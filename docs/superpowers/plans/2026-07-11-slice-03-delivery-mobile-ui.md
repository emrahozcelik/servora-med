# Servora-Med Slice 03 Product-Delivery Mobile UI Plan

**Goal:** Make the verified Slice 02 tracer usable from a Staff phone through Manager approval or revision, without opening full CRM/catalog administration scope.

**Physical scene:** A field employee records a delivery one-handed in a bright clinic corridor while a manager reviews the same immutable submission on a daytime desktop. The UI remains light-first, restrained, high-contrast, and operationally explicit.

**Architecture:** React pages compose role-aware flows; `services/api.ts` owns credentialed transport and typed errors; backend state/version remains authoritative. No client token storage, drag-and-drop dependency, router framework, global state framework, or speculative component library is added.

## Task 1: Minimum authenticated reference reads

- [x] Add organization-scoped read-only customer and active-product endpoints.
- [x] Staff, Manager, and Admin may read; no mutation endpoint is introduced.
- [x] Return only fields required by the tracer form.
- [x] Add route/service tests and live PostgreSQL coverage.

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

- [x] Show immutable backend status/version and next valid command.
- [x] Start then submit for approval with pending/success/error feedback.
- [x] Reconcile stale version by refetching and explaining the conflict.
- [x] No optimistic lifecycle transition without backend confirmation.

## Task 6: Manager review flow

- [x] Show submitted delivery purpose, product snapshot, quantity, delivered time, and activity.
- [x] Commercial data is read-only in `WAITING_APPROVAL`.
- [x] Approve or request revision with mandatory reason.
- [x] Keyboard alternatives exist for every action; no drag-and-drop is required.

## Task 7: Responsive and accessibility verification

- [x] Verify approximately 390 CSS px without horizontal page scrolling.
- [x] Verify 44 by 44 CSS px primary targets, labels, logical focus, and non-color errors.
- [x] Verify keyboard-only Staff and Manager critical flows.
- [x] Verify 200 percent text size and supported 400 percent zoom reflow.
- [x] Verify `prefers-reduced-motion` and screen-reader semantics.

## Task 8: Live tracer, documentation, and closeout

- [x] Run component/API tests, web build, server regression tests, and audits.
- [x] Run browser flow against disposable PostgreSQL for Staff create/start/submit and Manager approve/revision.
- [x] Update README, MVP slice status, DESIGN implementation tokens, and exact manual-check record.
- [x] Reindex server/web Codebase Memory and commit a slice-scoped checkpoint.

## Verification Record (2026-07-11)

- Web tests: 8 files, 30 tests passed.
- Web production build: passed.
- Server tests: 17 files, 96 tests passed.
- Server build: passed.
- Server and web production dependency audits: 0 vulnerabilities.
- Automated accessibility contract: 44 CSS px control minimum, visible focus outline, mobile single-column form/detail reflow, and reduced-motion CSS passed.
- Disposable PostgreSQL 16 live verification: migrations 001/002, development seed, Staff login, authenticated customer/product reference reads, JobCard create, delivery add, start, submit, Manager login, approve, activity read, and a second revision-request flow passed.
- Live reference result: one active customer and one active product returned within the authenticated organization scope.
- Live tracer result: one `COMPLETED` JobCard with five expected events and one `REVISION_REQUESTED` JobCard. Disposable server and database were stopped and removed.
- Playwright Chromium at a 390 by 844 CSS px viewport completed two Staff delivery flows through create, start, and submit. Manager review then approved the sale delivery and returned the sample delivery with a required revision reason.
- The 390 CSS px screens had no horizontal document overflow. Measured buttons, inputs, selects, and text areas in the delivery form were at least 44 CSS px high; controls had explicit accessible names and result messages exposed status semantics.
- Keyboard checks confirmed logical login order (`E-posta`, `Parola`, `Giriş yap`), visible 3 CSS px focus outlines, keyboard activation, and sequential delivery-form access. Manager decisions are native buttons and revision reason is a labeled text control; drag and drop is not required.
- At 200 percent root text size, the header initially overflowed. Mobile header wrapping was added with a regression contract, then the browser recheck passed with `scrollWidth === clientWidth`. A 320 CSS px effective reflow viewport, representing a supported 1280 CSS px layout at 400 percent zoom, retained all primary actions without horizontal overflow.
- Chromium `prefers-reduced-motion: reduce` matched and nonessential transition duration resolved to 0.01 ms. Accessibility snapshots exposed semantic banner/main/region/heading/list/form/status structures for login, delivery, approval queue, review, and feedback.
- Codebase Memory reindex completed with 294 nodes / 594 edges for the server and 111 nodes / 219 edges for the web application. Browser server, Vite process, and disposable database were stopped and removed after verification.
