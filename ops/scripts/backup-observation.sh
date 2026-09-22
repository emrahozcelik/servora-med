#!/usr/bin/env bash
# Servora-Med backup observation-state writer (OPS-004 / OPS-BACKUP-OBS-1).
#
# The ONLY writer of /var/lib/servora-med-backup/observation-v1.json. Updates it
# failure-atomically: a restrictive temp file in the same directory is fully
# written, flushed and closed, then renamed over the canonical state. A partial
# document is never readable as canonical state.
#
# The serialization is deliberately flat (one scalar per line, fixed key order)
# so a pure-bash writer can preserve the prior verified-success evidence without
# a JSON parser and without any new runtime dependency. It stays a single
# versioned JSON document for readers.
#
# Every value written is either an allowlisted token or a validated ISO-8601 UTC
# instant: no free-form text, path, filename, hostname, database name, credential
# or raw error can ever enter the state.
set -Eeuo pipefail
umask 077

readonly SCHEMA_VERSION=1

readonly TRIGGER_ALLOWLIST=(scheduled predeploy postdeploy manual)
readonly OUTCOME_ALLOWLIST=(running success failure)
# Stable, secret-safe failure classes derived from the real failure stages of
# ops/scripts/backup-postgres.sh.
readonly FAILURE_CLASS_ALLOWLIST=(
  DUMP_FAILED
  CHECKSUM_FAILED
  ARTIFACT_FINALIZE_FAILED
  OFFSITE_COPY_FAILED
  OBSERVATION_WRITE_FAILED
  UNKNOWN
)

readonly ISO_UTC_RE='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$'
readonly MAX_STATE_BYTES=65536

# Calendar-accurate instant validation. The range-limited shape check rejects
# out-of-range components, and the epoch round-trip rejects calendar-impossible
# instants such as 2026-02-30T00:00:00Z. The TypeScript reader applies the same
# round-trip, so both sides agree on what a trustworthy instant is.
is_valid_instant() {
  local value="$1"
  [[ "$value" =~ $ISO_UTC_RE ]] || return 1
  local epoch formatted
  # BSD date (macOS pilot host) uses -j -f; GNU date (production) uses -d.
  if epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" '+%s' 2>/dev/null)" \
    && [[ -n "$epoch" ]]; then
    formatted="$(date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
    [[ "$formatted" == "$value" ]]
    return $?
  fi
  if epoch="$(date -u -d "$value" '+%s' 2>/dev/null)" && [[ -n "$epoch" ]]; then
    formatted="$(date -u -d "@${epoch}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
    [[ "$formatted" == "$value" ]]
    return $?
  fi
  # Neither date dialect available: the range-limited shape check stands alone.
  return 0
}

usage() {
  cat >&2 <<'USAGE'
usage: backup-observation.sh --state PATH --trigger CLASS --started-at ISO
                             --outcome running|success|failure
                             [--completed-at ISO] [--failure-class CLASS]
USAGE
}

fail_usage() {
  printf 'backup-observation: %s\n' "$1" >&2
  usage
  exit 64
}

STATE_PATH=""
TRIGGER=""
STARTED_AT=""
OUTCOME=""
COMPLETED_AT=""
FAILURE_CLASS=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --state) STATE_PATH="${2:-}"; shift 2 ;;
    --trigger) TRIGGER="${2:-}"; shift 2 ;;
    --started-at) STARTED_AT="${2:-}"; shift 2 ;;
    --outcome) OUTCOME="${2:-}"; shift 2 ;;
    --completed-at) COMPLETED_AT="${2:-}"; shift 2 ;;
    --failure-class) FAILURE_CLASS="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) fail_usage "unknown argument: $1" ;;
  esac
done

[[ -n "$STATE_PATH" ]] || fail_usage "--state is required"
[[ -n "$TRIGGER" ]] || fail_usage "--trigger is required"
[[ -n "$STARTED_AT" ]] || fail_usage "--started-at is required"
[[ -n "$OUTCOME" ]] || fail_usage "--outcome is required"

contains() {
  local needle="$1"; shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" == "$needle" ]] && return 0
  done
  return 1
}

