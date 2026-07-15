# Slice 10 Structured Sales Meeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate `SALES_MEETING` as a structured two-stage JobCard workflow with exact
planning/result contracts, shared approval guarantees, safe activity, type-aware web UI,
and approved Staff outcome reporting.

**Architecture:** Keep one JobCards module, one lifecycle engine, and one JobCard version
as concurrency truth. Add migration 007 and a one-to-one meeting-details subresource;
extend exhaustive type policies, workspace projections, the existing Staff report read
model, and React's explicit three-variant detail shell without a generic details system.

**Tech Stack:** Node.js, Fastify, TypeScript, PostgreSQL, React, React Router, Vite,
Vitest, Playwright MCP.

## Global Constraints

- The approved SSOT is
  `docs/superpowers/specs/2026-07-15-sales-meeting-design.md` at commit
  `e1efaa7e32721ac81673be7a1f08e74976ce5256`.
- Do not reopen or alter approved product decisions during implementation.
- `dueDate` is the required organization-local planned day; `meetingAt` is the actual
  instant. Do not add `scheduledAt`.
- Canonical outcomes, in order, are `POSITIVE`, `FOLLOW_UP_REQUIRED`, `NO_DECISION`, and
  `NOT_INTERESTED`.
- `FOLLOW_UP_REQUIRED` recommends but never requires `nextFollowUpAt`.
- Submit validation order is Customer, assignee, then meeting readiness.
- Draft details may be null. Submit requires actual time, outcome, and normalized summary;
  `meetingAt` may be at most request time plus 15 minutes.
- Add exactly `007_sales_meeting.sql`; migrations 001–006 are immutable.
- Use `job_cards.version`; add no detail version.
- Meeting PATCH is target-scoped idempotent and appends one safe
  `MEETING_DETAILS_UPDATED` event containing changed-field names only.
- `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED` reuse `409 JOB_NOT_EDITABLE`.
- Staff report ownership is `job_cards.assigned_to`; range uses actual `meetingAt`; only
  `COMPLETED SALES_MEETING` rows contribute to `meetingsByOutcome`.
- All-type operational counters include Sales Meeting. Delivery quantities remain
  Product Delivery-only and exact three-decimal strings.
- Keep WCAG 2.2 AA, keyboard operation, 44×44 CSS px targets, 200% text enlargement,
  400% reflow, visible focus, and reduced-motion behavior.
- Add no runtime dependency, trigger, generic form builder, JSON details model, scheduler,
  notification, calendar integration, financial/inventory behavior, report table, cache,
  view, materialized view, ranking, score, or meeting dashboard.
- Every implementation task follows RED → minimal GREEN → focused regression → commit.

---

## Starting State

- Branch: `feature/slice-10-sales-meeting`.
- Approved design commit: `e1efaa7e32721ac81673be7a1f08e74976ce5256`.
- `origin/main` at planning start: `7f3450ef0c7ad07b26871aede523d6afcc78621c`.
- Branch is zero commits behind and one design commit ahead before this planning commit.
- No migration, test, or application code has been changed for Slice 10.

## File Map

### Server production

- Create `server/src/db/migrations/007_sales_meeting.sql` — exact type/event constraints,
  one-to-one details table, checks, composite FK, and partial report index.
- Create `server/src/modules/job-cards/meeting-details-input.ts` — exact GET/PATCH path and
  body parsing, strict instant parsing, Unicode summary normalization, and candidate
  validation helpers.
- Modify `server/src/modules/job-cards/types.ts` — third JobCard type, outcomes, meeting DTO,
  activity detail, create variant, and repository inputs.
- Modify `server/src/modules/job-cards/create-input.ts` — per-type allowlists and exact
  Sales Meeting create normalization.
- Modify `server/src/modules/job-cards/policy.ts` — Sales Meeting type guard; reuse shared
  edit and assignment policy.
- Modify `server/src/modules/job-cards/repository.ts` — create/read/lock/update meeting
  details and transaction-scoped version/activity behavior.
- Modify `server/src/modules/job-cards/service.ts` — atomic create, GET/PATCH subresource,
  concealment, type guard, idempotency, no-op, and version behavior.
- Modify `server/src/modules/job-cards/submission-policy.ts` — exhaustive third readiness
  policy and deterministic Customer → assignee → details order.
- Modify `server/src/modules/job-cards/handlers.ts` and `routes.ts` — exact meeting GET/PATCH
  HTTP boundary.
- Modify `server/src/modules/job-cards/activity-presenter.ts` — safe meeting activity.
- Modify `server/src/modules/job-cards/workspace-query.ts` — third type filter.
- Modify `server/src/modules/reports/types.ts`, `ports.ts`, `repository.ts`, and `service.ts`
  — exact four-row Staff outcome read model.

### Server tests

- Create `server/tests/sales-meeting-schema.test.ts`.
- Create `server/tests/sales-meeting-input.test.ts`.
- Create `server/tests/sales-meeting-service.test.ts`.
- Create `server/tests/sales-meeting-postgres.test.ts`.
- Create `server/tests/reports-meetings.test.ts`.
- Modify `server/tests/job-card-create-input.test.ts`.
- Modify `server/tests/job-card-policy.test.ts`.
- Modify `server/tests/job-card-crud-service.test.ts`.
- Modify `server/tests/job-card-routes.test.ts`.
- Modify `server/tests/job-card-lifecycle-service.test.ts`.
- Modify `server/tests/job-card-activity.test.ts`.
- Modify `server/tests/job-card-workspace-query.test.ts`.
- Modify `server/tests/job-card-workspace-repository.test.ts`.
- Modify `server/tests/job-card-board.test.ts`.
- Modify `server/tests/job-card-workspace-postgres.test.ts`.
- Modify `server/tests/reports-dashboard.test.ts`, `reports-staff-summary.test.ts`,
  `reports-deliveries.test.ts`, `reports-approvals.test.ts`, `reports-routes.test.ts`, and
  `reports-service.test.ts`.

### Web production

- Create `web/src/SalesMeetingCreate.tsx` — separate planning form and reference loading.
- Create `web/src/jobs/MeetingDetails.tsx` — focused editable/read-only result component.
- Modify `web/src/paths.ts` and `AppRouter.tsx` — stable `/jobs/new-meeting` route.
- Modify `web/src/jobs/jobs-api.ts` — exact third type/create variant, MeetingDetails API,
  activity parser, and strict response parsing.
- Modify `web/src/jobs/job-search.ts`, `JobFilters.tsx`, and `job-labels.ts` — URL-owned
  third type and exhaustive labels.
