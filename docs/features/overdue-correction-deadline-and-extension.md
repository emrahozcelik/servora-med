# Revision correction deadline and authorized deadline extension (OVR-5)

- **Status:** Accepted product contract — `DECISIONS.md` OVR-5 (owner: "Kabul, 5a
  başla", 2026-11-21). OVR-5a (readers, migration 066) shipped in PR #473; OVR-5b (writers, UI, migration 067) ships in the
  following PR #474. Both reached production together in one deploy of
  `4ef582d` on 2026-11-21 (migrations 066–068): the deploy workflow ships only
  the current `main` head, so the intermediate 5a-only repoint floor of §8
  never existed in production; fixes go forward.
  The owner chose the lateness direction on 2026-11-20 (item 1 "A + B": a
  correction deadline with a management-adjustable value; item 2 "A": the
  history is kept and the old obligation is ended) and answered the open
  questions on 2026-11-21: (Q1) the later of the original deadline and the
  correction deadline applies; (Q2) management picks a date-time, default
  24 hours, 1 hour to 14 days; (Q3) Staff cannot change the deadline fields of
  a job with open lateness and use the change request instead; (Q4) an
  extension that ends open lateness requires a reason. Revised the same day
  after the owner's design review (rollback compatibility, OVR-4 reminder
  cycle after an extension, atomic JOB-010 change-request resolution, patch
  instant after the lock, role-specific deadline-removal errors, started-job
  limit). Ships with the code.
- **Date:** 2026-11-21
- **Scope:** Stage 1 ("lateness correctness") of the owner's lateness plan:
  the submission deadline of a revision cycle, and what an authorized deadline
  move does to lateness that is already open. Quiet hours, new reminder kinds
  and lateness reports (stages 2 and 3) are out of scope.
- **Not solved here:** a started `PRODUCT_DELIVERY` / `SALES_MEETING` (or any
  job whose submission deadline is its planned interval) cannot get new
  submission time by an extension, because the planned interval of a started
  job is not editable and must not be rewritten after the fact (§4.10). A
  separate management-set *submission obligation deadline* for started jobs
  is a later decision (backlog), possibly linked to the JOB-010 change request.
- **Amends:** the OVR-2 locked decision "a deadline/schedule revision after a
  breach must not erase, mutate or close the prior incident; only a real
  lifecycle recovery closes one" (`server/src/modules/job-cards/overdue-incidents.ts`
  header). Evidence is still never erased or rewritten; a separate, reasoned
  *ending* is added next to recovery. JOB-006 §5 Staff schedule edits are
  narrowed for jobs with open lateness only. Earlier records are not rewritten.

## 1. Context (observed on `main` `b0d3341`)

1. **A revision cycle has no time of its own.** `REQUEST_REVISION` arms
   the next submission episode (N ≥ 2; N = 1 for legacy factless rows,
   migration 048) at the request instant
   (`service.ts` `activateNextSubmissionEpisode`,
   `job_card_submission_episode_activations`). The episode reuses the original
   effective submission deadline (`effectiveSubmissionDeadlineAt`, no episode
   input). When the revision is requested after that deadline, the scanner
   records `LATE_SUBMISSION` at the request instant on its next tick (≤ 60 s):
   Staff are late the moment they are asked to correct.
2. **A deadline move never ends open lateness.** A patch of `dueDate` /
   `scheduledAt` / `scheduledEndsAt` appends a schedule revision; open incidents
   of the old revision stay open (tests `deadline revision after breach
   preserves the old-revision incident`, B2 matrix). OVR-4 keeps reminding,
   the open-late list keeps counting, and the job shows "Devam eden gecikme"
   although management has granted new time.
3. **A deadline move carries no reason.** `overrideReason` is dropped
   (`service.ts` patch), schedule revision `source` is always `RESCHEDULE`, the
   activity is a generic `JOB_FIELDS_UPDATED`.
