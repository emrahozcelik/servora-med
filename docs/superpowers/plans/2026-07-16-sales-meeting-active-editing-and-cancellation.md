# Sales Meeting Active Editing and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authorized users edit and cancel Sales Meetings throughout the active lifecycle, use controlled approval withdrawal before review-state edits, and make the result form default its time and report no-op saves clearly.

**Architecture:** Keep backend policy, named lifecycle commands, version checks, row locks, and activities authoritative. Add a focused meeting JobCard edit form that reuses the existing PATCH contract and reference services; `WAITING_APPROVAL` editing first invokes the existing withdrawal endpoint. Keep result data separate from planned-job fields and preserve terminal immutability.

**Tech Stack:** PostgreSQL, Fastify, TypeScript, Vitest, React 19, Vite, jsdom, existing REST and idempotency infrastructure.

## Global Constraints

- Assigned Staff may cancel their own JobCard in `NEW`, `PLANNED`, `IN_PROGRESS`, `WAITING_APPROVAL`, or `REVISION_REQUESTED`.
- Manager/Admin may cancel organization-visible JobCards in every non-terminal status.
- `COMPLETED` and `CANCELLED` remain immutable and cannot be reopened or cancelled again.
- `WAITING_APPROVAL` editing must first use `POST /api/job-cards/:id/withdraw-from-approval`; do not mutate the review snapshot in place.
- Withdrawal keeps `clientActionId`, `expectedVersion`, `JOB_WITHDRAW_FROM_APPROVAL:${jobCardId}`, and `JOB_APPROVAL_WITHDRAWN`.
- Direct JobCard editing uses the existing `PATCH /api/job-cards/:id` route and `expectedVersion`.
- `NEW` and `PLANNED` continue to hide and reject Sales Meeting result and note writes.
- A null persisted `meetingAt` defaults once to the device's current local minute; persisted values and user edits win.
- A valid no-op result patch returns `400 MEETING_DETAILS_UNCHANGED` with `Görüşme sonucunda kaydedilecek bir değişiklik yok.`
- Do not add a migration, dependency, generic status endpoint, notification, or WebSocket behavior.
- Do not change Sezer Dener's password or leave temporary sessions/test JobCards behind.

## File Structure

- `server/src/modules/job-cards/policy.ts`: canonical active-state cancellation and withdrawal authorization.
- `server/src/modules/job-cards/service.ts`: exact no-op result error and existing command execution.
- `server/tests/job-card-policy.test.ts`: complete role/status matrix.
- `server/tests/job-card-lifecycle-service.test.ts`: Manager/Admin withdrawal and expanded cancellation behavior.
- `server/tests/sales-meeting-service.test.ts`: exact result no-op contract.
- `server/tests/sales-meeting-postgres.test.ts`: real transaction/concurrency regression.
- `web/src/jobs/job-capabilities.ts`: pure edit/cancel/withdraw visibility projection.
- `web/src/jobs/jobs-api.ts`: full existing JobCard patch input type.
- `web/src/jobs/MeetingDetails.tsx`: current-time default and no-op result guard.
- `web/src/jobs/SalesMeetingEditForm.tsx`: focused active Sales Meeting JobCard form.
- `web/src/JobDetail.tsx`: edit-mode orchestration, withdrawal sequencing, conflict refresh.
- `web/tests/{job-capabilities,meeting-details,job-detail,sales-meeting-edit}.test.*`: UI TDD coverage.
- Durable product/architecture/API/user-manual docs: approved permission and editing behavior.

---

### Task 1: Expand the canonical cancellation and withdrawal policy

**Files:**
- Modify: `server/tests/job-card-policy.test.ts`
- Modify: `server/src/modules/job-cards/policy.ts`

**Interfaces:**
- Consumes: `assertCanTransition(actor, job, command, reason?)`.
- Produces: cancellation in all active states for assigned Staff and Manager/Admin; withdrawal in `WAITING_APPROVAL` for assigned Staff and Manager/Admin.

