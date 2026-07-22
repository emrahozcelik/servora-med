# Servora-Med Minimal Install Surface and Web Push Implementation Plan

> **Execution gate:** This is a docs-only Phase R plan. Do not add a manifest,
> icons, service worker, migration, dependency, configuration, API, worker, or
> runtime UI until
> `2026-07-21-minimal-install-web-push-design.md` receives explicit design
> approval and the docs PR is merged.

**Goal:** Make Servora-Med minimally installable and add optional,
recipient-safe Web Push derived from committed persistent notifications without
adding offline business behavior.

**Non-goals:** Business API caching, offline reads/mutations, Background Sync,
offline queues, sensitive push payloads, marketing notifications, geolocation
enablement, native apps, or a new realtime transport.

## TDD Execution Rule

Every runtime task below is a sequence of vertical tracer bullets:

```text
RED: write one observable-behavior test and run it to confirm the intended failure
GREEN: add only enough production code for that one behavior and rerun it
REFACTOR: remove duplication only while the focused and affected tests are green
```

Do not write a task's entire test matrix before implementation. Tests exercise
public HTTP, repository, browser-adapter, worker-event, or rendered UI
interfaces. Mock only external browser APIs, time, and the external push sender;
use real PostgreSQL for storage and transaction contracts.

## Task 1 — Baseline and Design Review

Allowed source area: only this plan and the paired design spec.

- [x] Start from Phase Q merge `f3bb177` on a clean
  `docs/minimal-install-web-push-design` branch.
- [x] Keep the independent local `server/src/index.ts` development geocoder
  change outside the Phase R branch in `stash@{0}`.
- [x] Read the program roadmap, Phase P/Q specs and plans, current notification
  repository/API/UI, auth session lifecycle, deployment configuration, and
  official MDN/W3C/WebKit Push/install guidance.
- [x] Record default-off enablement, manifest/install UX, permission states,
  subscription/session model, durable outbox, dispatcher, privacy payload,
  service-worker, deep-link, operations, and browser contracts.
- [x] Obtain explicit design review approval before runtime implementation.
- [x] Keep the design PR docs-only and draft until the review findings and
  exact-head CI are resolved.
- [x] After design merge, create a fresh runtime branch from updated `main`;
  never continue runtime work on the docs branch.

## Task 2 — Manifest, Icons, and Install Surface (Vertical TDD)

Allowed source area: web manifest/icon assets, root HTML, one install adapter,
the existing NotificationCenter settings composition, styles, focused tests,
and responsive fixture only.

- [x] RED→GREEN: prove the root HTML references the manifest and Apple touch
  icon; add the minimum links only.
- [x] RED→GREEN: prove required manifest identity, `/jobs` start URL, root
  scope, standalone display, colors, Turkish language, and no related native
  app preference; add the manifest.
- [x] RED→GREEN one asset at a time: verify 192, 512, maskable 512, Apple 180,
  and monochrome badge dimensions/content/path; add approved Servora assets.
- [x] RED→GREEN: capture `beforeinstallprompt` in a root-level listener early
  enough to retain an event fired before authentication settles; expose install
  only after the event and invoke its single-use prompt only from the explicit
  button.
- [x] RED→GREEN: handle accepted, dismissed, `appinstalled`, and standalone
  states without repeated prompting.
- [x] RED→GREEN: when no install event exists, show non-blocking browser-menu
  and Share → Add to Home Screen guidance without user-agent authorization.
- [x] RED→GREEN: place the accessible `Kurulum ve cihaz bildirimleri` subview
  inside the existing notification dialog and prove focus/back behavior.
- [x] Run focused web tests and production build; commit only this install
  tracer slice.

## Task 3 — Server Gate and Subscription Storage (Vertical TDD)

Allowed source area: server config, migration `014`, one web-push module,
dependency wiring interfaces, environment examples, migration tests, and
focused repository tests.

- [x] RED→GREEN: absent and exact `false` resolve disabled; exact `true`
  resolves enabled; every other value fails config validation.
- [x] RED→GREEN one required value at a time: enabled mode rejects missing or
  malformed VAPID subject/public/private key before request handling.
- [x] RED→GREEN on real PostgreSQL: add the required composite session/user key
  and create tenant-safe, recipient/session-safe `web_push_subscriptions` with
  bounded sensitive fields, global endpoint hash uniqueness, one active
  root-scope subscription per session, checks, and indexes.
- [x] RED→GREEN on real PostgreSQL: create `web_push_deliveries` with
  tenant-safe notification/subscription links, unique delivery identity,
  state/lease/attempt checks, and due-work indexes.
- [x] RED→GREEN: append, find-current-session, idempotent same-identity upsert,
  scoped disable, and inactive-session cleanup repository behavior.
- [x] RED→GREEN: store the VAPID public-key fingerprint and expose only a
  SHA-256 subscription fingerprint, never endpoint/key material.
- [x] RED→GREEN: under an endpoint-row lock, allow explicit same-user
  new-session rebind while abandoning older non-terminal deliveries; reject
  cross-user/organization transfer without revealing the prior owner.
- [x] RED→GREEN: logger redaction covers endpoint, `p256dh`, `auth`, payload,
  and VAPID values dynamically, not only through a static path assertion.
- [x] Update environment examples with false default and secret-handling notes;
  no real VAPID key enters Git.
- [x] Run migration, focused PostgreSQL/config/redaction tests, server build,
  and migration upgrade/backup-restore checks.

## Task 4 — Authenticated Subscription API and Session Safety (Vertical TDD)

Allowed source area: Task 3 module, auth request/session presentation needed to
identify the current session, web-push routes/handlers/service, web API adapter,
and focused tests.

- [x] RED→GREEN: authenticated status returns disabled/null values while the
  flag is false and never returns endpoint or keys.