- Modify `web/src/JobDetail.tsx` — explicit loaded-detail union, bounded version reload,
  common mutation mutex, and type-aware result/review shell.
- Modify `web/src/jobs/JobWorkspace.tsx`, `JobRow.tsx`, and `JobBoard.tsx` — create action
  and type presentation without delivery leakage.
- Modify `web/src/jobs/JobTimeline.tsx` — safe meeting event presentation.
- Modify `web/src/reports/report-types.ts`, `reports-api.ts`, and
  `StaffOperationalReport.tsx` — exact four-row outcome summary.
- Modify `web/src/styles.css` — scoped responsive, focus, helper, and read-only styles.

### Web tests

- Create `web/tests/sales-meeting-create.test.tsx`.
- Create `web/tests/meeting-details.test.tsx`.
- Modify `web/tests/jobs-api.test.ts`, `job-search.test.ts`, `router.test.tsx`,
  `job-detail.test.tsx`, `manager-review.test.tsx`, `job-list.test.tsx`,
  `job-board.test.tsx`, `workspace-view.test.tsx`, `job-timeline.test.tsx`,
  `reports-api.test.ts`, `staff-operational-report.test.tsx`,
  `reports-accessibility.test.tsx`, and `accessibility-contract.test.ts`.

### Closeout documentation

- Modify `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`,
  `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`,
  `SERVORA_MED_MVP_SLICES.md`, `DECISIONS.md`, and `README.md` only after verified code.
- Modify this plan and the design status during verified closeout.
- Refresh `server/.codebase-memory/` and `web/.codebase-memory/` after verification.

---

### Task 1: Canonical Types and Exact Parsers

**Files:**
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/create-input.ts`
- Create: `server/src/modules/job-cards/meeting-details-input.ts`
- Modify: `server/src/modules/job-cards/submission-policy.ts`
- Modify: `server/tests/job-card-create-input.test.ts`
- Create: `server/tests/sales-meeting-input.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**
- Produces: `MeetingOutcome`, `MEETING_OUTCOMES`, `MeetingDetails`,
  `PatchMeetingDetailsInput`, `parseMeetingDetailsPatch`, `parseMeetingJobCardId`, and the
  exact third `SalesMeetingCreateInput` discriminant. The exhaustive submission registry
  temporarily fails closed with `MEETING_NOT_READY` until Task 5 adds persisted readiness.
- Consumes: existing `boundedTrimmedString`, code-point helpers, UUID/date validation,
  priority defaults, and `AppError` conventions.

- [x] **Step 1: Write failing parser and type-contract tests**

Add table-driven tests that accept the exact Sales Meeting create shape and reject result
fields, unknown fields, malformed body UUIDs, impossible calendar dates, accepted past
dates, naive instants, unknown outcomes, over-4,000-code-point summaries, and PATCH without a
detail field. Assert malformed `:jobCardId` maps to `JOB_CARD_NOT_FOUND` without a
repository call. Add a lifecycle test proving the newly exhaustive Sales Meeting policy
fails closed without transition or activity. Replace the obsolete route expectation that
treated `type=SALES_MEETING` as invalid with canonical parsed-query coverage.

```ts
expect(parseJobCardCreateInput({
  clientActionId: 'meeting-create-1', type: 'SALES_MEETING', title: 'Kontrol görüşmesi',
  customerId, assignedTo: staffId, dueDate: '2026-07-15',
})).toMatchObject({ type: 'SALES_MEETING', priority: 'normal', contactId: null });

let thrown: unknown;
try {
  parseMeetingDetailsPatch({
    clientActionId: 'save-1', expectedVersion: 2,
    meetingAt: '2026-07-15T13:00:00',
  });
} catch (error) { thrown = error; }
expect(thrown).toMatchObject({ code: 'VALIDATION_ERROR' });
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd server && npm test -- --run tests/job-card-create-input.test.ts tests/sales-meeting-input.test.ts
```

Expected: FAIL because the third discriminant and meeting parser are absent.

- [x] **Step 3: Add minimal exact types and parsers**

Implement the canonical constants and public shapes exactly:

```ts
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const;
export const MEETING_OUTCOMES = [
  'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

export type MeetingDetails = {
  jobCardId: string;
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
  meetingSummary: string | null;
  nextFollowUpAt: string | null;
  jobCardVersion: number;
};
```

Use separate create allowlists per discriminant. Require offset or `Z` for instants,
canonicalize with `toISOString()`, normalize empty summary to null, and require at least
one of the four mutable fields. Add the third registry entry as a tested fail-closed
`MEETING_NOT_READY` policy; Task 5 replaces it with exact persisted readiness checks.

- [x] **Step 4: Run focused tests and server build**

Run:

```bash
cd server && npm test -- --run tests/job-card-create-input.test.ts \
  tests/sales-meeting-input.test.ts tests/job-card-lifecycle-service.test.ts \
  tests/job-card-routes.test.ts
cd server && npm run build
```

Expected: focused parser/lifecycle/route files and build PASS; Product Delivery and
General Task parser cases remain unchanged.

- [x] **Step 5: Commit Task 1**

```bash
git add server/src/modules/job-cards/types.ts \
  server/src/modules/job-cards/create-input.ts \
  server/src/modules/job-cards/meeting-details-input.ts \
  server/src/modules/job-cards/submission-policy.ts \
  server/tests/job-card-create-input.test.ts server/tests/sales-meeting-input.test.ts \
  server/tests/job-card-lifecycle-service.test.ts server/tests/job-card-routes.test.ts \
  docs/superpowers/plans/2026-07-15-sales-meeting.md
git commit -m "feat: add sales meeting contracts"
```

### Task 2: Migration 007 and Persisted Invariants

**Files:**
- Create: `server/src/db/migrations/007_sales_meeting.sql`
- Create: `server/tests/sales-meeting-schema.test.ts`
- Modify: `server/tests/migrate-runner.test.ts`

**Interfaces:**
- Produces: exact three-type check, exact 15-event check,
  `job_card_meeting_details`, composite FK, summary/outcome/chronology checks, and
  `meeting_details_org_time_job_idx`.
- Consumes: existing migration runner transaction and `schema_migrations` behavior.

- [x] **Step 1: Write failing clean-install and upgrade tests**

Test clean 001→007 and applied 001→006→007 paths. Query PostgreSQL constraints and assert
set equality, not substring presence:

```ts
expect(new Set(jobTypes)).toEqual(new Set([
  'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING',
]));
expect(activityEvents).toHaveLength(15);
expect(new Set(activityEvents)).toEqual(new Set(EXPECTED_ACTIVITY_EVENTS));
```

