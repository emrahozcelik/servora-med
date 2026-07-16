# Servora-Med MVP Slices

> Date: 2026-07-16
> Status: Living implementation order; repository scope verified through Slice 12
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
| 05 | Customers and contacts | 02, 04 | maintained CRM records |
| 06 | Product catalog | 01 | maintained product reference data |
| 07 | Notes, timeline, and Kanban/list | 02-06 | full operational board and audit reading |
| 08 | Staff profile and operational reports | 02, 04-07 | staff and manager summaries |
| 09 | General Task | 02, 07 | second validated JobCard type |
| 10 | Structured Sales Meeting | 07 | meeting workflow with reportable details |
| 11 | Production deployment, backup, and hardening | 01-10 | VPS pilot readiness |
| 12 | Local pilot cutover, installation guide, user manual | 01-11 | macOS + Cloudflare Tunnel pilot |
| 13 | WebSocket, only if polling is insufficient | 07 | measured realtime improvement |

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

- [x] Server build passes.
- [x] Server smoke test passes against the intended test setup.
- [x] Web build passes.
- [x] No restaurant table, route, role, or terminology exists.
- [x] Missing required environment values fail clearly.
- [x] Public health output is generic.
- [x] Password, token, cookie, and authorization headers are configured for redaction before auth is added.

### Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Slice 00 acceptance remains covered by the current server/web builds and CI, configuration
failure tests, generic health projection tests, production logger-redaction tests, and the
Servora-Med-only schema and route vocabulary. These checks remain regression gates in
later slices rather than historical one-time assertions.

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

- [x] Valid login sets the cookie and returns safe user data without a raw token.
- [x] Invalid credentials return generic `401 UNAUTHORIZED`.
- [x] Database stores only `token_hash`.
- [x] Frontend does not store auth tokens in Web Storage.
- [x] Logout revokes the session and clears the cookie.
- [x] Expired and revoked sessions fail authentication.
- [x] Login rate limit is verified.
- [x] Unsafe production request with mismatched Origin is rejected.
- [x] Staff cannot use an admin-only route.
- [x] Development seed refuses production execution.
- [x] Login is usable by keyboard with visible focus and accessible labels.

### Verification

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Focused tests cover login success/failure, token hashing, revoke, expiry, rate limit, Origin validation, and role guard.

Slice 01 acceptance remains covered by the auth service/route/setup suites, PostgreSQL
session schema and seed tests, role-boundary tests, credentialed web client tests, and the
recorded three-role keyboard/focus browser acceptance. Raw session tokens remain confined
to the secure cookie boundary and are never returned in the public user DTO.

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

- [x] Manager creates clinic, hospital, dealer, company, or other customer.
- [x] Manager adds contacts under same-organization customers.
- [x] Staff can read organization customer and contact records but cannot mutate them.
- [x] Customer lifecycle uses `prospect`, `active`, or `inactive` with no duplicate active flag.
- [x] Default list hides inactive records and can filter them explicitly.
- [x] Search and mobile forms are usable with keyboard and zoom.

### Verification

Slice 05 was closed on 2026-07-13 with server 27 files/175 tests passing (2 files/3
PostgreSQL-gated tests skipped there and passed separately), web 19 files/103 tests
passing, both builds passing, and both dependency audits reporting zero vulnerabilities.
The authenticated `/login -> /jobs` redirect is covered by the final routing regression.
Migrations 001–004, development seed, forced
password changes, Customer/Contact lifecycle, primary replacement, Contact-linked
JobCard creation, active-job guards, Staff-assignment cleanup, audit safety,
cross-organization concealment, rollback, and two-client concurrency were verified on
disposable PostgreSQL 16.13 databases; the live PostgreSQL suites passed all 3 tests and
the databases were then removed.

Playwright acceptance covered Manager and Staff flows at desktop, 390×844, and 320 CSS
px effective reflow widths. Keyboard-only Contact creation/cancellation, visible focus
and restoration, 44×44 targets, 200% text enlargement, reduced motion, semantic
landmarks/labels/live feedback, direct nested URLs, Back/Forward/refresh, and absence of
horizontal page scrolling passed. The detailed record is in
`docs/superpowers/plans/2026-07-12-customers-contacts.md`.

## 9. Slice 06: Product Catalog

**Goal:** Replace seeded product data with managed reference records.

