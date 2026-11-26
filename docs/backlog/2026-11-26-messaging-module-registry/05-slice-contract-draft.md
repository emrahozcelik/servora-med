# Messaging in the installation module registry — slice contract (draft)

Status: **draft contract, research output** (not an accepted decision; no code changed).
Base: `origin/main` @ `fca614bd` (this worktree `fca614b`, branch
`claude/messaging-module-registry-2ef670`). MOD-002 landed as PR #511, merge
`89bf6b10715d74040edbfd503cacb34a7bb3d176`.
Mirrors the structure of [docs/features/operator-module-pilot.md](../features/operator-module-pilot.md)
(Overview pilot: §5 registry, §6 mutation, §7 runtime reads, §8 web, §9 backup/deploy, §10 acceptance, §12 interfaces).
Related: DECISIONS.md MOD-002 (line 3735), MOD-001 (1991), SCH-001 (3671);
[docs/backlog/2026-11-25-core-modules-architecture-research.md](2026-11-25-core-modules-architecture-research.md) V4 (line 41), V7 (44), §4 item 4 (200–207), §5 step 2 (227).

Every claim below is anchored to `file:line`, a commit, a PR, or is marked **UNVERIFIED**.
"PROPOSAL" = this document proposes it; "DECISION-n" = owner must choose (options + recommendation in §15).

## Summary

- Messaging is a self-contained product module: one Fastify plugin with 11 routes, one service whose `enabled` flag is captured at construction, and optional in-app/web-push notification production. Its env key `MESSAGING_ENABLED` is read once at startup and both the route registration and the service's internal 404 gate capture it (`app.ts:521-531`, `messaging/service.ts:118,1086-1088`).
- Unlike Overview, messaging already has a user capability field and a fully capability-gated web page (`capabilities/types.ts:5`, `web/src/shell/route-access.ts:39-40`, `web/src/AppRouter.tsx:396,407`, `web/src/shell/navigation-model.ts:92`). The web therefore needs only revalidation plumbing, not a new route or nav model.
- Messaging has **no env secret or infrastructure dependency**; web push (VAPID) is a separate, independently gated channel. PROPOSAL: no env ceiling for messaging (DECISION-4).
- The registry is hard-locked to one module in three places: `registry.ts:7-15`, `takeover.ts:20-24` (`{ overviewDashboard: boolean }`), and two CHECKs in `074_…sql:59,86-87`. A widening migration is unavoidable.
- **Two sibling research branches already claim migration `075`** for their own widening (Warehouse W0 `06-first-slice-proposal.md:168`; Accounting `01-codebase-touchpoints.md:498-501`). This slice must own or coordinate 075 (DECISION-1) and should make the key CHECK module-agnostic so it is the last widening migration (DECISION-2).

## 1. Numbered findings (verified)

| # | Finding | Evidence |
| - | --- | --- |
| F1 | The registry is a compile-time array with a one-member literal type, so adding MESSAGING is a type change, not a data change. | `server/src/modules/installation-modules/registry.ts:7-15,17-24,26-30` |
| F2 | Takeover accepts a single boolean keyed by capability name; the loop already reads `legacy[module.capability]`, so the loop body generalises, the signature does not. | `server/src/modules/installation-modules/takeover.ts:20-29` (`const enabled = legacy[module.capability]`) |
| F3 | The database enumerates the module vocabulary twice (state table + audit), so MESSAGING cannot be written before a migration. | `server/src/db/migrations/074_installation_operator_and_module_state.sql:59`, `:86-87` |
| F4 | The migration head is `074`; `075` is free in the repository and there is no reservation mechanism (plain `NNN_name.sql`, lexicographic order, contiguity enforced from 001). | `ls server/src/db/migrations \| sort \| tail -3`; `server/tests/migration-catalog.test.ts:125-137` |
| F5 | Warehouse research already reserves `075` for registry widening (five CHECK rewrites, module-agnostic descriptor/takeover). | branch `claude/warehouse-module-research-0e4def`, `docs/backlog/2026-11-26-warehouse-module-research/06-first-slice-proposal.md:141-177` (W0-3 at :168) |
| F6 | Accounting research also proposes `075` as its first change (widen both `module_key` CHECKs to `('OVERVIEW','ACCOUNTING')`). | branch `claude/accounting-module-research-0100ad`, `docs/backlog/2026-11-26-accounting-module-research/01-codebase-touchpoints.md:498-501` |
| F7 | Maintenance research assumes a later independent "module panel registration" slice and only flags the compile error; it does not claim a migration number. | branch `claude/maintenance-module-research-b97e8e`, `…/02-scope-options.md:541`, `…/01-jobcard-type-impact.md:135` |
| F8 | `MESSAGING_ENABLED` is parsed by the shared `readBoolean` (unset/`false` → false, exact `true` → true, anything else throws) and defaults to false. | `server/src/config.ts:318-324`, `:910`; `server/.env.example:32`; `README.md:583` |
| F9 | Messaging has no secret/infra env dependency. VAPID is required **only** when `WEB_PUSH_ENABLED=true`, and staging runs messaging on with push off — proof that messaging does not depend on the push channel. | `server/src/config.ts:713-731`; `ops/examples/servora-med-staging.env.example:86-87`; `ops/ci/verify-env-examples.sh:68-83` |
| F10 | Messaging routes are registered **only** when the startup env flag is true, so a runtime enable leaves the API answering Fastify's unregistered-route 404 until restart. | `server/src/app.ts:521-531` |
| F11 | The service captures `enabled` in its constructor; every one of the 11 public commands calls `requireEnabled()` which throws the module's opaque `404 NOT_FOUND` ("Sayfa bulunamadı."). | `server/src/modules/messaging/service.ts:118,130,149,197,550,732,737,747,784,965,1072,1080,1086-1088`; `notFound()` at `:42-44` |
| F12 | Overview's gate is a per-request read with distinct 404 (disabled) and 503 (missing/unreadable) outcomes; that is the behaviour to mirror. | `server/src/modules/overview/service.ts:42,91-100`; `docs/features/operator-module-pilot.md:152-161` |
| F13 | `/api/auth/login` and `/api/auth/me` compute capabilities per request, but only Overview is overridden from module state; messaging still comes from the startup config. | `server/src/modules/auth/handlers.ts:31-36,43,46`; `server/src/modules/capabilities/service.ts:20-27` |
| F14 | The web already gates the messaging route, nav entry and mobile "direct" list on `user.capabilities.messaging`, and redirects to `/jobs` when false. | `web/src/shell/route-access.ts:39-40`; `web/src/AppRouter.tsx:396,407-408`; `web/src/shell/navigation-model.ts:92,105-110` |
| F15 | Identity revalidation exists and is capability-agnostic (whole `/api/auth/me` identity), throttled 30 s, single-flight, forced on an Overview 404. Messaging has no 404→revalidate trigger. | `web/src/identity-revalidation.ts:12-70`; `web/src/App.tsx:227-235`; `web/src/overview/OverviewPage.tsx:108`; `web/src/messaging/MessagingPage.tsx:257-268` |
| F16 | `MessagingReadPort.getUnreadCount` is implemented by the messaging repository and consumed **only** by `OverviewService`, and the port is constructed only when the startup env flag is true. | `server/src/modules/messaging/types.ts:146-148`; `server/src/modules/overview/service.ts:6,34,70-80`; `server/src/app.ts:362-375` |
| F17 | Messaging has no worker and no background claim. The only other writers of messaging tables are Staff offboarding (participants + activity + realtime event) and demo-data **purge**; offboarding must keep working while the module is off. | `server/src/modules/people/offboarding.ts:1006-1046`; `server/src/modules/people/repository.ts:233-235`; `server/src/modules/demo-data/repository.ts:429-451`; research §4 item 4 at `2026-11-25-core-modules-architecture-research.md:200-207` |
| F18 | The web-push queue is core, state-agnostic and claims only deliveries created within 24 h with `attempt_count < 6`, so a disable can at worst leak a bounded tail of already-queued pushes. | `server/src/modules/web-push/repository.ts:717-731`; `server/src/modules/messaging/repository.ts:1315-1355` |
| F19 | Operator module listing reads every registry key and returns 503 if any row is missing/unreadable — with two modules a missing MESSAGING row bricks the operator page until the row exists (takeover normally creates it before listen). | `server/src/modules/operator/service.ts:127-133,163-178`; `server/src/index.ts:321-326` |
| F20 | Existing tests encode the *old* fact "MESSAGING is an unknown module key": the operator acceptance test PUTs `MESSAGING` and expects 404 plus a `23514` DB rejection. These assertions must change in this slice. | `server/tests/operator-pilot-postgres.test.ts:1119-1131`; single-module count at `server/tests/operator-unit-flow.test.ts:150-152` |
| F21 | The migration head `074` is mentioned in 29 server test files (a sibling measurement of exact `toBe('074_…')` assertions reports 18; both are the same slice cost); `migration-catalog.test.ts` also pins `count = 74` and full pending-version arrays. Any new migration pays this cost once, in the PR that lands it. | `grep -rl 074_installation_operator_and_module_state server/tests` → 29 files; `server/tests/migration-catalog.test.ts:125-137,274` |
| F22 | `new MessagingService(...)` has 44 call sites (1 production, 43 test) across 14 test files; changing the constructor is mechanical but wide. | `grep -rn "new MessagingService(" server/src server/tests` → 44 |

