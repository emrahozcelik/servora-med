# Servora-Med Architecture Plan

> Date: 2026-07-10  
> Status: Approved Phase 0 architecture  
> Responsibility: Technical and architectural decision SSOT

## 1. Responsibility Map

| Concern | Source of truth |
| --- | --- |
| Product scope and workflows | `PRODUCT_REQUIREMENTS.md` |
| Product design context | `PRODUCT.md` |
| Durable decisions | `DECISIONS.md` |
| Architecture | `SERVORA_MED_ARCHITECTURE_PLAN.md` |
| Data model | `SERVORA_MED_SCHEMA_DRAFT.md` |
| API contract | `SERVORA_MED_API_DRAFT.md` |
| Delivery order and acceptance | `SERVORA_MED_MVP_SLICES.md` |
| Agent discipline | `AGENTS.md` |
| Historical planning inputs | `docs/archive/inputs/` |

This document does not duplicate complete schema columns, endpoint payloads, or slice acceptance criteria.

## 2. Architecture Goals

Servora-Med is a VPS-ready browser application for medical and dental B2B operations. Its core qualities are:

- reliable backend-owned domain rules
- structured product-delivery data
- mandatory manager approval
- append-only operational history
- mobile usability for field staff
- clear organization ownership boundaries
- small, testable vertical slices

The system remains a modular monolith until the MVP is stable.

## 3. System Topology

```text
[Mobile and Desktop Browser]
            |
           HTTPS
            |
      [Nginx or Caddy]
       |            |
  [React SPA]   [/api -> Fastify]
                       |
                  [PostgreSQL]
```

Target runtime:

- Node.js 22.12 or newer
- Fastify with TypeScript
- PostgreSQL 16 or newer
- React and Vite
- Nginx or Caddy for TLS and reverse proxy
- systemd for process supervision
- external backup destination controlled by an operations script

Native mobile, Electron, Tauri, and LAN-first store-server deployment are outside scope.

## 4. Greenfield Boundary and Servora-POS Reference

Servora-Med is a greenfield application, not a Servora-POS refactor.

Servora-POS may be consulted for proven technical patterns:

- Fastify boot and plugin wiring
- PostgreSQL pool and migration runner
- modular route, handler, service, and type separation
- atomic idempotency claim pattern
- error mapping and safe logging
- rate limiting, CORS, and graceful shutdown
- Vitest and test-database setup
- VPS backup script structure

Restaurant domain code is not copied or renamed. Tables, orders, menu items, payments, shifts, printers, kitchen flows, and restaurant roles have no place in Servora-Med.

## 5. Backend Module Contract

Each business module follows this responsibility split:

| File | Responsibility |
| --- | --- |
| `routes.ts` | URL, method, schema, authentication, and middleware wiring |
| `handlers.ts` | Translate HTTP input and service output |
| `service.ts` | Domain behavior, authorization decisions, transactions, and invariants |
| `types.ts` | DTOs, row types, command types, and mappers |

Rules:

- Handlers do not contain SQL or domain decisions.
- Services do not depend on Fastify request objects.
- Database access is not performed by frontend code.
- Business-critical validation is enforced by service logic and supported by database constraints where practical.
- Multi-step mutations and their activity events share one transaction.

Initial modules:

```text
auth
users
staff
customers
contacts
products
job-cards
reports
health
```

## 6. Frontend Contract

| Area | Responsibility |
| --- | --- |
| `pages/` | Route-level workflow composition |
| `components/` | Reusable UI and domain presentation |
| `hooks/` | Reusable client behavior and server-state coordination |
| `services/` | API contracts and command calls |
| `store/` | UI state such as filters and selected records |

Frontend rules:

- Backend state is authoritative.
- Frontend does not maintain a second transition engine.
- Optimistic UI is used only when reconciliation and rollback are safe.
- Critical actions expose loading, success, validation, authorization, retry, and version-conflict states.
- The Slice 07 board is read-only; lifecycle changes use explicit named controls in detail.
- Mobile is a dedicated layout mode, not a compressed desktop board.
- UI strategy and accessibility are governed by `PRODUCT.md` and `DECISIONS.md`.

