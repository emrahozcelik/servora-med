# Job Acceptance and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous `PLANNED` lifecycle with assigned-Staff acceptance, add canonical `scheduledAt`, separate planned and actual delivery times, simplify JobCard interaction, enable assignment-stage notes, and refresh backend readiness immediately after meeting-result saves.

**Architecture:** Keep one backend-owned JobCard state machine and workflow-context SSOT. Migration 009 adds acceptance and scheduling facts while preserving legacy planning history. React consumes backend capabilities, uses one pure local-time default helper, and never derives permissions or readiness independently.

**Tech Stack:** PostgreSQL, Node.js, Fastify, TypeScript, React, React Router, Vite, Vitest, Playwright responsive smoke.

## Global Constraints

- Base implementation work on `main` at or after `c246022d2376272930b8cd3b77d0864985745798`.
- Use an isolated worktree and a new feature branch.
- Add migration `009`; never edit applied migrations `001`–`008`.
- Preserve historical `planned_at` and `JOB_PLANNED`; new code must not write them.
- Only assigned Staff may accept an assignment.
- `scheduledAt` is planned; `meetingAt` and `deliveredAt` are actual.
- Backend remains permission/readiness SSOT.
- No new runtime dependency.
- Preserve optimistic concurrency, idempotency, organization scoping, and same-transaction activity append.
- Maintain WCAG 2.2 AA contracts, 44×44 CSS px targets, keyboard access, focus visibility, reduced motion, and 320 CSS px reflow.
- Use TDD and commit after every task.

---

## File Structure

### New files

- `server/src/db/migrations/009_job_acceptance_and_scheduling.sql` — schema/data migration.
- `web/src/jobs/scheduling.ts` — pure date-time default/format conversion helpers.
- `server/tests/job-acceptance-postgres.test.ts` — migration and transaction acceptance.
- `web/tests/scheduling.test.ts` — deterministic local scheduling helper tests.

### Primary modified backend files

- `server/src/modules/job-cards/types.ts`
- `server/src/modules/job-cards/policy.ts`
- `server/src/modules/job-cards/service.ts`
- `server/src/modules/job-cards/repository.ts`
- `server/src/modules/job-cards/create-input.ts`
- `server/src/modules/job-cards/handlers.ts`
- `server/src/modules/job-cards/routes.ts`
- `server/src/modules/job-cards/submission-policy.ts`
- `server/src/modules/job-cards/activity-presenter.ts`

### Primary modified frontend files

- `web/src/jobs/jobs-api.ts`
- `web/src/jobs/job-labels.ts`
- `web/src/jobs/job-workflow-presentation.ts`
- `web/src/jobs/JobLifecycleSteps.tsx`
- `web/src/jobs/JobWorkflowPanels.tsx`
- `web/src/jobs/JobRow.tsx`
- `web/src/jobs/JobBoard.tsx`
- `web/src/JobDetail.tsx`
- `web/src/DeliveryCreate.tsx`
- `web/src/GeneralTaskCreate.tsx`
- `web/src/SalesMeetingCreate.tsx`
- `web/src/jobs/MeetingDetails.tsx`
- `web/src/styles.css`

### Durable documentation

- `DECISIONS.md`
- `PRODUCT_REQUIREMENTS.md`
- `SERVORA_MED_API_DRAFT.md`
- `SERVORA_MED_ARCHITECTURE_PLAN.md`
- `SERVORA_MED_MVP_SLICES.md`
- `SERVORA_MED_SCHEMA_DRAFT.md`
- `docs/user-manual/servora-med-user-manual.md`

---

### Task 1: Migration 009 and Canonical Persistence Types

**Files:**
- Create: `server/src/db/migrations/009_job_acceptance_and_scheduling.sql`
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Test: `server/tests/migrate-runner.test.ts`
- Test: `server/tests/sales-meeting-schema.test.ts`
- Create: `server/tests/job-acceptance-postgres.test.ts`

**Interfaces:**
- Produces status `ACCEPTED`.
- Produces columns `accepted_at`, `accepted_by`, `scheduled_at`.
- Preserves legacy `planned_at`.
- Produces activity event `JOB_ACCEPTED`.

- [ ] **Step 1: Write failing migration metadata tests**

Assert that migration 009 is the latest immutable migration and that the expected schema version increments from 8 to 9.