Insert null draft data, valid visible summary, space/tab/newline-only summaries, 4,001
code points, invalid outcome, cross-organization FK, and invalid follow-up chronology.
Assert failed migration leaves neither table nor migration row.

- [x] **Step 2: Run migration tests and verify RED**

Run:

```bash
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/migrate-runner.test.ts tests/sales-meeting-schema.test.ts
```

Expected: FAIL because migration 007 and its exact constraints do not exist. If
`TEST_DATABASE_URL` is absent, stop this task and provide a disposable PostgreSQL URL;
do not count skipped tests as verification.

- [x] **Step 3: Implement migration 007**

Use one transactional migration with these essential definitions:

```sql
CREATE TABLE job_card_meeting_details (
  job_card_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  meeting_at TIMESTAMPTZ,
  outcome VARCHAR(40) CHECK (outcome IS NULL OR outcome IN (
    'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED'
  )),
  meeting_summary TEXT CHECK (
    meeting_summary IS NULL OR (
      char_length(meeting_summary) BETWEEN 1 AND 4000
      AND meeting_summary ~ '[^[:space:]]'
    )
  ),
  next_follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  CHECK (next_follow_up_at IS NULL OR (
    meeting_at IS NOT NULL AND next_follow_up_at > meeting_at
  ))
);
```

Replace named checks with exact value sets and add the approved partial index. Do not add
a child composite unique constraint or trigger.

- [x] **Step 4: Verify both migration paths and immutable history**

Run:

```bash
git diff --exit-code HEAD -- server/src/db/migrations/001_auth_foundation.sql \
  server/src/db/migrations/002_delivery_tracer.sql server/src/db/migrations/003_people.sql \
  server/src/db/migrations/004_crm_contacts.sql server/src/db/migrations/005_product_catalog.sql \
  server/src/db/migrations/006_jobcard_workspace.sql
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/migrate-runner.test.ts tests/sales-meeting-schema.test.ts
cd server && npm run build
```

Expected: migrations 001–006 unchanged; clean, upgrade, rollback, and no-reapply cases
PASS; build copies 007 into `dist`.

- [x] **Step 5: Commit Task 2**

```bash
git add server/src/db/migrations/007_sales_meeting.sql \
  server/tests/sales-meeting-schema.test.ts server/tests/migrate-runner.test.ts
git commit -m "feat: add sales meeting schema"
```

### Task 3: Atomic Sales Meeting Creation

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/tests/job-card-crud-service.test.ts`
- Create: `server/tests/sales-meeting-service.test.ts`

**Interfaces:**
- Produces: transaction method `createMeetingDetails`, atomic Sales Meeting create, empty
  detail invariant, canonical JobCard response, and unchanged `JOB_CREATE` replay.
- Consumes: Task 1 normalized create union and existing assignment/relation/idempotency
  policy.

- [x] **Step 1: Write failing create transaction tests**

Cover Staff self-assignment, pre-lookup mismatch, management assignment, required active
Customer, optional active Contact, required due date, lock order, exactly one empty detail,
exactly one `JOB_CREATED`, no meeting-update event, replay, and rollback.

```ts
const result = await service.create(staffActor, salesMeetingInput);
expect(result.type).toBe('SALES_MEETING');
expect(repository.meetingDetailsFor(result.id)).toEqual({
  meetingAt: null, outcome: null, meetingSummary: null, nextFollowUpAt: null,
});
expect(repository.eventsFor(result.id)).toEqual(['JOB_CREATED']);
```

- [x] **Step 2: Run create tests and verify RED**

```bash
cd server && npm test -- --run \
  tests/job-card-crud-service.test.ts tests/sales-meeting-service.test.ts
```

Expected: FAIL because create does not persist the required detail row.

- [x] **Step 3: Implement minimal atomic create**

Extend the transaction port and PostgreSQL transaction:

```ts
createMeetingDetails(input: {
  organizationId: string;
  jobCardId: string;
}): Promise<void>;
```

In the existing critical `JOB_CREATE` work, preserve lock order
`users -> customers -> contacts -> job_cards -> meeting_details`, create the empty detail
only for `SALES_MEETING`, append only `JOB_CREATED`, then return canonical detail.

- [x] **Step 4: Run focused and Product Delivery regressions**

```bash
cd server && npm test -- --run tests/job-card-create-input.test.ts \
  tests/job-card-crud-service.test.ts tests/job-card-routes.test.ts \
  tests/sales-meeting-service.test.ts
cd server && npm run build
```

Expected: Sales Meeting create/replay/rollback PASS and existing two create variants PASS.

- [x] **Step 5: Commit Task 3**

```bash
git add server/src/modules/job-cards/repository.ts \
  server/src/modules/job-cards/service.ts server/tests/job-card-crud-service.test.ts \
  server/tests/sales-meeting-service.test.ts
git commit -m "feat: create structured sales meetings"
```

### Task 4: Meeting Details GET/PATCH Transaction

**Files:**
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Modify: `server/src/modules/job-cards/activity-presenter.ts`
- Modify: `server/tests/job-card-policy.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`
- Modify: `server/tests/job-card-activity.test.ts`
- Modify: `server/tests/sales-meeting-service.test.ts`

**Interfaces:**
- Produces: `assertSalesMeetingJob`, `getMeetingDetails`, `patchMeetingDetails`, exact
  route handlers, `MEETING_DETAILS_UPDATE:<jobCardId>` critical action, and
  `MeetingDetails` response with parent version, exact 15-event vocabulary, and safe
  `MEETING_DETAILS` activity projection.
- Consumes: Task 1 parser, Task 2 table, Task 3 detail invariant, existing
  `assertCanEdit`, concealment, `bumpVersion`, and critical-action repository.

- [x] **Step 1: Write failing route/service tests**

Cover GET scope/type/missing invariant, PATCH malformed path/body distinction, parent
concealment before type guard, wrong type, all editable and immutable statuses, Staff
ownership, merged chronology, no-op, version conflict, action replay/in-progress, one
version bump, full rollback, canonical changed-field ordering, and absence of old/new
meeting values in public activity. Assert the canonical TypeScript activity vocabulary
has exactly 15 unique values with no missing or unexpected event.

```ts
expect(await service.patchMeetingDetails(actor, jobId, {
  clientActionId: 'meeting-save-1', expectedVersion: 2,
  outcome: 'FOLLOW_UP_REQUIRED', meetingSummary: 'Kontrol ziyareti yapıldı.',
})).toMatchObject({ outcome: 'FOLLOW_UP_REQUIRED', jobCardVersion: 3 });
```

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts \
  tests/job-card-routes.test.ts tests/job-card-activity.test.ts \
  tests/sales-meeting-service.test.ts
```

