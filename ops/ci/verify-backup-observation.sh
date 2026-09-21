#!/usr/bin/env bash
# Deterministic contract proof for the host backup observation state writer
# (OPS-004 / OPS-BACKUP-OBS-1). Runs entirely in a temporary directory: it never
# touches /var/lib, never contacts PostgreSQL and never invokes a real backup.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRITER="$ROOT/ops/scripts/backup-observation.sh"

TMP_BASE="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${TMP_BASE%/}/servora-obs-XXXXXX")"
cleanup() { chmod -R u+rwx "$TMP" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

STATE_DIR="$TMP/state"
STATE="$STATE_DIR/observation-v1.json"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

failures=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok   %s\n' "$1"
}

expect_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi
}

expect_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  expect_eq "$label" "$actual" "$expected"
}

# Reads a top-level key from the canonical state as JSON (null prints as null).
state_field() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    process.stdout.write(value === null ? "null" : String(value));
  ' "$STATE" "$1"
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}

inode_of() {
  if stat -c '%i' "$1" >/dev/null 2>&1; then stat -c '%i' "$1"; else stat -f '%i' "$1"; fi
}

# --- G: syntax -----------------------------------------------------------------
if bash -n "$WRITER"; then
  pass "bash -n backup-observation.sh"
else
  fail "bash -n backup-observation.sh"
fi

# --- A: first attempt ----------------------------------------------------------
"$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T02:30:00Z --outcome running
expect_eq "begin publishes a valid document" "$(state_field schemaVersion)" "1"
expect_eq "begin records the attempt as running" "$(state_field latestAttemptResult)" "running"
expect_eq "begin has no completion instant" "$(state_field latestAttemptCompletedAt)" "null"
expect_eq "begin has no verified restore point" "$(state_field latestVerifiedAt)" "null"
expect_eq "state file mode is 0600" "$(file_mode "$STATE")" "600"
pass "first attempt publishes a parseable document"

# --- B: atomic replace, not in-place rewrite -----------------------------------
before_inode="$(inode_of "$STATE")"
"$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T02:30:00Z \
  --outcome success --completed-at 2026-09-21T02:30:04Z
after_inode="$(inode_of "$STATE")"
if [[ "$before_inode" != "$after_inode" ]]; then
  pass "canonical state is replaced by atomic rename (inode changes)"
else
  fail "canonical state was rewritten in place (inode unchanged)"
fi
expect_eq "verified success records the restore point" "$(state_field latestVerifiedAt)" "2026-09-21T02:30:04Z"
expect_eq "verified success records its trigger" "$(state_field latestVerifiedTrigger)" "scheduled"
expect_eq "scheduled success advances the heartbeat baseline" \
  "$(state_field latestScheduledVerifiedAt)" "2026-09-21T02:30:04Z"

# --- B: no temporary residue left behind ---------------------------------------
leftovers="$(find "$STATE_DIR" -maxdepth 1 -name '.*tmp*' -print | wc -l | tr -d ' ')"
expect_eq "no temporary state residue remains" "$leftovers" "0"

# --- B: a stray partial temp file cannot become canonical ----------------------
printf '{ "schemaVersion": 1, "partial' >"$STATE_DIR/.${STATE##*/}.tmp.999999"
expect_eq "canonical state ignores a stray partial temp file" "$(state_field latestVerifiedAt)" "2026-09-21T02:30:04Z"
rm -f "$STATE_DIR/.${STATE##*/}.tmp.999999"

# --- B: failed attempt preserves the prior verified restore point --------------
"$WRITER" --state "$STATE" --trigger postdeploy --started-at 2026-09-21T14:00:00Z \
  --outcome failure --completed-at 2026-09-21T14:00:09Z --failure-class DUMP_FAILED
expect_eq "failure is recorded as the latest attempt" "$(state_field latestAttemptResult)" "failure"
expect_eq "failure records its safe class" "$(state_field latestAttemptFailureClass)" "DUMP_FAILED"
expect_eq "pg_dump failure preserves the prior success" \
  "$(state_field latestVerifiedAt)" "2026-09-21T02:30:04Z"
expect_eq "postdeploy does not advance the scheduled baseline" \
  "$(state_field latestScheduledVerifiedAt)" "2026-09-21T02:30:04Z"
expect_eq "postdeploy does not overwrite the scheduled attempt" \
  "$(state_field latestScheduledAttemptResult)" "success"

# --- B: checksum failure preserves the prior verified restore point ------------
"$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T15:00:00Z \
  --outcome failure --completed-at 2026-09-21T15:00:05Z --failure-class CHECKSUM_FAILED
expect_eq "checksum failure preserves the prior success" \
  "$(state_field latestVerifiedAt)" "2026-09-21T02:30:04Z"
expect_eq "checksum failure is recorded by class" \
  "$(state_field latestAttemptFailureClass)" "CHECKSUM_FAILED"

# --- B: a manual success is a restore point but never a schedule heartbeat -----
"$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T16:00:00Z \
  --outcome success --completed-at 2026-09-21T16:00:03Z
expect_eq "manual success becomes the latest restore point" \
  "$(state_field latestVerifiedAt)" "2026-09-21T16:00:03Z"
