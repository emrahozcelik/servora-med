# Local macOS pilot — Cloudflare Tunnel

Pilot Servora-Med on a single Mac without opening inbound ports. Public HTTPS terminates at **Cloudflare Edge**; the Mac only runs loopback services.

This is **not** the developer `npm run dev` path. For day-to-day coding see [README](../../README.md). For Ubuntu VPS see [production-deployment.md](./production-deployment.md).

## Topology

```text
Internet
  → Cloudflare Edge TLS (app.example.com)
    → named Cloudflare Tunnel
      → cloudflared LaunchDaemon (boot; /etc/cloudflared)
        → Caddy http://app.example.com:8080 bind 127.0.0.1 (LaunchDaemon, user servora-med)
          ├── web/dist
          └── /api/* → Fastify 127.0.0.1:3000 (LaunchDaemon, user servora-med)
                         → PostgreSQL localhost (boot service, user servora-postgres)
```

### Hard rules

```text
no router port forwarding
no public Fastify (3000) or PostgreSQL
Caddy binds 127.0.0.1 only; site address uses public Host matcher
Fastify HOST=127.0.0.1
API and backup processes run as servora-med (never root)
PostgreSQL OS process runs as servora-postgres (never root)
session cookie remains host-only
Cloudflare Tunnel ≠ Servora-Med authentication
Cloudflare Tunnel ≠ offsite backup
never commit cert.pem, token, or tunnel credential JSON
canonical DB auth: password-bearing DATABASE_URL (URL-safe hex; no secret on argv; SCRAM host)
```

### Threat boundary (client IP)

- Visitors reach only Cloudflare; Caddy is not on the public internet.
- Caddy trusts client IP headers **only** from loopback (`127.0.0.0/8`, `::1`) where `cloudflared` connects.
- Caddy trusts loopback proxies and forwards `CF-Connecting-IP` as `X-Forwarded-For` plus `X-Forwarded-Proto: https` to Fastify.
- Fastify `TRUSTED_PROXY=loopback` uses that IP for login rate limits.
- A compromised local process on the pilot host could spoof headers to Caddy; that is **host compromise**, not a remote rate-limit bypass.

### Boot-time process model (canonical)

| Component | Boot mechanism | Identity |
|-----------|----------------|----------|
| PostgreSQL | `sudo brew services --sudo-service-user=servora-postgres start postgresql@16` | **servora-postgres** |
| Fastify API | `/Library/LaunchDaemons/com.servora-med.api.plist` | **servora-med** |
| Caddy | `/Library/LaunchDaemons/com.servora-med.caddy.plist` | **servora-med** |
| cloudflared | `sudo cloudflared service install` | official Cloudflare LaunchDaemon |
| Backup timer | `/Library/LaunchDaemons/com.servora-med.backup.plist` | **servora-med** |

Do **not** use login-dependent `brew services start` (without `sudo`) as the pilot install path. Do **not** use bare `sudo brew services start postgresql@16` (that can leave Postgres owned by root or an interactive admin). User LaunchAgents stop when nobody is logged in.

### Reboot acceptance (no interactive login)

```text
reboot Mac
do not log in to a GUI session
PostgreSQL starts; process owner is servora-postgres (not root)
pg_isready -h 127.0.0.1 succeeds
Fastify listens on 127.0.0.1:3000 as servora-med
Caddy responds on 127.0.0.1:8080 with Host: app.example.com
cloudflared shows a connected tunnel
public https://app.example.com/api/health returns {"status":"ok"}
```

Operator-owned until executed on a real Mac: full reboot drill above.

## Supported assumptions

- macOS with Homebrew (Apple Silicon `/opt/homebrew` or Intel `/usr/local`)
- Node.js 22.12+
- PostgreSQL 16+
- Caddy 2.x
- `cloudflared` current stable

## Prerequisites (packages only)

```bash
brew install node@22 postgresql@16 caddy cloudflared
# Do not use non-sudo brew services as the pilot runtime path.
```

## 0. Dedicated service identities (collision-safe UID/GID)

Canonical names:

| Name | Purpose |
|------|---------|
| **servora-med** | Fastify, Caddy, backup (same name as Ubuntu systemd units) |
| **servora-postgres** | PostgreSQL OS process (Homebrew service user) |

