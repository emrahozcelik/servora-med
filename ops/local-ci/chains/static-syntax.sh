#!/usr/bin/env bash
# Static syntax gate (bash -n + node --check), extracted so the caller stays flat.
set -Eeuo pipefail
cd /work/server
bash -n \
  ../ops/scripts/backup-postgres.sh \
  ../ops/scripts/backup-observation.sh \
  ../ops/scripts/restore-dr-acceptance.sh \
  ../ops/scripts/restore-rehearsal.sh \
  ../ops/scripts/deploy-release.sh \
  ../ops/deploy-production.sh \
  ../ops/scripts/deploy-production-host.sh \
  ../ops/scripts/host-operation-lock.sh \
  ../ops/scripts/issue-installed-old-adoption.sh \
  ../ops/scripts/issue-installed-old-adoption-67d3318.sh \
  ../ops/scripts/issue-historical-recovery-disposition-6ce4cff0.sh \
  ../ops/scripts/stage-historical-recovery-6ce4cff0.sh \
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
node --check ../ops/scripts/migration-state.mjs
node --check ../ops/scripts/migration-reconciliation.mjs
node --check ../web/scripts/production-browser-smoke.mjs

# Validate the local-first tooling that produces and verifies this evidence.
for script in ../ops/local-ci/*.sh ../ops/local-ci/lib/*.sh ../ops/local-ci/chains/*.sh; do
  bash -n "$script"
done
node --check ../ops/local-ci/assemble-manifest.mjs

for module in historical-archive-stage historical-archive-preflight deployment-attempt deployment-controller deployment-db-guard trusted-time backup-observation backup-observation-writer forward-transition forward-host forward-host-driver forward-host-storage forward-host-evidence forward-host-probe forward-host-recovery forward-host-continuity preserve-forward-authorization; do
  node --check "../ops/scripts/${module}.mjs"
done
