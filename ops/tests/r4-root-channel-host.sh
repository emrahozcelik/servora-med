#!/usr/bin/env bash
# Fixture administrator versus deployment actor separation, on the R4 VM only.
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(hostname)" == lima-servora-r4-20261012 ]]
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
id servora-deploy >/dev/null
install -d -o root -g root -m 0755 /usr/local/libexec/servora-med
install -o root -g root -m 0755 "$ROOT/ops/scripts/deploy-production-host.sh" /usr/local/libexec/servora-med/deploy-production-host
install -d -o root -g root -m 0700 /var/lib/servora-med/deploy/approvals
printf '%s\n' 'SYNTHETIC_CHANNEL_PROBE_NOT_A_DEPLOYMENT_APPROVAL' > /var/lib/servora-med/deploy/approvals/channel-probe
chmod 0600 /var/lib/servora-med/deploy/approvals/channel-probe
digest="$(sha256sum /usr/local/libexec/servora-med/deploy-production-host | cut -d' ' -f1)"
printf 'servora-deploy ALL=(root) NOPASSWD: sha256:%s /usr/local/libexec/servora-med/deploy-production-host --help\n' "$digest" > /etc/sudoers.d/servora-r4-channel-probe
chmod 0440 /etc/sudoers.d/servora-r4-channel-probe
visudo -cf /etc/sudoers.d/servora-r4-channel-probe
runuser -u servora-deploy -- sudo -n /usr/local/libexec/servora-med/deploy-production-host --help
if runuser -u servora-deploy -- sh -c 'printf forged > /var/lib/servora-med/deploy/approvals/channel-probe' 2>/dev/null; then
  echo 'ROOT_CHANNEL_FAILED approval_write_allowed'; exit 1
fi
if runuser -u servora-deploy -- ln -sf /tmp/forged /var/lib/servora-med/deploy/approvals/channel-probe 2>/dev/null; then
  echo 'ROOT_CHANNEL_FAILED approval_replacement_allowed'; exit 1
fi
if runuser -u servora-deploy -- sudo -n /bin/sh -c true 2>/dev/null; then
  echo 'ROOT_CHANNEL_FAILED arbitrary_shell_allowed'; exit 1
fi
if runuser -u servora-deploy -- sudo -n systemctl restart servora-med.service 2>/dev/null; then
  echo 'ROOT_CHANNEL_FAILED arbitrary_systemctl_allowed'; exit 1
fi
if runuser -u servora-deploy -- sudo -n /usr/local/libexec/servora-med/deploy-production-host --phase rollback --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --fqdn example.test 2>/dev/null; then
  echo 'ROOT_CHANNEL_FAILED unapproved_arguments_allowed'; exit 1
fi
[[ "$(cat /var/lib/servora-med/deploy/approvals/channel-probe)" == SYNTHETIC_CHANNEL_PROBE_NOT_A_DEPLOYMENT_APPROVAL ]]
printf 'ROOT_CHANNEL_PROBE owner=%s mode=%s\n' \
  "$(stat -c %U /var/lib/servora-med/deploy/approvals/channel-probe)" \
  "$(stat -c %a /var/lib/servora-med/deploy/approvals/channel-probe)"
echo 'R4_ROOT_CHANNEL_SEPARATION_PASS'
echo 'FULL_ATTEMPT_ADMISSION=NOT_RUN'