```ts
expect(migrations.at(-1)?.name).toBe('009_job_acceptance_and_scheduling.sql');
expect(expectedSchemaVersion).toBe(9);
```

- [ ] **Step 2: Write failing PostgreSQL upgrade tests**

Create fixtures covering:

```ts
[
  { status: 'NEW', expectedStatus: 'NEW' },
  { status: 'PLANNED', expectedStatus: 'NEW' },
  { status: 'IN_PROGRESS', expectedStatus: 'IN_PROGRESS' },
]
```

After migration assert:

```ts
expect(row.status).toBe(expectedStatus);
expect(row.accepted_at).toBeNull();
expect(row.accepted_by).toBeNull();
```

Also assert that historical `planned_at` and `JOB_PLANNED` remain present.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
cd server
npm test -- --run tests/migrate-runner.test.ts tests/job-acceptance-postgres.test.ts
```

Expected: failure because migration 009 and `ACCEPTED` do not exist.

- [ ] **Step 4: Implement migration 009**

Migration responsibilities:

```sql
UPDATE job_cards SET status = 'NEW' WHERE status = 'PLANNED';

ALTER TABLE job_cards
  ADD COLUMN accepted_at TIMESTAMPTZ NULL,
  ADD COLUMN accepted_by UUID NULL,
  ADD COLUMN scheduled_at TIMESTAMPTZ NULL;
```

Use the repository’s actual existing constraint names and organization-scoped foreign-key pattern. Replace the active status check with:

```sql
CHECK (status IN (
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'
))
```

Drop `job_cards_planned_status_timestamp_check`. Add:

```sql
CHECK (status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
```

Extend the activity event check with `JOB_ACCEPTED` while retaining `JOB_PLANNED`.

- [ ] **Step 5: Update TypeScript persistence types**

```ts
export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
] as const;

export type JobCard = {
  // existing fields
  scheduledAt: string | null;
};

export type JobLifecycleFacts = {
  createdAt: string;
  acceptedAt: string | null;
  acceptedBy: RelatedIdentity | null;
  startedAt: string | null;
  // existing submission/approval/revision/cancel facts
};
```

Do not expose `plannedAt` in the new public workflow contract.

- [ ] **Step 6: Update repository projections**

Select and map `scheduled_at`, `accepted_at`, and accepted-user identity in detail. Add `scheduledAt` to list/board items without extra queries.

- [ ] **Step 7: Run migration and repository tests**

```bash
cd server
npm test -- --run tests/migrate-runner.test.ts tests/job-acceptance-postgres.test.ts \
  tests/job-card-detail-repository.test.ts tests/job-card-workspace-repository.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add server/src/db/migrations/009_job_acceptance_and_scheduling.sql \
  server/src/modules/job-cards/types.ts server/src/modules/job-cards/repository.ts \
  server/tests/migrate-runner.test.ts server/tests/sales-meeting-schema.test.ts \
  server/tests/job-acceptance-postgres.test.ts
git commit -m "feat: add job acceptance and scheduling persistence"
```

---

### Task 2: Acceptance State Machine and Policy SSOT

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Modify: `server/src/modules/job-cards/activity-presenter.ts`
- Test: `server/tests/job-card-policy.test.ts`
- Test: `server/tests/job-card-lifecycle-service.test.ts`
- Test: `server/tests/job-card-routes.test.ts`
- Test: `server/tests/job-card-activity.test.ts`

**Interfaces:**
- Removes command `PLAN`.
- Produces command `ACCEPT_ASSIGNMENT`.
- Produces service method `acceptAssignment(actor, jobCardId, input)`.
- Produces route `POST /api/job-cards/:jobCardId/accept`.

- [ ] **Step 1: Write failing policy matrix tests**

```ts
expect(getAllowedLifecycleCommands(staff, assignedNew)).toContain('ACCEPT_ASSIGNMENT');
expect(getAllowedLifecycleCommands(manager, assignedNew)).not.toContain('ACCEPT_ASSIGNMENT');
expect(getAllowedLifecycleCommands(admin, assignedNew)).not.toContain('ACCEPT_ASSIGNMENT');
expect(getAllowedLifecycleCommands(staff, accepted)).toContain('START');
expect(getAllowedLifecycleCommands(staff, assignedNew)).not.toContain('START');
```

Another Staff user must receive no command.

- [ ] **Step 2: Write failing lifecycle service tests**

Verify assigned Staff `NEW -> ACCEPTED`, management acceptance `403 FORBIDDEN`, stale version `409 VERSION_CONFLICT`, idempotent replay, same-transaction `JOB_ACCEPTED`, and returned `acceptedAt` / `acceptedBy`.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
cd server
npm test -- --run tests/job-card-policy.test.ts \
  tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts
```

