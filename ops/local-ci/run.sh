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
BUNDLE="$EVIDENCE_ROOT/$SHA"
LOGS="$BUNDLE/logs"
mkdir -p "$LOGS" "$LOGS/aux"
STARTED_AT="$(date -u +%FT%TZ)"
NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
OS_INFO="$(uname -srm)"
PG_SERVER="17 (postgres:17-alpine service)"
PG_CLIENT="$(docker run --rm postgres:17-alpine psql --version 2>/dev/null || echo unknown)"

NET=servora-localci
PG=servora-localci-pg
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -qx "$PG"; then
  docker rm -f "$PG" >/dev/null
fi
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=servora_med_test postgres:17-alpine >/dev/null
cleanup() {
  if [[ "$KEEP" != true ]]; then
    docker rm -f "$PG" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

EXPORT_DIR="$BUNDLE/tree-export"
rm -rf "$EXPORT_DIR" && mkdir -p "$EXPORT_DIR"
git -C "$REPO" archive "$SHA" | tar -x -C "$EXPORT_DIR"

echo "=== [1/5] server chain (node:22 + postgres:17) ==="
docker run --rm --network "$NET" --name servora-localci-server \
  -v "$EXPORT_DIR:/repo:ro" \
  -v "$LOGS:/logs" \
  -v "$SCRIPT_DIR/chains:/chains:ro" \
  node:22-bookworm bash /chains/server-chain.sh 2>&1 | tee "$LOGS/aux/server-chain.stdout.log"

echo "=== [2/5] web chain (node:22) ==="
docker run --rm --name servora-localci-web \
  -v "$EXPORT_DIR:/repo:ro" \
  -v "$LOGS:/logs" \
  -v "$SCRIPT_DIR/chains:/chains:ro" \
  -e LOCAL_CI_SHA="$SHA" \
  node:22-bookworm bash /chains/web-chain.sh 2>&1 | tee "$LOGS/aux/web-chain.stdout.log"

echo "=== [3/5] benchmark smoke ==="
docker run --rm -v "$EXPORT_DIR:/repo:ro" node:22-bookworm \
  node /repo/ops/benchmarks/auth-kdf-benchmark.mjs --mode=smoke >"$LOGS/benchmark-smoke.log" 2>&1 \
  && echo 0 >"$LOGS/benchmark-smoke.exit" || echo "$?" >"$LOGS/benchmark-smoke.exit"

echo "=== [4/5] linux-compat gate ==="
(
  cd "$EXPORT_DIR/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1
  bash "$SCRIPT_DIR/verify-linux-compat.sh" --server-dir "$EXPORT_DIR/server" >"$LOGS/linux-compat.detail.json" 2>"$LOGS/linux-compat.log"
) && echo 0 >"$LOGS/linux-compat.exit" || echo "$?" >"$LOGS/linux-compat.exit"
COMPAT_DETAIL="$(cat "$LOGS/linux-compat.detail.json" 2>/dev/null || echo null)"
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
  --bundle "$BUNDLE" --sha "$SHA" --tree "$TREE" --repo "$ORIGIN_URL" \
  --started "$STARTED_AT" --finished "$FINISHED_AT" \
  --os "$OS_INFO" --arch "$(uname -m)" --node "$NODE_VERSION" --npm "$NPM_VERSION" \
  --pg-server "$PG_SERVER" --pg-client "$PG_CLIENT" \
  --compat-detail "$COMPAT_DETAIL"
echo "EVIDENCE_BUNDLE_READY dir=$BUNDLE"
