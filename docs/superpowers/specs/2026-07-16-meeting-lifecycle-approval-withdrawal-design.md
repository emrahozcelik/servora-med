# Meeting Lifecycle, Approval Withdrawal, and Cancellation Design

Date: 2026-07-16  
Status: Product-approved design  
Scope: `SALES_MEETING` visibility and mutation guards, approval withdrawal, and
`WAITING_APPROVAL` cancellation

## 1. Objective

This change makes a submitted JobCard a stable review snapshot while giving the assigned
Staff user explicit, audited commands to withdraw or cancel it. It also prevents a planned
Sales Meeting from displaying or accepting result data and Staff notes before the meeting
has started.

The backend remains the source of truth. The frontend derives presentation capabilities
from persisted JobCard type, status, role, and assignment. There is no generic status patch,
new JobCard type, automatic withdrawal, reopening, notification system, or realtime work.

`SALES_MEETING` remains the single domain type for both “Satış görüşmesi” and any existing
“Sunum görüşmesi” UI wording.

## 2. Existing-Code Map

Backend boundaries:

- `server/src/modules/job-cards/policy.ts` owns edit, note-access, and transition policy.
- `server/src/modules/job-cards/service.ts` owns versioned lifecycle commands and structured
  meeting mutation.
- `server/src/modules/job-cards/notes-service.ts` owns note creation and its activity append.
- `server/src/modules/job-cards/repository.ts` owns critical-action claims, row locking,
  atomic transitions, and activity persistence.
- `server/src/modules/job-cards/routes.ts` and `handlers.ts` expose named commands.
- `server/src/modules/job-cards/types.ts` and `activity-presenter.ts` own canonical activity
  types and safe presentation.
- Migration `007_sales_meeting.sql` constrains activity event names and therefore cannot be
  modified after application.

Frontend boundaries:

- `web/src/JobDetail.tsx` loads canonical detail state and orchestrates lifecycle actions.
- `web/src/jobs/MeetingDetails.tsx` currently derives editability locally and always renders
  the result section.
- `web/src/jobs/JobNotes.tsx` currently owns both note reading and composing without a
  lifecycle capability input.
- `web/src/jobs/jobs-api.ts` owns named command calls and strict response parsing.
- `web/src/jobs/JobRow.tsx` derives list-level command affordances separately from detail.

Existing behavior that this design intentionally changes:

- Staff is currently forbidden from every `CANCEL` command.
- `CANCEL` currently excludes `WAITING_APPROVAL` for every role.
- structured meeting fields are currently editable in `NEW` and `PLANNED` because the
  shared edit guard only blocks review and terminal states.
- note creation currently has no type/status mutation guard.
- the Slice 07 SSOT says Staff can add notes in `WAITING_APPROVAL`; this remains true for
  other JobCard types but becomes false for Sales Meeting to preserve its submitted review
  snapshot.

## 3. Canonical State and Visibility Model

| Status | Planning | Meeting result | Sales Meeting notes | Assigned Staff actions |
| --- | --- | --- | --- | --- |
| `NEW` | editable | hidden; mutation rejected | hidden; add rejected | existing plan/start actions |
| `PLANNED` | editable | hidden; mutation rejected | hidden; add rejected | existing start action |
| `IN_PROGRESS` | editable | visible and editable | visible; composer enabled | existing submit action |
| `REVISION_REQUESTED` | editable | visible and editable | visible; composer enabled | resume/correct/resubmit under existing flow |
| `WAITING_APPROVAL` | read-only | visible and read-only | persisted notes visible; composer hidden | withdraw, cancel |
| `COMPLETED` | read-only | persisted result visible and read-only | persisted notes read-only | none |
| `CANCELLED` | read-only | persisted result shown only when present | persisted notes shown only when present | none |

The result and note sections are not mounted for `NEW` or `PLANNED`, including during detail
loading. There are no disabled placeholders or empty cards. After a successful start command,
the canonical response changes the status to `IN_PROGRESS`; the same capability derivation
then reveals both sections.

