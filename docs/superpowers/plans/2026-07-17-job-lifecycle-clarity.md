# Job Lifecycle Clarity and Approval UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose backend-authoritative JobCard workflow context and use one frontend presentation SSOT to explain phases, responsibility, readiness, approval consequences, revision/cancellation reasons, and compact list/board progress.

**Architecture:** Fastify keeps the canonical state machine and produces actor-scoped commands/actions, persisted lifecycle facts, and structured readiness from the same evaluator used by submission. React strictly parses that neutral contract and derives Turkish copy and component composition through pure presentation adapters; UI components never recreate transition permission or readiness policy.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Fastify 5, PostgreSQL 16, React 19, Vite 8, Vitest 4, existing CSS design system, Playwright responsive smoke.

## Global Constraints

- Baseline implementation target is current `main`; execute in an isolated worktree created with `superpowers:using-git-worktrees` and preserve unrelated working-tree changes.
- Normative design is `docs/superpowers/specs/2026-07-17-job-lifecycle-clarity-design.md`.
- Keep all eight lifecycle commands, their source/target statuses, optimistic concurrency, idempotency keys, role permissions, and terminal states unchanged.
- Manager/Admin `WITHDRAW_FROM_APPROVAL` permission is intentional and must remain tested.
- Backend owns allowed commands, allowed actions, lifecycle facts, and submission readiness; frontend owns Turkish copy and layout only.
- `COMPLETED` and `CANCELLED` remain terminal. Revision and cancellation reasons remain mandatory.
- Do not add a migration, npm dependency, UI framework, toast library, generic status endpoint, or synthetic historical activity event.
- Historical activity without reason metadata returns `reason: null`; only future revision/cancel events persist safe reason metadata.
- Activity stays newest-first and paginated.
- Code, identifiers, test names, task names, and commits are English. User-facing product copy is Turkish.
- Follow red-green-refactor. Do not write production code before the focused failing test exists and fails for the intended reason.
- Every task must leave server/web type checking intact for its touched boundary and must not stage `web/vite.config.ts`, `dünya-dental.png`, or other unrelated files.

---

## File Structure and Responsibilities

### Backend

- `server/src/modules/job-cards/types.ts`: public workflow/readiness/activity DTOs and persisted detail types.
- `server/src/modules/job-cards/policy.ts`: actor-scoped lifecycle-command and non-lifecycle-action helpers plus existing enforcement guards.
- `server/src/modules/job-cards/submission-policy.ts`: shared structured evaluation and submit-time assertion.
- `server/src/modules/job-cards/repository.ts`: lifecycle fact projection, safe actor joins, cancellation source, and submission-reader queries.
- `server/src/modules/job-cards/service.ts`: actor-scoped workflow-context composition and canonical mutation responses.
- `server/src/modules/job-cards/activity-presenter.ts`: event-specific safe reason allowlist.
- Existing routes and handlers remain unchanged because the detail/list/board endpoints and named command routes are reused.

### Frontend

- `web/src/jobs/jobs-api.ts`: strict neutral workflow contract types and runtime parsers.
- `web/src/jobs/job-labels.ts`: shared technical status, type, and activity labels.
- `web/src/jobs/job-workflow-presentation.ts`: pure phase, responsibility, requirement, transition, and compact-summary derivation.
- `web/src/jobs/JobLifecycleSteps.tsx`: accessible detail stepper.
- `web/src/jobs/JobWorkflowPanels.tsx`: responsibility, requirements, revision, and cancellation panels.
- `web/src/jobs/JobApprovalReviewPanel.tsx`: management review summary.
- `web/src/jobs/JobWorkflowDialog.tsx`: completion and withdraw/edit confirmations; reason dialog remains in `JobDetail.tsx` until migrated here.
- `web/src/jobs/CompactWorkflowSummary.tsx`: list and board phase summary.
- `web/src/JobDetail.tsx`: detail orchestration and named command execution only.
- `web/src/jobs/JobRow.tsx`, `JobBoard.tsx`, `JobTimeline.tsx`: consume shared presentation outputs.
- `web/src/styles.css`: component layout, focus, reflow, and reduced-motion rules using existing tokens.

### Documentation

- `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_MVP_SLICES.md`, `DECISIONS.md`, `DESIGN.md`, and `docs/user-manual/servora-med-user-manual.md`: durable contract and operator/user language.

---

### Task 1: Backend Permission SSOT

**Files:**
- Modify: `server/src/modules/job-cards/types.ts:107-140`
- Modify: `server/src/modules/job-cards/policy.ts:4-103`
- Modify: `server/src/modules/job-cards/service.ts:214-269`
- Test: `server/tests/job-card-policy.test.ts:63-151`
- Test: `server/tests/job-card-notes.test.ts:101-164`
- Test: `server/tests/sales-meeting-service.test.ts:369-455`

**Interfaces:**
- Produces: `JobPermissionSubject`, `JobWorkflowAction`,
  `getAllowedLifecycleCommands(actor, subject)`, `getAllowedJobActions(actor, subject)`, and
  `assertAllowedJobAction(actor, job, action)`.
- Consumed by: Task 4 backend response composition and all existing edit/note/meeting guards.
- Preserves: exact `FORBIDDEN`, `INVALID_TRANSITION`, `REVISION_REASON_REQUIRED`, and `CANCEL_REASON_REQUIRED` behavior.

- [x] **Step 1: Write failing permission-matrix tests**

Add imports for the two helpers and the following cases to `job-card-policy.test.ts`:

```ts
it('returns actor-scoped lifecycle commands without narrowing management intervention', () => {
  const waiting = { ...job, status: 'WAITING_APPROVAL' as const };
  expect(getAllowedLifecycleCommands(staff, waiting)).toEqual([
    'WITHDRAW_FROM_APPROVAL', 'CANCEL',
  ]);
  expect(getAllowedLifecycleCommands(manager, waiting)).toEqual([
    'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
  ]);
  expect(getAllowedLifecycleCommands(admin, waiting)).toEqual([
    'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
  ]);
  expect(getAllowedLifecycleCommands({ ...staff, id: 'staff-2' }, waiting)).toEqual([]);
  expect(getAllowedLifecycleCommands(admin, { ...job, status: 'COMPLETED' })).toEqual([]);
});

it('returns neutral actions without treating waiting edits as direct mutation', () => {
  const meeting = { ...job, type: 'SALES_MEETING' as const };
  expect(getAllowedJobActions(staff, { ...meeting, status: 'IN_PROGRESS' })).toEqual([
    'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT',
    'VIEW_NOTES', 'ADD_NOTE',
  ]);
  expect(getAllowedJobActions(manager, { ...meeting, status: 'WAITING_APPROVAL' })).toEqual([
    'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES',
  ]);
  expect(getAllowedJobActions(staff, { ...meeting, status: 'NEW' })).toEqual([
    'EDIT_JOB_FIELDS',
  ]);
  expect(getAllowedJobActions(staff, { ...meeting, status: 'CANCELLED' })).toEqual([
    'VIEW_MEETING_RESULT', 'VIEW_NOTES',
  ]);
});

it('keeps action projection and write/read guards in parity', () => {
  const meeting = { ...job, type: 'SALES_MEETING' as const };
  for (const status of JOB_CARD_STATUSES) {
    const candidate = { ...meeting, status };
    for (const action of JOB_WORKFLOW_ACTIONS.filter((value) =>
      value !== 'WITHDRAW_AND_EDIT_JOB_FIELDS')) {
      const allowed = getAllowedJobActions(staff, candidate).includes(action);
      if (allowed) expect(() => assertAllowedJobAction(staff, candidate, action)).not.toThrow();
      else expect(() => assertAllowedJobAction(staff, candidate, action))
        .toThrowError(expect.objectContaining({ code: 'JOB_NOT_EDITABLE' }));
    }
  }
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts
```

Expected: FAIL because `getAllowedLifecycleCommands`, `getAllowedJobActions`, and
`JobWorkflowAction` do not exist.

- [x] **Step 3: Add the neutral action type and pure helpers**

Add to `types.ts`:

```ts
export type JobPermissionSubject = Pick<
  JobCard,
  'organizationId' | 'type' | 'status' | 'assignedTo'
>;

export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];
```

Add to `policy.ts` and keep the order stable because it is part of the API contract:

```ts
function actorCanReachJob(actor: JobCardActor, job: JobPermissionSubject) {
  return actor.organizationId === job.organizationId
    && (actor.role !== 'STAFF' || actor.id === job.assignedTo);
}

export function getAllowedLifecycleCommands(
  actor: JobCardActor,
  job: JobPermissionSubject,
): LifecycleCommand[] {
  if (!actorCanReachJob(actor, job)
    || job.status === 'COMPLETED' || job.status === 'CANCELLED') return [];
  if (job.status === 'NEW') return ['PLAN', 'START', 'CANCEL'];
  if (job.status === 'PLANNED') return ['START', 'CANCEL'];
  if (job.status === 'IN_PROGRESS') return ['SUBMIT_FOR_APPROVAL', 'CANCEL'];
  if (job.status === 'REVISION_REQUESTED') return ['RESUME', 'CANCEL'];
  return actor.role === 'STAFF'
    ? ['WITHDRAW_FROM_APPROVAL', 'CANCEL']
    : ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'];
}

export function getAllowedJobActions(
  actor: JobCardActor,
  job: JobPermissionSubject,
): JobWorkflowAction[] {
  if (!actorCanReachJob(actor, job)) return [];
  const actions: JobWorkflowAction[] = [];
  const terminal = job.status === 'COMPLETED' || job.status === 'CANCELLED';
  if (!terminal && job.status !== 'WAITING_APPROVAL') actions.push('EDIT_JOB_FIELDS');
  if (job.type !== 'SALES_MEETING') {
    actions.push('VIEW_NOTES', 'ADD_NOTE');
    return actions;
  }
  if (job.status === 'WAITING_APPROVAL'
    && getAllowedLifecycleCommands(actor, job).includes('WITHDRAW_FROM_APPROVAL')) {
    actions.push('WITHDRAW_AND_EDIT_JOB_FIELDS');
  }
  if (!['NEW', 'PLANNED'].includes(job.status)) {
    actions.push('VIEW_MEETING_RESULT');
  }
  if (['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) {
    actions.push('EDIT_MEETING_RESULT');
  }
  if (!['NEW', 'PLANNED'].includes(job.status)) actions.push('VIEW_NOTES');
  if (['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) actions.push('ADD_NOTE');
  return actions;
}

export function assertAllowedJobAction(
  actor: JobCardActor,
  job: JobCard,
  action: Exclude<JobWorkflowAction, 'WITHDRAW_AND_EDIT_JOB_FIELDS'>,
) {
  assertSameOrganization(actor, job.organizationId);
  if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
  if (!getAllowedJobActions(actor, job).includes(action)) notEditable();
}
```

Refactor the existing guards into thin wrappers so response actions and mutation/read guards
cannot drift:

```ts
export const assertCanEdit = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'EDIT_JOB_FIELDS');
export const assertCanEditMeetingResult = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'EDIT_MEETING_RESULT');
export const assertCanAccessNotes = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'VIEW_NOTES');
export const assertCanAddNote = (actor: JobCardActor, job: JobCard) =>
  assertAllowedJobAction(actor, job, 'ADD_NOTE');
```

Add `assertCanViewMeetingResult` as the `VIEW_MEETING_RESULT` wrapper and call it in
`getMeetingDetails` after `assertSalesMeetingJob`. Add note/service tests proving Sales Meeting
`NEW`/`PLANNED` reads and writes return the existing exact contract
`409 JOB_NOT_EDITABLE / "JobCard bu durumda düzenlenemez."`,
while review/completed/cancelled reads and execution/correction writes remain allowed.

Refactor `assertCanTransition` to keep access/terminal/Staff-manager error precedence, then
replace `allowedSources` with membership in `getAllowedLifecycleCommands(actor, job)`:

