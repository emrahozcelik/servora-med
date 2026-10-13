#!/usr/bin/env bash
# Common fixed-host kernel lock. Never unlink or reclaim ownership.
servora_acquire_host_lock() {
  local servora_lock_state=/var/lib/servora-med/deploy
  [[ "$EUID" -eq 0 ]] || fail ROOT_REQUIRED
  command -v flock >/dev/null || fail HOST_BOOTSTRAP_REQUIRED_flock
  [[ -d "$servora_lock_state" && ! -L "$servora_lock_state" && "$(stat -c %u "$servora_lock_state")" == 0 \
    && $((8#$(stat -c %a "$servora_lock_state") & 8#022)) -eq 0 ]] || fail HOST_LOCK_DIRECTORY_UNTRUSTED
  local lock="${servora_lock_state}/host.lock"
  if [[ ! -e "$lock" && ! -L "$lock" ]]; then
    (set -o noclobber; : >"$lock") || fail HOST_LOCK_CREATE_FAILED
  fi
  [[ -f "$lock" && ! -L "$lock" && "$(stat -c '%U:%G:%a:%h' "$lock")" == root:root:600:1 ]] \
    || fail HOST_LOCK_FILE_UNTRUSTED
  exec 9>>"$lock"
  [[ "$(stat -Lc '%d:%i' "/proc/$$/fd/9")" == "$(stat -c '%d:%i' "$lock")" ]] || fail HOST_LOCK_FILE_REPLACED
  flock -n 9 || fail HOST_DEPLOYMENT_LOCK_BUSY
}


servora_assert_no_pending_attempt() {
  [[ "$EUID" -eq 0 ]] || fail ROOT_REQUIRED
  [[ ! -e /var/lib/servora-med/deploy/active.json && ! -L /var/lib/servora-med/deploy/active.json \
    && ! -e /var/lib/servora-med/deploy/activation.block && ! -L /var/lib/servora-med/deploy/activation.block ]] || fail RECOVERY_ATTEMPT_PENDING
  # A crash may leave the sealed initialization reservation before active.json
  # is published. Maintenance must not race that same-owner admission window.
  local initialization=/var/lib/servora-med/deploy/initializations
  if [[ -e "$initialization" || -L "$initialization" ]]; then
    [[ -d "$initialization" && ! -L "$initialization" \
      && "$(stat -c '%U:%G:%a' "$initialization")" == root:root:700 ]] || fail RECOVERY_ATTEMPT_PENDING
    local reserved
    reserved="$(find "$initialization" -mindepth 1 -maxdepth 1 -print -quit)" || fail RECOVERY_ATTEMPT_PENDING
    [[ -z "$reserved" ]] || fail RECOVERY_ATTEMPT_PENDING
  fi
}
