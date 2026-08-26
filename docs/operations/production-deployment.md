# Production deployment — Servora-Med (Ubuntu VPS reference)

**Ubuntu 24.04 VPS** reference topology (Slice 11). For the **initial macOS pilot** with Cloudflare Tunnel (no inbound app ports), use [local-macos-cloudflare-tunnel.md](./local-macos-cloudflare-tunnel.md) instead.

## Topology

```text
Internet → Caddy :443 (TLS)
            ├── static: /opt/servora-med/current/web/dist
            └── /api/* → 127.0.0.1:3000 Fastify
                            └── PostgreSQL 127.0.0.1:5432
```

- Public firewall: 80/443 (+ restricted SSH). **Not** 3000 or 5432.
- Session cookies remain host-only (no `Domain=`).
- CORS origin: single `https://<FQDN>`.

## Directory layout

| Path | Purpose |
|------|---------|
| `/opt/servora-med/releases/<sha>` | Immutable release |
| `/opt/servora-med/current` | Symlink to active release |
| `/etc/servora-med/servora-med.env` | App environment (root:servora-med, mode 0640) |
| `/etc/servora-med/servora-med-backup.env` | Backup identity (required by backup unit) |
| `/var/backups/servora-med` | Local backups (0700) |
| `/var/backups/servora-med/br-workspaces` | BR5 worker temporary workspaces (0700) |
| `/var/log/servora-med` | Backup/restore ops logs |

## Environment

See `ops/examples/servora-med.env.example`.

Required production highlights:

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `CORS_ORIGIN=https://<FQDN>`
- `TRUSTED_PROXY=loopback`
- `HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit` (must equal the exact latest canonical migration identifier included in the deployed release; update every release that adds a migration)
- `DEMO_DATA_CREATION_ENABLED=false` (default false all environments; creation DISABLED, list/preview/purge remain AVAILABLE; enable explicitly only for staging/dev where disposable `TEST_DATABASE_URL` is used)

### HEALTH_SCHEMA_VERSION verification

`HEALTH_SCHEMA_VERSION` must equal the exact latest canonical migration
identifier included in the deployed release. The immutable release contains no
Git checkout and no `server/src`; migration SQL lives under
`server/dist/db/migrations` (copied there by the build). Verify against that
directory (no database credentials, no application secrets):

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

A builder-checkout may be verified separately with
`git ls-files server/src/db/migrations`; a builder checkout is **not** an
installed release and the two must never be mixed.

Failure behavior — an incorrect or stale `HEALTH_SCHEMA_VERSION` means:

```text
incorrect or stale HEALTH_SCHEMA_VERSION
→ /api/health returns 503
→ deployment must be treated as not ready
```
- `DATABASE_URL` PostgreSQL only (prefer peer/`PGPASSFILE`, never log the URL)

## Build release (immutable dependencies)

On a clean builder with Node 22:

```bash
cd server
npm ci
npm run build
# Production runtime deps only — lockfile-pinned, no devDependencies
npm ci --omit=dev

cd ../web
npm ci
npm run build
```

Copy into `/opt/servora-med/releases/<git-sha>/`:

```text
server/dist/
server/package.json
server/package-lock.json
server/node_modules/          # from npm ci --omit=dev
web/dist/
ops/
```

`node dist/index.js` must resolve `fastify`, `pg`, and other runtime packages from
`server/node_modules` in that release directory. Do **not** omit `package-lock.json`
or run an open-ended `npm install` on the VPS.

Smoke after copy (on builder or staging):

```bash
cd /opt/servora-med/releases/<sha>/server
node -e "require('fs').accessSync('node_modules/fastify'); require('fs').accessSync('dist/index.js')"
# ESM package: also
node --input-type=module -e "import 'fastify'; import 'pg'; console.log('deps-ok')"
```

## Host prerequisite: age >= 1.3 (BR3 backup encryption)

The current MVP backup stack does **not** require `age`. It becomes a host
prerequisite only when the BR5 backup worker is enabled (BR3 encryption
runs the official `age` CLI with a native post-quantum hybrid recipient —
decision `OPS-003`). Install the official upstream release, pinned and
checksum-verified (values from the age release page; adjust when bumping):

```bash
AGE_VERSION="v1.3.1"
AGE_SHA256="bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377"
curl -fsSL -o /tmp/age.tar.gz \
  "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-amd64.tar.gz"
echo "${AGE_SHA256}  /tmp/age.tar.gz" | sha256sum --check --strict -
tar -xzf /tmp/age.tar.gz -C /tmp
sudo install -m 0755 /tmp/age/age /usr/local/bin/age
rm -rf /tmp/age /tmp/age.tar.gz
age --version   # must report >= 1.3.0; older/major-different binaries fail closed
```

