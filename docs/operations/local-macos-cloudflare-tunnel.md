# Local macOS pilot — Cloudflare Tunnel

Pilot Servora-Med on a single Mac without opening inbound ports. Public HTTPS terminates at **Cloudflare Edge**; the Mac only runs loopback services.

This is **not** the developer `npm run dev` path. For day-to-day coding see [README](../../README.md). For Ubuntu VPS see [production-deployment.md](./production-deployment.md).

## Topology

```text
Internet
  → Cloudflare Edge TLS (app.example.com)
    → named Cloudflare Tunnel
      → cloudflared LaunchDaemon (boot)
        → Caddy http://127.0.0.1:8080  (Host: app.example.com)
          ├── web/dist
          └── /api/* → Fastify 127.0.0.1:3000
                         → PostgreSQL localhost
```

### Hard rules

```text
no router port forwarding
no public Fastify (3000) or PostgreSQL
Caddy binds 127.0.0.1 only
Fastify HOST=127.0.0.1
session cookie remains host-only
Cloudflare Tunnel ≠ Servora-Med authentication
Cloudflare Tunnel ≠ offsite backup
never commit cert.pem, token, or tunnel credential JSON
```

### Threat boundary (client IP)

- Visitors reach only Cloudflare; Caddy is not on the public internet.
- Caddy trusts client IP headers **only** from loopback (`127.0.0.0/8`, `::1`) where `cloudflared` connects.
- Caddy sets `CF-Connecting-IP` → `{client_ip}` and forwards `X-Forwarded-For: {client_ip}` plus `X-Forwarded-Proto: https` to Fastify.
- Fastify `TRUSTED_PROXY=loopback` uses that IP for login rate limits.
- A compromised local process on the pilot host could spoof headers to Caddy; that is **host compromise**, not a remote rate-limit bypass. Do not claim “all local spoof is impossible.”

## Supported assumptions

- macOS with Homebrew (Apple Silicon `/opt/homebrew` or Intel `/usr/local`)
- Node.js 22.12+
- PostgreSQL 16+
- Caddy 2.x
- `cloudflared` current stable

## Prerequisites (Homebrew)

```bash
brew install node@22 postgresql@16 caddy cloudflared
brew services start postgresql@16
# Ensure node 22 is on PATH for the pilot user
```

## 1. Release directory layout

```text
/opt/servora-med/releases/<git-sha>/
  server/dist
  server/package.json
  server/package-lock.json
  server/node_modules   # npm ci --omit=dev
  web/dist
  ops/
/opt/servora-med/current → releases/<git-sha>
```

On Apple Silicon without `/opt`, use an equivalent absolute pilot root (document your choice) but keep **absolute paths** in launchd wrappers.

## 2. Build production artifacts

```bash
git clone https://github.com/emrahozcelik/servora-med.git
cd servora-med
git checkout <pilot-tag-or-main-sha>

cd server
npm ci
npm run build
npm ci --omit=dev

cd ../web
npm ci
npm run build
```

Copy into the release directory (adjust root as needed):

```bash
SHA="$(git rev-parse HEAD)"
ROOT="/opt/servora-med"
sudo mkdir -p "$ROOT/releases/$SHA"
sudo rsync -a server/dist server/package.json server/package-lock.json server/node_modules \
  "$ROOT/releases/$SHA/server/"
sudo rsync -a web/dist "$ROOT/releases/$SHA/web/"
sudo rsync -a ops "$ROOT/releases/$SHA/"
sudo ln -sfn "$ROOT/releases/$SHA" "$ROOT/current"
```

## 3. Environment files (private)

Do **not** use the repository `.env` for pilot. Install:

```text
/etc/servora-med/servora-med.env          # API process
/etc/servora-med/servora-med-backup.env   # backup script
```

Minimum API keys (see `ops/examples/servora-med.env.example`):

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGIN=https://app.example.com
TRUSTED_PROXY=loopback
HEALTH_SCHEMA_VERSION=007_sales_meeting
DATABASE_URL=postgresql://…@127.0.0.1:5432/servora_med
LOG_LEVEL=info
```

`CORS_ORIGIN` must be the **public https** origin users type in the browser.

## 4. Database, migrate, first Admin

```bash
createuser -s servora 2>/dev/null || true
createdb -O servora servora_med

set -a
source /etc/servora-med/servora-med.env
set +a

cd /opt/servora-med/current/server
node dist/db/migrate.js

# One-shot bootstrap (env vars only; never commit passwords)
export BOOTSTRAP_ORGANIZATION_NAME="…"
export BOOTSTRAP_ADMIN_NAME="…"
export BOOTSTRAP_ADMIN_EMAIL="…"
export BOOTSTRAP_ADMIN_PASSWORD="…"
node dist/db/bootstrap-admin.js
unset BOOTSTRAP_ADMIN_PASSWORD
```

## 5. Caddy (tunnel origin)

```bash
sudo mkdir -p /usr/local/var/log/servora-med
sudo cp /opt/servora-med/current/ops/caddy/Caddyfile.tunnel.example /usr/local/etc/Caddyfile
# Edit app.example.com → your hostname
# Edit root paths if release root differs