### Acceptance

- [x] Admin and Manager can create a Product with only a non-empty name.
- [x] SKU, brand, category, model, unit, and reference price are optional informational fields.
- [x] SKU has no inventory, accounting, format, or uniqueness meaning in MVP.
- [x] Staff can read the organization catalog but cannot mutate it.
- [x] Product mutations use `version` and `expectedVersion`.
- [x] Product active state changes only through named activate/deactivate commands.
- [x] Inactive Products cannot be selected for new delivery items or as a replacement Product.
- [x] Existing delivery snapshots remain unchanged when catalog data changes or a Product is deactivated.
- [x] No stock quantity, movement, costing, invoice, revenue, price-history, currency, or accounting behavior is introduced.
- [x] Product forms, lists, search, conflict handling, lifecycle actions, and delivery selection meet shared accessibility criteria.

**Completion record (2026-07-13):** Migration 005, canonical Product API, role and
lifecycle policy, optimistic concurrency, safe audit, searchable delivery selection,
disposable PostgreSQL, full automated gates, and Playwright desktop/mobile/accessibility
acceptance passed. The detailed evidence is in
`docs/superpowers/plans/2026-07-13-product-catalog.md`.

Post-review hardening aligned Product API/form limits with PostgreSQL, concealed malformed
UUID paths as `PRODUCT_NOT_FOUND`, preserved focus across successful lifecycle changes,
removed a duplicate unused detail component, and added PostgreSQL-backed GitHub Actions CI.

## 10. Slice 07: Notes, Timeline, and Kanban/List

**Goal:** Provide the full operational reading and coordination surface.

### Deliverables

- notes that are append-only through the public application contract
- immutable activity timeline using canonical event labels
- desktop Kanban or structured list
- mobile status tabs and lists
- filters for status, type, assignee, customer, priority, and due date
- approval queue
- named action controls
- read-only desktop board with explicit named command controls in JobCard detail

### Acceptance

- [x] Staff list is server-scoped to assigned JobCards.
- [x] Manager sees organization JobCards.
- [x] Staff can add notes in `WAITING_APPROVAL` without editing commercial data.
- [x] Activity order is deterministic and events are not duplicated.
- [x] Completed and cancelled work is represented by filtered counts rather than active board columns.
- [x] Mobile never renders a squeezed board and does not request board data.
- [x] Lifecycle changes use explicit accessible command controls; drag and drop is not implemented.
- [x] Failed transition restores or refetches backend truth.
- [x] Color is not the only indicator of status, priority, lateness, or result.

## 11. Slice 08: Staff Profile and Operational Reports

**Goal:** Derive trusted operational summaries from persisted data.

### Deliverables

- read-only organization-scoped Reports module with no report tables or mutations
- manager dashboard counters and one accessible daily completed-JobCard trend
- Staff self and Admin/Manager-visible operational summaries backed by one canonical read model
- manager-approved delivery quantity grouped by purpose, Product snapshot, Staff, and actual delivery date while preserving unit
- approval queue age from Staff submission time
- point-in-time open, overdue, waiting, and revision counts plus period completion/cancellation counts

### Acceptance

