# Operational Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only Slice 08 operational reporting surface from canonical
PostgreSQL data while preserving organization scope, exact quantities, Staff
attribution, shared People counters, accessible URL-owned report UI, and the approved
non-financial boundary.

**Architecture:** Add a read-only `reports` module whose PostgreSQL read model implements
the canonical `StaffOperationalSummaryPort` and supplies dashboard, Staff, delivery, and
approval summaries. The composition root injects that same read model into People and
Reports, while the existing JobCard repository implements a narrow approval-item port so
the approval queue reuses `JobCardListItem` without a People/Reports runtime cycle. React
uses runtime-validated report clients and stable URL-owned routes; PostgreSQL owns every
calendar boundary and aggregation.

**Tech Stack:** Node.js, Fastify, TypeScript, PostgreSQL, React, React Router,
Vite, Vitest, Playwright.

## Global Constraints

- Reports are read-only.
- Organization identity comes only from the authenticated session.
- Staff attribution uses only `job_cards.assigned_to`.
- Dashboard, Staff, and approval JobCard metrics include every JobCard type.
- Delivery metrics include only `PRODUCT_DELIVERY`.
- Delivery output includes only manager-approved `COMPLETED` records.
- Delivery date is `job_card_delivery_items.delivered_at`.
- Completion date is `job_cards.manager_approved_at`.
- Cancellation date is `job_cards.cancelled_at`.
- Approval age begins at `job_cards.staff_completed_at`.
- Quantities remain exact three-decimal strings.
- Persisted unit values are not normalized.
- Product reports use historical delivery snapshots.
- Revenue, inventory, commission, ranking, and employee scoring are excluded.
- No report table, cache, materialized view, trigger, or scheduled aggregate is added.
- No migration or index is added without disposable-PostgreSQL query-plan evidence and
  a separate user review.
- No chart dependency is added.
- WCAG 2.2 Level AA is a completion requirement.
- The backend aggregates; the frontend never produces business aggregates.
- Existing migrations `001` through `006` are immutable.
- No new runtime dependency is required for this slice.

---

## Starting State and Baseline

- Branch: `feature/slice-08-operational-reports`.
- Approved design commit: `f889dacd804b8fc7987f2c820a7a1bccf2795094`.
- `origin/main`: `8ee5f5992e28e4f7621ce7c3f57fc8cd2a97c899`.
- The approved-design baseline, before the initial plan commit, was zero commits behind
  and three commits ahead of `origin/main`. Commit
  `c08b3a7c6706cd947d060bde104b859fb01f715c` added this plan and made the branch four
  commits ahead. Documentation review commits may increase that count, so execution must
  re-check `git rev-list --left-right --count origin/main...HEAD` instead of treating the
  recorded count as an invariant.
- Worktree is clean; no merge, rebase, or history rewrite is required before execution.
- Baseline server build passed.
- Baseline server suite passed with 38 files passed, 4 PostgreSQL-gated files skipped,
  504 tests passed, and 14 tests skipped.
- Baseline web suite passed with 31 files and 228 tests.
- Baseline web production build passed.
- The repository has no checked-in Playwright package, config, or browser test directory.
  Existing browser acceptance uses Playwright MCP against the running app; Task 13 keeps
  that model and adds no browser dependency.

## File Map

### Server production files

- Create `server/src/modules/reports/types.ts` — exact public DTOs and internal typed
  report inputs.
- Create `server/src/modules/reports/query.ts` — endpoint allowlists, repeated-scalar
  rejection, strict dates, UUIDs, pagination, and group parsing.
- Create `server/src/modules/reports/ports.ts` — `StaffOperationalSummaryPort`, complete
  Reports read-model interface, and narrow approval-item port.
- Create `server/src/modules/reports/repository.ts` — organization-scoped PostgreSQL
  aggregates and exact decimal mapping.
- Create `server/src/modules/reports/service.ts` — role policy, Staff concealment, one
  request time, and response composition.
- Create `server/src/modules/reports/handlers.ts` — HTTP input/output translation only.
- Create `server/src/modules/reports/routes.ts` — five authenticated GET routes.
- Modify `server/src/modules/job-cards/repository.ts` — expose canonical approval items
  through `ApprovalQueueItemPort` while reusing `mapJobCardListItem`.
- Modify `server/src/modules/people/types.ts` — split persisted profile identity from the
  unchanged public profile-with-counters DTO.
- Modify `server/src/modules/people/repository.ts` — remove Staff counter SQL and return
  profile identity only.
- Modify `server/src/modules/people/service.ts` — consume injected `getOne`/`getMany` and
  preserve the existing public counter names.
- Modify `server/src/app.ts` — register Reports and inject the canonical summary port.
- Modify `server/src/index.ts` — construct one `PostgresReportsRepository` and one
  `PostgresJobCardRepository`, then inject them through the composition root.

### Server tests

- Create `server/tests/reports-query.test.ts`.
- Create `server/tests/reports-staff-summary.test.ts`.
- Create `server/tests/reports-dashboard.test.ts`.
- Create `server/tests/reports-staff.test.ts`.
- Create `server/tests/reports-deliveries.test.ts`.
- Create `server/tests/reports-approvals.test.ts`.
- Create `server/tests/reports-service.test.ts`.
- Create `server/tests/reports-routes.test.ts`.
- Create `server/tests/reports-postgres.test.ts`.
- Modify `server/tests/people-counters.test.ts`.
- Modify `server/tests/people-repository.test.ts`.
- Modify `server/tests/people-service.test.ts`.
- Modify `server/tests/people-routes.test.ts`.
- Modify `server/tests/app.test.ts`.
- Modify `server/tests/job-card-workspace-repository.test.ts`.

### Web production files

- Create `web/src/reports/report-types.ts` — exact runtime-facing report types.
- Create `web/src/reports/reports-api.ts` — strict response parsers and request builders.
- Create `web/src/reports/report-search.ts` — canonical URL parsing and replace-state
  decisions.
- Create `web/src/reports/StaffOperationalReport.tsx` — own/management Staff summary.
- Create `web/src/reports/ReportsDashboard.tsx` — counters and completed trend.
- Create `web/src/reports/DeliveryReport.tsx` — grouped exact-quantity report.
- Create `web/src/reports/ApprovalReport.tsx` — age summary and oldest-first queue.
- Modify `web/src/StaffProfiles.tsx` — embed Staff own report and link management profile
  to its report route.
- Modify `web/src/AppRouter.tsx` — register four stable report routes.
- Modify `web/src/AppShell.tsx` — expose `Raporlar` only to Admin and Manager.
- Modify `web/src/paths.ts` — exact report route helpers.
- Modify `web/src/styles.css` — restrained responsive report layouts using existing
  tokens.

### Web tests

- Create `web/tests/reports-api.test.ts`.
- Create `web/tests/report-search.test.ts`.
- Create `web/tests/staff-operational-report.test.tsx`.
- Create `web/tests/reports-dashboard.test.tsx`.
- Create `web/tests/delivery-report.test.tsx`.
- Create `web/tests/approval-report.test.tsx`.
- Create `web/tests/reports-navigation.test.tsx`.
- Create `web/tests/reports-accessibility.test.tsx`.
- Modify `web/tests/people-client.test.ts`.
- Modify `web/tests/staff-profiles.test.tsx`.
- Modify `web/tests/router.test.tsx`.
- Modify `web/tests/app-shell.test.tsx`.
- Modify `web/tests/accessibility-contract.test.ts`.

### Closeout documentation

- Modify `README.md` only after all verification passes.
- Modify `SERVORA_MED_API_DRAFT.md` only after all verification passes.
- Modify `SERVORA_MED_MVP_SLICES.md` only after all verification passes.
- Modify `SERVORA_MED_ARCHITECTURE_PLAN.md` to record the implemented read-model and
  dependency direction only after all verification passes.
- Do not modify `SERVORA_MED_SCHEMA_DRAFT.md`: Slice 08 adds no schema object.
- Do not modify `DECISIONS.md`: DOM-006 already records the durable decision.
- Do not modify `DESIGN.md`: report UI reuses the established tokens and adds no new
  design-system token.

---

### Task 1: Canonical Report Types and Strict Query Parsing

**Files:**
- Create: `server/src/modules/reports/types.ts`
- Create: `server/src/modules/reports/query.ts`
- Create: `server/src/modules/reports/ports.ts`
- Create: `server/tests/reports-query.test.ts`

**Interfaces:**
- Consumes: `JobCardListItem` and `DeliveryPurpose` as type-only imports from
  `server/src/modules/job-cards/types.ts`; `AppError` from
  `server/src/errors/index.ts`.
- Produces: the exact DTOs below; `parseDashboardReportQuery(raw)`,
  `parseStaffReportQuery(raw)`, `parseDeliveryReportQuery(raw)`,
  `parseApprovalReportQuery(raw)`, and `parseStaffReportPathId(raw)`; the exact
  `StaffOperationalSummaryPort`, `ReportsReadModel`, and `ApprovalQueueItemPort`.

- [x] **Step 1: Write failing contract and parser tests**

Create table-driven tests that assert exact defaults, allowed keys, repeated scalar
rejection for every allowed scalar, unknown-key rejection, strict leap dates, paired
ranges, `from <= to`, at most 366 inclusive dates, required group, pagination boundaries,
and the intentionally different Staff path/query UUID errors.

```ts
const validation = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });
const concealed = expect.objectContaining({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });

expect(parseDashboardReportQuery({})).toEqual({ requestedRange: null });
expect(parseDashboardReportQuery({ from: '2024-02-29', to: '2025-02-28' }))
  .toEqual({ requestedRange: { from: '2024-02-29', to: '2025-02-28' } });
expect(() => parseDashboardReportQuery({ from: '2026-07-01' })).toThrowError(validation);
expect(() => parseDashboardReportQuery({ from: ['2026-07-01', '2026-07-01'] }))
  .toThrowError(validation);
expect(() => parseDeliveryReportQuery({ groupBy: 'day', staffUserId: '' }))
  .toThrowError(validation);
expect(() => parseDeliveryReportQuery({ groupBy: 'day', staffUserId: 'bad' }))
  .toThrowError(validation);
expect(() => parseStaffReportPathId('bad')).toThrowError(concealed);
expect(parseApprovalReportQuery({})).toEqual({ limit: 50, offset: 0 });
```

For each endpoint, pass arrays for every scalar it accepts and prove failure occurs before
coercion. Also assert a 367-date inclusive range fails while exactly 366 dates passes.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/reports-query.test.ts`

Expected: FAIL because the Reports contract files do not exist.

- [x] **Step 3: Implement exact DTOs, ports, and parsers**

Define the shared range and summary types exactly once:

```ts
export type RequestedReportRange = Readonly<{ from: string; to: string }> | null;
export type ResolvedReportRange = Readonly<{ from: string; to: string; timezone: string }>;

export type StaffOperationalCounters = Readonly<{
  openJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
  overdueJobCards: number;
  completedInPeriod: number;
}>;

export type StaffOperationalSummary = Readonly<{
  staffUserId: string;
  range: ResolvedReportRange;
  counters: StaffOperationalCounters;
}>;

export type StaffOperationalSummaryScope = Readonly<{
  organizationId: string;
  requestedRange: RequestedReportRange;
  requestTime: Date;
}>;

export type StaffOperationalSummaryOneInput = StaffOperationalSummaryScope &
  Readonly<{ staffUserId: string }>;
export type StaffOperationalSummaryManyInput = StaffOperationalSummaryScope &
  Readonly<{ staffUserIds: readonly string[] }>;
```

Define all public report DTOs, including these exact delivery and approval shapes:

```ts
export type DeliveryDayItem = { date: string; unit: string | null; quantity: string };
export type DeliveryPurposeItem = {
  purpose: DeliveryPurpose;
  unit: string | null;
  quantity: string;
};
export type DeliveryProductItem = {
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  productModelSnapshot: string | null;
  unit: string | null;
  quantity: string;
};
export type DeliveryStaffItem = {
  staff: { userId: string; name: string; isActive: boolean };
  unit: string | null;
  quantity: string;
};

export type DeliveryReportResponse =
  | { groupBy: 'day'; items: DeliveryDayItem[]; range: ResolvedReportRange;
      total: number; limit: number; offset: number }
  | { groupBy: 'purpose'; items: DeliveryPurposeItem[]; range: ResolvedReportRange;
      total: number; limit: number; offset: number }
  | { groupBy: 'product'; items: DeliveryProductItem[]; range: ResolvedReportRange;
      total: number; limit: number; offset: number }
  | { groupBy: 'staff'; items: DeliveryStaffItem[]; range: ResolvedReportRange;
      total: number; limit: number; offset: number };

export type ApprovalItem = JobCardListItem & { waitingMinutes: number };
export type ApprovalSummary = {
  pendingCount: number;
  oldestWaitingMinutes: number | null;
  averageWaitingMinutes: number | null;
  under2Hours: number;
  between2And8Hours: number;
  between8And24Hours: number;
  over24Hours: number;
};
export type ApprovalReportResponse = {
  summary: ApprovalSummary;
  items: ApprovalItem[];
  total: number;
  limit: number;
  offset: number;
};
```

Add the remaining public responses and internal read inputs exactly:

```ts
export type DashboardReportResponse = {
  range: ResolvedReportRange;
  counters: {
    activeJobCards: number;
    overdueJobCards: number;
    waitingApproval: number;
    revisionRequested: number;
    completedInPeriod: number;
    cancelledInPeriod: number;
  };
  completedTrend: Array<{ date: string; count: number }>;
};

export type ReportStaffIdentity = {
  userId: string;
  name: string;
  isActive: boolean;
};

