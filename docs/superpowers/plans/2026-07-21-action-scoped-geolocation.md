# Servora-Med Action-Scoped Browser Geolocation Implementation Plan

> **Execution gate:** This is a docs-only Phase Q plan. Do not add migrations,
> runtime code, dependencies, provider credentials, or UI changes until the
> paired technical design is explicitly approved. Runtime development and
> production enablement have separate gates in design section 16.

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
- [x] Separate the 1,000 metre approximate-address threshold from any future
  geographic-report eligibility rule.
- [x] Define `capturedAt` as client-claimed metadata and server timestamps as
  authoritative for audit and Timeline ordering.
- [x] Require completed-action short-circuit before reverse geocoding while
  retaining the transaction claim as the final concurrency defense.
- [x] Define `ACTION_SCOPED_GEOLOCATION_ENABLED` as a server-owned, default-off
  gate exposed through JobCard presentation and enforced again by the server.
- [x] Defer the full employee/user disclosure and retention decision to a
  governed Settings/profile documents slice; keep production capture disabled
  until those decisions are approved.
- [x] Complete technical design review before runtime code (`9623938`,
  approved 2026-07-21).

Production enablement remains a separate gate after implementation:

- [ ] Publish and link the approved full location disclosure.
- [ ] Record a concrete maximum retention period or exact approved policy.
- [ ] Select and approve the reverse-geocoding provider, regional endpoint,
  data-processing terms, request-log retention, subprocessors, cross-border
  transfer mechanism, response licensing/cache terms, deletion obligations,
  timeout, rate limit, production secret handling, and required deletion/export
  process.
- [ ] Complete real Safari allow, deny, timeout, background/resume, and focus
  acceptance on a physical device.
- [ ] Complete Chrome timeout and retry manual acceptance against the selected
  production-like provider configuration.

## Task 2 — Storage and Repository Contracts (TDD)

Allowed source area: one new migration, JobCard repository/location types, and
focused PostgreSQL tests.

- [x] Write failing PostgreSQL tests for tenant-safe JobCard/activity/actor
  links, exact captured/unavailable checks, unique activity linkage, precision,
  and indexes.
- [x] Add an append-only `job_action_locations` migration without changing an
  already-applied migration.
- [x] Add a transaction port that appends exactly one location outcome beside
  the persisted `JOB_STARTED` activity.
- [x] Prove duplicate append rejection and full rollback with the activity.
- [x] Run migration, focused PostgreSQL tests, and server build.

## Task 3 — Server Start Integration (TDD)

Allowed source area: existing start route/handler/service, location module,
reverse-geocoder port/adapter, server config, dependency wiring, and focused
tests.

- [x] Write failing config tests proving absent/false is disabled, only exact
  `true` enables, invalid values fail startup, and enabled mode requires every
  selected provider configuration value before the server accepts requests.
- [x] Add `ACTION_SCOPED_GEOLOCATION_ENABLED` to the existing server config
  loader with a false default; do not add an independent web build flag.
- [x] Write failing tests for exact request validation, Staff-only start,
  captured and every normalized unavailable outcome.
- [x] Extend only the existing start command with the discriminated
  `locationCapture` field; do not add a second endpoint or transition.
- [x] Validate coordinate bounds, finite values, positive accuracy, a
  well-formed ISO client timestamp, exact fields, and failure enum on the
  backend before any provider I/O.
- [x] Keep reverse-geocoder I/O outside the DB transaction with a strict bound;
  map only Servora-owned address components and persist no raw response.
- [x] Before reverse geocoding, return the stored result for an already
  completed critical action with the same organization, actor, kind, and
  `clientActionId`.
- [x] Before reverse geocoding, perform an organization-scoped, non-mutating
  START preflight for assigned Staff authorization, transition eligibility, and
  obvious `expectedVersion` mismatch; repeat every check inside the transaction.
- [x] When disabled, discard any client-supplied `locationCapture` before
  provider/persistence work, execute the legacy start transition, and prove no
  geocoder call or location row occurs.
- [x] Append transition, `JOB_STARTED`, location outcome, and existing realtime
  ledger event in one transaction; publish invalidation only after commit.
- [x] Prove geocoder timeout/failure and low accuracy do not block start.
- [x] Prove completed replay does not call the geocoder again and transaction
  rollback/concurrent requests create no duplicate business records.
- [x] Prove cross-organization users, unrelated Staff, Admin/Manager START,
  already `IN_PROGRESS` or otherwise ineligible status, obvious stale version,
  and malformed capture payloads never call the geocoder.