contains "$TRIGGER" "${TRIGGER_ALLOWLIST[@]}" || fail_usage "unsupported trigger class: ${TRIGGER}"
contains "$OUTCOME" "${OUTCOME_ALLOWLIST[@]}" || fail_usage "unsupported outcome: ${OUTCOME}"
is_valid_instant "$STARTED_AT" || fail_usage "--started-at must be an ISO-8601 UTC instant"
[[ -n "$STATE_PATH" && "$STATE_PATH" == /* && "$STATE_PATH" != */ && "$STATE_PATH" != *//* ]] \
  || fail_usage "--state must be a normalized absolute path"

case "$OUTCOME" in
  running)
    [[ -z "$COMPLETED_AT" ]] || fail_usage "--completed-at is not valid for outcome running"
    [[ -z "$FAILURE_CLASS" ]] || fail_usage "--failure-class is not valid for outcome running"
    ;;
  success)
    [[ -n "$COMPLETED_AT" ]] || fail_usage "--completed-at is required for outcome success"
    [[ -z "$FAILURE_CLASS" ]] || fail_usage "--failure-class is not valid for outcome success"
    ;;
  failure)
    [[ -n "$COMPLETED_AT" ]] || fail_usage "--completed-at is required for outcome failure"
    [[ -n "$FAILURE_CLASS" ]] || fail_usage "--failure-class is required for outcome failure"
    contains "$FAILURE_CLASS" "${FAILURE_CLASS_ALLOWLIST[@]}" \
      || fail_usage "unsupported failure class: ${FAILURE_CLASS}"
    ;;
esac

if [[ -n "$COMPLETED_AT" ]]; then
  is_valid_instant "$COMPLETED_AT" || fail_usage "--completed-at must be an ISO-8601 UTC instant"
fi

STATE_DIR="$(dirname -- "$STATE_PATH")"
STATE_NAME="$(basename -- "$STATE_PATH")"

