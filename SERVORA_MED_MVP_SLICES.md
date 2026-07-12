# Servora-Med MVP Slices

> Date: 2026-07-10  
> Status: Approved Phase 0 implementation order  
> Responsibility: Delivery sequence, dependencies, acceptance criteria, and verification SSOT

## 1. Delivery Rules

1. Work proceeds in order unless the user explicitly reprioritizes it.
2. Each slice produces an independently reviewable result.
3. Backend owns domain rules and permissions.
4. Critical mutations include activity, idempotency, concurrency, and ownership behavior in the same slice.
5. UI slices include loading, empty, error, forbidden, retry, and stale-version states.
6. WCAG 2.2 Level AA is part of acceptance, not post-MVP polish.
7. Restaurant POS domain is never copied or renamed into Servora-Med.
8. Every completed implementation slice reports exact commands and results.

Minimum implementation verification:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Relevant lint and focused accessibility commands are added when the project tooling exists.

## 2. Slice Map

| # | Slice | Depends on | Independently useful result |
| --- | --- | --- | --- |
| 00 | Scaffold and safety baseline | none | buildable Fastify/React/PostgreSQL skeleton |
| 01 | Secure auth and admin bootstrap | 00 | safe login, logout, session, role shell |
| 02 | Product-delivery tracer bullet backend | 01 | complete delivery and approval domain path through API |
| 03 | Product-delivery tracer bullet mobile UI | 02 | staff-to-manager workflow in browser |
| 04 | Users and staff profiles | 01 | operational user administration and profile visibility |
| 05 | Customers and contacts | 01 | maintained CRM records |
| 06 | Product catalog | 01 | maintained product reference data |
| 07 | Notes, timeline, and Kanban/list | 02-06 | full operational board and audit reading |
| 08 | Staff profile and operational reports | 02, 04-07 | staff and manager summaries |
| 09 | General Task | 02, 07 | second validated JobCard type |
| 10 | Structured Sales Meeting | 07 | meeting workflow with reportable details |
| 11 | Production deployment, backup, and hardening | 01-10 | VPS pilot readiness |
| 12 | WebSocket, only if polling is insufficient | 07 | measured realtime improvement |

Warehouse, accounting, native mobile, custom fields, and user-defined tables are not slices in this plan.

## 3. Slice 00: Scaffold and Safety Baseline

**Goal:** Create a greenfield monorepo with build, migration, and test foundations.

### Deliverables

- `server/` Fastify and TypeScript application shell
- `web/` React, Vite, and TypeScript application shell
- PostgreSQL pool and migration runner
- configuration validation
- error mapping and log-redaction baseline
- generic health endpoint
- Vitest smoke test and test-database setup
- mobile-first CSS reset and app shell baseline
- README with local environment and commands

### Acceptance

- [ ] Server build passes.
- [ ] Server smoke test passes against the intended test setup.
- [ ] Web build passes.
- [ ] No restaurant table, route, role, or terminology exists.
- [ ] Missing required environment values fail clearly.
- [ ] Public health output is generic.
- [ ] Password, token, cookie, and authorization headers are configured for redaction before auth is added.

### Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

## 4. Slice 01: Secure Auth and Admin Bootstrap

**Goal:** Provide production-shaped browser authentication before domain work begins.

### Backend

- organizations, users, and sessions migration group
- global case-insensitive email uniqueness
- password hashing
- opaque session token with persisted hash only
- `HttpOnly`, `Secure`, `SameSite=Lax` cookie
- login, logout, `/me`, and password change
- expiry and revoke behavior
- login rate limit
- exact production origin and unsafe-method Origin validation
- admin, manager, and staff role guard
- production first-admin bootstrap command
- development seed command that refuses production

### Frontend

- accessible login page
- credentialed API client
- protected route shell
- role-aware navigation
- expired-session and authentication-error handling

### Acceptance

