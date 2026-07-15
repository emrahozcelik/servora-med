# Slice 09 General Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate `GENERAL_TASK` as a complete, approved JobCard workflow with exact
create contracts, shared lifecycle and audit guarantees, type-safe workspace/detail UI,
and no delivery, schema, or report-scope leakage.

**Architecture:** Keep one JobCards module and one lifecycle engine. Add an exact
discriminated create parser and an exhaustive `submission-policy.ts`; keep assignment,
relations, idempotency, versioning, activity, notes, list, board, approval, and reports on
the existing JobCard infrastructure. React gains a separate `/jobs/new-task` page and a
type-aware detail shell; Product Delivery remains structurally separate and unchanged.

**Tech Stack:** Node.js, Fastify, TypeScript, PostgreSQL, React, React Router, Vite,
Vitest, Playwright MCP.

## Global Constraints

- The approved SSOT is
  `docs/superpowers/specs/2026-07-14-general-task-design.md`.
- Do not reopen or change approved design decisions during execution.
- Keep one `POST /api/job-cards` endpoint with an exact `type` discriminated union.
- Staff create requires `assignedTo === authenticatedStaff.id`; mismatch returns
  `403 FORBIDDEN` before assignee lookup.
- Malformed assignee is `400 VALIDATION_ERROR`; missing/cross-organization is
  `404 ASSIGNEE_NOT_FOUND`; inactive/non-Staff is `403 FORBIDDEN`.
- Product Delivery and General Task share assignment and relation policy.
- Product Delivery submission invariants and current creation flow remain unchanged.
- General Task submission requires only a valid title and eligible assignee.
- Every delivery subresource operation on General Task returns
  `409 INVALID_JOB_TYPE` after parent concealment and before item/version/Product work.
- General Task detail performs no delivery-items request.
- Operational counters and approval queues cover all JobCard types; delivery quantities
  remain Product Delivery-only.
- WCAG 2.2 Level AA, keyboard operation, 44×44 CSS px targets, 200% text enlargement,
  320 CSS px reflow, and reduced motion are completion requirements.
- Existing migrations `001` through `006` are immutable.
- Add no migration, table, column, trigger, view, cache, generic form builder, JSON details,
  custom field, checklist, attachment, subtask, notification, realtime feature, financial
  behavior, inventory behavior, or runtime dependency.
- Every task follows RED → GREEN → focused regression → commit.

---

## Starting State

- Branch: `feature/slice-09-general-task`.
- Approved design content commit: `62d54d6bed043431190831049bbb3dd18a4335dd`.
- `origin/main` at planning start: `8ee5f5992e28e4f7621ce7c3f57fc8cd2a97c899`.
- The branch is zero commits behind and 30 commits ahead of `origin/main` before this
  planning commit because it is stacked on the completed Slice 08 branch history.
- Slice 08 is independently preserved at
  `26d475cc85f4e2191883bb13a9e6c8f3a8122513`.
- Last recorded Slice 08 verification: ordinary server suite 611 passed/15 skipped;
  PostgreSQL-enabled server suite 626 passed; web suite 286 passed; server and web builds
  passed; report browser/accessibility acceptance and Lighthouse accessibility 100 passed.
- No implementation file has been changed for Slice 09.

## File Map

### Server production

- Create `server/src/modules/job-cards/create-input.ts` — exact create discriminated union,
  allowlist, normalization, UUID/date/priority validation.
- Create `server/src/modules/job-cards/submission-policy.ts` — exhaustive
  `Record<JobCardType, SubmissionPolicy>` readiness registry.
- Modify `server/src/modules/job-cards/types.ts` — canonical type constant, create/detail
  DTOs, relation identities, both-type workspace filters.
- Modify `server/src/modules/job-cards/validation.ts` — reusable strict UUID validator.
- Modify `server/src/modules/job-cards/handlers.ts` — delegate create body parsing; preserve
  all other exact route bodies.
- Modify `server/src/modules/job-cards/policy.ts` — common pre-lookup Staff assignment and
  Product Delivery type guard.
- Modify `server/src/modules/job-cards/service.ts` — both-type create, shared relation
  validation, submission strategy call, guarded delivery paths, canonical detail returns.
- Modify `server/src/modules/job-cards/repository.ts` — canonical detail projection and
  transaction-scoped projection reads.
- Modify `server/src/modules/job-cards/workspace-query.ts` — both canonical type filters.

### Server tests

- Create `server/tests/job-card-create-input.test.ts`.
- Create `server/tests/job-card-detail-repository.test.ts`.
- Modify `server/tests/job-card-policy.test.ts`.
- Modify `server/tests/job-card-crud-service.test.ts`.
- Modify `server/tests/job-card-routes.test.ts`.
- Modify `server/tests/job-card-lifecycle-service.test.ts`.
- Modify `server/tests/delivery-item-service.test.ts`.
- Modify `server/tests/job-card-workspace-query.test.ts`.
- Modify `server/tests/job-card-workspace-repository.test.ts`.
- Modify `server/tests/job-card-board.test.ts`.
- Modify `server/tests/job-card-workspace-postgres.test.ts`.
- Modify `server/tests/reports-dashboard.test.ts`.
- Modify `server/tests/reports-staff-summary.test.ts`.
- Modify `server/tests/reports-deliveries.test.ts`.
- Modify `server/tests/reports-approvals.test.ts`.

### Web production

- Create `web/src/GeneralTaskCreate.tsx` — standalone quick-create screen and stable
  logical-submission action ID.
- Modify `web/src/paths.ts` — stable `/jobs/new-task` path.
- Modify `web/src/AppRouter.tsx` — General Task route and explicit workspace create actions.
- Modify `web/src/jobs/jobs-api.ts` — exact detail parser, both create discriminants, both
  type filters.