4. **Staff can move their own deadlines.** `EDIT_JOB_FIELDS` is available to the
   assigned Staff member outside `WAITING_APPROVAL` and terminal states
   (`policy.ts` `getAllowedJobActions`); only `SALE`, `WEEKLY_REPORT` (its
   `dueDate` is immutable for every role) and JOB-010 window jobs restrict
   deadline fields. Once (2) is fixed, an unrestricted
   Staff edit could end the Staff member's own lateness.
5. **After `START`, a phase deadline cannot move.** `scheduledAt` /
   `scheduledEndsAt` are editable only in `NEW` / `ACCEPTED`; in `IN_PROGRESS` /
   `REVISION_REQUESTED` only `dueDate` is editable, and `dueDate` is the
   submission deadline only when the job has no phase deadline.

## 2. Principles

- **Evidence vs. obligation.** An incident proves that a deadline was breached,
  when, and who was accountable. That fact is immutable. Whether the
  obligation is *still* late is a separate, current question. Ending an
  obligation never deletes, rewrites or recovers the evidence, and is never
  presented as on-time or successful completion.
- **Only management grants time.** Correction deadlines and extensions are
  management decisions with an actor, an instant and (for an extension that
  ends lateness) a reason. Staff never end their own lateness.
- **Lateness computation and notification delivery stay separate** (stage 2
  owns quiet hours).

## 3. Revision correction deadline

1. `REQUEST_REVISION` takes an optional `correctionDueAt` (ISO instant).
   Omitted → the server uses `reserved_at + 24 h`. Validation order:
   - **Syntax, before the intent claim and hashing:** a non-string, `null` or
     invalid instant → `400 VALIDATION_ERROR` with `fieldErrors.correctionDueAt`.
   - **Bound, under the 049 clock:** `reserved_at + 1 h ≤ correctionDueAt ≤
     reserved_at + 14 days`, checked in the reservation preflight
     (`assertLifecycleReservation`, against `reservedAt`) and again in
     finalize against `reserved_at`; never against the service clock. Outside
     → `400 VALIDATION_ERROR` with `fieldErrors.correctionDueAt`.
   - The bound is skipped when §3.4 applies (no original deadline).
2. The value is stored once on the episode activation row
   (`correction_due_at`), with the default materialized (never NULL for a new
   `REQUEST_REVISION` activation). It never changes afterwards.
3. **Effective submission deadline of an episode armed by `REQUEST_REVISION`
   with a stored `correction_due_at`** = `max(original effective deadline,
   correction_due_at)`, where the original effective deadline is today's
   formula under the current governing schedule revision. Equality is on time
   (first-late = effective + 1 ms), exactly as today.
4. If the job has **no** original effective deadline
   (`effectiveSubmissionDeadlineAt(...) === null`: no `scheduledEndsAt`, no
   `scheduledAt` except for `SALES_MEETING`, and no `dueDate`), it has no submission lateness today and keeps none: the server
   stores `correction_due_at = NULL`, ignores a syntactically valid supplied
   value (it still enters the request hash), and the UI does
   not offer the picker. A correction deadline never creates lateness where
   none existed.
5. Episodes armed by `WITHDRAW_FROM_APPROVAL` (any actor) and legacy
   activation rows (`correction_due_at IS NULL`) keep today's deadline.
6. The TypeScript and SQL deadline renderers stay single-owner
   (`overdue-incidents.ts`): the submission deadline gains an optional
   correction input/ref; the scanner candidates, the producers and the
   per-job snapshot all read the activation row of the episode they evaluate.
   - SQL must return `NULL` whenever the original deadline is `NULL`
     (PostgreSQL `GREATEST(NULL, x)` is `x`): `CASE WHEN (original) IS NULL
     THEN NULL WHEN correction IS NULL THEN (original) ELSE GREATEST(original,
     correction) END`, matching TypeScript.
   - The `LATE_SUBMISSION` scanner candidate query `LEFT JOIN`s
     `job_card_submission_episode_activations` on `(organization_id,
     job_card_id, episode_no = next episode)` (UNIQUE) and uses its
     `correction_due_at` in the first-late filter and ordering.