- [ ] Valid login sets the cookie and returns safe user data without a raw token.
- [ ] Invalid credentials return generic `401 UNAUTHORIZED`.
- [ ] Database stores only `token_hash`.
- [ ] Frontend does not store auth tokens in Web Storage.
- [ ] Logout revokes the session and clears the cookie.
- [ ] Expired and revoked sessions fail authentication.
- [ ] Login rate limit is verified.
- [ ] Unsafe production request with mismatched Origin is rejected.
- [ ] Staff cannot use an admin-only route.
- [ ] Development seed refuses production execution.
- [ ] Login is usable by keyboard with visible focus and accessible labels.

### Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Focused tests cover login success/failure, token hashing, revoke, expiry, rate limit, Origin validation, and role guard.

## 5. Slice 02: Product-Delivery Tracer Bullet Backend

**Goal:** Validate the highest-risk domain path before building full administration screens.

### Reference data

Use the development seed or minimum authenticated setup for:

- one organization
- one staff user
- one manager
- one customer
- one product

Full customer and product admin screens are not dependencies.

### Backend path

- JobCard and delivery-item tables
- JobCard `version`
- activity and processed-action tables
- staff-scoped create, list, and detail
- delivery-item create, patch, and remove
- named `start`, `submit-for-approval`, `approve`, and `request-revision` commands
- immutable review state
- terminal-state immutability
- organization ownership validation
- canonical activity events in the business transaction
- critical-command idempotency
- expected-version conflict behavior

### Acceptance

- [x] Staff creates a `PRODUCT_DELIVERY` assigned to themselves.
- [x] Staff cannot assign the JobCard to another user.
- [x] Delivery item records product, `deliveryPurpose`, positive quantity, and `deliveredAt`.
- [x] Product snapshot comes from the selected same-organization product.
- [x] Missing purpose, time, product, customer, assignee, or positive quantity blocks approval submission.
- [x] `CONSIGNMENT` and `RETURN` create no stock or financial side effect.
- [x] Staff submission moves `IN_PROGRESS` to `WAITING_APPROVAL`.
- [x] Staff approval attempt returns `403 FORBIDDEN`.
- [x] Manager approval moves `WAITING_APPROVAL` to `COMPLETED`.
- [x] Manager revision request requires a reason.
- [x] Neither staff nor manager can patch commercial fields in `WAITING_APPROVAL`.
- [x] Stale `expectedVersion` returns `409 VERSION_CONFLICT` with no mutation or activity.
- [x] Duplicate completed critical command returns its original response without a duplicate event.
- [x] Concurrent duplicate command returns `409 ACTION_IN_PROGRESS` or the completed original response according to timing.
- [x] Cross-organization customer, product, assignee, or JobCard access is rejected.
- [x] Each successful business command appends the canonical event in the same transaction.

### Required canonical events in this slice

```text
JOB_CREATED
JOB_STARTED
JOB_SUBMITTED_FOR_APPROVAL
JOB_APPROVED
JOB_REVISION_REQUESTED
JOB_FIELDS_UPDATED
DELIVERY_ITEM_ADDED
DELIVERY_ITEM_UPDATED
DELIVERY_ITEM_REMOVED
```

### Verification

```bash
cd server && npm run build
cd server && npm test -- --run
```

Focused tests cover the full tracer path, negative role checks, submit invariants, transaction rollback, duplicate action, version conflict, and cross-organization rejection.

## 6. Slice 03: Product-Delivery Tracer Bullet Mobile UI

**Goal:** Make the tracer path usable from staff mobile action through manager review.

### Staff flow

- sign in
- view own JobCards
- create product delivery
- select seeded customer and product
- enter purpose, quantity, and delivered time
- start and submit for approval
- see success, failure, retry, and waiting state

### Manager flow

- sign in
- view approval queue
- inspect immutable delivery details and activity
- approve or request revision

### Accessibility and responsive acceptance

