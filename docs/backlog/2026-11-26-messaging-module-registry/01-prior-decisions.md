# Messaging under the installation module registry — prior decisions, contracts and evidence

Baseline: branch `claude/messaging-module-registry-2ef670`, HEAD `fca614b` (merge #514),
migration head `074_installation_operator_and_module_state`. Research only; no source change.
Everything below is read from this checkout unless marked UNVERIFIED.

## Summary

1. **MOD-002 is the binding gate, and it explicitly excludes Messaging.** Only `OVERVIEW` moves in
   this decision; "every other module keeps its env key until its own slice and contract"
   (`DECISIONS.md:3778-3779`). The pilot contract repeats this and names Messaging as out of scope
   (`docs/features/operator-module-pilot.md:30-34`). A Messaging slice therefore needs a new
   accepted decision/contract, not just code.
2. **There is no `MSG-*` decision and no `docs/features/` messaging contract.** `DECISIONS.md` has
   zero `MSG-` sections; `SERVORA_MED_SCHEMA_DRAFT.md` and `SERVORA_MED_MVP_SLICES.md` mention
   messaging zero times; `PRODUCT_REQUIREMENTS.md` mentions messages once, only as retained
   historical attribution (`PRODUCT_REQUIREMENTS.md:51`). Ownership of messaging currently sits in
   the historical Phase U package (`PHASE-U-README.md:38`) and PR bodies.
3. **The only written "off" contract for Messaging is a historical plan section**: disabled mode
   blocks navigation, APIs, notification projection, SSE/message invalidation and the dashboard
   widget (`docs/superpowers/plans/2026-07-25-phase-u-servora-workspace.md:1276-1289`). Navigation,
   APIs, SSE, widget are implemented; **notification projection is not** (see C2).
4. **Today the switch is read once at startup**, in two independent places: route registration
   (`server/src/app.ts:521`) and the `MessagingService` constructor flag
   (`server/src/modules/messaging/service.ts:113-122`). A third startup capture feeds the Overview
   widget (`server/src/app.ts:361-376`). Only Overview is read per request from the DB.
5. **The registry is locked to one literal**: descriptor type and array (`registry.ts:7-24`), takeover
   signature (`takeover.ts:20-24,29`), `installation_module_state.module_key` CHECK (`074:59`) and
   `operator_audit_events.module_key` CHECK (`074:86-87`); the value-shape CHECKs (`074:104-119`) are
   key-agnostic. Widening needs a migration, and the head is `074`, so that migration is `075`.
6. **Messaging differs from Warehouse: the capability already exists.**
   `AuthenticatedCapabilities.messaging` (`server/src/modules/capabilities/types.ts:5`), its
   projection (`.../capabilities/service.ts:7-13`), web parsing (`web/src/services/api.ts:22,186`),
   nav (`navigation-model.ts:92`), route guard (`route-access.ts:40`) and the job-detail action
   (`JobConversationAction.tsx:91`) all exist. The work is state + gate, not capability naming.
7. **Migration 075 is contested.** An unmerged Warehouse research commit (`9104a34`, branch
   `claude/warehouse-module-research-0e4def`, NOT an ancestor of HEAD) proposes `075_*` that rewrites
   five CHECKs and adds `FRESH_INSTALL`/`MODULE_STATE_INITIALIZED`. A Messaging-only `075` would
   collide at the filename/number level and force a second rewrite (see §6, C8).
8. **Offboarding is already module-agnostic and must stay so.** It reads `conversations` in the plan
   and rewrites `conversation_participants`, `messaging_activity_logs` and `realtime_events` while
   offboarding, with no messaging flag (`people/offboarding.ts:1011-1046,1135-1153`). This satisfies
   the accepted disable-semantics direction; it also means "off" can never mean "no messaging tables".

## 1. Inventory

Status legend: **Accepted** = owner-accepted decision record; **Draft** = contract/plan not accepted
as policy; **Historical** = implementation-era record kept for traceability; **Evidence** =
observed code/data.

### 1.1 Accepted decisions

| ID / path:line | Status | Binding rule (quoted) | Implication for runtime on/off |
| --- | --- | --- | --- |
| `DECISIONS.md:3735-3789` MOD-002 | Accepted 2026-11-26 | "Only Overview moves in this decision. Every other module keeps its env key until its own slice and contract." (`:3778-3779`) | Messaging slice needs its own accepted decision + contract before implementation. |
| MOD-002 §3 `:3765-3769` | Accepted | "Their state is one typed row per module in `installation_module_state` (not a generic settings bag)"; changes audited in `operator_audit_events` same transaction. | Messaging state must be a typed row + `MODULE_STATE_CHANGED`, not a JSONB settings bag (UI-002). |
| MOD-002 §4 `:3770-3773` | Accepted | "afterwards the database is the only source and the env key is legacy. Env acts as a ceiling only for modules whose secrets or infrastructure live in env". | `MESSAGING_ENABLED` has no secret/infra prerequisite → takeover only, no ceiling (same reasoning as Overview, `operator-module-pilot.md:113-116`). |
| MOD-002 §5 `:3774-3775` | Accepted | "When module state cannot be read, the module's API answers `503` and its capability is reported as off; there is no env fallback." | A `MESSAGING` read failure must produce `503 MODULE_STATE_UNAVAILABLE`, not a silent off/404. |
| MOD-002 §6 `:3776-3777` | Accepted | Restore revokes operator sessions and deactivates operator accounts; "Module state and audit return to the backup instant" (`operator-module-pilot.md:186-189`). | A messaging toggle is rewound by restore; existing conversations are rewound with the whole DB. |
| `DECISIONS.md:3671-3733` SCH-001 | Accepted 2026-11-25 | "While the module is enabled … also count as occupancy. While it is disabled, they do not count and are never deleted." (`:3702-3704`) | Precedent for messaging off semantics: rows preserved, never deleted, effect returns on re-enable. |
| SCH-001 §6 `:3714-3717` | Accepted | "the calendar screen, manual entries, the reminder worker … remain part of the Calendar module" while core planning stays core. | Analogous split needed for messaging: which parts are core (offboarding, deletion blockers) vs module (UI, send, notifications). |
| `DECISIONS.md:102-122` UI-002 | Accepted | No "genel amaçlı `organization_settings` JSONB torbası"; canonical behaviour is not user-configurable. | Module state stays typed; messaging on/off is installation state, not an org setting. |
| `DECISIONS.md:2041-2050` MOD-001 §4 | Accepted | Existing notification-scoped durable web-push outbox "stays unchanged; it is not domain integration". | Do not turn messaging off into a durable event/outbox redesign. |
| `DECISIONS.md:2930-2951` U3-A | Accepted | Offboarded Staff cannot be reactivated. | Messaging participant rows of offboarded Staff remain historical; never reactivate to "fix" a thread. |

### 1.2 Contracts, plans, drafts

| Path:line | Status | Rule (quoted) | Implication |
| --- | --- | --- | --- |
| `docs/features/operator-module-pilot.md:3` | Draft marker (stale) | "Status: **draft contract**" while MOD-002 is Accepted and PR #511 merged. | Status line should be corrected in a future docs pass (C6). |
| `operator-module-pilot.md:30-34` | Draft contract | Out of scope: "other modules (Messaging, Calendar, Web Push, alerts, backup, demo data) and their display on the panel". | Messaging is deliberately deferred; do not treat the pilot as authorizing it. |
| `operator-module-pilot.md:104-126` §5 | Draft contract | Registry entry fields `key`, `label`, `capability`, `legacyEnvKey`; "One entry: `OVERVIEW`"; state CHECK `IN ('OVERVIEW')`. | The descriptor shape has no field for "module without env key" and none for worker/route hooks. |
| `operator-module-pilot.md:152-161` §7 | Draft contract | Disabled Overview keeps `404 NOT_FOUND`; unreadable state → `503`; "Overview routes stay always registered"; "A request that already passed the gate may complete." | Messaging routes are *not* always registered today → a runtime switch requires moving to always-registered + per-request gate. |
| `operator-module-pilot.md:163-178` §8 | Draft contract | Customer `/api/auth/me` revalidation on focus/visibility; 401 logs out; 5xx keeps identity; disabled Overview moves the open page to `/jobs`. | Implemented generically (`web/src/identity-revalidation.ts:20-30`), so a messaging change is picked up by an open session. |
| `operator-module-pilot.md:245-275` §12 | Owner-approved interfaces | `takeOverInstallationModules(pool, legacy: { overviewDashboard: boolean })`; `staticModuleStateReader` from `config.capabilities.overviewDashboard`. | Both are single-module-shaped; adding `MESSAGING` forces a signature/typing change (compile-time, not optional). |
| `docs/backlog/2026-11-25-core-modules-architecture-research.md:183-187` §4.1 | Accepted direction (research, "kabul edildi") | "Takvim ve mesajlaşma, kendi kapatma kuralları doğrulanmadan panele bağlanmamalı." | Messaging's disable rules must be verified *before* registry attachment — the core requirement of this task. |
| `...research.md:200-207` §4.4 | Accepted direction | "Veri, FK, audit ve idempotency kayıtları korunur… Offboarding, modül kapalıyken de çalışmalı. SSE/replay, bildirim listesi, derin bağlantılar ve push kuyruğu aynı görünürlük kararına bağlanır." | This is the checklist a messaging off contract must answer item by item. |
| `...research.md:227` §5 step 2 | Planned order | "Messaging: katılımcı erişimi ve yeniden atama davranışı doğrulanır; gerekiyorsa job-cards okuma portu aynı dilimde". | Messaging is the *next* slice after Overview; participant access + reassignment must be verified in it. |
| `...research.md:41-44` V4–V7 | Evidence-backed findings | V4 messaging reads `job_cards` by inline SQL; V5 offboarding writes 21 tables incl. `conversation_participants`; V6 core tables carry module vocabulary; V7 switching is startup-only. | Confirmed in this checkout (§3, §5). |
| `docs/superpowers/plans/2026-07-25-phase-u-servora-workspace.md:1276-1289` §8 | Historical plan | "Disabled mode blocks: navigation, APIs, notification projection, SSE/message invalidation, dashboard message widget." | The only explicit off-contract; partially implemented (C2). |
| `docs/superpowers/specs/2026-07-25-phase-u-servora-workspace-design.md:947-976` §16 | Historical spec | "disabled mode hides navigation and blocks server paths"; "production enablement requires a separate gate". | Capability model + enablement gate precedent. |
| `PHASE-U-README.md:38,158` | Historical | U3 = "Messaging and advanced dashboard analytics"; three flags incl. `MESSAGING_ENABLED` default false. | Delivery record for messaging. |
| `docs/operations/staging-contract.md:137` | Historical/operational | "`MESSAGING_ENABLED` \| `true` \| messaging capability (completed through M9 + UXA closeout; fail-closed)". | Staging value is `true`; a registry takeover would copy `true`. |
| `docs/operations/staging-acceptance.md:55-63` | Historical/stale | Pins "exactly the 41 canonical migrations" and head `041_*`. | Cannot be reused as the enablement gate without updating (C7). |
| `docs/features/staff-offboarding-terminal-integrity.md:11` | Accepted feature contract | "…Customers, Calendar, Reminders, messaging and session revocation continue through their existing paths." | Offboarding's messaging writes are contractual, not incidental. |
| `docs/features/staff-offboarding-weekly-report-ownership.md:23` | Accepted feature contract | Clarifies without "expanding list, Staff, messaging or tenant permissions." | No new messaging authority may ride on offboarding. |
| `docs/user-manual/servora-med-user-manual.md:60` | Current user manual | "**Mesajlar** \| `/messages` \| Mesajlaşma özelliği açıkken herkes" | User-facing copy already conditional; low change cost. |

### 1.3 Implemented schema (evidence, owned by migrations)

| Path:line | Rule | Implication |
| --- | --- | --- |
| `server/src/db/migrations/018_messaging.sql:1-98` | `conversations`, `messages`, `conversation_participants`, `messaging_activity_logs`; idempotent send `UNIQUE (conversation_id, sender_user_id, client_action_id)`; activity actions `CONVERSATION_CREATED`, `MESSAGE_SENT`, `READ_CURSOR_UPDATED`. | Messaging has its own audit table, not `audit_events`. Off must preserve it (and preserve idempotency keys). |
| `018:100-120` | `in_app_notifications` CHECK widened: `entity_type` gains `'conversation'`, `kind` gains `'message.received'`. | Core notification table carries messaging vocabulary (V6). Off must decide what happens to these rows. |
| `018:122-140` | `realtime_events` gains `messaging_activity_id` FK + one-of CHECK + `message.sent`, `conversation.created`. | Core realtime table carries messaging vocabulary; no new events when module off. |
| `026_messaging_participant_lifecycle.sql:14-48` | Adds `details` JSONB and `PARTICIPANTS_CHANGED`; adds `conversation.participants_changed` event type. | M9 reassignment audit/realtime path. |
| `029_messaging_conversation_archive.sql:6-24` | `conversation_user_states` per-user archive, separate from participants. | Archive state must survive an off/on cycle untouched. |
| `025_messaging_context_ready.sql:9-48` | `GENERAL`/`JOB`/`CUSTOMER` contexts; `job_id` FK `ON DELETE RESTRICT`; `customer_id` FK `ON DELETE RESTRICT`. | Conversations block JobCard/Customer hard deletion; messaging data cannot be treated as disposable. |
| `025:63-85` | Canonical invariant: one `JOB` conversation per JobCard (`UNIQUE (organization_id, job_id) WHERE context_type='JOB'`). | Re-enabling must not re-create threads; one thread per job forever. |
| `074:51-65,86-87,104-119` | `installation_module_state.module_key CHECK IN ('OVERVIEW')`; `operator_audit_events.module_key CHECK (… IN ('OVERVIEW'))`; value-shape CHECKs. | Hard blocker for any second key; needs `075`. |

### 1.4 Evidence (PRs, tests, captured UI)

| Reference | What it proves |
| --- | --- |
| PR **#511** (merged 2026-11-26 08:18Z, "installation operator and runtime Overview module state") | MOD-002 shipped with one registry entry; body lists "other modules (Messaging, Calendar, Web Push, …) on the registry" as **not covered**. |
| PR **#76** (merged 2026-07-28, Phase U3) | Introduced `MESSAGING_ENABLED` default false, the capability gate, `message.received`, `conversation.created`/`message.sent`, and the privacy contract: "Message body ONLY in thread endpoint… NO body in Web Push, logs, audit, or any summary"; "Capability fail-closed: messagingEnabled=false excludes summary from response". |
| PR **#117, #119, #123, #125, #127, #131, #143, #145, #170** (all MERGED) | M2 context model, M3 resource authorization, M5 job-detail thread, web-push deep link `/messages?conversation=<uuid>` (bodyless), M4 create flow, M9 assignee sync, organization-wide MANAGER/ADMIN RBAC, sender attribution, per-user archive. |
| `server/tests/messaging-service.test.ts:66-84` | Service-level gate: `new MessagingService(pool, false)` → 404 on list/unread; `true` → works. |
| `server/tests/messaging-m5-job-detail-lookup.test.ts:337` | "service-level: messaging disabled returns 404 and no metadata". |
| `docs/evidence/phase-u3-messaging-dashboard/README.md` (17 PNGs) | UI + privacy evidence at `b34aa7a`: bodyless notifications, deep link, 200 % reflow, no HTML injection. No messaging-off screenshots. |
| `docs/evidence/linked-follow-up-jobcards/f4/README.md:75` | A recorded acceptance env with `MESSAGING_ENABLED=false` (module off is exercised in some flows). |
| `web/scripts/r3b-jobcard-invalidation-acceptance.mjs:78`, `r4b-staff-offboarding-acceptance.mjs:75`, `jobcard-idempotency-response-loss.mjs:102` | Acceptance harnesses force `MESSAGING_ENABLED=true`. |
| `server/tests/migration-catalog.test.ts:125`, `server/tests/schema-check.test.ts:303-306` | Hardcoded "count 74 / head 074" — a new migration breaks these tests in the same PR. |

## 2. The only existing disable contract for Messaging, and its gaps

`docs/superpowers/plans/2026-07-25-phase-u-servora-workspace.md:1286-1289` lists five blocked
surfaces. Current state per surface:

| Surface | Contract says | Code today | Verdict |
| --- | --- | --- | --- |
| Navigation | blocked | nav link only when `capabilities.messaging` (`web/src/shell/navigation-model.ts:92`) | implemented |
| APIs | blocked | routes not registered when off (`server/src/app.ts:521`), service double-gates (`service.ts:1086-1088`) | implemented (startup-only) |
| SSE / message invalidation | blocked | producer only inside messaging service; no events generated when routes absent | implemented, but only because the producer cannot run |
| Dashboard widget | blocked | Overview gates on the **startup** flag and the existence of the read port (`app.ts:361-376`, `overview/service.ts:71-84`) | implemented, but **not** runtime-safe |
| Notification projection | blocked | notifications module has **no** capability check (`server/src/modules/notifications/{types.ts:32,40,presenter.ts:86-89,routes.ts}`) | **not implemented** (C2) |

Consequence: today's env-off already leaves historical `message.received` rows visible in the
notification center with a bodyless label, and their deep link `/messages?conversation=<id>` is
silently redirected to `/jobs` by the route guard (`web/src/AppRouter.tsx:396-408`). The Phase U plan
says this should have been blocked; it never was. A runtime switch makes this visible in both
directions (off→on and on→off) without a deploy.

## 3. Startup read vs per-request read (verified)

| Decision point | Where | Read when | Effect of a runtime toggle without code change |
| --- | --- | --- | --- |
| `MESSAGING_ENABLED` parse | `server/src/config.ts:910` | process start | none until restart |
| Messaging route registration | `server/src/app.ts:521-529` | `buildApp` (before listen) | `PUT /conversations/:id/messages` has no handler at all; enabling needs a restart because Fastify cannot add routes after listen |
| `MessagingService.enabled` | `server/src/modules/messaging/service.ts:113-122` | construction | every handler still throws 404 even if state says on |
| Overview messaging read port | `server/src/app.ts:361-376` | construction (`dependencies.pool && config.capabilities?.messaging`) | Overview `messageUnreadSummary` never appears after enabling at runtime |
| Overview module state | `server/src/modules/installation-modules/state.ts:52-61`; `auth/handlers.ts:28-34`; `overview/service.ts:91-101` | **per request** (one PK read, no cache) | works (the MOD-002 pilot behaviour) |
| Customer identity refresh | `web/src/identity-revalidation.ts:20-30` | focus / visibilitychange, ≥30 s apart | a toggled messaging capability is picked up by an open tab within the throttle |

Also verified: `staticModuleStateReader(enabled)` (`state.ts:69-79`) is **key-agnostic** and
`buildApp` builds it from `config.capabilities?.overviewDashboard` only (`app.ts:257-260`), so adding
`MESSAGING` without changing this makes pool-less unit tests report the Overview value for messaging
(trap, not a policy issue).

## 4. What a `MESSAGING` registry entry actually requires

1. `registry.ts:7-15` descriptor type: `capability` is the literal `'overviewDashboard'`; `legacyEnvKey`
   is the literal `'OVERVIEW_DASHBOARD_ENABLED'`. Both must widen; `key` is already derived from the
   array (`registry.ts:26`).
2. `takeover.ts:20-24,29`: parameter is `{ overviewDashboard: boolean }` and the loop does
   `legacy[module.capability]`. With a second capability this stops compiling — signature must become
   a keyed/partial map (the same conclusion Warehouse W0-2 reached independently).
3. `074:59` and `074:86-87` CHECKs must accept `'MESSAGING'`; `074:104-119` value-shape CHECKs are key
   agnostic and need no change.
4. `operator_audit_events` has `MODULE_STATE_TAKEN_OVER` / `MODULE_STATE_CHANGED` already; no new event
   type is needed for a module that *has* an env key.
5. `capabilities/service.ts:24-29` has only `withOverviewDashboard`; a second registry read needs a
   multi-key projection (two PK reads per `/api/auth/me`, accepted cost per `state.ts:45`).
6. `app.ts:521` must become "always register the routes, gate per request" to honour
   `operator-module-pilot.md:160-161`; otherwise disabling at runtime leaves a registered route that
   must be re-gated and enabling requires a restart.
7. `overview/service.ts:71-84` + `app.ts:361-376` must take the messaging flag and the read port from
   the registry read instead of `config.capabilities`.
8. Operator copy is generic (`web/src/operator/OperatorModulesPage.tsx:40-52`) and the page renders the
   server list (`:81-83,194`); no web change is required to *show* the row, but "…sayfası … görünür
   olacak" undersells messaging's surfaces (nav + job-detail action + Overview widget), see Q11.
9. A messaging slice needs no new `AuthenticatedCapabilities` field (it exists, `types.ts:5`) and no new
   web capability parsing (`services/api.ts:183-186` already reads it).

## 5. Cross-module surfaces an "off" decision must cover

| Surface | Evidence | Today's behaviour when messaging is off | Decision needed |
| --- | --- | --- | --- |
| Existing `message.received` notifications | `notifications/types.ts:32,40`; no capability gate in `notifications/*` | still listed, bodyless, click → `/jobs` | hide, keep, or annotate? (C2) |
| Web-push deep link | `web-push/payload.ts:41-43`; service-worker allowlist per PR #125 | no new payloads (no producer); already-delivered pushes still open `/messages` → redirect | accept or add a fallback page? |
| Push outbox | MOD-001 §4 (`DECISIONS.md:2049-2050`) keeps the notification-scoped outbox unchanged | no new message rows → queue drains normally | keep unchanged; no new mechanism |
| SSE / realtime | `018:122-140`, `026:44-48`; producer inside messaging service | no events | confirm replay/`Last-Event-ID` behaviour needs nothing |
| Overview unread widget | `overview/service.ts:71-84` | omitted from the response | must be driven by runtime state, not startup config |
| Job detail "Mesaj" action | `web/src/jobs/JobConversationAction.tsx:91` | hidden | confirm hidden, not disabled-with-explanation |
| Reassignment prompt | `web/src/jobs/useReassignmentConversationSync.ts:28-49` (client calls the M5 lookup then M9 sync) | lookup 404 → no prompt | job reassignment stays independent (already true) |
| Offboarding | `people/offboarding.ts:1011-1046` (writes participants/activity/realtime), `:1135-1153` (plan reads conversations) | **still runs and writes messaging rows** | keep; do not add a flag check (accepted direction §4.4) |
| Staff permanent-delete blockers | `people/repository.ts:220-238` reads `messages`, `conversation_participants`, `conversation_user_states`, `messaging_activity_logs` | blockers still apply | keep; a module switch must not shrink history blockers |
| Demo data | `demo-data/analyzer.ts:726,782-790`; `demo-data/repository.ts:433-450,652-653` | purge/plan still handles messaging tables | keep |
| Retention | no messaging retention/purge anywhere (grep: none in `server/src/modules/messaging`, `DECISIONS.md`, `PRODUCT_REQUIREMENTS.md`) | data lives until tenant delete (org delete cascades, `018:2-3`) or Customer/JobCard delete, which both `ON DELETE RESTRICT` (`025:36-48`) | Q6: define retention or state "none" explicitly |
| Audit | messaging writes `messaging_activity_logs`, not `audit_events` (`018:79-98`); operator changes write `operator_audit_events` (`074:67-119`) | switching is visible only at installation level | Q7: should an org-level audit/notice exist? |
| Idempotency | `messages` unique `(conversation_id, sender_user_id, client_action_id)` (`018:40-41`); `messaging_activity_logs` unique (`018:96-98`) | keys survive off/on | preserve; never clear on disable |

## 6. Migration, CI and the 075 collision

- Head is `074` (`server/src/db/migrations/`, verified). The catalog derives the head dynamically
  (`server/src/db/migration-catalog.ts`) but two tests hardcode it: "count 74 / last 074"
  (`server/tests/migration-catalog.test.ts:125`) and "dist catalog 74 head 074"
  (`server/tests/schema-check.test.ts:303-306`). A new migration updates both.
- `ops/ci/verify-env-examples.sh:59-70` asserts the **staging** example contains
  `MESSAGING_ENABLED=true`; the production example has no `MESSAGING_ENABLED` line at all
  (`ops/examples/servora-med.env.example`, only other `*_ENABLED` keys). So after takeover the CI
  assertion still passes on a fresh staging DB but becomes a check on a legacy key — it needs an
  explicit policy (keep as legacy input, as `OVERVIEW_DASHBOARD_ENABLED` is documented at
  `server/.env.example:27-31`, or retire it in the same PR).
- Duplicate numbers are a hard catalog error (migration-catalog invalid reasons include
  `DUPLICATE_MIGRATION_NUMBER`; test `migration-catalog.test.ts:406` expects DIVERGED).
- **Coordination risk (C8):** commit `9104a34` ("docs: warehouse/stock module research (W0/W1
  proposal)", branch `claude/warehouse-module-research-0e4def`, not an ancestor of HEAD) specifies
  `W0-3`: "Migration `075_*` — drop/recreate five CHECKs … (`installation_module_state_module_key_check`,
  `operator_audit_events_module_key_check`, `installation_module_state_source_check` (+
  `'FRESH_INSTALL'`), `operator_audit_events_event_type_check` (+ `MODULE_STATE_INITIALIZED`), and
  `operator_audit_events_module_value_check`)". The same document states Messaging and Calendar are
  the next two modules and that W0 is their prerequisite. Two sessions cannot both create `075`.
  Options: (a) messaging depends on W0's module-agnostic widening; (b) messaging ships its own narrow
  `075` and W0 becomes `076`; (c) messaging waits.

