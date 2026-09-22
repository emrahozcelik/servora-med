#!/usr/bin/env bash
# Servora-Med PostgreSQL backup — atomic dump with portable checksum and ops log.
# Secrets: use PGPASSFILE or peer auth. Never put passwords on argv.
#
# Trigger provenance is explicit and comes from the call site (argv), never from
# the clock, deploy artifacts, process ancestry, or a mutable environment:
#   --trigger=scheduled   servora-med-backup.timer -> servora-med-backup.service
#   --trigger=predeploy   servora-med-predeploy-backup@.service -> launcher
#   --trigger=postdeploy  servora-med-postdeploy-backup.service
#   --trigger=manual      direct operator invocation (default)
#
# SC2317/SC2329: on_error/on_exit/cleanup/release_lock are invoked via trap only;
# ShellCheck cannot see trap dispatch and reports false-positive unreachable code.
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR

# --- explicit trigger provenance ---------------------------------------------
TRIGGER="manual"
for arg in "$@"; do
  case "$arg" in
    --trigger=*) TRIGGER="${arg#--trigger=}" ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 64
      ;;
  esac
done
case "$TRIGGER" in
  scheduled|predeploy|postdeploy|manual) ;;
  *)
    # An unrecognised trigger would be recorded as a wrong provenance class,
    # which is worse than a loud, early failure.
    echo "Unsupported trigger class: ${TRIGGER}" >&2
    exit 64
    ;;
esac

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
OPS_LOG="${OPS_LOG:?OPS_LOG is required}"
PGHOST="${PGHOST:?PGHOST is required}"
PGPORT="${PGPORT:?PGPORT is required}"
PGUSER="${PGUSER:?PGUSER is required}"
PGDATABASE="${PGDATABASE:?PGDATABASE is required}"
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
LOCK_DIR="${BACKUP_DIR}/.backup.lock.d"
OFFSITE_COPY_HOOK="${OFFSITE_COPY_HOOK:-}"
# Allow matching server major version in CI/prod (e.g. /usr/lib/postgresql/17/bin/pg_dump).
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
LOCK_MODE=""

# --- host observation state (OPS-004) ----------------------------------------
# Unset means the deployment has not adopted the observation artifact yet: the
# backup keeps working and no evidence is published. Once configured, publishing
# is mandatory and a write failure fails the run visibly.
OBSERVATION_PATH="${BACKUP_OBSERVATION_PATH:-}"
OBSERVATION_WRITER="${SCRIPT_DIR}/backup-observation.sh"
observation_enabled=0
observation_finalized=0
attempt_started_at=""
CURRENT_STAGE="UNKNOWN"

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

# Publishes one observation transition. Never echoes the state path or any
# content: the writer emits only allowlisted tokens and validated instants.
write_observation() {
  local outcome="$1"
  local completed_at="${2:-}"
  local failure_class="${3:-}"
  [[ "$observation_enabled" -eq 1 ]] || return 0
  local args=(--state "$OBSERVATION_PATH" --trigger "$TRIGGER"
    --started-at "$attempt_started_at" --outcome "$outcome")
  [[ -n "$completed_at" ]] && args+=(--completed-at "$completed_at")
  [[ -n "$failure_class" ]] && args+=(--failure-class "$failure_class")
  "$OBSERVATION_WRITER" "${args[@]}"
}

# Trap-invoked helpers (ERR/EXIT). ShellCheck cannot see trap dispatch.
# shellcheck disable=SC2317,SC2329
cleanup_partials() {
  rm -f "$partial_path" "$checksum_partial"
}