- Modify `web/src/jobs/job-search.ts` — URL-owned both-type parsing/canonicalization.
- Modify `web/src/jobs/JobFilters.tsx` — `Genel görev` filter option.
- Modify `web/src/JobDetail.tsx` — shared type-aware shell and conditional delivery fetch.
- Modify `web/src/jobs/job-labels.ts` — exhaustive textual JobCard type labels.
- Modify `web/src/jobs/JobWorkspace.tsx` — separate `Yeni teslim` and `Yeni görev` actions.
- Modify `web/src/jobs/JobRow.tsx` — type-aware row facts.
- Modify `web/src/jobs/JobBoard.tsx` — type-aware card facts.
- Modify `web/src/styles.css` — scoped responsive/accessibility styles for quick-create and
  type-aware presentation.

### Web tests

- Create `web/tests/general-task-create.test.tsx`.
- Modify `web/tests/jobs-api.test.ts`.
- Modify `web/tests/job-search.test.ts`.
- Modify `web/tests/router.test.tsx`.
- Modify `web/tests/job-detail.test.tsx`.
- Modify `web/tests/manager-review.test.tsx`.
- Modify `web/tests/job-list.test.tsx`.
- Modify `web/tests/job-board.test.tsx`.
- Modify `web/tests/workspace-view.test.tsx`.
- Modify `web/tests/accessibility-contract.test.ts`.

### Closeout documentation

- Modify `SERVORA_MED_API_DRAFT.md`.
- Modify `SERVORA_MED_ARCHITECTURE_PLAN.md`.
- Modify `SERVORA_MED_MVP_SLICES.md`.
- Modify `README.md`.
- Modify `docs/superpowers/plans/2026-07-15-general-task.md` checkboxes and execution
  record.
- Refresh `server/.codebase-memory/` and `web/.codebase-memory/` artifacts through the
  Codebase Memory MCP.

---

### Task 1: Canonical Types, Exact Create Parser, and Web Detail Parser

**Files:**
- Create: `server/src/modules/job-cards/create-input.ts`
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/validation.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Test: `server/tests/job-card-create-input.test.ts`
- Modify: `web/src/jobs/jobs-api.ts`
- Test: `web/tests/jobs-api.test.ts`
- Modify: `web/tests/manager-review.test.tsx` — canonical detail fixture identities.
- Modify: `web/tests/tracer-client.test.ts` — canonical detail fixture identities.

**Interfaces:**
- Produces: `JOB_CARD_TYPES`, `JobCardType`, public `JobCardCreateInput`, internal
  `NormalizedJobCardCreateInput`, `JobCardDetail`, `parseJobCardCreateInput`, `uuidString`,
  web `JobCardCreateInput`, and exact `parseJobCard` behavior.
- Consumes: current `validation`, `boundedTrimmedString`, `isoDate`, priorities, and web
  response primitives.

- [x] **Step 1: Write failing exact-contract tests**

Add table-driven server cases that accept the two approved bodies and reject absent or
unknown `type`, arrays, unknown/delivery fields, malformed UUIDs, whitespace-only/256-code-
point titles, invalid priority, and invalid calendar date.
Add web cases that parse both exact detail discriminants and reject missing `assignee`,
malformed Customer/Contact projections, and an unknown type.

```ts
expect(parseJobCardCreateInput({
  clientActionId: 'task-create-1', type: 'GENERAL_TASK', title: 'Doktoru ara',
  assignedTo: STAFF_ID,
})).toEqual({
  clientActionId: 'task-create-1', type: 'GENERAL_TASK', title: 'Doktoru ara',
  assignedTo: STAFF_ID, description: null, customerId: null, contactId: null,
  priority: 'normal', dueDate: null,
})

expect(() => parseJobCardCreateInput({
  clientActionId: 'task-create-2', type: 'GENERAL_TASK', title: 'Görev',
  assignedTo: STAFF_ID, quantity: 1,
})).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
```

- [x] **Step 2: Run RED tests**

Run:

```bash
cd server && npm test -- --run tests/job-card-create-input.test.ts
cd web && npm test -- --run tests/jobs-api.test.ts
```

Expected: FAIL because the parser/types and General Task web discriminant do not exist.

- [x] **Step 3: Implement the minimum exact contracts**

Use the approved union, not a partially optional common object:

```ts
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK'] as const
export type JobCardType = (typeof JOB_CARD_TYPES)[number]

export type JobCardCreateInput =
  | {
      clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string
      description?: string | null; customerId: string; contactId?: string | null
      assignedTo: string; priority?: JobCardPriority; dueDate?: string | null
    }
  | {
      clientActionId: string; type: 'GENERAL_TASK'; title: string
      description?: string | null; customerId?: string | null; contactId?: string | null
      assignedTo: string; priority?: JobCardPriority; dueDate?: string | null
    }

export type NormalizedJobCardCreateInput =
  | (Omit<Extract<JobCardCreateInput, { type: 'PRODUCT_DELIVERY' }>,
      'description' | 'contactId' | 'priority' | 'dueDate'> & {
      description: string | null; contactId: string | null
      priority: JobCardPriority; dueDate: string | null
    })
  | (Omit<Extract<JobCardCreateInput, { type: 'GENERAL_TASK' }>,
      'description' | 'customerId' | 'contactId' | 'priority' | 'dueDate'> & {
      description: string | null; customerId: string | null; contactId: string | null
      priority: JobCardPriority; dueDate: string | null
    })

export type RelatedIdentity = { id: string; name: string }
export type JobCardDetail = JobCard & {
  assignee: RelatedIdentity
  customer: RelatedIdentity | null
  contact: RelatedIdentity | null
}
```