export type StaffReportResponse = {
  staff: ReportStaffIdentity;
  range: ResolvedReportRange;
  counters: StaffOperationalCounters;
  deliveriesByPurpose: DeliveryPurposeItem[];
};

export type ReportRangeQuery = { requestedRange: RequestedReportRange };
export type DeliveryReportQuery = ReportRangeQuery & {
  groupBy: 'day' | 'purpose' | 'product' | 'staff';
  staffUserId: string | null;
  limit: number;
  offset: number;
};
export type ApprovalReportQuery = { limit: number; offset: number };
export type DeliveryReportReadInput = StaffOperationalSummaryScope &
  Omit<DeliveryReportQuery, 'requestedRange'>;
```

Define these exact ports:

```ts
export interface StaffOperationalSummaryPort {
  getOne(input: StaffOperationalSummaryOneInput): Promise<StaffOperationalSummary | null>;
  getMany(input: StaffOperationalSummaryManyInput):
    Promise<ReadonlyMap<string, StaffOperationalSummary>>;
}

export interface ReportsReadModel extends StaffOperationalSummaryPort {
  getDashboard(input: StaffOperationalSummaryScope): Promise<DashboardReportResponse>;
  getStaffIdentity(input: { organizationId: string; staffUserId: string }):
    Promise<ReportStaffIdentity | null>;
  getStaffDeliveriesByPurpose(input: StaffOperationalSummaryOneInput):
    Promise<DeliveryPurposeItem[]>;
  getDeliveryReport(input: DeliveryReportReadInput): Promise<DeliveryReportResponse>;
  getApprovalSummary(input: { organizationId: string; requestTime: Date }):
    Promise<ApprovalSummary>;
}

export interface ApprovalQueueItemPort {
  getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]>;
}
```

Implement parsing with endpoint-specific key sets and reject arrays before any coercion:

```ts
function exactScalarQuery(raw: unknown, allowed: readonly string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('query');
  const value = raw as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key) || Array.isArray(entry)) throw validation(key);
  }
  return value;
}

function requestedRange(value: Record<string, unknown>): RequestedReportRange {
  if (value.from === undefined && value.to === undefined) return null;
  if (typeof value.from !== 'string' || typeof value.to !== 'string') {
    throw validation(value.from === undefined ? 'from' : 'to');
  }
  const from = strictDate(value.from, 'from');
  const to = strictDate(value.to, 'to');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days > 365) throw validation('to');
  return { from, to };
}
```

`strictDate` must require `^\d{4}-\d{2}-\d{2}$`, construct the UTC date, and round-trip
year/month/day. `parseDeliveryReportQuery` requires `groupBy`, defaults to `limit=50` and
`offset=0`, accepts limit 1–200, and treats an omitted `staffUserId` as `null`.
`parseStaffReportPathId` throws `STAFF_PROFILE_NOT_FOUND` for every non-string or malformed
UUID without repository access. Query UUID parsing throws `VALIDATION_ERROR` instead.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-query.test.ts`

Expected: PASS with all DTO compile checks and parser cases green.

- [x] **Step 5: Run related contract regressions**

Run: `cd server && npm test -- --run tests/job-card-workspace-query.test.ts tests/errors.test.ts`

Expected: PASS; existing JobCard query and safe error contracts remain unchanged.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/types.ts server/src/modules/reports/query.ts \
  server/src/modules/reports/ports.ts server/tests/reports-query.test.ts
git commit -m "feat: add report contracts and query parsing"
```

### Task 2: StaffOperationalSummaryPort and PostgreSQL Read Model

**Files:**
- Create: `server/src/modules/reports/repository.ts`
- Create: `server/tests/reports-staff-summary.test.ts`

**Interfaces:**
- Consumes: `StaffOperationalSummaryPort`, `StaffOperationalSummaryOneInput`, and
  `StaffOperationalSummaryManyInput` from Task 1; `pg.Pool`.
- Produces: `PostgresReportsRepository.getOne(input)` and batch
  `PostgresReportsRepository.getMany(input)` with a keyed `ReadonlyMap`.

- [x] **Step 1: Write failing port and query-shape tests**

Use a recording Pool double to prove `getOne` calls one batch query, `getMany` calls one
query for any non-empty ID list, and an empty list performs zero database calls. Map rows
for known Staff with no JobCards to zero counters; omit unknown, cross-organization, and
non-Staff IDs.

```ts
await expect(repository.getMany({
  organizationId: 'org-1',
  staffUserIds: [],
  requestedRange: null,
  requestTime,
})).resolves.toEqual(new Map());
expect(pool.query).not.toHaveBeenCalled();

const summaries = await repository.getMany({
  organizationId: 'org-1',
  staffUserIds: [STAFF_ONE, STAFF_TWO],
  requestedRange: { from: '2026-07-01', to: '2026-07-31' },
  requestTime,
});
expect(pool.query).toHaveBeenCalledTimes(1);
expect([...summaries.keys()]).toEqual([STAFF_ONE, STAFF_TWO]);
expect(summaries.get(STAFF_TWO)?.counters).toEqual({
  openJobCards: 0,
  waitingApproval: 0,
  revisionRequested: 0,
  overdueJobCards: 0,
  completedInPeriod: 0,
});
```

Assert SQL attribution contains `jc.assigned_to = requested.staff_user_id`, contains no
`staff_completed_by`, `created_by`, `manager_approved_by`, or activity join, and contains
no JobCard type predicate. Assert range bounds are resolved with the organization
timezone and the supplied `requestTime`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/reports-staff-summary.test.ts`

Expected: FAIL because `PostgresReportsRepository` does not exist.

- [x] **Step 3: Implement one batch Staff aggregation**

Implement `getOne` as a single-ID call to `getMany`; implement `getMany` with one SQL
statement and no loop containing `pool.query`:

```ts
async getOne(input: StaffOperationalSummaryOneInput) {
  const result = await this.getMany({
    organizationId: input.organizationId,
    staffUserIds: [input.staffUserId],
    requestedRange: input.requestedRange,
    requestTime: input.requestTime,
  });
  return result.get(input.staffUserId) ?? null;
}

async getMany(input: StaffOperationalSummaryManyInput) {
  const staffUserIds = [...new Set(input.staffUserIds)];
  if (staffUserIds.length === 0) return new Map<string, StaffOperationalSummary>();
  const result = await this.pool.query<StaffSummaryRow>(STAFF_SUMMARY_SQL, [
    input.organizationId,
    input.requestedRange?.from ?? null,
    input.requestedRange?.to ?? null,
    input.requestTime,
    staffUserIds,
  ]);
  return new Map(result.rows.map((row) => [row.staff_user_id, mapStaffSummary(row)]));
}
```

The SQL must start from requested Staff IDs so zero-counter Staff produce rows:

```sql
WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($2::date,
      date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($3::date,
      (date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
), requested AS (
  SELECT unnest($5::uuid[]) AS staff_user_id
)
SELECT requested.staff_user_id, organization_range.from_date,
  organization_range.to_date, organization_range.timezone,
  COUNT(jc.id) FILTER (WHERE jc.status IN ('NEW', 'PLANNED', 'IN_PROGRESS'))::int
    AS open_job_cards,
  COUNT(jc.id) FILTER (WHERE jc.status = 'WAITING_APPROVAL')::int
    AS waiting_approval,
  COUNT(jc.id) FILTER (WHERE jc.status = 'REVISION_REQUESTED')::int
    AS revision_requested,
  COUNT(jc.id) FILTER (
    WHERE jc.due_date < ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
      AND jc.status IN ('NEW', 'PLANNED', 'IN_PROGRESS',
        'WAITING_APPROVAL', 'REVISION_REQUESTED')
  )::int AS overdue_job_cards,
  COUNT(jc.id) FILTER (
    WHERE jc.status = 'COMPLETED'
      AND jc.manager_approved_at >=
        (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
      AND jc.manager_approved_at <
        ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
  )::int AS completed_in_period
FROM requested
JOIN users u ON u.id = requested.staff_user_id
  AND u.organization_id = $1 AND u.role = 'STAFF'
JOIN staff_profiles sp ON sp.organization_id = u.organization_id AND sp.user_id = u.id
CROSS JOIN organization_range
LEFT JOIN job_cards jc ON jc.organization_id = $1
  AND jc.assigned_to = requested.staff_user_id
GROUP BY requested.staff_user_id, organization_range.from_date,
  organization_range.to_date, organization_range.timezone
ORDER BY requested.staff_user_id;
```

Map PostgreSQL counts with `Number` because these fields are integer counters. Do not use
`Number` for any delivery quantity. Return `from_date` and `to_date` as strict strings and
the database timezone unchanged.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-staff-summary.test.ts`

Expected: PASS, including one-query and zero-query assertions.

- [x] **Step 5: Run the server type/build gate**

Run: `cd server && npm run build`

Expected: PASS without adding a migration or dependency.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/repository.ts \
  server/tests/reports-staff-summary.test.ts
git commit -m "feat: add canonical staff report summaries"
```

### Task 3: Dashboard Queries

**Files:**
- Modify: `server/src/modules/reports/repository.ts`
- Create: `server/tests/reports-dashboard.test.ts`

**Interfaces:**
- Consumes: `StaffOperationalSummaryScope`, `DashboardReportResponse`, and the shared
  organization-local range CTE from Task 2.
- Produces: `PostgresReportsRepository.getDashboard(input):
  Promise<DashboardReportResponse>`.

- [x] **Step 1: Write failing dashboard query tests**

Record the SQL and map representative rows. Prove current-state counters do not include
range predicates, period counters use their canonical timestamps, trend contains every
date including zeros, all JobCard types contribute, and one `requestTime` supplies both
the default range and overdue date.

```ts
const result = await repository.getDashboard({
  organizationId: 'org-1',
  requestedRange: { from: '2026-07-01', to: '2026-07-03' },
  requestTime: new Date('2026-07-14T09:00:00.000Z'),
});
expect(result.completedTrend).toEqual([
  { date: '2026-07-01', count: 2 },
  { date: '2026-07-02', count: 0 },
  { date: '2026-07-03', count: 1 },
]);
expect(recordedSql).toContain('generate_series');
expect(recordedSql).not.toContain("jc.type = 'PRODUCT_DELIVERY'");
```