- [ ] **Step 4: Replace lifecycle definitions**

```ts
export type LifecycleCommand =
  | 'ACCEPT_ASSIGNMENT'
  | 'START'
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'WITHDRAW_FROM_APPROVAL'
  | 'RESUME'
  | 'CANCEL';
```

Policy core:

```ts
if (job.status === 'NEW') {
  return actor.role === 'STAFF' ? ['ACCEPT_ASSIGNMENT', 'CANCEL'] : ['CANCEL'];
}
if (job.status === 'ACCEPTED') return ['START', 'CANCEL'];
```

- [ ] **Step 5: Implement service and route**

```ts
{
  command: 'ACCEPT_ASSIGNMENT',
  operationKey: 'JOB_ACCEPT_ASSIGNMENT',
  target: 'ACCEPTED',
  event: 'JOB_ACCEPTED',
  note: null,
  revisionReason: null,
  cancelReason: null,
}
```

Repository transition must atomically set `accepted_at` and `accepted_by`.

- [ ] **Step 6: Remove active PLAN writes**

Delete the public plan handler/route/client contract. Keep the historical activity presenter able to render `JOB_PLANNED`.

- [ ] **Step 7: Run focused tests and commit**

```bash
cd server
npm test -- --run tests/job-card-policy.test.ts tests/job-card-lifecycle-service.test.ts \
  tests/job-card-routes.test.ts tests/job-card-activity.test.ts
git add server/src/modules/job-cards server/tests/job-card-policy.test.ts \
  server/tests/job-card-lifecycle-service.test.ts server/tests/job-card-routes.test.ts \
  server/tests/job-card-activity.test.ts
git commit -m "feat: replace planning state with staff acceptance"
```

---

### Task 3: Creation, Reassignment, and Schedule Mutation Rules

**Files:**
- Modify: `server/src/modules/job-cards/create-input.ts`
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Test: `server/tests/job-card-create-input.test.ts`
- Test: `server/tests/job-card-crud-service.test.ts`
- Test: `server/tests/job-card-workspace-postgres.test.ts`
- Test: `server/tests/sales-meeting-postgres.test.ts`

**Interfaces:**
- Create inputs accept `scheduledAt`.
- Patch input accepts `scheduledAt`.
- Staff self-created/self-assigned jobs start as `ACCEPTED`.
- Management-created jobs start as `NEW`.

- [ ] **Step 1: Write failing create-contract tests**

```ts
type ProductDeliveryCreateInput = { /* existing fields */ scheduledAt: string };
type SalesMeetingCreateInput = { /* existing fields */ scheduledAt: string };
type GeneralTaskCreateInput = { /* existing fields */ scheduledAt?: string | null };
```

Reject timestamps without `Z` or an explicit offset.

- [ ] **Step 2: Write failing creation-state tests**

```ts
expect((await service.create(staff, selfAssigned)).status).toBe('ACCEPTED');
expect((await service.create(manager, assignedToStaff)).status).toBe('NEW');
```

- [ ] **Step 3: Write failing schedule/reassignment tests**

Verify assigned Staff edits `scheduledAt` in `NEW` and `ACCEPTED`; Manager schedule/assignee edits in `ACCEPTED` return `NEW` with cleared acceptance; those changes in `IN_PROGRESS` return `JOB_NOT_EDITABLE`.

- [ ] **Step 4: Run focused tests**

```bash
cd server
npm test -- --run tests/job-card-create-input.test.ts \
  tests/job-card-crud-service.test.ts tests/job-card-workspace-postgres.test.ts
```

- [ ] **Step 5: Implement exact instant parsing and actor-aware initial status**

```ts
const selfAccepted = actor.role === 'STAFF' && actor.id === input.assignedTo;
```

Create `NEW` or `ACCEPTED`. Include accepted facts in `JOB_CREATED`; do not append a second `JOB_ACCEPTED` event for self-created work.

- [ ] **Step 6: Implement acceptance invalidation**

Management schedule or assignee changes on accepted work clear acceptance and set status `NEW`, with one version increment and safe activity.

