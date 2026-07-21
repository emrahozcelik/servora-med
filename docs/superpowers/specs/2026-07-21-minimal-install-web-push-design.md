# Servora-Med Minimal Install Surface and Web Push Design

**Date:** 2026-07-21
**Status:** Proposed — docs-only design review required before runtime work
**Phase:** R — minimal install surface and Web Push
**Dependencies:** Phase P persistent notification center and its recipient policy
are merged and stable. Phase Q production geolocation enablement is independent
and remains default-off.

## 1. Objective

Add a minimal installable web-app surface and optional browser Web Push for the
existing persistent in-app notifications. A push tells an intended recipient
that one already-committed notification is available and opens its existing
Servora-Med JobCard deep link.

This phase does not make push a source of JobCard truth. The persistent
`in_app_notifications` row remains the user-facing read model, and the existing
authorized REST APIs remain authoritative after navigation.

## 2. Scope

Included:

- a Web App Manifest, install-safe application icons, and standalone launch;
- explicit Chromium install prompting when `beforeinstallprompt` is available;
- manual Add to Home Screen/Add to Dock guidance when no install event exists;
- a minimal root-scoped service worker for `push` and `notificationclick`;
- an explicit, user-initiated browser notification permission flow;
- VAPID-backed Push API subscriptions;
- tenant-, recipient-, and auth-session-scoped subscription storage;
- a durable delivery outbox derived from committed persistent notifications;
- bounded delivery retries and stale endpoint cleanup;
- privacy-safe notification payloads and allowlisted relative deep links;
- current Chrome and real Safari/iOS manual acceptance.

Excluded:

- business API or HTML response caching;
- a `fetch` event handler in the service worker;
- offline JobCard reads or mutations;
- Background Sync, offline queues, or cache-first/stale-while-revalidate data;
- full JobCard, customer, contact, note, delivery, actor, or location payloads;
- geolocation production enablement, policy, retention, or provider work;
- email, SMS, WhatsApp, native mobile applications, WebSocket, Redis, Kafka,
  LISTEN/NOTIFY, or a general-purpose job queue;
- marketing notifications, bulk campaigns, scheduling, or user-authored push;
- OS application stores and native packaging.

## 3. Foundational Rules

### 3.1 Persistent notification first

Push delivery may exist only for a committed `in_app_notifications` row. A
JobCard command never contacts a browser push service and never waits for a
push result.

```text
JobCard command transaction
  -> activity and realtime event
  -> persistent recipient notification
  -> one delivery row per currently active recipient subscription
  -> commit

post-commit dispatcher
  -> claim due delivery
  -> send encrypted Web Push outside every database transaction
  -> record success, retry, expiry, or endpoint disablement
```

A rolled-back command produces no notification and no delivery. An idempotent
command replay produces neither again. A user who subscribes later does not
receive a backlog of notifications created before that subscription.

### 3.2 Online application remains canonical

Push accelerates awareness; it does not synchronize application state. Clicking
a push opens a route and the existing authenticated client loads canonical REST
data. SSE, focus/visibility recovery, and disconnected fallback behavior remain
unchanged.

### 3.3 Progressive enhancement

Unsupported browsers continue as the existing online application. Capability
checks use `serviceWorker`, `PushManager`, `Notification`, display-mode media
queries, and install events. User-agent browser detection does not grant or
deny functionality.

## 4. Default-Off Enablement

`WEB_PUSH_ENABLED` is a server-owned boolean configuration value. Absence and
the exact value `false` mean disabled. The exact value `true` is the only
enabled state; every other non-empty value fails configuration validation.

When disabled:

- the authenticated status endpoint returns `enabled: false` and no VAPID key;
- the web does not register the push service worker, request notification
  permission, call `PushManager.subscribe`, or submit subscription material;
- subscription creation is rejected without inserting or reactivating a row;
- notification projection creates no push delivery rows;
- no dispatcher starts and no push-service HTTP request occurs;
- the manifest and install guidance may still be served because installing the
  online application is independent from enabling background notifications.

When enabled, startup requires all of:

```text
WEB_PUSH_ENABLED=true
WEB_PUSH_VAPID_SUBJECT=mailto:... or https://...
WEB_PUSH_VAPID_PUBLIC_KEY=<URL-safe Base64 P-256 public key>
WEB_PUSH_VAPID_PRIVATE_KEY=<URL-safe Base64 private key>
```