# Validate
caddy validate --config /usr/local/etc/Caddyfile

# Run (example; prefer brew services or a dedicated launchd if preferred)
caddy run --config /usr/local/etc/Caddyfile
```

Confirm loopback only:

```bash
curl -fsS -H 'Host: app.example.com' http://127.0.0.1:8080/api/health
# Expect: {"status":"ok"}
```

## 6. Cloudflare named tunnel (canonical pilot)

Official locally managed tunnel flow (create → DNS → config → service).

```bash
cloudflared tunnel login
cloudflared tunnel create servora-med-pilot
# Note UUID; credentials JSON written under ~/.cloudflared/<UUID>.json

cloudflared tunnel route dns servora-med-pilot app.example.com
```

Install **boot-time** service (preferred for pilot availability):

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<TUNNEL_UUID>.json

# Copy and edit ops/cloudflared/config.yml.example → /etc/cloudflared/config.yml
sudo cloudflared --config /etc/cloudflared/config.yml service install
```

Per Cloudflare macOS docs: `sudo cloudflared service install` installs a **LaunchDaemon** that starts at boot and expects configuration under `/etc/cloudflared/`. User-level `cloudflared service install` (no sudo) is login-dependent LaunchAgent — use only as a **dev alternative**, not the pilot default.

Validate (always pass `--config` when testing non-default paths so you do not hit a personal `~/.cloudflared/config.yml`):

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://app.example.com
cloudflared tunnel list
cloudflared tunnel info servora-med-pilot
```

## 7. Fastify API process (launchd)

1. Create wrapper `/usr/local/libexec/servora-med/start-api.sh` (see comments in `ops/launchd/com.servora-med.api.plist.example`).
2. Point `ProgramArguments` at that wrapper with absolute Homebrew `node` path.
3. `sudo plutil -lint /Library/LaunchDaemons/com.servora-med.api.plist`
4. `sudo launchctl bootstrap system /Library/LaunchDaemons/com.servora-med.api.plist`

## 8. Backup schedule (launchd)

1. Install `servora-med-backup.env` (see `ops/examples/servora-med-backup.env.example`).
2. Wrapper runs `ops/scripts/backup-postgres.sh`.
3. Install `com.servora-med.backup.plist.example` as LaunchDaemon.
4. `plutil -lint` before load.

Local backup is **not** offsite. See [backup-restore.md](./backup-restore.md).

## 9. Smoke checks

```bash
curl -fsS https://app.example.com/api/health
# {"status":"ok"}

# Browser: open https://app.example.com → login
# Confirm Secure session cookie on HTTPS public host
```

Rate-limit identity: two different internet clients should not share one login bucket (depends on CF-Connecting-IP → Caddy → Fastify chain above).

## 10. Upgrade / rollback

1. Build new release directory with lockfile + `npm ci --omit=dev`.
2. Pre-deploy backup.
3. Stop API (and optionally Caddy briefly).
4. `node /opt/servora-med/releases/<new>/server/dist/db/migrate.js` — **never** from old `current` before switch.
5. On migrate failure: do not switch `current`; restart previous API.
6. On success: `ln -sfn` new release → `current`; start API.
7. Health + login smoke on public hostname.

## 11. Startup / shutdown order

**Start:** PostgreSQL → Fastify → Caddy → cloudflared  
**Stop:** cloudflared → Caddy → Fastify → (PostgreSQL only if host maintenance)

## 12. Host availability checklist (operator)

```text
[ ] Mac stays powered and networked during pilot hours
[ ] Sleep disabled or prevented while pilot is live
[ ] Auto power-on after power loss configured if required
[ ] Disk encryption (FileVault) remains enabled
[ ] Pilot OS account is not a daily personal admin account
[ ] Tunnel credentials mode 600; not in git
```

## 13. Troubleshooting

| Symptom | Check |
|---------|--------|
| `health` unavailable | Postgres up? migrate done? `HEALTH_SCHEMA_VERSION` matches? |
| 502 at Cloudflare | Caddy/Fastify running? `curl` loopback health? |
| Login CSRF/Origin errors | `CORS_ORIGIN` exact public `https://` origin? |
| Wrong rate-limit sharing | Caddy `trusted_proxies` / `client_ip_headers` / `header_up X-Forwarded-*`? |
| Tunnel not after reboot | LaunchDaemon installed with sudo? `/etc/cloudflared` config active? |

Do not share passwords, cookies, Authorization headers, or full `DATABASE_URL` when escalating issues.

## Status honesty

| Capability | Status |
|------------|--------|
| Local scheduled backup scripts | available in repository |
| Disposable restore automated tests | available with `TEST_DATABASE_URL` |
| Host restore rehearsal record | pending until executed here |
| Real offsite copy | pending destination + credentials |