Do **not** hardcode `UniqueID` / `PrimaryGroupID` values. Use the repository helper, which:

```text
existing username/group → verify expected identity and non-admin status
new identity → choose an unused UID/GID in a private range
UID/GID already owned by another principal → abort
partial user/group creation → report and abort safely
```

```bash
# From a checkout (or installed release copy of the script):
sudo ./ops/scripts/ensure-macos-service-identity.sh servora-med "Servora-Med Service"
sudo ./ops/scripts/ensure-macos-service-identity.sh servora-postgres "Servora PostgreSQL"
```

Do not run API, backup, or PostgreSQL as an interactive admin user or as **root**.

### Permissions contract

```text
release tree /opt/servora-med: readable by servora-med (e.g. root:servora-med, dirs 0750, files 0640+)
web/dist and server/dist: readable by servora-med
log dir /usr/local/var/log/servora-med: writable by servora-med (0750, owner servora-med)
backup dir /var/backups/servora-med: writable by servora-med (0700, owner servora-med)
private env /etc/servora-med/*.env: root:servora-med mode 0640 (readable by servora-med, not world)
tunnel credentials /etc/cloudflared/<UUID>.json: root:wheel mode 0600 (cloudflared service)
API/backup wrappers /usr/local/libexec/servora-med/*.sh: root:wheel mode 0755
LaunchDaemon plists /Library/LaunchDaemons/com.servora-med.*.plist: root:wheel mode 0644
PostgreSQL data dir (Homebrew): owned by servora-postgres:servora-postgres (not root)
```

```bash
sudo mkdir -p \
  /opt/servora-med \
  /etc/servora-med \
  /usr/local/libexec/servora-med \
  /usr/local/var/log/servora-med \
  /var/backups/servora-med \
  /usr/local/etc

sudo chown root:servora-med /etc/servora-med
sudo chmod 0750 /etc/servora-med
sudo chown servora-med:servora-med /usr/local/var/log/servora-med /var/backups/servora-med
sudo chmod 0750 /usr/local/var/log/servora-med
sudo chmod 0700 /var/backups/servora-med
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

```bash
SHA="$(git rev-parse HEAD)"
ROOT="/opt/servora-med"
sudo mkdir -p "$ROOT/releases/$SHA"
sudo rsync -a server/dist server/package.json server/package-lock.json server/node_modules \
  server/scripts \
  "$ROOT/releases/$SHA/server/"
sudo rsync -a web/dist "$ROOT/releases/$SHA/web/"
sudo rsync -a ops "$ROOT/releases/$SHA/"
sudo ln -sfn "$ROOT/releases/$SHA" "$ROOT/current"
sudo chown -R root:servora-med "$ROOT/releases/$SHA"
sudo chmod -R g+rX "$ROOT/releases/$SHA"
```

## 3. Environment files (private)

Do **not** use the repository `.env` for pilot.

```text
/etc/servora-med/servora-med.env          # API process
/etc/servora-med/servora-med-backup.env   # backup script
```

```bash
sudo cp ops/examples/servora-med.env.example /etc/servora-med/servora-med.env
sudo cp ops/examples/servora-med-backup.env.example /etc/servora-med/servora-med-backup.env
# edit secrets and absolute PG_*_BIN paths for this Mac
sudo chown root:servora-med /etc/servora-med/servora-med.env /etc/servora-med/servora-med-backup.env
sudo chmod 0640 /etc/servora-med/servora-med.env /etc/servora-med/servora-med-backup.env
```

Minimum API keys (canonical **password-bearing DATABASE_URL**):

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGIN=https://app.example.com
TRUSTED_PROXY=loopback
HEALTH_SCHEMA_VERSION=007_sales_meeting
DATABASE_URL=postgresql://servora:<APP_DB_PASSWORD>@127.0.0.1:5432/servora_med
LOG_LEVEL=info
```

`CORS_ORIGIN` must be the **public https** origin users type in the browser.

