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
NEW_RELEASE="${NEW_RELEASE:-/opt/servora-med/releases/${SHA}}"
ENV_FILE="${ENV_FILE:-/etc/servora-med/servora-med.env}"
SERVICE_NAME="${SERVICE_NAME:-servora-med}"
PREDEPLOY_BACKUP_UNIT="servora-med-predeploy-backup@${SHA}.service"
CURRENT_LINK="${CURRENT_LINK:-/opt/servora-med/current}"
FQDN="${SERVORA_FQDN:-}"

# A production release path must remain tied to the validated SHA. Test and
# staging harnesses may provide an isolated NEW_RELEASE path, but the backup
# unit never derives an executable path from that override.
if [[ "$NEW_RELEASE" == /opt/servora-med/releases/* && "$NEW_RELEASE" != "/opt/servora-med/releases/${SHA}" ]]; then
  echo "NEW_RELEASE must match the SHA release root" >&2
  exit 1
fi

if [[ ! -d "$NEW_RELEASE/server/dist" ]]; then
  echo "Missing release build: $NEW_RELEASE/server/dist" >&2
  exit 1
fi
if [[ ! -f "$NEW_RELEASE/server/package-lock.json" ]]; then
  echo "Missing package-lock.json in release: $NEW_RELEASE/server" >&2
  exit 1
fi
if [[ ! -d "$NEW_RELEASE/server/node_modules" ]]; then
  echo "Missing node_modules in release (run npm ci --omit=dev in server/ AFTER a successful npm run build)." >&2
  exit 1
fi
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

# 6) Switch release pointer only after successful migration AND schema check.
ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"

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