## 7. Documentation ownership gap

- `DECISIONS.md` has no `MSG-*` record (0 matches for `^## MSG`).
- `SERVORA_MED_SCHEMA_DRAFT.md` mentions messaging **0 times**; `SERVORA_MED_MVP_SLICES.md` **0
  times**; `PRODUCT_REQUIREMENTS.md` once (`:51`, retention of historical attribution);
  `SERVORA_MED_API_DRAFT.md` 3 matches, all in error/message prose (`:244,863,930`), none describing
  the messaging endpoints.
- `docs/README.md` (current owners index) has **no messaging row**; the only pointer is the historical
  Phase U package (`docs/README.md:52`).
- `docs/features/` contains **no** messaging contract (`grep -rl MESSAGING_ENABLED docs/features` → 0).
- Practical consequence: the participant/authorization/reassignment rules that §5 step 2 requires to be
  verified are documented only in PR bodies (#119, #143, #145, #131) and in code comments
  (`server/src/modules/messaging/policy.ts:6-26`). The behavior itself is precise:
  `canReadConversation` gives ADMIN/MANAGER same-org access without membership; STAFF requires
  membership and, for JOB threads, current assignment (`policy.ts:45-63`, `:65-73`).

## 8. Conflicts and drifts

| # | Conflict | Evidence | Severity |
| --- | --- | --- | --- |
| C1 | Task goal (runtime switch) vs MOD-002 §7 (only Overview moves until its own slice/contract) | `DECISIONS.md:3778-3779`; `operator-module-pilot.md:30-34` | Blocking process gate, not a technical one |
| C2 | Phase U plan says off blocks "notification projection"; code has no messaging capability check in notifications | plan `:1286-1289` vs `notifications/{types.ts:32,40,presenter.ts:86-89,routes.ts}` | Behaviour drift, already true under env-off |
| C3 | Pilot expects "routes stay always registered"; messaging routes are conditionally registered | `operator-module-pilot.md:160-161` vs `app.ts:521` | Design mismatch to resolve in the slice |
| C4 | Accepted direction "offboarding must work with module off"; offboarding writes messaging tables unconditionally | research `:205` vs `offboarding.ts:1011-1046` | Consistent in behaviour; risk is a future well-meaning flag check |
| C5 | Research text says "bugün `auth/me` yalnızca açılışta çağrılıyor"; revalidation now exists | research `:206-207` vs `web/src/identity-revalidation.ts:20-30` (PR #511) | Stale research sentence (behaviour improved) |
| C6 | `operator-module-pilot.md:3` still says "draft contract" | vs `DECISIONS.md:3735-3741` (Accepted) and PR #511 merged | Cosmetic, misleads readers about authority |
| C7 | `staging-acceptance.md` pins 41 migrations / head 041 | `docs/operations/staging-acceptance.md:55-63` vs head 074 (`migration-catalog.test.ts:125`) | Stale; cannot serve as the enablement gate |
| C8 | Two candidate `075` migrations (messaging narrow vs Warehouse W0 five-CHECK widening) | `9104a34` (not in HEAD) §W0-3 vs `074:59,86-87` | Coordination/merge conflict |
| C9 | `staticModuleStateReader` is key-agnostic; `buildApp` seeds it from `overviewDashboard` | `state.ts:69-79`; `app.ts:257-260` | Silent wrong value in unit tests once a second key exists |
| C10 | Operator switch copy is page-shaped ("sayfası … görünür olacak") while messaging also drives nav, job-detail action, Overview widget, notifications | `OperatorModulesPage.tsx:40-52` | UX wording, needs owner/design call |

Also noted but not a conflict: Overview's `messageUnreadSummary` is *silently omitted* on messaging
errors (`overview/service.ts:71-84` catches and drops) whereas the module-state contract asks for
fail-closed `503` per module; for messaging itself this must be decided explicitly (Q12).

## 9. Open questions / owner decisions

Items are referenced elsewhere as Q1–Q12.

1. **Disable semantics (central).** Does "off" mean (a) hidden + unwritable but conversation history
   readable by ADMIN/MANAGER through some path, or (b) hidden entirely (no read path, no export), with
   data preserved? SCH-001 (`:3702-3704`) and research §4.4 (`:200-207`) imply preserve-and-hide.
2. **In-flight requests.** Adopt the Overview rule "a request that already passed the gate may
   complete" (`operator-module-pilot.md:160-161`) for sends? If yes, a message can land after the
   operator flipped the switch — acceptable?
3. **Notification projection.** Keep existing `message.received` rows visible (status quo), hide them
   while off, or delete them? If kept, is a silent redirect to `/jobs` acceptable?
4. **Push queue.** Confirm no new mechanism: existing queued deliveries drain; the durable outbox is
   unchanged (MOD-001 §4). Any push already on a device will deep-link into a redirect.
5. **Offboarding during off.** Confirm it keeps rewriting participants and writing
   `messaging_activity_logs` + `realtime_events` (today it does), i.e. no capability gate is added.
6. **Retention.** No policy exists. Decide "none until tenant delete" explicitly, or define a period.
   Either way the slice must state it, because "off" must not imply deletion.
7. **Audit visibility.** Should an organization-visible signal exist when the operator hides messaging,
   or is installation-level `operator_audit_events` sufficient? MOD-002 §6 defers business-data
   operator actions; module state is installation-level today.
8. **Env after takeover.** Make `MESSAGING_ENABLED` a documented legacy input (like
   `OVERVIEW_DASHBOARD_ENABLED`) and relax `ops/ci/verify-env-examples.sh:59-70`, or keep the CI
   assertion as a staging-policy statement? A ceiling is not justified: messaging has no env secret or
   infrastructure prerequisite (MOD-002 §4; pilot `:113-116`).
9. **Sequencing vs Warehouse W0.** Messaging-first `075` or wait for the module-agnostic widening?
   This decides who owns the registry type, the takeover signature and the CHECK rewrite.
10. **Fresh-install default.** Takeover the env value (MOD-002 OP11 precedent) → staging DBs come up
    **on** (`staging-contract.md:137`), production example has no key → comes up **off**.
11. **Operator copy.** Is "`<Modül>` sayfası … görünür olacak" enough for messaging, or should the
    descriptor gain a short consequence line (nav + job detail + dashboard + notifications)? Note the
    pilot deliberately rejected menu metadata in the descriptor (`operator-module-pilot.md:107-108`).
12. **Error contract.** Match Overview: disabled → `404 NOT_FOUND`, unreadable → `503
    MODULE_STATE_UNAVAILABLE` (`operator-module-pilot.md:152-159`), or keep 404 for both? Today
    messaging-off is a router-level 404 with no body.

## 10. Unverified

- **Host state.** Whether production currently runs with `MESSAGING_ENABLED=true`, and how many
  `message.received` notifications exist there. The production example has no key, and README says
  default disabled (`README.md:583`), but no host was inspected.
- **Warehouse W0 landing.** Commit `9104a34` is on an unmerged branch
  (`claude/warehouse-module-research-0e4def`); whether W0 will land before, after, or instead of a
  messaging slice is unknown from this checkout. Treat its `075` claim as a proposal, not a fact.
- **Route-level disabled test.** No test builds the app with messaging off and asserts `/api/messaging/*`
  404 at HTTP level; only service-level 404s exist (`messaging-service.test.ts:66-84`,
  `messaging-m5-job-detail-lookup.test.ts:337`). Whether the registration gate is covered indirectly
  was not exhaustively audited.
- **Operator UI evidence in-repo.** PR #511 claims UI-003 screenshots at 390/1440 px, but no
  `docs/evidence/*operator*` directory exists in this checkout; the artifacts may live outside the repo.
- **Retention/backup specifics.** Backup includes messaging tables implicitly (full dump); per-table
  retention wording was not found anywhere, so "no policy" is an absence-of-evidence statement.
- **Line-number drift.** `research.md:41` cites `messaging/service.ts:170,308,340,376,1191`; in HEAD the
  `job_cards` reads are at `service.ts:170,308,376,1191,1262,1286` and `repository.ts:479,642,772`.
  The claim (inline SQL into `job_cards`) holds; the exact list differs.

## 11. Documents an implementation PR would have to update

| Document | Why |
| --- | --- |
| `DECISIONS.md` | New accepted record (e.g. MSG-001) or a MOD-002 amendment covering messaging off semantics; §3/§5/§7 of itself are the template. |
| `docs/features/` (new `messaging-module-registry.md`) | Messaging has no owning contract; participants, JobCard threads, notifications, offboarding, retention and acceptance must be written down. |
| `docs/features/operator-module-pilot.md` | Correct the stale draft status (C6) and reference the second module; do not silently extend its scope. |
| `SERVORA_MED_SCHEMA_DRAFT.md` §8.1 (+ new §8.2) | Documents `module_key CHECK IN ('OVERVIEW')`; must describe the widened CHECKs and any new source/event values. |
| `SERVORA_MED_API_DRAFT.md` §20 | Module list/PUT examples show only `OVERVIEW`; add the second key and any new error rows. |
| `docs/README.md` | Add the messaging owning row (today only the historical Phase U pointer). |
| `README.md:107,583` | `/messages` and `MESSAGING_ENABLED` are described as env capabilities. |
| `server/.env.example:26-32` | Add the legacy-takeover note used for `OVERVIEW_DASHBOARD_ENABLED`. |
| `ops/examples/servora-med-staging.env.example:80-86` + `ops/ci/verify-env-examples.sh:59-70` | Staging flag policy / CI assertion (Q8). |
| `docs/operations/staging-contract.md:137`, `docs/operations/staging-acceptance.md:55-63` | Flag table + enablement gate (already stale, C7). |
| `docs/user-manual/servora-med-user-manual.md:60` | Already conditional; may need a sentence about the operator switch. |
| `server/tests/migration-catalog.test.ts:125`, `server/tests/schema-check.test.ts:303-306` | Hardcoded head/count. |
| `PHASE-U-README.md` | Historical; only if the slice wants a forward pointer (do not rewrite history). |

## 12. Evidence bundle

Saved outside the checkout at
fleet run `20261126-154819-deepseek-48ba` evidence (local operator machine, not in the repo):

| File | Contents |
| --- | --- |
| `01-registry-and-074.txt` | `registry.ts`, `takeover.ts:20-57`, 074 CHECK excerpts, `state.ts:47-101` |
| `02-messaging-wiring.txt` | `app.ts` wiring (257-262, 361-376, 521-529), service constructor + gate, config/capabilities, auth per-request read |
| `03-cross-module-surfaces.txt` | offboarding writes/reads, people deletion blockers, notification kinds/presenter, push payload, web gating greps |
| `04-docs-and-ci-env.txt` | env examples (server/staging/production), `verify-env-examples.sh`, staging contract/acceptance, README rows |
| `05-prs-u3-and-mod002.txt` | PR #76 full body, merge timestamps for #76 and #511 |
| `06-migration-head-and-w0.txt` | migration list tail, hardcoded head/count tests, Warehouse `9104a34` W0-3 excerpt and ancestry check |

Commands used (all read-only): `grep -rn`, `sed -n`, `git log --all --grep`, `git show 9104a34`,
`git merge-base --is-ancestor`, `gh pr list --search messaging`, `gh pr view`. No build or test was run;
this task produces no code.
