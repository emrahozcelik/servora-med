#!/usr/bin/env bash
# Real unit-condition fixture; never use on a production host.
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(hostname)" == lima-servora-r4-20261012 ]]
[[ "$(cat /proc/1/comm)" == systemd ]]
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
sed -e 's|ExecStart=/usr/bin/node dist/index.js|ExecStart=/opt/servora-med/current/server/policy-probe|' \
  -e '/ProtectSystem=strict/a ReadWritePaths=/var/lib/servora-r4-policy-probe' \
  "$ROOT/ops/systemd/servora-med.service" > /etc/systemd/system/servora-med.service
systemctl daemon-reload
systemctl stop servora-med.service
if [[ "$(systemctl show servora-med.service -p ActiveState --value)" == failed ]]; then
  systemctl reset-failed servora-med.service
fi
: > /var/lib/servora-r4-policy-probe/starts
install -o root -g root -m 0600 /dev/null /var/lib/servora-med/deploy/activation.block
systemctl start servora-med.service
sleep 1
printf 'BARRIER_PROBE start_count=%s active=%s condition=%s\n' \
  "$(wc -l < /var/lib/servora-r4-policy-probe/starts)" \
  "$(systemctl show servora-med.service -p ActiveState --value)" \
  "$(systemctl show servora-med.service -p ConditionResult --value)"
[[ ! -s /var/lib/servora-r4-policy-probe/starts ]]
[[ "$(systemctl show servora-med.service -p ActiveState --value)" == inactive ]]
[[ "$(systemctl show servora-med.service -p ConditionResult --value)" == no ]]
echo 'R4_SYSTEMD_START_BARRIER_PASS'
