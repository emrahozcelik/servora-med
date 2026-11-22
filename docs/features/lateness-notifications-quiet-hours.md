# Lateness notifications: quiet hours, start reminder and management alerts (OVR-6)

- **Status:** Accepted product contract — `DECISIONS.md` OVR-6 (owner: "evet
  başlayalım", 2026-11-22). Ships with the code.
  The owner chose the direction on 2026-11-20 (lateness plan stage 2: item 3
  "A" notification deferral without changing lateness time; item 4 "B + C"
  one-off notifications for late start and approval wait; item 5 "B"
  management alert for unaccepted jobs, not Staff lateness) and answered the
  open questions on 2026-11-21: (Q1) sending window 08:00–21:00 organization
  time, Sunday closed; (Q2) quiet hours apply to lateness notifications only;
  (Q3) Staff get a start reminder 15 minutes after the planned start, the
  `LATE_START` incident rule is unchanged; (Q4) unaccepted jobs outside the
  JOB-010 window get a management list **and** one notification per job.
  Revised the same day after a critic review (delivery identity per planned
  start, rollback scope, lock order, batch fairness, partial-key conflicts,
  read surfaces) and again on 2026-11-22 after the owner's review (approval
  alert suppressed by an open change request, SQL vs worker quiet-hours
  reporting, atomic delivery, JOB-010 list ownership matrix, activation and
  rollback evidence, wording).
- **Date:** 2026-11-21
- **Scope:** Stage 2 ("notifications and acceptance") of the owner's lateness
  plan. Reports (stage 3) are out of scope.
- **Amends:** OVR-4 automatic submission reminder **send timing** (quiet-hours
  gate; thresholds, identity and recipients unchanged). There is no separate
  OVR-4 record in `DECISIONS.md`; this record carries the change. **Extends:**
  OVR-2/OVR-3 incidents (read only), JOB-010 (unchanged), D1 §5 (no automatic
  notification while a change request is open). Incident evidence, deadlines
  and `breached_at` are never changed.

## 1. Context (observed on `main` `e3910c0`)

1. **No notification timing policy exists.** Every automatic producer sends at
   its scan instant. OVR-4 reminders fall at `breached_at + 15 min` / `+ 60 min`;
   a `due_date` deadline breaches at local midnight, so Staff and management can
   be notified at 00:15 and 01:00. The only local-time window in the code is the
   SYSTEM follow-up slot window `[08:00, 19:00]` (`follow-up-policy.ts`,
   inclusive end); the only non-working day is Sunday (`working-day-policy.ts`).
2. **Late start and approval wait are silent.** `LATE_START` (boundary
   `scheduled_ends_at`) and `APPROVAL_WAIT` (`submitted_at + 24 h`) are recorded
   as incidents but nobody is notified and there is no cross-job list. A
   14:00–15:00 delivery is only "late" at 15:00.
3. **Unaccepted jobs outside the JOB-010 window are invisible.** JOB-010 offers
   cover `PRODUCT_DELIVERY` / `SALES_MEETING` with a planned start while the
   window is enabled. Any other `NEW` job (for example a `GENERAL_TASK` with a
   planned time) can pass its planned time unaccepted with no offer, incident,
   notification or list.
4. **Production status of OVR-4 is not recorded.** There is no activation
   record for `OVERDUE_REMINDER_ENABLED`; this contract does not assume it is on.

## 2. Principles

- **Notification time is not lateness time.** Quiet hours only delay *sending*;
  incidents, deadlines, `breached_at`, due thresholds and reports never move.
- **Re-check at send time.** A deferred notification is sent only if its
  condition still holds when the window opens; nothing is queued in advance.
- **Reminders are not lateness.** The start reminder and the unaccepted-job
  alert create no incident and never count against Staff.
- **Time-critical acceptance and calendar notifications are not delayed.**

## 3. Quiet hours

1. **Window.** Automatic lateness notifications are sent only while the
   organization-local time (`organizations.timezone`, DST via `local-calendar.ts`)
   is Monday–Saturday and `08:00 ≤ t < 21:00` (end exclusive). Sunday is closed
   all day. Outside the window a due notification waits; the first worker tick
   inside the next window sends it if it is still due and eligible (a Saturday
   21:00 item waits until Monday 08:00).