Run the same point-in-time fixture with two different requested ranges and assert
`activeJobCards`, `overdueJobCards`, `waitingApproval`, and `revisionRequested` remain
equal while completion, cancellation, and trend may differ.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/reports-dashboard.test.ts`

Expected: FAIL because `getDashboard` is missing.

- [x] **Step 3: Implement one deterministic dashboard statement**

Use the same organization-range CTE as Task 2 and one statement with counters plus a
zero-filled series:

```sql
WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($2::date,
      date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($3::date,
      (date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o
  WHERE o.id = $1
),
counters AS (
  SELECT
    COUNT(*) FILTER (WHERE status IN ('NEW', 'PLANNED', 'IN_PROGRESS',
      'WAITING_APPROVAL', 'REVISION_REQUESTED'))::int AS active_job_cards,
    COUNT(*) FILTER (WHERE due_date <
      ($4::timestamptz AT TIME ZONE organization_range.timezone)::date
      AND status IN ('NEW', 'PLANNED', 'IN_PROGRESS',
        'WAITING_APPROVAL', 'REVISION_REQUESTED'))::int AS overdue_job_cards,
    COUNT(*) FILTER (WHERE status = 'WAITING_APPROVAL')::int AS waiting_approval,
    COUNT(*) FILTER (WHERE status = 'REVISION_REQUESTED')::int AS revision_requested,
    COUNT(*) FILTER (WHERE status = 'COMPLETED'
      AND manager_approved_at >= (from_date::timestamp AT TIME ZONE timezone)
      AND manager_approved_at < ((to_date + 1)::timestamp AT TIME ZONE timezone))::int
      AS completed_in_period,
    COUNT(*) FILTER (WHERE status = 'CANCELLED'
      AND cancelled_at >= (from_date::timestamp AT TIME ZONE timezone)
      AND cancelled_at < ((to_date + 1)::timestamp AT TIME ZONE timezone))::int
      AS cancelled_in_period
  FROM job_cards CROSS JOIN organization_range
  WHERE organization_id = $1
), days AS (
  SELECT day::date
  FROM organization_range,
    generate_series(from_date, to_date, interval '1 day') day
), trend AS (
  SELECT days.day,
    COUNT(jc.id) FILTER (WHERE jc.status = 'COMPLETED')::int AS count
  FROM days
  CROSS JOIN organization_range
  LEFT JOIN job_cards jc ON jc.organization_id = $1
    AND jc.manager_approved_at >=
      (days.day::timestamp AT TIME ZONE organization_range.timezone)
    AND jc.manager_approved_at <
      ((days.day + 1)::timestamp AT TIME ZONE organization_range.timezone)
  GROUP BY days.day
  ORDER BY days.day
)
SELECT organization_range.from_date, organization_range.to_date,
  organization_range.timezone, counters.*,
  COALESCE(json_agg(json_build_object('date', trend.day, 'count', trend.count)
    ORDER BY trend.day), '[]'::json) AS completed_trend
FROM organization_range CROSS JOIN counters CROSS JOIN trend
GROUP BY organization_range.from_date, organization_range.to_date,
  organization_range.timezone, counters.active_job_cards,
  counters.overdue_job_cards, counters.waiting_approval,
  counters.revision_requested, counters.completed_in_period,
  counters.cancelled_in_period;
```

Map trend dates to `YYYY-MM-DD` and integer counts. Do not filter any dashboard metric by
JobCard type.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-dashboard.test.ts`

Expected: PASS with zero-day trend and point-in-time assertions.

- [x] **Step 5: Run related summary regressions**

Run: `cd server && npm test -- --run tests/reports-dashboard.test.ts tests/reports-staff-summary.test.ts`

Expected: PASS; both paths use the same local-range contract.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/repository.ts server/tests/reports-dashboard.test.ts
git commit -m "feat: add operational dashboard read model"
```

### Task 4: Staff Operational Report Read Models

**Files:**
- Modify: `server/src/modules/reports/repository.ts`
- Create: `server/tests/reports-staff.test.ts`

**Interfaces:**
- Consumes: `StaffOperationalSummaryPort.getOne`, `ReportStaffIdentity`,
  `DeliveryPurposeItem`, and `StaffOperationalSummaryOneInput` from Tasks 1–2.
- Produces: `PostgresReportsRepository.getStaffIdentity(input)` and
  `PostgresReportsRepository.getStaffDeliveriesByPurpose(input)`.

- [x] **Step 1: Write failing Staff identity and purpose-summary tests**

Prove active and inactive same-organization Staff are returned, while missing,
cross-organization, and non-Staff identities return `null`. Prove all five operational
counters are attributed only through `assigned_to` and include every JobCard type. Prove
purpose quantities include only approved `COMPLETED` `PRODUCT_DELIVERY` records and use
`delivered_at`, not `manager_approved_at`, as the range timestamp.

```ts
await expect(repository.getStaffIdentity({
  organizationId: ORG_ONE,
  staffUserId: INACTIVE_STAFF,
})).resolves.toEqual({ userId: INACTIVE_STAFF, name: 'Eski Personel', isActive: false });

const items = await repository.getStaffDeliveriesByPurpose({
  organizationId: ORG_ONE,
  staffUserId: STAFF_ONE,
  requestedRange: { from: '2026-07-01', to: '2026-07-31' },
  requestTime,
});
expect(items).toEqual([
  { purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
  { purpose: 'SALE', unit: null, quantity: '0.500' },
  { purpose: 'RETURN', unit: 'kutu', quantity: '12.500' },
]);
```

Assert the SQL contains `jc.assigned_to = $2`, ignores submitter/creator/approver/activity
actors, applies the canonical purpose order, uses `COLLATE "C"`, and puts null unit last.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/reports-staff.test.ts`

Expected: FAIL because Staff identity and delivery-purpose methods are missing.

- [x] **Step 3: Implement safe identity and delivery-purpose reads**

Use a concealed identity query that requires both the Staff role and profile:

```ts
async getStaffIdentity(input: { organizationId: string; staffUserId: string }) {
  const result = await this.pool.query<StaffIdentityRow>(
    `SELECT u.id, u.name, u.is_active
     FROM users u
     JOIN staff_profiles sp
       ON sp.organization_id = u.organization_id AND sp.user_id = u.id
     WHERE u.organization_id = $1 AND u.id = $2 AND u.role = 'STAFF'
     LIMIT 1`,
    [input.organizationId, input.staffUserId],
  );
  const row = result.rows[0];
  return row ? { userId: row.id, name: row.name, isActive: row.is_active } : null;
}
```

Implement purpose aggregation with the complete trust and range predicates:

```sql
WITH organization_range AS (
  SELECT o.timezone,
    COALESCE($3::date,
      date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
    COALESCE($4::date,
      (date_trunc('month', $5::timestamptz AT TIME ZONE o.timezone)
        + interval '1 month - 1 day')::date) AS to_date
  FROM organizations o WHERE o.id = $1
)
SELECT di.delivery_purpose, di.unit,
  to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity
FROM job_card_delivery_items di
JOIN job_cards jc ON jc.organization_id = di.organization_id AND jc.id = di.job_card_id
CROSS JOIN organization_range
WHERE jc.organization_id = $1
  AND jc.assigned_to = $2
  AND jc.type = 'PRODUCT_DELIVERY'
  AND jc.status = 'COMPLETED'
  AND jc.manager_approved_at IS NOT NULL
  AND di.delivered_at >=
    (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
  AND di.delivered_at <
    ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
GROUP BY di.delivery_purpose, di.unit
ORDER BY CASE di.delivery_purpose
  WHEN 'SALE' THEN 1 WHEN 'SAMPLE' THEN 2 WHEN 'CONSIGNMENT' THEN 3
  WHEN 'RETURN' THEN 4 WHEN 'OTHER' THEN 5 END,
  di.unit COLLATE "C" ASC NULLS LAST;
```

Return PostgreSQL `quantity` text unchanged. Do not parse or recompute it.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-staff.test.ts`

Expected: PASS for identity concealment, inactive Staff, attribution, type scope, range,
purpose order, and exact quantity strings.

- [x] **Step 5: Run all backend report read-model tests**

Run: `cd server && npm test -- --run tests/reports-staff-summary.test.ts tests/reports-dashboard.test.ts tests/reports-staff.test.ts`

Expected: PASS with no People repository dependency.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/repository.ts server/tests/reports-staff.test.ts
git commit -m "feat: add staff operational report reads"
```

### Task 5: Delivery Grouped Reports

**Files:**
- Modify: `server/src/modules/reports/repository.ts`
- Create: `server/tests/reports-deliveries.test.ts`

**Interfaces:**
- Consumes: `DeliveryReportReadInput`, the four exact delivery item types, and
  `DeliveryReportResponse` from Task 1.
- Produces: `PostgresReportsRepository.getDeliveryReport(input)` with four fixed SQL
  shapes selected only by the validated `groupBy` discriminant.

- [x] **Step 1: Write failing tests for all four grouping shapes**

Use recording Pool responses for `day`, `purpose`, `product`, and `staff`. Assert each
response contains only its own fields, quantity stays a three-decimal string, `total`
counts canonical grouped rows, and item/count statements share exactly the same grouped
subquery string.

```ts
const day = await repository.getDeliveryReport({
  organizationId: ORG_ONE,
  requestedRange: range,
  requestTime,
  groupBy: 'day',
  staffUserId: null,
  limit: 50,
  offset: 0,
});
expect(day).toEqual({
  groupBy: 'day',
  range: resolvedRange,
  items: [{ date: '2026-07-14', unit: null, quantity: '0.500' }],
  total: 1,
  limit: 50,
  offset: 0,
});
expect(day.items[0]).not.toHaveProperty('purpose');
```

For every group, assert SQL includes only `PRODUCT_DELIVERY`, `COMPLETED`, non-null manager
approval, `delivered_at` local range, and optional `assigned_to` filtering. Assert no
report-time `lower`, `upper`, `trim`, `coalesce(unit`, `Number`, or `parseFloat` quantity
logic exists. Cover `null`, `kutu`, and `Kutu` as separate groups; catalog rename and
deactivation must leave snapshot fields unchanged.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/reports-deliveries.test.ts`

Expected: FAIL because `getDeliveryReport` is missing.

- [x] **Step 3: Implement fixed grouped-query definitions**

Define a closed query-definition map. Client values never become SQL identifiers:

```ts
const DELIVERY_GROUPS = {
  day: {
    select: `(di.delivered_at AT TIME ZONE organization_range.timezone)::date AS date,
      di.unit,
      to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `(di.delivered_at AT TIME ZONE organization_range.timezone)::date, di.unit`,
    order: `date DESC, di.unit COLLATE "C" ASC NULLS LAST`,
  },
  purpose: {
    select: `di.delivery_purpose, di.unit,
      to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `di.delivery_purpose, di.unit`,
    order: `CASE di.delivery_purpose
      WHEN 'SALE' THEN 1 WHEN 'SAMPLE' THEN 2 WHEN 'CONSIGNMENT' THEN 3
      WHEN 'RETURN' THEN 4 WHEN 'OTHER' THEN 5 END,
      di.unit COLLATE "C" ASC NULLS LAST`,
  },
  product: {
    select: `di.product_id, di.product_name_snapshot, di.product_sku_snapshot,
      di.product_model_snapshot, di.unit,
      to_char(SUM(di.quantity), 'FM999999999999999999990.000') AS quantity`,
    group: `di.product_id, di.product_name_snapshot, di.product_sku_snapshot,
      di.product_model_snapshot, di.unit`,
    order: `di.product_name_snapshot COLLATE "C" ASC, di.product_id ASC,
      di.product_sku_snapshot COLLATE "C" ASC NULLS LAST,
      di.product_model_snapshot COLLATE "C" ASC NULLS LAST,
      di.unit COLLATE "C" ASC NULLS LAST`,
  },
  staff: {
    select: `u.id AS staff_user_id, u.name AS staff_name, u.is_active,
      di.unit, to_char(SUM(di.quantity),
        'FM999999999999999999990.000') AS quantity`,
    group: `u.id, u.name, u.is_active, di.unit`,
    order: `u.name COLLATE "C" ASC, u.id ASC,
      di.unit COLLATE "C" ASC NULLS LAST`,
  },
} as const;
```

Build the grouped subquery once per request and reuse its exact string for count and page:

```ts
const rangeValues = [
  input.organizationId,
  input.requestedRange?.from ?? null,
  input.requestedRange?.to ?? null,
  input.requestTime,
];

const organizationRangeCte = `
  organization_range AS (
    SELECT o.timezone,
      COALESCE($2::date,
        date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)::date) AS from_date,
      COALESCE($3::date,
        (date_trunc('month', $4::timestamptz AT TIME ZONE o.timezone)
          + interval '1 month - 1 day')::date) AS to_date
    FROM organizations o WHERE o.id = $1
  )`;

const groupedSql = `
  WITH ${organizationRangeCte}
  SELECT ${definition.select}
  FROM job_card_delivery_items di
  JOIN job_cards jc ON jc.organization_id = di.organization_id AND jc.id = di.job_card_id
  ${input.groupBy === 'staff'
    ? `JOIN users u ON u.organization_id = jc.organization_id
         AND u.id = jc.assigned_to AND u.role = 'STAFF'
       JOIN staff_profiles sp ON sp.organization_id = u.organization_id
         AND sp.user_id = u.id`
    : ''}
  CROSS JOIN organization_range
  WHERE jc.organization_id = $1
    AND jc.type = 'PRODUCT_DELIVERY'
    AND jc.status = 'COMPLETED'
    AND jc.manager_approved_at IS NOT NULL
    AND di.delivered_at >=
      (organization_range.from_date::timestamp AT TIME ZONE organization_range.timezone)
    AND di.delivered_at <
      ((organization_range.to_date + 1)::timestamp AT TIME ZONE organization_range.timezone)
    ${input.staffUserId === null ? '' : 'AND jc.assigned_to = $5'}
  GROUP BY ${definition.group}`;
```

Resolve the echoed range independently of grouped rows so an empty report still returns
the exact `{ from, to, timezone }` selected by PostgreSQL. The range lookup is always the
first query; count and page are then invoked in that order inside `Promise.all`:

```ts
type ResolvedReportRangeRow = {
  from: string;
  to: string;
  timezone: string;
};
type DeliveryGroupRow = Record<string, unknown>;

const resolvedRangeSql = `
  WITH ${organizationRangeCte}
  SELECT to_char(from_date, 'YYYY-MM-DD') AS "from",
    to_char(to_date, 'YYYY-MM-DD') AS "to",
    timezone
  FROM organization_range`;

const groupedValues = [
  ...rangeValues,
  ...(input.staffUserId === null ? [] : [input.staffUserId]),
];
const countSql = `SELECT COUNT(*)::int AS total FROM (${groupedSql}) grouped`;
const limitParameter = groupedValues.length + 1;
const offsetParameter = groupedValues.length + 2;
const pageSql = `${groupedSql}
  ORDER BY ${definition.order}
  LIMIT $${limitParameter}
  OFFSET $${offsetParameter}`;
const pageValues = [...groupedValues, input.limit, input.offset];

const rangeResult = await this.pool.query<ResolvedReportRangeRow>(
  resolvedRangeSql,
  rangeValues,
);
const [countResult, pageResult] = await Promise.all([
  this.pool.query<{ total: number }>(countSql, groupedValues),
  this.pool.query<DeliveryGroupRow>(pageSql, pageValues),
]);
```

The count and page statements reuse the exact `groupedSql` text and the same
`groupedValues`; only the page appends positional limit/offset values. Tests must assert
the empty-result path still returns the resolved range, `total: 0`, and `items: []`, and
that every SQL placeholder is positional (`$1`, `$2`, and so on). Map each row through a
group-specific mapper and return PostgreSQL quantity text unchanged.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-deliveries.test.ts`

Expected: PASS for all four discriminants, exact totals, sort order, units, snapshots,
Staff attribution/filtering, and decimal strings.

- [x] **Step 5: Run related Product and delivery regressions**

Run: `cd server && npm test -- --run tests/reports-deliveries.test.ts tests/product-repository.test.ts tests/delivery-item-service.test.ts`

Expected: PASS; catalog and delivery mutation behavior remain unchanged.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/repository.ts server/tests/reports-deliveries.test.ts
git commit -m "feat: add grouped delivery reports"
```

### Task 6: Approval Age Summary and Canonical JobCard Items

**Files:**
- Modify: `server/src/modules/reports/repository.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Create: `server/tests/reports-approvals.test.ts`
- Modify: `server/tests/job-card-workspace-repository.test.ts`

**Interfaces:**
- Consumes: `ApprovalSummary`, `ApprovalItem`, and `ApprovalQueueItemPort` from Task 1;
  the existing `JobCardListItem` mapper and SQL projection.
- Produces: `PostgresReportsRepository.getApprovalSummary(input)` and
  `PostgresJobCardRepository.getApprovalItems(input)`.

- [x] **Step 1: Write failing boundary, summary, and projection tests**

Freeze `requestTime` and cover elapsed values immediately below and exactly at 2, 8, and
24 hours; a future `staff_completed_at`; an empty queue; multiple pages; and two JobCard
types. Assert completed whole minutes for items and oldest, nearest whole minute for the
average, mutually exclusive buckets, and these invariants:

```text
pendingCount == total
pendingCount == under2Hours + between2And8Hours + between8And24Hours + over24Hours
```

```ts
expect(summary.pendingCount).toBe(total);
expect(summary.pendingCount).toBe(
  summary.under2Hours + summary.between2And8Hours
  + summary.between8And24Hours + summary.over24Hours,
);
expect(futureItem.waitingMinutes).toBe(0);
expect(futureSummary.under2Hours).toBe(1);
```

Assert item SQL reuses every `JOB_CARD_LIST_COLUMNS` field and `mapJobCardListItem`, adds
only `waitingMinutes`, sorts `staff_completed_at ASC, id ASC`, and contains no type or
assignee-ownership predicate.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `cd server && npm test -- --run tests/reports-approvals.test.ts tests/job-card-workspace-repository.test.ts`

Expected: FAIL because both approval read methods are missing.

- [x] **Step 3: Implement one elapsed expression in both SQL owners**

Use this exact elapsed expression in summary and item SQL:

```sql
GREATEST($2::timestamptz - j.staff_completed_at, interval '0 seconds')
```

Implement the whole-queue summary without pagination:

```sql
WITH waiting AS (
  SELECT GREATEST($2::timestamptz - j.staff_completed_at,
    interval '0 seconds') AS elapsed
  FROM job_cards j
  WHERE j.organization_id = $1 AND j.status = 'WAITING_APPROVAL'
)
SELECT COUNT(*)::int AS pending_count,
  FLOOR(EXTRACT(EPOCH FROM MAX(elapsed)) / 60)::int AS oldest_waiting_minutes,
  ROUND(AVG(EXTRACT(EPOCH FROM elapsed)) / 60)::int AS average_waiting_minutes,
  COUNT(*) FILTER (WHERE elapsed < interval '2 hours')::int AS under_2_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '2 hours'
    AND elapsed < interval '8 hours')::int AS between_2_and_8_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '8 hours'
    AND elapsed < interval '24 hours')::int AS between_8_and_24_hours,
  COUNT(*) FILTER (WHERE elapsed >= interval '24 hours')::int AS over_24_hours
FROM waiting;
```

Map empty `MAX`/`AVG` results to `null`. In `PostgresJobCardRepository`, implement the
narrow port using its existing projection:

```ts
async getApprovalItems(input: {
  organizationId: string;
  requestTime: Date;
  limit: number;
  offset: number;
}): Promise<ApprovalItem[]> {
  const rows = await this.pool.query<JobCardListRow & { waiting_minutes: number }>(
    `SELECT ${JOB_CARD_LIST_COLUMNS},
       FLOOR(EXTRACT(EPOCH FROM GREATEST(
         $2::timestamptz - j.staff_completed_at,
         interval '0 seconds')) / 60)::int AS waiting_minutes
     ${WORKSPACE_ITEM_JOINS}
     WHERE j.organization_id = $1 AND j.status = 'WAITING_APPROVAL'
     ORDER BY j.staff_completed_at ASC, j.id ASC
     LIMIT $3 OFFSET $4`,
    [input.organizationId, input.requestTime, input.limit, input.offset],
  );
  return rows.rows.map((row) => ({
    ...mapJobCardListItem(row),
    waitingMinutes: Number(row.waiting_minutes),
  }));
}
```

Make `PostgresJobCardRepository` structurally satisfy `ApprovalQueueItemPort`; do not add
the method to the mutation/workspace-facing `JobCardRepository` interface. This keeps
existing JobCard service doubles narrow and leaves workspace list/board behavior unchanged.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-approvals.test.ts tests/job-card-workspace-repository.test.ts`

Expected: PASS for boundary buckets, future clamp, summary invariants, deterministic page,
and canonical projection reuse.

- [x] **Step 5: Run JobCard workspace regressions**

Run: `cd server && npm test -- --run tests/job-card-board.test.ts tests/job-card-routes.test.ts tests/job-card-workspace-repository.test.ts`

Expected: PASS; approval reporting adds no lifecycle or workspace ownership source.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/repository.ts \
  server/src/modules/job-cards/repository.ts \
  server/tests/reports-approvals.test.ts \
  server/tests/job-card-workspace-repository.test.ts
git commit -m "feat: add approval age report reads"
```

### Task 7: Reports Service, Handlers, Routes, and Authorization

**Files:**
- Create: `server/src/modules/reports/service.ts`
- Create: `server/src/modules/reports/handlers.ts`
- Create: `server/src/modules/reports/routes.ts`
- Create: `server/tests/reports-service.test.ts`
- Create: `server/tests/reports-routes.test.ts`

**Interfaces:**
- Consumes: `ReportsReadModel`, `ApprovalQueueItemPort`, all Task 1 parsers, and the
  authenticated `SafeUser`.
- Produces: `ReportsService.dashboard`, `getOwnStaffReport`, `getStaffReport`,
  `getDeliveries`, and `getApprovals`; five exact GET routes under `/api/reports`.

- [x] **Step 1: Write failing role, error, and route-contract tests**

Use memory ports with call recording. Test the complete role matrix, one authoritative
`requestTime` per service call, Staff self-ID forcing, Admin/Manager Staff selection,
inactive Staff, query allowlists, repeated scalars, and no repository call for malformed
path/query UUIDs.

```ts
await expect(service.dashboard(STAFF, { requestedRange: null }))
  .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
await expect(service.getOwnStaffReport(MANAGER, { requestedRange: null }))
  .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
await expect(service.getStaffReport(MANAGER, MISSING_STAFF, { requestedRange: null }))
  .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
```

At the route level, verify exactly:

```text
GET /api/reports/dashboard
GET /api/reports/staff/me
GET /api/reports/staff/:userId
GET /api/reports/deliveries
GET /api/reports/approvals
```

Assert Staff receives `403` on the four management routes; Admin/Manager receive `403`
on `/staff/me`; malformed Staff path returns concealed `404`; malformed delivery query
Staff UUID returns `400`; valid unavailable query Staff UUID returns `404`; and unknown or
repeated queries return `400`.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `cd server && npm test -- --run tests/reports-service.test.ts tests/reports-routes.test.ts`

Expected: FAIL because service, handlers, and routes are absent.

- [x] **Step 3: Implement policy composition and thin HTTP translation**

Use exact role guards and one request time:

```ts
export class ReportsService {
  constructor(
    private readonly reports: ReportsReadModel,
    private readonly approvalItems: ApprovalQueueItemPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  dashboard(actor: SafeUser, query: ReportRangeQuery) {
    requireManagement(actor);
    return this.reports.getDashboard({
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime: this.now(),
    });
  }

  getOwnStaffReport(actor: SafeUser, query: ReportRangeQuery) {
    if (actor.role !== 'STAFF') throw forbidden();
    return this.staffReport(actor.organizationId, actor.id, query, this.now());
  }

  getStaffReport(actor: SafeUser, staffUserId: string, query: ReportRangeQuery) {
    requireManagement(actor);
    return this.staffReport(actor.organizationId, staffUserId, query, this.now());
  }
}
```

`staffReport` must call `getOne`, `getStaffIdentity`, and
`getStaffDeliveriesByPurpose` with the same organization, requested range, Staff ID, and
request time. If identity or summary is absent, throw exactly:

```ts
new AppError('STAFF_PROFILE_NOT_FOUND', 404, 'Personel profili bulunamadı.')
```

Implement both composition methods explicitly:

```ts
private async staffReport(
  organizationId: string,
  staffUserId: string,
  query: ReportRangeQuery,
  requestTime: Date,
): Promise<StaffReportResponse> {
  const input = {
    organizationId,
    staffUserId,
    requestedRange: query.requestedRange,
    requestTime,
  };
  const [identity, summary, deliveriesByPurpose] = await Promise.all([
    this.reports.getStaffIdentity({ organizationId, staffUserId }),
    this.reports.getOne(input),
    this.reports.getStaffDeliveriesByPurpose(input),
  ]);
  if (!identity || !summary) throw staffProfileNotFound();
  return { staff: identity, range: summary.range,
    counters: summary.counters, deliveriesByPurpose };
}

async getDeliveries(actor: SafeUser, query: DeliveryReportQuery) {
  requireManagement(actor);
  const requestTime = this.now();
  if (query.staffUserId !== null) {
    const identity = await this.reports.getStaffIdentity({
      organizationId: actor.organizationId,
      staffUserId: query.staffUserId,
    });
    if (!identity) throw staffProfileNotFound();
  }
  return this.reports.getDeliveryReport({
    organizationId: actor.organizationId,
    requestedRange: query.requestedRange,
    requestTime,
    groupBy: query.groupBy,
    staffUserId: query.staffUserId,
    limit: query.limit,
    offset: query.offset,
  });
}
```

Inactive same-organization Staff passes the identity check. `getApprovals` calls summary
and items with the same request time, then constructs `total` only from
`summary.pendingCount`:

```ts
const requestTime = this.now();
const [summary, items] = await Promise.all([
  this.reports.getApprovalSummary({ organizationId: actor.organizationId, requestTime }),
  this.approvalItems.getApprovalItems({
    organizationId: actor.organizationId,
    requestTime,
    limit: query.limit,
    offset: query.offset,
  }),
]);
return { summary, items, total: summary.pendingCount, limit: query.limit, offset: query.offset };
```

Handlers call only parsers and service methods. Register routes with the existing Fastify
options-object authentication pattern; the pre-handler is never passed as a bare second
argument:

```ts
type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type ReportsRoutesOptions = {
  service: ReportsService;
  authenticate: Authenticate;
};

export const reportsRoutes: FastifyPluginAsync<ReportsRoutesOptions> =
  async (app, options) => {
    const handlers = createReportsHandlers(options.service);
    const secured = { preHandler: options.authenticate };

    app.get('/dashboard', secured, handlers.dashboard);
    app.get('/staff/me', secured, handlers.getOwnStaffReport);
    app.get<{ Params: { userId: string } }>(
      '/staff/:userId',
      secured,
      handlers.getStaffReport,
    );
    app.get('/deliveries', secured, handlers.getDeliveries);
    app.get('/approvals', secured, handlers.getApprovals);
  };
```

Do not register the plugin in `server/src/app.ts` in this task. Direct route tests create
a Fastify instance, attach an authenticated `currentUser`, and register `reportsRoutes`
with memory ports. Include a route source-contract assertion that every route uses an
options object whose `preHandler` is `options.authenticate`. Task 8 removes People's old
SQL and registers both consumers in one
composition-root commit, so no deployed intermediate state exposes two counter sources.
Do not put SQL, date arithmetic, or role policy in handlers.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `cd server && npm test -- --run tests/reports-service.test.ts tests/reports-routes.test.ts`

Expected: PASS for all routes, roles, errors, time consistency, and query contracts.

- [x] **Step 5: Run server build and route regressions**

Run: `cd server && npm run build && npm test -- --run tests/auth-routes.test.ts tests/people-routes.test.ts tests/job-card-routes.test.ts tests/reports-routes.test.ts`

Expected: PASS; Reports routes use existing auth and error mapping without changing other
modules.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/reports/service.ts \
  server/src/modules/reports/handlers.ts server/src/modules/reports/routes.ts \
  server/tests/reports-service.test.ts server/tests/reports-routes.test.ts
git commit -m "feat: expose authorized report routes"
```

### Task 8: People Counter Integration and Composition Root

**Files:**
- Modify: `server/src/modules/people/types.ts`
- Modify: `server/src/modules/people/repository.ts`
- Modify: `server/src/modules/people/service.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/people-counters.test.ts`
- Modify: `server/tests/people-repository.test.ts`
- Modify: `server/tests/people-service.test.ts`
- Modify: `server/tests/people-routes.test.ts`
- Modify: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: the exact `StaffOperationalSummaryPort` from Task 1 and
  `PostgresReportsRepository` from Task 2.
- Produces: unchanged public `StaffProfileSummary.counters` names backed exclusively by
  `getOne`/batch `getMany`; one production Reports read-model instance injected into both
  People and Reports.

- [x] **Step 1: Rewrite tests to fail on the old People-owned counter SQL**

Change People repository doubles to return profile identity without counters. Inject a
recording summary port into PeopleService and prove `listStaff` calls `getMany` exactly
once with every returned Staff ID, while own/detail/update reads call `getOne` exactly
once. Preserve public DTO values:

```ts
expect(await service.listStaff(MANAGER, 'active')).toEqual([
  expect.objectContaining({
    user: expect.objectContaining({ id: STAFF_ONE }),
    counters: {
      open: 3,
      waitingApproval: 2,
      revisionRequested: 1,
      completedThisMonth: 4,
      overdue: 1,
    },
  }),
]);
expect(summaryPort.getMany).toHaveBeenCalledTimes(1);
expect(summaryPort.getOne).not.toHaveBeenCalled();
```

Add a source-contract assertion that `people/repository.ts` contains no `COUNT(jc.id)`,
`manager_approved_at`, or `LEFT JOIN job_cards`. Read `people/service.ts`,
`people/types.ts`, and `people/repository.ts`; collect imports whose source starts with
`../reports/`, and assert every collected statement begins with `import type`. The test
must find the two expected imports in `people/service.ts`, so an accidentally missing
check cannot pass vacuously:

```ts
import { readFile } from 'node:fs/promises';

const peopleFiles = ['service.ts', 'types.ts', 'repository.ts'] as const;
const peopleSources = await Promise.all(peopleFiles.map(async (file) => ({
  file,
  source: await readFile(
    new URL(`../src/modules/people/${file}`, import.meta.url),
    'utf8',
  ),
})));
const serviceSource = peopleSources.find(({ file }) => file === 'service.ts')?.source ?? '';
const peopleSource = peopleSources.map(({ source }) => source).join('\n');
expect(serviceSource).toContain(
  "import type { StaffOperationalSummary } from '../reports/types.js';",
);
expect(serviceSource).toContain(
  "import type { StaffOperationalSummaryPort } from '../reports/ports.js';",
);
expect(peopleSource).not.toMatch(
  /import\s+(?!type\b)[^;]*from ['"]\.\.\/reports\//g,
);
```

Preserve all existing People role, profile update, deactivation, audit, and password
behavior tests. Add an app test proving People and Reports routes appear only when the
same Reports read model is injected and that the approval queue remains a separate narrow
dependency.

- [x] **Step 2: Run People tests and verify RED**

Run: `cd server && npm test -- --run tests/people-counters.test.ts tests/people-repository.test.ts tests/people-service.test.ts tests/people-routes.test.ts tests/app.test.ts`

Expected: FAIL because PeopleService does not accept the port and the repository still
owns counter SQL.

- [x] **Step 3: Remove the second SQL source and map the canonical counters**

Split the identity type while keeping the public DTO unchanged:

```ts
export type StaffProfileDetails = Omit<StaffProfileSummary, 'counters'>;

export interface PeopleRepository {
  execute<T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T>;
  listUsers(organizationId: string): Promise<SafeManagedUser[]>;
  getUser(organizationId: string, userId: string): Promise<SafeManagedUser | null>;
  getStaffProfile(organizationId: string, userId: string):
    Promise<StaffProfileDetails | null>;
  listStaffProfiles(organizationId: string, status: StaffStatusFilter):
    Promise<StaffProfileDetails[]>;
}
```

Delete `StaffSummaryRow`, `STAFF_SUMMARY_SELECT`, `STAFF_SUMMARY_GROUP`, and People's
JobCard joins. People's only direct dependency on Reports contracts is erased at runtime:

```ts
import type { StaffOperationalSummary } from '../reports/types.js';
import type { StaffOperationalSummaryPort } from '../reports/ports.js';
```

Do not use a value import, import a Reports repository/service, or add a People-to-Reports
runtime call. Add the port to PeopleService:

```ts
constructor(
  private readonly repository: PeopleRepository,
  private readonly credentials: CredentialPreparation,
  private readonly staffSummaries: StaffOperationalSummaryPort,
  private readonly now: () => Date = () => new Date(),
) {}
```

Map canonical counters in one function:

```ts
function withCounters(
  profile: StaffProfileDetails,
  summary: StaffOperationalSummary,
): StaffProfileSummary {
  return {
    ...profile,
    counters: {
      open: summary.counters.openJobCards,
      waitingApproval: summary.counters.waitingApproval,
      revisionRequested: summary.counters.revisionRequested,
      completedThisMonth: summary.counters.completedInPeriod,
      overdue: summary.counters.overdueJobCards,
    },
  };
}
```

For `listStaff`, capture one `requestTime`, load identities, then call:

```ts
const summaries = await this.staffSummaries.getMany({
  organizationId: actor.organizationId,
  staffUserIds: profiles.map((profile) => profile.user.id),
  requestedRange: null,
  requestTime,
});
return profiles.map((profile) => {
  const summary = summaries.get(profile.user.id);
  if (!summary) throw new Error(`Missing Staff summary for ${profile.user.id}`);
  return withCounters(profile, summary);
});
```

Use `getOne` with `requestedRange: null` for own/detail/update return values. Missing
identity or summary produces the existing `STAFF_PROFILE_NOT_FOUND`.

In `server/src/index.ts`, construct once and reuse:

```ts
const jobCards = new PostgresJobCardRepository(database.pool);
const reports = new PostgresReportsRepository(database.pool);
const app = await buildApp(config, {
  authRepository: new PostgresAuthRepository(database.pool),
  jobCardRepository: jobCards,
  approvalQueueItemPort: jobCards,
  peopleRepository: new PostgresPeopleRepository(
    database.pool, credentials, sessions, customerAssignments,
  ),
  reportsRepository: reports,
  crmRepository: new PostgresCrmRepository(database.pool),
  productRepository: new PostgresProductRepository(database.pool),
});
```

Extend and wire the app dependency contract in the same change that deletes People's
counter SQL:

```ts
export type AppDependencies = {
  authRepository?: AuthRepository;
  jobCardRepository?: JobCardRepository;
  approvalQueueItemPort?: ApprovalQueueItemPort;
  peopleRepository?: PeopleRepository;
  reportsRepository?: ReportsReadModel;
  crmRepository?: CrmRepository;
  productRepository?: ProductRepository;
};

if (dependencies.peopleRepository && dependencies.reportsRepository) {
  await app.register(peopleRoutes, {
    prefix: '/api',
    service: new PeopleService(
      dependencies.peopleRepository,
      new AuthCredentialAdministration(),
      dependencies.reportsRepository,
    ),
    authenticate: authenticateDomain,
  });
}
if (dependencies.reportsRepository && dependencies.approvalQueueItemPort) {
  await app.register(reportsRoutes, {
    prefix: '/api/reports',
    service: new ReportsService(
      dependencies.reportsRepository,
      dependencies.approvalQueueItemPort,
    ),
    authenticate: authenticateDomain,
  });
}
```

`buildApp` injects the same `dependencies.reportsRepository` into PeopleService and
ReportsService; Reports imports no People module and neither module calls HTTP. All test
composition roots inject an explicit memory implementation of the same port. This single
commit both deletes People's SQL and makes Reports reachable, so no buildable commit has
two active production counter sources.

- [x] **Step 4: Run People tests and verify GREEN**

Run: `cd server && npm test -- --run tests/people-counters.test.ts tests/people-repository.test.ts tests/people-service.test.ts tests/people-routes.test.ts tests/app.test.ts`

Expected: PASS with one batch query path and unchanged public People DTOs.

- [x] **Step 5: Run backend build and cross-module regressions**

Run: `cd server && npm run build && npm test -- --run tests/app.test.ts tests/auth-service.test.ts tests/crm-service.test.ts tests/people-service.test.ts tests/reports-service.test.ts`

Expected: PASS with no People/Reports circular runtime import and no duplicate counter SQL.

- [x] **Step 6: Commit**

```bash
git add server/src/modules/people/types.ts \
  server/src/modules/people/repository.ts server/src/modules/people/service.ts \
  server/src/app.ts server/src/index.ts server/tests/people-counters.test.ts \
  server/tests/people-repository.test.ts server/tests/people-service.test.ts \
  server/tests/people-routes.test.ts server/tests/app.test.ts
git commit -m "refactor: share canonical staff report counters"
```

### Task 9: Reports Web API Contract

**Files:**
- Create: `web/src/reports/report-types.ts`
- Create: `web/src/reports/reports-api.ts`
- Create: `web/src/reports/report-search.ts`
- Modify: `web/src/jobs/jobs-api.ts`
- Create: `web/tests/reports-api.test.ts`
- Create: `web/tests/report-search.test.ts`
- Modify: `web/tests/jobs-api.test.ts`

**Interfaces:**
- Consumes: `request`, `object`, `string`, `nullableString`, `number`, `boolean`, and
  `ApiError` from `web/src/services/api.ts`; canonical JobCard list parsing helpers from
  `web/src/jobs/jobs-api.ts` after exporting `parseJobCardListItem`.
- Produces: exact web report types; `getDashboardReport`, `getOwnStaffReport`,
  `getStaffReport`, `getDeliveryReport`, `getApprovalReport`; request query builders and
  canonical URL parsers.

- [x] **Step 1: Write failing parser and query-builder tests**

Provide valid and invalid payload fixtures for every DTO. Prove each delivery discriminant
rejects fields from another shape, exact quantity strings survive unchanged, unknown
group shapes fail with `INVALID_RESPONSE`, Staff identity is strictly parsed, and
ApprovalItem parses a canonical JobCard list item plus a non-negative integer age.
The canonical web list projection accepts both `PRODUCT_DELIVERY` and `GENERAL_TASK` so
all-type approval rows parse, while JobCard creation/detail and workspace type filters
remain Product Delivery-only until Slice 09.

```ts
expect(parseDeliveryReport({
  groupBy: 'purpose',
  items: [{ purpose: 'SALE', unit: null, quantity: '3.000' }],
  range, total: 1, limit: 50, offset: 0,
})).toEqual({
  groupBy: 'purpose',
  items: [{ purpose: 'SALE', unit: null, quantity: '3.000' }],
  range, total: 1, limit: 50, offset: 0,
});
expect(() => parseDeliveryReport({
  groupBy: 'day',
  items: [{ purpose: 'SALE', unit: null, quantity: '3.000' }],
  range, total: 1, limit: 50, offset: 0,
})).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
const validDeliveryPayloads = [
  { groupBy: 'day', items: [
    { date: '2026-07-14', unit: null, quantity: '0.500' },
  ] },
  { groupBy: 'purpose', items: [
    { purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
  ] },
  { groupBy: 'product', items: [{
    productId: PRODUCT_ID,
    productNameSnapshot: 'İmplant Seti',
    productSkuSnapshot: null,
    productModelSnapshot: null,
    unit: 'Kutu',
    quantity: '12.500',
  }] },
  { groupBy: 'staff', items: [{
    staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: true },
    unit: 'Kutu',
    quantity: '3.000',
  }] },
] as const;

for (const payload of validDeliveryPayloads) {
  const response = { ...payload, range, total: 1, limit: 50, offset: 0 };
  expect(() => parseDeliveryReport({ ...response, unexpected: true }))
    .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  expect(() => parseDeliveryReport({ ...response, limit: 0 }))
    .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
}
```

Assert query builders omit null filters, always encode scalar values once, keep exact
dates, and never call `Number` or `parseFloat` on quantity. Test canonical URL parsing for
partial/invalid dates, invalid group, negative offset, empty/malformed Staff UUID, and a
syntactically valid unavailable Staff UUID that must remain in state.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `cd web && npm test -- --run tests/reports-api.test.ts tests/report-search.test.ts`

Expected: FAIL because the report web contract files do not exist.

- [x] **Step 3: Implement strict discriminated parsers and URL helpers**

Mirror the server DTO property names exactly. Keep decimal values as strings with a
three-decimal response check:

```ts
function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

function exactObject(value: unknown, field: string, keys: readonly string[]) {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !keys.includes(key))) invalid(field);
  return parsed;
}

function array(value: unknown, field: string) {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
): T[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(field);
  return value as T[number];
}

function nonNegativeInteger(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) invalid(field);
  return parsed;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed <= 0) invalid(field);
  return parsed;
}

