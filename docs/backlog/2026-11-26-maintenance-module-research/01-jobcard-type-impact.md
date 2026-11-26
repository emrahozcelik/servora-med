# 01 — JobCard type impact inventory for a new `MAINTENANCE` type

> **Owner review update (2026-11-26):** Historical baseline 89bf6b1. #513 is now merged (6b909356); the claimed weekly-report merge conflict was refuted in README §3. Rebaseline remaining dispatch points before implementation; [07](07-owner-approved-product-direction.md) controls duration, acceptance, occupancy, and rollout.

Baseline: `origin/main` @ `89bf6b1` (worktree `maintenance-module-research-b97e8e`).
Scope: `server/src/modules/job-cards/**` + the migrations that constrain its
vocabulary. Read-only research; nothing implemented.

**Summary (10 lines)**

1. The JobCard module has **no single dispatch owner** for "what a type means".
   The meaning of a type is smeared across ~40 independent allowlists, SQL
   `IN` lists, `Record`s and if-chains; exactly **one** of them (follow-up
   default type) is compile-time total today.
2. PR #513 (`origin/refactor/job-card-exhaustive-dispatch`) makes **two** of
   them exhaustive: the *status* chain in `getAllowedLifecycleCommands`
   (`policy.ts:115-147`) and the *type* chain in `evaluateSubmission`
   (`submission-policy.ts:371-390`). It does not touch the other ~38.
3. Worst silent-inheritance points for a new type today: **staff occupancy**
   (`occupancy.ts:70`), **canonical duration / planned interval**
   (`job-card-duration.ts:5,42`), **effective submission deadline**
   (`overdue-incidents.ts:140` + 3 copies), **submission readiness** (falls into
   `evaluateMeeting` → 500 `INVARIANT_VIOLATION`), **job actions**
   (`policy.ts:190`), **assignment offers** (`assignment-offer-policy.ts:35`),
   **on-site classification** (`customer-schedule.ts:16`).
4. Creation is **fail-closed**: `create-input.ts:53-56` and `service.ts:1852`
   reject anything outside the three public create types with 400, and the DB
   `job_cards_type_check` (`057:5-7`) would reject the row anyway (raw 23514 →
   500, no mapper in this module).
5. The owner's hypothesis (assignment/lifecycle/approval stay in JobCard;
   device service history lives in Maintenance) is **supported by the code
   shape**: nothing in the lifecycle path is per-type except approval-time
   follow-ups and delivery/sale pairing, both of which are already optional
   branches. The hard coupling is *scheduling* (duration, occupancy, early
   start, slots, lateness), not lifecycle.
6. A `MAINTENANCE` type therefore needs **two prerequisite refactors** before
   any Maintenance model work: one shared "on-site / planned-interval /
   offer-eligible" type predicate set, and one exhaustive dispatch seam.
7. The weekly-report branch rewrites only **the tail of `evaluateSubmission`**
   among the dispatch points below (plus removing weekly-report producers).
   Exhaustiveness work does not need to wait for it, but the `submission-policy`
   hunk will textually conflict and must be rebased.
8. Recommended order: (a) consolidate the "on-site/interval" predicate (1 PR),
   (b) land #513, (c) make duration + job-actions + deadline exhaustive
   (1-2 PRs), (d) only then add the `MAINTENANCE` literal + migration.
9. Two DB CHECKs are hard gates: `job_cards_type_check` and
   `job_cards_follow_up_proposal_present_check` (`027:37`, only three types).
10. Nothing here decides *product* behaviour for Maintenance; every row marked
    **B** is an owner decision, not an engineering default.

---

## 1. How a type enters the system today (the gate chain)

| Step | Where | Behaviour |
| --- | --- | --- |
| Vocabulary | `types.ts:29-30` (`JOB_CARD_TYPES` / `JobCardType`) | Adding a literal widens every consumer; only `Record<JobCardType,…>` sites break the build. |
| DB | `057_sale_from_visit.sql:5-7` `job_cards_type_check` | `IN ('PRODUCT_DELIVERY','GENERAL_TASK','SALES_MEETING','WEEKLY_REPORT','SALE')`. A new literal needs a migration; violation = PG `23514`, unmapped in `job-cards` ⇒ global 500 (`app.ts:243-249`, `errors/*:49-52`). |
| Create body | `create-input.ts:36-40` (`CREATE_FIELDS_BY_TYPE`), `:50-62` (`exactRecord`) | Per-type exact field allowlist; unknown type → 400 `type`. |
| Create service | `service.ts:1851-1881` | Second allowlist (`PRODUCT_DELIVERY|SALES_MEETING|GENERAL_TASK`) → 400 `INVALID_JOB_TYPE`. |
| Create union | `types.ts:408-450` (`JobCardCreateInput`, `NormalizedJobCardCreateInput`) | Closed discriminated union; a new type needs a new member before any code can construct it. |
| Follow-up create | `create-input.ts:279-297`, `service.ts:3074-3081` | Same three-type allowlist. |
| Follow-up proposal | `service.ts:8583-8588` | Rejects `WEEKLY_REPORT`, `SALE`, and any value not in `JOB_CARD_TYPES`. |
| DB follow-up | `027_follow_up_proposals.sql:37` | `follow_up_proposed_type IN ('PRODUCT_DELIVERY','GENERAL_TASK','SALES_MEETING')`. |

Observed: the *write* side is closed by three independent allowlists plus the
DB. The *read/behaviour* side (below) is mostly open and silently permissive.

---

## 2. Dispatch-point inventory

Legend

