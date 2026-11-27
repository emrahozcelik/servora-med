# Messaging under the installation module registry — runtime disable / re-enable semantics

**Status:** research only. No source, test, migration or doc was changed. This file is the
deliverable.
**Date:** 2026-11-26. **Worktree:** `messaging-module-registry-2ef670`, HEAD `fca614b`
(merge of PR #514); migration head **074**; MOD-002 shipped in PR #511 (`89bf6b1`).
**Scope:** the 15 messaging-adjacent surfaces named by the task, measured against
`MESSAGING_ENABLED` today and against a future `installation_module_state` toggle.

**Method:** read-only code trace (`server/src`, `web/src`, `server/src/db/migrations`,
`server/tests`, `web/tests`) plus the accepted/draft governance documents. Every claim
below carries `file:line` or a document section. Anything not executed is marked
**UNVERIFIED** in §9.

---

## Summary

1. `MESSAGING_ENABLED` is read **once at composition**: when false, the messaging routes
   are never registered (`server/src/app.ts:521-530`) and the whole `/api/messaging/*`
   namespace is answered by the framework's own 404. The service additionally carries a
   404 gate (`server/src/modules/messaging/service.ts:1086-1088`) that HTTP never reaches
   in that configuration.
2. Nothing is deleted or mutated by switching off: messages, conversations, participants,
   read cursors, notification rows, realtime events, push deliveries and idempotency
   constraints are ordinary data and stay untouched.
3. Four surfaces are **not** connected to the flag at all today: the generic notification
   list/mark-read, the web-push dispatcher (it will still deliver queued `message.received`
   pushes), the SSE stream/replay, and Staff offboarding (it writes
   `conversation_participants` directly, `server/src/modules/people/offboarding.ts:1011-1041`).
4. The only **durable** disable defect is participant drift. Job reassignment sync is
   client-driven, not part of the JobCard transaction (`job-cards/service.ts:4486-4489` →
   web `useReassignmentConversationSync.ts` → `POST /job-assignee-sync`). If it cannot run
   while messaging is off, the **new** STAFF assignee is never added, and because STAFF
   access requires persisted membership *and* current assignment
   (`server/src/modules/messaging/policy.ts:56-62`), that person cannot open the canonical
   JOB thread even after re-enable. There is no UI path to replay it.
5. Recommended bundle (one coherent visibility decision): always-registered routes with a
   per-request module read → `404` disabled / `503` unreadable; `/api/auth/me` projects the
   capability; notifications stay visible and markable; SSE unchanged; already-queued
   message pushes are **abandoned** (`MODULE_DISABLED`), never sent and never replayed;
   participant reconciliation moves into the JobCard assignment transaction (core);
   offboarding, demo purge and backup/restore unchanged.
6. Re-enabling does nothing bulk: it flips one row, and the next request/identity refresh
   observes it. The only "burst" risk is held push deliveries (removed by the abandon rule)
   or a catch-up backfill (removed by moving participant sync to core).
7. Registry widening is mechanically larger than a key change: three compile-time couplings
   (`registry.ts:7-15,17-26`, `takeover.ts:20-24`, `index.ts:324-326`), two 074 CHECKs
   (`074:59`, `074:86-87`), the static test reader (`state.ts:69-80`), the staging env
   contract (`ops/ci/verify-env-examples.sh:58-70`) and `HEALTH_SCHEMA_VERSION`
   (`verify-env-examples.sh:40-47`). Both sibling research branches already claim migration
   **075** (`claude/warehouse-module-research-0e4def`
   `…/warehouse-module-research/06-first-slice-proposal.md` W0-3;
   `claude/accounting-module-research-0100ad`
   `…/accounting-module-research/01-codebase-touchpoints.md` §11.2 item 1); two `075_*.sql`
   files fail the catalog with `DUPLICATE_MIGRATION_NUMBER`
   (`server/src/db/migration-catalog.ts:99-105`) — the number must be reserved by whoever
   lands first.

---

## 1. What the rules are, and how binding they are

| Source | Status | What it actually says for this slice |
| --- | --- | --- |
| `DECISIONS.md` MOD-002 (`DECISIONS.md:3735-3788`) | **Accepted** (owner, 2026-11-26) | Registry + typed state + env takeover + fail-closed 503; §7 "pilot scope: only Overview moves; every other module keeps its env key until its own slice and contract" (`DECISIONS.md:3778-3779`). |
| `docs/features/operator-module-pilot.md` §5, §7, §8, §10 | **Draft contract**, implemented by PR #511 | §7: disabled → `404`; missing row / read failure → `503`; `/api/auth/me` reports capability false and logs; **"A request that already passed the gate may complete"** (`…pilot.md:156-161`). §8: focus/visibility revalidation (`:173-178`). Out of scope: Messaging (`:30-34`). |
| `docs/backlog/2026-11-25-core-modules-architecture-research.md` §4 item 4 (`:200-207`), §5 step 2 (`:227`) | **Research**, explicitly "not a decision" (`:3`), but the section is headed "Sol's corrections (accepted)" | Data/FK/audit/idempotency kept; new requests and **claims** stop; in-flight completion rule is module-specific; no bulk revival on re-enable; offboarding works while disabled; SSE/replay, notification list, deep links and push queue follow **one** visibility decision; open SPAs must be able to re-pull the capability. |
| `AGENTS.md` §7, §9, §5 | Binding engineering contract | Idempotency for important state, backend-owned policy, no weakened auth, tests required. |
| `DECISIONS.md` UI-002 (`:102-122`) | **Accepted** | The state row is typed and one-per-module; no generic settings bag. |

There is **no accepted `DECISIONS.md` record for module disable semantics** yet. The
implementing PR must write one (as MOD-002 did for Overview); until then §4 item 4 is
direction, not policy.

---

## 2. Verified facts about the switch as it exists today

**F1 — one read, at startup.** `server/src/config.ts:910` reads the flag via
`readBoolean` (`config.ts:318-323`: unset → `false`, strict `true|false`). It is consumed
in exactly four server places: `app.ts:362` (Overview's messaging read port),
`app.ts:374` (Overview service flag), `app.ts:521` (route registration),
`app.ts:526` (service constructor). Nothing reads it per request.

**F2 — false means the routes do not exist.** `app.ts:521-530` registers
`messagingRoutes` only when `config.capabilities?.messaging` is true. Fastify then answers
`/api/messaging/*` with its framework 404, which has no `code` field; the web client reads
`body.error` (`web/src/services/api.ts:103-108`), so a stale open tab would surface the
framework's English string rather than the Turkish `Sayfa bulunamadı.`
(exact body **UNVERIFIED**, §9).

**F3 — a second, dormant gate.** Every `MessagingService` entry point calls
`requireEnabled()` (`service.ts:130,149,197,550,732,737,747,784,965,1072,1080`), which
throws `NOT_FOUND 404 "Sayfa bulunamadı."` (`service.ts:42-44,1086-1088`). Only tests reach
it today (`server/tests/messaging-service.test.ts:66-77`).

**F4 — capability projection is static.** `/api/auth/me` overrides only Overview from the
module-state reader (`server/src/modules/auth/handlers.ts:31-34`,
`server/src/modules/capabilities/service.ts:24-29`); `messaging` stays the startup value.
The web consumes it in five places: nav (`web/src/shell/navigation-model.ts:92`), route
guard (`web/src/shell/route-access.ts:39-40`), router
(`web/src/AppRouter.tsx:396,407-408`), Job Detail action
(`web/src/JobDetail.tsx:3764`), and the action component itself
(`web/src/jobs/JobConversationAction.tsx:91`).

**F5 — data is untouched.** No delete/update path is triggered by the flag. Messaging
tables are ordinary rows (`server/src/db/migrations/018_messaging.sql`,
`025_messaging_context_ready.sql`, `026_messaging_participant_lifecycle.sql`).

**F6 — notifications are generic.** The notification list/unread/mark-read have no
messaging dependency (`server/src/modules/notifications/repository.ts:132-206`,
`…/service.ts:88-112`). Rows carry only `kind` + entity ids
(`server/src/modules/notifications/types.ts:67-72`); the human copy is static
(`…/presenter.ts:86-89,92-102`), so no message body is exposed by a notification row.

**F7 — the push worker is module-blind.** The dispatcher starts when
`WEB_PUSH_ENABLED` is true (`app.ts:487-518`); claims are filtered only by delivery state,
unread notification, active subscription, active recipient and live session
(`server/src/modules/web-push/repository.ts:690-728`). A queued `message.received`
delivery is therefore sent after a disable.

**F8 — SSE is module-blind.** The stream is always registered when the realtime service
exists (`app.ts:457-467`); replay authorizes by stored audience only
(`server/src/modules/realtime/repository.ts:83-102,175-202`). No messaging filter exists.

**F9 — offboarding writes messaging directly, unguarded.**
`OffboardingService.syncJobConversations` deletes/inserts `conversation_participants`,
writes a `PARTICIPANTS_CHANGED` activity and a realtime event inside the offboarding
transaction (`people/offboarding.ts:697,1002-1050`). No capability check exists anywhere in
that file.

**F10 — JobCard never touches messaging.** `server/src/modules/job-cards/*.ts` contains no
`conversation`/`messaging` reference. PATCH returns `assignmentTransitionId`
(`job-cards/service.ts:4273-4282,4486-4489`) and the browser decides to call M9
(`web/src/JobDetail.tsx:2755-2768` → `web/src/jobs/useReassignmentConversationSync.ts:43-79`
→ `web/src/services/messaging-api.ts:237-240`).

**F11 — messaging commands do not use `processed_actions`.** No reference in
`server/src/modules/messaging/**`. Idempotency is: `messages` unique `(conversation_id,
sender_user_id, client_action_id)` (`018:40-41`), `messaging_activity_logs` unique
`(organization_id, actor_user_id, client_action_id, action)` (`018:96-97`), plus the
`PARTICIPANTS_CHANGED` receipt read from `details` (`026:16-24`,
`messaging/service.ts:810-828`). `processed_actions` belongs to JobCard/offboarding
(`002:196`, `offboarding.ts:465-470`).

**F12 — the registry is still Overview-only.** `registry.ts:7-15,17-26` (`key:'OVERVIEW'`,
`capability:'overviewDashboard'`), `takeover.ts:20-24` (`legacy:{overviewDashboard}`),
`index.ts:324-326`, `074:59` (`module_key IN ('OVERVIEW')`), `074:86-87` (operator audit
`module_key` CHECK). `staticModuleStateReader(enabled:boolean)` returns the *same* state for
every key (`state.ts:69-80`), and `buildApp` derives it from `overviewDashboard`
(`app.ts:257-260`) — with two modules this would report messaging = overview.

**F13 — restore rewinds module state.** `docs/operations/backup-restore.md:242-246`:
`installation_module_state` and the operator audit return to the backup instant. A future
MESSAGING row inherits that behaviour.

**F14 — staging CI still pins the env flag.**
`ops/ci/verify-env-examples.sh:58-70` requires `MESSAGING_ENABLED=true` in the staging
example, and `:40-47` requires `HEALTH_SCHEMA_VERSION=<latest migration>` in both examples.

---

## 3. Surface-by-surface semantics

Legend: **D** = proposed behaviour when the operator disables, **R** = when re-enabled,
**Risk**, **Test** = does a test exist today. All proposals are for the future slice; they
are not implemented.

**Today's snapshot with `MESSAGING_ENABLED=false` (startup decision, not per request):**

| # | Surface | What actually happens today | Where |
| --- | --- | --- | --- |
| 1 | conversations/messages read | Routes not registered → framework 404; the auth pre-handler never runs | `app.ts:521-530` |
| 2 | message write (send/create/archive/read) | Same; no write path exists | `app.ts:521-530` |
| 3 | unread counts | `/api/messaging/unread-count` absent; Overview summary absent | `app.ts:362-364,374` |
| 4 | existing message notifications | Fully functional and listed | `notifications/repository.ts:145-182` |
| 5 | notification click | Marks read, then SPA redirects to `/jobs` | `NotificationCenter.tsx:225-229`, `AppRouter.tsx:407-408` |
| 6 | push queue + worker | Queued `message.received` deliveries are still claimed and sent | `web-push/repository.ts:690-728` |
| 7 | SSE live/replay | Unchanged; pre-disable envelopes can replay | `realtime/repository.ts:175-202` |
| 8 | deep links from other modules | Job Detail action hidden; push URL kept but redirects | `JobConversationAction.tsx:91`, `AppRouter.tsx:407-408` |
| 9 | JobCard assignment sync | Endpoint absent; participants drift | `messaging/routes.ts:27` |
| 10 | cancel/complete/invalidate | No messaging work at all | `grep` job-cards: no match |
| 11 | staff offboarding | Runs and mutates participants | `offboarding.ts:697,1002-1050` |
| 12 | demo purge | Runs; messaging tables are in the plan | `demo-data/repository.ts:443-451` |
| 13 | backup/restore | Full dump; state/audit rewind on restore | `backup/engine.ts:260-268`, `backup-restore.md:242-246` |
| 14 | idempotency rows | Untouched; messaging does not use `processed_actions` | `018:40-41,96-97` |
| 15 | in-flight requests | None exist: without the route, no request reaches the service | `app.ts:521-530` |

The table above is the authoritative "today" answer for `MESSAGING_ENABLED=false`; each
section below adds the code detail, the proposal, the risk and the test status.


### S1 — Reading conversations and messages

**Current (flag false):** routes absent → framework 404 for every read
(`app.ts:521-530`). With routes present, `getConversations` / `getMessages` /
`getJobConversation` / `getRecipients` each gate first
(`service.ts:130,149,747,1080`) → `404 NOT_FOUND`. No read-only mode exists.
**D:** keep routes always registered (Overview precedent, `app.ts:361-379`); per request
read the module state once; disabled → `404 NOT_FOUND "Sayfa bulunamadı."`; missing row or
read failure → `503 MODULE_STATE_UNAVAILABLE`
(`overview/service.ts:12-20,91-101`). Do **not** answer `200 {items:[]}`: an empty list is
a lie the UI renders as "no conversations" (`web/src/messaging/MessagingPage.tsx:257-269`
distinguishes error from empty). Web side: a messaging `404` must force one identity
revalidation (the existing single-flight `useIdentityRevalidation`,
`web/src/identity-revalidation.ts:52-63`) so the capability flips and the router redirects.
**R:** nothing to migrate; next request serves from the DB. No cache exists
(`state.ts:42-63`).
**Risk:** +1 PK read per messaging request; an open tab that already has the page mounted
shows the change differently per request: the conversation list renders the AppError text
(`MessagingPage.tsx:257-269`), while a thread load treats the same `404` as "membership
revoked" and silently clears the selection (`MessagingPage.tsx:349-359`). Overview solves
the former with a forced revalidation on 404 (`OverviewPage.tsx:108`); the messaging page
has no equivalent, so a module-off 404 is indistinguishable from a lost membership without
one. Adding the forced revalidation is part of this slice, not a nicety.
**Test:** unit gate only (`messaging-service.test.ts:66-77`); no HTTP-level disabled test,
no 503 test.

### S2 — Sending messages / creating conversations / archive / mark-read

**Current:** same gate at entry (`service.ts:197,550,732,737,965`). With the flag off the
route does not exist; with the gate, `404`. A request that passed the gate completes its
transaction and commits, including message + activity + realtime + notifications + push
(`service.ts:557-727,683-705`). Terminal JOB conversations additionally block sends
(`policy.ts:65-71`).
**D:** identical gate; no new writes. Keep `404`: `403`/`409` would create a second
"disabled" contract for the same condition and diverge from the existing gate and the
Overview precedent.
**R:** immediate. A client retry that was issued while off receives 404 even if the first
attempt committed; the message is durable and the client recovers it on the next list
fetch. That is acceptable but must be documented because the UI shows a send failure.
**Risk:** one message can land "after" the switch (S15). No partial state: message,
activity, notification and delivery are one transaction (`service.ts:557-727`).
**Test:** idempotency/authorization suites exist (`messaging-service.test.ts`,
`messaging-m7-concurrency-race.test.ts`); no disabled-write test.

### S3 — Unread counts and badges

**Current:** `/api/messaging/unread-count` is gated (`service.ts:1071-1073`). The Overview
card is conditional on the startup flag **and** on the read port being constructed
(`overview/service.ts:69-79`, `app.ts:362-364,374`). The notification-center badge counts
`message.received` rows because it is kind-agnostic
(`notifications/repository.ts:132-143`). Messaging's own totals are page-local
(`MessagingPage.tsx:166,273-275`); Overview renders "N okunmamış mesaj" with a link to
`/messages` (`web/src/overview/OverviewPage.tsx:145,362-367`).
**D:** messaging endpoint 404. Overview must omit `messageUnreadSummary` (treat as absent),
which requires **decoupling the port from the env flag**: construct
`PostgresMessagingRepository` whenever a pool exists and gate the call per request on the
module state, otherwise the summary disappears forever once the env key is retired.
Notification badge follows S4.
**R:** counts are computed live from stored cursors (`repository.ts:628-656`), so they
return to exactly the pre-disable truth; no counter to rebuild.
**Risk:** a missed Overview change shows a link to a 404 page — a visible "switch did not
work" symptom.
**Test:** none for the Overview summary; the messaging unread gate is unit-tested.

### S4 — Notifications already created for messages (list, mark-read)

**Current:** fully functional while messaging is off; no kind filter exists
(`notifications/repository.ts:145-182`). Mark-read also abandons the notification's pending
push with `READ` in the same statement (`repository.ts:77-91,184-206`). The row has no
message text (F6).
**D (recommended):** keep them listed and markable. They are user-owned history about an
event that happened while the module was on; hiding them would make re-enable "resurrect" a
batch of unread rows, which contradicts the no-bulk-revival rule (§4 item 4).
**D (alternative):** filter `kind='message.received'` out of list and counts when disabled.
Rejected as the default because it forces a per-request module read into the *core*
notification repository and creates the revival burst on re-enable.
**R:** unchanged list (no suppression gap to resolve).
**Risk:** activating a message notification while disabled marks it read and then lands on
`/jobs` (S5); the user may not understand why.
**Test:** generic notification suites plus
`web/tests/notification-center-visual-contract.test.tsx`; no messaging-disabled case.

### S5 — Notification click target and deep links

**Current:** click marks read, refreshes, then navigates to
`/messages?conversation=<id>` (`web/src/notifications/NotificationCenter.tsx:211-235`,
specifically `:225-229`). Push payload uses the same URL
(`server/src/modules/web-push/payload.ts:36-43`); the service worker allowlists exactly that
shape (`web/public/service-worker.js:1-14,85-115`). With the capability false the SPA route
redirects to `/jobs` (`AppRouter.tsx:407-408`); the documented production Caddy serves the
SPA with `try_files {path} /index.html` (`ops/caddy/Caddyfile.example:36-41`), so a deep
link is never an HTTP 404 — it is a client-side redirect.
**D:** keep the current redirect. Keep the service-worker allowlist unchanged so the URL
stays valid forever; do not rewrite or invalidate stored notification URLs.
**R:** works unchanged; conversation ids are stable because disable deletes nothing.
**Risk:** silent fallback to `/jobs` with no message; consider a one-line notice ("Mesajlaşma
modülü kapalı") when the redirect fires while the notification is a conversation kind.
**Test:** `web/tests/service-worker-click.test.ts` covers allowlist and exact-target focus;
no capability-redirect test for `/messages`.

### S6 — Web-push queue entries and the worker claim path

**Current:** deliveries are created only inside the message-send transaction
(`service.ts:697-704` → `messaging/repository.ts:1326-1366`). Once created they are claimed
by state/lease only (`web-push/repository.ts:690-728`), sent by
`dispatcher.ts:147-262`, and cleaned up on read/inactive/expired/24 h
(`web-push/repository.ts:636-676`).
**D (recommended: abandon, not hold, not send):** when the dispatcher processes a delivery
whose `notification.kind === 'message.received'`, read the messaging module state once; if
disabled, `guard.recordAbandoned({ errorCode: 'MODULE_DISABLED' })` instead of sending. If
the read **throws**, do not abandon — leave the row `CLAIMED` and let the lease expire
(`dispatcher.ts:251-257` already treats infrastructure failure this way), so a DB blip
cannot silently destroy pushes. No new deliveries can be created while disabled (sends are
blocked), so one sweep per cycle terminates. `last_error_code` is free text ≤ 80 chars
(`014_create_web_push.sql:84,103`), so no migration is needed. The reader already exists in
`buildApp` scope (`app.ts:257-260`), so wiring one into the dispatcher deps is local.
**Why not hold:** holding until re-enable produces a burst of up to 24 h of stale "new
message" pushes the moment the module is switched back on — a bulk revival and a confusing
operator experience. **Why not send:** the operator's intent is that messaging stops being
an active channel; a push 2 s after the switch looks like a failure.
**R:** nothing to flush. New messages create fresh deliveries normally.
**Risk:** a provider call already in flight may still be accepted while its row is
abandoned; `recordDelivered` requires `state='CLAIMED' AND lease_token=$2`
(`web-push/repository.ts:778-786`) and will return false. Bounded to the one batch in
flight at switch time; the user still has the in-app notification (S4).
**Test:** claim/lifecycle suites exist (`web-push-dispatch-postgres.test.ts:225-302`);
none covers a module-disabled decision.

### S7 — SSE live stream and replay/backfill

**Current:** no filter (F8). Messaging events are persisted per activity
(`realtime_events.messaging_activity_id`, `018:122-160`, `026:37-58`). While disabled there
is no producer, so no *new* messaging envelopes exist. Replay of pre-disable envelopes can
still reach a reconnecting client and trigger a refetch of a now-404 API.
**D (recommended):** leave the stream and replay untouched. Envelopes carry no message body
(`realtime/types.ts:68-74,87-97`); the only effect is a wasted refresh. Filtering would put
a per-replay module read into the core realtime repository for no security gain.
**R:** unchanged; nothing to backfill.
**Risk / pre-existing defects found while tracing this:** (a) replay authorizes by stored
audience, not current membership, so a removed participant can still receive old
`message.sent` *envelopes* (ids/timing only); (b) the web allowlist omits
`conversation.participants_changed` (`web/src/realtime/RealtimeProvider.tsx:34-53`), so a
participant sync never refreshes an open Messaging page; (c) offboarding publishes that event
with resource key `messaging` (`offboarding.ts:1039-1042`) while every subscriber listens on
`conversations`/`message-unread`/`conversation:<id>` (`MessagingPage.tsx:312`,
`jobs/JobConversationAction.tsx:79`). (b) and (c) must be fixed if participant sync becomes
server-side (S9), otherwise the thread stays stale until the next message.
**Test:** realtime service/repository suites; no messaging-disabled case, no web allowlist
test for the participant event.

### S8 — Deep links from other modules (JobCard detail)

**Current:** the Job Detail action is hidden twice, by capability
(`JobDetail.tsx:3764`) and by the component (`JobConversationAction.tsx:91`). Its lookup
`GET /conversations/job/:jobId` is gated and opaque-404s non-participants
(`service.ts:137-191`).
**D:** no server change; the capability projection (F4) hides the action. A tab with a stale
capability shows the action, gets a 404 on lookup, and the component falls back to
`start`/`none` (`JobConversationAction.tsx:57-78`) — with `canCreate` it would then fail on
click with the generic error (`:105-118`).
**R:** works; the canonical thread still resolves for participants and for
ADMIN/MANAGER org-wide (`service.ts:163-168`).
**Risk:** the stale-tab click path produces a dead button rather than hiding it; solved for
free by the capability refresh on focus (`web/src/identity-revalidation.ts:20-31`,
`web/src/App.tsx:225-233`).
**Test:** `messaging-m5-job-detail-lookup.test.ts`; no web test for the disabled action.

### S9 — JobCard-linked conversations: assignment / reassignment while disabled

**Current flow (all verified):** PATCH writes the `JOB_ASSIGNED` activity and returns its id
(`job-cards/service.ts:4273-4282,4486-4489`); the browser offers a sync immediately after
(`JobDetail.tsx:2755-2768`); the user confirms; M9 validates the immutable transition id,
"still the latest assignment activity", and `newValue.assignedTo === job.assigned_to`
(`messaging/service.ts:830-848`), rejects non-STAFF candidates (`:850-859`) and terminal jobs
(`:806-808`); the previous STAFF participant row is deleted (`:864-867`) and the new one is
inserted with `last_read_message_id = latest message` (`:868-876`), so history is readable
with unread 0 (test `messaging-m9-job-assignee-sync.test.ts:518-539`). Zero-delta returns
`changed:false` (`:878-884`).
**Access truth:** STAFF read requires membership **and** `job.assigned_to === actor`
(`policy.ts:56-62`); the list applies the same filter (`repository.ts:404-407,466`) and so
does the unread count (`repository.ts:647-654`). Therefore, the moment PATCH commits, the
old assignee loses access **even if the participant row is stale** — the stale row is not a
privacy leak. The damage is the opposite direction.
**Today, while disabled:** the sync endpoint 404s, the row is never updated. The new STAFF
assignee is not a participant → `getJobConversation` 404 (`service.ts:163-168`),
`listMessages` 403 (`service.ts:761-763`), conversation list hidden
(`repository.ts:404-407`), send 403 (`service.ts:567-569`).
**D (recommended): move reconciliation to core.** Perform the participant delta inside the
JobCard assignment transaction (a narrow messaging port, or the direct-SQL precedent already
used by offboarding at `offboarding.ts:1002-1050`), keyed on the `JOB_ASSIGNED` activity
itself. Then it runs regardless of module state, the client prompt and M9 endpoint become
redundant (or stay as an idempotent retry), and there is no catch-up to design.
**D (fallback B):** keep M9 client-driven, add a bounded catch-up at re-enable that
recomputes STAFF participants from `job_cards.assigned_to` with the same unread-0 marker.
This is a bulk mutation on re-enable, needs its own audit and idempotency, and would remove
*all* stale STAFF rows (a semantic extension of M9, which only removes the previous
assignee).
**D (not acceptable):** current behaviour. After re-enable the new assignee is permanently
locked out of the canonical thread — no UI offers the sync again, and a manager sending a
message does not add participants.
**R:** with A nothing; with B one bounded backfill (no notifications, no pushes).
**Risk (A):** job-cards writes messaging tables — a boundary decision that must be recorded
(OFFBOARDING already does this, so the pattern exists but is not formally owned). It must
preserve M9's security properties: STAFF-only candidates, terminal rejection, one audit +
one realtime event per effective delta, idempotent replay. ADMIN/MANAGER participants must
never be touched (M9 never touches them).
**Test:** M9 suite covers all of the above (`…m9…test.ts:234-660`); no test covers "sync
skipped while disabled", and no test asserts participant state after PATCH alone.

### S10 — Job cancel / complete / invalidate while disabled

**Current:** these commands never touch messaging (F10). A terminal JOB conversation keeps
its messages and participants; reads remain allowed for those who are participants *and*
still assigned (`policy.ts:56-62`); sends are blocked (`policy.ts:68-71`). Invalidated jobs
block new conversation creation (`service.ts:262-268`).
**D:** no messaging work. Participants are not pruned (same as today; see S11 for
offboarding).
**R:** nothing. A completed/cancelled job's thread is history and stays readable.
**Risk:** the previous assignee row remains on a terminal thread; harmless for access
(STAFF still needs `job.assigned_to === actor`), but it appears in the participant list as
a current member although that person no longer has Job access. Do not "clean up" on
disable — that would be destructive and is not required by §4 item 4.
**Test:** terminal-send rejection is covered in the messaging authorization suite; no
disable-specific test.

### S11 — Staff offboarding / deactivation while disabled

**Current:** STAFF deactivation is only possible through offboarding
(`people/service.ts:263-269`). Offboarding removes the target from the JOB conversations of
**active** jobs being transferred, adds the replacement, writes one activity and one realtime
event (`offboarding.ts:697,1002-1050`); the plan only includes jobs in
`NEW|ACCEPTED|IN_PROGRESS|WAITING_APPROVAL|REVISION_REQUESTED`
(`offboarding.ts:1086-1097`). Direct GENERAL/CUSTOMER threads are not touched — the test
asserts the offboarded user remains the sole participant of the direct thread
(`staff-offboarding-postgres.test.ts:520-528`). Permanent delete is blocked by any message
sent, any participant row, any `conversation_user_states`, any messaging activity, or any
realtime actor row (`people/repository.ts:220-241` → `USER_PERMANENT_DELETE_BLOCKED`
`people/service.ts:311-321`). MANAGER/ADMIN deactivation bypasses offboarding, leaving rows
with `is_active=false`; the participant list shows that flag
(`messaging/repository.ts:434-437`).
**D:** **works unchanged, by design.** No capability check exists and none should be added;
the research rule is explicit. Sessions are revoked and SSE streams are closed
(`offboarding.ts:438-441,475`).
**R:** nothing pending; rows moved during the disabled window are final.
**Risk / gaps to decide (not caused by disable):** (i) terminal-job conversations keep the
offboarded participant forever (plan filters by active status); (ii) the offboarded user
remains the only participant of GENERAL/CUSTOMER threads, so those threads become
manager-only; (iii) a deactivated MANAGER/ADMIN stays messageable in titled GENERAL/CUSTOMER
threads because `canSendMessage` never checks recipient activity (`policy.ts:65-72`) —
notifications are written, pushes are suppressed by the active-recipient join
(`web-push/repository.ts:711-713,644-660`).
**Test:** `staff-offboarding-postgres.test.ts:389-545` covers the active-job participant
transfer and the untouched direct thread; none covers terminal-job conversations or a
disabled-messaging context.

### S12 — Demo-data purge

**Current:** purge is a child-first table plan that includes
`web_push_deliveries → in_app_notifications → realtime_events → web_push_subscriptions →
conversation_user_states → conversation_participants → messages → messaging_activity_logs →
conversations` (`demo-data/repository.ts:443-451`), gated only by
`DEMO_DATA_CREATION_ENABLED` (`demo-data/service.ts:82-84`, `app.ts:542-551`).
**D / R:** unchanged; the purge must keep working while messaging is off (it is an
installation/cleanup operation, not a messaging feature).
**Risk:** none found; ordering already respects the FKs.
**Test:** `demo-data-purge-acceptance-postgres.test.ts:594` purges a full graph including
messaging; no case runs with messaging disabled (the flag is not consulted at all, so this
is low risk).

### S13 — Backup and restore

**Current:** backup is a full `pg_dump -Fc --no-owner --no-acl`
(`backup/engine.ts:260-268`), so every messaging table, `realtime_events`,
`in_app_notifications`, `web_push_deliveries` and `processed_actions` is included. Restore
revokes operator access and rewinds `installation_module_state` + operator audit to the
backup instant (`backup-restore.md:219-246`).
**D:** no special handling. **R:** no special handling.
**Risk:** an operator switch made after the backup is silently undone by a restore — the
module can reappear enabled or disabled. This is the accepted MOD-002 restore model; the
runbook already tells the operator to re-check the Overview switch (`backup-restore.md:245-246`)
and must be extended to every registry module. A pre-075 backup restored onto a 075 release
gets the MESSAGING row from the env value at the next startup takeover
(`takeover.ts:28-57`); the staging env says `true` (F14), so the effective state after
upgrade is **not** the operator's last choice — verify the DB row, never the env.
**Test:** backup/restore suites exist; none asserts module state after restore.

### S14 — Idempotency rows

**Current:** F11. Nothing module-specific to preserve beyond ordinary rows.
**D / R:** no cleanup, no rewrite, no TTL. A retry of a message whose first attempt
committed before the switch returns `404` while disabled and `200 isDuplicate` after
re-enable, because the unique key is still there (`018:40-41`,
`messaging/service.ts:610-635`). `CLIENT_ACTION_REUSED` semantics are unchanged.
**Risk:** a client shows "send failed" for a message that actually committed, and the retry
is refused while disabled. Acceptable; document it in the operator runbook ("in-flight
messages may still arrive").
**Test:** covered by the M7/M9 suites.

### S15 — Requests that already passed the gate

**Current:** the gate is the first statement of every method, before validation and before
`BEGIN` (`service.ts:550-557`). A request already inside completes and commits.
**D:** keep this. It is the accepted Overview rule
(`docs/features/operator-module-pilot.md:160-161`) and the module-specific in-flight rule
from research §4 item 4.
**R:** nothing.
**Risk:** one message + its notifications + its push + its SSE event can be produced after
the operator flipped the switch. The push is then swept by S6 on the next dispatcher cycle.
No mid-transaction abort, no partial writes.
**Test:** none; add a MODE test that flips the state between gate and commit (see §7).

---

## 4. Recommended coherent package

The research requires **one** visibility decision. The proposal that stays internally
consistent with the existing product is: *messaging content becomes unreachable; messaging
history artifacts that already exist stay where they are; nothing new is delivered; nothing
is deleted.*

| Surface | Disabled | Re-enabled |
| --- | --- | --- |
| `/api/messaging/*` | `404 NOT_FOUND` per request | next request |
| module state unreadable | `503 MODULE_STATE_UNAVAILABLE`; `/api/auth/me` false + log | next read |
| `capabilities.messaging` in `/api/auth/me` | false | true |
| nav / routes / Job Detail action | hidden + redirect to `/jobs` | restored |
| Overview `messageUnreadSummary` | omitted (0/absent) | recomputed live |
| message notifications (existing) | visible, markable | unchanged (no revival) |
| notification badge | still counts them (consistent with visible list) | unchanged |
| push deliveries already queued | abandoned `MODULE_DISABLED` | nothing to flush |
| SSE live / replay | unchanged | unchanged |
| participant reconciliation | runs in core (JobCard transaction) | no backfill needed |
| offboarding / demo purge / backup | unchanged | unchanged |
| idempotency rows | untouched | untouched |

One sentence resolves the apparent asymmetry between "notification stays" and "push is
cancelled": the **artifact** (the notification row, and therefore the badge) is preserved
because it records an event that already happened and contains no message content; the
**transports** (push, and in principle SSE) stop delivering while the module is off. SSE
needs no filter because it has no producer while messaging is off; push needs one because
rows enqueued before the switch still exist.

Why not "fully hidden" (filter notifications, filter SSE, drop pushes at production time):
it forces every core subsystem to read a product module's state, and it makes re-enable a
bulk revival of hidden unread material — exactly what §4 item 4 forbids.

Why not "read-only while disabled": it would require a second authorization mode in every
service method, contradicts the existing `requireEnabled()` contract and the Overview
precedent (`404`), and makes "off" mean two different things per module.

### 4a. Cross-check with the sibling slice-contract draft

`docs/backlog/2026-11-26-messaging-module-registry/05-slice-contract-draft.md` is a parallel
research draft (not accepted). Where it overlaps, this document agrees with:

- **DECISION-9** ("hidden entirely", data preserved, SSE/notification history unchanged) —
  same content/artifact split argued above.
- **DECISION-6** (keep message notifications; deep link redirects) — same as OD3 A.
- **DECISION-4** (no env ceiling) and **DECISION-3** (one per-request read; route-level
  `preHandler` is compatible with the "always register + gate" proposal here).
- **§7** in-flight completion and gate-before-idempotency — same as S14/S15.

Two differences to reconcile before freezing either document:

1. **DECISION-5 (push).** Its option A accepts a bounded 24 h tail of already-queued message
   pushes; its option B proposes the *operator toggle transaction* abandon them. This
   document's S6/OD4 is a third variant that avoids both the stale tail and the toggle
   writing into the core queue: **the dispatcher** reads the module state when it claims a
   `message.received` delivery and abandons it with `MODULE_DISABLED`. The toggle stays a
   two-table write; the worker owns the queue transition. If the owner prefers option A,
   the only cost is the stale tail; option C ("send, no gating") is the same thing without
   documenting it.
2. **§7's "reassignment sync is client-driven; nothing to disable on the server"** does not
   state the failure mode: with the endpoint 404ing, the new assignee is never added and
   cannot read the thread after re-enable (S9). OD6 must be decided before the contract is
   frozen; otherwise the slice ships a permanent access gap.


---

## 5. Prerequisites verified for the registry slice (not the main topic, but blocking)

| Item | Evidence | Change needed |
| --- | --- | --- |
| Registry key union | `server/src/modules/installation-modules/registry.ts:7-26` | add `MESSAGING` descriptor (label, `capability:'messaging'`, `legacyEnvKey:'MESSAGING_ENABLED'`) |
| Takeover signature | `…/takeover.ts:20-24`; call `server/src/index.ts:324-326` | widen `legacy` to `{overviewDashboard; messaging}`; the parameter type makes an omission a compile error, and a loosely typed omission would push `undefined` into the INSERT and stop startup |
| State row CHECK | `074:59` | migration alters `installation_module_state_module_key_check` |
| Operator audit CHECK | `074:86-87` | same migration alters `operator_audit_events_module_key_check` |
| Static test reader | `…/state.ts:69-80`; `app.ts:257-260` | must become per-key (map), otherwise unit tests report messaging = overview |
| Capability projection | `auth/handlers.ts:31-34`; `capabilities/service.ts:24-29` | add messaging to the runtime projection |
| Route registration | `app.ts:521-530` | always register; move the flag into the service after the per-request read |
| Overview read port | `app.ts:362-364,374` | construct regardless of env; gate per request |
| Operator UI | `web/src/operator/OperatorModulesPage.tsx:193-210` | no change (renders the API list); confirmation copy (`:44-50`) is Overview-worded ("sayfası") and should be module-aware |
| Staging env contract | `ops/ci/verify-env-examples.sh:58-70` | keep `MESSAGING_ENABLED=true` as the takeover input until the slice lands, then decide whether the gate should assert the DB row instead |
| Schema version | `verify-env-examples.sh:40-47` | bump both examples to the new head |
| Migration number | head is `074`; catalog rejects duplicates (`migration-catalog.ts:99-105`) | **075 is contested by two sibling research branches** (Warehouse W0-3, Accounting §11.2 item 1, read from `git show` on the local branches). Warehouse proposes a module-agnostic widening (five CHECKs, `FRESH_INSTALL` source, `MODULE_STATE_INITIALIZED`); if that lands first, messaging needs only a registry entry and no migration. Otherwise reserve 075 explicitly. Neither branch is an accepted contract. |

---

## 6. Open questions / owner decisions

**OD1 — Response shape for a disabled messaging read.**
A) `404 NOT_FOUND "Sayfa bulunamadı."` (recommended). B) `403`. C) `200` with empty items.
D) `503` for everything.
*Reason:* A is what `requireEnabled()` already does and what MOD-002 §7 chose for Overview;
it does not lie about emptiness and does not leak "this module exists but you lack it".
C breaks the Messaging page's error/empty distinction; B implies an authorization decision
that did not happen.