Expected: FAIL because the guard, repository operations, service methods, and routes are
absent.

- [x] **Step 3: Implement minimal GET/PATCH flow**

Register:

```ts
app.get<{ Params: { id: string } }>('/:id/meeting-details', secured, h.meetingDetails);
app.patch<{ Params: { id: string } }>('/:id/meeting-details', secured, h.patchMeetingDetails);
```

PATCH order must be parent `FOR UPDATE` → type guard → expected version → existing
`assertCanEdit` → detail row lock → merged candidate/no-op → detail update → one parent
version bump → activity append → processed-action completion. GET performs no lock,
version mutation, or idempotency claim.

Add `MEETING_DETAILS_UPDATED` to the canonical TypeScript event vocabulary in the same
task that first emits it. Present only:

```ts
{ kind: 'MEETING_DETAILS', changedFields: [
  'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
] }
```

filtered to fields actually changed and kept in canonical order. Never expose values.

- [x] **Step 4: Run service, route, concurrency, and build verification**

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts \
  tests/job-card-routes.test.ts tests/job-card-crud-service.test.ts \
  tests/job-card-activity.test.ts tests/sales-meeting-input.test.ts \
  tests/sales-meeting-service.test.ts
cd server && npm run build
```

Expected: all focused tests PASS; exact existing `JOB_NOT_EDITABLE`, `VERSION_CONFLICT`,
`INVALID_JOB_TYPE`, `ACTION_IN_PROGRESS`, and concealment behavior is preserved.

- [x] **Step 5: Commit Task 4**

```bash
git add server/src/modules/job-cards/{types.ts,policy.ts,repository.ts,service.ts,handlers.ts,routes.ts,activity-presenter.ts} \
  server/tests/job-card-policy.test.ts server/tests/job-card-routes.test.ts \
  server/tests/job-card-activity.test.ts server/tests/sales-meeting-service.test.ts
git commit -m "feat: add sales meeting details API"
```

### Task 5: Exhaustive Submission Policy and Lifecycle Readiness

**Files:**
- Modify: `server/src/modules/job-cards/submission-policy.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify: `server/tests/sales-meeting-service.test.ts`

**Interfaces:**
- Produces: exhaustive `Record<JobCardType, SubmissionPolicy>` with
  `validateSalesMeetingSubmission`, one captured `requestTime`, deterministic error
  priority, `getSubmissionCustomer`, and `MEETING_NOT_READY` safe field errors.
- Consumes: Task 4 locked detail read, existing Customer and assignee reads, shared
  lifecycle transition transaction, and exact outcomes.

- [x] **Step 1: Write failing readiness and priority tests**

Cover Customer missing/cross-org/inactive before assignee; assignee invalid before
details; each required detail; four outcomes; exact +15-minute boundary and one
millisecond later; past actual time; optional follow-up; invalid chronology; revision
edit/resubmit; and immutable review/terminal states.

```ts
const service = new JobCardService(repository, () => requestTime);
await expect(service.submitForApproval(actor, jobId, commandInput))
  .rejects.toMatchObject({ code: 'MEETING_NOT_READY', details: {
    fieldErrors: { meetingSummary: expect.any(String) },
  } });
```

- [x] **Step 2: Run lifecycle tests and verify RED**

```bash
cd server && npm test -- --run \
  tests/job-card-lifecycle-service.test.ts tests/sales-meeting-service.test.ts
```

Expected: FAIL because `SALES_MEETING` has no exhaustive submission policy.

- [x] **Step 3: Implement the third policy**

Add a transaction read returning the canonical detail and implement:

```ts
getSubmissionCustomer(
  organizationId: string,
  customerId: string,
): Promise<{ id: string; organizationId: string; status: 'prospect' | 'active' | 'inactive' } | null>;

const submissionPolicies: Record<JobCardType, SubmissionPolicy> = {
  PRODUCT_DELIVERY: validateProductDeliverySubmission,
  GENERAL_TASK: validateGeneralTaskSubmission,
  SALES_MEETING: validateSalesMeetingSubmission,
};
```

Capture service `requestTime` once at operation entry. Validate Customer, then shared
assignee eligibility, then detail readiness. Return only approved field-error keys and no
persisted values.

- [x] **Step 4: Run all lifecycle and delivery regressions**

```bash
cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts \
  tests/sales-meeting-service.test.ts tests/delivery-item-service.test.ts \
  tests/job-card-crud-service.test.ts
cd server && npm run build
```

Expected: all three policies PASS; Product Delivery and General Task semantics unchanged.

- [x] **Step 5: Commit Task 5**

```bash
git add server/src/modules/job-cards/submission-policy.ts \
  server/src/modules/job-cards/repository.ts \
  server/tests/job-card-lifecycle-service.test.ts server/tests/sales-meeting-service.test.ts
git commit -m "feat: validate sales meeting submission"
```

### Task 6: Server Workspace, Board, and All-Type Regressions

**Files:**
- Modify: `server/src/modules/job-cards/workspace-query.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/tests/job-card-workspace-query.test.ts`
- Modify: `server/tests/job-card-workspace-repository.test.ts`
- Modify: `server/tests/job-card-board.test.ts`
- Modify: `server/tests/job-card-workspace-postgres.test.ts`
- Modify: `server/tests/reports-dashboard.test.ts`
- Modify: `server/tests/reports-approvals.test.ts`
- Modify: `server/tests/reports-staff-summary.test.ts`

**Interfaces:**
- Produces: third exact list/board filter and all-type counter/approval participation.
- Consumes: canonical `JOB_CARD_TYPES`; preserves `deliveryItemCount` projection and
  existing Staff visibility/ordering.

- [x] **Step 1: Write failing third-type workspace tests**

Add parser, repository, board-column, role-scope, search, pagination, approval, dashboard,
and Staff-counter fixtures for `SALES_MEETING`. Assert list projection returns
`deliveryItemCount: 0` without joining meeting details.

```ts
expect(parseJobCardListQuery({ type: 'SALES_MEETING' }).type).toBe('SALES_MEETING');
expect(page.items.find((item) => item.id === meetingId)).toMatchObject({
  type: 'SALES_MEETING', deliveryItemCount: 0,
});
```

- [x] **Step 2: Run focused workspace/report tests and verify RED**

```bash
cd server && npm test -- --run tests/job-card-workspace-query.test.ts \
  tests/job-card-workspace-repository.test.ts tests/job-card-board.test.ts \
  tests/reports-dashboard.test.ts tests/reports-approvals.test.ts \
  tests/reports-staff-summary.test.ts
```

Expected: FAIL at third-type parsing/fixtures.