- [x] Primary flow is usable at approximately 390 CSS px without horizontal page scrolling.
- [x] Primary controls have at least 44 by 44 CSS px interaction areas where applicable.
- [x] Every field has an accessible label; placeholder is not the label.
- [x] Required and error states are not communicated by color alone.
- [x] Visible focus follows the logical task order.
- [x] Staff and manager flows can be completed with keyboard without drag and drop.
- [x] Submit errors identify the problem and correction.
- [x] Loading skeleton, empty state, forbidden state, network retry, and stale-version state are designed.
- [x] `prefers-reduced-motion` removes nonessential movement without removing feedback.
- [x] At 200 percent text size the flow remains usable.
- [x] At supported 400 percent zoom the content reflows and primary actions remain available.
- [x] Screen-reader semantics are manually checked for login, delivery form, approval queue, and result feedback.

### Verification

```bash
cd web && npm run build
```

Run configured component tests and accessibility automation, then record manual keyboard, zoom, touch-target, and screen-reader checks. Automation does not replace manual verification.

## 7. Slice 04: Users and Staff Profiles

**Goal:** Replace seed-only staff setup with role-aware administration and first-class profiles.

### Deliverables

- admin user list, create, update, deactivate, and password reset
- staff profile create/update linked one-to-one with user
- manager assignment
- own-profile read
- manager organization-wide profile read
- staff JobCard counters from persisted data

### Acceptance

- [x] Admin creates manager and staff users.
- [x] Staff cannot create, role-change, or deactivate users.
- [x] Profile and manager belong to the same organization.
- [x] User inactive state controls profile availability; no duplicate profile active flag exists.
- [x] Profile contains no undefined generic monthly target.
- [x] Staff can view only their own profile unless explicitly authorized.
- [x] Forms meet the shared accessibility criteria.

## 8. Slice 05: Customers and Contacts

**Goal:** Replace seeded customer data with role-aware CRM maintenance.

### Acceptance

- [ ] Manager creates clinic, hospital, dealer, company, or other customer.
- [ ] Manager adds contacts under same-organization customers.
- [ ] Staff can read organization customer and contact records but cannot mutate them.
- [ ] Customer lifecycle uses `prospect`, `active`, or `inactive` with no duplicate active flag.
- [ ] Default list hides inactive records and can filter them explicitly.
- [ ] Search and mobile forms are usable with keyboard and zoom.

## 9. Slice 06: Product Catalog

**Goal:** Replace seeded product data with managed reference records.

### Acceptance

- [ ] Manager creates, updates, searches, and deactivates products.
- [ ] SKU is unique within organization.
- [ ] Staff has catalog read access only.
- [ ] No stock quantity, stock mutation, or product tracking requirement flags exist.
- [ ] Default catalog price remains reference data and is not copied into delivery items.
- [ ] Product form and search meet shared accessibility criteria.

## 10. Slice 07: Notes, Timeline, and Kanban/List

**Goal:** Provide the full operational reading and coordination surface.

### Deliverables

- append-only notes
- immutable activity timeline using canonical event labels
- desktop Kanban or structured list
- mobile status tabs and lists
- filters for status, type, assignee, customer, priority, and due date
- approval queue
- named action controls
- optional drag and drop as a progressive enhancement only

### Acceptance

- [ ] Staff list is server-scoped to assigned JobCards.
- [ ] Manager sees organization JobCards.
- [ ] Staff can add notes in `WAITING_APPROVAL` without editing commercial data.
- [ ] Activity order is deterministic and events are not duplicated.
- [ ] Completed and cancelled columns are limited, collapsed, or filtered by default.
- [ ] Mobile never renders a squeezed seven-column board.
- [ ] Every drag action has an equivalent accessible command control.
- [ ] Failed transition restores or refetches backend truth.
- [ ] Color is not the only indicator of status, priority, lateness, or result.

## 11. Slice 08: Staff Profile and Operational Reports

**Goal:** Derive trusted operational summaries from persisted data.

### Deliverables

- manager dashboard counters
- staff self and manager-visible profile summaries
- delivery quantity grouped by purpose, product, staff, and actual delivery date
- approval queue age
- open, overdue, waiting, revision, and completed counts

### Acceptance