function decimalQuantity(value: unknown, field: string) {
  const parsed = string(value, field);
  if (!/^(0|[1-9]\d*)\.\d{3}$/.test(parsed)) invalid(field);
  return parsed;
}

const DELIVERY_REPORT_KEYS = {
  day: ['groupBy', 'items', 'range', 'total', 'limit', 'offset'],
  purpose: ['groupBy', 'items', 'range', 'total', 'limit', 'offset'],
  product: ['groupBy', 'items', 'range', 'total', 'limit', 'offset'],
  staff: ['groupBy', 'items', 'range', 'total', 'limit', 'offset'],
} as const;

export function parseDeliveryReport(value: unknown): DeliveryReportResponse {
  const candidate = object(value);
  const groupBy = oneOf(candidate.groupBy, 'groupBy',
    ['day', 'purpose', 'product', 'staff'] as const);
  const response = exactObject(
    value,
    `deliveryReport.${groupBy}`,
    DELIVERY_REPORT_KEYS[groupBy],
  );
  const base = parsePageAndRange(response);
  if (groupBy === 'day') return {
    groupBy,
    ...base,
    items: array(response.items, 'items').map(parseDeliveryDayItem),
  };
  if (groupBy === 'purpose') return {
    groupBy,
    ...base,
    items: array(response.items, 'items').map(parseDeliveryPurposeItem),
  };
  if (groupBy === 'product') return {
    groupBy,
    ...base,
    items: array(response.items, 'items').map(parseDeliveryProductItem),
  };
  return {
    groupBy,
    ...base,
    items: array(response.items, 'items').map(parseDeliveryStaffItem),
  };
}
```

Each discriminant first applies its top-level exact key allowlist, and each item parser
must call `exactObject` with its exact property allowlist before reading fields. This
rejects extra top-level properties and prevents a day item from accepting
purpose/Product/Staff properties.

Widen only the read-list type and export its existing parser:

```ts
export type JobCardListItem = {
  id: string;
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK';
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  staffCompletedAt: string | null;
  customer: RelatedName | null;
  contact: RelatedName | null;
  assignee: RelatedName;
  deliveryItemCount: number;
};
```

`parseJobCardListItem` uses
`oneOf(v.type, 'type', ['PRODUCT_DELIVERY', 'GENERAL_TASK'] as const)`. Keep the full
`JobCard` parser and create/filter types Product Delivery-only. Reuse the exported list
parser for approvals:

```ts
function parseApprovalItem(value: unknown): ApprovalItem {
  const row = object(value);
  const item = parseJobCardListItem(row);
  const waitingMinutes = nonNegativeInteger(row.waitingMinutes, 'waitingMinutes');
  return { ...item, waitingMinutes };
}
```

Request builders use `URLSearchParams` and existing `request` so backend `ApiError` status,
code, details, and retryable behavior are preserved. `report-search.ts` exports:

```ts
export function readDashboardSearch(search: URLSearchParams): DashboardUrlState;
export function readDeliverySearch(search: URLSearchParams): DeliveryUrlState;
export function readApprovalSearch(search: URLSearchParams): ApprovalUrlState;
export function dashboardSearch(state: DashboardUrlState): URLSearchParams;
export function deliverySearch(state: DeliveryUrlState): URLSearchParams;
export function approvalSearch(state: ApprovalUrlState): URLSearchParams;
export function validateRequestedRange(from: string, to: string):
  | { ok: true; value: { from: string; to: string } }
  | { ok: false; errors: Array<{ field: 'from' | 'to'; message: string }> };
