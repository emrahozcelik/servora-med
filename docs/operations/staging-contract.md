# Staging contract — Servora-Med pilot readiness

Canonical contract for a **disposable, synthetic-data-only staging environment**.
This document defines decisions and the environment variable contract only; it
does not create, deploy, or provision anything.

- Environment name: `staging`
- Production deployment is **out of scope** for this document.

## Canonical decisions

```text
INITIAL PILOT TOPOLOGY:
macOS host + Cloudflare Tunnel + Caddy + loopback Fastify

ENVIRONMENT NAME:
staging

DATABASE CLASS:
disposable synthetic-only staging database

REAL CUSTOMER / PATIENT / STAFF DATA:
PROHIBITED

WEB_PUSH_ENABLED:
false initially

ACTION_SCOPED_GEOLOCATION_ENABLED:
false initially

CURRENT HEALTH_SCHEMA_VERSION:
026_messaging_participant_lifecycle

AUTOMATIC MIGRATION ON APP START:
PROHIBITED

MIGRATION METHOD:
explicit canonical migration command before application start

PRODUCTION DEPLOYMENT:
out of scope

STAGING_PUBLIC_ORIGIN:
operator-provided HTTPS origin; unresolved until ingress provisioning
```

Topology follows [OPS-001](../DECISIONS.md) and the macOS + Cloudflare Tunnel
guide ([local-macos-cloudflare-tunnel.md](./local-macos-cloudflare-tunnel.md)).
The staging host runs only loopback services; public HTTPS terminates at
Cloudflare Edge. No router port forwarding, no public Fastify or PostgreSQL.

## Health schema version

`HEALTH_SCHEMA_VERSION` must equal the **exact latest canonical migration
identifier included in the deployed release** — currently
`026_messaging_participant_lifecycle`. Update the value in the staging environment file
on every release that adds a migration.

Operator verification against the deployed release (no database credentials, no
application secrets). The immutable release contains no Git checkout and no
`server/src`; migration SQL lives under `server/dist/db/migrations` (copied
there by the build):

```bash
MIGRATION_DIR="$RELEASE_DIR/server/dist/db/migrations"

test -d "$MIGRATION_DIR"

LATEST_MIGRATION="$(
  find "$MIGRATION_DIR" \
    -maxdepth 1 \
    -type f \
    -name '[0-9][0-9][0-9]_*.sql' \
    -exec basename {} .sql \; |
  LC_ALL=C sort |
  tail -n 1
)"

test -n "$LATEST_MIGRATION"
printf '%s\n' "$LATEST_MIGRATION"
```

A builder checkout may be verified separately with
`git ls-files server/src/db/migrations`; a builder checkout is **not** an
installed release and the two must never be mixed.

Failure behavior:

```text
incorrect or stale HEALTH_SCHEMA_VERSION
→ /api/health returns 503
→ deployment must be treated as not ready
```

## Environment contract

Placeholder-only staging environment example:
[`ops/examples/servora-med-staging.env.example`](../../ops/examples/servora-med-staging.env.example).

Only variable names, purposes, and required/optional states are documented here.
No values or real credentials are recorded.

### Runtime

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | yes | `staging` runs with `production` semantics (strict config, no dev defaults) |
| `HOST` | yes | loopback only (`127.0.0.1` or `::1`) |
| `PORT` | no | listen port; defaults to `3000` |
| `DATABASE_URL` | yes | PostgreSQL `postgresql://` URL pointing to the **staging** database |
| `LOG_LEVEL` | no | allowlist `fatal`..`trace`; default `info` |

### HTTP / security

| Variable | Required | Purpose |
|----------|----------|---------|
| `CORS_ORIGIN` | yes | single exact HTTPS origin (operator-provided until ingress provisioning) |
| `TRUSTED_PROXY` | yes | `loopback` for the tunnel → Caddy → Fastify chain |
| `SESSION_TTL_SECONDS` | no | opaque session lifetime; default `28800` |
| `LOGIN_RATE_LIMIT_MAX` | no | login attempts per limiter window; default `5` |
| `RATE_LIMIT_WINDOW_MS` | no | limiter window; default `60000` |

