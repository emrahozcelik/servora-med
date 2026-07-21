# Servora-Med Persistent In-App Notification Center Implementation Plan

> **Execution mode:** This is the Phase P implementation plan. It is proposed
> documentation only until `2026-07-20-persistent-in-app-notification-center-design.md`
> is reviewed. Do not start runtime implementation or mark this PR ready before
> that review.

**Goal:** Add a recipient-authorized, durable in-app JobCard notification read
model with unread count, accessible responsive list, idempotent mark-read, deep
links, and SSE-driven canonical REST reconciliation.

**Non-goals:** Push, service workers, PWA/offline support, geolocation, toast
standardisation, bulk read, new realtime transport, and new JobCard rules.

## Task 1 — Baseline and Design Review

Allowed source area: only this plan and the paired design spec.

- [x] Confirm `main` contains SSE server foundation PR #34, web reconciliation
  PR #36, and its docs closeout PR #38.
- [x] Create the independent `feature/in-app-notification-center` branch.
- [x] Record the notification model, transaction boundary, recipients, API,
  web behaviour, and acceptance tests in the paired design.
- [x] Obtain explicit review approval for the design before runtime code.
- [x] Open and retain draft PR #39 titled `feat: add in-app notification center`.

## Task 2 — Server Notification Model (TDD)

Allowed source area: new notifications module, migration `012`, focused server
tests, and dependency wiring only.

- [x] Write failing migration/repository tests for recipient/source-event
  uniqueness, tenant-safe composite source FK, allowed kinds, recipient-scoped
  ordering, unread counting, cursor pagination, and idempotent read updates.
- [x] Add `012_create_in_app_notifications.sql` with the approved table,
  foreign keys, checks, indexes, and no business snapshot fields.
- [x] Add notification types plus a transaction/repository port. Reuse the
  existing PostgreSQL transaction; do not add a queue or projector.
- [x] Implement list, unread count, and mark-read repository operations with
  organization + recipient predicates on every query.
- [x] Run focused notification tests and `cd server && npm run build`.

## Task 3 — Transactional Event Projection (TDD)

Allowed source area: Task 2 files, JobCard transaction/service integration,
realtime mapper/types, dependency wiring, and focused tests.

- [x] Write failing tests covering each approved source activity, exact active
  recipient set, actor exclusion, inactive manager exclusion, rollback, and
  idempotent command replay.
- [x] Implement a pure notification policy that maps only the approved
  high-signal JobCard activities to semantic notification kinds and recipient
  drafts before any realtime event is inserted.
- [x] Append the realtime event with `notifications` only when those drafts
  exist, then insert rows using its persisted source event ID in the same
  transaction.
- [x] Retain the existing SSE payload shape and audience rules; do not create a
  new mark-read realtime event.
- [x] Publish only after commit through the established realtime bus path.
- [x] Run focused lifecycle/realtime/notification integration tests and server
  build. Confirm no public JobCard DTO changed.

## Task 4 — Recipient-Scoped REST API (TDD)

Allowed source area: notifications module/routes, shared server wiring, API
tests, and generated API client types only.

- [x] Write failing route tests for authentication/password-change gate,
  cursor validation, list ordering, unread count, idempotent mark-read, and a
  `404` response for cross-user/cross-organization notification IDs.
- [x] Implement `GET /api/notifications/unread-count`.
- [x] Implement `GET /api/notifications` with validated `limit` and opaque
  cursor, newest-first stable pagination, and public semantic DTOs only.
- [x] Implement `PATCH /api/notifications/:notificationId/read` with an
  idempotent response.
- [x] Add the web API service parsers without making components call raw fetch.
- [x] Run focused API tests, full server build, and migration verification.

## Task 5 — Notification Center Web Surface (TDD)

Allowed source area: a new notifications feature, AppShell composition,
existing owned UI primitives/styles, API service, focused web tests, and
responsive fixtures/smoke.

- [ ] Write failing controller/component tests for initial unread load, list
  loading/empty/error/retry, semantic rendering, zero/non-zero badge, and
  clearing all recipient-scoped state on logout/user/organization change.
- [ ] Add a Servora-owned notification controller that loads unread count and,
  only while open, the current list page through the API service.
- [ ] Add the labelled AppShell trigger, badge, and accessible responsive panel
  using the established mobile drawer/dialog focus contract.
- [ ] Implement one-row pending state, idempotent mark-read then deep-link
  navigation, and error handling that keeps the panel open.
- [ ] Implement `Daha fazla yükle`: append later pages with ID de-duplication,
  expose load-more retry, and reset to the canonical first page on a new
  notification invalidation.
- [ ] Do not migrate ConfirmationAction, introduce a toast system, or alter
  existing shell navigation/drawer semantics outside the notification surface.
- [ ] Run focused web tests and `cd web && npm run build`.

## Task 6 — Realtime Reconciliation and Regression (TDD)

Allowed source area: Task 5 files, `RealtimeProvider` subscriptions, focused
tests, and responsive smoke fixtures only.

- [ ] Write tests that a `notifications` invalidation reloads canonical unread
  count and, if open, its list; no SSE payload is rendered as a notification.
- [ ] Prove reconnect/focus/visibility/online/fallback reconciliation reuses
  the same guarded loaders and does not duplicate rows or reads. A local
  mark-read reloads immediately; other tabs recover through these mechanisms,
  not a new mark-read SSE event.
- [ ] Add desktop/mobile parity and keyboard/focus assertions, including Escape
  and trigger focus restoration.
- [ ] Add real notification-center smoke coverage at 390, 720, 768, 1024, and
  1440 px plus 200% text and 400% reflow; verify no horizontal overflow.
- [ ] Run full web test/build/bundle/responsive/audit and full server
  build/migration/test/audit suites.

## Task 7 — Manual Verification and Handoff

- [ ] In two authenticated sessions, create each supported source action and
  confirm only intended manager/staff recipients see one persistent item.
- [ ] Mark an item read in one session; confirm its immediate canonical reload
  and the other session's reconciliation after focus, reconnect, page resume,
  or fallback polling (not an invented mark-read SSE delivery).
- [ ] Confirm keyboard operation, mobile panel focus restoration, a long
  message at 400% reflow, and deep link access/denial behaviour.
- [ ] Record exact command outcomes and manual results in the design’s
  Implementation Record and the PR description.
- [ ] Move the PR from draft only after all acceptance criteria and required CI
  checks pass.

## Required Verification Commands

```bash
cd server
npm run build
npm test -- --run
npm audit --omit=dev

cd ../web
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
npm audit --omit=dev
```