`parseJobCardCreateInput` returns `NormalizedJobCardCreateInput`: it inspects `type`,
applies one exact allowlist, normalizes optional text to `null`, defaults priority to
`normal`, and calls `uuidString`/`isoDate`. Contact-without-Customer is a relation-policy
error in Task 2, not a primitive parser error. In `handlers.ts`,
replace only create parsing:

```ts
create: async (request, reply) => reply.code(201).send(
  await service.create(actor(request), parseJobCardCreateInput(request.body)),
),
```

On web, change `JobCard.type` to both values, require the three relation projections, and
export the same create union. Do not alter Product Delivery fields.

- [x] **Step 4: Verify GREEN and Product Delivery parser regression**

Run the two targeted commands from Step 2, then:

```bash
cd server && npm test -- --run tests/job-card-routes.test.ts
cd web && npm test -- --run tests/delivery-create.test.tsx tests/delivery-create-screen.test.tsx
```

Expected: PASS; Product Delivery create/parser fixtures remain valid.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/create-input.ts server/src/modules/job-cards/types.ts \
  server/src/modules/job-cards/validation.ts server/src/modules/job-cards/handlers.ts \
  server/tests/job-card-create-input.test.ts web/src/jobs/jobs-api.ts web/tests/jobs-api.test.ts
git add web/tests/manager-review.test.tsx web/tests/tracer-client.test.ts \
  docs/superpowers/plans/2026-07-15-general-task.md
git commit -m "feat: define General Task contracts"
```

### Task 2: Shared Assignment and Customer/Contact Policy

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Test: `server/tests/job-card-policy.test.ts`
- Test: `server/tests/job-card-crud-service.test.ts`

**Interfaces:**
- Consumes: `NormalizedJobCardCreateInput`, `JobCardActor`, `JobCardAssignee` from Task 1.
- Produces: `assertCreateAssignmentRequest(actor, assignedTo)` and the exact assignee
  error matrix used by both create types.

- [x] **Step 1: Write failing policy and lookup-order tests**

Use a repository double that counts `getAssigneeForUpdate` calls. Assert:

```ts
await expect(service.create(staff, productInput({ assignedTo: OTHER_ID })))
  .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })
expect(repository.assigneeLookupCount).toBe(0)

await expect(service.create(manager, taskInput({ assignedTo: MISSING_ID })))
  .rejects.toMatchObject({ statusCode: 404, code: 'ASSIGNEE_NOT_FOUND' })
await expect(service.create(manager, taskInput({ assignedTo: INACTIVE_ID })))
  .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })
```

Cover Product Delivery and General Task for Staff self/mismatch, and management missing,
cross-organization, inactive, and non-Staff candidates. Cover Customer absent for General
Task, active Customer, active matching Contact, Contact without Customer, mismatched
Contact, inactive Customer, and inactive Contact.

- [x] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-crud-service.test.ts
```

Expected: FAIL because Staff mismatch currently reaches assignee lookup and General Task
relation paths are not active.

- [x] **Step 3: Implement minimum shared policy**

Add and call this before any assignee lookup:

```ts
export function assertCreateAssignmentRequest(actor: JobCardActor, assignedTo: string) {
  if (actor.role === 'STAFF' && actor.id !== assignedTo) forbidden()
}
```

Keep `assertCanCreateForAssignee` as the post-lookup eligibility policy. In `create`, use
this order exactly: validate parsed input → pre-lookup Staff equality → assignee lookup →
`404 ASSIGNEE_NOT_FOUND` when absent → active/Staff policy → optional Customer/Contact
locks and canonical relation errors. Do not derive or replace `assignedTo`.

- [x] **Step 4: Verify GREEN and Product Delivery behavior**

```bash
cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-crud-service.test.ts
cd server && npm test -- --run tests/job-card-service.test.ts tests/delivery-item-service.test.ts
```

Expected: PASS with the exact 400/403/404 matrix and unchanged valid Product Delivery
creation.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/policy.ts server/src/modules/job-cards/service.ts \
  server/tests/job-card-policy.test.ts server/tests/job-card-crud-service.test.ts
git commit -m "feat: share JobCard assignment policy"
```

### Task 3: General Task Create Transaction, Activity, and Idempotency

**Files:**
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts` — pass the normalized union without a type escape.
- Modify: `server/tests/job-card-crud-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**
- Consumes: `NormalizedJobCardCreateInput` and shared policies from Tasks 1–2.
- Produces: idempotent `JobCardService.create` for both discriminants.

- [x] **Step 1: Write failing General Task create tests**

Assert title-only creation writes one `GENERAL_TASK`/`NEW`/version-1 JobCard, defaults
priority, persists nullable context, and appends exactly one `JOB_CREATED`. Assert optional
Customer/Contact values persist. Exercise completed replay, in-progress duplicate,
concurrent duplicate, and rollback when activity append fails.

```ts
expect(created).toMatchObject({
  type: 'GENERAL_TASK', status: 'NEW', version: 1, title: 'Doktoru ara',
  customerId: null, contactId: null, assignedTo: STAFF_ID, priority: 'normal',
})
expect(repository.activities).toHaveLength(1)
expect(repository.activities[0]?.event).toBe('JOB_CREATED')
```

- [x] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/job-card-crud-service.test.ts tests/job-card-routes.test.ts
```

Expected: FAIL because `JobCardService.create` still rejects `GENERAL_TASK`.

- [x] **Step 3: Implement the minimum type-aware create transaction**