# shellcheck disable=SC2317,SC2329
release_lock() {
  if [[ "$LOCK_MODE" == "flock" ]]; then
    # Kernel drops flock when FD 9 closes; nothing else required.
    :
  elif [[ "$LOCK_MODE" == "mkdir" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}

# Single failure exit path, used by both the ERR trap and explicit checks so no
# failure can skip publishing its observation.
# shellcheck disable=SC2317,SC2329
finish_failure() {
  local failure_class="${1:-UNKNOWN}"
  trap - ERR
  cleanup_partials
  if [[ ! -f "$checksum_path" ]]; then
    rm -f "$final_path"
  fi
  release_lock
  # A failed or incomplete attempt must never erase the previous valid verified
  # restore point. Once the local artifact is verified and published, a later
  # stage failure (for example the future offsite hook) must not downgrade the
  # local success: offsite is a separate dimension (DECISIONS.md -> OPS-004 item 8).
  if [[ "$observation_enabled" -eq 1 && -n "$attempt_started_at" && "$observation_finalized" -eq 0 ]]; then
    write_observation failure "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$failure_class" \
      || log_ops "failure" "observation_write_failed"
  fi
  log_ops "failure" "partial_removed"
  exit 1
}

# shellcheck disable=SC2317,SC2329
on_error() {
  finish_failure "${CURRENT_STAGE:-UNKNOWN}"
}

# shellcheck disable=SC2317,SC2329
on_exit() {
  release_lock
}

trap on_error ERR
trap on_exit EXIT

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

acquire_lock() {
  # Canonical Ubuntu production: util-linux flock (kernel-managed; survives crash cleanly).
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      return 1
    fi
    LOCK_MODE="flock"
    return 0
  fi

  # Fallback for hosts without flock (e.g. macOS test). Reclaim stale lock if PID is dead.
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    LOCK_MODE="mkdir"
    return 0
  fi
  if [[ -f "$LOCK_DIR/pid" ]]; then
    local old_pid
    old_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && ! kill -0 "$old_pid" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        printf '%s\n' "$$" >"$LOCK_DIR/pid"
        LOCK_MODE="mkdir"
        return 0
      fi
    fi
  fi
  return 1
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ -n "$OBSERVATION_PATH" ]]; then
  if [[ ! -x "$OBSERVATION_WRITER" ]]; then
    echo "Observation writer is missing or not executable: ${OBSERVATION_WRITER}" >&2
    exit 1
  fi
  observation_enabled=1
fi

if ! acquire_lock; then
  # A concurrent run is a skip, not an attempt: recording it would misreport the
  # provider's latest attempt.
  log_ops "failure" "lock_busy"
  echo "Another backup is already running." >&2
  exit 1
fi

attempt_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "$observation_enabled" -eq 1 ]]; then
  CURRENT_STAGE="OBSERVATION_WRITE_FAILED"
  write_observation running
fi

export PGHOST PGPORT PGUSER PGDATABASE

CURRENT_STAGE="DUMP_FAILED"
"$PG_DUMP_BIN" -Fc --no-owner --no-acl -f "$partial_path"

CURRENT_STAGE="CHECKSUM_FAILED"
digest="$(hash_file "$partial_path")"
# Portable sidecar: hash + basename only (no absolute path).
printf '%s  %s\n' "$digest" "$final_name" >"$checksum_partial"

verify_digest="$(hash_file "$partial_path")"
if [[ "$verify_digest" != "$digest" ]]; then
  echo "Checksum self-verify failed" >&2
  finish_failure "CHECKSUM_FAILED"
fi

CURRENT_STAGE="ARTIFACT_FINALIZE_FAILED"
mv "$partial_path" "$final_path"
mv "$checksum_partial" "$checksum_path"

# The artifact and its sidecar are finalized and checksum-verified: this is the
# local restore point. Publish it before retention/offsite so neither can erase
# or downgrade a proven local success.
if [[ "$observation_enabled" -eq 1 ]]; then
  CURRENT_STAGE="OBSERVATION_WRITE_FAILED"
  write_observation success "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  observation_finalized=1
fi

CURRENT_STAGE="UNKNOWN"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -mtime +7 -print0 \
  | while IFS= read -r -d '' old; do
      rm -f "$old" "${old}.sha256"
    done

if [[ -n "$OFFSITE_COPY_HOOK" ]]; then
  CURRENT_STAGE="OFFSITE_COPY_FAILED"
  if [[ ! -x "$OFFSITE_COPY_HOOK" ]]; then
    echo "OFFSITE_COPY_HOOK is not executable: $OFFSITE_COPY_HOOK" >&2
    finish_failure "OFFSITE_COPY_FAILED"
  fi
  "$OFFSITE_COPY_HOOK" "$final_path" "$checksum_path"
fi

log_ops "success" "$final_path"
echo "Backup written: $final_path"
exit 0