2. **Applies to lateness-related automatic operational alerts.** This family
   includes alerts that are not Staff fault: OVR-4 `STAFF_REMINDER` and
   `MANAGEMENT_ESCALATION`; the start reminder (§4, not lateness); the
   approval-wait alert (§5, management delay); the unaccepted-job alert (§6, not
   Staff lateness). Belonging to this family says *when* an alert may be sent,
   never *who is at fault*. At window opening OVR-4 may send the reminder and
   the escalation in the same tick; this is accepted (Q2).
3. **Does not apply to:** JOB-010 acceptance reminder and expiry, calendar
   reminders, request-driven notifications (lifecycle, assignment, change
   request, notes, messages) and the manager's manual submission reminder.
4. **Single owner.** New module `server/src/modules/notifications/quiet-hours.ts`
   owns `NOTIFICATION_WINDOW_START_MINUTE = 8 * 60`,
   `NOTIFICATION_WINDOW_END_MINUTE = 21 * 60` (exclusive), the closed weekday,
   `isWithinNotificationWindow(instant, timezone)` and its SQL renderer. The
   follow-up `FOLLOW_UP_AUTO_WINDOW_*` constants are not reused. Weekday mapping
   is explicit: `local-calendar.ts` uses 0 = Sunday, SQL `ISODOW` uses 7 =
   Sunday. Not configurable per organization or user in this release.
5. **Clock discipline unchanged.** The window is a due-gate evaluated at
   `scanTime` *before* any delivery row is anchored; `sent_at`, activity
   metadata, realtime `occurredAt` and notification `created_at` stay equal to
   the actual `scanTime`. Due thresholds stay measured from their anchor.
6. **Fairness and reporting.** Two distinct cases:
   - *Quiet at discovery:* discovery SQL excludes candidates whose organization
     is outside its window. They are not candidates and are **not counted**
     anywhere in the iteration report; quiet organizations never fill a
     bounded batch.
   - *Closed at send time:* a candidate discovered inside the window whose
     under-lock re-check finds the window closed (the boundary passed between
     discovery and lock) is skipped with the new outcome
     `deferred-quiet-hours`; nothing is written.
   - The number of notifications waiting for a window is not a worker counter;
     when needed (for example before activation, §9) it is measured by a
     separate, bounded, read-only query.
7. **Testability.** Both workers take the window as an injected policy
   (default: the real one). Existing OVR-4 and OVR-5 reminder suites scan at
   00:15/01:00 local and therefore must either inject an always-open window or
   move their scan instants into the window; they are updated in the same PR.

## 4. Start reminder (Staff)

1. **Condition.** Job `ACCEPTED`, `scheduled_at` not null, `started_at` null,
   the current assignee an active `STAFF` user, no `OPEN` change request (D1 §5),
   and `scanTime ≥ scheduled_at + 15 min`. Acceptance after that instant makes
   it due at the next tick.
2. **Once per planned start and recipient.** Identity is (job, planned start
   instant, recipient). A due-date-only edit, a title edit or any edit that
   keeps `scheduled_at` sends nothing new; a reschedule (new `scheduled_at`)
   allows one reminder for the new start; a reassignment lets the new assignee
   be reminded once for the same start (the previous assignee is not reminded
   again).
3. **Not lateness.** No incident, no change to `LATE_START` (still recorded at
   `scheduled_ends_at`), no effect on reports.