# --- state directory contract ------------------------------------------------
# The directory must already exist with restrictive ownership/mode; creating it
# here would let a misconfigured deployment silently invent a permissive state
# root. systemd StateDirectory (0700, servora-med:servora-med) owns creation.
if [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  printf 'backup-observation: state directory is missing or not a physical directory\n' >&2
  exit 1
fi

# --- read prior evidence -----------------------------------------------------
# A failed or incomplete attempt must never erase the previous valid verified
# restore point, so the prior success evidence is carried forward verbatim.
# An unreadable or non-canonical state is NEVER rewritten: that would discard
# evidence we cannot prove we understood. The run fails closed instead.
# Reads a top-level scalar from the canonical flat state file. Prints the raw
# value for a JSON string or number, or `null` for a JSON null. Returns 1 when
# the key is absent or not in the canonical form, which the caller treats as a
# fail-closed condition. Keys are always from the fixed internal allowlist.
read_state_field() {
  local file="$1" key="$2" line
  line="$(grep -E "^  \"${key}\": " "$file" | head -n 1 || true)"
  [[ -n "$line" ]] || return 1
  if [[ "$line" =~ ^\ \ \"${key}\":\ null,?$ ]]; then
    printf 'null'
    return 0
  fi
  if [[ "$line" =~ ^\ \ \"${key}\":\ (-?[0-9]+),?$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$line" =~ ^\ \ \"${key}\":\ \"([^\"]*)\",?$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

prior_verified_at="null"
prior_verified_trigger="null"
prior_scheduled_verified_at="null"
prior_scheduled_started="null"
prior_scheduled_completed="null"
prior_scheduled_result="null"
prior_scheduled_failure_class="null"

state_exists=0
if [[ -e "$STATE_PATH" || -L "$STATE_PATH" ]]; then
  state_exists=1
  if [[ ! -f "$STATE_PATH" || -L "$STATE_PATH" ]]; then
    printf 'backup-observation: existing state is not a regular file\n' >&2
    exit 1
  fi
  if [[ "$(wc -c <"$STATE_PATH")" -gt "$MAX_STATE_BYTES" ]]; then
    printf 'backup-observation: existing state exceeds the size contract\n' >&2
    exit 1
  fi
  prior_schema="$(read_state_field "$STATE_PATH" schemaVersion)" || {
    printf 'backup-observation: existing state is not canonical (schemaVersion)\n' >&2
    exit 1
  }
  if [[ "$prior_schema" != "$SCHEMA_VERSION" ]]; then
    printf 'backup-observation: existing state has an unsupported schema version\n' >&2
    exit 1
  fi
  prior_verified_at="$(read_state_field "$STATE_PATH" latestVerifiedAt)" || {
    printf 'backup-observation: existing state is not canonical (latestVerifiedAt)\n' >&2
    exit 1
  }
  prior_verified_trigger="$(read_state_field "$STATE_PATH" latestVerifiedTrigger)" || {
    printf 'backup-observation: existing state is not canonical (latestVerifiedTrigger)\n' >&2
    exit 1
  }
  prior_scheduled_verified_at="$(read_state_field "$STATE_PATH" latestScheduledVerifiedAt)" || {
    printf 'backup-observation: existing state is not canonical (latestScheduledVerifiedAt)\n' >&2
    exit 1
  }
  prior_scheduled_started="$(read_state_field "$STATE_PATH" latestScheduledAttemptStartedAt)" || {
    printf 'backup-observation: existing state is not canonical (latestScheduledAttemptStartedAt)\n' >&2
    exit 1
  }
  prior_scheduled_completed="$(read_state_field "$STATE_PATH" latestScheduledAttemptCompletedAt)" || {
    printf 'backup-observation: existing state is not canonical (latestScheduledAttemptCompletedAt)\n' >&2
    exit 1
  }
  prior_scheduled_result="$(read_state_field "$STATE_PATH" latestScheduledAttemptResult)" || {
    printf 'backup-observation: existing state is not canonical (latestScheduledAttemptResult)\n' >&2
    exit 1
  }
  prior_scheduled_failure_class="$(read_state_field "$STATE_PATH" latestScheduledAttemptFailureClass)" || {
    printf 'backup-observation: existing state is not canonical (latestScheduledAttemptFailureClass)\n' >&2
    exit 1
  }

  # Carried-forward instants must themselves be trustworthy.
  for carried in "$prior_verified_at" "$prior_scheduled_verified_at" \
    "$prior_scheduled_started" "$prior_scheduled_completed"; do
    if [[ "$carried" != "null" ]] && ! is_valid_instant "$carried"; then
      printf 'backup-observation: existing state carries an invalid instant\n' >&2
      exit 1
    fi
  done
  if [[ "$prior_verified_trigger" != "null" ]] \
    && ! contains "$prior_verified_trigger" "${TRIGGER_ALLOWLIST[@]}"; then
    printf 'backup-observation: existing state carries an invalid trigger\n' >&2
    exit 1
  fi
  if [[ "$prior_scheduled_result" != "null" ]] \
    && ! contains "$prior_scheduled_result" "${OUTCOME_ALLOWLIST[@]}"; then
    printf 'backup-observation: existing state carries an invalid scheduled result\n' >&2
    exit 1
  fi
  if [[ "$prior_scheduled_failure_class" != "null" ]] \
    && ! contains "$prior_scheduled_failure_class" "${FAILURE_CLASS_ALLOWLIST[@]}"; then
    printf 'backup-observation: existing state carries an invalid failure class\n' >&2
    exit 1
  fi
  # An instant without its trigger (or the reverse) is not a trustworthy pair.
  if [[ "$prior_verified_at" == "null" && "$prior_verified_trigger" != "null" ]] \
    || [[ "$prior_verified_at" != "null" && "$prior_verified_trigger" == "null" ]]; then
    printf 'backup-observation: existing state has an inconsistent verified success\n' >&2
    exit 1
  fi
  # The scheduled attempt group is all-or-nothing.
  if [[ "$prior_scheduled_result" == "null" ]] \
    && { [[ "$prior_scheduled_started" != "null" ]] \
      || [[ "$prior_scheduled_completed" != "null" ]] \
      || [[ "$prior_scheduled_failure_class" != "null" ]]; }; then
    printf 'backup-observation: existing state has a partial scheduled attempt\n' >&2
    exit 1
  fi
  if [[ "$prior_scheduled_verified_at" != "null" && "$prior_scheduled_result" == "null" ]]; then
    printf 'backup-observation: existing state has a scheduled success without an attempt\n' >&2
    exit 1
  fi
fi

# --- derive the new document -------------------------------------------------
# Prior evidence is re-emitted in its JSON literal form so a failed or
# incomplete attempt can never erase it.
json_string_or_null() {
  if [[ "$1" == "null" ]]; then
    printf 'null'
  else
    printf '"%s"' "$1"
  fi
}

# Establishes the durability boundary without hiding platform or I/O errors.
# Production Linux uses GNU sync's targeted file/directory flush. The supported
# macOS local/pilot path uses BSD sync's dependency-free global flush because it
# has no GNU-compatible `-f PATH` form. Any non-zero result is a write failure.
flush_path() {
  local path="$1"
  case "$(uname -s)" in
    Linux) sync -f "$path" ;;
    Darwin) sync ;;
    *)
      printf 'backup-observation: unsupported durability platform\n' >&2
      return 1
      ;;
  esac
}

attempt_completed="null"
failure_class_json="null"
verified_at_json="$(json_string_or_null "$prior_verified_at")"
verified_trigger_json="$(json_string_or_null "$prior_verified_trigger")"
scheduled_verified_at_json="$(json_string_or_null "$prior_scheduled_verified_at")"

case "$OUTCOME" in
  running) attempt_completed="null" ;;
  success)
    attempt_completed="\"${COMPLETED_AT}\""
    # A checksum-verified success becomes the authoritative local restore point
    # for every trigger class; only the scheduled class also advances the
    # schedule heartbeat baseline.
    verified_at_json="\"${COMPLETED_AT}\""
    verified_trigger_json="\"${TRIGGER}\""
    if [[ "$TRIGGER" == "scheduled" ]]; then
      scheduled_verified_at_json="\"${COMPLETED_AT}\""
    fi
    ;;
  failure)
    attempt_completed="\"${COMPLETED_AT}\""
    failure_class_json="\"${FAILURE_CLASS}\""
    ;;
