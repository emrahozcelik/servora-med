#!/usr/bin/env bash
# Root-owned fixed-purpose host helper for the controlled production deploy.
#
# This file is installed once at
# /usr/local/libexec/servora-med/deploy-production-host. It is deliberately
# separate from the runner-side ops/deploy-production.sh entrypoint so the
# only privileged command exposed to servora-deploy is this fixed helper.
set -Eeuo pipefail
umask 077

readonly SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$SAFE_PATH"

if [[ "${BASH_SOURCE[0]}" != "$0" && "${SERVORA_DEPLOY_TEST_MODE:-}" == 1 ]]; then
  # Source-only fixture hook. Direct production execution can never select a
  # different release root or current link through this branch.
  RELEASE_ROOT="${SERVORA_TEST_RELEASE_ROOT:-/tmp/servora-med-test/releases}"
  CURRENT_LINK="${SERVORA_TEST_CURRENT_LINK:-/tmp/servora-med-test/current}"
else
  RELEASE_ROOT="/opt/servora-med/releases"
  CURRENT_LINK="/opt/servora-med/current"
fi
readonly RELEASE_ROOT CURRENT_LINK
readonly SERVICE="servora-med.service"
readonly APP_ENV_FILE="/etc/servora-med/servora-med.env"
readonly BACKUP_DIR="/var/backups/servora-med"
readonly STATE_DIR="/var/lib/servora-med/deploy"
readonly PREDEPLOY_LAUNCHER="/usr/local/libexec/servora-med/predeploy-backup-launcher"
readonly PREDEPLOY_UNIT="/etc/systemd/system/servora-med-predeploy-backup@.service"
readonly EXPECTED_LAUNCHER_SHA256="166aab1e43a88f317f0d4a429de09e3f07d205e910ca03577d7efbda8bcf6f0d"
readonly EXPECTED_UNIT_SHA256="bb59f68869582585794d406090eb6abf6b738b7d95e981b1ca884a027659d3a0"
readonly NODE_BIN="/usr/bin/node"
readonly SERVICE_USER="servora-med"

PHASE=""
SHA=""
ARTIFACT=""
ARTIFACT_SHA=""
FQDN=""
ALLOW_MIGRATIONS=false
OLD_RELEASE=""
MIGRATIONS_APPLIED=0
SERVICE_STOPPED=false
STAGING_DIR=""
STATE_FILE=""
TEMP_FILES=()
CURRENT_SWITCHED=false

usage() {
  cat >&2 <<'EOF'
Usage:
  deploy-production-host.sh --phase deploy --sha SHA --artifact PATH \
    --artifact-sha SHA256 --fqdn HOST [--allow-migrations]
  deploy-production-host.sh --phase postdeploy --sha SHA --fqdn HOST
  deploy-production-host.sh --phase rollback --sha SHA --fqdn HOST
EOF
}

fail() {
  local reason="$1"
  echo "PRODUCTION_DEPLOYMENT_FAILED phase=${PHASE:-UNKNOWN} sha=${SHA:-UNKNOWN} reason=${reason}" >&2
  exit 1
}

