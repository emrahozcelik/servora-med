#!/usr/bin/env bash
# Run only on the explicitly provisioned disposable R4 host, as its fixture admin.
# This tests the real installed systemd policy, not Fastify/artifact acceptance.
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(cat /proc/1/comm)" == systemd ]]
[[ "$(hostname)" == lima-servora-r4-20261012 ]]
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for account in servora-med servora-deploy; do
  id "$account" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$account"
done
install -d -o root -g root -m 0755 /opt/servora-med/current/server
install -d -o root -g root -m 0755 /etc/servora-med
install -d -o root -g root -m 0700 /var/lib/servora-med/deploy
install -d -o servora-med -g servora-med -m 0700 /var/lib/servora-r4-policy-probe
printf '%s\n' '#!/bin/sh' 'printf "start\n" >> /var/lib/servora-r4-policy-probe/starts' 'exit 1' > /opt/servora-med/current/server/policy-probe
chmod 0755 /opt/servora-med/current/server/policy-probe
touch /etc/servora-med/servora-med.env
chown root:servora-med /etc/servora-med/servora-med.env
chmod 0640 /etc/servora-med/servora-med.env
sed -e 's|ExecStart=/usr/bin/node dist/index.js|ExecStart=/opt/servora-med/current/server/policy-probe|' \
  -e '/ProtectSystem=strict/a ReadWritePaths=/var/lib/servora-r4-policy-probe' \
  "$ROOT/ops/systemd/servora-med.service" > /etc/systemd/system/servora-med.service
systemctl daemon-reload
source "$ROOT/ops/scripts/deploy-production-host.sh"

# RED on the original helper: this missing operation cannot bound auto-restarts.
r4_suppress_restarts
[[ "$(systemctl show servora-med.service -p Restart --value)" == no ]]
if [[ "$(systemctl show servora-med.service -p ActiveState --value)" == failed ]]; then
  systemctl reset-failed servora-med.service
fi
: > /var/lib/servora-r4-policy-probe/starts
chown servora-med:servora-med /var/lib/servora-r4-policy-probe/starts
systemctl start servora-med.service || true
sleep 12
[[ "$(wc -l < /var/lib/servora-r4-policy-probe/starts)" == 1 ]]
[[ "$(systemctl show servora-med.service -p NRestarts --value)" == 0 ]]
systemctl stop servora-med.service
echo 'R4_SYSTEMD_RESTART_SUPPRESSION_PASS'
