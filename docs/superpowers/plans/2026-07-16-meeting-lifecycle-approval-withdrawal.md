# Meeting Lifecycle, Approval Withdrawal, and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sales Meeting result/notes lifecycle-correct, add an idempotent assigned-Staff approval-withdrawal command, and allow narrowly scoped cancellation of assigned work while it waits for approval.

**Architecture:** Extend the existing named-command lifecycle engine, row-lock/version/idempotency transaction, and safe activity presenter. Keep backend policy authoritative; expose one frontend capability projection that controls rendering and commands without duplicating transition validation. Add only the append-only activity constraint migration required for `JOB_APPROVAL_WITHDRAWN`.

**Tech Stack:** PostgreSQL migrations, Fastify, TypeScript, Vitest, React 19, Vite, jsdom component tests, existing browser acceptance tooling.

## Execution Status — 2026-07-16

- Tasks 1–8 and the documentation/full-verification portions of Task 9 are complete.
- The four required PostgreSQL lifecycle races pass: approve/withdraw,
  request-revision/withdraw, cancel/withdraw, and cancel/approve.
- Browser acceptance was attempted but could not be completed because the local dataset has
  no active Staff/Manager pair in the same organization with password-change requirements
  cleared. No acceptance records or sessions were left behind.
- Draft PR [#11](https://github.com/emrahozcelik/servora-med/pull/11) is open; its
  server and web CI checks are green. The PR remains intentionally unmerged.

## Global Constraints

- Do not modify applied migrations `001`–`007`; add `008_meeting_approval_withdrawal.sql`.
- Use `clientActionId` and `expectedVersion`; do not introduce `actionId` or a generic status endpoint.
- Use exact meeting-guard error `409 JOB_NOT_EDITABLE` with `JobCard bu durumda düzenlenemez.`
- Scope withdrawal idempotency as `JOB_WITHDRAW_FROM_APPROVAL:${jobCardId}`.
- Assigned Staff may cancel only their own `WAITING_APPROVAL` JobCard; do not grant Staff cancellation in any other state.
- Preserve Manager/Admin cancellation behavior and extend their valid source states with `WAITING_APPROVAL`.
- `NEW`/`PLANNED` Sales Meeting result and notes are not rendered, mounted, or requested.
- `WAITING_APPROVAL`/`COMPLETED` Sales Meeting notes load read-only; `CANCELLED` renders notes only when records exist.
- Do not change Product Delivery or General Task note behavior.
- Do not reopen `COMPLETED` or `CANCELLED`, delete history, add notifications/WebSocket, or create a new JobCard type.
- Maintain WCAG 2.2 AA, keyboard completion, focus restoration, 44×44 px applicable targets, reduced motion, 390 CSS px mobile, 200% text, and supported 400% reflow.
- Preserve the untracked `pilot-products.example.json`; it is outside this task.

## File Structure

- `server/src/db/migrations/008_meeting_approval_withdrawal.sql`: append-only activity event constraint update.
- `server/src/modules/job-cards/types.ts`: canonical lifecycle command and activity vocabulary.
- `server/src/modules/job-cards/policy.ts`: exact meeting write guard and role/source transition matrix.
- `server/src/modules/job-cards/service.ts`: withdrawal command definition and exact scoped operation key.
- `server/src/modules/job-cards/notes-service.ts`: Sales Meeting-only note write guard.
- `server/src/modules/job-cards/{handlers,routes}.ts`: named withdrawal HTTP command.
- `server/src/modules/job-cards/activity-presenter.ts`: withdrawal and waiting-cancellation safe transition presentation.
- `web/src/jobs/job-capabilities.ts`: single pure visibility/action projection.
- `web/src/jobs/{jobs-api,MeetingDetails,JobNotes,JobRow,job-labels}.tsx?`: API contract and capability consumers.
- `web/src/JobDetail.tsx`: canonical command state, withdrawal action, cancellation dialog, stale reload.
- Existing server/web test files: focused TDD additions without a new framework.
- SSOT and user manual files: durable lifecycle documentation.

---

### Task 1: Append-only activity migration and vocabulary

**Files:**
- Create: `server/src/db/migrations/008_meeting_approval_withdrawal.sql`
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/activity-presenter.ts`
- Modify: `server/tests/sales-meeting-schema.test.ts`
- Modify: `server/tests/job-card-activity.test.ts`

**Interfaces:**
- Consumes: existing `JOB_CARD_ACTIVITY_EVENTS`, `JobCardActivityEvent`, `presentActivity()`.
- Produces: event `JOB_APPROVAL_WITHDRAWN` presented as `WAITING_APPROVAL → IN_PROGRESS`; waiting cancellation presented as `WAITING_APPROVAL → CANCELLED`.

- [ ] **Step 1: Write failing migration and presenter tests**

Add an exact expected event set containing every existing event plus `JOB_APPROVAL_WITHDRAWN`; assert the migration constraint contains the entire set, not only the new value. Add lifecycle cases:

```ts
['JOB_APPROVAL_WITHDRAWN', 'WAITING_APPROVAL', 'IN_PROGRESS'],
['JOB_CANCELLED', 'WAITING_APPROVAL', 'CANCELLED'],
```

The schema test must compare `readCheckValues(..., 'job_card_activity_logs_event_type_check')` to the full canonical set and must apply migrations `001`–`008` twice to prove no reapply.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd server && npm test -- --run tests/sales-meeting-schema.test.ts tests/job-card-activity.test.ts`

Expected: FAIL because migration `008` and event/type presenter support do not exist.

- [ ] **Step 3: Add the migration and minimal vocabulary support**

Create migration SQL that drops and recreates only `job_card_activity_logs_event_type_check`, copying all 15 old values from `007` and adding `JOB_APPROVAL_WITHDRAWN`. Extend the TypeScript event tuple and safe lifecycle transition allowlist.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `cd server && npm test -- --run tests/sales-meeting-schema.test.ts tests/job-card-activity.test.ts`

Expected: PASS; canonical vocabulary has 16 unique values and all old values remain.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations/008_meeting_approval_withdrawal.sql \
  server/src/modules/job-cards/types.ts server/src/modules/job-cards/activity-presenter.ts \
  server/tests/sales-meeting-schema.test.ts server/tests/job-card-activity.test.ts
git commit -m "feat: add approval withdrawal activity"
```

### Task 2: Backend withdrawal lifecycle command

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Modify: `server/tests/job-card-policy.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**
- Consumes: `runLifecycle()`, `executeCriticalAction()`, versioned row lock, lifecycle handler `body()`.
- Produces: `JobCardService.withdrawFromApproval(actor, jobCardId, input)` and `POST /:id/withdraw-from-approval`.

- [ ] **Step 1: Write failing policy/service/route tests**

Cover assigned Staff success, other Staff `403 FORBIDDEN`, Manager/Admin `403 FORBIDDEN`, non-waiting `409 INVALID_TRANSITION`, stale `409 VERSION_CONFLICT`, replay without duplicate activity, in-progress duplicate, one `JOB_APPROVAL_WITHDRAWN`, retained submission event, and resubmission. Assert:

```ts
expect(repo.claims[0]?.operationKey)
  .toBe('JOB_WITHDRAW_FROM_APPROVAL:job-1');
expect(repo.events.at(-1)).toMatchObject({
  event: 'JOB_APPROVAL_WITHDRAWN',
  oldValue: { status: 'WAITING_APPROVAL' },
  newValue: { status: 'IN_PROGRESS' },
});
```

Route test must send only `clientActionId` and `expectedVersion` and reject unsupported fields through the existing body allowlist.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts`

Expected: FAIL because the command, service method, handler, and route are absent.

- [ ] **Step 3: Implement the minimal named command**

Extend `LifecycleCommand` with `WITHDRAW_FROM_APPROVAL`. In policy, require role `STAFF`, actor ID equal to `assignedTo`, and source `WAITING_APPROVAL`. Add:

```ts
async withdrawFromApproval(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
  return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
    command: 'WITHDRAW_FROM_APPROVAL',
    operationKey: 'JOB_WITHDRAW_FROM_APPROVAL',
    target: 'IN_PROGRESS',
    event: 'JOB_APPROVAL_WITHDRAWN',
    note: null,
    revisionReason: null,
    cancelReason: null,
  });
}
```

Retain `runLifecycle()` scoping `${definition.operationKey}:${jobCardId}`. Wire the handler using `LIFECYCLE_FIELDS` and add the exact route.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/{types,policy,service,handlers,routes}.ts \
  server/tests/job-card-{policy,lifecycle-service,routes}.test.ts
git commit -m "feat: withdraw jobs from approval"
```