### Readiness

| Variable | Required | Purpose |
|----------|----------|---------|
| `HEALTH_SCHEMA_VERSION` | yes | exact `schema_migrations.version` for readiness; currently `026_messaging_participant_lifecycle` |

### Feature flags

| Variable | Staging value | Purpose |
|----------|---------------|---------|
| `OVERVIEW_DASHBOARD_ENABLED` | `true` | overview dashboard capability (completed, no external dependency) |
| `CALENDAR_ENABLED` | `true` | calendar capability (completed, no external dependency; fail-closed) |
| `CALENDAR_REMINDER_LEAD_MINUTES` | no | in-app reminder lead time `5..1440`; default `30` |
| `MESSAGING_ENABLED` | `true` | messaging capability (completed through M9 + UXA closeout; fail-closed) |
| `WEB_PUSH_ENABLED` | `false` | Web Push stays disabled until its external-service acceptance gate is approved |
| `ACTION_SCOPED_GEOLOCATION_ENABLED` | `false` | geolocation stays disabled until its Google-service acceptance gate is approved |

### Conditional secrets

Required only when the matching flag is enabled — **not required** for the
initial staging contract:

| Variable | Required when | Purpose |
|----------|---------------|---------|
| `WEB_PUSH_VAPID_SUBJECT` | `WEB_PUSH_ENABLED=true` | public https or mailto contact |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | `WEB_PUSH_ENABLED=true` | URL-safe Base64 P-256 public key |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | `WEB_PUSH_ENABLED=true` | URL-safe Base64 P-256 private key |
| `REVERSE_GEOCODER_PROVIDER` | `ACTION_SCOPED_GEOLOCATION_ENABLED=true` | must be `google` |
| `GOOGLE_GEOCODING_API_KEY` | `ACTION_SCOPED_GEOLOCATION_ENABLED=true` | reverse-geocoding API key |
| `REVERSE_GEOCODER_TIMEOUT_MS`, `GEOCODING_USER_DAILY_LIMIT`, `GEOCODING_ORG_DAILY_LIMIT`, `GEOCODING_GLOBAL_MONTHLY_LIMIT` | geolocation enabled | quota controls |

### Support metadata

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPPORT_DISPLAY_LABEL` | no | support contact label shown to users |
| `SUPPORT_EMAIL` | no | support email (validated format) |
| `SUPPORT_HELP_URL` | no | https help URL |

### Bootstrap-only variables

Used by the bootstrap/seed commands, never by the running application:

| Variable | Purpose |
|----------|---------|
| `BOOTSTRAP_ORGANIZATION_NAME`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | synthetic initial administrator (`bootstrap-admin`) |
| `DEV_SEED_ORGANIZATION_NAME`, `DEV_SEED_PASSWORD` | **local development only** (`db:seed:dev`); never part of the staging bootstrap |
| `F4_SEED_PASSWORD` | synthetic acceptance fixtures (`f4-seed` from a separate exact-head tooling checkout) |

## Remaining blockers (honest inventory)

These items are **unresolved** and are inputs for later batches; this document
does not resolve them:

```text
offsite destination and credential:
UNRESOLVED

backup encryption-at-rest:
UNRESOLVED

backup/health/disk alerting:
UNRESOLVED

live staging host installation:
NOT PERFORMED

Cloudflare Tunnel/domain provisioning:
NOT PERFORMED

live restore rehearsal:
NOT PERFORMED

staging database:
NOT CREATED
```

## Authorization boundaries

```text
STAGING DEPLOYMENT:
NOT AUTHORIZED

PRODUCTION DEPLOYMENT:
NOT AUTHORIZED

CLOUD RESOURCE CREATION:
NOT AUTHORIZED

STAGING DATABASE CREATION:
NOT AUTHORIZED (until a later batch is explicitly authorized)
```

Related documents: [staging-database-runbook.md](./staging-database-runbook.md),
[staging-acceptance.md](./staging-acceptance.md),
[backup-restore.md](./backup-restore.md),
[production-deployment.md](./production-deployment.md).