7. `JOB_REVISION_REQUESTED` activity metadata records `correctionDueAt`. The
   in-app notification keeps its static `job.revision_requested` text (the
   notification table has no payload); the job detail shows the deadline.
   The job DTO gains `correctionDueAt: string | null` = the **effective**
   deadline of the current submission episode (`max(original, stored)`) when
   that episode was armed by `REQUEST_REVISION` with a stored value and the job
   is `REVISION_REQUESTED` or `IN_PROGRESS`; otherwise `null`. Staff and
   management see it as "Düzeltme son tarihi" in the organization timezone.
8. **Idempotency:** the `REQUEST_REVISION` request hash includes
   `correctionDueAt` only when the client sent it (normalized instant), as the
   JOB-009/JOB-010 optional fields already do in
   `critical-action-request-hash.ts`. A request without it hashes exactly as
   today, so receipts recorded before this release keep replaying.
9. **UI:** the revision dialog (`JobDetail.tsx` and `WeeklyReportDetail.tsx`
   `JobWorkflowDialog` kind `revision`) gains a date-time picker prefilled with
   now + 24 h, the 1 h–14 d hint and the server field error; hidden when the job
   has no original deadline.

## 4. Authorized deadline extension ends open lateness

0. **Patch instant.** `patch()` samples its business instant (the existing
   injected service clock, OVR-2 clock discipline) **after** it holds the
   JobCard `FOR UPDATE` lock (users are locked first, ARC-003), not before the
   transaction as today (`service.ts` `const requestTime = this.now()` ahead of
   `executeTransaction`). That single instant drives every decision of the
   patch: time validation, the appended revision's `created_at`, the
   pre-mutation and post-revision MUTATION producers, the §4.1 boundary
   comparison, `ended_at`, and the §4.11 change-request `resolved_at`. A patch
   that waited behind another transaction is therefore judged at the moment it
   actually applies: a new deadline that has already passed by then is not
   treated as future.
1. **Trigger.** A MANAGER/ADMIN patch that changes `dueDate`, `scheduledAt` or
   `scheduledEndsAt` and appends a schedule revision. After the change, for
   each open incident (`recovered_at IS NULL AND ended_at IS NULL`) of type
   `LATE_START` (episode 1) or `LATE_SUBMISSION` (the current episode), the
   server evaluates that delay type's first-late boundary under the **new**
   revision (§3 included). If the boundary is **after** the patch instant, the
   obligation is no longer late: every open row of that (job, delay type,
   episode) — across revisions — is ended in the same transaction.
   Ending runs after `appendScheduleRevision` and before the post-revision
   MUTATION producers; when the new boundary is in the future those producers
   find nothing breached. Open `LATE_START` rows are inspected whatever the
   current status (`ACCEPTED`, or `NEW` after a reset by reassignment or
   reschedule). The JOB-010 reschedule rules (reset to `NEW`, new offer,
   `PAST_START_ACKNOWLEDGEMENT_REQUIRED`) run in the same transaction; any
   error rolls the ending back.
2. If the new boundary is still at or before the patch instant (for example a
   `dueDate` move on a job whose deadline comes from `scheduledEndsAt`, or a
   move that is still in the past), nothing is ended; today's B2 behavior is
   unchanged.
3. **Removing the deadline is not an extension (management).** A MANAGER/ADMIN
   patch that would make the boundary of an open incident `NULL` (for example
   `dueDate: null` on a `GENERAL_TASK` without phase times) is rejected with
   `409 OPEN_LATENESS_DEADLINE_REQUIRED` ("Gecikmesi açık işin son tarihi
   kaldırılamaz; ileri bir tarih seçin."). Removing a field that is **not** the
   open incident's governing deadline (for example `dueDate` on a job whose
   deadline is `scheduledEndsAt`) leaves every boundary unchanged: it is
   allowed, nothing ends (§4.2). Staff never reach this rule: §5 rejects any
   Staff deadline change on a job with open lateness first.