### Task 3: Narrow waiting-approval cancellation authorization

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/tests/job-card-policy.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`

**Interfaces:**
- Consumes: existing `cancel()` request and `JOB_CANCELLED` activity.
- Produces: assigned Staff-only `WAITING_APPROVAL → CANCELLED`; Manager/Admin retain old sources and gain waiting source.

- [ ] **Step 1: Write the failing authorization matrix**

Assert assigned Staff succeeds only from `WAITING_APPROVAL`; Staff cancellation from `NEW`, `PLANNED`, `IN_PROGRESS`, and `REVISION_REQUESTED` remains `403 FORBIDDEN`; other Staff is forbidden; Manager/Admin retain old cancellation states and can cancel waiting. Assert whitespace reason yields `400 CANCEL_REASON_REQUIRED`, one activity retains reason in persisted cancellation fields, and approve after cancellation fails.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-lifecycle-service.test.ts`

Expected: FAIL on assigned Staff waiting cancellation and waiting source validation.

- [ ] **Step 3: Implement explicit role/source branching**

In `assertCanTransition`, handle `CANCEL` before the broad Staff reviewer-command rule:

```ts
if (command === 'CANCEL' && actor.role === 'STAFF' && job.status !== 'WAITING_APPROVAL') {
  forbidden();
}
```

