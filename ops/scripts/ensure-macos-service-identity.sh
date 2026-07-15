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
#   - Name missing → allocate an unused UID/GID in [SERVORA_ID_MIN, SERVORA_ID_MAX]
#   - UID/GID owned by another principal → abort
#   - Partial user/group mismatch → abort (no silent repair of foreign ownership)
#
# Test hook (Linux/CI):
#   SERVORA_IDENTITY_STORE=/tmp/store  uses a flat-file backend instead of dscl.
#
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail

NAME="${1:-}"
REAL_NAME="${2:-Servora service ${NAME}}"
ID_MIN="${SERVORA_ID_MIN:-420}"
ID_MAX="${SERVORA_ID_MAX:-489}"

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
  exit 1
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

mock_create() {
  local uid="$1"
  local gid="$1"
  printf '%s\n' "${uid}" >"${STORE}/users/${NAME}"
  printf '%s\n' "${gid}" >"${STORE}/groups/${NAME}"
  printf '%s\n' "${NAME}" >"${STORE}/uids/${uid}"
  printf '%s\n' "${NAME}" >"${STORE}/gids/${gid}"
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
  # Member of admin group is not allowed for pilot service identities.
  dseditgroup -o checkmember -m "${NAME}" admin >/dev/null 2>&1
}

dscl_create() {
  local id="$1"
  dscl . -create "/Groups/${NAME}" || die "failed creating group ${NAME}"
  dscl . -create "/Groups/${NAME}" PrimaryGroupID "${id}" || die "failed setting group id for ${NAME}"
  dscl . -create "/Users/${NAME}" || die "failed creating user ${NAME}"
  dscl . -create "/Users/${NAME}" UserShell /usr/bin/false || die "failed setting shell for ${NAME}"
  dscl . -create "/Users/${NAME}" RealName "${REAL_NAME}" || die "failed setting RealName for ${NAME}"
  dscl . -create "/Users/${NAME}" UniqueID "${id}" || die "failed setting UniqueID for ${NAME}"
  dscl . -create "/Users/${NAME}" PrimaryGroupID "${id}" || die "failed setting PrimaryGroupID for ${NAME}"
  dscl . -create "/Users/${NAME}" NFSHomeDirectory /var/empty || die "failed setting home for ${NAME}"
  dscl . -create "/Users/${NAME}" IsHidden 1 || true
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
  create_identity() { mock_create "$1"; }
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
  create_identity() { dscl_create "$1"; }
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

# Neither user nor group exists — allocate.
new_id="$(allocate_free_id)"
# Re-check ownership immediately before create (TOCTOU reduced, still best-effort).
owner_u="$(uid_owner "${new_id}" || true)"
owner_g="$(gid_owner "${new_id}" || true)"
if [[ -n "${owner_u}" || -n "${owner_g}" ]]; then
  die "UID/GID ${new_id} became owned during allocation (user=${owner_u:-none} group=${owner_g:-none})"
fi

create_identity "${new_id}"

# Post-create verification
user_exists || die "create reported success but user ${NAME} missing"
group_exists || die "create reported success but group ${NAME} missing"
uid="$(user_uid)"
gid="$(group_gid)"
[[ "${uid}" == "${new_id}" && "${gid}" == "${new_id}" ]] || die "post-create id mismatch for ${NAME}"
if is_admin; then
  die "created ${NAME} but it is admin; aborting"
fi

printf 'ok created non-admin identity %s uid/gid=%s\n' "${NAME}" "${uid}"
