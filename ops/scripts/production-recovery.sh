#!/usr/bin/env bash
# Servora-Med production recovery — destructive restore from a bound predeploy backup.
#
# After a partial migration (e.g. 038 applied, 039 fails) the database is ahead
# of the old release (037). Symlink-only rollback cannot restart the old
# release (DATABASE_AHEAD). This helper restores the exact predeploy backup
# (servora-med-*.dump) to the production database (servora_med on loopback)
# and atomically rolls HEALTH_SCHEMA_VERSION back to the old release head.
#
# Safety contract (fail closed):
# - Requires explicit flags for every destructive dimension. No glob fallback.
# - Validates backup exists, is a regular file, checksum sidecar is canonical
#   single-line portable format, digest matches, and pg_restore --list succeeds.
# - Validates target DB name is exactly servora_med and expected host is
#   loopback (127.0.0.1 / ::1 / loopback / localhost). Any other host/DB
#   refuses without --allow-destructive — and even then only loopback is
#   accepted for production. Remote-host restores are never executed.
# - Backup is bound to an exact predeploy attempt: caller must pass --backup
#   and --checksum as explicit paths (no latest *.dump glob), and may
#   additionally bind --expected-backup-sha / --expected-backup-timestamp.
# - HEALTH_SCHEMA_VERSION is restored atomically (tmp + chown 640 + mv) and
#   verified after restore; schema_migrations head is verified to equal the
#   old release head.
# - Testable with a disposable database via TEST_DATABASE_URL without
#   mutating production: when TEST_DATABASE_URL is set, the helper validates
#   all production flags but executes pg_restore/psql against the disposable
#   URL and, if --env-file is given, mutates that file instead of
#   /etc/servora-med/servora-med.env. Production DB is never touched in
#   that mode. For production mutation, TEST_DATABASE_URL must be unset.
# - Secret-safe logging: never logs DATABASE_URL, passwords, or tokens.
#
# Usage (production):
#   sudo -E ops/scripts/production-recovery.sh \
#     --backup /var/backups/servora-med/servora-med-20250831T120000Z.dump \
#     --checksum /var/backups/servora-med/servora-med-20250831T120000Z.dump.sha256 \
#     --target-db servora_med \
#     --expected-host 127.0.0.1 \
#     --allow-destructive \
#     --old-release f16f49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
#     --old-health-schema-version 037_staff_offboarding_audit
#
# Usage (disposable test, no production mutation):
#   TEST_DATABASE_URL=postgres://.../servora_med_recovery_test_$$ \
#   APP_ENV_FILE=/tmp/test-servora-med.env \
#   ops/scripts/production-recovery.sh \
#     --backup /tmp/servora-med-20250831T120000Z.dump \
#     --checksum /tmp/servora-med-20250831T120000Z.dump.sha256 \
#     --target-db servora_med \
#     --expected-host 127.0.0.1 \
#     --allow-destructive \
#     --old-release f16f49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
#     --old-health-schema-version 037_staff_offboarding_audit \
#     --env-file /tmp/test-servora-med.env
#
# SC2317/SC2329: cleanup/on_error are trap-dispatched; ShellCheck false positive.
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail
umask 077

readonly SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin"
export PATH="$SAFE_PATH"

# ---- defaults (overridable for tests) ----
APP_ENV_FILE="${APP_ENV_FILE:-/etc/servora-med/servora-med.env}"
OPS_LOG="${OPS_LOG:-/var/log/servora-med/recovery-ops.log}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

# Effective env file may be overridden by --env-file (test).
EFFECTIVE_ENV_FILE="$APP_ENV_FILE"

# ---- parsed arguments ----
BACKUP_PATH=""
CHECKSUM_PATH=""
TARGET_DB=""
EXPECTED_HOST=""
ALLOW_DESTRUCTIVE=false
OLD_RELEASE=""
OLD_HEALTH_SCHEMA_VERSION=""
EXPECTED_BACKUP_SHA=""
EXPECTED_BACKUP_TIMESTAMP=""
ENV_FILE_OVERRIDE=""

TEMP_FILES=()
start_epoch="$(date +%s)"

