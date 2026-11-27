# Messaging module — every runtime gate of the messaging capability

Research output. Branch `claude/messaging-module-registry-2ef670`, base SHA
`fca614b` (verified with `git rev-parse HEAD`). Read-only investigation: no source,
test, migration or other doc was modified.

Documents read for authority: `AGENTS.md` (§2, §3, §6, §7, §9, §15),
`DECISIONS.md` MOD-001 (1991-2070), SCH-001 (3671-3733), MOD-002 (3735-3788),
`docs/features/operator-module-pilot.md` (whole file, contract still marked **draft**
at line 3 while MOD-002 is **Accepted**), and
`docs/backlog/2026-11-25-core-modules-architecture-research.md` (V4/V5/V6/V7,
§4 items 4-6, §5 step 2).

## Summary

1. The messaging flag is read **exactly once per process**, in `loadConfig()`
   (`server/src/config.ts:910`). Every other server location consumes that captured
   boolean; there is **no per-request read anywhere**. Server code touching it:
   `server/src/app.ts:362,374,521,526` and
   `server/src/modules/overview/service.ts:33,71,84` (plus the constructor capture in
   `server/src/modules/messaging/service.ts:118`).
2. Two different "off" behaviours exist today and they are **not** the Overview
   contract: the 11 routes are simply **not registered** (Fastify default 404, route
   name leaked, body outside the app error contract), and the service carries a
   redundant second gate that returns `404 NOT_FOUND` `Sayfa bulunamadı.` if it is
   ever reached while off.
3. Everything that would look "runtime switchable" today is **not**: routes not
   registered, `MessagingService.enabled` and `OverviewService.messagingEnabled`
   captured at construction, and the Overview unread read-port
   (`PostgresMessagingRepository`) built only when the startup flag is true.
4. Four surfaces are **completely ungated** and would keep emitting messaging
   traffic after a runtime disable: realtime SSE replay
   (`server/src/modules/realtime/service.ts:131-153`), the notifications list,
   the web-push outbox claim (`server/src/modules/web-push/dispatcher.ts`), and the
   static service-worker deep-link allow-list (`web/public/service-worker.js:3`).
5. The client side is already capability-driven and needs **no new switch** for
   navigation or routing; what is missing is a *trigger*: a forced
   `/api/auth/me` revalidation on a messaging `404`, which today exists only for
   Overview (`web/src/overview/OverviewPage.tsx:108` ←
   `web/src/App.tsx:235`).
6. Adding `MESSAGING` to the registry forces a **new migration** (074's CHECK is
   `IN ('OVERVIEW')`, `074_installation_operator_and_module_state.sql:59,87`), and
   **18 server test files** hard-code `074_installation_operator_and_module_state`
   as the migration head. Migration-number contention with the sibling Warehouse
   "W0" proposal is a real coordination risk, not a theoretical one.
7. One design trap the Overview precedent does not cover: the messaging gate runs
   **before** idempotency resolution (`service.ts:550` vs the `clientActionId`
   replay inside the transaction), so a retried send after a disable answers `404`
   instead of the stored result — an AGENTS.md §7 concern.

---

## 1. Findings

### F1 — Single startup read of `MESSAGING_ENABLED`

`server/src/config.ts:910` (`messaging: readBoolean(env.MESSAGING_ENABLED,
'MESSAGING_ENABLED')`) is the only env read. `readBoolean` (`config.ts:318-323`)
accepts only unset/`false`/`true` and throws otherwise. `loadConfig()` runs once in
`server/src/index.ts:91`. `AppConfig.capabilities?: AuthenticatedCapabilities`
(`config.ts:190`) is therefore a process-lifetime snapshot. The backup worker has
its own `loadConfig()` (`server/src/backup-worker.ts:21`) but reads no messaging key.

### F2 — Two independent gates, both startup-fixed

* Route registration: `server/src/app.ts:521-531`. If false, `messagingRoutes` is
  never added, so `/api/messaging/*` falls through to Fastify's default 404.
  Verified shape for fastify 5.12.8 (the version pinned at `server/package.json:42`):
  `{"message":"Route GET:/api/messaging/conversations not found","error":"Not Found","statusCode":404}`
  — a different body than the app contract `{error, code}` from
  `server/src/errors/index.ts:21-27`, and it names the unregistered route.
  No `setNotFoundHandler` exists in `server/src` (grep, 0 hits).
* Service construction: `app.ts:524-528` passes `config.capabilities?.messaging ?? false`
  into `new MessagingService(pool, enabled, realtimePublisher)`
  (`service.ts:116-122`), stored as `private readonly enabled`
  (`service.ts:118`) and enforced by `requireEnabled()` (`service.ts:1086-1088`).

Because the routes are absent when off, the `requireEnabled()` gate is currently
**unreachable through HTTP**; it only matters for direct service construction
(unit tests, and any future always-registered route). `server/tests/messaging-service.test.ts:64-77`
tests exactly that path.

### F3 — 11 per-method gates, all synchronous, all thin

`requireEnabled()` is called at `service.ts:130,149,197,550,732,737,747,784,965,1072,1080`
— one per public method and one per endpoint in `messaging/routes.ts:17-27`:

