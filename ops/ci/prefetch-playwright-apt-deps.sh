#!/usr/bin/env bash
# Download (never install) the apt packages that `playwright install --with-deps`
# needs, in bounded attempts, before the real install runs from the warm cache.
#
# On 2026-11-20 two web jobs stalled for the full 15-minute step timeout while
# apt fetched ~126 MB from azure.archive.ubuntu.com at ~60 kB/s; a concurrent
# job got the same 126 MB from the same mirror in 5 s. A slow-but-alive
# connection never trips Acquire::http::Timeout or the mirror+file fallback,
# so a time bound is the only signal. Download-only attempts are safe to kill:
# dpkg never runs, completed .debs stay in the archive cache and partial ones
# resume. After a failed attempt the Azure entry that use-azure-apt-mirror.sh
# put first is moved to the end of the mirror list, so the retry uses the
# runner's own Ubuntu mirrors on a fresh connection (the 2026-11-19 failure
# was the reverse case). Both attempts failing fails the step early with
# PLAYWRIGHT_APT_PREFETCH_FAILED instead of hanging.
#
# Run from web/ after use-azure-apt-mirror.sh and npm ci. APT_ROOT and the
# attempt length exist for tests; CI uses the defaults.
set -Eeuo pipefail

APT_ROOT="${APT_ROOT:-}"
ATTEMPT_SECONDS="${PLAYWRIGHT_APT_ATTEMPT_SECONDS:-240}"
MIRROR="http://azure.archive.ubuntu.com/ubuntu/"
apt_dir="$APT_ROOT/etc/apt"
conf="$apt_dir/apt.conf.d/81-servora-ci-download-only"

[[ -d "$apt_dir/apt.conf.d" ]] || { echo "APT_CONFIG_DIR_MISSING" >&2; exit 1; }

# Move the Azure entry from first to last place in every mirror+file list.
demote_azure() {
  local path list updated
  while IFS= read -r path; do
    list="$APT_ROOT$path"
    [[ -f "$list" && "$(head -n 1 "$list")" == "$MIRROR"$'\t'"priority:1" ]] || continue
    updated="$(MIRROR="$MIRROR" awk '
      BEGIN { mirror = ENVIRON["MIRROR"]; max = 1 }
      index($0, mirror) || /^[[:space:]]*$/ { next }
      match($0, /priority:[0-9]+/) { p = substr($0, RSTART + 9, RLENGTH - 9) + 0; if (p > max) max = p }
      { print }
      END { print mirror "\tpriority:" (max + 1) }
    ' "$list")"
    printf '%s\n' "$updated" | sudo tee "$list" >/dev/null
    echo "APT_AZURE_MIRROR_DEMOTED $path"
  done < <(cat "$apt_dir/sources.list" "$apt_dir"/sources.list.d/* 2>/dev/null \
    | grep -Eo 'mirror\+file:/[^[:space:]]+' | sed 's#^mirror+file:##' | sort -u)
}

trap 'sudo rm -f "$conf"' EXIT
# The lock timeout covers an apt-get that is still exiting after a timeout.
printf '%s\n' 'APT::Get::Download-Only "true";' 'DPkg::Lock::Timeout "120";' | sudo tee "$conf" >/dev/null

for attempt in 1 2; do
  status=0
  timeout -k 30 "$ATTEMPT_SECONDS" npx playwright install-deps chromium webkit || status=$?
  if ((status == 0)); then
    echo "PLAYWRIGHT_APT_PREFETCH_READY attempt=$attempt"
    exit 0
  fi
  echo "PLAYWRIGHT_APT_PREFETCH_ATTEMPT_FAILED attempt=$attempt status=$status limit=${ATTEMPT_SECONDS}s" >&2
  if ((attempt == 1)); then demote_azure; fi
done

echo "PLAYWRIGHT_APT_PREFETCH_FAILED" >&2
exit 1