cleanup() {
  local file
  if [[ "${#TEMP_FILES[@]}" -gt 0 ]]; then
    for file in "${TEMP_FILES[@]}"; do
      rm -f -- "$file" 2>/dev/null || true
    done
  fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf -- "$STAGING_DIR" 2>/dev/null || true
  fi
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT
fi

on_error() {
  local code=$?
  set +e
  if [[ "$SERVICE_STOPPED" == true && "$MIGRATIONS_APPLIED" -eq 0 && -n "$OLD_RELEASE" ]]; then
    if [[ "$CURRENT_SWITCHED" == true ]]; then
      atomic_switch "$OLD_RELEASE" >/dev/null 2>&1 || true
      CURRENT_SWITCHED=false
    fi
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
  fi
  echo "PRODUCTION_DEPLOYMENT_FAILED phase=${PHASE:-UNKNOWN} sha=${SHA:-UNKNOWN} reason=unexpected_error_${code}" >&2
  exit "$code"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap on_error ERR
fi

require_commands() {
  [[ "$(id -u)" -eq 0 ]] || fail ROOT_REQUIRED
  local command_name
  for command_name in sha256sum stat readlink tar find mv mkdir chmod chown systemctl curl setfacl getfacl sudo date sleep awk sort cut mktemp id basename dirname tr rm cmp sed grep od; do
    command -v "$command_name" >/dev/null 2>&1 || fail "HOST_BOOTSTRAP_REQUIRED_${command_name}"
  done
  [[ -x "$NODE_BIN" ]] || fail HOST_BOOTSTRAP_REQUIRED_node
  id "$SERVICE_USER" >/dev/null 2>&1 || fail HOST_BOOTSTRAP_REQUIRED_servora_med
}

validate_sha() {
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_SHA
}

validate_fqdn() {
  [[ "$FQDN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail INVALID_FQDN
}

validate_artifact() {
  [[ "$ARTIFACT" == /* && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || fail INVALID_ARTIFACT
  [[ "$(basename -- "$ARTIFACT")" == *"${SHA}"*.tar.gz ]] || fail ARTIFACT_SHA_NAME_MISMATCH
  [[ "$ARTIFACT_SHA" =~ ^[0-9a-f]{64}$ ]] || fail INVALID_ARTIFACT_SHA256
}

assert_env_contract() {
  [[ -f "$APP_ENV_FILE" && ! -L "$APP_ENV_FILE" ]] || fail HOST_ENV_CONTRACT_MISSING
  [[ "$(stat -c '%U:%G:%a' "$APP_ENV_FILE")" == 'root:servora-med:640' ]] \
    || fail HOST_ENV_CONTRACT_DRIFT
}

assert_host_backup_contract() {
  [[ -f "$PREDEPLOY_LAUNCHER" && ! -L "$PREDEPLOY_LAUNCHER" ]] || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ -f "$PREDEPLOY_UNIT" && ! -L "$PREDEPLOY_UNIT" ]] || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ "$(sha256sum "$PREDEPLOY_LAUNCHER" | awk '{print $1}')" == "$EXPECTED_LAUNCHER_SHA256" ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ "$(sha256sum "$PREDEPLOY_UNIT" | awk '{print $1}')" == "$EXPECTED_UNIT_SHA256" ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ "$(stat -c '%U:%G:%a' "$PREDEPLOY_LAUNCHER")" == 'root:root:755' ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ "$(stat -c '%U:%G:%a' "$PREDEPLOY_UNIT")" == 'root:root:644' ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
}

assert_release_dir() {
  local path="$1"
  local canonical
  [[ -d "$path" && ! -L "$path" ]] || return 1
  canonical="$(cd -- "$path" && pwd -P)" || return 1
  [[ "$canonical" == "$path" ]]
}

assert_release_file() {
  local path="$1"
  local parent canonical
  [[ -f "$path" && ! -L "$path" ]] || return 1
  parent="$(cd -- "$(dirname -- "$path")" && pwd -P)" || return 1
  canonical="${parent}/$(basename -- "$path")"
  [[ "$canonical" == "$path" ]]
}

current_release() {
  [[ -L "$CURRENT_LINK" ]] || fail CURRENT_RELEASE_POINTER_INVALID
  local resolved
  resolved="$(readlink -f -- "$CURRENT_LINK")" || fail CURRENT_RELEASE_POINTER_INVALID
  [[ "$resolved" == "$RELEASE_ROOT"/* ]] || fail CURRENT_RELEASE_POINTER_INVALID
  assert_release_dir "$resolved" || fail CURRENT_RELEASE_POINTER_INVALID
  printf '%s\n' "$resolved"
}

health_url_check() {
  local url="$1"
  curl --fail --silent --show-error --max-time 5 --output /dev/null "$url"
}

health_gate() {
  local attempt
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    if health_url_check 'http://127.0.0.1:3000/api/health' \
      && health_url_check "https://${FQDN}/api/health"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_service_and_health() {
  systemctl is-active --quiet "$SERVICE" || fail CURRENT_SERVICE_NOT_ACTIVE
  health_gate || fail CURRENT_HEALTH_FAILED
}

is_forbidden_artifact_path() {
  local clean="$1"
  case "$clean" in
    ..|../*|*/../*|*/..|.git|.git/*|*/.git|*/.git/*|.worktrees|.worktrees/*|*/.worktrees|*/.worktrees/*|host.md|*/host.md|.env|.env.*|*/.env|*/.env.*|credentials|*/credentials|credentials/*|*/credentials/*|password|*/password|passwords|*/passwords|passwords/*|*/passwords/*|customer-manifest*|*/customer-manifest*|personnel-manifest*|*/personnel-manifest*|*/db-dumps/*|*/private/tmp/*|*.pem|*.key|id_rsa|*/id_rsa|id_ed25519|*/id_ed25519|._*|*/._*)
      return 0
      ;;
    servora-med-shared-temporary-password|*/servora-med-shared-temporary-password|servora-med-shared-temporary-password.*|*/servora-med-shared-temporary-password.*|temporary-password|*/temporary-password|temporary-password.*|*/temporary-password.*|*temporary-password|*temporary-password.*)
      return 0
      ;;
    *password.*|*passwords.*)
      case "$clean" in
        *.json|*.csv|*.txt|*.yaml|*.yml|*.xlsx|*.xls|*.ods|*.tsv|*.toml|*.ini|*.conf|*.xml) return 0 ;;
      esac
      ;;
    *personnel-onboarding-credentials*|*personnel-onboarding-manifest*|*customer-onboarding*|*production-mapping*)
      return 0
      ;;
    *credential|*credentials)
      return 0
      ;;
    *credential.*|*credentials.*)
      case "$clean" in
        *.json|*.csv|*.txt|*.yaml|*.yml|*.xlsx|*.xls|*.ods|*.tsv|*.toml|*.ini|*.conf|*.xml) return 0 ;;
      esac
      ;;
  esac
  return 1
}

verify_archive_entries() {
  local entry clean
  tar -tzf "$ARTIFACT" >/dev/null || fail ARTIFACT_INVALID_ARCHIVE
  tar -tvzf "$ARTIFACT" >/dev/null || fail ARTIFACT_INVALID_ARCHIVE
  while IFS= read -r entry; do
    clean="${entry#./}"
    [[ "$clean" != /* ]] || fail ARTIFACT_PATH_TRAVERSAL
    [[ "$clean" != *$'\n'* && "$clean" != *$'\r'* ]] || fail ARTIFACT_PATH_INVALID
    is_forbidden_artifact_path "$clean" && fail ARTIFACT_FORBIDDEN_CONTENT
  done < <(tar -tzf "$ARTIFACT")

  # The helper extracts as root. Reject device nodes, FIFOs, and hard links so
  # an untrusted transferred archive can only create ordinary release files,
  # directories, and in-root symlinks.
  local mode
  while IFS= read -r mode; do
    case "${mode:0:1}" in
      -|d|l) ;;
      *) fail ARTIFACT_FORBIDDEN_FILE_TYPE ;;
    esac
  done < <(tar -tvzf "$ARTIFACT" | awk '{print $1}')
}

verify_checksum_sidecar() {
  local target="$1"
  local sidecar="$2"
  local invalid_reason="$3"
  local mismatch_reason="$4"
  local line expected filename actual checksum_pattern line_count byte
  [[ -f "$sidecar" && ! -L "$sidecar" ]] || fail "$invalid_reason"
  while IFS= read -r byte; do
    case "$byte" in
      0a|2[0-9a-f]|[3-6][0-9a-f]|7[0-9a-e]) ;;
      *) fail "$invalid_reason" ;;
    esac
  done < <(od -An -v -t x1 "$sidecar" | tr -s '[:space:]' '\n' | sed '/^$/d')
  line_count="$(awk 'END { print NR }' "$sidecar")" || fail "$invalid_reason"
  [[ "$line_count" == 1 ]] || fail "$invalid_reason"
  line="$(sed -n '1p' "$sidecar")" || fail "$invalid_reason"
  checksum_pattern='^([0-9a-f]{64})[ ][ ]([^[:space:]]+)$'
  [[ "$line" =~ $checksum_pattern ]] || fail "$invalid_reason"
  expected="${BASH_REMATCH[1]}"
  filename="${BASH_REMATCH[2]}"
  [[ "$filename" != */* && "$filename" == "$(basename -- "$target")" ]] \
    || fail "$invalid_reason"
  actual="$(sha256sum -- "$target" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "$mismatch_reason"
}