Remove the Product-only type rejection. Require Customer only in the Product branch; call
relation validation only when General Task has a Customer. Pass the discriminant unchanged
to `createJobCard`. Keep the existing critical-action claim:

```ts
const result = await repository.executeCriticalAction(
  { organizationId: actor.organizationId, userId: actor.id,
    clientActionId: input.clientActionId, operationKey: 'JOB_CREATE' },
  async (tx) => {
    // assignment and optional relation validation already passed in this transaction
    const job = await tx.createJobCard({ ...normalized, organizationId: actor.organizationId,
      createdBy: actor.id })
    await tx.appendActivity({ organizationId: actor.organizationId, jobCardId: job.id,
      actorId: actor.id, event: 'JOB_CREATED', clientActionId: input.clientActionId,
      metadata: { assignedTo: job.assignedTo } })
    return job
  },
)
```

Do not append `JOB_ASSIGNED` during initial creation.

- [x] **Step 4: Verify GREEN and route exactness**

Run Step 2, then:

```bash
cd server && npm test -- --run tests/job-card-activity.test.ts tests/job-card-service.test.ts
```

Expected: PASS; replay returns the original result and failures leave no partial record or
activity.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/service.ts server/src/modules/job-cards/handlers.ts \
  server/tests/job-card-crud-service.test.ts \
  server/tests/job-card-routes.test.ts
git commit -m "feat: create General Task JobCards"
```

### Task 4: Exhaustive Type-Specific Submission Policy

**Files:**
- Create: `server/src/modules/job-cards/submission-policy.ts`
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Test: `server/tests/job-card-lifecycle-service.test.ts`

**Interfaces:**
- Produces: `validateSubmission(transaction, actor, jobCard)` backed by an exhaustive
  `Record<JobCardType, SubmissionPolicy>`.
- Consumes: transaction `customerExists`, `getAssignee`, and
  `getSubmissionDeliveryItems` methods.

- [ ] **Step 1: Write failing readiness and lifecycle tests**

Test that General Task with title and eligible assignee submits without Customer or items;
empty persisted title or newly inactive/non-Staff assignee fails without transition. Keep
Product Delivery cases for Customer, item, Product/purpose/date/positive quantity. Run the
full plan/start/submit/approve/revision/resume/cancel matrix for General Task, including
stale version, replay, concurrent duplicate, terminal immutability, first-start timestamp,
and activity rollback.

- [ ] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts
```

Expected: FAIL with `DELIVERY_NOT_READY` for General Task.

- [ ] **Step 3: Implement the exact policy registry**

```ts
export type SubmissionPolicy = (
  tx: JobCardTransaction, actor: JobCardActor, job: JobCard,
) => Promise<void>

const policies: Record<JobCardType, SubmissionPolicy> = {
  PRODUCT_DELIVERY: validateProductDeliverySubmission,
  GENERAL_TASK: validateGeneralTaskSubmission,
}

export const validateSubmission = (
  tx: JobCardTransaction, actor: JobCardActor, job: JobCard,
) => policies[job.type](tx, actor, job)
```

Move existing Product Delivery readiness unchanged into its policy. General Task checks a
trimmed 1–255-code-point title and active same-organization Staff assignee. Replace only
the inline submit block in `runLifecycle` with `await validateSubmission(tx, actor, job)`.

- [ ] **Step 4: Verify GREEN and Product Delivery regression**

```bash
cd server && npm test -- --run tests/job-card-lifecycle-service.test.ts
cd server && npm test -- --run tests/delivery-item-service.test.ts tests/job-card-policy.test.ts
```

Expected: PASS; both types use the same transition/idempotency/activity engine.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/submission-policy.ts \
  server/src/modules/job-cards/policy.ts server/src/modules/job-cards/service.ts \
  server/tests/job-card-lifecycle-service.test.ts
git commit -m "feat: validate JobCard submission by type"
```

### Task 5: Common Delivery Subresource Type Guard

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/tests/delivery-item-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**
- Produces: `assertProductDeliveryJob(job)` used by GET/POST/PATCH/DELETE delivery paths.

- [ ] **Step 1: Write failing four-path guard tests**

For a visible General Task, assert list, add, patch, and remove each return
`409 INVALID_JOB_TYPE` and exact Turkish message. Spies must prove no version comparison,
item lookup, Product lookup, mutation, or activity after the parent read. Preserve missing
or cross-organization parent as `404 JOB_CARD_NOT_FOUND`.

- [ ] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/delivery-item-service.test.ts tests/job-card-routes.test.ts
```

Expected: FAIL for list/patch/delete paths that currently lack the shared type guard.

- [ ] **Step 3: Implement and place the guard**

```ts
export function assertProductDeliveryJob(job: JobCard) {
  if (job.type !== 'PRODUCT_DELIVERY') {
    throw new AppError('INVALID_JOB_TYPE', 409,
      'Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.')
  }
}
```

Each service method must read/conceal the parent, invoke this guard, and only then perform
version/item/Product work. GET must not call the delivery repository after guard failure.

- [ ] **Step 4: Verify GREEN and Product Delivery CRUD**

Run Step 2 and:

```bash
cd server && npm test -- --run tests/job-card-workspace-postgres.test.ts
```

Expected: targeted unit tests PASS. PostgreSQL-gated cases either PASS with
`TEST_DATABASE_URL` or report their existing explicit skip without being claimed live.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/policy.ts server/src/modules/job-cards/service.ts \
  server/tests/delivery-item-service.test.ts server/tests/job-card-routes.test.ts
