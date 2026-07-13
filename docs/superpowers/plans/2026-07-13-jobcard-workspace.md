# Slice 07 JobCard Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Slice 07 as the canonical role-aware JobCard workspace with paginated list and desktop read-only board projections, complete named lifecycle commands, append-only operational notes, and a safe activity timeline.

**Architecture:** The existing JobCard modular-monolith boundary remains authoritative. A typed workspace filter/query unit feeds shared list and board projections; lifecycle and notes use transaction-owned processed actions; activity persistence stays internal while a presenter emits allowlisted public details. React Router owns workspace URLs, desktop defaults to the structured list, the board only opens detail, and mobile canonicalizes every board URL to list without issuing a board request.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Fastify 5.10, PostgreSQL 16+ (CI PostgreSQL 17), React 19.2, React Router DOM 7.18.1, Vite 8.1, Vitest 4.1, existing CSS design tokens, Playwright MCP.

## Global Constraints

- Follow [the approved Slice 07 design](../specs/2026-07-13-jobcard-workspace-design.md) exactly.
- Use English identifiers, tests, commits, and acceptance criteria; use Turkish user-facing copy.
- Create migration `006_jobcard_workspace.sql`; never edit applied migrations 001–005.
- Keep `JobCard` as the aggregate root and the backend state machine as the only business-state authority.
- Support only `PRODUCT_DELIVERY` in Slice 07 filters and UI. Do not expose `GENERAL_TASK` before Slice 09.
- Keep the board a read projection. Board cards only open detail and expose no lifecycle command, menu, drag handle, or gesture mutation.
- Mobile never requests or renders the board. A mobile board URL is replaced with `view=list` and is not automatically restored after resize.
- Staff reads and mutations remain limited to their own assigned JobCards. Client filters never widen this scope.
- Manager/Admin reads remain organization-scoped. Cross-organization and hidden Staff records use `404 JOB_CARD_NOT_FOUND`.
- Preserve commercial-field immutability in `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED`; notes remain appendable under their separate policy.
- Every lifecycle command requires `clientActionId` and `expectedVersion`, uses processed actions, increments JobCard version once, and writes exactly one named activity in the same transaction.
- `clientActionId` is 1–255 Unicode code points after trim. The web client uses `crypto.randomUUID()`; the server does not require UUID syntax.
- Submission and approval notes allow 0–2,000 code points. Revision and cancellation reasons require 1–2,000 code points. Operational notes require 1–4,000 code points.
- Note append does not accept `expectedVersion`, never bumps JobCard version, and returns `201` for both first success and completed replay.
- Notes are append-only through the application contract: public routes, service/repository
  surfaces, and UI expose no update or delete operation. Do not add database mutation
  prevention triggers or claim physical database immutability.
- Keep the exact 14-event canonical vocabulary. Never emit a generic status-change event.
- Never expose persisted activity `old_value`, `new_value`, or `metadata` directly. Public activity uses event-specific allowlisted `details` and never contains note text.
- Use exact query/body allowlists. Job search is at most 200 code points; dates accept only `YYYY-MM-DD`.
- Do not add WebSocket, notifications, saved views, reports, General Task, attachments, stock, warehouse, accounting, bulk mutation, or configurable workflows.
- Do not add a UI framework, drag-and-drop package, state library, date library, or animation dependency.
- Meet WCAG 2.2 AA, approximately 44×44 CSS-pixel targets, visible focus, keyboard operation, 200% text, applicable 400% reflow, reduced motion, and color-independent status meaning.
- Begin every production behavior with a focused failing test and end each task with focused regression verification.
- Keep execution sequential by default. If delegation is used, run no more than two subagents concurrently and do not let them edit overlapping files.

---

## File Map

### Server

- Create `server/src/db/migrations/006_jobcard_workspace.sql` — note storage for the append-only application contract, workspace indexes, and lifecycle timestamp checks.
- Create `server/src/modules/job-cards/validation.ts` — shared Unicode code-point, action ID, lifecycle text, date, UUID, and pagination validation.
- Create `server/src/modules/job-cards/workspace-query.ts` — exact list/board query parsing and canonical typed filters.
- Create `server/src/modules/job-cards/activity-presenter.ts` — event-specific allowlisted public activity details.
- Create `server/src/modules/job-cards/notes-service.ts` — note validation, scoped reads, and idempotent append orchestration.
- Modify `server/src/modules/job-cards/types.ts` — complete event/command unions and workspace/note/activity DTOs.
- Modify `server/src/modules/job-cards/policy.ts` — full lifecycle role/state matrix and note policy.
- Modify `server/src/modules/job-cards/repository.ts` — shared list/board projection queries, complete transitions, safe activity reads, note transactions, and first-start preservation.
- Modify `server/src/modules/job-cards/service.ts` — filtered reads, full lifecycle commands, activity presentation, and focused note service composition.
- Modify `server/src/modules/job-cards/handlers.ts` — exact list/board/note/activity queries, exact command bodies, and fixed note `201` response.
- Modify `server/src/modules/job-cards/routes.ts` — board, plan, resume, cancel, notes, and paginated activity routes.
- Modify `server/src/app.ts` and `server/src/index.ts` only where note/workspace dependencies require composition changes.

### Web

- Create `web/src/AppShell.tsx` — desktop sidebar and focus-managed compact navigation drawer.
- Create `web/src/jobs/jobs-api.ts` — runtime-validated list, board, note, activity, and lifecycle transport.
- Create `web/src/jobs/job-search.ts` — canonical URL parsing and list/board/status transitions.
- Create `web/src/jobs/job-labels.ts` — exhaustive known event/status/priority presentation and safe unknown-event fallback.
- Create `web/src/jobs/JobFilters.tsx` — accessible URL-owned filters and mobile disclosure.
- Create `web/src/jobs/JobRow.tsx` — compact/expanded structured row and permitted list commands.
- Create `web/src/jobs/JobList.tsx` — paginated list and explicit result states.
- Create `web/src/jobs/JobBoard.tsx` — desktop-only five-column read projection whose cards only open detail.
- Create `web/src/jobs/JobWorkspace.tsx` — URL state, breakpoint canonicalization, request ownership, quick views, and list/board composition.
- Create `web/src/jobs/JobNotes.tsx` — independent append/read states and same-action retry.
- Create `web/src/jobs/JobTimeline.tsx` — independent paginated activity states and safe presentation.
- Modify `web/src/App.tsx` — keep identity/session ownership and remove global JobCard workspace loading.
- Modify `web/src/AppRouter.tsx` — compose the shell and canonical Jobs/detail routes.
- Modify `web/src/JobDetail.tsx` — independent base/delivery/notes/activity loading and all named lifecycle actions.
- Modify `web/src/services/api.ts` — retain shared request/error primitives and remove superseded JobCard transport definitions after consumers migrate.
- Modify `web/src/styles.css` — shell, list, board, detail sections, drawer/dialog focus, responsive/reflow, and reduced-motion styles.

