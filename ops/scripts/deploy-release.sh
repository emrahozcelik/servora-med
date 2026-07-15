#!/usr/bin/env bash
# Fail-closed production deploy helper for Servora-Med.
# Usage:
#   sudo -E SHA=<git-sha> ENV_FILE=/etc/servora-med/servora-med.env \
#     ./ops/scripts/deploy-release.sh
#
# Requires: NEW release already copied to /opt/servora-med/releases/$SHA
# including server/dist, server/package.json, server/package-lock.json,
# server/node_modules (from npm ci --omit=dev), web/dist, and ops/.
set -Eeuo pipefail

SHA="${SHA:?SHA is required}"
NEW_RELEASE="${NEW_RELEASE:-/opt/servora-med/releases/${SHA}}"
ENV_FILE="${ENV_FILE:-/etc/servora-med/servora-med.env}"
SERVICE_NAME="${SERVICE_NAME:-servora-med}"
BACKUP_UNIT="${BACKUP_UNIT:-servora-med-backup.service}"
CURRENT_LINK="${CURRENT_LINK:-/opt/servora-med/current}"
FQDN="${SERVORA_FQDN:-}"

if [[ ! -d "$NEW_RELEASE/server/dist" ]]; then
  echo "Missing release build: $NEW_RELEASE/server/dist" >&2
  exit 1
fi
if [[ ! -f "$NEW_RELEASE/server/package-lock.json" ]]; then
  echo "Missing package-lock.json in release: $NEW_RELEASE/server" >&2
  exit 1
fi
if [[ ! -d "$NEW_RELEASE/server/node_modules" ]]; then
  echo "Missing node_modules in release (run npm ci --omit=dev in server/)." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

echo "Deploying release $SHA from $NEW_RELEASE"

# 1) Pre-deploy backup — failure aborts deploy.
if ! systemctl start "$BACKUP_UNIT"; then
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
  systemctl start "$SERVICE_NAME" || true
  exit 1
fi

# 5) Switch release pointer only after successful migration.
ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"

# 6) Start application against new current.
if ! systemctl start "$SERVICE_NAME"; then
  echo "Service start failed after symlink switch." >&2
  exit 1
fi

# 7) Readiness smoke (optional FQDN).
if [[ -n "$FQDN" ]]; then
  if ! curl -fsS "https://${FQDN}/api/health" | grep -q '"status":"ok"'; then
    echo "Health check failed for https://${FQDN}/api/health" >&2
    exit 1
  fi
fi

echo "Deploy complete: $SHA"
