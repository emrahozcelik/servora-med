#!/usr/bin/env bash
# lib/resource-cleanup.sh — ownership-scoped local-CI resource cleanup.
#
# Sourceable only; never executes on source. Called by run.sh's EXIT trap via
# ci_cleanup_run_resources. Unit-tested by ops/tests/ci-resource-cleanup.test.mjs
# against a fake docker(1); see DOCKER_BIN below.
#
# Policy (fail-closed, ownership-scoped):
#   - Resources are removed only when this run still holds the lock claim.
#   - Only resources this run created are addressed: the PG container, the
#     assistant network, the anonymous data volumes recorded from the PG
#     container at creation time, and the run-owned tree export directory.
#   - A recorded volume is removed only while it still looks anonymous
#     (no user labels). Anything else is left in place with a warning.
#   - --keep-containers keeps containers, networks AND their volumes.
#   - Evidence bundles and logs are never touched by cleanup.
#   - Broad operations are forbidden here by design: no `docker system prune`,
#     no `docker volume prune`, no `colima delete`, no `limactl delete`.
#     Cross-project or shared resources can never match the ownership gates.
set -Eeuo pipefail

# DOCKER_BIN override exists so tests can inject a fake docker(1).
ci_docker() { "${DOCKER_BIN:-docker}" "$@"; }

# ci_list_container_volumes <container>: print space-separated names of the
# volumes mounted by the container. Empty (with a warning) on any failure.
ci_list_container_volumes() {
  local container="$1" names=""
  names="$(ci_docker inspect --format '{{ range .Mounts }}{{ .Name }} {{ end }}' "$container" 2>/dev/null || true)"
  if [[ -z "${names// /}" ]]; then
    echo "LOCAL_CI cleanup: no recorded volumes for $container; leaving storage in place" >&2
  fi
  printf '%s' "$names"
}

# ci_is_removable_volume <name>: true only while the volume still looks
# anonymous (docker's anonymous marker label at most, never user labels).
ci_is_removable_volume() {
  local name="$1" labels=""
  labels="$(ci_docker volume inspect --format '{{json .Labels}}' "$name" 2>/dev/null || true)"
  case "$labels" in
    'null' | '{}' | '{"com.docker.volume.anonymous":""}') return 0 ;;
    *) return 1 ;;
  esac
}

# ci_cleanup_run_resources: full trap policy driven by run.sh state variables.
# Always exits 0 so a trap never masks the run's real outcome.
ci_cleanup_run_resources() {
  local owner=""
  owner="$(cat -- "${LOCAL_CI_LOCK_DIR:-}/pid" 2>/dev/null || true)"
  if [[ -z "${LOCAL_CI_LOCK_CLAIM:-}" || "$owner" != "${LOCAL_CI_LOCK_CLAIM:-}" ]]; then
    echo "LOCAL_CI cleanup: ownership unknown; resources left in place" >&2
    return 0
  fi
  if [[ "${KEEP:-false}" != "true" ]]; then
    if [[ "${PG_CREATED:-false}" == "true" ]]; then
      ci_docker rm -f "${PG:?}" >/dev/null 2>&1 || true
      local vol
      # shellcheck disable=SC2086 # PG_VOLUMES is intentionally space-separated.
      for vol in ${PG_VOLUMES:-}; do
        if ci_is_removable_volume "$vol"; then
          ci_docker volume rm "$vol" >/dev/null 2>&1 || true
        else
          echo "LOCAL_CI cleanup: keeping non-anonymous volume $vol" >&2
        fi
      done
    fi
    if [[ "${NET_CREATED:-false}" == "true" ]]; then
      ci_docker network rm "${NET:?}" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "${EXPORT_CREATED:-false}" == "true" ]]; then
    rm -rf -- "${EXPORT_DIR:?}"
  fi
  rm -- "$LOCAL_CI_LOCK_DIR/pid"
  rmdir -- "$LOCAL_CI_LOCK_DIR"
}
