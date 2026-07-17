# Job Lifecycle Clarity and Approval UX Design

Date: 2026-07-17
Status: Product-approved design
Baseline: `origin/main` at `f02b511891dea5462b7f0076186079ad526fa2df`
Scope: JobCard workflow read model, lifecycle presentation SSOT, detail guidance,
approval decisions, activity reasons, and compact list/board summaries

## 1. Objective

Servora-Med already has an explicit, versioned, idempotent JobCard state machine. The
current UI does not communicate that state machine with equal clarity. Detail actions are
presented mainly as a short button list, command labels do not explain their consequences,
and lifecycle copy is duplicated across detail, list, board, status chips, timeline, and
feedback messages.

This design makes the current phase, expected actor, missing submission requirements,
transition consequence, revision loop, approval decision, and terminal outcome visible
without changing the canonical backend state machine.

The selected architecture is a domain-backed presentation adapter:

- the backend owns neutral workflow facts, permissions, and submission readiness;
- the frontend owns Turkish presentation copy, visual composition, and responsive behavior;
- validation and permission decisions are not reimplemented in React;
- backend responses do not contain UI labels, modal copy, or layout instructions.

## 2. Approved Domain Decisions

### 2.1 Canonical state machine remains unchanged

```text
NEW --PLAN----------------------------> PLANNED
NEW --START---------------------------> IN_PROGRESS
PLANNED --START-----------------------> IN_PROGRESS
IN_PROGRESS --SUBMIT_FOR_APPROVAL-----> WAITING_APPROVAL
WAITING_APPROVAL --APPROVE------------> COMPLETED
WAITING_APPROVAL --REQUEST_REVISION---> REVISION_REQUESTED
WAITING_APPROVAL --WITHDRAW_FROM_APPROVAL-> IN_PROGRESS
REVISION_REQUESTED --RESUME-----------> IN_PROGRESS
active state --CANCEL-----------------> CANCELLED
```

`COMPLETED` and `CANCELLED` remain terminal. Revision and cancellation continue to require
a non-empty reason. Lifecycle mutations continue to require `clientActionId` and
`expectedVersion` and to append activity in the same transaction.

### 2.2 Manager/Admin approval withdrawal is intentional

Assigned Staff, Manager, and Admin may execute `WITHDRAW_FROM_APPROVAL` from
`WAITING_APPROVAL`. Another Staff user remains forbidden. This permission is already part
of the current backend policy and test contract and is preserved.

The statement in
`2026-07-16-meeting-lifecycle-approval-withdrawal-design.md` that Manager/Admin do not have
withdrawal authority is superseded by this design. No policy narrowing is included in this
work.

For a Sales Meeting in `WAITING_APPROVAL`, management editing is therefore not a simple
record edit. It first withdraws the job, changes the status to `IN_PROGRESS`, appends
`JOB_APPROVAL_WITHDRAWN`, and then opens editing. The user-facing label is:

```text
Kontrolden çıkar ve kayıtları düzenle
```

### 2.3 Permission and responsibility are separate

Existing Manager/Admin intervention permissions for active jobs remain available. They do
not make management the normal process owner for those phases.

| Status | Expected actor |
| --- | --- |
| `NEW` | assigned Staff |
| `PLANNED` | assigned Staff |
| `IN_PROGRESS` | assigned Staff |
| `WAITING_APPROVAL` | Manager/Admin |
| `REVISION_REQUESTED` | assigned Staff |
| `COMPLETED` | none |
| `CANCELLED` | none |

The presentation adapter uses expected responsibility when choosing a primary action.
Management intervention commands outside `WAITING_APPROVAL` stay secondary or in an
overflow region even when the backend allows them.

## 3. Architectural Boundaries

### 3.1 Backend-owned neutral workflow contract

The backend owns:

- lifecycle commands allowed for the authenticated actor;
- non-lifecycle actions the authenticated actor may perform;
- persisted lifecycle timestamps, actors, notes, and latest reasons;
- the source status of cancellation;
- structured submission readiness evaluated by the same policy used for submission;
- safe activity details, including future revision/cancellation reasons.

### 3.2 Frontend-owned presentation

The frontend owns:

- phase and status labels;
- responsibility headings and descriptions;
- transition labels, consequences, confirmation copy, and success messages;
- stepper state and responsive composition;
- requirement labels derived from stable backend codes;
- detail, list, board, and timeline component composition.

The frontend must not add a lifecycle command that the backend response did not allow. It
must not decide whether a JobCard is ready for submission. It may choose not to foreground
an allowed intervention command based on expected responsibility.

## 4. Backend Workflow Read Model

The authenticated detail response gains a `workflowContext` field. The following names and
semantics are normative:

```ts
type JobWorkflowAction =
  | 'EDIT_JOB_FIELDS'
  | 'WITHDRAW_AND_EDIT_JOB_FIELDS'
  | 'VIEW_MEETING_RESULT'
  | 'EDIT_MEETING_RESULT'
  | 'VIEW_NOTES'
  | 'ADD_NOTE';

type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];

  lifecycle: {
    createdAt: string;
    plannedAt: string | null;
    startedAt: string | null;

    submittedAt: string | null;
    submittedBy: RelatedIdentity | null;
    submissionNote: string | null;

    approvedAt: string | null;
    approvedBy: RelatedIdentity | null;
    approvalNote: string | null;

    revisionRequestedAt: string | null;
    revisionRequestedBy: RelatedIdentity | null;
    revisionReason: string | null;

    cancelledAt: string | null;
    cancelledBy: RelatedIdentity | null;
    cancelReason: string | null;
    cancelledFromStatus: JobCardStatus | null;
  };

  submissionReadiness: {
    evaluatedAt: string;
    ready: boolean;
    items: SubmissionRequirement[];
  } | null;
};
```

All timestamps use the existing canonical UTC instant format. Related identities contain
only the safe public `id` and `name` fields. Missing or deleted related users are represented
as `null`; the persisted timestamp and reason remain visible.

`cancelledFromStatus` is required because timestamps alone cannot reliably distinguish a
cancellation from `IN_PROGRESS`, `WAITING_APPROVAL`, or `REVISION_REQUESTED`. It is read
from the latest valid existing `JOB_CANCELLED` activity old value. It is `null` only when no
safe valid source can be established. No schema migration is required.

### 4.1 Actor-scoped command and action helpers

Introduce one backend helper that returns allowed lifecycle commands for an actor and a
JobCard. `assertCanTransition` checks membership in that result, then applies command-input
validation such as mandatory reasons. The detail response and list/board summary responses
use the same helper.

Non-lifecycle actions use the same pattern and reuse the existing edit/note policies. This
removes the current need for React to independently reproduce meeting edit, note visibility,
and note composer permissions.

`EDIT_JOB_FIELDS` is distinct from `EDIT_MEETING_RESULT`.
`WITHDRAW_AND_EDIT_JOB_FIELDS` represents the Sales Meeting flow in `WAITING_APPROVAL` for
an actor who may withdraw and may edit after withdrawal. It therefore applies to assigned
Staff as well as authorized management. It requires an allowed `WITHDRAW_FROM_APPROVAL`
command and does not imply that job or meeting fields are mutable while the status remains
`WAITING_APPROVAL`. After withdrawal, the canonical `IN_PROGRESS` response exposes the
direct edit actions that apply to that state.

### 4.2 Compact list/board context

List and board responses do not receive the full lifecycle/readiness payload. Each item
receives the actor-scoped `allowedCommands` calculated by the same pure helper. The frontend
derives a compact summary from status, assignee, viewer, and those commands.

This must not add per-row database queries. Command calculation operates on the JobCard row
already loaded for the list or board.

## 5. Structured Submission Readiness

Submission policy is refactored from throw-only validators into structured evaluators. The
same evaluation result is used by both `submissionReadiness` and
`SUBMIT_FOR_APPROVAL`; there are not separate UI and mutation validators.

```ts
type SubmissionRequirement = {
  code:
    | 'CUSTOMER_ELIGIBLE'
    | 'ASSIGNEE_ELIGIBLE'
    | 'DELIVERY_ITEM_PRESENT'
    | 'DELIVERY_ITEMS_VALID'
    | 'TASK_TITLE_VALID'
    | 'MEETING_TIME_VALID'
    | 'MEETING_OUTCOME_VALID'
    | 'MEETING_SUMMARY_PRESENT'
    | 'FOLLOW_UP_TIME_VALID';
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
```

