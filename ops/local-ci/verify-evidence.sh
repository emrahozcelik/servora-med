#!/usr/bin/env bash
# verify-evidence.sh — fail-closed verifier for local CI evidence bundles.
#
# Usage:
#   ops/local-ci/verify-evidence.sh --evidence-root <dir> --sha <40-hex>
#       [--tree <tree-sha>] [--exceptions <checkId:reason,...>] [--json]
#
# Fails closed when: manifest missing/invalid, log hash mismatch, unknown log
# file, SHA/tree mismatch, result != PASS, any required check not PASS (unless
# explicitly excepted), exception references unknown check, builder identity
# missing, or linux-compat check did not positively assert compatibility.
#
# Portable POSIX-ish bash (no associative arrays): runs on macOS bash 3.2.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/evidence.sh"

EVIDENCE_ROOT=""
SHA=""
TREE=""
EXCEPTIONS=""
JSON_OUT=false

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --evidence-root) EVIDENCE_ROOT="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --tree) TREE="${2:-}"; shift 2 ;;
    --exceptions) EXCEPTIONS="${2:-}"; shift 2 ;;
    --json) JSON_OUT=true; shift ;;
    *) echo "EVIDENCE_VERIFY_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

fail() {
  local reason="$1"
  if [[ "$JSON_OUT" == true ]]; then
    printf '{"ok":false,"reason":"%s"}\n' "$reason"
  else
    echo "EVIDENCE_VERIFY_FAILED reason=${reason}" >&2
  fi
  exit 1
}

MFIELD_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const path = process.argv[2].split("."); let v = m; for (const p of path) { v = (v === undefined || v === null) ? v : v[p]; } if (v === undefined || v === null) process.exit(3); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));'

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_SHA
[[ -n "$EVIDENCE_ROOT" && -d "$EVIDENCE_ROOT" ]] || fail EVIDENCE_ROOT_MISSING

BUNDLE="$EVIDENCE_ROOT/$SHA"
MANIFEST="$BUNDLE/manifest.json"
[[ -f "$MANIFEST" ]] || fail MANIFEST_MISSING
node --input-type=module -e "$MFIELD_JS" -- "$MANIFEST" schemaVersion >/dev/null \
  || fail MANIFEST_INVALID_JSON

mget() {
  node --input-type=module -e "$MFIELD_JS" -- "$MANIFEST" "$1" \
    || fail "MANIFEST_FIELD_MISSING_$1"
}

[[ "$(mget schemaVersion)" == "$EVIDENCE_SCHEMA_VERSION" ]] || fail SCHEMA_MISMATCH
[[ "$(mget sha)" == "$SHA" ]] || fail EVIDENCE_SHA_MISMATCH
if [[ -n "$TREE" ]]; then
  [[ "$(mget tree)" == "$TREE" ]] || fail EVIDENCE_TREE_MISMATCH
fi
[[ "$(mget result)" == "PASS" ]] || fail EVIDENCE_RESULT_NOT_PASS
[[ -n "$(mget builder.os)" && -n "$(mget builder.arch)" && -n "$(mget builder.node)" ]] \
  || fail BUILDER_IDENTITY_MISSING

LOOKUP_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.log === process.argv[2]); if (!c) process.exit(4); process.stdout.write(c.sha256);'
VERIFY_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const dir = process.argv[2]; for (const c of m.checks) { const f = dir + "/" + c.log; if (!fs.existsSync(f)) { console.error("missing " + c.log); process.exit(5); } const { createHash } = await import("node:crypto"); const h = createHash("sha256").update(fs.readFileSync(f)).digest("hex"); if (h !== c.sha256) { console.error("hash " + c.log); process.exit(6); } }'
STATUS_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.id === process.argv[2]); if (!c) process.exit(7); process.stdout.write(c.result);'

# Every log file on disk must be referenced with a matching hash.
while IFS= read -r logfile; do
  entry="$(node --input-type=module -e "$LOOKUP_JS" -- "$MANIFEST" "logs/$logfile")" \
    || fail "EVIDENCE_UNLISTED_LOG_${logfile}"
  actual="$(evidence_sha256_file "$BUNDLE/logs/$logfile")"
  [[ "$actual" == "$entry" ]] || fail EVIDENCE_LOG_HASH_MISMATCH
done < <(cd "$BUNDLE/logs" && ls -1 -- *.log 2>/dev/null)

# Every referenced log must exist with a matching hash.
node --input-type=module -e "$VERIFY_JS" -- "$MANIFEST" "$BUNDLE" \
  || fail EVIDENCE_LOG_HASH_MISMATCH

# Required-check policy (exceptions carried as a plain delimited list).
EXCEPTION_IDS=""
if [[ -n "$EXCEPTIONS" ]]; then
  while IFS= read -r pair; do
    id="${pair%%:*}"; reason="${pair#*:}"
    [[ -n "$id" && -n "$reason" && "$id" != "$pair" ]] || fail INVALID_EXCEPTION_FORMAT
    known=false
    for req in "${REQUIRED_EVIDENCE_CHECKS[@]}"; do
      [[ "$req" == "$id" ]] && known=true
    done
    [[ "$known" == true ]] || fail EXCEPTION_UNKNOWN_CHECK
    EXCEPTION_IDS="${EXCEPTION_IDS}${id}
"
  done < <(printf '%s\n' "$EXCEPTIONS" | tr ',' '\n')
fi

exception_reason() {
  local want="$1" line
  while IFS= read -r line; do
    [[ "$line" == "$want" ]] && return 0
  done <<<"$EXCEPTION_IDS"
  return 1
}

for req in "${REQUIRED_EVIDENCE_CHECKS[@]}"; do
  status="$(node --input-type=module -e "$STATUS_JS" -- "$MANIFEST" "$req")" \
    || fail "EVIDENCE_CHECK_MISSING_${req}"
  if [[ "$status" != "PASS" ]]; then
    if exception_reason "$req"; then
      echo "evidence exception: ${req} (${status}) — reviewed exception accepted" >&2
      continue
    fi
    fail "EVIDENCE_CHECK_FAILED_${req}"
  fi
done

# linux-compat must positively assert zero native/platform-restricted deps.
COMPAT_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.id === "linux-compat"); const d = (c === undefined || c === null) ? null : c.detail; if (!d || d.nativeBinaries !== 0 || d.osRestricted !== 0 || d.cpuRestricted !== 0) process.exit(8);'
node --input-type=module -e "$COMPAT_JS" -- "$MANIFEST" \
  || fail EVIDENCE_LINUX_INCOMPATIBLE

if [[ "$JSON_OUT" == true ]]; then
  printf '{"ok":true,"sha":"%s"}\n' "$SHA"
else
  echo "EVIDENCE_VERIFY_PASS sha=${SHA}"
fi
