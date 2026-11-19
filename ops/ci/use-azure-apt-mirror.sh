#!/usr/bin/env bash
# Route Ubuntu apt traffic on GitHub-hosted runners to the Azure mirror and
# bound every apt download with retries/timeouts before Playwright installs its
# system dependencies. On 2026-11-19 the runner's mirror list
# (us-east-2.ec2.archive.ubuntu.com, archive.ubuntu.com, security.ubuntu.com)
# returned 503/timeouts for hours while azure.archive.ubuntu.com (same signed
# archive, same keyring, all pockets including -security) stayed available.
#
# ubuntu-24.04 runner images declare `URIs: mirror+file:/etc/apt/apt-mirrors.txt`,
# so both direct Ubuntu URIs and Ubuntu mirror lists referenced via mirror+file
# are pointed at Azure. Third-party sources are left untouched. APT_ROOT exists
# for tests; CI runs this with sudo and no APT_ROOT.
set -Eeuo pipefail

APT_ROOT="${APT_ROOT:-}"
MIRROR="http://azure.archive.ubuntu.com/ubuntu"
UBUNTU_URI='https?://([a-z0-9-]+\.)*(security|archive)\.ubuntu\.com/ubuntu'
apt_dir="$APT_ROOT/etc/apt"

[[ -d "$apt_dir" ]] || { echo "APT_CONFIG_DIR_MISSING" >&2; exit 1; }

shopt -s nullglob
sources=()
for file in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.sources "$apt_dir"/sources.list.d/*.list; do
  [[ -f "$file" ]] && sources+=("$file")
done
((${#sources[@]})) || { echo "APT_AZURE_MIRROR_NOT_CONFIGURED" >&2; exit 1; }

# Portable in-place edit (GNU/BSD sed differ on -i); `>` keeps mode/owner.
rewrite() {
  local rewritten
  rewritten="$(sed -E "s#${UBUNTU_URI}#${MIRROR}#g" "$1")"
  printf '%s\n' "$rewritten" >"$1"
}

for file in "${sources[@]}"; do
  rewrite "$file"
done

# Ubuntu mirror lists referenced as mirror+file:<absolute path>.
lists=()
while IFS= read -r path; do
  list="$APT_ROOT$path"
  [[ -f "$list" ]] || { echo "APT_MIRROR_LIST_MISSING" >&2; exit 1; }
  if grep -Eq "$UBUNTU_URI" "$list"; then
    printf '%s/\tpriority:1\n' "$MIRROR" >"$list"
    lists+=("$list")
  fi
done < <(grep -Eoh 'mirror\+file:/[^[:space:]]+' "${sources[@]}" | sed 's#^mirror+file:##' | sort -u)

configured=("${sources[@]}" ${lists[@]+"${lists[@]}"})
# No `grep -q` in the pipe: an early exit would SIGPIPE the producer under pipefail.
if grep -Eh "$UBUNTU_URI" "${configured[@]}" | grep -vF "$MIRROR" >/dev/null; then
  echo "APT_UBUNTU_MIRROR_REWRITE_INCOMPLETE" >&2
  exit 1
fi
grep -Fq "$MIRROR" "${configured[@]}" || { echo "APT_AZURE_MIRROR_NOT_CONFIGURED" >&2; exit 1; }

mkdir -p "$apt_dir/apt.conf.d"
cat >"$apt_dir/apt.conf.d/80-servora-ci-retries" <<'CONF'
Acquire::Retries "5";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
CONF

echo "APT_AZURE_MIRROR_READY"
