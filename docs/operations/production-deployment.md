# Production deployment — Servora-Med

Canonical pilot topology for a single Ubuntu 24.04 VPS.

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

## Build release

On a clean builder with Node 22:

```bash
cd server && npm ci && npm run build
cd ../web && npm ci && npm run build
```

Copy `server/` (including `dist/`, `package.json`), `web/dist/`, and `ops/` into
`/opt/servora-med/releases/<git-sha>/`.

## Deploy sequence (exact)

Migration **must** run from the **new release directory**, never from the still-active
`current` symlink.

```bash
# As a deploy operator with sudo where needed.
SHA="<git-sha>"
NEW_RELEASE="/opt/servora-med/releases/${SHA}"
ENV_FILE="/etc/servora-med/servora-med.env"

# 1) Pre-deploy backup (uses backup env file; no secrets on argv)
sudo systemctl start servora-med-backup.service

# 2) Stop accepting traffic
sudo systemctl stop servora-med

# 3) Load production environment without printing secrets
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# 4) Migrate using the NEW release binaries only
node "${NEW_RELEASE}/server/dist/db/migrate.js"

# 5) Switch release pointer only after migrate succeeds
ln -sfn "$NEW_RELEASE" /opt/servora-med/current

# 6) Start application
sudo systemctl start servora-med

# 7) Readiness + smoke
curl -fsS "https://${SERVORA_FQDN:-app.example.com}/api/health"
# Expect: {"status":"ok"}
# Smoke: SPA loads; login works over HTTPS
# Record deployed SHA in external ops notes (no secrets)
```

Do **not**:

- run `node /opt/servora-med/current/server/dist/db/migrate.js` before `ln -sfn`
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
API responses use `Cache-Control: no-store`. Hashed Vite assets under `/assets/*` are immutable; SPA `index.html` is `no-cache`.

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
