# Servora-Med Slice 03 Product-Delivery Mobile UI Plan

**Goal:** Make the verified Slice 02 tracer usable from a Staff phone through Manager approval or revision, without opening full CRM/catalog administration scope.

**Physical scene:** A field employee records a delivery one-handed in a bright clinic corridor while a manager reviews the same immutable submission on a daytime desktop. The UI remains light-first, restrained, high-contrast, and operationally explicit.

**Architecture:** React pages compose role-aware flows; `services/api.ts` owns credentialed transport and typed errors; backend state/version remains authoritative. No client token storage, drag-and-drop dependency, router framework, global state framework, or speculative component library is added.

## Task 1: Minimum authenticated reference reads

- [x] Add organization-scoped read-only customer and active-product endpoints.
- [x] Staff, Manager, and Admin may read; no mutation endpoint is introduced.
- [x] Return only fields required by the tracer form.
- [ ] Add route/service tests and live PostgreSQL coverage.

## Task 2: Typed tracer API client and error model

- [x] Add typed JobCard, delivery item, activity, customer, and product DTOs.
- [x] Add create/read/patch, delivery mutation, lifecycle, and activity client calls.
- [x] Preserve backend error code/status, including `VERSION_CONFLICT`, `FORBIDDEN`, and retryable network failure.
- [x] Keep all requests credentialed and reject unknown response shapes safely.

## Task 3: Role-aware application shell and work lists

- [x] Staff landing shows only own JobCards with clear status/date/customer hierarchy.
- [x] Manager landing prioritizes `WAITING_APPROVAL` without fake metrics.
- [x] Loading skeleton, empty, forbidden, and retry states are explicit.
- [x] Mobile navigation is structural, not a compressed desktop sidebar.

## Task 4: Staff Product Delivery creation flow

- [x] Select seeded/readable customer and active product.
- [x] Enter delivery purpose, positive quantity, and delivered time with explicit labels.
- [x] Create JobCard, add delivery item, and preserve returned versions.
- [x] Reject/describe validation errors without relying on color.

## Task 5: Staff start and approval-submission flow

- [ ] Show immutable backend status/version and next valid command.
- [ ] Start then submit for approval with pending/success/error feedback.
- [ ] Reconcile stale version by refetching and explaining the conflict.
- [ ] No optimistic lifecycle transition without backend confirmation.

## Task 6: Manager review flow

- [ ] Show submitted delivery purpose, product snapshot, quantity, delivered time, and activity.
- [ ] Commercial data is read-only in `WAITING_APPROVAL`.
- [ ] Approve or request revision with mandatory reason.
- [ ] Keyboard alternatives exist for every action; no drag-and-drop is required.

## Task 7: Responsive and accessibility verification

- [ ] Verify approximately 390 CSS px without horizontal page scrolling.
- [ ] Verify 44 by 44 CSS px primary targets, labels, logical focus, and non-color errors.
- [ ] Verify keyboard-only Staff and Manager critical flows.
- [ ] Verify 200 percent text size and supported 400 percent zoom reflow.
- [ ] Verify `prefers-reduced-motion` and screen-reader semantics.

## Task 8: Live tracer, documentation, and closeout

- [ ] Run component/API tests, web build, server regression tests, and audits.
- [ ] Run browser flow against disposable PostgreSQL for Staff create/start/submit and Manager approve/revision.
- [ ] Update README, MVP slice status, DESIGN implementation tokens, and exact manual-check record.
- [ ] Reindex server/web Codebase Memory and commit a slice-scoped checkpoint.
