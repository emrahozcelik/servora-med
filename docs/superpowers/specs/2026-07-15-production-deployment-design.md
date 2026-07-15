# Slice 11 — Production Deployment, Backup, and Hardening

> **Status:** Approved design; implementation verified on feature branch  
> **Baseline:** `main` @ `23031b39599e3f16fab232987a288577aad717f4`  
> **Date:** 2026-07-15  
> **Scope:** Public VPS pilot readiness — configuration, reverse proxy, process lifecycle, backup/restore, verification  
> **Out of scope:** domain features, Docker/K8s, HA, auto-deploy, observability platforms, WebSocket

---

## 1. Purpose

Ship a **repeatable, restorable, public-VPS-safe** operating contract for Servora-Med after domain slices 01–10.

Success means:

1. Production config rejects unsafe network, CORS, and bind settings.
2. Fastify sits behind Caddy TLS on loopback only.
3. Login rate limiting uses the real client IP from a **trusted** proxy hop.
4. Public health reports only generic readiness (no infrastructure leak).
5. Deploys use an explicit migration step (not silent mutate-on-start).
6. Backups and restore rehearsals are scripted, logged externally, and safe-by-default.
7. systemd + Caddy units contain **no secret literals**.

---

## 2. Current-state audit (producer × consumer × test)

### 2.1 Already correct (verify, harden, do not redesign)

| Area | Current evidence |
|------|------------------|
| Exact CORS origin + credentials | `loadConfig` + `@fastify/cors` |
| Production unsafe-method Origin | `buildApp` `onRequest` vs `corsOrigin` |
| Session cookie | HttpOnly, SameSite=Lax, path `/`, Secure when `NODE_ENV=production` |
| Login rate limit | `@fastify/rate-limit` on `POST /api/auth/login` |
| Logger redaction **paths** | `LOGGER_REDACT_PATHS` in `app.ts`; unit list test only |
| Public health shape | `{ status: 'ok' }` — always 200 today |
| SIGINT/SIGTERM | `index.ts` flags + `app.close` + pool end |
| Migration runner | SQL files + `schema_migrations` in transaction |
| CI PostgreSQL | `.github/workflows/ci.yml` postgres:17 + migrate + test |

### 2.2 Findings

#### Blocker

| ID | Finding | Risk |
|----|---------|------|
| B1 | No explicit `trustProxy` / trusted hop | Behind Caddy, rate limit keys may collapse to one proxy IP or accept spoofed `X-Forwarded-For` if trust is opened carelessly |
| B2 | Production allows `http://` CORS origin | Cookie `Secure` + public HTTP origin mismatch; non-TLS pilot |
| B3 | Health always 200, no DB/schema probe | Load balancer / smoke checks cannot detect dead DB or missing migrations |
| B4 | `start` runs `runMigrations` before listen | Accidental schema mutation on every service restart; concurrent multi-instance race |
| B5 | No production-only scripts | Operators use `tsx`/`--env-file=.env` patterns unsuitable for systemd |
| B6 | No backup/restore/offsite/rehearsal artifacts | Pilot cannot claim restorable ops |
| B7 | No systemd/Caddy production guides | Topology and TLS left to tribal knowledge |
| B8 | Log redaction not proven on serialized output | Path list can drift from real Pino output |

#### Important

| ID | Finding | Risk |
|----|---------|------|
| I1 | Pool uses only `connectionString` | No production max/timeout/`application_name` |
| I2 | Shutdown has no timeout/exit-code contract | systemd may kill mid-drain; failures can hang |
| I3 | Migration has no advisory lock | Two migrate jobs can interleave poorly if operators err |
| I4 | Production bind not constrained | `HOST=0.0.0.0` would expose API if firewall fails |
| I5 | `LOG_LEVEL` unrestricted string | Typos → silent/noisy logs |
| I6 | `DATABASE_URL` not scheme-checked | Non-Postgres URLs fail late |
| I7 | API draft mentions admin `GET /api/health/detailed` | Not implemented; public readiness is the MVP deliverable — detailed stays **deferred** |

#### Optional

