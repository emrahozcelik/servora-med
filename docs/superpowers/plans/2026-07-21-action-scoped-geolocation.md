# Servora-Med Action-Scoped Browser Geolocation Implementation Plan

> **Execution gate:** This is a docs-only Phase Q plan. Do not add migrations,
> runtime code, dependencies, provider credentials, or UI changes until the
> paired design is explicitly approved, including every gate in section 15.

**Goal:** Attach one optional, auditable browser-location outcome to the
existing Staff `İşi başlat` action without blocking the workflow when location
or reverse geocoding is unavailable.

**Non-goals:** Continuous/background tracking, login capture, geofencing,
attendance, route history, geographic report UI, Web Push, offline mutations,
or a new JobCard transition.

## Task 1 — Design and Policy Approval

Allowed source area: only this plan and the paired design spec.

- [x] Select the first action: assigned Staff `İşi başlat` only.
- [x] Record the purpose, optional/non-blocking behavior, no-consent-dialog UX,
  canonical coordinate model, approximate address, and audit presentation.
- [ ] Approve the static employee/user notice text.
- [ ] Approve the 1,000 metre reverse-geocoding/report threshold.
- [ ] Approve retention matching JobCard and immutable activity history.
- [ ] Select and approve the reverse-geocoding provider, regional endpoint,
  data-processing terms, timeout, rate limit, and production secret handling.
- [ ] Complete design review before runtime code.

## Task 2 — Storage and Repository Contracts (TDD)

Allowed source area: one new migration, JobCard repository/location types, and
focused PostgreSQL tests.

- [ ] Write failing PostgreSQL tests for tenant-safe JobCard/activity/actor
  links, exact captured/unavailable checks, unique activity linkage, precision,
  and indexes.
- [ ] Add an append-only `job_action_locations` migration without changing an
  already-applied migration.
- [ ] Add a transaction port that appends exactly one location outcome beside
  the persisted `JOB_STARTED` activity.
- [ ] Prove duplicate append rejection and full rollback with the activity.
- [ ] Run migration, focused PostgreSQL tests, and server build.

## Task 3 — Server Start Integration (TDD)

Allowed source area: existing start route/handler/service, location module,
reverse-geocoder port/adapter, dependency wiring, and focused tests.

- [ ] Write failing tests for exact request validation, Staff-only start,
  captured and every normalized unavailable outcome.
- [ ] Extend only the existing start command with the discriminated
  `locationCapture` field; do not add a second endpoint or transition.
- [ ] Validate coordinate bounds, finite values, positive accuracy, canonical
  instant, exact fields, and failure enum on the backend.
- [ ] Keep reverse-geocoder I/O outside the DB transaction with a strict bound;
  map only Servora-owned address components and persist no raw response.
- [ ] Append transition, `JOB_STARTED`, location outcome, and existing realtime
  ledger event in one transaction; publish invalidation only after commit.
- [ ] Prove geocoder timeout/failure and low accuracy do not block start.
- [ ] Prove idempotent replay and transaction rollback create no duplicates.
- [ ] Prove SSE and logs contain no location data and public JobCard list/board
  DTOs remain unchanged.

## Task 4 — Browser Capture Adapter (TDD)

Allowed source area: one web geolocation service/adapter and focused tests.

- [ ] Write failing tests for supported capture, permission denied, unavailable,
  timeout, unsupported browser, unknown error, and exact browser options.
- [ ] Add a small `captureStartLocation` adapter around
  `navigator.geolocation.getCurrentPosition`; components do not access the raw
  API directly.
- [ ] Return the exact captured/unavailable API envelope without reverse
  geocoding or permission preflight.
- [ ] Ensure one click causes at most one browser location request.

## Task 5 — Start Action and History UI (TDD)

Allowed source area: existing Staff start surface, JobCard API client/parser,
typed activity presentation, focused web tests, styles, and responsive fixture.

- [ ] Add the approved static notice beside the existing `İşi başlat` action;
  keep its name and command intent unchanged.
- [ ] Add a synchronous pending gate before awaiting browser geolocation and
  preserve the existing `clientActionId` across transport retry.
- [ ] Submit captured or unavailable outcome, then use the existing canonical
  stale-version refresh behavior.
- [ ] Render approximate address, accuracy, capture time, or localized failure
  reason in `JOB_STARTED` history without exposing raw provider data.
- [ ] Preserve mobile action-before-Timeline DOM order, focus behavior, and
  accessible pending/error announcements.
- [ ] Add 390/720/768/1024/1440, 200% text, and 400% reflow coverage for long
  approximate addresses and failure text.

## Task 6 — Full Regression and Privacy Verification

- [ ] Run full server migration/build/test/audit and web
  test/build/bundle/responsive/audit suites.
- [ ] Statically and dynamically verify no coordinates, address, accuracy, or
  failure reason appear in SSE envelopes or logs.
- [ ] Verify existing lifecycle, approval, activity, realtime, notification,
  request-gate, and idempotency contracts remain green.

## Task 7 — Manual Browser Acceptance and Handoff

- [ ] Chrome: allow, deny, timeout, low-accuracy, retry, and double-click cases.
- [ ] Real Safari: allow, deny, timeout, background/resume, and focus behavior.
- [ ] Confirm login/page load never prompts and only Staff start triggers one
  native permission request.
- [ ] Confirm manager/admin action surfaces never request location.
- [ ] Confirm captured/unavailable history is visible only to authorized
  JobCard viewers in the same organization.
- [ ] Record exact provider/config, retention approval, commands, CI, browser
  results, and merge data in the design Implementation Record.
- [ ] Move the runtime PR from draft only after all acceptance criteria pass.

## Required Verification Commands

```bash
cd server
npm run build
npm run migrate
npm test -- --run
npm audit --omit=dev

cd ../web
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
npm audit --omit=dev
```
