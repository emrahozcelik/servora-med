#!/usr/bin/env bash
# Stage B of the server chain: runs as the non-root `node` user (GitHub
# runners are non-root; permission-semantics tests require it).
set -Eeuo pipefail
export CI=true
export PSQL_BIN=/usr/lib/postgresql/17/bin/psql
export PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump
export PG_RESTORE_BIN=/usr/lib/postgresql/17/bin/pg_restore
export DATABASE_URL="postgresql://postgres:postgres@servora-localci-pg:5432/servora_med_test"
export TEST_DATABASE_URL="postgresql://postgres:postgres@servora-localci-pg:5432/servora_med_test"
export NODE_ENV=test
export HOME=/tmp/cihome
mkdir -p "$HOME"
cd /work/server

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

check server-static-syntax -- bash /work/ops-local-ci-static-syntax.sh
check server-shellcheck -- shellcheck -x \
  ../ops/local-ci/run.sh \
  ../ops/local-ci/docker-gated.sh \
  ../ops/local-ci/load-prod-env.sh \
  ../ops/local-ci/verify-evidence.sh \
  ../ops/local-ci/lib/evidence.sh \
  ../ops/local-ci/lib/resource-cleanup.sh \
  ../ops/local-ci/lib/cache.sh \
  ../ops/local-ci/lib/ssh-files.sh \
  ../ops/scripts/backup-postgres.sh \
  ../ops/scripts/backup-observation.sh \
  ../ops/scripts/restore-dr-acceptance.sh \
  ../ops/scripts/restore-rehearsal.sh \
  ../ops/scripts/deploy-release.sh \
  ../ops/deploy-production.sh \
  ../ops/scripts/deploy-production-host.sh \
  ../ops/scripts/host-operation-lock.sh \
  ../ops/scripts/predeploy-backup-launcher.sh \
  ../ops/scripts/ensure-macos-service-identity.sh \
  ../ops/ci/verify-caddyfile.sh \
  ../ops/ci/verify-sse-streaming.sh \
  ../ops/ci/verify-sse-streaming-behavior.sh \
  ../ops/ci/verify-tunnel-caddyfile.sh \
  ../ops/ci/verify-tunnel-caddy-behavior.sh \
  ../ops/ci/verify-cloudflared-ingress.sh \
  ../ops/ci/verify-db-auth-contract.sh \
  ../ops/ci/verify-env-examples.sh \
  ../ops/ci/verify-systemd-units.sh \
  ../ops/ci/verify-operator-alerting.sh \
  ../ops/launchd/start-api.sh.example \
  ../ops/launchd/run-backup.sh.example \
  ../ops/launchd/run-backup-worker.sh.example \
  ../ops/launchd/run-alerting.sh.example

check server-systemd-units -- bash ../ops/ci/verify-systemd-units.sh
check server-backup-observation -- bash ../ops/ci/verify-backup-observation.sh
check server-operator-alerting -- bash ../ops/ci/verify-operator-alerting.sh
check server-env-examples -- bash ../ops/ci/verify-env-examples.sh
check server-db-auth-contract -- bash ../ops/ci/verify-db-auth-contract.sh

check server-build -- bash -c 'npm ci --no-audit --no-fund && npm run build && npx tsc --noEmit --module NodeNext --target ES2022 --strict --skipLibCheck --typeRoots node_modules/@types ../ops/tests/trusted-time-types.mts'
check server-dep-smoke -- bash /work/ops-local-ci-dep-smoke.sh
check server-migrate-schema -- bash -c 'npx tsx src/db/migrate.ts && npm run schema:check'
check server-tests -- bash -c 'npm test -- --run && node --test ../ops/tests/deployment-attempt.test.mjs ../ops/tests/deployment-controller.test.mjs ../ops/tests/deployment-operator.test.mjs ../ops/tests/ci-resource-cleanup.test.mjs ../ops/tests/ci-resource-lifecycle.test.mjs ../ops/tests/trusted-time.test.mjs ../ops/tests/trusted-approval.test.mjs'
check server-audit -- bash -c 'npm audit --audit-level=high'