verify_artifact_checksum() {
  local actual
  actual="$(sha256sum -- "$ARTIFACT" | awk '{print $1}')"
  [[ "$actual" == "$ARTIFACT_SHA" ]] || fail ARTIFACT_CHECKSUM_MISMATCH
  verify_checksum_sidecar \
    "$ARTIFACT" \
    "${ARTIFACT}.sha256" \
    ARTIFACT_CHECKSUM_SIDECAR_INVALID \
    ARTIFACT_CHECKSUM_SIDECAR_MISMATCH
}

validate_extracted_links() {
  local root="$1"
  local link resolved
  while IFS= read -r -d '' link; do
    resolved="$(readlink -f -- "$link")" || fail ARTIFACT_BROKEN_LINK
    [[ "$resolved" == "$root"/* ]] || fail ARTIFACT_LINK_ESCAPES_RELEASE
  done < <(find "$root" -type l -print0)
}

validate_release_tree() {
  local root="$1"
  local required
  for required in \
    "$root/server/dist" \
    "$root/server/dist/db/migrations" \
    "$root/server/node_modules" \
    "$root/web/dist" \
    "$root/ops/scripts" \
    "$root/ops/systemd"; do
    assert_release_dir "$required" || fail RELEASE_TREE_INVALID
  done
  for required in \
    "$root/server/package.json" \
    "$root/server/package-lock.json" \
    "$root/server/dist/db/migrate.js" \
    "$root/server/dist/db/schema-check.js" \
    "$root/ops/scripts/backup-postgres.sh" \
    "$root/ops/scripts/migration-state.mjs" \
    "$root/ops/scripts/migration-reconciliation.mjs" \
    "$root/ops/scripts/deploy-production-host.sh" \
    "$root/ops/scripts/predeploy-backup-launcher.sh" \
    "$root/ops/systemd/servora-med-predeploy-backup@.service"; do
    assert_release_file "$required" || fail RELEASE_TREE_INVALID
  done
  [[ -x "$root/ops/scripts/backup-postgres.sh" ]] || fail RELEASE_TREE_INVALID
  validate_extracted_links "$root"
}

assert_candidate_backup_contract() {
  local release="$1"
  [[ "$(sha256sum "$release/ops/scripts/predeploy-backup-launcher.sh" | awk '{print $1}')" == "$EXPECTED_LAUNCHER_SHA256" ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
  [[ "$(sha256sum "$release/ops/systemd/servora-med-predeploy-backup@.service" | awk '{print $1}')" == "$EXPECTED_UNIT_SHA256" ]] \
    || fail PREDEPLOY_HOST_CONTRACT_DRIFT
}

assert_candidate_host_helper_contract() {
  local release="$1"
  local installed_sha candidate_sha
  installed_sha="$(sha256sum -- "$0" | awk '{print $1}')"
  candidate_sha="$(sha256sum -- "$release/ops/scripts/deploy-production-host.sh" | awk '{print $1}')"
  [[ "$installed_sha" == "$candidate_sha" ]] || fail HOST_HELPER_SOURCE_DRIFT
}

set_release_permissions() {
  local release="$1"
  chown -R root:servora-med "$release" || fail HOST_BOOTSTRAP_REQUIRED_servora_med_group
  chmod -R o-rwx "$release"
  chmod -R g-w "$release"
  chmod -R g+rX "$release"
  find "$release/ops/scripts" -type f -exec chmod g+rx {} +
}

release_content_manifest() {
  local root="$1"
  local type path
  (
    cd -- "$root"
    find . -mindepth 1 \
      ! -name '.servora-release-artifact.sha256' \
      ! -name '.servora-release-content.sha256' \
      -printf '%y %p\n' |
      LC_ALL=C sort |
      while IFS=' ' read -r type path; do
        case "$type" in
          f) printf 'f %s %s\n' "$path" "$(sha256sum -- "$path" | awk '{print $1}')" ;;
          l) printf 'l %s %s\n' "$path" "$(readlink -- "$path")" ;;
          d) printf 'd %s\n' "$path" ;;
          *) return 1 ;;
        esac
      done
  )
}

apply_caddy_acl() {
  local release="$1"
  id caddy >/dev/null 2>&1 || fail HOST_BOOTSTRAP_REQUIRED_caddy
  setfacl -m u:caddy:--x /opt/servora-med
  setfacl -m u:caddy:--x "$RELEASE_ROOT"
  setfacl -m u:caddy:--x "$release"
  setfacl -m u:caddy:--x "$release/web"
  find "$release/web/dist" -type d -exec setfacl -m u:caddy:r-x {} +
  find "$release/web/dist" -type f -exec setfacl -m u:caddy:r-- {} +
  sudo -u caddy test -x /opt/servora-med
  sudo -u caddy test -x "$RELEASE_ROOT"
  sudo -u caddy test -r "$release/web/dist/index.html"
  sudo -u caddy test ! -r "$APP_ENV_FILE"
  sudo -u caddy test ! -r "$release/server/dist/index.js"
  sudo -u caddy test ! -w "$release/web/dist/index.html"
  sudo -u caddy test ! -w "$release/web/dist"
  getfacl -p "$release/web/dist/index.html" >/dev/null 2>&1 || fail CADDY_ACL_VERIFICATION_FAILED
}

stage_release() {
  local release="$RELEASE_ROOT/$SHA"
  if [[ -e "$release" || -L "$release" ]]; then
    assert_release_dir "$release" || fail IMMUTABLE_RELEASE_COLLISION
    local marker="${release}/.servora-release-artifact.sha256"
    local content_marker="${release}/.servora-release-content.sha256"
    [[ -f "$marker" && ! -L "$marker" ]] || fail IMMUTABLE_RELEASE_COLLISION
    [[ "$(stat -c '%U:%G:%a' "$marker")" == 'root:root:600' ]] || fail IMMUTABLE_RELEASE_COLLISION
    [[ "$(tr -d '[:space:]' <"$marker")" == "$ARTIFACT_SHA" ]] || fail IMMUTABLE_RELEASE_COLLISION
    [[ -f "$content_marker" && ! -L "$content_marker" ]] || fail IMMUTABLE_RELEASE_COLLISION
    [[ "$(stat -c '%U:%G:%a' "$content_marker")" == 'root:root:600' ]] || fail IMMUTABLE_RELEASE_COLLISION
    validate_release_tree "$release"
    assert_candidate_backup_contract "$release"
    assert_candidate_host_helper_contract "$release"

    local verification_dir expected_manifest existing_manifest
    verification_dir="$(mktemp -d "${RELEASE_ROOT}/.verify-${SHA}.XXXXXX")"
    STAGING_DIR="$verification_dir"
    tar --extract --gzip --file "$ARTIFACT" --directory "$verification_dir" \
      --no-same-owner --no-same-permissions --no-overwrite-dir
    validate_release_tree "$verification_dir"
    set_release_permissions "$verification_dir"
    expected_manifest="$(mktemp)"
    existing_manifest="$(mktemp)"
    TEMP_FILES+=("$expected_manifest" "$existing_manifest")
    release_content_manifest "$verification_dir" >"$expected_manifest" \
      || fail IMMUTABLE_RELEASE_COLLISION
    release_content_manifest "$release" >"$existing_manifest" \
      || fail IMMUTABLE_RELEASE_COLLISION
    cmp -s "$expected_manifest" "$existing_manifest" || fail IMMUTABLE_RELEASE_COLLISION
    cmp -s <(sed '/^[[:space:]]*$/d' "$content_marker") "$existing_manifest" \
      || fail IMMUTABLE_RELEASE_COLLISION
    apply_caddy_acl "$release"
    echo "RELEASE_STAGE=EXISTING_BYTE_IDENTICAL"
    return 0
  fi

  STAGING_DIR="$(mktemp -d "${RELEASE_ROOT}/.staging-${SHA}.XXXXXX")"
  tar --extract --gzip --file "$ARTIFACT" --directory "$STAGING_DIR" \
    --no-same-owner --no-same-permissions --no-overwrite-dir
  validate_release_tree "$STAGING_DIR"
  assert_candidate_backup_contract "$STAGING_DIR"
  assert_candidate_host_helper_contract "$STAGING_DIR"
  printf '%s\n' "$ARTIFACT_SHA" >"${STAGING_DIR}/.servora-release-artifact.sha256"
  set_release_permissions "$STAGING_DIR"
  release_content_manifest "$STAGING_DIR" >"${STAGING_DIR}/.servora-release-content.sha256" \
    || fail RELEASE_CONTENT_MANIFEST_FAILED
  chown root:root "${STAGING_DIR}/.servora-release-artifact.sha256" "${STAGING_DIR}/.servora-release-content.sha256"
  chmod 600 "${STAGING_DIR}/.servora-release-artifact.sha256" "${STAGING_DIR}/.servora-release-content.sha256"
  mv -- "$STAGING_DIR" "$release"
  STAGING_DIR=""
  apply_caddy_acl "$release"
  echo "RELEASE_STAGE=NEW"
}

run_release_node() {
  shift
  # Run release code with the same unprivileged identity as the application.
  # The protected environment is read by that identity, so an operator-supplied
  # archive can never turn the root helper into a root Node execution primitive.
  sudo -u "$SERVICE_USER" -- /bin/bash -c '
    set -Eeuo pipefail
    set -a
    # shellcheck disable=SC1090
    source "$1"
    set +a
    export NODE_ENV=production
    export PATH="$2"
    shift 2
    exec "$@"
  ' -- "$APP_ENV_FILE" "$SAFE_PATH" "$NODE_BIN" "$@"
}

STATE_CATALOG_COUNT=""
STATE_CATALOG_HEAD=""
STATE_APPLIED_HEAD=""
STATE_APPLIED_COUNT=""
STATE_PENDING_VERSIONS=""
STATE_PENDING_COUNT=""
STATE_UNEXPECTED_VERSIONS=""
STATE_UNEXPECTED_COUNT=""
STATE_MIGRATION_STATUS=""
STATE_MIGRATION_REASON=""
STATE_DUPLICATE_VERSIONS=""
STATE_EXACT_CATALOG=""
STATE_ORGANIZATIONS=""
STATE_ADMINS=""
STATE_STAFF=""
STATE_CUSTOMERS=""
STATE_PRODUCTS=""
STATE_JOBS=""
STATE_DEMO_DATA=""

BEFORE_ORGANIZATIONS=""
BEFORE_ADMINS=""
BEFORE_STAFF=""
BEFORE_CUSTOMERS=""
BEFORE_PRODUCTS=""
BEFORE_JOBS=""
BEFORE_DEMO_DATA=""
BEFORE_MIGRATION_HEAD=""
BEFORE_PENDING_VERSIONS=""
BEFORE_PENDING_COUNT=""

read_migration_state() {
  local release="$1"
  local output key value
  output="$(run_release_node "$release" "$release/ops/scripts/migration-state.mjs" "$release")" \
    || fail MIGRATION_STATE_READ_FAILED
  STATE_CATALOG_COUNT=""
  STATE_CATALOG_HEAD=""
  STATE_APPLIED_HEAD=""
  STATE_APPLIED_COUNT=""
  STATE_PENDING_VERSIONS=""
  STATE_PENDING_COUNT=""
  STATE_UNEXPECTED_VERSIONS=""
  STATE_UNEXPECTED_COUNT=""
  STATE_MIGRATION_STATUS=""
  STATE_MIGRATION_REASON=""
  STATE_DUPLICATE_VERSIONS=""
  STATE_EXACT_CATALOG=""
  STATE_ORGANIZATIONS=""
  STATE_ADMINS=""
  STATE_STAFF=""
  STATE_CUSTOMERS=""
  STATE_PRODUCTS=""
  STATE_JOBS=""
  STATE_DEMO_DATA=""
  while IFS='=' read -r key value; do
    case "$key" in
      catalog_count) STATE_CATALOG_COUNT="$value" ;;
      catalog_head) STATE_CATALOG_HEAD="$value" ;;
      applied_head) STATE_APPLIED_HEAD="$value" ;;
      applied_count) STATE_APPLIED_COUNT="$value" ;;
      pending_versions) STATE_PENDING_VERSIONS="$value" ;;
      pending_count) STATE_PENDING_COUNT="$value" ;;
      unexpected_versions) STATE_UNEXPECTED_VERSIONS="$value" ;;
      unexpected_count) STATE_UNEXPECTED_COUNT="$value" ;;
      migration_status) STATE_MIGRATION_STATUS="$value" ;;
      migration_reason) STATE_MIGRATION_REASON="$value" ;;
      duplicate_versions) STATE_DUPLICATE_VERSIONS="$value" ;;
      exact_catalog) STATE_EXACT_CATALOG="$value" ;;
      organizations) STATE_ORGANIZATIONS="$value" ;;
      admins) STATE_ADMINS="$value" ;;
      staff) STATE_STAFF="$value" ;;
      customers) STATE_CUSTOMERS="$value" ;;
      products) STATE_PRODUCTS="$value" ;;
      jobs) STATE_JOBS="$value" ;;
      demo_data) STATE_DEMO_DATA="$value" ;;
    esac
  done <<<"$output"
  [[ "$STATE_CATALOG_COUNT" =~ ^[0-9]+$ && "$STATE_APPLIED_COUNT" =~ ^[0-9]+$ ]] \
    || fail MIGRATION_STATE_INVALID
  [[ "$STATE_PENDING_COUNT" =~ ^[0-9]+$ && "$STATE_UNEXPECTED_COUNT" =~ ^[0-9]+$ ]] \
    || fail MIGRATION_STATE_INVALID
  [[ -n "$STATE_CATALOG_HEAD" && -n "$STATE_EXACT_CATALOG" ]] || fail MIGRATION_STATE_INVALID
  [[ "$STATE_MIGRATION_STATUS" =~ ^(EXACT|PREFIX_WITH_PENDING|DIVERGENT|DATABASE_AHEAD|DUPLICATE_HISTORY|INVALID_CATALOG)$ ]] \
    || fail MIGRATION_STATE_INVALID
  for value in "$STATE_ORGANIZATIONS" "$STATE_ADMINS" "$STATE_STAFF" "$STATE_CUSTOMERS" \
    "$STATE_PRODUCTS" "$STATE_JOBS" "$STATE_DEMO_DATA"; do
    [[ "$value" =~ ^[0-9]+$ ]] || fail MIGRATION_STATE_INVALID
  done
}

capture_data_invariants() {
  BEFORE_ORGANIZATIONS="$STATE_ORGANIZATIONS"
  BEFORE_ADMINS="$STATE_ADMINS"
  BEFORE_STAFF="$STATE_STAFF"
  BEFORE_CUSTOMERS="$STATE_CUSTOMERS"
  BEFORE_PRODUCTS="$STATE_PRODUCTS"
  BEFORE_JOBS="$STATE_JOBS"
  BEFORE_DEMO_DATA="$STATE_DEMO_DATA"
  BEFORE_MIGRATION_HEAD="$STATE_APPLIED_HEAD"
  BEFORE_PENDING_VERSIONS="$STATE_PENDING_VERSIONS"
  BEFORE_PENDING_COUNT="$STATE_PENDING_COUNT"
}

assert_data_invariants_unchanged() {
  [[ "$STATE_ORGANIZATIONS" == "$BEFORE_ORGANIZATIONS" \
    && "$STATE_ADMINS" == "$BEFORE_ADMINS" \
    && "$STATE_STAFF" == "$BEFORE_STAFF" \
    && "$STATE_CUSTOMERS" == "$BEFORE_CUSTOMERS" \
    && "$STATE_PRODUCTS" == "$BEFORE_PRODUCTS" \
    && "$STATE_JOBS" == "$BEFORE_JOBS" \
    && "$STATE_DEMO_DATA" == "$BEFORE_DEMO_DATA" ]] \
    || fail BUSINESS_DATA_INVARIANT_CHANGED
}

run_schema_check() {
  local release="$1"
  local error_file
  error_file="$(mktemp)"
  TEMP_FILES+=("$error_file")
  if ! run_release_node "$release" "$release/server/dist/db/schema-check.js" \
    >"$error_file" 2>&1; then
    return 1
  fi
}

verify_backup_artifact() {
  local before_epoch="$1"
  local before_names="${2:-}"
  local candidate candidate_name checksum mode owner_group timestamp backup_dir_mode backup_dir_owner_group
  backup_dir_mode="$(stat -c '%a' "$BACKUP_DIR")"
  backup_dir_owner_group="$(stat -c '%U:%G' "$BACKUP_DIR")"
  [[ "$backup_dir_mode" == 700 && "$backup_dir_owner_group" == 'servora-med:servora-med' ]] \
    || fail BACKUP_DIRECTORY_CONTRACT_INVALID
  candidate="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -printf '%T@ %p\n' \
    | sort -n | tail -n 1 | cut -d' ' -f2- || true)"
  [[ -n "$candidate" && -f "$candidate" ]] || fail BACKUP_ARTIFACT_MISSING
  candidate_name="$(basename -- "$candidate")"
  if [[ -n "$before_names" ]] && grep -Fqx -- "$candidate_name" <<<"$before_names"; then
    fail BACKUP_ARTIFACT_NOT_NEW
  fi
  [[ "$(stat -c '%Y' "$candidate")" -ge "$before_epoch" ]] || fail BACKUP_ARTIFACT_NOT_NEW
  checksum="${candidate}.sha256"
  [[ -f "$checksum" && ! -L "$checksum" ]] || fail BACKUP_CHECKSUM_MISSING
  verify_checksum_sidecar "$candidate" "$checksum" BACKUP_CHECKSUM_INVALID BACKUP_CHECKSUM_FAILED
  command -v pg_restore >/dev/null 2>&1 || fail HOST_BOOTSTRAP_REQUIRED_pg_restore
  pg_restore -l "$candidate" >/dev/null 2>&1 || fail BACKUP_ARCHIVE_INVALID
  mode="$(stat -c '%a' "$candidate")"
  owner_group="$(stat -c '%U:%G' "$candidate")"
  timestamp="$(stat -c '%y' "$candidate")"
  [[ "$mode" == 600 && "$owner_group" == 'servora-med:servora-med' ]] \
    || fail BACKUP_ARTIFACT_CONTRACT_INVALID
  echo "BACKUP_ARTIFACT=$candidate_name"
  echo "BACKUP_ARTIFACT_TIMESTAMP=$timestamp"
  echo "BACKUP_ARTIFACT_OWNER_GROUP=$owner_group"
  echo "BACKUP_ARTIFACT_MODE=$mode"
}

run_predeploy_backup() {
  local backup_unit="servora-med-predeploy-backup@${SHA}.service"
  local backup_start backup_started_at backup_completed_at backup_result backup_exit before_names
  before_names="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -printf '%f\n' | sort || true)"
  backup_start="$(date +%s)"
  backup_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! systemctl start "$backup_unit" >/dev/null 2>&1; then
    fail PREDEPLOY_BACKUP_FAILED
  fi
  backup_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  backup_result="$(systemctl show "$backup_unit" -p Result --value)"
  backup_exit="$(systemctl show "$backup_unit" -p ExecMainStatus --value)"
  [[ "$backup_result" == success && "$backup_exit" == 0 ]] || fail PREDEPLOY_BACKUP_FAILED
  verify_backup_artifact "$backup_start" "$before_names"
  echo "PREDEPLOY_BACKUP_UNIT=$backup_unit"
  echo "PREDEPLOY_BACKUP_STARTED_AT=$backup_started_at"
  echo "PREDEPLOY_BACKUP_COMPLETED_AT=$backup_completed_at"
  echo "PREDEPLOY_BACKUP_RESULT=$backup_result"
  echo "PREDEPLOY_BACKUP_EXIT=$backup_exit"
  echo "PREDEPLOY_BACKUP=PASS"
}

write_state() {
  local release="$1"
  local postdeploy_status="$2"
  mkdir -p "$STATE_DIR"
  chown root:root "$STATE_DIR"
  chmod 750 "$STATE_DIR"
  STATE_FILE="${STATE_DIR}/${SHA}.state"
  local temporary
  temporary="$(mktemp "${STATE_DIR}/.${SHA}.state.XXXXXX")"
  TEMP_FILES+=("$temporary")
  cat >"$temporary" <<EOF
sha=${SHA}
old_release=${OLD_RELEASE}
new_release=${release}
migrations_applied=${MIGRATIONS_APPLIED}
postdeploy=${postdeploy_status}
EOF
  chown root:root "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$STATE_FILE"
}

read_state() {
  STATE_FILE="${STATE_DIR}/${SHA}.state"
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail DEPLOYMENT_STATE_MISSING
  [[ "$(stat -c '%U:%G:%a' "$STATE_FILE")" == 'root:root:600' ]] || fail DEPLOYMENT_STATE_INVALID
  # State is written by this root-owned helper and contains no secrets.
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  [[ "${sha:-}" == "$SHA" ]] || fail DEPLOYMENT_STATE_INVALID
  [[ "${new_release:-}" == "$RELEASE_ROOT/$SHA" ]] || fail DEPLOYMENT_STATE_INVALID
  [[ "${migrations_applied:-}" =~ ^[0-9]+$ ]] || fail DEPLOYMENT_STATE_INVALID
  MIGRATIONS_APPLIED="$migrations_applied"
  OLD_RELEASE="${old_release:-}"
}

atomic_switch() {
  local release="$1"
  local temporary="${CURRENT_LINK}.new.$$"
  rm -f -- "$temporary"
  ln -s -- "$release" "$temporary"
  mv -Tf -- "$temporary" "$CURRENT_LINK"
  CURRENT_SWITCHED=true
}

restart_candidate_or_fail() {
  systemctl start "$SERVICE" >/dev/null 2>&1 || return 1
  SERVICE_STOPPED=false
}

rollback_internal() {
  [[ -n "$OLD_RELEASE" ]] || fail ROLLBACK_TARGET_MISSING
  assert_release_dir "$OLD_RELEASE" || fail ROLLBACK_TARGET_INVALID
  atomic_switch "$OLD_RELEASE"
  systemctl restart "$SERVICE" >/dev/null 2>&1 || fail ROLLBACK_SERVICE_RESTART_FAILED
  SERVICE_STOPPED=false
  CURRENT_SWITCHED=false
  health_gate || fail ROLLBACK_HEALTH_FAILED
  echo "ROLLBACK=PASS"
}

deploy_phase() {
  PHASE=SOURCE
  require_commands
  validate_sha
  validate_fqdn
  validate_artifact
  assert_env_contract
  assert_host_backup_contract
  assert_release_dir "$RELEASE_ROOT" || fail RELEASE_ROOT_INVALID

  PHASE=PREFLIGHT
  OLD_RELEASE="$(current_release)"
  assert_service_and_health

  PHASE=PACKAGE
  verify_archive_entries
  verify_artifact_checksum
  stage_release
  local release="$RELEASE_ROOT/$SHA"
  validate_release_tree "$release"
  assert_candidate_backup_contract "$release"

  PHASE=BACKUP
  run_predeploy_backup

  PHASE=MIGRATION
  read_migration_state "$release"
  local before_applied="$STATE_APPLIED_COUNT"
  capture_data_invariants
  case "$STATE_MIGRATION_STATUS" in
    EXACT)
      ;;
    PREFIX_WITH_PENDING)
      [[ "$ALLOW_MIGRATIONS" == true ]] || fail PENDING_MIGRATIONS_REQUIRE_EXPLICIT_AUTHORIZATION
      ;;
    DIVERGENT|DATABASE_AHEAD|DUPLICATE_HISTORY|INVALID_CATALOG)
      fail MIGRATION_HISTORY_DIVERGED
      ;;
    *)
      fail MIGRATION_STATE_INVALID
      ;;
  esac
  systemctl stop "$SERVICE" >/dev/null 2>&1
  SERVICE_STOPPED=true
  local migration_log
  migration_log="$(mktemp)"
  TEMP_FILES+=("$migration_log")
  if ! run_release_node "$release" "$release/server/dist/db/migrate.js" \
    >"$migration_log" 2>&1; then
    if read_migration_state "$release"; then
      MIGRATIONS_APPLIED=$((STATE_APPLIED_COUNT - before_applied))
    else
      MIGRATIONS_APPLIED=1
    fi
    if [[ "$MIGRATIONS_APPLIED" -eq 0 ]]; then
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
      SERVICE_STOPPED=false
    fi
    fail MIGRATION_FAILED
  fi
  # A failed post-run state read leaves migration outcome unknown. Keep the
  # service stopped in that case instead of pretending a zero-migration
  # rollback is safe; the successful read below replaces this sentinel.
  MIGRATIONS_APPLIED=1
  read_migration_state "$release"
  MIGRATIONS_APPLIED=$((STATE_APPLIED_COUNT - before_applied))
  assert_data_invariants_unchanged
  [[ "$MIGRATIONS_APPLIED" -ge 0 ]] || fail MIGRATION_STATE_REGRESSED
  [[ "$STATE_PENDING_COUNT" == 0 && "$STATE_UNEXPECTED_COUNT" == 0 \
    && -z "$STATE_PENDING_VERSIONS" && -z "$STATE_UNEXPECTED_VERSIONS" ]] \
    || fail MIGRATION_RESULT_INCOMPATIBLE
  [[ "$STATE_EXACT_CATALOG" == true && "$STATE_MIGRATION_STATUS" == EXACT ]] \
    || fail MIGRATION_HISTORY_DIVERGED
  if ! run_schema_check "$release"; then
    if [[ "$MIGRATIONS_APPLIED" -eq 0 ]]; then
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
      SERVICE_STOPPED=false
    fi
    fail SCHEMA_CHECK_FAILED
  fi
  echo "SCHEMA_CHECK=PASS"
  echo "MIGRATION_CATALOG_COUNT=$STATE_CATALOG_COUNT"
  echo "MIGRATION_CATALOG_HEAD=$STATE_CATALOG_HEAD"
  echo "MIGRATION_BEFORE_COUNT=$before_applied"
  echo "MIGRATION_BEFORE_HEAD=$BEFORE_MIGRATION_HEAD"
  echo "MIGRATION_PENDING_BEFORE=$BEFORE_PENDING_VERSIONS"
  echo "MIGRATION_PENDING_BEFORE_COUNT=$BEFORE_PENDING_COUNT"
  echo "MIGRATION_AFTER_COUNT=$STATE_APPLIED_COUNT"
  echo "MIGRATION_AFTER_HEAD=$STATE_APPLIED_HEAD"
  echo "MIGRATION_PENDING_AFTER=$STATE_PENDING_VERSIONS"
  echo "MIGRATION_PENDING_AFTER_COUNT=$STATE_PENDING_COUNT"
  echo "MIGRATION_STATUS=$STATE_MIGRATION_STATUS"
  echo "MIGRATION_REASON=$STATE_MIGRATION_REASON"
  echo "MIGRATION_DUPLICATE_VERSIONS=$STATE_DUPLICATE_VERSIONS"
  echo "MIGRATIONS_APPLIED=${MIGRATIONS_APPLIED}"
  echo "PRE_MIGRATION_ORGANIZATIONS=$BEFORE_ORGANIZATIONS"
  echo "PRE_MIGRATION_ADMINS=$BEFORE_ADMINS"
  echo "PRE_MIGRATION_STAFF=$BEFORE_STAFF"
  echo "PRE_MIGRATION_CUSTOMERS=$BEFORE_CUSTOMERS"
  echo "PRE_MIGRATION_PRODUCTS=$BEFORE_PRODUCTS"
  echo "PRE_MIGRATION_JOBS=$BEFORE_JOBS"
  echo "PRE_MIGRATION_DEMO_DATA=$BEFORE_DEMO_DATA"
  echo "POST_MIGRATION_ORGANIZATIONS=$STATE_ORGANIZATIONS"
  echo "POST_MIGRATION_ADMINS=$STATE_ADMINS"
  echo "POST_MIGRATION_STAFF=$STATE_STAFF"
  echo "POST_MIGRATION_CUSTOMERS=$STATE_CUSTOMERS"
  echo "POST_MIGRATION_PRODUCTS=$STATE_PRODUCTS"
  echo "POST_MIGRATION_JOBS=$STATE_JOBS"
  echo "POST_MIGRATION_DEMO_DATA=$STATE_DEMO_DATA"

  PHASE=ACTIVATION
  write_state "$release" not_run
  atomic_switch "$release"
  if ! restart_candidate_or_fail; then
    if [[ "$MIGRATIONS_APPLIED" -eq 0 ]]; then
      rollback_internal
    else
      fail ACTIVATION_SERVICE_START_FAILED_MANUAL_ROLLBACK_REQUIRED
    fi
  fi
  if ! health_gate; then
    if [[ "$MIGRATIONS_APPLIED" -eq 0 ]]; then
      rollback_internal
    else
      fail HEALTH_FAILED_MANUAL_ROLLBACK_REQUIRED
    fi
    fail HEALTH_FAILED
  fi
  echo "HEALTH=PASS"
  echo "ACTIVATION=PASS"
  echo "OLD_RELEASE=${OLD_RELEASE}"
  echo "NEW_RELEASE=${release}"
  echo "READY_FOR_BROWSER_SMOKE=YES"
}

postdeploy_phase() {
  PHASE=POSTDEPLOY_BACKUP
  require_commands
  validate_sha
  validate_fqdn
  assert_env_contract
  read_state
  local release="$RELEASE_ROOT/$SHA"
  [[ "$(current_release)" == "$release" ]] || fail CURRENT_RELEASE_NOT_CANDIDATE
  systemctl is-active --quiet "$SERVICE" || fail CURRENT_SERVICE_NOT_ACTIVE
  health_gate || fail HEALTH_FAILED
  local backup_unit="servora-med-backup.service"
  local backup_start backup_started_at backup_completed_at backup_result backup_exit before_names
  before_names="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'servora-med-*.dump' -printf '%f\n' | sort || true)"
  backup_start="$(date +%s)"
  backup_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! systemctl start "$backup_unit" >/dev/null 2>&1; then
    echo "LIVE_BUT_POSTDEPLOY_BACKUP_FAILED sha=${SHA}" >&2
    exit 2
  fi
  backup_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  backup_result="$(systemctl show "$backup_unit" -p Result --value)"
  backup_exit="$(systemctl show "$backup_unit" -p ExecMainStatus --value)"
  [[ "$backup_result" == success && "$backup_exit" == 0 ]] \
    || { echo "LIVE_BUT_POSTDEPLOY_BACKUP_FAILED sha=${SHA}" >&2; exit 2; }
  local verification_output
  if ! verification_output="$(verify_backup_artifact "$backup_start" "$before_names" 2>&1)"; then
    echo "LIVE_BUT_POSTDEPLOY_BACKUP_FAILED sha=${SHA}" >&2
    printf '%s\n' "$verification_output" >&2
    exit 2
  fi
  printf '%s\n' "$verification_output"
  write_state "$release" success
  echo "POSTDEPLOY_BACKUP_UNIT=$backup_unit"
  echo "POSTDEPLOY_BACKUP_STARTED_AT=$backup_started_at"
  echo "POSTDEPLOY_BACKUP_COMPLETED_AT=$backup_completed_at"
  echo "POSTDEPLOY_BACKUP_RESULT=$backup_result"
  echo "POSTDEPLOY_BACKUP_EXIT=$backup_exit"
  echo "POSTDEPLOY_BACKUP=PASS"
  echo "DEPLOYMENT=COMPLETE"
}

rollback_phase() {
  PHASE=ROLLBACK
  require_commands
  validate_sha
  validate_fqdn
  read_state
  if [[ "$MIGRATIONS_APPLIED" -ne 0 ]]; then
    fail MIGRATION_APPLIED_MANUAL_ROLLBACK_REQUIRED
  fi
  local release="$RELEASE_ROOT/$SHA"
  [[ "$(current_release)" == "$release" ]] || {
    echo "ROLLBACK=NOT_REQUIRED"
    exit 0
  }
  rollback_internal
  write_state "$release" rolled_back
  echo "ROLLBACK=COMPLETE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --artifact-sha) ARTIFACT_SHA="${2:-}"; shift 2 ;;
    --fqdn) FQDN="${2:-}"; shift 2 ;;
    --allow-migrations) ALLOW_MIGRATIONS=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; fail UNKNOWN_ARGUMENT ;;
  esac
done

case "$PHASE" in
  deploy)
    [[ -n "$SHA" && -n "$ARTIFACT" && -n "$ARTIFACT_SHA" && -n "$FQDN" ]] || { usage; fail MISSING_ARGUMENT; }
    deploy_phase
    ;;
  postdeploy)
    [[ -n "$SHA" && -n "$FQDN" ]] || { usage; fail MISSING_ARGUMENT; }
    postdeploy_phase
    ;;
  rollback)
    [[ -n "$SHA" && -n "$FQDN" ]] || { usage; fail MISSING_ARGUMENT; }
    rollback_phase
    ;;
  *) usage; fail INVALID_PHASE ;;
esac
fi