## 2. Goal and scope

**Goal.** An installation operator switches **Messaging** on/off from `/operator`, with no restart and no env edit; customers already signed in pick it up on the next capability revalidation; disabling stops new messaging API work while preserving all data, history, audit and idempotency records.

**In scope**

- Registry entry `MESSAGING` (`label: 'Mesajlar'`, capability `messaging`, legacy env `MESSAGING_ENABLED`).
- One widening migration (next free number) for the two `module_key` CHECKs.
- Takeover of `MESSAGING_ENABLED` once, per module, in the API process before listen.
- `/api/messaging/*` always registered (when a pool exists) and guarded per request: 404 when disabled, 503 when state is unreadable/missing.
- Per-request `user.capabilities.messaging` on `/api/auth/login` and `/api/auth/me`; `messageUnreadSummary` in Overview follows the messaging state.
- Web: messaging 404 forces one identity revalidation so an open `/messages` page moves to `/jobs`; nav/route gating already exists.
- Server + web tests, ops/env-example and documentation updates.

**Out of scope (do not expand)**

- Any change to messaging domain rules, authorization, cursors, idempotency or schema (tables 018 unchanged).
- Registry prerequisites/dependency graph/worker hooks/menu metadata (explicitly deferred by `operator-module-pilot.md:104-108`).
- Web push becoming registry-managed (`WEB_PUSH_ENABLED` stays an env key); Calendar/Backup/Demo/Geolocation stay as they are.
- Generic "module onboarding framework", per-module migrations, dynamic plugin loading.
- Suppressing or deleting historical notifications, conversations, messages or activity rows.
- Any retention window: "off" does not delete and introduces no purge policy; data is kept until an explicit tenant/general deletion decision.
- Warehouse W0 / Accounting A0 / Maintenance registry work beyond not colliding with 075.

## 3. Registry descriptor

PROPOSAL — exact entries and types (minimal widening, array stays SSOT for the key union):

```ts
// server/src/modules/installation-modules/registry.ts
export type ModuleCapabilityKey = 'overviewDashboard' | 'messaging';

export type InstallationModuleDescriptor = Readonly<{
  key: 'OVERVIEW' | 'MESSAGING';
  /** Turkish operator-facing label. */
  label: string;
  /** The `user.capabilities` field this module drives. */
  capability: ModuleCapabilityKey;
  /** Legacy env key; read once as the takeover source. */
  legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED' | 'MESSAGING_ENABLED';
}>;

export const INSTALLATION_MODULES = [
  { key: 'OVERVIEW',  label: 'Genel Bakış', capability: 'overviewDashboard', legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED' },
  { key: 'MESSAGING', label: 'Mesajlar',    capability: 'messaging',         legacyEnvKey: 'MESSAGING_ENABLED' },
] as const satisfies readonly InstallationModuleDescriptor[];

export type InstallationModuleKey = (typeof INSTALLATION_MODULES)[number]['key']; // 'OVERVIEW' | 'MESSAGING'
```

- Descriptor stays four fields. Adding `hasPage`, `worker`, `prerequisites`, `menu` is rejected: the server derives behaviour from `capability` (`operator/service.ts:47`, `auth/handlers.ts:33`), and the web hard-codes the capability names (`web/src/shell/route-access.ts:39-40`, `navigation-model.ts:92`).
- PROPOSAL (cheap, optional): one compile-time coverage assertion so a new module capability cannot silently miss `AuthenticatedCapabilities`:
  ```ts
  type _CapabilityCovered = ModuleCapabilityKey extends keyof AuthenticatedCapabilities ? true : never;
  const _capabilityCoverage: _CapabilityCovered = true;
  ```
- The type does not tie `key`↔`capability` pairs (a wrong pairing compiles). Accepted for two modules; review enforces it. If the owner wants it enforced, use a keyed definition map instead of an array (more churn, no runtime change).