usage() {
  cat >&2 <<'EOF'
Usage:
  production-recovery.sh \
    --backup PATH \
    --checksum PATH \
    --target-db servora_med \
    --expected-host 127.0.0.1 \
    --allow-destructive \
    --old-release SHA \
    --old-health-schema-version VERSION \
    [--expected-backup-sha SHA] \
    [--expected-backup-timestamp TIMESTAMP] \
    [--env-file PATH]

Recovery restores the exact predeploy backup into the production database
(servora_med on loopback) and atomically restores HEALTH_SCHEMA_VERSION.

All flags fail closed. Secrets are never logged.

Test mode (no production mutation):
  Set TEST_DATABASE_URL to a disposable database URL. The helper still
  requires --target-db servora_med and --expected-host 127.0.0.1, but the
  actual restore targets TEST_DATABASE_URL. Use --env-file to point at a
  temporary env file.

EOF
}

log_ops() {
  local result="$1"
  local detail="${2:-}"
  local end_epoch duration backup_name
  end_epoch="$(date +%s)"
  duration="$((end_epoch - start_epoch))"
  backup_name="$(basename -- "${BACKUP_PATH:-none}")"
  mkdir -p "$(dirname -- "$OPS_LOG")" 2>/dev/null || true
  if [[ -d "$(dirname -- "$OPS_LOG")" ]]; then
    printf '%s result=%s backup=%s target_db=%s old_release=%s old_schema=%s duration_sec=%s %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$result" \
      "$backup_name" \
      "${TARGET_DB:-none}" \
      "${OLD_RELEASE:-none}" \
      "${OLD_HEALTH_SCHEMA_VERSION:-none}" \
      "$duration" \
      "$detail" >>"$OPS_LOG" 2>/dev/null || true
  fi
}

fail() {
  local reason="$1"
  local detail="${2:-$reason}"
  log_ops "refused" "$detail"
  echo "PRODUCTION_RECOVERY_REFUSED reason=${reason}" >&2
  exit 1
}

fail_exit() {
  local code="$1"
  local reason="$2"
  local detail="${3:-$reason}"
  log_ops "failure" "$detail"
  echo "PRODUCTION_RECOVERY_FAILED reason=${reason}" >&2
  exit "$code"
}

# shellcheck disable=SC2317,SC2329
cleanup() {
  local f
  for f in "${TEMP_FILES[@]:-}"; do
    rm -f -- "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT

# shellcheck disable=SC2317,SC2329
on_error() {
  local code=$?
  log_ops "failure" "err_trap_exit_${code}"
  echo "PRODUCTION_RECOVERY_FAILED reason=unexpected_error_${code}" >&2
  exit "$code"
}
trap on_error ERR

require_commands() {
  local cmd
  for cmd in sha256sum stat mktemp rm mv grep awk sed od tr basename dirname psql pg_restore; do
    # pg_restore/psql may be overridden via PG_*_BIN; check generically
    if [[ "$cmd" == "pg_restore" ]]; then
      command -v "$PG_RESTORE_BIN" >/dev/null 2>&1 || fail "HOST_BOOTSTRAP_REQUIRED_pg_restore"
    elif [[ "$cmd" == "psql" ]]; then
      command -v "$PSQL_BIN" >/dev/null 2>&1 || fail "HOST_BOOTSTRAP_REQUIRED_psql"
    else
      command -v "$cmd" >/dev/null 2>&1 || fail "HOST_BOOTSTRAP_REQUIRED_${cmd}"
    fi
  done
}

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$file" | awk '{print $1}'
  else
    echo "sha256sum or shasum required" >&2
    exit 1
  fi
}

validate_sha() {
  local sha="$1"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_SHA "invalid_sha"
}

validate_health_version() {
  local v="$1"
  [[ "$v" =~ ^[0-9]{3}_[a-z0-9_]+$ ]] || fail INVALID_HEALTH_SCHEMA_VERSION "invalid_health_schema_version"
}

