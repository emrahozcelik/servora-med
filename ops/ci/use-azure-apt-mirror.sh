#!/usr/bin/env bash
# Route Ubuntu apt traffic on GitHub-hosted runners to the Azure mirror and
# bound every apt download with retries/timeouts before Playwright installs its
# system dependencies. On 2026-11-19 security.ubuntu.com and archive.ubuntu.com
# returned 503 for hours while azure.archive.ubuntu.com (same signed archive,
# same keyring, all pockets including -security) stayed available.
#
# Only Ubuntu archive/security URIs are rewritten; third-party sources are left
# untouched. APT_ROOT exists for tests; CI runs this with sudo and no APT_ROOT.
set -Eeuo pipefail

APT_ROOT="${APT_ROOT:-}"
MIRROR="http://azure.archive.ubuntu.com/ubuntu"
UBUNTU_URI='https?://(security|([a-z]{2}\.)?archive)\.ubuntu\.com/ubuntu'
apt_dir="$APT_ROOT/etc/apt"

[[ -d "$apt_dir" ]] || { echo "APT_CONFIG_DIR_MISSING" >&2; exit 1; }

shopt -s nullglob
sources=()
for file in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.sources "$apt_dir"/sources.list.d/*.list; do
  [[ -f "$file" ]] && sources+=("$file")
done

for file in "${sources[@]}"; do
  # Portable in-place edit (GNU/BSD sed differ on -i); `>` keeps mode/owner.
  rewritten="$(sed -E "s#${UBUNTU_URI}#${MIRROR}#g" "$file")"
  printf '%s\n' "$rewritten" >"$file"
done

if ((${#sources[@]})) && grep -Eq "$UBUNTU_URI" "${sources[@]}"; then
  echo "APT_UBUNTU_MIRROR_REWRITE_INCOMPLETE" >&2
  exit 1
fi
if ! ((${#sources[@]})) || ! grep -Fq "$MIRROR" "${sources[@]}"; then
  echo "APT_AZURE_MIRROR_NOT_CONFIGURED" >&2
  exit 1
fi

mkdir -p "$apt_dir/apt.conf.d"
cat >"$apt_dir/apt.conf.d/80-servora-ci-retries" <<'CONF'
Acquire::Retries "5";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
CONF

echo "APT_AZURE_MIRROR_READY"