### Tests and documentation

- Create server tests `job-card-workspace-schema.test.ts`, `job-card-workspace-query.test.ts`, `job-card-workspace-repository.test.ts`, `job-card-board.test.ts`, `job-card-activity.test.ts`, `job-card-notes.test.ts`, and `job-card-workspace-postgres.test.ts`.
- Modify server tests `job-card-policy.test.ts`, `job-card-service.test.ts`, `job-card-lifecycle-service.test.ts`, `job-card-crud-service.test.ts`, `job-card-routes.test.ts`, `delivery-item-service.test.ts`, `delivery-schema.test.ts`, `migrate-runner.test.ts`, and `app.test.ts` as their contracts change.
- Create web tests `jobs-api.test.ts`, `job-search.test.ts`, `app-shell.test.tsx`, `job-list.test.tsx`, `job-board.test.tsx`, `job-notes.test.tsx`, and `job-timeline.test.tsx`.
- Modify web tests `App.test.tsx`, `router.test.tsx`, `workspace-view.test.tsx`, `job-detail.test.tsx`, `manager-review.test.tsx`, `tracer-client.test.ts`, and `accessibility-contract.test.ts`.
- Update `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `DECISIONS.md`, `DESIGN.md`, and `README.md` only after verified implementation behavior exists.

---

## Checkpoint 07A — Schema and Canonical Read Models

### Task 1: Migration 006 and database invariants

**Files:**
- Create: `server/src/db/migrations/006_jobcard_workspace.sql`
- Create: `server/tests/job-card-workspace-schema.test.ts`
- Modify: `server/tests/migrate-runner.test.ts`
- Modify: `server/tests/delivery-schema.test.ts`

**Interfaces:**
- Produces `job_card_notes` with organization-scoped foreign keys.
- Produces the exact workspace indexes and named lifecycle checks from the approved spec.
- Leaves migration 002 activity vocabulary unchanged because it already contains all 14 events.

- [ ] **Step 1: Write the failing file-contract test**

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/006_jobcard_workspace.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('006 JobCard workspace migration', () => {
  it('creates organization-owned append-only notes', () => {
    expect(sql).toMatch(/CREATE TABLE job_card_notes/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, job_card_id\)[\s\S]*job_cards \(organization_id, id\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, author_id\)[\s\S]*users \(organization_id, id\)/i);
    expect(sql).not.toMatch(/UPDATE job_card_notes|DELETE FROM job_card_notes/i);
  });

  it('adds deterministic read indexes and lifecycle checks', () => {
    expect(sql).toMatch(/job_card_notes \(job_card_id, created_at DESC, id DESC\)/i);
    expect(sql).toMatch(/job_cards \(organization_id, updated_at DESC, id DESC\)/i);
    expect(sql).toMatch(/staff_completed_at ASC, id ASC[\s\S]*WAITING_APPROVAL/i);
    expect(sql).toContain('job_cards_planned_status_timestamp_check');
    expect(sql).toContain('job_cards_started_status_timestamp_check');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/job-card-workspace-schema.test.ts`
Expected: FAIL because migration 006 does not exist.

- [ ] **Step 3: Add the migration**

```sql
CREATE TABLE job_card_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  author_id UUID NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_id)
    REFERENCES users (organization_id, id)
);

CREATE INDEX job_card_notes_job_time_idx
  ON job_card_notes (job_card_id, created_at DESC, id DESC);
CREATE INDEX job_cards_organization_updated_idx
  ON job_cards (organization_id, updated_at DESC, id DESC);
CREATE INDEX job_cards_waiting_approval_idx
  ON job_cards (organization_id, staff_completed_at ASC, id ASC)
  WHERE status = 'WAITING_APPROVAL';

ALTER TABLE job_cards ADD CONSTRAINT job_cards_planned_status_timestamp_check
  CHECK (status <> 'PLANNED' OR planned_at IS NOT NULL);
ALTER TABLE job_cards ADD CONSTRAINT job_cards_started_status_timestamp_check
  CHECK (status NOT IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED')
    OR started_at IS NOT NULL);
```

Place this guard before both `ALTER TABLE` statements; do not rewrite historical rows:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_cards WHERE status = 'PLANNED' AND planned_at IS NULL) THEN
    RAISE EXCEPTION 'Cannot add planned timestamp constraint: invalid JobCard rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM job_cards
    WHERE status IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED')
      AND started_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add started timestamp constraint: invalid JobCard rows exist';
  END IF;
END $$;
```

- [ ] **Step 4: Add a PostgreSQL migration test**

With `TEST_DATABASE_URL`, apply migrations 001–006, insert a note with matching organization references, reject a cross-organization author/job pair, reject whitespace-only text, and verify the planned/started checks. Assert migrations 001–005 checksums/files remain unchanged in the repository diff.

- [ ] **Step 5: Verify GREEN and migration copying**

Run: `cd server && npm test -- --run tests/job-card-workspace-schema.test.ts tests/delivery-schema.test.ts tests/migrate-runner.test.ts && npm run build`
Expected: schema contracts pass; PostgreSQL cases skip cleanly without `TEST_DATABASE_URL`; build copies migration 006.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations/006_jobcard_workspace.sql server/tests/job-card-workspace-schema.test.ts server/tests/migrate-runner.test.ts server/tests/delivery-schema.test.ts
git commit -m "feat: add JobCard workspace schema"
```

### Task 2: Shared validation and exact workspace query contracts

**Files:**
- Create: `server/src/modules/job-cards/validation.ts`
- Create: `server/src/modules/job-cards/workspace-query.ts`
- Create: `server/tests/job-card-workspace-query.test.ts`
- Modify: `server/src/modules/job-cards/types.ts`

**Interfaces:**