- [x] Reports use database queries, not frontend aggregates.
- [x] Every endpoint rejects unknown query parameters, parameters outside its allowlist, and repeated scalar `from`, `to`, `groupBy`, `staffUserId`, `limit`, or `offset` values with `400 VALIDATION_ERROR`.
- [x] Staff can request only their own summary.
- [x] Manager can request organization staff summaries.
- [x] Staff ownership consistently uses `job_cards.assigned_to`; creator, submitter, approver, and activity actors do not determine Staff attribution.
- [x] Date ranges use paired inclusive local dates, default to the organization-local current month, and contain at most 366 calendar dates.
- [x] Delivery reporting includes only `COMPLETED` Product Delivery JobCards and uses `deliveredAt`, not approval-submission time.
- [x] Dashboard counters/trend, Staff counters, and approval metrics include every JobCard type; delivery reports and `deliveriesByPurpose` include only `PRODUCT_DELIVERY`.
- [x] Completion counts use `managerApprovedAt`; cancellation counts use `cancelledAt`; approval age begins at `staffCompletedAt`.
- [x] Quantity remains an exact decimal string and separate for every nullable unit and delivery purpose.
- [x] Delivery `total` counts canonical grouped rows, item and count queries use identical group keys, and quantities always use three decimal places.
- [x] Delivery responses form an exact `groupBy` discriminated union for day, purpose, Product, and Staff items; Staff `deliveriesByPurpose` reuses `DeliveryPurposeItem`.
- [x] Purpose items use canonical purpose order, then persisted unit with explicit null-last ordering.
- [x] Persisted units are not normalized during reporting; `null`, casing differences, and different spellings remain separate groups.
- [x] Product grouping uses persisted delivery snapshots rather than live catalog names.
- [x] Existing People counters and Reports use one `StaffOperationalSummaryPort` source without copied SQL definitions; `getMany` batches `listStaff` without a per-Staff query.
- [x] Composition-root injection creates no People/Reports runtime cycle and no module calls another through HTTP.
- [x] Approval buckets are mutually exclusive at the exact 2-hour, 8-hour, and 24-hour boundaries.
- [x] Approval elapsed time clamps future submission timestamps to zero; summary covers the whole queue, `pendingCount == total`, and bucket totals equal `pendingCount`.
- [x] Missing, cross-organization, non-Staff, and malformed Staff report identifiers all return `404 STAFF_PROFILE_NOT_FOUND`; malformed UUIDs do not reach PostgreSQL.
- [x] Delivery `staffUserId` omission selects all Staff; empty, repeated, or malformed query values return `400`, unavailable valid Staff values return `404 STAFF_PROFILE_NOT_FOUND`, and inactive same-organization Staff is accepted.
- [x] Approval items reuse canonical `JobCardListItem` and add a non-negative integer `waitingMinutes` in completed whole minutes.
- [x] Stable `/reports`, `/reports/deliveries`, `/reports/approvals`, and `/staff/:staffUserId/reports` routes and URL-owned filters preserve refresh, deep links, Back, and Forward; date/group/Staff filter changes reset offset and invalid URL values use replace navigation.
- [x] No report migration is added without a disposable-PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` result that demonstrates the need.
- [x] Reports contain no revenue, margin, commission, invoice, payment, or inventory valuation.
- [x] The trend has a complete semantic table equivalent; empty data and date-range errors are accessible and understandable.

## 12. Slice 09: General Task

**Goal:** Add the second pilot-core JobCard workflow without weakening the state machine.

### Acceptance

- [x] General Task requires title and eligible assignee.
- [x] It uses the same plan, start, submit, approve, revision, resume, and cancel commands.
- [x] Product delivery fields are neither required nor accepted for General Task.
- [x] Approval, activity, idempotency, concurrency, ownership, and immutability tests apply.
- [x] Mobile quick create and manager review remain accessible.

Slice 09 was verified with the exact discriminated create parser, shared Staff and
management assignee policy, optional Customer/Contact relation policy, idempotent create,
exhaustive submission strategy, all four delivery type guards, canonical related-identity
detail projection, list/board type filters, `/jobs/new-task`, and the type-aware detail
shell. General Task contributes to all-type operational counters and approval queues but
never to delivery quantities.

Disposable PostgreSQL 16.13 acceptance covered the full General Task revision and approval
paths, activity and note safety, Staff visibility, both type filters, zero delivery rows,
and Product Delivery-only reports. Browser acceptance covered Staff and Manager flows,
deep links and browser history, keyboard and focus behavior, 44 CSS px targets, mobile and
enlarged-text reflow, reduced motion, semantic structure, and zero General Task delivery
requests. No migration, dependency, generic form builder, JSON details model, financial,
inventory, or report-storage feature was added.

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

- [x] Meeting type and details ship in the same migration and domain slice.
- [x] Submit requires customer, assignee, meeting time, outcome, and summary.
- [x] Follow-up time is optional but validated when present.
- [x] Meeting lifecycle uses canonical JobCard commands and events.
- [x] Unstructured notes do not replace required meeting details.

Slice 10 was verified with migration 007, the exact third create discriminant, one empty
detail row per meeting, target-scoped idempotent result PATCH, one parent JobCard version,
deterministic Customer → assignee → readiness submission validation, safe
`MEETING_DETAILS_UPDATED`, and the shared revision/approval lifecycle. The separate
`/jobs/new-meeting` flow plans the local day; the type-aware detail records actual time,
closed outcome, normalized summary, and optional later follow-up.

All-type workspace, dashboard, approval, and Staff counters include Sales Meeting.
`meetingsByOutcome` uses only completed meetings, `assigned_to`, actual `meeting_at`, and
four canonical zero-filled rows; delivery quantities remain Product Delivery-only and
exact decimal strings. Disposable PostgreSQL passed all 58 server files and 753 tests;
the ordinary server suite passed 732 tests with 21 PostgreSQL skips. The web suite passed
42 files and 335 tests. Both builds and production dependency audits passed. Playwright
covered Staff/Manager plan, result, revision, approval, deep-link/history, mobile,
keyboard/focus, 44 px controls, reduced motion, optional follow-up guidance, safe
timeline, outcome reporting, 200% text, and 400% reflow without horizontal overflow.

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

- [x] Production refuses unsafe CORS and cookie settings.
- [x] Auth secrets and sensitive payloads do not appear in logs.
- [x] Public health reveals no infrastructure detail.
- [x] Backup exits clearly on failure and records timestamp and destination externally.
- [ ] Restore is performed against a safe test target and documented. *(disposable CI/local PG acceptance automated; live host rehearsal record pending)*
- [x] No product-domain backup status table is required.
- [x] Full server tests and both builds pass.

Slice 11 implementation verification is complete: production config rejection,
required `HEALTH_SCHEMA_VERSION`, loopback trusted-proxy rate-limit identity,
generic readiness health (`200`/`503` with exact migration pin in production),
migrate-not-on-start, graceful shutdown, real `buildApp` log redaction,
fail-closed backup/restore scripts, systemd/Caddy templates, and runbooks that
migrate from `NEW_RELEASE` before switching `current`. Disposable PostgreSQL
backup→restore acceptance is automated under `TEST_DATABASE_URL`.

Operator-only remaining steps: live VPS/TLS cutover, host-recorded restore
rehearsal under `docs/operations/restore-rehearsals/`, and real offsite copy.

## 15. Slice 12: Local Pilot Cutover, Installation Guide, and User Manual

**Goal:** Run Servora-Med as a limited pilot on macOS behind Cloudflare Tunnel without
inbound ports, with clear developer/pilot install docs and a Turkish user manual.

### Deliverables

- local macOS + Cloudflare Tunnel operations runbook
- cloudflared named-tunnel config example
- loopback-only tunnel Caddyfile (public HTTPS at Cloudflare edge)
- launchd examples for API and backup
- README install chooser (dev / macOS pilot / Ubuntu VPS reference)
- Turkish Admin/Manager/Staff user manual grounded in real UI routes
- client-IP trust chain documentation and contract tests
- roadmap renumber: WebSocket deferred to Slice 13

### Acceptance

- [x] Tunnel Caddy binds loopback only; Fastify remains loopback-only in production config.
- [x] Cloudflare Tunnel config example has hostname → local Caddy and catch-all `http_status:404`.
- [x] Client-IP contract: `CF-Connecting-IP` → Caddy client IP → `X-Forwarded-For` + `X-Forwarded-Proto: https` → Fastify rate-limit identity (contract + trust-proxy tests).
- [x] README separates development setup from pilot/production commands.
- [x] Turkish user manual covers Staff delivery/task/meeting, Manager approval/CRM/reports, Admin users.
- [x] No tunnel credentials or secrets committed.
- [x] Server/web builds and tests pass for Slice 12 artifacts (contract tests + full ordinary suites). Remote CI green is required before merge.

Operator-only (not claimed by repository alone): live public hostname cutover, host restore rehearsal record,
real offsite copy.

Slice 12 repository closeout was merged by
[#9](https://github.com/emrahozcelik/servora-med/pull/9) at
`525e838819f38df6961222b41e344c3b3a917305`. Both PR checks passed, and the post-merge
`main` CI run
[`29450061356`](https://github.com/emrahozcelik/servora-med/actions/runs/29450061356)
completed successfully. This evidence verifies repository
artifacts and automated contracts only; it does not claim that a real hostname, reboot,
offsite target, or host restore rehearsal has been completed.

## 16. Slice 13: WebSocket Only if Polling Is Insufficient

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

## 17. MVP Pilot Definition of Done

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

Structured Sales Meeting is complete in Slice 10. WebSocket remains conditional on the
measured Slice 13 entry criteria and does not block pilot completion.
