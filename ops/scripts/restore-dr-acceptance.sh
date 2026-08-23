#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Disposable acceptance only. This script never changes production service
# configuration and never deletes R2 objects (Bucket Lock/lifecycle may make
# deletion impossible). Use a disposable PostgreSQL database and, for the
# real-R2 layer, a disposable bucket/prefix and opaque instance id.
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
: "${AGE_BIN:?AGE_BIN must point to official age >= 1.3.0}"
: "${AGE_KEYGEN_BIN:?AGE_KEYGEN_BIN must point to official age-keygen}"

export BR7_FULL_DR_ACCEPTANCE=1

if [[ "${BR7_REAL_R2_ACCEPTANCE:-0}" == "1" ]]; then
  : "${BR7_REAL_R2_INSTANCE_ID:?BR7_REAL_R2_INSTANCE_ID is required for real R2 acceptance}"
  : "${BACKUP_R2_ACCOUNT_ID:?BACKUP_R2_ACCOUNT_ID is required for real R2 acceptance}"
  : "${BACKUP_R2_ACCESS_KEY_ID:?BACKUP_R2_ACCESS_KEY_ID is required for real R2 acceptance}"
  : "${BACKUP_R2_SECRET_ACCESS_KEY:?BACKUP_R2_SECRET_ACCESS_KEY is required for real R2 acceptance}"
  : "${BACKUP_R2_BUCKET:?BACKUP_R2_BUCKET must be a disposable acceptance bucket}"
fi

cd "$(dirname "$0")/../../server"
npm test -- --run tests/backup-dr-full-acceptance.test.ts
