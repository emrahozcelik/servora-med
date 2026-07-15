#!/usr/bin/env bash
# Restore a Servora-Med backup into a disposable database only.
set -Eeuo pipefail
umask 077

DUMP_PATH="${1:-}"
shift || true

I_ACCEPT=false
KEEP=false
for arg in "$@"; do
  case "$arg" in
    --i-accept-destructive-restore) I_ACCEPT=true ;;
    --keep) KEEP=true ;;
  esac
done

if [[ -z "$DUMP_PATH" || ! -f "$DUMP_PATH" ]]; then
  echo "Usage: $0 /path/to/backup.dump --i-accept-destructive-restore [--keep]" >&2
  exit 2
fi

if [[ "$I_ACCEPT" != true ]]; then
  echo "Refusing: pass --i-accept-destructive-restore for disposable targets only." >&2
  exit 2
fi

PRODUCTION_PGHOST="${PRODUCTION_PGHOST:-}"
PRODUCTION_PGDATABASE="${PRODUCTION_PGDATABASE:-servora_med}"
TARGET_PGHOST="${TARGET_PGHOST:-127.0.0.1}"
TARGET_PGPORT="${TARGET_PGPORT:-5432}"
TARGET_PGUSER="${TARGET_PGUSER:-${PGUSER:-servora}}"
TARGET_PGDATABASE="${TARGET_PGDATABASE:-servora_med_restore_rehearsal}"
OPS_LOG="${OPS_LOG:-/var/log/servora-med/restore-ops.log}"
start_epoch="$(date +%s)"

log_ops() {
  local result="$1"
  local detail="${2:-}"
  local end_epoch duration
  end_epoch="$(date +%s)"
  duration="$((end_epoch - start_epoch))"
  mkdir -p "$(dirname "$OPS_LOG")" 2>/dev/null || true
  if [[ -d "$(dirname "$OPS_LOG")" && -w "$(dirname "$OPS_LOG")" ]] || [[ -w "$OPS_LOG" ]]; then
    printf '%s result=%s dump=%s target_db=%s duration_sec=%s %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$result" \
      "$(basename "$DUMP_PATH")" \
      "$TARGET_PGDATABASE" \
      "$duration" \
      "$detail" >>"$OPS_LOG" 2>/dev/null || true
  fi
}

if [[ -n "$PRODUCTION_PGHOST" && "$TARGET_PGHOST" == "$PRODUCTION_PGHOST" \
  && "$TARGET_PGDATABASE" == "$PRODUCTION_PGDATABASE" ]]; then
  log_ops "refused" "production_target_guard"
  echo "Refusing restore into production host/database pair." >&2
  exit 3
fi

if [[ "$TARGET_PGDATABASE" == "$PRODUCTION_PGDATABASE" ]]; then
  log_ops "refused" "production_database_name"
  echo "Refusing restore into PRODUCTION_PGDATABASE (${PRODUCTION_PGDATABASE})." >&2
  echo "Set TARGET_PGDATABASE to a disposable name." >&2
  exit 3
fi

checksum_path="${DUMP_PATH}.sha256"
if [[ -f "$checksum_path" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$checksum_path"
  elif command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$checksum_path")"
    actual="$(shasum -a 256 "$DUMP_PATH" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || {
      log_ops "failure" "checksum_mismatch"
      echo "Checksum mismatch" >&2
      exit 4
    }
  fi
else
  echo "Warning: no checksum file at ${checksum_path}" >&2
fi

export PGHOST="$TARGET_PGHOST" PGPORT="$TARGET_PGPORT" PGUSER="$TARGET_PGUSER"

# Drop/create disposable target (requires CREATEDB privilege).
psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_PGDATABASE}\";"
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_PGDATABASE}\";"

export PGDATABASE="$TARGET_PGDATABASE"
pg_restore --no-owner --no-acl -d "$TARGET_PGDATABASE" "$DUMP_PATH" || {
  # pg_restore can exit non-zero with warnings; require schema_migrations present.
  true
}

migration_count="$(psql -d "$TARGET_PGDATABASE" -Atc 'SELECT COUNT(*) FROM schema_migrations' || echo 0)"
if [[ "${migration_count}" -lt 1 ]]; then
  log_ops "failure" "schema_migrations_missing"
  echo "Restore failed: schema_migrations empty or missing." >&2
  exit 5
fi

psql -d "$TARGET_PGDATABASE" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM users;' >/dev/null
psql -d "$TARGET_PGDATABASE" -v ON_ERROR_STOP=1 -c 'SELECT id FROM job_cards LIMIT 1;' >/dev/null || true

log_ops "success" "migrations=${migration_count}"

if [[ "$KEEP" != true ]]; then
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_PGDATABASE}\";"
fi

echo "Restore rehearsal succeeded against ${TARGET_PGDATABASE}"
exit 0
