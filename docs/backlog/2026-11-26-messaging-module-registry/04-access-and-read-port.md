# Messaging under the installation module registry — access paths and the job-cards read port

- **Date:** 2026-11-26
- **Repo state:** branch `claude/messaging-module-registry-2ef670`, HEAD `fca614b` (Thu Nov 26 15:39:48 2026 +0300). Worktree clean except this backlog directory.
- **Slice context:** move Messaging onto the MOD-002 installation module registry ([`DECISIONS.md` MOD-002, accepted 2026-11-26](../../../DECISIONS.md)), replacing the startup `MESSAGING_ENABLED` gate.
- **Answers:** research V4 (inline JobCard/user access SQL) and V6 (core tables carrying module FK columns) in [2026-11-25-core-modules-architecture-research.md](../2026-11-25-core-modules-architecture-research.md), plus §5 step 2 ("Messaging: participant access and reassignment behaviour verified; if needed, job-cards read port in the same slice").
- **Method:** source reading only. Test suites were **not run** (no `server/.env` → no `TEST_DATABASE_URL`; see Unverified).

## Summary

1. **A job-cards read port is not needed for this slice.** The registry move changes *where and when* `enabled` is read; it changes zero authorization SQL. Recommendation: defer, and if one boundary change is pulled in, export the existing private `actorCanReachJob` rather than build a port (finding 12).
2. **V4 under-counts the coupling.** V4 cites 5 inline reads; the module actually issues **26 SQL statements that touch 5 core tables** (`job_cards`, `users`, `customers`, `job_card_activity_logs`, `sessions`) — full inventory in finding 3.
3. **Participant access is decided by two facts together:** a persisted `conversation_participants` row **and** the live `job_cards.assigned_to` (STAFF only). MANAGER/ADMIN need neither membership nor assignment, only same-organization (finding 5).
4. **Reassignment A→B:** A loses access the instant `job_cards.assigned_to` changes (no participant-row deletion needed). B gains access **only** after the optional, client-initiated M9 `job-assignee-sync` POST (finding 7). If that offer is dismissed or fails, B stays outside the thread and nothing retries.
5. **The one runtime defect the registry slice must fix is not in the access path:** Overview's messaging read port and `messagingEnabled` flag are captured at startup (`app.ts:362-375`, `overview/service.ts:33`), so an operator enabling Messaging at runtime would never produce `messageUnreadSummary` (finding 2).
6. **Reverse dependency:** core never imports messaging code, but People/offboarding and People/user-deletion and demo-data read and write messaging tables with raw SQL. That is why offboarding keeps working when Messaging is off — preserve it (finding 10).

---

## 1. Registry lockdown — the sibling finding is correct (verified)

The registry is a closed set with exactly one key, in three places:

| Location | Content |
| --- | --- |
| `server/src/modules/installation-modules/registry.ts:7-15` | `InstallationModuleDescriptor` type literal `key: 'OVERVIEW'`, `capability: 'overviewDashboard'`, `legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED'` |
| `server/src/modules/installation-modules/registry.ts:17-24` | `INSTALLATION_MODULES` array with one entry |
| `server/src/modules/installation-modules/takeover.ts:22` | `legacy: { overviewDashboard: boolean }` — typed by capability, indexed at `takeover.ts:29` as `legacy[module.capability]` |
| `server/src/db/migrations/074_installation_operator_and_module_state.sql:59` | `CHECK (module_key IN ('OVERVIEW'))` on `installation_module_state` |
| `server/src/db/migrations/074_installation_operator_and_module_state.sql:87` | `CHECK (module_key IS NULL OR module_key IN ('OVERVIEW'))` on `operator_audit_events` |

Migration head is **074** (`server/src/db/migrations/`, 74 files) — the Warehouse W0 proposal (sibling research) also wants 075, so numbering must be sequenced by the lead, not by whichever session writes first.

Adding MESSAGING is descriptor-only on the code side; `OperatorService` is fully generic over `INSTALLATION_MODULES` (`server/src/modules/operator/service.ts:45-56, 126-134`), and the route validates keys through `findInstallationModule` (`server/src/modules/operator/routes.ts:159`). What is **not** generic:

- `takeover.ts:22` needs `messaging: boolean` in the legacy map (and `index.ts` must pass `config.capabilities.messaging`, `server/src/config.ts:910`). Today `legacy[module.capability]` would be `legacy['messaging']` → compile error, which is the desired fail-closed behaviour.
- Both 074 CHECKs need a migration.
- Two existing tests encode "MESSAGING is unknown": `server/tests/operator-pilot-postgres.test.ts:897` (`modules).toHaveLength(1)`) and `:1119` (`it.each(['MESSAGING', 'NOPE', 'OVERVIEW2']) … 404 NOT_FOUND`). Both must change deliberately, not be deleted silently.

