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

- [ ] RED→GREEN: server `enabled: false` causes no service-worker registration,
  permission request, Push API call, or subscription request.
- [ ] RED→GREEN: unsupported service worker, PushManager, or Notifications API
  shows guidance and preserves normal application behavior.
- [ ] RED→GREEN: `default` requests permission exactly once and only from the
  explicit `Cihaz bildirimlerini aç` click.
- [ ] RED→GREEN: `denied` never re-prompts and shows browser/OS settings
  guidance; `granted` proceeds without another prompt.
- [ ] RED→GREEN: register fixed `/service-worker.js`, root scope, and
  `updateViaCache: 'none'`; no user/server value supplies the script URL.
- [ ] RED→GREEN: subscribe with exact `userVisibleOnly: true` and decoded
  server public key.
- [ ] RED→GREEN: a synchronous gate prevents duplicate subscribe/disable;
  server-save retry reuses the same browser subscription.
- [ ] RED→GREEN: explicit disable completes server disable before best-effort
  browser unsubscribe and then reloads canonical status.
- [ ] RED→GREEN: logout best-effort unsubscribes locally after authoritative
  server session revocation; identity/account changes clear all controller
  state and never auto-associate an old endpoint.
- [ ] RED→GREEN: after cross-account `409`, explicit enable unsubscribes,
  creates a fresh browser subscription, and retries create exactly once; a
  second conflict stops without a loop.
- [ ] RED→GREEN: on authenticated mount/focus/visibility/online recovery,
  compare browser and safe server fingerprints only when the current session
  already has an active server record; equal state writes nothing and changed
  endpoint/keys refresh that opted-in record.
- [ ] RED→GREEN: a missing browser subscription disables the server record;
  provider-stale or changed-VAPID `renewalRequired` rotates only after a new
  explicit enable action.
- [ ] RED→GREEN: Home Screen guidance precedes push enablement when required
  capabilities are unavailable in a non-installed context.
- [ ] Run focused browser-adapter/controller/UI tests and web build.

## Task 6 — Minimal Service Worker Push and Click Contract (Vertical TDD)

Allowed source area: one root service-worker asset, a focused worker harness,
manifest assets, Caddy examples/checks, and focused tests. No feature component
or business API changes.

- [ ] RED→GREEN: a valid version-1 payload produces one visible notification
  with generic title/body, stable notification tag, icon/badge, and safe data.
- [ ] RED→GREEN: missing, malformed, or unsupported payload still produces a
  generic visible notification linked only to `/jobs`.
- [ ] RED→GREEN one rejection at a time: disallow cross-origin, credentials,
  query/hash, backslashes, encoded slashes, non-Job paths, and malformed UUIDs.
- [ ] RED→GREEN: click closes the notification and focuses an exact open target
  client before navigating another same-origin client or opening a new window.
- [ ] RED→GREEN: install/activate replaces the prior worker without creating or
  deleting business caches.
- [ ] RED→GREEN: `pushsubscriptionchange` performs no fetch/API mutation and
  posts only a fixed, data-free refresh signal to currently open same-origin
  clients; no open client is a safe no-op.
- [ ] Add a source/static contract test proving there is no `fetch`, sync,
  periodic-sync, geolocation, CacheStorage, IndexedDB, or mutation behavior.
- [ ] Update Caddy examples and behavior tests so worker JS is never SPA HTML,
  uses JavaScript MIME and `no-cache`; manifest revalidates and versioned icons
  may be immutable.
- [ ] Run focused worker/ops tests and web build.

## Task 7 — Notification-to-Outbox Projection (Vertical TDD)

Allowed source area: JobCard notification orchestration, notification/web-push
transaction ports, Task 3 repository, and focused real-PostgreSQL integration
tests. No provider call or web UI.

- [ ] RED→GREEN: one committed persistent notification plus one active
  recipient subscription creates exactly one delivery in the same transaction.
- [ ] RED→GREEN: multiple current recipient subscriptions create one unique
  delivery each; unrelated, disabled, expired-session, inactive-user, or
  cross-tenant subscriptions create none.
- [ ] RED→GREEN: notification transaction rollback produces no delivery;
  idempotent JobCard replay produces no duplicate.
- [ ] RED→GREEN: push disabled mode creates the unchanged persistent in-app
  notification but no delivery.
- [ ] RED→GREEN: subscribing after notification commit does not backfill old
  notification deliveries.
- [ ] RED→GREEN: mark-read abandons unclaimed pending work; the accepted
  post-claim race remains recorded rather than hidden.
- [ ] Confirm public notification/JobCard/realtime DTOs and semantic recipient
  policy are unchanged.
- [ ] Run focused lifecycle/notification/PostgreSQL tests and server build.