git commit -m "feat: guard JobCard delivery resources"
```

### Task 6: Canonical Detail Projection and Related Identity Joins

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Create: `server/tests/job-card-detail-repository.test.ts`
- Modify: `server/tests/job-card-crud-service.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`

**Interfaces:**
- Produces: `findJobCardDetail(organizationId, jobCardId)` and transaction
  `getJobDetail(organizationId, jobCardId)` returning `JobCardDetail | null`.

- [ ] **Step 1: Write failing projection and response tests**

Assert one organization-scoped query maps assignee, nullable Customer, and nullable
Contact identities. Cross-organization rows return null. Assert GET detail, create, patch,
and lifecycle responses contain the exact projection and idempotent replay retains its
stored projection.

- [ ] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/job-card-detail-repository.test.ts \
  tests/job-card-crud-service.test.ts tests/job-card-lifecycle-service.test.ts
```

Expected: FAIL because repository detail currently returns raw IDs only.

- [ ] **Step 3: Implement the projection once**

Use one selected column set for public and transaction reads:

```sql
SELECT j.id, j.organization_id, j.type, j.status, j.version, j.title,
       j.description, j.customer_id, j.contact_id, j.assigned_to, j.created_by,
       j.priority, j.due_date,
       assignee.id AS assignee_id, assignee.name AS assignee_name,
       customer.id AS customer_id_join, customer.name AS customer_name,
       contact.id AS contact_id_join, contact.name AS contact_name
FROM job_cards j
JOIN users assignee
  ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
LEFT JOIN customers customer
  ON customer.organization_id = j.organization_id AND customer.id = j.customer_id
LEFT JOIN contacts contact
  ON contact.organization_id = j.organization_id AND contact.id = j.contact_id
WHERE j.organization_id = $1 AND j.id = $2
```

Map raw identifiers and additive identities exactly. Inside create/patch/lifecycle critical
transactions, read the projection before completing the processed response so replay
stores the same DTO; do not compose names through People/CRM HTTP calls.

- [ ] **Step 4: Verify GREEN and visibility**

Run Step 2 and:

```bash
cd server && npm test -- --run tests/job-card-routes.test.ts tests/job-card-service.test.ts
```

Expected: PASS; Product Delivery retains all previous fields plus additive identities.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts \
  server/tests/job-card-detail-repository.test.ts server/tests/job-card-crud-service.test.ts \
  server/tests/job-card-lifecycle-service.test.ts
git commit -m "feat: project JobCard detail identities"
```

### Task 7: Server List and Board Type Filters

**Files:**
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/workspace-query.ts`
- Modify: `server/tests/job-card-workspace-query.test.ts`
- Modify: `server/tests/job-card-workspace-repository.test.ts`
- Modify: `server/tests/job-card-board.test.ts`

**Interfaces:**
- Produces: `JobCardBaseFilters.type: JobCardType | null` and strict list/board parsing.

- [ ] **Step 1: Write failing query/repository tests**

Accept each canonical type, omit type for both, and reject empty, repeated, or unknown
type with `400 VALIDATION_ERROR`. Assert parameterized SQL applies `j.type = $n`, General
Task rows map `deliveryItemCount: 0`, and board/list reuse `JobCardListItem`.

- [ ] **Step 2: Run RED tests**

```bash
cd server && npm test -- --run tests/job-card-workspace-query.test.ts \
  tests/job-card-workspace-repository.test.ts tests/job-card-board.test.ts
```

Expected: FAIL because `optionalType` accepts only Product Delivery.

- [ ] **Step 3: Implement minimum both-type parsing**

```ts
function optionalType(value: unknown): JobCardType | null {
  if (value === undefined) return null
  if (!JOB_CARD_TYPES.includes(value as JobCardType)) throw validation('type')
  return value as JobCardType
}
```

Keep exact-query array rejection for repeated scalars and existing repository SQL shape.
Do not add a second General Task query.

- [ ] **Step 4: Verify GREEN**

Run Step 2 and:

```bash
cd server && npm test -- --run tests/job-card-workspace-postgres.test.ts
```

Expected: unit tests PASS; gated PostgreSQL result is reported accurately.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards/types.ts server/src/modules/job-cards/workspace-query.ts \
  server/tests/job-card-workspace-query.test.ts \
  server/tests/job-card-workspace-repository.test.ts server/tests/job-card-board.test.ts
git commit -m "feat: filter workspace by JobCard type"
```

### Task 8: Web API Contracts and URL-Owned Type Filter

**Files:**
- Modify: `web/src/jobs/jobs-api.ts`
- Modify: `web/src/jobs/job-search.ts`
- Modify: `web/src/jobs/JobFilters.tsx`
- Modify: `web/src/jobs/job-labels.ts`
- Modify: `web/tests/jobs-api.test.ts`
- Modify: `web/tests/job-search.test.ts`
- Modify: `web/tests/workspace-view.test.tsx`

**Interfaces:**
- Produces: web `JobCardType`, both-type request filters, exact create request builders,
  exhaustive `jobTypeLabels`, and canonical URL ownership.

- [ ] **Step 1: Write failing API/search/filter tests**

Assert Product and General create bodies contain only their union fields. Parse
`type=GENERAL_TASK`; preserve it through refresh/deep-link/Back/Forward helpers; remove
empty/repeated/unknown type with canonical replace state; reset offset on type change; and
render both textual filter options.

- [ ] **Step 2: Run RED tests**

```bash
cd web && npm test -- --run tests/jobs-api.test.ts tests/job-search.test.ts \
  tests/workspace-view.test.tsx