```ts
export type JobCardStatusFilter = JobCardStatus | 'active' | 'closed' | 'all';
export type JobCardBaseFilters = {
  q: string | null;
  type: 'PRODUCT_DELIVERY' | null;
  assignedTo: string | null;
  customerId: string | null;
  priority: JobCardPriority | null;
  dueBefore: string | null;
  dueAfter: string | null;
};
export type JobCardWorkspaceFilters = JobCardBaseFilters & { status: JobCardStatusFilter };
export type JobCardListQuery = JobCardWorkspaceFilters & { limit: number; offset: number };
export type JobCardBoardQuery = JobCardBaseFilters & { limit: number };

export function parseJobCardListQuery(raw: unknown): JobCardListQuery;
export function parseJobCardBoardQuery(raw: unknown): JobCardBoardQuery;
export function requireActionId(value: unknown): string;
export function optionalLifecycleNote(value: unknown): string | null;
export function requireLifecycleReason(value: unknown, field: string): string;
```

- [ ] **Step 1: Write failing table-driven parser tests**

Cover defaults, every allowed key, repeated scalar rejection, unknown-key rejection, exact status values, `PRODUCT_DELIVERY` only, four priorities, valid UUID filters, whitespace query omission, 1/200/201-code-point query boundaries, `YYYY-MM-DD` round-trip validation, timestamp rejection, inclusive due bounds, reversed-bound rejection, limit 1/100/101, and non-negative offset.

```ts
it.each([
  [{}, { status: 'active', q: null, type: null, priority: null, limit: 25, offset: 0 }],
  [{ q: '  Klinik  ' }, { q: 'Klinik' }],
  [{ type: 'PRODUCT_DELIVERY', priority: 'urgent' }, { type: 'PRODUCT_DELIVERY', priority: 'urgent' }],
])('parses list query %j', (raw, expected) => {
  expect(parseJobCardListQuery(raw)).toMatchObject(expected);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-workspace-query.test.ts`
Expected: FAIL because the validation/query modules do not exist.

- [ ] **Step 3: Implement shared bounded text/date helpers**

```ts
export const codePointLength = (value: string) => Array.from(value).length;

export function boundedTrimmedString(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw validation(field);
  const trimmed = value.trim();
  const length = codePointLength(trimmed);
  if (length < min || length > max) throw validation(field);
  return trimmed;
}

export function isoDate(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validation(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw validation(field);
  return value;
}
```

Use one exact-key helper that rejects array/repeated values. `parseJobCardBoardQuery` accepts only `q,type,assignedTo,customerId,priority,dueBefore,dueAfter,limit` and rejects `status`/`offset`.

- [ ] **Step 4: Complete canonical types**

Add the missing events `JOB_PLANNED`, `JOB_RESUMED`, `JOB_CANCELLED`, and `NOTE_ADDED`. Expand `LifecycleCommand` to `PLAN | START | SUBMIT_FOR_APPROVAL | APPROVE | REQUEST_REVISION | RESUME | CANCEL`. Define `JobCardListItem`, paginated DTOs, board DTO, note DTO, internal activity record, public activity details, and public activity DTO exactly as the spec.

- [ ] **Step 5: Verify GREEN and build**

Run: `cd server && npm test -- --run tests/job-card-workspace-query.test.ts tests/job-card-policy.test.ts && npm run build`
Expected: parser/type tests and TypeScript build pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/job-cards/validation.ts server/src/modules/job-cards/workspace-query.ts server/src/modules/job-cards/types.ts server/tests/job-card-workspace-query.test.ts
git commit -m "feat: define JobCard workspace contracts"
```

### Task 3: Canonical paginated JobCard list projection

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Create: `server/tests/job-card-workspace-repository.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`
- Modify: `server/tests/job-card-crud-service.test.ts`

**Interfaces:**

```ts
export type JobCardReadScope = { organizationId: string; assignedTo: string | null };

listJobCards(scope: JobCardReadScope, query: JobCardListQuery): Promise<Paginated<JobCardListItem>>;
list(actor: JobCardActor, query: JobCardListQuery): Promise<Paginated<JobCardListItem>>;
```

- [ ] **Step 1: Write failing repository projection tests**

Assert organization predicate, unconditional Staff assignee predicate, Manager/Admin optional assignee filter, active/closed/all/exact status expansion, title/Customer/Contact search only, all filters, inclusive due dates, deterministic default ordering, approval ordering, related names, delivery item count, no mixed-unit sum, and total independent of limit/offset.

- [ ] **Step 2: Write failing route tests**

Assert `GET /api/job-cards` passes the parsed query to service and returns exactly `{ items,total,limit,offset }`. Unknown/repeated query keys and invalid values return `400 VALIDATION_ERROR`. Staff `assignedTo=other-user` returns an empty scoped page and never removes the authenticated assignee predicate.

- [ ] **Step 3: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-workspace-repository.test.ts tests/job-card-routes.test.ts`
Expected: FAIL because list pagination/projection is not implemented.

- [ ] **Step 4: Implement one shared SQL filter builder**

```ts
type SqlFilter = { clause: string; values: unknown[] };

function workspaceWhere(
  scope: JobCardReadScope,
  filters: JobCardBaseFilters & { status?: JobCardStatusFilter },
): SqlFilter {
  const predicates = ['j.organization_id = $1'];
  const values: unknown[] = [scope.organizationId];
  const add = (sql: (position: number) => string, value: unknown) => {
    values.push(value); predicates.push(sql(values.length));
  };
  if (scope.assignedTo) add((p) => `j.assigned_to = $${p}`, scope.assignedTo);
  if (filters.assignedTo) add((p) => `j.assigned_to = $${p}`, filters.assignedTo);
  if (filters.type) add((p) => `j.type = $${p}`, filters.type);
  if (filters.customerId) add((p) => `j.customer_id = $${p}`, filters.customerId);
  if (filters.priority) add((p) => `j.priority = $${p}`, filters.priority);
  if (filters.dueAfter) add((p) => `j.due_date >= $${p}::date`, filters.dueAfter);
  if (filters.dueBefore) add((p) => `j.due_date <= $${p}::date`, filters.dueBefore);
  const statuses = statusValues(filters.status ?? 'all');
  if (statuses) add((p) => `j.status = ANY($${p}::varchar[])`, statuses);
  if (filters.q) {
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&');
    add((p) => `(j.title ILIKE $${p} ESCAPE '\\' OR c.name ILIKE $${p} ESCAPE '\\' OR ct.name ILIKE $${p} ESCAPE '\\')`, `%${escaped}%`);
  }
  return { clause: predicates.join(' AND '), values };
}
```

`statusValues` returns the five active statuses for `active`, the two terminal statuses for
`closed`, `null` for `all`, and a one-element array for an exact status. The list query
joins `customers c` and `contacts ct` before applying this clause.