* **Behaviour for a new type** — `silent-inherit`: no compile error and no
  throw; the new type reuses a branch written for another type.
  `fail-closed`: an explicit allowlist rejects. `compile-error`: a total
  `Record`/union forces a change. `db-reject`: PG constraint.
* **Class** — **A** must become exhaustive (or be driven by one shared
  predicate) *before* the type is added; **B** needs an explicit per-type
  decision during MAINTENANCE design; **C** safe default (no change needed, or
  change is local and obvious).
* **WR** — does `origin/refactor/weekly-report-submission` rewrite this region?
* **#513** — does `origin/refactor/job-card-exhaustive-dispatch` already make it
  exhaustive?

| id | file:line | construct | behaviour for a new type | #513? | class | WR |
| --- | --- | --- | --- | --- | --- | --- |
| D01 | `types.ts:29-30` | `JOB_CARD_TYPES` tuple / union | widening only | n/a | A (the literal is the trigger) | no |
| D02 | `migrations/057:5-7` | `job_cards_type_check` | `db-reject` (23514 → 500) | n/a | A (migration) | no |
| D03 | `migrations/027:37` | `follow_up_proposed_type` CHECK | `db-reject` only if a MAINTENANCE child is proposed; defaults keep it out | n/a | A if MAINTENANCE can be a proposal type, else C | no |
| D04 | `create-input.ts:36-62` | `CREATE_FIELDS_BY_TYPE` + `exactRecord` | `fail-closed` 400 `type` | no | C (safe) → B when opened | no |
| D05 | `create-input.ts:279-297` | `FOLLOW_UP_FIELDS_BY_TYPE` + `exactFollowUpRecord` | `fail-closed` 400 `type` | no | C → B | no |
| D06 | `create-input.ts:380-391` | `PREVIEWABLE_JOB_TYPES` | `fail-closed` 400 `type` (no schedule preview) | no | C → B (if on-site) | no |
| D07 | `create-input.ts:407-415` | `parseAvailableSlotsInput` type check | `fail-closed` 400 `type` (no slot search) | no | C → B (if on-site) | no |
| D08 | `service.ts:1852-1854` | create allowlist | `fail-closed` 400 `INVALID_JOB_TYPE` | no | C → B | no (WR deletes other create paths) |
| D09 | `service.ts:3079-3081` | follow-up create allowlist | `fail-closed` 400 | no | C → B | no |
| D10 | `policy.ts:115-147` | status chain in `getAllowedLifecycleCommands` | **already silent-inherit today**: last branch is "waiting approval" | **yes** (adds `WAITING_APPROVAL` branch + `assertNeverJobCardValue(status)`) | A, covered by #513 | no |
| D11 | `policy.ts:54-56,64-75` | `acceptsEarlyStart` (30-min tolerance + authorization) | `silent-inherit`: new type gets the strict `requestTime >= scheduledAt` floor and its authorization is ignored | no | **B** (is an on-site visit early-startable?) + recommend A-style total set | no |
| D12 | `policy.ts:190-201` | `getAllowedJobActions` type branch (`!== 'SALES_MEETING'`) | `silent-inherit`: new type gets notes + change-request only; no result/docs actions | no | **A** (this is the V11 silent fall-through for *actions*) | no |
| D13 | `submission-policy.ts:371-390` | `evaluateSubmission` chain | `silent-inherit` → **`evaluateMeeting`**: every readiness item becomes `MEETING_*`; submit fails **500 `INVARIANT_VIOLATION`** (no `job_card_meeting_details` row, `:173-178`) | **yes** (if/if/`never` ⇒ compile error) | A, covered by #513 | **yes** (same function tail) |
| D14 | `job-card-duration.ts:5-8` | `CANONICAL_JOB_DURATION_MS: Partial<Record<…>>` | `silent-inherit`: `null` duration ⇒ no canonical end; `canonicalScheduledEndsAt` (`create-input.ts:105-123`, `!` non-null) would throw if reached | no | **A** (make it `Record<JobCardType, number \| null>`) | no |
| D15 | `job-card-duration.ts:42-44,53-63` | `isPlannedIntervalJobType` / `hasValidPlannedInterval` | `silent-inherit`: new type is exempt from the START interval invariant (both bounds may be NULL) | no | **B** (decision) + A (same predicate as D16/D17) | no |
| D16 | `occupancy.ts:70` | SQL `j.type IN ('SALES_MEETING','PRODUCT_DELIVERY')` | `silent-inherit`: **new type never occupies staff** ⇒ no `CALENDAR_CONFLICT`, double booking allowed, slot search blind to it | no | **A** (SCH-001 core invariant) | no |
| D17 | `customer-schedule.ts:16-18` | `isOnSiteJobType` | `silent-inherit`: new type is not "on-site" ⇒ excluded from available-slots (`service.ts:9072,9093`) and preview | no | **B** + A (same predicate as D16) | no |
| D18 | `customer-schedule.ts:25-27,165-167` + `repository.ts:3854-3920` | customer-frequency observation (`type === 'SALES_MEETING'`) | `silent-inherit`: no frequency advisory, no duplicate-visit check | no | C (safe default) → B if repeated maintenance should warn | no |
| D19 | `assignment-offer-policy.ts:35-37` | `isAssignmentOfferJobType` | `silent-inherit`: new type is **never** offer-eligible ⇒ `NEW` jobs sit unaccepted, no JOB-010 window, no JOB-012 proposal (`service.ts:5546,5708`) | no | **B** (biggest product decision) | no |
| D20 | `follow-up-policy.ts:86-96` | `FOLLOW_UP_TYPE_DEFAULTS: Record<JobCardType, JobCardType>` | `compile-error` — **already exhaustive** | no | A (already satisfied) | no |
| D21 | `follow-up-policy.ts:109-134` | `requiresMandatoryFollowUpProposal`, `isFollowUpVisit` | `silent-inherit`: no mandatory follow-up, not a follow-up visit | no | C | no |
| D22 | `overdue-contract.ts:80-84,97-107,113-123` | current-overdue predicate (+`WEEKLY_REPORT`/`WAITING_APPROVAL` exemption) | `silent-inherit`: due-date lateness applies to the new type unchanged | no | C (desired if due-date driven) | no |
| D23 | `overdue-incidents.ts:130-149,266-284` | `effectiveSubmissionDeadlineAt` / `…Sql` (`SALES_MEETING ? null : scheduledAt`) | `silent-inherit`: **`scheduled_at` is used as the submission deadline** even with no interval end | no | **B** + A (4 copies, see D25/D26/D24) | no |
| D24 | `overdue-breach-producer.ts:314-315` | `planLateSubmissionBreach` phase deadline | same `SALES_MEETING ? null : scheduledAt` copy | no | A (dedupe with D23) | no |
| D25 | `service.ts:8105-8107` | `originalSubmissionDeadline` | same copy | no | A (dedupe) | no |
| D26 | `service.ts:8306-8308` | `endOpenObligationsByExtension` first-late | same copy | no | A (dedupe) | no |
| D27 | `overdue-breach-scanner.ts:114-125,188-214` | `isEligibleStatus` (status only) | `silent-inherit`: new type automatically earns `LATE_START` / `LATE_SUBMISSION` incidents | no | **B** (are maintenance visits late-start accountable?) | no |
| D28 | `lateness-alert-worker.ts:152` | `NON_FIELD_WORK_TYPES = ['WEEKLY_REPORT','SALE']` | `silent-inherit`: new type gets start reminders / past-start alerts | no | C → B (confirm) | no |
| D29 | `repository.ts:5453` (`unacceptedPastStartSql`) | `type NOT IN ('WEEKLY_REPORT','SALE')` | `silent-inherit`: new `NEW` past-start jobs appear on the management list + alert even though no offer exists | no | B (confirm intended) | line shifts only |
| D30 | `service.ts:5147-5158` | `grantEarlyStartAuthorization` type check | `fail-closed` 409 `EARLY_START_NOT_APPLICABLE` | no | C → B (align with D11) | no |
| D31 | `service.ts:3829-4068` | `patch()` per-type edit rules | if-chain; new type gets **no** type rule: `scheduledAt` may be nulled, `scheduledEndsAt` accepted as-is, no canonical repair | no | **A** (chain of `if (type === …)` with no else) + **B** per rule | no |
| D32 | `service.ts:6251-6253` | approve `delivery` only for `SALE` | `fail-closed` 400 | no | C | no (region untouched) |
| D33 | `service.ts:7632-7640` | weekly-report submit hook | `silent-inherit` no-op for other types | no | C | **yes** (becomes `appendWeeklyReportSubmission(tx, …)`) |
| D34 | `service.ts:8691-8693,8806-8812` | approval-time follow-up only `SALES_MEETING` | `fail-closed` 400 `FOLLOW_UP_PROPOSAL_INVALID` | no | C (unless approval-follow-up needed) | no |
| D35 | `service.ts:8962` | `getFollowUpSuggestion` rejects `SALE` | `silent-inherit` (new type allowed to suggest) | no | C | no |
| D36 | `repository.ts:253-299` | lifecycle pair projection (`SALE`/`SALES_MEETING`) | `silent-inherit`: no partner ⇒ single-card lifecycle | no | C | no |
| D37 | `repository.ts:307-358` | sale↔delivery link projection | `silent-inherit`: no link rows | no | C | no |
| D38 | `service.ts:1132-1145` | `appendRealtimeForActivity` keys by `jobType` | `silent-inherit`: generic realtime keys only | no | C | no |
| D39 | `notes-service.ts:22` | `INVOICE_CAPABLE_JOB_TYPES` | `silent-inherit`: not invoice-capable | no | C | no |
| D40 | `policy.ts:360-378` | `assertProductDeliveryJob` / `assertSalesMeetingJob` | `fail-closed` 409 `INVALID_JOB_TYPE` | no | C → B if MAINTENANCE gets structured sub-resources | no |
| D41 | `migrations/071:78-121` | activity `event_type` CHECK | `db-reject` for any new event name (e.g. `MAINTENANCE_PART_USED`) | n/a | A only if new events are introduced | no |
| D42 | `repository.ts:2338-2355` | weekly source-work SQL `jc.type <> 'WEEKLY_REPORT'` | `silent-inherit`: new type appears in weekly report source work | no | C | **yes** (moves to `weekly-reports/`) |
| D43 | `history-port.ts:17,45,56,73-80` | `JobCardType` in history DTOs | type carried, no branching | no | C | no |
| D44 | `workspace-query.ts:47-51` | list/board `type` filter via `JOB_CARD_TYPES` | `silent-inherit`: filterable immediately | no | C | no |
| D45 | `service.ts:3557-3561` | `assertSaleCapability` | `silent-inherit`: unaffected | no | C | no |
| D46 | `sale-policy.ts:13-20` | `assertSaleSourceEligible` (`SALES_MEETING` only) | `silent-inherit`: cannot originate a sale | no | C | no |
| D47 | `critical-action-request-hash.ts:363-380` | create/proposal hashes include `type` | idempotency identity is type-correct by construction | no | C | no |
| D48 | `location-types.ts:33`, `start-location-input.ts`, `submit-location-comparison.ts` | START/SUBMIT location evidence | fully type-agnostic | no | C (works for free) | no |
| D49 | `installation-modules/registry.ts:7-26` | module key union (`key: 'OVERVIEW'`) | `compile-error` if a `MAINTENANCE` module key is added | n/a | A (separate slice, MOD-002) | no |

