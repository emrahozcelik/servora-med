# Assignment acceptance window and delivery rescue (JOB-010)

- **Status:** DRAFT r4 — owner answered Q1–Q9 with the draft defaults
  (2026-11-20, "Evet, kabul et"). The record itself is not yet accepted and
  grants no implementation permission. On owner acceptance, the decision
  section moves into `DECISIONS.md` as `JOB-010`.
- **Date:** 2026-11-20
- **Scope:** Management-assigned `PRODUCT_DELIVERY` and `SALES_MEETING`
  JobCards before work starts: when Staff may accept, how long they have, how
  they decline or release the job, what happens when nobody answers, and how
  management recovers the customer commitment.
- **Extends:** JOB-006 (acceptance), JOB-008 / JOB-009 (follow-up visit
  creation paths), Staff offboarding transfer. **Amends:** the
  `PRODUCT_REQUIREMENTS.md` Staff-cancellation invariant for jobs in the acceptance window, in
  `NEW` and `ACCEPTED` only. Earlier records are not rewritten.

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

## Decision (proposed)

### 1. Acceptance and start are separate time rules

- `ACCEPT_ASSIGNMENT` is no longer gated by `scheduledAt`, for every JobCard
  type *(Q7)*. It removes an unrecorded restriction and adds no rule.
- `START` keeps the existing not-before `scheduledAt` gate, the planned
  interval requirement and location rules.

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
  offboarding transfer, and management re-offer (§8).
- **Fields:** job, assignee, `opened_at`, `opened_reason` (one of the producers
  above), opening actor (always the authenticated management actor;
  offboarding runs as an ADMIN), `acceptance_due_at`, `urgent` flag, state,
  closing instant, closing actor, closing reason. An optional link to the assignment-history row exists only
  when the producer wrote one; an offer is not required to have one.
- **States:** `OPEN`, `ACCEPTED`, `DECLINED`, `RELEASED`, `EXPIRED`,
  `WITHDRAWN`. At most one `OPEN` offer per job (database-enforced). Closed
  offers are never reopened or edited; the single exception is the one-way
  `ACCEPTED -> RELEASED` step in §5.
- **Closers:** accept → `ACCEPTED`; decline → `DECLINED`; release (§5) →
  `RELEASED`; expiry (§6) → `EXPIRED`; management reassign, reschedule, cancel,
  ADMIN invalidation and offboarding transfer → `WITHDRAWN`.
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

### 4. Acceptance deadline

One rule, computed by the server at offer open:

```
acceptance_due_at = max(scheduledAt − 60 min, opened_at + minimum window)
urgent            = acceptance_due_at > scheduledAt − 60 min
```

- Minimum window *(Q1)* keeps every deadline answerable, including system
  producers (JOB-008 approval, JOB-009 replacement, offboarding) that cannot
  ask anyone for a value, and late re-offers.
- `urgent` offers are shown to management as "customer time at risk".
- No manual deadline override in V1.
- **Boundary:** a reservation with `reserved_at < acceptance_due_at` is on
  time; `reserved_at >= acceptance_due_at` is late (same equality rule as
  `LATE_START`).
- **Staff schedule edits never move a deadline or open, withdraw or reopen an
  offer.** Only management actions and the producers above do. *(Q9: whether
  Staff may still edit `scheduledAt` of a job in the window while it is `NEW`.)*

### 5. Staff answers

- **Accept:** `ACCEPT_ASSIGNMENT`, now allowed before `scheduledAt`, only on an
  `OPEN` offer.
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
  unchanged *(Q3)*.

### 6. Expiry

- A clock-only worker (OVR-3 conventions: bounded batch, per-job row lock,
  injected clock, opt-in env flag defaulting to off) closes an `OPEN` offer as
  `EXPIRED` once `acceptance_due_at` has passed.
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
`OPEN` offers marked `urgent`, and `OPEN` offers whose `acceptance_due_at` has
passed (computed at read time, so the list stays correct while the expiry
worker is off). Management may:

- **reassign** to another active Staff member (opens a new offer);
- **re-offer to the same Staff member** (new management action with
  `clientActionId` and `expectedVersion`; rejected with 409 while an offer is
  `OPEN`). Allowed on any `NEW` `PRODUCT_DELIVERY` / `SALES_MEETING` with a
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

`NEW` jobs that exist before the migration get no offer and no deadline; none
is fabricated. They keep pre-JOB-010 rules until a management producer (§3)
opens an offer for them *(Q4)*.

## Owner answers (2026-11-20)

The owner accepted every draft default below. Inline *(Qn)* references in the
decision point to these answers.

| # | Question | Answer |
| - | -------- | ------------- |
| Q1 | Minimum response window | 10 minutes |
| Q2 | Staff reminder in V1, and when | Yes, once, halfway between open and deadline |
| Q3 | Staff cancellation for jobs in the window in `IN_PROGRESS` and later | Unchanged |
| Q4 | Pre-rollout `NEW` jobs | No offer until the next management producer |
| Q5 | Decline/release reason codes | `SCHEDULE_CONFLICT`, `ON_LEAVE`, `TOO_FAR`, `MISSING_STOCK_OR_EQUIPMENT`, `OTHER` |
| Q6 | Who receives management notifications; notify on accept? | All active MANAGER/ADMIN (as OVR-4); no accept notification |
| Q7 | Remove the acceptance not-before gate for all types | Yes |
| Q8 | Include `GENERAL_TASK` with `scheduledAt` | No |
| Q9 | May Staff edit `scheduledAt` of a job in the window while `NEW`? | No — the time is a customer commitment set by management |

## Delivery slices (each its own PR, in order)

1. **Acceptance gate removal (§1).** Policy and tests only; no schema change.
2. **Offer model, decline/release, cancel restriction (§3, §5, §9, §11).**
3. **Deadline and expiry worker (§4, §6).**
4. **Notifications and management list (§7, §8).**

## Consequences

- New migration: offer table; widened 049 lifecycle-intent command CHECK;
  activity event types; notification kinds. `JobCardStatus` is unchanged.
- Producers to update: job create paths, patch (reassign/reschedule), JOB-008
  approval, JOB-009 replacement, offboarding transfer (which also starts
  sending `job.reassigned`), ADMIN invalidation (withdraws the offer).
- Demo-data purge order includes the new tables.
- `PRODUCT_REQUIREMENTS.md` lifecycle invariants and `SERVORA_MED_API_DRAFT.md`
  (decline/release and re-offer endpoints) are amended on acceptance.
- New env flag for the expiry worker, off by default; production activation is
  a separate, explicit step.
