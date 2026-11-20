# Assignment acceptance window and delivery rescue (JOB-010)

- **Status:** Accepted product contract — `DECISIONS.md` JOB-010
  (2026-11-20). Owner answered Q1–Q9 with the draft defaults ("Evet, kabul
  et"), accepted the record ("Evet, kayda taşı") and added the pre-merge
  decisions P1-A/B/C, early START and outcome rules (PR #470 review), then
  decided D1 (2026-11-20: Staff never cancel; reasoned request to management).
  Implementation pending; ships with the code, release plan below.
- **Date:** 2026-11-20
- **Scope:** Management-assigned `PRODUCT_DELIVERY` and `SALES_MEETING`
  JobCards before work starts: when Staff may accept, how long they have, how
  they decline or release the job, what happens when nobody answers, how
  management recovers the customer commitment, and how early a
  `PRODUCT_DELIVERY` / `SALES_MEETING` may start.
- **Extends:** JOB-006 (acceptance), JOB-008 / JOB-009 (follow-up visit
  creation paths), Staff offboarding transfer. **Amends:** the
  `PRODUCT_REQUIREMENTS.md` Staff-cancellation invariant and JOB-006 §5 Staff
  schedule edits for jobs in the acceptance window, in `NEW` and `ACCEPTED`
  only; replaces the unrecorded not-before `scheduledAt` `START` gate for
  `PRODUCT_DELIVERY` and `SALES_MEETING` with a 30-minute tolerance. Earlier
  records are not rewritten.

## Context

A customer expects a product delivery at 14:00. Management assigns it to a
Staff member at 12:00. Today:

1. **Staff cannot accept before the planned start.** `getAllowedLifecycleCommands`
   (`server/src/modules/job-cards/policy.ts:51-56`) filters `ACCEPT_ASSIGNMENT`
   and `START` out until `requestTime >= scheduledAt`; `assertCanTransition`
   (`policy.ts:242`) enforces the same list on the lifecycle reservation and
   finalize paths. Before 14:00 the only command a Staff member sees in `NEW`
   is `CANCEL`. Management cannot know before 14:00 whether the delivery is
   covered.
   - **Drift:** JOB-006 makes acceptance a commitment before work starts and
     contains no not-before rule for acceptance. The gate arrived in commit
     `87074ab` ("fix: reconcile acceptance and start gating", 2026-08-17)
     without a decision record. It is implemented behavior, not accepted
     policy.
2. **No acceptance deadline exists.** A `NEW` job can stay unanswered until
   and after its planned time. OVR-2 `LATE_START` does not cover it: its
   boundary is `scheduled_ends_at` and it requires an existing acceptance.
3. **No decline path exists.** Staff answers in `NEW` are `ACCEPT_ASSIGNMENT`
   and `CANCEL` (`policy.ts:59`), and Staff may also `CANCEL` in `ACCEPTED`
   (`policy.ts:61-64`; `PRODUCT_REQUIREMENTS.md:147-148`). A Staff member who
   cannot take the job removes the customer's JobCard instead of handing it
   back to management.
4. **Management is not told.** Assignment produces `job.assigned` /
   `job.reassigned` for the assignee only; `JOB_ACCEPTED` produces no
   notification (`server/src/modules/notifications/policy.ts:37-51`).
   Offboarding transfer writes realtime events but no in-app notification at
   all (`server/src/modules/people/offboarding.ts`). `in_app_notifications`
   stores `created_at`, `read_at` and `dismissed_at` only; nothing proves that
   a notification was seen.
5. **No same-person retry.** A same-assignee patch writes no activity,
   assignment history or notification (it only bumps `version`); the history
   CHECK forbids `from_user_id = to_user_id`. Management cannot give the same
   Staff member a fresh, recorded chance.

### Related drift found while drafting (not changed by this record)

- JOB-006 §6 lets assigned Staff `ADD_NOTE` in `NEW`; `policy.ts:84-93`
  grants Staff `ADD_NOTE` only in `ACCEPTED`, `IN_PROGRESS` and
  `REVISION_REQUESTED`. Reported for a separate decision.

## Decision

### 1. Acceptance and start are separate time rules

- `ACCEPT_ASSIGNMENT` is no longer gated by `scheduledAt`, for every JobCard
  type *(Q7)*. It removes an unrecorded restriction and adds no rule.
- The acceptance deadline (§4) and the early-start tolerance (§1a) are
  independent: neither moves the other.

### 1a. Early START

Staff may arrive before the planned time; if the customer is ready, the visit
or delivery may start early. No separate "arrived" command, arrival state or
button is introduced.

- **Who:** only the assigned Staff member, from `ACCEPTED` (unchanged).
- **Tolerance:** for every `PRODUCT_DELIVERY` and `SALES_MEETING` (in or out of
  the acceptance window), `START` is allowed from `scheduledAt − 30 min`.
  The current not-before rule (`requestTime >= scheduledAt`) is replaced by
  `requestTime >= scheduledAt − 30 min`. Other types keep today's rule.
- **Earlier than 30 minutes** needs either a valid reschedule (defined below) or an
  **early-start authorization** granted by MANAGER/ADMIN beforehand.
  - Granted only while the job is `NEW` or `ACCEPTED`, by a management command
    with `clientActionId` and `expectedVersion`, under the JobCard row lock; it
    increments `job_cards.version` and appends its own activity event in the
    same transaction.
  - Durable record: job, assignee, current schedule revision number, the
    planned `scheduledAt` / `scheduledEndsAt` it was granted for, granting
    actor and instant.
  - Valid only while the assignee and the planned interval are unchanged. A
    reassignment or a change of `scheduledAt` / `scheduledEndsAt` voids it; a
    `dueDate`-only revision does not. Voiding is recorded when it happens: a
    later return to the same assignee or planned interval does not revive it.
    No revocation or earliest-instant field in V1.
  - With a valid authorization, `START` is allowed any time before the
    tolerance boundary.
  - A "valid reschedule" means a new planned time set by whoever may change it:
    management for jobs in the window (§4); Staff too for jobs outside it,
    where JOB-006 §5 still applies. The tolerance then follows the new time.
- **Planned values stay as planned.** Early `START` never changes
  `scheduledAt` or `scheduledEndsAt`; the actual start instant is the existing
  `startedAt` (049 reservation time) and the existing START location-evidence
  policy applies.
- **No negative event.** An early start creates no `LATE_START` or other
  lateness incident. Role, location, planned-interval and lifecycle-safety
  checks are unchanged.
- **Boundary:** `requestTime = scheduledAt − 30 min` is allowed; one
  millisecond earlier needs the authorization.

Example: a meeting planned for 14:00 may start at 13:30 or 13:40; if the
customer is not ready, Staff wait. Starting at 13:15 needs a management
authorization or a reschedule.

### 2. Scope of the acceptance window

A JobCard is **in the window** when `type` is `PRODUCT_DELIVERY` or
`SALES_MEETING` (any `engagementKind`), it has a `scheduledAt`, and **at least
one assignment offer (§3) has been recorded for it**. It enters the window
when a producer in §3 records its first offer and stays in it until `START` or
a terminal status.

So a Staff self-assigned job is outside the window until management
reschedules or reassigns it (which records an offer); a JOB-008 follow-up
created directly in `ACCEPTED` for the proposing Staff member is outside it;
`GENERAL_TASK` *(Q8)*, `WEEKLY_REPORT`, `SALE`, jobs without `scheduledAt` and
jobs that existed before rollout with no offer *(Q4)* are outside it.
**Jobs outside the window keep today's acceptance and cancel rules
unchanged**; no offer is ever required for them.

### 3. Assignment offer

An **assignment offer** is a durable, server-owned record of "this Staff
member was asked to take this job by this deadline". A job may have many
offers over time; at most one is `OPEN`.

- **Producers** (each opens an offer in the same transaction as the change):
  management create (`create`, `createProductDelivery`, management
  `createFollowUp`), management reassignment, management reschedule (including
  the JOB-006 `ACCEPTED -> NEW` reset), a JOB-008 approval-created follow-up
  that starts in `NEW`, a JOB-009 `RESCHEDULE` replacement that starts in `NEW`,
  offboarding transfer of a `NEW` or `ACCEPTED` job (started jobs never get an
  offer), and management re-offer (§8).
- **Fields:** job, assignee, `opened_at`, `opened_reason` (one of the producers
  above), opening actor (always the authenticated management actor;
  offboarding runs as an ADMIN), `acceptance_due_at`, `urgent_reason`
  (`null`, `SHORT_NOTICE` or `START_PASSED`; see §4 and below), optional
  past-start acknowledgement (code and text), state, closing instant, closing
  actor, closing reason. An optional link to the assignment-history row exists only
  when the producer wrote one; an offer is not required to have one.
- **States:** `OPEN`, `ACCEPTED`, `DECLINED`, `RELEASED`, `EXPIRED`,
  `WITHDRAWN`. At most one `OPEN` offer per job (database-enforced). Closed
  offers are never reopened or edited; the single exception is the one-way
  `ACCEPTED -> RELEASED` step in §5.
- **Closers:** accept → `ACCEPTED`; decline → `DECLINED`; release (§5) →
  `RELEASED`; expiry (§6) or a management producer meeting an overdue `OPEN`
  offer → `EXPIRED`; management reassign, reschedule, cancel, ADMIN
  invalidation and offboarding transfer of a live `OPEN` offer → `WITHDRAWN`.
- The JobCard lifecycle status stays `NEW` while no offer is `OPEN`. No new
  `JobCardStatus` is introduced.
- For a job in the window, `ACCEPT_ASSIGNMENT` requires an `OPEN` offer for the
  acting assignee and closes it as `ACCEPTED` in the same transaction.
- **Planned window already too short.** A producer may open an offer only when
  `opened_at + minimum window < scheduled_ends_at`, so every on-time
  acceptance lands before the OVR-2 `LATE_START` boundary.
  - Direct management actions (create, reassign, reschedule, re-offer) that
    fail this test are rejected with 409; management picks a later time.
  - Compound producers that must not fail (JOB-008 approval, JOB-009
    replacement, offboarding transfer) record the offer and close it at once as
    `WITHDRAWN` with reason `PLANNED_WINDOW_PASSED`. The job lands in the
    management list (§8); Staff cannot accept it until management reschedules.
- **Planned start already passed.** When `opened_at >= scheduledAt` (the
  window still fits by the rule above), the offer is never treated as an
  ordinary assignment:
  - The offer's `urgent_reason` is `START_PASSED` for every producer.
  - Direct management actions also require an explicit acknowledgement in the
    same request — code `CUSTOMER_CONFIRMED_LATER_TIME`, `CUSTOMER_WAITING` or
    `OTHER`, plus mandatory text — or a reschedule; without either the request
    is rejected with 409.
  - Compound producers cannot ask; in current code only offboarding transfer
    can reach this case (JOB-008 and JOB-009 already reject a past
    `scheduledAt`). The offer has no acknowledgement and appears in the
    management list (§8).
  - The offer stores `urgent_reason`, the acknowledgement (if any), actor and
    instant.

### 4. Acceptance deadline

One rule, computed by the server at offer open:

```
acceptance_due_at = max(scheduledAt − 60 min, opened_at + minimum window)
urgent_reason     = START_PASSED   if opened_at >= scheduledAt
                    SHORT_NOTICE   else if acceptance_due_at > scheduledAt − 60 min
                    null           otherwise
```

- Minimum window *(Q1)* keeps every deadline answerable, including system
  producers (JOB-008 approval, JOB-009 replacement, offboarding) that cannot
  ask anyone for a value, and late re-offers.
- Offers with an `urgent_reason` are shown to management as "customer time at
  risk".
- No manual deadline override in V1.
- **Boundary:** a reservation with `reserved_at < acceptance_due_at` is on
  time; `reserved_at >= acceptance_due_at` is late (same equality rule as
  `LATE_START`).
- **The server enforces the deadline, not the worker.** `ACCEPT_ASSIGNMENT`
  and `DECLINE_ASSIGNMENT` compare the canonical 049 reservation instant with
  `acceptance_due_at` in the reservation preflight and again in the finalize
  transaction. A late request is rejected with 409
  (`ACCEPTANCE_WINDOW_CLOSED`) and writes nothing, whether or not the expiry
  worker has run. A late decline is rejected the same way: the job is already
  in the management list (§8). Reads present such an offer as expired. To let
  the same Staff member accept again, management re-offers (§8).
- **Only management changes the customer time.** For jobs in the window, in
  `NEW` and `ACCEPTED`, `scheduledAt`, `scheduledEndsAt` and `dueDate` may be
  changed only by MANAGER/ADMIN; a Staff patch of these fields is rejected with
  403. This amends JOB-006 §5 ("Staff schedule edits do not clear their own
  acceptance") for these jobs only; jobs outside the window keep it. Staff
  edits therefore never move a deadline or open, withdraw or reopen an offer.
  An early `START` (§1a) is not a schedule change *(Q9)*.

### 5. Staff answers

- **Accept:** `ACCEPT_ASSIGNMENT`, now allowed before `scheduledAt`, only on an
  `OPEN` offer and only before `acceptance_due_at` (§4).
- **Decline (new command `DECLINE_ASSIGNMENT`):** assigned Staff only, job in
  the window, in `NEW` with an `OPEN` offer. Structured reason code *(Q5)* plus
  mandatory text. Closes the offer as `DECLINED`; the job stays `NEW` and
  assigned until management acts. The text is stored on the offer and its
  activity, not as a JobCard note.
- **Release (separate new command `RELEASE_ASSIGNMENT`):** assigned Staff may
  hand back a job in the window from `ACCEPTED`, before `START`, when its
  latest offer is `ACCEPTED` for them; same reason fields as decline. In one
  transaction, in this order:
  1. materialize OVR-2 `LATE_START` against the pre-release acceptance (the
     same pre-mutation rule the JOB-006 management reset and offboarding
     already follow), so releasing never hides a breach;
  2. clear acceptance facts and return the job to `NEW`;
  3. move the offer `ACCEPTED -> RELEASED`.

  No new offer opens until management acts. Management is notified (§7).
  An already-open `LATE_START` incident stays open, as after a management
  reset.
- **No Staff cancel for jobs in the window in `NEW` and `ACCEPTED`.** Staff decline or
  release instead; management keeps reasoned cancellation. This closes the
  "accept, then cancel" path. Staff cancellation in `IN_PROGRESS` and later is
  covered by decision D1 below: Staff never cancel any JobCard.

### 6. Expiry

- A clock-only worker (OVR-3 conventions: bounded batch, per-job row lock,
  injected clock, opt-in env flag defaulting to off) closes an `OPEN` offer as
  `EXPIRED` once `acceptance_due_at` has passed and produces the expiry
  notifications. It is not what blocks a late accept; §4 does that on every
  request.
- An `ACCEPT_ASSIGNMENT` or `DECLINE_ASSIGNMENT` reservation reserved before
  `acceptance_due_at` and still in flight wins over expiry (049 ordering, as in
  OVR-3).
- The JobCard is **never** cancelled automatically; only the offer expires.

### 7. Notifications

| When | Recipient | Kind |
| ---- | --------- | ---- |
| Offer opens (any producer, including offboarding) | Assignee | existing `job.assigned` / `job.reassigned` |
| Reminder before deadline *(Q2)* | Assignee, once per offer | new `job.acceptance_reminder` |
| Offer declined or released | Management *(Q6)* | new `job.assignment_declined` |
| Offer expired | Management *(Q6)* | new `job.acceptance_expired` |

- Acceptance itself sends no notification; it is visible in the management
  list (§8). *(Q6.)*
- The deadline is read from the offer on the job detail and lists; the
  notification schema does not change.
- Each automatic notification is sent at most once per offer and kind (durable
  delivery identity, as in OVR-4). Transport failure never changes offer or
  lifecycle state.

### 8. Management recovery

A management "needs action" list shows jobs in the window whose latest offer
is `DECLINED`, `RELEASED`, `EXPIRED` or `WITHDRAWN` (`PLANNED_WINDOW_PASSED`),
`OPEN` offers with an `urgent_reason`, and `OPEN` offers whose `acceptance_due_at` has
passed (computed at read time, so the list stays correct while the expiry
worker is off). Management may:

- **reassign** to another active Staff member (opens a new offer);
- **re-offer to the same Staff member** (new management action with
  `clientActionId` and `expectedVersion`). Rejected with 409 only while an
  `OPEN` offer is still live (`requestTime < acceptance_due_at`). An `OPEN`
  offer whose deadline has passed (expiry worker off or not yet run) is closed
  as `EXPIRED` in the same transaction that opens the new offer, so recovery
  never waits for the worker. Allowed on any `NEW` `PRODUCT_DELIVERY` / `SALES_MEETING` with a
  `scheduledAt`, including a pre-rollout job with no offer, which it brings
  into the window as an explicit management choice;
- **reschedule** (opens a new offer);
- **cancel** with a reason when the delivery cannot happen.

Every one of these that opens an offer is subject to the "planned window
already too short" rule in §3: when the remaining time before
`scheduled_ends_at` cannot fit the minimum window, management must
reschedule. This prevents a Staff member from being charged with OVR-2
`LATE_START` for accepting on time, and gives the new commitment its own
schedule revision.

### 9. Concurrency, idempotency and versioning

- Every offer change happens under the JobCard row lock, following the
  existing lock order (users → job card → lifecycle intents).
- `DECLINE_ASSIGNMENT` and `RELEASE_ASSIGNMENT` are lifecycle commands:
  migration widens the 049 `job_card_lifecycle_intents.command` CHECK; the
  reservation preflight reads the offer state in its transaction.
- Decline, release and re-offer increment `job_cards.version`. Expiry does not.
  Each command re-checks its own required offer state under the lock (accept
  and decline: `OPEN`; release: `ACCEPTED` for the actor) and returns a 409 on a
  stale view.

### 10. Evidence, accountability and reports

- Every offer open, close and re-offer appends an activity row in the same
  transaction as the change.
- Expiry is recorded as "not answered in time", never as Staff fault: a
  notification `read_at` is a client receipt, not proof of having seen it.
- Offer outcomes are **not** added to Staff performance metrics, on-time rates
  or OVR incidents by this record. Any future report follows REPORT-001.
- OVR-2 `LATE_START` is unchanged (boundary `scheduled_ends_at`, accepted jobs
  only, existing recovery across revisions).

### 11. Existing jobs at rollout

`NEW` and `ACCEPTED` jobs that exist before the migration get no offer and no
deadline; none is fabricated. They keep pre-JOB-010 rules until a management
producer (§3) opens an offer for them *(Q4)*. The early-start tolerance (§1a) applies to
them from release 1.

### 12. Started work that cannot be completed

An early or on-time `START` does not mean the visit or delivery succeeded.
After `START`, Staff record what actually happened inside the existing JobCard:

- the customer was available: the visit or delivery proceeds as today;
- the customer is not ready: Staff wait; nothing is recorded;
- the contact is absent, refuses or asks for later: Staff record that outcome
  and use the existing follow-up / reschedule paths;
- a delivery happened early: the real `deliveredAt` is recorded.

**No fabricated actual times.** A visit that did not happen never gets a
`meetingAt`, and an item that was not delivered never gets a `deliveredAt`.
No separate arrival workflow is created.

**Known gap (closed by D1, release 2a).** Today a Sales Meeting cannot be submitted without a
valid `meetingAt`, even with outcome `FOLLOW_UP_REQUIRED` and an
`unsuccessfulReason` (`CONTACT_NOT_AVAILABLE`, `CONTACT_BUSY`,
`CUSTOMER_UNREACHABLE`, `REQUESTED_LATER`, `OTHER`) —
`server/src/modules/job-cards/submission-policy.ts:120-171`. Delivery
submission likewise requires a valid `deliveredAt` on every item. A visit
that did not happen therefore cannot be closed truthfully except by `CANCEL`.
Decision D1 closes it: an empty `meetingAt` for a visit that did not happen,
and a change/termination request for a delivery that could not be handed
over.

## Decision D1 — cancellation is a management power (2026-11-20)

Accepted by the owner. It replaces the earlier open question and applies to
**every JobCard type**, not only jobs in the acceptance window.

1. **STAFF never execute `CANCEL`.** MANAGER/ADMIN keep reasoned cancellation
   in every active status. This supersedes the `PRODUCT_REQUIREMENTS.md`
   Staff-cancellation invariant and, for Staff, the JOB-009 statement that
   assigned Staff may choose the follow-up continuity decision (management
   chooses it when cancelling). `WEEKLY_REPORT` was already manager-only.
2. **Before `START`:** Staff use `DECLINE_ASSIGNMENT` / `RELEASE_ASSIGNMENT`
   (§5) for jobs in the window. For jobs outside the window, Staff use the
   change/termination request below.
3. **Change/termination request** (Staff, any active status, own job):
   structured reason (customer changed their mind, wrong product, missing
   stock or equipment, visit could not happen, other) plus mandatory text.
   - It never changes the JobCard status and deletes nothing. At most one open
     request per job; idempotent through `clientActionId`; activity row in the
     same transaction; all active MANAGER/ADMIN are notified.
   - Management resolves it: correct the job, reschedule (only where the
     lifecycle still allows it), create a linked new job, cancel with a
     reason, or reject and ask for more information. Request, decision, actor,
     reason and instants are kept in history.
   - A started job is never rescheduled by erasing `startedAt` or
     responsibility facts: management closes it with its real outcome (or
     cancels it) and creates a linked new job when the work must happen again.
4. **Truthful outcomes first.** A Sales Meeting that did not take place
   (contact absent, unreachable, asked for later) can be submitted through the
   existing approval path with `meetingAt` empty, using outcome
   `FOLLOW_UP_REQUIRED` and an `unsuccessfulReason`. A delivery that could not
   be handed over goes through the change/termination request. No
   `meetingAt` / `deliveredAt` is ever fabricated.
5. **Lateness while a request is open.** Existing incidents are never closed
   or rewritten by a request. While a request is open, OVR-4 automatic Staff
   reminders for that job stop, and the time from the request to the
   management decision is measured as management wait, separately from Staff
   lateness.
6. **Staff self-created jobs are included** (no exception); the management
   load is reviewed after rollout.
7. **Performance.** Management-approved operational reasons (customer
   withdrew or postponed, customer absent, wrong product, stock or equipment
   problem) and a management cancellation on a Staff request are never Staff
   fault: they stay visible with their reasons in activity and operational
   reports but never lower a performance score, failed-completion count or
   lateness KPI. Previously recorded, provable lateness incidents are kept;
   evidence and fault remain separate concepts. REPORT-001 attribution rules
   apply.
8. **Never strand Staff.** Staff `CANCEL` is removed only in the same
   activation that makes the request path, the empty-`meetingAt` submission and
   the management decision list available.

## Owner answers (2026-11-20)

The owner accepted every draft default below. Inline *(Qn)* references in the
decision point to these answers.

| # | Question | Answer |
| - | -------- | ------------- |
| Q1 | Minimum response window | 10 minutes |
| Q2 | Staff reminder in V1, and when | Yes, once, halfway between open and deadline |
| Q3 | Staff cancellation for jobs in the window in `IN_PROGRESS` and later | Superseded by decision D1: Staff never cancel any JobCard |
| Q4 | Pre-rollout `NEW` jobs | No offer until the next management producer |
| Q5 | Decline/release reason codes | `SCHEDULE_CONFLICT`, `ON_LEAVE`, `TOO_FAR`, `MISSING_STOCK_OR_EQUIPMENT`, `OTHER` |
| Q6 | Who receives management notifications; notify on accept? | All active MANAGER/ADMIN (as OVR-4); no accept notification |
| Q7 | Remove the acceptance not-before gate for all types | Yes |
| Q8 | Include `GENERAL_TASK` with `scheduledAt` | No |
| Q9 | May Staff change the customer time of a job in the window? | No — `scheduledAt`, `scheduledEndsAt` and `dueDate` in `NEW` and `ACCEPTED` are management-only (widened from `NEW` only in the 2026-11-20 pre-merge review) |

### Pre-merge owner decisions (2026-11-20)

Recorded from the owner's PR #470 review, before merge:

- **P1-A:** late accept/decline is blocked by the server against
  `acceptance_due_at` on every request, independent of the expiry worker (§4).
- **P1-B:** customer-time fields are management-only in `NEW` and `ACCEPTED`
  for jobs in the window (§4, Q9).
- **P1-C:** an offer opened after the planned start needs an explicit
  management acknowledgement or a reschedule; compound producers mark it
  `START_PASSED` (§3).
- **Early START:** 30-minute tolerance for `PRODUCT_DELIVERY` and
  `SALES_MEETING`; earlier only with a management authorization or reschedule;
  no arrival workflow (§1a).
- **Outcomes:** no fabricated `meetingAt` / `deliveredAt`; failed-visit
  submission is resolved by D1 (§12).
- **D1** decided later the same day (see "Decision D1").

## Release plan

Documentation ships with the code PR that implements it (no documentation-only
PRs). Powers are removed from Staff only behind an activation flag that stays
off until every replacement path is merged; turning it on in production is a
separate, explicitly approved step.

| Release | Content | Effect on Staff |
| ------- | ------- | --------------- |
| **1** | Accept before start (§1); 30-minute early START and early-start authorization (§1a) | Only widens; ships alone |
| **2a** | Change/termination request, management decision list and notifications, empty `meetingAt` for a visit that did not happen (D1) | Unchanged; Staff `CANCEL` still available |
| **2b** | Assignment offers, deadline, server-side deadline check, decline/release, re-offer, urgency, management-only customer time, expiry worker (§3–§9) | Behind the activation flag, off |
| **2c** | Activation: Staff `CANCEL` removed for every type; deadline and window rules enforced | Only after 2a and 2b are merged and the owner approves |

Every release ships PostgreSQL integration tests for its server rules and UI
regression tests for the screens it changes.

## Acceptance scenarios

Times use one organization timezone; the job is planned 14:00–15:00 and
assigned at 12:00 unless stated.

| # | Scenario | Expected | Release |
| - | -------- | -------- | ------- |
| A1 | Staff accepts at 12:30 | Accepted; no lateness incident | 1, 2b |
| A2 | Staff accepts at 12:59:59.999 | Accepted (deadline 13:00) | 2b |
| A3 | Staff accepts at 13:00, expiry worker off | 409 `ACCEPTANCE_WINDOW_CLOSED`; nothing written; job in management list | 2b |
| A4 | Staff declines at 13:05, worker off | Same 409; job stays `NEW`, not cancelled | 2b |
| A5 | Accept reserved 12:59:59, finalized after 13:00 | Accepted (reservation instant wins) | 2–3 |
| A6 | Management re-offers the same Staff at 13:10, expiry worker off | Overdue offer closed as `EXPIRED`; new offer, deadline 13:20; Staff can accept; both offers kept in history | 2b |
| A7 | Staff patches `scheduledAt`, `scheduledEndsAt` or `dueDate` in `NEW` or `ACCEPTED` | 403; nothing written | 2b |
| A8 | Accepted job, Staff starts at 13:30 | `IN_PROGRESS`; `scheduledAt`/`scheduledEndsAt` unchanged; `startedAt` 13:30; START location policy applied | 1 |
| A9 | Accepted job, Staff starts at 13:29:59.999 without authorization | Rejected; nothing written | 1 |
| A10 | Management authorizes early start, Staff starts at 13:15 | `IN_PROGRESS`; `scheduledAt`/`scheduledEndsAt` unchanged; `startedAt` 13:15; authorization recorded with actor, instant, revision | 1 |
| A11 | Authorization granted, then management reschedules or reassigns | Authorization void; tolerance applies to the new time; a `dueDate`-only change keeps it | 1 |
| A12 | Early start never produces `LATE_START` | No incident | 1 |
| A13 | Management assigns at 14:10 (start passed, end 15:00) without acknowledgement | 409; with acknowledgement: offer `urgent_reason = START_PASSED`, acknowledgement stored, deadline 14:20 | 2b |
| A14 | Management assigns at 14:55 (window does not fit before 15:00) | 409; must reschedule | 2b |
| A14b | Management assigns at 13:30 (start not passed) | Offer `urgent_reason = SHORT_NOTICE`, deadline 13:40 | 2b |
| A15 | Offer expires | JobCard stays `NEW` and assigned; management can reassign, re-offer, reschedule or cancel | 2b |
| A16 | Started visit, contact absent | Submitted with `FOLLOW_UP_REQUIRED`, `unsuccessfulReason`, empty `meetingAt`; approved by management | 2a |
| A17 | Started delivery, nothing handed over | Staff send a termination request; status unchanged; management cancels with a reason; `startedAt` kept; no `deliveredAt` | 2a |
| A19 | Staff try `CANCEL` on any JobCard type and status after activation | Rejected; nothing written | 2c |
| A20 | Request open on a late job | No further OVR-4 Staff reminder; incident kept; request→decision time reported as management wait | 2a |
| A21 | Management cancels on a Staff request | Staff performance metrics unchanged by it | 2a |
| A18 | Offboarding transfers an `IN_PROGRESS` job | No offer opened; job not in the management list | 2b |

## Consequences

- New migrations: early-start authorization table and its activity event type
  (release 1); change/termination request table (2a); offer table, widened 049
  lifecycle-intent command CHECK, further activity event types and
  notification kinds (2a–2b). `JobCardStatus` is
  unchanged.
- The `START` tolerance and the authorization check change `policy.ts`
  (`timeEligible`) and `JobPermissionSubject`: the permission subject must carry
  whether a valid authorization exists, so the lifecycle reservation/finalize
  checks and every read that computes `allowedCommands` (detail, list, board)
  load it.
- Producers to update: job create paths, patch (reassign/reschedule), JOB-008
  approval, JOB-009 replacement, offboarding transfer (which also starts
  sending `job.reassigned`), ADMIN invalidation (withdraws the offer).
- Demo-data purge order includes the new tables.
- `PRODUCT_REQUIREMENTS.md` lifecycle invariants are amended with this
  acceptance; `SERVORA_MED_API_DRAFT.md` gains the decline/release and re-offer
  endpoints in the release that adds them.
- New env flag for the expiry worker, off by default; production activation is
  a separate, explicit step.
