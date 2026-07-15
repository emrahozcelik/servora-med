#!/usr/bin/env bash
# Ensure a non-admin macOS service user + matching group with collision-safe UID/GID.
#
# Usage:
#   sudo ./ops/scripts/ensure-macos-service-identity.sh <name> ["Real Name"]
#
# Canonical pilot names: servora-med, servora-postgres
#
# Behavior:
#   - Existing matching name → verify non-admin + consistent UID/GID mapping; exit 0
#   - Name missing → choose unused UID/GID; create group then user
#   - On failure of this invocation → rollback only records created here
#   - Pre-existing/foreign identities are never deleted
#
# Test hooks:
#   SERVORA_IDENTITY_STORE=/tmp/store   flat-file backend (Linux CI)
#   SERVORA_IDENTITY_FAIL_AT=after_group|after_user_create|after_user_uid
#
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail

NAME="${1:-}"
REAL_NAME="${2:-Servora service ${NAME}}"
ID_MIN="${SERVORA_ID_MIN:-420}"
ID_MAX="${SERVORA_ID_MAX:-489}"
FAIL_AT="${SERVORA_IDENTITY_FAIL_AT:-}"

CREATED_GROUP=0
CREATED_USER=0
ALLOCATED_ID=""

if [[ -z "${NAME}" ]]; then
  printf 'usage: %s <service-username> ["Real Name"]\n' "$(basename "$0")" >&2
  exit 2
fi
if ! [[ "${NAME}" =~ ^[a-z][a-z0-9_-]*$ ]]; then
  printf 'invalid service name: %s\n' "${NAME}" >&2
  exit 2
fi
if ! [[ "${ID_MIN}" =~ ^[0-9]+$ && "${ID_MAX}" =~ ^[0-9]+$ && "${ID_MIN}" -le "${ID_MAX}" ]]; then
  printf 'invalid SERVORA_ID_MIN/MAX\n' >&2
  exit 2
fi

STORE="${SERVORA_IDENTITY_STORE:-}"

die() {
  printf 'ensure-macos-service-identity: %s\n' "$*" >&2
  # Explicit exit does not fire ERR traps; roll back on the way out.
  if [[ "${CREATED_USER}" -eq 1 || "${CREATED_GROUP}" -eq 1 ]]; then
    if declare -F rollback_created >/dev/null 2>&1; then
      rollback_created || true
    fi
  fi
  exit 1
}

maybe_fail() {
  local point="$1"
  if [[ "${FAIL_AT}" == "${point}" ]]; then
    die "injected failure at ${point}"
  fi
}

# --- backend: flat-file mock (tests) -----------------------------------------

mock_init() {
  mkdir -p "${STORE}/users" "${STORE}/groups" "${STORE}/uids" "${STORE}/gids" "${STORE}/admins"
}

mock_user_exists() { [[ -f "${STORE}/users/${NAME}" ]]; }
mock_group_exists() { [[ -f "${STORE}/groups/${NAME}" ]]; }

mock_user_uid() { cat "${STORE}/users/${NAME}"; }
mock_group_gid() { cat "${STORE}/groups/${NAME}"; }

mock_uid_owner() {
  local uid="$1"
  if [[ -f "${STORE}/uids/${uid}" ]]; then
    cat "${STORE}/uids/${uid}"
  fi
}

mock_gid_owner() {
  local gid="$1"
  if [[ -f "${STORE}/gids/${gid}" ]]; then
    cat "${STORE}/gids/${gid}"
  fi
}

mock_is_admin() {
  [[ -f "${STORE}/admins/${NAME}" ]]
}

mock_create_group() {
  local gid="$1"
  printf '%s\n' "${gid}" >"${STORE}/groups/${NAME}"
  printf '%s\n' "${NAME}" >"${STORE}/gids/${gid}"
}

mock_create_user() {
  local uid="$1"
  printf '%s\n' "${uid}" >"${STORE}/users/${NAME}"
  printf '%s\n' "${NAME}" >"${STORE}/uids/${uid}"
}

mock_delete_user() {
  local uid
  if [[ -f "${STORE}/users/${NAME}" ]]; then
    uid="$(cat "${STORE}/users/${NAME}")"
    rm -f "${STORE}/users/${NAME}"
    if [[ -n "${uid}" && -f "${STORE}/uids/${uid}" ]]; then
      if [[ "$(cat "${STORE}/uids/${uid}")" == "${NAME}" ]]; then
        rm -f "${STORE}/uids/${uid}"
      fi
    fi
  fi
}