Use the same filter object for a count query and item query. Project Customer, Contact, assignee, timestamps, and a correlated/grouped `deliveryItemCount`. Default order is `j.updated_at DESC,j.id DESC`; exact `WAITING_APPROVAL` uses `j.staff_completed_at ASC,j.id ASC`.

- [ ] **Step 5: Enforce service-owned visibility**

```ts
const scope = {
  organizationId: actor.organizationId,
  assignedTo: actor.role === 'STAFF' ? actor.id : null,
};
```

For Staff, preserve their server scope regardless of the client filter. When a different `assignedTo` is supplied, return an empty page without querying an expanded scope. Manager/Admin forward the validated optional assignee filter.

- [ ] **Step 6: Verify GREEN and regression build**

Run: `cd server && npm test -- --run tests/job-card-workspace-repository.test.ts tests/job-card-routes.test.ts tests/job-card-crud-service.test.ts && npm run build`
Expected: list projection, scope, route, and existing CRUD tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts server/src/modules/job-cards/handlers.ts server/tests/job-card-workspace-repository.test.ts server/tests/job-card-routes.test.ts server/tests/job-card-crud-service.test.ts
git commit -m "feat: add paginated JobCard workspace list"
```

### Task 4: Desktop board read projection

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Create: `server/tests/job-card-board.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**

```ts
listBoard(scope: JobCardReadScope, query: JobCardBoardQuery): Promise<JobCardBoard>;
board(actor: JobCardActor, query: JobCardBoardQuery): Promise<JobCardBoard>;
```

- [ ] **Step 1: Write failing board parity tests**

For identical scope and non-status filters, assert every board item equals the canonical list-item projection, active column counts are pre-limit totals, each column contains at most `limit`, ordering is updated/id descending, and completed/cancelled appear only in `closedCounts`.

- [ ] **Step 2: Write failing route contract tests**

Assert `GET /api/job-cards/board` is registered before `/:id`, uses exact board keys, defaults limit 25, rejects status/offset, and applies Staff/organization scope.

- [ ] **Step 3: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-board.test.ts tests/job-card-routes.test.ts`
Expected: FAIL because the board repository/service/route does not exist.

- [ ] **Step 4: Implement board grouping over shared predicates/projection**

Reuse `workspaceWhere` and the `JobCardListItem` mapper. Query filtered active rows with `ROW_NUMBER() OVER (PARTITION BY status ORDER BY updated_at DESC,id DESC)` and return only rows at or below the per-column limit. Compute grouped active and closed counts before limiting. Initialize all five active keys even when empty.

- [ ] **Step 5: Verify GREEN**

Run: `cd server && npm test -- --run tests/job-card-board.test.ts tests/job-card-workspace-repository.test.ts tests/job-card-routes.test.ts && npm run build`
Expected: board/list parity, route validation, and build pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts server/src/modules/job-cards/handlers.ts server/src/modules/job-cards/routes.ts server/tests/job-card-board.test.ts server/tests/job-card-routes.test.ts
git commit -m "feat: add JobCard board projection"
```

---

## Checkpoint 07B — Complete Lifecycle, Safe Activity, and Notes

### Task 5: Complete lifecycle state machine and persistence

**Files:**
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Modify: `server/tests/job-card-policy.test.ts`
- Modify: `server/tests/job-card-service.test.ts`
- Modify: `server/tests/job-card-lifecycle-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`
- Modify: `server/tests/job-card-crud-service.test.ts`

**Interfaces:**

```ts
type LifecycleInput = { clientActionId: string; expectedVersion: number; note?: string };
type RevisionInput = LifecycleInput & { revisionReason: string };
type CancelInput = LifecycleInput & { cancelReason: string };

plan(actor, id, input): Promise<JobCard>;
start(actor, id, input): Promise<JobCard>;
submitForApproval(actor, id, input): Promise<JobCard>;
approve(actor, id, input): Promise<JobCard>;
requestRevision(actor, id, input): Promise<JobCard>;
resume(actor, id, input): Promise<JobCard>;
cancel(actor, id, input): Promise<JobCard>;
```

- [ ] **Step 1: Expand failing policy matrix tests**

Use table-driven cases for every allowed source/command/role combination and representative rejected combinations. Assert Staff own-only plan/start/submit/resume, Staff cancel/approve/revision denial, Manager/Admin organization commands, required reasons, and terminal-state denial.

- [ ] **Step 2: Add failing service/idempotency tests**

Assert action IDs at 1/255/256 code points, lifecycle text boundaries, expected-version conflicts, action-in-progress behavior, completed replay, one version increment, one named event, rollback on policy/repository failure, `plannedAt`, first `startedAt`, resume preservation, cancel fields, and revision history semantics.

- [ ] **Step 3: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-service.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts`
Expected: FAIL for missing plan/resume/cancel and incomplete validation/events.

- [ ] **Step 4: Consolidate lifecycle execution without changing public commands**

```ts
type LifecycleDefinition = {
  command: LifecycleCommand;
  operationKey: string;
  target: JobCardStatus;
  event: JobCardActivityEvent;
  note: string | null;
  revisionReason: string | null;
  cancelReason: string | null;
};
```

Validate inputs before entering the transaction, then claim processed action, lock JobCard, compare version, apply policy, perform command-specific readiness, transition/version, append exactly one event, persist response, and commit.

- [ ] **Step 5: Implement first-start-safe transition SQL**

Use `planned_at = CASE WHEN target='PLANNED' THEN occurredAt ELSE planned_at END` and `started_at = CASE WHEN command='START' THEN COALESCE(started_at,occurredAt) ELSE started_at END`. Resume never writes `started_at`. Write cancellation fields only for cancel. Preserve latest revision columns across resume and replace them only on the next revision request.

- [ ] **Step 6: Fix the existing JobCard patch SQL under a regression test**

Add a PostgreSQL/query-double regression proving `updateFieldsWithVersion` contains one `WHERE` clause and executes a versioned patch. Remove the duplicated `WHERE organization_id...` currently present; make no other CRUD refactor.

- [ ] **Step 7: Register exact command handlers/routes**

`plan/start/resume` accept only action ID and expected version. Submit/approve also accept optional note. Revision/cancel accept their required reason. Unknown fields return validation errors. Register all seven named endpoints and no generic transition route.

- [ ] **Step 8: Verify GREEN and regression suites**

Run: `cd server && npm test -- --run tests/job-card-policy.test.ts tests/job-card-service.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts tests/job-card-crud-service.test.ts tests/delivery-item-service.test.ts && npm run build`
Expected: complete lifecycle, CRUD regression, delivery invariants, and build pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/job-cards server/tests/job-card-policy.test.ts server/tests/job-card-service.test.ts server/tests/job-card-lifecycle-service.test.ts server/tests/job-card-routes.test.ts server/tests/job-card-crud-service.test.ts server/tests/delivery-item-service.test.ts
git commit -m "feat: complete JobCard lifecycle"
```