| service method | line | route (`routes.ts`) |
| --- | --- | --- |
| `getConversations` | 130 | `GET /conversations` (17) |
| `getJobConversation` | 149 | `GET /conversations/job/:jobId` (20) |
| `createOrGetConversation` | 197 | `POST /conversations` (19) |
| `sendMessage` | 550 | `POST /conversations/:id/messages` (22) |
| `archiveConversation` | 732 | `POST .../archive` (23) |
| `unarchiveConversation` | 737 | `POST .../unarchive` (24) |
| `getMessages` | 747 | `GET .../messages` (21) |
| `syncJobAssignee` | 784 | `POST .../job-assignee-sync` (27) |
| `markRead` | 965 | `PATCH .../read` (25) |
| `getUnreadCount` | 1072 | `GET /unread-count` (26) |
| `getRecipients` | 1080 | `GET /recipients` (18) |

`policy.ts` has **no** flag dependency (pure authorization rules,
`messaging/policy.ts:41-73`); `repository.ts` has none (grep for `enabled` in
`messaging/repository.ts`: 0 hits); `types.ts` has none apart from the read-port
interface (`types.ts:146-148`). There is **no** messaging worker, claim loop or tick
(grep `worker|tick|claim` in `server/src/modules/messaging/`: 0 hits; no messaging
entry in `server/src/index.ts`).

### F4 — The gate precedes idempotency resolution (new risk vs Overview)