Non-dispatch points deliberately excluded: `sale-*` producers hard-code
`'SALE'`/`'PRODUCT_DELIVERY'` when *creating* (`sale-service.ts:227,321`,
`sale-approval-delivery-input.ts:80-90`, `service.ts:2864,3000,7773`) — they
never branch on an unknown type, so they are safe.

---

## 3. Topic findings

### 3.1 Staff occupancy (SCH-001)

* Single SQL owner: `occupancy.ts:47-88`; the job leg is
  `j.type IN ('SALES_MEETING','PRODUCT_DELIVERY')` (`:70`) with status set
  `NEW|ACCEPTED|IN_PROGRESS|WAITING_APPROVAL|REVISION_REQUESTED` (`:72`) and
  `scheduled_at`/`scheduled_ends_at` both NOT NULL (`:71`). Consumed by
  `assertCalendarAvailability` (`repository.ts:5088-5098`),
  `listAssigneeCalendarIntervals` (`repository.ts:3931-3943`) and therefore by
  the follow-up auto-scheduler and the available-slot search.
* SCH-001 §1 (`DECISIONS.md:3671-3700`) names the on-site set explicitly:
  "active on-site jobs (`SALES_MEETING`, `PRODUCT_DELIVERY` …)". So the current
  list is policy, not accident — and a new on-site type is **not** covered by
  the decision.