## 4. State and migration

No new table, no new column, no data rewrite.

PROPOSAL — new migration, module-agnostic name (DECISION-1, DECISION-2):

```sql
-- 075_registry_module_key_policy.sql
-- MOD-002 registry widening: the module vocabulary is owned by the compile-time
-- registry; the database enforces its *shape*, so later modules need no key migration.
ALTER TABLE installation_module_state
  DROP CONSTRAINT installation_module_state_key_check,
  ADD CONSTRAINT installation_module_state_key_check
    CHECK (module_key ~ '^[A-Z][A-Z0-9]{1,31}$');

ALTER TABLE operator_audit_events
  DROP CONSTRAINT operator_audit_events_module_key_check,
  ADD CONSTRAINT operator_audit_events_module_key_check
    CHECK (module_key IS NULL OR module_key ~ '^[A-Z][A-Z0-9]{1,31}$');
```

If the owner rejects the format CHECK: identical file with
`CHECK (module_key IN ('OVERVIEW','MESSAGING'))` on both constraints, named
`075_messaging_module_key.sql`. Nothing else in 075.

State semantics (unchanged from MOD-002 §3/§5):

| Column | MESSAGING row |
| --- | --- |
| `module_key` | `'MESSAGING'` |
| `enabled` | effective state; **the only source** |
| `version` | optimistic version for `PUT /api/operator/modules/MESSAGING` |
| `source` | `ENV_TAKEOVER` on first start, `OPERATOR` after any operator change |
| `updated_by_operator_id` | NULL for takeover, operator id for operator changes (074 CHECK pair) |

Migration-collision protocol (PROPOSAL, part of the merge checklist):

1. This slice takes the **lowest free number at merge time** (075 today). It is a Core-owned, module-agnostic widening, not a messaging-owned migration.
2. Sibling slices (Warehouse W0, Accounting A0, Maintenance) must **not** author a second key-widening migration; after 075 they only add a registry entry (+ capability field) and, if they need a new `source`/event type, their own narrow migration.
3. If another branch merges a `075_*` first, this PR rebases and renumbers to the next free number; migration files already applied are never edited (`AGENTS.md` §6).
4. Both ops env examples and `HEALTH_SCHEMA_VERSION` move in the same PR (`ops/ci/verify-env-examples.sh:40-50`).
5. The landing PR must update the 29 head-pinned test files (F21) and `migration-catalog.test.ts` count/pending arrays; this is expected churn, not a defect.

## 5. Takeover

