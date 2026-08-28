#!/usr/bin/env bash
# Controlled Servora-Med production deployment entrypoint.
#
# The runner builds an exact main SHA, packages only the immutable release
# payload, transfers it over strict-host-key-checked SSH, and delegates
# privileged host work to the fixed-purpose host helper. A merge to main never
# invokes this script automatically; the GitHub workflow is workflow_dispatch.
set -Eeuo pipefail
umask 077

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly HOST_HELPER="/usr/local/libexec/servora-med/deploy-production-host"
readonly DEFAULT_SSH_USER="servora-deploy"

PHASE="SOURCE"
SHA=""
FQDN="${SERVORA_PROD_FQDN:-}"
PROD_HOST="${SERVORA_PROD_HOST:-}"
SSH_USER="${SERVORA_PROD_SSH_USER:-$DEFAULT_SSH_USER}"
SSH_KEY="${SERVORA_PROD_SSH_KEY:-}"
KNOWN_HOSTS="${SERVORA_PROD_KNOWN_HOSTS:-}"
ALLOW_MIGRATIONS=false
CHECK_ONLY=false
ARTIFACT_INPUT=""
ARTIFACT=""
ARTIFACT_SHA=""
WORK_DIR=""
SSH_DIR=""
KEY_FILE=""
KNOWN_HOSTS_FILE=""
LOCAL_TEMP_FILES=()
REMOTE_ARTIFACT=""
REMOTE_CHECKSUM=""
REMOTE_CHECKSUM_FILE=""
SSH_READY=false
MIGRATIONS_APPLIED=0
OLD_RELEASE="UNKNOWN"
NEW_RELEASE="UNKNOWN"
CI_RUN_ID="UNKNOWN"
CI_STATUS="FAIL"
BUILD_STATUS="FAIL"
TRANSFER_STATUS="FAIL"
DEPLOY_STATUS="FAIL"
BROWSER_STATUS="NOT_RUN"
POSTDEPLOY_STATUS="NOT_RUN"
ROLLBACK_STATUS="NOT_REQUIRED"
PREDEPLOY_BACKUP_STATUS="NOT_RUN"
ACTIVATION_STATUS="NOT_RUN"
HEALTH_STATUS="NOT_RUN"

usage() {
  cat >&2 <<'EOF'
Usage:
  ops/deploy-production.sh --sha <40-character-main-sha> [--allow-migrations]
  ops/deploy-production.sh --check

Environment (GitHub production environment secrets/variables):
  SERVORA_PROD_HOST
  SERVORA_PROD_SSH_USER (default: servora-deploy)
  SERVORA_PROD_SSH_KEY
  SERVORA_PROD_KNOWN_HOSTS
  SERVORA_PROD_FQDN

For a prebuilt, exact-SHA artifact, set --artifact PATH. The artifact must
have a sibling SHA-256 sidecar and must contain only the release payload.
EOF
}

fail() {
  local reason="$1"
  echo "PRODUCTION_DEPLOYMENT_FAILED phase=${PHASE} sha=${SHA:-UNKNOWN} reason=${reason}" >&2
  exit 1
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail SHA256_TOOL_MISSING
  fi
}

cleanup_remote() {
  if [[ "$SSH_READY" != true || -z "$REMOTE_ARTIFACT" ]]; then
    return 0
  fi
  set +e
  ssh_run rm -f -- "$REMOTE_ARTIFACT" "${REMOTE_CHECKSUM:-}" >/dev/null 2>&1 || true
  set -e
}

