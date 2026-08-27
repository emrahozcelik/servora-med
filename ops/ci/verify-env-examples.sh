#!/usr/bin/env bash
# Servora-Med env-example deployment contract check.
#
# Prevents the two drift classes this repo has hit:
#  1. HEALTH_SCHEMA_VERSION in ops examples lagging behind the latest
#     canonical migration (readiness becomes "unavailable" in production).
#  2. Staging feature-flag examples going stale relative to the approved
#     initial staging policy (Overview/Messaging/Calendar on; Web Push and
#     geolocation off until their external-service gates).
#
# Also guards the placeholder-only secret contract: examples must never carry
# real VAPID keys, Google API keys, database passwords, or alert webhook URLs.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROD_EXAMPLE="$ROOT/ops/examples/servora-med.env.example"
STAGING_EXAMPLE="$ROOT/ops/examples/servora-med-staging.env.example"
MIGRATIONS_DIR="$ROOT/server/src/db/migrations"

test -f "$PROD_EXAMPLE"
test -f "$STAGING_EXAMPLE"
test -d "$MIGRATIONS_DIR"

# Latest canonical migration identifier, e.g. 037_staff_offboarding_audit.
LATEST_MIGRATION="$(
  find "$MIGRATIONS_DIR" -maxdepth 1 -name '[0-9][0-9][0-9]_*.sql' -type f -print 2>/dev/null \
    | sed 's#.*/\([0-9][0-9][0-9]_[^/]*\)\.sql$#\1#' \
    | sort \
    | tail -n 1
)"
if [[ -z "${LATEST_MIGRATION}" ]]; then
  echo "no canonical migrations found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi
if ! [[ "${LATEST_MIGRATION}" =~ ^[0-9]{3}_[A-Za-z0-9_]+$ ]]; then
  echo "unexpected migration identifier: ${LATEST_MIGRATION}" >&2
  exit 1
fi

# 1. HEALTH_SCHEMA_VERSION must track the latest migration in BOTH examples.
for example in "$PROD_EXAMPLE" "$STAGING_EXAMPLE"; do
  if ! grep -F "HEALTH_SCHEMA_VERSION=${LATEST_MIGRATION}" "$example" >/dev/null; then
    echo "stale HEALTH_SCHEMA_VERSION in $(basename "$example"): expected ${LATEST_MIGRATION}" >&2
    exit 1
  fi
  if grep -E '^HEALTH_SCHEMA_VERSION=' "$example" | grep -vF "=${LATEST_MIGRATION}" >/dev/null; then
    echo "conflicting HEALTH_SCHEMA_VERSION lines in $(basename "$example")" >&2
    exit 1
  fi
done

# 2. Initial staging feature-flag policy.
# grep -E on a shell-sourced example: only exact KEY=value lines are matched.
staging_flag() {
  grep -E "^$1=(true|false)$" "$STAGING_EXAMPLE" | tail -n 1
}

OVERVIEW="$(staging_flag OVERVIEW_DASHBOARD_ENABLED || true)"
MESSAGING="$(staging_flag MESSAGING_ENABLED || true)"
CALENDAR="$(staging_flag CALENDAR_ENABLED || true)"
WEB_PUSH="$(staging_flag WEB_PUSH_ENABLED || true)"
GEOLOCATION="$(staging_flag ACTION_SCOPED_GEOLOCATION_ENABLED || true)"

[[ "${OVERVIEW}" == "OVERVIEW_DASHBOARD_ENABLED=true" ]] || {
  echo "staging OVERVIEW_DASHBOARD_ENABLED must be true; got: ${OVERVIEW:-<missing>}" >&2
  exit 1
}
[[ "${MESSAGING}" == "MESSAGING_ENABLED=true" ]] || {
  echo "staging MESSAGING_ENABLED must be true; got: ${MESSAGING:-<missing>}" >&2
  exit 1
}
[[ "${CALENDAR}" == "CALENDAR_ENABLED=true" ]] || {
  echo "staging CALENDAR_ENABLED must be true; got: ${CALENDAR:-<missing>}" >&2
  exit 1
}
[[ "${WEB_PUSH}" == "WEB_PUSH_ENABLED=false" ]] || {
  echo "staging WEB_PUSH_ENABLED must be false; got: ${WEB_PUSH:-<missing>}" >&2
  exit 1
}
[[ "${GEOLOCATION}" == "ACTION_SCOPED_GEOLOCATION_ENABLED=false" ]] || {
  echo "staging ACTION_SCOPED_GEOLOCATION_ENABLED must be false; got: ${GEOLOCATION:-<missing>}" >&2
  exit 1
}

# 3. Placeholder-only secret contract (no real credentials in examples).
# DATABASE_URL password must be a <...> placeholder in both examples.
for example in "$PROD_EXAMPLE" "$STAGING_EXAMPLE"; do
  if ! grep -Eq '^DATABASE_URL="?(postgres|postgresql)://servora:<[A-Z_]+>@' "$example"; then
    echo "DATABASE_URL must use a <PLACEHOLDER> password: $(basename "$example")" >&2
    exit 1
  fi
done

# VAPID / Google / webhook values must stay empty (disabled staging flags).
for key in WEB_PUSH_VAPID_SUBJECT WEB_PUSH_VAPID_PUBLIC_KEY WEB_PUSH_VAPID_PRIVATE_KEY \
  REVERSE_GEOCODER_PROVIDER GOOGLE_GEOCODING_API_KEY; do
  value="$(grep -E "^${key}=" "$STAGING_EXAMPLE" | tail -n 1)"
  [[ "${value}" == "${key}=" ]] || {
    echo "staging ${key} must be empty; got: ${value}" >&2
    exit 1
  }
done

echo "env-example contract passed (HEALTH_SCHEMA_VERSION=${LATEST_MIGRATION}, staging flags, placeholder-only secrets)"