Only `age` is needed at runtime (the worker encrypts; it never decrypts).
`age-keygen` runs on the **operator's** machine for offline key
generation — never install or use the private identity on the VPS
(`docs/operations/backup-recovery/architecture.md` §10).

## Cloudflare R2 boundary (BR4 + BR5; production execution is gated)

BR4 supplies the private Cloudflare R2 adapter and remote verification
engine. BR5 supplies the separate opt-in worker, but does not authorize
production cutover or removal of the MVP timer/script stack.

Operator-managed application env fields:

```text
BACKUP_INSTANCE_ID
BACKUP_R2_ACCOUNT_ID
BACKUP_R2_ACCESS_KEY_ID
BACKUP_R2_SECRET_ACCESS_KEY
BACKUP_R2_BUCKET
BACKUP_R2_BUCKET_ALIAS        # optional safe display label
```

- Use a private, operator-created R2 bucket and an `Object Read & Write`
  token scoped to that bucket. Do not give the runtime Cloudflare account,
  Bucket Lock, lifecycle, public-domain, or bucket-administration authority.
- `BACKUP_INSTANCE_ID` must be a stable opaque identifier that survives DB
  loss; never derive it from an organization, customer, hostname containing
  a customer name, database name, email, or username.
- The endpoint is derived from the validated account ID and uses
  `region=auto`; no operator-provided endpoint is accepted.
- Completed backup objects use streaming `PutObject` with
  `If-None-Match: *`. BR4 deliberately fails closed with
  `R2_OBJECT_TOO_LARGE` above R2's effective 5 GiB − 5 MiB
  (5,363,466,240-byte) single-PUT ceiling because R2 does
  not document an equivalent atomic no-overwrite condition for multipart
  finalization. Do not treat multipart backup upload as enabled.
- Configure Bucket Lock and lifecycle manually according to the retention
  contract. Bucket Lock takes precedence over lifecycle and the application
  neither configures nor claims to observe it.
- `POST /api/admin/backup-storage/test` performs a 15-second-bounded list + multipart
  create/abort capability probe, completes no object, and persists only the
  safe timestamp/outcome. Missing R2 configuration records a `CONFIG`
  failure; no credential or raw SDK diagnostic is returned.

Worker activation requires a separate deployment gate:

- `BACKUP_WORKER_ENABLED=false` remains the safe default; the API never
  claims backup rows.
- Before enabling it, execute the disposable-bucket FULL_DATA DR gate in
  [`real-r2-dr-acceptance.md`](./backup-recovery/real-r2-dr-acceptance.md).
  A BR4 connection probe alone is insufficient. Without dedicated acceptance
  credentials, `REAL_R2_DR_ACCEPTANCE` remains **NOT EXECUTED**.
- Verify `GET /api/health` includes an aggregate `backup` object with the
  latest verified timestamp, `latestScheduledVerifiedAt`, and
  worker/scheduler heartbeat. In verified-runs monitoring mode, scheduled
  freshness comes from the scheduled field; a manual verified run does not
  satisfy it. Keep the single operator-alerting monitor in legacy mode until
  the gate approves `SERVORA_ALERT_BACKUP_SOURCE=verified-runs`.

## Deploy sequence (fail-closed)

Migration **must** run from the **new release directory**, never from the still-active
`current` symlink. Prefer the checked-in helper:

```bash
sudo SHA=<git-sha> SERVORA_FQDN=app.example.com \
  ENV_FILE=/etc/servora-med/servora-med.env \
  /opt/servora-med/releases/<git-sha>/ops/scripts/deploy-release.sh
```

`SERVORA_FQDN` is **required** — deployment `health` (`https://${SERVORA_FQDN}/api/health → 200`) is mandatory and the script fails preflight **before** stopping the service or migrating if `SERVORA_FQDN` is empty. The script stores `SERVORA_FQDN` in its internal `FQDN` shell variable; do not set `FQDN` directly. No `migrate → schema-check → activate → restart → success` without verified health.

Equivalent expanded sequence (`set -Eeuo pipefail` semantics):

```bash
set -Eeuo pipefail
SHA="<git-sha>"
NEW_RELEASE="/opt/servora-med/releases/${SHA}"
ENV_FILE="/etc/servora-med/servora-med.env"

# 1) Pre-deploy backup — failure aborts (no further deploy steps)
systemctl start servora-med-backup.service

# 2) Stop accepting traffic
systemctl stop servora-med

# 3) Load production environment without printing secrets
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# 4) Migrate using the NEW release binaries only
#    On failure: do NOT change symlink; restart previous service
if ! node "${NEW_RELEASE}/server/dist/db/migrate.js"; then
  echo "Migration failed; current symlink unchanged" >&2
  systemctl start servora-med || true
  exit 1
fi

# 5) Verify schema compatibility from NEW release (read-only, no auto-migrate)
#    Must succeed before activation — proves pending=0, detects AHEAD/DIVERGED, catalog/config mismatch
if ! node "${NEW_RELEASE}/server/dist/db/schema-check.js"; then
  echo "Schema check failed; current symlink unchanged" >&2
  systemctl start servora-med || true
  exit 1
fi

# 6) Switch release pointer only after successful migration AND schema check
ln -sfn "$NEW_RELEASE" /opt/servora-med/current

# 7) Start application
systemctl start servora-med

# 8) Readiness + smoke
curl -fsS "https://${SERVORA_FQDN}/api/health"
# Expect: {"status":"ok"}
```