- [ ] **Step 1: Write the failing authorization matrix**

Add table-driven tests equivalent to:

```ts
for (const status of ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
  expect(() => assertCanTransition(staff, { ...job, status }, 'CANCEL', 'Gerekçe'))
    .not.toThrow();
  expect(() => assertCanTransition(manager, { ...job, status }, 'CANCEL', 'Gerekçe'))
    .not.toThrow();
}
expect(() => assertCanTransition(manager, { ...job, status: 'WAITING_APPROVAL' }, 'WITHDRAW_FROM_APPROVAL'))
  .not.toThrow();
expect(() => assertCanTransition(admin, { ...job, status: 'WAITING_APPROVAL' }, 'WITHDRAW_FROM_APPROVAL'))
  .not.toThrow();
expect(() => assertCanTransition(otherStaff, { ...job, status: 'IN_PROGRESS' }, 'CANCEL', 'Gerekçe'))
  .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
```

Retain explicit terminal, cross-organization, missing-reason, and invalid-source assertions.

- [ ] **Step 2: Run the policy test and confirm RED**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts`

Expected: FAIL because Staff cancellation is restricted to `WAITING_APPROVAL` and non-Staff withdrawal is forbidden.

- [ ] **Step 3: Make the smallest policy change**

Remove the Staff `CANCEL`/`WAITING_APPROVAL` special-case denial and change withdrawal authorization to:

```ts
if (command === 'WITHDRAW_FROM_APPROVAL'
  && actor.role === 'STAFF' && actor.id !== job.assignedTo) forbidden();
```

Keep the active `allowedSources` list and terminal guard unchanged.

- [ ] **Step 4: Run the policy test and confirm GREEN**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts`

Expected: all policy tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/policy.ts server/tests/job-card-policy.test.ts
git commit -m "feat: expand active job cancellation policy"
```

---

### Task 2: Prove lifecycle service authorization, idempotency, and activity

**Files:**
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify only if a test exposes a defect: `server/src/modules/job-cards/service.ts`

**Interfaces:**
- Consumes: `JobCardService.cancel()` and `JobCardService.withdrawFromApproval()`.
- Produces: audited Manager/Admin withdrawal and Staff active-state cancellation through the existing command engine.

- [ ] **Step 1: Write failing service tests**

Add tests that call the real service command definitions:

```ts
const withdrawn = await service.withdrawFromApproval(manager, 'job-1', {
  clientActionId: 'manager-withdraw-1', expectedVersion: 3,
});
expect(withdrawn).toMatchObject({ status: 'IN_PROGRESS', version: 4 });
expect(repository.activities.at(-1)).toMatchObject({
  event: 'JOB_APPROVAL_WITHDRAWN', actorId: manager.id,
});

for (const status of ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
  const repository = lifecycleRepository({ status });
  await expect(new JobCardService(repository).cancel(staff, 'job-1', {
    clientActionId: `cancel-${status}`, expectedVersion: 3, cancelReason: 'İptal edildi.',
  })).resolves.toMatchObject({ status: 'CANCELLED' });
}
```

Assert replay returns the original withdrawal response and terminal/cross-assignee calls still fail.

- [ ] **Step 2: Run the focused service test and confirm RED**

Run: `cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts`

Expected: Manager withdrawal and pre-review Staff cancellation cases fail with `FORBIDDEN` before Task 1 is present; after Task 1 they document GREEN service behavior without a parallel command model.

- [ ] **Step 3: Correct only defects revealed by the service test**

Keep the existing definition:

```ts
operation: 'JOB_WITHDRAW_FROM_APPROVAL',
event: 'JOB_APPROVAL_WITHDRAWN',
from: ['WAITING_APPROVAL'],
to: 'IN_PROGRESS',
```

Do not add role branching in `service.ts`; policy remains the authorization source.

- [ ] **Step 4: Run the lifecycle service suite and confirm GREEN**

Run: `cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts`

Expected: all tests pass and the named route contract remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/tests/job-card-lifecycle-service.test.ts server/src/modules/job-cards/service.ts
git commit -m "test: cover active cancellation commands"
```