Missing, empty, malformed, or mutually incompatible VAPID configuration fails
before the server accepts requests. `https://localhost` is not an accepted
production VAPID subject because Safari push services reject that subject. The
private key is never returned to the web, persisted in PostgreSQL, or logged.

The web has no independent `VITE_*` security flag. It learns the resolved
capability and public VAPID key from an authenticated server endpoint.

## 5. Manifest, Icons, and Install UX

The root document references `/manifest.webmanifest` and an Apple touch icon.
The manifest defines:

```text
id: /
name: Servora-Med
short_name: Servora-Med
start_url: /jobs
scope: /
display: standalone
background_color: existing Servora shell background
theme_color: existing Servora theme color
lang: tr
prefer_related_applications: false
```

Assets include:

- 192×192 and 512×512 PNG icons with `purpose: any`;
- a separate 512×512 maskable icon with the brand mark inside the maskable safe
  zone;
- a 180×180 Apple touch icon;
- a small monochrome notification badge asset where supported.

Icons use the existing Servora `S` brand mark and approved palette. Generated
files are checked for exact dimensions, non-empty alpha/content, MIME type, and
manifest paths. No third-party logo or placeholder asset is shipped.

The authenticated notification panel gains a compact
`Kurulum ve cihaz bildirimleri` settings subview rather than a new navigation
module. A tiny root-level install-opportunity controller begins listening before
authentication UI settles so an early `beforeinstallprompt` event is not lost;
it never displays or triggers a prompt by itself. The authenticated settings
subview consumes that retained single-use event.

- If `beforeinstallprompt` is available, the app stores that event and exposes
  `Uygulamayı yükle`; `prompt()` runs only from that explicit click. The event
  is single-use and cleared after accepted or dismissed outcome.
- `appinstalled` clears install prompting state.
- If no programmatic install event exists, the surface gives non-blocking
  manual instructions: browser menu/Add to Dock, or Share → Add to Home Screen.
- Instructions may name browser menu labels, but feature availability is never
  decided from a user-agent string.
- In standalone display mode, install prompting is hidden.
- The application never opens an install or permission prompt on login, page
  load, notification-panel open, or route navigation.

A service worker is not used to make the business application offline. Current
installability guidance does not require inventing a `fetch` handler.

## 6. Permission and Subscription UX

The settings subview explains before any browser prompt:

> Cihaz bildirimlerini açarsanız size atanan veya onayınızı bekleyen işler için
> Servora-Med kapalıyken de genel bir bildirim gösterilebilir. Bildirimlerde
> müşteri, not, teslimat veya konum bilgisi yer almaz. Bu ayarı istediğiniz zaman
> kapatabilirsiniz.

The exact final Turkish copy remains a product-review item in this docs PR; its
behavioral contract is fixed:

1. No permission request occurs without the `Cihaz bildirimlerini aç` click.
2. `default` may call `Notification.requestPermission()` once from that click.
3. `granted` proceeds to service-worker registration and subscription.
4. `denied` does not call the prompt repeatedly; the UI explains that browser
   or operating-system settings control the decision.
5. Missing required browser capabilities shows an unsupported state and leaves
   the normal online application fully functional.
6. On iOS/iPadOS, Web Push is offered only when the installed Home Screen web
   app exposes the required features. Otherwise Add to Home Screen guidance is
   shown first.

`PushManager.subscribe` uses exactly:

```ts
{
  userVisibleOnly: true,
  applicationServerKey: decodedServerPublicVapidKey,
}
```

If browser subscription succeeds but the server request fails, the local
subscription is retained for an explicit retry; retry reuses it rather than
prompting again. A synchronous pending gate prevents duplicate click races.

Disabling follows this order:

1. disable the recipient/session-scoped server record;
2. call the browser subscription's `unsubscribe()` best-effort;
3. reload canonical server/browser status.

Server disablement is authoritative. Browser cleanup failure cannot permit a
disabled server row to receive another delivery.

## 7. Authenticated API

Routes use the existing session authentication and password-change gate:

```text
GET    /api/web-push/status
POST   /api/web-push/subscriptions
DELETE /api/web-push/subscriptions/:subscriptionId
```

Status response:

```ts
type WebPushStatus = Readonly<{
  enabled: boolean;
  vapidPublicKey: string | null;
  subscription: null | Readonly<{
    id: string;
    createdAt: string;
  }>;
}>;
```

Only a subscription belonging to the authenticated organization, user, and
current auth session is returned. Endpoint and encryption keys never appear in
any response.

Creation accepts the exact browser `PushSubscription` data required for
delivery:

```ts
type CreateWebPushSubscription = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{
    p256dh: string;
    auth: string;
  }>;
}>;
```

Validation requires exact fields, bounded lengths, URL-safe Base64 key
material, and an HTTPS endpoint with no credentials, non-default port, IP
literal, fragment, or unsupported push-service host. The first pilot endpoint
allowlist is deliberately server-owned and SSRF-safe:

- exact `fcm.googleapis.com` for current Chrome;
- exact `updates.push.services.mozilla.com` for standards-compatible Firefox;
- exact `push.apple.com` or a hostname ending in `.push.apple.com` for Safari.

Adding another push service is an explicit server configuration/code review,
not a client-provided escape hatch.

Creation is idempotent for the same endpoint and current identity/session. An
endpoint already owned by another user or organization is not silently
transferred; the client must unsubscribe/rotate it after an explicit action.
Deletion is scoped by organization, recipient, and current session and returns
`404` outside that scope.

Subscription creation and deletion receive focused rate limits. Request-body
redaction covers the entire endpoint and key object.

## 8. Subscription Storage and Session Safety

Migration `014_create_web_push.sql` adds two focused tables. The names are
proposed and must remain consistent across SQL and TypeScript.

```text
web_push_subscriptions
  id
  organization_id
  recipient_user_id
  session_id
  endpoint
  endpoint_hash
  p256dh
  auth
  expiration_time nullable
  created_at
  updated_at
  disabled_at nullable
  disabled_reason nullable
  last_success_at nullable
  last_failure_at nullable
  consecutive_failures
```

Required constraints:

- tenant-safe organization/recipient foreign key;
- a migration-added `sessions (user_id, id)` unique key and matching
  subscription `(recipient_user_id, session_id)` foreign key so a row cannot
  bind another user's session;
- globally unique SHA-256 `endpoint_hash`, because one browser endpoint must
  not deliver two users' data;
- at most one active subscription for the root service-worker scope per auth
  session;
- non-negative failure count and exact disabled-reason vocabulary;
- bounded non-empty endpoint/key fields.

Endpoint, `p256dh`, and `auth` are sensitive capability material. They are
stored only because standards-based delivery needs them. They are not browser
or device analytics; Phase R stores no raw user-agent, device name, advertising
identifier, IP address, or location in this table.

The dispatcher joins subscriptions to active users and unrevoked, unexpired
sessions before every send. Logout and password-change session revocation
therefore stop delivery server-side even if browser `unsubscribe()` fails.
Expired/revoked-session subscriptions are disabled during dispatcher cleanup.

On explicit logout the web performs best-effort local browser unsubscription
after the authoritative server logout. On account change, push UI state is
cleared. A new account must click enable explicitly; an old endpoint is never
auto-associated during login.

## 9. Durable Delivery Outbox

```text
web_push_deliveries
  id
  organization_id
  notification_id
  subscription_id
  state = PENDING | CLAIMED | DELIVERED | ABANDONED
  attempt_count
  next_attempt_at
  lease_token nullable
  lease_until nullable
  last_error_code nullable
  delivered_at nullable
  abandoned_at nullable
  created_at
  updated_at
```

Required constraints:

- tenant-safe notification and subscription foreign keys;
- unique `(notification_id, subscription_id)`;
- exact state-dependent timestamp/lease checks;
- non-negative bounded attempts;
- indexes for due claims and subscription cleanup.

After persistent notification rows are appended, the same JobCard transaction
inserts deliveries by selecting active subscriptions for those exact recipients
whose users and auth sessions are still active. No network I/O occurs. Push
disabled mode does not insert deliveries.

Mark-read cancels an unclaimed pending delivery for that notification/recipient
where practical. The dispatcher also skips notifications already read before
claim. A narrow race in which mark-read happens after claim may still display a
push; this is acceptable and recorded rather than hidden.

## 10. Dispatcher and Delivery Semantics