- [ ] **Step 7: Run focused tests and commit**

```bash
cd server
npm test -- --run tests/job-card-create-input.test.ts tests/job-card-crud-service.test.ts \
  tests/job-card-workspace-postgres.test.ts tests/sales-meeting-postgres.test.ts
git add server/src/modules/job-cards server/tests/job-card-create-input.test.ts \
  server/tests/job-card-crud-service.test.ts server/tests/job-card-workspace-postgres.test.ts \
  server/tests/sales-meeting-postgres.test.ts
git commit -m "feat: add scheduled work and acceptance invalidation"
```

---

### Task 4: Separate Planned Delivery from Actual Delivery

**Files:**
- Modify: `server/src/db/migrations/009_job_acceptance_and_scheduling.sql`
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/submission-policy.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Test: `server/tests/delivery-item-service.test.ts`
- Test: `server/tests/job-card-submission-readiness.test.ts`
- Test: `server/tests/job-acceptance-postgres.test.ts`

**Interfaces:**
- `DeliveryItem.deliveredAt` becomes nullable before submission.
- Submission still requires a valid actual delivery time.

- [ ] **Step 1: Write failing delivery/readiness tests**

Verify a planned item may be created with `deliveredAt: null`, but readiness reports `DELIVERY_ITEMS_VALID` as invalid until actual time is recorded.

- [ ] **Step 2: Write failing execution-boundary tests**

Actual `deliveredAt` may be recorded in `IN_PROGRESS`; it is never copied from `scheduledAt`.

- [ ] **Step 3: Run focused tests**

```bash
cd server
npm test -- --run tests/delivery-item-service.test.ts \
  tests/job-card-submission-readiness.test.ts tests/job-acceptance-postgres.test.ts
```

- [ ] **Step 4: Extend migration and contracts**

Drop the actual delivery column’s non-null constraint using the real schema name. Do not backfill from `scheduled_at`. Update DTO/storage types to nullable.

- [ ] **Step 5: Preserve readiness rule**

```ts
item.deliveredAt instanceof Date
&& !Number.isNaN(item.deliveredAt.valueOf())
```

Null remains not ready.

- [ ] **Step 6: Run focused tests and commit**

```bash
cd server
npm test -- --run tests/delivery-item-service.test.ts \
  tests/job-card-submission-readiness.test.ts tests/job-acceptance-postgres.test.ts
git add server/src/db/migrations/009_job_acceptance_and_scheduling.sql \
  server/src/modules/job-cards server/tests/delivery-item-service.test.ts \
  server/tests/job-card-submission-readiness.test.ts server/tests/job-acceptance-postgres.test.ts
git commit -m "feat: separate planned and actual delivery times"
```

---

### Task 5: Frontend Workflow Contract and Acceptance UX

**Files:**
- Modify: `web/src/jobs/jobs-api.ts`
- Modify: `web/src/jobs/job-labels.ts`
- Modify: `web/src/jobs/job-workflow-presentation.ts`
- Modify: `web/src/jobs/JobLifecycleSteps.tsx`
- Modify: `web/src/jobs/JobWorkflowPanels.tsx`
- Modify: `web/src/JobDetail.tsx`
- Test: `web/tests/jobs-api.test.ts`
- Test: `web/tests/job-workflow-presentation.test.ts`
- Test: `web/tests/job-detail.test.tsx`
- Test: `web/tests/job-timeline.test.tsx`

**Interfaces:**
- Client command `acceptJobCard`.
- Primary assigned-Staff action label `İşi kabul et`.
- Status labels `NEW -> Atandı`, `ACCEPTED -> Kabul edildi`.

- [ ] **Step 1: Write failing strict-parser tests**

Reject active responses containing `PLANNED` or `PLAN`. Accept `ACCEPTED`, `ACCEPT_ASSIGNMENT`, `scheduledAt`, `acceptedAt`, and `acceptedBy`. Historical activity parsing must still accept `JOB_PLANNED`.

- [ ] **Step 2: Write failing presentation tests**

```ts
expect(primaryFor('NEW', assignedStaff).label).toBe('İşi kabul et');
expect(primaryFor('ACCEPTED', assignedStaff).label).toBe('İşi başlat');
```

Manager viewing `NEW` must not receive a fabricated acceptance button.

- [ ] **Step 3: Run focused tests**