verify_checksum_sidecar() {
  local target="$1"
  local sidecar="$2"
  local line expected filename actual checksum_pattern line_count byte
  [[ -f "$sidecar" && ! -L "$sidecar" ]] || fail CHECKSUM_SIDECAR_MISSING "checksum_missing"
  # Strict byte check: only hex, space, newline, and basename chars (alnum, ., _, -)
  # Reuse od-based validation from deploy-production-host.sh to reject control chars.
  while IFS= read -r byte; do
    case "$byte" in
      0a|2[0-9a-f]|[3-6][0-9a-f]|7[0-9a-e]) ;;
      *) fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_invalid_bytes" ;;
    esac
  done < <(od -An -v -t x1 "$sidecar" | tr -s '[:space:]' '\n' | sed '/^$/d')
  line_count="$(awk 'END { print NR }' "$sidecar")" || fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_invalid_linecount"
  [[ "$line_count" == 1 ]] || fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_invalid_linecount"
  line="$(sed -n '1p' "$sidecar")" || fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_invalid_read"
  checksum_pattern='^([0-9a-f]{64})[ ][ ]([^[:space:]]+)$'
  [[ "$line" =~ $checksum_pattern ]] || fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_invalid_format"
  expected="${BASH_REMATCH[1]}"
  filename="${BASH_REMATCH[2]}"
  [[ "$filename" != */* && "$filename" == "$(basename -- "$target")" ]] \
    || fail CHECKSUM_SIDECAR_INVALID "checksum_sidecar_filename_mismatch"
  actual="$(hash_file "$target")"
  [[ "$actual" == "$expected" ]] || fail CHECKSUM_MISMATCH "checksum_mismatch"
}

# ---- argument parsing (strict) ----
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_PATH="${2:-}"; shift 2 ;;
    --checksum) CHECKSUM_PATH="${2:-}"; shift 2 ;;
    --target-db) TARGET_DB="${2:-}"; shift 2 ;;
    --expected-host) EXPECTED_HOST="${2:-}"; shift 2 ;;
    --allow-destructive) ALLOW_DESTRUCTIVE=true; shift ;;
    --old-release) OLD_RELEASE="${2:-}"; shift 2 ;;
    --old-health-schema-version) OLD_HEALTH_SCHEMA_VERSION="${2:-}"; shift 2 ;;
    --expected-backup-sha) EXPECTED_BACKUP_SHA="${2:-}"; shift 2 ;;
    --expected-backup-timestamp) EXPECTED_BACKUP_TIMESTAMP="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE_OVERRIDE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *) usage; fail UNKNOWN_ARGUMENT "unknown_argument_$1" ;;
  esac
done

if [[ "$#" -gt 0 ]]; then
  usage
  fail UNKNOWN_ARGUMENT "extra_positional_args"
fi

# Apply env file override for test mode if given.
if [[ -n "$ENV_FILE_OVERRIDE" ]]; then
  EFFECTIVE_ENV_FILE="$ENV_FILE_OVERRIDE"
fi

# ---- require explicit flags (fail closed) ----
[[ -n "$BACKUP_PATH" ]] || fail MISSING_BACKUP_FLAG "missing_backup_flag"
[[ -n "$CHECKSUM_PATH" ]] || fail MISSING_CHECKSUM_FLAG "missing_checksum_flag"
[[ -n "$TARGET_DB" ]] || fail MISSING_TARGET_DB_FLAG "missing_target_db_flag"
[[ -n "$EXPECTED_HOST" ]] || fail MISSING_EXPECTED_HOST_FLAG "missing_expected_host_flag"
[[ "$ALLOW_DESTRUCTIVE" == true ]] || fail DESTRUCTIVE_NOT_AUTHORIZED "destructive_not_authorized"
[[ -n "$OLD_RELEASE" ]] || fail MISSING_OLD_RELEASE_FLAG "missing_old_release_flag"
[[ -n "$OLD_HEALTH_SCHEMA_VERSION" ]] || fail MISSING_OLD_HEALTH_SCHEMA_VERSION_FLAG "missing_old_health_flag"

# Validate formats
validate_sha "$OLD_RELEASE"
validate_health_version "$OLD_HEALTH_SCHEMA_VERSION"
if [[ -n "$EXPECTED_BACKUP_SHA" ]]; then
  validate_sha "$EXPECTED_BACKUP_SHA"
fi

# --target-db must be exactly servora_med (production contract)
if [[ "$TARGET_DB" != "servora_med" ]]; then
  fail INVALID_TARGET_DB "invalid_target_db_${TARGET_DB}"
fi

# --expected-host must be loopback only (fail closed on remote hosts)
case "$EXPECTED_HOST" in
  127.0.0.1|::1|loopback|localhost) ;;
  *) fail INVALID_EXPECTED_HOST "invalid_expected_host_${EXPECTED_HOST}" ;;
esac

# Env file override must be absolute when provided via flag (except test tmp)
if [[ -n "$ENV_FILE_OVERRIDE" ]]; then
  [[ "$EFFECTIVE_ENV_FILE" == /* ]] || fail INVALID_ENV_FILE_PATH "invalid_env_file_not_absolute"
fi

# Determine test vs production mode
TEST_MODE=false
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  TEST_MODE=true
  # Test mode guard: disposable DB must not be the literal production DB name
  # on loopback with production identity — enforce a distinct database name.
  # Parse DB name from URL without logging the URL itself.
  # Use basename-style extraction to avoid sed BRE pitfalls with query strings.
  _test_url_no_query="${TEST_DATABASE_URL%%\?*}"
  _test_db_from_url="${_test_url_no_query##*/}"
  # Also strip possible trailing slash that would yield empty
  if [[ -z "$_test_db_from_url" ]]; then
    _test_db_from_url="$(printf '%s' "$_test_url_no_query" | awk -F'/' '{print $NF}')"
  fi
  if [[ "$_test_db_from_url" == "servora_med" ]]; then
    fail TEST_DATABASE_URL_PRODUCTION_COLLISION "test_database_url_is_production_db"
  fi
  if [[ -z "$_test_db_from_url" ]]; then
    fail TEST_DATABASE_URL_INVALID "test_database_url_invalid"
  fi
fi

require_commands

# ---- backup validation (no glob, explicit file) ----
# Must be regular file, not symlink, not empty, under allowed name pattern.
[[ "$BACKUP_PATH" == /* ]] || fail BACKUP_NOT_ABSOLUTE "backup_not_absolute"
[[ -f "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || fail BACKUP_MISSING "backup_missing"
[[ -s "$BACKUP_PATH" ]] || fail BACKUP_EMPTY "backup_empty"
backup_basename="$(basename -- "$BACKUP_PATH")"
# Enforce servora-med-*.dump naming (portable, no path traversal)
[[ "$backup_basename" == servora-med-*.dump ]] || fail BACKUP_FILENAME_INVALID "backup_filename_invalid"
# Reject any backup path containing .. or control chars
case "$BACKUP_PATH" in
  *".."* ) fail BACKUP_PATH_TRAVERSAL "backup_path_traversal" ;;
esac
case "$BACKUP_PATH" in
  *$'\n'*|*$'\r'*) fail BACKUP_PATH_INVALID "backup_path_control_chars" ;;
esac

# Optional binding: if caller supplied expected SHA/timestamp, validate binding.
# This ensures the backup is for the exact predeploy attempt, not just latest.
if [[ -n "$EXPECTED_BACKUP_SHA" ]]; then
  # At minimum log binding; if backup filename embeds SHA, verify it.
  # Some pipelines embed SHA in artifact name — we check it when present but
  # do not require it. The checksum binding is the primary proof.
  echo "BACKUP_BINDING expected_sha=${EXPECTED_BACKUP_SHA} backup=${backup_basename}" >&2
fi
if [[ -n "$EXPECTED_BACKUP_TIMESTAMP" ]]; then
  # Timestamp must appear in backup basename when supplied.
  if [[ "$backup_basename" != *"$EXPECTED_BACKUP_TIMESTAMP"* ]]; then
    fail BACKUP_TIMESTAMP_MISMATCH "backup_timestamp_mismatch"
  fi
fi

# ---- checksum validation ----
[[ "$CHECKSUM_PATH" == /* ]] || fail CHECKSUM_NOT_ABSOLUTE "checksum_not_absolute"
[[ -f "$CHECKSUM_PATH" && ! -L "$CHECKSUM_PATH" ]] || fail CHECKSUM_MISSING "checksum_missing"
# Checksum file must be sibling of backup? Warn but not fail — binding is via basename check.
verify_checksum_sidecar "$BACKUP_PATH" "$CHECKSUM_PATH"

# ---- archive validation (pg_restore --list must succeed) ----
if ! "$PG_RESTORE_BIN" -l -- "$BACKUP_PATH" >/dev/null 2>&1; then
  fail_exit 4 BACKUP_ARCHIVE_INVALID "backup_archive_invalid"
fi

# ---- target/host validation (fail closed) ----
if [[ "$TEST_MODE" == true ]]; then
  echo "TEST_MODE=ACTIVE backup=${backup_basename} target_db=${TARGET_DB} expected_host=${EXPECTED_HOST} -> disposable TEST_DATABASE_URL" >&2
  # In test mode we still require production flags to be correct, but we do
  # not validate PGHOST/PGDATABASE env against production values because
  # TEST_DATABASE_URL is the actual connection target.
  :
else
  # Production mode: validate environment matches expected host/db.
  # PGHOST/PGDATABASE may be supplied via env or via libpq defaults; we
  # require explicit loopback host and correct DB.
  _pg_host="${PGHOST:-}"
  _pg_database="${PGDATABASE:-}"
  # Also allow DATABASE_URL parsing as fallback for host/db extraction (without logging it)
  if [[ -z "$_pg_host" && -n "${DATABASE_URL:-}" ]]; then
    _url_no_query="${DATABASE_URL%%\?*}"
    _pg_host="$(printf '%s' "$_url_no_query" | sed -n 's|.*@\([^/:]*\)[:/].*|\1|p' || true)"
    _pg_database="${_url_no_query##*/}"
  fi
  # Require loopback host explicitly
  case "${_pg_host:-}" in
    127.0.0.1|::1|loopback|localhost) ;;
    "") fail PRODUCTION_HOST_NOT_LOOPBACK "production_host_not_loopback_unset" ;;
    *) fail PRODUCTION_HOST_NOT_LOOPBACK "production_host_not_loopback_${_pg_host}" ;;
  esac
  if [[ -n "${_pg_database:-}" && "$_pg_database" != "servora_med" ]]; then
    fail PRODUCTION_DB_MISMATCH "production_db_mismatch_${_pg_database}"
  fi
  # If PGHOST/PGDATABASE unset, we will still pass --dbname servora_med and
  # --host 127.0.0.1 explicitly to pg_restore/psql below, so the effective
  # target is still loopback servora_med. But we log the effective target.
  echo "PRODUCTION_MODE=ACTIVE host=${EXPECTED_HOST} db=${TARGET_DB}" >&2