- [x] Prove a genuine state/version race after successful preflight may call the
  provider but commits no business records when the transaction rejects it;
  record this accepted TOCTOU transfer/cost risk in the Implementation Record.
- [x] Prove SSE and logs contain no location data and public JobCard list/board
  DTOs remain unchanged.

## Task 4 — Browser Capture Adapter (TDD)

Allowed source area: one web geolocation service/adapter and focused tests.

- [x] Write failing tests for supported capture, permission denied, unavailable,
  timeout, unsupported browser, unknown error, and exact browser options.
- [x] Add a small `captureStartLocation` adapter around
  `navigator.geolocation.getCurrentPosition`; components do not access the raw
  API directly.
- [x] Return the exact captured/unavailable API envelope without reverse
  geocoding or permission preflight.
- [x] Ensure one click causes at most one browser location request.

## Task 5 — Start Action and History UI (TDD)

Allowed source area: existing Staff start surface, JobCard API client/parser,
typed activity presentation, focused web tests, styles, and responsive fixture.

- [x] Extend the server-owned JobCard presentation with
  `startLocationCaptureEnabled`; never derive it from role/status in the web
  application and never add a separate `VITE_*` flag.
- [x] Prove absent/false capability renders no notice, makes no browser
  geolocation call, and submits the existing location-free start payload.
- [x] Add the operational notice from the design beside the existing
  `İşi başlat` action; keep its name and command intent unchanged. Do not add a
  broken legal-document link before the governed documents surface exists.
- [x] Add a synchronous pending gate before awaiting browser geolocation and
  preserve the existing `clientActionId` across transport retry.
- [x] Submit captured or unavailable outcome, then use the existing canonical
  stale-version refresh behavior.
- [x] Render approximate address, accuracy, capture time, or localized failure
  reason in `JOB_STARTED` history without exposing raw provider data.
- [x] Preserve mobile action-before-Timeline DOM order, focus behavior, and
  accessible pending/error announcements.
- [x] Add 390/720/768/1024/1440, 200% text, and 400% reflow coverage for long
  approximate addresses and failure text.

## Task 6 — Full Regression and Privacy Verification

- [x] Run full server migration/build/test/audit and web
  test/build/bundle/responsive/audit suites.
- [x] Prove the production-like default configuration keeps capture disabled;
  prove enabled mode with missing provider configuration fails startup.
- [x] Statically and dynamically verify no coordinates, address, accuracy, or
  failure reason appear in SSE envelopes or logs.
- [x] Verify existing lifecycle, approval, activity, realtime, notification,
  request-gate, and idempotency contracts remain green.

## Task 7 — Default-Off MVP Manual Browser Acceptance and Handoff

- [x] Chrome: allow (mocked 50m accuracy, resolved to Çankaya/Ankara), deny
  (PERMISSION_DENIED, UI shows "Konum alınamadı: Konum izni reddedildi"),
  low-accuracy (5000m > 1000m threshold, geocoding skipped, UI shows
  "Yaklaşık adres oluşturulamadı · Doğruluk: yaklaşık 5.000 metre"), and
  double-click (only one location record persisted, idempotent).
- [x] Confirm login/page load never prompts: verified admin surface shows no
  geolocation disclosure, no permission request, and no start button.
- [x] Confirm manager/admin action surfaces never request location: admin
  viewing the same IN_PROGRESS job only sees "Kontrole gönder"/"İşi iptal et"
  buttons; no geolocation element is present on the page.
- [x] Confirm captured/unavailable history is visible only to authorized
  JobCard viewers: admin sees "Konum: Çankaya/Ankara" for captured and
  "Konum alınamadı: Konum izni reddedildi" for unavailable; raw coordinates
  are never exposed in the Timeline DTO.
- [x] Record exact provider/config, production-enablement status, commands, CI,
  browser results, and merge data in the design Implementation Record.
- [x] Record the accepted possibility: already documented in Task 3 above;
  the TOCTOU/provender-duplication risk assessment was recorded on 2026-07-21.
- [x] Move the runtime PR from draft after the default-off MVP acceptance
  criteria pass and the production-enablement follow-up checks are explicitly
  recorded above.

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

## Implementation Record

### Task 2 — Storage and Repository Contracts

Completed on 2026-07-21 on branch `feature/action-scoped-geolocation`.

- Added migration `013_create_job_action_locations` with an append-only,
  tenant-safe activity/JobCard/actor link, exact outcome and geocoding checks,
  one-location-per-activity uniqueness, fixed coordinate precision, and the
  authorized JobCard-history index.
- Added a typed `appendJobActionLocation` transaction port for captured and
  unavailable outcomes.