**OD2 — Behaviour when the module state cannot be read.**
A) `503 MODULE_STATE_UNAVAILABLE` on messaging routes, capability false in `/api/auth/me`,
error logged, no env fallback (recommended). B) Serve `404` (indistinguishable from off).
C) Keep the last known value (no cache exists; would require one).
*Reason:* A is MOD-002 decision item 5 (`DECISIONS.md:3774-3775`) and the Overview contract.

**OD3 — Existing message notifications while disabled.**
A) Keep them in the list, markable; the click redirects to `/jobs` (recommended). B) Hide
`message.received` from list and count. C) Keep but disable the click.
*Reason:* A needs zero core changes and avoids a re-enable revival burst; rows contain no
message content. C is a UX nicety that still needs a per-row capability check in a generic
component.

**OD4 — Already-queued message pushes.**
A) Abandon with `MODULE_DISABLED` when the dispatcher observes the disabled state
(recommended). B) Hold until re-enable. C) Send them (queued before the switch).
*Reason:* A matches "new claims stop", avoids a 24-hour stale burst on re-enable, and keeps
the in-app notification as the canonical record. B is a revival; C makes the switch look
broken to the operator. Requires one module-state read per claimed `message.received`
delivery; on read failure keep `CLAIMED` and retry, never abandon.