4. `APPROVAL_WAIT` is never ended by this path (it is management delay and has
   no schedule deadline).
5. **Reason.** When the change would end at least one incident, the patch must
   carry `deadlineExtensionReason` (trimmed, 1–500 characters); missing →
   `400 DEADLINE_EXTENSION_REASON_REQUIRED` with
   `fieldErrors.deadlineExtensionReason`, nothing is written. A reason sent
   when nothing ends is ignored and not stored, but its type and length are
   validated whenever it is sent (non-string or more than 500 characters →
   `400 VALIDATION_ERROR` with `fieldErrors.deadlineExtensionReason`). Deadline
   edits on jobs without open lateness stay reason-free as today.
6. **Ending record.** Per ended row: `ended_at` = the patch instant (the same
   instant as the appended revision's `created_at`), `ended_by_user_id`,
   `end_reason = 'DEADLINE_EXTENDED'`, `end_note` = the reason,
   `ended_by_schedule_revision_no` = the appended revision. Evidence columns
   (`deadline_at`, `breached_at`, accountability, `schedule_revision_no`,
   `source`) never change. Ending and recovery are mutually exclusive and
   one-way.
7. **Activity.** One `JOB_OVERDUE_ENDED_BY_EXTENSION` activity per patch, in
   the same transaction, with delay types, episode, old and new boundary and
   the reason in its metadata. `JOB_FIELDS_UPDATED` is still written for the
   field change. The event joins `JOB_CARD_ACTIVITY_EVENTS` (server `types.ts`
   and web `job-labels.ts`: "Gecikme, tarih uzatılmasıyla sonlandırıldı"), maps
   to `job.updated` in `realtime/event-mapper.ts`, and the activity presenter
   returns `{ kind: 'NONE' }` for it: the reason and incident facts stay in the
   management-only incident history.
8. **After ending.** A new deadline that later passes produces a new incident
   under the new revision (today's identity rule). A later lifecycle recovery
   (`START`, `SUBMIT_FOR_APPROVAL`, `CANCEL`) recovers only rows that are
   neither recovered nor ended.
9. **OVR-4 reminder cycle per obligation.** Today one automatic reminder and
   one escalation are recorded per (job, delay type, episode, kind)
   (`053` UNIQUE and the `ON CONFLICT` target in
   `insertOverdueNotificationDelivery`; discovery joins deliveries by
   episode). After an extension ends the episode's lateness and the new
   deadline passes, the new incident would never be reminded. The delivery
   identity therefore moves to the **canonical open incident** of the episode
   (earliest `breached_at` among open rows, as the worker already selects):
   - deliveries are unique per `(organization_id, incident_id, kind)`; the
     insert's conflict target and the existing-row lookup key on the canonical
     incident id;
   - a delivery of a kind is due for an episode only when **no** delivery of
     that kind references an incident of the same episode that is still open
     (neither recovered nor ended). Discovery and recheck use this rule, so a
     shift of the canonical row alone can never start a second cycle;
   - an ending (§4.1) closes the old canonical incident, so a later breach of
     the new deadline has a new canonical incident and starts a new reminder
     cycle (one reminder, one escalation, today's thresholds);
   - field changes that end nothing do not start a new cycle: a B2 row added by
     a still-past deadline move is not canonical (the earlier open row is), a
     title or description edit appends no revision, and a recovery closes every
     row of the episode;
   - manual reminders (`job_card_submission_reminders`) already reference the
     incident and are unchanged; their `SUBMISSION_NOT_LATE` guard uses the
     §6 definition of open.
10. **Known limit (unchanged by this contract).** After `START`, the phase
   deadline of `PRODUCT_DELIVERY` / `SALES_MEETING` / scheduled jobs cannot be
   moved, so their open `LATE_SUBMISSION` cannot be ended by an extension. This
   contract does **not** solve extending a started job; the revision
   correction deadline (§3) is management's only lever there until the
   backlog decision in the header.
11. **Resolving the Staff change request in the same patch.** A deadline move
   does not resolve an open JOB-010 change request by itself, and while that
   request is open automatic OVR-4 Staff reminders stay stopped (D1 §5). The
   management patch may therefore carry
   `changeRequestResolution: { changeRequestId, resolution: 'RESCHEDULED',
   note? }`:
   - accepted only from MANAGER/ADMIN and only when the patch appends a
     schedule revision; otherwise `400 VALIDATION_ERROR` with
     `fieldErrors.changeRequestResolution`;
   - `changeRequestId` must be the job's single `OPEN` request; any other id →
     `404 CHANGE_REQUEST_NOT_FOUND`, a request that is no longer open →
     `409 CHANGE_REQUEST_NOT_OPEN` (the codes `resolveChangeRequest` returns
     today). Nothing is written in either case;
   - only `RESCHEDULED`; `note` follows the `resolveChangeRequest` rules
     (optional, at most 2 000 characters);
   - it is resolved inside the patch transaction with the same effects as
     `resolveChangeRequest` (resolution, `resolved_by`, `resolved_at` = the patch
     instant, activity, Staff notification), after the job lock and in the same
     order (users → job card → change request);
   - the server never resolves a request that the patch did not name, and never
     resolves one implicitly; without the field the request stays open exactly
     as today. Idempotency comes from the patch's `expectedVersion`: a replay of
     the same patch fails with the existing version conflict and resolves
     nothing twice;
   - UI: when the job has an open change request and management changes a
     deadline field, the form shows a labelled checkbox "Personelin önerisini
     'Yeniden planlandı' olarak sonuçlandır" (checked by default, can be
     unticked); the request id comes from the loaded request, never guessed.

## 5. Staff cannot move deadlines of a job with open lateness

1. A STAFF patch that changes `dueDate`, `scheduledAt` or `scheduledEndsAt` on a
   job that, after the existing pre-mutation materialization, has an open
   `LATE_START` or `LATE_SUBMISSION` incident is rejected with
   `409 DEADLINE_CHANGE_REQUIRES_MANAGEMENT` ("Gecikmesi açık işin tarihini
   yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin."). The whole
   transaction rolls back; the scanner still records the breach on its own.
   The existing, stricter guards keep precedence (`SALE`, `WEEKLY_REPORT`,
   JOB-010 `CUSTOMER_TIME_MANAGEMENT_ONLY`, `JOB_NOT_EDITABLE`). This rule
   precedes §4.3: a Staff `dueDate: null` on a job with open lateness returns
   `DEADLINE_CHANGE_REQUIRES_MANAGEMENT`, never
   `OPEN_LATENESS_DEADLINE_REQUIRED`.
2. Staff self-created jobs are included. Jobs without open lateness keep
   today's Staff edit rights (JOB-010 window jobs keep their own stricter rule).
3. The job DTO exposes a server-computed `hasOpenOverdueIncident: boolean`
   (open `LATE_START` / `LATE_SUBMISSION`), like `hasOpenChangeRequest`. The UI
   disables Staff deadline fields when it is true and points to the change
   request; the backend remains the authority.
4. **UI surfaces.** No form edits `dueDate` today. `GeneralTaskEditForm` gains a
   `dueDate` date field. `JobScheduleEditForm` keeps editing the planned time in
   `NEW` / `ACCEPTED`. For management, the extension reason field appears when
   `hasOpenOverdueIncident` is true **or** after the server answers
   `400 DEADLINE_EXTENSION_REASON_REQUIRED` (the scanner may not have ticked
   when the page loaded); the entered values are kept.

## 6. Consumers of "open"

"Open" becomes `recovered_at IS NULL AND ended_at IS NULL` everywhere a
current state is derived: OVR-4 discovery and recheck (with the per-incident
delivery identity of §4.9), the per-job
submission-lateness snapshot, the management open-late list, the manual
submission reminder guard (`SUBMISSION_NOT_LATE`), `hasOpenOverdueIncident`,
and recovery (`recoverOverdueIncidentEpisode` adds `AND ended_at IS NULL`;
otherwise the exclusivity CHECK would fail the lifecycle transaction).
Incident history (management-only) shows ended rows with
"Tarih uzatılmasıyla sonlandırıldı", the instant, actor and reason. The history
item gains `endedAt`, `endedBy {id, name} | null`, `endReason`, `endNote`,
`endedDurationSeconds` (ended − breached); `totalDelaySeconds` stays `null`
for ended rows (never a recovery or on-time result), and reminder statistics
stop at `endedAt`. The web parsers are strict (`exactObject`), so server DTO
and web parser change together. Reports do not read incidents today and are
unchanged (stage 3).

## 7. Schema (migrations 066 and 067)

Migration 066 is additive and ships with release OVR-5a; migration 067 only
drops the superseded delivery identity and ships with release OVR-5b (§8).

**066 `066_overdue_correction_deadline_and_extension`:**

- `job_card_submission_episode_activations.correction_due_at TIMESTAMPTZ NULL`;
  CHECK `correction_due_at IS NULL OR (activated_by_command = 'REQUEST_REVISION'
  AND correction_due_at > activated_at)`. No backfill.
- `job_card_overdue_incidents`: `ended_at TIMESTAMPTZ`, `ended_by_user_id UUID`
  (FK users in org), `end_reason VARCHAR(30)` CHECK `IN ('DEADLINE_EXTENDED')`,
  `end_note TEXT` CHECK `CHAR_LENGTH(BTRIM(end_note)) BETWEEN 1 AND 500`,
  `ended_by_schedule_revision_no INTEGER` (composite FK to
  `job_card_schedule_revisions (organization_id, job_card_id, revision_no)`
  `ON DELETE RESTRICT`). CHECKs: the five are all NULL or all set;
  `NOT (recovered_at IS NOT NULL AND ended_at IS NOT NULL)`;
  `ended_at >= breached_at`. The recovery pair CHECK is unchanged. No backfill.
- Constraints get deterministic table-prefixed names (as in 064/065):
  `job_card_submission_episode_activations_correction_due_check`,
  `job_card_overdue_incidents_ending_set_check`,
  `job_card_overdue_incidents_ending_exclusive_check`,
  `job_card_overdue_incidents_ending_instant_check`,
  `job_card_overdue_incidents_end_reason_check`,
  `job_card_overdue_incidents_end_note_check`.
- Activity event-type CHECK widened with `JOB_OVERDUE_ENDED_BY_EXTENSION`,
  keeping every value accepted by 065.
- A fail-closed `DO $$` block verifies the new constraints through
  `pg_get_constraintdef` and that no row is pre-populated
  (`COUNT(*) FILTER (WHERE ended_at IS NOT NULL) = 0`, same for
  `correction_due_at`); tables are not required to be empty.
- `job_card_overdue_notification_deliveries`: add
  `job_card_overdue_notification_deliveries_incident_kind_key UNIQUE
  (organization_id, incident_id, kind)` **alongside** the 053 episode key.
  Existing rows already satisfy it (an incident belongs to one episode, and the
  053 key allows one row per episode and kind). The 053 key stays in 066 so
  the previous release keeps working (§8).
- `HEALTH_SCHEMA_VERSION` in both env examples and the schema-head tests move to
  `066_overdue_correction_deadline_and_extension` (OVR-5a).

**067 `067_overdue_delivery_identity_per_incident`:** drops the 053 UNIQUE
`(organization_id, job_card_id, delay_type, episode_no, kind)`. Its name is
auto-generated, so the migration finds it through `pg_constraint` by its exact
column list and fails closed if it is not found exactly once; a `DO $$` block
then verifies that only the incident key remains. `HEALTH_SCHEMA_VERSION` moves
to `067_overdue_delivery_identity_per_incident` (OVR-5b).

## 8. Release and rollback

**The previous release is not a safe rollback target once OVR-5 writes data.**
`b0d3341` treats every row with `recovered_at IS NULL` as open: it would resume
reminders for ended incidents, list them as open, ignore correction deadlines
(scanner breaches at the revision instant again), and its recovery `UPDATE`
would set `recovered_at` on ended rows, which the exclusivity CHECK rejects, so
`START` / `SUBMIT_FOR_APPROVAL` / `CANCEL` on those jobs would fail. The deploy
pipeline already refuses to deploy a release behind the database
(`DATABASE_AHEAD`), and the runbook allows a `current` repoint only to a
schema-compatible release; the database is forward-only.

OVR-5 therefore ships as two releases (two code PRs; this contract and the
`DECISIONS.md` record ship with the first, the second updates their status). No
activation flag.

- **OVR-5a — readers (expand), no visible behavior change.** Migration 066.
  Every consumer honors `ended_at` and `correction_due_at` (§3.6, §6): scanner,
  producers, recovery guard, OVR-4 discovery/recheck/insert keyed by the
  canonical incident (§4.9), snapshot, open-late list, manual reminder guard,
  history DTO and web parser. Patch instant after the lock (§4.0). No code
  writes `ended_at` or `correction_due_at` yet, so behavior is identical to
  today except the clock sampling point.
- **OVR-5b — writers.** Migration 067. `REQUEST_REVISION` `correctionDueAt`,
  extension ending with reason, `changeRequestResolution`, the deadline-removal
  rule, the Staff block (§5), the DTO fields and all UI.

Rollback rules:

- **5b → 5a:** safe `current` repoint. 5a reads everything 5b writes and does
  not need the dropped 053 key.
- **5a → `b0d3341`:** safe while 067 is not applied: 5a writes no new column,
  and its deliveries also satisfy the 053 key, which still exists.
- **After 5b is live, no repoint below 5a.** A defect is fixed forward. Ended
  rows are evidence and are never converted to recovered rows or deleted to
  make an old release work.
- Each deploy needs the owner's production approval and `allow_migrations`, as
  usual.

## 9. Acceptance scenarios (PostgreSQL tests)

- C1 revision after the original deadline, default: no incident until
  `reserved_at + 24 h`; at `+24 h + 1 ms` the scanner records one
  `LATE_SUBMISSION` with `deadline_at = correction_due_at + 1 ms`.
- C2 revision well before the original deadline with a correction deadline
  earlier than it: the original deadline governs (max rule).
- C3 management-chosen `correctionDueAt` at the 1 h and 14 d bounds is accepted;
  outside them `400` with `fieldErrors.correctionDueAt`; nothing armed.
- C4 job without any deadline: no correction stored, no incident ever.
- C5 `WITHDRAW_FROM_APPROVAL` after the deadline keeps today's immediate breach.
- C6 replay of a `REQUEST_REVISION` receipt recorded without `correctionDueAt`
  replays; same key with a different `correctionDueAt` conflicts.
- E1 management moves `dueDate` of a late `GENERAL_TASK` (`IN_PROGRESS`) into the
  future with a reason: every open row of the episode is ended with the reason,
  revision and actor; OVR-4 stops; the open-late list drops it; history shows
  the ending.
- E2 same without a reason: `400 DEADLINE_EXTENSION_REASON_REQUIRED`, nothing
  written.
- E3 move still in the past / `dueDate` move on a job governed by
  `scheduledEndsAt`: nothing ended; today's B2 rows unchanged.
- E4 management reschedules an `ACCEPTED` delivery with open `LATE_START` into
  the future: the incident is ended, the job returns to `NEW` (existing rule).
- E5 after E1, the new deadline passes: a new incident under the new revision;
  a later `SUBMIT_FOR_APPROVAL` recovers only the new row; the ended row stays
  ended.
- E6 `APPROVAL_WAIT` open while management edits fields: never ended.
- E7 management extension before the scanner ticked: pre-mutation
  materialization and ending in one transaction; without a reason both roll
  back.
- E8 open `LATE_START` on a job reset to `NEW` by reassignment, then
  rescheduled into the future: ended.
- E9 several open revision rows of the same episode: all ended by one patch.
- E10 management `dueDate: null` on a `GENERAL_TASK` whose open lateness is
  governed by `dueDate`: `409 OPEN_LATENESS_DEADLINE_REQUIRED`, nothing written.
- E11 management `dueDate: null` on a job with open lateness governed by
  `scheduledEndsAt`: allowed, nothing ended, boundaries unchanged.
- E12 Staff `dueDate: null` on a job with open lateness: `409
  DEADLINE_CHANGE_REQUIRES_MANAGEMENT` (never the E10 code).
- N1 reminder cycle after an extension: late → automatic reminder and
  escalation delivered → management extends with a reason (ended) → the new
  deadline passes → the new incident gets its own reminder and escalation.
- N2 no new cycle without an ending: a still-past `dueDate` move (B2 row) or a
  title edit after a delivered reminder sends nothing new.
- N3 deliveries recorded before 066 keep deduplicating their episode (canonical
  incident = the incident they reference).
- J1 extension with `changeRequestResolution` for the job's open request: the
  deadline moves, the lateness ends and the request is `RESCHEDULED` in one
  transaction (actor, instant, activity, Staff notification); OVR-4 reminders
  resume only if the new deadline later passes.
- J2 wrong id, a request of another job, or an already resolved request: `404`
  / `409 CHANGE_REQUEST_NOT_OPEN`, nothing written (no field change, no
  ending).
- J3 extension without `changeRequestResolution`: the request stays `OPEN`.
- J4 `changeRequestResolution` on a patch that appends no schedule revision, or
  from Staff: `400`, nothing written.
- T1 a management patch that waits behind a held JobCard lock samples its
  instant after acquiring it: a new deadline that passed while it waited ends
  nothing (and the existing B2 rows apply).
- R1 OVR-5a against data written by OVR-5b (ended rows, correction deadlines,
  per-incident deliveries): readers treat it correctly (the 5b → 5a repoint
  guarantee).
- S1 Staff deadline edit on a job with open lateness: `409
  DEADLINE_CHANGE_REQUIRES_MANAGEMENT`, nothing written; without open lateness
  the edit succeeds as today; Staff self-created job included.
- S2 the DTO flag `hasOpenOverdueIncident` matches the backend rule.
- S3 Staff deadline patch before the scanner ticked: `409`, the field edit and
  the pre-mutation incident both roll back.
- C7 scanner candidate prefilter with `correction_due_at`: not a candidate at
  the correction deadline, a candidate at `+1 ms`.
- C8 `SALES_MEETING` with `scheduledAt` only (no end, no `dueDate`): no
  correction stored.
- Existing B2 tests that patch `dueDate` as `staffA` on a job with open
  lateness change to management (move/removal) or expect the new `409`.
- DB: CHECKs reject half-set endings, ended-and-recovered rows,
  `ended_at < breached_at`, `correction_due_at` on a withdraw activation.
- UI (Playwright, `UI-003`, 390×844 and desktop): revision drawer picker
  (default, bounds, error), Staff correction deadline display, management
  extension reason field appearing with open lateness or after the server
  error, the change-request resolution checkbox, Staff disabled date fields
  with the change-request hint, history "sonlandırıldı" row.