The current single Fastify process owns a small in-process
`WebPushDispatcher`; no second service or broker is introduced. The durable DB
lease keeps the design safe if a future deployment briefly runs two processes.

When enabled, the dispatcher:

1. atomically claims a bounded due batch with `FOR UPDATE SKIP LOCKED` and a
   lease token;
2. commits the claim;
3. sends each push outside a database transaction through a narrow
   `WebPushSender` port;
4. records success, retry, stale endpoint, terminal failure, or expiry in a
   separate short transaction;
5. stops accepting new work and awaits bounded active sends during shutdown.

Initial bounded policy:

- batch size: 20;
- polling interval: 5 seconds;
- send timeout: 10 seconds;
- push-service TTL and delivery expiry: 24 hours;
- retry delays: 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour;
- maximum attempts: 5.

These are code-owned constants for the first VPS pilot, not speculative env
configuration. A later operations finding may justify making them configurable.

Result mapping:

- success marks the delivery delivered and resets subscription failures;
- `404` or `410` disables the stale subscription and abandons all its pending
  deliveries;
- `408`, `429`, `5xx`, network errors, and timeouts schedule bounded retry;
- other `4xx` results are terminal delivery failures without leaking provider
  bodies;
- expired, read, revoked-session, inactive-user, or disabled-subscription work
  is abandoned without sending.

Delivery is at-least-once around the unavoidable crash window between a push
service accepting a request and PostgreSQL recording success. The unique outbox
row prevents normal duplicates; a stable notification tag/topic coalesces the
rare crash retry. The design does not claim impossible exactly-once external
delivery.

The Node implementation may add the narrowly scoped `web-push` package because
VAPID signing and RFC 8291 payload encryption are security-sensitive protocol
work that the current stack does not provide. It must be pinned, audited, kept
behind `WebPushSender`, and never imported by domain policy or route handlers.

## 11. Payload Privacy

Push payload version 1 is exact and intentionally small:

```ts
type PushPayloadV1 = Readonly<{
  version: 1;
  notificationId: string;
  title: string;
  body: string;
  url: string;
}>;
```

- `title` and `body` reuse the existing generic notification presenter text.
- `url` is derived server-side as `/jobs/<UUID>` from the persisted entity.
- No organization/user ID, JobCard title/status snapshot, customer/contact,
  note, delivery, actor, location, endpoint, or key is included.
- The first release always uses generic lock-screen-safe text; it does not add
  a detailed-content preference.
- Web Push encrypts message contents, but the external push service can still
  observe endpoint, timing, frequency, and approximate message size. This
  metadata exposure is documented in production operations/privacy review.

`notificationId` without hyphens supplies the 32-character push topic; the
service worker uses the notification ID as its visible notification tag. This
coalesces retries without coalescing different notification records.

Logs contain only safe delivery ID, normalized result code, attempt number, and
aggregate counts. Provider response bodies, headers, endpoints, encryption
keys, payload body, deep-link entity ID, and VAPID secrets are never logged.

## 12. Service Worker Contract

The worker is served at the fixed same-origin root path
`/service-worker.js`, registered with scope `/` and `updateViaCache: 'none'`.
The registration URL is a code constant, never server/user input.

The worker has only:

- install/activate lifecycle needed to replace the previous version cleanly;
- a `push` listener that always calls `showNotification`;
- a `notificationclick` listener that closes, focuses/navigates an existing
  same-origin window, or opens one.

There is no `fetch`, sync, periodic-sync, geolocation, cache-storage, IndexedDB,
business API, or mutation handler.

The worker strictly validates payload version and deep link. The only accepted
version-1 target is `/jobs/<UUID>` with no origin override, credentials,
backslashes, encoded slash, query, or hash. Invalid/missing data still produces
a generic visible Servora-Med notification linked to `/jobs`; it never becomes
silent background work.

On click:

1. close the notification;
2. prefer an already-open exact same-origin target client;
3. otherwise navigate and focus an existing same-origin Servora client;
4. otherwise call `clients.openWindow` with the allowed relative URL.

If the user is logged out, the current URL remains the safe target while the
existing login surface is shown. After successful login, normal client routing
loads that route; no arbitrary `next` URL or cross-origin redirect is added.
Destination REST authorization remains final.