**OD5 — SSE live stream and replay.**
A) Unchanged; messaging envelopes carry no content (recommended). B) Filter messaging
events while disabled.
*Reason:* A is YAGNI and keeps the core realtime repository free of product-module reads;
B adds a per-replay state read for no privacy gain.

**OD6 — Job participant reconciliation.**
A) Move it into the JobCard assignment transaction (core), so it never pauses
(recommended). B) Keep M9 client-driven and run a bounded catch-up at re-enable.
C) Keep today's behaviour and accept that the new assignee may never regain the thread.
*Reason:* §4 item 4 requires membership/security facts to survive a disable; a module switch
must not create a permanent access gap for the current assignee. A removes the client-driven
security mutation entirely and matches the existing offboarding precedent; B is acceptable
only if A is rejected, and it must reuse M9's unread-0 marker and audit shape. C is a defect,
not a policy.

**OD7 — Offboarding participant cleanup scope.**
A) Status quo: move participants only for active jobs being transferred; leave terminal-job
and GENERAL/CUSTOMER threads untouched (safe, minimal). B) Additionally remove the
offboarded STAFF from terminal-job conversations. C) Also transfer/depopulate
GENERAL/CUSTOMER threads (needs a separate product decision; these threads have no ownership
model).
*Recommendation:* **B** if OD6 A or B lands, because assignment becomes the membership
source and a terminal thread with a stale member is the same defect in miniature; otherwise
**A** (do not extend this slice). C is out of scope here.