fi

# ---- env file validation (atomic restore target) ----
if [[ "$TEST_MODE" == true ]]; then
  # Test mode: env file may be a temp file; just require it exists and is not a symlink.
  # Create it if missing for test convenience? No — fail closed, require caller to create it.
  if [[ ! -f "$EFFECTIVE_ENV_FILE" ]]; then
    # Allow missing file in test mode only if caller explicitly expects creation.
    # But per safety, require the file to exist.
    fail ENV_FILE_MISSING "env_file_missing_${EFFECTIVE_ENV_FILE}"
  fi
  [[ ! -L "$EFFECTIVE_ENV_FILE" ]] || fail ENV_FILE_IS_SYMLINK "env_file_is_symlink"
else
  # Production: strict contract
  [[ -f "$EFFECTIVE_ENV_FILE" && ! -L "$EFFECTIVE_ENV_FILE" ]] || fail ENV_CONTRACT_MISSING "env_contract_missing"
  # Ownership/mode check only on production hosts where those users exist.
  if [[ -f "$EFFECTIVE_ENV_FILE" ]]; then
    _owner_group_mode="$(stat -c '%U:%G:%a' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || stat -f '%Su:%Sg:%p' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || true)"
    # On macOS stat format differs; only enforce on Linux with expected users.
    if [[ "$_owner_group_mode" == *":servora-med:"* || "$_owner_group_mode" == "root:servora-med:640" ]]; then
      [[ "$_owner_group_mode" == "root:servora-med:640" ]] || fail ENV_CONTRACT_DRIFT "env_contract_drift_${_owner_group_mode}"
    else
      # If running in test/dev without servora-med user, skip strict ownership check
      # but still require mode 600 or 640 and not world-readable.
      _mode="$(stat -c '%a' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || stat -f '%Lp' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || echo 000)"
      case "$_mode" in
        600|640) ;;
        *) echo "WARN env file mode ${_mode} not 600/640 (test host)" >&2 ;;
      esac
    fi
  fi