* The same "on-site/interval" idea is re-expressed in five places:
  `occupancy.ts:70` (SQL), `customer-schedule.ts:16-18`,
  `job-card-duration.ts:42-44`, `policy.ts:54-56`, and implicitly in
  `create-input.ts:380,413`. They already differ: `policy.ts:55` is
  "early-startable", not "on-site".
* **Recommendation (inference):** introduce one exported constant
  `ON_SITE_JOB_TYPES` (or `PLANNED_INTERVAL_JOB_TYPES` + `EARLY_START_JOB_TYPES`)
  in `job-card-duration.ts` or `types.ts`, render the occupancy SQL from it, and
  keep the two genuinely different predicates separate. This is the single
  highest-value prerequisite: without it, adding MAINTENANCE to occupancy
  passes review while `isOnSiteJobType` stays stale (or vice versa).

### 3.2 Assignment offers / JOB-010 window / JOB-012 proposal

* Eligibility is one predicate: `assignment-offer-policy.ts:35-37`
  (`PRODUCT_DELIVERY|SALES_MEETING`), used by
  `isAssignmentOfferEligible` (`:44-52`), the policy window
  (`policy.ts:99-104`), re-offer (`service.ts:5546`) and proposal
  acceptance (`service.ts:5708`).
* Consequence of `silent-inherit` (new type excluded): a manager-created
  MAINTENANCE job lands `NEW`; the assigned technician gets
  `['ACCEPT_ASSIGNMENT','CANCEL']` without any offer (`policy.ts:123`) — i.e.
  the *release-2a* rules, no deadline, no reminder, no
  `PENDING_ACCEPTANCE` alert. That is a coherent fallback, but it must be a
  decision, because JOB-010 §3 uses `scheduled_ends_at` for the minimum window
  and a maintenance visit is exactly the kind of appointment where a
  10-minute acceptance window matters.
* JOB-012's proposed-interval derivation (`assignment-offer-policy.ts:128-140`)
  needs a persisted or canonical duration; with D14 returning `null` it
  returns `null` ⇒ "no proposal possible". So D19 and D14 must be decided
  together.
* SCH-001 §1 lists "assignment-time proposal and its approval (JOB-012)" among
  the core occupancy checks — if MAINTENANCE becomes offer-eligible, the
  proposal path must also route through `assertCalendarAvailability`.

### 3.3 Available slots (JOB-011)

* `POST /job-cards/available-slots` is core (SCH-001 §4). Input parser closed
  to two types (`create-input.ts:413-415`); service rejects non-on-site twice
  (`service.ts:9072-9074`, `:9093-9097`); duration comes from
  `canonicalScheduledEnd` (`:9061`) or the persisted duration (`:9104-9110`).
* A new type therefore cannot use slot search at all (`fail-closed`, 400
  `scheduledEndsAt`/`type`) — which is safe but means the Maintenance UI would
  ship its own scheduling widget unless D07/D14/D17 are resolved.
* Same-day candidate rule (JOB-011) lives in `available-slots.ts:57-134`
  (08:00–19:00 local, 30-min grid, no Sunday) and is type-agnostic apart from
  the duration it is given.

### 3.4 Early start (JOB-010 §1a)

* `acceptsEarlyStart` (`policy.ts:54-56`) drives both the 30-minute tolerance
  and whether a management authorization is honoured (`:70-73`). For a new
  type both are silently disabled — an authorized early start is stored
  (`service.ts:5110-5200`, table `job_card_early_start_authorizations`,
  migration 063) but has no effect. That is a silent policy divergence, not a
  crash, and the authorization would look "granted" in the UI while being
  inert.
* `grantEarlyStartAuthorization` itself is `fail-closed` for the new type
  (`service.ts:5147-5158`), so today the permission cannot even be created.
  The two lists must not drift: one set, used by both.

### 3.5 Duration and the JOB-007 occupied end

