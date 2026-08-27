#!/usr/bin/env bash
# Root-installed, fixed-path launcher for the SHA-scoped pre-deploy backup.
# The systemd template passes one instance argument; this helper validates it
# independently of deploy-release.sh before deriving any executable path.
set -Eeuo pipefail

readonly RELEASE_ROOT="/opt/servora-med/releases"

if [[ "$#" -ne 1 ]]; then
  echo "exactly one release SHA instance is required" >&2
  exit 64
fi

SHA="$1"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "release instance must be a 40-character lowercase hexadecimal SHA" >&2
  exit 64
fi

canonical_dir() {
  local path="$1"
  (cd -- "$path" && pwd -P)
}

assert_physical_dir() {
  local path="$1"
  local canonical
  [[ -d "$path" && ! -L "$path" ]] || return 1
  canonical="$(canonical_dir "$path")" || return 1
  [[ "$canonical" == "$path" ]]
}

assert_physical_file() {
  local path="$1"
  local parent canonical
  [[ -f "$path" && ! -L "$path" ]] || return 1
  parent="$(canonical_dir "$(dirname -- "$path")")" || return 1
  canonical="${parent}/$(basename -- "$path")"
  [[ "$canonical" == "$path" ]]
}

if ! assert_physical_dir "$RELEASE_ROOT"; then
  echo "release root is not a physical directory: $RELEASE_ROOT" >&2
  exit 65
fi

readonly RELEASE_DIR="${RELEASE_ROOT}/${SHA}"
if ! assert_physical_dir "$RELEASE_DIR"; then
  echo "release instance is not a physical directory: $RELEASE_DIR" >&2
  exit 65
fi

readonly BACKUP_SCRIPT="${RELEASE_DIR}/ops/scripts/backup-postgres.sh"
if ! assert_physical_file "$BACKUP_SCRIPT" || [[ ! -x "$BACKUP_SCRIPT" ]]; then
  echo "release backup script is missing, escaped, or not executable" >&2
  exit 65
fi

exec "$BACKUP_SCRIPT"