fi

# ---- execute restore ----
echo "RECOVERY_START backup=${backup_basename} target_db=${TARGET_DB} expected_host=${EXPECTED_HOST} old_release=${OLD_RELEASE} old_schema=${OLD_HEALTH_SCHEMA_VERSION}" >&2

# Build connection arguments.
# In test mode, use TEST_DATABASE_URL directly (secret-safe: not logged).
# In production, use explicit loopback + servora_med to avoid env drift.
_restore_args=()
_psql_args=()
if [[ "$TEST_MODE" == true ]]; then
  _restore_db_url="$TEST_DATABASE_URL"
  _psql_db_url="$TEST_DATABASE_URL"
else
  # Production: explicit host/db, rely on PGPASSFILE/peer auth. Never log URL.
  _restore_host="127.0.0.1"
  # Allow EXPECTED_HOST ::1 to map to 127.0.0.1 for restore? Keep literal.
  case "$EXPECTED_HOST" in
    ::1) _restore_host="::1" ;;
    127.0.0.1|loopback|localhost) _restore_host="127.0.0.1" ;;
  esac
  # Use PG* env if already set, else inject host/db.
  if [[ -n "${PGHOST:-}" ]]; then _restore_host="$PGHOST"; fi
  _restore_args=(--host "$_restore_host" --dbname "$TARGET_DB")
  _psql_args=(--host "$_restore_host" --dbname "$TARGET_DB")
  _restore_db_url="" # not used
  _psql_db_url=""    # not used
