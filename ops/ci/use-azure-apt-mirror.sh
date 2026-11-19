#!/usr/bin/env bash
# Make the Azure Ubuntu mirror the first apt source for Ubuntu archive/security
# pockets and bound every apt download with retries/timeouts before Playwright
# installs its system dependencies. On 2026-11-19 the runner's mirror list
# (us-east-2.ec2.archive.ubuntu.com, archive.ubuntu.com, security.ubuntu.com)
# returned 503/timeouts for hours and later served 126 MB at ~143 kB/s, while
# azure.archive.ubuntu.com (same signed archive, same keyring, all pockets
# including -security) stayed fast. A slow mirror never triggers a fallback,
# so Azure must be preferred, not appended.
#
# The runner's existing Ubuntu mirrors stay configured as fallbacks:
# - mirror+file lists (ubuntu-24.04 runners: /etc/apt/apt-mirrors.txt) get
#   Azure at priority:1 (apt tries the lowest number first) and every other
#   entry's explicit priority shifted by one;
# - deb822 `URIs:` lines get Azure prepended as the first URI;
# - one-line `deb` entries get an Azure duplicate inserted before the original.
# Reruns add nothing. Third-party sources are left untouched. APT_ROOT exists
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

# Print one source file with Azure placed first (deb822 or one-line format).
# Portable POSIX awk; a line that already names the mirror is never touched.
add_fallback() {
  UBUNTU_URI="$UBUNTU_URI" MIRROR="$MIRROR" awk -v deb822="$2" '
    BEGIN { uri = ENVIRON["UBUNTU_URI"]; mirror = ENVIRON["MIRROR"] }
    FNR == NR { seen[$0] = 1; next }
    index($0, mirror) || $0 !~ uri { print; next }
    deb822 == 1 {
      if ($0 ~ /^URIs:/) { sub(/^URIs:[[:space:]]*/, "URIs: " mirror "/ "); sub(/[[:space:]]+$/, "") }
      print
      next
    }
    /^[[:space:]]*deb(-src)?[[:space:]]/ {
      copy = $0
      gsub(uri, mirror, copy)
      if (!(copy in seen)) { print copy; seen[copy] = 1 }
    }
    { print }
  ' "$1" "$1"
}

# Portable in-place write (GNU/BSD sed/awk differ on -i); `>` keeps mode/owner.
for file in "${sources[@]}"; do
  case "$file" in *.sources) deb822=1 ;; *) deb822=0 ;; esac
  updated="$(add_fallback "$file" "$deb822")"
  printf '%s\n' "$updated" >"$file"
done

# Ubuntu mirror lists referenced as mirror+file:<absolute path>.
lists=()
while IFS= read -r path; do
  list="$APT_ROOT$path"
  [[ -f "$list" ]] || { echo "APT_MIRROR_LIST_MISSING" >&2; exit 1; }
  grep -Eq "$UBUNTU_URI" "$list" || continue
  lists+=("$list")
  # Already rewritten: Azure is the first entry with priority:1.
  [[ "$(head -n 1 "$list")" == "$MIRROR/"$'\t'"priority:1" ]] && continue
  updated="$(MIRROR="$MIRROR" awk '
    BEGIN { mirror = ENVIRON["MIRROR"]; print mirror "/\tpriority:1" }
    index($0, mirror) { next }
    /^[[:space:]]*$/ { next }
    match($0, /priority:[0-9]+/) {
      p = substr($0, RSTART + 9, RLENGTH - 9) + 1
      $0 = substr($0, 1, RSTART - 1) "priority:" p substr($0, RSTART + RLENGTH)
    }
    { print }
  ' "$list")"
  printf '%s\n' "$updated" >"$list"
done < <(grep -Eoh 'mirror\+file:/[^[:space:]]+' "${sources[@]}" | sed 's#^mirror+file:##' | sort -u)

# Every Ubuntu deb822 URIs line, Ubuntu one-line source file and Ubuntu mirror
# list must now also name the Azure mirror.
for file in "${sources[@]}" ${lists[@]+"${lists[@]}"}; do
  if grep -Eq "$UBUNTU_URI" "$file" && ! grep -Fq "$MIRROR" "$file"; then
    echo "APT_AZURE_FALLBACK_INCOMPLETE" >&2
    exit 1
  fi
  if [[ "$file" == *.sources ]] && grep -E '^URIs:' "$file" | grep -E "$UBUNTU_URI" | grep -vF "$MIRROR" >/dev/null; then
    echo "APT_AZURE_FALLBACK_INCOMPLETE" >&2
    exit 1
  fi
done
grep -Fq "$MIRROR" "${sources[@]}" ${lists[@]+"${lists[@]}"} || { echo "APT_AZURE_MIRROR_NOT_CONFIGURED" >&2; exit 1; }

mkdir -p "$apt_dir/apt.conf.d"
cat >"$apt_dir/apt.conf.d/80-servora-ci-retries" <<'CONF'
Acquire::Retries "5";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
CONF

echo "APT_AZURE_MIRROR_READY"
