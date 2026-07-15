#!/usr/bin/env bash
# Servora-Med PostgreSQL backup — atomic dump with checksum and ops log.
# Secrets: use PGPASSFILE or peer auth. Never put passwords on argv.
set -Eeuo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/backups/servora-med}"
OPS_LOG="${OPS_LOG:-/var/log/servora-med/backup-ops.log}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-servora}"
PGDATABASE="${PGDATABASE:-servora_med}"
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
OFFSITE_COPY_CMD="${OFFSITE_COPY_CMD:-}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_name="servora-med-${timestamp}.dump"
partial_path="${BACKUP_DIR}/${final_name}.partial"
final_path="${BACKUP_DIR}/${final_name}"
checksum_path="${final_path}.sha256"
start_epoch="$(date +%s)"

log_ops() {
  local result="$1"
  local detail="${2:-}"
  local end_epoch duration
  end_epoch="$(date +%s)"
  duration="$((end_epoch - start_epoch))"
  mkdir -p "$(dirname "$OPS_LOG")" 2>/dev/null || true
  # Never log password-bearing URLs.
  if [[ -d "$(dirname "$OPS_LOG")" ]]; then
    printf '%s result=%s file=%s duration_sec=%s %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$result" \
      "${detail:-none}" \
      "$duration" \
      "db=${PGDATABASE} host=${PGHOST}" >>"$OPS_LOG" 2>/dev/null || true
  fi
}

cleanup_partial() {
  rm -f "$partial_path"
}

on_error() {
  cleanup_partial
  log_ops "failure" "partial_removed"
  exit 1
}
trap on_error ERR

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log_ops "failure" "lock_busy"
  echo "Another backup is already running." >&2
  exit 1
fi

export PGHOST PGPORT PGUSER PGDATABASE
# Prefer PGPASSFILE from environment if set by operator.

pg_dump -Fc --no-owner --no-acl -f "$partial_path"
# Atomic publish
mv "$partial_path" "$final_path"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$final_path" >"$checksum_path"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$final_path" >"$checksum_path"
else
  echo "sha256sum or shasum required" >&2
  exit 1
fi

# Local retention: delete dumps older than 7 days (and their checksums).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -mtime +7 -print0 \
  | while IFS= read -r -d '' old; do
      rm -f "$old" "${old}.sha256"
    done

if [[ -n "$OFFSITE_COPY_CMD" ]]; then
  # Hook receives final dump path as $1. Credentials stay in the hook environment.
  # shellcheck disable=SC2086
  eval "$OFFSITE_COPY_CMD" "$final_path"
fi

log_ops "success" "$final_path"
echo "Backup written: $final_path"
exit 0