* Canonical durations exist only for `SALES_MEETING` (60 min) and
  `PRODUCT_DELIVERY` (30 min) (`job-card-duration.ts:5-8`); the type is
  `Partial<Record<…>>`, so an unknown type yields `null` **at runtime without a
  compiler warning** — the only truly dangerous "partial" in the module.
* `JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL` (`job-card-duration.ts:29-32`) is
  type-agnostic: `WAITING_APPROVAL` is released at `staff_completed_at`, else
  `scheduled_ends_at`. A new type inherits this correctly **if** it has a
  planned interval; with `scheduled_ends_at = NULL` it occupies nothing
  (occupancy requires both bounds, `occupancy.ts:71`).
* `hasValidPlannedInterval` (`:53-63`) is the START invariant (R3). A new type
  is exempt ⇒ a MAINTENANCE job could START with no planned interval and then
  never occupy a calendar slot. Decision required.

### 3.6 Overdue incidents (OVR-1 … OVR-6)

* The three delay types share one deadline authority
  (`overdue-incidents.ts:130-149`, `266-284`) with three identical copies of
  the phase rule at `overdue-breach-producer.ts:314-315`,
  `service.ts:8105-8107`, `service.ts:8306-8308`. For `SALES_MEETING` the
  `scheduled_at` fallback is deliberately suppressed (a meeting's start is not
  its deadline); every other type falls back to `scheduled_at`.
* A MAINTENANCE visit is much closer to a `SALES_MEETING` (a fixed appointment)
  than to a `PRODUCT_DELIVERY`/`GENERAL_TASK` (open-ended work), so the
  `else` branch is probably **wrong** for it — a silent inheritance of a rule
  designed for another shape. This is the clearest example of why the
  "4 copies, one `else`" pattern must become explicit before the type exists.
* Scanner eligibility is status-only (`overdue-breach-scanner.ts:114-125`), so
  MAINTENANCE would automatically accrue `LATE_START` (from `ACCEPTED`) and
  `LATE_SUBMISSION` (from `IN_PROGRESS`) incidents. Accountability is
  `STAFF`/`ASSIGNMENT_AT_BREACH` for late submission
  (`overdue-breach-producer.ts:349-367`) and `MANAGEMENT`/`ROLE_POLICY` for
  approval wait (`:401-417`) — both type-agnostic.
* Current-overdue list membership uses `due_date` only
  (`overdue-contract.ts:80-84`); the only type exception is
  `WEEKLY_REPORT`+`WAITING_APPROVAL` (`:83,105,121`). A new type joins the
  general rule — acceptable if MAINTENANCE carries `due_date`.

### 3.7 Submission readiness

* `evaluateSubmission` is the only per-type readiness dispatcher
  (`submission-policy.ts:358-391`). Its final `else` is the meeting branch; for
  a new type it produces `MEETING_TIME_VALID / MEETING_OUTCOME_VALID /
  MEETING_SUMMARY_PRESENT / FOLLOW_UP_TIME_VALID` items and, at submit time,
  the `!details` guard throws `INVARIANT_VIOLATION` **500**
  (`:173-178`). So today a new type is: detail screen renders junk readiness,
  submit returns 500.
* Called from three places: `service.ts:7386` (single submit),
  `service.ts:6976,6981` (pair submit) and `service.ts:9331-9333` (job detail
  projection for `IN_PROGRESS|REVISION_REQUESTED|WAITING_APPROVAL`).
* PR #513 fixes exactly this by converting the trailing ternary into
  `if (PRODUCT_DELIVERY) … if (SALES_MEETING) … const unhandledType: never`
  (`origin/refactor/job-card-exhaustive-dispatch:submission-policy.ts`).
  After it, adding MAINTENANCE is a compile error until a branch exists.
* Requirements are per-type data (customer, assignee, items/details) — the
  `SubmissionRequirementCode` union (`types.ts:858-866`) is *not* exhaustive
  over types and does not need to be; a `MAINTENANCE_RESULT_PRESENT`-style code
  would be a new union member (safe, additive).

### 3.8 Manager approval and revision

* Approval/revision are status-driven (`policy.ts:142-146`), not type-driven:
  every type can be submitted, approved, revised, withdrawn and resumed.
  Manager-only enforcement is role-based (`policy.ts:404-408`).
* The only type-conditional parts of approval are: (a) sale↔delivery
  (`service.ts:6251-6253`, `resolvePairPlan` `:6376-6430`), (b) weekly report
  submission snapshot (`:7632-7640`), (c) follow-up proposal
  (`service.ts:8679-8788`, `SALES_MEETING` only). All three are `fail-closed`
  or no-op for a new type ⇒ approval works out of the box.
* Approval-time "rescue delivery" (SALE-002 §5) is SALE-only and unaffected.

### 3.9 Invalidation

* `invalidate()` (`service.ts:1623-1700+`) is ADMIN-only
  (`policy.ts:21-23`), blocks on active follow-up children
  (`service.ts:1675-1685`) and writes `JOB_INVALIDATED` + `invalidated_*`
  columns. No `type` reference anywhere in the method ⇒ a new type is
  invalidatable with no change. **C.**
* DB invariants: `job_cards_invalidation_fields_check`,
  `job_cards_invalidation_reason_code_check` (`036:21-40`) — type-agnostic.

### 3.10 Cancel

* `cancel()` (`service.ts:6317-6325`) → `runLifecycle`; type-specific cancel
  behaviour is limited to (a) follow-up continuity for `SALES_MEETING` +
  `engagement_kind = FOLLOW_UP` (`follow-up-policy.ts:129-134`,
  `service.ts:6358-6360`), (b) pair co-cancel for a live sale pair
  (`service.ts:7508-7523`), (c) the OVR breach chain by *status*
  (`service.ts:8456-8500`).