Keep assignment and organization checks, remove `CANCEL` from the blanket Staff reviewer denial, and add `WAITING_APPROVAL` to the shared cancel source list. Preserve the existing mandatory reason check.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/policy.ts \
  server/tests/job-card-policy.test.ts server/tests/job-card-lifecycle-service.test.ts
git commit -m "feat: cancel assigned jobs awaiting approval"
```

### Task 4: Exact Sales Meeting result and note write guards

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/notes-service.ts`
- Modify: `server/tests/sales-meeting-service.test.ts`
- Modify: `server/tests/job-card-notes.test.ts`

**Interfaces:**
- Consumes: JobCard type/status, existing `assertCanEdit()` and note transaction.
- Produces: `assertCanEditMeetingResult()` and `assertCanAddNote()` using exact error contract.

- [ ] **Step 1: Write failing status-matrix tests**

For structured results and note creation assert `NEW`/`PLANNED` reject with:

```ts
expect(error).toMatchObject({
  statusCode: 409,
  code: 'JOB_NOT_EDITABLE',
  message: 'JobCard bu durumda düzenlenemez.',
});
```

Also assert Sales Meeting `IN_PROGRESS`/`REVISION_REQUESTED` accept both, Sales Meeting waiting/terminal note creation rejects, note listing remains allowed, and Product Delivery/General Task note creation behavior is unchanged.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd server && npm test -- --run tests/sales-meeting-service.test.ts tests/job-card-notes.test.ts`

Expected: FAIL because planned result/note writes currently succeed.

- [ ] **Step 3: Implement minimal type-specific policy guards**

Add a shared exact-error helper and policies:

```ts
function notEditable(): never {
  throw new AppError('JOB_NOT_EDITABLE', 409, 'JobCard bu durumda düzenlenemez.');
}