cleanup_local() {
  set +e
  cleanup_remote
  local file
  if [[ "${#LOCAL_TEMP_FILES[@]}" -gt 0 ]]; then
    for file in "${LOCAL_TEMP_FILES[@]}"; do
      rm -f -- "$file"
    done
  fi
  [[ -z "$SSH_DIR" ]] || rm -rf -- "$SSH_DIR"
  [[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  set -e
}

write_summary() {
  local exit_code="$1"
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  set +e
  {
    echo '## Production Deployment'
    echo
    echo "- Result: $([[ "$exit_code" -eq 0 ]] && echo PASS || echo FAIL)"
    echo "- SHA: ${SHA:-UNKNOWN}"
    echo "- Previous release: ${OLD_RELEASE}"
    echo "- New release: ${NEW_RELEASE}"
    echo "- Exact-main CI: ${CI_STATUS} (${CI_RUN_ID})"
    echo "- Build/package: ${BUILD_STATUS}"
    echo "- Transfer: ${TRANSFER_STATUS}"
    echo "- Deployment gates: ${DEPLOY_STATUS}"
    echo "- Predeploy backup: ${PREDEPLOY_BACKUP_STATUS}"
    echo "- Migrations applied: ${MIGRATIONS_APPLIED}"
    echo "- Activation: ${ACTIVATION_STATUS}"
    echo "- Health: ${HEALTH_STATUS}"
    echo "- Browser smoke: ${BROWSER_STATUS}"
    echo "- Postdeploy backup: ${POSTDEPLOY_STATUS}"
    echo "- Rollback: ${ROLLBACK_STATUS}"
    echo
    echo 'No business-data import, seed, bootstrap, or database restore was invoked.'
  } >>"$GITHUB_STEP_SUMMARY"
  set -e
}

on_exit() {
  local code=$?
  set +e
  write_summary "$code"
  cleanup_local
  exit "$code"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap on_exit EXIT
fi

validate_sha() {
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_SHA
}

validate_fqdn() {
  [[ "$FQDN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail INVALID_FQDN
}

validate_host_identity() {
  [[ "$PROD_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail INVALID_PRODUCTION_HOST
  [[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || fail INVALID_SSH_USER
  [[ -n "$SSH_KEY" && -n "$KNOWN_HOSTS" ]] || fail SSH_SECRETS_MISSING
}

check_commands() {
  local command_name
  for command_name in bash git node npm tar ssh scp curl gh jq awk sed grep rm mktemp basename dirname od tr; do
    command -v "$command_name" >/dev/null 2>&1 || fail "REQUIRED_COMMAND_MISSING_${command_name}"
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail SHA256_TOOL_MISSING
  fi
}

check_only() {
  PHASE=CHECK
  check_commands
  if [[ -n "$SHA" ]]; then
    validate_sha
  fi
  if [[ -n "$ARTIFACT_INPUT" ]]; then
    ARTIFACT="$ARTIFACT_INPUT"
    [[ -n "$SHA" ]] || fail SHA_REQUIRED_FOR_ARTIFACT_CHECK
    [[ "$ARTIFACT" == /* && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || fail INVALID_ARTIFACT
    [[ "$(basename -- "$ARTIFACT")" == *"${SHA}"*.tar.gz ]] || fail ARTIFACT_SHA_NAME_MISMATCH
    [[ -f "${ARTIFACT}.sha256" ]] || fail ARTIFACT_CHECKSUM_SIDECAR_MISSING
    verify_artifact_sidecar
    verify_archive_entries
  fi
  bash -n "$REPO_ROOT/ops/deploy-production.sh"
  bash -n "$REPO_ROOT/ops/scripts/deploy-production-host.sh"
  node --check "$REPO_ROOT/ops/scripts/migration-state.mjs"
  node --check "$REPO_ROOT/ops/scripts/migration-reconciliation.mjs"
  node --check "$REPO_ROOT/web/scripts/production-browser-smoke.mjs"
  [[ -f "$REPO_ROOT/.github/workflows/deploy-production.yml" ]] || fail WORKFLOW_MISSING
  [[ -f "$REPO_ROOT/docs/operations/production-deployment.md" ]] || fail DEPLOYMENT_DOC_MISSING
  echo "DEPLOY_CHECK=PASS"
}

verify_source() {
  PHASE=SOURCE
  validate_sha
  local local_sha remote_sha branch
  local_sha="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)" || fail LOCAL_HEAD_UNAVAILABLE
  [[ "$local_sha" == "$SHA" ]] || fail LOCAL_HEAD_MISMATCH

  branch="$(git -C "$REPO_ROOT" symbolic-ref --short -q HEAD || true)"
  if [[ -n "${GITHUB_REF:-}" ]]; then
    [[ "$GITHUB_REF" == refs/heads/main ]] || fail NON_MAIN_WORKFLOW_REF
  fi
  [[ -z "$branch" || "$branch" == main ]] || fail NON_MAIN_BRANCH

  git -C "$REPO_ROOT" diff --quiet HEAD -- || fail TRACKED_WORKTREE_DIRTY
  git -C "$REPO_ROOT" diff --cached --quiet || fail STAGED_WORKTREE_DIRTY
  local -a build_inputs=(
    server/src
    server/scripts
    server/package.json
    server/package-lock.json
    server/tsconfig.json
    web/src
    web/scripts
    web/public
    web/index.html
    web/package.json
    web/package-lock.json
    web/tsconfig.json
    web/tsconfig.node.json
    web/vite.config.ts
    ops
  )
  local untracked_build_inputs
  # Do not pass --exclude-standard: ignored files under build inputs are still
  # untracked and can influence an artifact, so they must fail closed too.
  untracked_build_inputs="$(git -C "$REPO_ROOT" ls-files --others -- "${build_inputs[@]}")" \
    || fail SOURCE_TREE_SCAN_FAILED
  [[ -z "$untracked_build_inputs" ]] || fail SOURCE_TREE_NOT_EXACT
  remote_sha="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/main | awk 'NR == 1 {print $1}')" \
    || fail REMOTE_MAIN_LOOKUP_FAILED
  [[ "$remote_sha" == "$SHA" ]] || fail REMOTE_MAIN_MISMATCH
  [[ "$(git -C "$REPO_ROOT" rev-parse "${SHA}^{commit}")" == "$SHA" ]] || fail COMMIT_NOT_FOUND
}

verify_exact_main_ci() {
  PHASE=CI
  [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] || fail GITHUB_TOKEN_MISSING
  local runs run_id jobs
  runs="$(gh run list \
    --workflow ci.yml \
    --branch main \
    --event push \
    --commit "$SHA" \
    --limit 20 \
    --json databaseId,headSha,status,conclusion,event,headBranch \
    --jq ".[] | select(.headSha == \"${SHA}\" and .status == \"completed\" and .conclusion == \"success\" and .event == \"push\" and .headBranch == \"main\") | .databaseId")" \
    || fail EXACT_MAIN_CI_LOOKUP_FAILED
  run_id="$(printf '%s\n' "$runs" | sed -n '1p')"
  [[ "$run_id" =~ ^[0-9]+$ ]] || fail EXACT_MAIN_CI_NOT_GREEN
  jobs="$(gh run view "$run_id" --json jobs --jq '[.jobs[] | {name, conclusion}]')" \
    || fail EXACT_MAIN_CI_JOBS_LOOKUP_FAILED
  jq -e 'any(.[]; .name == "server" and .conclusion == "success")' >/dev/null <<<"$jobs" \
    || fail EXACT_MAIN_CI_SERVER_NOT_GREEN
  jq -e 'any(.[]; .name == "web" and .conclusion == "success")' >/dev/null <<<"$jobs" \
    || fail EXACT_MAIN_CI_WEB_NOT_GREEN
  CI_RUN_ID="$run_id"
  CI_STATUS=PASS
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
    servora-med-personnel-onboarding-credentials|*/servora-med-personnel-onboarding-credentials|servora-med-personnel-onboarding-credentials.*|*/servora-med-personnel-onboarding-credentials.*|personnel-onboarding-credentials|*/personnel-onboarding-credentials|personnel-onboarding-credentials.*|*/personnel-onboarding-credentials.*)
      return 0
      ;;
    servora-med-personnel-onboarding-manifest|*/servora-med-personnel-onboarding-manifest|servora-med-personnel-onboarding-manifest.*|*/servora-med-personnel-onboarding-manifest.*|personnel-onboarding-manifest|*/personnel-onboarding-manifest|personnel-onboarding-manifest.*|*/personnel-onboarding-manifest.*)
      return 0
      ;;
    servora-med-customer-onboarding-manifest|*/servora-med-customer-onboarding-manifest|servora-med-customer-onboarding-manifest.*|*/servora-med-customer-onboarding-manifest.*|customer-onboarding-manifest|*/customer-onboarding-manifest|customer-onboarding-manifest.*|*/customer-onboarding-manifest.*)
      return 0
      ;;
    *customer-onboarding.json|*customer-onboarding.csv|*customer-onboarding.xlsx|*customer-onboarding.yaml|*customer-onboarding.yml)
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
    *production-mapping|*production-mapping.json|*production-mapping.csv|*production-mapping.xlsx|*production-mapping.yaml|*production-mapping.yml)
      return 0
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
  local mode
  while IFS= read -r mode; do
    case "${mode:0:1}" in
      -|d|l) ;;
      *) fail ARTIFACT_FORBIDDEN_FILE_TYPE ;;
    esac
  done < <(tar -tvzf "$ARTIFACT" | awk '{print $1}')
}

verify_artifact_sidecar() {
  local sidecar="${ARTIFACT}.sha256"
  local line expected filename actual checksum_pattern line_count
  [[ -f "$sidecar" && ! -L "$sidecar" ]] || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  validate_checksum_sidecar_bytes "$sidecar"
  line_count="$(awk 'END { print NR }' "$sidecar")" || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  [[ "$line_count" == 1 ]] || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  line="$(sed -n '1p' "$sidecar")" || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  checksum_pattern='^([0-9a-f]{64})[ ][ ]([^[:space:]]+)$'
  [[ "$line" =~ $checksum_pattern ]] \
    || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  expected="${BASH_REMATCH[1]}"
  filename="${BASH_REMATCH[2]}"
  [[ "$filename" != */* && "$filename" == "$(basename -- "$ARTIFACT")" ]] \
    || fail ARTIFACT_CHECKSUM_SIDECAR_INVALID
  actual="$(sha256_file "$ARTIFACT")"
  [[ "$actual" == "$expected" ]] || fail ARTIFACT_CHECKSUM_SIDECAR_MISMATCH
}

validate_checksum_sidecar_bytes() {
  local byte
  while IFS= read -r byte; do
    case "$byte" in
      0a|2[0-9a-f]|[3-6][0-9a-f]|7[0-9a-e]) ;;
      *) fail ARTIFACT_CHECKSUM_SIDECAR_INVALID ;;
    esac
  done < <(od -An -v -t x1 "$1" | tr -s '[:space:]' '\n' | sed '/^$/d')
}

package_artifact() {
  local output="$1"
  tar --create --gzip --file "$output" \
    --directory "$REPO_ROOT" \
    --exclude='./.git' \
    --exclude='./host.md' \
    --exclude='*/.env' \
    --exclude='*/.env.*' \
    --exclude='*/credentials/*' \
    --exclude='*/passwords/*' \
    --exclude='*/customer-manifests/*' \
    --exclude='*/personnel-manifests/*' \
    --exclude='*/db-dumps/*' \
    --exclude='*/private/tmp/*' \
    --exclude='*/.worktrees/*' \
    --exclude='*/._*' \
    --exclude='*servora-med-shared-temporary-password*' \
    --exclude='*temporary-password*' \
    --exclude='*password' \
    --exclude='*passwords' \
    --exclude='*password.json' \
    --exclude='*password.csv' \
    --exclude='*password.txt' \
    --exclude='*password.yaml' \
    --exclude='*password.yml' \
    --exclude='*password.xlsx' \
    --exclude='*passwords.json' \
    --exclude='*passwords.csv' \
    --exclude='*passwords.txt' \
    --exclude='*passwords.yaml' \
    --exclude='*passwords.yml' \
    --exclude='*passwords.xlsx' \
    --exclude='*password.xls' \
    --exclude='*password.ods' \
    --exclude='*password.tsv' \
    --exclude='*password.toml' \
    --exclude='*password.ini' \
    --exclude='*password.conf' \
    --exclude='*password.xml' \
    --exclude='*passwords.xls' \
    --exclude='*passwords.ods' \
    --exclude='*passwords.tsv' \
    --exclude='*passwords.toml' \
    --exclude='*passwords.ini' \
    --exclude='*passwords.conf' \
    --exclude='*passwords.xml' \
    --exclude='*servora-med-personnel-onboarding-credentials*' \
    --exclude='*personnel-onboarding-credentials*' \
    --exclude='*servora-med-personnel-onboarding-manifest*' \
    --exclude='*personnel-onboarding-manifest*' \
    --exclude='*servora-med-customer-onboarding-manifest*' \
    --exclude='*customer-onboarding-manifest*' \
    --exclude='*customer-onboarding.json' \
    --exclude='*customer-onboarding.csv' \
    --exclude='*customer-onboarding.xlsx' \
    --exclude='*customer-onboarding.yaml' \
    --exclude='*customer-onboarding.yml' \
    --exclude='*credential.json' \
    --exclude='*credential.csv' \
    --exclude='*credential.txt' \
    --exclude='*credential.yaml' \
    --exclude='*credential.yml' \
    --exclude='*credential.xlsx' \
    --exclude='*credentials.json' \
    --exclude='*credentials.csv' \
    --exclude='*credentials.txt' \
    --exclude='*credentials.yaml' \
    --exclude='*credentials.yml' \
    --exclude='*credentials.xlsx' \
    --exclude='*credential' \
    --exclude='*credentials' \
    --exclude='*credential.xls' \
    --exclude='*credential.ods' \
    --exclude='*credential.tsv' \
    --exclude='*credential.toml' \
    --exclude='*credential.ini' \
    --exclude='*credential.conf' \
    --exclude='*credential.xml' \
    --exclude='*credentials.xls' \
    --exclude='*credentials.ods' \
    --exclude='*credentials.tsv' \
    --exclude='*credentials.toml' \
    --exclude='*credentials.ini' \
    --exclude='*credentials.conf' \
    --exclude='*credentials.xml' \
    --exclude='*production-mapping.json' \
    --exclude='*production-mapping.csv' \
    --exclude='*production-mapping.xlsx' \
    --exclude='*production-mapping.yaml' \
    --exclude='*production-mapping.yml' \
    --exclude='*production-mapping*' \
    server/dist \
    server/package.json \
    server/package-lock.json \
    server/node_modules \
    web/dist \
    ops
}

build_artifact() {
  PHASE=BUILD
  local node_major node_version npm_version
  node_version="$(node --version)"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" == 22 ]] || fail "NODE_22_REQUIRED_${node_version}"
  npm_version="$(npm --version)"

  if [[ -n "$ARTIFACT_INPUT" ]]; then
    ARTIFACT="$ARTIFACT_INPUT"
    [[ "$ARTIFACT" == /* && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || fail INVALID_ARTIFACT
    [[ "$(basename -- "$ARTIFACT")" == *"${SHA}"*.tar.gz ]] || fail ARTIFACT_SHA_NAME_MISMATCH
    [[ -f "${ARTIFACT}.sha256" ]] || fail ARTIFACT_CHECKSUM_SIDECAR_MISSING
    ARTIFACT_SHA="$(sha256_file "$ARTIFACT")"
    verify_artifact_sidecar
    verify_archive_entries
    BUILD_STATUS="PREBUILT_VERIFIED node=${node_version} npm=${npm_version}"
    return 0
  fi

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/servora-production-deploy.XXXXXX")"
  (cd "$REPO_ROOT/server" && npm ci)
  (cd "$REPO_ROOT/server" && npm run build)
  (cd "$REPO_ROOT/server" && npm ci --omit=dev)
  (cd "$REPO_ROOT/web" && npm ci)
  (cd "$REPO_ROOT/web" && npm run build)
  (cd "$REPO_ROOT/web" && npm run smoke:production-dist)
  (cd "$REPO_ROOT/web" && npm run smoke:responsive)

  ARTIFACT="$WORK_DIR/servora-med-${SHA}.tar.gz"
  package_artifact "$ARTIFACT"
  verify_archive_entries
  ARTIFACT_SHA="$(sha256_file "$ARTIFACT")"
  printf '%s  %s\n' "$ARTIFACT_SHA" "$(basename -- "$ARTIFACT")" >"${ARTIFACT}.sha256"
  git -C "$REPO_ROOT" diff --quiet HEAD -- || fail BUILD_MUTATED_TRACKED_SOURCE
  git -C "$REPO_ROOT" diff --cached --quiet || fail BUILD_MUTATED_STAGED_SOURCE
  BUILD_STATUS="PASS node=${node_version} npm=${npm_version} tree=$(git -C "$REPO_ROOT" rev-parse "${SHA}^{tree}")"
}

shell_quote() {
  printf '%q' "$1"
}

ssh_run() {
  local arg quoted command_line=""
  for arg in "$@"; do
    quoted="$(shell_quote "$arg")"
    command_line+="${quoted} "
  done
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$PROD_HOST" "$command_line"
}

prepare_ssh() {
  PHASE=TRANSFER
  validate_fqdn
  validate_host_identity
  SSH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/servora-production-ssh.XXXXXX")"
  KEY_FILE="$SSH_DIR/id_deploy"
  KNOWN_HOSTS_FILE="$SSH_DIR/known_hosts"
  printf '%s\n' "$SSH_KEY" >"$KEY_FILE"
  printf '%s\n' "$KNOWN_HOSTS" >"$KNOWN_HOSTS_FILE"
  chmod 600 "$KEY_FILE" "$KNOWN_HOSTS_FILE"
  SSH_OPTS=(-i "$KEY_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS_FILE" -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
  REMOTE_ARTIFACT="/var/tmp/servora-med-${SHA}-$$.tar.gz"
  REMOTE_CHECKSUM="${REMOTE_ARTIFACT}.sha256"
  REMOTE_CHECKSUM_FILE="$(mktemp)"
  LOCAL_TEMP_FILES+=("$REMOTE_CHECKSUM_FILE")
  printf '%s  %s\n' "$ARTIFACT_SHA" "$(basename -- "$REMOTE_ARTIFACT")" >"$REMOTE_CHECKSUM_FILE"
  # Arm failure cleanup before the first transfer so a partially completed
  # scp cannot leave the remote temporary artifact behind.
  SSH_READY=true
  scp "${SSH_OPTS[@]}" -- "$ARTIFACT" "$SSH_USER@$PROD_HOST:$REMOTE_ARTIFACT" \
    || fail ARTIFACT_TRANSFER_FAILED
  scp "${SSH_OPTS[@]}" -- "$REMOTE_CHECKSUM_FILE" "$SSH_USER@$PROD_HOST:$REMOTE_CHECKSUM" \
    || fail ARTIFACT_CHECKSUM_TRANSFER_FAILED
  TRANSFER_STATUS=PASS
}

remote_phase() {
  local output_file="$1"
  shift
  if ! ssh_run "$@" >"$output_file" 2>&1; then
    return 1
  fi
  return 0
}

read_remote_key() {
  local key="$1" file="$2"
  awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$file"
}

deploy_remote() {
  PHASE=DEPLOY
  local output_file
  output_file="$(mktemp)"
  LOCAL_TEMP_FILES+=("$output_file")
  if [[ "$ALLOW_MIGRATIONS" == true ]]; then
    if ! remote_phase "$output_file" sudo -n "$HOST_HELPER" --phase deploy --sha "$SHA" --artifact "$REMOTE_ARTIFACT" --artifact-sha "$ARTIFACT_SHA" --fqdn "$FQDN" --allow-migrations; then
      cat "$output_file" >&2
      fail REMOTE_DEPLOY_FAILED
    fi
  else
    if ! remote_phase "$output_file" sudo -n "$HOST_HELPER" --phase deploy --sha "$SHA" --artifact "$REMOTE_ARTIFACT" --artifact-sha "$ARTIFACT_SHA" --fqdn "$FQDN"; then
      cat "$output_file" >&2
      fail REMOTE_DEPLOY_FAILED
    fi
  fi
  OLD_RELEASE="$(read_remote_key OLD_RELEASE "$output_file")"
  NEW_RELEASE="$(read_remote_key NEW_RELEASE "$output_file")"
  MIGRATIONS_APPLIED="$(read_remote_key MIGRATIONS_APPLIED "$output_file")"
  PREDEPLOY_BACKUP_STATUS="$(read_remote_key PREDEPLOY_BACKUP "$output_file")"
  ACTIVATION_STATUS="$(read_remote_key ACTIVATION "$output_file")"
  HEALTH_STATUS="$(read_remote_key HEALTH "$output_file")"
  [[ "$OLD_RELEASE" == /opt/servora-med/releases/* ]] || fail REMOTE_OLD_RELEASE_INVALID
  [[ "$NEW_RELEASE" == "/opt/servora-med/releases/$SHA" ]] || fail REMOTE_NEW_RELEASE_INVALID
  [[ "$PREDEPLOY_BACKUP_STATUS" == PASS ]] || fail REMOTE_PREDEPLOY_BACKUP_NOT_VERIFIED
  [[ "$ACTIVATION_STATUS" == PASS && "$HEALTH_STATUS" == PASS ]] || fail REMOTE_ACTIVATION_NOT_VERIFIED
  [[ "$MIGRATIONS_APPLIED" =~ ^[0-9]+$ ]] || MIGRATIONS_APPLIED=0
  DEPLOY_STATUS=PASS
  rm -f -- "$output_file"
}

run_browser_smoke() {
  PHASE=BROWSER_SMOKE
  local output_file
  output_file="$(mktemp)"
  LOCAL_TEMP_FILES+=("$output_file")
  if ! SERVORA_PROD_FQDN="$FQDN" node "$REPO_ROOT/web/scripts/production-browser-smoke.mjs" >"$output_file" 2>&1; then
    cat "$output_file" >&2
    BROWSER_STATUS=FAIL
    rm -f -- "$output_file"
    return 1
  fi
  BROWSER_STATUS=PASS
  rm -f -- "$output_file"
}

rollback_remote() {
  PHASE=ROLLBACK
  local output_file
  output_file="$(mktemp)"
  LOCAL_TEMP_FILES+=("$output_file")
  if remote_phase "$output_file" sudo -n "$HOST_HELPER" --phase rollback --sha "$SHA" --fqdn "$FQDN"; then
    ROLLBACK_STATUS=PASS
    rm -f -- "$output_file"
    return 0
  fi
  cat "$output_file" >&2
  ROLLBACK_STATUS=FAIL
  rm -f -- "$output_file"
  return 1
}

postdeploy_remote() {
  PHASE=POSTDEPLOY_BACKUP
  local output_file
  output_file="$(mktemp)"
  LOCAL_TEMP_FILES+=("$output_file")
  if ! remote_phase "$output_file" sudo -n "$HOST_HELPER" --phase postdeploy --sha "$SHA" --fqdn "$FQDN"; then
    cat "$output_file" >&2
    if grep -q 'LIVE_BUT_POSTDEPLOY_BACKUP_FAILED' "$output_file"; then
      POSTDEPLOY_STATUS=LIVE_BUT_POSTDEPLOY_BACKUP_FAILED
    else
      POSTDEPLOY_STATUS=FAIL
    fi
    rm -f -- "$output_file"
    return 1
  fi
  POSTDEPLOY_STATUS=PASS
  rm -f -- "$output_file"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --allow-migrations) ALLOW_MIGRATIONS=true; shift ;;
    --artifact) ARTIFACT_INPUT="${2:-}"; shift 2 ;;
    --check|--dry-run) CHECK_ONLY=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; fail UNKNOWN_ARGUMENT ;;
  esac
done

if [[ "$CHECK_ONLY" == true ]]; then
  check_only
  exit 0
fi

[[ -n "$SHA" ]] || { usage; fail SHA_REQUIRED; }
check_commands
verify_source
verify_exact_main_ci
build_artifact
prepare_ssh
deploy_remote

if ! run_browser_smoke; then
  if [[ "$MIGRATIONS_APPLIED" -eq 0 ]]; then
    rollback_remote || fail BROWSER_SMOKE_FAILED_ROLLBACK_FAILED
  else
    ROLLBACK_STATUS=MANUAL_REQUIRED_MIGRATIONS_APPLIED
  fi
  fail BROWSER_SMOKE_FAILED
fi

if ! postdeploy_remote; then
  if [[ "$POSTDEPLOY_STATUS" == LIVE_BUT_POSTDEPLOY_BACKUP_FAILED ]]; then
    fail LIVE_BUT_POSTDEPLOY_BACKUP_FAILED
  fi
  fail POSTDEPLOY_FAILED
fi

PHASE=COMPLETE
echo "PRODUCTION_DEPLOYMENT_COMPLETE sha=${SHA} previous=${OLD_RELEASE} migrations_applied=${MIGRATIONS_APPLIED} browser_smoke=${BROWSER_STATUS} postdeploy_backup=${POSTDEPLOY_STATUS}"
fi
