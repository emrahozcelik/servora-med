#!/usr/bin/env bash
# Run-owned Docker lifecycle. Source only; callers explicitly pin the daemon.
set -Eeuo pipefail

ci_resource_log() {
  printf '%s\n' "$*" >&2
  if [[ -n "${CLEANUP_LOG:-}" ]]; then
    printf '%s\n' "$*" >>"$CLEANUP_LOG" || printf 'LOCAL_CI_CLEANUP_LOG_FAILED\n' >&2
  fi
  return 0
}

# Resolve colima-true once. Pin its local endpoint for every child process so
# later `docker context use` / context-file edits cannot redirect this run.
ci_pin_docker_daemon() {
  local selected endpoint daemon
  selected="$(command docker context show)" || return 1
  if [[ "$selected" != colima-true || -n "${DOCKER_HOST:-}" ]]; then
    echo 'LOCAL_CI_FAILED reason=DOCKER_CONTEXT_MISMATCH expected=colima-true (unset DOCKER_HOST)' >&2
    return 1
  fi
  endpoint="$(command docker context inspect colima-true --format '{{.Endpoints.docker.Host}}')" || return 1
  [[ "$endpoint" == unix://* ]] || { echo 'LOCAL_CI_FAILED reason=DOCKER_ENDPOINT_NOT_LOCAL' >&2; return 1; }
  export LOCAL_CI_DOCKER_ENDPOINT="$endpoint" DOCKER_HOST="$endpoint"
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  daemon="$(ci_docker info --format '{{.ID}}')" || return 1
  [[ -n "$daemon" ]] || { echo 'LOCAL_CI_FAILED reason=DOCKER_DAEMON_ID_MISSING' >&2; return 1; }
  export LOCAL_CI_DOCKER_DAEMON_ID="$daemon"
}

ci_docker() { command docker --host "${LOCAL_CI_DOCKER_ENDPOINT:?}" "$@"; }

ci_assert_docker_daemon() {
  local actual
  if ! actual="$(ci_docker info --format '{{.ID}}')" || [[ -z "${LOCAL_CI_DOCKER_DAEMON_ID:-}" || "$actual" != "$LOCAL_CI_DOCKER_DAEMON_ID" ]]; then
    ci_resource_log 'LOCAL_CI_FAILED reason=DOCKER_DAEMON_MISMATCH resources_left_for_supervised_recovery'
    return 1
  fi
}

# Only ambiguous create replies need discovery. Names alone never authorize a
# removal: require the exact run label and a full immutable Docker resource ID.
ci_recover_resource_id() {
  local kind="$1" name="$2" metadata id label format
  if [[ "$kind" == container ]]; then
    format='{{.Id}} {{index .Config.Labels "com.servora.local-ci.run"}}'
  else
    format='{{.Id}} {{index .Labels "com.servora.local-ci.run"}}'
  fi
  if ! metadata="$(ci_docker "$kind" inspect --format "$format" "$name")"; then
    ci_resource_log "LOCAL_CI_OWNERSHIP_UNKNOWN kind=$kind name=$name inspection_failed"
    return 1
  fi
  read -r id label <<<"$metadata"
  if [[ ! "$id" =~ ^[0-9a-f]{64}$ || "$label" != "${RUN_ID:?}" ]]; then
    ci_resource_log "LOCAL_CI_OWNERSHIP_UNKNOWN kind=$kind name=$name label_mismatch"
    return 1
  fi
  ci_resource_log "LOCAL_CI_RESOURCE_RECOVERED kind=$kind id=$id run=$RUN_ID"
  printf '%s' "$id"
}

ci_create_run_resources() {
  local code label="com.servora.local-ci.run=${RUN_ID:?}"
  NET_CREATE_ATTEMPTED=true
  if NET_ID="$(ci_docker network create --label "$label" "$NET")"; then
    [[ "$NET_ID" =~ ^[0-9a-f]{64}$ ]] || { NET_ID=""; return 1; }
  else
    code=$?; NET_ID=""; return "$code"
  fi
  ci_resource_log "LOCAL_CI_RESOURCE_CREATED kind=network id=$NET_ID run=$RUN_ID"
  PG_CREATE_ATTEMPTED=true
  if PG_ID="$(ci_docker create --name "$PG" --label "$label" --network "$NET_ID" --network-alias servora-localci-pg \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=servora_med_test postgres:17-alpine)"; then
    [[ "$PG_ID" =~ ^[0-9a-f]{64}$ ]] || { PG_ID=""; return 1; }
  else
    code=$?; PG_ID=""; return "$code"
  fi
  # A successful create reply proves ownership of this immutable ID even if
  # later inspection is unavailable. Record before start, which can fail.
  ci_resource_log "LOCAL_CI_RESOURCE_CREATED kind=container id=$PG_ID run=$RUN_ID"
  ci_docker start "$PG_ID" >/dev/null
}

ci_cleanup_command() {
  local output code
  if output="$(ci_docker "$@" 2>&1)"; then
    ci_resource_log "LOCAL_CI_CLEANUP_OK operation=$*${output:+ output=$output}"
  else
    code=$?
    ci_resource_log "LOCAL_CI_CLEANUP_FAILED operation=$* exit=$code${output:+ output=$output}"
    return 1
  fi
}

# EXIT-trap policy. Never masks the CI status. Cleanup failures and unresolved
# ownership are retained separately in logs/aux/cleanup.log and cleanup.status.
ci_cleanup_run_resources() {
  local owner failed=false
  owner="$(cat -- "${LOCAL_CI_LOCK_DIR:-}/pid" 2>/dev/null || true)"
  if [[ -z "${LOCAL_CI_LOCK_CLAIM:-}" || "$owner" != "$LOCAL_CI_LOCK_CLAIM" ]]; then
    echo 'LOCAL_CI cleanup: ownership unknown; resources left in place' >&2
    return 0
  fi
  if [[ "${KEEP:-false}" != true ]]; then
    if ci_assert_docker_daemon; then
      if [[ -z "${PG_ID:-}" && "${PG_CREATE_ATTEMPTED:-false}" == true ]]; then
        PG_ID="$(ci_recover_resource_id container "$PG")" || failed=true
      fi
      if [[ -n "${PG_ID:-}" ]]; then
        # Docker distinguishes anonymous mounts from named/shared volumes.
        # No volume-list inspection or label-based anonymity guesses.
        ci_cleanup_command rm -fv "$PG_ID" || failed=true
      fi
      if [[ -z "${NET_ID:-}" && "${NET_CREATE_ATTEMPTED:-false}" == true ]]; then
        NET_ID="$(ci_recover_resource_id network "$NET")" || failed=true
      fi
      if [[ -n "${NET_ID:-}" ]]; then
        ci_cleanup_command network rm "$NET_ID" || failed=true
      fi
    else
      failed=true
    fi
  else
    ci_resource_log 'LOCAL_CI_CLEANUP_KEPT reason=keep-containers'
  fi
  if [[ "${EXPORT_CREATED:-false}" == true ]]; then
    rm -rf -- "${EXPORT_DIR:?}" || { ci_resource_log 'LOCAL_CI_CLEANUP_FAILED operation=remove-export'; failed=true; }
  fi
  if ! rm -- "$LOCAL_CI_LOCK_DIR/pid" || ! rmdir -- "$LOCAL_CI_LOCK_DIR"; then
    ci_resource_log 'LOCAL_CI_CLEANUP_FAILED operation=release-lock'
    failed=true
  fi
  if [[ -n "${CLEANUP_LOG:-}" ]]; then
    if [[ "$failed" == true ]]; then
      printf 'FAIL\n' >"${CLEANUP_LOG%.log}.status" || ci_resource_log 'LOCAL_CI_CLEANUP_STATUS_WRITE_FAILED'
    else
      printf 'PASS\n' >"${CLEANUP_LOG%.log}.status" || ci_resource_log 'LOCAL_CI_CLEANUP_STATUS_WRITE_FAILED'
    fi
  fi
  return 0
}
