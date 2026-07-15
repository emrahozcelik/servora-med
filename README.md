# Servora-Med

Servora-Med is a browser-based B2B operations platform for medical and dental product companies. Staff record product deliveries, general tasks, and sales meetings as **JobCards**; managers approve or request revision. Authentication, CRM, product catalog, operational reports, and pilot deployment tooling are included.

**User manual (Turkish):** [docs/user-manual/servora-med-user-manual.md](docs/user-manual/servora-med-user-manual.md)

## Implemented scope

Full slice inventory and acceptance live in [`SERVORA_MED_MVP_SLICES.md`](SERVORA_MED_MVP_SLICES.md) (through **Slice 12** pilot docs/templates). Summary:

- Auth (Admin / Manager / Staff), JobCard lifecycle, Product Delivery, General Task, Sales Meeting
- Customers/contacts, product catalog, notes/timeline, operational reports
- Production/pilot hardening (config, health, backup/restore scripts, Caddy/systemd templates)
- Local macOS + Cloudflare Tunnel pilot runbook and install chooser (this README)

## Quick architecture

```text
Browser → (pilot) Cloudflare HTTPS → Tunnel → Caddy loopback
       → Fastify API loopback → PostgreSQL local/private
```

Ubuntu VPS with public Caddy TLS remains a supported **reference** topology ([production-deployment.md](docs/operations/production-deployment.md)).

## Choose your setup

| Path | Guide |
|------|--------|
| **Local development** | Sections below (*Five-minute development start*) |
| **macOS pilot (Cloudflare Tunnel)** | [local-macos-cloudflare-tunnel.md](docs/operations/local-macos-cloudflare-tunnel.md) |
| **Ubuntu VPS reference** | [production-deployment.md](docs/operations/production-deployment.md) |

## Current Scope (detail)

Implemented through Slice 12 (application through Slice 11; pilot docs Slice 12):

- Fastify and TypeScript server shell
- strict environment validation
- safe public health endpoint
- PostgreSQL migration runner
- transaction and rollback coverage for migration application
- safe HTTP error shape
- sensitive logger redaction paths
- React and Vite web shell
- server and web test harnesses
- email/password authentication for Admin, Manager, and Staff roles
- case-insensitive globally unique email identity
- hashed opaque cookie sessions with expiration and revocation
- login rate limiting and production Origin/CORS protection
- first-admin bootstrap and development-only seed commands
- accessible responsive login, identity loading, logout, and protected shell
- minimum customer and product reference schema/seed
- staff-scoped Product Delivery JobCard create, list, detail, and versioned patch
- structured delivery item create, patch, remove, and catalog snapshots
- start, approval submission, manager approval, and revision commands
- transactional canonical activity, idempotent critical actions, and optimistic concurrency
- authenticated JobCard HTTP API
- responsive Staff-to-Manager Product Delivery workflow UI
- mandatory first-login password change and fresh-login flow
- Admin user and Admin/Manager Staff-profile maintenance
- Staff own-profile operational counters
- versioned, audited Customer lifecycle and responsible Staff assignment
- nested Contact lifecycle with one active primary Contact
- Staff read-only CRM with assigned-JobCard summary scope
- stable Customer and Contact list/detail routes with Back/Forward/refresh support
- Contact-linked JobCard creation with responsible Staff and primary Contact suggestions
- shared CRM/People/JobCard lock order and live PostgreSQL concurrency coverage
- Admin/Manager Product create, edit, activate, and deactivate commands
- Staff read-only Product list/detail access
- nullable informational SKU, brand, category, model, unit, and reference price
- duplicate SKU support without inventory or accounting meaning
- Product optimistic concurrency and atomic management audit events
- canonical paginated Product search for catalog and delivery selection
- immutable historical delivery snapshots when Product data or active state changes
- role-scoped, filterable JobCard list and read-only desktop board
- full named lifecycle commands with backend truth recovery
- application-contract append-only JobCard notes in every lifecycle state
- safe paginated activity timeline with canonical Turkish event labels
- mobile-forced list layout without a squeezed Kanban board
- organization-scoped operational dashboard and Staff summaries
- grouped approved-delivery reports with exact decimal-string quantities
- oldest-first approval queue with non-negative age buckets
- stable report routes with URL-owned filters, pagination, and role boundaries
- separate General Task quick create, shared approval lifecycle, type-aware detail, and
  list/board/report integration without delivery-item leakage