**Task 6 TDD note (2026-07-15):** the new third-type tests passed on their first run
because Task 1 had already extended the canonical `JOB_CARD_TYPES` set and the existing
workspace/report SQL was intentionally generic. No production change was required;
the PostgreSQL acceptance fixture below provides the new behavioral coverage.

- [x] **Step 3: Extend only canonical type-aware boundaries**

Use `JOB_CARD_TYPES` in exact query parsing and preserve existing SQL filters. Do not join
meeting details into list/board or special-case all-type counters.

- [x] **Step 4: Run ordinary and PostgreSQL workspace regressions**

```bash
cd server && npm test -- --run tests/job-card-workspace-query.test.ts \
  tests/job-card-workspace-repository.test.ts tests/job-card-board.test.ts \
  tests/reports-dashboard.test.ts tests/reports-approvals.test.ts \
  tests/reports-staff-summary.test.ts
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/job-card-workspace-postgres.test.ts
cd server && npm run build
```

Expected: all-type surfaces include Sales Meeting; visibility and ordering PASS.

- [x] **Step 5: Commit Task 6**

```bash
git add server/src/modules/job-cards/workspace-query.ts \
  server/src/modules/job-cards/repository.ts \
  server/tests/job-card-workspace-query.test.ts \
  server/tests/job-card-workspace-repository.test.ts server/tests/job-card-board.test.ts \
  server/tests/job-card-workspace-postgres.test.ts server/tests/reports-dashboard.test.ts \
  server/tests/reports-approvals.test.ts server/tests/reports-staff-summary.test.ts
git commit -m "feat: include sales meetings in operations"
```

### Task 7: Staff Meetings-by-Outcome Read Model

**Files:**
- Modify: `server/src/modules/reports/types.ts`
- Modify: `server/src/modules/reports/ports.ts`
- Modify: `server/src/modules/reports/repository.ts`
- Modify: `server/src/modules/reports/service.ts`
- Create: `server/tests/reports-meetings.test.ts`
- Modify: `server/tests/reports-postgres.test.ts`
- Modify: `server/tests/reports-service.test.ts`
- Modify: `server/tests/reports-routes.test.ts`

**Interfaces:**
- Produces: `MeetingOutcomeItem`,
  `ReportsReadModel.getStaffMeetingsByOutcome(input)`, and exact
  `StaffReportResponse.meetingsByOutcome`.
- Consumes: existing `StaffOperationalSummaryOneInput`, resolved organization-local range,
  Staff identity errors, and Task 2 persisted details.

- [x] **Step 1: Write failing exact report tests**

Assert exactly four rows in canonical order, zero fill, non-negative integer counts,
`COMPLETED` only, `assigned_to` attribution, actual `meeting_at`, half-open local range,
DST boundary, inactive historical Staff, and organization isolation. Assert Product
Delivery decimal strings and General Task behavior remain unchanged.

```ts
expect(report.meetingsByOutcome).toEqual([
  { outcome: 'POSITIVE', count: 0 },
  { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
  { outcome: 'NO_DECISION', count: 0 },
  { outcome: 'NOT_INTERESTED', count: 0 },
]);
```

- [x] **Step 2: Run report tests and verify RED**

```bash
cd server && npm test -- --run tests/reports-meetings.test.ts \
  tests/reports-service.test.ts tests/reports-routes.test.ts \
  tests/reports-deliveries.test.ts
```

Expected: FAIL because the port and response field are absent.

- [x] **Step 3: Implement the minimal read-model extension**

Add:

```ts
getStaffMeetingsByOutcome(
  input: StaffOperationalSummaryOneInput,
): Promise<MeetingOutcomeItem[]>;
```

Use a canonical SQL `VALUES` set left-joined to a grouped aggregate filtered by
organization, `SALES_MEETING`, `COMPLETED`, `assigned_to`, and actual-time range. Extend
the existing `Promise.all` in `ReportsService.staffReport`; add no route or service.

- [x] **Step 4: Run full focused reports with PostgreSQL**

```bash
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/reports-meetings.test.ts tests/reports-postgres.test.ts \
  tests/reports-deliveries.test.ts tests/reports-dashboard.test.ts \
  tests/reports-approvals.test.ts tests/reports-staff-summary.test.ts \
  tests/reports-service.test.ts tests/reports-routes.test.ts
cd server && npm run build
```

Expected: outcome query and every report regression PASS.

- [x] **Step 5: Commit Task 7**

```bash
git add server/src/modules/reports/{types.ts,ports.ts,repository.ts,service.ts} \
  server/tests/reports-meetings.test.ts server/tests/reports-service.test.ts \
  server/tests/reports-routes.test.ts server/tests/reports-postgres.test.ts
git commit -m "feat: report staff meeting outcomes"
```

Execution note: the shared PostgreSQL report fixture now applies migrations 001–007 so
the full report suite exercises the canonical Sales Meeting schema. Product Delivery
decimal-string and General Task behavior remained covered by the existing focused
regression suites without source changes.

### Task 8: Web Exact Contracts and URL-Owned Third Type

**Files:**
- Modify: `web/src/jobs/jobs-api.ts`
- Modify: `web/src/jobs/job-search.ts`
- Modify: `web/src/jobs/JobFilters.tsx`
- Modify: `web/src/jobs/job-labels.ts`
- Modify: `web/src/reports/report-types.ts`
- Modify: `web/src/reports/reports-api.ts`
- Modify: `web/src/reports/ApprovalReport.tsx`
- Modify: `web/tests/jobs-api.test.ts`
- Modify: `web/tests/job-search.test.ts`
- Modify: `web/tests/reports-api.test.ts`

**Interfaces:**
- Produces: web `MeetingOutcome`, `MeetingDetails`, exact create union,
  `getMeetingDetails`, `patchMeetingDetails`, safe meeting activity parser, exact Staff
  report parser, and URL-owned `SALES_MEETING` filter.
- Consumes: server public contracts from Tasks 1, 4, 6, and 7.

- [x] **Step 1: Write failing exact web parser tests**

Cover all three types, create payload compile fixtures, MeetingDetails exact keys and
instants, activity changed-field allowlist/order, report exact four-row cardinality/order,
unknown/duplicate outcomes, invalid counts, URL deep links, repeated/invalid type
canonicalization, and offset reset on type changes.

```ts
expect(parseStaffReport(payload).meetingsByOutcome.map((item) => item.outcome)).toEqual([
  'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
]);
```

- [x] **Step 2: Run web contract tests and verify RED**

```bash
cd web && npm test -- --run tests/jobs-api.test.ts \
  tests/job-search.test.ts tests/reports-api.test.ts
```