| ID | Finding | Decision |
|----|---------|----------|
| O1 | Nginx alternative full config | Architecture mentions Nginx **or** Caddy; Slice 11 ships **Caddy only** as canonical |
| O2 | Automatic offsite provider | Provider-neutral hook + encryption requirement; no fake “offsite complete” |
| O3 | Zero-downtime multi-instance | Explicitly out of MVP |

---

## 3. One-time target decision packet

Values **not** derivable from the repository. Working defaults below; replace before real VPS cutover. Design and plan use these placeholders; scripts remain parameterised.

| Decision | Working default | Notes |
|----------|-----------------|-------|
| Production FQDN | `app.example.com` | Operator must set real FQDN; CORS = `https://<FQDN>` |
| VPS OS | Ubuntu Server 24.04 LTS | systemd, Caddy apt/repo, Node 22 |
| Release root | `/opt/servora-med` | `releases/<sha>`, `current` symlink |
| Data / runtime | `/var/lib/servora-med` | app-owned non-secret state if any |
| Local backup dir | `/var/backups/servora-med` | mode `0700`, owner `servora-med` or backup user |
| Ops log dir | `/var/log/servora-med` | backup/restore operation logs (not app secrets) |
| Environment file | `/etc/servora-med/servora-med.env` | root-owned `0640`, group `servora-med` |
| PostgreSQL topology | **Local private** on same VPS | listen localhost only; not public internet |
| Offsite class | Provider-neutral encrypted copy hook | rsync-over-SSH **or** S3-compatible object storage; not implemented as product code |
| Backup schedule | Daily 02:30 UTC + pre-deploy | Local retain **7 days**; offsite retain **≥30 days** |
| RPO / RTO targets | RPO 24h / RTO 4h | Pilot operational targets, not SLA marketing |

No other operator questions are required to implement the repository deliverables.

---

## 4. Topology

```text
Internet
  │
  ▼
Caddy :443 (TLS, static web + /api reverse_proxy)
  │
  ├── file_server → /opt/servora-med/current/web/dist
  └── reverse_proxy → 127.0.0.1:3000  (Fastify)
                          │
                          ▼
                   PostgreSQL 16+ on 127.0.0.1:5432
                          │
              backup scripts → /var/backups/servora-med
                          │
              optional offsite hook → external encrypted store
```

Invariants:

- Fastify binds **only** `127.0.0.1` in production.
- PostgreSQL is not exposed to the public internet.
- Public firewall allows 80/443 only (plus SSH restricted).
- Same origin: `https://<FQDN>/` and `https://<FQDN>/api/*`.
- Session cookie remains **host-only** (no `Domain=` attribute).

---

## 5. Threat and failure boundaries

| Threat / failure | Control |
|------------------|---------|
| CSRF / cross-origin write | Exact CORS + production Origin check on non-safe methods |
| Credential theft via logs | Pino redact + tests on serialized lines |
| Rate-limit bypass / collapse | Trusted proxy hop only; rate key = client IP after trust |
| Schema drift on restart | Migrate is explicit `migrate:prod`, not part of `start:prod` |
| Silent backup failure | `set -e`, non-zero exit, partial cleanup, external ops log |
| Restore onto production | Script guard refuses production DSN / same-host production name |
| Secret in unit files | `EnvironmentFile=` only; examples use placeholders |
| Partial deploy | Immutable release dir + smoke after switch |
| Shutdown hang | Close timeout + non-zero exit on failure |

---

## 6. Exact environment contract

### 6.1 Variables

| Name | Production | Rules |
|------|------------|--------|
| `NODE_ENV` | required `production` | only `development` \| `test` \| `production` |
| `HOST` | required `127.0.0.1` | production **rejects** non-loopback |
| `PORT` | default `3000` | 1–65535 integer |
| `DATABASE_URL` | required | must start with `postgresql://` or `postgres://`; no credentials in logs |
| `LOG_LEVEL` | default `info` | allowlist: `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `CORS_ORIGIN` | required | single origin; production **https only**; no path/query/hash/wildcard |
| `SESSION_TTL_SECONDS` | default `28800` | positive integer |
| `LOGIN_RATE_LIMIT_MAX` | default `5` | positive integer |
| `RATE_LIMIT_WINDOW_MS` | default `60000` | positive integer |
| `TRUSTED_PROXY` | required in production | see §7 |
| `HEALTH_SCHEMA_VERSION` | optional | if set, readiness requires this migration version present; if unset, “at least one applied + DB reachable” |

Bootstrap / seed vars stay out of the long-running service unit (`BOOTSTRAP_*`, `DEV_SEED_*` only for one-shot CLIs).

### 6.2 Production rejection matrix

Reject (fail process start) when:

```text
NODE_ENV=production and CORS_ORIGIN missing
CORS_ORIGIN is * or multi-value
CORS_ORIGIN has path, query, or hash
CORS_ORIGIN uses http: in production
HOST is not 127.0.0.1 or ::1 in production
DATABASE_URL missing or non-Postgres scheme
LOG_LEVEL not in allowlist
TRUSTED_PROXY missing/invalid in production
PORT / positive integers invalid
```

Development/test may keep `http://127.0.0.1:5173` CORS and unrestricted host for local work.