```bash
cd web
npm test -- --run tests/jobs-api.test.ts tests/job-workflow-presentation.test.ts \
  tests/job-detail.test.tsx tests/job-timeline.test.tsx
```

- [ ] **Step 4: Update client contracts**

```ts
export function acceptJobCard(jobId: string, input: LifecycleInput) {
  return lifecycleRequest(jobId, 'accept', input);
}
```

- [ ] **Step 5: Update workflow presentation**

Canonical phases:

```text
Atandı -> Kabul edildi -> Uygulanıyor -> Yönetici kontrolü -> Tamamlandı
```

Historical active jobs without acceptance data say `Kabul bilgisi kaydedilmemiş`; never say `Planlama atlandı`.

- [ ] **Step 6: Wire exhaustive command execution**

Add `ACCEPT_ASSIGNMENT` to the command switch. Preserve conflict refresh, focus restoration, and idempotent action IDs.

- [ ] **Step 7: Run focused tests and commit**

```bash
cd web
npm test -- --run tests/jobs-api.test.ts tests/job-workflow-presentation.test.ts \
  tests/job-detail.test.tsx tests/job-timeline.test.tsx
git add web/src/jobs web/src/JobDetail.tsx web/tests/jobs-api.test.ts \
  web/tests/job-workflow-presentation.test.ts web/tests/job-detail.test.tsx \
  web/tests/job-timeline.test.tsx
git commit -m "feat: add assignment acceptance UX"
```

---

### Task 6: Shared Scheduling Helper and Create Forms

**Files:**
- Create: `web/src/jobs/scheduling.ts`
- Create: `web/tests/scheduling.test.ts`
- Modify: `web/src/DeliveryCreate.tsx`
- Modify: `web/src/GeneralTaskCreate.tsx`
- Modify: `web/src/SalesMeetingCreate.tsx`
- Test: `web/tests/delivery-create-screen.test.tsx`
- Test: `web/tests/general-task-create.test.tsx`
- Test: `web/tests/sales-meeting-create.test.tsx`

**Interfaces:**
- Produces `defaultScheduledLocalValue(now: Date): string`.
- Produces `localDateTimeToIso(value: string): string`.

- [ ] **Step 1: Write deterministic helper tests**

```ts
expect(defaultScheduledLocalValue(localDate('2026-07-17T13:04')))
  .toBe('2026-07-17T14:30');
expect(defaultScheduledLocalValue(localDate('2026-07-17T13:24')))
  .toBe('2026-07-17T14:30');
expect(defaultScheduledLocalValue(localDate('2026-07-17T13:48')))
  .toBe('2026-07-17T15:00');
```

Also cover day rollover.

- [ ] **Step 2: Run helper test and verify failure**

```bash
cd web
npm test -- --run tests/scheduling.test.ts
```

- [ ] **Step 3: Implement helper**

Use local date getters/setters. Do not slice `toISOString()` to produce a device-local input value.

- [ ] **Step 4: Write failing form tests**

All three forms initialize once. A user-edited value survives rerenders, reference refreshes, validation errors, and retry.

Product Delivery create sends `scheduledAt`; planned delivery-item creation sends `deliveredAt: null`.

Sales Meeting replaces date-only `dueDate` with required `scheduledAt`.

General Task may clear the prefilled value and submit `scheduledAt: null`.

- [ ] **Step 5: Implement form changes**

Labels:

```text
Product Delivery: Planlanan teslim zamanı
Sales Meeting: Planlanan görüşme zamanı
General Task: Planlanan zaman (isteğe bağlı)
```

Use a lazy initializer:

```ts
const [scheduledLocal, setScheduledLocal] = useState(
  () => defaultScheduledLocalValue(new Date()),
);
```

- [ ] **Step 6: Run focused tests and commit**

```bash
cd web
npm test -- --run tests/scheduling.test.ts tests/delivery-create-screen.test.tsx \
  tests/general-task-create.test.tsx tests/sales-meeting-create.test.tsx
git add web/src/jobs/scheduling.ts web/src/DeliveryCreate.tsx \
  web/src/GeneralTaskCreate.tsx web/src/SalesMeetingCreate.tsx \
  web/tests/scheduling.test.ts web/tests/delivery-create-screen.test.tsx \
  web/tests/general-task-create.test.tsx web/tests/sales-meeting-create.test.tsx
git commit -m "feat: default and edit planned work times"
```