PROPOSAL — signature becomes exhaustive over module capabilities so a new module cannot be forgotten at the call site (aligned with the exhaustive-dispatch precedent, PR #513):

```ts
// server/src/modules/installation-modules/takeover.ts
export async function takeOverInstallationModules(
  pool: Pool,
  legacy: Readonly<Record<ModuleCapabilityKey, boolean>>, // { overviewDashboard, messaging }
  now?: () => Date,
): Promise<void>;
```

Loop body unchanged: per registry module, `INSERT … ON CONFLICT (module_key) DO NOTHING RETURNING`, and only the inserting process writes `MODULE_STATE_TAKEN_OVER` (actor `SYSTEM`) in the same transaction. Any throw stops startup.

`server/src/index.ts:321-326` becomes:

```ts
await takeOverInstallationModules(database.pool, {
  overviewDashboard: config.capabilities?.overviewDashboard ?? false,
  messaging: config.capabilities?.messaging ?? false,
});
```

Behaviour matrix:

| Situation | Result |
| --- | --- |
| Fresh empty DB, `MESSAGING_ENABLED` unset/`false` | `MESSAGING` row `enabled=false`, `source=ENV_TAKEOVER`, one audit event |
| Fresh empty DB, `MESSAGING_ENABLED=true` | `enabled=true` |
| Existing 074 DB, first start on 075 | OVERVIEW row untouched; only the missing MESSAGING row is inserted from env |
| Restart / concurrent startups | no duplicate row, no duplicate event (unique PK conflict) |
| Row missing **and** a `MODULE_STATE_TAKEN_OVER` event for that key exists | startup fails closed (damaged/partial restore); no env re-derivation |
| Row missing and **no** event (e.g. hand-truncated table before any start) | inserted from env; same accepted semantics as Overview today |
| Env flipped after takeover | no effect; DB is the only source |

Note: the fail-closed check is per `module_key` (`takeover.ts:40-50`), so a damaged MESSAGING row fails startup even when OVERVIEW is healthy — correct, but it widens the blast radius of a damaged row to "API does not start" (accepted, same as Overview).

## 6. Runtime reads and failure behaviour

### 6.1 Read model

One `ModuleStateReader`, one primary-key read per module per request, no cache (`state.ts:51-63`).

| Request | State reads | Notes |
| --- | --- | --- |
| All 11 `/api/messaging/*` routes (5 GET, 5 POST, 1 PATCH) | 1 (`MESSAGING`) | gate runs after authentication, before the handler |
| `GET /api/auth/me` | 2 (`OVERVIEW`, `MESSAGING`) | `Promise.all`; any failure → that capability `false` + error log, request still 200 |
| `POST /api/auth/login` | 2 | same; login never fails because of module state |
| `GET /api/overview` | 2 (`OVERVIEW` gate, `MESSAGING` for the unread summary) | messaging read failure only omits `messageUnreadSummary` |
| `GET /api/operator/modules` | 2 (one per registry key) | 503 if any row missing/unreadable |
| `PUT /api/operator/modules/:key` | 0 reads (row locked `FOR UPDATE` in the transaction) | `operator/repository.ts:242-282` |

Notes: a missing/unreadable row logs one error per read (same as Overview), so a damaged MESSAGING row is visible in logs on every `/me`; two PK reads per customer auth call is the accepted cost of the registry (the Warehouse research reaches the same conclusion for a second module).

### 6.2 HTTP status table (PROPOSAL — frozen for parallel authors once accepted)

Precedence is top-down; the first matching row wins.

| # | Condition | Status | `code` | Body message |
| - | --- | --- | --- | --- |
| 1 | No/invalid customer session | `401` | `UNAUTHENTICATED` | `Oturum açmanız gerekiyor.` (`auth/middleware.ts:12`) |
| 2 | `mustChangePassword` | `403` | `PASSWORD_CHANGE_REQUIRED` | existing |
| 3 | MESSAGING state read throws | `503` | `MODULE_STATE_UNAVAILABLE` | `Modül durumu şu anda okunamıyor.` |
| 4 | MESSAGING row missing | `503` | `MODULE_STATE_UNAVAILABLE` | same |
| 5 | MESSAGING `enabled=false` | `404` | `NOT_FOUND` | `Sayfa bulunamadı.` (same opaque 404 the service uses today) |
| 6 | `enabled=true` | existing per-endpoint success/errors | — | unchanged |

Endpoints covered (all of `server/src/modules/messaging/routes.ts:18-27`):

| Method | Path |
| --- | --- |
| GET | `/api/messaging/conversations` |
| GET | `/api/messaging/recipients` |
| POST | `/api/messaging/conversations` |
| GET | `/api/messaging/conversations/job/:jobId` |
| GET | `/api/messaging/conversations/:conversationId/messages` |
| POST | `/api/messaging/conversations/:conversationId/messages` |
| POST | `/api/messaging/conversations/:conversationId/archive` |
| POST | `/api/messaging/conversations/:conversationId/unarchive` |
| PATCH | `/api/messaging/conversations/:conversationId/read` |
| GET | `/api/messaging/unread-count` |
| POST | `/api/messaging/conversations/:conversationId/job-assignee-sync` |

Also fixed:

| Endpoint | Disabled / unreadable | Enabled |
| --- | --- | --- |
| `GET /api/auth/me` | `200`, `capabilities.messaging=false` (+ error log on failure) | `200`, true |
| `POST /api/auth/login` | `200`, `capabilities.messaging=false` | `200`, true |
| `GET /api/overview` | unchanged for `OVERVIEW`; `messageUnreadSummary` **omitted** | `messageUnreadSummary` present when the read succeeds |
| `GET /api/operator/modules` | `503 MODULE_STATE_UNAVAILABLE` if the MESSAGING row is missing/unreadable | `200` with two entries |
| `PUT /api/operator/modules/MESSAGING` | `400`, `401`, `403`, `409 MODULE_VERSION_CONFLICT`, `503` as today | `200` |
| `PUT /api/operator/modules/<other>` | `404 NOT_FOUND` (unknown key) | `404` |

### 6.3 Gate placement — PROPOSAL (DECISION-3)

Recommended: **route-level guard**, one place, after authentication:

```ts
// server/src/modules/messaging/routes.ts
export type MessagingRoutesOptions = {
  service: MessagingService;
  authenticate: preHandlerHookHandler;
  moduleState: ModuleStateReader;
};
// per route (array preserves order: auth first, then module state):
app.get('/conversations', { preHandler: [options.authenticate, gate] }, handlers.listConversations);
```

with a Fastify-free helper so the 404/503 mapping has one definition:

```ts
// server/src/modules/installation-modules/gate.ts (new)
export function moduleDisabled(): AppError;          // ('NOT_FOUND', 404, 'Sayfa bulunamadı.')
export function moduleStateUnavailable(): AppError;  // ('MODULE_STATE_UNAVAILABLE', 503, 'Modül durumu şu anda okunamıyor.')
export async function assertModuleEnabled(
  reader: ModuleStateReader,
  key: InstallationModuleKey,
  logger: ModuleStateLogger,                          // request.log satisfies this
): Promise<void>;                                      // throws the two errors above
```

Then delete `private readonly enabled`, the 11 `this.requireEnabled()` calls and `requireEnabled()` itself (`messaging/service.ts:118,1086-1088`), and pass the reader in `app.ts`.

Why not the Overview-style service gate: messaging has 11 thin pass-through endpoints (11 duplicate gate calls + 11 `await`s) and no internal caller; `OverviewService` needs the state *inside* the service because it also decides whether to emit `messageUnreadSummary`. Both options are listed in DECISION-3.

### 6.4 Env ceiling — PROPOSAL (DECISION-4)

`effective = state.enabled`; **no** `AND env`. Reasons: no secret/infra lives in env for messaging (F9); MOD-002 §4 restricts ceilings to env-secret modules (`DECISIONS.md:3770-3773`); a ceiling would make the operator unable to enable messaging on an install whose env lacks the key (the production example does not contain it at all — `ops/examples/servora-med.env.example` has no `MESSAGING_ENABLED` line). `config.capabilities.messaging` survives only as (a) takeover input and (b) the pool-less test fallback.

### 6.5 Overview unread summary (PROPOSAL)

`OverviewService` drops the constructor `messagingEnabled` boolean and reads the state per request:

```ts
const messagingEnabled = await readModuleEnabledOrFalse(this.moduleState, 'MESSAGING', logger);
if (messagingEnabled && this.messagingRead) { /* existing try/catch */ }
return { ...overview, upcomingWork, ...(role !== 'STAFF' ? { workTypeDistribution } : {}),
         ...(messagingEnabled ? { messageUnreadSummary } : {}) };
```

`messagingReadPort` in `app.ts` is constructed whenever `dependencies.pool` exists (not only when env is true), so enabling at runtime does not require a restart. A messaging read failure must never fail `/api/overview`.

## 7. Workers, claims and in-flight commands

- **No messaging worker or scheduled claim exists.** Nothing to start/stop on toggle. The only claim-like command is `POST …/job-assignee-sync`, an HTTP command with `clientActionId` + idempotency (`service.ts:779-800`); when disabled the route answers 404 before the command, so no new claim is accepted.
- **In-flight requests complete.** A request that passed the gate keeps its connection and finishes its transaction; there is no mid-request re-read (same rule as `operator-module-pilot.md:160-161`). Re-enabling does not resurrect anything.
- **Gate precedes idempotency resolution.** `requireEnabled()` runs before `clientActionId` handling today (`service.ts:550-556`); the route guard preserves that order. A retry of a command that committed just before a disable therefore returns `404`, not the stored duplicate result; the idempotency record is untouched and replays normally after re-enable. Accepted (the module is off; no new work may be claimed).
- **Reassignment sync is client-driven.** No server-side job-cards → messaging coupling exists; `useReassignmentConversationSync` on the web offers the sync and hides it when the capability is off. Nothing to disable on the server.
- **Staff offboarding stays outside the gate.** It deletes/inserts `conversation_participants`, writes `messaging_activity_logs` and a `conversation.participants_changed` realtime event directly, whatever the module state (`people/offboarding.ts:1006-1046`). This is a hard invariant of disable semantics (research §4 item 4) and must be covered by a test with MESSAGING disabled.
- **History guards stay.** `people/repository.ts:233-235` still blocks permanent deletion of a user who has messaging activity; disabling does not unlock it.
- **Demo-data** only analyzes/purges existing messaging rows (`demo-data/repository.ts:429-451`); it is state-agnostic and unchanged. It creates no conversations.
- **No new writes on disable.** The toggle transaction writes only `installation_module_state` + `operator_audit_events` (DECISION-5 for the push exception).

## 8. Realtime, notifications, push

- Event types that belong to messaging: `conversation.created`, `message.sent`, `conversation.participants_changed`; entity `conversation` (`realtime/types.ts:18-21,28-36`). Resource keys used by clients: `conversations`, `conversation:<id>`, `message-unread`, and on send also `overview`, `notifications` (`messaging/service.ts:497,675,720,923,1047`).
- **SSE replay is state-agnostic and stays so.** `replayVisible` filters by organization/audience/resource authorization only (`realtime/repository.ts:175-207`), so old `conversation.*` events still replay after a disable. Consequence: at most one stale cache invalidation on the client; no page exists to consume it. PROPOSAL: no filter (a module-state filter in the core event stream is exactly the "generic infrastructure" MOD-001 §4 discourages).
- **In-app notifications are history and stay.** `message.received` rows (`notifications/types.ts:32`, `messaging/repository.ts:1315-1331`) remain visible in the notification center; their deep link is `/messages?conversation=…` (`web/src/notifications/NotificationCenter.tsx:227-228`) which now redirects to `/jobs` while disabled. PROPOSAL: keep (DECISION-6); deleting history contradicts disable semantics.
- **Web-push queue is core and unchanged.** Messaging inserts `web_push_deliveries` inside its send transaction regardless of the dispatcher state (`messaging/repository.ts:1333-1355`); the dispatcher runs only when `WEB_PUSH_ENABLED` and claims rows created in the last 24 h with `attempt_count < 6` (`web-push/repository.ts:717-731`). Therefore disabling messaging can at worst deliver a bounded tail of pushes queued before the disable. PROPOSAL: do not write to the queue on disable (DECISION-5).
- No push is *created* while disabled because no message can be sent (all messaging writes are behind the gate).

## 9. Web

Capability field name is unchanged: `user.capabilities.messaging` (server `capabilities/types.ts:5`; web type/parser `services/api.ts:22,186`). Only its **source** moves from startup config to per-request module state.

Already correct today (no change needed): capability type/parser (`web/src/services/api.ts:20,22,184,186`), route gate (`AppRouter.tsx:396,407-408`), nav + mobile direct list (`navigation-model.ts:92,105-110`), job-detail entry (`jobs/JobConversationAction.tsx:91`), route identity/title (`shell/route-identity.ts:13,50,146,207`).

Gaps to close (PROPOSAL):

1. **404 → one forced revalidation.** `MessagingPage` currently treats a `404` on a thread load as "membership revoked" and clears the selection silently (`MessagingPage.tsx:349-359`); a module-off `404` would look identical (a sibling finding in this package, `02-runtime-gates.md` F17). Because both cases are the same opaque `404` by design, the page cannot distinguish them — so **every** messaging `404` (list load `:257-268`, thread load, send) calls one `onUnavailable` prop. The shell's existing forced revalidation (`App.tsx:227-235`) then compares the identity: module off → capability false → `AppRouter` redirects to `/jobs`; membership revoked → identity unchanged, the existing thread-clear behaviour stands and the cost is one `/me`. The callback must not be called more than once per user action (single flight already enforced in `useIdentityRevalidation`).
2. **Callback wiring.** PROPOSAL: rename the single existing prop `onOverviewUnavailable` to `onModuleUnavailable` in `App.tsx` / `AppRouter.tsx` and pass it to both `OverviewPage` and `MessagingPage`. Two identical callbacks would be the alternative; the rename touches one test (`web/tests/identity-revalidation.test.tsx`) and two source files.
3. **No new route, no new nav item, no operator UI change.** `OperatorModulesPage` renders whatever `GET /api/operator/modules` returns (generic label + "sayfası" copy, `web/src/operator/OperatorModulesPage.tsx:41-53`), so the MESSAGING row appears automatically.
4. **Operator confirmation copy (DECISION-7).** Current copy says the page "kısa süre içinde kaybolur" but says nothing about data. Adding one generic sentence ("Veriler silinmez.") is shared with the Warehouse W0 proposal (`06-first-slice-proposal.md:173`).
5. **No flash of a disabled page:** if `/messages` is opened with a stale `messaging=true`, the list 404 → revalidation → redirect; the page must not loop (revalidation is single-flight and throttled).

## 10. Backup, restore and deploy

- **Backups.** `installation_module_state` and `operator_audit_events` are ordinary installation-level tables inside the database dump; no backup code change. A dump therefore carries the MESSAGING state and its history.
- **Restore.** The restore path requires the dump's `schema_migrations` ledger to match the release catalog exactly (`backup/restore/postgres.ts:166-196`, `db/recovery-catalog.ts`). Consequences: a pre-075 dump is restored only with its own release (existing verified-release flow), then forward-migrated; the first start on 075 then takes over the missing MESSAGING row from env. A dump taken after 075 restores the state **as of the backup instant**; env is not re-read (row exists). Operator access reset still runs (`backup/restore/operator-reset.ts`, `operator/restore-reset.ts`).
- **Deploy.** Migration 075 requires `allow_migrations` on the deploy run (same gate as 074, `docs/operations/production-deployment.md:756-772`). `HEALTH_SCHEMA_VERSION` must move to 075 in both ops examples (`ops/ci/verify-env-examples.sh:40-50`), and the runbook's MOD-002 section gains one MESSAGING sentence.
- **Deploy-visible behaviour gate.** Before deploying, read the live `MESSAGING_ENABLED` value and state it in the release note: takeover freezes it into the DB, so a live `true` stays on (operator-owned afterwards) and an absent/false key stays off. The production example contains no `MESSAGING_ENABLED` line, so production behaviour is decided by the real host env, not the example.
- **Rollback.** Rolling the release back to a 074 binary leaves the 075 CHECK in place; 074 code only ever writes `'OVERVIEW'`, which still satisfies both the format and enumeration variants. No down-migration is written (repo policy: forward-only).
- **Staging.** The staging example keeps `MESSAGING_ENABLED=true` as the legacy takeover input; `ops/ci/verify-env-examples.sh:68-71` keeps asserting it, mirroring the OVERVIEW precedent (`:64-67`).

## 11. Acceptance scenarios

PROPOSAL — the owner-approved contract freezes these IDs; test authors should keep the IDs stable.

Server (PostgreSQL; harness style of `server/tests/operator-pilot-postgres.test.ts` / `installation-modules-takeover.test.ts`):

| ID | Scenario | Expected |
| --- | --- | --- |
| MS1 | Fresh schema, `{overviewDashboard:true, messaging:true}` takeover | two rows, each `source=ENV_TAKEOVER`, exactly one `MODULE_STATE_TAKEN_OVER` per key |
| MS2 | Fresh schema, `messaging:false` | MESSAGING `enabled=false`; OVERVIEW unaffected |
| MS3 | Six concurrent takeovers on a missing row (two pools) | exactly 2 rows and 2 events; no duplicates over repeated rounds |
| MS4 | Restart with flipped env (`messaging:false` after `true`) | state and version unchanged, no new event |
| MS5 | Existing 074 DB (OVERVIEW row only), first 075 start | OVERVIEW row byte-identical; MESSAGING inserted from env; only one new event |
| MS6 | `PUT /api/operator/modules/MESSAGING {enabled:false, expectedVersion:1}` then GET each of the 11 endpoints | `200` on PUT; every endpoint `404 NOT_FOUND` without restart; `/api/auth/me` `messaging=false` |
| MS7 | Toggle MESSAGING back on | all 11 endpoints return their normal success/validation codes; `/me` `messaging=true` |
| MS8 | Unauthenticated request to a disabled module | `401 UNAUTHENTICATED` (auth precedes the module gate) |
| MS9 | `mustChangePassword` user, enabled module | `403 PASSWORD_CHANGE_REQUIRED` |
| MS10 | Row deleted (no takeover event) → any messaging endpoint and `/api/auth/me` | messaging `503 MODULE_STATE_UNAVAILABLE`; `/me` 200 with `messaging=false`; `GET /api/operator/modules` `503` |
| MS11 | Injected reader that throws | messaging `503`; `/me` 200 `messaging=false`; one error log per read; `/api/overview` still `200` when OVERVIEW is healthy |
| MS12 | Stale `expectedVersion` (same or different value) | `409 MODULE_VERSION_CONFLICT`, no state/audit write |
| MS13 | Current version, same value | `200`, zero new audit events |
| MS14 | Current version, different value with forced audit failure | whole transaction rolls back (state and audit unchanged) |
| MS15 | `PUT /modules/NOPE` | `404 NOT_FOUND`, nothing written; DB rejects a key that violates the chosen CHECK policy |
| MS16 | `GET /api/operator/modules` with both rows present | two entries with Turkish labels and per-module versions |
| MS17 | Overview with messaging off / on / unreadable | `messageUnreadSummary` omitted / present / omitted with `/api/overview` still `200` |
| MS18 | Staff offboarding (job transfer) with messaging disabled | offboarding succeeds; participants swapped; activity + `conversation.participants_changed` event written |
| MS19 | Toggle off while a send is in flight (gate passed) | the in-flight send commits; the next request 404s |
| MS20 | Toggle off with queued `message.received` push rows | no `web_push_deliveries` / `in_app_notifications` row is modified by the toggle (DECISION-5 option A) |
| MS21 | SSE `Last-Event-ID` replay after a disable | pre-disable `conversation.*` events still replay |
| MS22 | Restore a post-075 dump, then first start | state equals the backup instant; no env re-takeover event; operator reset applied |

Web (jsdom/Vitest; style of `web/tests/identity-revalidation.test.tsx`, `router.test.tsx`):

| ID | Scenario | Expected |
| --- | --- | --- |
| MW1 | `messaging=false` → direct `/messages` | lands on `/jobs`, no "Konuşmalar" request, no error state |
| MW2 | `messaging=true` → `/messages` | renders the messaging page (existing tests unchanged) |
| MW3 | Nav with `messaging=false` | no "Mesajlar" destination; with true, present |
| MW4 | `/api/auth/me` revalidation flips messaging true→false while `/messages` is open | page unmounts, router lands on `/jobs`, one forced revalidation |
| MW5 | Messaging list answers 404 (module off) | exactly one forced revalidation, throttle bypassed, no overlap with a running request |
| MW6 | Operator page with two modules | both rows render; toggling MESSAGING sends `expectedVersion` and shows success/conflict states |
| MW7 | Customer routes | no request to `/api/operator/*` (existing guard unchanged) |

## 12. Existing tests that change

| File | Change |
| --- | --- |
| `server/tests/operator-pilot-postgres.test.ts` | OP9 must stop using `MESSAGING` as the unknown key (`:1119-1123`) and stop expecting a `23514` rejection for it (`:1126-1131`); takeover counts become 2 rows / 2 events (`:1128,1151,1162-1218`); `seedState` (`:320-326`) must seed both rows or the operator fixture returns 503 |
| `server/tests/operator-unit-flow.test.ts` | `modules` list length 1 → 2 (`:150-152`) |
| `server/tests/installation-modules-takeover.test.ts` | takeover signature and per-module assertions (8 call sites) |
| `server/tests/migration-catalog.test.ts` | `count` 74 → 75, head, contiguous array, pending-version lists (`:125-137,274`) |
| 29 server test files | hard-coded head `074_…` → `075_…` (F21) |
| `server/tests/messaging-service.test.ts` (+13 messaging test files) | constructor: `new MessagingService(pool, true[, publisher])` → `new MessagingService(pool[, publisher])` (43 sites); the "capability gate" describe block (`:63-86`) moves to a route-level test if DECISION-3 = A |
| `server/tests/overview-service.test.ts`, `overview-routes.test.ts` | `OverviewService` loses `messagingEnabled`; add the messaging-state branch (5 sites) |
| `server/tests/messaging-cursor-validation.test.ts`, `messaging-m8-input-validation.test.ts`, `messaging-m9-job-assignee-sync.test.ts` | locally built Fastify app registers `messagingRoutes` directly → must pass `moduleState: staticModuleStateReader(true)` |
| `web/tests/identity-revalidation.test.tsx` | prop rename to `onModuleUnavailable` (if taken) + messaging 404 scenario |
| `web/tests/router.test.tsx`, `route-access.test.ts` | add the messaging route-gate case (currently untested) |

## 13. Docs to update (same PR)

| Document | Change |
| --- | --- |
| `DECISIONS.md` | new accepted record **MOD-003** ("Messaging joins the installation module registry"): registry entry, 075 widening policy, no env ceiling, disable semantics, 404/503 mapping. MOD-002 is not edited (accepted record; §7 explicitly deferred other modules). |
| `docs/features/messaging-module-registry.md` | promote this contract on approval (DECISION-8) |
| `docs/README.md` | index row for the new feature contract |
| `SERVORA_MED_SCHEMA_DRAFT.md` | new §8.2 for 075 (constraint names, policy, no DML); note in §8.1 that `module_key` is no longer an enumeration (if DECISION-2 = format CHECK) |
| `SERVORA_MED_API_DRAFT.md` | §4: `capabilities.messaging` is runtime-derived; new short sub-section for `/api/messaging` module-off semantics (404/503) or a note in §20; §20 module list now two keys |
| `README.md` | feature bullet (`:107`) and env table row (`:583`): "legacy takeover input" |
| `server/.env.example` | extend the MOD-002 legacy note block (`:26-31`) to `MESSAGING_ENABLED` (`:32`) |
| `ops/examples/servora-med-staging.env.example` | extend the legacy note (`:80-83`) to `MESSAGING_ENABLED=true` (`:86`) |
| `ops/ci/verify-env-examples.sh` | comment only; assertions stay (`:59,68-71`) |
| `docs/operations/production-deployment.md` | MOD-002 section (`:756-772`): one MESSAGING takeover paragraph, 075 `allow_migrations`, record the live env value |
| `docs/operations/staging-contract.md` | `:137` row: "legacy takeover input (MOD-003)"; optionally refresh the stale migration head at `:128` |
| `docs/operations/backup-restore.md` | one line: module state returns to the backup instant; post-075 dump restores with the matching release |

Historical/evidence files (`docs/operations/staging-acceptance.md:63`, `docs/evidence/…/f4/README.md:75`) are dated records; do not rewrite them.

## 14. Implementation interfaces (fixed for parallel authors)

```ts
// registry.ts
export type ModuleCapabilityKey = 'overviewDashboard' | 'messaging';
export type InstallationModuleKey = 'OVERVIEW' | 'MESSAGING';
export function findInstallationModule(key: string): InstallationModuleDescriptor | undefined;

// state.ts
export function staticModuleStateReader(
  state: boolean | Readonly<Partial<Record<ModuleCapabilityKey, boolean>>>,
): ModuleStateReader;                                   // boolean keeps existing call sites working
export async function readModuleEnabledOrFalse(
  reader: ModuleStateReader, key: InstallationModuleKey, logger: ModuleStateLogger,
): Promise<boolean>;

// gate.ts (new)
export function moduleDisabled(): AppError;
export function moduleStateUnavailable(): AppError;
export async function assertModuleEnabled(
  reader: ModuleStateReader, key: InstallationModuleKey, logger: ModuleStateLogger,
): Promise<void>;

// takeover.ts
export async function takeOverInstallationModules(
  pool: Pool, legacy: Readonly<Record<ModuleCapabilityKey, boolean>>, now?: () => Date,
): Promise<void>;

// capabilities/service.ts
export function withModuleCapabilities(
  capabilities: AuthenticatedCapabilities | undefined,
  runtime: Readonly<{ overviewDashboard: boolean; messaging: boolean }>,
): AuthenticatedCapabilities;                           // replaces withOverviewDashboard

// messaging/service.ts
export class MessagingService {
  constructor(pool: Pool, realtimePublisher?: RealtimeEventPublisher); // `enabled` removed
}

// messaging/routes.ts
export type MessagingRoutesOptions = {
  service: MessagingService;
  authenticate: preHandlerHookHandler;
  moduleState: ModuleStateReader;                       // 404/503 gate, auth first
};

// overview/service.ts
export class OverviewService {
  constructor(
    moduleState: ModuleStateReader,
    repository: OverviewReadModel,
    reports?: ReportsReadModel,
    now?: () => Date,
    calendarEnabled?: boolean,
    messagingRead?: MessagingReadPort,                  // `messagingEnabled` removed
  );
}

// inside the authenticated block that defines authenticateDomain (app.ts:261-613)
const messagingReadPort = dependencies.pool
  ? new PostgresMessagingRepository(dependencies.pool)
  : undefined;

// overview registration (replaces app.ts:366-379): drop the captured messaging boolean
new OverviewService(
  moduleStateReader, dependencies.overviewRepository, dependencies.reportsRepository,
  undefined, config.capabilities?.calendar ?? false, messagingReadPort,
);

// messaging registration (replaces app.ts:521-531)
if (dependencies.pool) {
  await app.register(messagingRoutes, {
    prefix: '/api/messaging',
    service: new MessagingService(dependencies.pool, dependencies.realtimePublisher),
    authenticate: authenticateDomain,
    moduleState: moduleStateReader,
  });
}
```

Pool-less unit tests: `buildApp` must build the fallback reader from the **whole** capability object, otherwise a static reader built from `overviewDashboard` would report the wrong value for MESSAGING:

```ts
const moduleStateReader = dependencies.moduleStateReader
  ?? (dependencies.pool
    ? new PostgresModuleStateReader(dependencies.pool)
    : staticModuleStateReader(config.capabilities ?? {}));
```
(`server/src/app.ts:257-260` currently passes only `config.capabilities?.overviewDashboard`; two auth fixtures set `overviewDashboard:true, messaging:false` — `auth-routes.test.ts:52-56`, `auth-login-constant-work.test.ts:364-368`.)

File layout (server): `installation-modules/{registry,state,takeover,gate}.ts`; `messaging/{routes,service}.ts` modified; `capabilities/service.ts` modified; `overview/service.ts` modified; `db/migrations/075_*.sql`; `index.ts` modified. No new web files.

## 15. Open questions / owner decisions

Sibling research in this package (`01-prior-decisions.md` §9 Q1–Q12) raises the same questions; this section turns the in-scope ones into decisions: Q1→DECISION-9, Q2→§7, Q3→DECISION-6, Q4→DECISION-5, Q5→§7, Q8→DECISION-4, Q9→DECISION-1, Q10→§5, Q11→DECISION-7, Q12→§6.2.

**DECISION-1 — Who owns migration 075, and how is the three-way collision resolved?**
- A (recommended): this slice owns `075_registry_module_key_policy.sql` and lands it as a module-agnostic widening; siblings then never need a key migration. Merge-gate: lowest free number at merge time; renumber on rebase; never edit an applied migration.
- B: split a Core-only widening PR (a local "W0") first; this slice rebases onto it and adds no migration. Safer for parallel sessions, one extra PR.
- C: wait for the Warehouse W0 branch to land 075. Rejected: blocks messaging on an unapproved research slice.

**DECISION-2 — Enumerating or shape-only `module_key` CHECK?**
- A (recommended): shape regex `^[A-Z][A-Z0-9]{1,31}$` on both tables; vocabulary stays in the compile-time registry. Removes future contention; the DB still rejects malformed keys and the operator API already 404s unknown keys (`operator/routes.ts:159-160`). Residual risk: a hand-inserted key outside the registry is inert (listing iterates the registry, `operator/service.ts:127-133`), not a crash.
- B: `IN ('OVERVIEW','MESSAGING')`. Keeps a hard DB vocabulary but guarantees another identical migration for Warehouse, Accounting and Maintenance, each with the 29-file head churn.
- If A is chosen, say explicitly in MOD-003 that "typed state" is enforced by one-row-per-registry-key plus shape CHECKs, not by an enumeration (UI-002 compatibility).

**DECISION-3 — Gate location**
- A (recommended): route-level `preHandler: [authenticate, gate]` on the 11 messaging routes; delete the service flag. One read, one definition, auth-first.
- B: service-level `assertModuleEnabled()` in each of the 11 methods (closest mirror of Overview). More edits, 11 awaits, logger plumbing; `OverviewService` still needs its own messaging read, so the "service owns the gate" argument is weaker here.

**DECISION-4 — Is `MESSAGING_ENABLED` an env ceiling?**
- A (recommended): no ceiling; DB is the only source after takeover. No env secret/infra exists (F9).
- B: ceiling (`enabled AND env`). Rejected: makes the panel unable to enable messaging when the host env omits the key, and contradicts MOD-002 §4's stated ceiling rule.

**DECISION-5 — Web-push queue on disable**
- A (recommended): no write. Queued message pushes may still be delivered for up to the 24 h claim window (F18); they are already-formed notifications for a message that exists.
- B: on disable, mark pending `message.received` deliveries `ABANDONED` with `last_error_code='MODULE_DISABLED'`. Stronger silence, but the operator toggle then writes into the core push queue (new cross-module coupling) and changes an existing state machine for a bounded benefit.

**DECISION-6 — Message notifications and deep links while disabled**
- A (recommended): keep rows visible with the existing copy; the deep link redirects to `/jobs`. History preserved, zero new code.
- B: hide `message.received` rows from the notification center while disabled. Requires the notification read to consult module state (new coupling) and hides history.
- C: delete them. Rejected by disable semantics (research §4 item 4).

**DECISION-7 — Operator confirmation copy**
- A (recommended): add one generic sentence "Veriler silinmez." to the disable dialog for every module (shared with Warehouse W0-8).
- B: a messaging-specific consequence line ("Konuşmalar ve mesajlar silinmez; Mesajlar menüsü, iş detayı girişi ve bildirim bağlantıları gizlenir.").
- C: none (current copy).

**DECISION-8 — Where the accepted contract lives**
- A (recommended): promote to `docs/features/messaging-module-registry.md` when approved, plus a DECISIONS MOD-003 record; keep this file as the research draft.
- B: keep the contract in `docs/backlog/2026-11-26-messaging-module-registry/`.

**DECISION-9 — Disable semantics (decide first; DECISION-3/5/6 assume it)**
- A (recommended): **hidden entirely** — every `/api/messaging/*` endpoint 404s, no read or export path while off, all data preserved; SSE/web-push/notification history unchanged. Matches SCH-001 (`DECISIONS.md:3702-3704`: data of a disabled module is "never deleted") and research §4 item 4 (data, FK, audit and idempotency preserved).
- B: hidden but ADMIN/MANAGER keep a read-only history path (e.g. job-detail conversation viewer or an export). Requires a second, role-scoped read surface, an explicit capability and new API — a much larger slice.
- C: hidden and the operator may purge. Rejected (destructive, contradicts MOD-002/§4 item 4).

Non-decision open questions:

1. Should `GET /api/operator/modules` stay fail-closed (503) when one row is missing, or return the readable rows plus a per-row error? Fail-closed is MOD-002 behaviour; keep unless the owner wants panel resilience.
2. Should the operator page show "last change" for MESSAGING whose `source=ENV_TAKEOVER` as "kurulum ayarından devralındı"? The generic copy already does (`OperatorModulesPage.tsx:31-39`).
3. Is a release note entry enough for the takeover behaviour change, or does the owner want a staging acceptance rerun that flips MESSAGING twice from `/operator`?
4. Should customers see an organization-visible signal that messaging was hidden by the installation operator, or is the installation-level `operator_audit_events` record sufficient (MOD-002 §6 precedent)?

## 16. Unverified

- Open PRs / unmerged branches beyond the three local research branches were not enumerated (no GitHub API call in this read-only session). Another session may already be preparing `075`. — **UNVERIFIED**
- Production live values of `MESSAGING_ENABLED` (and whether any host sets it true) — no host access. — **UNVERIFIED**
- Whether production has pending `message.received` push deliveries or unread message notifications that would surface the deep-link redirect — no DB access. — **UNVERIFIED**
- Warehouse W0's final migration content: its `06-first-slice-proposal.md` is a research draft on an unmerged branch, not an accepted contract. — **UNVERIFIED as policy**
- Whether TypeScript reports the removed private `enabled` field under `noUnusedLocals` (expected, not executed) — no build was run (research-only task). — **UNVERIFIED**
- Actual runtime effect of `staticModuleStateReader(config.capabilities)` on the existing auth fixtures (reasoned from code, not executed). — **UNVERIFIED**
- Whether any external/scripted client depends on `messageUnreadSummary` being present while messaging is on but push is off. — **UNVERIFIED**
- No `npm run build`, `npm test` or web build was executed; this task is research/contract only.

## 17. Evidence

Saved under fleet run `20261126-154819-deepseek-cd61` evidence (local operator machine, not in the repo):

- `01-env-and-config.txt` — `readBoolean`, capabilities block, `MESSAGING_ENABLED` occurrences, `readWebPushConfig` (VAPID only when enabled).
- `02-app-wiring.txt` — `app.ts` reader/overview/messaging/operator registration, `index.ts` takeover-before-listen.
- `03-messaging-gate.txt` — all 11 routes, service constructor, `requireEnabled` call sites, Overview gate, capability projection, auth runtime capabilities, `MessagingReadPort`.
- `04-registry-and-migration.txt` — registry, state reader/projection, takeover, 074 CHECKs, migration tail.
- `05-sibling-075-collision.txt` — Warehouse W0 rows (075) and Accounting's 075 proposal, read via `git show` on the unmerged branches.
- `06-tests-blast-radius.txt` — 29 head-pinned test files, catalog count assertion, operator tests that encode `MESSAGING` as unknown, takeover and constructor call-site counts, the current capability-gate test.
- `07-sibling-package-crosscheck.txt` — excerpts from the sibling research files in this package (`01-prior-decisions.md` Q1–Q12, `02-runtime-gates.md` F4/F14/F17/F18) used to reconcile this contract.

Commands used (all read-only): `git rev-parse`, `git log`, `git show <branch>:<path>`, `git grep`, `grep -rn`, `sed -n`, `ls`, `wc -l`.