**OD8 — Read-only mode instead of full hide.** A) No: disabled = hidden API (recommended),
matching every other module. B) Yes: allow browsing history while writes are blocked.
*Reason:* B doubles the authorization surface and contradicts MOD-002 §7; if the customer
wants to keep history readable, that is a separate "archive" feature, not "module off".

**OD9 — In-flight message visibility.** A) Accept that one in-flight message may commit
after the switch (recommended, Overview precedent). B) Abort in-flight sends (requires a
second state read inside the transaction and a new error path). *Reason:* A is already the
accepted rule and the window is milliseconds.

---

## 7. Acceptance tests the implementing slice should add

Server (PostgreSQL where state is involved):

- `MODE-OFF-1` toggle off → every `/api/messaging/*` route answers `404` with
  `code=NOT_FOUND`; `/api/auth/me` returns `messaging:false`; no restart.
- `MODE-ON-0` toggle off → on → the same requests succeed again; unread counts equal the
  pre-disable values; no restart.
- `MODE-OFF-3` state row missing / reader throws → `503 MODULE_STATE_UNAVAILABLE` and
  `/api/auth/me` `messaging:false`; error logged; no env fallback.
- `MODE-OFF-4` message notification stays listable and markable while disabled; its pending
  push becomes `ABANDONED` with `READ` on mark-read (existing behaviour) and `MODULE_DISABLED`
  when the dispatcher sees the disabled state first.