- Verified captured/unavailable persistence, invalid field combinations,
  numeric bounds, vocabulary, cross-organization/wrong-job/non-start links,
  duplicate rejection, and activity/location/action-claim rollback against the
  local PostgreSQL 16 `servora_med_test` database.
- Applied migrations through `013_create_job_action_locations` to the local
  test database.
- Focused PostgreSQL and migration-upgrade verification passed: 3 files and 17
  tests. The dedicated location suite passed 11 tests.
- Full server regression with `TEST_DATABASE_URL` passed 1,024 tests in 87 files
  when excluding only `db-auth-contract.test.ts`. The unfiltered run passed
  1,028 of 1,029 tests; its sole failure is the known local `pg_hba` `trust`
  configuration accepting the deliberately wrong password. Location and other
  PostgreSQL suites were not skipped.

### Task 3 — Server Start Integration

Completed on 2026-07-21 on branch `feature/action-scoped-geolocation`.

- Added the exact, discriminated start-location request parser and the
  server-owned `ACTION_SCOPED_GEOLOCATION_ENABLED` flag. Missing/false stays on
  the unchanged legacy start path; invalid boolean values fail configuration.
- Added fail-closed application wiring: enabled mode cannot start without an
  injected `ReverseGeocoder`. No production provider adapter or credential was
  selected, so production enablement remains blocked by the separate policy
  and provider gates.
- Added a completed-action lookup and organization-scoped START preflight before
  provider I/O. Authorization, assignment, transition, and version checks are
  repeated inside the critical-action transaction.
- Bounded reverse-geocoder I/O outside the transaction. Unavailable, low
  accuracy, timeout, and provider-failure outcomes remain non-blocking.
- Persisted transition, `JOB_STARTED` activity, one location outcome, and the
  existing realtime ledger event atomically. Location payloads remain absent
  from realtime envelopes and the request-body location field is logger-redacted.
- Proved the accepted TOCTOU boundary: a state race after successful preflight
  may consume one provider call, while the transaction commits no business
  records. Concurrent first requests may similarly incur bounded duplicate
  provider cost; the critical-action claim still permits only one commit.
- Focused parser/config/startup/route/service/logger verification passed 137 tests.
  The real PostgreSQL location suite passed 12 tests, including service-level
  commit and completed replay. Full server regression excluding only the known
  local `pg_hba trust` password-auth contract passed 1,062 tests in 89 files.

### Task 4 — Browser Capture Adapter

Completed on 2026-07-21 on branch `feature/action-scoped-geolocation`.

- Added a dependency-free `captureStartLocation` adapter around the single
  `navigator.geolocation.getCurrentPosition` call with the approved high
  accuracy, 10-second timeout, and zero-cache options.
- Normalized success and browser error codes into the exact API envelope,
  including unsupported and unknown fallbacks. No Permissions API preflight or
  reverse-geocoding behavior was introduced in the browser.
- Focused adapter verification passed 7 tests and the production web build
  passed.

### Task 5 — Start Action and History UI

Completed on 2026-07-21 on branch `feature/action-scoped-geolocation`.

- Added `startLocationCaptureEnabled` to the server-owned detail presentation.
  It is true only for enabled, assigned Staff START presentation; the web parser
  safely normalizes an absent legacy value to false.
- Kept the existing `İşi başlat` action and added the approved operational
  notice only when the server capability is true. No consent checkbox,
  Permissions API preflight, or placeholder legal-document link was added.
- Added a synchronous mutation gate before browser capture, accessible capture
  and submit pending labels, and reuse of the same `clientActionId` and capture
  envelope after a retryable transport failure.
- Joined location evidence to the authorized activity query and exposed only a
  typed safe presentation: approximate label, accuracy, client capture time, or
  normalized failure reason. Raw coordinates remain absent from the activity
  DTO and Timeline.
- Focused web detail/API/Timeline/capture verification passed 97 tests. The
  responsive smoke passed at 390, 720, 768, 1024, and 1440 px plus 200% text
  and 400% reflow with long location notice/address content; action-before-
  Timeline DOM order remained intact.

### Task 6 — Full Regression and Privacy Verification

Completed locally on 2026-07-21. Exact-head `cae087b` GitHub CI subsequently
passed both server and web jobs before review.

- Server migration, build, focused PostgreSQL integration, production audit,
  and the full suite excluding only the known local `pg_hba trust` password-
  rejection contract passed. The full server result was 1,065 tests in 89
  files; the real location suite passed all 12 tests.
- Web full tests passed 644 tests in 72 files. Production build, bundle budget,
  responsive smoke, and production dependency audit passed; the largest chunk
  remained approximately 179 KB under the 500,000-byte hard budget.