Do **not** rely on Homebrew default peer/trust authentication for the app role. The API must connect with the password embedded in `DATABASE_URL` under a private env file (`root:servora-med`, mode **0640**). The password must be **URL-safe** (canonical: `openssl rand -hex 32`) or **percent-encoded** in the URL. Never put the password or full `DATABASE_URL` on process **argv** (no `psql "$DATABASE_URL"`). Verify with Node/`pg` and environment only (`server/scripts/verify-db-auth.mjs`). Never print secrets to logs.

### Backup binary paths (absolute)

`ops/examples/servora-med-backup.env.example` requires:

```text
PG_DUMP_BIN
PG_RESTORE_BIN
PSQL_BIN
```

Apple Silicon Homebrew example:

```text
PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump
PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore
PSQL_BIN=/opt/homebrew/opt/postgresql@16/bin/psql
```

Intel Homebrew example:

```text
PG_DUMP_BIN=/usr/local/opt/postgresql@16/bin/pg_dump
PG_RESTORE_BIN=/usr/local/opt/postgresql@16/bin/pg_restore
PSQL_BIN=/usr/local/opt/postgresql@16/bin/psql
```

The backup wrapper sets a minimal `PATH=/usr/bin:/bin` and **refuses** relative `pg_dump` names so launchd cannot pick a random system client.

## 4. PostgreSQL boot service + least-privilege app role

### 4.1 OS identity + data directory

```bash
sudo ./ops/scripts/ensure-macos-service-identity.sh servora-postgres "Servora PostgreSQL"

# Homebrew data directory (Apple Silicon example; Intel uses /usr/local/...):
PG_DATA="$(/opt/homebrew/bin/brew --prefix postgresql@16)/var/postgresql@16"
# First-time init if empty — SCRAM for host TCP, peer for local sockets:
if [[ ! -d "$PG_DATA/base" ]]; then
  sudo mkdir -p "$PG_DATA"
  sudo chown servora-postgres:servora-postgres "$PG_DATA"
  sudo -u servora-postgres /opt/homebrew/opt/postgresql@16/bin/initdb \
    --auth-local=peer \
    --auth-host=scram-sha-256 \
    -D "$PG_DATA"
fi
sudo chown -R servora-postgres:servora-postgres "$PG_DATA"
sudo chmod 0700 "$PG_DATA"
```

**Existing cluster (do not re-run `initdb`):** fail-closed host auth upgrade:

```bash
PG_HBA="$PG_DATA/pg_hba.conf"
# Inspect host rules — refuse silent re-init of data.
grep -E '^(local|host)' "$PG_HBA"
# Replace any host "trust" / "password" (md5-only) rules for app access with scram-sha-256, e.g.:
#   host  all  all  127.0.0.1/32  scram-sha-256
#   host  all  all  ::1/128       scram-sha-256
# Keep local peer for OS bootstrap as servora-postgres if desired.
sudo -u servora-postgres /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D "$PG_DATA" reload
# Then run correct + incorrect password tests (section 4.3 / 4.5).
```

### 4.2 Boot-time PostgreSQL (non-root service user)

```bash
# System LaunchDaemon owned by servora-postgres (survives reboot without GUI login).
sudo brew services \
  --sudo-service-user=servora-postgres \
  start postgresql@16

sudo brew services list | grep postgresql
```

Verify process identity and readiness (no interactive login assumptions):

```bash
# Process owner must be servora-postgres, never root.
pgrep -lf postgres | head
ps -o user=,pid=,command= -c postgres 2>/dev/null || ps aux | grep '[p]ostgres'
# Expect USER column servora-postgres

/opt/homebrew/opt/postgresql@16/bin/pg_isready -h 127.0.0.1
# Intel: /usr/local/opt/postgresql@16/bin/pg_isready -h 127.0.0.1
```

### 4.3 Fail-closed app role + password-bearing DATABASE_URL (no argv secrets)

Do **not** use `createuser -s` (superuser). Application role is **`servora`**.
Canonical auth: **password-bearing `DATABASE_URL`** in `/etc/servora-med/servora-med.env`.
Host TCP auth: **SCRAM-SHA-256**. Bootstrap as OS user **`servora-postgres`** over **local peer** (socket). Never put passwords or DATABASE_URL on process argv.