### Task 6: Safe paginated activity projection

**Files:**
- Create: `server/src/modules/job-cards/activity-presenter.ts`
- Create: `server/tests/job-card-activity.test.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**

```ts
export function presentActivity(record: ActivityRecord): JobCardActivityDto;
listActivity(organizationId: string, jobCardId: string, page: PageQuery): Promise<Paginated<ActivityRecord>>;
listActivity(actor: JobCardActor, jobCardId: string, page: PageQuery): Promise<Paginated<JobCardActivityDto>>;
```

- [ ] **Step 1: Write failing presenter tests for all 14 events**

Assert lifecycle `STATUS_TRANSITION`, assigned/field updates `FIELDS_UPDATED`, delivery operation/details, note ID only, created `NONE`, malformed persisted values falling to `NONE`, and absence of raw JSONB/note text from serialized DTOs.

- [ ] **Step 2: Write failing read/route tests**

Assert exact `limit/offset` query keys, defaults 50/0, range 1–100, actor name projection, nullable actor, total, Staff visibility, organization scope, and `created_at DESC,id DESC` ordering.

- [ ] **Step 3: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-activity.test.ts tests/job-card-routes.test.ts`
Expected: FAIL because activity is raw, ascending, and unpaginated.

- [ ] **Step 4: Implement allowlisted presenter and read query**

Read internal activity columns plus actor name with a left join. Never spread the row into the DTO. Validate each field by event and return only `{ id,jobCardId,eventType,actor,details,createdAt }`. Use the existing activity index through a backward scan.

- [ ] **Step 5: Verify GREEN**

Run: `cd server && npm test -- --run tests/job-card-activity.test.ts tests/job-card-routes.test.ts tests/job-card-lifecycle-service.test.ts && npm run build`
Expected: all event projection, pagination, lifecycle, and build checks pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/job-cards/activity-presenter.ts server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts server/src/modules/job-cards/handlers.ts server/tests/job-card-activity.test.ts server/tests/job-card-routes.test.ts
git commit -m "feat: add safe JobCard activity timeline"
```

### Task 7: Append-only operational notes

**Files:**
- Create: `server/src/modules/job-cards/notes-service.ts`
- Create: `server/tests/job-card-notes.test.ts`
- Modify: `server/src/modules/job-cards/policy.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/src/modules/job-cards/routes.ts`
- Modify: `server/tests/job-card-routes.test.ts`

**Interfaces:**

```ts
type CreateNoteInput = { clientActionId: string; note: string };

listNotes(actor: JobCardActor, jobCardId: string, page: PageQuery): Promise<Paginated<JobCardNoteDto>>;
addNote(actor: JobCardActor, jobCardId: string, input: CreateNoteInput): Promise<JobCardNoteDto>;
```

- [ ] **Step 1: Write failing note policy/service tests**

Cover Staff assigned-only read/append, Manager/Admin organization scope, hidden 404, every JobCard status including waiting/completed/cancelled, 1/4,000/4,001-code-point text, action ID limits, no expected version, no JobCard version bump, same-action replay, in-progress duplicate, concurrent different actions, canonical author DTO, and absence of note update/delete methods from the public repository/service contract.

- [ ] **Step 2: Write failing atomicity tests**

With a transaction double and PostgreSQL-gated case, force activity insert failure after note insert and assert both roll back. Repeat a completed action ID and assert one note, one `NOTE_ADDED`, metadata `{ noteId }`, and no note text in activity persistence.

- [ ] **Step 3: Write failing route tests**

Assert exact note query/body keys, list defaults 25/0, deterministic newest-first order, first append `201`, completed replay `201` with identical DTO, and in-progress `409 ACTION_IN_PROGRESS`.

- [ ] **Step 4: Run and verify RED**

Run: `cd server && npm test -- --run tests/job-card-notes.test.ts tests/job-card-routes.test.ts`
Expected: FAIL because note persistence/service/routes do not exist.

- [ ] **Step 5: Implement transaction-owned append**

Claim operation `JOB_NOTE_ADD`, lock/read the JobCard only to enforce visibility without comparing or incrementing version, insert the note, append `NOTE_ADDED` with metadata only, store the Note DTO, and commit. The handler always sends `reply.code(201)` for completed and replay results; do not generalize processed-action HTTP status handling.

- [ ] **Step 6: Implement paginated note reads**

Join author name, scope by organization/job, order `created_at DESC,id DESC`, return `{ items,total,limit,offset }`, and expose no single-note/update/delete route or repository method. Do not add a database trigger; append-only is an application-contract guarantee.

- [ ] **Step 7: Verify GREEN and Checkpoint 07B**

Run: `cd server && npm test -- --run tests/job-card-notes.test.ts tests/job-card-activity.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts && npm run build`
Expected: notes, activity, lifecycle, routes, and build pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/job-cards/notes-service.ts server/src/modules/job-cards/policy.ts server/src/modules/job-cards/repository.ts server/src/modules/job-cards/service.ts server/src/modules/job-cards/handlers.ts server/src/modules/job-cards/routes.ts server/tests/job-card-notes.test.ts server/tests/job-card-routes.test.ts
git commit -m "feat: add append-only JobCard notes"
```

---

## Checkpoint 07C — Responsive JobCard Workspace

### Task 8: Web transport, canonical URL state, and labels

**Files:**
- Create: `web/src/jobs/jobs-api.ts`
- Create: `web/src/jobs/job-search.ts`
- Create: `web/src/jobs/job-labels.ts`
- Create: `web/tests/jobs-api.test.ts`
- Create: `web/tests/job-search.test.ts`
- Modify: `web/src/services/api.ts`
- Modify: `web/tests/tracer-client.test.ts`

**Interfaces:**

```ts
export type JobSearchState = {
  q?: string; status?: JobCardStatusFilter; type?: 'PRODUCT_DELIVERY';
  assignedTo?: string; customerId?: string; priority?: JobCardPriority;
  dueBefore?: string; dueAfter?: string; view: 'list' | 'board'; offset: number;
};

export function parseJobSearch(params: URLSearchParams): JobSearchState;
export function enterBoard(current: URLSearchParams): URLSearchParams;
export function selectStatus(current: URLSearchParams, status: JobCardStatusFilter): URLSearchParams;
export function forceMobileList(current: URLSearchParams): URLSearchParams;
```