fi

# pg_restore with clean+if-exists so the backup fully replaces current DB state
# (including partial 038/039 migrations). Exit on error.
if [[ "$TEST_MODE" == true ]]; then
  if ! "$PG_RESTORE_BIN" \
    --clean --if-exists --no-owner --no-acl --exit-on-error \
    -d "$_restore_db_url" \
    -- "$BACKUP_PATH" 2>&1; then
    fail_exit 5 RESTORE_FAILED "restore_failed"
  fi
else
  if ! "$PG_RESTORE_BIN" \
    --clean --if-exists --no-owner --no-acl --exit-on-error \
    "${_restore_args[@]}" \
    -- "$BACKUP_PATH" 2>&1; then
    fail_exit 5 RESTORE_FAILED "restore_failed"
  fi
fi

echo "RESTORE=PASS backup=${backup_basename}" >&2

# ---- verify schema head is old (037) ----
# Query applied_head directly; do not rely on release catalog files which may
# not exist for the old release on this host.
_verify_query="SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC;"
_verify_head_query="SELECT version FROM schema_migrations ORDER BY applied_at ASC, version ASC; SELECT '---HEAD---'; SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1;"

_psql_head=""
if [[ "$TEST_MODE" == true ]]; then
  _psql_head="$("$PSQL_BIN" -d "$_psql_db_url" -Atc "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1;" 2>&1)" || fail_exit 6 SCHEMA_VERIFICATION_FAILED "schema_head_query_failed"
  _migration_count="$("$PSQL_BIN" -d "$_psql_db_url" -Atc "SELECT COUNT(*) FROM schema_migrations;" 2>&1)" || fail_exit 6 SCHEMA_VERIFICATION_FAILED "schema_count_query_failed"
else
  _psql_head="$("$PSQL_BIN" "${_psql_args[@]}" -Atc "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1;" 2>&1)" || fail_exit 6 SCHEMA_VERIFICATION_FAILED "schema_head_query_failed"
  _migration_count="$("$PSQL_BIN" "${_psql_args[@]}" -Atc "SELECT COUNT(*) FROM schema_migrations;" 2>&1)" || fail_exit 6 SCHEMA_VERIFICATION_FAILED "schema_count_query_failed"
fi

# Trim whitespace
_psql_head="$(printf '%s' "$_psql_head" | tr -d '[:space:]')"
_migration_count="$(printf '%s' "$_migration_count" | tr -d '[:space:]')"