- [x] RED→GREEN: enabled status returns only the public VAPID key, safe
  subscription fingerprint/current-session metadata, and exact
  `renewalRequired` state.
- [x] RED→GREEN one validator at a time: exact request shape, bounded
  URL-safe-Base64 keys, expiration, HTTPS URL, no credentials/explicit port
  (including `:443`)/IP, and the
  approved Chrome/Mozilla/Apple endpoint hosts.
- [x] RED→GREEN: prove arbitrary/private/cross-origin-style endpoints cannot
  turn the server into an SSRF client.
- [x] RED→GREEN: explicit create is idempotent for the same current identity
  and returns the same public record on retry.
- [x] RED→GREEN: the same user can explicitly rebind a retained browser
  endpoint to a later session; login/status loading never rebinds it and old
  pending work is abandoned.
- [x] RED→GREEN: a different user/organization receives ownership-opaque
  `409 PUSH_SUBSCRIPTION_CONFLICT` and can never acquire that row.
- [x] RED→GREEN: disabled create performs no row write; cross-user/tenant or
  other-session disable returns `404`; current-session disable is idempotent.
- [x] RED→GREEN: add focused mutation rate limits and preserve the existing
  production Origin check/password-change gate.
- [x] RED→GREEN: session revocation, expiry, inactive user, password change,
  and logout make a stored subscription ineligible for delivery even when
  browser unsubscribe fails.
- [x] Add strict web response/request parsers; components do not call raw
  endpoints.
- [x] Run focused route/session/API tests and server/web builds.

## Task 5 — Browser Permission and Subscription Controller (Vertical TDD)

Allowed source area: one browser adapter/controller, Task 2 settings subview,
Task 4 API adapter, styles, focused tests, and responsive fixture.

- [x] RED→GREEN: server `enabled: false` causes no service-worker registration,
  permission request, Push API call, or subscription request.
- [x] RED→GREEN: unsupported service worker, PushManager, or Notifications API
  shows guidance and preserves normal application behavior.
- [x] RED→GREEN: `default` requests permission exactly once and only from the
  explicit `Cihaz bildirimlerini aç` click.
- [x] RED→GREEN: `denied` never re-prompts and shows browser/OS settings
  guidance; `granted` proceeds without another prompt.
- [x] RED→GREEN: register fixed `/service-worker.js`, root scope, and
  `updateViaCache: 'none'`; no user/server value supplies the script URL.
- [x] RED→GREEN: subscribe with exact `userVisibleOnly: true` and decoded
  server public key.
- [x] RED→GREEN: a synchronous gate prevents duplicate subscribe/disable;
  server-save retry reuses the same browser subscription.
- [x] RED→GREEN: explicit disable completes server disable before best-effort
  browser unsubscribe and then reloads canonical status.
- [x] RED→GREEN: logout best-effort unsubscribes locally after authoritative
  server session revocation; identity/account changes clear all controller
  state and never auto-associate an old endpoint.
- [x] RED→GREEN: after cross-account `409`, explicit enable unsubscribes,
  creates a fresh browser subscription, and retries create exactly once; a
  second conflict stops without a loop.
- [x] RED→GREEN: on authenticated mount/focus/visibility/online recovery,
  compare browser and safe server fingerprints only when the current session
  already has an active server record; equal state writes nothing and changed
  endpoint/keys refresh that opted-in record.
- [x] RED→GREEN: a missing browser subscription disables the server record;
  provider-stale or changed-VAPID `renewalRequired` rotates only after a new
  explicit enable action.
- [x] RED→GREEN: Home Screen guidance precedes push enablement when required
  capabilities are unavailable in a non-installed context.
- [x] Run focused browser-adapter/controller/UI tests and web build.

## Task 6 — Minimal Service Worker Push and Click Contract (Vertical TDD)

Allowed source area: one root service-worker asset, a focused worker harness,
manifest assets, Caddy examples/checks, and focused tests. No feature component
or business API changes.

- [x] RED→GREEN: a valid version-1 payload produces one visible notification
  with generic title/body, stable notification tag, icon/badge, and safe data.
- [x] RED→GREEN: missing, malformed, or unsupported payload still produces a
  generic visible notification linked only to `/jobs`.
- [x] RED→GREEN one rejection at a time: disallow cross-origin, credentials,
  query/hash, backslashes, encoded slashes, non-Job paths, and malformed UUIDs.
- [x] RED→GREEN: click closes the notification and focuses an exact open target
  client before navigating another same-origin client or opening a new window.
- [x] RED→GREEN: install/activate replaces the prior worker without creating or
  deleting business caches.
- [x] RED→GREEN: `pushsubscriptionchange` performs no fetch/API mutation and
  posts only a fixed, data-free refresh signal to currently open same-origin
  clients; no open client is a safe no-op.
- [x] Add a source/static contract test proving there is no `fetch`, sync,
  periodic-sync, geolocation, CacheStorage, IndexedDB, or mutation behavior.
- [x] Update Caddy examples and behavior tests so worker JS is never SPA HTML,
  uses JavaScript MIME and `no-cache`; manifest revalidates and versioned icons
  may be immutable.
- [x] Run focused worker/ops tests and web build.

## Task 7 — Notification-to-Outbox Projection (Vertical TDD)

Allowed source area: JobCard notification orchestration, notification/web-push
transaction ports, Task 3 repository, and focused real-PostgreSQL integration
tests. No provider call or web UI.

- [x] RED→GREEN: one committed persistent notification plus one active
  recipient subscription creates exactly one delivery in the same transaction.
- [x] RED→GREEN: multiple current recipient subscriptions create one unique
  delivery each; unrelated, disabled, expired-session, inactive-user, or
  cross-tenant subscriptions create none.
