#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# OPS-R4-003 administrator-only, no-argument historical disposition. It never
# completes, accepts, resumes or activates the attempt. Never add this command
# to deploy sudoers. Install root:root 0750 as
# /usr/local/libexec/servora-med/issue-historical-recovery-disposition-6ce4cff0.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || fail RECOVERY_DISPOSITION_ADMIN_REQUIRED
[[ "$#" -eq 0 ]] || fail RECOVERY_DISPOSITION_ARGUMENTS_INVALID

trusted_file() {
  local path="$1" mode="$2" directory
  [[ "$(realpath -e "$path")" == "$path" && -f "$path" && ! -L "$path" \
    && "$(stat -c '%U:%G:%a:%h' "$path")" == "root:root:$mode:1" ]] || fail RECOVERY_DISPOSITION_TOOL_UNTRUSTED
  directory="$(dirname "$path")"
  while [[ "$directory" != / ]]; do
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c %u "$directory")" == 0 \
      && $((8#$(stat -c %a "$directory") & 8#022)) -eq 0 ]] || fail RECOVERY_DISPOSITION_TOOL_UNTRUSTED
    directory="$(dirname "$directory")"
  done
}
readonly library=/usr/local/libexec/servora-med/host-operation-lock.sh
trusted_file "$library" 644
[[ "$(sha256sum "$library" | awk '{print $1}')" == a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e ]] \
  || fail RECOVERY_DISPOSITION_TOOL_UNTRUSTED
for module in deployment-attempt deployment-controller deployment-db-guard migration-reconciliation trusted-time historical-recovery-evidence; do
  trusted_file "/usr/local/libexec/servora-med/$module.mjs" 644
done
node_path="$(realpath -e /usr/bin/node)"
trusted_file "$node_path" 755
[[ -f /var/lib/servora-med/deploy/host.lock && ! -L /var/lib/servora-med/deploy/host.lock ]] \
  || fail RECOVERY_DISPOSITION_HOST_LOCK_REQUIRED
# shellcheck source=host-operation-lock.sh
source "$library"
servora_acquire_host_lock
exec /usr/bin/env -i PATH="$PATH" LANG=C LC_ALL=C "$node_path" --input-type=module --eval '
  import {issueHistoricalRecoveryDisposition} from "/usr/local/libexec/servora-med/deployment-controller.mjs";
  try {
    const sealed=issueHistoricalRecoveryDisposition();
    console.log(JSON.stringify({status:"HISTORICAL_RECOVERY_DISPOSITION_SEALED",sha256:sealed.sha256}));
  } catch(error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:"RECOVERY_DISPOSITION_ISSUANCE_FAILED");
    process.exitCode=1;
  }
'