- `MODE-OFF-5` a `message.received` delivery enqueued before the switch is not sent while
  disabled and is not sent after re-enable (abandoned).
- `MODE-OFF-6` a request that passed the gate commits exactly once even if the state flips
  mid-flight; a second send is `404`.
- `MODE-OFF-7` Job PATCH reassignment while disabled leaves the conversation's STAFF
  participants equal to the current assignee only (OD6 A), or the re-enable catch-up
  produces exactly that (OD6 B).
- `MODE-OFF-8` offboarding while disabled still moves participants for transferred active
  jobs and still revokes sessions.
- `MODE-OFF-9` demo purge while disabled deletes the full messaging graph.
- `MODE-OFF-10` restore rewinds the messaging state to the backup instant; a pre-075 restore
  takes over from env once and then ignores the env.
- `MODE-ON-1` re-enable creates no notification, no push and no participant mutation beyond
  the decided catch-up.

Web:

- `/messages` and `/messages?conversation=<id>` redirect to `/jobs` when the capability is
  false and render normally when it flips true after a focus revalidation.
- Job Detail hides the messaging action when the capability is false.
- The notification center keeps conversation notifications visible and the click ends on
  `/jobs` (no crash, no blank page).

---

## 8. Residual risks and notes for the implementing PR

- **Do not delete anything on disable.** All FKs are ordinary business relations
  (`conversations.job_id` is `ON DELETE RESTRICT` since 025:44-48); a cleanup would be
  irreversible and is not required.
