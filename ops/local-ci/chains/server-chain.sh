#!/usr/bin/env bash
# Server chain for ops/local-ci/run.sh — reproduces the CI `server` job.
# Runs inside node:22-bookworm with /repo (exact tree, ro) and /logs (rw).
# Each check writes /logs/<id>.log; failures abort the chain (set -e) so any
# unexecuted check is simply absent and fails closed at manifest assembly.
set -Eeuo pipefail
prepare_check_logs() {
  local logs="$1"
  mkdir -p "$logs/aux"
  # Retain the host owner so it can read evidence and remove a prior run.
  # Grant only the container's node group access, never world write access.
  chgrp node "$logs" "$logs/aux"
  chmod g+rwx "$logs" "$logs/aux"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
export DEBIAN_FRONTEND=noninteractive

prepare_check_logs /logs
echo "=== stage A (root): toolchain ===" | tee /logs/aux/stage-a.log
apt-get update -qq >>/logs/aux/stage-a.log 2>&1
apt-get install -y -qq shellcheck curl ca-certificates gnupg lsb-release systemd zstd jq >>/logs/aux/stage-a.log 2>&1
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq >>/logs/aux/stage-a.log 2>&1
apt-get install -y -qq postgresql-client-17 gh >>/logs/aux/stage-a.log 2>&1
/usr/lib/postgresql/17/bin/psql --version 2>&1 | tee -a /logs/aux/stage-a.log
curl -fsSL -o /tmp/age.tar.gz "https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-linux-amd64.tar.gz"
echo "bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377  /tmp/age.tar.gz" | sha256sum --check --strict - >>/logs/aux/stage-a.log 2>&1
tar -xzf /tmp/age.tar.gz -C /tmp
install -m 0755 /tmp/age/age /tmp/age/age-keygen /tmp/age/age-inspect /usr/local/bin/
age --version 2>&1 | tee -a /logs/aux/stage-a.log
node --version 2>&1 | tee -a /logs/aux/stage-a.log
grep PRETTY_NAME /etc/os-release | tee -a /logs/aux/stage-a.log
bash /chains/verify-log-permissions.sh >>/logs/aux/stage-a.log 2>&1

rm -rf /work && cp -a /repo /work
SERVORA_R4_ISOLATED_CLI_TEST=1 node --test /work/ops/tests/installed-old-adoption-cli-root.test.mjs > /logs/aux/installed-old-adoption-cli-root.log 2>&1
cp /chains/static-syntax.sh /work/ops-local-ci-static-syntax.sh
cp /chains/dep-smoke.sh /work/ops-local-ci-dep-smoke.sh
cp /chains/server-chain-user.sh /work/ops-local-ci-stage-b.sh
chmod +x /work/ops-local-ci-*.sh
chown -R node:node /work
su node -s /bin/bash /work/ops-local-ci-stage-b.sh
rm -f /work/ops-local-ci-*.sh
echo SERVER-CHAIN-COMPLETE