```bash
# URL-safe password (hex only — safe in URI userinfo without encoding).
APP_DB_PASSWORD="$(openssl rand -hex 32)"

# Write private env files (mode 0640, root:servora-med). Never commit.
# DATABASE_URL=postgresql://servora:${APP_DB_PASSWORD}@127.0.0.1:5432/servora_med
# PGPASSWORD=${APP_DB_PASSWORD}   # backup env only, same secret
sudo chown root:servora-med /etc/servora-med/servora-med.env /etc/servora-med/servora-med-backup.env
sudo chmod 0640 /etc/servora-med/servora-med.env /etc/servora-med/servora-med-backup.env

# Confirm host rules are scram-sha-256 (not trust).
grep -E '^host' "$PG_DATA/pg_hba.conf"

# Bootstrap role via Node parameterized PASSWORD $1 (secret only in env).
RELEASE=/opt/servora-med/current
# Peer/socket admin URL for superuser (no password on argv). Adjust socket dir for your Homebrew install.
SOCKET_DIR="$(sudo -u servora-postgres /opt/homebrew/opt/postgresql@16/bin/psql -d postgres -Atc 'SHOW unix_socket_directories' | awk '{print $1}')"
ADMIN_DATABASE_URL="postgresql:///postgres?host=${SOCKET_DIR}"

sudo -u servora-postgres env -i \
  PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  HOME=/var/empty \
  ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL}" \
  APP_DB_PASSWORD="${APP_DB_PASSWORD}" \
  APP_DB_ROLE=servora \
  APP_DB_NAME=servora_med \
  /opt/homebrew/bin/node "$RELEASE/server/scripts/bootstrap-app-role.mjs"

# Correct password succeeds (Node/pg; DATABASE_URL only in environment).
set -a
# shellcheck disable=SC1091
source /etc/servora-med/servora-med.env
set +a
env -i PATH="/opt/homebrew/bin:/usr/bin:/bin" HOME=/var/empty \
  DATABASE_URL="${DATABASE_URL}" \
  EXPECT_USER=servora \
  /opt/homebrew/bin/node "$RELEASE/server/scripts/verify-db-auth.mjs"

# Wrong password must fail (negative test).
env -i PATH="/opt/homebrew/bin:/usr/bin:/bin" HOME=/var/empty \
  DATABASE_URL="postgresql://servora:wrong-password@127.0.0.1:5432/servora_med" \
  EXPECT_FAIL=1 \
  /opt/homebrew/bin/node "$RELEASE/server/scripts/verify-db-auth.mjs"

unset APP_DB_PASSWORD
```

Never use:

```bash
psql "$DATABASE_URL"
psql -v pass="$APP_DB_PASSWORD"
```

If PostgreSQL is unavailable or the operator lacks permission, these commands **exit non-zero**. Do not append `|| true`.

### 4.4 Migrate + first Admin

```bash
set -a
# shellcheck disable=SC1091
source /etc/servora-med/servora-med.env
set +a

cd /opt/servora-med/current/server
# migrate reads DATABASE_URL from environment only (no URL on argv).
env -i PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  DATABASE_URL="${DATABASE_URL}" \
  /opt/homebrew/bin/node dist/db/migrate.js

export BOOTSTRAP_ORGANIZATION_NAME="…"
export BOOTSTRAP_ADMIN_NAME="…"
export BOOTSTRAP_ADMIN_EMAIL="…"
export BOOTSTRAP_ADMIN_PASSWORD="…"
env -i PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  DATABASE_URL="${DATABASE_URL}" \
  BOOTSTRAP_ORGANIZATION_NAME="${BOOTSTRAP_ORGANIZATION_NAME}" \
  BOOTSTRAP_ADMIN_NAME="${BOOTSTRAP_ADMIN_NAME}" \
  BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL}" \
  BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD}" \
  /opt/homebrew/bin/node dist/db/bootstrap-admin.js
unset BOOTSTRAP_ADMIN_PASSWORD
```

### 4.5 API process as servora-med — DB + health smoke

After launchd API install (section 7):

```bash
# Process identity
pgrep -lf 'dist/index.js' || true
# Must run as servora-med, not root

# DB connectivity as the service user — Node/pg, env only (no psql URL argv).
sudo -u servora-med env -i \
  PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  HOME=/var/empty \
  bash -c 'set -a; source /etc/servora-med/servora-med.env; set +a; \
    exec /opt/homebrew/bin/node /opt/servora-med/current/server/scripts/verify-db-auth.mjs'

# Application readiness (SCRAM path already validated above)
curl -fsS -H 'Host: app.example.com' http://127.0.0.1:3000/api/health
# Expect: {"status":"ok"}
```

