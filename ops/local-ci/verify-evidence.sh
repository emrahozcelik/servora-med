#!/usr/bin/env bash
# verify-evidence.sh — fail-closed verifier for local CI evidence bundles.
#
# Usage:
#   ops/local-ci/verify-evidence.sh --evidence-root <dir> --sha <40-hex>
#       [--tree <tree-sha>] [--json]
#
# Fails closed when: manifest missing/invalid, log hash mismatch, unknown log
# file, SHA/tree mismatch, result != PASS, any required check not PASS,
# builder identity missing, linux-compat check did not positively assert
# compatibility, or manifest provenance is not exactly
# "local-operator-attested".
#
# Exception policy A (no production exceptions): there is deliberately no
# --exceptions mechanism. A caller-supplied reason string is not independent
# approval and must never mark a failed check acceptable, so every mandatory
# check must PASS. (The assembler already forces manifest result FAIL when
# any check is not PASS, so exceptions could never have authorized a deploy.)
#
# Portable POSIX-ish bash (no associative arrays): runs on macOS bash 3.2.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/evidence.sh"

EVIDENCE_ROOT=""
SHA=""
TREE=""
JSON_OUT=false

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --evidence-root) EVIDENCE_ROOT="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --tree) TREE="${2:-}"; shift 2 ;;
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
# Trust model (see lib/evidence.sh): the verifier establishes evidence FILE
# INTEGRITY (log hashes recomputed) and exact GIT SOURCE IDENTITY (SHA/tree
# binding). It does NOT establish execution provenance or operator approval:
# a self-consistent bundle only proves internal consistency. The manifest
# must therefore claim exactly "local-operator-attested" provenance — any
# other value (e.g. a forged "independently-authenticated" claim) is refused
# so forged evidence can never be described as independently authenticated.
[[ "$(mget provenance)" == "local-operator-attested" ]] || fail EVIDENCE_PROVENANCE_UNRECOGNIZED
[[ -n "$(mget builder.os)" && -n "$(mget builder.arch)" && -n "$(mget builder.node)" ]] \
  || fail BUILDER_IDENTITY_MISSING

LOOKUP_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.log === process.argv[2]); if (!c) process.exit(4); process.stdout.write(c.sha256);'
VERIFY_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const dir = process.argv[2]; for (const c of m.checks) { const f = dir + "/" + c.log; if (!fs.existsSync(f)) { console.error("missing " + c.log); process.exit(5); } const { createHash } = await import("node:crypto"); const h = createHash("sha256").update(fs.readFileSync(f)).digest("hex"); if (h !== c.sha256) { console.error("hash " + c.log); process.exit(6); } }'
STATUS_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.id === process.argv[2]); if (!c) process.exit(7); process.stdout.write(c.result);'

# Manifest log references must stay inside logs/ (no traversal, absolute
# paths, or odd names): the verifier reads these files, so a forged manifest
# must not make it read outside the bundle. Validated before touching disk.
LOGPATH_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const c of m.checks) { if (typeof c.log !== "string" || !/^logs\/[A-Za-z0-9_.-]+\.log$/.test(c.log)) { console.error("bad log path " + c.id); process.exit(9); } }'
node --input-type=module -e "$LOGPATH_JS" -- "$MANIFEST" \
  || fail EVIDENCE_LOG_PATH_INVALID

# Every log file on disk must be referenced with a matching hash. Portable
# glob loop (no ls): runs on macOS and Linux alike.
shopt -s nullglob
for logpath in "$BUNDLE/logs/"*.log; do
  logfile="$(basename -- "$logpath")"
  entry="$(node --input-type=module -e "$LOOKUP_JS" -- "$MANIFEST" "logs/$logfile")" \
    || fail "EVIDENCE_UNLISTED_LOG_${logfile}"
  actual="$(evidence_sha256_file "$logpath")"
  [[ "$actual" == "$entry" ]] || fail EVIDENCE_LOG_HASH_MISMATCH
done
shopt -u nullglob

# Every referenced log must exist with a matching hash.
node --input-type=module -e "$VERIFY_JS" -- "$MANIFEST" "$BUNDLE" \
  || fail EVIDENCE_LOG_HASH_MISMATCH

# Required-check policy A: every mandatory check must PASS. No exceptions.
for req in "${REQUIRED_EVIDENCE_CHECKS[@]}"; do
  status="$(node --input-type=module -e "$STATUS_JS" -- "$MANIFEST" "$req")" \
    || fail "EVIDENCE_CHECK_MISSING_${req}"
  [[ "$status" == "PASS" ]] || fail "EVIDENCE_CHECK_FAILED_${req}"
done

# linux-compat must positively assert zero native/platform-restricted deps AND
# a successful production install+import on linux/amd64. The scan alone does
# not prove every platform dependency is absent (see verify-linux-compat.sh),
# so a scan-only bundle is refused.
COMPAT_JS='import fs from "node:fs"; const m = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const c = m.checks.find((x) => x.id === "linux-compat"); const d = (c === undefined || c === null) ? null : c.detail; const a = (d === undefined || d === null) ? null : d.linuxAmd64; if (!d || d.nativeBinaries !== 0 || d.osRestricted !== 0 || d.cpuRestricted !== 0 || !a || a.result !== "pass" || !a.productionPackages) process.exit(8);'
node --input-type=module -e "$COMPAT_JS" -- "$MANIFEST" \
  || fail EVIDENCE_LINUX_INCOMPATIBLE

if [[ "$JSON_OUT" == true ]]; then
  printf '{"ok":true,"sha":"%s"}\n' "$SHA"
else
  echo "EVIDENCE_VERIFY_PASS sha=${SHA}"
fi
