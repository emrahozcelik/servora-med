#!/usr/bin/env bash
# Read-only fixed-path B1-01 guard. No lock creation or state writer.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV
fail() { printf '%s\n' BOOTSTRAP_FENCE_TOOL_UNTRUSTED >&2; exit 1; }
[[ "$EUID" -eq 0 && "$#" -ge 1 && "$#" -le 2 ]] || fail
trusted_file() {
  local path="$1" mode="$2" parent
  [[ "$(realpath -e "$path")" == "$path" && -f "$path" && ! -L "$path" \
    && "$(stat -c '%U:%G:%a:%h' "$path")" == "root:root:$mode:1" ]] || fail
  parent="$(dirname "$path")"
  while [[ "$parent" != / ]]; do
    [[ -d "$parent" && ! -L "$parent" && "$(stat -c %u "$parent")" == 0 \
      && $((8#$(stat -c %a "$parent") & 8#022)) -eq 0 ]] || fail
    parent="$(dirname "$parent")"
  done
}
readonly module=/usr/local/libexec/servora-med/bootstrap-fence.mjs
trusted_file /usr/local/libexec/servora-med/bootstrap-fence 755
trusted_file "$module" 644
[[ "$(sha256sum "$module" | awk '{print $1}')" == 068ea5157b89fd2dc3303acd1343b22a57c71b2bcd79ec3d3a42ee6c18174f31 ]] || fail
node_path="$(realpath -e /usr/bin/node)"
trusted_file "$node_path" 755
exec /usr/bin/env -i PATH="$PATH" LANG=C LC_ALL=C "$node_path" "$module" "$@"