### Schema check (`npm run schema:check`)

```bash
# Development (tsx)
npm run schema:check        # tsx src/db/schema-check.ts (uses .env)

# Production (built artifact, NEW release)
node dist/db/schema-check.js
# or via script
npm run schema:check:prod
```

- **Read-only**: never migrates, never creates `schema_migrations`, never acquires migration lock.
- **Exit 0** only for `COMPATIBLE`; all other states (`BEHIND`/`EMPTY`/`AHEAD`/`DIVERGED`/missing table/`HEALTH_SCHEMA_VERSION` mismatch/catalog invalid/DB unavailable) → nonzero.
- **Operator messages** distinguish: `BEHIND`/`EMPTY` → `Run npm run migrate`, `AHEAD` → newer DB than release, `DIVERGED` → incompatible history, `missing schema_migrations` → explicit migration required.
- **Privacy**: never prints `DATABASE_URL`, credentials, or full config.

Do **not**:

- run migrate or schema check from `/opt/servora-med/current/...` before `ln -sfn` (must use NEW release artifacts)
- continue deploy after backup, migration, or schema-check failure
- put passwords on the command line
- run migrations on every process start (`start:prod` never migrates; deployment is explicit)

Deployment gates are complementary, not duplicated:

- **Deployment**: actively migrates (`migrate` → `schema:check`) then activates
- **Startup guard**: never migrates; refuses incompatible DB (`BEHIND`/`EMPTY`/`AHEAD`/`DIVERGED`/missing)
- **Readiness**: continuously reports incompatible DB as `503 unavailable`

Migration failure reality: runner is transaction-per-migration. If `030` and `031` succeed and `032` fails, the earlier migrations remain committed. Deployment must still stop and **not** activate the new release. No automatic rollback/down migrations are added.

### Rollback

- Application: repoint `current` to previous release **only if** schema is still compatible with that release.
- Database: forward-only; no automated destructive rollback.
- If post-activation health fails, report failure per operations policy — automatic application/database rollback is a separate design decision.

## systemd

```bash
sudo cp ops/systemd/servora-med.service /etc/systemd/system/
sudo cp ops/systemd/servora-med-backup.service /etc/systemd/system/
sudo cp ops/systemd/servora-med-backup.timer /etc/systemd/system/
sudo cp ops/systemd/servora-med-backup-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now servora-med
sudo systemctl enable --now servora-med-backup.timer
# Do not enable servora-med-backup-worker until the BR5 production gate above is approved.
```

`EnvironmentFile=` paths are **required** (no optional `-` prefix). Missing env files fail the unit.

### BR5 worker cutover checklist (documentation only)

This repository does not perform host activation. Follow the separately gated
G0–G10 sequence in
[`production-cutover-runbook.md`](./backup-recovery/production-cutover-runbook.md).
Real-R2 DR PASS, read-only host preflight, worker authorization, first verified
manual and scheduled backups, monitoring observation, and legacy retirement
are separate gates. Keep `BACKUP_WORKER_ENABLED=false`, the legacy timer,
`OFFSITE_COPY_HOOK`, and legacy monitoring unchanged until their respective
authorization points.

## Caddy

Example: `ops/caddy/Caddyfile.example`.
API responses use `Cache-Control: no-store`. Hashed Vite assets under `/assets/*` are immutable; SPA app-shell routes use `no-cache`.

## Health

```http
GET /api/health
200 {"status":"ok"}           # plus safe backup evidence when worker health is wired
503 {"status":"unavailable"}  # otherwise — no infrastructure details
```

## Verification status (repository vs operator)

| Claim | Status |
|-------|--------|
| Implementation verification (unit/integration/CI) | unit/integration checks complete on the isolated branch; exact-head CI is the Draft PR handoff gate |
| Disposable PostgreSQL backup/restore acceptance | covered by automated tests when `TEST_DATABASE_URL` is set |
| Disposable real-R2 FULL_DATA DR acceptance | **NOT EXECUTED** — dedicated acceptance credentials unavailable; never falls back to production credentials |
| Live host restore rehearsal record | **pending** operator |
| Offsite copy execution | **pending** operator hook |
| TLS/VPS cutover | **pending** operator |

## Non-goals

Docker/K8s, multi-region, HA, auto-deploy from CI, product backup UI.
