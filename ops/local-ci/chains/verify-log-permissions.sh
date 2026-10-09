#!/usr/bin/env bash
# Cross-UID acceptance: node can write, original host owner can remove logs.
# shellcheck disable=SC2016 # Positional arguments expand in the child shell.
set -Eeuo pipefail
# shellcheck source=ops/local-ci/chains/server-chain.sh
# shellcheck disable=SC1091
source "$(dirname -- "${BASH_SOURCE[0]}")/server-chain.sh"
fixture=$(mktemp -d /tmp/servora-log-permissions.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
chmod 755 "$fixture"
for fixture_owner in 501 0; do
  logs="$fixture/logs-$fixture_owner"
  mkdir -p "$logs/aux"
  chown -R "$fixture_owner:$fixture_owner" "$logs"
  chmod 750 "$logs" "$logs/aux"
  if su node -s /bin/bash -c 'test -w "$1"' -- log-test "$logs"; then exit 1; fi
  prepare_check_logs "$logs"
  su node -s /bin/bash -c 'printf "synthetic\n" >"$1/check.log"; printf "auxiliary\n" >"$1/aux/check.log"' -- log-test "$logs"
  [[ $(stat -c '%u' "$logs") == "$fixture_owner" ]]
  [[ $(stat -c '%a' "$logs") == 770 ]]
  setpriv --reuid="$fixture_owner" --regid="$fixture_owner" --clear-groups bash -c 'rm -- "$1/check.log" "$1/aux/check.log"' host-test "$logs"
done
echo LOG_PERMISSIONS_ACCEPTANCE_PASS
