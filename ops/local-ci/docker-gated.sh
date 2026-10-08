#!/usr/bin/env bash
# docker-gated.sh — run the 5 docker-gated ops validations, best available path.
#
# Usage: ops/local-ci/docker-gated.sh --repo <exact-tree-dir> --logs <dir>
# Prefers the Colima VM userspace (node + docker share a net namespace there);
# falls back to host docker with a shared TMPDIR; records NOT_RUN when docker
# is unavailable. Never reports unexecuted checks as passed.
set -Eeuo pipefail

REPO=""
LOGDIR=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --logs) LOGDIR="${2:-}"; shift 2 ;;
    *) echo "DOCKER_GATED_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done
[[ -n "$REPO" && -d "$REPO/server" && -n "$LOGDIR" ]] \
  || { echo "DOCKER_GATED_FAILED reason=BAD_ARGS" >&2; exit 1; }
mkdir -p "$LOGDIR"

run_one() { # id -- command...
  local id="$1"; shift
  if [[ "${1:-}" == "--" ]]; then shift; fi
  local code=0
  "$@" >"$LOGDIR/${id}.log" 2>&1 || code=$?
  echo "$code" >"$LOGDIR/${id}.exit"
  if [[ "$code" -eq 0 ]]; then
    echo "check ${id}: PASS"
    return 0
  fi
  echo "check ${id}: FAIL"
  return 1
}

failed=false
docker_available() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

if ! docker_available; then
  for id in server-caddyfile server-sse-behavior server-tunnel-caddyfile server-tunnel-behavior server-cloudflared-ingress; do
    printf 'NOT_RUN: docker unavailable on operator host\n' >"$LOGDIR/${id}.log"
    printf 'SKIP\n' >"$LOGDIR/${id}.exit"
  done
  echo "DOCKER_GATED_FAILED reason=DOCKER_UNAVAILABLE" >&2
  exit 1
fi

# The SSE behavior smoke needs node + docker in one Linux net namespace.
# Prefer the Colima VM userspace (has both after one-time setup); otherwise
# run host-side with a shared TMPDIR (works for all but the SSE behavior test
# when the backend cannot share the daemon net namespace).
VM_RUN=false
if command -v colima >/dev/null 2>&1 && colima ssh -p true -- true 2>/dev/null; then
  if colima ssh -p true -- test -x /home/emrah.guest/.local/bin/node 2>/dev/null \
    || colima ssh -p true -- test -x "$HOME/.local/bin/node" 2>/dev/null; then
    VM_RUN=true
  fi
fi

TMP_SHARED="$HOME/.local/share/servora-med/ci-tmp"
mkdir -p "$TMP_SHARED"

# Scripts run from the export tree (exact SHA content).
run_one server-caddyfile -- bash -c "cd '$REPO/server' && TMPDIR='$TMP_SHARED' bash ../ops/ci/verify-caddyfile.sh" || failed=true
if [[ "$VM_RUN" == true ]]; then
  run_one server-sse-behavior -- bash -c "colima ssh -p true -- env PATH=/home/emrah.guest/.local/bin:/usr/bin:/bin TMPDIR=/tmp bash '$REPO/ops/ci/verify-sse-streaming-behavior.sh'" || failed=true
else
  run_one server-sse-behavior -- bash -c "cd '$REPO/server' && TMPDIR='$TMP_SHARED' bash ../ops/ci/verify-sse-streaming-behavior.sh" || failed=true
fi
run_one server-tunnel-caddyfile -- bash -c "cd '$REPO/server' && TMPDIR='$TMP_SHARED' bash ../ops/ci/verify-tunnel-caddyfile.sh" || failed=true
run_one server-tunnel-behavior -- bash -c "cd '$REPO/server' && TMPDIR='$TMP_SHARED' bash ../ops/ci/verify-tunnel-caddy-behavior.sh" || failed=true
run_one server-cloudflared-ingress -- bash -c "cd '$REPO/server' && TMPDIR='$TMP_SHARED' bash ../ops/ci/verify-cloudflared-ingress.sh" || failed=true

[[ "$failed" == false ]]