```ts
assertSameOrganization(actor, job.organizationId);
if (actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
if (job.status === 'COMPLETED' || job.status === 'CANCELLED') invalidTransition();
if (actor.role === 'STAFF' && ['APPROVE', 'REQUEST_REVISION'].includes(command)) forbidden();
if (!getAllowedLifecycleCommands(actor, job).includes(command)) invalidTransition();
```

Keep the existing mandatory-reason checks immediately after this block.

- [x] **Step 4: Run policy tests and backend build**

Run:

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-notes.test.ts tests/sales-meeting-service.test.ts && npm run build
```

Expected: PASS; the current Staff/Manager/Admin matrix and exact error tests remain green.

- [x] **Step 5: Commit the permission SSOT**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/policy.ts server/src/modules/job-cards/service.ts server/tests/job-card-policy.test.ts server/tests/job-card-notes.test.ts server/tests/sales-meeting-service.test.ts
git commit -m "refactor: centralize job workflow permissions"
```

---

### Task 2: Structured Submission Readiness Evaluator

**Files:**
- Modify: `server/src/modules/job-cards/types.ts:107-140`
- Modify: `server/src/modules/job-cards/repository.ts:86-129, 470-645, 648-900`
- Modify: `server/src/modules/job-cards/submission-policy.ts:1-144`
- Modify: `server/src/modules/job-cards/service.ts:591-597`
- Create: `server/tests/job-card-submission-readiness.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts:481-670`

**Interfaces:**
- Produces: `SubmissionRequirement`, `SubmissionReadiness`, `SubmissionReader`,
  `evaluateSubmission(reader, actor, job, evaluatedAt)`, and `assertSubmissionReady(evaluation)`.
- Consumed by: Task 4 detail workflow context and existing submit lifecycle.
- Preserves: existing public submission error codes/messages and Sales Meeting field errors.

- [x] **Step 1: Write failing readiness and validation-parity tests**

Create `job-card-submission-readiness.test.ts` with a reader double and the following core
matrix. Use the existing canonical `JobCard`, assignee, delivery item, customer, and meeting
fixtures from `job-card-lifecycle-service.test.ts`.