```

Each read result includes `canonical: boolean`. URL dates use the same strict date and
366-day checks as the server only to canonicalize navigation; the server remains
authoritative. Preserve a syntactically valid Staff UUID even when the later API request
returns not found.

Define URL state without hidden component defaults:

```ts
export type DashboardUrlState = {
  from: string | null;
  to: string | null;
  canonical: boolean;
};
export type DeliveryUrlState = {
  from: string | null;
  to: string | null;
  groupBy: 'day' | 'purpose' | 'product' | 'staff';
  staffUserId: string | null;
  offset: number;
  canonical: boolean;
};
export type ApprovalUrlState = { offset: number; canonical: boolean };
```

`parsePageAndRange` has one exact implementation shared by all top-level parsers:

```ts
function parsePageAndRange(value: Record<string, unknown>) {
  const limit = positiveInteger(value.limit, 'limit');
  if (limit > 200) invalid('limit');
  return {
    range: parseResolvedRange(value.range),
    total: nonNegativeInteger(value.total, 'total'),
    limit,
    offset: nonNegativeInteger(value.offset, 'offset'),
  };
}
```

Define and use `parseDeliveryDayItem`, `parseDeliveryPurposeItem`,
`parseDeliveryProductItem`, and `parseDeliveryStaffItem` in this file; each first calls
`exactObject` with exactly the keys in its Task 1 DTO and returns that DTO without adding
or dropping properties.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/reports-api.test.ts tests/report-search.test.ts`