## Task 8 — Bounded Push Dispatcher and Sender Adapter (Vertical TDD)

Allowed source area: Task 3 web-push module, one external-sender adapter,
dispatcher lifecycle wiring, the narrowly justified pinned `web-push`
dependency, and focused tests.

- [ ] RED→GREEN: atomically claim one due row with lease identity and send only
  after the claim transaction closes.
- [ ] RED→GREEN: claim count never exceeds currently available slots, at most
  four sends run concurrently, and no fifth sender starts until a slot is free.
- [ ] RED→GREEN: the 30-second lease exceeds the 10-second send timeout;
  concurrent claimers and process-restart lease recovery do not normally send
  the same row twice, and result writes require the matching lease token.
- [ ] RED→GREEN: build the exact generic payload/deep link from the committed
  notification presenter; prove forbidden business fields are absent.
- [ ] RED→GREEN: success records delivered time and resets subscription
  failure state without logging sensitive sender output.
- [ ] RED→GREEN: `404` and `410` disable the subscription and abandon its
  remaining due work.
- [ ] RED→GREEN one retry class at a time: timeout/network/`408`/`429`/`5xx`
  use the approved 30s/2m/10m/30m/1h schedule, six total send attempts (initial
  plus five retries), and 24-hour expiry. Failed attempt 6 is abandoned without
  indexing another delay.
- [ ] RED→GREEN: other `4xx`, already-read, revoked-session, inactive-user,
  disabled-subscription, and expired work terminate without a sender call.
- [ ] RED→GREEN: disabled config never constructs/starts the sender or polls;
  shutdown stops polling/claims, starts no new provider call, waits 15 seconds,
  aborts unfinished sends, and leaves their claims unchanged until the
  30-second lease expires.
- [ ] Record the residual at-least-once crash window and stable tag/topic
  mitigation in the Implementation Record; do not claim external exactly-once.
- [ ] Pin and audit `web-push`; document why protocol encryption/VAPID cannot be
  safely replaced by existing stack helpers.
- [ ] Run focused dispatcher/sender/config tests, full server build, and audit.

## Task 9 — Integrated UI, Recovery, and Responsive Verification

Allowed source area: completed Phase R files, existing notification-center
tests/fixtures, responsive smoke, and operations verification only.

- [ ] RED→GREEN: a committed notification passes through outbox/sender payload
  into the worker display once in the normal path, then click loads the existing
  authorized JobCard route.
- [ ] RED→GREEN: destination not-found/authorization behavior remains canonical
  and no push payload bypasses REST permissions.
- [ ] RED→GREEN: logout/account switch and two authenticated browser profiles
  cannot cross-deliver or expose another recipient's subscription state.
- [ ] RED→GREEN: notification-center invalidation/read behavior remains
  unchanged; push does not invent a new mark-read SSE event.
- [ ] Add real settings/long-copy/loading/error/pending states to responsive
  smoke at 390, 720, 768, 1024, and 1440 px plus 200% text and 400% reflow.
- [ ] Verify install/push controls, dialog focus/back restoration, unsupported
  state, denied state, and long errors without horizontal overflow.
- [ ] Verify production-like default-off runtime, manifest/icons/worker HTTP
  behavior, backups/restores, migration, shutdown, and safe observability.

## Task 10 — Full Regression, Manual Browser Acceptance, and Handoff

- [ ] Run all required server and web commands below with the real local test
  PostgreSQL database; do not treat conditional skips as execution.
- [ ] Confirm exact-head GitHub CI server and web jobs pass.
- [ ] Chrome desktop and Android: install, allow, deny, foreground/background,
  duplicate/retry, click, logout, and stale-endpoint cases.
- [ ] Firefox desktop: install where supported, allow/deny,
  foreground/background, Mozilla endpoint, click, logout, refresh, and stale
  endpoint cases.
- [ ] Safari macOS: Add to Dock, allow/deny, closed-browser delivery, and click.
- [ ] Real iOS/iPadOS Home Screen app: install, explicit permission, background
  delivery, click, Focus behavior awareness, logout/account switch, and
  non-installed guidance.
- [ ] Confirm lock-screen text contains no customer, contact, JobCard title,
  note, delivery, actor, or location data.
- [ ] Confirm provider logs/application logs/access logs contain no endpoint,
  keys, payload, deep-link entity ID, or VAPID secret.
- [ ] Record exact config (without secrets), browser/OS versions, provider
  endpoint families, command results, known at-least-once risk, CI run, merge
  SHA, and branch cleanup in the design Implementation Record.
- [ ] Keep runtime PR draft until all acceptance criteria, real-device gates,
  review, and exact-head CI pass.

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