```ts
it('evaluates product delivery requirements in stable order', async () => {
  const evaluation = await evaluateSubmission(reader({
    customer: null,
    assignee: { ...assignee, isActive: false },
    items: [],
  }), staff, deliveryJob, now);
  expect(evaluation.readiness).toEqual({
    evaluatedAt: now.toISOString(),
    ready: false,
    items: [
      { code: 'CUSTOMER_ELIGIBLE', state: 'invalid', field: 'customerId' },
      { code: 'ASSIGNEE_ELIGIBLE', state: 'invalid', field: 'assignedTo' },
      { code: 'DELIVERY_ITEM_PRESENT', state: 'missing', field: 'deliveryItems' },
      { code: 'DELIVERY_ITEMS_VALID', state: 'missing', field: 'deliveryItems' },
    ],
  });
});

it('uses one Sales Meeting evaluation for checklist and exact submit error', async () => {
  const evaluation = await evaluateSubmission(reader({
    meetingDetails: {
      meetingAt: null, outcome: null, meetingSummary: ' ', nextFollowUpAt: null,
    },
  }), staff, meetingJob, now);
  expect(evaluation.readiness.items).toEqual(expect.arrayContaining([
    { code: 'MEETING_TIME_VALID', state: 'missing', field: 'meetingAt' },
    { code: 'MEETING_OUTCOME_VALID', state: 'missing', field: 'outcome' },
    { code: 'MEETING_SUMMARY_PRESENT', state: 'missing', field: 'meetingSummary' },
    { code: 'FOLLOW_UP_TIME_VALID', state: 'met', field: 'nextFollowUpAt' },
  ]));
  expect(() => assertSubmissionReady(evaluation)).toThrowError(expect.objectContaining({
    code: 'MEETING_NOT_READY',
    details: { fieldErrors: {
      meetingAt: 'Gerçekleşen görüşme zamanı zorunludur.',
      outcome: 'Görüşme sonucu zorunludur.',
      meetingSummary: 'Görüşme özeti zorunludur.',
    } },
  }));
});

it('evaluates meeting time against the single supplied instant', async () => {
  const evaluation = await evaluateSubmission(reader({
    meetingDetails: {
      meetingAt: '2026-07-17T12:16:00.000Z', outcome: 'POSITIVE',
      meetingSummary: 'Tamamlandı', nextFollowUpAt: null,
    },
  }), staff, meetingJob, new Date('2026-07-17T12:00:00.000Z'));
  expect(evaluation.readiness.items).toContainEqual({
    code: 'MEETING_TIME_VALID', state: 'invalid', field: 'meetingAt',
  });
});
```

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-submission-readiness.test.ts tests/job-card-lifecycle-service.test.ts
```

Expected: FAIL because the structured evaluator and types do not exist.

- [x] **Step 3: Add public requirement types and the shared reader port**

Add to `types.ts`:

```ts
export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'FOLLOW_UP_TIME_VALID',
] as const;
export type SubmissionRequirementCode = (typeof SUBMISSION_REQUIREMENT_CODES)[number];
export type SubmissionRequirement = {
  code: SubmissionRequirementCode;
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
export type SubmissionReadiness = {
  evaluatedAt: string;
  ready: boolean;
  items: SubmissionRequirement[];
};
```

Add to `repository.ts` and make both `JobCardTransaction` and `JobCardRepository` extend it:

```ts
export interface SubmissionReader {
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getSubmissionCustomer(
    organizationId: string,
    customerId: string,
  ): Promise<SubmissionCustomer | null>;
  getSubmissionMeetingDetails(
    organizationId: string,
    jobCardId: string,
  ): Promise<MeetingDetailsCandidate | null>;
  getSubmissionDeliveryItems(
    organizationId: string,
    jobCardId: string,
  ): Promise<SubmissionDeliveryItem[]>;
}
```

Rename transaction `getMeetingDetailsForUpdate` to `getSubmissionMeetingDetails` while
retaining `FOR UPDATE`. Implement the same method on `PostgresJobCardRepository` without
`FOR UPDATE`; implement repository `getAssignee`, `getSubmissionCustomer`, and
`getSubmissionDeliveryItems` with organization-scoped read queries and the existing mappers.

- [x] **Step 4: Replace throw-only policies with one evaluation object**

Use this internal result and public entry points in `submission-policy.ts`:

```ts
export type SubmissionEvaluation = {
  readiness: SubmissionReadiness;
  failure: AppError | null;
};

export async function evaluateSubmission(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  evaluatedAt: Date,
): Promise<SubmissionEvaluation> {
  const assignee = await reader.getAssignee(actor.organizationId, jobCard.assignedTo);
  const assigneeRequirement: SubmissionRequirement = {
    code: 'ASSIGNEE_ELIGIBLE',
    state: assignee && assignee.organizationId === actor.organizationId
      && assignee.isActive && assignee.role === 'STAFF' ? 'met' : 'invalid',
    field: 'assignedTo',
  };
  if (jobCard.type === 'GENERAL_TASK') {
    const titleLength = Array.from(jobCard.title.trim()).length;
    const items: SubmissionRequirement[] = [
      { code: 'TASK_TITLE_VALID', state: titleLength < 1 ? 'missing'
        : titleLength > 255 ? 'invalid' : 'met', field: 'title' },
      assigneeRequirement,
    ];
    const failure = items[0]!.state !== 'met'
      ? new AppError('VALIDATION_ERROR', 400, 'JobCard başlığı geçersiz.')
      : assigneeRequirement.state !== 'met'
        ? new AppError('ASSIGNEE_NOT_ELIGIBLE', 400, 'Atanan personel aktif ve uygun olmalıdır.')
        : null;
    return readiness(evaluatedAt, items, failure);
  }
  return jobCard.type === 'PRODUCT_DELIVERY'
    ? evaluateDelivery(reader, actor, jobCard, evaluatedAt, assigneeRequirement)
    : evaluateMeeting(reader, actor, jobCard, evaluatedAt, assigneeRequirement);
}

export function assertSubmissionReady(evaluation: SubmissionEvaluation) {
  if (evaluation.failure) throw evaluation.failure;
}

export async function validateSubmission(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  requestTime: Date,
) {
  const evaluation = await evaluateSubmission(reader, actor, jobCard, requestTime);
  assertSubmissionReady(evaluation);
  return evaluation;
}
```

Implement the two helpers with the current validation precedence kept in their `failure`
selection. Delivery uses `CUSTOMER_ELIGIBLE -> ASSIGNEE_ELIGIBLE -> DELIVERY_ITEM_PRESENT ->
DELIVERY_ITEMS_VALID`; meeting uses `CUSTOMER_ELIGIBLE -> ASSIGNEE_ELIGIBLE ->
MEETING_TIME_VALID -> MEETING_OUTCOME_VALID -> MEETING_SUMMARY_PRESENT ->
FOLLOW_UP_TIME_VALID`. Build delivery requirements and first failure as follows:

```ts
const customer = jobCard.customerId === null ? null
  : await reader.getSubmissionCustomer(actor.organizationId, jobCard.customerId);
const customerState = jobCard.customerId === null ? 'missing'
  : !customer || customer.organizationId !== actor.organizationId
    || customer.status === 'inactive' ? 'invalid' : 'met';
const deliveryItems = await reader.getSubmissionDeliveryItems(
  actor.organizationId,
  jobCard.id,
);
const deliveryItemsValid = deliveryItems.length > 0 && deliveryItems.every((item) =>
  Boolean(item.productId)
  && DELIVERY_PURPOSES.includes(item.deliveryPurpose)
  && item.deliveredAt instanceof Date
  && !Number.isNaN(item.deliveredAt.valueOf())
  && Number.isFinite(item.quantity)
  && item.quantity > 0);
const items: SubmissionRequirement[] = [
  { code: 'CUSTOMER_ELIGIBLE', state: customerState, field: 'customerId' },
  assigneeRequirement,
  { code: 'DELIVERY_ITEM_PRESENT', state: deliveryItems.length ? 'met' : 'missing',
    field: 'deliveryItems' },
  { code: 'DELIVERY_ITEMS_VALID', state: deliveryItems.length === 0 ? 'missing'
    : deliveryItemsValid ? 'met' : 'invalid', field: 'deliveryItems' },
];
const failure = customerState !== 'met'
  ? new AppError('DELIVERY_NOT_READY', 400,
    'Ürün teslimi için geçerli müşteri zorunludur.')
  : assigneeFailure(assigneeRequirement)
    ?? (!deliveryItemsValid
      ? new AppError('DELIVERY_NOT_READY', 400,
        'Ürün teslimi onaya gönderilmek için gerekli bilgileri içermiyor.')
      : null);
```

`assigneeFailure` returns the current exact `ASSIGNEE_NOT_ELIGIBLE` AppError only for a non-met
assignee requirement. The meeting helper builds its existing `fieldErrors` object from these
states:

```ts
const customer = jobCard.customerId === null ? null
  : await reader.getSubmissionCustomer(actor.organizationId, jobCard.customerId);
const customerRequirement: SubmissionRequirement = {
  code: 'CUSTOMER_ELIGIBLE',
  state: jobCard.customerId === null ? 'missing'
    : !customer || customer.organizationId !== actor.organizationId
      || customer.status === 'inactive' ? 'invalid' : 'met',
  field: 'customerId',
};
const meetingAt = details?.meetingAt ? new Date(details.meetingAt) : null;
const meetingAtValid = meetingAt !== null && !Number.isNaN(meetingAt.valueOf())
  && meetingAt.valueOf() <= evaluatedAt.valueOf() + 15 * 60_000;
const outcomeValid = details?.outcome !== null
  && details?.outcome !== undefined
  && MEETING_OUTCOMES.includes(details.outcome);
const summaryPresent = Boolean(details?.meetingSummary?.trim());
const followUpValid = details?.nextFollowUpAt === null
  || (meetingAt !== null
    && !Number.isNaN(new Date(details!.nextFollowUpAt!).valueOf())
    && new Date(details!.nextFollowUpAt!).valueOf() > meetingAt.valueOf());

const items: SubmissionRequirement[] = [
  customerRequirement,
  assigneeRequirement,
  { code: 'MEETING_TIME_VALID', state: details?.meetingAt === null || !details
    ? 'missing' : meetingAtValid ? 'met' : 'invalid', field: 'meetingAt' },
  { code: 'MEETING_OUTCOME_VALID', state: details?.outcome === null || !details
    ? 'missing' : outcomeValid ? 'met' : 'invalid', field: 'outcome' },
  { code: 'MEETING_SUMMARY_PRESENT', state: summaryPresent ? 'met' : 'missing',
    field: 'meetingSummary' },
  { code: 'FOLLOW_UP_TIME_VALID', state: followUpValid ? 'met' : 'invalid',
    field: 'nextFollowUpAt' },
];
```

When meeting details are absent, keep the existing `INVARIANT_VIOLATION` failure before field
validation. Failure precedence remains missing/not-found customer (`CUSTOMER_NOT_FOUND`),
inactive customer (`CUSTOMER_INACTIVE`), ineligible assignee (`ASSIGNEE_NOT_ELIGIBLE`), missing
details (`INVARIANT_VIOLATION`), then structured field errors (`MEETING_NOT_READY`). When details
exist, construct the exact current `MEETING_NOT_READY.details.fieldErrors` messages in the
existing field order. `readiness()` sets `ready` to
`items.every(item => item.state === 'met')` and `evaluatedAt` to `Date#toISOString()`.

- [x] **Step 5: Use the evaluator once in submit and run regression tests**

Keep `runLifecycle` calling `validateSubmission(tx, actor, job, requestTime)` only for
`SUBMIT_FOR_APPROVAL`; retain its returned evaluation for Task 4 rather than re-reading the
same rows.

Run:

```bash
cd server && npm test -- --run tests/job-card-submission-readiness.test.ts tests/job-card-lifecycle-service.test.ts tests/sales-meeting-postgres.test.ts && npm run build
```

Expected: PASS; PostgreSQL acceptance is skipped only when its existing environment gate is
unset, while all unit submission matrices pass.

- [x] **Step 6: Commit structured readiness**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/repository.ts server/src/modules/job-cards/submission-policy.ts server/src/modules/job-cards/service.ts server/tests/job-card-submission-readiness.test.ts server/tests/job-card-lifecycle-service.test.ts
git commit -m "feat: expose structured job submission readiness"
```

---

### Task 3: Persisted Lifecycle Fact Projection

**Files:**
- Modify: `server/src/modules/job-cards/types.ts:107-113`
- Modify: `server/src/modules/job-cards/repository.ts:167-284, 397-403, 808-814`
- Test: `server/tests/job-card-detail-repository.test.ts`
- Test: `server/tests/job-card-workspace-postgres.test.ts`

**Interfaces:**
- Produces: `JobLifecycleFacts` and `PersistedJobCardDetail`.
- Consumed by: Task 4 workflow-context presenter.
- Reads: existing `job_cards` lifecycle columns and latest valid `JOB_CANCELLED.old_value.status`.

- [x] **Step 1: Extend repository tests with all lifecycle facts**

Expand the row fixture and expected projection:

```ts
const lifecycleRow = {
  created_at: new Date('2026-07-17T08:00:00.000Z'),
  planned_at: new Date('2026-07-17T08:30:00.000Z'),
  started_at: new Date('2026-07-17T09:00:00.000Z'),
  staff_completed_at: new Date('2026-07-17T10:00:00.000Z'),
  staff_completion_note: 'Kontrole hazır',
  submitter_id: 'staff-1', submitter_name: 'Emrah Demir',
  manager_approved_at: null, manager_approval_note: null,
  approver_id: null, approver_name: null,
  revision_requested_at: new Date('2026-07-17T10:30:00.000Z'),
  revision_reason: 'İkinci miktarı düzeltin',
  revision_actor_id: 'manager-1', revision_actor_name: 'Murat Yönetici',
  cancelled_at: null, cancel_reason: null,
  cancellation_actor_id: null, cancellation_actor_name: null,
  cancelled_from_status: null,
};

expect(result.lifecycle).toEqual({
  createdAt: '2026-07-17T08:00:00.000Z',
  plannedAt: '2026-07-17T08:30:00.000Z',
  startedAt: '2026-07-17T09:00:00.000Z',
  submittedAt: '2026-07-17T10:00:00.000Z',
  submittedBy: { id: 'staff-1', name: 'Emrah Demir' },
  submissionNote: 'Kontrole hazır',
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: '2026-07-17T10:30:00.000Z',
  revisionRequestedBy: { id: 'manager-1', name: 'Murat Yönetici' },
  revisionReason: 'İkinci miktarı düzeltin',
  cancelledAt: null, cancelledBy: null, cancelReason: null,
  cancelledFromStatus: null,
});
```

Add a cancellation row case asserting a valid `WAITING_APPROVAL` source and a malformed
activity source mapping to `null` without leaking raw JSON.

- [x] **Step 2: Run repository tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-detail-repository.test.ts
```

Expected: FAIL because lifecycle columns and `lifecycle` are absent.

- [x] **Step 3: Define persisted lifecycle types and extend the query**

Add to `types.ts`:

```ts
export type JobLifecycleFacts = {
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

export type PersistedJobCardDetail = JobCard & {
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  lifecycle: JobLifecycleFacts;
};
```

Extend `JOB_CARD_DETAIL_QUERY` with lifecycle columns, LEFT JOIN aliases for submitter,
approver, revision actor, and cancellation actor, and this organization-scoped lateral read:

```sql
LEFT JOIN LATERAL (
  SELECT a.old_value->>'status' AS cancelled_from_status
  FROM job_card_activity_logs a
  WHERE a.organization_id = j.organization_id
    AND a.job_card_id = j.id
    AND a.event_type = 'JOB_CANCELLED'
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
) cancellation ON TRUE
```

Map dates with `toISOString()`, identities only when both safe columns are present, and
accept `cancelled_from_status` only when it is a member of `JOB_CARD_STATUSES` and is not a
terminal status.

- [x] **Step 4: Verify organization scope and PostgreSQL behavior**

```bash
cd server && npm test -- --run tests/job-card-detail-repository.test.ts tests/job-card-workspace-postgres.test.ts && npm run build
```

Expected: PASS; the query remains `WHERE j.organization_id = $1 AND j.id = $2`, actor joins
include organization equality, and malformed/cross-organization facts do not surface.

- [x] **Step 5: Commit lifecycle facts**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/repository.ts server/tests/job-card-detail-repository.test.ts server/tests/job-card-workspace-postgres.test.ts
git commit -m "feat: project job lifecycle facts"
```

---

### Task 4: Actor-Scoped Workflow Context in Detail, List, and Board Responses

**Files:**
- Modify: `server/src/modules/job-cards/types.ts:107-194`
- Modify: `server/src/modules/job-cards/repository.ts:1-196`
- Modify: `server/src/modules/job-cards/service.ts:113-218, 576-615`
- Modify: `server/tests/job-card-crud-service.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify: `server/tests/job-card-board.test.ts`
- Modify: `server/tests/job-card-workspace-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 permission helpers, Task 2 evaluator, Task 3 persisted lifecycle facts.
- Produces: required `JobWorkflowContext`, public `JobCardDetail`, and actor-scoped
  `JobCardListItem.allowedCommands`.
- Returned by: create, detail, patch, and every successful lifecycle command.

- [x] **Step 1: Write failing service contract tests**

Add one detail matrix and one list/board assertion:

```ts
it('returns one actor-scoped workflow context from persisted truth', async () => {
  repo.job.status = 'IN_PROGRESS';
  const result = await new JobCardService(repo, () => time).detail(staff, 'job-1');
  expect(result.workflowContext).toEqual({
    allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    lifecycle: repo.persistedDetail.lifecycle,
    submissionReadiness: {
      evaluatedAt: time.toISOString(),
      ready: true,
      items: [
        { code: 'CUSTOMER_ELIGIBLE', state: 'met', field: 'customerId' },
        { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
        { code: 'DELIVERY_ITEM_PRESENT', state: 'met', field: 'deliveryItems' },
        { code: 'DELIVERY_ITEMS_VALID', state: 'met', field: 'deliveryItems' },
      ],
    },
  });
});

it('returns null readiness outside execution, correction, and review', async () => {
  for (const status of ['NEW', 'PLANNED', 'COMPLETED', 'CANCELLED'] as const) {
    repo.job.status = status;
    const result = await new JobCardService(repo, () => time).detail(manager, 'job-1');
    expect(result.workflowContext.submissionReadiness).toBeNull();
  }
});

it('adds allowed commands to list and board items from the authenticated actor', async () => {
  const service = new JobCardService(repository, () => time);
  const list = await service.list(manager, listQuery);
  const board = await service.board(manager, boardQuery);
  expect(list.items[0]?.allowedCommands).toEqual([
    'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
  ]);
  expect(board.columns.WAITING_APPROVAL.items[0]?.allowedCommands).toEqual([
    'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
  ]);
});
```

Also assert that another Staff assignment still returns `404` before readiness queries.

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-crud-service.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-board.test.ts
```

Expected: FAIL because public responses do not contain workflow context or allowed commands.

- [x] **Step 3: Define the public context and list projection**

Add to `types.ts`:

```ts
export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};

export type JobCardDetail = Omit<PersistedJobCardDetail, 'lifecycle'> & {
  workflowContext: JobWorkflowContext;
};

export type PersistedJobCardListItem = {
  id: string;
  type: JobCardType;
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  staffCompletedAt: string | null;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  assignee: RelatedIdentity;
  deliveryItemCount: number;
};

export type JobCardListItem = PersistedJobCardListItem & {
  allowedCommands: LifecycleCommand[];
};
```

Repository list/board interfaces return persisted list items; service public types return
items enriched with `allowedCommands`.

- [x] **Step 4: Add one workflow-context composer and use it for every detail response**

Add a private service method with an optional precomputed submit evaluation:

```ts
private async presentDetail(
  reader: SubmissionReader,
  actor: JobCardActor,
  persisted: PersistedJobCardDetail,
  evaluatedAt: Date,
  precomputed?: SubmissionEvaluation,
): Promise<JobCardDetail> {
  const { lifecycle, ...job } = persisted;
  const readinessStatuses: JobCardStatus[] = [
    'IN_PROGRESS', 'REVISION_REQUESTED', 'WAITING_APPROVAL',
  ];
  const evaluation = readinessStatuses.includes(job.status)
    ? precomputed ?? await evaluateSubmission(reader, actor, job, evaluatedAt)
    : null;
  return {
    ...job,
    workflowContext: {
      allowedCommands: getAllowedLifecycleCommands(actor, job),
      allowedActions: getAllowedJobActions(actor, job),
      lifecycle,
      submissionReadiness: evaluation?.readiness ?? null,
    },
  };
}
```

Use it after organization/assignment scope in `detail()`. Use the transaction as reader in
create, patch, and `runLifecycle`. For `SUBMIT_FOR_APPROVAL`, pass the evaluation already
returned by `validateSubmission` so the transaction does not repeat readiness reads.

Enrich list/board items with a pure mapper:

```ts
private presentListItem(actor: JobCardActor, item: PersistedJobCardListItem): JobCardListItem {
  const subject: JobPermissionSubject = {
    organizationId: actor.organizationId,
    type: item.type,
    status: item.status,
    assignedTo: item.assignee.id,
  };
  return { ...item, allowedCommands: getAllowedLifecycleCommands(actor, subject) };
}
```

Map every list page and active board column through this method; leave closed counts intact.

- [x] **Step 5: Run the backend contract suite**

```bash
cd server && npm test -- --run tests/job-card-crud-service.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-board.test.ts tests/job-card-workspace-repository.test.ts && npm run build
```

Expected: PASS; canonical mutation responses contain context, list/board do not perform
additional queries, and all scope tests remain green.

- [x] **Step 6: Commit backend workflow responses**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts server/tests/job-card-crud-service.test.ts server/tests/job-card-lifecycle-service.test.ts server/tests/job-card-board.test.ts server/tests/job-card-workspace-repository.test.ts
git commit -m "feat: return actor scoped workflow context"
```

---

### Task 5: Future Revision and Cancellation Reasons in Safe Activity

**Files:**
- Modify: `server/src/modules/job-cards/types.ts:219-250`
- Modify: `server/src/modules/job-cards/service.ts:606-608`
- Modify: `server/src/modules/job-cards/activity-presenter.ts:69-84, 145-185`
- Test: `server/tests/job-card-lifecycle-service.test.ts:211-283`
- Test: `server/tests/job-card-activity.test.ts:38-155`

**Interfaces:**
- Produces: `STATUS_TRANSITION` activity details with required `reason: string | null`.
- Consumed by: Tasks 6 and 10 web parser/timeline.
- Security boundary: only event-specific valid `metadata.reason` is public.

- [x] **Step 1: Write failing persistence and presenter tests**

```ts
it.each([
  ['requestRevision', 'JOB_REVISION_REQUESTED', { revisionReason: ' Miktarı düzeltin ' }, 'Miktarı düzeltin'],
  ['cancel', 'JOB_CANCELLED', { cancelReason: ' Müşteri iptal etti ' }, 'Müşteri iptal etti'],
] as const)('stores a safe reason for %s activity', async (method, event, reasonInput, reason) => {
  const repo = new LifecycleRepository();
  repo.job.status = method === 'cancel' ? 'IN_PROGRESS' : 'WAITING_APPROVAL';
  await new JobCardService(repo)[method](manager, 'job-1', {
    clientActionId: method, expectedVersion: 2, ...reasonInput,
  } as never);
  expect(repo.events[0]).toMatchObject({ event, metadata: { reason } });
});

it('allowlists reasons only for revision and cancellation events', () => {
  expect(presentActivity(baseRecord('JOB_REVISION_REQUESTED', {
    oldValue: { status: 'WAITING_APPROVAL' },
    newValue: { status: 'REVISION_REQUESTED' },
    metadata: { reason: 'Miktarı düzeltin', secret: 'hidden' },
  })).details).toEqual({
    kind: 'STATUS_TRANSITION', fromStatus: 'WAITING_APPROVAL',
    toStatus: 'REVISION_REQUESTED', reason: 'Miktarı düzeltin',
  });
  expect(presentActivity(baseRecord('JOB_STARTED', {
    oldValue: { status: 'PLANNED' }, newValue: { status: 'IN_PROGRESS' },
    metadata: { reason: 'must not leak' },
  })).details).toEqual({
    kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED',
    toStatus: 'IN_PROGRESS', reason: null,
  });
});
```

Include malformed reason cases (`42`, whitespace, object) and assert `reason: null`.

- [x] **Step 2: Run activity tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts tests/job-card-activity.test.ts
```

Expected: FAIL because lifecycle activity metadata is absent and status details have no
`reason` field.

- [x] **Step 3: Persist only normalized future reasons**

In `runLifecycle`, compute metadata immediately before `appendActivity`:

```ts
const reason = definition.revisionReason ?? definition.cancelReason;
const metadata = reason === null ? undefined : { reason };
await tx.appendActivity({
  organizationId: actor.organizationId,
  jobCardId,
  actorId: actor.id,
  event: definition.event,
  clientActionId: input.clientActionId,
  oldValue: { status: job.status, version: job.version },
  newValue: { status: updated.status, version: updated.version },
  metadata,
});
```

All other lifecycle events keep `metadata` undefined.

- [x] **Step 4: Extend the safe DTO and event-specific presenter**

Change the status detail union to require `reason: string | null`. Update
`statusDetails(eventType, oldValue, newValue, metadata)`:

```ts
const metadataRecord = jsonRecord(metadata);
const reason = (eventType === 'JOB_REVISION_REQUESTED' || eventType === 'JOB_CANCELLED')
  && typeof metadataRecord?.reason === 'string' && metadataRecord.reason.trim()
  ? metadataRecord.reason.trim()
  : null;
return {
  kind: 'STATUS_TRANSITION',
  fromStatus: oldRecord.status,
  toStatus: newRecord.status,
  reason,
};
```

Pass `record.metadata` only through the lifecycle branch. Keep all raw metadata omitted from
the public DTO.

- [x] **Step 5: Run focused tests and build**

```bash
cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts tests/job-card-activity.test.ts && npm run build
```

Expected: PASS, including historical rows with `reason: null` and secret non-lifecycle
metadata not appearing in serialized output.

- [x] **Step 6: Commit safe activity reasons**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/service.ts server/src/modules/job-cards/activity-presenter.ts server/tests/job-card-lifecycle-service.test.ts server/tests/job-card-activity.test.ts
git commit -m "feat: present safe lifecycle reasons"
```

---

### Task 6: Strict Frontend Workflow Contract

**Files:**
- Modify: `web/src/jobs/jobs-api.ts:5-330`
- Create: `web/tests/fixtures/job-workflow.ts`
- Modify: `web/tests/jobs-api.test.ts`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/job-capabilities.test.ts`
- Modify: `web/tests/manager-review.test.tsx`
- Modify: `web/tests/meeting-details.test.tsx`
- Modify: `web/tests/sales-meeting-edit.test.tsx`
- Modify: `web/tests/job-list.test.tsx`
- Modify: `web/tests/job-board.test.tsx`

**Interfaces:**
- Consumes: Tasks 4 and 5 backend DTOs.
- Produces: strict `LifecycleCommand`, `JobWorkflowAction`, `JobWorkflowContext`,
  `SubmissionRequirement`, and reason-aware activity types/parsers.
- Consumed by: all remaining frontend tasks.

- [x] **Step 1: Add failing runtime-parser tests**

Create a canonical fixture:

```ts
export const workflowContext: JobWorkflowContext = {
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
  allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
  lifecycle: {
    createdAt: '2026-07-17T08:00:00.000Z', plannedAt: null,
    startedAt: '2026-07-17T09:00:00.000Z', submittedAt: null,
    submittedBy: null, submissionNote: null, approvedAt: null, approvedBy: null,
    approvalNote: null, revisionRequestedAt: null, revisionRequestedBy: null,
    revisionReason: null, cancelledAt: null, cancelledBy: null,
    cancelReason: null, cancelledFromStatus: null,
  },
  submissionReadiness: {
    evaluatedAt: '2026-07-17T12:00:00.000Z', ready: false,
    items: [{ code: 'DELIVERY_ITEM_PRESENT', state: 'missing', field: 'deliveryItems' }],
  },
};
```

Then assert:

```ts
it('strictly parses workflow context and actor-scoped list commands', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(json({ ...job, workflowContext }))
    .mockResolvedValueOnce(json({
      items: [{ ...listItem, allowedCommands: ['APPROVE', 'CANCEL'] }],
      total: 1, limit: 25, offset: 0,
    })));
  await expect(getJobCard('job-1')).resolves.toMatchObject({ workflowContext });
  await expect(listJobCards()).resolves.toMatchObject({
    items: [{ allowedCommands: ['APPROVE', 'CANCEL'] }],
  });
});

it.each([
  ['unknown command', { ...workflowContext, allowedCommands: ['DELETE'] }],
  ['unknown action', { ...workflowContext, allowedActions: ['EDIT_ANYTHING'] }],
  ['bad instant', { ...workflowContext, lifecycle: { ...workflowContext.lifecycle, createdAt: 'x' } }],
  ['bad requirement', { ...workflowContext, submissionReadiness: {
    ...workflowContext.submissionReadiness!, items: [{ code: 'UNKNOWN', state: 'met' }],
  } }],
])('rejects malformed %s', async (_name, candidate) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...job, workflowContext: candidate })));
  await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
```

Add activity cases requiring `reason` for every `STATUS_TRANSITION` and rejecting additional
raw fields.

- [x] **Step 2: Run web API tests and verify RED**

```bash
cd web && npm test -- --run tests/jobs-api.test.ts
```

Expected: FAIL because new fields/types/parsers are absent.

- [x] **Step 3: Define exact enums and public types**

Add canonical arrays and derived types:

```ts
export const LIFECYCLE_COMMANDS = [
  'PLAN', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
  'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
] as const;
export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];

export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];
```

Add the exact neutral shapes and make the new fields required:

```ts
export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'FOLLOW_UP_TIME_VALID',
] as const;
export type SubmissionRequirement = {
  code: (typeof SUBMISSION_REQUIREMENT_CODES)[number];
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
export type SubmissionReadiness = {
  evaluatedAt: string;
  ready: boolean;
  items: SubmissionRequirement[];
};
export type JobLifecycleFacts = {
  createdAt: string;
  plannedAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  submittedBy: RelatedName | null;
  submissionNote: string | null;
  approvedAt: string | null;
  approvedBy: RelatedName | null;
  approvalNote: string | null;
  revisionRequestedAt: string | null;
  revisionRequestedBy: RelatedName | null;
  revisionReason: string | null;
  cancelledAt: string | null;
  cancelledBy: RelatedName | null;
  cancelReason: string | null;
  cancelledFromStatus: JobCardStatus | null;
};
export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};
```

Add required `workflowContext: JobWorkflowContext` to `JobCard` and required
`allowedCommands: LifecycleCommand[]` to `JobCardListItem`.

- [x] **Step 4: Add strict parsers and migrate fixtures**

Implement `parseLifecycleFacts`, `parseRequirement`, `parseReadiness`, and
`parseWorkflowContext` with `exactObject`. Parse commands/actions with `oneOf`; parse all
timestamps with `canonicalInstant`/`nullableCanonicalInstant`; reject duplicate
commands/actions/requirement codes. When `cancelledFromStatus` is non-null, parse it with
`JOB_CARD_STATUSES` and reject `COMPLETED`/`CANCELLED` as invalid source statuses.

Use:

```ts
function uniqueValues<T extends string>(values: T[], field: string) {
  if (new Set(values).size !== values.length) invalid(field);
  return values;
}
```

Add `workflowContext: parseWorkflowContext(v.workflowContext)` in `parseJobCard` and
`allowedCommands` in `parseJobCardListItem`. Require `reason` in `STATUS_TRANSITION`:

```ts
const detail = exactObject(v, 'details', ['kind', 'fromStatus', 'toStatus', 'reason']);
return {
  kind,
  fromStatus: oneOf(detail.fromStatus, 'fromStatus', JOB_CARD_STATUSES),
  toStatus: oneOf(detail.toStatus, 'toStatus', JOB_CARD_STATUSES),
  reason: nullableString(detail.reason, 'reason'),
};
```

Import the fixture into affected tests and spread `workflowContext`/`allowedCommands` into
their JobCard fixtures. Do not make the production fields optional to avoid test edits.

- [x] **Step 5: Run transport tests and web build**

```bash
cd web && npm test -- --run tests/jobs-api.test.ts tests/job-detail.test.tsx tests/job-capabilities.test.ts tests/manager-review.test.tsx tests/meeting-details.test.tsx tests/sales-meeting-edit.test.tsx tests/job-list.test.tsx tests/job-board.test.tsx && npm run build
```

Expected: PASS; malformed successful responses fail closed and all typed fixtures use the
required contract.

- [x] **Step 6: Commit frontend transport**

```bash
git add web/src/jobs/jobs-api.ts web/tests/fixtures/job-workflow.ts web/tests/jobs-api.test.ts web/tests/job-detail.test.tsx web/tests/job-capabilities.test.ts web/tests/manager-review.test.tsx web/tests/meeting-details.test.tsx web/tests/sales-meeting-edit.test.tsx web/tests/job-list.test.tsx web/tests/job-board.test.tsx
git commit -m "feat: parse job workflow context"
```

---

### Task 7: Frontend Workflow Presentation SSOT

**Files:**
- Create: `web/src/jobs/job-workflow-presentation.ts`
- Modify: `web/src/jobs/job-labels.ts:1-52`
- Modify: `web/src/ui/StatusChip.tsx`
- Create: `web/tests/job-workflow-presentation.test.ts`
- Modify: `web/tests/status-priority-chips.test.tsx`

**Interfaces:**
- Produces: `deriveJobWorkflowPresentation(input)`,
  `deriveCompactWorkflowSummary({ job, user })`,
  shared requirement labels, transition consequences, confirmation copy, and success copy.
- Consumes: only parsed backend commands/actions, lifecycle facts, readiness, JobCard facts, and
  viewer identity.
- Prohibited: inferring a command or write permission not present in the backend response.

- [x] **Step 1: Write failing pure presentation tests**

Create table-driven tests using `web/tests/fixtures/job-workflow.ts`:

```ts
function derive(job: JobCard, user: CurrentUser = staff) {
  return deriveJobWorkflowPresentation({
    job,
    user,
    workflowContext: job.workflowContext,
    deliveryItems: [],
    meetingDetails: null,
  });
}

function jobAt(status: JobCardStatus, lifecycle: JobLifecycleFacts) {
  return jobWith({ status, workflowContext: contextWith({ lifecycle }) });
}

it('marks planning skipped only when execution exists without a planned timestamp', () => {
  const model = derive(jobWith({ status: 'IN_PROGRESS', workflowContext: contextWith({
    lifecycle: { ...workflowContext.lifecycle, plannedAt: null,
      startedAt: '2026-07-17T09:00:00.000Z' },
  }) }));
  expect(model.phaseItems.map(({ label, state }) => [label, state])).toEqual([
    ['Oluşturuldu', 'complete'], ['Planlama atlandı', 'skipped'],
    ['Uygulanıyor', 'current'], ['Yönetici kontrolü', 'upcoming'],
    ['Tamamlandı', 'upcoming'],
  ]);
});

it('shows a revision loop until the work is submitted again', () => {
  const lifecycle = {
    ...workflowContext.lifecycle,
    submittedAt: '2026-07-17T10:00:00.000Z',
    revisionRequestedAt: '2026-07-17T10:30:00.000Z',
    revisionReason: 'İkinci miktarı düzeltin',
  };
  expect(derive(jobAt('REVISION_REQUESTED', lifecycle)).revisionLoop)
    .toEqual({ active: true, returnedFrom: 'REVIEW', returnedTo: 'EXECUTION',
      reason: 'İkinci miktarı düzeltin' });
  expect(derive(jobAt('IN_PROGRESS', lifecycle)).revisionLoop?.active).toBe(true);
  expect(derive(jobAt('WAITING_APPROVAL', {
    ...lifecycle, submittedAt: '2026-07-17T11:00:00.000Z',
  })).revisionLoop).toBeNull();
});

it('uses exact consequence-led manager transitions without changing permissions', () => {
  const managerWaitingJob = jobWith({
    type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
    workflowContext: contextWith({
      allowedCommands: [
        'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
      ],
      allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
    }),
  });
  const model = derive(managerWaitingJob, manager);
  expect(model.primaryTransition).toMatchObject({
    command: 'APPROVE', label: 'Kontrolü tamamla ve işi kapat',
    successMessage: 'İş tamamlandı ve aktif işlerden çıkarıldı.',
    confirmation: { title: 'İşi tamamlamak üzeresiniz', confirmLabel: 'İşi tamamla' },
  });
  expect(model.secondaryTransitions.map(({ command, label }) => [command, label])).toEqual([
    ['REQUEST_REVISION', 'Düzeltme için personele geri gönder'],
    ['WITHDRAW_FROM_APPROVAL', 'Kontrolden geri çek'],
    ['CANCEL', 'İşi iptal et'],
  ]);
});

it('keeps management interventions secondary outside the management review phase', () => {
  const managerInProgressJob = jobWith({
    type: 'GENERAL_TASK', status: 'IN_PROGRESS',
    workflowContext: contextWith({
      allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    }),
  });
  const model = derive(managerInProgressJob, manager);
  expect(model.responsibility.role).toBe('STAFF');
  expect(model.primaryTransition).toBeNull();
  expect(model.secondaryTransitions.map((item) => item.command)).toEqual([
    'SUBMIT_FOR_APPROVAL', 'CANCEL',
  ]);
});
```

Also cover `NEW`, `PLANNED`, `COMPLETED`, `CANCELLED`, assigned/unassigned Staff, all
requirement codes/states, terminal banners, and compact ordinal/attention/expected-role values.

- [x] **Step 2: Run the pure tests and verify RED**

```bash
cd web && npm test -- --run tests/job-workflow-presentation.test.ts tests/status-priority-chips.test.tsx
```

Expected: FAIL because the adapter and shared status labels do not exist.

- [x] **Step 3: Define the pure presentation model**

Create `job-workflow-presentation.ts` with these local presentation-only types:

```ts
export type WorkflowPhase = 'CREATED' | 'PLANNING' | 'EXECUTION' | 'REVIEW' | 'COMPLETION';
export type WorkflowPhaseState = 'complete' | 'current' | 'upcoming' | 'skipped' | 'attention';
export type ExpectedRole = 'STAFF' | 'MANAGEMENT' | null;

export type TransitionPresentation = {
  command: LifecycleCommand;
  label: string;
  consequence: string;
  successMessage: string;
  confirmation?: { title: string; details: string[]; confirmLabel: string };
};

export type RecordEditPresentation = {
  action: 'EDIT_JOB_FIELDS' | 'WITHDRAW_AND_EDIT_JOB_FIELDS';
  label: string;
  consequence: string;
  confirmation?: { title: string; details: string[]; confirmLabel: string };
};

export type JobWorkflowPresentation = {
  currentPhase: WorkflowPhase | null;
  phaseItems: Array<{ phase: WorkflowPhase; label: string; state: WorkflowPhaseState }>;
  revisionLoop: { active: true; returnedFrom: 'REVIEW'; returnedTo: 'EXECUTION';
    reason: string | null } | null;
  responsibility: { role: ExpectedRole; title: string; description: string;
    consequence: string | null };
  requirements: Array<SubmissionRequirement & { label: string }>;
  recordEditAction: RecordEditPresentation | null;
  primaryTransition: TransitionPresentation | null;
  secondaryTransitions: TransitionPresentation[];
  terminalState: 'COMPLETED' | 'CANCELLED' | null;
};

export type CompactWorkflowSummary = {
  ordinal: 1 | 2 | 3 | 4 | 5 | null;
  total: 5;
  label: string;
  attention: boolean;
  expectedRole: ExpectedRole;
};
```

Use stable maps and pure selectors. Revision is active only when
`revisionRequestedAt !== null && (submittedAt === null || revisionRequestedAt > submittedAt)`.
Phase ordinals are `NEW=1`, `PLANNED=2`, `IN_PROGRESS/REVISION_REQUESTED=3`,
`WAITING_APPROVAL=4`, `COMPLETED=5`. Detail cancellation freezes at the phase mapped from
`cancelledFromStatus` and marks that phase `attention`; if no safe source is available,
`currentPhase` is null, only the known created phase is complete, and the banner says the source
phase was not recorded. Compact cancelled rows use `ordinal: null` and the label `İptal edildi`
because list/board intentionally do not carry cancellation-source history.

Define every requirement label in the SSOT:

```ts
export const requirementLabels: Record<SubmissionRequirement['code'], string> = {
  CUSTOMER_ELIGIBLE: 'Aktif ve geçerli müşteri',
  ASSIGNEE_ELIGIBLE: 'Aktif ve uygun sorumlu personel',
  DELIVERY_ITEM_PRESENT: 'En az bir ürün kalemi',
  DELIVERY_ITEMS_VALID: 'Ürün, amaç, miktar ve teslim zamanı',
  TASK_TITLE_VALID: 'Geçerli iş başlığı',
  MEETING_TIME_VALID: 'Gerçekleşen görüşme zamanı',
  MEETING_OUTCOME_VALID: 'Görüşme sonucu',
  MEETING_SUMMARY_PRESENT: 'Görüşme özeti',
  FOLLOW_UP_TIME_VALID: 'Takip zamanı (varsa görüşmeden sonra)',
};
```

Define all command copy centrally; `SUBMIT_FOR_APPROVAL` selects its revised label when the
revision loop is active, and `WITHDRAW_FROM_APPROVAL` selects Staff/management wording from the
viewer role:

| Command | Label | Consequence | Success |
| --- | --- | --- | --- |
| `PLAN` | `Planla` | `İş planlama aşamasına alınacaktır.` | `İş planlandı.` |
| `START` | `İşi başlat` | `İş “Uygulanıyor” aşamasına alınacaktır.` | `İş uygulanmaya başladı.` |
| `SUBMIT_FOR_APPROVAL` | `Kontrole gönder` / `Yeniden kontrole gönder` | `İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir.` | `İş yönetici kontrolüne gönderildi. Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.` |
| `APPROVE` | `Kontrolü tamamla ve işi kapat` | `İş “Tamamlandı” durumuna geçecek ve aktif işlerden çıkacaktır.` | `İş tamamlandı ve aktif işlerden çıkarıldı.` |
| `REQUEST_REVISION` | `Düzeltme için personele geri gönder` | `İş personele geri dönecek; yeniden düzenlemeye başlamak için personelin işi devam ettirmesi gerekecektir.` | `İş düzeltme için personele geri gönderildi.` |
| `WITHDRAW_FROM_APPROVAL` | `Kontrolden geri çek ve düzenle` / `Kontrolden geri çek` | `Kontrol sona erecek ve iş yeniden “Uygulanıyor” aşamasına alınacaktır; işlem geçmişi korunur.` | `İş yönetici kontrolünden geri çekildi ve yeniden düzenlemeye açıldı.` |
| `RESUME` | `Düzeltmeye başla` | `İş yeniden “Uygulanıyor” aşamasına alınacak; tamamlandığında tekrar kontrole gönderilmesi gerekecektir.` | `İş yeniden düzenlemeye açıldı. Tamamladığınızda tekrar kontrole gönderin.` |
| `CANCEL` | `İşi iptal et` | `İptal terminaldir; iş yeniden açılamaz.` | `İş iptal edildi.` |

`APPROVE.confirmation` is exactly:

```ts
{
  title: 'İşi tamamlamak üzeresiniz',
  details: [
    'Yönetici kontrolünü tamamlar',
    'İşi “Tamamlandı” durumuna geçirir',
    'Aktif iş listesinden kaldırır',
    'İş geçmişine onay kaydı ekler',
  ],
  confirmLabel: 'İşi tamamla',
}
```

`deriveJobWorkflowPresentation` receives the approved explicit input and never loads data:

```ts
type DeriveJobWorkflowPresentationInput = {
  job: JobCard;
  user: CurrentUser;
  workflowContext: JobWorkflowContext;
  deliveryItems: DeliveryItem[];
  meetingDetails: MeetingDetails | null;
};
```

It filters transition presentations strictly through `workflowContext.allowedCommands` and
chooses a primary only when the expected role matches the viewer role. Delivery/meeting facts
may enrich explanatory review copy, but readiness state always comes from
`workflowContext.submissionReadiness`. Management commands retained outside review stay in
`secondaryTransitions`. `WITHDRAW_AND_EDIT_JOB_FIELDS` is presented separately as a neutral
record action and is never synthesized from a lifecycle command in this adapter. For Sales
Meetings, `EDIT_JOB_FIELDS` becomes `Görüşmeyi düzenle` without confirmation. When
`WITHDRAW_AND_EDIT_JOB_FIELDS` is present, the adapter omits a duplicate visible
`WITHDRAW_FROM_APPROVAL` transition and returns:

```ts
{
  action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
  label: user.role === 'STAFF'
    ? 'Kontrolden geri çek ve düzenle'
    : 'Kontrolden çıkar ve kayıtları düzenle',
  consequence: 'Kontrol sona erecek ve iş yeniden “Uygulanıyor” aşamasına alınacaktır. '
    + 'Değişiklikler işi onaylamaz veya tamamlamaz; işin tekrar kontrole gönderilmesi gerekir.',
  confirmation: {
    title: user.role === 'STAFF'
      ? 'Kontrolden geri çek ve düzenle'
      : 'Kontrolden çıkar ve kayıtları düzenle',
    details: [
      'Yönetici kontrolünü sona erdirir',
      'İşi yeniden “Uygulanıyor” aşamasına alır',
      'İşi onaylamaz veya tamamlamaz',
      'Değişikliklerden sonra yeniden kontrole gönderim gerektirir',
    ],
    confirmLabel: user.role === 'STAFF'
      ? 'Geri çek ve düzenle'
      : 'Kontrolden çıkar ve düzenle',
  },
}
```

Primary priority is exact: assigned Staff gets `START` in `NEW`/`PLANNED`,
`SUBMIT_FOR_APPROVAL` in `IN_PROGRESS`, and `RESUME` in `REVISION_REQUESTED`; management gets
`APPROVE` in `WAITING_APPROVAL`. Staff in review and management in Staff-owned phases have no
primary transition. All other allowed commands remain secondary, with `CANCEL` always last.

Move all JobCard status labels into `job-labels.ts`:

```ts
export const jobStatusLabels: Record<JobCardStatus, string> = {
  NEW: 'Oluşturuldu', PLANNED: 'Planlandı', IN_PROGRESS: 'Uygulanıyor',
  WAITING_APPROVAL: 'Yönetici kontrolünde', REVISION_REQUESTED: 'Düzeltme gerekiyor',
  COMPLETED: 'Tamamlandı', CANCELLED: 'İptal edildi',
};
```

Make `StatusChip`, timeline status rendering, and the adapter consume this map rather than
declaring local copies.

- [x] **Step 4: Run presentation tests and build**

```bash
cd web && npm test -- --run tests/job-workflow-presentation.test.ts tests/status-priority-chips.test.tsx && npm run build
```

Expected: PASS; no React component decides permission or readiness.

- [x] **Step 5: Commit the frontend presentation SSOT**

```bash
git add web/src/jobs/job-workflow-presentation.ts web/src/jobs/job-labels.ts web/src/ui/StatusChip.tsx web/tests/job-workflow-presentation.test.ts web/tests/status-priority-chips.test.tsx
git commit -m "feat: derive job workflow presentation"
```

---

### Task 8: Detail Lifecycle Steps and Staff Responsibility UX

**Files:**
- Create: `web/src/jobs/JobLifecycleSteps.tsx`
- Create: `web/src/jobs/JobWorkflowPanels.tsx`
- Modify: `web/src/JobDetail.tsx:1-470`
- Delete: `web/src/jobs/job-capabilities.ts`
- Delete: `web/tests/job-capabilities.test.ts`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/meeting-details.test.tsx`
- Modify: `web/tests/job-notes.test.tsx`
- Modify: `web/src/styles.css:704-1150`

**Interfaces:**
- Consumes: Task 7 presentation model and backend `allowedActions`.
- Produces: accessible stepper, current-responsibility panel, checklist, revision loop, and
  cancellation terminal banner before type-specific records.
- Preserves: no Sales Meeting result/notes mount or request in `NEW`/`PLANNED`; read-only notes
  in review/completed; cancelled notes section only when records exist.

- [x] **Step 1: Write failing detail composition tests**

Add component tests that assert the information hierarchy and API behavior:

```ts
it('renders skipped planning and staff responsibility before structured records', async () => {
  const job = inProgressMeeting({ plannedAt: null, startedAt: instant });
  renderDetail(job);
  await screen.findByRole('heading', { name: job.title });
  const steps = screen.getByRole('list', { name: 'İş süreci' });
  expect(within(steps).getByText('Planlama atlandı')).toBeTruthy();
  expect(within(steps).getByText('Uygulanıyor').closest('[aria-current="step"]')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Şimdi sizden beklenen' })).toBeTruthy();
  expect(screen.getByText('İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Kontrole gönder' })).toBeTruthy();
});

it('shows revision reason and separates resuming from resubmitting', async () => {
  renderDetail(revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' }));
  expect(await screen.findByRole('heading', { name: 'Düzeltme gerekiyor' })).toBeTruthy();
  expect(screen.getByText('Miktarı düzeltin')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Düzeltmeye başla' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Yeniden kontrole gönder' })).toBeNull();
});

it('does not mount hidden Sales Meeting resources in new and planned states', async () => {
  const fetch = mockDetailFetch(newMeetingJob);
  renderScreen();
  await screen.findByText(newMeetingJob.title);
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/meeting-details'), expect.anything());
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/notes'), expect.anything());
  expect(screen.queryByRole('heading', { name: 'Görüşme sonucu' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Notlar' })).toBeNull();
});
```

Add separate cases for `WAITING_APPROVAL`/`COMPLETED` read-only notes, `CANCELLED` empty
notes suppression, terminal cancellation copy including source phase/time/reason, and the
absence of Staff primary actions for an unassigned job.

- [x] **Step 2: Run the focused component tests and verify RED**

```bash
cd web && npm test -- --run tests/job-detail.test.tsx tests/meeting-details.test.tsx tests/job-notes.test.tsx
```

Expected: FAIL because the detail is still a generic command list and local capabilities
derive permissions.

- [x] **Step 3: Build semantic step and panel components**

`JobLifecycleSteps` renders one `<ol aria-label="İş süreci">`; each `<li>` includes the phase
label plus the textual state (`Tamamlandı`, `Şu an`, `Sırada`, `Atlandı`, or `Dikkat gerekiyor`).
Set `aria-current="step"` only on the current phase. Icons use `aria-hidden="true"`; color is
never the only signal.

`JobWorkflowPanels.tsx` exports:

```ts
export function CurrentResponsibilityPanel(props: {
  presentation: JobWorkflowPresentation;
  assigneeName: string;
}): ReactNode;
export function RequirementsChecklist(props: {
  requirements: JobWorkflowPresentation['requirements'];
}): ReactNode;
export function RevisionLoopPanel(props: {
  loop: NonNullable<JobWorkflowPresentation['revisionLoop']>;
}): ReactNode;
export function CancelledJobBanner(props: {
  lifecycle: JobLifecycleFacts;
}): ReactNode;
```

Checklist state text is `Tamam`, `Eksik`, or `Geçersiz` alongside the icon. The cancelled
banner uses `cancelledFromStatus`, `cancelledAt`, and `cancelReason`; when a historical fact is
null it says `Bilgi kaydedilmemiş` and never invents an event.

- [x] **Step 4: Replace local capability and command derivation in detail**

Delete `availableLifecycleCommands`, `primaryLifecycleCommand`, `commandLabels`, and all
`jobCapabilities` use. Change the UI command state and dispatch to backend command names:

```ts
type PendingInteraction = LifecycleCommand | 'WITHDRAW_AND_EDIT_JOB_FIELDS';
const allowed = detail.job.workflowContext.allowedCommands;
const actions = detail.job.workflowContext.allowedActions;
const presentation = deriveJobWorkflowPresentation({
  job: detail.job,
  user,
  workflowContext: detail.job.workflowContext,
  deliveryItems: detail.kind === 'PRODUCT_DELIVERY' ? detail.deliveryItems : [],
  meetingDetails: detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null,
});
```

Render `presentation.recordEditAction` for Sales Meetings. Direct edit opens the form without
a dialog; withdraw-to-edit is wired through Task 9's confirmation for both assigned Staff and
management.

Render order becomes heading/summary, `JobLifecycleSteps`, terminal/revision/responsibility
panel, readiness checklist, primary/secondary transition area, structured records, notes, and
timeline. Map named command API calls in one exhaustive `executeLifecycleCommand` switch; keep
the existing version-conflict refresh and per-command `clientActionId` behavior.

Gate resources directly with backend actions:

```ts
const viewMeeting = actions.includes('VIEW_MEETING_RESULT');
const editMeeting = actions.includes('EDIT_MEETING_RESULT');
const viewNotes = actions.includes('VIEW_NOTES');
const addNote = actions.includes('ADD_NOTE');
```

The loader first fetches JobCard, then requests meeting details only when `viewMeeting` is
present. `JobNotes` mounts only when `viewNotes` is present and receives `canAdd={addNote}` plus
the existing cancelled empty suppression. Remove the deleted capabilities test; its backend-
owned contract is now covered by `jobs-api`, presentation, and detail integration tests.

- [x] **Step 5: Add the initial responsive component styles**

Use existing spacing, color, radius, and focus tokens. Add `.job-lifecycle-steps`,
`.workflow-responsibility`, `.workflow-requirements`, `.revision-loop`, and
`.cancelled-job-banner`; keep 44px minimum interactive targets and visible focus. At narrow
widths use a vertical step list; the full desktop and 400% reflow gate is completed in Task 11.

- [x] **Step 6: Run detail regressions and build**

```bash
cd web && npm test -- --run tests/job-detail.test.tsx tests/meeting-details.test.tsx tests/job-notes.test.tsx tests/sales-meeting-edit.test.tsx && npm run build
```

Expected: PASS; hidden components make no API request, backend actions gate writes, and current
optimistic-concurrency behavior remains green.

- [x] **Step 7: Commit staff lifecycle clarity**

```bash
git add web/src/JobDetail.tsx web/src/jobs/JobLifecycleSteps.tsx web/src/jobs/JobWorkflowPanels.tsx web/src/styles.css web/tests/job-detail.test.tsx web/tests/meeting-details.test.tsx web/tests/job-notes.test.tsx web/tests/sales-meeting-edit.test.tsx
git rm web/src/jobs/job-capabilities.ts web/tests/job-capabilities.test.ts
git commit -m "feat: explain staff job lifecycle"
```

---

### Task 9: Manager Approval and Withdraw-to-Edit UX

**Files:**
- Create: `web/src/jobs/JobApprovalReviewPanel.tsx`
- Create: `web/src/jobs/JobWorkflowDialog.tsx`
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/tests/manager-review.test.tsx`
- Modify: `web/tests/sales-meeting-edit.test.tsx`
- Modify: `web/tests/accessibility-contract.test.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Approval actions remain named backend commands with expected version and action ID.
- `WITHDRAW_AND_EDIT_JOB_FIELDS` remains a backend-provided action for assigned Staff and
  management; its implementation calls `WITHDRAW_FROM_APPROVAL` before opening Sales Meeting
  edit.
- Confirmation is required for approve, revision, withdraw/edit, and cancel only.

- [x] **Step 1: Write failing management decision tests**

```ts
it('explains completion and requires explicit confirmation', async () => {
  renderManagerReview(waitingJob);
  expect(await screen.findByRole('heading', { name: 'Yönetici kontrolü' })).toBeTruthy();
  expect(screen.getByText(/Emrah Demir.*yönetici kontrolüne gönderdi/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Kontrolü tamamla ve işi kapat' }));
  const dialog = screen.getByRole('dialog', { name: 'İşi tamamlamak üzeresiniz' });
  expect(within(dialog).getByText('İşi “Tamamlandı” durumuna geçirir')).toBeTruthy();
  expect(approveJobCard).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'İşi tamamla' }));
  expect(approveJobCard).toHaveBeenCalledWith(waitingJob.id, expect.objectContaining({
    expectedVersion: waitingJob.version,
  }));
});

it('uses a revision-specific confirmation label and mandatory reason', async () => {
  renderManagerReview(waitingJob);
  await user.click(await screen.findByRole('button', {
    name: 'Düzeltme için personele geri gönder',
  }));
  const dialog = screen.getByRole('dialog', { name: 'Düzeltme için personele geri gönder' });
  expect(within(dialog).getByRole('button', {
    name: 'Düzeltme için geri gönder',
  })).toBeDisabled();
  expect(within(dialog).queryByRole('button', { name: 'Onayla' })).toBeNull();
});

it.each([
  ['MANAGER', 'Kontrolden çıkar ve kayıtları düzenle', 'Kontrolden çıkar ve düzenle'],
  ['STAFF', 'Kontrolden geri çek ve düzenle', 'Geri çek ve düzenle'],
] as const)('confirms the real status consequence before %s edit', async (
  role, openLabel, confirmLabel,
) => {
  renderWaitingMeeting({ role });
  await user.click(await screen.findByRole('button', { name: openLabel }));
  expect(screen.getByText(/yeniden “Uygulanıyor” aşamasına alınacaktır/)).toBeTruthy();
  expect(withdrawJobCardFromApproval).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: confirmLabel }));
  expect(withdrawJobCardFromApproval).toHaveBeenCalledTimes(1);
});
```

Cover Escape, Tab/Shift+Tab containment, initial focus, disabled pending controls, and opener
focus restoration for every dialog kind.

- [x] **Step 2: Run management tests and verify RED**

```bash
cd web && npm test -- --run tests/manager-review.test.tsx tests/sales-meeting-edit.test.tsx tests/accessibility-contract.test.ts
```

Expected: FAIL because current manager actions use ambiguous labels and approve has no
confirmation.

- [x] **Step 3: Build the approval review panel**

`JobApprovalReviewPanel` accepts the JobCard, readiness presentations, and lifecycle facts. It
renders submitter/time only from `submittedBy`/`submittedAt`, a type-aware review summary from
readiness items, and the text `İş kayıtlarını inceleyerek karar verin.`. It does not run API
calls or decide permission.

Show it only when status is `WAITING_APPROVAL` and the expected viewer role is management.
Place structured delivery/meeting/task records before its decision action group so the manager
reviews facts before acting.

- [x] **Step 4: Centralize accessible workflow dialogs**

`JobWorkflowDialog` supports these exact variants:

```ts
type JobWorkflowDialogKind =
  | { kind: 'approve'; presentation: TransitionPresentation }
  | { kind: 'revision'; presentation: TransitionPresentation }
  | { kind: 'withdraw-edit'; presentation: RecordEditPresentation }
  | { kind: 'cancel'; presentation: TransitionPresentation };
