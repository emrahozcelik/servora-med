#!/usr/bin/env bash
# Web chain for ops/local-ci/run.sh — reproduces the CI `web` job.
# Runs inside the lockfile-keyed Node 22 Bookworm browser image.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME=/root

SHA="${LOCAL_CI_SHA:?LOCAL_CI_SHA required}"

check() {
  local id="$1"; shift
  if [[ "${1:-}" == "--" ]]; then shift; fi
  echo "--- check ${id}: $*"
  local code=0
  "$@" >"/logs/${id}.log" 2>&1 || code=$?
  echo "$code" >"/logs/${id}.exit"
  if [[ "$code" -eq 0 ]]; then
    echo "check ${id}: PASS"
  else
    echo "check ${id}: FAIL (see /logs/${id}.log)"
    exit 1
  fi
}

mkdir -p /logs/aux
echo "toolchain: node $(node --version) npm $(npm --version) $(grep PRETTY_NAME /etc/os-release)" | tee /logs/aux/stage-a-web.log
rm -rf /work && cp -a /repo /work
cd /work/web
export VITE_SERVORA_BUILD_SHA="$SHA"

check web-build -- bash -c 'npm ci --no-audit --no-fund && npm run build'
if ! grep -q "$SHA" dist/assets/*.js; then
  echo "built artifact does not embed $SHA" >&2
  exit 1
fi
check web-bundle -- bash -c 'npm run bundle:check'
check web-tests -- bash -c 'npm test -- --run'
check web-playwright-install -- node ../ops/local-ci/browser-availability.mjs
check web-smoke-dist -- bash -c 'npm run smoke:production-dist'
check web-smoke-responsive -- bash -c 'npm run smoke:responsive'
check web-geometry -- bash -c 'node scripts/follow-up-dialog-geometry.mjs'
check web-audit -- bash -c 'npm run audit:high'
echo WEB-CHAIN-COMPLETE
