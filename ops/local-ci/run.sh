#!/usr/bin/env bash
# run.sh — reproducible local CI entrypoint (local-first workflow).
#
# Mirrors .github/workflows/ci.yml coverage using Colima Docker (Ubuntu
# containers + postgres:17 service) instead of GitHub-hosted runners.
#
# Usage:
#   ops/local-ci/run.sh --sha <40-hex> [--repo <dir>] [--evidence-root <dir>]
#       [--skip-docker-gated] [--keep-containers]
#
# Fails closed on: bad SHA, HEAD/tree mismatch, dirty tracked tree, untracked
# build inputs, missing docker/colima, any check failure. Never reports
# unexecuted checks as passed (ABSENT / NOT_RUN fail the manifest).
#
# Output: <evidence-root>/<sha>/{manifest.json,report.md,logs/}
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/evidence.sh"

# Helpers are sourceable for focused tests without executing CI.

# canonical_repo_identity <remote-url>: canonical non-secret repository
# identity (host/owner/repo) for evidence. Strips userinfo (which may carry
# tokens) from https/ssh URLs and scp-like syntax; unparseable input yields
# "unknown" rather than persisting attacker-influenced text.
canonical_repo_identity() {
  local url="$1" rest host path
  case "$url" in
    https://*|http://*|ssh://*)
      rest="${url#*://}"
      rest="${rest##*@}" # longest strip: passwords may contain @
      host="${rest%%[/:]*}"
      path="${rest#*/}"
      ;;
    *)
      rest="$url"
      case "$rest" in *@*) rest="${rest##*@}" ;; esac
      case "$rest" in *:*)
        host="${rest%%:*}"
        path="${rest#*:}"
        ;;
      *) printf 'unknown'; return 0 ;;
      esac
      ;;
  esac
  path="${path%.git}"
  if [[ "$host" =~ ^[A-Za-z0-9.-]+$ && "$path" =~ ^[A-Za-z0-9_./-]+$ ]]; then
    printf '%s/%s' "$host" "$path"
  else
    printf 'unknown'
  fi
}

cleanup() {
  # Do not remove resources unless this run's claim is still on disk.
  # Evidence is deliberately retained on every exit, including setup errors.
  local owner=""
  owner="$(cat -- "${LOCAL_CI_LOCK_DIR:-}/pid" 2>/dev/null || true)"
  if [[ -z "${LOCAL_CI_LOCK_CLAIM:-}" || "$owner" != "$LOCAL_CI_LOCK_CLAIM" ]]; then
    echo "LOCAL_CI cleanup: ownership unknown; resources left in place" >&2
    return 0
  fi
  if [[ "${KEEP:-false}" != true ]]; then
    if [[ "${PG_CREATED:-false}" == true ]]; then
      docker rm -f "$PG" >/dev/null 2>&1 || true
    fi
    if [[ "${NET_CREATED:-false}" == true ]]; then
      docker network rm "$NET" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "${EXPORT_CREATED:-false}" == true ]]; then
    rm -rf -- "$EXPORT_DIR"
  fi
  rm -- "$LOCAL_CI_LOCK_DIR/pid"
  rmdir -- "$LOCAL_CI_LOCK_DIR"
}

# Sourcing exposes helpers only; direct invocations always run the full gate.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SHA=""
REPO=""
EVIDENCE_ROOT="${HOME}/.local/share/servora-med/evidence"
SKIP_DOCKER_GATED=false
KEEP=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --evidence-root) EVIDENCE_ROOT="${2:-}"; shift 2 ;;
    --skip-docker-gated) SKIP_DOCKER_GATED=true; shift ;;
    --keep-containers) KEEP=true; shift ;;
    *) echo "LOCAL_CI_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "LOCAL_CI_FAILED reason=INVALID_SHA" >&2; exit 1; }
if [[ -z "$REPO" ]]; then
  REPO="$(git rev-parse --show-toplevel)"
fi
[[ "$(git -C "$REPO" rev-parse --verify HEAD)" == "$SHA" ]] \
  || { echo "LOCAL_CI_FAILED reason=HEAD_MISMATCH" >&2; exit 1; }