- [ ] **Step 1: Write failing API parser tests**

Cover runtime validation for paginated list/notes/activity, board columns/counts, related names, technical version transport, all commands, fixed note `201`, unknown event `eventType: string`, known details parsing, malformed response rejection, and no raw activity JSONB fields.

- [ ] **Step 2: Write failing URL transition tests**

Assert defaults; invalid values canonicalize; filter changes reset offset; enter-board removes status/offset and preserves non-status filters; board status selection writes list/status/offset zero; mobile force-list preserves filters; desktop resize does not restore board.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/jobs-api.test.ts tests/job-search.test.ts tests/tracer-client.test.ts`
Expected: FAIL because focused jobs transport/search modules do not exist.

- [ ] **Step 4: Implement runtime-validated transport**

Move JobCard-specific types/functions out of shared `services/api.ts` only after every import is updated. Reuse `request`, `json`, `object`, `string`, `number`, and nullable helpers. Parse server activity event as a string; `job-labels.ts` narrows known values against the canonical 14-value tuple and otherwise returns `İş kaydında bir işlem yapıldı` without throwing.

- [ ] **Step 5: Implement canonical URL helpers**

Use a fixed allowed-key tuple. Emit no default `status=active`, `view=list`, or `offset=0` unless a transition explicitly requires the value. `enterBoard` deletes status/offset. `selectStatus` sets view list and offset zero. `forceMobileList` replaces only view.

- [ ] **Step 6: Verify GREEN and build**

Run: `cd web && npm test -- --run tests/jobs-api.test.ts tests/job-search.test.ts tests/tracer-client.test.ts && npm run build`
Expected: transport, URL, legacy client migration, and build pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/jobs/jobs-api.ts web/src/jobs/job-search.ts web/src/jobs/job-labels.ts web/src/services/api.ts web/tests/jobs-api.test.ts web/tests/job-search.test.ts web/tests/tracer-client.test.ts
git commit -m "feat: add JobCard workspace web contracts"
```

### Task 9: Responsive authenticated app shell

**Files:**
- Create: `web/src/AppShell.tsx`
- Create: `web/tests/app-shell.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/App.test.tsx`
- Modify: `web/tests/router.test.tsx`
- Modify: `web/tests/accessibility-contract.test.ts`

**Interfaces:**

```ts
type AppShellProps = {
  user: CurrentUser;
  pendingSignOut: boolean;
  onSignOut: () => void;
  children: ReactNode;
};
```

- [ ] **Step 1: Write failing role/navigation tests**

Assert desktop destinations, Staff `Profilim`, Manager/Admin `Personel`, Admin-only `Kullanıcılar`, `aria-current`, identity/logout, and that frontend route hiding does not replace backend authorization tests.

- [ ] **Step 2: Write failing drawer/focus tests**

Assert a 44-pixel menu trigger, labelled modal drawer, focus to heading/first link, Tab/Shift+Tab containment, Escape close, route-selection close, trigger focus restoration, and no narrow desktop sidebar markup at compact widths.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/app-shell.test.tsx tests/App.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts`
Expected: FAIL because the shell is still header plus horizontal section links.

- [ ] **Step 4: Extract shell without moving identity ownership**

Keep login/session/password-change/reload behavior in `App.tsx`. Render `AppShell` only for authenticated, password-complete users. Use semantic `<aside><nav>` for desktop and a button-controlled `role="dialog" aria-modal="true"` drawer for compact navigation. Implement focus containment/restoration with refs and keydown cleanup; add no dialog dependency.

- [ ] **Step 5: Add shell CSS and reduced-motion behavior**

At `min-width:64rem`, use sidebar plus main-content grid. Below it, hide sidebar from layout and show compact header/drawer. Maintain 44-pixel controls, visible focus, no page overflow, and instant drawer changes under reduced motion.

- [ ] **Step 6: Verify GREEN**

Run: `cd web && npm test -- --run tests/app-shell.test.tsx tests/App.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts && npm run build`
Expected: shell roles, focus, responsive contracts, and build pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/AppShell.tsx web/src/App.tsx web/src/AppRouter.tsx web/src/styles.css web/tests/app-shell.test.tsx web/tests/App.test.tsx web/tests/router.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: add responsive application shell"
```

### Task 10: URL-owned structured JobCard list

**Files:**
- Create: `web/src/jobs/JobFilters.tsx`
- Create: `web/src/jobs/JobRow.tsx`
- Create: `web/src/jobs/JobList.tsx`
- Create: `web/src/jobs/JobWorkspace.tsx`
- Create: `web/tests/job-list.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/workspace-view.test.tsx`
- Modify: `web/tests/router.test.tsx`

**Interfaces:**
- `JobWorkspace` owns `useSearchParams`, role-aware list requests, quick views, pagination, and request cancellation/stale suppression.
- `JobList` renders only the server projection and emits navigation/command intents.
- `JobRow` keeps technical version in command callbacks but never renders it.

- [ ] **Step 1: Write failing list state/presentation tests**

Cover loading, empty organization, no results, error, forbidden, retry, status/priority text, title, Customer, optional Contact, assignee, due date, delivery item count, technical version hidden, and correct paginated range/actions.

- [ ] **Step 2: Write failing URL/filter/expanded-row tests**

Cover exact filter controls, URL initialization, filter update offset reset, Back/Forward-compatible query keys, quick active/approval/revision views, approval oldest-first copy, expanded summary content, permitted named commands, and detail link.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/job-list.test.tsx tests/workspace-view.test.tsx tests/router.test.tsx`
Expected: FAIL because the old workspace uses global unpaginated data and client-side approval filtering.

- [ ] **Step 4: Implement independent workspace loading**

Remove global `listJobCards` loading from `ProtectedShell`. `JobWorkspace` parses URL state, requests `listJobCards`, ignores stale responses, and renders explicit states. Approval and revision quick links navigate to canonical list queries rather than filtering loaded rows.

- [ ] **Step 5: Implement accessible filters/list/expansion**

Use labelled native controls and a mobile disclosure. Search submission trims input; frontend mirrors limits but server remains authoritative. Render semantic lists/articles. Expansion uses a button with `aria-expanded`/`aria-controls`, includes the locked fields/actions, and retains a full-detail link.

- [ ] **Step 6: Add responsive structured-list styles**

Desktop uses aligned structured rows without dense ERP typography. Mobile stacks fields, wraps status links, keeps actions at least 44 pixels, and avoids page-level horizontal overflow. Status uses text plus shape/icon.

- [ ] **Step 7: Verify GREEN and regression build**

Run: `cd web && npm test -- --run tests/job-list.test.tsx tests/workspace-view.test.tsx tests/router.test.tsx tests/App.test.tsx tests/accessibility-contract.test.ts && npm run build`
Expected: canonical list, URL, expansion, shell integration, accessibility, and build pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/jobs/JobFilters.tsx web/src/jobs/JobRow.tsx web/src/jobs/JobList.tsx web/src/jobs/JobWorkspace.tsx web/src/App.tsx web/src/AppRouter.tsx web/src/styles.css web/tests/job-list.test.tsx web/tests/workspace-view.test.tsx web/tests/router.test.tsx web/tests/App.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: add structured JobCard workspace list"
```