mock_delete_group() {
  local gid
  if [[ -f "${STORE}/groups/${NAME}" ]]; then
    gid="$(cat "${STORE}/groups/${NAME}")"
    rm -f "${STORE}/groups/${NAME}"
    if [[ -n "${gid}" && -f "${STORE}/gids/${gid}" ]]; then
      if [[ "$(cat "${STORE}/gids/${gid}")" == "${NAME}" ]]; then
        rm -f "${STORE}/gids/${gid}"
      fi
    fi
  fi
}

# --- backend: macOS dscl -----------------------------------------------------

dscl_user_exists() {
  dscl . -read "/Users/${NAME}" UniqueID >/dev/null 2>&1
}

dscl_group_exists() {
  dscl . -read "/Groups/${NAME}" PrimaryGroupID >/dev/null 2>&1
}

dscl_user_uid() {
  dscl . -read "/Users/${NAME}" UniqueID | awk '{print $2}'
}

dscl_group_gid() {
  dscl . -read "/Groups/${NAME}" PrimaryGroupID | awk '{print $2}'
}

dscl_uid_owner() {
  local uid="$1"
  local line
  line="$(dscl . -list /Users UniqueID 2>/dev/null | awk -v id="${uid}" '$2 == id {print $1; exit}')"
  printf '%s' "${line}"
}

dscl_gid_owner() {
  local gid="$1"
  local line
  line="$(dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk -v id="${gid}" '$2 == id {print $1; exit}')"
  printf '%s' "${line}"
}

dscl_is_admin() {
  dseditgroup -o checkmember -m "${NAME}" admin >/dev/null 2>&1
}

dscl_create_group() {
  local gid="$1"
  dscl . -create "/Groups/${NAME}" || return 1
  dscl . -create "/Groups/${NAME}" PrimaryGroupID "${gid}" || return 1
}

dscl_delete_user() {
  if dscl . -read "/Users/${NAME}" UniqueID >/dev/null 2>&1; then
    dscl . -delete "/Users/${NAME}" || return 1
  fi
}

dscl_delete_group() {
  if dscl . -read "/Groups/${NAME}" PrimaryGroupID >/dev/null 2>&1; then
    dscl . -delete "/Groups/${NAME}" || return 1
  fi
}

# --- dispatch ----------------------------------------------------------------

if [[ -n "${STORE}" ]]; then
  mock_init
  user_exists() { mock_user_exists; }
  group_exists() { mock_group_exists; }
  user_uid() { mock_user_uid; }
  group_gid() { mock_group_gid; }
  uid_owner() { mock_uid_owner "$1"; }
  gid_owner() { mock_gid_owner "$1"; }
  is_admin() { mock_is_admin; }
  create_group() {
    mock_create_group "$1"
    CREATED_GROUP=1
    maybe_fail after_group
  }
  create_user() {
    mock_create_user "$1"
    CREATED_USER=1
    maybe_fail after_user_create
    maybe_fail after_user_uid
  }
  delete_user() { mock_delete_user; }
  delete_group() { mock_delete_group; }
else
  if ! command -v dscl >/dev/null 2>&1; then
    die "dscl not available; set SERVORA_IDENTITY_STORE for non-macOS tests"
  fi
  user_exists() { dscl_user_exists; }
  group_exists() { dscl_group_exists; }
  user_uid() { dscl_user_uid; }
  group_gid() { dscl_group_gid; }
  uid_owner() { dscl_uid_owner "$1"; }
  gid_owner() { dscl_gid_owner "$1"; }
  is_admin() { dscl_is_admin; }
  create_group() {
    dscl_create_group "$1"
    CREATED_GROUP=1
    maybe_fail after_group
  }
  create_user() {
    # Create user shell first so CREATED_USER is set before later property failures.
    dscl . -create "/Users/${NAME}" || return 1
    CREATED_USER=1
    maybe_fail after_user_create
    dscl . -create "/Users/${NAME}" UserShell /usr/bin/false || return 1
    dscl . -create "/Users/${NAME}" RealName "${REAL_NAME}" || return 1
    maybe_fail after_user_uid
    dscl . -create "/Users/${NAME}" UniqueID "${1}" || return 1
    dscl . -create "/Users/${NAME}" PrimaryGroupID "${1}" || return 1
    dscl . -create "/Users/${NAME}" NFSHomeDirectory /var/empty || return 1
    dscl . -create "/Users/${NAME}" IsHidden 1 || true
  }
  delete_user() { dscl_delete_user; }
  delete_group() { dscl_delete_group; }
fi