4. **Send.** In-app `job.start_reminder` (static copy: "Planlanan başlangıç
   geçti" / "Planlanan başlangıç saati geçti. İşi başlatın ya da değişiklik
   talebi gönderin."), Web Push when enabled, activity
   `JOB_START_REMINDER_SENT`, realtime `job.updated`. Quiet hours apply (a 07:00
   start is reminded at 08:00 if still not started).
5. `NEW` jobs are out of scope here: window jobs have JOB-010 offers, other `NEW`
   jobs are covered by §6.

## 5. Approval-wait alert (management)

1. **Condition.** An open `APPROVAL_WAIT` incident (`recovered_at IS NULL AND
   ended_at IS NULL`), the job still `WAITING_APPROVAL`, and **no `OPEN` change
   request** on the job (Staff may raise one while the job waits for approval;
   management is already notified of it, D1 §5). When the request is resolved
   and the job still waits, the alert is sent at the next tick inside the
   window. Incidents come from the existing OVR-2/OVR-3 rules (24 h after
   submission), so the alert needs the scanner (`OVERDUE_SCANNER_ENABLED`) like
   today's incidents.
2. **Once per incident.** A new submission cycle has its own incident and alert.
3. **Send.** In-app `job.approval_wait_alert` (static copy: "Onay bekleyen iş 24
   saati aştı" / "Bir işin yönetici onayı 24 saati aştı.") to every active
   MANAGER/ADMIN at send time, Web Push when enabled, activity
   `JOB_APPROVAL_WAIT_ALERT_SENT`. Quiet hours apply. Management delay, never
   Staff fault (REPORT-001).

## 6. Unaccepted jobs outside the JOB-010 window (management)

1. **Definition.** A job is an *unaccepted past-start job* when it is `NEW`, has
   an assignee, `scheduled_at` is not null and `scheduled_at ≤ now`, its type is
   not `WEEKLY_REPORT` or `SALE` (policy: these are not planned field work), and
   its **latest** JOB-010 offer (if any) does not place it with JOB-010
   according to the ownership matrix below. Not Staff lateness: no incident, no
   Staff notification.

   | Latest offer of a `NEW` past-start job | Owner |
   | --- | --- |
   | none | this list (§6) |
   | `OPEN` (urgent or past its deadline) | "Müdahale gereken atamalar" |
   | `OPEN` (not urgent, deadline not reached) | JOB-010 offer flow (no list; the offer is still answerable) |
   | `DECLINED`, `RELEASED`, `EXPIRED` | "Müdahale gereken atamalar" |
   | `WITHDRAWN` with `PLANNED_WINDOW_PASSED` | "Müdahale gereken atamalar" |
   | `WITHDRAWN` with any other reason (`REASSIGNED`, `RESCHEDULED`, `CANCELLED`, `INVALIDATED`, `OFFBOARDING_TRANSFER`) | this list (§6) |
   | `ACCEPTED` (stale: the job is `NEW` again) | this list (§6) |

   The needs-action predicate is reused from one owner (the existing repository
   predicate is extracted into a shared SQL renderer, not copied), so a job is
   on exactly one list or, for a still-answerable offer, in the offer flow. The
   matrix is evaluated by offer state only and is independent of
   `JOB_ASSIGNMENT_WINDOW_ENABLED`; offers written while the window was enabled
   keep their owner after a rollback.
2. **List.** `GET /api/job-cards/pending-acceptance/past-start` (two-segment
   static path, like `assignment-offers/needs-action`), MANAGER/ADMIN only
   (Staff `403`), read-time evaluation against the request clock, order
   `scheduled_at ASC, id ASC`, envelope `{ items, total, limit, offset }` like the
   needs-action list; rows carry job id/title/type, `jobPath`, assignee (id,
   name, active), planned start and elapsed seconds. A job with an open change
   request stays on the list. The overview shows "Kabul bekleyen ve planlanan
   zamanı geçen işler" next to "Müdahale gereken atamalar", management only,
   hidden when empty.
3. **One alert per planned start.** When a job first qualifies, every active
   MANAGER/ADMIN at send time receives `job.pending_acceptance_alert` once per
   (job, planned start instant) (static copy: "Kabul edilmemiş iş" / "Bir işin
   planlanan saati geçti ve henüz kabul edilmedi."), Web Push when enabled,
   activity `JOB_PENDING_ACCEPTANCE_ALERT_SENT`. Quiet hours apply. No alert
   while an `OPEN` change request exists (D1 §5). A due-date edit or a
   reassignment of the same planned start does not alert again; a reschedule to
   a new past start alerts once more; a future reschedule removes the job from
   the list.

## 7. Worker and delivery state

1. **New worker** `lateness-alert-worker` (start reminder, approval-wait alert,
   unaccepted-job alert): non-overlapping `setTimeout` loop, injected clock and
   window policy, bounded per-kind batches. **Lock order users → JobCard**
   (`assignee-lock.ts`, JOB-010 §9): snapshot read → lock the users involved →
   `getJobForUpdate` → re-check every condition. (OVR-4 locks the JobCard first;
   that pre-existing deviation is out of scope and recorded as a follow-up.)
2. **Batching.** Three per-kind discovery queries, each ordered by its due
   instant and bounded by `batchSize`; one tick processes at most `batchSize`
   candidates of each kind, so no kind starves another.
3. **Notification drafts.** The worker builds explicit notification drafts per
   recipient (as `assignment-offer-expiry-worker.ts` does), not the shared
   activity→notification policy. The three activity events are mapped to
   `job.updated` in `realtime/event-mapper.ts`; a missing mapping would silently
   drop notifications after the delivery row is anchored, so a test asserts
   the mapping exists.
4. **Config.** Optional `latenessAlerts` section, present only when a
   `LATENESS_ALERTS_*` key is set (OVR-4 convention): `LATENESS_ALERTS_ENABLED`
   (worker constructed only when `true`), `_POLL_INTERVAL_MS` (60 000),
   `_BATCH_SIZE` (50), `_START_REMINDER_DELAY_MS` (900 000; bounds like OVR-4).
   Defaults live in the policy module `lateness-alert-policy.ts`; both
   `ops/examples/*.env.example` files gain the keys commented/false. Production
   activation is a separate owner-approved step.
5. **OVR-4 worker** gains only the quiet-hours gate (§3) in discovery and
   re-check and the `deferred-quiet-hours` outcome.
6. **Atomic delivery (acceptance gate).** For one candidate, the delivery row,
   the activity, the realtime event, every in-app notification and every Web
   Push delivery-queue row (`web_push_deliveries`) are written in **one**
   database transaction, as OVR-4 does (`overdue-reminder-worker.ts`
   `executeTransaction`). Any failure rolls back all of them, including the
   delivery row, so the next tick retries; a delivery row never exists without
   its notifications. The actual push sending stays asynchronous in the existing
   dispatcher and its failures never touch these rows.
7. **Delivery table** `job_card_lateness_alert_deliveries`: `id`,
   `organization_id`, `job_card_id`, `kind` (`START_REMINDER`,
   `APPROVAL_WAIT_ALERT`, `PENDING_ACCEPTANCE_ALERT`), `planned_start_at`
   (TIMESTAMPTZ), `recipient_user_id`, `incident_id` (FK incidents), `sent_at`,
   `recorded_at`. Consistency FKs: `(organization_id, job_card_id)` → job cards;
   `(organization_id, job_card_id, incident_id)` → incidents through a new
   `UNIQUE (organization_id, job_card_id, id)` on `job_card_overdue_incidents`
   added by 069, so an incident of another job or organization can never be
   referenced; `(organization_id, recipient_user_id)` → users. Kind CHECKs fix
   the key columns: start reminder → planned
   start and recipient set, incident null; pending acceptance → planned start
   set, recipient and incident null; approval wait → incident set, planned start
   and recipient null. Identity: one real constraint
   `UNIQUE NULLS NOT DISTINCT (organization_id, job_card_id, kind,
   planned_start_at, recipient_user_id, incident_id)` (PostgreSQL 17), used as
   the `ON CONFLICT` target; the delivery row is anchored before
   activity/realtime/notification, exactly as OVR-4.

## 8. Read surfaces and schema (migration 069)

- Widening set (all in this PR): `notifications/types.ts` `NOTIFICATION_KINDS`
  and `presenter.ts` messages; `web/src/services/notifications-api.ts` kind
  allowlist (fails closed); `job-cards/types.ts` activity events,
  `activity-presenter.ts` (`{ kind: 'NONE' }`), `web/src/jobs/job-labels.ts`.
- Migration 069 `069_lateness_alerts_and_quiet_hours`: the incident
  `UNIQUE (organization_id, job_card_id, id)` and the delivery table (§7.7)
  with deterministic constraint names; `in_app_notifications_kind_check`
  re-created with every value from its latest definition (065) plus
  `job.start_reminder`, `job.approval_wait_alert`,
  `job.pending_acceptance_alert`; the activity event-type CHECK re-created with
  every value from its latest definition (066) plus `JOB_START_REMINDER_SENT`,
  `JOB_APPROVAL_WAIT_ALERT_SENT`, `JOB_PENDING_ACCEPTANCE_ALERT_SENT`; fail-closed
  `DO $$` verification; the new table starts empty.
- `HEALTH_SCHEMA_VERSION` → `069_lateness_alerts_and_quiet_hours`;
  `docs/README.md` gains the contract row; `SERVORA_MED_API_DRAFT.md` gains the
  list endpoint.

## 9. Release, activation and rollback

One release, additive schema. Deploy needs the owner's production approval and
`allow_migrations`. The list endpoint and the OVR-4 quiet-hours gate are live on
deploy; the new worker is not.

1. **Before deploy (gate).** Confirm read-only whether OVR-4 runs in production
   (`OVERDUE_REMINDER_ENABLED` in the service environment). If it runs, its
   overnight reminders move to 08:00 on deploy; the deploy note says so. The
   production check is read-only and done only with the owner's approval for
   that access.
2. **Rollback evidence, not flag state.** A `current` repoint to the previous
   release is allowed only when a read-only query proves, at that moment, that
   there are **zero** rows of: `in_app_notifications` with the three new kinds,
   `job_card_activity_logs` with the three new events, and
   `job_card_lateness_alert_deliveries`. The previous release reads the 069
   schema unchanged (new table and widened CHECKs only), so this evidence is
   sufficient; the flag having been off is not. With any such row present,
   fixes go forward; 069 is not reversed. The query is stored with the
   activation runbook.
3. **Activation (separate owner approval).** Before setting
   `LATENESS_ALERTS_ENABLED=true`: run read-only candidate counts per kind
   (start reminders due, open `APPROVAL_WAIT` incidents without an open change
   request, unaccepted past-start jobs) and record them; activate with a small
   batch (`LATENESS_ALERTS_BATCH_SIZE=10`) inside the sending window; observe
   the first ticks and verify per kind that delivery rows, activities and
   notifications match the recorded counts (catch-up: every condition open at
   activation alerts once); then raise the batch size to the default with
   approval. The activation record captures counts, timestamps and the batch
   change.

## 10. Acceptance scenarios

- Q1 window boundaries in `Europe/Istanbul`: 07:59 closed, 08:00 open, 20:59
  open, 21:00 closed; Sunday 12:00 closed; Monday 08:00 open; Saturday 21:00 →
  Monday 08:00; a DST date keeps local boundaries; TS predicate and SQL renderer
  agree on every case.
- Q2 OVR-4: a `due_date` breach at 00:00 with reminder due 00:15 is not a
  candidate overnight and is not counted; the 08:00 tick sends reminder and
  escalation, `sent_at` = that tick; a SUBMIT at 07:30 means nothing is sent.
- Q6 a candidate discovered at 20:59:59 whose under-lock re-check runs at 21:00
  is skipped as `deferred-quiet-hours` with nothing written; it is sent at the
  next window.
- Q3 Sunday breach → Monday 08:00.
- Q4 a quiet organization never blocks another organization's batch.
- Q5 JOB-010 acceptance reminder/expiry and calendar reminders still send at 03:00.
- S1 start reminder: planned 14:00, `ACCEPTED`, not started → at 14:15 (not
  14:14:59), once; `START` before → none; reschedule to 16:00 → one more at
  16:15; due-date-only edit → none; reassignment → the new assignee once; open
  change request → none, resolved → next tick; inactive assignee → none;
  acceptance at 14:30 → next tick.
- S2 no incident is created or changed; `LATE_START` still appears at
  `scheduled_ends_at`. S3 07:00 start → 08:00.
- A1 approval-wait alert once per incident to every active MANAGER/ADMIN;
  approval before the window opens → none; a second submission cycle → its own
  alert.
- A2 open change request on a `WAITING_APPROVAL` job past 24 h → no alert;
  request resolved while still waiting → alert at the next in-window tick;
  approved before the resolution → none.
- P1 unaccepted past-start `GENERAL_TASK`: listed at its planned time; one alert
  (quiet-hours gated); accept → leaves the list; future reschedule → leaves;
  past reschedule → one new alert; due-date edit or reassignment → no new alert;
  open change request → listed, no alert.
- P2 ownership matrix, one test per row: no offer → this list; `OPEN` urgent or
  past deadline → needs-action only; `OPEN` still answerable → neither list;
  `DECLINED` / `RELEASED` / `EXPIRED` / `WITHDRAWN`+`PLANNED_WINDOW_PASSED` →
  needs-action only; `WITHDRAWN` with each other reason → this list only; stale
  `ACCEPTED` → this list only. No job is ever on both lists.
- P4 offers written while the window was enabled, window later disabled,
  planned start passed → the same owners as P2.
- P3 Staff → `403`; the overview section is management-only, hidden when empty,
  390×844 and desktop without overflow; a deactivated assignee is shown as such.
- W1 worker: per-kind batches (one kind full never starves another), concurrent
  workers converge on one delivery, restart never resends, transport failure
  never corrupts lifecycle truth, users → JobCard lock order; the event mapper
  returns non-null for the three events.
- W2 atomic delivery: a fault injected after the delivery row (activity,
  realtime, in-app notification or `web_push_deliveries` insert) rolls back the
  delivery row too; the next tick sends exactly once.
- DB: kind/key CHECKs, the NULLS NOT DISTINCT identity, the incident FK rejects
  an incident of another job or organization, widened notification and activity
  CHECKs keep every earlier value.
- R1 the rollback-evidence query returns zero on a fresh 069 database and
  non-zero after one alert; the activation candidate-count queries match the
  worker's first-tick deliveries in a seeded catch-up scenario.
- Existing OVR-4/OVR-5 reminder suites updated for the window (§3.7) and still
  pass.
