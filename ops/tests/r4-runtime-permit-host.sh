#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" -eq 0 && "$(hostname)" == lima-servora-r4-20261012 ]]
[[ -f /var/lib/servora-med/deploy/activation.block ]]
[[ "$(systemctl show servora-med.service -p Restart --value)" == no ]]
[[ "$(readlink /opt/servora-med/current)" == /opt/servora-med/releases/e4ca2b19f7865dca3f1e4597dd099ed167667a19 ]]
permit=/run/servora-med-recovery/start.permit
install -d -o root -g root -m 0700 /run/servora-med-recovery
[[ ! -e "$permit" && ! -L "$permit" ]]
trap 'systemctl stop servora-med.service; rm -f -- "$permit"' EXIT
systemctl stop servora-med.service
systemctl start servora-med.service
[[ "$(systemctl show servora-med.service -p MainPID --value)" == 0 ]]
echo PERSISTENT_BARRIER_WITHOUT_RUNTIME_PERMIT=PASS
install -o root -g root -m 0600 /dev/null "$permit"
systemctl start servora-med.service
pid="$(systemctl show servora-med.service -p MainPID --value)"
[[ "$pid" != 0 ]] || { echo RUNTIME_PERMIT_CANNOT_START_REAL_SERVICE; exit 1; }
rm -- "$permit"
healthy=false
for ((i=0; i<30; i++)); do
  if curl --fail --silent http://127.0.0.1:3000/api/health | /usr/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const h=JSON.parse(s);if(h.status!=="ok"||h.releaseSha!=="e4ca2b19f7865dca3f1e4597dd099ed167667a19")process.exit(1)}catch{process.exit(1)}});'; then healthy=true; break; fi
  sleep 1
done
[[ "$healthy" == true ]] || { echo REAL_FASTIFY_HEALTH_FAILED; exit 1; }
[[ "$(readlink "/proc/$pid/cwd")" == /opt/servora-med/releases/e4ca2b19f7865dca3f1e4597dd099ed167667a19/server ]]
[[ -f /var/lib/servora-med/deploy/activation.block && ! -e "$permit" ]]
echo REAL_FASTIFY_START_WITH_PERSISTENT_BARRIER=PASS