The code describes the requirement, while `state` distinguishes absence from an invalid
value. For example, `MEETING_TIME_VALID` is `missing` when unset and `invalid` when it
exceeds the allowed future tolerance. `CUSTOMER_ELIGIBLE` covers existence, organization,
and active-state rules rather than merely checking that an identifier is present.

The evaluator receives one explicit `evaluatedAt` instant. A detail read and a submission
may occur at different instants; each response truthfully reports its evaluation time. The
submit transaction performs its own current evaluation while holding the existing locked
JobCard path.

Readiness is returned in `IN_PROGRESS`, `REVISION_REQUESTED`, and `WAITING_APPROVAL`, where
requirements inform execution, correction, or review. It is `null` in `NEW`, `PLANNED`,
`COMPLETED`, and `CANCELLED`. This avoids evaluating Sales Meeting result data before the
meeting has started. The frontend decides whether to render a Staff checklist or a Manager
review summary but does not recompute `ready`.

## 6. Canonical Presentation Phases

```ts
type WorkflowPhase =
  | 'CREATED'
  | 'PLANNING'
  | 'EXECUTION'
  | 'REVIEW'
  | 'COMPLETION';

type WorkflowPhaseState =
  | 'complete'
  | 'current'
  | 'upcoming'
  | 'skipped'
  | 'attention';
```

| Technical status | Presentation phase |
| --- | --- |
| `NEW` | `CREATED` |
| `PLANNED` | `PLANNING` |
| `IN_PROGRESS` | `EXECUTION` |
| `WAITING_APPROVAL` | `REVIEW` |
| `REVISION_REQUESTED` | `EXECUTION` with revision loop |
| `COMPLETED` | `COMPLETION` |
| `CANCELLED` | alternative terminal outcome |

`NEW -> IN_PROGRESS` is valid. When `startedAt` exists and `plannedAt` is null, planning is
shown as `skipped` with the label `Planlama atlandı`; it is never shown with a false check.

`REVISION_REQUESTED` is not a sixth linear phase. It is an attention loop from review back
to execution and displays the latest persisted revision reason.

`CANCELLED` is not a successful green completion. The stepper freezes at the phase derived
from `cancelledFromStatus`, and a separate terminal banner shows cancellation time, actor,
and reason.

## 7. Frontend Presentation SSOT

One pure adapter produces the detail presentation:

```ts
deriveJobWorkflowPresentation({
  job,
  user,
  workflowContext,
  deliveryItems,
  meetingDetails,
});
```

It returns phase items, revision loop, responsibility, requirement presentations, primary
transition, secondary transitions, and terminal state. It may only present commands and
actions supplied by `workflowContext`.

One shared presentation module owns:

- technical status and phase labels;
- requirement-code labels;
- command labels and consequences;
- confirmation titles/details/confirm labels;
- transition success messages;
- compact list/board workflow summaries.

`JobDetail`, `JobRow`, `JobBoard`, `JobTimeline`, and `StatusChip` consume this vocabulary
instead of maintaining independent maps. Timeline event labels may remain event-specific,
but status names come from the shared status vocabulary.

## 8. Detail Screen Composition

Default detail order:

```text
1. Title, type, status, and priority
2. JobLifecycleSteps
3. CurrentResponsibilityPanel
4. RequirementsChecklist or ApprovalReviewPanel
5. Primary and secondary transitions
6. Job-type-specific records
7. Notes
8. JobActivityTimeline
```

For management viewing `WAITING_APPROVAL`, structured job records are placed before the
decision controls so the decision follows the evidence:

```text
1. Title and lifecycle
2. ApprovalReviewPanel
3. Structured job records
4. Approval decision controls
5. JobActivityTimeline
```

The full stepper exists only on detail. List and Kanban use a compact ordinal summary such
as `3 / 5 · Uygulanıyor`. The ordinal means current phase position, not number of completed
steps.

## 9. Staff Responsibility UX

### 9.1 Execution

In `IN_PROGRESS`, the panel explains the current task, renders backend readiness items, and
uses:

```text
Kontrole gönder
```

