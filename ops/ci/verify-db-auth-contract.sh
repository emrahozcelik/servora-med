#!/usr/bin/env bash
# Pilot DB auth contract via Node/pg — DATABASE_URL only in environment (never argv).
# Covers: password-bearing URL shape, URL-safe hex password guidance, connect success,
# wrong-password failure, no secret on process argv (Linux /proc when available).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_EXAMPLE="$ROOT/ops/examples/servora-med.env.example"
VERIFY_JS="$ROOT/server/scripts/verify-db-auth.mjs"
BOOTSTRAP_JS="$ROOT/server/scripts/bootstrap-app-role.mjs"

test -f "$ENV_EXAMPLE"
test -f "$VERIFY_JS"
test -f "$BOOTSTRAP_JS"

grep -E 'DATABASE_URL=postgresql://servora:<APP_DB_PASSWORD>@127\.0\.0\.1:5432/servora_med' \
  "$ENV_EXAMPLE" >/dev/null
grep -F 'URL-safe' "$ENV_EXAMPLE" >/dev/null || grep -Fi 'percent-encoded' "$ENV_EXAMPLE" >/dev/null

ADMIN_URL="${TEST_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "${ADMIN_URL}" ]]; then
  echo "TEST_DATABASE_URL or DATABASE_URL required" >&2
  exit 1
fi
if ! [[ "${ADMIN_URL}" =~ ^postgres(ql)?://[^:/@]+:[^@/]+@[^/]+/ ]]; then
  echo "admin URL must be password-bearing for CI bootstrap" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node required" >&2
  exit 1
fi

# Install pg for scripts when running before npm ci: use server node_modules if present.
cd "$ROOT/server"
if [[ ! -d node_modules/pg ]]; then
  npm ci --omit=dev --silent
fi

# URL-safe password (hex) — safe in URI userinfo without encoding.
APP_DB_PASSWORD="$(openssl rand -hex 32)"
if ! [[ "${APP_DB_PASSWORD}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "canonical password generator must produce 64 hex chars" >&2
  exit 1
fi

ROLE="servora_ci_auth"
DBNAME="servora_ci_auth_db"
# Build app URL without putting password on helper argv: pure bash concatenation into env only.
# Parse host/port from admin URL with node (no password printed).
# shellcheck disable=SC2016 # Node source must not expand under bash.
HOST_PORT="$(
  env -i PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
    U="${ADMIN_URL}" \
    node --input-type=module -e '
      const u = new URL(process.env.U);
      process.stdout.write(`${u.hostname}:${u.port || "5432"}`);
    '
)"

APP_URL="postgresql://${ROLE}:${APP_DB_PASSWORD}@${HOST_PORT}/${DBNAME}"

# Bootstrap role via env-only Node helper (parameterized PASSWORD $1).
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  ADMIN_DATABASE_URL="${ADMIN_URL}" \
  APP_DB_PASSWORD="${APP_DB_PASSWORD}" \
  APP_DB_ROLE="${ROLE}" \
  APP_DB_NAME="${DBNAME}" \
  node "${BOOTSTRAP_JS}"

# Correct password success — DATABASE_URL only in environment.
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  DATABASE_URL="${APP_URL}" \
  EXPECT_USER="${ROLE}" \
  node "${VERIFY_JS}"

# Wrong password must fail.
WRONG_URL="postgresql://${ROLE}:definitely-wrong-password@${HOST_PORT}/${DBNAME}"
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  DATABASE_URL="${WRONG_URL}" \
  EXPECT_FAIL=1 \
  node "${VERIFY_JS}"

# No-secret-in-argv: spawn verify and inspect /proc/PID/cmdline when available.
if [[ -r /proc/self/cmdline ]]; then
  (
    env -i \
      PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
      HOME="${HOME:-/tmp}" \
      DATABASE_URL="${APP_URL}" \
      EXPECT_USER="${ROLE}" \
      node "${VERIFY_JS}" &
    child=$!
    # Brief window while process may still be alive
    sleep 0.05
    if [[ -r "/proc/${child}/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' <"/proc/${child}/cmdline" || true)"
      if printf '%s' "${cmdline}" | grep -Fq "${APP_DB_PASSWORD}"; then
        echo "password leaked into process argv" >&2
        wait "${child}" || true
        exit 1
      fi
      if printf '%s' "${cmdline}" | grep -Fq "${APP_URL}"; then
        echo "DATABASE_URL leaked into process argv" >&2
        wait "${child}" || true
        exit 1
      fi
    fi
    wait "${child}"
  )
fi

# Percent-encoded special password still works when operator encodes userinfo.
SPECIAL_PASS='p@ss/w:ord!'
SPECIAL_ENC="$(
  env -i PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
    SPECIAL_PASS="${SPECIAL_PASS}" node --input-type=module -e 'process.stdout.write(encodeURIComponent(process.env.SPECIAL_PASS))'
)"
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  ADMIN_DATABASE_URL="${ADMIN_URL}" \
  APP_DB_PASSWORD="${SPECIAL_PASS}" \
  APP_DB_ROLE="${ROLE}" \
  APP_DB_NAME="${DBNAME}" \
  node "${BOOTSTRAP_JS}"

SPECIAL_URL="postgresql://${ROLE}:${SPECIAL_ENC}@${HOST_PORT}/${DBNAME}"
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  DATABASE_URL="${SPECIAL_URL}" \
  EXPECT_USER="${ROLE}" \
  node "${VERIFY_JS}"

# Cleanup role/db (best-effort) without printing passwords.
# shellcheck disable=SC2016 # Node source must not expand under bash.
env -i \
  PATH="$(command -v node | xargs dirname):/usr/bin:/bin" \
  HOME="${HOME:-/tmp}" \
  ADMIN_DATABASE_URL="${ADMIN_URL}" \
  ROLE="${ROLE}" \
  DBNAME="${DBNAME}" \
  node --input-type=module -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    const role = process.env.ROLE;
    const db = process.env.DBNAME;
    await c.query(`DROP DATABASE IF EXISTS ${db}`);
    await c.query(`DROP ROLE IF EXISTS ${role}`);
    await c.end();
    console.log("ok cleanup");
  '

echo "db auth contract passed (env-only Node/pg, URL-safe hex, wrong-password fail, no argv secret)"