---

### Task 7: Assignment-Stage Notes and Schedule Editing

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/src/jobs/job-workflow-presentation.ts`
- Test: `server/tests/job-card-notes.test.ts`
- Test: `server/tests/job-card-policy.test.ts`
- Test: `web/tests/job-detail.test.tsx`
- Test: `web/tests/job-notes.test.tsx`

**Interfaces:**
- `NEW` and `ACCEPTED` expose `VIEW_NOTES` and `ADD_NOTE` to assigned Staff.
- Detail exposes schedule editing only from backend `EDIT_JOB_FIELDS`.

- [ ] **Step 1: Write failing policy tests**

```ts
for (const status of ['NEW', 'ACCEPTED'] as const) {
  expect(getAllowedJobActions(staff, { ...meeting, status }))
    .toEqual(expect.arrayContaining(['VIEW_NOTES', 'ADD_NOTE']));
}
```

Other Staff remains concealed.

- [ ] **Step 2: Write failing UI tests**

Render assigned Staff in `NEW` and `ACCEPTED`; expect Notes form and schedule edit control. Render another Staff; expect neither.

- [ ] **Step 3: Run focused tests**

```bash
cd server
npm test -- --run tests/job-card-policy.test.ts tests/job-card-notes.test.ts
cd ../web
npm test -- --run tests/job-detail.test.tsx tests/job-notes.test.tsx
```

- [ ] **Step 4: Implement capability changes**

Do not add role/status permission checks in React. Render notes and editing only from `allowedActions`.

- [ ] **Step 5: Run focused tests and commit**

```bash
git add server/src/modules/job-cards/policy.ts server/tests/job-card-policy.test.ts \
  server/tests/job-card-notes.test.ts web/src/JobDetail.tsx \
  web/src/jobs/job-workflow-presentation.ts web/tests/job-detail.test.tsx \
  web/tests/job-notes.test.tsx
git commit -m "feat: enable assignment-stage communication"
```

---

### Task 8: Direct Card Navigation and Remove Summary Disclosure

**Files:**
- Modify: `web/src/jobs/JobRow.tsx`
- Modify: `web/src/jobs/JobBoard.tsx`
- Modify: `web/src/styles.css`
- Test: `web/tests/job-list.test.tsx`
- Test: `web/tests/job-board.test.tsx`
- Test: `web/tests/accessibility-contract.test.ts`
- Test: `web/tests/responsive-layout-contract.test.ts`

**Interfaces:**
- Job title link is the semantic card navigation target.
- No `Özeti aç`, `Özeti kapat`, or `Tüm iş detaylarını aç`.

- [ ] **Step 1: Write failing interaction tests**

```ts
expect(buttonByName('Özeti aç')).toBeNull();
expect(screen.queryByText('Tüm iş detaylarını aç')).toBeNull();
expect(titleLink.getAttribute('href')).toBe(`/jobs/${job.id}`);
```

Command-button activation must call `onCommand` without navigation.

- [ ] **Step 2: Write failing accessibility/layout contracts**

Require one semantic link, no nested interactive controls, visible focus, and visible summary facts at 320 CSS px.

- [ ] **Step 3: Run focused tests**

```bash
cd web
npm test -- --run tests/job-list.test.tsx tests/job-board.test.tsx \
  tests/accessibility-contract.test.ts tests/responsive-layout-contract.test.ts
```

- [ ] **Step 4: Simplify JobRow**

Remove expand state, disclosure IDs/button, conditional command rendering, and separate detail link. Keep the title `<Link>` and add a stretched hit area. Put command controls above the link overlay with a stacking context.

- [ ] **Step 5: Run tests, responsive smoke, and commit**

```bash
cd web
npm test -- --run tests/job-list.test.tsx tests/job-board.test.tsx \
  tests/accessibility-contract.test.ts tests/responsive-layout-contract.test.ts
npm run smoke:responsive
git add web/src/jobs/JobRow.tsx web/src/jobs/JobBoard.tsx web/src/styles.css \
  web/tests/job-list.test.tsx web/tests/job-board.test.tsx \
  web/tests/accessibility-contract.test.ts web/tests/responsive-layout-contract.test.ts