allocate_free_id() {
  local candidate owner_u owner_g
  for ((candidate = ID_MIN; candidate <= ID_MAX; candidate++)); do
    owner_u="$(uid_owner "${candidate}" || true)"
    owner_g="$(gid_owner "${candidate}" || true)"
    if [[ -z "${owner_u}" && -z "${owner_g}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  die "no free UID/GID in range ${ID_MIN}-${ID_MAX}"
}

rollback_created() {
  local errors=0
  if [[ "${CREATED_USER}" -eq 1 ]]; then
    if ! delete_user; then
      printf 'ensure-macos-service-identity: rollback failed deleting user %s\n' "${NAME}" >&2
      printf 'manual recovery: remove user %s only if created by this failed run (id=%s)\n' "${NAME}" "${ALLOCATED_ID}" >&2
      errors=1
    else
      CREATED_USER=0
    fi
  fi
  if [[ "${CREATED_GROUP}" -eq 1 ]]; then
    if ! delete_group; then
      printf 'ensure-macos-service-identity: rollback failed deleting group %s\n' "${NAME}" >&2
      printf 'manual recovery: remove group %s only if created by this failed run (id=%s)\n' "${NAME}" "${ALLOCATED_ID}" >&2
      errors=1
    else
      CREATED_GROUP=0
    fi
  fi
  return "${errors}"
}

# ERR covers non-die command failures; die() rolls back itself.
on_error() {
  local exit_code=$?
  if [[ "${CREATED_USER}" -eq 1 || "${CREATED_GROUP}" -eq 1 ]]; then
    if ! rollback_created; then
      printf 'ensure-macos-service-identity: partial rollback; foreign identities were not modified\n' >&2
    fi
  fi
  exit "${exit_code}"
}
trap on_error ERR

# --- main --------------------------------------------------------------------

ue=0
ge=0
user_exists && ue=1
group_exists && ge=1

if [[ "${ue}" -eq 1 && "${ge}" -eq 0 ]]; then
  die "partial identity: user ${NAME} exists but group ${NAME} is missing"
fi
if [[ "${ue}" -eq 0 && "${ge}" -eq 1 ]]; then
  die "partial identity: group ${NAME} exists but user ${NAME} is missing"
fi

if [[ "${ue}" -eq 1 && "${ge}" -eq 1 ]]; then
  uid="$(user_uid)"
  gid="$(group_gid)"
  [[ -n "${uid}" && -n "${gid}" ]] || die "could not read UID/GID for ${NAME}"
  if [[ "${uid}" != "${gid}" ]]; then
    die "identity mismatch for ${NAME}: UniqueID=${uid} PrimaryGroupID=${gid} (must match)"
  fi
  owner_u="$(uid_owner "${uid}" || true)"
  owner_g="$(gid_owner "${gid}" || true)"
  if [[ -n "${owner_u}" && "${owner_u}" != "${NAME}" ]]; then
    die "UID ${uid} is owned by ${owner_u}, not ${NAME}"
  fi
  if [[ -n "${owner_g}" && "${owner_g}" != "${NAME}" ]]; then
    die "GID ${gid} is owned by ${owner_g}, not ${NAME}"
  fi
  if is_admin; then
    die "${NAME} is an admin principal; pilot service users must be non-admin"
  fi
  printf 'ok existing non-admin identity %s uid/gid=%s\n' "${NAME}" "${uid}"
  exit 0
fi

# Neither user nor group exists — allocate and create with rollback on failure.
ALLOCATED_ID="$(allocate_free_id)"
owner_u="$(uid_owner "${ALLOCATED_ID}" || true)"
owner_g="$(gid_owner "${ALLOCATED_ID}" || true)"
if [[ -n "${owner_u}" || -n "${owner_g}" ]]; then
  die "UID/GID ${ALLOCATED_ID} became owned during allocation (user=${owner_u:-none} group=${owner_g:-none})"
fi

create_group "${ALLOCATED_ID}"
create_user "${ALLOCATED_ID}"

# Post-create verification
user_exists || die "create reported success but user ${NAME} missing"
group_exists || die "create reported success but group ${NAME} missing"
uid="$(user_uid)"
gid="$(group_gid)"
[[ "${uid}" == "${ALLOCATED_ID}" && "${gid}" == "${ALLOCATED_ID}" ]] || die "post-create id mismatch for ${NAME}"
if is_admin; then
  die "created ${NAME} but it is admin; aborting"
fi

# Success — do not roll back on EXIT.
trap - ERR
printf 'ok created non-admin identity %s uid/gid=%s\n' "${NAME}" "${uid}"
