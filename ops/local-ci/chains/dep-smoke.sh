#!/usr/bin/env bash
# Production dependency smoke: pruned install must import and ship artifacts.
set -Eeuo pipefail
cd /work/server
SMOKE="$(mktemp -d)"
mkdir -p "$SMOKE/server" "$SMOKE/ops/scripts"
cp -R dist package.json package-lock.json "$SMOKE/server/"
cp /work/ops/scripts/trusted-time.mjs /work/ops/scripts/backup-observation.mjs "$SMOKE/ops/scripts/"
cd "$SMOKE/server"
npm ci --omit=dev --no-audit --no-fund
test -d node_modules/fastify
test -d node_modules/pg
node --input-type=module -e "import '@aws-sdk/client-s3'; import 'fastify'; import 'pg'; console.log('deps-ok')"
test -f dist/index.js
test -f dist/db/migrate.js
test -f dist/db/schema-check.js

node --input-type=module -e "await import('./dist/modules/health/host-backup-observation.js'); console.log('host-backup-artifact-import-ok')"