- **`GET /conversations/job/:jobId` hardcodes `unreadCount: 0`** (`service.ts:187`); it is a
  lookup, not a badge. Do not "fix" it in this slice.
- **The operator confirmation copy is Overview-worded** ("sayfası … görünür olacak",
  `OperatorModulesPage.tsx:44-50`). With messaging, "off" also stops pushes and participant
  sync; the dialog should say so.
- **The staging env gate still asserts `MESSAGING_ENABLED=true`** (F14). After takeover this
  value no longer describes the effective state; staging/f4 acceptance must verify the DB
  row, exactly as the Overview pilot requires (`operator-module-pilot.md:191-192`).
- **Fix the participant event plumbing in the same slice** if OD6 A or B lands:
  add `conversation.participants_changed` to the web allowlist
  (`RealtimeProvider.tsx:34-53`) and align offboarding's resource key
  (`offboarding.ts:1039-1042`) with `conversation:<id>`/`conversations` used by the clients.
- **Two modules in one state table mean the static reader must become a map**
  (`state.ts:69-80`); otherwise unit tests silently model the wrong world.

---

## 9. Unverified

The sibling `075` claims were verified out-of-band with `git show` on the two research
branches (see §5); the rows below are what could not be executed or read.

| Claim | Why unverified |
| --- | --- |
| Exact Fastify 5 default 404 body and the string the web `ApiError` shows when messaging routes are absent | `server/node_modules` is absent in this worktree; inferred from `fastify@5.12.8` (`server/package.json:42`) and `web/src/services/api.ts:103-108`. Not executed. |
| That a real deployment sets `MESSAGING_ENABLED` to any particular value | Only repository examples were inspected: `server/.env.example:32` = false, `ops/examples/servora-med-staging.env.example:86` = true, and `ops/examples/servora-med.env.example` has **no** line (so a fresh production install defaults to off via `config.ts:318-323`). Host env/DB were not read. |
| That any UI test currently asserts the `/messages` capability redirect | Searched `web/tests`; no test names or assertions found for the redirect itself. |
| That `MESSAGING_ENABLED` is absent from every deployment env file | Only the three examples and `README.md:583` were inspected; hosts were not read. |