Env/CI surface is already prepared by the Overview precedent: `MESSAGING_ENABLED` sits next to `OVERVIEW_DASHBOARD_ENABLED` in both examples (`server/.env.example:27-32`, `ops/examples/servora-med-staging.env.example:80-86`) and `ops/ci/verify-env-examples.sh:52-70` still requires it `true` in staging. Following MOD-002 §4 (env is a one-time takeover input) needs only the LEGACY comment, no CI change.

## 2. "Enabled" is read at startup today, twice — both must become per-request

| Where | Today | Effect |
| --- | --- | --- |
| `server/src/app.ts:521-529` | `if (dependencies.pool && config.capabilities?.messaging) register(messagingRoutes)` | Routes do not exist when off. A request gets Fastify's default 404 body (`{message, error, statusCode}`), **not** the app's `{error, code}` shape (`server/src/errors/index.ts:22-32`). |
| `server/src/modules/messaging/service.ts:116-122, 1086-1088` | `private readonly enabled: boolean` captured in the constructor; `requireEnabled()` throws `notFound()` (404) | Every service method re-checks a value that can never change after boot. |
| `server/src/app.ts:362-365` | `messagingReadPort` is only constructed when `config.capabilities.messaging` | With Messaging enabled later by the operator, Overview would never get a read port. |
| `server/src/modules/overview/service.ts:33, 71-84` | `messagingEnabled` ctor flag gates `messageUnreadSummary` | Same startup capture, second copy. |

The accepted Overview contract ([operator-module-pilot.md](../../features/operator-module-pilot.md) §7, accepted by MOD-002) fixes the target behaviour: **one `ModuleStateReader.read(key)` per request, no cache; disabled → the module's existing 404; missing row or read failure → `503`; no env fallback.** `ModuleStateReader.read` is already "one PK read per call" (`server/src/modules/installation-modules/state.ts:44-58`) and `readModuleEnabledOrFalse` (`state.ts:86-102`) is the "capability reports off, log the error" helper. Messaging has **no worker** to start/stop (no `onReady` hook, no worker file under `server/src/modules/messaging/`), so V7's worker clause does not apply here.

Newly required behaviour for this slice, beyond a mechanical swap: `requireEnabled()` currently collapses *all* states into 404. It must split **disabled → 404** from **unreadable → 503** (`MODULE_STATE_UNAVAILABLE`), matching `OverviewService.assertEnabled` (`server/src/modules/overview/service.ts:91-101`).

## 3. Full inventory — every messaging SQL statement touching a core table (26)

Re-verified against HEAD; the line numbers cited by V4 (`service.ts:170, 308, 340, 376, 1191`) have **not moved**. `A = server/src/modules/messaging/`.

`service.ts` — pool-level reads (9):

| # | Line | Core table | Purpose | Owning-module equivalent? |
| --- | --- | --- | --- | --- |
| 1 | `A/service.ts:169-173` | `job_cards.title` | Display title, M5 exact lookup | No narrow reader; widest: `PostgresJobCardRepository.findJobCard` (`job-cards/repository.ts:6000-6006`) returns the whole card |
| 2 | `A/service.ts:307-311` | `job_cards.title` | Display title, canonical create-or-get | same |
| 3 | `A/service.ts:340-343` | `users.name, is_active` | Resolve explicit participants before insert; blocks unknown/inactive | `PeopleRepository.getUser` (`people/repository.ts:633-639`) returns `name/isActive/role` — single row, pool only |
| 4 | `A/service.ts:361-365` | `customers.id, name` | CUSTOMER context must be same-org; supplies name | `CrmRepository.getCustomerDetail(actor, id)` (`crm/repository.ts:80`) needs a `CrmActor` and returns the full detail |
| 5 | `A/service.ts:375-379` | `job_cards.title` | Display title, new JOB thread | as #1 |
| 6 | `A/service.ts:1191-1193` | `job_cards.status, assigned_to` | `fetchJobAccess` — the input of every read/write authorization decision | **Rule** exists as `actorCanReachJob` (`job-cards/policy.ts:38-41`, **not exported**). **Data**: `getJob` (`repository.ts:3387`, tx), `findJobCard` (`:6000`), `getJobForUpdate` (`:3420`) |
| 7 | `A/service.ts:1234-1237` | `users.is_active, role` | Legacy pairwise re-auth of the counterpart | as #3 |
| 8 | `A/service.ts:1261-1264` | `job_cards.id, assigned_to` | Legacy pairwise JOB branch — **unreachable dead code** (see finding 9) | n/a |
| 9 | `A/service.ts:1286-1288` | `job_cards.assigned_to` | `validateJobContext`: JOB recipient must be the current assignee | Rule lives in job-cards assignment, no exported predicate |