Consequence copy states that the job moves to management review and records become locked
until review ends or the job is withdrawn. Success feedback is specific:

```text
İş yönetici kontrolüne gönderildi.
Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.
```

After a revision has been resumed, the same command is presented as
`Yeniden kontrole gönder`.

### 9.2 Revision loop

In `REVISION_REQUESTED`, show `Düzeltme gerekiyor`, the latest manager reason, and the
primary action:

```text
Düzeltmeye başla
```

This executes `RESUME` and changes the status to `IN_PROGRESS`. It does not resubmit the
job. Resubmission is a later, separate `SUBMIT_FOR_APPROVAL` action.

### 9.3 Waiting for review

Assigned Staff sees `Yönetici kontrolünde`, the submission actor/time when available, and a
message that no action is currently expected. The withdrawal action is:

```text
Kontrolden geri çek ve düzenle
```

Its consequence states that management review ends, the job returns to `IN_PROGRESS`, and
the existing activity history remains.

## 10. Manager Approval UX

`WAITING_APPROVAL` uses a dedicated approval panel instead of a generic button row. The
panel identifies who submitted the job and when, shows safe structured facts/readiness, and
asks management to review the job records before deciding.

Primary action:

```text
Kontrolü tamamla ve işi kapat
```

This requires confirmation. The dialog states that the job becomes `COMPLETED`, leaves the
active list, and receives a manager approval activity. The confirm label is
`İşi tamamla`.

Secondary action:

```text
Düzeltme için personele geri gönder
```

The reason dialog confirm label is `Düzeltme için geri gönder`; `Onayla` must not be used
for a revision request.

For Sales Meeting management editing:

```text
Kontrolden çıkar ve kayıtları düzenle
```

This requires confirmation before withdrawal. The dialog explains that review ends, the
job returns to `IN_PROGRESS`, edits do not approve or close it, and it must be resubmitted.
After successful withdrawal, the canonical response replaces local state and the edit form
opens. A later UI failure does not roll the lifecycle transition back; the page reports the
new canonical state and offers retry-safe editing.

`İşi iptal et` remains visually destructive, requires a reason, and warns that cancellation
is terminal.

## 11. Activity Reasons and Timeline

No migration is required. The activity table already has `metadata`.

Future `JOB_REVISION_REQUESTED` and `JOB_CANCELLED` activities store:

```ts
metadata: { reason: string };
```

The public lifecycle detail shape is:

```ts
type LifecycleActivityDetails = {
  kind: 'STATUS_TRANSITION';
  fromStatus: JobCardStatus;
  toStatus: JobCardStatus;
  reason: string | null;
};
```

`reason` is non-null only for a valid `JOB_REVISION_REQUESTED` or `JOB_CANCELLED` metadata
reason. Other lifecycle events and historical rows without safe reason metadata return
`reason: null`.

Reason persistence occurs in the same critical-action transaction as the transition and
activity append. The safe activity presenter exposes `reason` only for those two event
types, only when it is a valid non-empty string. Raw metadata, client action IDs, and
internal values remain hidden.

Historical activity rows without reason metadata remain unchanged. The current latest
revision/cancellation reason may be shown from `job_cards`; older missing reasons are never
reconstructed or represented by synthetic events.

The timeline remains paginated and newest-first. Its heading includes the supporting copy
`En yeni işlem üstte`. Existing ordering by `created_at DESC, id DESC` is preserved.

## 12. Concurrency, Idempotency, and Error Handling

All lifecycle commands continue through the existing critical-action claim, row lock,
expected-version comparison, transition, and activity append.

The workflow context returned after a successful command is canonical backend truth. The
frontend does not optimistically invent status, readiness, or allowed commands. On version
conflict or invalid transition, detail is reloaded before actionable feedback is shown.

Submission readiness failure maps structured unmet/invalid items to the existing safe error
contract. Field errors remain available for editable structured fields. Product delivery
must no longer collapse every readiness failure into an unhelpful UI-only guess; the same
requirement codes drive the visible checklist.

Reasons are trimmed and validated before persistence. Error responses do not expose raw
database metadata or other organizations' identities.

## 13. Accessibility and Responsive Behavior

- `JobLifecycleSteps` is an ordered list.
- The current phase uses `aria-current="step"`.
- Complete, current, skipped, attention, and upcoming states use text/icon semantics in
  addition to color.