- [ ] Reports use database queries, not frontend aggregates.
- [ ] Staff can request only their own summary.
- [ ] Manager can request organization staff summaries.
- [ ] Delivery reporting uses `deliveredAt`, not approval-submission time.
- [ ] Reports contain no revenue, margin, commission, invoice, payment, or inventory valuation.
- [ ] Empty data and date-range errors are accessible and understandable.

## 12. Slice 09: General Task

**Goal:** Add the second pilot-core JobCard workflow without weakening the state machine.

### Acceptance

- [ ] General Task requires title and eligible assignee.
- [ ] It uses the same plan, start, submit, approve, revision, resume, and cancel commands.
- [ ] Product delivery fields are neither required nor accepted for General Task.
- [ ] Approval, activity, idempotency, concurrency, ownership, and immutability tests apply.
- [ ] Mobile quick create and manager review remain accessible.

## 13. Slice 10: Structured Sales Meeting

**Goal:** Add Sales Meeting only when reportable structured details are implemented.

### Deliverables

- `SALES_MEETING` JobCard type migration
- one-to-one meeting details
- meeting time
- outcome
- optional next follow-up time
- meeting summary
- submit requirements
- mobile entry and manager review
- staff meeting summary query

### Acceptance

- [ ] Meeting type and details ship in the same migration and domain slice.
- [ ] Submit requires customer, assignee, meeting time, outcome, and summary.
- [ ] Follow-up time is optional but validated when present.
- [ ] Meeting lifecycle uses canonical JobCard commands and events.
- [ ] Unstructured notes do not replace required meeting details.

## 14. Slice 11: Production Deployment, Backup, and Hardening

**Goal:** Make the completed pilot safe to operate on a public VPS.

### Deliverables

- production configuration validation
- exact credentialed CORS origin
- unsafe-method Origin enforcement
- TLS reverse-proxy guide
- rate-limit review
- sensitive log-redaction verification
- generic health behavior
- graceful shutdown
- backup script with external operations logging
- offsite-copy guidance
- restore procedure and rehearsal record
- systemd deployment notes

### Acceptance

- [ ] Production refuses unsafe CORS and cookie settings.
- [ ] Auth secrets and sensitive payloads do not appear in logs.
- [ ] Public health reveals no infrastructure detail.
- [ ] Backup exits clearly on failure and records timestamp and destination externally.
- [ ] Restore is performed against a safe test target and documented.
- [ ] No product-domain backup status table is required.
- [ ] Full server tests and both builds pass.

## 15. Slice 12: WebSocket Only if Polling Is Insufficient

**Goal:** Add realtime only after pilot evidence shows polling or manual refresh is inadequate.

### Entry criteria

- measured delay harms manager workflow
- expected concurrent board usage is documented
- polling interval and server cost have been evaluated

### Acceptance if implemented

- [ ] Database remains source of truth.
- [ ] Events are scoped from authenticated organization, never client-selected organization.
- [ ] Reconnect and missed-event recovery are defined.
- [ ] Duplicate events do not duplicate UI state.
- [ ] Polling or refetch remains a recovery path.
- [ ] JobCard correctness does not depend on an active socket.

## 16. MVP Pilot Definition of Done

The pilot is complete when:

1. Secure authentication and three backend-enforced roles work.
2. Staff completes product delivery on mobile and manager approves or requests revision.
3. Product delivery records purpose, quantity, and actual delivery time without financial or stock side effects.
4. JobCard commands enforce transition, ownership, immutable-state, idempotency, and version rules.
5. Customers, contacts, products, users, and staff profiles are maintainable by authorized roles.
6. Notes and canonical activity timeline are visible.
7. Desktop manager board/list and mobile staff list are usable.
8. General Task works through the same approval engine.
9. Operational reports derive from persisted data.
10. Critical flows satisfy WCAG 2.2 Level AA acceptance.
11. Deployment, backup, and restore procedures are verified.
12. Server build, server tests, and web build pass.

Sales Meeting can follow as its structured slice without blocking the product-delivery pilot. WebSocket does not block pilot completion.
