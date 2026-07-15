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
| `/etc/servora-med/servora-med.env` | App environment (root:servora-med, 0640) |
| `/var/backups/servora-med` | Local backups (0700) |
| `/var/log/servora-med` | Backup/restore ops logs |

## Environment

See `ops/examples/servora-med.env.example` and design §6.

Required production highlights:

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `CORS_ORIGIN=https://<FQDN>`
- `TRUSTED_PROXY=loopback`
- `DATABASE_URL` PostgreSQL only (prefer peer/`PGPASSFILE`, never log the URL)

## Build release

On a clean builder with Node 22:

```bash
cd server && npm ci && npm run build
cd ../web && npm ci && npm run build
```

Copy `server/` (including `dist/`, `package.json`, lockfile if needed for audit)  
and `web/dist/`, plus `ops/` into `/opt/servora-med/releases/<git-sha>/`.

## Deploy sequence

```text
1. Pre-deploy backup: ops/scripts/backup-postgres.sh
2. systemctl stop servora-med
3. migrate:prod with EnvironmentFile loaded
4. ln -sfn releases/<sha> /opt/servora-med/current
5. systemctl start servora-med
6. Wait for GET https://<FQDN>/api/health → 200 {"status":"ok"}
7. Smoke: SPA loads; login works over HTTPS
8. Record deployed SHA in external ops notes
```

Production scripts:

```bash
# From /opt/servora-med/current/server with env loaded
node dist/db/migrate.js          # npm run migrate:prod
node dist/index.js               # npm run start:prod (via systemd)
node dist/db/bootstrap-admin.js  # one-shot only
```

**Do not** run migrations on every process start. `start:prod` never migrates.

### Rollback

- Application: repoint `current` to previous release **only if** schema is still compatible.
- Database: forward-only; no automated destructive rollback.

## systemd

Install units from `ops/systemd/`:

```bash
sudo cp ops/systemd/servora-med.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now servora-med
```

Backup timer:

```bash
sudo cp ops/systemd/servora-med-backup.* /etc/systemd/system/
sudo systemctl enable --now servora-med-backup.timer
```

## Caddy

Example: `ops/caddy/Caddyfile.example`.  
Set FQDN; ensure reverse_proxy to `127.0.0.1:3000`; strip Cookie/Authorization from access logs.

## Health

```http
GET /api/health
200 {"status":"ok"}           # DB reachable and schema present
503 {"status":"unavailable"}  # otherwise — no infrastructure details
```

## Non-goals

Docker/K8s, multi-region, HA, auto-deploy from CI, product backup UI.