- separate Sales Meeting planning and structured result capture with four canonical
  outcomes, optional follow-up, manager review, safe activity, and Staff outcome reports
- production config hardening (HTTPS CORS, loopback bind, trusted proxy)
- generic readiness health (`200` / `503`) without infrastructure leakage
- explicit production migrate/start scripts (no migrate-on-start)
- PostgreSQL backup/restore rehearsal scripts, systemd and Caddy templates
- operations runbooks under `docs/operations/`
- macOS Cloudflare Tunnel pilot guide, tunnel Caddy/cloudflared/launchd examples, user manual

### Not implemented yet / operator-owned

- Staff confidential notes and related follow-up cards
- WebSocket (evidence-gated **Slice 13**)
- Live public pilot cutover on a real host (docs ready; execution is operator-owned)
- Host-recorded restore rehearsal file
- Real offsite backup copy

## Prerequisites

- Node.js 22.12 or newer
- PostgreSQL 16 or newer
- npm

## Five-minute development start

```bash
cd server
npm ci          # or: npm install
cp .env.example .env
# create local DB named in DATABASE_URL
npm run migrate
npm run dev
```

In another terminal:

```bash
cd web
npm ci
npm run dev
```

Open the Vite URL (default `http://127.0.0.1:5173`). Use `npm run db:seed:dev` only for local demo data (refuses production).

### Development vs pilot/production commands

| Intent | Development | Pilot / production process |
|--------|-------------|----------------------------|
| Install | `npm ci` / `npm install` | `npm ci` then `npm ci --omit=dev` in release `server/` |
| Env | repo `server/.env` | private file e.g. `/etc/servora-med/servora-med.env` |
| Migrate | `npm run migrate` | `npm run migrate:prod` / `node dist/db/migrate.js` |
| Start | `npm run dev` | `npm run start:prod` / `node dist/index.js` |
| First admin | optional after empty DB | `bootstrap:admin` / `bootstrap:admin:prod` |
| Demo users | `db:seed:dev` only | **never** in production |

## Server Setup (detail)

```bash
cd server
npm ci
cp .env.example .env
```

Create the local PostgreSQL database named by `DATABASE_URL`, then run:

```bash
npm run migrate
npm run dev
```

The migration runner applies the immutable 001–007 files for the ledger, authentication,
Product Delivery tracer, People profiles/audits, Customer/Contact CRM, Product catalog,
JobCard workspace notes/indexes/lifecycle timestamp constraints, and Structured Sales
Meeting details.

### First Admin Bootstrap

Run migrations first. Set the four `BOOTSTRAP_*` values in the runtime environment, then run:

```bash
npm run bootstrap:admin
```

The command creates one organization and its first Admin. It refuses to run when any user already exists. It is not a migration and must not be used as a recurring user-management command.

### Development Seed

For an empty local development or test database, set `DEV_SEED_PASSWORD` and run:

```bash
npm run db:seed:dev
```

This creates development-only users:

- `admin@servora.local`
- `manager@servora.local`
- `staff@servora.local`

All three are created with the `mustChangePassword` flag. The command refuses `NODE_ENV=production` and refuses a database that already contains users.

The development seed also creates one Staff profile assigned to the demo Manager, `Demo Dental Klinik`, primary Contact `Dr. Ayşe Yılmaz`, one catalog product, and one Contact-linked `NEW` Product Delivery JobCard with its `JOB_CREATED` activity. These are local reference records, not production migration data.

Public health (readiness):

```text
GET http://127.0.0.1:3000/api/health
```

Response when the database is reachable and schema migrations are present:

```json
{
  "status": "ok"
}
```

When the database is unreachable or required schema is missing:

```json
{
  "status": "unavailable"
}
```

with HTTP status `503`. The public response intentionally contains no database, environment, host, filesystem, migration version, or dependency detail.

