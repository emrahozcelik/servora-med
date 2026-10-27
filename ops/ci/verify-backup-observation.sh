#!/usr/bin/env bash
# Deterministic real-filesystem producer/schema/publication contract. No DB or host-clock changes.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash -n "$ROOT/ops/scripts/backup-observation.sh"
node --check "$ROOT/ops/scripts/backup-observation.mjs"
node --check "$ROOT/ops/scripts/backup-observation-writer.mjs"
node --test "$ROOT/ops/tests/backup-observation.test.mjs"
echo "backup observation contract passed"
