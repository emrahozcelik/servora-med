#!/usr/bin/env bash
# Rewrite production unit paths into a temporary root with stubs, then
# run systemd-analyze verify as a hard gate (no || true).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/servora-systemd-XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p \
  "$TMP/opt/servora-med/current/server" \
  "$TMP/opt/servora-med/current/ops/scripts" \
  "$TMP/etc/servora-med" \
  "$TMP/usr/bin" \
  "$TMP/var/backups/servora-med" \
  "$TMP/var/lib/servora-med-alerting" \
  "$TMP/var/log/servora-med" \
  "$TMP/units"

# Stubs for binaries referenced by units.
printf '#!/bin/sh\nexit 0\n' >"$TMP/usr/bin/node"
chmod +x "$TMP/usr/bin/node"
printf '#!/bin/sh\nexit 0\n' >"$TMP/opt/servora-med/current/ops/scripts/backup-postgres.sh"
chmod +x "$TMP/opt/servora-med/current/ops/scripts/backup-postgres.sh"
printf '#!/bin/sh\nexit 0\n' >"$TMP/opt/servora-med/current/ops/scripts/operator-alerting.mjs"
chmod +x "$TMP/opt/servora-med/current/ops/scripts/operator-alerting.mjs"
: >"$TMP/opt/servora-med/current/server/dist-index-stub"
# WorkingDirectory must exist; ExecStart path is absolute to stub node.
mkdir -p "$TMP/opt/servora-med/current/server"
printf '#!/bin/sh\nexit 0\n' >"$TMP/opt/servora-med/current/server/dist-index.js"
chmod +x "$TMP/opt/servora-med/current/server/dist-index.js"

# Required EnvironmentFile paths must exist (non-optional).
: >"$TMP/etc/servora-med/servora-med.env"
: >"$TMP/etc/servora-med/servora-med-backup.env"
: >"$TMP/etc/servora-med/servora-med-alerting.env"

rewrite_unit() {
  local src="$1"
  local dest="$2"
  sed \
    -e "s|/usr/bin/node|${TMP}/usr/bin/node|g" \
    -e "s|/opt/servora-med/current/server/dist/index.js|${TMP}/opt/servora-med/current/server/dist-index.js|g" \
    -e "s|WorkingDirectory=/opt/servora-med/current/server|WorkingDirectory=${TMP}/opt/servora-med/current/server|g" \
    -e "s|EnvironmentFile=/etc/servora-med/|EnvironmentFile=${TMP}/etc/servora-med/|g" \
    -e "s|ExecStart=/opt/servora-med/current/ops/scripts/backup-postgres.sh|ExecStart=${TMP}/opt/servora-med/current/ops/scripts/backup-postgres.sh|g" \
    -e "s|ExecStart=/usr/bin/node /opt/servora-med/current/ops/scripts/operator-alerting.mjs|ExecStart=${TMP}/usr/bin/node ${TMP}/opt/servora-med/current/ops/scripts/operator-alerting.mjs|g" \
    -e "s|ReadWritePaths=/var/backups/servora-med /var/log/servora-med|ReadWritePaths=${TMP}/var/backups/servora-med ${TMP}/var/log/servora-med|g" \
    -e "s|ReadOnlyPaths=/var/backups/servora-med|ReadOnlyPaths=${TMP}/var/backups/servora-med|g" \
    -e "s|ReadWritePaths=/var/lib/servora-med-alerting /var/log/servora-med|ReadWritePaths=${TMP}/var/lib/servora-med-alerting ${TMP}/var/log/servora-med|g" \
    "$src" >"$dest"
}

rewrite_unit "$ROOT/ops/systemd/servora-med.service" "$TMP/units/servora-med.service"
rewrite_unit "$ROOT/ops/systemd/servora-med-backup.service" "$TMP/units/servora-med-backup.service"
rewrite_unit "$ROOT/ops/systemd/servora-med-alerting.service" "$TMP/units/servora-med-alerting.service"
# Timers have no absolute host paths beyond Unit= reference.
cp "$ROOT/ops/systemd/servora-med-backup.timer" "$TMP/units/servora-med-backup.timer"
cp "$ROOT/ops/systemd/servora-med-alerting.timer" "$TMP/units/servora-med-alerting.timer"

if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd-analyze is required on this CI image" >&2
  exit 1
fi

# Hard gate: non-zero fails the job.
systemd-analyze verify \
  "$TMP/units/servora-med.service" \
  "$TMP/units/servora-med-backup.service" \
  "$TMP/units/servora-med-backup.timer" \
  "$TMP/units/servora-med-alerting.service" \
  "$TMP/units/servora-med-alerting.timer"

echo "systemd-analyze verify passed"