---

### Task 3: Replace result no-op body validation with an exact domain error

**Files:**
- Modify: `server/tests/sales-meeting-service.test.ts`
- Modify: `server/src/modules/job-cards/service.ts`

**Interfaces:**
- Consumes: `patchMeetingDetails(actor, jobCardId, input)`.
- Produces: `MEETING_DETAILS_UNCHANGED` for a syntactically valid patch whose canonical candidate equals persisted details.

- [ ] **Step 1: Write the failing exact-contract test**

```ts
await expect(service.patchMeetingDetails(staff, job.id, {
  clientActionId: 'meeting-no-change', expectedVersion: job.version,
  meetingAt: current.meetingAt, outcome: current.outcome,
  meetingSummary: current.meetingSummary, nextFollowUpAt: current.nextFollowUpAt,
})).rejects.toMatchObject({
  statusCode: 400,
  code: 'MEETING_DETAILS_UNCHANGED',
  message: 'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
});
```

Also assert no version bump and no activity append.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd server && npm test -- --run tests/sales-meeting-service.test.ts`

Expected: FAIL with current `VALIDATION_ERROR` / `body geçersizdir.`.

- [ ] **Step 3: Implement the exact no-op error**

Replace only the `changedFields.length === 0` branch with:

```ts
throw new AppError(
  'MEETING_DETAILS_UNCHANGED',
  400,
  'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
);
```

- [ ] **Step 4: Run focused server tests and confirm GREEN**

Run: `cd server && npm test -- --run tests/sales-meeting-service.test.ts tests/sales-meeting-schema.test.ts`

Expected: all tests pass; malformed bodies still return `VALIDATION_ERROR`.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/service.ts server/tests/sales-meeting-service.test.ts
git commit -m "fix: explain unchanged meeting results"
```

---

### Task 4: Update frontend capabilities and the full patch contract

**Files:**
- Modify: `web/tests/job-capabilities.test.ts`
- Modify: `web/tests/jobs-api.test.ts`
- Modify: `web/src/jobs/job-capabilities.ts`
- Modify: `web/src/jobs/jobs-api.ts`

**Interfaces:**
- Produces: `canEditJob`, expanded `canCancel`, `requiresWithdrawalBeforeEdit`, and `PatchJobCardInput`.

- [ ] **Step 1: Write failing pure capability tests**

```ts
for (const status of ['NEW', 'PLANNED', 'IN_PROGRESS', 'REVISION_REQUESTED'] as const) {
  expect(jobCapabilities(staff, { ...meeting, status })).toMatchObject({
    canEditJob: true, canCancel: true, requiresWithdrawalBeforeEdit: false,
  });
}
expect(jobCapabilities(staff, { ...meeting, status: 'WAITING_APPROVAL' })).toMatchObject({
  canEditJob: true, canCancel: true, requiresWithdrawalBeforeEdit: true,
});
expect(jobCapabilities(manager, { ...meeting, status: 'WAITING_APPROVAL' })).toMatchObject({
  canEditJob: true, canCancel: true, requiresWithdrawalBeforeEdit: true,
});
expect(jobCapabilities(staff, { ...meeting, status: 'COMPLETED' }).canEditJob).toBe(false);
```

- [ ] **Step 2: Write the failing API projection test**

Call `patchJobCard` with every existing route field and assert the JSON body contains:

```ts
{
  expectedVersion: 5,
  title: 'Yeni başlık',
  description: 'Yeni açıklama',
  customerId: 'customer-2',
  contactId: 'contact-2',
  assignedTo: 'staff-2',
  priority: 'high',
  dueDate: '2026-07-20',
}
```