esac

# Scheduled heartbeat fields track only the scheduled trigger, so a deploy or
# manual backup can never satisfy or mask the daily timer contract.
scheduled_attempt_started="null"
scheduled_attempt_completed="null"
scheduled_attempt_result="null"
scheduled_attempt_failure_class="null"
if [[ "$TRIGGER" == "scheduled" ]]; then
  scheduled_attempt_started="\"${STARTED_AT}\""
  scheduled_attempt_completed="$attempt_completed"
  scheduled_attempt_result="\"${OUTCOME}\""
  scheduled_attempt_failure_class="$failure_class_json"
elif [[ "$state_exists" -eq 1 ]]; then
  # Preserve the established scheduled baseline; it is only ever advanced by the
  # scheduled trigger.
  scheduled_attempt_started="$(json_string_or_null "$prior_scheduled_started")"
  scheduled_attempt_completed="$(json_string_or_null "$prior_scheduled_completed")"
  scheduled_attempt_result="$(json_string_or_null "$prior_scheduled_result")"
  scheduled_attempt_failure_class="$(json_string_or_null "$prior_scheduled_failure_class")"
fi

updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

tmp_path="${STATE_DIR}/.${STATE_NAME}.tmp.$$"
# Single quotes on purpose: the path is expanded when the trap fires, so a
# partially written temp file can never survive as a stray artifact.
trap 'rm -f "$tmp_path" 2>/dev/null || true' EXIT

# A restrictive temp file in the SAME directory guarantees the rename below is a
# same-filesystem atomic operation.
if ! ( set -o noclobber; : >"$tmp_path" ) 2>/dev/null; then
  printf 'backup-observation: could not create a state temp file\n' >&2
  exit 1
fi
chmod 600 "$tmp_path"

cat >"$tmp_path" <<JSON
{
  "schemaVersion": ${SCHEMA_VERSION},
  "updatedAt": "${updated_at}",
  "latestAttemptTrigger": "${TRIGGER}",
  "latestAttemptStartedAt": "${STARTED_AT}",
  "latestAttemptCompletedAt": ${attempt_completed},
  "latestAttemptResult": "${OUTCOME}",
  "latestAttemptFailureClass": ${failure_class_json},
  "latestVerifiedAt": ${verified_at_json},
  "latestVerifiedTrigger": ${verified_trigger_json},
  "latestScheduledAttemptStartedAt": ${scheduled_attempt_started},
  "latestScheduledAttemptCompletedAt": ${scheduled_attempt_completed},
  "latestScheduledAttemptResult": ${scheduled_attempt_result},
  "latestScheduledAttemptFailureClass": ${scheduled_attempt_failure_class},
  "latestScheduledVerifiedAt": ${scheduled_verified_at_json}
}
JSON

# Flush the complete document to stable storage before it can become canonical.
if ! flush_path "$tmp_path"; then
  printf 'backup-observation: state temp-file flush failed\n' >&2
  exit 1
fi

mv -f -- "$tmp_path" "$STATE_PATH"
# The rename has already happened when this boundary fails. The complete new
# document may therefore be visible to the running system, but crash durability
# is unproven; returning failure prevents the backup from reporting success.
if ! flush_path "$STATE_DIR"; then
  printf 'backup-observation: state directory flush failed after rename\n' >&2
  exit 1
fi

trap - EXIT
exit 0