* For a new type: no continuity requirement (correct), no pair (correct), and
  the breach chain runs by status — meaning a cancelled IN_PROGRESS maintenance
  visit materializes a `LATE_SUBMISSION` incident using the D23 deadline rule.
  **B** (inherits D23/D27).
* Staff CANCEL is filtered out when the assignment window is on, or for
  `WEEKLY_REPORT` (`policy.ts:148-150`) — a new type keeps the pre-window
  staff-cancel right. **B** (confirm).

### 3.11 Follow-up creation

* Exhaustive-by-construction at the default map (`follow-up-policy.ts:86-96`).
  A new type **must** appear there ⇒ compile error until decided (the two
  existing non-obvious entries are `WEEKLY_REPORT→GENERAL_TASK` and
  `SALE→GENERAL_TASK`).
* Everything downstream is `fail-closed` or no-op for a non-meeting type:
  `requiresMandatoryFollowUpProposal` (`:109-122`), `isFollowUpVisit`
  (`:129-134`), approval-time follow-up (`service.ts:8691-8713`), auto
  scheduling (`service.ts:8805-8812`), suggestion (`service.ts:8995`).
* If MAINTENANCE should generate a follow-up (e.g. next service visit), the
  `follow_up_proposed_type` DB CHECK (D03) and the follow-up create allowlists
  (D05/D09) must be extended in the same slice.

### 3.12 Activity log events

* Event union: `types.ts:308-334`. DB CHECK: latest re-issue in
  `071_sale_standalone_and_delivery_link.sql:78-121` (complete list, no
  `type` dimension). Adding an event is one migration + one union member; the
  presenter (`activity-presenter.ts`) is event-keyed, not type-keyed.
* `JOB_CREATED` / `JOB_ASSIGNED` / `JOB_STARTED` / `JOB_SUBMITTED_FOR_APPROVAL`
  / `JOB_APPROVED` / `JOB_REVISION_REQUESTED` / `JOB_RESUMED` /
  `JOB_CANCELLED` / `JOB_INVALIDATED` are all type-agnostic — a MAINTENANCE
  card produces a valid audit trail with no change. **C.**
* One caveat: `JOB_PLANNED`, `MEETING_DETAILS_UPDATED`, delivery-item and
  sale-item events are producer-specific; a maintenance-specific event (parts
  used, device serviced) must be added to **both** the union and the CHECK in
  the same PR (D41).

### 3.13 Idempotency (`clientActionId`)

* Every mutating entry point claims `processed_actions` /
  `job_card_lifecycle_intents` with a request hash that already includes
  `type` (`critical-action-request-hash.ts:363-380` create, `:382-401`
  product-delivery create, `:403-430` follow-up create; lifecycle identity is
  `(command, jobCardId, expectedVersion, …)`). No type dispatch, no drift risk.
  **C.**
* If MAINTENANCE gets its own create endpoint with its own operation key (as
  `PRODUCT_DELIVERY_CREATE` did), it needs its own `*_REQUEST_VERSION` +
  hash function — a pattern to copy, not a gap.
* `create()` already runs the offer producer inside the same transaction
  (`service.ts:1992-2002`), so "create + offer" atomicity is a reusable shape.

### 3.14 Customer / contact requirements per type

| Type | Create | Submit readiness | Patch |
| --- | --- | --- | --- |
| `PRODUCT_DELIVERY` | `customerId` required, `contactId` forbidden (`create-input.ts:167-169,191-194`; `service.ts:1857-1864,1866`) | customer must be active (`submission-policy.ts:65-96`) | cannot add contact (`service.ts:3876-3884`) |
| `SALES_MEETING` | `customerId` required, `contactId` optional (`create-input.ts:197-209`) | customer must exist/active (`submission-policy.ts:107-172`) | contact must belong to customer (`service.ts:4001-4008`) |
| `GENERAL_TASK` | both optional (`create-input.ts:211-216`) | title only (`submission-policy.ts:371-383`) | — |
| `WEEKLY_REPORT` | dedicated endpoint, no customer (`service.ts:2041+`) | report row (`submission-policy.ts:227-313`) | customer/time immutable (`service.ts:3893-3942`) |
| `SALE` | dedicated endpoint, customer required (`057:17-23` DB CHECK) | `submission-policy.ts:315-356` | customer/time immutable (`service.ts:3829-3832`) |
| **`MAINTENANCE` (new)** | **undecided** — a device visit implies a customer *and* probably a device; the DB `job_cards` has no device column | **undecided** | **undecided** |

Observed: `job_cards` has no device/asset column. The existing structured
per-type children are `job_card_meeting_details` (SALES_MEETING),
`job_card_delivery_items` + delivery header (PRODUCT_DELIVERY),
`job_card_sale_details` (SALE) and `weekly_reports` (WEEKLY_REPORT) — each
introduced by its own migration and owned by the module that reads it. A device
history would follow the same shape as a **new table keyed by job_card_id**
(`organization_id, job_card_id` UNIQUE), which is consistent with the owner
hypothesis (identity/assignment/approval in JobCard; service history in
Maintenance).

### 3.15 Location capture

* START capture: `service.ts:6100-6140` (soft-fail provider, `#347`),
  persisted by `appendJobActionLocation` with `action='JOB_STARTED'`.
* SUBMIT capture: `service.ts:6166-6224`, advisory comparison
  (`submit-location-comparison.ts:42-78`), DB CHECK
  `action IN ('JOB_STARTED','JOB_SUBMITTED_FOR_APPROVAL')`
  (`054_job_action_locations_submit_approval.sql:11`).