## 5. Caddy (tunnel origin) — boot LaunchDaemon

```bash
sudo cp /opt/servora-med/current/ops/caddy/Caddyfile.tunnel.example /usr/local/etc/Caddyfile
# Edit app.example.com → your public hostname
# Edit root paths if release root differs
sudo chown root:servora-med /usr/local/etc/Caddyfile
sudo chmod 0640 /usr/local/etc/Caddyfile

# Validate with the absolute caddy binary for this Mac
/opt/homebrew/bin/caddy validate --config /usr/local/etc/Caddyfile

# Install wrapper-equivalent LaunchDaemon (absolute caddy path inside plist)
sudo cp /opt/servora-med/current/ops/launchd/com.servora-med.caddy.plist.example \
  /Library/LaunchDaemons/com.servora-med.caddy.plist
# Edit ProgramArguments[0] for Intel (/usr/local/bin/caddy) if needed
sudo chown root:wheel /Library/LaunchDaemons/com.servora-med.caddy.plist
sudo chmod 0644 /Library/LaunchDaemons/com.servora-med.caddy.plist
sudo plutil -lint /Library/LaunchDaemons/com.servora-med.caddy.plist
sudo launchctl bootout system/com.servora-med.caddy 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.servora-med.caddy.plist
sudo launchctl enable system/com.servora-med.caddy
sudo launchctl kickstart -k system/com.servora-med.caddy
```

Loopback smoke:

```bash
curl -fsS -H 'Host: app.example.com' http://127.0.0.1:8080/api/health
# Expect: {"status":"ok"} after API is up
```

## 6. Cloudflare named tunnel (canonical pilot)

```bash
cloudflared tunnel login
cloudflared tunnel create servora-med-pilot
# Note UUID; credentials JSON under ~/.cloudflared/<UUID>.json

cloudflared tunnel route dns servora-med-pilot app.example.com

sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<TUNNEL_UUID>.json
sudo chown root:wheel /etc/cloudflared/<TUNNEL_UUID>.json

# Copy and edit ops/cloudflared/config.yml.example → /etc/cloudflared/config.yml
# Ensure hostname and originRequest.httpHostHeader match the public FQDN.
sudo cp /opt/servora-med/current/ops/cloudflared/config.yml.example /etc/cloudflared/config.yml
sudo chmod 0644 /etc/cloudflared/config.yml
```

Validate **with explicit `--config`** so a personal `~/.cloudflared/config.yml` is never used by mistake:

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://app.example.com
cloudflared tunnel list
cloudflared tunnel info servora-med-pilot
```

### Official service install (after config is in `/etc/cloudflared/`)

```bash
# Official macOS LaunchDaemon installer (boot-time).
sudo cloudflared service install
```

Do **not** treat `cloudflared --config … service install` as the documented canonical form once files live under `/etc/cloudflared/`. Login-only `cloudflared service install` (no sudo) is a **development alternative** only.

Service operations:

```bash
sudo launchctl print system/com.cloudflare.cloudflared 2>/dev/null || true
# Logs (path may vary by cloudflared version):
#   /Library/Logs/com.cloudflare.cloudflared.err.log
#   /Library/Logs/com.cloudflare.cloudflared.out.log
# Or:
log show --predicate 'process == "cloudflared"' --last 30m | tail -n 50

# Restart after config changes:
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
# If the label differs on your install, use:
#   sudo launchctl list | grep -i cloud
```

## 7. Fastify API process (launchd)

```bash
sudo install -o root -g wheel -m 0755 \
  /opt/servora-med/current/ops/launchd/start-api.sh.example \
  /usr/local/libexec/servora-med/start-api.sh
# Edit absolute NODE_BIN for Intel if needed (/usr/local/bin/node)

sudo cp /opt/servora-med/current/ops/launchd/com.servora-med.api.plist.example \
  /Library/LaunchDaemons/com.servora-med.api.plist