The script is delivered with JavaScript MIME type and `Cache-Control: no-cache`.
Manifest and HTML revalidate. Versioned icons may be immutable. Caddy rules and
operations tests prevent the SPA fallback from returning `index.html` for the
worker. Because the worker owns no caches, activation has no cache migration or
deletion step.

## 13. Web Composition and Accessibility

```text
NotificationCenter dialog
  -> notifications list (existing)
  -> Kurulum ve cihaz bildirimleri subview
     -> install controller
     -> server Web Push status
     -> browser permission/subscription adapter
```

The root install-opportunity controller owns only the retained install event and
installed/standalone state. The identity-scoped push controller owns server
capability, browser permission, subscription pending/error, and canonical
subscription status. UI components do not access raw Push, Notification, or
service-worker APIs.

- Desktop and mobile show the same content and actions.
- Status is not communicated by color alone.
- Pending actions have accessible names and synchronous double-submit gates.
- Errors remain in the settings view with explicit retry.
- Returning to the notification list restores focus.
- Logout, organization/user/session identity change, and component unmount
  clear capability, subscription ID, pending action, and errors. Install-event
  state is not recipient data and is cleared only after use, `appinstalled`, or
  install-controller unmount.
- Long instructions and errors reflow at 320 CSS px / 400% without horizontal
  scrolling.

## 14. Security and Authorization

- All subscription APIs require the existing authenticated,
  password-change-complete session.
- Every query predicates organization, recipient, and current session.
- Subscription UUIDs outside that scope return `404`.
- The endpoint host allowlist prevents the server from becoming an SSRF client.
- Endpoint and key inputs have strict size/shape limits and complete log
  redaction.
- The existing production Origin check protects mutating subscription routes.
- VAPID private material stays in the root-owned environment file.
- Push permission does not grant JobCard authorization.
- A lock-screen message is assumed observable by anyone holding the device, so
  only the generic semantic copy is allowed.
- CORS remains one exact origin; service worker, manifest, API, and application
  share that origin and HTTPS deployment.

## 15. Operations and Observability

The dispatcher runs inside the existing Fastify process and PostgreSQL pool.
Systemd/launchd do not gain another unit. Graceful shutdown closes the
dispatcher before the DB pool within the existing 25–30 second stop window.

Safe operational signals include:

- due/claimed/delivered/retried/abandoned counts;
- normalized provider status class;
- active disabled-subscription count;
- oldest due delivery age.

No subscription or payload material appears in logs or health responses. Push
provider availability does not make core API readiness fail after startup; it
is an optional delivery channel. Invalid enabled configuration does fail
startup.

Production operations must:

- generate one VAPID key pair once and keep the private key outside Git;
- use an approved `mailto:` or public HTTPS contact subject;
- permit outbound HTTPS to the approved push-service hosts, including Apple
  push subdomains for Safari;
- include both new tables in backup/restore and migration rehearsal;
- monitor sustained retry/expiry rates;
- document key rotation, which invalidates/requires renewal of subscriptions.

## 16. Failure and Recovery

| Condition | Required behavior |
| --- | --- |
| Push disabled | No prompt, subscription write, outbox row, worker registration, or provider call |
| Unsupported browser | Normal online app; install guidance where applicable |
| Permission `default` | Prompt only after explicit click |
| Permission `denied` | No repeated prompt; settings guidance |
| Browser subscribed, server save fails | Keep local subscription; explicit retry reuses it |
| Logout/password change/session expiry | Server delivery stops via session join |
| Provider `404/410` | Disable subscription; abandon queued work |
| Provider `429/5xx` or network timeout | Bounded exponential retry |
| Notification already read before claim | Abandon pending delivery |
| Dispatcher/process restart | Expired leases become claimable; no outbox loss |
| Malformed push payload in worker | Show generic notification; safe `/jobs` target |
| Unauthorized/deleted deep-link target | Existing destination REST error/authorization behavior |

## 17. Test Contract

Server tests must prove:

- absent/false/invalid/true config and fail-closed VAPID validation;
- PostgreSQL tenant/session FKs, endpoint uniqueness, active-session uniqueness,
  exact checks, and indexes on a real test database;
- endpoint allowlist/SSRF rejection and input length/Base64 validation;
- authenticated status, idempotent create, scoped delete, cross-user/tenant
  `404`, and disabled-mode no-write behavior;