Expected: PASS for four exact delivery shapes, quantity strings, ApprovalItem reuse, API
error preservation, and canonical URL parsing.

- [x] **Step 5: Run transport regressions and web build**

Run: `cd web && npm test -- --run tests/jobs-api.test.ts tests/people-client.test.ts tests/reports-api.test.ts && npm run build`

Expected: PASS without a new package or lockfile change.

- [x] **Step 6: Commit**

```bash
git add web/src/reports/report-types.ts web/src/reports/reports-api.ts \
  web/src/reports/report-search.ts web/src/jobs/jobs-api.ts \
  web/tests/reports-api.test.ts web/tests/report-search.test.ts \
  web/tests/jobs-api.test.ts
git commit -m "feat: add runtime validated report client"
```

### Task 10: Staff Report UI

**Files:**
- Create: `web/src/reports/StaffOperationalReport.tsx`
- Modify: `web/src/StaffProfiles.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/AppShell.tsx`
- Modify: `web/src/paths.ts`
- Modify: `web/src/styles.css`
- Create: `web/tests/staff-operational-report.test.tsx`
- Modify: `web/tests/staff-profiles.test.tsx`
- Modify: `web/tests/router.test.tsx`
- Modify: `web/tests/app-shell.test.tsx`

**Interfaces:**
- Consumes: `getOwnStaffReport`, `getStaffReport`, `StaffReportResponse`, existing
  People profile APIs, and `CurrentUser`.
- Produces: Staff own operational report inside `/staff`; Admin/Manager Staff report at
  `/staff/:staffUserId/reports`; unchanged People profile counter DTO compatibility.

- [x] **Step 1: Write failing role-specific UI and route tests**

Test Staff own loading, success, no-delivery, error, and retry states. Test management
report loading, inactive label, safe not-found error, retry, exact default echoed range,
five counters, and purpose/unit rows. Prove there is no Staff date/group filter, ranking,
score, target, revenue, stock, or financial copy.

```ts
expect(ownReportHtml).toContain('1 Temmuz 2026 – 31 Temmuz 2026');
expect(ownReportHtml).toContain('Onaylı teslimler');
expect(ownReportHtml).toContain('12.500');
expect(ownReportHtml).toContain('Birim belirtilmedi');
expect(ownReportHtml).not.toMatch(/puan|sıralama|ciro|stok|komisyon/i);
```

Assert Manager/Admin profile pages link to `/staff/:staffUserId/reports`, Staff navigation
uses `/staff`, Staff never sees another profile/report link, and Back/Forward-style route
entries render stable content.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `cd web && npm test -- --run tests/staff-operational-report.test.tsx tests/staff-profiles.test.tsx tests/router.test.tsx tests/app-shell.test.tsx`

Expected: FAIL because the report component and management route are absent.

- [x] **Step 3: Implement own and management Staff report states**

Add exact paths:

```ts
reports: '/reports',
deliveryReports: '/reports/deliveries',
approvalReports: '/reports/approvals',
staffReport: (id: string) => `/staff/${encoded(id)}/reports`,
```

Staff navigation points to `paths.staff`. Add a management-only route:

```tsx
<Route path="/staff/:staffUserId/reports"
  element={user.role === 'STAFF'
    ? <ForbiddenView />
    : <StaffReportRoute user={user} />} />
```

Implement an explicit reusable state component:

```tsx
export function StaffOperationalReport({ report }: {
  report: StaffReportResponse;
}) {
  return <section className="staff-operational-report" aria-labelledby="staff-report-title">
    <div className="report-section-heading">
      <div>
        <p className="eyebrow">Operasyon raporu</p>
        <h2 id="staff-report-title">Aylık çalışma özeti</h2>
      </div>
      {!report.staff.isActive && <span className="status-label">Pasif personel</span>}
    </div>
    <p>{formatReportRange(report.range)}</p>
    <StaffCounterList counters={report.counters} />
    <DeliveryPurposeTable items={report.deliveriesByPurpose} />
  </section>;
}
```

Keep presentation helpers local and exhaustive:

```tsx
const staffCounterLabels: Record<keyof StaffOperationalCounters, string> = {
  openJobCards: 'Açık işler',
  waitingApproval: 'Onay bekliyor',
  revisionRequested: 'Düzeltme istendi',
  overdueJobCards: 'Geciken',
  completedInPeriod: 'Dönemde tamamlandı',
};

const purposeLabels: Record<DeliveryPurpose, string> = {
  SALE: 'Satış',
  SAMPLE: 'Numune',
  CONSIGNMENT: 'Konsinye',
  RETURN: 'İade',
  OTHER: 'Diğer',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}

function formatReportRange(range: ResolvedReportRange) {
  return `${formatDate(range.from)} – ${formatDate(range.to)} · ${range.timezone}`;
}

function StaffCounterList({ counters }: { counters: StaffOperationalCounters }) {
  return <dl className="counter-grid">
    {(Object.keys(staffCounterLabels) as Array<keyof StaffOperationalCounters>)
      .map((key) => <div key={key}><dt>{staffCounterLabels[key]}</dt>
        <dd>{counters[key]}</dd></div>)}
  </dl>;
}

function DeliveryPurposeTable({ items }: { items: DeliveryPurposeItem[] }) {
  if (items.length === 0) return <p>Bu dönemde onaylı teslim bulunmuyor.</p>;
  return <table className="report-table"><caption>Onaylı teslimler</caption>
    <thead><tr><th scope="col">Amaç</th><th scope="col">Birim</th>
      <th scope="col">Miktar</th></tr></thead>
    <tbody>{items.map((item) => <tr key={JSON.stringify([item.purpose, item.unit])}>
      <th scope="row">{purposeLabels[item.purpose]}</th>
      <td>{item.unit ?? 'Birim belirtilmedi'}</td><td>{item.quantity}</td>
    </tr>)}</tbody>
  </table>;
}
```

`StaffProfilesScreen` loads existing profile data and the Staff report independently so a
report retry does not discard profile facts. Staff calls `/api/reports/staff/me`; the
management route calls `/api/reports/staff/:userId`. The own and management views display
the backend-echoed current-month range and expose no filter controls. The purpose table
uses Turkish purpose labels, exact quantity text, and `Birim belirtilmedi` for null.
Existing profile counter compatibility remains tested against `/api/staff` responses.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/staff-operational-report.test.tsx tests/staff-profiles.test.tsx tests/router.test.tsx tests/app-shell.test.tsx`

Expected: PASS for both roles, stable routes, inactive identity, report states, and no
independent Staff report filters.

- [x] **Step 5: Run People/web regressions and build**

Run: `cd web && npm test -- --run tests/people-client.test.ts tests/staff-profiles.test.tsx tests/staff-operational-report.test.tsx tests/router.test.tsx && npm run build`

Expected: PASS; user/profile editing remains unchanged.

- [x] **Step 6: Commit**

```bash
git add web/src/reports/StaffOperationalReport.tsx web/src/StaffProfiles.tsx \
  web/src/AppRouter.tsx web/src/AppShell.tsx web/src/paths.ts web/src/styles.css \
  web/tests/staff-operational-report.test.tsx web/tests/staff-profiles.test.tsx \
  web/tests/router.test.tsx web/tests/app-shell.test.tsx
git commit -m "feat: add staff operational report views"
```

### Task 11: Management Reports UI and URL Ownership

**Files:**
- Create: `web/src/reports/ReportsDashboard.tsx`
- Create: `web/src/reports/DeliveryReport.tsx`
- Create: `web/src/reports/ApprovalReport.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/AppShell.tsx`
- Modify: `web/src/styles.css`
- Create: `web/tests/reports-dashboard.test.tsx`
- Create: `web/tests/delivery-report.test.tsx`
- Create: `web/tests/approval-report.test.tsx`
- Create: `web/tests/reports-navigation.test.tsx`

**Interfaces:**
- Consumes: report API functions and canonical search helpers from Task 9; stable paths
  from Task 10; `CurrentUser` role; existing
  `listStaff(status: 'active' | 'inactive' | 'all')` from
  `web/src/services/people-api.ts`.
- Produces: `/reports`, `/reports/deliveries`, and `/reports/approvals`; management-only
  `Raporlar` navigation; URL-owned date/group/Staff/offset behavior.

- [x] **Step 1: Write failing screen, navigation, and history tests**

Test dashboard point-in-time versus period labels, a complete trend table including zero
days, delivery group-specific headers, approval summary and oldest queue, loading/empty/
error/retry states, and mobile-safe semantic structures.

Use `MemoryRouter` entries to prove direct URLs, refresh-equivalent remounts, Back, Forward,
and replace canonicalization. Assert:

```ts
expect(location.search).toBe('?from=2026-07-01&to=2026-07-31');
expect(deliveryLocation.search).toBe(
  `?from=2026-07-01&to=2026-07-31&groupBy=staff&staffUserId=${STAFF_ID}&offset=0`,
);
expect(historyLengthAfterCanonicalReplace).toBe(historyLengthBeforeCanonicalReplace);
```

Changing `from`, `to`, `groupBy`, or `staffUserId` must write `offset=0`. Invalid URL
values are replaced; a syntactically valid unavailable Staff ID remains in the URL and
shows the API error. Staff has neither report navigation nor usable direct management
routes. Add explicit Staff filter tests: Admin loads `listStaff('all')` and sees active
and inactive labels; Manager loads `listStaff('active')`; loading the options does not
block the delivery request; an options failure leaves the report visible, shows an
inline retry, and still permits clearing an existing filter; a valid URL Staff ID absent
from the available options remains selected as an unavailable synthetic option. Assert
the filter is a `<select>`, not a free-text UUID input, and that empty or tampered values
are never written to the request URL.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `cd web && npm test -- --run tests/reports-dashboard.test.tsx tests/delivery-report.test.tsx tests/approval-report.test.tsx tests/reports-navigation.test.tsx`

Expected: FAIL because management report screens and routes are absent.

- [x] **Step 3: Implement management routes and canonical URL effects**

Register role-gated routes:

```tsx
<Route path={paths.reports} element={user.role === 'STAFF'
  ? <ForbiddenView /> : <ReportsDashboard />} />
<Route path={paths.deliveryReports} element={user.role === 'STAFF'
  ? <ForbiddenView /> : <DeliveryReport />} />
<Route path={paths.approvalReports} element={user.role === 'STAFF'
  ? <ForbiddenView /> : <ApprovalReport />} />
```

Add `Raporlar` to AppShell destinations only when role is Admin or Manager. Every screen
reads `useSearchParams`; if `read*Search` reports non-canonical state, call
`setSearchParams(canonicalParams, { replace: true })`. When an omitted dashboard or
delivery range returns successfully, write its echoed `from`/`to` with replace navigation.

Load Staff filter options independently from the report request. Reuse the existing
People client and its current authorization contract; do not add a Reports lookup
endpoint:

```tsx
import { listStaff, type StaffProfile } from '../services/people-api';

type StaffOptionsState =
  | { status: 'loading'; items: StaffProfile[] }
  | { status: 'ready'; items: StaffProfile[] }
  | { status: 'error'; items: StaffProfile[] };

const [staffOptions, setStaffOptions] = useState<StaffOptionsState>({
  status: 'loading',
  items: [],
});
const [staffOptionsReloadKey, setStaffOptionsReloadKey] = useState(0);
const [staffDraft, setStaffDraft] = useState(state.staffUserId ?? '');
const staffListStatus = user.role === 'ADMIN' ? 'all' : 'active';

useEffect(() => setStaffDraft(state.staffUserId ?? ''), [state.staffUserId]);