- Default-off and enabled-without-provider fail-closed behavior are covered by
  config/startup tests. Realtime envelopes exclude location fields and dynamic
  logger verification confirms the complete `locationCapture` request field is
  redacted.
- No list/board DTO, lifecycle transition, notification policy, SSE payload, or
  readiness rule was changed. Production capture remains disabled.

### Task 7 — Manual Chrome Acceptance

Completed on 2026-07-21 on branch `feature/action-scoped-geolocation`.

- Server configured with `ACTION_SCOPED_GELOCATION_ENABLED=true` and a
  `createDevReverseGeocoder()` mock that resolves to Test Mahallesi, Çankaya,
  Ankara. Production provider remains absent; the server fails closed without
  an injected `ReverseGeocoder`.

**Chrome allow (50m accuracy):**
- Created a new GENERAL_TASK, accepted as Sezer Dener (staff).
- Mocked `navigator.geolocation.getCurrentPosition` to return
  `{ latitude: 39.9334, longitude: 32.8597, accuracy: 50 }` and
  `navigator.permissions.query` to return `granted`.
- Clicked "İşi başlat" → job transitioned to IN_PROGRESS ("Uygulanıyor"),
  success toast "İş uygulanmaya başladı" shown.
- Timeline entry: `Kabul edildi → Uygulanıyor · Konum: Çankaya/Ankara ·
  Doğruluk: yaklaşık 50 metre · Yakalama zamanı: 21 Tem 2026 23:15`.
- DB: `capture_outcome=CAPTURED, latitude=39.933400, longitude=32.859700,
  accuracy_meters=50.000, geocoding_status=RESOLVED, neighborhood=Test Mahallesi,
  district=Çankaya, city=Ankara, approximate_label=Çankaya/Ankara`.
- Raw coordinates never exposed in UI; only approximate label shown.

**Chrome deny (PERMISSION_DENIED):**
- Loaded a fresh ACCEPTED job without geolocation permission (DevTools emulation
  did not auto-grant for the localhost origin).
- Clicked "İşi başlat" → job STILL transitioned to IN_PROGRESS (non-blocking).
- Timeline entry: `Kabul edildi → Uygulanıyor · Konum alınamadı: Konum izni
  reddedildi`.
- DB: `capture_outcome=UNAVAILABLE, failure_reason=PERMISSION_DENIED,
  geocoding_status=NOT_REQUESTED`.
- No coordinates stored; Turkish failure reason displayed.

**Chrome low accuracy (5000m > 1000m threshold):**
- Mocked geolocation with `accuracy: 5000` (>1000m reverse-geocoding threshold).
- Clicked "İşi başlat" → job started successfully.
- Timeline: `Kabul edildi → Uygulanıyor · Konum: Yaklaşık adres
  oluşturulamadı · Doğruluk: yaklaşık 5.000 metre · Yakalama zamanı:
  21 Tem 2026 23:17`.
- DB: `capture_outcome=CAPTURED, accuracy_meters=5000.000,
  geocoding_status=NOT_REQUESTED` (reverse geocoding intentionally skipped).
- No neighborhood/district/city stored, as designed.

**Chrome double-click idempotency:**
- Created a fresh ACCEPTED job, mocked 50m accuracy, double-clicked "İşi başlat".
- Only one `job_action_locations` record persisted.
- Only one "İş başlatıldı" timeline entry.
- Job correctly transitioned to IN_PROGRESS.

**Admin surface — no geolocation prompt:**
- Logged in as Sistem Yöneticisi and navigated to the same IN_PROGRESS job.
- Verified: no "İşi başlat" button, no geolocation disclosure text, no
  permission prompt. Only "Kontrole gönder" and "İşi iptal et" buttons visible.
- Admin can see location history: "Konum: Çankaya/Ankara" for captured,
  "Konum alınamadı: Konum izni reddedildi" for unavailable.

**Deferred production-enablement acceptance:**

- Chrome timeout: the 10-second timeout is exercised by the adapter unit tests.
- Chrome retry: works by reusing the same `clientActionId`/envelope.
- Real Safari: no Safari DevTools tooling available; behavior covered by the
  browser-agnostic adapter unit tests (7 tests) and the same HTML5 Geolocation
  API contract.
- These manual checks are not claimed as passed. They are intentionally moved
  to the production-enablement gate because capture remains default-off and no
  production reverse-geocoding provider is included in this PR.

**Merge data:**
- Branch: `feature/action-scoped-geolocation`
- Head: `66865b3`
- PR: #41
- Migration applied to `013_create_job_action_locations`