sudo chown root:wheel /Library/LaunchDaemons/com.servora-med.api.plist
sudo chmod 0644 /Library/LaunchDaemons/com.servora-med.api.plist
sudo plutil -lint /Library/LaunchDaemons/com.servora-med.api.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.servora-med.api.plist
sudo launchctl enable system/com.servora-med.api
sudo launchctl kickstart -k system/com.servora-med.api
```

Confirm process user:

```bash
pgrep -lf 'dist/index.js' || true
# Must not be root.
```

## 8. Backup schedule (launchd)

```bash
sudo install -o root -g wheel -m 0755 \
  /opt/servora-med/current/ops/launchd/run-backup.sh.example \
  /usr/local/libexec/servora-med/run-backup.sh

sudo cp /opt/servora-med/current/ops/launchd/com.servora-med.backup.plist.example \
  /Library/LaunchDaemons/com.servora-med.backup.plist
sudo chown root:wheel /Library/LaunchDaemons/com.servora-med.backup.plist
sudo chmod 0644 /Library/LaunchDaemons/com.servora-med.backup.plist
sudo plutil -lint /Library/LaunchDaemons/com.servora-med.backup.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.servora-med.backup.plist
```

Manual dry run (as service user, minimal PATH):

```bash
sudo -u servora-med env PATH=/usr/bin:/bin \
  /usr/local/libexec/servora-med/run-backup.sh
```

Local backup is **not** offsite. See [backup-restore.md](./backup-restore.md).

## 9. Smoke checks

```bash
curl -fsS https://app.example.com/api/health
# {"status":"ok"}

# Browser: open https://app.example.com → login
# Confirm Secure session cookie on HTTPS public host
```

Rate-limit identity: two different internet clients should not share one login bucket (CF-Connecting-IP → Caddy → Fastify chain).

## 10. Upgrade / rollback

1. Build new release directory with lockfile + `npm ci --omit=dev`.
2. Pre-deploy backup.
3. Stop API (`sudo launchctl bootout system/com.servora-med.api` or kickstart after switch).
4. Migrate with absolute node from the **new** release — never from old `current` before switch.
5. On migrate failure: do not switch `current`; restart previous API.
6. On success: `ln -sfn` new release → `current`; start API.
7. Health + login smoke on public hostname.

## 11. Startup / shutdown order

**Start:** PostgreSQL → Fastify → Caddy → cloudflared
**Stop:** cloudflared → Caddy → Fastify → (PostgreSQL only if host maintenance)

Backup timer is calendar-based and independent of request path.

## 12. Host availability checklist (operator)

```text
[ ] Mac stays powered and networked during pilot hours
[ ] Sleep disabled or prevented while pilot is live
[ ] Auto power-on after power loss configured if required
[ ] Disk encryption (FileVault) remains enabled
[ ] Pilot OS account is not a daily personal admin account
[ ] Service identity servora-med is non-admin
[ ] Tunnel credentials mode 600; not in git
[ ] Reboot acceptance (section above) executed at least once
```

## 13. Troubleshooting

| Symptom | Check |
|---------|--------|
| `health` unavailable | Postgres up? migrate done? `HEALTH_SCHEMA_VERSION` matches? |
| 502 at Cloudflare | Caddy/Fastify running? Host header match? `httpHostHeader`? |
| Login CSRF/Origin errors | `CORS_ORIGIN` exact public `https://` origin? |
| Wrong rate-limit sharing | Caddy `trusted_proxies` / `client_ip_headers` / `header_up X-Forwarded-*`? |
| Tunnel not after reboot | `sudo cloudflared service install`? `/etc/cloudflared` config? |
| Backup picks wrong pg_dump | Absolute `PG_*_BIN` in backup env? wrapper minimal PATH? |
| API running as root | `UserName`/`GroupName` in plist? wrappers installed correctly? |

Do not share passwords, cookies, Authorization headers, or full `DATABASE_URL` when escalating issues.

## Status honesty

| Capability | Status |
|------------|--------|
| Local scheduled backup scripts | available in repository |
| Disposable restore automated tests | available with `TEST_DATABASE_URL` |
| Host restore rehearsal record | pending until executed here |
| Real offsite copy | pending destination + credentials |
| Live public hostname cutover | operator-owned |