export function assertCanEditMeetingResult(actor: JobCardActor, job: JobCard) {
  assertCanEdit(actor, job);
  if (!['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) notEditable();
}

export function assertCanAddNote(actor: JobCardActor, job: JobCard) {
  assertCanAccessNotes(actor, job);
  if (job.type === 'SALES_MEETING'
    && !['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)) notEditable();
}
```

Use the result guard in `patchMeetingDetails()` and note guard inside the locked note transaction before `createNote()`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/{policy,service,notes-service}.ts \
  server/tests/sales-meeting-service.test.ts server/tests/job-card-notes.test.ts
git commit -m "fix: guard meeting results and notes by lifecycle"
```

### Task 5: PostgreSQL concurrency and integration proof

**Files:**
- Modify: `server/tests/sales-meeting-postgres.test.ts`
- Modify: `server/tests/job-card-workspace-postgres.test.ts`

**Interfaces:**
- Consumes: real `PostgresJobCardRepository`, migration `008`, lifecycle service.
- Produces: database-backed proof of locking, rollback, idempotency, history, and queue truth.

- [ ] **Step 1: Add PostgreSQL-enabled failing tests**

Create waiting Sales Meetings and race promises for approve vs withdraw, request revision vs withdraw, cancel vs withdraw, and cancel vs approve. Use separate service calls/connections and assert exactly one fulfilled transition, one canonical activity, final persisted status, and no approval of a cancelled card. Add withdraw/edit/resubmit history assertion in chronological order.

- [ ] **Step 2: Run with disposable PostgreSQL and confirm RED where support is incomplete**

Run: `cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run tests/sales-meeting-postgres.test.ts tests/job-card-workspace-postgres.test.ts`

Expected: FAIL before all new database behavior is wired; if `TEST_DATABASE_URL` is absent, provision the repository's documented disposable PostgreSQL target rather than treating skips as evidence.

- [ ] **Step 3: Make only integration corrections revealed by the tests**

Correct lock/order, operation key, or activity mapping defects in existing touched files; do not introduce new concurrency infrastructure.

- [ ] **Step 4: Run PostgreSQL tests and confirm GREEN**

Run the Step 2 command. Expected: PASS with no skips in these files.

- [ ] **Step 5: Commit**

```bash
git add server/tests/sales-meeting-postgres.test.ts \
  server/tests/job-card-workspace-postgres.test.ts server/src/modules/job-cards
git commit -m "test: verify approval withdrawal concurrency"
```

### Task 6: Frontend API and canonical capability projection

**Files:**
- Create: `web/src/jobs/job-capabilities.ts`
- Create: `web/tests/job-capabilities.test.ts`
- Modify: `web/src/jobs/jobs-api.ts`
- Modify: `web/src/jobs/job-labels.ts`
- Modify: `web/src/jobs/JobRow.tsx`
- Modify: `web/tests/jobs-api.test.ts`
- Modify: `web/tests/job-list.test.tsx`

**Interfaces:**
- Consumes: `JobCard`, `JobCardListItem`, `CurrentUser`.
- Produces: `jobCapabilities(user, job)` and `withdrawJobCardFromApproval(id, LifecycleInput)`.

- [ ] **Step 1: Write failing capability/API tests**

Define the full status matrix for `canViewMeetingResult`, `canEditMeetingResult`,
`canViewMeetingNotes`, `canAddMeetingNote`, `canWithdrawFromApproval`, and `canCancel`.
Assert only assigned Staff waiting cards receive withdraw/cancel; Manager review remains
approve/revise. Assert API path `/api/job-cards/job-1/withdraw-from-approval` and exact body.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd web && npm test -- --run tests/job-capabilities.test.ts tests/jobs-api.test.ts tests/job-list.test.tsx`

Expected: FAIL because helper/API/event label are absent.

- [ ] **Step 3: Implement pure projection and API function**

Create a dependency-free helper whose result is derived only from canonical type/status,
role/id, and assignment. Add:

```ts
export const withdrawJobCardFromApproval = (id: string, input: LifecycleInput) =>
  lifecycle(id, 'withdraw-from-approval', input);
```

Add `JOB_APPROVAL_WITHDRAWN` Turkish label and make JobRow consume the shared command projection.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/{job-capabilities.ts,jobs-api.ts,job-labels.ts,JobRow.tsx} \
  web/tests/{job-capabilities.test.ts,jobs-api.test.ts,job-list.test.tsx}
git commit -m "feat: derive job lifecycle capabilities"
```

### Task 7: Meeting result and three-mode notes rendering

**Files:**
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/src/jobs/MeetingDetails.tsx`
- Modify: `web/src/jobs/JobNotes.tsx`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/meeting-details.test.tsx`
- Modify: `web/tests/job-notes.test.tsx`

**Interfaces:**
- Consumes: `jobCapabilities()`.
- Produces: `JobNotes` props `canAdd: boolean` and `hideWhenEmpty: boolean`; conditional component mounting in detail.

- [ ] **Step 1: Write failing visibility and request tests**

Assert `NEW`/`PLANNED` mount neither meeting result nor notes and invoke neither details nor notes loader. Assert `IN_PROGRESS`/`REVISION_REQUESTED` edit both. Assert waiting/completed load notes without composer. Assert cancelled loads notes and returns `null` for an empty page but renders persisted notes. Assert no loading flash for hidden sections.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/meeting-details.test.tsx tests/job-notes.test.tsx`

Expected: FAIL because the components always render and JobNotes does not separate read/add/empty behavior.

- [ ] **Step 3: Implement capability-driven mounting**

Move editability out of `MeetingDetailsSection`; pass `canEdit`. Mount result/notes only when their `canView...` flags are true. Split note rendering so loading/list/error remains available without a composer; when `hideWhenEmpty` is true and the loaded page is empty, return `null` rather than an empty card.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/JobDetail.tsx web/src/jobs/{MeetingDetails,JobNotes}.tsx \
  web/tests/{job-detail,meeting-details,job-notes}.test.tsx
git commit -m "fix: show meeting results after start"
```

### Task 8: Assigned-Staff withdraw and cancellation UI

**Files:**
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`

**Interfaces:**
- Consumes: `withdrawJobCardFromApproval()`, `cancelJobCard()`, `jobCapabilities()`.
- Produces: waiting Staff actions, accessible terminal-cancellation reason dialog, stale truth reload.

- [ ] **Step 1: Write failing interaction/accessibility tests**

Assert assigned Staff sees exact labels, stable action IDs, double-submit lock, canonical state replacement, timeline refresh, and error state. For `VERSION_CONFLICT`/`INVALID_TRANSITION`, assert `getJobCard(jobId)` reload occurs and the UI reflects returned truth. Assert the dialog has `role=dialog`, `aria-modal=true`, labelled warning, required reason textarea, whitespace-disabled confirm, Escape/close, focus trap, and trigger focus restoration. Assert Manager controls and other-Staff absence remain correct.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx`

Expected: FAIL because Staff waiting actions are absent.

- [ ] **Step 3: Implement minimal command orchestration and reuse dialog conventions**

Use the existing `ReasonDialog` focus behavior, but provide explicit terminal warning and Staff cancellation copy. Keep separate `useRef<string | null>` action IDs per command until a non-retryable response; never mutate status optimistically. On success assign backend response, close/restore focus, set canonical success feedback, and increment timeline/notes refresh keys.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/JobDetail.tsx web/src/styles.css \
  web/tests/job-detail.test.tsx web/tests/manager-review.test.tsx
git commit -m "feat: manage submitted work from detail"
```

### Task 9: Documentation, acceptance, and full verification

**Files:**
- Modify: `PRODUCT_REQUIREMENTS.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `DECISIONS.md`
- Modify: `docs/user-manual/servora-med-user-manual.md`
- Modify existing acceptance tests under `server/tests/` and `web/tests/` only; do not add a framework.

**Interfaces:**
- Consumes: completed backend/frontend behavior.
- Produces: current SSOT, operator-facing guidance, verified PR-ready branch.

- [ ] **Step 1: Update SSOT and user manual surgically**

Document: meeting results/Staff notes begin after start; `WAITING_APPROVAL` is immutable; withdrawal returns to `IN_PROGRESS`; assigned Staff waiting cancellation requires reason; completed/cancelled remain terminal; other JobCard note behavior is unchanged. Document route, request, event, and migration `008`. Do not rewrite historical Slice 12 evidence.

- [ ] **Step 2: Run focused browser acceptance against the real local stack**

Use the existing browser tooling without adding Playwright dependencies. Verify Staff plan → no result/note request → start → result/note → submit → read-only → withdraw → edit → resubmit → Manager sees new submission. Separately verify waiting cancel with reason removes the card from approval truth and blocks later approval. Record exact pass/fail evidence in the closeout; do not claim automated Playwright if the repository has no Playwright harness.

- [ ] **Step 3: Run full local verification**

```bash
cd server
npm run build
npm test -- --run
npm audit --audit-level=high

cd ../web
npm run build
npm test -- --run
npm audit --audit-level=high

cd ..
git diff --check
git status --short --branch
```

Expected: all commands exit 0; only intentional task files plus untouched untracked `pilot-products.example.json` appear.

- [ ] **Step 4: Run PostgreSQL-enabled full server suite**

Run the full server suite with a disposable migrated database and confirm zero PostgreSQL skips. Apply migrations twice to prove no reapply and query the activity constraint to prove all 16 canonical events remain.

- [ ] **Step 5: Commit documentation and acceptance evidence**

```bash
git add PRODUCT_REQUIREMENTS.md SERVORA_MED_ARCHITECTURE_PLAN.md \
  SERVORA_MED_API_DRAFT.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_MVP_SLICES.md \
  DECISIONS.md docs/user-manual/servora-med-user-manual.md server/tests web/tests
git commit -m "docs: record approval withdrawal lifecycle"
```

- [ ] **Step 6: Push and open, but do not merge, the PR**

Push `fix/meeting-lifecycle-and-approval-withdrawal`, open a draft PR with exact verification evidence, wait for server/web CI, and report CI URL/status. Do not merge.