Expected: FAIL because current parsers accept only two types and no meeting/report DTO.

- [x] **Step 3: Implement exact web types, API calls, and parsers**

Add explicit API functions:

```ts
export const getMeetingDetails = async (id: string) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`));
export const patchMeetingDetails = async (id: string, input: PatchMeetingDetailsInput) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details`, json('PATCH', input)));
```

Use exhaustive constants and exact objects; do not derive business validation in React.

- [x] **Step 4: Run web contract suite and build**

```bash
cd web && npm test -- --run tests/jobs-api.test.ts \
  tests/job-search.test.ts tests/reports-api.test.ts
cd web && npm run build
```

Expected: exact parsers, URL ownership, and build PASS.

- [x] **Step 5: Commit Task 8**

```bash
git add web/src/jobs/{jobs-api.ts,job-search.ts,JobFilters.tsx,job-labels.ts} \
  web/src/reports/{report-types.ts,reports-api.ts} \
  web/src/reports/ApprovalReport.tsx \
  web/tests/jobs-api.test.ts web/tests/job-search.test.ts web/tests/reports-api.test.ts
git commit -m "feat: add sales meeting web contracts"
```

### Task 9: `/jobs/new-meeting` Planning Form

**Files:**
- Create: `web/src/SalesMeetingCreate.tsx`
- Modify: `web/src/paths.ts`
- Modify: `web/src/AppRouter.tsx`
- Create: `web/tests/sales-meeting-create.test.tsx`
- Modify: `web/tests/router.test.tsx`

**Interfaces:**
- Produces: stable `/jobs/new-meeting`, `SalesMeetingCreateScreen`, exact Sales Meeting
  create request, logical action-ID retry, and role-aware reference loading.
- Consumes: Task 8 `createJobCard`, current CRM/People APIs, request-generation gate,
  `CurrentUser`, and existing route/notice conventions.

- [x] **Step 1: Write failing planning-flow tests**

Cover Staff fixed self-assignee/no Staff request; Manager/Admin active Staff load; required
Customer and due date; optional Contact/description/priority; Customer load blocking;
Contact load non-blocking retry; Customer-change clearing; stale Contact suppression; past
due-date acceptance; exact payload; pending double-submit; and action-ID reuse after an
ambiguous network error.

```tsx
expect(createJobCard).toHaveBeenCalledWith({
  clientActionId: expect.any(String), type: 'SALES_MEETING',
  title: 'İmplant değerlendirme görüşmesi', customerId, assignedTo: staffId,
  dueDate: '2026-07-15', description: null, contactId: null, priority: 'normal',
});
```

- [x] **Step 2: Run create/router tests and verify RED**

```bash
cd web && npm test -- --run \
  tests/sales-meeting-create.test.tsx tests/router.test.tsx
```

Expected: FAIL because route and screen are absent.

- [x] **Step 3: Implement the focused planning screen**

Add `paths.newMeeting = '/jobs/new-meeting'`, explicit route wiring, and a standalone
form. Keep result fields out. Use required semantic labels and adjacent retry controls.
Preserve one UUID per logical create until definitive completion.

- [x] **Step 4: Run form, route, accessibility, and build checks**

```bash
cd web && npm test -- --run tests/sales-meeting-create.test.tsx \
  tests/router.test.tsx tests/accessibility-contract.test.ts
cd web && npm run build
```

Expected: role/reference/retry behavior, direct route, and build PASS.

- [x] **Step 5: Commit Task 9**

```bash
git add web/src/SalesMeetingCreate.tsx web/src/paths.ts web/src/AppRouter.tsx \
  web/tests/sales-meeting-create.test.tsx web/tests/router.test.tsx
git commit -m "feat: add sales meeting planning flow"
```

Execution note: the planning screen reuses the existing responsive task-form primitives;
no new CSS rule was necessary.

### Task 10: Type-Aware Detail Shell and Meeting Result Form

**Files:**
- Create: `web/src/jobs/MeetingDetails.tsx`
- Modify: `web/src/JobDetail.tsx`
- Create: `web/tests/meeting-details.test.tsx`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`

**Interfaces:**
- Produces: explicit `LoadedJobDetail` three-variant union, exact type-specific loading,
  one bounded version reload, `MeetingDetailsSection`, result edit/read-only UI, and
  JobDetail mutation mutex.
- Consumes: Task 8 meeting API, current lifecycle functions, Task 9 navigation, existing
  focus feedback, notes, and timeline.

- [x] **Step 1: Write failing detail-state and interaction tests**

Assert exactly one type-specific request, invalid variant impossibility through fixtures,
JobCard/detail version match, one retry then error, editable/immutable states, role scope,
UTC↔device-local conversion with visible offset, strict payload, logical save-ID replay,
single state update, timeline refresh, workspace notification, conflict reload, and no
parallel save/lifecycle mutation.

```ts
expect(loads).toEqual(['GET job', 'GET meeting-details']);
expect(screen.getByText('Saat dilimi: GMT+03:00')).toBeVisible();
expect(submitButton).toBeDisabledDuring('savingMeeting');
```

- [x] **Step 2: Run detail tests and verify RED**

```bash
cd web && npm test -- --run tests/meeting-details.test.tsx \
  tests/job-detail.test.tsx tests/manager-review.test.tsx
```

Expected: FAIL because detail state still uses `job + items` and has no meeting form.

- [x] **Step 3: Implement explicit union and result component**

Define:

```ts
type LoadedJobDetail =
  | {
      kind: 'PRODUCT_DELIVERY';
      job: JobCard & { type: 'PRODUCT_DELIVERY' };
      deliveryItems: DeliveryItem[];
    }
  | { kind: 'GENERAL_TASK'; job: JobCard & { type: 'GENERAL_TASK' } }
  | {
      kind: 'SALES_MEETING';
      job: JobCard & { type: 'SALES_MEETING' };
      meetingDetails: MeetingDetails;
    };
```

`MeetingDetailsSection` renders native controls while editable and semantic `<dl>` while locked.
Use one mutex for `savingMeeting` versus `runningLifecycle`; notes keep independent state.
After PATCH, update job version and normalized detail atomically.

- [x] **Step 4: Add explicit follow-up and accessibility behavior**

When outcome is `FOLLOW_UP_REQUIRED`, show prominent helper text linked to the follow-up
control. Do not set `required`, `aria-required`, or a visual required marker. Confirm save
and submit remain enabled without follow-up. Focus error summary, success status, and
conflict-refresh status according to the design.

- [x] **Step 5: Run focused detail, lifecycle, and accessibility tests**

```bash
cd web && npm test -- --run tests/meeting-details.test.tsx \
  tests/job-detail.test.tsx tests/manager-review.test.tsx \
  tests/accessibility-contract.test.ts
