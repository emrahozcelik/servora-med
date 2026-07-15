#!/usr/bin/env bash
# Servora-Med PostgreSQL backup — atomic dump with portable checksum and ops log.
# Secrets: use PGPASSFILE or peer auth. Never put passwords on argv.
set -Eeuo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
OPS_LOG="${OPS_LOG:?OPS_LOG is required}"
PGHOST="${PGHOST:?PGHOST is required}"
PGPORT="${PGPORT:?PGPORT is required}"
PGUSER="${PGUSER:?PGUSER is required}"
PGDATABASE="${PGDATABASE:?PGDATABASE is required}"
LOCK_DIR="${BACKUP_DIR}/.backup.lock.d"
OFFSITE_COPY_HOOK="${OFFSITE_COPY_HOOK:-}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_name="servora-med-${timestamp}.dump"
partial_path="${BACKUP_DIR}/${final_name}.partial"
final_path="${BACKUP_DIR}/${final_name}"
checksum_partial="${BACKUP_DIR}/${final_name}.sha256.partial"
checksum_path="${BACKUP_DIR}/${final_name}.sha256"
start_epoch="$(date +%s)"

log_ops() {
  local result="$1"
  local detail="${2:-}"
  local end_epoch duration
  end_epoch="$(date +%s)"
  duration="$((end_epoch - start_epoch))"
  mkdir -p "$(dirname "$OPS_LOG")" 2>/dev/null || true
  if [[ -d "$(dirname "$OPS_LOG")" ]]; then
    printf '%s result=%s file=%s duration_sec=%s %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$result" \
      "${detail:-none}" \
      "$duration" \
      "db=${PGDATABASE} host=${PGHOST}" >>"$OPS_LOG" 2>/dev/null || true
  fi
}

cleanup_partials() {
  rm -f "$partial_path" "$checksum_partial"
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

on_error() {
  cleanup_partials
  # Do not leave a half-published final dump/checksum pair.
  if [[ ! -f "$checksum_path" ]]; then
    rm -f "$final_path"
  fi
  release_lock
  log_ops "failure" "partial_removed"
  exit 1
}
trap on_error ERR
trap release_lock EXIT

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "sha256sum or shasum required" >&2
    exit 1
  fi
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Portable exclusive lock (mkdir is atomic; no util-linux flock dependency).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log_ops "failure" "lock_busy"
  echo "Another backup is already running." >&2
  exit 1
fi

export PGHOST PGPORT PGUSER PGDATABASE

pg_dump -Fc --no-owner --no-acl -f "$partial_path"

digest="$(hash_file "$partial_path")"
# Portable sidecar: hash + basename only (no absolute path).
printf '%s  %s\n' "$digest" "$final_name" >"$checksum_partial"

# Verify before publish.
verify_digest="$(hash_file "$partial_path")"
[[ "$verify_digest" == "$digest" ]] || {
  echo "Checksum self-verify failed" >&2
  exit 1
}

mv "$partial_path" "$final_path"
mv "$checksum_partial" "$checksum_path"

# Local retention: delete dumps older than 7 days (and their checksums).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -mtime +7 -print0 \
  | while IFS= read -r -d '' old; do
      rm -f "$old" "${old}.sha256"
    done

if [[ -n "$OFFSITE_COPY_HOOK" ]]; then
  if [[ ! -x "$OFFSITE_COPY_HOOK" ]]; then
    echo "OFFSITE_COPY_HOOK is not executable: $OFFSITE_COPY_HOOK" >&2
    exit 1
  fi
  "$OFFSITE_COPY_HOOK" "$final_path" "$checksum_path"
fi

log_ops "success" "$final_path"
echo "Backup written: $final_path"
exit 0