- [ ] **Step 3: Run focused web tests and confirm RED**

Run: `cd web && npm test -- --run tests/job-capabilities.test.ts tests/jobs-api.test.ts`

Expected: FAIL because the new capability keys and full patch input type are absent.

- [ ] **Step 4: Implement the pure projection and type**

Export:

```ts
export type PatchJobCardInput = {
  expectedVersion: number;
  title?: string;
  description?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  assignedTo?: string;
  priority?: JobCardPriority;
  dueDate?: string | null;
};
```

Derive `active = !['COMPLETED', 'CANCELLED'].includes(job.status)`, authorize assigned Staff
or Manager/Admin, and set `requiresWithdrawalBeforeEdit` only for `WAITING_APPROVAL`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `cd web && npm test -- --run tests/job-capabilities.test.ts tests/jobs-api.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/jobs/job-capabilities.ts web/src/jobs/jobs-api.ts web/tests/job-capabilities.test.ts web/tests/jobs-api.test.ts
git commit -m "feat: project active meeting edit capabilities"
```

---

### Task 5: Default the meeting time and suppress no-op result requests

**Files:**
- Modify: `web/tests/meeting-details.test.tsx`
- Modify: `web/src/jobs/MeetingDetails.tsx`

**Interfaces:**
- Produces: exported `meetingLocalValue(value, now?)` helper and client-side canonical no-op detection.

- [ ] **Step 1: Write failing current-time tests**

Use fake timers:

```ts
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-07-16T12:34:45.000Z'));
await act(async () => root.render(<MeetingDetailsSection details={detailsWithNullTime} {...props} />));
expect((container.querySelector('#meeting-actual-at') as HTMLInputElement).value)
  .toBe(meetingLocalValue(null, new Date('2026-07-16T12:34:45.000Z')));
```

Assert a persisted time wins, rerendering does not advance the field, and manual changes are not overwritten.

- [ ] **Step 2: Write the failing no-op UI test**

Render persisted non-null details, submit without changing controls, and assert:

```ts
expect(onSave).not.toHaveBeenCalled();
expect(container.querySelector('[role="status"]')?.textContent)
  .toContain('Görüşme sonucunda kaydedilecek bir değişiklik yok.');
```

- [ ] **Step 3: Run the component test and confirm RED**

Run: `cd web && npm test -- --run tests/meeting-details.test.tsx`

Expected: null time is empty and unchanged submit calls `onSave`.

- [ ] **Step 4: Implement stable initialization and canonical comparison**

Initialize time once:

```ts
const [meetingAt, setMeetingAt] = useState(() => localValue(details.meetingAt)
  || localValue(new Date().toISOString()));
```

Before allocating `clientActionId`, normalize the four fields and compare them with persisted
details. On equality set feedback to the exact no-op message and return without a request.
When new canonical details arrive, preserve a dirty user value; replace it only with a non-null
persisted value or when the JobCard identity changes.

- [ ] **Step 5: Run the component test and confirm GREEN**

Run: `cd web && npm test -- --run tests/meeting-details.test.tsx`

