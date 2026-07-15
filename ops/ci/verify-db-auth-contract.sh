#!/usr/bin/env bash
# Verify pilot DB auth contract: password-bearing URL works with minimal env (no Homebrew PATH).
# Hard gate when DATABASE_URL/TEST_DATABASE_URL is available (CI provides Postgres).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_EXAMPLE="$ROOT/ops/examples/servora-med.env.example"

test -f "$ENV_EXAMPLE"
grep -E 'DATABASE_URL=postgresql://servora:<APP_DB_PASSWORD>@127\.0\.0\.1:5432/servora_med' \
  "$ENV_EXAMPLE" >/dev/null

# Prefer CI test URL; require user:password@host form (not trust/peer-only).
URL="${TEST_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "${URL}" ]]; then
  echo "DATABASE_URL or TEST_DATABASE_URL required for db auth contract" >&2
  exit 1
fi

if ! [[ "${URL}" =~ ^postgresql://[^:/@]+:[^@/]+@[^/]+/ ]]; then
  echo "DATABASE_URL must be password-bearing (postgresql://user:pass@host/db)" >&2
  exit 1
fi

# Minimal environment: no PGPASSFILE, no extra secrets on argv.
export PATH="/usr/bin:/bin"
# Prefer absolute client if provided by CI; else require psql on PATH (CI installs client).
PSQL_BIN="${PSQL_BIN:-psql}"
if [[ "${PSQL_BIN}" != /* ]]; then
  if command -v psql >/dev/null 2>&1; then
    PSQL_BIN="$(command -v psql)"
  else
    echo "psql not found; set PSQL_BIN" >&2
    exit 1
  fi
fi

# Connection must succeed with only DATABASE_URL (password in URL, not argv flag).
DATABASE_URL="${URL}" "${PSQL_BIN}" "${URL}" -v ON_ERROR_STOP=1 -tAc 'SELECT 1' | grep -qx 1

# Simulate service-user minimal environment: only PATH + DATABASE_URL.
env -i PATH="/usr/bin:/bin" HOME="/tmp" \
  DATABASE_URL="${URL}" \
  "${PSQL_BIN}" "${URL}" -v ON_ERROR_STOP=1 -tAc "SELECT current_user" >/dev/null

echo "db auth contract passed (password-bearing DATABASE_URL, minimal env)"