---

## 10. Evidence index (commands actually run)

All commands were read-only in the worktree root.

- `grep -rn "capabilities?.messaging" server/src web/src` → `app.ts:362,374,521,526`;
  `navigation-model.ts:92`; `route-access.ts:40`; `JobDetail.tsx:3764`;
  `JobConversationAction.tsx:91`.
- `grep -n "this.requireEnabled()" server/src/modules/messaging/service.ts` → 11 call sites
  + definition at `:1086`.
- `grep -rn "processed_actions" server/src/modules/messaging server/src/modules/notifications
  server/src/modules/web-push` → no matches.
- `grep -rn "conversation\|messaging" server/src/modules/job-cards/*.ts` → no matches.
- `grep -rn "assignmentTransitionId" server/src web/src` → key hits:
  `job-cards/service.ts:4273-4282,4434-4478`; `messaging/service.ts:779-958`;
  `JobDetail.tsx:2755-2768`; `useReassignmentConversationSync.ts:65`;
  `messaging-api.ts:237-240`.
- `sed -n '690,728p' server/src/modules/web-push/repository.ts` → claim query without any
  module/kind filter.
- `sed -n '219,246p' server/src/modules/people/repository.ts` → permanent-delete blockers
  include messages, participants, user states, messaging activity, realtime actor rows.
- `sed -n '1011,1042p' server/src/modules/people/offboarding.ts` → direct participant
  delete/insert + `PARTICIPANTS_CHANGED` + realtime event with resource key `messaging`.
- `sed -n '242,246p' docs/operations/backup-restore.md` → module state returns to the backup
  instant.
- `awk 'NR>=3735 && NR<=3788' DECISIONS.md` → MOD-002 status and decision items.
- `sed -n '152,178p' docs/features/operator-module-pilot.md` → 404/503/fail-closed §7 and
  web revalidation §8.
- `git show claude/warehouse-module-research-0e4def:docs/backlog/2026-11-26-warehouse-module-research/06-first-slice-proposal.md | sed -n '148,176p'`
  → W0-3 owns migration `075` (five CHECKs).
- `git show claude/accounting-module-research-0100ad:docs/backlog/2026-11-26-accounting-module-research/01-codebase-touchpoints.md | sed -n '496,506p'`
  → §11.2 item 1 also names migration `075`.
