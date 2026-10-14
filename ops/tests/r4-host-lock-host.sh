#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" -eq 0 && "$(hostname)" == lima-servora-r4-20261012 ]]
lock=/var/lib/servora-med/deploy/host.lock
[[ -e "$lock" ]] || install -o root -g root -m 0600 /dev/null "$lock"
[[ ! -L "$lock" && "$(stat -c '%U:%G:%a:%h' "$lock")" == root:root:600:1 ]]
inode="$(stat -c '%d:%i' "$lock")"
exec 8<>"$lock"
flock -n 8
set +e
output="$(/usr/local/libexec/servora-med/deploy-production-host --phase forward-recovery --attempt-id 99999999-9999-4999-8999-999999999999 8>&- 2>&1)"
code=$?
set -e
printf 'HOST_LOCK_CONCURRENT_EXIT=%s\n%s\n' "$code" "$output"
[[ "$code" != 0 && "$output" == *HOST_DEPLOYMENT_LOCK_BUSY* ]]
flock -u 8
[[ "$inode" == "$(stat -c '%d:%i' "$lock")" ]]
echo COMMON_HOST_KERNEL_LOCK_CONCURRENCY=PASS