The JobCard workspace uses one canonical server list projection for list and board cards.
The desktop board groups active states only and reports completed/cancelled counts; mobile
always uses the structured list and does not request board data. Core detail, notes, and
activity have independent request/error states so a related-section failure does not hide
the JobCard or delivery facts.

## 7. Domain Boundaries

### 7.1 JobCard core

`JobCard` is the central domain object. Pilot-core types are:

- `PRODUCT_DELIVERY`
- `GENERAL_TASK`
- `SALES_MEETING`

Sales Meeting uses the same lifecycle engine, notes, activity, idempotency, visibility,
and `job_cards.version` concurrency source as the other types. Its result is stored in a
one-to-one structured detail row; `dueDate` is the planned organization-local day and
`meetingAt` is the actual instant. Quote follow-up, collection follow-up, warehouse,
accounting, and configurable record types are outside MVP.

### 7.2 State machine

```text
NEW -> PLANNED -> IN_PROGRESS -> WAITING_APPROVAL -> COMPLETED
                              -> REVISION_REQUESTED -> IN_PROGRESS
NEW | PLANNED | IN_PROGRESS | REVISION_REQUESTED -> CANCELLED
```

Transitions use named backend commands. A generic status patch or generic transition endpoint is not supported.

Required invariants:

- Staff cannot approve.
- Approval starts only from `WAITING_APPROVAL`.
- Revision requires a reason.
- Type-specific submit requirements are validated before state changes.
- Staff and manager cannot edit commercial fields in `WAITING_APPROVAL`.
- Manager can only approve or request revision while reviewing.
- `COMPLETED` and `CANCELLED` are immutable in MVP.

### 7.3 Product delivery

Product delivery stores purpose, positive quantity, product snapshot, and actual `delivered_at`. `staff_completed_at` remains the approval-submission time and is not treated as delivery time.

Delivery purposes are `SALE`, `SAMPLE`, `CONSIGNMENT`, `RETURN`, and `OTHER`. They are operational classifications. No purpose creates inventory, invoice, payment, revenue, or commission side effects in MVP.

### 7.4 General Task

General Task is the second pilot-core JobCard type. It uses the same persistence model,
processed-action boundary, state machine, approval engine, notes, and activity timeline as
Product Delivery. Creation and submission delegate only their type-specific requirements
to exhaustive policies: General Task requires a non-empty title and eligible assignee,
while Customer and Contact remain optional common context.

The public create contract is one exact `type`-discriminated union. Staff self-assignment
and management assignee eligibility are shared policies, so Product Delivery behavior does
not fork. Canonical detail uses organization-scoped joins for assignee, Customer, and
Contact display identities. The web detail shell selects a small type presentation;
General Task never calls or renders delivery-item subresources, and all four delivery
operations reject it with `INVALID_JOB_TYPE`.

The stable quick-create route is `/jobs/new-task`; `/jobs/new-delivery` remains unchanged.
This slice adds no migration, generic form builder, JSON details model, new dependency,
financial behavior, inventory behavior, or report storage.

### 7.5 Structured Sales Meeting

Sales Meeting is the third canonical JobCard type and uses a two-stage planning/result
flow. Creation atomically writes the JobCard and one empty `job_card_meeting_details`
row. The exact `/jobs/new-meeting` form owns planning; the type-aware detail shell alone
loads and patches `/api/job-cards/:id/meeting-details`. Other JobCard types never request
that subresource.

Meeting result mutation locks the JobCard before its detail row, validates one
`expectedVersion`, updates the detail, bumps the parent version once, and appends one
`MEETING_DETAILS_UPDATED` event in the same transaction. Activity carries only changed
field names. Submit readiness deterministically validates Customer, assignee, then actual
meeting time/outcome/summary. Approved Staff reporting groups only completed Sales
Meetings by outcome using actual `meeting_at` and `assigned_to`; delivery reports remain
Product Delivery-only.

