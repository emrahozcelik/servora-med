# Messaging as an installation module — contract

Status: **draft contract, owner review** (2026-11-26). Not yet accepted. It does not
authorize implementation until the owner approves it. Once approved, it ships as
`DECISIONS.md` MOD-003 with the first implementing PR.

Inputs:

- Research package: [docs/backlog/2026-11-26-messaging-module-registry/](../backlog/2026-11-26-messaging-module-registry/README.md)
  (PR #518).
- Owner review of that package (2026-11-26): `RESEARCH_ACCEPTABLE —
  CONTRACT_REVISION_REQUIRED`. The decisions below follow that review.
- MOD-002 and the Overview pilot contract: [operator-module-pilot.md](operator-module-pilot.md).

Guiding rule (owner): **when Messaging is off, customers experience the installation as
if the module did not exist; technically, all history and data integrity are kept.**

Base: `origin/main` @ `fca614b`.

## 1. Delivery order

Four PRs, in this order. R0 is core work shared with other modules. MSG-001…MSG-003 are
Messaging work.

| Step | Scope | Migration |
| ---- | ----- | --------- |
| **R0** | Shared registry widening (§2). No new module entry. | 075 (owned by R0) |
| **MSG-001** | Messaging runtime module state: registry entry, takeover, API/capability, Overview, notifications, push, SSE, web, operator copy (§3–§8) | none |
| **MSG-002** | Participant lifecycle: later assignee sync, sync authority, offboarding read marker, inactive participants (§9) | none expected |
| **MSG-003** | Regression and production acceptance: off/on/off cycles, open sessions, concurrency, backup/restore, staging (§10) | none |

The job-cards read port (research V4) and a broader Messaging refactor are deferred.

## 2. R0 — shared registry widening

Goal: the registry and its tables accept further modules without another schema change.
The allowed module keys stay fixed in code and verifiable.

- **Descriptor:** `key` and `capability` are derived from the `INSTALLATION_MODULES` array
  (no hand-written literal unions). `legacyEnvKey: string | null`. New operator-facing
  fields: `description` (one Turkish sentence), `whenDisabled` and `preserved` (short
  Turkish lists for the operator dialog, §8). No prerequisites, dependency graph, worker
  hooks, menu metadata or dynamic loading.
- **Migration 075** (drop and recreate CHECKs, no data rewrite):
  - `installation_module_state.module_key` and `operator_audit_events.module_key`: shape
    CHECK `^[A-Z][A-Z0-9_]{1,31}$` instead of `IN ('OVERVIEW')`.
  - `installation_module_state.source`: add `FRESH_INSTALL`. It is used for a module without
    a legacy env key, starts off, and is aligned with the Warehouse W0 proposal.
  - `operator_audit_events.event_type`: add `MODULE_STATE_INITIALIZED`; its `new_value`
    must carry a boolean `enabled`, like `TAKEN_OVER`/`CHANGED`.
  - Partial index `operator_audit_events (module_key, occurred_at) WHERE module_key IS NOT
    NULL`.
- **Keys stay verifiable:** startup verification fails closed when
  `installation_module_state` holds a key that is not in the registry. A test pins the
  registry keys.
- **Takeover:** `legacy: Partial<Record<InstallationModuleKey, boolean>>`. A module with an
  env key is taken over once as today. A module with `legacyEnvKey = null` gets
  `enabled = false`, `source = FRESH_INSTALL` and `MODULE_STATE_INITIALIZED`. A missing row
  with either event present still stops startup.
- **Capability projection:** `withOverviewDashboard` becomes
  `withModuleCapabilities(capabilities, reads)`, with one primary-key read per registered
  module per `/login` / `/me`. Read failure → that capability `false` and an error log.
- **Pool-less test reader:** `staticModuleStateReader` accepts a per-key map. Existing
  boolean call sites keep working.
- **Tests:** OP9 no longer uses `MESSAGING` as its unknown key. The migration head moves
  to 075 in the head-pinning tests, and `HEALTH_SCHEMA_VERSION` is bumped in both ops env
  examples.
- R0 adds no module. Overview behaviour is unchanged (OP1–OP13 stay green).

## 3. MSG-001 — registry entry and state

- Descriptor: `MESSAGING` → capability `messaging`, label `Mesajlaşma`,
  `legacyEnvKey: 'MESSAGING_ENABLED'`.
- **Effective state = `enabled`.** There is no env ceiling, because Messaging has no
  secret or infrastructure in env. Web Push stays its own `WEB_PUSH_ENABLED` channel.
- Takeover follows MOD-002: the first start takes over the current `MESSAGING_ENABLED`
  value once, and after that the env key is legacy. The staging example keeps
  `MESSAGING_ENABLED=true` as the takeover input, with the CI check unchanged. The
  production example has no key, so a fresh production DB takes over `false`.
- `MESSAGING_ENABLED` gets the same legacy note in `server/.env.example` as
  `OVERVIEW_DASHBOARD_ENABLED`.

## 4. API and capability

- `/api/messaging/*` routes are **always registered**. One route-level gate
  (`preHandler` after `authenticate`) reads `MESSAGING` once per request:
  - enabled → continue;
  - disabled → `404 NOT_FOUND` ("Sayfa bulunamadı.") with the app error body;
  - row missing or read failure → `503 MODULE_STATE_UNAVAILABLE`, error logged, no env
    fallback.
- The constructor flag in `MessagingService` is removed.
- `/api/auth/login` and `/api/auth/me` project `capabilities.messaging` per request (R0
  projection).
- **Idempotent retry while disabled:** the gate runs before idempotency resolution, so a
  retry answers `404`. The stored receipt is untouched and replays normally after
  re-enable.
- A request that already passed the gate may complete. No mid-request re-read.
- **Overview:** the messaging read port is always constructed when a pool exists.
  `messageUnreadSummary` is included only when `MESSAGING` reads enabled for that request.
  When disabled or unreadable, the field is omitted and the Overview response still
  succeeds.

## 5. Notifications (hide, never delete)

- While `MESSAGING` is disabled, or its state is unreadable, notification rows with
  `entity_type = 'conversation'` are **excluded** from the notification list, the unread
  count and bulk mark-read operations. Rows are not modified or deleted.
- After re-enable, the rows are visible again with their original read state. No push and
  no realtime signal is produced for them.
- No new message notifications can be created while disabled, because sending is behind
  the gate.

## 6. Web Push (message deliveries stop)

- The dispatcher reads `MESSAGING` once per tick.
- **Disabled:** pending message deliveries (deliveries whose notification has
  `entity_type = 'conversation'`, state `PENDING`) are set to `ABANDONED` with
  `last_error_code = 'MODULE_DISABLED'` in the dispatcher's own transaction, and none are
  claimed. Other deliveries (jobs, tasks, reports, system) are unaffected.
- **Transition rule:**
  - A delivery already `CLAIMED` and being sent when the module is disabled may finish.
  - A message already delivered to a device cannot be recalled. Its click opens the app,
    and the app sends the user to the normal landing route because `/messages` is not
    available.
- **Read failure:** message deliveries are neither claimed nor abandoned in that tick;
  they are retried on the next tick. Other deliveries continue.
- **Re-enable:** abandoned deliveries stay abandoned. Nothing is sent in bulk.
- The operator toggle transaction does not write into the push queue. It writes only the
  module state and the operator audit.

## 7. Realtime (live and replay follow the module)

- Live delivery and replay both pass through the per-connection catch-up
  (`realtime/service.ts` `sendCatchUp` → `replayVisible`), so there is one filter.
- While `MESSAGING` is disabled or unreadable, messaging events (`conversation.created`,
  `message.sent`, `conversation.participants_changed`, entity `conversation`) are skipped,
  and the connection cursor **advances past them**. There is one module-state read per
  catch-up batch.
- After re-enable, events skipped while disabled are not replayed. Clients refetch from
  the API as usual.
- Other event types are unaffected. Rows in `realtime_events` are kept.

## 8. Web and operator panel

- The capability already drives navigation, the `/messages` route guard, the JobDetail
  conversation action and the reassignment sync offer. No new switch is added.
- Any messaging `404` from the page triggers one forced `/api/auth/me` revalidation. The
  existing `onOverviewUnavailable` becomes a shared `onModuleUnavailable`. If the
  capability turned off, the router leaves `/messages` for the landing route. If it did
  not, the existing "removed from conversation" handling stays.
- Notification Center needs no client filter, because the server hides the rows (§5). The
  service-worker allow-list is unchanged (§6 transition rule).
- **Operator panel:** each module card shows `description`. The confirmation dialog lists
  what the change turns off (`whenDisabled`) and what is preserved (`preserved`), and
  states "Veriler silinmez." For Messaging:
  - Turns off: Mesajlar menüsü, mesajlaşma erişimi, iş detayından mesajlaşma, mesaj
    bildirimleri ve Web Push teslimatı, okunmamış mesaj sayacı.
  - Preserved: konuşmalar ve mesaj geçmişi, arşiv ve audit kayıtları, personel devri ve
    offboarding işlemleri.
  - The enable dialog lists the same items as "açılır".
- UI work follows UI-001, DESIGN.md and PRODUCT.md, with UI-003 rendered evidence at
  390 px and 1440 px.

## 9. MSG-002 — participant lifecycle

- **Later assignee sync.** The canonical JOB conversation lookup reports
  `assigneeSync: { transitionId } | null`. It is non-null when the latest `JOB_ASSIGNED`
  activity names a STAFF assignee who is not a participant, and the job is not terminal.
  JobDetail then shows a persistent sync action, not only the one-time offer after PATCH.
  It reuses the M9 endpoint with that transition id, keeping M9's security properties:
  immutable transition id, STAFF-only candidate, terminal rejection, unread 0 on join,
  one audit row, one realtime event, idempotent replay. Assignment itself stays
  independent of messaging. There is no automatic membership sync (PR #131 rule kept).
- **Sync authority.** Owner decision pending (§12 Q2).
- **Offboarding replacement:** the replacement participant gets
  `last_read_message_id = latest message`, the same as M9, and only STAFF are inserted.
  Offboarding keeps working while Messaging is disabled.
- **Inactive participants:** no new in-app message notification is created for an
  inactive user. Their historical identity and messages stay visible.
- **Tests:** CANCELLED and INVALIDATED job conversations (read yes, send no); the client
  lifecycle of `conversation.participants_changed`.

## 10. MSG-003 — regression and acceptance

Server (PostgreSQL), MSG-001:

- MS1 Takeover: empty DB with env unset → off; env `true` → on; restart does not
  duplicate; env changes after takeover have no effect.
- MS2 Toggle off → every `/api/messaging/*` route returns `404` with the app error body;
  `/me` reports `messaging: false`; Overview omits `messageUnreadSummary`. All of this
  happens without a restart.
- MS3 Toggle on → all of MS2 reverses.
- MS4 Row missing or read failure → messaging `503`; capability false; Overview still
  `200` without the field.
- MS5 Idempotent retry while disabled → `404`; after re-enable the same `clientActionId`
  returns the stored result.
- MS6 Conversation notifications are hidden from the list, the unread count and bulk
  mark-read while disabled, the rows are unchanged, and they are visible again after
  re-enable.
- MS7 Dispatcher while disabled: pending message deliveries → `ABANDONED` /
  `MODULE_DISABLED`; other deliveries are delivered; a claimed message delivery
  completes; read failure leaves message deliveries untouched; re-enable sends nothing
  that was abandoned.
- MS8 SSE while disabled: live and replay skip messaging events and deliver other events;
  the cursor advances; nothing is replayed after re-enable.
- MS9 Offboarding while disabled transfers participants and writes its activity log.
- MS10 Operator toggle writes only state and audit, with the same version and conflict
  rules as OP7/OP8.

Server, MSG-002:

- MS11 Reassignment with the sync dismissed, or while disabled → the lookup reports
  `assigneeSync`; a sync with that transition id adds B (unread 0) and removes A; a second
  reassignment makes the older id stale (`409`).
- MS12 Offboarding replacement starts with unread 0.
- MS13 No in-app message notification is created for an inactive participant.
- MS14 Send is refused for CANCELLED and INVALIDATED job conversations; reading still
  works.

Web:

- A messaging `404` triggers one revalidation; a disabled capability leaves `/messages`;
  no request loop.
- Operator dialog shows description, effects, preserved items and "Veriler silinmez.";
  version conflict and error states keep working.
- JobDetail shows the persistent sync action when `assigneeSync` is set.

Acceptance (MSG-003): on staging, flip Messaging off and on twice from `/operator` with an
open customer session; verify menu, page, notifications, push and Overview each time.
Restore: state and audit return to the backup instant, and a pre-075 backup re-runs
takeover.

## 11. Docs updated with the code

`DECISIONS.md` MOD-003; this contract set to accepted; `operator-module-pilot.md` status
line (draft → accepted, research C6); `SERVORA_MED_SCHEMA_DRAFT.md` (075);
`SERVORA_MED_API_DRAFT.md` (operator module fields, messaging error contract,
`assigneeSync`); `server/.env.example` legacy note; `docs/README.md` row for Messaging.

## 12. Open questions for the owner

1. **R0 ownership.** Proposed: this Messaging session implements R0 as its own small core
   PR first, owning 075. The Warehouse, Accounting, Maintenance and Calendar sessions are
   told to build on it and not to write their own key migration.
2. **Sync authority (research G2).** Today any ADMIN/MANAGER can read the JOB conversation
   (#143), and so is offered the sync, but only a participant may perform it, so a
   non-participant manager gets an error.
   - **A (proposed):** any same-org ADMIN/MANAGER who can read the conversation may sync,
     in line with #143.
   - B: offer the sync only to participants.