TREE="$(git -C "$REPO" rev-parse "${SHA}^{tree}")"
git -C "$REPO" diff --quiet HEAD -- || { echo "LOCAL_CI_FAILED reason=TRACKED_WORKTREE_DIRTY" >&2; exit 1; }
git -C "$REPO" diff --cached --quiet || { echo "LOCAL_CI_FAILED reason=STAGED_WORKTREE_DIRTY" >&2; exit 1; }
untracked="$(git -C "$REPO" ls-files --others -- server/src server/scripts server/package.json server/package-lock.json server/tsconfig.json web/src web/scripts web/public web/index.html web/package.json web/package-lock.json web/tsconfig.json web/tsconfig.node.json web/vite.config.ts ops)"
[[ -z "$untracked" ]] || { echo "LOCAL_CI_FAILED reason=SOURCE_TREE_NOT_EXACT" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || { echo "LOCAL_CI_FAILED reason=DOCKER_MISSING" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "LOCAL_CI_FAILED reason=DOCKER_UNAVAILABLE (is colima running?)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "LOCAL_CI_FAILED reason=NODE_MISSING" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == 22 ]] || { echo "LOCAL_CI_FAILED reason=NODE_22_REQUIRED_$(node --version)" >&2; exit 1; }

ORIGIN_URL="$(git -C "$REPO" remote get-url origin 2>/dev/null || echo unknown)"
REPO_IDENTITY="$(canonical_repo_identity "$ORIGIN_URL")"
unset ORIGIN_URL
BUNDLE="$EVIDENCE_ROOT/$SHA"
LOGS="$BUNDLE/logs"
# Concurrent runs can share a SHA bundle: fail closed on an existing lock.
# Resources have per-run names; stale lock recovery requires supervised
# quiescence, as documented in production-deployment.md.
LOCAL_CI_LOCK_DIR="${TMPDIR:-/tmp}/servora-med-local-ci.lock"
if ! mkdir "$LOCAL_CI_LOCK_DIR" 2>/dev/null; then
  holder_pid="$(cat -- "$LOCAL_CI_LOCK_DIR/pid" 2>/dev/null || echo unknown)"
  echo "LOCAL_CI_FAILED reason=LOCAL_CI_ALREADY_RUNNING holder=${holder_pid} recovery=supervised_only" >&2
  exit 1
fi
LOCAL_CI_LOCK_CLAIM="pid=$$ nonce=$RANDOM-$RANDOM"
# Cleanup is armed immediately after lock acquisition so even an early setup
# failure (node/docker/network/PG provisioning) releases the lock and never
# strands later invocations.
trap cleanup EXIT
printf '%s\n' "$LOCAL_CI_LOCK_CLAIM" >"$LOCAL_CI_LOCK_DIR/pid"
# Start from an empty logs tree: a rerun must never inherit check results
# from a previous run (stale PASS beside a new failure, or vice versa).
rm -rf -- "$LOGS"
mkdir -p "$LOGS" "$LOGS/aux"
STARTED_AT="$(date -u +%FT%TZ)"
NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
OS_INFO="$(uname -srm)"
PG_SERVER="17 (postgres:17-alpine service)"
PG_CLIENT="$(docker run --rm postgres:17-alpine psql --version 2>/dev/null || echo unknown)"

RUN_ID="$$-$RANDOM-$RANDOM"
NET="servora-localci-$RUN_ID"
PG="servora-localci-pg-$RUN_ID"
NET_CREATED=false
PG_CREATED=false
docker network create "$NET" >/dev/null
NET_CREATED=true
docker run -d --name "$PG" --network "$NET" --network-alias servora-localci-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=servora_med_test postgres:17-alpine >/dev/null
PG_CREATED=true

# Temporary export belongs solely to this run; logs remain in the bundle.
EXPORT_DIR="$(mktemp -d "$BUNDLE/tree-export.XXXXXX")"
EXPORT_CREATED=true
git -C "$REPO" archive "$SHA" | tar -x -C "$EXPORT_DIR"

server_chain_code=0
echo "=== [1/5] server chain (node:22 + postgres:17) ==="
docker run --platform linux/amd64 --rm --network "$NET" --name "servora-localci-server-$RUN_ID" \
  -v "$EXPORT_DIR:/repo:ro" \
  -v "$LOGS:/logs" \
  -v "$SCRIPT_DIR/chains:/chains:ro" \
  node:22-bookworm bash /chains/server-chain.sh 2>&1 | tee "$LOGS/aux/server-chain.stdout.log" || server_chain_code=$?
printf '%s\n' "$server_chain_code" >"$LOGS/aux/server-chain.exit"

web_chain_code=0
echo "=== [2/5] web chain (node:22) ==="
docker run --rm --ulimit nofile=65536:65536 --name "servora-localci-web-$RUN_ID" \
  -v "$EXPORT_DIR:/repo:ro" \
  -v "$LOGS:/logs" \
  -v "$SCRIPT_DIR/chains:/chains:ro" \
  -e LOCAL_CI_SHA="$SHA" \
  node:22-bookworm bash /chains/web-chain.sh 2>&1 | tee "$LOGS/aux/web-chain.stdout.log" || web_chain_code=$?
printf '%s\n' "$web_chain_code" >"$LOGS/aux/web-chain.exit"

echo "=== [3/5] benchmark smoke ==="
docker run --rm -v "$EXPORT_DIR:/repo:ro" node:22-bookworm \
  node /repo/ops/benchmarks/auth-kdf-benchmark.mjs --mode=smoke >"$LOGS/benchmark-smoke.log" 2>&1 \
  && echo 0 >"$LOGS/benchmark-smoke.exit" || echo "$?" >"$LOGS/benchmark-smoke.exit"

echo "=== [4/5] linux-compat gate (scan + linux/amd64 install+import) ==="
scan_code=0
(
  cd "$EXPORT_DIR/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1
  bash "$SCRIPT_DIR/verify-linux-compat.sh" --server-dir "$EXPORT_DIR/server" >"$LOGS/aux/linux-compat-scan.json" 2>"$LOGS/aux/linux-compat-scan.log"
) || scan_code=$?
amd64_code=0
bash "$SCRIPT_DIR/chains/linux-amd64-compat.sh" --server-dir "$EXPORT_DIR/server" >"$LOGS/aux/linux-amd64.json" 2>"$LOGS/aux/linux-amd64.log" || amd64_code=$?
{
  echo "--- dependency scan (verify-linux-compat.sh), exit=${scan_code} ---"
  cat "$LOGS/aux/linux-compat-scan.log" 2>/dev/null || true
  echo "--- linux/amd64 production install+import, exit=${amd64_code} ---"
  cat "$LOGS/aux/linux-amd64.log" 2>/dev/null || true
} >"$LOGS/linux-compat.log" 2>&1
if [[ "$scan_code" -eq 0 && "$amd64_code" -eq 0 ]]; then
  echo 0 >"$LOGS/linux-compat.exit"
else
  echo 1 >"$LOGS/linux-compat.exit"
fi
COMPAT_DETAIL="$(node --input-type=module -e '
import fs from "node:fs";
const scan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const amd64 = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
scan.linuxAmd64 = amd64;
process.stdout.write(JSON.stringify(scan));
' -- "$LOGS/aux/linux-compat-scan.json" "$LOGS/aux/linux-amd64.json" 2>/dev/null || echo null)"
if [[ "$COMPAT_DETAIL" == "null" ]]; then
  echo "linux-compat detail missing" >&2
fi

echo "=== [5/5] docker-gated validations ==="
if [[ "$SKIP_DOCKER_GATED" == true ]]; then
  for id in server-caddyfile server-sse-behavior server-tunnel-caddyfile server-tunnel-behavior server-cloudflared-ingress; do
    printf 'NOT_RUN: skipped by --skip-docker-gated\n' >"$LOGS/${id}.log"
    printf 'SKIP\n' >"$LOGS/${id}.exit"
  done
else
  bash "$SCRIPT_DIR/docker-gated.sh" --repo "$EXPORT_DIR" --logs "$LOGS" || true
fi

# Normalize benchmark/linux-compat entries to the per-check file convention.
echo "=== evidence manifest ==="
FINISHED_AT="$(date -u +%FT%TZ)"
node "$SCRIPT_DIR/assemble-manifest.mjs" \
  --bundle "$BUNDLE" --sha "$SHA" --tree "$TREE" --repo "$REPO_IDENTITY" \
  --started "$STARTED_AT" --finished "$FINISHED_AT" \
  --os "$OS_INFO" --arch "$(uname -m)" --node "$NODE_VERSION" --npm "$NPM_VERSION" \
  --pg-server "$PG_SERVER" --pg-client "$PG_CLIENT" \
  --compat-detail "$COMPAT_DETAIL" \
  --server-chain-exit "$server_chain_code" --web-chain-exit "$web_chain_code"
echo "EVIDENCE_BUNDLE_READY dir=$BUNDLE"