cd web && npm run build
```

Expected: all three detail variants, bounded concurrency, optional follow-up, focus, and
build PASS.

- [x] **Step 6: Commit Task 10**

```bash
git add web/src/jobs/MeetingDetails.tsx web/src/JobDetail.tsx web/src/styles.css \
  web/tests/meeting-details.test.tsx web/tests/job-detail.test.tsx \
  web/tests/manager-review.test.tsx
git commit -m "feat: add sales meeting result flow"
```

### Task 11: Workspace, Timeline, and Staff Report Presentation

**Files:**
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/jobs/JobRow.tsx`
- Modify: `web/src/jobs/JobBoard.tsx`
- Modify: `web/src/jobs/JobTimeline.tsx`
- Modify: `web/src/reports/StaffOperationalReport.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/workspace-view.test.tsx`
- Modify: `web/tests/job-list.test.tsx`
- Modify: `web/tests/job-board.test.tsx`
- Modify: `web/tests/job-timeline.test.tsx`
- Modify: `web/tests/staff-operational-report.test.tsx`
- Modify: `web/tests/reports-accessibility.test.tsx`

**Interfaces:**
- Produces: `Yeni görüşme` workspace action, exhaustive type labels, no delivery count on
  Sales Meeting, safe Turkish activity presentation, and four-row Staff outcome summary.
- Consumes: Task 8 exact parsers and Task 10 type-aware navigation/detail behavior.

- [x] **Step 1: Write failing presentation tests**

Cover list/board `Satış görüşmesi`, textual type cue, `Planlanan görüşme günü`, no delivery
fact, create navigation, safe changed-field activity, four visible outcome rows, all-zero
explanation with rows retained, and no chart/ranking/percentage.

```tsx
expect(screen.getByText('Satış görüşmesi')).toBeVisible();
expect(screen.queryByText(/ürün kalemi/)).not.toBeInTheDocument();
const outcomes = screen.getByRole('region', { name: 'Görüşme sonuçları' });
expect(within(outcomes).getAllByRole('row')).toHaveLength(5); // header + four outcomes
```

- [x] **Step 2: Run presentation tests and verify RED**

```bash
cd web && npm test -- --run tests/workspace-view.test.tsx tests/job-list.test.tsx \
  tests/job-board.test.tsx tests/job-timeline.test.tsx \
  tests/staff-operational-report.test.tsx tests/reports-accessibility.test.tsx
```

Expected: FAIL because workspace, timeline, and report components lack meeting output.

- [x] **Step 3: Implement minimal explicit presentation**

Add `onCreateMeeting` to `JobWorkspace`, exhaustive labels, type-aware due/review copy,
the `Görüşme sonucu güncellendi` safe timeline row, and a semantic outcome section with
`aria-labelledby` so its accessible name is `Görüşme sonuçları`. Keep all four outcome
rows visible at zero.

- [x] **Step 4: Run UI regressions and build**

```bash
cd web && npm test -- --run tests/workspace-view.test.tsx tests/job-list.test.tsx \
  tests/job-board.test.tsx tests/job-timeline.test.tsx \
  tests/staff-operational-report.test.tsx tests/reports-accessibility.test.tsx \
  tests/reports-dashboard.test.tsx tests/delivery-report.test.tsx
cd web && npm run build
```

Expected: type, activity, report, and delivery-report regressions PASS.

- [x] **Step 5: Commit Task 11**

```bash
git add web/src/jobs/{JobWorkspace.tsx,JobRow.tsx,JobBoard.tsx,JobTimeline.tsx} \
  web/src/reports/StaffOperationalReport.tsx \
  web/tests/workspace-view.test.tsx web/tests/job-list.test.tsx \
  web/tests/job-board.test.tsx web/tests/job-timeline.test.tsx \
  web/tests/staff-operational-report.test.tsx web/tests/reports-accessibility.test.tsx
git commit -m "feat: present sales meetings in workspace"
```

### Task 12: PostgreSQL, Browser, and Accessibility Acceptance

**Files:**
- Create: `server/tests/sales-meeting-postgres.test.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/tests/job-card-workspace-postgres.test.ts`
- Modify: `server/tests/reports-postgres.test.ts`
- Modify: `web/src/styles.css`
- Modify: `web/tests/accessibility-contract.test.ts`

**Interfaces:**
- Produces: live-database transaction/concurrency/report evidence and Playwright evidence;
  no Playwright dependency or config.
- Consumes: Tasks 1–11 complete vertical flow.

- [x] **Step 1: Write failing live PostgreSQL acceptance test**

Seed Staff, Manager, Customer, Contact, Product Delivery, General Task, and Sales Meeting.
Exercise create replay; empty detail invariant; concurrent detail PATCH; no-op/version;
safe activity; submit error priority; +15-minute boundary; revision; approval; Staff
visibility; all-type queues/counters; exact outcome report; and delivery exclusions.

- [x] **Step 2: Run the live acceptance tests**

```bash
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/sales-meeting-postgres.test.ts tests/job-card-workspace-postgres.test.ts \
  tests/reports-postgres.test.ts
```

Expected: PASS against a real disposable PostgreSQL database. A conditional skip is not
accepted as live verification.

- [x] **Step 3: Correct only integration gaps exposed by acceptance and rerun**

If Step 2 exposes a gap, first add the narrow failing assertion, correct only its source,
and rerun the same command. Use public services/routes and real constraints; do not
duplicate production SQL in test helpers. If Step 2 is already green, make no production
change in this step.

- [x] **Step 4: Run Playwright MCP browser acceptance**

Start the existing server/web development processes against disposable PostgreSQL. With
Playwright MCP, verify Staff plan → result save → submit → review lock; Manager approve;
Manager revision → Staff correction → resubmit; deep link/refresh/Back/Forward; mobile
390×844; desktop; keyboard-only focus; 44-pixel controls; 200% text; 400% reflow;
reduced motion; timezone helper; `FOLLOW_UP_REQUIRED` guidance without required semantics;
safe timeline; and Staff four-outcome report.

Expected: no uncaught console error, no horizontal overflow in required reflow viewport,
no inaccessible critical control, and backend truth preserved after refresh.

- [x] **Step 5: Run focused accessibility contracts**

```bash
cd web && npm test -- --run tests/accessibility-contract.test.ts \
  tests/meeting-details.test.tsx tests/sales-meeting-create.test.tsx \
  tests/reports-accessibility.test.tsx
```

Expected: semantic, focus, follow-up optionality, and responsive contracts PASS.