Production deploy/backup runbooks: `docs/operations/production-deployment.md` and `docs/operations/backup-restore.md`.

## Web Setup

```bash
cd web
npm install
npm run dev
```

Vite runs at `http://127.0.0.1:5173` and proxies `/api` requests to the local server.

The frontend derives identity from `GET /api/auth/me`. It does not store session tokens in Local Storage, Session Storage, or JavaScript-readable cookies.

## Authentication API

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/change-password
```

The server issues a high-entropy opaque session cookie. Only its SHA-256 hash is stored in PostgreSQL. The cookie is `HttpOnly`, `SameSite=Lax`, scoped to `/`, and `Secure` in production. Passwords are salted and hashed with Node.js `scrypt`.

Production unsafe requests must carry the exact configured `Origin`. CORS permits credentials only for `CORS_ORIGIN`. Login attempts are rate limited by the configured values.

## Product Delivery Tracer API

Authenticated JobCard routes are available under `/api/job-cards`. The tracer supports canonical list/board projections, JobCard create/read/patch, delivery-item mutations, paginated notes/activity, and named `plan`, `start`, `submit-for-approval`, `approve`, `request-revision`, `resume`, and `cancel` commands. Staff scope, manager review authority, organization ownership, expected version, and critical-action idempotency are enforced by the backend.

Slice 02 was verified against a disposable local PostgreSQL 16.13 database through migration, development seed, Staff/Manager login, approved delivery flow, revision flow, and direct activity/constraint queries. The disposable database was removed after verification.

## Product Delivery Mobile UI

Slice 03 provides the first role-aware browser tracer. Staff can create a structured product delivery, select its purpose and quantity, start it, and submit it for manager approval. Managers receive an approval queue with immutable delivery details and activity history, then approve or return the work with a required revision reason.

The flow was manually verified in Chromium at a 390 by 844 CSS px viewport against disposable PostgreSQL. It also passed keyboard navigation, visible focus, 44 CSS px target, 200 percent text-size, 320 CSS px effective 400-percent reflow, reduced-motion, and semantic accessibility snapshot checks. The verification record is maintained in `docs/superpowers/plans/2026-07-11-slice-03-delivery-mobile-ui.md`.

## People Backend

Slice 04 adds Admin-only user administration and Admin/Manager Staff profile APIs. Security-sensitive user changes use named role, activation, deactivation, and password-reset commands with integer optimistic versions. Staff profile summaries expose backend-derived open, waiting-approval, revision, completed-this-month, and overdue counters.

The development seed creates one Staff profile linked to the demo Manager in the same transaction as the demo users. A disposable PostgreSQL tracer verified forced password change, Staff creation/profile reads, Manager profile update, assigned-Staff lifecycle protection, eligible deactivation, session revocation, inactive login rejection, and atomic People audit events. The disposable database is removed after verification.

The role-aware web workspace now provides Admin user management, Admin/Manager Staff profile maintenance, Staff own-profile counters, and a mandatory first-login password screen. Playwright verified the complete three-role flow at 390×844 CSS px, keyboard focus order, 44 CSS px controls, 200% text enlargement, 320 CSS px effective 400% reflow, reduced motion, and semantic form/status structures.

## Customer and Contact CRM

Slice 05 provides Admin/Manager Customer maintenance, one optional responsible Staff user,
nested Contacts, explicit Customer and Contact lifecycle commands, and atomic primary
Contact replacement. Staff can read organization CRM records but cannot mutate them;
Customer JobCard summaries remain restricted to the authenticated Staff user's assigned
work. Customer and Contact records deliberately do not contain a generic notes editor or
CRM audit timeline.

The delivery creation route now suggests the Customer's eligible responsible Staff user
for management and the active primary Contact for every role. Staff assignment is still
forced to the authenticated Staff user, and the backend validates Customer, Contact,
organization, and assignee eligibility.

Final automated verification passed server 27 files/175 tests, web 19 files/103 tests,
both production builds, both high-severity dependency audits with zero vulnerabilities,
and all 3 separately enabled PostgreSQL tests. Slice 05 was verified on disposable
PostgreSQL 16.13 databases through migrations 001–004,
development seed, forced password change and fresh login, Customer search/update and tax
normalization, Contact primary replacement, Contact-linked JobCard creation, active-job
deactivation guards, Staff-assignment cleanup, safe audit payloads, cross-organization
concealment, rollback, and two-client concurrency. Browser acceptance passed through
Playwright MCP at 1200×800 desktop,
390×844, and 320 CSS px effective reflow widths with keyboard-only interaction, visible
focus restoration, 44 CSS px targets, 200% text enlargement, reduced motion, semantic
landmarks/labels/live feedback, and no horizontal page scrolling. The disposable databases
were removed after verification. Authenticated `/login` visits now replace the route with
`/jobs`; a focused routing regression test protects that behavior without breaking direct
CRM URLs.

## Product Catalog

Slice 06 provides the canonical organization-scoped Product catalog under
`/api/products`. Admin and Manager can create, edit, activate, and deactivate Products;
Staff can search and read them but cannot mutate them. Only Product name is required.
SKU, brand, category, model, unit, and `referencePrice` are optional informational values;
duplicate SKU values are allowed and no stock, warehouse, currency, costing, invoice, or
accounting behavior is implied.

Product patches and lifecycle commands use optimistic versions and atomic audit events.
Inactive Products cannot be selected for a new delivery or replace an existing delivery
Product. Existing delivery quantity/note edits remain possible without replacing the
Product, and persisted name/SKU/model/unit snapshots are not rewritten. Delivery creation
uses the searchable, paginated canonical catalog; the legacy `/api/reference/products`
route has been removed.

Final Slice 06 review verification passed server 32 files/266 tests with 3 files/6 conditional
PostgreSQL tests skipped in the ordinary suite, web 24 files/162 tests, both production
builds, and both high-severity dependency audits with zero vulnerabilities. Separately
enabled PostgreSQL tests passed the full 35-file/272-test server suite against migrations
001–005. Authenticated live tracing verified role boundaries, duplicate SKU,
five-field search, pagination, versions, failed-mutation audit safety, lifecycle guards,
immutable delivery snapshots, Product field limits, and malformed UUID concealment.

## JobCard Workspace

Slice 07 adds the canonical role-scoped JobCard list, a read-only active-state desktop
board, closed-state counts, the complete named lifecycle, operational notes, and a safe
activity timeline. Mobile always uses the structured list. Lifecycle commands never
optimistically change status; the returned server DTO is used, and version or transition
conflicts reload backend truth.

JobCard notes are append-only through the application contract. They remain available in
review, completed, and cancelled states, use stable idempotency action IDs for ambiguous
retries, do not increment JobCard version, and atomically create `NOTE_ADDED`. The public
activity DTO exposes allowlisted presentation details rather than raw audit JSON.

Final Slice 07 verification passed the PostgreSQL-enabled server suite at 42 files/518
tests and the web suite at 31 files/224 tests. Both production builds and high-severity
dependency audits passed with zero vulnerabilities. Playwright acceptance verified the
authenticated Staff workspace, detail, note, and timeline flow at desktop, 390-pixel
mobile, and 320-pixel reflow widths without horizontal overflow or a mobile board control.

## Operational Reports

Slice 08 adds a read-only Reports module with five authenticated endpoints and four stable
web routes. Admin and Manager use `/reports`, `/reports/deliveries`, and
`/reports/approvals`; Staff use their own existing profile area, while management can open
`/staff/:staffUserId/reports`. Staff ownership is derived only from
`job_cards.assigned_to`. The People profile counters consume the same batch-capable
`StaffOperationalSummaryPort`, so list views do not issue one counter query per Staff
member.

Delivery quantities include only approved `COMPLETED` Product Delivery JobCards. They use
the persisted delivery purpose, actual delivery date, historical Product snapshots, and
unit without normalization. Quantities remain exact three-decimal strings and are never
re-aggregated in JavaScript. Approval age starts at Staff submission, clamps future
timestamps to zero, covers the complete queue, and keeps `pendingCount`, total, and bucket
sums equal.

Final Slice 08 verification passed the ordinary server suite at 46 files passed and 5
PostgreSQL-conditional files skipped, with 611 tests passed and 15 skipped. A disposable
database migrated through 001–006 passed the PostgreSQL-enabled server suite at 51 files
and 626 tests; the operational report contract also executed its PostgreSQL
`EXPLAIN (ANALYZE, BUFFERS)` assertions. The web suite passed 39 files and 286 tests. Both
production builds and both high-severity dependency audits passed with zero
vulnerabilities. Browser acceptance through Chrome DevTools MCP covered Manager and Staff
desktop flows, 390×844 mobile, 320 CSS px reflow, keyboard-only use, visible focus, 200%
text enlargement, reduced motion, color-independent meaning, and no horizontal page
overflow. Lighthouse reported an accessibility score of 100 for the mobile report
snapshot. Slice 08 added no migration, report table, cache, materialized view, financial
metric, inventory metric, or ranking.

## General Tasks

Slice 09 activates `GENERAL_TASK` as the second pilot-core JobCard type. One exact
`POST /api/job-cards` discriminated union preserves the existing Product Delivery request
while allowing a title-and-assignee task with optional description, due date, Customer,
and Contact context. Both types share Staff self-assignment, management eligibility,
idempotent creation, lifecycle, approval, notes, activity, visibility, and concurrency
policies. Type-specific submission rules remain exhaustive and backend-owned.

The web app exposes `/jobs/new-task` as a separate quick-create flow and keeps
`/jobs/new-delivery` unchanged. One type-aware detail shell renders canonical assignee,
Customer, and Contact identities. General Task neither requests nor renders delivery
items; every delivery list/add/update/remove operation returns `INVALID_JOB_TYPE` for that
type. Workspace list and board filters accept both canonical types. Operational counters
and approval queues include General Task, while delivery quantities remain Product
Delivery-only.

Final Slice 09 verification passed the server build and ordinary suite at 48 files passed,
5 PostgreSQL-conditional files skipped, 669 tests passed, and 15 skipped. A disposable
PostgreSQL 16.13 database migrated through 001–006 passed all 53 server files and all 684
tests with no unexpected skip. The web suite passed 40 files and 315 tests, and its
production build passed. Both production dependency audits reported zero vulnerabilities.
Playwright MCP acceptance covered Staff create/start/submit/resume, Manager
revision/approval, deep links, refresh and Back/Forward URL state, keyboard-only use,
visible focus and restoration, 44 CSS px targets, 390×844 mobile, 320 CSS px effective
reflow, 200% text enlargement, reduced motion, semantic structure, and zero General Task
delivery requests. Slice 09 added no migration, dependency, generic form builder, JSON
details model, financial behavior, inventory behavior, or report storage.

## Structured Sales Meetings

Slice 10 activates `SALES_MEETING` as the third canonical JobCard type. The separate
`/jobs/new-meeting` flow records a required organization-local planned day. The assignee
later records actual meeting time, one of `POSITIVE`, `FOLLOW_UP_REQUIRED`,
`NO_DECISION`, or `NOT_INTERESTED`, a normalized summary, and an optional later follow-up.
`FOLLOW_UP_REQUIRED` recommends but does not require the follow-up date. Submission uses
the shared Customer → assignee → type-readiness validation order and the existing
revision/manager-approval lifecycle.

Migration `007_sales_meeting.sql` adds the exact third type, fifteenth activity event,
one-to-one detail table, chronology and content constraints, and partial actual-time
index. Detail PATCH is target-scoped idempotent, uses the parent JobCard version, and
publishes only changed-field names in `MEETING_DETAILS_UPDATED`. Staff reports show four
zero-filled outcome rows using completed meetings, `assigned_to`, and actual
`meeting_at`; all-type counters include Sales Meeting while delivery quantities remain
Product Delivery-only.

Verified implementation SHA: `d93441802832f91fe149b603fb55ef2a29b04089`.
The ordinary server suite passed 51 files with 732 tests and 7 PostgreSQL-conditional
files with 21 tests skipped. A disposable PostgreSQL database migrated through 001–007
and passed all 58 files and all 753 tests. The web suite passed all 42 files and all 335
tests. Both production builds and both production dependency audits passed with zero
vulnerabilities. Playwright MCP covered Staff planning/result/submission, Manager
revision/approval, deep links, refresh, Back/Forward, 390×844 mobile, keyboard focus,
44 CSS px controls, reduced motion, safe timeline and Staff outcome reporting. Both the
planning and completed-detail views reflowed at 200% and 400% text without horizontal
overflow. Later documentation-only and Codebase Memory commits did not rerun these full
suites.

Pull requests and pushes to `main` run these server/web build, test, audit, and
PostgreSQL-backed checks through `.github/workflows/ci.yml`.

## Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && npm audit --omit=dev
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --omit=dev
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | no | `development`, `test`, or `production`; defaults to development |
| `HOST` | no | listen address; defaults to `127.0.0.1`; production must be loopback only |
| `PORT` | no | listen port; defaults to `3000` |
| `DATABASE_URL` | yes | PostgreSQL `postgresql://` or `postgres://` URL |
| `LOG_LEVEL` | no | allowlist: `fatal` `error` `warn` `info` `debug` `trace` `silent`; defaults to `info` |
| `CORS_ORIGIN` | production | single exact origin without a path; production requires `https`; local default is `http://127.0.0.1:5173` |
| `TRUSTED_PROXY` | production | `loopback`, `127.0.0.1`, or `::1`; defaults to `loopback` outside production |
| `HEALTH_SCHEMA_VERSION` | production | exact `schema_migrations.version` for readiness (e.g. `007_sales_meeting`); optional in development/test |
| `SESSION_TTL_SECONDS` | no | opaque session lifetime; defaults to `28800` (8 hours) |
| `LOGIN_RATE_LIMIT_MAX` | no | login attempts allowed per limiter window; defaults to `5` |
| `RATE_LIMIT_WINDOW_MS` | no | login limiter window in milliseconds; defaults to `60000` |
| `BOOTSTRAP_ORGANIZATION_NAME` | bootstrap only | first organization name |
| `BOOTSTRAP_ADMIN_NAME` | bootstrap only | first Admin display name |
| `BOOTSTRAP_ADMIN_EMAIL` | bootstrap only | first Admin email |
| `BOOTSTRAP_ADMIN_PASSWORD` | bootstrap only | first Admin password; 12 to 128 characters |
| `DEV_SEED_ORGANIZATION_NAME` | seed only | local demo organization name |
| `DEV_SEED_PASSWORD` | seed only | local demo password; 12 to 128 characters |