```

Approve renders the four design-spec consequences and `İşi tamamla`. Revision/cancel render a
required textarea; revision confirms with `Düzeltme için geri gönder`, cancellation with
`İşi iptal et`. Withdraw/edit confirms with `Kontrolden çıkar ve düzenle` and explicitly says
the work moves to `Uygulanıyor`, is not approved/completed, and must be resubmitted.

Reuse the current focus trap and opener restoration behavior, then remove `ReasonDialog` from
`JobDetail.tsx`.

- [x] **Step 5: Wire management transitions and exact feedback**

Only render withdraw-to-edit when the adapter's `recordEditAction` is backed by
`allowedActions.includes('WITHDRAW_AND_EDIT_JOB_FIELDS')`. For assigned Staff and management,
confirmation calls withdrawal once,
updates the canonical JobCard response, opens edit, refreshes timeline, and shows:

```text
İş yönetici kontrolünden çıkarıldı ve yeniden düzenlemeye açıldı.
Değişikliklerden sonra işi tekrar kontrole göndermeniz gerekir.
```

Approve/revision/cancel use `TransitionPresentation.successMessage`. Conflict recovery still
reloads backend truth and restores an accessible error/status focus target.

- [x] **Step 6: Run management and full detail tests**

```bash
cd web && npm test -- --run tests/manager-review.test.tsx tests/sales-meeting-edit.test.tsx tests/job-detail.test.tsx tests/accessibility-contract.test.ts && npm run build
```

Expected: PASS; management review owns the primary action only in `WAITING_APPROVAL`, every
consequential decision is confirmed, and no backend permission changed.

- [x] **Step 7: Commit manager approval clarity**

```bash
git add web/src/JobDetail.tsx web/src/jobs/JobApprovalReviewPanel.tsx web/src/jobs/JobWorkflowDialog.tsx web/src/styles.css web/tests/manager-review.test.tsx web/tests/sales-meeting-edit.test.tsx web/tests/job-detail.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: clarify manager approval decisions"
```

---

### Task 10: Timeline Reasons and Shared Transition Feedback

**Files:**
- Modify: `web/src/jobs/JobTimeline.tsx`
- Modify: `web/src/jobs/job-labels.ts`
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/tests/job-timeline.test.tsx`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: safe `STATUS_TRANSITION.reason` and Task 7 transition presentation.
- Preserves: newest-first ordering and current `limit=50` pagination.
- Prohibited: rendering raw metadata, field values, client action IDs, or inferred old reasons.