expect_eq "manual success records the manual trigger" "$(state_field latestVerifiedTrigger)" "manual"
expect_eq "manual success does not advance the scheduled baseline" \
  "$(state_field latestScheduledVerifiedAt)" "2026-09-21T02:30:04Z"
expect_eq "manual success does not overwrite the scheduled attempt" \
  "$(state_field latestScheduledAttemptResult)" "success"

# --- B: a state write failure fails visibly and leaves canonical state intact --
canonical_before="$(cat "$STATE")"
chmod 500 "$STATE_DIR"
expect_exit "writer fails when the state directory is not writable" 1 \
  "$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T17:00:00Z --outcome running
chmod 700 "$STATE_DIR"
expect_eq "canonical state survives a failed write" "$(cat "$STATE")" "$canonical_before"
expect_eq "failed write did not advance the attempt" "$(state_field latestAttemptStartedAt)" "2026-09-21T16:00:00Z"

# --- A: malformed / unsupported / unsafe existing state ------------------------
printf '{ not json\n' >"$STATE"
expect_exit "malformed existing state fails closed" 1 \
  "$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T18:00:00Z --outcome running
expect_eq "malformed existing state is left untouched" "$(cat "$STATE")" '{ not json'

printf '{\n  "schemaVersion": 99,\n  "updatedAt": "2026-09-21T02:30:04Z"\n}\n' >"$STATE"
expect_exit "unsupported schema version fails closed" 1 \
  "$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T18:00:00Z --outcome running

# An unexpected extra key is ignored, not rejected: an additive writer change
# must never brick the state.
printf '{\n  "schemaVersion": 1,\n  "updatedAt": "2026-09-21T02:30:04Z",\n  "futureField": "x",\n  "latestAttemptResult": null,\n  "latestAttemptTrigger": null,\n  "latestAttemptStartedAt": null,\n  "latestAttemptCompletedAt": null,\n  "latestAttemptFailureClass": null,\n  "latestVerifiedAt": null,\n  "latestVerifiedTrigger": null,\n  "latestScheduledAttemptStartedAt": null,\n  "latestScheduledAttemptCompletedAt": null,\n  "latestScheduledAttemptResult": null,\n  "latestScheduledAttemptFailureClass": null,\n  "latestScheduledVerifiedAt": null\n}\n' >"$STATE"
expect_exit "unexpected extra key is tolerated" 0 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T18:30:00Z --outcome running

# --- A: invalid instants in an existing state fail closed ----------------------
printf '{\n  "schemaVersion": 1,\n  "updatedAt": "2026-09-21T02:30:04Z",\n  "latestAttemptResult": null,\n  "latestAttemptTrigger": null,\n  "latestAttemptStartedAt": null,\n  "latestAttemptCompletedAt": null,\n  "latestAttemptFailureClass": null,\n  "latestVerifiedAt": "2026-13-45T99:99:99Z",\n  "latestVerifiedTrigger": "scheduled",\n  "latestScheduledAttemptStartedAt": null,\n  "latestScheduledAttemptCompletedAt": null,\n  "latestScheduledAttemptResult": null,\n  "latestScheduledAttemptFailureClass": null,\n  "latestScheduledVerifiedAt": null\n}\n' >"$STATE"
expect_exit "invalid instant in existing state fails closed" 1 \
  "$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T19:00:00Z --outcome running

# --- argument contract ---------------------------------------------------------
rm -f "$STATE"
expect_exit "unknown trigger class is rejected" 64 \
  "$WRITER" --state "$STATE" --trigger cron --started-at 2026-09-21T02:30:00Z --outcome running
expect_exit "unknown failure class is rejected" 64 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T02:30:00Z \
  --outcome failure --completed-at 2026-09-21T02:31:00Z --failure-class OOPS
expect_exit "success without a completion instant is rejected" 64 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T02:30:00Z --outcome success
expect_exit "running with a completion instant is rejected" 64 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T02:30:00Z \
  --outcome running --completed-at 2026-09-21T02:31:00Z
expect_exit "a non-UTC instant is rejected" 64 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T02:30:00+03:00 --outcome running
expect_exit "a relative state path is rejected" 64 \
  "$WRITER" --state "relative/observation-v1.json" --trigger manual \
  --started-at 2026-09-21T02:30:00Z --outcome running
if [[ ! -e "$STATE" ]]; then
  pass "rejected invocations publish nothing"
else
  fail "a rejected invocation created state"
fi

# --- missing state directory fails closed --------------------------------------
rm -rf "$STATE_DIR"
expect_exit "a missing state directory fails closed" 1 \
  "$WRITER" --state "$STATE" --trigger manual --started-at 2026-09-21T02:30:00Z --outcome running

# --- no secret-shaped content can enter the state ------------------------------
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
"$WRITER" --state "$STATE" --trigger scheduled --started-at 2026-09-21T02:30:00Z \
  --outcome success --completed-at 2026-09-21T02:30:04Z
if grep -Eq 'postgres://|PGPASSWORD|/var/|\.dump|sha256|servora_med@|password' "$STATE"; then
  fail "state document contains a path, filename, credential or database identifier"
else
  pass "state document carries only the status vocabulary and instants"
fi

printf '\n'
if [[ "$failures" -ne 0 ]]; then
  printf 'backup observation contract FAILED (%d checks)\n' "$failures" >&2
  exit 1
fi
echo "backup observation contract passed"