```

Expected: FAIL because web type filters and create input are Product-only.

- [ ] **Step 3: Implement minimum web contracts**

```ts
export type JobCardType = 'PRODUCT_DELIVERY' | 'GENERAL_TASK'
export const jobTypeLabels: Record<JobCardType, string> = {
  PRODUCT_DELIVERY: 'Ürün teslimi',
  GENERAL_TASK: 'Genel görev',
}
```

Change `JobSearchState.type` and API filters to `JobCardType`. Accept either canonical
value in `parseJobSearch`; existing `canonicalJobSearchParams` removes every invalid or
repeated scalar with replace navigation. Add `Genel görev` to `JobFilters` and keep offset
reset in `updateJobSearch`.

- [ ] **Step 4: Verify GREEN**

Run Step 2 and:

```bash
cd web && npm test -- --run tests/job-list.test.tsx tests/job-board.test.tsx
```

Expected: PASS with no change to mobile board suppression.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/jobs-api.ts web/src/jobs/job-search.ts \
  web/src/jobs/JobFilters.tsx web/src/jobs/job-labels.ts \
  web/tests/jobs-api.test.ts web/tests/job-search.test.ts web/tests/workspace-view.test.tsx
git commit -m "feat: support General Task web contracts"
```

### Task 9: `/jobs/new-task` Quick-Create Form

**Files:**
- Create: `web/src/GeneralTaskCreate.tsx`
- Modify: `web/src/paths.ts`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/styles.css`
- Create: `web/tests/general-task-create.test.tsx`
- Modify: `web/tests/router.test.tsx`

**Interfaces:**
- Consumes: `createJobCard`, `listStaff`, `listCustomers`, `listContacts`,
  `createRequestGate`, and authenticated `CurrentUser`.
- Produces: `GeneralTaskCreateScreen`, `paths.newTask`, and workspace props
  `onCreateDelivery`/`onCreateTask` for explicit create links.

- [ ] **Step 1: Write failing form and route tests**

Cover direct route/refresh, Staff fixed identity with zero Staff-list calls, management
active Staff loading/error/retry, title/description, accessible `Ek bilgiler`, default
priority, due date, optional Customer/Contact, clearing and stale-response protection,
CRM failure with context-free submit, exact request body, pending lock, stable retry action
ID, error focus/value preservation, cancel, and success navigation to `/jobs/:id`.

- [ ] **Step 2: Run RED tests**

```bash
cd web && npm test -- --run tests/general-task-create.test.tsx tests/router.test.tsx
```

Expected: FAIL because route and screen do not exist.

- [ ] **Step 3: Implement the standalone form**

Add `newTask: '/jobs/new-task'`. Keep `DeliveryCreate` untouched. The create call must be:

```ts
await createJobCard({
  clientActionId: actionIdRef.current,
  type: 'GENERAL_TASK',
  title: title.trim(),
  assignedTo: user.role === 'STAFF' ? user.id : assignedTo,
  description: description.trim() || null,
  priority,
  dueDate: dueDate || null,
  customerId: customerId || null,
  contactId: contactId || null,
})
```

Generate `actionIdRef.current` once per logical submit and retain it after ambiguous or
retryable failure. Staff sees fixed owner text, never a selector. Use existing CRM/People
clients and request-generation gate; add no shared generic form abstraction. When the
optional section opens, load active Customers through repeated
`listCustomers({ status: 'active', limit: 200, offset })` pages until `items.length`
reaches `total`. Load selected-Customer Contacts through the same bounded paging pattern
with `listContacts`; do not silently truncate either selector.

- [ ] **Step 4: Verify GREEN and Product Delivery regression**

Run Step 2 and:

```bash
cd web && npm test -- --run tests/delivery-create.test.tsx \
  tests/delivery-create-screen.test.tsx tests/App.test.tsx
```

Expected: PASS; `/jobs/new-delivery` behavior remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/GeneralTaskCreate.tsx web/src/paths.ts web/src/AppRouter.tsx \
  web/src/jobs/JobWorkspace.tsx web/src/styles.css \
  web/tests/general-task-create.test.tsx web/tests/router.test.tsx
git commit -m "feat: add General Task quick create"
```

### Task 10: Type-Aware JobCard Detail Shell

**Files:**
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`

**Interfaces:**
- Consumes: exact `JobCardDetail`, `jobTypeLabels`, lifecycle/notes/timeline clients.
- Produces: one shared shell with conditional Product Delivery section.

- [ ] **Step 1: Write failing type-aware loading/render tests**

Assert General Task initial load and conflict truth reload make zero delivery-item calls;
show type/title/description/status/assignee/priority/due date/optional Customer/Contact,
notes, timeline, and allowed commands; show no delivery text. Assert Product Delivery still
fetches and renders items. Keep lifecycle success, dialog focus, review lock, and conflict
feedback cases.

- [ ] **Step 2: Run RED tests**

```bash
cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx
```

Expected: FAIL because `Promise.all` always requests delivery items and heading is fixed.

- [ ] **Step 3: Implement the type-aware fetch and shell**

Load detail first, then branch:

```ts
const job = await getJobCard(jobId)
const items = job.type === 'PRODUCT_DELIVERY'
  ? await listDeliveryItems(jobId)
  : []
setState({ kind: 'ready', job, items })
```

Use the same helper for initial load and `refreshTruth`. Render the delivery section only
for Product Delivery. Keep notes/timeline and lifecycle shell shared; replace fixed eyebrow
and delivery-only waiting text with exhaustive type-aware labels.

- [ ] **Step 4: Verify GREEN and lifecycle regression**

Run Step 2 and:

```bash
cd web && npm test -- --run tests/job-notes.test.tsx tests/job-timeline.test.tsx
```

Expected: PASS; General Task makes no delivery request under any tested reload path.

- [ ] **Step 5: Commit**

```bash
git add web/src/JobDetail.tsx web/src/styles.css web/tests/job-detail.test.tsx \
  web/tests/manager-review.test.tsx
