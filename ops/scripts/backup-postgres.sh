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
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
LOCK_DIR="${BACKUP_DIR}/.backup.lock.d"
OFFSITE_COPY_HOOK="${OFFSITE_COPY_HOOK:-}"
LOCK_MODE=""

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

# Called from trap handlers (on_error / on_exit) — ShellCheck SC2329.
# shellcheck disable=SC2329
cleanup_partials() {
  rm -f "$partial_path" "$checksum_partial"
}

# shellcheck disable=SC2329
release_lock() {
  if [[ "$LOCK_MODE" == "flock" ]]; then
    # Kernel drops flock when FD 9 closes; nothing else required.
    :
  elif [[ "$LOCK_MODE" == "mkdir" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}

# Invoked via trap ERR / EXIT — ShellCheck SC2329.
# shellcheck disable=SC2329
on_error() {
  cleanup_partials
  if [[ ! -f "$checksum_path" ]]; then
    rm -f "$final_path"
  fi
  release_lock
  log_ops "failure" "partial_removed"
  exit 1
}

# shellcheck disable=SC2329
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

if ! acquire_lock; then
  log_ops "failure" "lock_busy"
  echo "Another backup is already running." >&2
  exit 1
fi

export PGHOST PGPORT PGUSER PGDATABASE

pg_dump -Fc --no-owner --no-acl -f "$partial_path"

digest="$(hash_file "$partial_path")"
# Portable sidecar: hash + basename only (no absolute path).
printf '%s  %s\n' "$digest" "$final_name" >"$checksum_partial"

verify_digest="$(hash_file "$partial_path")"
[[ "$verify_digest" == "$digest" ]] || {
  echo "Checksum self-verify failed" >&2
  exit 1
}

mv "$partial_path" "$final_path"
mv "$checksum_partial" "$checksum_path"

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