### 7.6 Activity timeline

Critical JobCard commands append a canonical activity event in the same transaction. Lifecycle events carry old and new status, so no second generic status-change event is created.

JobCard activity is scoped to JobCard operations. Organization-level configuration audit requires a separate future design.

### 7.7 Operational reports read model

Reports is a read-only module inside the modular monolith. It derives organization-scoped
operational summaries from persisted JobCard and delivery data and owns no report table,
cache, materialized view, mutation, or migration.

The Reports module consumes the canonical JobCard approval projection through a narrow
port; it does not copy the JobCard list DTO mapping. People consumes only the Reports
module's `StaffOperationalSummaryPort` and related types through type-only imports.
`getMany` batches Staff summaries for `listStaff`, while `getOne` serves profile detail.
Reports never calls People, no module calls another through HTTP, and the composition root
constructs and injects one Reports repository instance. This dependency direction avoids
a People/Reports runtime cycle and preserves one Staff counter definition.

All Staff report attribution uses `job_cards.assigned_to`. Delivery quantities remain
exact decimal strings grouped by persisted nullable unit, and organization-local date
boundaries are resolved by PostgreSQL. Approval age uses one authoritative request time,
clamps future submission timestamps to zero, and derives summary totals from the complete
queue rather than its current page. Staff meeting outcomes use completed
`SALES_MEETING` rows, actual `meeting_at`, the same organization-local range, canonical
four-row zero-filled ordering, and the same assigned Staff ownership.

## 8. Authentication and Session Security

Authentication uses email and password with an adaptive password hash. Session behavior:

- The server creates a high-entropy opaque token.
- Only `token_hash` is persisted.
- The raw token is delivered in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
- Login, logout, expiration, revocation, and cleanup behavior are explicit.
- Login is rate limited.
- Passwords, password hashes, raw tokens, cookies, and session identifiers are redacted from logs.
- Credentialed CORS is restricted to the configured production origin.
- Cookie-based mutations follow the CSRF posture defined in the API contract.

The frontend does not store authentication tokens in Web Storage.

## 9. Organization Ownership Boundary

V1 runs one organization per deployment. It is not presented as SaaS multi-tenancy.

`organization_id` remains an ownership boundary so every query and relationship is scoped explicitly. The organization identity comes from the authenticated session, never from a trusted client body field.

Required ownership invariants:

- Login email is globally unique case-insensitively in V1.
- JobCard, customer, contact, product, delivery item, and assigned user belong to the same organization.
- Staff queries are additionally scoped to their authenticated user where required.
- Service validation protects cross-organization relationships; composite database constraints are used where they stay understandable and maintainable.

## 10. Idempotency and Concurrency

These mechanisms solve different problems.

### Idempotency

Atomic processed-action claims protect business-event commands against retry and double tap:

- JobCard creation
- delivery-item creation
- submit for approval
- manager approval
- revision request
- cancellation

The service claims the action before side effects, performs the mutation and activity append transactionally, then stores the completed response. Concurrent duplicate execution returns a clear in-progress conflict.

Ordinary profile, customer, contact, and product field updates do not use full response-caching idempotency unless a later side effect justifies it.

### Optimistic concurrency

JobCard uses an integer `version`. Field updates and named lifecycle commands provide `expectedVersion`. The database update includes the expected version and increments it atomically.

If the stored version differs, the operation performs no mutation and returns `409 VERSION_CONFLICT`. This prevents two different clients from silently overwriting one another even when their action identifiers are different.

## 11. Data and Migration Strategy

- PostgreSQL migrations are append-only after application.
- Migrations are grouped by executable slice dependency, not one monolithic initial schema and not one file per table.
- Development/demo data is loaded by `npm run db:seed:dev`, which refuses production execution.
- Production first-admin setup uses a separate bootstrap CLI or environment-controlled one-shot operation.
- Critical relational and numeric invariants use database constraints where practical.
- DTO, row type, and schema draft terminology stay aligned.
- Business records use status-based deactivation or soft delete when history matters.