Planning-field mutability continues to use the existing JobCard edit policy. The new
meeting-specific guard narrows only structured meeting result mutation. Note creation is
narrowed only for `SALES_MEETING`; `PRODUCT_DELIVERY` and `GENERAL_TASK` note behavior is
unchanged.

## 4. Backend Lifecycle Design

### 4.1 Withdraw from approval

Add the named route:

```text
POST /api/job-cards/:id/withdraw-from-approval
```

Request:

```json
{
  "clientActionId": "uuid",
  "expectedVersion": 7
}
```

The repository already calls the identifier `clientActionId`; the new contract retains that
name rather than introducing `actionId` in parallel.

The service adds command `WITHDRAW_FROM_APPROVAL` with operation key
`JOB_WITHDRAW_FROM_APPROVAL`, source `WAITING_APPROVAL`, target `IN_PROGRESS`, and event
`JOB_APPROVAL_WITHDRAWN`. It uses the existing critical-action transaction:

1. claim the idempotency key;
2. lock/read the JobCard in the actor organization;
3. verify the expected version;
4. require the actor to be the currently assigned Staff user;
5. validate the source status;
6. transition and increment the version atomically;
7. append exactly one activity in the same transaction;
8. return the canonical JobCard detail response.

Manager and Admin do not receive withdrawal authority. They retain approve and
request-revision review commands. Previous submission activities are never deleted or
rewritten, so resubmission appends another normal `JOB_SUBMITTED_FOR_APPROVAL` event.

### 4.2 Cancellation while waiting

Extend the shared `CANCEL` source set with `WAITING_APPROVAL`. Cancellation retains the
existing `clientActionId`, `expectedVersion`, and mandatory `cancelReason` request shape and
the existing `JOB_CANCELLED` event.

Authorization becomes:

- assigned Staff receives a narrowly scoped new authority to cancel only their own
  `WAITING_APPROVAL` JobCard; this task does not broaden Staff cancellation in other states;
- another Staff user is denied;
- Manager/Admin retain their existing cancellation authority and may also cancel a
  `WAITING_APPROVAL` JobCard now that it is a valid shared source state;
- `COMPLETED` and `CANCELLED` remain terminal.

Cancellation stores its reason through the existing canonical cancellation fields and
records one `JOB_CANCELLED` activity with old/new status. No redundant status-change event
is added.

### 4.3 Meeting mutation guards

Structured meeting mutation requires `SALES_MEETING` status to be `IN_PROGRESS` or
`REVISION_REQUESTED`. `NEW` and `PLANNED` fail with the existing safe `409` lifecycle/edit
error style before meeting details are updated or the JobCard version is incremented.

Sales Meeting note creation requires status `IN_PROGRESS` or `REVISION_REQUESTED`.
`NEW`, `PLANNED`, `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED` reject note creation.
Note listing remains available to authorized viewers so persisted notes can be presented
read-only in review and terminal states.

## 5. Activity and Migration Design

Add append-only migration `008_meeting_approval_withdrawal.sql`. It replaces only the
`job_card_activity_logs_event_type_check` constraint to add:

```text
JOB_APPROVAL_WITHDRAWN
```

No other schema change is required:

- lifecycle source-state rules live in backend policy, not a database transition table;
- existing cancellation columns and the cancelled-state constraint already require actor,
  timestamp, and non-empty reason;
- existing activity columns hold `actor_id` and `created_at` (`occurredAt` in the public
  presentation), while `old_value` and `new_value` hold statuses.

The activity presenter maps withdrawal to the existing `STATUS_TRANSITION` detail shape and
a Turkish label. Raw actor IDs, internal values, and client action IDs remain hidden from the
frontend response.

## 6. Frontend Capability Model and UI

Introduce one pure capability derivation used by detail components, conceptually returning:

```text
canViewMeetingResult
canEditMeetingResult
canViewMeetingNotes
canAddMeetingNote
canWithdrawFromApproval
canCancel
```

