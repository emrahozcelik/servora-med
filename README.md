# Servora-Med

Servora-Med is a browser-based B2B operations platform for medical and dental product companies. Slice 02 provides secure authentication plus the complete product-delivery tracer backend.

## Current Scope

Implemented through Slice 02:

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

Not implemented yet:

- customer, contact, product, and staff administration screens
- Product Delivery mobile workflow UI
- reporting and realtime
- password-change UI (the secured backend endpoint exists)

## Prerequisites

- Node.js 22.12 or newer
- PostgreSQL 16 or newer
- npm

## Server Setup

```bash
cd server
npm install
cp .env.example .env
```

Create the local PostgreSQL database named by `DATABASE_URL`, then run:

```bash
npm run migrate
npm run dev
```

The migration creates the migration ledger and Slice 01 auth tables: `organizations`, `users`, and `sessions`.

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

Public health:

```text
GET http://127.0.0.1:3000/api/health
```

Response:

```json
{
  "status": "ok"
}
```

The public response intentionally contains no database, environment, host, filesystem, or dependency detail.

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

Authenticated JobCard routes are available under `/api/job-cards`. The tracer supports JobCard create/read/patch, delivery-item mutations, activity reads, and named `start`, `submit-for-approval`, `approve`, and `request-revision` commands. Staff scope, manager review authority, organization ownership, expected version, and critical-action idempotency are enforced by the backend.

Slice 02 was verified against a disposable local PostgreSQL 16.13 database through migration, development seed, Staff/Manager login, approved delivery flow, revision flow, and direct activity/constraint queries. The disposable database was removed after verification.

## Product Delivery Mobile UI

Slice 03 provides the first role-aware browser tracer. Staff can create a structured product delivery, select its purpose and quantity, start it, and submit it for manager approval. Managers receive an approval queue with immutable delivery details and activity history, then approve or return the work with a required revision reason.

The flow was manually verified in Chromium at a 390 by 844 CSS px viewport against disposable PostgreSQL. It also passed keyboard navigation, visible focus, 44 CSS px target, 200 percent text-size, 320 CSS px effective 400-percent reflow, reduced-motion, and semantic accessibility snapshot checks. The verification record is maintained in `docs/superpowers/plans/2026-07-11-slice-03-delivery-mobile-ui.md`.

## People Backend

Slice 04 adds Admin-only user administration and Admin/Manager Staff profile APIs. Security-sensitive user changes use named role, activation, deactivation, and password-reset commands with integer optimistic versions. Staff profile summaries expose backend-derived open, waiting-approval, revision, completed-this-month, and overdue counters.

The development seed creates one Staff profile linked to the demo Manager in the same transaction as the demo users. A disposable PostgreSQL tracer verified forced password change, Staff creation/profile reads, Manager profile update, assigned-Staff lifecycle protection, eligible deactivation, session revocation, inactive login rejection, and atomic People audit events. The disposable database is removed after verification.

## Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm test -- --run
cd web && npm run build
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | no | `development`, `test`, or `production`; defaults to development |
| `HOST` | no | listen address; defaults to `127.0.0.1` |
| `PORT` | no | listen port; defaults to `3000` |
| `DATABASE_URL` | yes | PostgreSQL connection URL |
| `LOG_LEVEL` | no | Fastify/Pino log level; defaults to `info` |
| `CORS_ORIGIN` | production | single exact web origin without a path; local default is `http://127.0.0.1:5173` |
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

## Documentation

- Product scope: `PRODUCT_REQUIREMENTS.md`
- Architecture: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Schema contract: `SERVORA_MED_SCHEMA_DRAFT.md`
- API contract: `SERVORA_MED_API_DRAFT.md`
- Slice order: `SERVORA_MED_MVP_SLICES.md`
- UI context: `PRODUCT.md` and `DESIGN.md`
- Durable decisions: `DECISIONS.md`
- Agent discipline: `AGENTS.md`