For `sendMessage`, `requireEnabled()` at `service.ts:550` runs before the
transaction that resolves `clientActionId` (`appendMessage` path at
`service.ts:607`). Same ordering for `syncJobAssignee` (`:784` then `:812`) and
`createOrGetConversation` (`:197` before the deterministic `conv:` action id at
`:473`). A client retry of an already-committed mutation while the module is off
gets `404`, not the stored response. The Overview contract only allows GETs, so it
has no equivalent case. AGENTS.md §7 ("Duplicate requests must either return the
original result or a clear in-progress/conflict response") applies.

### F5 — Overview's optional messaging fields are constructor-captured

`app.ts:362-364` builds `messagingReadPort` **only** when
`dependencies.pool && config.capabilities?.messaging`; `app.ts:366-378` passes it
plus `config.capabilities?.messaging ?? false` into `OverviewService`.
`OverviewService` stores both as constructor parameters
(`overview/service.ts:33-34`), then:

* `overview/service.ts:71` — `if (this.messagingEnabled && this.messagingRead)`;
* `overview/service.ts:84` — spreads `messageUnreadSummary` only when
  `this.messagingEnabled`.

So the Overview payload is frozen at startup in **both** directions: turning
messaging on cannot start the summary, and turning it off cannot stop it. Note the
port is a bare `PostgresMessagingRepository` (`app.ts:363`), i.e. it bypasses
`MessagingService.requireEnabled()` entirely — acceptable today only because it is
never constructed when off.

### F6 — Capability projection only rewrites Overview

`server/src/modules/auth/handlers.ts:31-34` builds
`withOverviewDashboard(capabilities, await readModuleEnabledOrFalse(moduleState, 'OVERVIEW', request.log))`
and uses it per request at `:43` (`POST /api/auth/login`) and `:46`
(`GET /api/auth/me`). `withOverviewDashboard`
(`server/src/modules/capabilities/service.ts:24-29`) overrides **only**
`overviewDashboard`; `messaging` keeps the env value from
`options.config.capabilities` (`server/src/modules/auth/routes.ts:47`).
`DEFAULT_CAPABILITIES.messaging = false` (`capabilities/service.ts:10`).
`authenticatedUser()` (`capabilities/service.ts:31-47`) additionally gate-ANDs
`duplicateCustomerComparison` and `demoDatasetCreation` by role but leaves
`messaging` untouched.

### F7 — Realtime / SSE replay is audience-based, not module-based

`server/src/modules/realtime/service.ts:131-153` sends
`repository.replayVisible(viewer, lastSent, …)`; visibility comes from
`canViewRealtimeEvent` (audience), never from module state. Persisted
`realtime_events` carry `messaging_activity_id` (`realtime/repository.ts:15,35,125-147`,
`realtime/types.ts:46,56-59`). Consequence: an SSE client reconnecting after a
disable still replays historical `conversation.*` events. Live events stop (the
service gate prevents new ones) but replay does not discriminate.

### F8 — Notifications list and web-push outbox are ungated

* `notificationRoutes` are registered unconditionally when a repository exists
  (`app.ts:474-485`); no module-state read exists in
  `server/src/modules/notifications/*` (grep `capabilit|moduleState`: 0 hits).
  `message.received` / `conversation` are first-class notification vocabulary
  (`notifications/types.ts:32,40`), created by messaging inside its own
  transaction (`messaging/service.ts:684-706`).
* Web push: the dispatcher is registered on `config.webPush.enabled` only
  (`app.ts:486-520`); `claimDueDeliveries` has no module filter
  (`web-push/dispatcher.ts:281`); `buildPushPayload` maps `conversation` →
  `/messages?conversation=<id>` (`web-push/payload.ts:23-25,42`).

So after a runtime disable, previously queued conversation pushes are still
delivered, and the notification centre still lists conversation notifications
whose click target is now a redirect to `/jobs`.

### F9 — Offboarding and demo-data are correctly module-independent (keep it)

* Offboarding writes `conversation_participants` and
  `messaging_activity_logs` and inserts a realtime event with resource keys
  `ARRAY['messaging','conversation:<id>']` **with raw SQL**, not through
  `MessagingService` (`people/offboarding.ts:1011-1042`; conversation discovery at
  `:1135-1140` restricted to `context_type = 'JOB'`). It therefore already works
  while messaging is off — required by AGENTS.md §15 / research §4 item 4
  ("Offboarding must work while the module is off").
* Staff-delete blockers already count messaging rows
  (`people/repository.ts:222-236`: messages, participants, user states,
  messaging activity logs).
* Demo-data analyse/purge locks and deletes `conversations`, `messages`,
  `conversation_participants`, `conversation_user_states`,
  `messaging_activity_logs` (`demo-data/repository.ts:429-451,643-653`;
  `demo-data/types.ts:47-48,93-96`). No capability check anywhere in `demo-data`
  (grep `capabilit|enabled|messaging` in `demo-data/service.ts`: 0 hits).

### F10 — Restore: messaging tables are not a restore precondition

`CORE_RELATIONS` (`server/src/modules/backup/restore/postgres.ts:11-25`) lists 13
relations; **none** are messaging tables. `recovery-preflight.ts:24-26` only checks
`users` and `job_cards` (`RECOVERY_RELATION_MISSING`). Backups are full `pg_dump`, so
messaging data comes back if present, but nothing asserts it. If `MESSAGING` becomes
a registry key, `installation_module_state` and `operator_audit_events` are restored
to the **backup instant** (MOD-002 §9 / contract §9, `operator-module-pilot.md:186-189`),
i.e. a post-restore toggle is undone and, for a pre-075 backup, takeover re-runs on
first start (same rule already documented for 074 at `operator-module-pilot.md:190-192`).

### F11 — Health exposes nothing (keep as-is)

`server/src/modules/health/routes.ts` registers `/` and `/backup` only; the option
type carries readiness, release SHA, backup readiness. No module state, no operator.
Consistent with MOD-002 §3 (`DECISIONS.md:3765-3769`) and the contract's
"Nothing about operators is exposed by customer APIs or `/api/health`"
(`operator-module-pilot.md:81`).

### F12 — Registry, takeover and DB constraint are all `OVERVIEW`-shaped

* `registry.ts:7-15` — descriptor type pins `key: 'OVERVIEW'` and
  `capability: 'overviewDashboard'`; the array (17-24) has one entry.
* `takeover.ts:26-28` — `legacy: { overviewDashboard: boolean }`; the loop at
  `:30-57` indexes `legacy[module.capability]`, so a second descriptor needs the
  widened type or it will not type-check.
* `index.ts:324-327` — the only production call site, passes
  `{ overviewDashboard: config.capabilities?.overviewDashboard ?? false }`.
* `074_installation_operator_and_module_state.sql:59` —
  `CHECK (module_key IN ('OVERVIEW'))`; `:87` —
  `CHECK (module_key IS NULL OR module_key IN ('OVERVIEW'))` on
  `operator_audit_events`. Both must widen.
* Operator API is already generic: `operator/service.ts:127-133` lists
  `INSTALLATION_MODULES`, `:135-161` updates by key; the web panel is generic over
  `InstallationModule[]` (`web/src/operator/OperatorModulesPage.tsx:81-109,185-193`).

### F13 — The registry's own acceptance tests treat `MESSAGING` as an unknown key

`server/tests/operator-pilot-postgres.test.ts:1119-1130` runs
`it.each(['MESSAGING','NOPE','OVERVIEW2'])` and asserts `404 NOT_FOUND`, one state
row, zero new audit events; `:1132-1137` asserts the DB rejects
`INSERT … ('MESSAGING', …)` with SQLSTATE `23514`. Both must be rewritten when
MESSAGING joins the registry — this is the single clearest "add a module" checklist
item that exists today.

### F14 — Blast radius of the new migration is large

`grep -rln "074_installation_operator_and_module_state" server/tests` → **18 files**;
`grep -rln "toBe('074_installation_operator_and_module_state')"` → **18 files**
(evidence `04-head-074-assertions.txt`, 59 lines). Also
`server/tests/foundation-1-migration-backfill-postgres.test.ts:115`,
`job-card-lifecycle-intents-postgres.test.ts:45` ("head is 074 with 74 migrations")
and the two ops env examples (head is derived dynamically,
`ops/ci/verify-env-examples.sh:25-30`, so those are safe). A 075 that only widens a
CHECK still moves the head for all of them.

### F15 — CI enforces the staging env value

`ops/ci/verify-env-examples.sh:59` reads `MESSAGING_ENABLED` from
`ops/examples/servora-med-staging.env.example` and `:68-71` **fails the build** unless
it is exactly `MESSAGING_ENABLED=true`. `ops/examples/servora-med.env.example`
(production) has **no** `MESSAGING_ENABLED` line at all (only
`CALENDAR_ENABLED=false` at `:155`), so takeover there resolves to `false`.
`server/.env.example:29-32` already carries the MOD-002 legacy note, but only for
`OVERVIEW_DASHBOARD_ENABLED`; `MESSAGING_ENABLED=false` sits on line 32 with no note.

### F16 — Web: capability-driven everywhere, one missing trigger

Read path: `GET /api/auth/me` → `parseCurrentUser`
(`web/src/services/api.ts:151-190`, `messaging` at `:186`) → `CurrentUser.capabilities`
(`api.ts:22`). Consumers:

* `web/src/shell/navigation-model.ts:92` — sidebar/menu item;
* `web/src/shell/route-access.ts:39-40` — `canAccessRoute('messages')`;
* `web/src/AppRouter.tsx:396` + `:407-408` — route element or `<Navigate to={paths.jobs}>`;
* `web/src/JobDetail.tsx:3764` (action) + `:3773` (`messagingActionVisible`);
  `web/src/jobs/JobConversationAction.tsx:91` — returns `null` when off;
* `web/src/paths.ts:6` — `/messages`.

Refresh path: `useIdentityRevalidation` (`web/src/identity-revalidation.ts:32-80`;
30 s throttle at `:6`; focus/`visibilitychange` at `:65-68`; single flight `:52-63`)
wired at `web/src/App.tsx:224-235`. **The only forced call** is
`onOverviewUnavailable={revalidateIdentity}` (`App.tsx:235`) triggered by an
Overview `404` (`web/src/overview/OverviewPage.tsx:108`). There is no equivalent for
messaging, so an open `/messages` tab keeps its stale capability until the next
focus/visibility event.

### F17 — The messaging page misreads "module off" as "membership revoked"

`web/src/messaging/MessagingPage.tsx:349-357`: on `403` **or** `404` when loading a
thread it clears the selection, empties messages and says nothing
("membership was revoked (e.g. removed from the conversation)"). If `/api/messaging`
starts answering a module-level `404`/`503` per request, an open thread will look
like a silent removal instead of "module turned off". Needs an explicit branch.

### F18 — Reassignment participant sync is client-driven and fails silently

No server-side job-cards → messaging coupling exists (grep `messaging|conversation`
in `server/src/modules/job-cards/*.ts`: 0 hits). The sync is offered by
`web/src/jobs/useReassignmentConversationSync.ts:43-53`, which swallows every error
from `getJobConversation` and simply returns without an offer; callers are
`web/src/JobDetail.tsx:1591` and `web/src/calendar/CalendarPage.tsx:712`.
`syncJobAssignee` itself is gated (`service.ts:784`). Research §5 step 2 asks for
exactly this verification ("participant access and reassignment behaviour; add a
job-cards read port if needed") before messaging reaches the panel.
SCH-001's principle — "turning a module off must not weaken a core workflow rule"
(`DECISIONS.md:3689-3690`) — is the test this feature must pass or be explicitly
exempted from.

### F19 — Overview's unread link is not capability-gated

`web/src/overview/OverviewPage.tsx:145` reads `overview.messageUnreadSummary?.unreadTotal`;
`:362-368` renders `<Link to={paths.messages}>` when `> 0`. The link is gated only by
the server having sent the field. Combined with F5 (frozen `messagingEnabled`), a
runtime disable would keep advertising a dead link. SCH-001 §6
(`DECISIONS.md:3714-3716`) sets the precedent that Overview module fields follow the
module, not a separate rule — so this is resolved by making the server field
per-request, not by adding a client check.

### F20 — Service-worker deep link allow-list is build-time static

`web/public/service-worker.js:3` defines
`MESSAGING_DEEP_LINK = /^\/messages\?conversation=<uuid>$/i`, `:9` admits it in
`isAllowedDeepLink`, `:85-117` focuses/navigates/openWindow on it. It cannot see
capabilities. After a disable, a push click still navigates to `/messages?...`, and
the router guard (`AppRouter.tsx:407-408`) sends the user to `/jobs` — a working but
confusing outcome. Same for `web/src/notifications/NotificationCenter.tsx:225-229`.

### F21 — Realtime client subscriptions are harmless when off

`web/src/realtime/RealtimeProvider.tsx:258-267` (`useRealtimeInvalidation`) and the
two messaging subscriptions (`web/src/messaging/MessagingPage.tsx:312`,
`web/src/jobs/JobConversationAction.tsx:79`) only react to server events; no
capability check is needed and none should be added. `web/src/web-push/*`
`capability` is browser capability, not the module flag (no relation).

### F22 — Test and harness inventory (what a slice must touch)

| Location | What it pins |
| --- | --- |
| `server/tests/messaging-service.test.ts:64-77` | constructor flag → `404` |
| `server/tests/operator-pilot-postgres.test.ts:1119-1137` | `MESSAGING` is an unknown key + DB CHECK `23514` |
| 18 files (`04-head-074-assertions.txt`) | migration head == `074_…` |
| `server/tests/overview-r2-postgres.test.ts:23-34` | messaging migrations applied as fixtures (unchanged by a 075 CHECK widening) |
| `server/tests/config.test.ts:55-64` | default `capabilities.messaging === false` |
| `server/tests/capabilities.test.ts:29,41-42`, `auth-routes.test.ts:55`, `auth-login-constant-work.test.ts:367`, `operator-pilot-postgres.test.ts:87` | fixtures carry `messaging: false` |
| `web/tests/router.test.tsx:29`, `overview-module-switch.test.tsx:32` | fixtures; **no test asserts `/messages` redirects when messaging=false** |
| `web/tests/overview-page.test.tsx:218-225` | unread section + `href="/messages"` |
| `web/tests/service-worker-click.test.ts:143-196` | `/messages?conversation=` deep-link admission |
| `web/scripts/r3b-…:78`, `r4b-…:75`, `jobcard-idempotency-…:102` | real-server harnesses set `MESSAGING_ENABLED=true` |

---

## 2. Gate table

Read timing legend: **startup** = module load / `loadConfig` once; **construction**
= `buildApp` wiring; **per request** = each HTTP call; **build** = asset/CI build.
"Needs change" = does a runtime (operator) switch require touching this site, not
whether the file must be edited for unrelated reasons.

| # | file:line | what reads it | read at | effect when false | needs change for runtime switch |
| --- | --- | --- | --- | --- | --- |
| S1 | `server/src/config.ts:910` | `capabilities.messaging = readBoolean(MESSAGING_ENABLED)` | startup (`index.ts:91`) | process-lifetime `false` | yes — becomes legacy takeover input only |
| S2 | `server/src/modules/capabilities/types.ts:5` | type `messaging: boolean` | build | n/a | yes — add runtime projection to the type story |
| S3 | `server/src/modules/capabilities/service.ts:10` | `DEFAULT_CAPABILITIES.messaging=false` | construction | fallback only | yes — must be overridden by the reader |
| S4 | `server/src/modules/capabilities/service.ts:24-29` | `withOverviewDashboard` overrides **only** `overviewDashboard` | per request | `messaging` stays env value | yes — generalize to N modules |
| S5 | `server/src/modules/auth/handlers.ts:31-34,43,46` | `/login` + `/me` capability assembly | per request | clients see `messaging:false` | yes — add `readModuleEnabledOrFalse(…,'MESSAGING')` |
| S6 | `server/src/modules/auth/routes.ts:47` | passes `config.capabilities` + reader into handlers | construction | n/a | no — plumbing already present |
| S7 | `server/src/app.ts:362-364` | `messagingReadPort` built only if `pool && messaging` | construction | Overview gets no unread port | **yes** — build port whenever `pool` exists |
| S8 | `server/src/app.ts:366-378` | `OverviewService(..., calendar, messaging, port)` | construction | summary never appears | **yes** — stop passing flags |
| S9 | `server/src/modules/overview/service.ts:33,71,84` | `messagingEnabled` ctor flag guards field + call | construction | frozen either way | **yes** — per-request `read('MESSAGING')` |
| S10 | `server/src/app.ts:521-531` | route registration + `new MessagingService(pool, messaging ?? false, …)` | startup | `/api/messaging/*` unregistered → Fastify default 404 | **yes** — always register (Overview pattern) |
| S11 | `server/src/modules/messaging/service.ts:118` | `private readonly enabled` | construction | gate always closed | **yes** — replace with reader |
| S12 | `server/src/modules/messaging/service.ts:1086-1088` | `requireEnabled()` | per call | `404 NOT_FOUND` `Sayfa bulunamadı.` (`:42-44`) | **yes** — async read, 503 on read failure |
| S13 | `service.ts:130,149,197,550,732,737,747,784,965,1072,1080` | 11 call sites | per request | 404 | no — all already in `async` methods |
| S14 | `server/src/modules/messaging/routes.ts:11-28` | 11 endpoints, no gate | construction | n/a | no — keep gate in service |
| S15 | `server/src/modules/messaging/types.ts:146-148` | `MessagingReadPort` | build | n/a | no |
| S16 | `server/src/modules/installation-modules/registry.ts:7-15,17-24` | descriptor union + entries | build | MESSAGING not toggleable | **yes** — add entry, widen `key`/`capability` |
| S17 | `server/src/modules/installation-modules/takeover.ts:26-28,30` | `legacy: {overviewDashboard}` indexed by `capability` | startup | no MESSAGING row | **yes** — widen legacy type |
| S18 | `server/src/index.ts:324-327` | takeover call | startup | no takeover for MESSAGING | **yes** — pass `messaging` |
| S19 | `server/src/db/migrations/074_…sql:59,87` | `CHECK module_key IN ('OVERVIEW')` | DB | insert → `23514` | **yes** — new migration (never edit 074) |
| S20 | `server/src/modules/operator/service.ts:127-133,135-161` | generic list/update by key | per request | n/a | no — already generic |
| S21 | `server/src/modules/realtime/service.ts:131-153`; `realtime/repository.ts:125-147` | SSE replay by audience | per connection/event | historical `conversation.*` still replay | decision — cross-module (§4 item 4) |
| S22 | `server/src/modules/notifications/types.ts:32,40` (+ module, no gate) | notification vocabulary + list | per request | conversation notifications still listed | decision — visibility rule |
| S23 | `server/src/modules/web-push/payload.ts:23-25,42` | `conversation` → `/messages?conversation=` | worker tick | link to disabled page | decision |
| S24 | `server/src/modules/web-push/dispatcher.ts:281` | `claimDueDeliveries`, no module filter | worker tick | queued pushes still sent | decision |
| S25 | `server/src/modules/people/offboarding.ts:1011-1042,1135-1140` | raw-SQL participant transfer + activity + realtime | per command | **still works (required)** | no — must stay module-independent |
| S26 | `server/src/modules/people/repository.ts:222-236` | delete blockers include messaging rows | per request | unchanged | no |
| S27 | `server/src/modules/demo-data/repository.ts:429-451,643-653`; `types.ts:47-48,93-96` | lock/delete conversations | per admin command | unchanged | no |
| S28 | `server/src/modules/backup/restore/postgres.ts:11-25`; `db/recovery-preflight.ts:24-26` | `CORE_RELATIONS` / relation check | per restore | no messaging precondition | no — but note state rolls back to backup instant |
| S29 | `server/src/modules/health/routes.ts` (whole file) | readiness + release SHA | per request | nothing exposed | no |
| S30 | `server/src/modules/calendar/reminder-worker.ts:222`; `staff-confidential-notes/repository.ts:89` | `messagingActivityId: null` (column, not the flag) | construction | unrelated | no |
| W1 | `web/src/services/api.ts:22,186` | `capabilities.messaging` parsed from `/me` | per response | nav/route hidden | no — already dynamic |
| W2 | `web/src/identity-revalidation.ts:6,32-80` | refresh on focus/visibility, 30 s | per event | only path a switch reaches a tab | no (needs a *caller*, see W3) |
| W3 | `web/src/App.tsx:224-235`; `AppRouter.tsx:392-408` | forced revalidate wired only to Overview 404 | per render | stale capability until focus | **yes** — add messaging 404 trigger |
| W4 | `web/src/shell/navigation-model.ts:92` | sidebar/menu item | per render | item absent | no |
| W5 | `web/src/shell/route-access.ts:39-40` | route access rule | per render | `false` | no |
| W6 | `web/src/AppRouter.tsx:396,407-408,203` | route element / lazy import | per render | `<Navigate to={paths.jobs}>` | no |
| W7 | `web/src/JobDetail.tsx:3764,3773`; `jobs/JobConversationAction.tsx:91` | job-detail action | per render | action hidden | no |
| W8 | `web/src/jobs/useReassignmentConversationSync.ts:43-53` (callers `JobDetail.tsx:1591`, `calendar/CalendarPage.tsx:712`) | silent sync offer | per reassignment | offer silently skipped | decision — see F18 |
| W9 | `web/src/overview/OverviewPage.tsx:145,362-368` | unread link from server payload | per render | dead link while server still sends it | yes — server-side (F19) |
| W10 | `web/src/notifications/NotificationCenter.tsx:225-229` | click target `/messages?conversation=` | per click | lands on `/jobs` redirect | decision (copy/UX) |
| W11 | `web/public/service-worker.js:3,9,85-117` | static deep-link allow-list | build | navigates, then redirects | decision |
| W12 | `web/src/messaging/MessagingPage.tsx:312`; `realtime/RealtimeProvider.tsx:258-267` | realtime invalidation | per mount | no events while off | no |
| W13 | `web/src/services/messaging-api.ts` (all calls); `MessagingPage.tsx:349-357` | no capability check; 403/404 ⇒ "membership revoked" | per call | wrong UX on module-level 404/503 | **yes** — distinguish module-off |
| W14 | `web/src/operator/OperatorModulesPage.tsx:81-109,185-193` | generic module list/switch | per request | n/a | no |
| O1 | `ops/ci/verify-env-examples.sh:59,68-71` | staging must be `MESSAGING_ENABLED=true` | build/CI | CI fails if the key is removed | **yes** |
| O2 | `ops/examples/servora-med-staging.env.example:86` | `MESSAGING_ENABLED=true` | deploy | takeover source | yes — legacy note / re-point to DB state |
| O3 | `ops/examples/servora-med.env.example` (no MESSAGING line; `:155` `CALENDAR_ENABLED=false`) | production example | deploy | takeover writes `false` | check host value before rollout |
| O4 | `server/.env.example:29-32` | legacy note exists for Overview only | docs | misleading | yes |
| O5 | `web/scripts/r3b-…:78`, `r4b-…:75`, `jobcard-idempotency-…:102` | harness env `MESSAGING_ENABLED=true` | harness | harness still passes env until removed | yes (same slice as O1) |
| T1 | `server/tests/operator-pilot-postgres.test.ts:1119-1137` | `MESSAGING` = unknown key; DB `23514` | test | will fail once registered | **yes** |
| T2 | 18 files, `04-head-074-assertions.txt` | head == 074 | test | fail on any 075 | **yes** |
| T3 | `server/tests/messaging-service.test.ts:64-77` | ctor flag semantics | test | pins old design | **yes** |

---

## 3. The Overview pattern, and what messaging can and cannot copy

### 3.1 How Overview actually reads state per request

1. **One reader, no cache.** `PostgresModuleStateReader.read(key)`
   (`installation-modules/state.ts:52-63`) is a single primary-key `SELECT`;
   interface at `:47-49`; contract "one primary-key read per request, no cache"
   (`:51`, contract §7 `operator-module-pilot.md:152-161`).
2. **Routes are always registered.** `app.ts:366-378` registers `overviewRoutes`
   unconditionally; the gate is inside the service, not around the route
   (contract §7 `:160-161`).
3. **Service-side gate, fail-closed.**
   `OverviewService.assertEnabled` (`overview/service.ts:91-101`):
   read throws → log + `503 MODULE_STATE_UNAVAILABLE`; row missing → `503`;
   `enabled === false` → `404 NOT_FOUND` `Sayfa bulunamadı.` (`:14-24`).
   No env fallback.
4. **Capability projection per request.**
   `readModuleEnabledOrFalse(reader,'OVERVIEW',request.log)`
   (`state.ts:86-102`, missing row or error ⇒ `false` + log) feeding
   `withOverviewDashboard` (`capabilities/service.ts:24-29`) from
   `auth/handlers.ts:31-34`, used at `:43,:46`.
5. **Startup takeover, once.** `index.ts:324-327` after
   `assertStartupSchemaCompatible`, before `listen`
   (`index.ts:322-323` comment + `takeover.ts:3-19`); `INSERT … ON CONFLICT DO
   NOTHING RETURNING` decides the single winner and writes
   `MODULE_STATE_TAKEN_OVER` in the same transaction.
6. **Web picks it up without a restart:** `/api/auth/me` revalidation on
   focus/visibility (`identity-revalidation.ts`), and an Overview `404` forces one
   (`OverviewPage.tsx:108` → `App.tsx:235`).

### 3.2 Messaging gates that can follow it directly

| Gate | How | Effort / risk |
| --- | --- | --- |
| S11/S12/S13 (`MessagingService.enabled` → reader) | inject `ModuleStateReader`, make `requireEnabled()` async and read `'MESSAGING'`; 11 call sites already in `async` methods | low; single helper |
| S5/S4 (auth `/login` + `/me` capability) | extend the projection to `{overviewDashboard, messaging}` with `readModuleEnabledOrFalse` each; failure ⇒ `false` | low |
| S7/S8/S9 (Overview unread summary) | always build the read port when `pool` exists; ask `OverviewService` for `MESSAGING` state per request (or have the port return `null` when off) | low, but the port currently bypasses the service gate (F5) — decide whether the gate lives in `OverviewService` or in a small `MessagingOverviewReader` |
| S10 (route registration) | register `messagingRoutes` unconditionally and let the service answer 404/503 | low mechanically, but changes the public 404 **body** (F2) — that is a contract decision, not a refactor |
| S16/S17/S18/S19 (registry + takeover + CHECK) | add registry entry, widen legacy object, new migration for both CHECKs | mechanical; the cost is T2 (18 test files) |
| W3 (web trigger) | copy the Overview `404 → force revalidation` hook into `MessagingPage`; the route guard already fails closed | low |

### 3.3 Gates that cannot follow it directly

1. **Route registration is itself the gate (S10).** The Overview contract's whole
   point is that routes exist and answer `404`/`503`. Messaging must switch to
   always-registered, which changes today's observable behaviour (Fastify default
   404 → app contract 404/503). It also removes the accidental "route does not
   exist" defence.
2. **Idempotent mutations before the gate (F4).** For a GET-only module the ordering
   is irrelevant; for `sendMessage` / `syncJobAssignee` /
   `createOrGetConversation` the gate must run **after** a completed-action lookup
   (or the completed-action path must be exempt) so a retry still returns the
   original result. This is a design decision, not a copy of `assertEnabled`.
3. **Realtime replay (S21), notifications list (S22), web-push outbox (S23/S24).**
   These live in *other* modules and intentionally have no messaging dependency.
   Making them respect the switch requires a cross-module visibility contract
   (research §4 item 4: "SSE/replay, notification list, deep links and the push
   queue hang on the same visibility decision"). A `ModuleStateReader` call sprinkled
   into `notifications`/`web-push` would make the module registry the second
   authority inside two unrelated modules — needs an explicit decision.
4. **Build-time assets (W11).** `web/public/service-worker.js` ships as a static
   file; it cannot read module state. Only the *source* can be neutralised (stop
   creating conversation pushes) or the *destination* made safe (already true: the
   route guard redirects).
5. **Client-driven participant sync (W8/F18).** It is not a server gate at all —
   the offer simply never appears when `getJobConversation` fails. Under SCH-001
   ("turning a module off must not weaken a core workflow rule") this must be
   classified explicitly: core (move the sync server-side / into offboarding-style
   ownership) or module (document that reassignment no longer syncs participants).
6. **Worker/tick gates.** There are none for messaging (F3). The nearest analogue is
   the Calendar reminder worker (`app.ts:389-399`), which is also construction-gated
   — so there is *no* existing in-repo precedent for a worker that reads module state
   per tick; inventing one here would be a new pattern.

---

## 4. Open questions / owner decisions

1. **Disable semantics for messaging.** Data/FK/audit/idempotency are preserved
   (established). Undecided: what happens to (a) an open conversation view,
   (b) an in-flight `sendMessage`, (c) an already-created `message.received`
   notification in the list, (d) an already-queued web push. Research §4 item 4
   requires all four to hang on one visibility decision.
2. **Retry-after-disable for idempotent mutations (F4).** Return the stored result,
   or `404`? AGENTS.md §7 favours the stored result; the Overview contract has no
   precedent.
3. **Route shape.** Adopt the Overview contract exactly (always registered;
   `404 NOT_FOUND` when off, `503 MODULE_STATE_UNAVAILABLE` on read failure), or keep
   "not registered" and accept the Fastify default body?
4. **Deep links (F20/W10).** Neutralise at the source (no conversation notifications
   / pushes while off, and hide existing ones) or accept the `/jobs` redirect?
5. **Migration numbering (F14).** The sibling Warehouse research proposes a 075
   "widen the registry" migration for modules without an env key. Should there be
   **one** shared widening migration (OVERVIEW + MESSAGING + future keys) authored
   by a single owner, or per-module migrations? Two sessions writing 075 is a
   concrete collision risk.
6. **Env takeover for production (O3).** `ops/examples/servora-med.env.example` has no
   `MESSAGING_ENABLED`. Confirm the *host* value before the first start on the new
   migration; otherwise takeover silently writes `false` for a deployment that
   believed messaging was on.
7. **Env ceiling.** MOD-002 §4 says env acts as a ceiling only for modules whose
   secrets/infrastructure live in env (web-push, geocoding). Messaging has none —
   confirm it is a pure DB-state module with no ceiling.
8. **Restore semantics (F10).** Module state returns to the backup instant, so a
   post-restore re-toggle is required. Accepted, or should the runbook carry an
   explicit "verify module state after restore" step (as it already does for
   operators)?
9. **Staging acceptance re-point (F15/O1).** The CI gate requires
   `MESSAGING_ENABLED=true` in the staging example. Replace it with a DB-state
   assertion (the way Overview's staging acceptance moved to "verify DB state after
   first takeover", `operator-module-pilot.md:190-192`) or keep the env line as a
   legacy record and drop the assertion?
10. **Participant-sync classification (F18).** Core rule (survives the switch) or
    module feature (documented as unavailable while off)? SCH-001 is the governing
    precedent.
11. **Scope confirmation.** MOD-002 §7 / `DECISIONS.md:3778-3779` says *only* Overview
    moves in this decision and "every other module keeps its env key until its own
    slice and contract". A messaging slice therefore needs its own accepted decision
    record (and its own contract doc), not an extension of
    `docs/features/operator-module-pilot.md` — which is still marked **draft**
    (`operator-module-pilot.md:3`) even though MOD-002 is Accepted.

---

## 5. Unverified

* **Fastify's default 404 body inside this application.** No `node_modules` in this
  worktree, so `buildApp` was not executed. The shape quoted in F2 was produced with
  fastify `5.12.8` from the sibling checkout's `node_modules` (the same version this
  worktree pins at `server/package.json:42`), plus a grep showing no
  `setNotFoundHandler` in `server/src`. Not an end-to-end app assertion.
* **Whether any real deployment sets `MESSAGING_ENABLED` out-of-band** (systemd
  drop-in, host `.env`, container env). No host access; UNVERIFIED. Same for the
  production value used by the 074 takeover of Overview.
* **Runtime behaviour of a switch** (per-request 404/503, client redirect timing,
  notification/push leakage) was **not executed** — no database suite was run
  (`TEST_DATABASE_URL` not provisioned for this task, and it is a research task).
  All statements about the switch are static code reading at `fca614b`.
* **The claim that no messaging worker/claim/tick exists** is a negative claim from
  `grep -rn "worker|tick|claim" server/src/modules/messaging/` (0 hits) plus the
  absence of any messaging entry in `server/src/index.ts`. Not proven by execution.
* **That notification/push leakage actually occurs after a disable** is derived from
  the absence of a module-state read in those modules (grep) — no test was run with
  a pre-seeded outbox.
* **Exact behaviour of `pg_restore` for a pre-075 backup followed by a first start
  on the widened registry** — reasoned from `takeover.ts:30-57` and the documented
  074 flow, not exercised.
* **Sibling Warehouse "W0 migration 075" plan** — referenced from the task brief; the
  Warehouse research document was **not** read in this session, so the collision is
  recorded as a coordination risk, not as a verified plan.

---

## Evidence files

All under fleet run `20261126-154819-deepseek-1119` evidence (local operator machine, not in the repo):

* `01-server-messaging-refs.txt` — every `messaging|MESSAGING` hit in `server/src` + HEAD/branch.
* `02-web-messaging-refs.txt` — every messaging hit in `web/src`.
* `03-MESSAGING_ENABLED-repo.txt` — repo-wide `MESSAGING_ENABLED` occurrences (docs, ops, tests, harnesses).
* `04-head-074-assertions.txt` — the 18 test files pinning migration head 074.
* `05-fastify-default-404.txt` — fastify 5.12.8 default 404 body + the pinned version.
* `06-gate-call-sites.txt` — the 11 `requireEnabled()` sites and the helper.
* `07-tests-messaging-flag.txt` — `new MessagingService` in tests + the OP9 unknown-key test.