- [x] RED→GREEN: notification transaction rollback produces no delivery;
  idempotent JobCard replay produces no duplicate.
- [x] RED→GREEN: push disabled mode creates the unchanged persistent in-app
  notification but no delivery.
- [x] RED→GREEN: subscribing after notification commit does not backfill old
  notification deliveries.
- [x] RED→GREEN: mark-read abandons unclaimed pending work; the accepted
  post-claim race remains recorded rather than hidden.
- [x] Confirm public notification/JobCard/realtime DTOs and semantic recipient
  policy are unchanged.
- [x] Run focused lifecycle/notification/PostgreSQL tests and server build.

## Task 8 — Bounded Push Dispatcher and Sender Adapter (Vertical TDD)

Allowed source area: Task 3 web-push module, one external-sender adapter,
dispatcher lifecycle wiring, the narrowly justified pinned `web-push`
dependency, and focused tests.

- [x] RED→GREEN: atomically claim one due row with lease identity and send only
  after the claim transaction closes.
- [x] RED→GREEN: claim count never exceeds currently available slots, at most
  four sends run concurrently, and no fifth sender starts until a slot is free.
- [x] RED→GREEN: the 30-second lease exceeds the 10-second send timeout;
  concurrent claimers and process-restart lease recovery do not normally send
  the same row twice, and result writes require the matching lease token.
- [x] RED→GREEN: build the exact generic payload/deep link from the committed
  notification presenter; prove forbidden business fields are absent.
- [x] RED→GREEN: success records delivered time and resets subscription
  failure state without logging sensitive sender output.
- [x] RED→GREEN: `404` and `410` disable the subscription and abandon its
  remaining due work.
- [x] RED→GREEN one retry class at a time: timeout/network/`408`/`429`/`5xx`
  use the approved 30s/2m/10m/30m/1h schedule, six total send attempts (initial
  plus five retries), and 24-hour expiry. Failed attempt 6 is abandoned without
  indexing another delay.
- [x] RED→GREEN: other `4xx`, already-read, revoked-session, inactive-user,
  disabled-subscription, and expired work terminate without a sender call.
- [x] RED→GREEN: disabled config never constructs/starts the sender or polls;
  shutdown stops polling/claims, starts no new provider call, waits 15 seconds,
  aborts unfinished sends, and leaves their claims unchanged until the
  30-second lease expires.
- [x] Record the residual at-least-once crash window and stable tag/topic
  mitigation in the Implementation Record; do not claim external exactly-once.
- [x] Pin and audit `web-push`; document why protocol encryption/VAPID cannot be
  safely replaced by existing stack helpers.
- [x] Run focused dispatcher/sender/config tests, full server build, and audit.

## Task 9 — Integrated UI, Recovery, and Responsive Verification

Allowed source area: completed Phase R files, existing notification-center
tests/fixtures, responsive smoke, and operations verification only.

- [x] RED→GREEN: real JobCard lifecycle projects a PENDING delivery; claim +
  presenter/payload + fake sender capture + matching-lease `recordDelivered` +
  real service-worker harness showNotification/click once in the normal path.
- [x] RED→GREEN: destination not-found/authorization remains canonical REST
  (opaque JOB_CARD_NOT_FOUND); push title/body is not used as JobCard UI data.
- [x] RED→GREEN: logout/account switch and two authenticated browser profiles
  cannot cross-deliver or expose another recipient's subscription state;
  recovery state is generation-scoped so B is not blocked by unresolved A.
- [x] RED→GREEN: notification-center invalidation/read behavior remains
  unchanged; push does not invent a mark-read SSE event; SW click does not
  call fetch/mark-read/`postMessage` mark-read.
- [x] Add real settings/long-copy/loading/error/pending states to responsive
  smoke at 390, 720, 768, 1024, and 1440 px plus 200% text and 400% reflow.
- [x] Verify install/push controls, dialog focus/back restoration, unsupported
  state, denied state, and long errors without horizontal overflow.
- Production-like ops evidence (split):
  - [x] Default-off runtime (`WEB_PUSH_ENABLED` false)
  - [x] Manifest / service-worker build output (no SPA HTML in worker)
  - [x] Caddy / tunnel Caddy / systemd scripts present in CI workflow
  - [x] Migration runner contract (`npm run migrate` / CI migrate step)
  - [x] Backup script is full `pg_dump` (no web_push table exclusion)
  - [x] Backup/restore production-like acceptance rehearsal (Task 10A/B clean PG)
  - [x] Safe observability: dispatcher/sender do not log endpoint/keys/payload

## Task 10 — Full Regression, Manual Browser Acceptance, and Handoff

Automated regression (Task 10A/B):

- [x] Clean disposable PostgreSQL (scram-sha-256) with migrations 001–014;
  full server suite 1267 passed / 0 failed (no conditional skip of required
  PG contracts).
- [x] Full web suite 752 passed / 0 failed; build; bundle budget; responsive
  smoke; audits 0 vulns.
- [x] Service worker dist artifact: JS only, install/activate/push/click/
  pushsubscriptionchange listeners only; no fetch/CacheStorage/IndexedDB.
- [x] Backup/restore rehearsal includes web_push_subscriptions +
  web_push_deliveries row counts and FK presence; artifacts deleted.
- [x] Exact-head GitHub CI at Task 9 close (`bfb27c8`) server + web SUCCESS.
- [ ] Local Caddy/tunnel/systemd validate (blocked: no docker/caddy/
  systemd-analyze on agent host); scripts wired in CI workflow.

Real-device acceptance (Task 10C — operator / physical devices):

- [x] Desktop multi-browser staff↔manager instant notification traffic
  (Chrome + Firefox + Safari; operator confirmed 2026-07-22).
