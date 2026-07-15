# Slice 12 — Local Pilot Cutover, Installation Guide, and User Manual

> **Status:** Approved design; implementation verified in-repo (operator live cutover remains host-owned)
> **Baseline:** `main` @ `167d24a71f79c9c7a2f966c901700d6459ca1321`
> **Date:** 2026-07-15
> **Scope:** macOS local pilot via Cloudflare Tunnel, README install restructuring, Turkish user manual, ops templates
> **Out of scope:** WebSocket, new domain features, Docker/K8s, committed tunnel credentials, automatic OS/router config

---

## 1. Purpose

Make Servora-Med **pilot-ready on a single macOS host** without opening inbound ports, while shipping:

1. A complete **local macOS + Cloudflare Tunnel** operations runbook.
2. Templates for **cloudflared**, **tunnel Caddy**, and **launchd**.
3. A **trustworthy client-IP / rate-limit** path through CF → tunnel → Caddy → Fastify.
4. A restructured **README** for developer vs pilot operator paths.
5. A **Turkish, task-oriented user manual** for Admin / Manager / Staff grounded in real UI routes.

WebSocket remains **evidence-gated** and is renumbered to **Slice 13** (same entry criteria and acceptance as today's Slice 12 WebSocket section).

---

## 2. Roadmap change

| Slice | Title |
|-------|--------|
| **12** | Local Pilot Cutover, Installation Guide, and User Manual |
| **13** | WebSocket Only if Polling Is Insufficient *(unchanged criteria)* |

VPS (Ubuntu + systemd + public Caddy TLS) remains a **supported reference topology** from Slice 11.
**Initial pilot topology** is local macOS + Cloudflare Tunnel.

---

## 3. Current-state audit (relevant to this slice)

### Already in place (reuse)

| Asset | Role |
|-------|------|
| Slice 11 config: HTTPS CORS, loopback bind, `TRUSTED_PROXY=loopback`, `HEALTH_SCHEMA_VERSION` | Production/pilot process contract |
| `start:prod` / `migrate:prod` / bootstrap | Clean process model |
| Generic health `200/503` | External smoke |
| `ops/caddy/Caddyfile.example` | VPS TLS Caddy (keep; do not repurpose) |
| Backup/restore scripts + fail-closed deploy helper | Ops continuity |
| Web routes in `web/src/paths.ts` + shell nav in `AppShell.tsx` | Manual accuracy |

### Gaps this slice fills

| Gap | Deliverable |
|-----|-------------|
| No macOS pilot runbook | `docs/operations/local-macos-cloudflare-tunnel.md` |
| No cloudflared template | `ops/cloudflared/config.yml.example` |
| No loopback-only Caddy for tunnel | `ops/caddy/Caddyfile.tunnel.example` |
| No launchd for API/backup on macOS | `ops/launchd/*.plist.example` |
| README still Slice-11-shaped, not pilot/install-first | README restructure |
| No end-user Turkish manual | `docs/user-manual/servora-med-user-manual.md` |
| CF-Connecting-IP not documented/tested through Caddy | Caddy trusted proxy + tests/docs |
| WebSocket still labeled Slice 12 in MVP | Renumber to 13 |

### Non-findings

- No application schema or JobCard domain changes required.
- Slice 11 systemd units stay Ubuntu-only; macOS uses launchd templates.

---

## 4. Canonical pilot topology

```text
Internet
  → Cloudflare Edge TLS (public hostname HTTPS)
    → named Cloudflare Tunnel
      → cloudflared LaunchDaemon (boot-time; /etc/cloudflared/)
        → Caddy http://app.example.com:8080 bind 127.0.0.1 (loopback HTTP; Host = public FQDN)
          ├── static: web/dist
          └── /api/* → Fastify 127.0.0.1:3000
                         → PostgreSQL localhost only
```

### Hard rules

```text
no router port forwarding
no public Fastify / PostgreSQL ports
Caddy binds loopback only (8080); site address uses explicit http:// and public Host matcher
Fastify binds loopback only (3000)
PostgreSQL listens locally only
public hostname uses HTTPS at Cloudflare edge (X-Forwarded-Proto to Fastify is https)
session cookie remains host-only (no Domain=)
Cloudflare Tunnel ≠ application auth (Servora-Med session remains SSOT)
Cloudflare Access optional, not required
tunnel credentials never committed
local disk backup ≠ offsite backup
canonical cloudflared service: sudo cloudflared service install (LaunchDaemon)
```

### Durable decisions (for DECISIONS.md closeout)

1. Local macOS + Cloudflare named tunnel is the **initial pilot topology**.
2. Ubuntu VPS remains a **supported reference** topology (Slice 11).
3. No inbound application/database ports for pilot.
4. Cloudflare Tunnel does **not** satisfy offsite backup.
5. WebSocket remains evidence-gated (Slice 13).

---

## 5. Workstream A — macOS local pilot operations

### 5.1 Runbook

**Create:** `docs/operations/local-macos-cloudflare-tunnel.md`

Must cover end-to-end (developer setup separated from pilot setup):

```text
supported macOS / arch assumptions (Apple Silicon + Intel via Homebrew)
Homebrew, Node 22+, PostgreSQL 16+, Caddy, cloudflared
clone/update, production build, npm ci --omit=dev in server release dir
DB create, env files under private paths (not repo .env for pilot)
migrate:prod, bootstrap:admin:prod (never commit real bootstrap secrets)
Caddy with tunnel Caddyfile: http://<public-fqdn>:8080 + bind 127.0.0.1
cloudflared login, named tunnel create, DNS route, config under /etc/cloudflared
tunnel ingress validate/rule with explicit --config (never silent personal config)
boot-time LaunchDaemon: sudo cloudflared service install (LaunchAgent = dev alternative only)
health + login smoke on public hostname
backup schedule (launchd) + restore rehearsal checklist
upgrade/deploy/rollback boundaries
startup/shutdown order
logs + troubleshooting
power/sleep/disk-encryption operator checklist
```

No automatic scripts for macOS sleep or firmware settings—**checklist only**.

### 5.2 cloudflared config template

**Create:** `ops/cloudflared/config.yml.example`

Aligned with Cloudflare published-application config (catch-all required):

```yaml
# Locally-managed named tunnel — do not commit real UUID or credentials JSON.
# Canonical pilot paths (LaunchDaemon):
#   config:      /etc/cloudflared/config.yml
#   credentials: /etc/cloudflared/<TUNNEL_UUID>.json
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404   # mandatory catch-all
```

Document operator commands (from Cloudflare docs). When the active file is not the CLI default, **always** pass `--config`:

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://app.example.com
cloudflared tunnel list
cloudflared tunnel info <name-or-uuid>
```

macOS service models (Cloudflare official):

| Model | Command | Paths | Pilot use |
|-------|---------|-------|-----------|
| **LaunchDaemon (canonical)** | `sudo cloudflared service install` | `/etc/cloudflared/` | Boot-time pilot |
| LaunchAgent (dev alternative) | `cloudflared service install` | `~/.cloudflared/` | Login-dependent only |

### 5.3 Tunnel Caddyfile

**Create:** `ops/caddy/Caddyfile.tunnel.example`
**Do not modify** VPS `Caddyfile.example` semantics beyond shared header conventions.

`auto_https off` alone does **not** make the site HTTP. The site address must use explicit `http://` and must match the public `Host` (not bare `http://127.0.0.1:8080` as the site matcher). Canonical shape:

```caddyfile
{
    servers :8080 {
        trusted_proxies static 127.0.0.0/8 ::1
        client_ip_headers CF-Connecting-IP
    }
}

http://app.example.com:8080 {
    bind 127.0.0.1
    # API / assets / SPA + reverse_proxy with:
    #   header_up X-Forwarded-For {client_ip}
    #   header_up X-Forwarded-Proto https
}
```

Requirements:

```text
bind 127.0.0.1 only
explicit http:// + public FQDN site matcher (Host alignment executable-tested)
plain HTTP origin (HTTPS at Cloudflare edge)
root → pilot release web/dist
/api/* → reverse_proxy 127.0.0.1:3000 + Cache-Control: no-store
/assets/* → immutable long cache
all other SPA shell → Cache-Control: no-cache + try_files → index.html
log filters: strip Cookie and Authorization
```

### 5.4 Real client IP chain

```text
public https request
  → CF-Connecting-IP preserved (Cloudflare single visitor IP header)
  → cloudflared → Caddy on loopback
  → Caddy trusted_proxies = 127.0.0.0/8 ::1
  → Caddy client_ip_headers = CF-Connecting-IP
  → X-Forwarded-For = {client_ip}
  → X-Forwarded-Proto = https   (never accidental http for public browser traffic)
  → Fastify TRUSTED_PROXY=loopback → request.ip = visitor IP (login rate limit)
```

**Threat boundary (must stay honest):**

- Internet users cannot reach Caddy directly; only the tunnel hop on loopback can.
- Caddy listens only on loopback.
- A malicious process on the same host could spoof `CF-Connecting-IP` toward Caddy; that is **host compromise**, not a remote bypass.
- Do **not** write acceptance that claims “all local spoof is prevented.”

**Test obligation (smallest executable proof):**

| Case | Expected |
|------|----------|
| Two different visitor IPs via trusted loopback peer (`X-Forwarded-For` after Caddy resolution) | Independent login rate-limit buckets |
| Spoofed `X-Forwarded-For` from non-loopback peer | Not trusted as distinct clients |
| Tunnel Caddyfile contract | `trusted_proxies`, `client_ip_headers CF-Connecting-IP`, `header_up X-Forwarded-For {client_ip}`, `header_up X-Forwarded-Proto https`, Host matcher + bind |

Full multi-process CF stack in CI is **not** required.

### 5.5 launchd templates

**Create (examples only):**

```text
ops/launchd/com.servora-med.api.plist.example
ops/launchd/com.servora-med.backup.plist.example
```

Properties (exact; launchd does **not** load interactive shell `PATH` or repo `.env`):

```text
absolute executable paths (wrapper scripts, not bare "npm" / relative node)
Apple Silicon vs Intel Homebrew path notes in comments (/opt/homebrew vs /usr/local)
no secrets in plist (no DATABASE_URL / passwords)
wrapper sources private EnvironmentFile (/etc/servora-med/*.env)
log directories under /usr/local/var/log/servora-med
API: RunAtLoad + KeepAlive
backup: StartCalendarInterval
```

Verification: contract tests for absolute paths and no secret literals; `plutil -lint` on macOS when available; Linux CI relies on XML/contract tests when `plutil` is absent.

Cloudflared: **official** `sudo cloudflared service install` is canonical—do not invent a third-party cloudflared plist.

### 5.6 Power / host availability checklist

Operator-owned (no automation):

```text
machine powered and network online
prevent sleep while pilot is live
auto-restart after power loss is an OS setting
FileVault (or disk encryption) remains on
pilot OS account is not a daily personal admin account
```

---

## 6. Workstream B — README restructure

README becomes the **install chooser**, not a second user manual.

### Target structure

```text
What Servora-Med is
Implemented scope (link MVP slices; no stale long checklists)
Quick architecture
Choose your setup
  - local development
  - local macOS pilot (Cloudflare Tunnel)
  - Ubuntu VPS reference (link Slice 11 runbook)
Prerequisites
Five-minute development start
Production/pilot environment summary
Database migration
First Admin bootstrap
Demo seed
Build and test
Backup and restore
Health and troubleshooting
User manual link
Operations documentation index
Security notes
Known limitations / pending operator tasks
```

### Command separation (must not blur)

| Context | Commands |
|---------|----------|
| Dev | `npm install` / `npm ci`, `.env`, `npm run dev`, `db:seed:dev`, `migrate` |
| Pilot/prod process | `/etc` or private env file, `npm ci --omit=dev`, `migrate:prod`, `start:prod`, `bootstrap:admin:prod` |

Long route/test-count lists stay in SSOT; README links.

---

## 7. Workstream C — Turkish user manual

**Create:** `docs/user-manual/servora-med-user-manual.md`

### Language and style

- Turkish, task-oriented, non-developer audience.
- Routes and button labels **only** from code (`paths.ts`, `AppShell`, create/detail screens).
- No invented permissions.

### Canonical navigation (from code)

| Label | Path | Who |
|-------|------|-----|
| İşler | `/jobs` | all |
| Müşteriler | `/customers` | all (Staff scoped) |
| Ürünler | `/products` | all (Staff read-only product) |
| Raporlar | `/reports` | Admin/Manager |
| Kullanıcılar | `/users` | Admin |
| Personel / Profilim | `/staff` | Manager/Admin vs Staff |
| Oturumu kapat | shell button | all |

Create flows:

| Flow | Path |
|------|------|
| Product Delivery | `/jobs/new-delivery` |
| General Task | `/jobs/new-task` |
| Sales Meeting | `/jobs/new-meeting` |
| Job detail | `/jobs/:id` |
| Staff report | `/staff/:id/reports` |

### Required sections

As specified in the slice brief: ortak; Staff; Manager; Admin; sorun giderme; güvenli paylaşım.

Screenshots optional; if added later: seeded demo only, alt text, update instructions.

---

## 8. Workstream D — Backup / offsite honesty

Status table (must appear in ops + README limitations):

| Capability | Status |
|------------|--------|
| Local scheduled backup | repository implementation available |
| Disposable restore test | automated (`TEST_DATABASE_URL`) |
| Host restore rehearsal | **pending** until executed on pilot host |
| Real offsite copy | **pending** until destination + credentials configured |

Cloudflare Tunnel **does not** transport backups.
Optional rclone/S3/R2 example may live as a **separate optional appendix**, never as “offsite complete”.

---

## 9. Application code changes (minimal)

| Change | Why |
|--------|-----|
| Possibly none for Fastify if Caddy alone forwards correct `X-Forwarded-For` and `TRUSTED_PROXY=loopback` | Prefer zero app change |
| Contract tests for tunnel Caddyfile + existing rate-limit tests | Prove intent |
| Optional tiny Caddy snippet validation in CI | Same as Slice 11 pattern |
| MVP slices renumber + README/architecture/decisions | Roadmap |

No schema migrations. No new npm dependencies unless strictly needed (default: none).

---

## 10. Acceptance criteria

### Local pilot (operator-executed; docs enable)

```text
production build runs on clean local release directory
PostgreSQL reachable locally only
Fastify loopback only
Caddy loopback only
Cloudflare hostname serves SPA over HTTPS
/api/health generic ok
login works through public hostname
cookie Secure on HTTPS public host
unsafe Origin rejected
different visitors → separate rate-limit identity (via trusted chain)
no router 3000/5432 forwarding
cloudflared resumes via supported launch agent
```

### Documentation

```text
fresh developer follows README
fresh operator follows local-macOS runbook
Admin/Manager/Staff can use user manual without code
links and commands valid
no secrets committed
README and SSOT consistent
```

### Automated verification

```text
server build + ordinary tests + PG tests
web build + tests
audits
shellcheck / bash -n for new scripts
Caddy validate for tunnel Caddyfile
cloudflared ingress validate where CLI available (document if skipped)
plutil -lint on launchd examples when available
doc link check (lightweight)
git diff --check
remote CI green
```

---

## 11. Non-goals

```text
WebSocket implementation
new JobCard types / confidential notes / follow-up cards
inventory/accounting
native app / Docker / K8s / HA
automatic Cloudflare account provisioning
committed tunnel credentials
automatic router or macOS security configuration
```

---

## 12. Closeout documentation set

| File | Update |
|------|--------|
| `README.md` | Restructure per §6 |
| `SERVORA_MED_MVP_SLICES.md` | Slice 12 = pilot cutover; Slice 13 = WebSocket |
| `SERVORA_MED_ARCHITECTURE_PLAN.md` | Pilot topology + tunnel note |
| `DECISIONS.md` | Durable pilot decisions |
| `docs/operations/*` | New macOS tunnel runbook + index links |
| `docs/user-manual/*` | User manual |

---

## 13. Approval gate

**Approved** 2026-07-15 with mandatory technical clarifications (exact HTTP Host matcher, CF-Connecting-IP / trusted_proxies, X-Forwarded-Proto https, LaunchDaemon canonical model, `--config` validation). No second design approval required; single implementation review after Tasks 1–11.
