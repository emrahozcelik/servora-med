# Servora-Med Slice 02 Product-Delivery Tracer Backend Plan

**Goal:** Deliver the smallest secure backend path from a staff-created product-delivery JobCard through structured delivery data, approval submission, manager approval or revision, immutable activity, idempotency, and optimistic concurrency.

**Architecture:** The JobCard module remains a cohesive modular-monolith boundary. HTTP handlers translate authenticated requests; a domain service owns authorization, state transitions, validation, idempotency, and transactions; a PostgreSQL repository owns parameterized persistence and atomic version predicates. Canonical activity is written in the same business transaction.

**Scope constraints:** `PRODUCT_DELIVERY` only. No full customer/product administration UI, stock, accounting, prices, attachments, notes, board projection, WebSocket, or `GENERAL_TASK` implementation in this slice.

## Task 1: Delivery tracer schema and minimum reference seed

**Files:**
- Create `server/src/db/migrations/002_delivery_tracer.sql`
- Create `server/tests/delivery-schema.test.ts`
- Modify `server/src/modules/auth/setup.ts`
- Modify `server/tests/auth-setup.test.ts`

- [x] Add customers, products, JobCards, delivery items, activity, and processed actions.
- [x] Reinforce same-organization ownership with composite keys where clear.
- [x] Add status, type, priority, purpose, quantity, version, review-state, and idempotency checks.
- [x] Extend development seed with one minimum customer and product without affecting bootstrap.

## Task 2: Pure domain vocabulary, transition, authorization, and validation rules

**Files:**
- Create `server/src/modules/job-cards/types.ts`
- Create `server/src/modules/job-cards/policy.ts`
- Create `server/tests/job-card-policy.test.ts`

- [x] Define canonical statuses, purposes, priorities, events, commands, and safe DTOs.
- [x] Test staff self-assignment, manager review authority, editable/review/terminal states, valid transitions, revision reason, and delivery submit invariants.

## Task 3: PostgreSQL transaction and idempotency foundation

**Files:**
- Create `server/src/modules/job-cards/repository.ts`
- Create `server/src/modules/job-cards/service.ts`
- Create `server/tests/job-card-service.test.ts`

- [x] Claim critical actions before side effects using the processed-action unique key.
- [x] Return completed original responses; reject live duplicate claims with `ACTION_IN_PROGRESS`.
- [x] Keep JobCard mutation, version increment, activity append, and completed response atomic.
- [x] Return `VERSION_CONFLICT` without mutation or activity for stale writes.

## Task 4: Staff-scoped JobCard create, list, detail, and field patch

- [x] Staff creates `PRODUCT_DELIVERY` only for self; manager/admin may assign same-organization active staff.
- [x] Staff reads only assigned JobCards; manager/admin read organization scope.
- [x] Cross-organization references and access are rejected.
- [x] Field patch rejects review and terminal states and appends bounded canonical activity.

## Task 5: Delivery item create, patch, and remove

- [x] Validate active same-organization product, purpose, delivered time, and positive quantity.
- [x] Snapshot product name, SKU, model, and unit from the catalog.
- [x] Increment parent version and append delivery activity atomically.
- [x] Reject review/terminal mutation and unknown financial fields.

## Task 6: Named lifecycle commands

- [x] Implement `start`, `submit-for-approval`, `approve`, and `request-revision`.
- [x] Submit validates customer, eligible assignee, and all delivery items.
- [x] Staff cannot approve; manager/admin cannot silently edit review-state commercial data.
- [x] Approval records manager identity/time; revision records mandatory reason/time.

## Task 7: Authenticated HTTP routes and safe contracts

**Routes:**
- `GET/POST /api/job-cards`
- `GET/PATCH /api/job-cards/:id`
- `GET/POST /api/job-cards/:id/delivery-items`
- `PATCH/DELETE /api/job-cards/:id/delivery-items/:itemId`
- `POST /api/job-cards/:id/start`
- `POST /api/job-cards/:id/submit-for-approval`
- `POST /api/job-cards/:id/approve`
- `POST /api/job-cards/:id/request-revision`
- `GET /api/job-cards/:id/activity`

- [x] Apply auth middleware and backend-owned staff/manager scopes.
- [x] Validate exact request shapes and reject unknown commercial/financial fields.
- [x] Add route acceptance tests for the complete tracer and negative cases.

## Task 8: Verify, document, and reindex

- [x] Run server build, full tests, and production audit.
- [x] Scan for restaurant, stock, accounting, raw token, and duplicated event leakage.
- [x] Update README and `SERVORA_MED_MVP_SLICES.md` with exact implemented state.
- [x] Reindex server Codebase Memory and record live PostgreSQL integration status.

## Completion Record (2026-07-11)

- Server build: passed.
- Server tests: 15 files, 94 tests passed.
- Web tests: 2 files, 6 tests passed.
- Web production build: passed.
- Server and web production dependency audits: 0 vulnerabilities.
- Source scans: no restaurant domain, stock/accounting side effect, raw credential, Web Storage token, Bearer token, or generic duplicate status event leakage.
- Live database: PostgreSQL 16.13 disposable local database.
- Live flow: migrations 001/002, development seed, Staff and Manager login, JobCard create, delivery item add, start, submit, approve, revision, API activity read, and direct SQL state/activity checks passed.
- Live flow caught PostgreSQL error `42P08` in lifecycle status parameter inference. Explicit `varchar(30)` cast was added; the complete approval and revision flows then passed.
- Live result: one `COMPLETED` JobCard, one `REVISION_REQUESTED` JobCard, expected five-event timeline for each, and ten completed processed actions. Disposable server/database were stopped and removed.
