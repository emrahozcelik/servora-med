#!/usr/bin/env bash
# Fail-closed production deploy helper for Servora-Med.
# Usage:
#   sudo -E SHA=<git-sha> ENV_FILE=/etc/servora-med/servora-med.env \
#     ./ops/scripts/deploy-release.sh
#
# Requires: NEW release already copied to /opt/servora-med/releases/$SHA
# including server/dist, server/package.json, server/package-lock.json,
# server/node_modules, web/dist, and ops/.
# The host must also install servora-med-predeploy-backup@.service; the
# scheduled servora-med-backup.service remains current-release based.
#
# Build order contract (never swap these two steps):
#   server: npm ci (full, dev deps included) -> npm run build -> npm ci --omit=dev
#   web:    npm ci (full) -> npm run build  (runtime is static web/dist only)
# `npm ci --omit=dev` cannot build: typescript/vite are devDependencies.
# The release server/node_modules below MUST be the post-build production
# dependency set (npm ci --omit=dev run AFTER a successful server build).
set -Eeuo pipefail

SHA="${SHA:?SHA is required}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SHA must be a 40-character lowercase hexadecimal git commit" >&2
  exit 1
fi
readonly RELEASE_ROOT="/opt/servora-med/releases"
readonly EXPECTED_RELEASE="${RELEASE_ROOT}/${SHA}"
readonly CURRENT_LINK="/opt/servora-med/current"

# NEW_RELEASE is retained as a compatibility input for the operator wrapper
# and test harness, but it is not a path selector. It must be the exact
# canonical SHA path; lexical aliases such as /tmp, releases-alt, or .. are
# rejected before any service, backup, migration, or activation action.
NEW_RELEASE="${NEW_RELEASE-${EXPECTED_RELEASE}}"
ENV_FILE="${ENV_FILE:-/etc/servora-med/servora-med.env}"
SERVICE_NAME="${SERVICE_NAME:-servora-med}"
PREDEPLOY_BACKUP_UNIT="servora-med-predeploy-backup@${SHA}.service"
FQDN="${SERVORA_FQDN:-}"

# The production release root and active pointer are fixed constants. Resolve
# both the root and the SHA entry with physical paths so parent/release
# symlinks and path escapes fail closed. The check is intentionally lexical
# first, so a path containing SHA/.. is rejected even when it resolves back to
# the expected directory.
if [[ "$NEW_RELEASE" != "$EXPECTED_RELEASE" ]]; then
  echo "NEW_RELEASE must exactly match ${EXPECTED_RELEASE}" >&2
  exit 1
fi

canonical_dir() {
  local path="$1"
  (cd -- "$path" && pwd -P)
}

assert_release_dir() {
  local path="$1"
  local canonical
  [[ -d "$path" && ! -L "$path" ]] || return 1
  canonical="$(canonical_dir "$path")" || return 1
  [[ "$canonical" == "$path" ]]
}

assert_release_file() {
  local path="$1"
  local parent canonical
  [[ -f "$path" && ! -L "$path" ]] || return 1
  parent="$(canonical_dir "$(dirname -- "$path")")" || return 1
  canonical="${parent}/$(basename -- "$path")"
  [[ "$canonical" == "$path" ]]
}

if ! assert_release_dir "$RELEASE_ROOT"; then
  echo "Release root must be a physical directory: $RELEASE_ROOT" >&2
  exit 1
fi
if ! assert_release_dir "$EXPECTED_RELEASE"; then
  echo "SHA release must be a physical directory: $EXPECTED_RELEASE" >&2
  exit 1
fi

for required_dir in \
  "$EXPECTED_RELEASE/server/dist" \
  "$EXPECTED_RELEASE/server/node_modules" \
  "$EXPECTED_RELEASE/web/dist" \
  "$EXPECTED_RELEASE/ops/scripts"; do
  if ! assert_release_dir "$required_dir"; then
    echo "Missing or escaped release directory: $required_dir" >&2
    exit 1
  fi
done

for required_file in \
  "$EXPECTED_RELEASE/server/package.json" \
  "$EXPECTED_RELEASE/server/package-lock.json" \
  "$EXPECTED_RELEASE/server/dist/db/migrate.js" \
  "$EXPECTED_RELEASE/server/dist/db/schema-check.js" \
  "$EXPECTED_RELEASE/ops/scripts/backup-postgres.sh"; do
  if ! assert_release_file "$required_file"; then
    echo "Missing or escaped release artifact: $required_file" >&2
    exit 1
  fi
done

if [[ ! -x "$EXPECTED_RELEASE/ops/scripts/backup-postgres.sh" ]]; then
  echo "Backup script must be executable: $EXPECTED_RELEASE/ops/scripts/backup-postgres.sh" >&2
  exit 1
fi

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "Active release pointer must be absent or a symlink: $CURRENT_LINK" >&2
  exit 1
fi

# All runtime paths below are derived from EXPECTED_RELEASE after the exact
# path and physical-tree checks above; NEW_RELEASE cannot redirect them.
NEW_RELEASE="$EXPECTED_RELEASE"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

echo "Deploying release $SHA from $NEW_RELEASE"

# Require SERVORA_FQDN for mandatory health verification (fail preflight before destructive work)
# FQDN is an internal shell variable derived from SERVORA_FQDN; do not set FQDN directly
if [[ -z "${FQDN:-}" ]]; then
  echo "SERVORA_FQDN is required for deployment health verification" >&2
  exit 1
fi

# 1) Pre-deploy backup — failure aborts deploy. The template unit executes the
# exact SHA release path and does not depend on the current symlink.
if ! systemctl start "$PREDEPLOY_BACKUP_UNIT"; then
  echo "Pre-deploy backup failed; aborting deploy (current symlink unchanged)." >&2
  exit 1
fi

# 2) Stop accepting traffic.
systemctl stop "$SERVICE_NAME"

# 3) Load production environment without printing secrets.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# 4) Migrate from NEW release only. Failure must not switch symlink.
if ! node "${NEW_RELEASE}/server/dist/db/migrate.js"; then
  echo "Migration failed; leaving current symlink unchanged and restarting previous service." >&2
  if ! systemctl start "$SERVICE_NAME"; then
    echo "Previous service restart attempt also failed; manual recovery required." >&2
  fi
  exit 1
fi

# 5) Verify schema compatibility from NEW release (read-only, no auto-migrate).
#    Must succeed before activation — proves pending=0, detects AHEAD/DIVERGED, catalog/config mismatch.
if ! node "${NEW_RELEASE}/server/dist/db/schema-check.js"; then
  echo "Schema check failed; leaving current symlink unchanged and restarting previous service." >&2
  if ! systemctl start "$SERVICE_NAME"; then
    echo "Previous service restart attempt also failed; manual recovery required." >&2
  fi
  exit 1
fi

# 6) Switch the fixed release pointer only after successful migration AND
# schema check. The target is the validated SHA path, never a caller path.
ln -sfn "$EXPECTED_RELEASE" "$CURRENT_LINK"

# 7) Start application against new current.
if ! systemctl start "$SERVICE_NAME"; then
  echo "Service start failed after symlink switch." >&2
  exit 1
fi

# 8) Readiness smoke (mandatory health verification).
if ! curl -fsS "https://${FQDN}/api/health" | grep -q '"status":"ok"'; then
  echo "Health check failed for https://${FQDN}/api/health" >&2
  exit 1
fi

echo "Deploy complete: $SHA"