- [x] Local Chrome allow/subscribe/disable + dispatcher DELIVERED path
  (agent-assisted + operator).
- [ ] Chrome desktop edge matrix (deny profile / closed-browser / logout
  click / retry / stale) if required by product gate.
- [ ] Chrome Android physical device matrix.
- [ ] Real iOS/iPadOS Home Screen matrix (permission/background/Focus).
- [ ] Lock-screen privacy content review on physical devices.
- [ ] Application/access/provider log review (no endpoint/keys/payload).
- [ ] HTTPS staging with operator-provisioned VAPID (not agent-generated)
  for non-localhost mobile acceptance.
- [ ] Branding PR #47 merge + Phase R rebase + re-verification.
- [ ] Production enablement approval; `WEB_PUSH_ENABLED` stays false until then.
- [ ] Keep PR #45 Draft until all acceptance criteria and review pass.

Acceptance case log:
`docs/superpowers/plans/2026-07-22-minimal-install-web-push-acceptance.md`

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

cd ..
bash ops/ci/verify-caddyfile.sh
bash ops/ci/verify-tunnel-caddyfile.sh
bash ops/ci/verify-systemd-units.sh
```

## Production Enablement Gate

Runtime storage, manifest, UI, worker, and delivery code may merge with
`WEB_PUSH_ENABLED=false`. Production Web Push remains disabled until all are
recorded:

- [ ] final user-facing Turkish explanation and settings copy approved;
- [ ] production VAPID subject and one generated key pair stored outside Git;
- [ ] outbound HTTPS policy permits approved Chrome/Firefox/Safari endpoint
  families;
- [ ] subscription/payload metadata exposure and retention reviewed;
- [ ] stale endpoint cleanup and monitoring verified in production-like staging;
- [ ] Chrome, Firefox desktop, and real Safari/iOS manual acceptance passed;
- [ ] VAPID rotation and emergency-disable runbooks approved;
- [ ] exact production flag change receives explicit approval.

## Implementation Record

### Task 2 — Minimal install surface

- Runtime branch: `feature/minimal-install-web-push`, created from `f6d9365`;
  the independent `stash@{0}` was not applied.
- Root HTML now references the manifest and Apple touch icon. The manifest uses
  the approved `/jobs` online start route, root scope, standalone display, and
  Servora identity.
- Verified PNG assets: 192×192, 512×512, maskable 512×512, Apple 180×180, and
  monochrome notification badge 96×96.
- A root-started install controller retains `beforeinstallprompt` before auth
  settles, but invokes it only from the explicit settings action. Accepted,
  dismissed, `appinstalled`, standalone, manual guidance, and focus restoration
  behavior are covered.
- The settings subview performs no service-worker registration or notification
  permission request. Web Push remains default-off and Task 5 owns that later
  server-capability-driven behavior.
- Focused tests: 43 passed. Full web suite: 659 passed.
- Web production build, bundle budget, responsive smoke at the established
  viewports/200%/400%, and production audit passed; audit reported zero
  vulnerabilities.
- Manual install/browser acceptance and exact-head CI remain pending for Task
  10. No offline `fetch` handler, cache, service worker, or push runtime was
  added in this slice.
- Server build and production audit passed with zero vulnerabilities. The local
  full server suite reached 1,067 passing tests and three environment-specific
  failures: local password authentication accepted the intentionally wrong
  password, and the local application role lacked `job_action_locations`
  grants in two PostgreSQL acceptance tests. No server source changed in Task 2;
  exact-head CI remains the clean-environment regression authority.

### Task 3 — Server gate and subscription storage

- Added a server-owned, default-off `WEB_PUSH_ENABLED` config. Enabled startup
  now rejects missing, malformed, local-only, or mutually incompatible VAPID
  configuration before accepting requests; no generated key material entered
  Git.
- Migration `014_create_web_push` adds tenant-safe and auth-session-safe
  subscription storage plus the constrained durable delivery outbox. Global
  endpoint ownership, one active root-scope subscription per session, bounded
  attempts, state/lease fields, and due-work indexes are database-enforced.
- The repository derives endpoint, subscription, and decoded VAPID SHA-256
  fingerprints; endpoint/key material remains internal. It supports scoped
  lookup/disable, idempotent same-identity upsert, explicit same-user session
  rebind, ownership-opaque conflict, replacement cleanup, inactive-session
  cleanup, and idempotent delivery projection.
- Real PostgreSQL tests cover cross-tenant and wrong-session rejection,
  endpoint/session uniqueness, rebind and cross-owner isolation, abandoned old
  work, idempotent outbox append, inactive-session cleanup, state constraints,
  and required indexes.
- Serialized logger tests verify endpoint, encryption keys, payload, and VAPID
  values are redacted. Environment examples retain the false default and
  document root-owned secret handling.
- Focused Task 3 verification: 76 tests passed across config, redaction,
  migration, repository, upgrade, JobCard migration compatibility, and
  backup/restore; server build passed.
- The full local server suite reached 1,100 passing tests and the same three
  pre-existing environment failures recorded in Task 2: local PostgreSQL auth
  accepts the intentionally wrong password, and the local application role
  lacks `job_action_locations` grants in two acceptance tests. Phase R focused
  PostgreSQL tests do not skip and all pass; exact-head CI remains the clean
  environment regression authority.

### Task 4 — Authenticated subscription API and session safety

- Canonical request validation accepts only the exact PushSubscription shape,
  bounded URL-safe Base64 keys, finite non-negative expiration, and approved
  Chrome, Mozilla, or Apple HTTPS endpoints. Credentials, query, fragment,
  backslash authority, IP representations, misleading suffixes, and every
  explicit port including `:443` are rejected.
- Authenticated status exposes only the public VAPID key and safe current-session
  metadata. Create is default-off, idempotent, supports explicit same-user
  session rebind, and maps cross-owner conflicts to opaque
  `PUSH_SUBSCRIPTION_CONFLICT`.
- Delete is current-session scoped and idempotent. It remains available while
  Web Push is disabled as a cleanup-only operation; malformed IDs return `400`
  and every other owner/session scope receives the same `404`.
- POST and DELETE share a six-per-minute session-token-hash rate-limit group;
  status reads do not consume it. Existing authentication, forced-password,
  Origin, revoked/expired session, and inactive-user boundaries remain in
  force.
- The strict web API adapter is not consumed by UI components; Task 5 owns the
  permission/subscription controller.
- Focused verification: 71 server tests and 9 web API tests passed; server and
  web production builds, the 500,000-byte bundle budget, and both production
  dependency audits passed with zero vulnerabilities.

### Task 5 — Browser permission and subscription controller

- `BrowserWebPushAdapter` is the only web module that accesses Notification,
  service-worker, PushManager, standalone-display, and PushSubscription browser
  APIs. It registers only `/service-worker.js` with root scope and
  `updateViaCache: 'none'`; Task 5 does not add worker event behavior.
- `WebPushController` receives the server-owned status capability, never prompts
  on mount or recovery, and permits permission/subscription work only through
  the explicit device-notification action. Disabled and unsupported states do
  not register a worker or call Push APIs.
- Enable/disable commands share a synchronous gate. Server-save retry retains
  the browser subscription, cross-owner conflict rotates once only after an
  explicit command, and server disablement precedes best-effort browser cleanup.
- Identity reset and logout clear recipient-scoped state; logout performs local
  best-effort unsubscribe only after the authoritative server logout succeeds.
  Mount/focus/visibility/online recovery reconciles only an already-active
  current-session record and ignores stale identity responses.
- The existing notification settings dialog now presents enabled, disabled,
  unsupported/Home Screen, denied, and renewal-required guidance without raw
  HTTP or browser API use in the component.
- Focused adapter/controller/settings tests: 33 passed. Full web suite: 682
  passed. Web production build, bundle budget, responsive smoke at the
  established viewports/200%/400%, and production audit passed with zero
  vulnerabilities. Production `WEB_PUSH_ENABLED` remains false; service-worker
  push and click handling remain Task 6 work.

### Task 6 — Minimal Service Worker Push and Click Contract

- `web/public/service-worker.js` is a plain JavaScript file (no bundler) served
  at `/service-worker.js` with root scope and `updateViaCache: 'none'`.
- **push**: Valid V1 payload (version, notificationId, title, body, url) produces
  one `showNotification` with correct title/body/tag/icon/badge/safe data.
  Missing, malformed, unsupported, array, extra-field, or oversized payloads
  produce a generic `Servora-Med` / `Bekleyen işleriniz var.` notification
  linked to `/jobs`. No parse error becomes an unhandled rejection.
- **Payload validation**: exact 5-field contract; canonical UUID for
  `notificationId`; non-empty bounded title (≤120) and body (≤240);
  allowlist-based `/jobs/<UUID>` deep link; blocks cross-origin, query, hash,
  backslash, encoded-slash, and non-JobCard paths. Extra or sensitive fields
  (customerName, endpoint, p256dh, etc.) force generic fallback.
- **notificationclick**: closes notification; re-validates data URL via same
  allowlist; sorts `matchAll` results deterministically (exact URL match first,
  then client id); focuses exact target without navigating; navigates and
  focuses another same-origin client; opens window when no client exists;
  cross-origin/invalid URL falls back to `/jobs`.
- **install/activate**: `skipWaiting()` and `clients.claim()` only; no cache
  creation or migration.
- **pushsubscriptionchange**: posts fixed `{ type: 'push-subscription-changed' }`
  to open same-origin window clients; no fetch, mutation, or subscription
  material; no open client is a safe no-op.
- **Boundary enforcement**: worker has no `fetch`, sync, periodicsync,
  CacheStorage, IndexedDB, geolocation, or localStorage. Static analysis and
  runtime listener checks confirm this.
- **Caddy**: both `Caddyfile.example` and `Caddyfile.tunnel.example` add a
  dedicated `handle /service-worker.js` before the SPA catch-all so the worker
  is never served as `index.html`. Verification scripts check for the dedicated
  handler and `Cache-Control: no-cache`.
- **Test harness** (`tests/helpers/service-worker-harness.ts`): reads the real
  worker from disk via `node:fs`, runs it in `node:vm` isolation, captures
  `addEventListener` registrations, `showNotification` calls, and `waitUntil`
  promises. Does not duplicate parser or validation logic.
- Focused test files: `service-worker-push.test.ts` (20 tests),
  `service-worker-click.test.ts` (8 tests), `service-worker-boundary.test.ts`
  (19 tests) — all 47 pass. Full web suite: 729 passed. Web production build,
  bundle budget, responsive smoke, and `npm audit --omit=dev` passed.
- Added `clearNotifications()` to harness to support table-driven tests.
- No `server/` code, `web/src/` feature component, manifest, or branding file
  was changed. Worker registration path/scope/update policy matches Task 5.
- `WEB_PUSH_ENABLED` remains false. Foreground worker-message integration in
  `WebPushController` is deferred to Task 9. Real device testing belongs to
  Task 10.

### Task 7 — Notification-to-Outbox Projection

- `AppendWebPushDeliveriesInput` and `appendWebPushDeliveries()` added to
  `JobCardTransaction` interface; `PostgresJobCardTransaction` delegates to
  `PostgresWebPushTransaction.appendDeliveries`.
- `JobCardService` accepts a 5th constructor parameter `{ enabled: boolean }`
  for web push. In `appendRealtimeForActivity`, after
  `transaction.appendNotifications()` returns records, calls
  `transaction.appendWebPushDeliveries()` when
  `this.webPush.enabled && notifications.length > 0`.
- Wired `{ enabled: config.webPush.enabled }` from `app.ts` to `JobCardService`.
- `PostgresNotificationRepository.markRead` uses a data-modifying CTE:
  `WITH updated AS (...), abandoned AS (UPDATE web_push_deliveries SET state='ABANDONED', last_error_code='READ' FROM updated WHERE state='PENDING') SELECT ... FROM updated`.
- All 6 mock `JobCardTransaction` instances in server test files received
  `appendWebPushDeliveries: async () => []`.
- Migration `014_create_web_push.sql` added to the migration list in
  `notifications-migration.test.ts`.
- 14 PostgreSQL integration tests in
  `server/tests/notification-delivery-projection.test.ts` covering:
  single-subscription delivery, multiple-subscription dedup, disabled subscription,
  expired auth-session, inactive user, cross-tenant isolation, basic and
  disabled JobCardService wiring, rollback, idempotent dedup, no-backfill for
  post-commit subscriptions, and mark-read abandoning PENDING deliveries
  (including double-mark and non-PENDING safety).
- Focused verification: 14 tests passed. Full server suite: 1,168 passed and
  the same 3 pre-existing environment-specific failures (local auth accepting
  wrong password, two `job_action_locations` grants missing for the local
  application role). Server build passed.
- No new migration, no dispatcher, no provider call, no browser API, no config
  change. `WEB_PUSH_ENABLED` remains false.

### Task 8 — Bounded Push Dispatcher and Sender Adapter

- `web-push@3.6.7` + `@types/web-push@3.6.4` pinned in `package.json`. The
  library is required for RFC 8291 (AES128GCM encryption) and RFC 8292 (VAPID
  signature) which existing stack helpers (Node `crypto`, generic HTTP) cannot
  produce correctly without reimplementing protocol details.
- **Sender adapter** (`sender.ts`): `createWebPushSender(vapid, requestFn?)`
  returns a `WebPushSender` with a single `send(input)` method. Uses
  `webPush.generateRequestDetails()` for encryption/VAPID, then an injected
  `https.request` function (defaults to `node:https`). Returns a discriminated
  union: `{ type: 'response', statusCode }` | `'network-error'` | `'timeout'` |
  `'aborted'`. Validates endpoint via `parseApprovedPushEndpoint` (rejects
  non-allowlisted endpoints without making a request). Respects `AbortSignal`
  and configurable timeout (default 10s). Drains response body without logging.
  7 unit tests.
- **Payload builder** (`payload.ts`): `buildPushPayload(PublicNotification)`
  validates entity type is `job-card` and entity ID is a canonical UUID, then
  returns `PushPayloadV1` (version, notificationId, title, body, url). Rejects
  forbidden business fields. `buildPushTopic` strips hyphens from notification
  ID for topic deduplication. 14 unit tests.
- **Dispatch repository port** (`repository.ts`): 6 SQL methods appended to
  `PostgresWebPushRepository`:
  - `cleanupDueDeliveries(at)` — CTE abandons PENDING/expired-CLAIMED rows
    whose eligibility has expired (read notification, disabled subscription,
    inactive user, revoked/expired session).
  - `claimDueDeliveries(input)` — CTE with `FOR UPDATE SKIP LOCKED`,
    deterministic ordering by `next_attempt_at ASC, id ASC`, eligibility joins
    (unread notification, active subscription, active user, valid session,
    attempt < 6, delivery < 24h old). Returns `ClaimedWebPushDelivery[]`.
  - `recordDelivered(input)` — lease-token-guarded UPDATE to `DELIVERED`,
    resets subscription `consecutive_failures`.
  - `recordRetry(input)` — lease-token-guarded UPDATE to `PENDING` with
    `next_attempt_at` and `last_error_code`.
  - `recordAbandoned(input)` — lease-token-guarded UPDATE to `ABANDONED`.
  - `recordProviderStale(input)` — transaction: abandon current delivery,
    disable subscription (`PROVIDER_STALE`), abandon remaining
    PENDING/expired-CLAIMED deliveries for same subscription.
  - 8 unit tests (SQL patterns) + 10 PostgreSQL integration tests (P1-P6/R1-R4
    covering claim, lease, concurrency, limit, delivery, retry, abandon, and
    provider-stale).
- **Dispatcher** (`dispatcher.ts`): `createDispatcher(config, deps)` returns a
  `WebPushDispatcher` with `start()`/`stop()`.
  - **Exported constants**:
    `WEB_PUSH_DISPATCH_CONCURRENCY = 4`,
    `WEB_PUSH_POLL_INTERVAL_MS = 5_000`,
    `WEB_PUSH_SEND_TIMEOUT_MS = 10_000`,
    `WEB_PUSH_LEASE_DURATION_MS = 30_000`,
    `WEB_PUSH_SHUTDOWN_GRACE_MS = 15_000`,
    `WEB_PUSH_MAX_ATTEMPTS = 6`,
    `WEB_PUSH_RETRY_DELAYS_MS = [30s, 2m, 10m, 30m, 1h]`.
  - **retryDelayForAttempt(attemptCount)**: returns fixed delay from
    `WEB_PUSH_RETRY_DELAYS_MS` array; attempt 6 (and above) returns `null`
    (immediate abandon without further delay). No `Math.random()`, jitter, or
    exponential backoff.
  - **Global concurrency**: `activeSends` Map keyed by `deliveryId` with
    `{ controller: AbortController, promise: Promise<void> }`.
    `availableSlots = WEB_PUSH_DISPATCH_CONCURRENCY - activeSends.size`.
    Each cycle claims exactly `Math.min(deliveries.length, availableSlots)`
    deliveries and starts one `processDelivery` per slot.
  - **Poll overlap guard**: `pollInFlight` boolean prevents a new claim cycle
    from starting while the previous cleanup+claim is still in progress.
  - **Per-send AbortController**: each `processDelivery` creates its own
    `AbortController`. On `stop()`, ALL active controllers are aborted after
    the grace period, not just the most recent cycle's.
  - **Shutdown/claim race guard**: `stopping` is checked AFTER
    `claimDueDeliveries` returns. If shutdown started while the claim was
    in-flight, provider sends are not started. Delivery rows remain `CLAIMED`
    with lease fields unchanged; after the 30-second lease expires they may be
    reclaimed by another dispatcher or process restart.
  - **HTTP classification** (`classifyResponse`): maps HTTP status to
    `DispatchOutcome` — `DELIVERED` (2xx), `PROVIDER_STALE` (404/410),
    `RETRYABLE` (408/429/5xx), `TERMINAL` (3xx/other 4xx/0).
  - **Error code normalization** (`errorCodeForStatus`): produces canonical
    values — `PROVIDER_404`, `PROVIDER_408`, `PROVIDER_410`, `PROVIDER_429`,
    `PROVIDER_5XX`, `PROVIDER_REDIRECT`, `PROVIDER_4XX`, `NETWORK`, `TIMEOUT`,
    `MAX_ATTEMPTS`, `INVALID_PAYLOAD`.
  - **Canonical presenter**: uses `presentNotification(record)` to convert
    `NotificationRecord` → `PublicNotification` before invoking
    `buildPayload`. Unknown notification kinds throw → caught as
    `INVALID_PAYLOAD` abandon (no inline fallback message map).
  - **resultAt**: captured after the provider response returns, used for
    ALL result timestamps (delivered/retry/abandon/stale) within that
    delivery's processing.
  - **Graceful shutdown**: clear interval → if active sends exist, race
    `waitForActive` vs 15s timeout. If timeout wins, abort ALL active
    controllers, then wait for completion. Aborted results
    (`result.type === 'aborted'`) skip all repository writes.
  - Unit tests covering: retry schedule, claim/deliver, claim limit = 4,
    concurrency ≤4, no claim while four unresolved, claim limit 1 after a slot
    frees, available-slots-based claim, 5xx/network/timeout retry, 404/410
    provider-stale, build-failure and unknown-kind abandon (real presenter path),
    empty claim, error survival, in-flight wait, exact 14_999/15_000 ms grace
    abort boundary, HTTP mapping table, attempt 6 abandon, poll overlap,
    shutdown/claim race (no sender after stop; rows stay CLAIMED), multi-cycle
    abort of all active controllers, no post-stop claims, clock injection for
    result timestamps, static source guard against jitter/exponential/300s cap.
- **Lifecycle wiring** (`app.ts`): when `config.webPush.enabled` is `true` and
  `webPushRepository` exists, creates the dispatcher with its deps, registers
  `onReady` → `start()` and `onClose` → `stop()`. Accepts
  `dependencies.webPushDispatcher` for test injection. When disabled, neither
  constructs the sender nor wires lifecycle — even if an injected dispatcher is
  provided. The gate is `config.webPush.enabled` only
  (not `|| dependencies.webPushDispatcher`). Lifecycle tests cover enabled
  injection, disabled without injection, and disabled with injection.
- **Fixed retry schedule** (design spec compliance):
  failed attempt 1 → 30 seconds,
  failed attempt 2 → 2 minutes,
  failed attempt 3 → 10 minutes,
  failed attempt 4 → 30 minutes,
  failed attempt 5 → 1 hour,
  failed attempt 6 → immediate `MAX_ATTEMPTS` abandonment via `recordAbandoned`
  (no further delay indexing). No jitter, no exponential backoff, no 300s cap.
  The previous implementation used `2^(n-1)*10s` with ±20% jitter and 300s cap.
- **Clock injection**: optional `DispatcherClock` (`() => Date`) on dispatcher
  deps; production default is `() => new Date()`. Result timestamps
  (`delivered_at` / `abandoned_at` / `last_failure_at` / `next_attempt_at`)
  are taken after the provider returns, not at send start.
- **Dispatcher removed**: `batchSize` from `DispatcherConfig`; concurrency is
  now a constant. `computeBackoff` removed; replaced by `retryDelayForAttempt`.
  Removed inline `NOTIFICATION_MESSAGES` map; uses canonical
  `presentNotification` from the notifications module.
- **Default-off gate fix**: `app.ts` line 244 changed from
  `config.webPush.enabled || dependencies.webPushDispatcher` to
  `config.webPush.enabled`. Previously an injected dispatcher dependency would
  start polling even with `WEB_PUSH_ENABLED=false`. Now the gate is strictly
  the config flag.
- **PostgreSQL test R3 update**: the attempt-6 test now calls
  `recordAbandoned` with `MAX_ATTEMPTS` instead of `recordRetry`, matching
  the dispatcher's behavior. Verifies state is `ABANDONED`, `abandoned_at` is
  set, and `last_error_code` is `MAX_ATTEMPTS`.
- **Residual at-least-once risk**: a crashed dispatcher that has claimed rows
  but not sent them will have its leases expire after 30s. Another dispatcher
  instance (or the same one after restart) will reclaim those rows via
  `claimDueDeliveries` which includes `state = 'CLAIMED' AND lease_until < $at`.
  Stable topic tags mitigate duplicate `showNotification` at the browser level.
  True exactly-once is infeasible in a crash-recovery push system.
- Focused verification: 152 web-push tests passed across 11 test files (45
  dispatcher unit, 8 sender, 14 payload, 18 repository SQL, 10 dispatch
  PostgreSQL, 7 sender validation, 10 notification-delivery projection, 14
  identity-setup-trigger, 8 projection lifecycle, 15 web-adapter, 3 lifecycle).
  Full server suite: 1,253 passed, same 5 pre-existing environment-specific
  failures (3 env + 2 auth-setup-postgres). Server and web production builds
  passed. `WEB_PUSH_ENABLED` remains `false` in production.

### Task 9 — Integrated UI, Recovery, and Responsive Verification

- **Foreground `pushsubscriptionchange` recovery**: `WebPushController` listens
  on an injectable `serviceWorkerTarget` for the exact fixed message
  `{ type: 'push-subscription-changed' }` (single key). Invalid shapes are
  ignored. Handler only calls existing `recover()` — no permission prompt,
  auto-subscribe, auto-renewal, or cross-account rebind.
- **Generation-scoped recovery**: recovery state is
  `{ generation, promise }`. Same-generation focus/online/visibility/SW signals
  share one promise; a new identity generation starts independent recovery and
  is not blocked by an unresolved prior generation. Stale A `finally` cannot
  clear B’s active recovery; stale A results never mutate B snapshot or run
  mutations. Covered by deterministic gate tests in
  `web-push-controller.test.ts`.
- **Listener lifecycle**: message listener registers once on first `start()`,
  is removed on `stop()`, and is optional when `serviceWorkerTarget` is absent.
- **Identity isolation**: generation guards reject stale recovery mutations
  after logout/`clearLocalSubscription` and account switch. Two independent
  controller instances with separate SW targets do not cross-call APIs.
- **UI loading/pending**: settings show
  `Cihaz bildirimi durumu yükleniyor…` (`role="status"`) while `enabled === null`;
  enable/disable buttons stay hidden. Pending actions use disabled buttons with
  `aria-busy`. Long errors keep `role="alert"` and `overflow-wrap: anywhere`.
- **Responsive smoke**: fixture accepts `?pushState=` matrix; runs at 390/720/
  768/1024/1440 plus 200% and 400% reflow samples (`npm run smoke:responsive`).
- **Integrated normal path (PostgreSQL)**:
  `server/tests/web-push-integrated-normal-path.test.ts` uses real
  `JobCardService.submitForApproval` (webPush enabled) →
  `in_app_notifications` + `web_push_deliveries` PENDING →
  `PostgresWebPushRepository.claimDueDeliveries` →
  `presentNotification` + `buildPushPayload` → fake sender capture →
  `recordDelivered` matching lease → real `service-worker.js` harness
  `showNotification` once → `notificationclick` focus `/jobs/<UUID>` with no
  mark-read/`fetch`/`postMessage` mark-read side effects.
- **Mark-read proof**: worker source static analysis (no `fetch`, no
  `/api/notifications`, no mark-read event types); click harness asserts no
  `client.postMessage`; NotificationCenter + real controller assert SW message
  does not call `markNotificationRead` / list / unread APIs. Canonical
  notification SSE invalidation still refreshes list/unread.
- **Authorization**: `web/tests/job-detail.test.tsx` covers authorized REST
  load, opaque not-found UI, and cross-tenant-as-not-found without using push
  payload as job data. Server route tests keep `JOB_CARD_NOT_FOUND` for
  malformed IDs.
- **Ops evidence**:
  - Local Docker/`systemd-analyze` may be missing; scripts are exercised in
    GitHub CI (`ops/ci/verify-caddyfile.sh`, tunnel Caddy, systemd).
  - Backup is full-database `pg_dump` (no table exclusion list for web_push).
  - Production-like restore rehearsal remains an enablement/Task 10 gap.
  - Dispatcher/sender have no console logging of endpoint/keys/payload.
- Branding PR #47 remains Draft; post-merge `main` rebase may be required.
- Task 10 (real device acceptance / production enablement) is **partial**.

### Task 10 — Automated regression + blocked device acceptance (partial)

- **Clean PostgreSQL regression**: ephemeral Postgres 16 on `127.0.0.1:55432`
  with `scram-sha-256` host auth (`postgres`/`postgres`), empty
  `servora_med_test`, migrations 001–014 applied. Local trust-auth Homebrew
  cluster is **not** used for Task 10A (it cannot fail wrong-password checks
  and had grant drift on `job_action_locations`).
- **Server tests**: 1267 passed / 0 failed / 103 files.
- **Web tests**: 752 passed / 0 failed / 80 files.
- **Build/bundle/smoke/audit**: web+server build OK; bundle budget OK;
  responsive smoke OK; `npm audit --omit=dev` 0 vulns both packages.
- **Ops local**: `verify-caddyfile.sh` / tunnel / systemd exit 1 without
  docker/caddy/systemd-analyze; same scripts run in GitHub CI
  (`.github/workflows/ci.yml`).
- **Backup/restore**: full `pg_dump` + restore-rehearsal with synthetic
  subscription/notification/delivery; restore counts
  `subs=1,dels=1,notifs=1,migrations=14,fk=6`; dump deleted after run.
- **Staging / VAPID**: agent did **not** generate VAPID keys or enable public
  HTTPS staging. Production `WEB_PUSH_ENABLED` remains false.
- **Device acceptance**: blocked — Chrome/Android/Firefox/Safari/iOS matrices
  require operator + physical devices. Case log scaffold:
  `docs/superpowers/plans/2026-07-22-minimal-install-web-push-acceptance.md`.
- **Exact-head SHA**: `bfb27c8c5ee219f7cd891b7902a8f34a91d7b580`
- **CI run IDs (Task 9 close / current head)**:
  server `29943672288/job/89003581379` SUCCESS;
  web `29943672288/job/89003581334` SUCCESS.
- **Merge SHA**: pending explicit review and merge.
- **Known risk**: at-least-once crash window on claimed deliveries (lease reclaim).