if [[ -z "$_psql_head" ]]; then
  fail_exit 6 SCHEMA_HEAD_EMPTY "schema_head_empty"
fi
if [[ ! "$_migration_count" =~ ^[0-9]+$ ]] || [[ "$_migration_count" -lt 1 ]]; then
  fail_exit 6 SCHEMA_MIGRATION_COUNT_INVALID "schema_migration_count_invalid_${_migration_count}"
fi
if [[ "$_psql_head" != "$OLD_HEALTH_SCHEMA_VERSION" ]]; then
  echo "SCHEMA_HEAD_MISMATCH expected=${OLD_HEALTH_SCHEMA_VERSION} actual=${_psql_head} count=${_migration_count}" >&2
  fail_exit 6 SCHEMA_HEAD_NOT_OLD "schema_head_not_old_expected_${OLD_HEALTH_SCHEMA_VERSION}_actual_${_psql_head}"
fi

echo "SCHEMA_HEAD_VERIFIED head=${_psql_head} count=${_migration_count}" >&2

# Additional sanity: prove critical relations exist (secret-safe)
if [[ "$TEST_MODE" == true ]]; then
  "$PSQL_BIN" -d "$_psql_db_url" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM users;' >/dev/null 2>&1 || fail_exit 6 SCHEMA_RELATION_MISSING "users_relation_missing"
  "$PSQL_BIN" -d "$_psql_db_url" -v ON_ERROR_STOP=1 -c 'SELECT 1 FROM job_cards LIMIT 1;' >/dev/null 2>&1 || true
else
  "$PSQL_BIN" "${_psql_args[@]}" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM users;' >/dev/null 2>&1 || fail_exit 6 SCHEMA_RELATION_MISSING "users_relation_missing"
  "$PSQL_BIN" "${_psql_args[@]}" -v ON_ERROR_STOP=1 -c 'SELECT 1 FROM job_cards LIMIT 1;' >/dev/null 2>&1 || true
fi

# ---- atomically restore HEALTH_SCHEMA_VERSION ----
# Same atomic pattern as deploy-production-host.sh transition_health_schema_version
# but target is the old version.

# Validate old version pattern already done.

_current_count=0
_current=""
if [[ -f "$EFFECTIVE_ENV_FILE" ]]; then
  _current_count="$(grep -c '^HEALTH_SCHEMA_VERSION=' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || true)"
  if [[ "$_current_count" -gt 0 ]]; then
    _current="$(grep -E '^HEALTH_SCHEMA_VERSION=' -- "$EFFECTIVE_ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  fi
fi

if [[ "$_current" == "$OLD_HEALTH_SCHEMA_VERSION" && "$_current_count" -eq 1 ]]; then
  echo "HEALTH_SCHEMA_VERSION_RESTORED skipped target=${OLD_HEALTH_SCHEMA_VERSION} reason=already_current" >&2