- [x] **Step 1: Write failing timeline and feedback tests**

```ts
it('labels newest-first history and shows only safe lifecycle reasons', async () => {
  const activities: JobCardActivity[] = [
    activity('JOB_CANCELLED', {
      kind: 'STATUS_TRANSITION', fromStatus: 'IN_PROGRESS', toStatus: 'CANCELLED',
      reason: 'Müşteri teslimatı iptal etti',
    }),
    activity('JOB_STARTED', {
      kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED', toStatus: 'IN_PROGRESS', reason: null,
    }),
  ];
  render(<JobTimeline jobId="job-1" load={resolvedPage(activities)} />);
  expect(await screen.findByText('En yeni işlem üstte')).toBeTruthy();
  expect(screen.getByText('Neden: Müşteri teslimatı iptal etti')).toBeTruthy();
  expect(screen.getAllByText(/Neden:/)).toHaveLength(1);
});

it.each([
  ['SUBMIT_FOR_APPROVAL', 'İş yönetici kontrolüne gönderildi. Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.'],
  ['APPROVE', 'İş tamamlandı ve aktif işlerden çıkarıldı.'],
  ['REQUEST_REVISION', 'İş düzeltme için personele geri gönderildi.'],
  ['RESUME', 'İş yeniden düzenlemeye açıldı. Tamamladığınızda tekrar kontrole gönderin.'],
])('uses presentation success copy for %s', async (command, expected) => {
  await executeDetailCommand(command);
  expect(screen.getByRole('status')).toHaveTextContent(expected);
});
```