Expected: all default-time, persisted-time, override, no-op, and existing accessibility tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/jobs/MeetingDetails.tsx web/tests/meeting-details.test.tsx
git commit -m "fix: default meeting result time"
```

---

### Task 6: Build the focused Sales Meeting JobCard edit form

**Files:**
- Create: `web/src/jobs/SalesMeetingEditForm.tsx`
- Create: `web/tests/sales-meeting-edit.test.tsx`

**Interfaces:**
- Consumes: `JobCard`, `CurrentUser`, `PatchJobCardInput`, `listCustomers`, `listContacts`, `listStaff`.
- Produces: `SalesMeetingEditForm({ job, user, pending, onCancel, onSave })`.

- [ ] **Step 1: Write failing form tests**

Cover these exact behaviors:

```ts
expect(screenValues()).toMatchObject({
  title: job.title, description: job.description, dueDate: job.dueDate,
  customerId: job.customerId, contactId: job.contactId, priority: job.priority,
});
expect(container.querySelector('#meeting-edit-assignee')).toBeNull(); // Staff
expect(managerContainer.querySelector('#meeting-edit-assignee')).not.toBeNull();
```

Change the customer and assert contact clears and active contacts reload. Submit and assert
`onSave` receives only canonical fields plus `expectedVersion`. Verify blank title/day/customer
are field errors, `Vazgeç` calls `onCancel`, and pending disables controls.

- [ ] **Step 2: Run the new test and confirm RED**

Run: `cd web && npm test -- --run tests/sales-meeting-edit.test.tsx`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the form using existing services**

Create a controlled form with IDs `meeting-edit-title`, `meeting-edit-description`,
`meeting-edit-due-date`, `meeting-edit-customer`, `meeting-edit-contact`,
`meeting-edit-priority`, and Manager/Admin-only `meeting-edit-assignee`. Load active customers,
the selected customer's active contacts, and active Staff profiles. Submit:

```ts
await onSave({
  expectedVersion: job.version,
  title: title.trim(),
  description: description.trim() || null,
  customerId,
  contactId: contactId || null,
  assignedTo: user.role === 'STAFF' ? job.assignedTo : assignedTo,
  priority,
  dueDate,
});
```

Use existing field/error/focus class conventions and no new dependency.

- [ ] **Step 4: Run the form tests and confirm GREEN**

Run: `cd web && npm test -- --run tests/sales-meeting-edit.test.tsx`

Expected: all form, authorization-visibility, validation, and reference-loading tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/SalesMeetingEditForm.tsx web/tests/sales-meeting-edit.test.tsx
git commit -m "feat: edit active sales meetings"
```

---

### Task 7: Orchestrate edit, withdrawal, cancellation, and conflicts in detail

**Files:**
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`
- Modify: `web/src/JobDetail.tsx`

**Interfaces:**
- Consumes: `jobCapabilities`, `SalesMeetingEditForm`, `patchJobCard`, and `withdrawJobCardFromApproval`.
- Produces: direct edit mode and withdraw-then-edit sequencing.

- [ ] **Step 1: Write failing action-visibility tests**

Assert assigned Staff sees `Görüşmeyi düzenle` and `İşi iptal et` in each direct active state.
Assert `WAITING_APPROVAL` shows `Onaydan geri çek ve düzenle` and cancellation. Assert
Manager/Admin waiting review also includes controlled edit and cancellation alongside approve
and revision. Assert terminal and unassigned Staff views have no edit/cancel actions.

- [ ] **Step 2: Write failing orchestration tests**

For direct edit, click `Görüşmeyi düzenle`, submit the form, and assert `patchJobCard` uses the
current version and the refreshed canonical detail is rendered. For waiting edit:

```ts
expect(withdrawJobCardFromApproval).toHaveBeenCalledWith(job.id, {
  clientActionId: expect.any(String), expectedVersion: job.version,
});
expect(patchJobCard).not.toHaveBeenCalled();
expect(container.querySelector('#meeting-edit-title')).not.toBeNull();
```

Assert a withdrawal conflict refreshes truth and does not open stale edit mode. Assert a patch
conflict reloads truth, exits stale edit mode, and announces the conflict.

- [ ] **Step 3: Run focused detail tests and confirm RED**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx`

Expected: edit actions/form are absent and Staff cancellation is absent before waiting approval.

- [ ] **Step 4: Implement detail orchestration**

Add `editing` state. Direct edit sets it true. Waiting edit stores a stable withdrawal action ID,
awaits the named withdrawal command, updates canonical state to `IN_PROGRESS`, then sets edit
mode true. Successful `patchJobCard` calls `refreshTruth()`, closes edit mode, refreshes timeline,
and announces success. `VERSION_CONFLICT` always reloads canonical truth before allowing retry.