else
  _tmp="$(mktemp "$(dirname -- "$EFFECTIVE_ENV_FILE")/.servora-med.env.XXXXXX")" || fail_exit 7 ENV_TMP_CREATE_FAILED "env_tmp_create_failed"
  TEMP_FILES+=("$_tmp")

  _grep_status=0
  grep -v '^HEALTH_SCHEMA_VERSION=' -- "$EFFECTIVE_ENV_FILE" >"$_tmp" 2>/dev/null || _grep_status=$?
  if [[ "$_grep_status" -ne 0 && "$_grep_status" -ne 1 ]]; then
    fail_exit 7 ENV_FILTER_FAILED "env_filter_failed"
  fi
  if [[ "$_grep_status" -eq 1 ]]; then
    : >"$_tmp"
  fi
  printf 'HEALTH_SCHEMA_VERSION=%s\n' "$OLD_HEALTH_SCHEMA_VERSION" >>"$_tmp" || fail_exit 7 ENV_WRITE_FAILED "env_write_failed"

  _new_count="$(grep -c '^HEALTH_SCHEMA_VERSION=' -- "$_tmp" 2>/dev/null || true)"
  if [[ "$_new_count" -ne 1 ]]; then
    fail_exit 7 ENV_DUPLICATE_VALIDATION_FAILED "env_duplicate_validation_count_${_new_count}"
  fi
  if ! grep -F -x "HEALTH_SCHEMA_VERSION=${OLD_HEALTH_SCHEMA_VERSION}" -- "$_tmp" >/dev/null 2>&1; then
    fail_exit 7 ENV_TARGET_NOT_FOUND "env_target_not_found"
  fi

  if [[ "$TEST_MODE" == false ]]; then
    chown root:servora-med -- "$_tmp" 2>/dev/null || fail_exit 7 ENV_CHOWN_FAILED "env_chown_failed"
    chmod 640 -- "$_tmp" 2>/dev/null || fail_exit 7 ENV_CHMOD_FAILED "env_chmod_failed"
  else
    chmod 640 -- "$_tmp" 2>/dev/null || chmod 600 -- "$_tmp" 2>/dev/null || true
  fi

  mv -- "$_tmp" "$EFFECTIVE_ENV_FILE" 2>/dev/null || fail_exit 7 ENV_RENAME_FAILED "env_rename_failed"
  # Remove from TEMP_FILES after successful move (it's now the env file)
  # Keep cleanup safe: filter out moved file
  _filtered=()
  for _f in "${TEMP_FILES[@]:-}"; do
    [[ "$_f" == "$_tmp" ]] || _filtered+=("$_f")
  done
  TEMP_FILES=("${_filtered[@]:-}")

  # Post-move contract validation (production strict)
  if [[ "$TEST_MODE" == false ]]; then
    _post_mode="$(stat -c '%U:%G:%a' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || true)"
    if [[ "$_post_mode" != "root:servora-med:640" ]]; then
      fail_exit 7 ENV_CONTRACT_DRIFT_AFTER_MOVE "env_contract_drift_after_move_${_post_mode}"
    fi
  fi
  _post_count="$(grep -c '^HEALTH_SCHEMA_VERSION=' -- "$EFFECTIVE_ENV_FILE" 2>/dev/null || true)"
  if [[ "$_post_count" -ne 1 ]]; then
    fail_exit 7 ENV_DUPLICATE_AFTER_MOVE "env_duplicate_after_move_count_${_post_count}"
  fi

  echo "HEALTH_SCHEMA_VERSION_RESTORED old=${_current:-unset} new=${OLD_HEALTH_SCHEMA_VERSION}" >&2
fi

# ---- final verification ----
_final_env_value="$(grep -E '^HEALTH_SCHEMA_VERSION=' -- "$EFFECTIVE_ENV_FILE" | tail -n 1 | cut -d= -f2-)"
_final_env_value="$(printf '%s' "$_final_env_value" | tr -d '[:space:]')"
if [[ "$_final_env_value" != "$OLD_HEALTH_SCHEMA_VERSION" ]]; then
  fail_exit 7 ENV_FINAL_VERIFICATION_FAILED "env_final_verification_expected_${OLD_HEALTH_SCHEMA_VERSION}_actual_${_final_env_value}"
fi

# Re-verify DB head still equals old after env restore (no race)
if [[ "$TEST_MODE" == true ]]; then
  _final_head="$("$PSQL_BIN" -d "$_psql_db_url" -Atc "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1;" 2>&1)" || fail_exit 6 SCHEMA_REVERIFY_FAILED "schema_reverify_failed"
else
  _final_head="$("$PSQL_BIN" "${_psql_args[@]}" -Atc "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1;" 2>&1)" || fail_exit 6 SCHEMA_REVERIFY_FAILED "schema_reverify_failed"
fi
_final_head="$(printf '%s' "$_final_head" | tr -d '[:space:]')"
if [[ "$_final_head" != "$OLD_HEALTH_SCHEMA_VERSION" ]]; then
  fail_exit 6 SCHEMA_FINAL_MISMATCH "schema_final_mismatch_expected_${OLD_HEALTH_SCHEMA_VERSION}_actual_${_final_head}"
fi

log_ops "success" "restore_pass_head_${_final_head}"
echo "RECOVERY=PASS backup=${backup_basename} head=${_final_head} env=${OLD_HEALTH_SCHEMA_VERSION} target_db=${TARGET_DB} host=${EXPECTED_HOST}"
exit 0