* Both are gated by `this.geolocation.enabled` and `actor.role === 'STAFF'`,
  never by type (`location-types.ts:33`). A MAINTENANCE visit gets on-site
  location evidence **for free** — likely a requirement for this domain, so
  this is a positive finding. **C.**
* No location code path branches on `type`: `parseStartLocationCapture`
  (`start-location-input.ts:1-74`) and `parseActionLocationCapture` validate
  the envelope only, and `appendJobActionLocation` writes the same row shape
  for every type.

---

## 4. Overlap with `origin/refactor/weekly-report-submission`

Branch stat over `server/src/modules/job-cards` only:

```
repository.ts        | 311 +-------
service.ts           | 831 ++++------------------
submission-policy.ts | 113 +--
3 files changed, 196 insertions(+), 1059 deletions(-)
```

Points from §2 the branch rewrites:

| Point | Overlap | Detail |
| --- | --- | --- |
| **D13** `submission-policy.ts:371-390` | **direct** | Removes the local `evaluateWeeklyReport` (moves to `weekly-reports/submission.ts`) and rewrites the `WEEKLY_REPORT` arm to `const { items, failure } = await evaluateWeeklyReport(…)`. The final `PRODUCT_DELIVERY ? … : evaluateMeeting` ternary is untouched, so #513 still applies — but both branches edit the same 8-line tail ⇒ textual conflict, trivial semantic resolution. |
| **D33** `service.ts:7632-7640` | **direct** | Replaces the private `appendWeeklyReportSubmission(tx, {actor, job, …})` with the module function taking `organizationId/staffUserId/jobCardId`. Line moves ~7632 → ~7110. |
| **D42** `repository.ts:2338-2355` | **direct (moderate)** | The SQL helper `selectWeeklySourceWork` (with `jc.type <> 'WEEKLY_REPORT'` at `:2353`) moves to `weekly-reports/`; the delegating `listWeeklySourceWorkSnapshot` stays on the repository (`:5236`, `:6375`). The `SubmissionReader` interface no longer declares `getOrganizationTimezone` / `getWeeklyReportByJobId` / `listWeeklySourceWorkSnapshot` itself (`repository.ts:1121-1140`) — it now *extends* `WeeklyReportSubmissionReader` (`weekly-reports/submission.ts:17-27`). So the SQL literal does leave job-cards, but the call sites do not. |
| D08/D09 producers | indirect | `createWeeklyReport`, `bulkRequestWeeklyReports`, `getWeeklyReport`, `removeWeeklyReport`, draft update, PDF and submission reads all leave `service.ts`/`repository.ts`; none of them is a type-dispatch point, but they dominate the diff and every rebase. |
| D22/D29 | cosmetic | `repository.ts` line numbers shift (`unacceptedPastStartSql` 5453 → 5223 on the branch). |