- Mobile uses a vertical stepper; desktop may use a horizontal stepper when space permits.
- At constrained desktop widths the component may retain the compact vertical layout.
- Primary targets are at least 44 by 44 CSS pixels.
- Confirmation dialogs contain focus, support Escape when safe, and restore focus to the
  opener.
- Success feedback uses `role="status"`; errors use `role="alert"`.
- The flow supports 200% text and 400% reflow without horizontal task scrolling.
- Motion is optional, limited to state feedback, and disabled under reduced-motion.
- Mobile presents one primary action per responsibility region.

## 14. Verification Strategy

Implementation follows red-green-refactor. Required focused coverage includes:

Backend:

- exact command matrix for assigned Staff, other Staff, Manager, and Admin;
- `assertCanTransition` and response `allowedCommands` parity;
- action capability parity with edit, meeting, and note guards;
- readiness matrices for all three JobCard types;
- the same evaluator result driving readiness and submission rejection/acceptance;
- meeting time evaluation against one injected instant;
- complete lifecycle fact mapping, actor joins, and `cancelledFromStatus`;
- reason metadata persistence and event-specific safe presentation;
- old activity rows without reason metadata;
- no additional migration and no cross-organization leakage;
- idempotency, version conflicts, and activity count invariants.

Frontend:

- pure presentation matrices across every status, role, assignment, and job type;
- skipped planning and revision-loop states;
- completed and cancelled terminal presentations;
- primary responsibility differing from allowed intervention permissions;
- exact transition labels, consequences, confirmations, and success messages;
- Staff checklist and Manager approval panel composition;
- management edit confirmation before withdrawal;
- revision dialog confirm label;
- detail, list, board, chip, and timeline shared vocabulary;
- strict parsing of workflow context, allowed commands/actions, facts, and requirements;
- keyboard/focus, live-region, mobile, 200% text, and 400% reflow acceptance.

Phase gates run server tests/build/audit, PostgreSQL contract tests, web tests/build/audit,
responsive browser smoke, keyboard/focus acceptance, `git diff --check`, and remote CI.

## 15. Delivery Phases

### Phase A: Domain-backed workflow SSOT

- backend allowed-command and allowed-action helpers;
- structured submission evaluator;
- detail workflow context and compact list/board command context;
- lifecycle facts and cancellation source;
- future revision/cancel reason metadata;
- frontend presentation types, shared vocabulary, and pure adapters.

### Phase B: Detail lifecycle clarity

- lifecycle stepper;
- current responsibility panel;
- requirements checklist;
- skipped planning, revision loop, and cancelled terminal banner;
- responsive and accessible detail composition.

### Phase C: Manager approval UX

- approval review panel;
- explicit completion and revision copy;
- completion, revision, management-edit, and cancellation confirmations;
- role/status integration coverage.

### Phase D: Timeline, compact summaries, and feedback

- future reason presentation and newest-first explanation;
- JobRow and Kanban compact workflow summaries;
- shared transition feedback copy;
- reuse of existing accessible feedback surfaces without a toast dependency.

## 16. Non-goals

- a new JobCard state or generic status patch;
- changing existing Manager/Admin or Staff lifecycle authority;
- editing a job while it remains in `WAITING_APPROVAL`;
- reconstructing missing historical activity reasons;
- a UI framework, Tailwind, stepper library, or toast dependency;
- dashboard redesign, PWA/offline work, or drag-and-drop lifecycle mutation;
- form-system refactoring unrelated to this workflow;
- a database migration when the existing lifecycle and metadata columns suffice.

## 17. Acceptance Criteria

Within a few seconds, an authorized user can identify:

1. the current workflow phase;
2. completed, skipped, current, and upcoming phases;
3. the person or role expected to act next;
4. the primary action expected from the viewer;
5. missing or invalid submission requirements;
6. the consequence of the primary action before executing it;
7. the latest revision reason;
8. prior actions with actor and time;
9. the difference between editing, withdrawing review, revision, and approval;
10. that completion and cancellation are terminal.

The backend remains authoritative for permissions and readiness, while all Turkish workflow
copy is generated by the frontend presentation SSOT.
