#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Administrator-only first-cutover attestation. Never add this to deploy sudoers.
# Install root:root 0750 as /usr/local/libexec/servora-med/issue-installed-old-adoption.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || fail RECOVERY_ADOPTION_ADMIN_REQUIRED
[[ "$#" -eq 2 && "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
  && "$2" =~ ^[0-9]{8}T[0-9]{6}Z-issue369-71ae6df6$ ]] || fail RECOVERY_ADOPTION_ARGUMENTS_INVALID

trusted_file() {
  local path="$1" mode="$2" directory
  [[ "$(realpath -e "$path")" == "$path" && -f "$path" && ! -L "$path" \
    && "$(stat -c '%U:%G:%a:%h' "$path")" == "root:root:$mode:1" ]] || fail RECOVERY_ADOPTION_TOOL_UNTRUSTED
  directory="$(dirname "$path")"
  while [[ "$directory" != / ]]; do
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c %u "$directory")" == 0 \
      && $((8#$(stat -c %a "$directory") & 8#022)) -eq 0 ]] || fail RECOVERY_ADOPTION_TOOL_UNTRUSTED
    directory="$(dirname "$directory")"
  done
}
readonly library=/usr/local/libexec/servora-med/host-operation-lock.sh
trusted_file "$library" 644
[[ "$(sha256sum "$library" | awk '{print $1}')" == a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e ]] \
  || fail RECOVERY_ADOPTION_TOOL_UNTRUSTED
for module in deployment-attempt deployment-controller deployment-db-guard migration-reconciliation trusted-time; do
  trusted_file "/usr/local/libexec/servora-med/$module.mjs" 644
done
node_path="$(realpath -e /usr/bin/node)"
trusted_file "$node_path" 755
# Bootstrap must already have provisioned this stable inode. Issuance does not
# create a host lock, repair a journal, change services or install a profile.
[[ -f /var/lib/servora-med/deploy/host.lock && ! -L /var/lib/servora-med/deploy/host.lock ]] \
  || fail RECOVERY_ADOPTION_HOST_LOCK_REQUIRED
# shellcheck source=host-operation-lock.sh
source "$library"
servora_acquire_host_lock
exec /usr/bin/env -i PATH="$PATH" LANG=C LC_ALL=C "$node_path" --input-type=module --eval '
  import {issueInstalledOldAdoption} from "/usr/local/libexec/servora-med/deployment-controller.mjs";
  try {
    const sealed=issueInstalledOldAdoption(process.argv[1],process.argv[2]);
    console.log(JSON.stringify({status:"INSTALLED_OLD_ADOPTION_SEALED",sha256:sealed.sha256}));
  } catch(error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:"RECOVERY_ADOPTION_ISSUANCE_FAILED");
    process.exitCode=1;
  }
' "$1" "$2"