- [x] **Step 2: Run timeline/detail tests and verify RED**

```bash
cd web && npm test -- --run tests/job-timeline.test.tsx tests/job-detail.test.tsx
```

Expected: FAIL because timeline omits reasons/newest-first context and detail still contains
generic success construction.

- [x] **Step 3: Render safe reason and shared labels**

Use `jobStatusLabels` for transition text. Add `<p className="timeline-order-note">En yeni
işlem üstte</p>` directly under the timeline heading. For status details render a reason only
when `details.reason !== null`:

```tsx
{details.reason && <p className="timeline-reason"><strong>Neden:</strong> {details.reason}</p>}
```

Update activity labels to `Kontrole gönderildi`, `Kontrol tamamlandı`, `Düzeltme için geri
gönderildi`, and `Kontrolden geri çekildi` so timeline, status chips, and actions share the
approved process language.

- [x] **Step 4: Remove generic success messages**

After a successful named command, look up the already-derived transition presentation and set
its `successMessage`; do not concatenate button labels. Normal record saves keep their specific
existing messages. Continue using the current `role="status"` surface rather than adding a
toast dependency.

- [x] **Step 5: Run timeline regressions and build**

```bash
cd web && npm test -- --run tests/job-timeline.test.tsx tests/job-detail.test.tsx tests/manager-review.test.tsx && npm run build
```

