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
TARGET_PGUSER="${TARGET_PGUSER:-${PGUSER:-}}"
TARGET_PGDATABASE="${TARGET_PGDATABASE:-servora_med_restore_rehearsal}"
OPS_LOG="${OPS_LOG:-/var/log/servora-med/restore-ops.log}"
start_epoch="$(date +%s)"
target_created=false

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

validate_ident() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    log_ops "refused" "invalid_${name}"
    echo "Invalid ${name}: must match ^[A-Za-z_][A-Za-z0-9_]*$" >&2
    exit 6
  fi
}

cleanup_target() {
  if [[ "$target_created" == true && "$KEEP" != true ]]; then
    PGHOST="$TARGET_PGHOST" PGPORT="$TARGET_PGPORT" PGUSER="$TARGET_PGUSER" \
      psql -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"${TARGET_PGDATABASE}\";" >/dev/null 2>&1 || true
  fi
}

on_error() {
  local code=$?
  log_ops "failure" "err_trap_exit_${code}"
  cleanup_target
  echo "Restore failed (exit ${code})." >&2
  exit "$code"
}
trap on_error ERR

if [[ -z "${TARGET_PGUSER}" ]]; then
  log_ops "refused" "missing_target_pguser"
  echo "TARGET_PGUSER (or PGUSER) is required." >&2
  exit 2
fi

validate_ident "$TARGET_PGDATABASE" "TARGET_PGDATABASE"
validate_ident "$TARGET_PGUSER" "TARGET_PGUSER"

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
if [[ ! -f "$checksum_path" ]]; then
  log_ops "failure" "checksum_missing"
  echo "Checksum file required: ${checksum_path}" >&2
  exit 4
fi

expected="$(awk '{print $1; exit}' "$checksum_path")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$DUMP_PATH" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$DUMP_PATH" | awk '{print $1}')"
else
  log_ops "failure" "checksum_utility_missing"
  echo "sha256sum or shasum required" >&2
  exit 4
fi

if [[ "$expected" != "$actual" ]]; then
  log_ops "failure" "checksum_mismatch"
  echo "Checksum mismatch" >&2
  exit 4
fi

export PGHOST="$TARGET_PGHOST" PGPORT="$TARGET_PGPORT" PGUSER="$TARGET_PGUSER"

psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_PGDATABASE}\";"
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_PGDATABASE}\";"
target_created=true

export PGDATABASE="$TARGET_PGDATABASE"
pg_restore \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-acl \
  -d "$TARGET_PGDATABASE" \
  "$DUMP_PATH"

migration_count="$(psql -d "$TARGET_PGDATABASE" -Atc 'SELECT COUNT(*) FROM schema_migrations')"
if [[ "${migration_count}" -lt 1 ]]; then
  log_ops "failure" "schema_migrations_missing"
  echo "Restore failed: schema_migrations empty or missing." >&2
  exit 5
fi

psql -d "$TARGET_PGDATABASE" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM users;' >/dev/null
psql -d "$TARGET_PGDATABASE" -v ON_ERROR_STOP=1 -c 'SELECT 1 FROM job_cards LIMIT 1;' >/dev/null || true

log_ops "success" "migrations=${migration_count}"

if [[ "$KEEP" != true ]]; then
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_PGDATABASE}\";"
  target_created=false
fi

echo "Restore rehearsal succeeded against ${TARGET_PGDATABASE}"
exit 0