`repository.ts` — pool-level (7):

| # | Line | Core table | Purpose | Equivalent? |
| --- | --- | --- | --- | --- |
| 10 | `A/repository.ts:374-380` | `conversation_participants ⋈ users` | Participant names / `isActive` in every conversation DTO | Own-DTO assembly |
| 11 | `A/repository.ts:410-412, 429-496` | `conversations ⋈ job_cards ⋈ customers ⋈ users` (2 laterals) | Conversation list projection **and** STAFF visibility filter `j.assigned_to = $2` | No; this is reach-rule copy **#2** |
| 12 | `A/repository.ts:546-558` | `messages ⋈ users` | `sender_name` in message list | Own-DTO assembly |
| 13 | `A/repository.ts:592-600` | `INSERT messages ⋈ users` | `sender_name` on send | Own-DTO assembly |
| 14 | `A/repository.ts:614-623` | `messages ⋈ users` | Idempotent replay read | Own-DTO assembly |
| 15 | `A/repository.ts:633-654` | `messages ⋈ conversation_participants ⋈ conversations ⋈ job_cards` | Unread aggregate with the same STAFF JOB filter | No; reach-rule copy **#3** |
| 16 | `A/repository.ts:725-731` | `users` | Recipient directory: same-org, active, `role='STAFF'` for JOB/CUSTOMER | `PeopleRepository.listUsers` has no role/context filter |

`repository.ts` — transaction (`PostgresMessagingTransaction`, 10):

| # | Line | Core table | Purpose | Equivalent? |
| --- | --- | --- | --- | --- |
| 17 | `A/repository.ts:770-775` | `job_cards … FOR UPDATE` | Lock the JobCard while membership changes, so a concurrent reassignment serializes | `getJobForUpdate` (`job-cards/repository.ts:3420-3431`) — same lock, wider row, separate class |
| 18 | `A/repository.ts:790-793` | `job_card_activity_logs` by id | Verify the immutable assignment-transition token | **None** — no reader outside job-cards |
| 19 | `A/repository.ts:809-816` | `job_card_activity_logs` latest `JOB_ASSIGNED` | Staleness / ABA rejection | **None** |
| 20 | `A/repository.ts:889-896` | `conversation_participants ⋈ users` | Roles for the post-mutation realtime audience | Own-DTO assembly |
| 21 | `A/repository.ts:904-907` | `users.role` | Only STAFF assignees may be synced | as #3 |
| 22 | `A/repository.ts:1017-1023` | `conversation_participants ⋈ users` | Participant list in the sync response | Own-DTO assembly |
| 23 | `A/repository.ts:1037-1045` | `conversation_participants ⋈ users` | Audience filter `u.role <> 'STAFF' OR u.id = $3` | No; reach-rule copy **#4** |
| 24 | `A/repository.ts:1163-1166` | `INSERT messages ⋈ users` | `sender_name` | Own-DTO assembly |
| 25 | `A/repository.ts:1180-1195` | `conversation_user_states` + `EXISTS (users … role IN ('ADMIN','MANAGER'))` | Auto-unarchive for management when a new message arrives | No |
| 26 | `A/repository.ts:1332-1364` | `web_push_deliveries ⋈ in_app_notifications ⋈ web_push_subscriptions ⋈ users ⋈ sessions` | Enqueue push for eligible recipients | Web-push module has near-identical eligibility SQL (`web-push/repository.ts:194, 486-487, 659`) but exposes no reusable reader |