Expected: PASS; old events show no fabricated reason and pagination still reloads offset zero on
refresh.

- [x] **Step 6: Commit timeline and outcome language**

```bash
git add web/src/jobs/JobTimeline.tsx web/src/jobs/job-labels.ts web/src/JobDetail.tsx web/src/styles.css web/tests/job-timeline.test.tsx web/tests/job-detail.test.tsx
git commit -m "feat: show lifecycle reasons and outcomes"
```

---

### Task 11: Compact List/Board Workflow Summaries and Responsive Acceptance

**Files:**
- Create: `web/src/jobs/CompactWorkflowSummary.tsx`
- Modify: `web/src/jobs/JobRow.tsx`
- Modify: `web/src/jobs/JobList.tsx`
- Modify: `web/src/jobs/JobBoard.tsx`
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-list.test.tsx`
- Modify: `web/tests/job-board.test.tsx`
- Modify: `web/tests/responsive-layout-contract.test.ts`
- Modify: `web/tests/ui-button-contract.test.ts`

**Interfaces:**
- Consumes: list/board `allowedCommands` and Task 7 compact adapter.
- Produces: phase ordinal, phase label, attention flag, expected role, and at most one mobile
  primary open-for-action control.
- Preserves: current list/board selection, filters, pagination, closed counts, and user-approved
  view mode; no forced list switch or pagination reset is introduced.

- [x] **Step 1: Write failing compact-summary tests**

```ts
it('shows the same compact workflow summary in list and board', async () => {
  const job = listJob({ status: 'WAITING_APPROVAL',
    allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'] });
  renderList(job, manager);
  expect(screen.getByText('4 / 5 · Yönetici kontrolünde')).toBeTruthy();
  expect(screen.getByText('İşlem beklenen: Yönetici')).toBeTruthy();
  cleanup();
  renderBoard(job, manager);
  expect(screen.getByText('4 / 5 · Yönetici kontrolünde')).toBeTruthy();
  expect(screen.getByText('İşlem beklenen: Yönetici')).toBeTruthy();
});

it('marks correction attention without claiming phases are completed', () => {
  renderList(listJob({ status: 'REVISION_REQUESTED', allowedCommands: ['RESUME', 'CANCEL'] }), staff);
  expect(screen.getByText('3 / 5 · Düzeltme gerekiyor')).toBeTruthy();
  expect(screen.getByText('Yönetici notu mevcut')).toBeTruthy();
  expect(screen.queryByText('3 aşama tamamlandı')).toBeNull();
});

it('uses backend allowed commands for the one mobile action', async () => {
  const onCommand = vi.fn();
  renderList(listJob({ status: 'IN_PROGRESS', allowedCommands: ['CANCEL'] }), staff, onCommand);
  expect(screen.queryByRole('button', { name: 'Kontrole göndermek için aç' })).toBeNull();
  expect(screen.getAllByRole('link', { name: /Tüm iş detaylarını aç/ })).toHaveLength(1);
});
```

Extend CSS contract tests for 44px targets, vertical mobile steps, horizontal-or-compact desktop
steps, 200% text, 400% reflow at 320 CSS px, and `prefers-reduced-motion: reduce`.

- [x] **Step 2: Run list/board/responsive tests and verify RED**

```bash
cd web && npm test -- --run tests/job-list.test.tsx tests/job-board.test.tsx tests/responsive-layout-contract.test.ts tests/ui-button-contract.test.ts
```

Expected: FAIL because list/board have local lifecycle labels and no shared summary.

- [x] **Step 3: Add the shared compact component**

`CompactWorkflowSummary` accepts `{ summary, assigneeName }` and renders:

```tsx
<div className={`compact-workflow${summary.attention ? ' compact-workflow--attention' : ''}`}>
  <p>{summary.ordinal !== null && <><strong>{summary.ordinal} / {summary.total}</strong> · </>}
    {summary.label}</p>
  <span>{summary.expectedRole === 'MANAGEMENT'
    ? 'İşlem beklenen: Yönetici'
    : summary.expectedRole === 'STAFF'
      ? `İşlem beklenen: ${assigneeName}`
      : 'İşlem beklenmiyor'}</span>
</div>
```

For correction, replace the secondary line with `Yönetici notu mevcut`; do not include the
reason itself on list/board.

- [x] **Step 4: Remove list/board permission duplication**

Delete `permittedJobCommands`. Change `JobCommandIntent.name` to `LifecycleCommand` and derive
the one mobile open-for-action control from `presentation.primaryTransition` only. In the
expanded desktop summary, render open controls for primary plus presentable secondary commands
that have an `openLabels` entry; these remain visually secondary when they represent management
intervention outside the expected responsibility. Every candidate must also be present in
`job.allowedCommands`. The controls still navigate to detail through existing `onCommand`; they
do not mutate a job from list/board.

Exact open labels are:

```ts
const openLabels: Partial<Record<LifecycleCommand, string>> = {
  START: 'İşi başlatmak için aç',
  SUBMIT_FOR_APPROVAL: 'Kontrole göndermek için aç',
  RESUME: 'Düzeltmeye başlamak için aç',
  APPROVE: 'Yönetici kontrolünü aç',
  REQUEST_REVISION: 'Düzeltme kararını aç',
};
```

Render `CompactWorkflowSummary` inside both `JobRow` and `BoardCard`. Pass `user` from
`JobWorkspace` through `JobBoard` so both surfaces call
`deriveCompactWorkflowSummary({ job, user })`. Consume `jobStatusLabels` for board columns.
Preserve `JobWorkspace` search params exactly; this task
must not add a new `forceMobileList` call, reset `offset`, or change the selected `view`.
The existing responsive-breakpoint behavior remains unchanged and covered by workspace tests.

- [x] **Step 5: Complete responsive and motion styles**

At mobile widths keep lifecycle steps vertical and one primary action full-width. At desktop,
use a five-column step layout when it fits and fall back to compact vertical without horizontal
page scroll. Use logical properties, `minmax(0, 1fr)`, overflow wrapping, and existing tokens.
All actionable controls are at least `2.75rem` high. Under reduced motion, disable workflow
transition/scroll animations. Do not add decorative motion.

- [x] **Step 6: Run UI regressions and responsive smoke**

```bash
cd web && npm test -- --run tests/job-workflow-presentation.test.ts tests/job-list.test.tsx tests/job-board.test.tsx tests/workspace-view.test.tsx tests/responsive-layout-contract.test.ts tests/ui-button-contract.test.ts && npm run build && npm run smoke:responsive
```

Expected: PASS at the script's phone/tablet/desktop viewports with no horizontal overflow,
preserved search state, and no second mobile primary action.

- [x] **Step 7: Commit compact summaries and reflow**

```bash
git add web/src/jobs/CompactWorkflowSummary.tsx web/src/jobs/JobRow.tsx web/src/jobs/JobList.tsx web/src/jobs/JobBoard.tsx web/src/jobs/JobWorkspace.tsx web/src/AppRouter.tsx web/src/styles.css web/tests/job-list.test.tsx web/tests/job-board.test.tsx web/tests/responsive-layout-contract.test.ts web/tests/ui-button-contract.test.ts
git commit -m "feat: add compact workflow summaries"
```

---

### Task 12: Durable Documentation and Full Verification Gate

**Files:**
- Modify: `PRODUCT_REQUIREMENTS.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `DECISIONS.md`
- Modify: `DESIGN.md`
- Modify: `docs/user-manual/servora-med-user-manual.md`
- Modify: `docs/superpowers/plans/2026-07-17-job-lifecycle-clarity.md` (check completed tasks)

**Interfaces:**
- Documents: unchanged state machine, intentional Manager/Admin withdrawal, backend workflow
  context, frontend presentation SSOT, readiness parity, lifecycle reasons, and operator-facing
  terminology.
- Verifies: unit/integration/PostgreSQL contracts, builds, audits, responsive behavior,
  keyboard/focus behavior, text reflow, and whitespace integrity.

- [x] **Step 1: Update durable product and architecture documents**

Make the following exact documentation changes:

- `PRODUCT_REQUIREMENTS.md`: add lifecycle visibility, current responsibility, consequence-led
  commands, structured readiness, revision reason, cancellation terminal presentation, and
  detail/list/board acceptance criteria.
- `SERVORA_MED_ARCHITECTURE_PLAN.md`: document `JobWorkflowContext`, `SubmissionReader`, actor-
  scoped permission projection, safe reason metadata, and frontend presentation adapter.
- `SERVORA_MED_MVP_SLICES.md`: mark this feature as a tested detail-first vertical slice and list
  no unimplemented UI as complete.
- `DECISIONS.md`: record Manager/Admin withdrawal as intentional, readiness as backend-owned,
  Turkish copy as frontend-owned, and no migration/no new dependency.
- `DESIGN.md`: register stepper, responsibility, approval, checklist, terminal banner, compact
  summary, accessibility, and responsive behavior using existing design tokens.
- User manual: replace `Onaya gönder`/`Onayla` language with the approved control labels and
  explain skipped planning, correction loop, review lock, withdraw-to-edit consequence,
  completion, and cancellation.

- [x] **Step 2: Run the complete server verification**

```bash
cd server && npm test -- --run && npm run build && npm audit
```

Expected: all unit tests and enabled PostgreSQL tests PASS, TypeScript/build PASS, and audit has
no unresolved high/critical vulnerability introduced by this work.

Run PostgreSQL-gated suites explicitly when `TEST_DATABASE_URL` is available:

```bash
cd server && TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" npm test -- --run tests/sales-meeting-schema.test.ts tests/job-card-workspace-postgres.test.ts tests/sales-meeting-postgres.test.ts
```

Expected: PASS. If the variable is unavailable, report this gate as not run; do not claim
PostgreSQL acceptance from skipped tests.

- [x] **Step 3: Run the complete web verification**

```bash
cd web && npm test -- --run && npm run build && npm audit && npm run smoke:responsive
```

Expected: all Vitest suites PASS, production build PASS, audit has no new high/critical finding,
and responsive smoke PASS.

- [ ] **Step 4: Perform keyboard, focus, zoom, and role acceptance**

Run the app locally against the test database and record evidence for this matrix:

```text
Staff: NEW → START → IN_PROGRESS → SUBMIT → WAITING_APPROVAL
Staff: WAITING_APPROVAL → WITHDRAW → IN_PROGRESS
Manager: WAITING_APPROVAL → REQUEST_REVISION → REVISION_REQUESTED
Staff: REVISION_REQUESTED → RESUME → IN_PROGRESS → SUBMIT
Manager: WAITING_APPROVAL → APPROVE → COMPLETED
Assigned Staff/Manager: every active phase → CANCELLED
Unassigned Staff: no commands/actions and no scoped detail access
```

For each applicable dialog verify Tab, Shift+Tab, Escape, initial focus, opener restoration,
pending disablement, and status/error announcement. Check mobile, desktop, 200% text, and 400%
reflow with no clipped meaning or horizontal page scroll. Verify list/board view and pagination
are preserved instead of reset.

- [x] **Step 5: Check migration/event compatibility and repository integrity**

No migration is expected. Confirm `server/src/db/migrations/007_sales_meeting.sql` and
`008_meeting_approval_withdrawal.sql` are unchanged. The existing
`server/tests/sales-meeting-schema.test.ts` exact-set assertion is the mandatory automated gate:
it checks all 15 historical activity values plus `JOB_APPROVAL_WITHDRAWN`, so dropping any old
event fails. Also retain this static integrity check:

```bash
git diff --exit-code origin/main -- server/src/db/migrations
rg -n "JOB_CREATED|JOB_ASSIGNED|JOB_PLANNED|JOB_STARTED|JOB_SUBMITTED_FOR_APPROVAL|JOB_APPROVED|JOB_REVISION_REQUESTED|JOB_RESUMED|JOB_CANCELLED|JOB_FIELDS_UPDATED|DELIVERY_ITEM_ADDED|DELIVERY_ITEM_UPDATED|DELIVERY_ITEM_REMOVED|NOTE_ADDED|MEETING_DETAILS_UPDATED|JOB_APPROVAL_WITHDRAWN" server/src/db/migrations/007_sales_meeting.sql server/src/db/migrations/008_meeting_approval_withdrawal.sql
git diff --check
```

Expected: migrations have no diff, all historical values plus the withdrawal event are present,
and whitespace check is clean.

- [ ] **Step 6: Record remote CI when publication is authorized**

If the implementation branch is already published or the user explicitly authorizes push/PR
work, run the repository's existing CI checks and record their URLs/results. Do not publish a
branch solely to satisfy this gate. When publication is outside the authorized scope, record
remote CI as not run and rely only on the local evidence above.

- [x] **Step 7: Update checklist evidence and commit documentation**

Check each completed task/step in this plan only after its command/evidence succeeds. Record any
unavailable PostgreSQL/manual gate under a dated `Verification Notes` subsection rather than
marking it complete.

```bash
git add PRODUCT_REQUIREMENTS.md SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_MVP_SLICES.md DECISIONS.md DESIGN.md docs/user-manual/servora-med-user-manual.md docs/superpowers/plans/2026-07-17-job-lifecycle-clarity.md
git commit -m "docs: document job workflow guidance"
```

---

## Spec Coverage Map

- Backend permission SSOT and intentional Manager/Admin withdrawal: Tasks 1 and 4.
- Domain-backed readiness and validation parity: Tasks 2, 4, and 6.
- Persisted phase facts, actors, latest reasons, and cancellation source: Tasks 3, 4, and 8.
- Future safe revision/cancel timeline reasons without migration: Tasks 5, 6, and 10.
- Presentation SSOT, exact transition copy, role-aware responsibility: Tasks 7 through 10.
- Skipped planning, revision loop, completed/cancelled terminal models: Tasks 7 and 8.
- Meeting result/note mount and write behavior: Tasks 6 and 8.
- Manager approval/revision/withdraw-edit/cancel confirmations: Task 9.
- Full detail stepper versus compact list/board summary: Tasks 8 and 11.
- Timeline stays separate, paginated, and newest-first: Task 10.
- Accessibility, responsive behavior, preserved view/pagination, and no new dependency: Tasks 8,
  9, 11, and 12.
- Durable documentation and complete verification evidence: Task 12.

---

## Verification Notes (2026-07-17)

### Local automated gates (Task 12)

| Gate | Result |
| --- | --- |
| `cd server && npm test -- --run` | PASS — 868 passed, 27 skipped (PostgreSQL-gated), 65 files passed / 10 skipped |
| `cd server && npm run build` | PASS |
| `cd server && npm audit` | PASS — 0 vulnerabilities |
| `TEST_DATABASE_URL` PostgreSQL suites | **not run** — `TEST_DATABASE_URL` unset in this environment |
| `cd web && npm test -- --run` | PASS — 462 passed, 54 files |
| `cd web && npm run build` | PASS |
| `cd web && npm audit` | PASS — 0 vulnerabilities |
| `cd web && npm run smoke:responsive` | PASS — phone/tablet/desktop, 200% font, 400% reflow, no horizontal overflow |
| `git diff --exit-code origin/main -- server/src/db/migrations` | PASS — no migration diff |
| Activity enum presence (007 + 008) | PASS — 15 historical values + `JOB_APPROVAL_WITHDRAWN` in 008 |
| `git diff --check` | PASS on committed trees after docs trailing-whitespace fix |

### Unavailable gates (honest)

- **Interactive keyboard/focus/zoom role matrix (Task 12 Step 4):** not run. No local app process was started against a populated test database in this session; automated Vitest/component coverage and responsive smoke are the available evidence only.
- **Remote CI (Task 12 Step 6):** not run. Branch publication/push/PR was not authorized.
- **Disposable PostgreSQL suites** (`sales-meeting-schema`, `job-card-workspace-postgres`, `sales-meeting-postgres`, and other `TEST_DATABASE_URL` files): not run here. Ordinary suites still pass with those files skipped.

### Verification repair during Task 12

Full web suite initially failed 3 tests because fixtures/parser still assumed pre-`workflowContext` list/detail shapes:

- `web/tests/tracer-client.test.ts` — mock JobCard responses updated with `workflowContext` / list `allowedCommands`.
- `web/src/reports/report-types.ts` + `reports-api.ts` + `jobs-api.ts` — approval queue rows correctly use `PersistedJobCardListItem` (no actor-scoped `allowedCommands`), matching backend `ApprovalItem`.

After that repair, full web verification passed.

### Implementation Tasks 1–11

Marked complete based on existing commits on `feature/job-lifecycle-clarity` (`961bc7d` … `12a31e8`) and stated review approval. PostgreSQL-specific steps that only run under `TEST_DATABASE_URL` remain covered by the Task 12 note above when that variable is unavailable.