### Task 11: Read-only desktop board and mobile forced list

**Files:**
- Create: `web/src/jobs/JobBoard.tsx`
- Create: `web/tests/job-board.test.tsx`
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/jobs/JobFilters.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-search.test.ts`
- Modify: `web/tests/accessibility-contract.test.ts`

- [ ] **Step 1: Write failing board semantics tests**

Assert five active labelled columns, counts, closed-count links, list-item projection fields, detail-only links, and absence of buttons/menus/draggable attributes/drag instructions/lifecycle callbacks.

- [ ] **Step 2: Write failing responsive request tests**

Stub `matchMedia`. Assert desktop `view=board` requests board without status/offset, entering board canonicalizes URL, status selection returns to list, compact viewport replaces view and never calls board, in-flight board data is ignored after compact transition, and later desktop resize does not restore board.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/job-board.test.tsx tests/job-search.test.ts tests/accessibility-contract.test.ts`
Expected: FAIL because board and breakpoint canonicalization do not exist.

- [ ] **Step 4: Implement desktop board composition**

Use the same status/priority/list labels and `JobCardListItem` type. Cards contain one `Link` to detail. Column overflow and closed counts navigate to list queries. Do not mount hidden board markup on compact layouts.

- [ ] **Step 5: Implement breakpoint canonicalization**

Subscribe to `matchMedia('(min-width: 64rem)')`. When false and URL view is board, call `setSearchParams(forceMobileList(params), { replace: true })`, invalidate the board request generation, and render list. Do not store a remembered desktop view.

- [ ] **Step 6: Verify GREEN**

Run: `cd web && npm test -- --run tests/job-board.test.tsx tests/job-search.test.ts tests/job-list.test.tsx tests/accessibility-contract.test.ts && npm run build`
Expected: read-only board, mobile forced list, list regression, and build pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/jobs/JobBoard.tsx web/src/jobs/JobWorkspace.tsx web/src/jobs/JobFilters.tsx web/src/styles.css web/tests/job-board.test.tsx web/tests/job-search.test.ts web/tests/accessibility-contract.test.ts
git commit -m "feat: add read-only JobCard board"
```

### Task 12: Complete Job detail, notes, timeline, and truth recovery

**Files:**
- Create: `web/src/jobs/JobNotes.tsx`
- Create: `web/src/jobs/JobTimeline.tsx`
- Create: `web/tests/job-notes.test.tsx`
- Create: `web/tests/job-timeline.test.tsx`
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`
- Modify: `web/tests/router.test.tsx`

- [ ] **Step 1: Write failing independent-section tests**

Assert base detail/delivery success remains visible when notes or activity fail; each section has its own loading/empty/error/retry state; pagination is independent; actor/author names render; raw event codes and technical audit fields do not.

- [ ] **Step 2: Write failing notes interaction tests**

Cover persistent label, 1/4,000-code-point validation, remaining count, pending state, successful prepend/clear, ambiguous network result preserving draft/action ID, same-action retry, `ACTION_IN_PROGRESS`, completed/cancelled append, and no lifecycle-field unlock.

- [ ] **Step 3: Write failing lifecycle UI tests**

Cover role/status action visibility for all seven commands, revision/cancel dialogs and 2,000-code-point limits, no optimistic success, pending controls, successful server DTO replacement, version conflict full truth reload, invalid transition reload, safe messages, and focus restoration after dialogs/actions.

- [ ] **Step 4: Write failing event compatibility tests**

Assert every known event has an exhaustive Turkish label/details renderer. Supply an unknown string event and assert `İş kaydında bir işlem yapıldı`, no raw code, no timeline failure, and only non-sensitive development diagnostic input.

- [ ] **Step 5: Run and verify RED**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx tests/job-notes.test.tsx tests/job-timeline.test.tsx tests/router.test.tsx`
Expected: FAIL because detail loading is coupled and notes/full lifecycle/safe timeline are incomplete.

- [ ] **Step 6: Refactor detail into independent request state**

Load base JobCard and delivery items as the core detail state. Mount `JobNotes` and `JobTimeline` with their own effects/retries so either can fail without replacing core content. After lifecycle success, update from server DTO and refresh activity; after conflict/invalid transition, reload backend truth before enabling commands.

- [ ] **Step 7: Implement notes with stable action IDs**

Create one `crypto.randomUUID()` when submission begins and retain it through ambiguous network or in-progress retries. Generate a new ID only after confirmed success or explicit draft replacement. Do not use expected version and do not mutate the displayed JobCard version.

- [ ] **Step 8: Implement dialogs/actions and safe timeline**

Use existing focus-managed dialog patterns with native labelled controls, Escape close, non-destructive initial focus, associated field errors, and trigger restoration. Render activity through `job-labels.ts`; validate known detail discriminants and fall back safely for unknown/malformed presentation.

- [ ] **Step 9: Verify GREEN and Checkpoint 07C**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx tests/job-notes.test.tsx tests/job-timeline.test.tsx tests/job-list.test.tsx tests/job-board.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts && npm run build`
Expected: detail, lifecycle, note, timeline, workspace, accessibility, and build pass.

- [ ] **Step 10: Commit**

```bash
git add web/src/jobs/JobNotes.tsx web/src/jobs/JobTimeline.tsx web/src/JobDetail.tsx web/src/styles.css web/tests/job-notes.test.tsx web/tests/job-timeline.test.tsx web/tests/job-detail.test.tsx web/tests/manager-review.test.tsx web/tests/router.test.tsx
git commit -m "feat: complete JobCard detail workspace"
```

---

## Checkpoint 07D — PostgreSQL, Browser Acceptance, and Closeout