- logout, password change, expired session, inactive user, and account switch
  cannot receive delivery;
- committed notification creates one delivery per active subscription in the
  same transaction; rollback/replay creates none or no duplicate;
- already-read notifications are skipped;
- lease claim/reclaim, retry schedule, expiry, and normal duplicate prevention;
- `404/410` stale cleanup and safe handling of retryable/terminal results;
- payload exactness/privacy and no endpoint/key/payload/VAPID material in logs;
- dispatcher shutdown and disabled mode make no sender call.

Web tests must prove:

- manifest fields, icon dimensions/paths, HTML links, and service-worker HTTP
  asset path expectations;
- `beforeinstallprompt`, accepted/dismissed outcome, `appinstalled`, standalone,
  and manual guidance states;
- no permission prompt on login/load/open; one explicit click prompts once;
- default/granted/denied/unsupported permission behavior;
- exact `userVisibleOnly` and VAPID public-key subscription options;
- duplicate click gate, save failure retry, disable ordering, and identity
  cleanup;
- service-worker registration fixed path/scope/update policy;
- push event always shows a notification; exact and malformed payload behavior;
- click allowlist, existing-client focus/navigation, new-window behavior, and
  rejection of cross-origin or malformed URLs;
- worker contains no `fetch` handler or business caching;
- responsive, keyboard, focus, loading, error, and 400% reflow parity.

Operations checks must prove Caddy serves the manifest, icons, and worker with
the intended route, MIME, and caching behavior and never serves SPA HTML for
the worker.

Manual acceptance covers:

- Chrome desktop and Android: install, allow, deny, foreground/background
  delivery, duplicate/retry behavior, click navigation, logout, and stale
  endpoint cleanup;
- Safari macOS: Add to Dock/install, allow/deny, closed-browser delivery, and
  click navigation;
- real iOS/iPadOS Home Screen app: install, explicit permission, background
  delivery, Focus interaction awareness, click navigation, logout/account
  switch, and unsupported non-installed-browser guidance.

## 18. Acceptance Criteria

1. Manifest and icons make Servora-Med installable without adding offline
   business behavior.
2. No browser install or notification permission prompt appears without an
   explicit user action.
3. Push disabled mode causes no subscription, outbox, worker-registration, or
   provider side effect.
4. One committed persistent notification creates at most one outbox row per
   active recipient subscription and no unrelated recipient work.
5. External delivery occurs only after commit and never inside a JobCard
   transaction.
6. Subscription reads/writes are tenant-, recipient-, and current-session
   scoped; logout/session revocation stops delivery.
7. Push payload and lock-screen text contain no sensitive business details.
8. Stale endpoints, retries, process restarts, and rare at-least-once duplicate
   windows are bounded and observable.
9. Notification clicks accept only safe relative JobCard links and preserve
   destination REST authorization.
10. The service worker has no `fetch` handler, business cache, offline queue,
    mutation, or geolocation behavior.
11. Existing notification center, SSE, lifecycle, idempotency, bundle,
    responsive, backup, and security contracts remain green.
12. Real Chrome and Safari/iOS acceptance passes before production enablement.

## 19. Alternatives Rejected

### Send push inside the JobCard transaction

Rejected because provider latency/failure would lengthen or roll back the
canonical business transaction and could expose uncommitted state.

### Best-effort send immediately after commit without an outbox

Rejected because a process crash would permanently lose the delivery and there
would be no bounded retry or stale-endpoint lifecycle.

### External queue/broker first

Rejected for the current single-process VPS modular monolith. PostgreSQL lease
rows provide the required durability without Redis/Kafka/another service.

### Firebase-specific client SDK

Rejected because standards-based Push API, Service Workers, VAPID, and a narrow
server sender support the Chrome/Safari pilot without making Firebase another
application platform.

### Broad PWA/offline plugin

Rejected because it would add cache ownership and offline semantics that this
online business application has not designed.

## 20. Official References

- [MDN — Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN — Trigger installation from your PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt)
- [MDN — PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)
- [MDN — ServiceWorkerContainer.register](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)
- [MDN — notificationclick event](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event)
- [W3C — Push API](https://www.w3.org/TR/push-api/)
- [WebKit — Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)
- [WebKit — Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [`web-push` Node library](https://github.com/web-push-libs/web-push)