git commit -m "refactor: open job details directly from cards"
```

---

### Task 9: Refresh Readiness After Meeting Result Save

**Files:**
- Modify: `web/src/JobDetail.tsx`
- Test: `web/tests/job-detail.test.tsx`
- Test: `web/tests/meeting-details.test.tsx`

**Interfaces:**
- `saveMeeting` persists result data and then reloads canonical detail.

- [ ] **Step 1: Write failing integration test**

Start with `MEETING_TIME_VALID`, `MEETING_OUTCOME_VALID`, and `MEETING_SUMMARY_PRESENT` as `missing`. Mock successful PATCH and a refreshed detail where all are `met`. Save and assert the checklist updates before `SUBMIT_FOR_APPROVAL`.

- [ ] **Step 2: Run focused test and verify failure**

```bash
cd web
npm test -- --run tests/job-detail.test.tsx tests/meeting-details.test.tsx
```

- [ ] **Step 3: Implement canonical refresh**

```ts
const meetingDetails = await patchMeetingDetails(jobId, input);
await refreshTruth();
setTimelineKey((value) => value + 1);
onChanged();
return meetingDetails;
```

Do not manually patch `submissionReadiness`.

- [ ] **Step 4: Run focused tests and commit**

```bash
cd web
npm test -- --run tests/job-detail.test.tsx tests/meeting-details.test.tsx
git add web/src/JobDetail.tsx web/tests/job-detail.test.tsx \
  web/tests/meeting-details.test.tsx
git commit -m "fix: refresh submission readiness after meeting save"
```

---

### Task 10: Documentation, Full Verification, and PR Readiness

**Files:**
- Modify: `DECISIONS.md`
- Modify: `PRODUCT_REQUIREMENTS.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `docs/user-manual/servora-med-user-manual.md`

**Interfaces:**
- Durable documents use `ACCEPTED`, `ACCEPT_ASSIGNMENT`, and `scheduledAt`.
- Historical `PLANNED` appears only as migrated legacy history.

- [ ] **Step 1: Add one superseding decision**

Record that the unchanged-state-machine decision is superseded for assignment acceptance and scheduling. Include migration semantics and planned/actual separation.

- [ ] **Step 2: Update API/schema/user documentation**

Document exact create/patch fields, `/accept`, permission matrix, default scheduling behavior, nullable pre-submission actual delivery time, and acceptance invalidation.

- [ ] **Step 3: Search for stale active vocabulary**

```bash
rg -n "PLANNED|PLAN|Planla|plannedAt|Planlama atlandı" \
  server/src server/tests web/src web/tests \
  PRODUCT_REQUIREMENTS.md SERVORA_MED_API_DRAFT.md \
  SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_MVP_SLICES.md \
  SERVORA_MED_SCHEMA_DRAFT.md docs/user-manual
```

Every remaining match must be historical, migration-related, or a negative regression assertion.

- [ ] **Step 4: Run full server verification**

```bash
cd server
npm run build
npm test -- --run
npm audit --omit=dev
```

- [ ] **Step 5: Run PostgreSQL verification**

```bash
cd server
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
```

Expected: all tests pass with no unexpected PostgreSQL skips.

- [ ] **Step 6: Run full web verification**

```bash
cd web
npm test -- --run
npm run build
npm run smoke:responsive
npm audit --omit=dev
```

- [ ] **Step 7: Verify migration immutability and diff hygiene**

```bash
git diff --exit-code origin/main -- server/src/db/migrations/001_* \
  server/src/db/migrations/002_* server/src/db/migrations/003_* \
  server/src/db/migrations/004_* server/src/db/migrations/005_* \
  server/src/db/migrations/006_* server/src/db/migrations/007_* \
  server/src/db/migrations/008_*
git diff --check
```

- [ ] **Step 8: Commit documentation**

```bash
git add DECISIONS.md PRODUCT_REQUIREMENTS.md SERVORA_MED_API_DRAFT.md \
  SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_MVP_SLICES.md \
  SERVORA_MED_SCHEMA_DRAFT.md docs/user-manual/servora-med-user-manual.md
git commit -m "docs: define job acceptance and scheduling workflow"
```

- [ ] **Step 9: Prepare PR evidence**

The PR summary must state:

- `PLANNED` replaced by Staff acceptance;
- migration 009 maps legacy `PLANNED -> NEW`;
- planned and actual times are separated;
- assignment-stage notes are enabled;
- list cards navigate directly;
- meeting readiness refresh bug is fixed;
- exact server/web/PostgreSQL/smoke/audit results.