Counts by core table: `job_cards` 9 statements (#1, 2, 5, 6, 8, 9, 11, 15, 17); `users` 15 (#3, 7, 10, 11, 12, 13, 14, 16, 20, 21, 22, 23, 24, 25, 26); `customers` 2 (#4, 11); `job_card_activity_logs` 2 (#18, 19); `sessions` 1 (#26). Messaging tables themselves are not counted.

### V6, verified for the messaging part

`server/src/db/migrations/018_messaging.sql:122-135` adds `realtime_events.messaging_activity_id` + FK + `UNIQUE` + the "exactly one activity source" CHECK to a **core** table; `:100-120` widens `in_app_notifications.entity_type/kind` with `'conversation'` / `'message.received'`. `server/src/db/migrations/025_messaging_context_ready.sql:36-48` puts `ON DELETE RESTRICT` FKs from `conversations` to `customers` and `job_cards`: a messaging row can block a core delete unless the conversation goes first. These are schema-level couplings that no read port changes.

## 4. What the owning modules actually expose today

Two established cross-module patterns exist; the DI port is the rarer one.

| Pattern | Example | Shape |
| --- | --- | --- |
| **Plain function taking a `Queryable`**, imported directly | `job-cards/occupancy.ts:91, 109` (`findStaffOccupancyConflicts`, `listStaffOccupiedIntervals`) imported by `calendar/repository.ts:20`, `people/offboarding.ts:11`, `job-cards/repository.ts:6`; `job-cards/assignment-history-sql.ts:24` imported by `reports/repository.ts:12` | `(q: Pick<PoolClient,'query'>, …) => Promise<…>`; works inside an open transaction. This is the SCH-001 shape. |
| **DI interface** wired in `app.ts` | `JobHistoryReadPort` (`job-cards/history-port.ts:65`) → `people/routes.ts:22`, `crm/routes.ts:18`; `WeeklyReportHistoryReadPort` (`weekly-reports/history-port.ts:65`); `MessagingReadPort` (`messaging/types.ts:146-148`) → `overview/service.ts:6,34` | Interface + optional constructor parameter; needs composition-root wiring and a test double. |

Consequences for the recommendation:

- There is **no** existing narrow function for "status + assignee of one JobCard", no reader for `job_card_activity_logs`, and no name-only customer reader.
- The reach **rule** is duplicated in job-cards (`policy.ts:38-41`) and messaging (policy + three SQL copies, above).
- Messaging is not an outlier: CRM also reads `job_cards` inline (`crm/repository.ts:114-120`), as do Calendar's reminder worker (`calendar/reminder-worker.ts:122`) and Reports (`reports/repository.ts:631+`). The codebase's chosen boundary is "modules own their tables; a *rule* gets one definition", not "all access goes through ports".

## 5. Participant access rules — who can read/write a JobCard conversation

Decision inputs: `isParticipant` (a `conversation_participants` row) and `jobAccess` (`job_cards.status`, `job_cards.assigned_to` fetched at `service.ts:1191`). The pure rule is `messaging/policy.ts:45-73`:

```
canReadConversation:
  non-STAFF: same-org && (non-JOB || job row exists && job.org == actor.org)
  STAFF:     isParticipant && (non-JOB || job.assignedTo === actor.id)
canSendMessage = canReadConversation && (non-JOB || !isTerminalJobStatus(job.status))
```

| Actor / state | Read JOB thread | Send | Code |
| --- | --- | --- | --- |
| STAFF, currently assigned, participant row | yes | yes, job non-terminal | `policy.ts:56-62`, `service.ts:567` |
| STAFF, **previously** assigned, participant row still present | **no** | no | `policy.ts:61-62` (row deliberately not deleted, `messaging-authorization-runtime.test.ts:249-250`) |
| STAFF, currently assigned, **no** participant row | no (403, list hides it) | no | `policy.ts:57`, `service.ts:567` |
| MANAGER / ADMIN, same org, any job | yes (no participant row needed) | yes, non-terminal | `policy.ts:47-55`, `service.ts:564-569` |
| MANAGER / ADMIN, other org | no | no | `policy.ts:50, 54` |
| Any role, terminal job | yes (history) | **no** (403) | `policy.ts:68-71` |

Non-JOB contexts: STAFF requires membership only; MANAGER/ADMIN are org-wide (`policy.ts:52-58`). Legacy **titleless** GENERAL keeps a pairwise policy: STAFF is allowed only when N=2 and the counterpart is an active ADMIN/MANAGER (`service.ts:580-590, 1227-1257`); N>2 for STAFF is fail-closed (`service.ts:585-587`).

Asymmetry worth knowing: MANAGER/ADMIN need no participant row to read or send, **but do need one** for `syncJobAssignee` (`service.ts:803-804` throws opaque 404 otherwise).

`getConversations` encodes the same rule in SQL (`repository.ts:410-412, 486-487`). List, unread count (`repository.ts:633-652`) and realtime audience (`:1037-1045`) are three independent copies of the rule that `policy.ts` states once; they agree today by construction, not by a shared definition.

## 6. Tests that prove the rules (names + locations)

All under `server/tests/`; none were executed here (task item 3: no `TEST_DATABASE_URL`; see Unverified).

`messaging-authorization-runtime.test.ts`
- `:154` `JOB active: assigned Staff participant can list, open, mark read and send`
- `:180` `JOB active: participant but unassigned Staff is denied everywhere`
- `:201` `JOB active: authorized Staff who is not a participant is denied`
- `:225` `JOB assignment change: stale Staff loses access without participant-row deletion` — asserts A denied, participant row preserved (`:249-250`), and the newly assigned B also denied (`:254-256`)
- `:260` `JOB terminal: authorized participants read; send is 403 for every role with no side effects` — also asserts zero new `messages` / `MESSAGE_SENT` rows (`:286-297`)
- `:301` CUSTOMER; `:323` titled GENERAL; `:345` legacy titleless GENERAL; `:369` N>2 JOB stale participant denied; `:426` unread aggregate excludes hidden JOB threads; `:491` creation regression

`messaging-m5-job-detail-lookup.test.ts`
- `:265` `F: newly assigned Staff who is NOT a participant gets 404 with zero metadata`
- `:282` `G: stale old Staff participant after reassignment gets 404`
- `:323` `J: terminal Job + authorized participant resolves 200 (readable)`
- `:337` `service-level: messaging disabled returns 404 and no metadata` — constructs `new MessagingService(pool, false)`, i.e. the **startup-flag pattern that this slice removes**; this test must be rewritten, not dropped

`messaging-m9-job-assignee-sync.test.ts`
- `:250` `rejects nonparticipant Admin/Manager with opaque 404`
- `:267` `performs A→B replacement with history, unread 0, one audit, one realtime event` (audience = admin + A + B, `:315`)
- `:321` `rejects stale old transition token after A→B→C→A→B (full ABA)`
- `:409` `replay after membership loss is denied`
- `:430` `terminal Job rejects sync with 409`
- `:454` `zero-delta returns 200 changed:false without new audit/realtime`
- `:487` `unrelated stale Staff membership is preserved` (and excluded from the audience, `:513-514`)
- `:518` `newly added Staff sees history with unread 0, next message unread 1`
- `:540` `replay after role change to STAFF is denied with 403`
- `:561` `concurrent identical transitions serialize to one mutation, one audit, one realtime event`

`messaging-org-wide-manager-rbac.test.ts`
- `:180` `O3/O4/O5/O6: empty-team MANAGER can open/read/send an existing canonical JOB conversation without being persisted as a participant`
- `:262` cross-org read/send denied; `:286` cross-org Job on create denied opaquely; `:341` `JOB recipient must be the current assigned Staff`

`staff-offboarding-postgres.test.ts`
- `:519-523` JOB conversation participants become exactly `[replacementB]`
- `:524-528` GENERAL conversation keeps the offboarded user's participant row

## 7. Reassignment A→B — exact timeline, and the gaps

Orchestration is **web-side, never server-to-server**: job-cards PATCH returns `assignmentTransitionId` (`job-cards/service.ts:4273-4280, 4434-4478`), the SPA offers the sync (`web/src/JobDetail.tsx:2754-2765`, `web/src/calendar/CalendarPage.tsx:386-393`), looks the thread up through M5, and posts `job-assignee-sync` (`web/src/jobs/useReassignmentConversationSync.ts:44-71, 73-100`; API `web/src/services/messaging-api.ts:237-241`).

| Moment | A (old assignee) | B (new assignee) | Thread state |
| --- | --- | --- | --- |
| Before PATCH | participant row + `assigned_to = A` → read/write | no row → nothing | normal |
| **PATCH commits** | **read and write lost immediately** (`assigned_to = B`), row still present | still no row → 404 on M5, 403 on read | readable only by MANAGER/ADMIN |
| Sync offer accepted | row deleted, removed from audience, gets `conversation.participants_changed` (`:895-897, 927-938`) | row inserted with `last_read_message_id = latest` → history, unread 0 (`service.ts:868-876`, `repository.ts:849-863`) | normal again |
| Offer dismissed / failed / page reloaded | row remains, access stays lost | no row, no path to gain one | thread silently stalls |

Gaps:

- **G1 — no recovery path.** The offer lives only in React state (`useReassignmentConversationSync.ts:38-42`) and is raised only right after a successful PATCH. A reload, a dismiss, or a 5xx leaves B outside forever: `createOrGetConversation` never mutates membership of an existing canonical JOB thread (`service.ts:293-331, 399-426`), and no participant-add endpoint exists.
- **G2 — lookup authority ≠ sync authority.** A non-participant MANAGER/ADMIN may *find* the canonical thread (M5 case D/E, `messaging-m5-job-detail-lookup.test.ts:236-264`) and is therefore offered the sync, but `syncJobAssignee` rejects non-participants with opaque 404 (`service.ts:803-804`, test `:250`). The SPA then shows "Atama güncellendi. Konuşma katılımcıları güncellenemedi." (`useReassignmentConversationSync.ts:95-99`).
- **G3 — the sync is the only way new Staff join**, and it requires the *latest* `JOB_ASSIGNED` activity id (`service.ts:838-843`), so any second reassignment makes the first offer permanently stale (test `:321`).
- **G4 — offboarding bypasses M9.** It inserts the replacement without the read marker (`people/offboarding.ts:1017-1021`), so the replacement sees the entire history as unread; it also skips the STAFF-only check and the transition token that M9 enforces. No test asserts unread after offboarding.

## 8. Terminal, cancelled, invalidated

`isTerminalJobStatus` = `COMPLETED | CANCELLED | INVALIDATED` (`job-cards/types.ts:23-25`, `job-cards/policy.ts:43-46`). Messaging uses it in exactly one place: send denial (`policy.ts:68-71`). Read stays open for all three.

- **INVALIDATED** additionally blocks *creating* a new JOB thread (`service.ts:262-268`, `409 JOB_NOT_OPERATIONAL`); an existing canonical thread stays readable.
- **Coverage gap:** messaging's own tests exercise `COMPLETED` only (`messaging-authorization-runtime.test.ts:142`, `messaging-m5-job-detail-lookup.test.ts:123`, `messaging-m9-job-assignee-sync.test.ts:440`). Cancelled/invalidated behaviour is derived from a shared predicate but is **not** covered by a messaging test.
- Invalidation does not change `assigned_to` (no assignment write in `job-cards/service.ts:1623+`), so the STAFF reach rule is unaffected.

## 9. Deactivated users, and one dead branch

- No `is_active` check exists in `canReadConversation` / `canSendMessage`. Enforcement is only at authentication: login and per-request session auth reject inactive users (`auth/service.ts:56, 90, 155`). Residual effects: inactive participants still render (`participantIsActive: false`), still receive **in-app** notifications (`repository.ts:1314-1322` has no active filter, unlike push at `:1351-1354`), and `syncJobAssignee` inserts the new assignee with only a role check (`repository.ts:900-908`), relying on the job assignment itself to have validated activity.
- Legacy-pairwise send *does* check the counterpart's `is_active` (`service.ts:1238-1242`), and new conversations reject inactive recipients (`service.ts:1218-1220`).
- **Dead code (behaviour-neutral):** the JOB branch of `reauthorizeSend` (`service.ts:1259-1277`) can never run, because the only caller is inside `isLegacyGeneralConversation` (`service.ts:580-587`) and that predicate requires `contextType === 'GENERAL'` (`policy.ts:41-43`). Statement #8 (`service.ts:1261-1264`) and the manager/admin no-op at `:1248-1250` are therefore dead. Per the research note "[dead] code is cleaned when the slice touches that file" (research doc, closing note under §5), this belongs to whoever edits that file next — not to the registry slice by default.

## 10. Reverse dependency — what core does to messaging (matters when Messaging is off)

Nothing under `server/src/modules/job-cards/` imports messaging. The couplings run these directions:

| Consumer | What it does | Evidence | Works when Messaging is off? |
| --- | --- | --- | --- |
| `app.ts` (composition root) | imports service/repository/routes, registers conditionally | `app.ts:87-89, 521-529` | yes (no route) |
| `overview` | `MessagingReadPort` type + `getUnreadCount` call | `overview/service.ts:6, 33-34, 70-84`; port built at `app.ts:362-365` | yes, but port is missing if enabled later (finding 2) |
| `realtime` | `realtime_events.messaging_activity_id` FK + "exactly one source" CHECK; pass-through in insert | `018_messaging.sql:122-135`; `realtime/repository.ts:15, 35, 91, 125-147` | yes (column nullable) |
| `people/offboarding` | raw-SQL participant transfer + `messaging_activity_logs` + `realtime_events`; reads `conversations` for the plan | `offboarding.ts:1002-1044`, `1136-1140`; test `staff-offboarding-postgres.test.ts:519-528` | **yes — required by research §4 item 4** |
| `people` user deletion | counts `messages`, `conversation_participants`, `conversation_user_states`, `messaging_activity_logs` as business history | `people/repository.ts:221-237`; test `people-repository.test.ts:249` | yes (raw SQL) |
| `demo-data` | locks/purges conversations, participants, states, activities | `demo-data/repository.ts:429-451, 643-653`; `analyzer.ts:426-437, 707-790` | yes (raw SQL) |
| `web` | nav, route guard, JobDetail action, M9 driver | `navigation-model.ts:92`, `route-access.ts:40`, `JobDetail.tsx:3764`, `JobConversationAction.tsx:91`, `useReassignmentConversationSync.ts` | yes — `offerSync` swallows the 404 and shows no prompt (`:49-56`) |
| `job-cards` | only *produces* `assignmentTransitionId` | `job-cards/service.ts:4273-4280, 4434-4478` | yes |

So the reassignment workflow is already correct with Messaging off, and offboarding is already correct — because it writes tables, not module code. Extracting messaging into a separate service later would need a **write** port for offboarding; that is not this slice.

## 11. Disable-semantics checklist derived from research §4 item 4

| Requirement | Messaging today | Action for this slice |
| --- | --- | --- |
| Data, FK, audit, idempotency preserved | rows untouched when off (route absence) | none |
| New requests/claims stop | route absent → 404 | keep 404 when disabled; add 503 when state unreadable |
| In-flight work may complete | no long-running claim in messaging | none |
| Workers | none | none |
| Offboarding still works | raw SQL | prove with an existing offboarding test, no change |
| SSE / replay / deep links / push follow the same visibility | producers stop; persisted events stay replayable within the SSE cursor window; already-enqueued `web_push_deliveries` keep draining while `WEB_PUSH_ENABLED` is on (`app.ts:490-520`) | decide whether an open `/messages` page redirects (Overview has one at §8, messaging has none) |
| Open SPA can re-fetch capability | `web/src/identity-revalidation.ts:1-60` already refetches `/api/auth/me` on focus/visibility | free, **if** `auth/me` computes `messaging` from module state (today from env, `config.ts:910` + `capabilities/service.ts:24-31`) |

## 12. Recommendation — defer the job-cards read port

**For doing it in this slice:** research §5 step 2 explicitly allows it; the service constructor and every runtime gate already change here; the reach rule has 4 copies inside messaging plus 1 in job-cards, and a single definition now prevents a later 5-file edit; SCH-001 is recent precedent that one core rule gets one reader.

**For deferring (wins):**

1. Scope: the registry move never changes an authorization outcome. All 26 statements behave identically with the module on or off — they only run when a request is admitted. Bundling a permission refactor increases risk on the property that must not regress.
2. YAGNI / research §4 item 2 ("narrow contracts come with the first real consumer"): the only consumer is the same module. A port would be a private refactor wearing an interface, plus DI wiring and a test double — the speculative layer AGENTS.md §1 rule 2 forbids.
3. Shape mismatch: a DI interface cannot express the `FOR UPDATE` read inside messaging's transaction (`repository.ts:770-775`). The correct primitive is a `Queryable` function (the `occupancy.ts` shape), which is not a port and does not need to ship with the registry move.
4. Timing: the slice already spans registry + takeover + two CHECKs + a migration + `auth/me` + Overview's port + web capability + ~4 test files. Two migrations may collide with the Warehouse W0 proposal (both want 075); a bigger slice makes that sequencing harder.
5. The inventories show the pattern is systemic (calendar, CRM, reports all read `job_cards` inline). Fixing it for messaging alone would create a one-off boundary, not an architecture.

**Recommendation: defer.** Do the registry move with zero changes to `messaging/policy.ts`, `service.ts` access reads, or the SQL inventory; prove the participant rules with the existing tests (plus a cancelled/invalidated variant if the reviewer wants the coverage gap closed).

**If one boundary change is pulled in anyway, this is the smallest correct interface — a function export, not a port:**

```ts
// server/src/modules/job-cards/policy.ts — make the existing private function public.
// Today: function actorCanReachJob(actor: JobCardActor, job: JobPermissionSubject)  (policy.ts:38)
export function actorCanReachJob(actor: JobCardActor, job: JobPermissionSubject): boolean;
```

Messaging would then keep `isParticipant` and the terminal-send rule and delegate only the reach half. This is behaviour-preserving because `conversations.organization_id` equals `job_cards.organization_id` by composite FK (`018_messaging.sql:16-18`, `025_messaging_context_ready.sql:36-48`), so `actorCanReachJob`'s org check is equivalent to messaging's conversation-org check, and `assigned_to` is `NOT NULL` (`002_delivery_tracer.sql:65`).

**Only if SQL dedup is also wanted later** (separate slice; these four modules would have to be its consumers before the abstraction earns its keep):

```ts
// server/src/modules/job-cards/access.ts
type Queryable = Pick<PoolClient, 'query'>;          // same shape as occupancy.ts:9

export type JobAccessSnapshot = Readonly<{
  organizationId: string;
  status: JobCardStatus;
  assignedTo: string;                                 // NOT NULL in the schema
}>;

export async function readJobAccess(
  q: Queryable, organizationId: string, jobCardId: string,
): Promise<JobAccessSnapshot | null>;

export async function lockJobAccessForUpdate(
  q: Queryable, organizationId: string, jobCardId: string,
): Promise<JobAccessSnapshot | null>;                 // replaces repository.ts:770-775
```

A `job_card_activity_logs` reader for the transition token (#18, #19) is a separate question and has no second consumer today.

### Minimal registry-slice boundary (for the implementer)

1. `registry.ts:7-24` — add `MESSAGING` (`label: 'Mesajlaşma'`, `capability: 'messaging'`, `legacyEnvKey: 'MESSAGING_ENABLED'`); widen the key union.
2. `takeover.ts:22` — `legacy: { overviewDashboard: boolean; messaging: boolean }`; pass `config.capabilities.messaging` from `index.ts`.
3. New migration — widen `074:59` and `074:87` to include `'MESSAGING'`; coordinate the number with the Warehouse W0 slice (head is 074).
4. `app.ts:521-529` — register routes whenever a pool exists; replace the ctor flag with a per-request reader; disabled → 404, unreadable → 503.
5. `app.ts:362-375` + `overview/service.ts:33, 71-84` — build the read port whenever a pool exists and gate `messageUnreadSummary` per request.
6. `auth/handlers.ts:31-34` + `capabilities/service.ts:24-31` — compute `capabilities.messaging` from the reader (same shape as `withOverviewDashboard`).
7. Tests to change deliberately: `operator-pilot-postgres.test.ts:897, 1119`; `messaging-m5-job-detail-lookup.test.ts:337`.
8. Env examples: keep `MESSAGING_ENABLED`, mark LEGACY (`server/.env.example:27-32`, `ops/examples/servora-med-staging.env.example:80-86`); `ops/ci/verify-env-examples.sh:68` unchanged.

## Open questions / owner decisions

1. **Migration numbering.** Who owns 075? Messaging needs one narrow migration (two CHECKs); the Warehouse W0 proposal wants 075 to widen the registry too. One shared "registry widening" migration is cheaper than two — needs a lead decision, not a session race.
2. **Is installation-wide messaging state acceptable?** `installation_module_state` has no `organization_id` (`074:49-66`). Env was process-wide, so this is parity, but it is the last chance to ask.
3. **Reassignment recovery (G1/G2).** Is "B joins only if the offer is accepted, otherwise never" the accepted product rule? It is enforced by tests `messaging-m5-job-detail-lookup.test.ts:265` and `messaging-m9-job-assignee-sync.test.ts:250` but written down in no decision record, and it lets a dismiss/5xx strand a thread. Options: allow a participant MANAGER/ADMIN to sync on the latest transition at any time; or derive STAFF read access from assignment alone and treat membership as notification preference. Both change authorization and need a decision record.
4. **Cancelled / invalidated coverage.** Only `COMPLETED` is tested. Confirm that "read yes, write no" is intended for `CANCELLED` and `INVALIDATED` too (it follows from `isTerminalJobStatus`, `policy.ts:70`).
5. **Deactivated participants.** Should `canReadConversation` / `canSendMessage` reject inactive actors and recipients directly (today only authentication does), and should inactive participants stop receiving in-app notifications (`repository.ts:1314-1322`)?
6. **Open-page behaviour on toggle-off.** Overview gets an explicit 404 → `/jobs` redirect (operator-module-pilot §8). Messaging has only the route guard (`route-access.ts:40`) and capability refresh; an already-open `/messages` page would just start receiving 404s. Decide whether this slice adds the redirect.
7. **Offboarding vs M9 invariants (G4).** Should `people/offboarding.ts:1002-1044` set `last_read_message_id` and enforce the STAFF-only rule, or should messaging expose a write function it calls? The first is two lines; the second is the write port that a future module extraction would need.

## Unverified

- **No test was executed.** `server/.env` does not exist, so `TEST_DATABASE_URL` is absent; per the task rules and AGENTS.md §9 the postgres suites cited above are **NOT RUN**. All behavioural statements come from source plus the named existing assertions.
- Whether any accepted document owns the messaging participant rules. No match for `grep -rn "messaging" SERVORA_MED_API_DRAFT.md`, `grep -rn "messaging\|Mesajlaşma" SERVORA_MED_MVP_SLICES.md`, or `grep -n -i "messaging\|mesajlaş" DECISIONS.md` (one incidental mention at `DECISIONS.md:2261`, not a policy). The rules therefore have **no accepted document owner**, only code + tests — which is the open question behind #3.
- V6's claim that `job_card_activity_logs` CHECKs were rewritten in 13 migrations was not re-verified; only the messaging-owned parts of V6 (`018:100-135`, `025:36-48`) were checked.
- Real-world timing of the M9 offer (e.g. whether any deployment currently dismisses it) is not measured; no telemetry was inspected.
- The Warehouse W0 migration proposal was not read beyond the brief's summary; the 075 collision is reported as a **risk**, not a confirmed plan.
