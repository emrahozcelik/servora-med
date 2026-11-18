#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# OPS-R4-005: exact historical evidence staging ONLY. Never removes a live
# source, finalizes ARCHIVE-COMPLETE, writes root approvals, or deploys.
# Install root:root 0750, do not grant via deploy sudoers.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV
fail(){ printf '%s\n' "$1" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || fail RECOVERY_HISTORICAL_STAGE_ADMIN_REQUIRED
[[ "$#" -eq 0 ]] || fail RECOVERY_HISTORICAL_STAGE_ARGUMENTS_INVALID

trusted_file() {
  local path="$1" mode="$2" directory
  [[ "$(realpath -e "$path")" == "$path" && -f "$path" && ! -L "$path" \
    && "$(stat -c '%U:%G:%a:%h' "$path")" == "root:root:$mode:1" ]] \
      || fail RECOVERY_HISTORICAL_STAGE_TOOL_UNTRUSTED
  directory="$(dirname "$path")"
  while [[ "$directory" != / ]]; do
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c %u "$directory")" == 0 \
      && $((8#$(stat -c %a "$directory") & 8#022)) -eq 0 ]] \
        || fail RECOVERY_HISTORICAL_STAGE_TOOL_UNTRUSTED
    directory="$(dirname "$directory")"
  done
}
readonly library=/usr/local/libexec/servora-med/host-operation-lock.sh
trusted_file "$library" 644
[[ "$(sha256sum "$library" | awk '{print $1}')" == \
  a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e ]] \
  || fail RECOVERY_HISTORICAL_STAGE_TOOL_UNTRUSTED
for file in deployment-controller.mjs historical-archive-preflight.mjs historical-archive-stage.mjs \
  historical-recovery-evidence.mjs \
  deployment-attempt.mjs deployment-db-guard.mjs migration-reconciliation.mjs trusted-time.mjs; do
  trusted_file "/usr/local/libexec/servora-med/$file" 644
done
node_path="$(realpath -e /usr/bin/node)"
trusted_file "$node_path" 755

# Stable host lock is never removed, replaced, or reclaimed.
[[ -f /var/lib/servora-med/deploy/host.lock && ! -L /var/lib/servora-med/deploy/host.lock ]] \
  || fail RECOVERY_HISTORICAL_STAGE_HOST_LOCK_REQUIRED
# shellcheck source=host-operation-lock.sh
source "$library"
servora_acquire_host_lock
servora_assert_no_pending_attempt
exec /usr/bin/env -i PATH="$PATH" LANG=C LC_ALL=C "$node_path" \
  /usr/local/libexec/servora-med/historical-archive-stage.mjs