Production secrets must come from the deployment environment. Raw passwords, session tokens, cookies, and authorization headers must never be committed or logged.

## Backup and restore

Scripts and contracts: [docs/operations/backup-restore.md](docs/operations/backup-restore.md).

| Capability | Status |
|------------|--------|
| Local scheduled backup scripts | available |
| Disposable restore automated tests | available with `TEST_DATABASE_URL` |
| Host restore rehearsal record | pending until executed on pilot host |
| Real offsite copy | pending destination + credentials |

Cloudflare Tunnel does **not** move backups off-host.

## Health and troubleshooting

```bash
curl -fsS http://127.0.0.1:3000/api/health
# production pilot public: curl -fsS https://app.example.com/api/health
```

See operations runbooks for tunnel/VPS failures. Do not share passwords, cookies, or full database URLs when escalating.

## Documentation

- **User manual (TR):** `docs/user-manual/servora-med-user-manual.md`
- Product scope: `PRODUCT_REQUIREMENTS.md`
- Architecture: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Schema contract: `SERVORA_MED_SCHEMA_DRAFT.md`
- API contract: `SERVORA_MED_API_DRAFT.md`
- Slice order: `SERVORA_MED_MVP_SLICES.md`
- UI context: `PRODUCT.md` and `DESIGN.md`
- Durable decisions: `DECISIONS.md`
- Agent discipline: `AGENTS.md`
- macOS pilot + Tunnel: `docs/operations/local-macos-cloudflare-tunnel.md`
- Ubuntu VPS: `docs/operations/production-deployment.md`
- Backup/restore: `docs/operations/backup-restore.md`
- Ops templates: `ops/`