git commit -m "feat: render type-aware JobCard detail"
```

### Task 11: Workspace List and Board Type Presentation

**Files:**
- Modify: `web/src/jobs/JobRow.tsx`
- Modify: `web/src/jobs/JobBoard.tsx`
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-list.test.tsx`
- Modify: `web/tests/job-board.test.tsx`
- Modify: `web/tests/workspace-view.test.tsx`

**Interfaces:**
- Consumes: `jobTypeLabels`, `JobCardListItem.type`, and `deliveryItemCount`.
- Produces: text-based type presentation without false delivery facts.

- [ ] **Step 1: Write failing row/card/create-action tests**

Assert each row/card exposes the textual type. General Task shows no `Teslim`, product
count, or delivery empty state even when canonical count is zero; Product Delivery keeps
its count. Assert `Yeni teslim` and `Yeni görev` are distinct accessible actions with
stable routes and mobile targets.

- [ ] **Step 2: Run RED tests**

```bash
cd web && npm test -- --run tests/job-list.test.tsx tests/job-board.test.tsx \
  tests/workspace-view.test.tsx
```

Expected: FAIL because current row/card hard-code Product Delivery and delivery count.

- [ ] **Step 3: Implement minimum type presentation**

Use `jobTypeLabels[job.type]` in row summary and board card. Wrap delivery facts only in:

```tsx
{job.type === 'PRODUCT_DELIVERY' &&
  <div><dt>Teslim</dt><dd>{job.deliveryItemCount} ürün kalemi</dd></div>}
```

Do not use color as the only type cue and do not add new card colors per type.

- [ ] **Step 4: Verify GREEN and responsive unit contracts**

Run Step 2 and:

```bash
cd web && npm test -- --run tests/accessibility-contract.test.ts
```

Expected: PASS with existing list/board lifecycle links and mobile list behavior intact.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/JobRow.tsx web/src/jobs/JobBoard.tsx \
  web/src/jobs/JobWorkspace.tsx web/src/styles.css web/tests/job-list.test.tsx \
  web/tests/job-board.test.tsx web/tests/workspace-view.test.tsx
git commit -m "feat: present General Tasks in workspace"
```

### Task 12: Approval, Staff, and Operational Report Regressions

**Files:**
- Modify: `server/tests/reports-dashboard.test.ts`
- Modify: `server/tests/reports-staff-summary.test.ts`
- Modify: `server/tests/reports-deliveries.test.ts`
- Modify: `server/tests/reports-approvals.test.ts`

**Interfaces:**
- Consumes: established Slice 08 report queries; produces no production report change.

- [ ] **Step 1: Add mixed-type regression fixtures**

First add assertions for one named General Task contribution before adding that fixture;
this deliberately proves the tests can fail. Cover active/overdue/waiting/revision/
completed/cancelled/trend and Staff ownership. Add the waiting General Task assertion to
approval age and assert delivery quantity/purpose totals remain unchanged.

- [ ] **Step 2: Run tests to detect any scope leak**

```bash
cd server && npm test -- --run tests/reports-dashboard.test.ts \
  tests/reports-staff-summary.test.ts tests/reports-deliveries.test.ts \
  tests/reports-approvals.test.ts
```

Expected: FAIL because the named General Task fixtures have not been inserted yet.

- [ ] **Step 3: Add the minimum mixed-type fixtures**

Insert the named General Task rows with the exact statuses, dates, and `assigned_to`
values asserted in Step 1. Do not modify report production code. Delivery fixtures remain
owned by Product Delivery and preserve this established predicate:

```sql
AND j.type = 'PRODUCT_DELIVERY'
```

If the completed fixtures reveal a production query contradicting the approved DOM-006
scope, stop execution and report the exact SQL/test evidence for a separate review; do not
silently broaden this test-only task.

- [ ] **Step 4: Re-run report and People regressions**

```bash
cd server && npm test -- --run tests/reports-dashboard.test.ts \
  tests/reports-staff-summary.test.ts tests/reports-deliveries.test.ts \
  tests/reports-approvals.test.ts tests/people-counters.test.ts
```

Expected: PASS and exact decimal delivery strings remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/tests/reports-dashboard.test.ts server/tests/reports-staff-summary.test.ts \
  server/tests/reports-deliveries.test.ts server/tests/reports-approvals.test.ts
git commit -m "test: cover General Task report scope"
```

### Task 13: Disposable PostgreSQL, Browser, and Accessibility Acceptance

**Files:**
- Modify: `server/tests/job-card-workspace-postgres.test.ts`
- Modify: `web/tests/accessibility-contract.test.ts`
- Modify: `web/tests/general-task-create.test.tsx`
- Modify: `web/tests/job-detail.test.tsx`

**Interfaces:**
- Produces: live-database and browser evidence; no new Playwright dependency/config.

- [ ] **Step 1: Write the failing PostgreSQL acceptance extension**

Extend the isolated schema flow to migrate 001–006, create Staff/Manager/session/reference
rows, create a title-only General Task, start, submit, approve, revision/resume path,
append note/activity, verify visibility, both-type filters, canonical identities, zero
delivery items, all four `INVALID_JOB_TYPE` operations, report inclusion, and delivery
report exclusion.

- [ ] **Step 2: Run PostgreSQL acceptance against a disposable database**

```bash
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run \
  tests/job-card-workspace-postgres.test.ts
```

Expected: PASS with a real disposable PostgreSQL URL. Do not accept the conditional skip
as live verification; create/remove the disposable database using the established project
procedure and record its PostgreSQL version.