useEffect(() => {
  let current = true;
  setStaffOptions({ status: 'loading', items: [] });
  void listStaff(staffListStatus).then(
    (items) => current && setStaffOptions({ status: 'ready', items }),
    () => current && setStaffOptions({ status: 'error', items: [] }),
  );
  return () => { current = false; };
}, [staffListStatus, staffOptionsReloadKey]);
```

Admin sees active and inactive Staff, with inactive options suffixed `(Pasif)`. Manager
sees active Staff because the existing People policy rejects non-active list modes for
Managers. The Reports API still accepts an inactive same-organization Staff ID. When the
canonical URL contains a valid ID missing from the loaded list, insert one synthetic
option labelled `Seçili personel (listede yok)` so the URL and server response remain
authoritative. During loading the select is disabled but the report still loads. On list
error, render an inline `Personel seçenekleri yüklenemedi.` message and retry button;
enable a select containing `Tüm personel` plus any synthetic current selection so the
user can clear the filter without losing the report.

```tsx
const selectedIsAvailable = staffOptions.items.some(
  (profile) => profile.user.id === staffDraft,
);
const showUnavailableSelection = staffDraft !== '' && !selectedIsAvailable;

<select name="staffUserId" disabled={staffOptions.status === 'loading'}
  value={staffDraft} onChange={(event) => setStaffDraft(event.target.value)}>
  <option value="">Tüm personel</option>
  {showUnavailableSelection &&
    <option value={staffDraft}>Seçili personel (listede yok)</option>}
  {staffOptions.items.map((profile) =>
    <option key={profile.user.id} value={profile.user.id}>
      {profile.user.name}{profile.user.isActive ? '' : ' (Pasif)'}
    </option>)}
</select>
{staffOptions.status === 'error' && <div className="field-error" role="alert">
  Personel seçenekleri yüklenemedi.
  <button type="button" onClick={() => setStaffOptionsReloadKey((value) => value + 1)}>
    Tekrar dene
  </button>
</div>}
```

Use accessible user-submitted filter validation before navigation:

```tsx
type DeliveryFilterResult =
  | { ok: true; value: Omit<DeliveryUrlState, 'canonical'> }
  | { ok: false; errors: Array<{ field: string; message: string }> };

function validateReportFilterForm(
  data: FormData,
  allowedStaffIds: ReadonlySet<string>,
): DeliveryFilterResult {
  const from = String(data.get('from') ?? '');
  const to = String(data.get('to') ?? '');
  const range = validateRequestedRange(from, to);
  if (!range.ok) return range;
  const groupBy = String(data.get('groupBy') ?? '');
  if (!['day', 'purpose', 'product', 'staff'].includes(groupBy)) {
    return { ok: false, errors: [{ field: 'groupBy', message: 'Geçerli bir gruplama seçin.' }] };
  }
  const selectedStaffUserId = String(data.get('staffUserId') ?? '');
  if (selectedStaffUserId !== '' && !allowedStaffIds.has(selectedStaffUserId)) {
    return { ok: false, errors: [{
      field: 'staffUserId', message: 'Geçerli bir personel seçin.',
    }] };
  }
  const staffUserId = selectedStaffUserId || null;
  return {
    ok: true,
    value: {
      ...range.value,
      groupBy: groupBy as DeliveryUrlState['groupBy'],
      staffUserId,
      offset: 0,
    },
  };
}

function submitFilters(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const allowedStaffIds = new Set(staffOptions.items.map((profile) => profile.user.id));
  if (state.staffUserId !== null) allowedStaffIds.add(state.staffUserId);
  const result = validateReportFilterForm(
    new FormData(event.currentTarget),
    allowedStaffIds,
  );
  if (!result.ok) {
    setErrors(result.errors);
    requestAnimationFrame(() => errorSummaryRef.current?.focus());
    return;
  }
  setSearchParams(deliverySearch({ ...result.value, offset: 0 }));
}
```

The dashboard labels the first four counters `Şu an`; completion/cancellation counters
use the selected period label. Render one restrained aria-hidden graphic and a complete
authoritative table:

```tsx
import type { CSSProperties } from 'react';

const formatDate = (value: string) => new Intl.DateTimeFormat(
  'tr-TR', { dateStyle: 'medium', timeZone: 'UTC' },
).format(new Date(`${value}T00:00:00Z`));

<div className="completed-trend" aria-hidden="true">
  {report.completedTrend.map((point) =>
    <span key={point.date} style={{ '--count': point.count } as CSSProperties} />)}
</div>
<table>
  <caption>Tamamlanan işlerin günlük dağılımı</caption>
  <thead><tr><th scope="col">Tarih</th><th scope="col">Tamamlanan iş</th></tr></thead>
  <tbody>{report.completedTrend.map((point) =>
    <tr key={point.date}><th scope="row">{formatDate(point.date)}</th>
      <td>{point.count}</td></tr>)}</tbody>
</table>
```

Delivery presentation switches exhaustively on `report.groupBy`; it never combines rows
or parses quantity. Desktop tables reflow into labelled cards below 720px. Approval
summary uses text labels for every bucket and renders canonical JobCard fields plus
`waitingMinutes`; pagination owns only `offset`. Use the exhaustive read-only label map
`{ PRODUCT_DELIVERY: 'Ürün teslimi', GENERAL_TASK: 'Genel görev' }` for approval item
types; this does not activate General Task creation or mutation UI.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/reports-dashboard.test.tsx tests/delivery-report.test.tsx tests/approval-report.test.tsx tests/reports-navigation.test.tsx`

Expected: PASS for screen states, stable routes, URL ownership, offset reset, default
range replacement, unavailable Staff error, and role navigation.

- [x] **Step 5: Run router/shell/accessibility regressions and build**

Run: `cd web && npm test -- --run tests/router.test.tsx tests/app-shell.test.tsx tests/accessibility-contract.test.ts tests/reports-navigation.test.tsx && npm run build`

Expected: PASS with no chart package and no page-level horizontal overflow.

- [x] **Step 6: Commit**

```bash
git add web/src/reports/ReportsDashboard.tsx \
  web/src/reports/DeliveryReport.tsx web/src/reports/ApprovalReport.tsx \
  web/src/AppRouter.tsx web/src/AppShell.tsx web/src/styles.css \
  web/tests/reports-dashboard.test.tsx web/tests/delivery-report.test.tsx \
  web/tests/approval-report.test.tsx web/tests/reports-navigation.test.tsx
git commit -m "feat: add management operational reports"
```

### Task 12: Disposable PostgreSQL Acceptance and Query-Plan Evidence

**Files:**
- Create: `server/tests/reports-postgres.test.ts`

**Interfaces:**
- Consumes: migrations `001_auth_foundation.sql` through
  `006_jobcard_workspace.sql`, `PostgresReportsRepository`,
  `PostgresJobCardRepository`, and `ReportsService`.
- Produces: one PostgreSQL-gated acceptance suite proving live constraints, timezone
  boundaries, aggregation semantics, authorization scope, and inspectable query plans.

- [ ] **Step 1: Write the gated acceptance test shell and verify it is absent**

Add the test import and fixture contract first. The suite must use an isolated schema and
always drop it in `finally`:

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Operational reports PostgreSQL contract', () => {
  it('derives trusted reports from migrations 001 through 006', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reports_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations001Through006(pool);
      const fixture = await seedReportFixture(pool);
      await verifyReports(pool, fixture);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
```

- [ ] **Step 2: Run the isolated test and verify RED**

Run: `cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run tests/reports-postgres.test.ts`

Expected: FAIL because fixture and verification helpers are not implemented. If
`TEST_DATABASE_URL` is empty, configure a disposable PostgreSQL 16+ database before
continuing; a skipped run does not satisfy this task.

- [ ] **Step 3: Implement the complete cross-organization fixture and assertions**

Create deterministic IDs/times and insert at least:

```ts
type ReportFixture = {
  organizationOne: string;
  organizationTwo: string;
  admin: SafeUser;
  manager: SafeUser;
  activeStaff: SafeUser;
  inactiveStaff: SafeUser;
  otherOrganizationStaff: SafeUser;
  requestTime: Date;
  futureJobId: string;
  expected: {
    activeAllTypes: number;
    purposeRows: DeliveryPurposeItem[];
    groupedRows: number;
  };
};

const requestTime = new Date('2026-07-14T12:00:00.000Z');

function bucketTotal(summary: ApprovalSummary) {
  return summary.under2Hours + summary.between2And8Hours
    + summary.between8And24Hours + summary.over24Hours;
}
```

Define `applyMigrations001Through006(pool)` by reading the six existing SQL files with
`readFile` and executing them in filename order. Define
`seedReportFixture(pool): Promise<ReportFixture>` with explicit parameterized inserts and
`verifyReports(pool, fixture): Promise<void>` with the repository/service calls and
assertions listed below; all three helpers live in this test file.

The SQL fixture must contain two organizations with distinct timezones. Use
`Europe/Berlin` for organization one and `Asia/Tokyo` for organization two so one fixture
has a real DST transition while the other proves organization isolation. Include Admin,
Manager, active Staff, inactive Staff, and another-organization Staff;
`PRODUCT_DELIVERY` and `GENERAL_TASK`; every lifecycle status; a JobCard reassigned before
reporting; a submitter different from the assignee; approved and unapproved deliveries;
null, `kutu`, and `Kutu` units; two historical Product snapshot names around a catalog
rename and deactivation; leap-day and local day-edge deliveries; exact 2h/8h/24h approval
ages; and a future Staff submission time.

For the 2026 Europe/Berlin spring transition, insert approved same-unit deliveries at
`2026-03-28T23:30:00.000Z` (`1.000`), `2026-03-29T21:30:00.000Z` (`2.000`), and
`2026-03-29T22:30:00.000Z` (`4.000`). Query the exact local range
`2026-03-29..2026-03-29`; the first two rows belong to March 29 across the UTC+1 to UTC+2
change, while the third is already local March 30 and must be excluded. This fixture
prohibits a fixed-offset implementation of the 23-hour local day.

Exercise repository and service calls and assert:

```ts
const dstDayReport = await reports.getDeliveryReport({
  organizationId: fixture.organizationOne,
  requestedRange: { from: '2026-03-29', to: '2026-03-29' },
  requestTime: fixture.requestTime,
  groupBy: 'day',
  staffUserId: null,
  limit: 50,
  offset: 0,
});

expect(dashboard.counters.activeJobCards).toBe(fixture.expected.activeAllTypes);
expect(staffReport.staff.userId).toBe(fixture.activeStaff.id);
expect(staffReport.deliveriesByPurpose).toEqual(fixture.expected.purposeRows);
expect(deliveries.total).toBe(fixture.expected.groupedRows);
expect(deliveries.items.every((item) => /^\d+\.\d{3}$/.test(item.quantity))).toBe(true);
expect(approvals.summary.pendingCount).toBe(approvals.total);
expect(bucketTotal(approvals.summary)).toBe(approvals.total);
expect(approvals.items.find((item) => item.id === fixture.futureJobId)?.waitingMinutes)
  .toBe(0);
expect(dstDayReport).toMatchObject({
  groupBy: 'day',
  range: { from: '2026-03-29', to: '2026-03-29', timezone: 'Europe/Berlin' },
  total: 1,
  items: [{ date: '2026-03-29', unit: 'Kutu', quantity: '3.000' }],
});
```

Prove the reassigned JobCard belongs to its persisted current `assigned_to`, not creator,
submitter, approver, or activity actor. Prove cross-organization Staff and delivery rows
never appear. Prove `GENERAL_TASK` contributes to dashboard/Staff/approval counts but not
delivery quantities. Prove approved deliveries use `delivered_at` organization-local
boundaries, including the Europe/Berlin DST transition without a fixed UTC offset, and
completion counts use `manager_approved_at`.

Capture the exact SQL executed by production repositories, then explain those statements
inside the same schema. The required evidence mode is
`EXPLAIN (ANALYZE, BUFFERS)`; JSON format is added only for stable automated inspection:

```ts
const calls: Array<{ text: string; values: readonly unknown[] }> = [];
const recordingPool = {
  query: async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    return pool.query(text, [...values]);
  },
};
const reports = new PostgresReportsRepository(recordingPool as never);
const jobCards = new PostgresJobCardRepository(recordingPool as never);
await exerciseEveryReportQuery(reports, jobCards, fixture);