- [x] **Step 6: Commit Task 12**

```bash
git add server/tests/sales-meeting-postgres.test.ts \
  server/tests/job-card-workspace-postgres.test.ts server/tests/reports-postgres.test.ts \
  web/tests/accessibility-contract.test.ts
git commit -m "test: verify sales meeting acceptance"
```

### Task 13: Full Verification, SSOT Closeout, Memory, and Push

**Files:**
- Modify: `PRODUCT_REQUIREMENTS.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `DECISIONS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-15-sales-meeting-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-sales-meeting.md`
- Refresh: `server/.codebase-memory/`
- Refresh: `web/.codebase-memory/`

**Interfaces:**
- Produces: exact verification SHA/evidence, current SSOTs, durable Sales Meeting decision,
  updated Codebase Memory artifacts, clean branch, and local/remote parity.
- Consumes: every previous task and the approved closeout contract.

- [x] **Step 1: Run the complete server verification gate**

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
cd server && npm audit --omit=dev
```

Expected: build PASS; ordinary and PostgreSQL-enabled suites report zero failures;
production dependency audit reports zero vulnerabilities. Record exact pass/skip counts.

- [x] **Step 2: Run the complete web verification gate**

```bash
cd web && npm run build
cd web && npm test -- --run
cd web && npm audit --omit=dev
```

Expected: build and all tests PASS; production dependency audit reports zero
vulnerabilities. Preserve Task 12 Playwright evidence.

- [x] **Step 3: Capture the verified implementation SHA**

```bash
git diff --check
git status --short
git rev-parse HEAD
```

Expected: no unstaged/uncommitted implementation change before documentation editing.
Store this exact SHA and all verification totals for closeout docs.

- [x] **Step 4: Update SSOTs and durable decision**

Mark Sales Meeting implemented only now. Record in `DECISIONS.md` the two-stage model,
`dueDate` versus `meetingAt`, closed four-outcome vocabulary, and optional follow-up for
`FOLLOW_UP_REQUIRED`. Add exact API/schema/report contracts, Slice 10 acceptance checks,
README scope/totals, design status `Implemented and verified`, plan checkboxes, verified
implementation SHA, and the explicit note that full tests were not rerun for a later
docs-only closeout commit.

- [x] **Step 5: Verify and commit documentation closeout**

```bash
git diff --check
rg -n "SALES_MEETING|MEETING_DETAILS_UPDATED|meetingsByOutcome" \
  PRODUCT_REQUIREMENTS.md SERVORA_MED_ARCHITECTURE_PLAN.md \
  SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md \
  SERVORA_MED_MVP_SLICES.md DECISIONS.md README.md
git add PRODUCT_REQUIREMENTS.md SERVORA_MED_ARCHITECTURE_PLAN.md \
  SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md \
  DECISIONS.md README.md docs/superpowers/specs/2026-07-15-sales-meeting-design.md \
  docs/superpowers/plans/2026-07-15-sales-meeting.md
git commit -m "docs: close Slice 10 sales meetings"
```

Expected: docs align to the captured verified SHA; no implementation claim predates it.

- [x] **Step 6: Refresh Codebase Memory after verified closeout**

Use Codebase Memory MCP `index_repository` in `full` mode with persistence for:

```text
/Users/emrah/Documents/Servora-Med/server
/Users/emrah/Documents/Servora-Med/web
```

Verify index status and architecture counts, then commit only generated artifacts:

```bash
git add server/.codebase-memory web/.codebase-memory
git commit -m "chore: refresh Slice 10 codebase memory"
```

- [x] **Step 7: Recheck documentation-only and memory-only commits**

```bash
git diff --check HEAD~2 HEAD
git status --short
git log -3 --oneline
```

Expected: clean worktree. Do not claim that full tests were rerun after docs/memory-only
commits; cite the exact implementation verification SHA from Step 3.

- [ ] **Step 8: Push and verify parity**

```bash
git push -u origin feature/slice-10-sales-meeting
git fetch origin
git rev-parse HEAD
git rev-parse origin/feature/slice-10-sales-meeting
git rev-list --left-right --count \
  origin/feature/slice-10-sales-meeting...HEAD
```

Expected: local and remote SHA identical; ahead/behind `0 0`; no PR or merge is performed
without the user's separate instruction.

## Plan Self-Review

The plan was checked task-by-task against every section of the approved design.

- Tasks 1–2 cover exact types, parsers, migration, exact vocabularies, constraints,
  clean/upgrade/rollback/no-reapply paths, and immutable migration history.
- Tasks 3–5 cover relation policy, atomic/idempotent create, one-to-one invariant,
  GET/PATCH, lock order, no-op, optimistic concurrency, deterministic submit errors,
  lifecycle, revision, immutability, exact 15-event equality, and value-safe activity.
- Tasks 6–7 cover workspace/all-type behavior, completed-only meeting outcomes,
  `assigned_to`, actual-time range, zero fill, DST, and delivery/report regressions.
- Tasks 8–11 cover exact web parsers, URL ownership, separate create route, discriminated
  detail loading, bounded version reload, mutation mutex, timezone behavior, optional
  follow-up guidance, safe timeline, and Staff report UI.
- Task 12 covers real PostgreSQL, vertical browser flows, mobile, keyboard, focus, zoom,
  reflow, touch targets, reduced motion, and accessibility semantics.
- Task 13 covers full builds/tests/audits, exact verification SHA, every required SSOT,
  mandatory durable decision, Codebase Memory, clean worktree, push, and SHA parity.
- Product Delivery create/lifecycle/delivery reports and exact decimal strings remain
  regression gates; General Task behavior remains a regression gate.
- No task introduces a second lifecycle, trigger, detail version, generic form, JSON
  details, scheduler, notification, calendar integration, finance/inventory behavior,
  report infrastructure, ranking, score, or new runtime dependency.
- Type and method names are consistent across producer/consumer tasks.
- No unresolved drafting marker or deferred implementation instruction remains.

## Execution Closeout

Tasks 1–12 and Task 13 verification/documentation steps were executed. The exact fully
verified implementation SHA is `d93441802832f91fe149b603fb55ef2a29b04089`: server build,
732 ordinary tests with 21 PostgreSQL-conditional skips, all 753 tests against disposable
PostgreSQL, server production audit, web build, all 335 web tests, web production audit,
and Playwright Staff/Manager acceptance passed. Codebase Memory is current at the Slice 10
docs closeout (`215ac9e`) with server 1485 nodes/3771 edges and web 861 nodes/1916 edges.
Remote parity remains the final closeout step; later docs/memory-only commits do not rerun
these suites.