Keep result/notes mounting rules unchanged. Route all cancel buttons through the existing reason
dialog. Derive visibility from `jobCapabilities` rather than duplicating status lists.

- [ ] **Step 5: Run detail tests and confirm GREEN**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx tests/job-capabilities.test.ts`

Expected: all action, sequence, dialog, conflict, result visibility, and review tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/JobDetail.tsx web/tests/job-detail.test.tsx web/tests/manager-review.test.tsx
git commit -m "feat: orchestrate meeting edits from detail"
```

---

### Task 8: PostgreSQL concurrency, durable docs, and acceptance

**Files:**
- Modify: `server/tests/sales-meeting-postgres.test.ts`
- Modify: `PRODUCT_REQUIREMENTS.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `docs/user-manual/servora-med-user-manual.md`
- Modify: `docs/superpowers/plans/2026-07-16-sales-meeting-active-editing-and-cancellation.md`

**Interfaces:**
- Verifies: real locking/version behavior and the final user-visible contract.

- [ ] **Step 1: Add the PostgreSQL race regression**

Create a disposable waiting Sales Meeting and race Manager approval against Manager withdrawal;
assert exactly one command succeeds, the loser receives `VERSION_CONFLICT`, and exactly one of
`JOB_APPROVED`/`JOB_APPROVAL_WITHDRAWN` exists. Create an active meeting and race Staff patch
against Staff cancellation; assert one canonical mutation wins and the activity/version history
contains no duplicate business event.

- [ ] **Step 2: Run real PostgreSQL acceptance**

Run against a disposable migrated database:

```bash
createdb servora_med_active_edit_test
cd server
TEST_DATABASE_URL=postgresql:///servora_med_active_edit_test npm test -- --run tests/sales-meeting-postgres.test.ts
dropdb servora_med_active_edit_test
```

Expected: acceptance passes and the disposable database is removed.

- [ ] **Step 3: Update durable documentation**

Record the exact active edit/cancel matrix, controlled waiting withdrawal, terminal immutability,
default result time, and `MEETING_DETAILS_UNCHANGED` response. Do not alter historical slice
evidence or claim that terminal records are editable.

- [ ] **Step 4: Run full verification**

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && npm audit --audit-level=high
cd web && npm run build
cd web && npm test -- --run
cd web && npm audit --audit-level=high
git diff --check
```

Expected: every command exits zero; PostgreSQL-gated tests may skip only when
`TEST_DATABASE_URL` is absent, with the focused real-PostgreSQL command already passed.

- [ ] **Step 5: Run controlled Sezer Dener acceptance**

Use Sezer Dener's existing active account and an assigned non-terminal Sales Meeting. Verify:

1. edit and cancel actions appear before approval;
2. edit mode loads canonical fields;
3. a null result time defaults to the current local minute and remains editable;
4. unchanged persisted result does not send a request or show `body geçersizdir.`;
5. waiting edit withdraws before opening the form;
6. completed/cancelled cards remain read-only.

Do not change Sezer's password. Delete any directly inserted temporary session. Do not cancel or
irreversibly alter the user's existing business records; use a disposable clearly named meeting
and cancel it with an acceptance reason only if cancellation itself must be exercised.

- [ ] **Step 6: Mark plan execution evidence and commit**

```bash
git add PRODUCT_REQUIREMENTS.md SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_API_DRAFT.md \
  docs/user-manual/servora-med-user-manual.md \
  docs/superpowers/plans/2026-07-16-sales-meeting-active-editing-and-cancellation.md \
  server/tests/sales-meeting-postgres.test.ts
git commit -m "docs: record active meeting editing"
```

- [ ] **Step 7: Push the existing branch and update PR #11 without merging**

```bash
git push origin fix/meeting-lifecycle-and-approval-withdrawal
gh pr checks 11 --watch --interval 10
```

Expected: `server` and `web` checks pass; PR remains open and unmerged.