for (const call of calls.filter(({ text }) => /^\s*(WITH|SELECT)/i.test(text))) {
  const explain = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${call.text}`,
    [...call.values],
  );
  expect(explain.rows[0]?.['QUERY PLAN']).toBeDefined();
  if (process.env.REPORT_EXPLAIN === '1') {
    process.stdout.write(`${JSON.stringify(explain.rows[0]?.['QUERY PLAN'], null, 2)}\n`);
  }
}
```

Define `exerciseEveryReportQuery` in the same test and call Staff `getMany`, dashboard,
Staff purpose summary, all four delivery groups, approval summary, and approval items once
with the fixed fixture request time. The recording pool delegates to the real isolated
Pool, so every explained statement is the production SQL rather than a test copy.

Do this for Staff batch summaries, dashboard, each delivery group, approval summary, and
approval items. Do not assert a specific planner node. If observed plans show a material
problem at representative volume, stop without a migration and present the evidence for
user review.

- [ ] **Step 4: Run PostgreSQL acceptance and verify GREEN**

Run: `cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run tests/reports-postgres.test.ts`

Expected: PASS with the test executed, not skipped, and the isolated schema removed.

- [ ] **Step 5: Capture readable query-plan evidence and run all gated suites**

Run:

```bash
cd server
REPORT_EXPLAIN=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npm test -- --run tests/reports-postgres.test.ts --reporter=verbose
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
```

Expected: the report test prints PostgreSQL JSON plans; the complete server suite passes
with every PostgreSQL-gated test executed. No `007` migration appears in the diff.

- [ ] **Step 6: Commit**

```bash
git add server/tests/reports-postgres.test.ts
git commit -m "test: verify reports against PostgreSQL"
```

### Task 13: Accessibility and Playwright Acceptance

**Files:**
- Create: `web/tests/reports-accessibility.test.tsx`
- Modify: `web/tests/accessibility-contract.test.ts`
- Modify: `web/tests/reports-navigation.test.tsx`
- Modify: `web/src/reports/ReportsDashboard.tsx`
- Modify: `web/src/reports/DeliveryReport.tsx`
- Modify: `web/src/reports/ApprovalReport.tsx`
- Modify: `web/src/reports/StaffOperationalReport.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: completed report screens from Tasks 10–11 and existing shared focus, shell,
  and responsive CSS contracts.
- Produces: automated semantic/reflow guards plus recorded Playwright MCP acceptance for
  Manager desktop, Staff desktop, 390×844 mobile, and 320 CSS px effective width.

- [ ] **Step 1: Write failing accessibility and interaction tests**

Assert report landmarks/headings, captions, header scopes, date labels and associated
errors, focusable error summary, keyboard filter/pagination/retry controls, textual trend
equivalent, inactive Staff text, bucket text, 44px controls, reduced motion, and mobile
reflow classes.

```ts
expect(container.querySelector('table caption')?.textContent)
  .toBe('Tamamlanan işlerin günlük dağılımı');
expect(container.querySelector('[aria-hidden="true"].completed-trend')).not.toBeNull();
expect(container.querySelectorAll('table thead th[scope="col"]').length).toBeGreaterThan(0);
expect(css).toMatch(/\.report-filter (button|select|input)[^{]*\{[^}]*min-height: 2\.75rem;/);
expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.report-table-row/);
```

Test that submitting an invalid date focuses the error summary or first invalid field;
filter and pagination actions are buttons/forms/links rather than pointer-only handlers;
and Staff report navigation is absent.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd web && npm test -- --run tests/reports-accessibility.test.tsx tests/accessibility-contract.test.ts tests/reports-navigation.test.tsx`

Expected: FAIL on any missing semantics, focus target, responsive rule, or role exclusion.

- [ ] **Step 3: Apply the smallest semantic and CSS corrections**

Use semantic HTML before ARIA and preserve the existing focus token:

```tsx
{errors.length > 0 &&
  <div ref={errorSummaryRef} className="form-error" role="alert" tabIndex={-1}>
    <h2>Filtreleri kontrol edin</h2>
    <ul>{errors.map((error) => <li key={error.field}>{error.message}</li>)}</ul>
  </div>}
```

Use responsive row labels and no page-level horizontal scrolling:

```css
.report-filter button,
.report-filter input,
.report-filter select,
.report-pagination a,
.report-pagination button { min-height: 2.75rem; }

.report-workspace,
.report-section,
.report-table-wrap { min-width: 0; max-width: 100%; }

@media (max-width: 720px) {
  .report-table thead { position: absolute; inline-size: 1px; block-size: 1px;
    overflow: hidden; clip-path: inset(50%); }
  .report-table tr { display: grid; grid-template-columns: 1fr; }
  .report-table td::before { content: attr(data-label); font-weight: 650; }
}

@media (prefers-reduced-motion: reduce) {
  .completed-trend span { transition: none; }
}
```

Do not add motion, chart, table, accessibility, or browser packages.

- [ ] **Step 4: Run focused accessibility tests and verify GREEN**

Run: `cd web && npm test -- --run tests/reports-accessibility.test.tsx tests/accessibility-contract.test.ts tests/reports-navigation.test.tsx`

Expected: PASS for semantics, focus, 44px controls, role exclusion, reflow, and reduced
motion.

- [ ] **Step 5: Run Playwright MCP acceptance against the live stack**

Start the migrated server and web app in separate terminals:

```bash
cd server && npm run migrate && npm run dev
cd web && npm run dev
```

Using Playwright MCP, verify and record all of these scenarios:

1. Manager desktop: direct `/reports`, dashboard date validation/focus, trend graphic and
   complete table, delivery group/filter/pagination, unavailable valid Staff error,
   approval oldest queue, Back, Forward, refresh, and deep link.
2. Staff desktop: `/staff` own summary works; `Raporlar` navigation is absent; direct
   `/reports`, `/reports/deliveries`, `/reports/approvals`, and another Staff report show
   the established forbidden view.
3. 390×844 mobile: drawer navigation, counters, filters, tables-as-cards, pagination,
   retry, visible focus, and no horizontal page overflow.
4. 320 CSS px effective width: critical actions and all report content reflow without
   horizontal page scrolling.
5. Keyboard only: reach every navigation, filter, date, group, Staff, pagination, retry,
   and Staff-report link; focus remains visible and returns to a valid target.
6. 200% text enlargement and applicable 400% reflow: content is not clipped or overlapped.
7. Reduced motion: report understanding and state feedback remain complete.
8. Color independence: point-in-time/period counters, delivery groups, approval buckets,
   inactive Staff, and errors all have textual meaning.

Expected: every scenario passes. The repository still contains no Playwright config or
dependency; acceptance is performed through Playwright MCP.

- [ ] **Step 6: Commit**

```bash
git add web/tests/reports-accessibility.test.tsx \
  web/tests/accessibility-contract.test.ts web/tests/reports-navigation.test.tsx \
  web/src/reports/ReportsDashboard.tsx web/src/reports/DeliveryReport.tsx \
  web/src/reports/ApprovalReport.tsx web/src/reports/StaffOperationalReport.tsx \
  web/src/styles.css
git commit -m "test: harden report accessibility"
```

### Task 14: Full Verification, SSOT Closeout, Memory, and Push

**Files:**
- Modify: `README.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify after reindex: `.codebase-memory/graph.db.zst` and the repository's existing
  Codebase Memory metadata files produced by the configured indexer.

**Interfaces:**
- Consumes: every server/web deliverable and acceptance result from Tasks 1–13.
- Produces: verified Slice 08 documentation, refreshed server/web code graphs, persistent
  project-memory observations, a clean pushed feature branch, and PR-ready evidence.

- [ ] **Step 1: Run the closeout documentation preflight and verify RED**

Run:

```bash
rg -n "Not implemented yet|operational reports" README.md
rg -n "implemented through Slice 07" SERVORA_MED_API_DRAFT.md
rg -n "## 11. Slice 08" SERVORA_MED_MVP_SLICES.md
```

Expected: output still describes Slice 08 as unimplemented or unchecked; closeout claims
must not change before verification.

- [ ] **Step 2: Run every automated and live verification gate**

Run:

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
cd server && npm audit --audit-level=high
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --audit-level=high
```

Expected: both builds pass; ordinary and PostgreSQL-enabled server suites pass; the web
suite passes; both audits report zero high-severity vulnerabilities. Confirm the
PostgreSQL-enabled report test executed rather than skipped. Re-run the complete Task 13
Playwright MCP matrix if any report UI or CSS changed after browser acceptance.

- [ ] **Step 3: Verify architecture, scope, and migration boundaries**

Run:

```bash
git diff --name-only origin/main...HEAD | rg 'server/src/db/migrations' || true
rg -n "materialized view|report table|cache table|commission|ranking|inventory valuation" \
  server/src/modules/reports web/src/reports
rg -n "parseFloat|Number\(.*quantity|staff_completed_by.*assigned|created_by.*assigned" \
  server/src/modules/reports web/src/reports
```

Expected: no migration file is added; source contains no report/cache/materialized view,
financial/ranking/inventory scope, quantity conversion, or alternate Staff ownership.
Allowed explanatory test text must not correspond to production behavior.

- [ ] **Step 4: Update verified SSOT documentation**

Write only observed behavior and exact verification totals:

```text
README.md
- Move operational reports into implemented scope.
- Record five report endpoints, four stable UI routes, canonical Staff counter sharing,
  exact quantity strings, approval-age semantics, and exact final test/build/audit/
  Playwright results.

SERVORA_MED_API_DRAFT.md
- Change the status to: Living API contract; implemented through Slice 08 Operational
  Reports and verified closeout.
- Preserve the already-approved exact DTO and validation contract.

SERVORA_MED_MVP_SLICES.md
- Mark every verified Slice 08 acceptance checkbox complete.
- Do not mark Slice 09 or later work complete.

SERVORA_MED_ARCHITECTURE_PLAN.md
- Record Reports as a read-only modular-monolith read model.
- Record Reports -> JobCard approval projection port, People -> type-only Staff summary
  port, one composition-root Reports instance, and no People/Reports runtime cycle.
```

Do not edit schema, decisions, or design-system documents because this implementation
adds no schema object, durable decision, dependency, or UI token.

- [ ] **Step 5: Run documentation and full-worktree verification**

Run:

```bash
git diff --check
rg -n "implemented through Slice 08 Operational Reports" SERVORA_MED_API_DRAFT.md
sed -n '/## 11\. Slice 08/,/## 12\. Slice 09/p' SERVORA_MED_MVP_SLICES.md \
  | rg "\[ \]" || true
git status --short
```

Expected: `git diff --check` passes; API status is exact; no Slice 08 acceptance remains
unchecked; worktree contains only intended closeout documentation before commit.

- [ ] **Step 6: Commit verified closeout documentation**

```bash
git add README.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md \
  SERVORA_MED_ARCHITECTURE_PLAN.md
git commit -m "docs: close Slice 08 operational reports"
```

- [ ] **Step 7: Reindex Codebase Memory and update persistent project memory**

Use `codebase-memory-mcp.index_repository` in `full` mode with persistence for:

```text
/Users/emrah/Documents/Servora-Med/server
/Users/emrah/Documents/Servora-Med/web
```

Then use `codebase-memory-mcp.index_status` to confirm both indexes completed and record
their node/edge counts. Use persistent `memory` to add only stable Slice 08 decisions and
verified completion facts: canonical assigned Staff ownership, approved delivery policy,
exact decimal strings, local timestamp ownership, shared People port, stable routes,
approval invariants, and final verification status. Do not store transient test logs.

- [ ] **Step 8: Commit refreshed Codebase Memory artifacts**

Run:

```bash
git status --short
git add .codebase-memory
git commit -m "chore: refresh Slice 08 codebase memory"
```

Expected: the commit contains only generated Codebase Memory artifacts. If the configured
indexer updates a second existing tracked metadata path, add that generated path in the
same commit and report it explicitly.

- [ ] **Step 9: Push and prepare the PR evidence without opening a PR**

Run:

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
git push -u origin feature/slice-08-operational-reports
git status --short
```

Expected: push succeeds; the branch tracks its origin counterpart; worktree is clean.
Prepare a PR summary containing scope, exact commands/results, PostgreSQL query-plan
evidence, Playwright matrix, no-migration result, and remaining risks. Do not open the PR
until the user explicitly requests it.

---

## Acceptance Coverage Matrix

| Approved requirement | Implementation and verification |
| --- | --- |
| Exact DTOs and strict scalar queries | Tasks 1, 7, and 9 |
| Organization-local paired dates and 366-date maximum | Tasks 1–5 and 12 |
| Canonical Staff attribution through `assigned_to` | Tasks 2, 4, 5, and 12 |
| Batch `getMany` and zero-query empty list | Tasks 2 and 8 |
| No People/Reports runtime cycle or HTTP call | Tasks 7, 8, and 14 |
| Dashboard point-in-time and period metrics | Tasks 3, 11, and 12 |
| All-type operational metrics | Tasks 2–4, 6, and 12 |
| Delivery-only `PRODUCT_DELIVERY` metrics | Tasks 4, 5, and 12 |
| Approved delivery trust policy and `delivered_at` | Tasks 4, 5, and 12 |
| Exact decimal strings and persisted units | Tasks 4, 5, 9, 11, and 12 |
| Historical Product snapshot groups | Tasks 5 and 12 |
| Grouped-row totals and deterministic pagination | Tasks 5 and 12 |
| Canonical purpose order and null-last unit | Tasks 4, 5, and 12 |
| Approval clamp, boundaries, whole minutes, and invariants | Tasks 6, 7, and 12 |
| Canonical `JobCardListItem` approval projection | Tasks 6 and 9 |
| Exact role and not-found contracts | Tasks 7, 10, 11, and 12 |
| Stable routes and URL-owned state | Tasks 9–11 and 13 |
| Staff own and management profile reports | Tasks 10, 12, and 13 |
| Semantic trend/table and responsive report UI | Tasks 11 and 13 |
| No speculative schema/index/cache/dependency | Tasks 5, 12, and 14 |
| Full verification, SSOT, memory, push | Task 14 |

## Plan Self-Review Result

- Every acceptance item in the approved design maps to at least one task and one focused
  test or live acceptance scenario.
- All public DTO names and properties match the approved design.
- `StaffOperationalSummaryPort` has one exact signature throughout the plan.
- `getMany` performs one batch query and the empty-ID path performs no query.
- People removes its JobCard counter SQL before consuming the port; no intermediate
  commit leaves two production counter sources.
- Dashboard, Staff, and approval metrics include all JobCard types; delivery quantities
  include only `PRODUCT_DELIVERY`.
- UTC range boundaries remain in PostgreSQL; frontend date logic only validates and owns
  navigation state.
- Delivery quantities remain strings in server mappers, web parsers, and UI rendering.
- Delivery count and page statements reuse one grouped SQL definition.
- Approval summary is calculated before pagination and supplies response `total`.
- A syntactically valid unavailable Staff URL remains visible and produces the API error.
- No migration, report table, cache, materialized view, financial metric, inventory
  metric, ranking, score, or advanced BI behavior is planned.
- Every task has exact files, consumed/produced interfaces, a RED/GREEN cycle, related
  verification, and a focused commit.

## Execution Stop

This document is the only deliverable of the planning turn. Implementation begins only
after user review and approval. Because the project has explicitly disabled subagent use,
approved execution should use `superpowers:executing-plans` inline with review checkpoints.