### 6.3 Runtime scripts (`server/package.json`)

| Script | Behavior |
|--------|----------|
| `build` | unchanged — `tsc` + copy migrations |
| `start:prod` | `node dist/index.js` — **no** auto-migrate; no required repo `.env` |
| `migrate:prod` | `node dist/db/migrate.js` — applies pending migrations under advisory lock |
| `bootstrap:admin:prod` | `node dist/db/bootstrap-admin.js` — one-shot; env from process environment |

Compiled `dist` must include migrate and bootstrap entrypoints (extend build as needed). systemd and operators must **not** depend on `tsx` or repository `.env` for production.

---

## 7. Trusted proxy and client IP

### 7.1 Topology assumption

Exactly **one** reverse-proxy hop: Caddy on the same host → Fastify on loopback.

### 7.2 Config

```text
TRUSTED_PROXY=loopback
```

Allowed production values:

| Value | Meaning |
|-------|---------|
| `loopback` | Trust proxy only when the immediate peer is loopback (`127.0.0.1` / `::1`) — **canonical** |
| `127.0.0.1` | Explicit IPv4 loopback peer only |
| `::1` | Explicit IPv6 loopback peer only |

Reject: `true`, `*`, empty, multi-hop lists, public CIDRs (pilot does not need multi-hop).

### 7.3 Fastify behavior

- Construct Fastify with `trustProxy` set from the validated config (boolean or address matching the chosen mode — **never** bare `true` for “trust everyone”).
- `request.ip` after trust must be the client IP Caddy forwards, not `127.0.0.1`, for rate limiting.
- Direct connections that are **not** from the trusted peer must not honor client-supplied `X-Forwarded-For` for rate-limit identity (spoof resistance).

### 7.4 Caddy obligation

Caddy must set standard forwarding headers for the reverse_proxy hop (default Caddy behavior is acceptable if documented). Fastify trusts only the single loopback peer.

### 7.5 Rate-limit test matrix

| Case | Expected |
|------|----------|
| Two different client IPs via trusted proxy headers | Independent login counters |
| Spoofed `X-Forwarded-For` from untrusted direct peer | Not treated as distinct clients / not trusted |
| Production without `TRUSTED_PROXY` | Config load fails |

---

## 8. Health / readiness

### 8.1 Public contract

```http
GET /api/health
```

| Condition | Status | Body |
|-----------|--------|------|
| DB accepts a trivial query **and** `schema_migrations` has required readiness | `200` | `{"status":"ok"}` |
| DB unreachable, query fails, or required schema not current | `503` | `{"status":"unavailable"}` |

Public body **must not** include: database host/name, migration filenames/versions, exception text, filesystem paths, env values, dependency versions.

### 8.2 Implementation notes

- Health module receives a narrow port: `checkReadiness(): Promise<'ok' | 'unavailable'>`.
- Default readiness: `SELECT 1` + `SELECT COUNT(*) FROM schema_migrations` > 0 (or exact `HEALTH_SCHEMA_VERSION` match when set).
- Failures: log safe category (`health_db_unreachable`, `health_schema_missing`) without credentials or full URL.
- No product-domain health table; no admin detailed endpoint in this slice (API draft `/detailed` deferred).

### 8.3 Smoke use

Deploy and systemd health checks call only this generic endpoint.

---

## 9. Runtime application changes