Inputs are canonical JobCard type/status plus current user role/id and `assignedTo`. This
model controls rendering only; backend enforcement remains authoritative. List-row command
derivation must use the same policy vocabulary or shared helper so mobile and desktop do not
drift.

In assigned Staff `WAITING_APPROVAL` detail:

- “Onaydan geri çek ve düzenle” calls the named withdraw command with a stable action ID and
  current version;
- “İşi iptal et” opens an accessible modal dialog;
- the dialog warns that cancellation is terminal in MVP, labels and describes the required
  reason, provides close and confirm actions, traps/restores focus using existing dialog
  conventions, and disables confirmation for whitespace-only input;
- both commands expose pending, error, and retry-safe states and prevent double submission.

On success, the page replaces local JobCard state with the canonical backend response,
refreshes dependent meeting/note/timeline truth as needed, closes the dialog, and follows the
existing detail-page navigation convention. A `VERSION_CONFLICT`, invalid transition, or
other stale-state response triggers a detail reload before showing the actionable error; the
UI never applies an optimistic status transition.

Manager review controls remain approve/request-revision. Other Staff users neither receive
the detail through existing scope rules nor see withdrawal/cancellation actions.

## 7. Concurrency, Idempotency, and Error Handling

Withdraw and cancel use the same critical-action claim and `SELECT ... FOR UPDATE` lifecycle
path as approve and request-revision. Expected-version comparison occurs after the lock.
Therefore approve vs withdraw, revision vs withdraw, cancel vs withdraw, and cancel vs
approve serialize on the JobCard; one transition wins and the loser receives the canonical
version or invalid-transition response without partial mutation.

A completed duplicate action returns its stored canonical response. An in-progress duplicate
returns `ACTION_IN_PROGRESS`. Every successful mutation appends its activity in the same
transaction. Validation, authorization, and stale-version failures roll back the claim and
all business writes.

## 8. Verification Strategy

Implementation follows red-green-refactor with focused tests before each production change.

Backend coverage includes:

- withdrawal authorization, source-state, version, idempotency, exact activity count,
  retained submission history, and resubmission;
- approve/revision/cancel races against withdrawal and cancel/approve concurrency;
- assigned/other Staff and Manager/Admin cancellation behavior with mandatory reason;
- terminal cancellation behavior;
- Sales Meeting result and note rejection in `NEW`/`PLANNED`, acceptance in
  `IN_PROGRESS`/`REVISION_REQUESTED`, immutable review behavior, and unchanged notes for
  other types;
- clean/upgrade/no-reapply migration verification and PostgreSQL-enabled integration tests.

Frontend coverage includes the full visibility matrix, read-only review state, assigned-user
actions, cancellation dialog accessibility and reason validation, double-submit protection,
stale-truth reload, Manager controls, and unauthorized-action absence.

Playwright acceptance covers Staff plan/start/result/note/submit/withdraw/edit/resubmit and
Manager review of the new persisted submission, plus Staff cancellation from
`WAITING_APPROVAL` and Manager inability to approve the cancelled card. Mobile width,
keyboard/focus, 44 px targets, reduced motion, 200% text, and supported 400% reflow remain
acceptance gates.

Full verification runs server build/tests/audit, PostgreSQL-enabled server tests, web
build/tests/audit, focused concurrency tests, both Playwright flows, and `git diff --check`.
Remote CI must pass before review is requested.

## 9. Documentation and Delivery

Update the product requirements, architecture plan, API draft, schema draft, MVP slice SSOT,
durable decisions where appropriate, and Turkish user manual. Documentation states that
meeting result/Staff notes begin after start, review is immutable, editing requires explicit
withdrawal, assigned Staff may cancel waiting work with a reason, and terminal states do not
reopen.

The Slice 12 status and completed Sales Meeting cleanup are already present on current
`main`; they must not be rewritten or claimed again as new implementation evidence.

Work is delivered on `fix/meeting-lifecycle-and-approval-withdrawal` in focused commits and a
PR. The PR is not merged by this task; remote CI is observed and reported.