### Task 13: Live integration, accessibility, SSOT, and memory closeout

**Files:**
- Create: `server/tests/job-card-workspace-postgres.test.ts`
- Modify: `.github/workflows/ci.yml` only when the new PostgreSQL test needs an explicit command or browser job.
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `DECISIONS.md`
- Modify: `DESIGN.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-13-jobcard-workspace.md` with exact verified results.

- [ ] **Step 1: Add the end-to-end PostgreSQL contract test before closeout**

With `TEST_DATABASE_URL`, apply migrations 001–006 and verify real list projection/filtering/pagination, Staff concealment, approval sorting, board/list parity, plan/start/submit/approve and revision/resume/cancel flows, first-start preservation, one event per command, note concurrency/replay/rollback/no-version-bump, safe activity ordering, and terminal commercial immutability with note append.

- [ ] **Step 2: Run the full automated gate with PostgreSQL**

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && npm audit --audit-level=high
cd web && npm run build
cd web && npm test -- --run
cd web && npm audit --audit-level=high
```

Expected: every suite/build passes; PostgreSQL-gated tests run against the disposable database; both audits report zero actionable high-severity vulnerabilities. Record exact file/test totals.

- [ ] **Step 3: Run an authenticated disposable-database tracer**

Create a fresh database, migrate, dev-seed with an ephemeral password, and exercise via HTTP plus safe SQL assertions:

1. Staff list is own-assignee only and cannot be widened.
2. Manager list filters/search/pagination and approval ordering match the contract.
3. Board projection matches list items and returns closed counts only.
4. Plan/start/submit/approve and revision/resume/cancel enforce roles, versions, idempotency, timestamps, and one activity each.
5. Two concurrent note appends both succeed; same-action replay creates no duplicate; forced activity failure rolls back note.
6. Completed/cancelled fields reject edits while notes remain appendable.
7. Public activity contains allowlisted details and no raw JSONB/note text.

Stop all processes, remove ephemeral credentials, drop the database, and confirm it no longer exists.

- [ ] **Step 4: Run Playwright MCP acceptance**

Verify Manager desktop and Staff desktop at 1200×800, Staff/Manager mobile at 390×844, and 320 CSS-pixel effective reflow. Cover sidebar/drawer, URL filters, Back/Forward/refresh/deep links, list expansion, read-only board, no mobile board request/overflow, notes, approval/revision/resume/cancel, conflict truth recovery, independent section failures, keyboard-only flow, visible focus, dialog focus, 44-pixel targets, 200% text, applicable 400% reflow, reduced motion, and color-independent status.

- [ ] **Step 5: Update SSOT with verified behavior only**

Record migration 006, canonical list/board contracts, full lifecycle, note rules, safe activity details, responsive shell/workspace, exact error/recovery behavior, test totals, and remaining Slice 08/09 boundaries. Remove the stale optional drag-and-drop wording. Do not claim reports, General Task, notifications, realtime, warehouse, or accounting.

- [ ] **Step 6: Refresh codebase and persistent memory after final code state**

Reindex `server` and `web` with persistence enabled only after all changes and tests are final. Store stable Slice 07 architecture/product decisions and verified completion status. Do not store credentials, ports, temporary database names, browser artifacts, or raw test logs.

- [ ] **Step 7: Review final diff and scope**

```bash
git diff --check
git status --short
rg -n "drag|WebSocket|notification|saved view|GENERAL_TASK|attachment|stock|warehouse|accounting|oldValue|newValue|metadata" server/src web/src SERVORA_MED_*.md DECISIONS.md DESIGN.md README.md
```

Every match must be an explicit rejection/non-goal, internal audit persistence, or safely allowlisted behavior. Confirm no unfinished marker, debug output, generated browser artifact, secret, or unrelated refactor remains.

- [ ] **Step 8: Commit closeout**

```bash
git add .github/workflows/ci.yml SERVORA_MED_API_DRAFT.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_MVP_SLICES.md SERVORA_MED_ARCHITECTURE_PLAN.md DECISIONS.md DESIGN.md README.md docs/superpowers/plans/2026-07-13-jobcard-workspace.md server/tests/job-card-workspace-postgres.test.ts
git commit -m "docs: close JobCard workspace slice"
```

If CI does not require modification, omit `.github/workflows/ci.yml` from the staged set. Commit only files that actually changed.

---

## Coverage Matrix

| Approved requirement | Implementation task |
| --- | --- |
| Migration 006, notes table, indexes, lifecycle checks | Task 1 |
| Exact list/board filters, limits, dates, and canonical types | Task 2 |
| Paginated related-record list projection and approval ordering | Task 3 |
| Shared read-only board projection and closed counts | Task 4 |
| Complete role-aware lifecycle, versions, idempotency, timestamps | Task 5 |
| Safe paginated activity details and actor projection | Task 6 |
| Append-only concurrent notes, fixed 201 replay, no version bump | Task 7 |
| Web transport, unknown-event compatibility, canonical URL helpers | Task 8 |
| Desktop sidebar and compact accessible navigation | Task 9 |
| URL-owned structured list, filters, pagination, expanded rows | Task 10 |
| Detail-only desktop board and mobile forced list | Task 11 |
| Independent detail/notes/timeline, lifecycle UI, truth recovery | Task 12 |
| PostgreSQL, Playwright, accessibility, SSOT, CI, and memory | Task 13 |

## Definition of Done

- [ ] All thirteen tasks and four checkpoints are complete.
- [ ] Migrations 001–005 remain byte-for-byte unchanged and migration 006 applies cleanly.
- [ ] Staff scope cannot be widened by any filter, read endpoint, or mutation.
- [ ] List and board share projection/filter policy; board has no mutation surface and mobile never requests it.
- [ ] All seven lifecycle commands enforce the exact role/state matrix, optimistic version, idempotency, timestamps, and one named activity.
- [ ] Notes are append-only, concurrent, fixed-201 idempotent, version-independent, and available in terminal states.
- [ ] Public activity exposes only allowlisted details; unknown transport events cannot break the timeline.
- [ ] Desktop/mobile workspace and detail meet the approved accessibility and truth-recovery contracts.
- [ ] Full server/web builds, tests, audits, disposable PostgreSQL tracer, and Playwright acceptance pass with recorded evidence.
- [ ] SSOT documents, codebase memory, and persistent memory reflect verified final behavior.
- [ ] Worktree is clean and the branch contains only intentional Slice 07 commits.

Do not begin Slice 08 reports or Slice 09 General Task until this plan closes.
