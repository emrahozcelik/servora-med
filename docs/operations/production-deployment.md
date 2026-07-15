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
| `/var/log/servora-med` | Backup/restore ops logs |

## Environment

See `ops/examples/servora-med.env.example`.

Required production highlights:

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `CORS_ORIGIN=https://<FQDN>`
- `TRUSTED_PROXY=loopback`
- `HEALTH_SCHEMA_VERSION=007_sales_meeting` (exact latest migration name; update each release that adds a migration)
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

## Deploy sequence (fail-closed)

Migration **must** run from the **new release directory**, never from the still-active
`current` symlink. Prefer the checked-in helper:

```bash
sudo SHA=<git-sha> SERVORA_FQDN=app.example.com \
  ENV_FILE=/etc/servora-med/servora-med.env \
  /opt/servora-med/releases/<git-sha>/ops/scripts/deploy-release.sh
```

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

# 5) Switch release pointer only after successful migration
ln -sfn "$NEW_RELEASE" /opt/servora-med/current

# 6) Start application
systemctl start servora-med

# 7) Readiness + smoke
curl -fsS "https://${SERVORA_FQDN}/api/health"
# Expect: {"status":"ok"}
```

Do **not**:

- run migrate from `/opt/servora-med/current/...` before `ln -sfn`
- continue deploy after backup or migration failure
- put passwords on the command line
- run migrations on every process start (`start:prod` never migrates)

### Rollback

- Application: repoint `current` to previous release **only if** schema is still compatible.
- Database: forward-only; no automated destructive rollback.

## systemd

```bash
sudo cp ops/systemd/servora-med.service /etc/systemd/system/
sudo cp ops/systemd/servora-med-backup.service /etc/systemd/system/
sudo cp ops/systemd/servora-med-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now servora-med
sudo systemctl enable --now servora-med-backup.timer
```

`EnvironmentFile=` paths are **required** (no optional `-` prefix). Missing env files fail the unit.

## Caddy

Example: `ops/caddy/Caddyfile.example`.
API responses use `Cache-Control: no-store`. Hashed Vite assets under `/assets/*` are immutable; SPA app-shell routes use `no-cache`.

## Health

```http
GET /api/health
200 {"status":"ok"}           # DB reachable and exact HEALTH_SCHEMA_VERSION present
503 {"status":"unavailable"}  # otherwise — no infrastructure details
```

## Verification status (repository vs operator)

| Claim | Status |
|-------|--------|
| Implementation verification (unit/integration/CI) | complete on this branch |
| Disposable PostgreSQL backup/restore acceptance | covered by automated tests when `TEST_DATABASE_URL` is set |
| Live host restore rehearsal record | **pending** operator |
| Offsite copy execution | **pending** operator hook |
| TLS/VPS cutover | **pending** operator |

## Non-goals

Docker/K8s, multi-region, HA, auto-deploy from CI, product backup UI.