| Area | Change |
|------|--------|
| `config.ts` | Production HTTPS CORS; host loopback; log level allowlist; Postgres URL scheme; `trustedProxy`; optional health schema version |
| `app.ts` | `trustProxy` from config; inject health readiness port |
| `index.ts` | **Remove** migrate-on-start; hardened shutdown with timeout + exit codes; startup failure cleanup preserved |
| `db/index.ts` | Production pool options: `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `application_name=servora-med` |
| `db/migrate-runner.ts` / store | Session `pg_advisory_lock` around migrate batch |
| `health/*` | Readiness probe + 200/503 |
| `package.json` | `start:prod`, `migrate:prod`, `bootstrap:admin:prod` |
| `.env.example` | Document new vars; production notes |
| Tests | See §16 |

No new npm dependencies for ops scripts (bash + `pg_dump`/`pg_restore`).

---

## 10. Deploy sequence

Immutable release model under `/opt/servora-med`:

```text
1. Build artifact on CI or clean builder (server + web)
2. Copy release to /opt/servora-med/releases/<git-sha>
3. Verify release contains server/dist and web/dist
4. Pre-deploy backup (ops/scripts/backup-postgres.sh)
5. systemctl stop servora-med   # drain
6. sudo -u servora-med EnvironmentFile=... migrate:prod
7. ln -sfn releases/<git-sha> current
8. systemctl start servora-med
9. Wait for GET https://<FQDN>/api/health → 200
10. Smoke: login page loads; health ok; optional authenticated me
11. Record deployed SHA in external ops log / release notes
```

### 10.1 Migration / rollback policy

- **Forward-only** DB migrations in production.
- No automatic destructive DB rollback tooling.
- Application code may roll back to previous `current` symlink **only if** schema is backward-compatible with that release.
- Policy: every migration in this repo must remain compatible with the immediately previous app release for at least one deploy window (additive schema preferred; breaking changes require multi-step releases).
- Concurrent migrate: single advisory lock; second migrate waits or fails clearly.

### 10.2 Startup

`start:prod` must not apply migrations. Fresh empty DB will be `503` until `migrate:prod` succeeds — intentional.

---

## 11. Graceful shutdown

```text
on SIGTERM or SIGINT:
  if already shutting down → ignore
  mark shutting down
  stop accepting new connections (app.close)
  await in-flight request drain with timeout T=25s
  finally close DB pool
  exit 0 on clean close
  exit 1 on timeout or close error
```

systemd:

```text
TimeoutStopSec=30
KillMode=mixed
```

Startup failure path already closes app + pool and sets `exitCode=1`; keep and test.

No unhandled rejection from shutdown async work (attach `.catch` or await in signal handler with process.exit).

---

## 12. systemd contract

Artifacts:

```text
ops/systemd/servora-med.service
ops/systemd/servora-med-backup.service
ops/systemd/servora-med-backup.timer
ops/examples/servora-med.env.example
```

### 12.1 `servora-med.service` (long-running)

| Directive | Value / intent |
|-----------|----------------|
| `User` / `Group` | `servora-med` |
| `WorkingDirectory` | `/opt/servora-med/current/server` |
| `EnvironmentFile` | `-/etc/servora-med/servora-med.env` |
| `Environment=NODE_ENV=production` | explicit |
| `ExecStart` | `/usr/bin/node dist/index.js` (or full path to Node 22) |
| `Restart` | `on-failure` |
| `RestartSec` | `5` |
| `TimeoutStopSec` | `30` |
| `UMask` | `0077` |
| `NoNewPrivileges` | `true` |
| `PrivateTmp` | `true` |
| `ProtectSystem` | `strict` |
| `ProtectHome` | `true` |
| `ReadWritePaths` | only paths the app must write (none required for MVP if logs go to journal) |
| `After` / `Wants` | `network-online.target` `postgresql.service` (if local) |

Logging: journald (`StandardOutput=journal`). No secrets in unit files.

### 12.2 Backup oneshot + timer

- `servora-med-backup.service`: `Type=oneshot`, runs `ops/scripts/backup-postgres.sh`
- `servora-med-backup.timer`: daily `OnCalendar=*-*-* 02:30:00 UTC` (adjustable)

---

## 13. Caddy contract

Artifact: `ops/caddy/Caddyfile.example`

```text
https://{$SERVORA_FQDN} {
  encode gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    X-Frame-Options DENY
    -Server
  }

  handle /api/* {
    reverse_proxy 127.0.0.1:3000
  }

  handle {
    root * /opt/servora-med/current/web/dist
    try_files {path} /index.html
    file_server
  }

  @immutable path *.js *.css *.woff2
  header @immutable Cache-Control "public, max-age=31536000, immutable"

  @index path /index.html /
  header @index Cache-Control "no-cache"
}
```

Additional requirements:

- Automatic HTTPS (Caddy defaults).
- HTTP→HTTPS redirect (Caddy defaults for site block).
- No reverse_proxy caching of API.
- Do not log `Cookie` or `Authorization` (Caddy log field filters documented).
- Request body size and timeouts reviewed in guide (align with upload needs; MVP default Caddy limits OK).
- Nginx: architecture-level alternative only — no second full guide in Slice 11.

---

## 14. Backup contract

Artifact: `ops/scripts/backup-postgres.sh`

### 14.1 Behavior

```bash
set -Eeuo pipefail
umask 077
```

| Requirement | Implementation |
|-------------|----------------|
| Protected dir | `BACKUP_DIR` mode `0700` |
| Filename | `servora-med-YYYYMMDDTHHMMSSZ.dump` (UTC) |
| Format | `pg_dump -Fc --no-owner --no-acl` |
| Atomicity | write `*.partial` → fsync → rename |
| Checksum | `sha256sum` sidecar `*.sha256` |
| Failure | non-zero exit; remove partial; log failure |
| Concurrency | `flock` on lockfile under backup dir |
| Secrets | use `PGPASSFILE` or `PGSERVICEFILE` — **never** pass password on argv; never echo `DATABASE_URL` |
| Ops log | append-only line: ISO time, result, final path, checksum, duration — **no** password/URL |

Env inputs (names only in docs):

```text
BACKUP_DIR
PGHOST PGPORT PGUSER PGDATABASE
PGPASSFILE   # preferred
OPS_LOG
```

No product `backup_status` table.

### 14.2 Retention (local)

- Keep last **7** successful dumps (+ checksums).
- Pre-deploy backup always taken; tagged or named so retention does not delete “latest pre-deploy” until next success (simple: retention by age mtime ≥ 7 days).

### 14.3 Offsite policy

```text
class: provider-neutral hook
requirement: encrypted transport and at-rest storage
checksum: verify after copy
failure: non-zero exit + ops log
credentials: separate from app env file where practical
retention: ≥ 30 days offsite
RPO: 24h  RTO: 4h
```

Document `OFFSITE_COPY_CMD` optional hook invoked after local success. Do **not** claim offsite complete unless the hook runs successfully.

---

## 15. Restore contract

Artifact: `ops/scripts/restore-rehearsal.sh` + `docs/operations/backup-restore.md` + `docs/operations/restore-rehearsals/`

### 15.1 Hard guards

Refuse to run when:

```text
target DSN host is production app host name configured as PRODUCTION_PGHOST
target database name equals PRODUCTION_PGDATABASE
operator did not pass --i-accept-destructive-restore on disposable target
backup checksum mismatch
```

### 15.2 Happy path

```text
1. verify *.sha256
2. create or recreate disposable database
3. pg_restore --no-owner --no-acl
4. verify schema_migrations non-empty / expected versions present
5. critical smoke: users count ≥ 0 query; job_cards select limit 1
6. optional: curl readiness against a staging app bound to that DB
7. record rehearsal file under docs/operations/restore-rehearsals/
8. cleanup disposable DB unless --keep
```

### 15.3 Rehearsal record fields

```text
date/time (UTC)
operator
application SHA
backup timestamp + filename
checksum
safe target identifier (db name only, not password URL)
duration
result (pass/fail)
follow-up action
```

Cadence: **required once before first production pilot traffic**; monthly thereafter (ops policy, not automated product).

---

## 16. Logging contract

| Layer | Rule |
|-------|------|
| App (Pino) | Redact paths already listed; add tests capturing **serialized** log lines for password fields, Cookie, Set-Cookie, Authorization, raw token, connection string password |
| Backup/restore scripts | Ops log without secrets |
| Caddy | No Cookie/Authorization in access logs |
| systemd | journal; no secrets in unit |

Redaction verification is a **blocker acceptance** for Slice 11 closeout.

---

## 17. PostgreSQL runtime config

`createDatabase` production defaults (overridable later only if needed):

```text
max: 20
connectionTimeoutMillis: 5000
idleTimeoutMillis: 30000
application_name: servora-med
```

SSL:

- Local private VPS Postgres: typically no TLS on localhost — document as acceptable.
- Managed DB (if later): require SSL in URL (`sslmode=require`) — document; do not force in local default.

---

## 18. Test matrix

### Automated

| Suite | Coverage |
|-------|----------|
| config unit | production rejection/acceptance matrix §6.2 |
| proxy unit/integration | trusted loopback; spoofed header; rate-limit separation |
| health | 200 when ready; 503 when DB down / schema missing; body shape only |
| log redaction | real Pino destination capture |
| shutdown | success, failure/timeout exit code, double-signal idempotency |
| migrate lock | second concurrent migrate serializes or waits under advisory lock |
| backup script | success path, failure path, partial cleanup, atomic rename, flock (bats or bash+fixtures) |
| restore script | production-target guard refuses |
| bash | `bash -n` on ops scripts |
| systemd | `systemd-analyze verify` when runner has systemd (CI optional skip with message) |
| Caddy | config parse / static fixture smoke where tool available; else documented manual |
| server ordinary + PG | full existing suite green |
| server build + audit | pass |
| web suite + build + audit | pass |
| git diff --check | pass |
| clean worktree | pass |

### Manual VPS acceptance (not claimed unless performed)

```text
install units
load env from /etc
migrate:prod
start service
Caddy TLS cert issued
health 200
login works over HTTPS
backup oneshot succeeds
restore rehearsal on disposable DB recorded
firewall: 3000 and 5432 not public
```

Do **not** claim real offsite or production restore unless executed.

---

## 19. Documentation closeout

| Path | Content |
|------|---------|
| `docs/operations/production-deployment.md` | topology, env, deploy sequence, systemd, Caddy, smoke |
| `docs/operations/backup-restore.md` | backup, retention, offsite hook, restore, rehearsal cadence |
| `docs/operations/restore-rehearsals/` | dated records (template + first rehearsal when done) |
| `ops/*` | scripts, units, Caddyfile, env example |
| `README.md` | link ops docs; production start/migrate scripts |
| `SERVORA_MED_MVP_SLICES.md` | check Slice 11 acceptance after verify |
| `SERVORA_MED_ARCHITECTURE_PLAN.md` | record Caddy-canonical + migrate-not-on-start |
| `SERVORA_MED_API_DRAFT.md` | public health 200/503; note `/detailed` deferred |
| `DECISIONS.md` | only if durable decision needed (trusted proxy loopback; migrate explicit) |

No schema draft changes (no backup table).

---

## 20. Non-goals (reconfirmed)

```text
Docker / Kubernetes / Terraform
multi-region / HA PostgreSQL
zero-downtime cluster deploy
CI → auto production deploy
monitoring/APM platform
product UI for backups
backup_status table
WebSocket
domain / financial / inventory features
generic config framework
second full Nginx runbook
admin health detailed endpoint (deferred)
```

---

## 21. Documentation SSOT alignment

| Document | Slice 11 obligation |
|----------|---------------------|
| MVP Slice 11 acceptance | Map 1:1 to this design |
| Architecture §14 | Caddy canonical; trustProxy; external backup logs |
| API health | Public readiness only |
| AGENTS security | CORS, health, rate limit, no secret logs |
| Product DoD item 12 | Satisfied by verified ops + rehearsal record |

---

## 22. Self-review checklist

- [x] No migrate-on-start in production path  
- [x] No `trustProxy=true` for all clients  
- [x] Production HTTPS-only CORS  
- [x] Host-only cookies preserved  
- [x] Public health no infrastructure leak  
- [x] Backup atomic + checksum + no secret logging  
- [x] Restore cannot target production by default  
- [x] No product backup table  
- [x] No new runtime dependency required for core app  
- [x] Target-specific values isolated in §3 table  

---

## 23. Approval gate

**Implementation must not start** until this design and the companion plan  
`docs/superpowers/plans/2026-07-15-production-deployment.md` receive **explicit user approval**.