- [ ] **Step 3: Strengthen automated accessibility contracts**

Assert the quick-create disclosure, persistent labels, error associations, focusable error
summary, two 44×44 create actions, textual type labels, and absence of delivery UI/request
for General Task. Run:

```bash
cd web && npm test -- --run tests/accessibility-contract.test.ts \
  tests/general-task-create.test.tsx tests/job-detail.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run browser acceptance with Playwright MCP**

Against the disposable PostgreSQL-backed running app, verify Staff create → start → submit,
Manager approve and revision, refresh/deep link/Back/Forward type filter, keyboard-only
operation, visible focus/focus restoration, 44×44 targets, 390×844 viewport, 320 CSS px
effective reflow, 200% text enlargement, applicable 400% zoom, reduced motion, semantic
snapshot, and zero General Task delivery request in the network log. Record each result in
Task 14; do not add Playwright packages.

- [ ] **Step 5: Commit acceptance tests**

```bash
git add server/tests/job-card-workspace-postgres.test.ts \
  web/tests/accessibility-contract.test.ts web/tests/general-task-create.test.tsx \
  web/tests/job-detail.test.tsx
git commit -m "test: verify General Task acceptance"
```

### Task 14: Full Verification, SSOT Closeout, Memory, and Push

**Files:**
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-15-general-task.md`
- Refresh: `server/.codebase-memory/`
- Refresh: `web/.codebase-memory/`

**Interfaces:**
- Consumes: verified Tasks 1–13; produces the truthful Slice 09 closeout record.

- [ ] **Step 1: Run the complete server verification**

```bash
cd server && npm run build
cd server && npm test -- --run
```

Expected: PASS. Record exact files/tests/skips; skipped PostgreSQL tests do not replace
Task 13 live evidence.

- [ ] **Step 2: Run the PostgreSQL-enabled complete server suite**

```bash
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
```

Expected: PASS with every PostgreSQL-conditional file enabled. Record database version,
file count, test count, and zero unexpected skips.

- [ ] **Step 3: Run complete web verification**

```bash
cd web && npm test -- --run
cd web && npm run build
```

Expected: PASS. Record exact file/test counts.

- [ ] **Step 4: Run dependency and diff hygiene checks**

```bash
cd server && npm audit --omit=dev
cd web && npm audit --omit=dev
git diff --check
git status --short
```

Expected: audits report zero production vulnerabilities, diff check passes, and status
contains only intended closeout files before commit.

- [ ] **Step 5: Update SSOT and evidence**

Document the exact create union, assignment 400/403/404 matrix, submission strategies,
canonical detail projection, `INVALID_JOB_TYPE`, both-type filters, route/UI behavior,
tests, and browser evidence. Mark Slice 09 implemented/verified only now. Keep Slice 10+
open. State explicitly that no migration, generic form builder, JSON details, financial,
inventory, or report-storage feature was added.

- [ ] **Step 6: Refresh Codebase Memory**

Run Codebase Memory change detection for server and web from the Slice 09 base, then index
both repositories with persistence enabled. Verify index status and architecture counts;
store refreshed `.codebase-memory/graph.db.zst` artifacts. Do not invent counts—copy tool
results exactly.

- [ ] **Step 7: Self-review implementation against the approved design**

Verify every acceptance criterion in design sections 6–22 has a passing test/evidence;
search production and docs for unresolved markers; verify no migration or dependency
change; verify Product Delivery tests and behavior; verify all report type scopes; verify
General Task network evidence contains no delivery request.

- [ ] **Step 8: Commit closeout**

```bash
git add SERVORA_MED_API_DRAFT.md SERVORA_MED_ARCHITECTURE_PLAN.md \
  SERVORA_MED_MVP_SLICES.md README.md \
  docs/superpowers/plans/2026-07-15-general-task.md \
  server/.codebase-memory web/.codebase-memory
git commit -m "docs: close Slice 09 general tasks"
```

- [ ] **Step 9: Push and verify remote parity**

```bash
git push origin feature/slice-09-general-task
git rev-parse HEAD
git rev-parse origin/feature/slice-09-general-task
git status --short --branch
```

Expected: local and remote SHAs are identical and worktree is clean. Stop for user review;
do not merge or open a PR unless explicitly requested.

---

## Plan Self-Review

- [x] All approved design sections map to Tasks 1–14.
- [x] Every task names exact production files, test files, behavior, commands, expected
      results, and a separate commit boundary.
- [x] RED → minimum GREEN → focused regression → commit order is explicit.
- [x] Product Delivery regression checks are present at every shared contract boundary.
- [x] Staff mismatch is pre-lookup `403`; malformed/missing/cross-org/inactive/non-Staff
      outcomes are exact and shared by both create types.
- [x] Submission policy is exhaustive and lifecycle execution remains shared.
- [x] All four delivery paths share one General Task guard.
- [x] Detail identities are backend-projected without People/CRM HTTP composition.
- [x] API and URL type filters accept exactly both canonical values.
- [x] General Task quick-create and detail remain separate from Product Delivery controls.
- [x] All-type operational metrics and Product Delivery-only quantities remain distinct.
- [x] PostgreSQL, browser, keyboard, focus, target, zoom, reflow, motion, and semantic
      evidence have an explicit task.
- [x] No migration, dependency, form builder, JSON details, out-of-scope domain, or
      speculative abstraction is planned.
- [x] No unresolved marker or deferred implementation instruction remains.

## Execution Stop

This plan is a documentation-only deliverable awaiting user review. Slice 09 implementation
has not started. No production or test code may be changed until this plan is explicitly
approved by the user.