No production migration installs known demo credentials.

## 12. Realtime Boundary

Polling or manual refresh is sufficient for the pilot until measured usage proves otherwise. PostgreSQL remains the source of truth.

WebSocket event replay is an optional later slice. It is not a dependency of JobCard correctness, approval, board usability, or pilot readiness.

## 13. Configurability Boundary

The product may later support controlled saved views and display preferences. Configuration cannot alter:

- canonical fields and enums
- state machine transitions
- manager approval
- role boundaries
- delivery submit invariants
- ownership boundaries
- idempotency and concurrency rules
- activity obligations
- completed and cancelled immutability

General JSON settings bags, custom fields, user-created database tables, form builders, and workflow designers are outside MVP.

## 14. Deployment and Operations

### Initial pilot topology (Slice 12)

```text
Internet
  → Cloudflare Edge TLS (public hostname HTTPS)
    → named Cloudflare Tunnel
      → cloudflared LaunchDaemon (boot; /etc/cloudflared/)
        → Caddy http://<public-fqdn>:8080 bind 127.0.0.1 only
          ├── static web/dist
          └── /api/* → Fastify 127.0.0.1:3000 → PostgreSQL local only
```

- No inbound application (3000) or PostgreSQL ports; no router port forwarding.
- Public HTTPS semantics: browser is HTTPS even though the tunnel origin is local HTTP.
- Client IP for login rate limits: `CF-Connecting-IP` → Caddy `trusted_proxies` (loopback) + `client_ip_headers` → `X-Forwarded-For {client_ip}` + `X-Forwarded-Proto https` → Fastify `TRUSTED_PROXY=loopback`.
- Cloudflare Tunnel does **not** replace Servora-Med session auth and does **not** move backups off-host.
- Runbook: `docs/operations/local-macos-cloudflare-tunnel.md`. Templates: `ops/caddy/Caddyfile.tunnel.example`, `ops/cloudflared/`, `ops/launchd/`.

### Ubuntu VPS reference (Slice 11)

Production assumptions (still supported):

- TLS terminates at **Caddy** on the VPS (canonical for this topology). Nginx remains an architecture-level alternative only.
- Fastify binds loopback only and trusts only a configured **loopback** proxy hop.
- CORS allows only the production **https** web origin with credentials.
- Schema migrations run via explicit `migrate:prod`, not on process start.
- Health readiness is generic for unauthenticated callers (`ok` / `unavailable`).
- Process handles graceful termination with bounded shutdown.
- Database backup scripts write exit status, timestamp, and destination to external operations logs.
- Backup copies leave the host through an optional encrypted offsite hook.
- Restore is rehearsed against disposable targets; production target guards are mandatory.

Backup status does not require a product-domain database table in MVP.  
Runbooks: `docs/operations/local-macos-cloudflare-tunnel.md` (pilot), `docs/operations/production-deployment.md` (VPS), `docs/operations/backup-restore.md`.

## 15. Verification Strategy

Minimum implementation commands:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Critical automated coverage:

- authentication and role boundaries
- staff data visibility
- transition matrix and invalid transitions
- staff approval rejection
- product-delivery submit requirements
- immutable review and terminal states
- activity event transactionality
- idempotent command replay and concurrent duplicate handling
- stale `expectedVersion`
- cross-organization relationship rejection
- report query correctness

Critical UI coverage includes mobile width, keyboard completion, visible focus, zoom/reflow, reduced motion, and error states.

## 16. Explicitly Out of Scope

- warehouse and stock movements
- accounting, invoices, payments, and financial performance
- attachment upload in pilot core
- native mobile and offline-first database
- multi-tenant SaaS administration
- user-defined tables, custom fields, and workflow design
- mandatory drag and drop
- mandatory WebSocket realtime
- advanced BI
- restaurant POS domain and infrastructure