Not touched by the branch: `policy.ts` (D10-D12, D19's consumer),
`occupancy.ts`, `job-card-duration.ts`, `assignment-offer-policy.ts`,
`follow-up-policy.ts`, `overdue-*`, `customer-schedule.ts`, `create-input.ts`,
`workspace-query.ts`, migrations.

**Verdict.** Exhaustiveness work does **not** need to wait for the
weekly-report branch. Recommended sequencing:

1. If #513 is ready, merge it first — it is 2 files + tests and its
   `submission-policy` hunk is 12 lines.
2. The weekly-report branch then rebases one line (D13) plus the D33 call.
3. If the weekly-report branch merges first, #513 rebases the same way.
4. Never re-implement the `never`-check inside `weekly-reports/submission.ts`:
   the new type dispatch must stay in `job-cards/submission-policy.ts` (the
   module must not learn about JobCard types).

---

## 5. Recommended prerequisite order (PR-sized)

Each step is independently reviewable and leaves `main` green.

| # | PR | Contents | Why before MAINTENANCE |
| --- | --- | --- | --- |
| P1 | `refactor(job-cards): one on-site/planned-interval type predicate` | Export `PLANNED_INTERVAL_JOB_TYPES` (and a separate `EARLY_START_JOB_TYPES`) from `job-card-duration.ts`; render `occupancy.ts:70` SQL from it; replace `isOnSiteJobType` body and `acceptsEarlyStart` body with membership checks. Add a unit test asserting the SQL list equals the TS list. | Removes the 5-way duplication that would let MAINTENANCE be half-on-site (occupies nothing but is offered slots, or vice versa). No behaviour change for the 5 current types. |
| P2 | #513 (`refactor(job-cards): exhaustive type/status dispatch`) — already open | `assertNeverJobCardValue`, `WAITING_APPROVAL` branch, `never` in `evaluateSubmission` + tests. | Turns D10/D13 into compile errors. |
| P3 | `refactor(job-cards): total canonical duration table` | `CANONICAL_JOB_DURATION_MS: Record<JobCardType, number \| null>` (explicit `null` for `GENERAL_TASK`/`WEEKLY_REPORT`/`SALE`); add a `Record`-based `isPlannedIntervalJobType`. | D14/D15 become compile errors instead of runtime `null`. |
| P4 | `refactor(job-cards): exhaustive job-action dispatch` | Convert `policy.ts:190-214` into `switch (job.type)` with `assertNeverJobCardValue(job.type, 'type')`, keeping today's behaviour per type (`SALES_MEETING` result actions, `PRODUCT_DELIVERY` actual-time, others generic). | D12 stops silently giving new types the generic branch. |
| P5 | `refactor(job-cards): single effective-submission-deadline owner` | Collapse `overdue-incidents.ts:130-149`, `overdue-breach-producer.ts:314-315`, `service.ts:8105-8107`, `service.ts:8306-8308` into one pure function + one SQL renderer, with an explicit per-type "start is/is not a deadline" map. | D23-D26 become one decision instead of four copies. Highest regression risk — needs the existing overdue tests as the guard. |
| P6 | (design) `docs/features/maintenance/…` decisions | Per-type answers for D11, D15, D17, D19, D23, D27, D31, D03, plus customer/device/structured-result model. | Everything marked **B**. |
| P7 | `feat(job-cards): MAINTENANCE job type` | Union + DB migration for `job_cards_type_check` (+ `follow_up_proposed_type` if needed) + create parser + readiness branch + follow-up default map entry. | The actual type; now every missed spot is a compiler error (P1-P5) or a test failure. |

P1-P5 are ~200-400 changed lines total and touch only job-cards; they can be
done by separate agents in parallel except P5 vs P2/P3 (P5 touches
`submission`-adjacent service lines but not the same hunks).

---

## 6. What happens today if `'MAINTENANCE'` is added to the union alone

A single-line change to `types.ts:29` in an otherwise unchanged tree would:

1. **Compile** — only `FOLLOW_UP_TYPE_DEFAULTS` (`follow-up-policy.ts:86`)
   fails, and `installation-modules/registry.ts` is unaffected.
2. **Not be creatable** — 400 at `create-input.ts:53-56` before any DB access.
3. **Not be insertable** — if created by another path, PG `23514` → 500.
4. **Already be un-submittable** — 500 `INVARIANT_VIOLATION` at
   `submission-policy.ts:173-178`.
5. **Already read as generic** — list/board (`workspace-query.ts:47-51`),
   detail (`service.ts:9311-9390`), notes, change requests, invalidation,
   cancel: all work.
6. **Occupy nothing** — `occupancy.ts:70`; double booking becomes possible the
   moment a maintenance job is written by any future path.

That asymmetry (safe on write, silent on scheduling/lateness) is the reason the
class **A** rows exist.

---

## 7. Open questions for the owner

1. **On-site and planned interval.** Is a maintenance visit always a planned
   interval with a canonical duration (like `SALES_MEETING`), or may it be
   open-ended (like `GENERAL_TASK`)? This single answer decides D14, D15, D16,
   D17, D23.
2. **Occupancy.** Does a maintenance visit block the technician's calendar
   (SCH-001 §1)? If yes, does it also count for customer-frequency warnings
   (D18)?
3. **Assignment.** Does JOB-010's acceptance window apply (D19)? If yes,
   MAINTENANCE joins the offer/reminder/expiry machinery and JOB-012 proposals;
   if no, a maintenance job is accepted without a deadline, and
   `unacceptedPastStart` (D29) still lists it — is that intended?
4. **Lateness accountability.** Is a late start / late submission of a
   maintenance visit an OVR incident attributable to the technician (D27)? The
   scanner is status-only today, so the default is *yes*.
5. **Submission payload.** Does approval require a structured result (device,
   work performed, parts, next service date)? If yes: new `SubmissionRequirementCode`s,
   new child table, `MEETING_NOT_READY`-style field errors, and a new
   `EDIT_*` workflow action (D12, D40).
6. **Customer/contact.** Required customer (like `PRODUCT_DELIVERY`) or
   optional (like `GENERAL_TASK`)? Contact allowed?
7. **Device identity.** Where does the device live — a Maintenance-module table
   referenced by `job_card_id`, or a new `job_cards.device_id`? The JobCard
   schema has no asset column today.
8. **Follow-ups.** Should a completed maintenance visit generate a follow-up
   (next service)? That needs D03 + D05/D09.
9. **Cancel/early-start.** Should a technician be able to start early with
   management authorization (D11/D30) and cancel a `NEW` job while the
   assignment window is enabled (`policy.ts:148-150`)?
10. **Module packaging.** Is Maintenance an installation module
    (`installation-modules/registry.ts`, MOD-002) with its own capability, or
    always-on core? MOD-002 says each later module needs its own slice and
    contract.

## 8. Unverified items

* **Not executed**: no build, no test, no migration, no DB. All statements
  about compiler behaviour are derived from reading the type declarations
  (`Record<>` vs `Partial<Record<>>`, closed unions, `never` assignment); they
  were not proven with `tsc`.
* **Not executed**: `npm test` / `local-ci`. The claim that a new type yields
  `500 INVARIANT_VIOLATION` on submit is a code-path reading
  (`submission-policy.ts:173-178` → `AppError('INVARIANT_VIOLATION', 500, …)`),
  not an observed response.
* **Not executed**: the `23514 → 500` claim assumes no mapper; `rg "23514"`
  finds none under `server/src/modules/job-cards`, and `toErrorResponse`
  returns 500 for non-`AppError`s. A database-level test would be required to
  confirm the exact body.
* **#513 status**: read from `origin/refactor/job-card-exhaustive-dispatch`
  (`b3e20e8`, `02a9ba2`), not from GitHub. PR number/staging state and CI
  result were **not** verified (no network call made).
* **Weekly-report branch**: read from
  `origin/refactor/weekly-report-submission` (`3497254`…`9a6b3e8`). Whether it
  is mergeable today, and its test status, is **UNVERIFIED**.
* **Web client impact** (`web/src/**`) is out of scope for this document and
  was not inspected; a new type will also need UI dispatch work.
* `SCH-001`'s "on-site" wording is quoted from `DECISIONS.md:3671-3700`;
  I did not re-read every later decision that might extend it.
