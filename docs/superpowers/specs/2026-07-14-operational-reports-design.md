# Operational Reports Design

> Date: 2026-07-14
> Status: Approved design; implementation not started
> Slice: 08 — Staff Profile and Operational Reports

## 1. Purpose

Slice 08 turns persisted JobCard and Product Delivery data into trusted operational
summaries for field Staff and organization management. It extends the five existing
Staff counters into one canonical reporting read model rather than creating a parallel
analytics system.

Reports answer operational questions:

- How much active work exists now?
- Which work is late, waiting for approval, or awaiting revision?
- How many jobs were completed or cancelled in a selected period?
- Which approved quantities were delivered by purpose, Product, Staff member, and date?
- How long has the current approval queue been waiting?

The module does not calculate revenue, stock, accounting, commission, or performance
scores.

## 2. Goals

- Give Admin and Manager an organization-wide operational dashboard.
- Give Staff a trusted summary of only their own work.
- Give Admin and Manager the same summary for any organization Staff profile.
- Report approved delivery quantities by actual delivery date and preserve unit.
- Measure the current approval queue from the Staff submission timestamp.
- Calculate every aggregation in PostgreSQL within the authenticated organization.
- Use organization-local calendar boundaries without frontend UTC calculations.
- Keep the existing Staff profile counters backed by the same reporting query source.
- Meet the shared WCAG 2.2 Level AA UI and test requirements.

## 3. Non-Goals

Slice 08 does not add:

- revenue, margin, commission, invoice, payment, or collection totals
- stock availability, movement, valuation, costing, or warehouse reports
- sales targets, rankings, leaderboards, or employee scoring
- arbitrary report builders, custom fields, saved dashboards, or exports
- background report jobs, cache tables, snapshots, or materialized views
- advanced BI, multiple chart types, or a chart library
- mutation endpoints in the Reports module
- realtime report updates

SKU, reference price, Product unit, and other Product fields remain informational. A
report must not infer inventory or accounting meaning from them.

## 4. Trusted Data Policy

Delivery quantities and Staff delivery summaries include only JobCards that satisfy all
of these conditions at query time:

```text
type = PRODUCT_DELIVERY
status = COMPLETED
manager_approved_at IS NOT NULL
```

`WAITING_APPROVAL`, `REVISION_REQUESTED`, `CANCELLED`, and other unfinished records do
not contribute to delivery quantities or completed Staff output. A delivery approved
later appears under its persisted `delivered_at` date, not its approval date. Therefore a
historical delivery report may gain an approved record after the original delivery day.

Delivery purposes remain separate. A positive `RETURN` quantity is reported under
`RETURN`; it is never subtracted from `SALE` to invent a net-sales value.

The following timestamp ownership is canonical:

| Metric | Timestamp or date |
| --- | --- |
| delivery quantity | `job_card_delivery_items.delivered_at` |
| completed JobCard count | `job_cards.manager_approved_at` |
| cancelled JobCard count | `job_cards.cancelled_at` |
| approval waiting age | `job_cards.staff_completed_at` to server request time |
| overdue state | `job_cards.due_date` compared with organization-local current date |

## 5. Date-Range Contract

Report endpoints that accept a period use:

```text
from=YYYY-MM-DD
to=YYYY-MM-DD
```

Rules:

- `from` and `to` are both omitted or both supplied.
- Omitting both selects the current organization-local calendar month.
- Both displayed dates are inclusive.
- SQL uses a half-open interval from local `from 00:00` through local
  `to + 1 day 00:00`, converted with `organizations.timezone`.
- The inclusive range contains at most 366 calendar dates; equivalently,
  `to - from` cannot exceed 365 days.
- Strict calendar dates are required. Invalid dates, partial ranges, `from > to`, and
  ranges longer than 366 dates return `400 VALIDATION_ERROR` with field details.
- The backend supplies the authoritative request time. The frontend never constructs
  UTC boundaries.
- Responses echo `{ from, to, timezone }` so the UI can label the result precisely.

Day grouping derives the organization-local calendar date from `delivered_at`. Daylight
saving or offset changes are handled by PostgreSQL timezone conversion, not fixed offsets.

## 6. Authorization

| Capability | Admin | Manager | Staff |
| --- | --- | --- | --- |
| Organization dashboard | yes | yes | no |
| Own operational report | no | no | yes |
| Another Staff report | yes | yes | no |
| Organization delivery report | yes | yes | no |
| Approval-age report | yes | yes | no |

Every read is scoped by the authenticated `organizationId`. A Staff request cannot
supply another Staff identifier. Missing and cross-organization Staff records have the
same concealed not-found behavior. Inactive Staff remain available to Admin and Manager
for historical reporting.

## 7. Backend Boundary

Add a read-only module:

```text
reports/
  types.ts
  query.ts
  repository.ts
  service.ts
  handlers.ts
  routes.ts
```

Responsibilities:

- `types.ts` defines query inputs and public report DTOs.
- `query.ts` owns strict query parsing, local-date validation, and canonical constants.
- `repository.ts` owns organization-scoped PostgreSQL read models and exact decimal
  mapping.
- `service.ts` owns role scope, Staff visibility, defaults, and report composition.
- `handlers.ts` translates authenticated HTTP input and output only.
- `routes.ts` registers authenticated GET routes only.

Reports does not own JobCards, delivery items, users, or Staff profiles and performs no
mutation. It may reuse safe JobCard list projection functions through a narrow read port;
it does not call another module through HTTP.

The existing five-counter SQL in People becomes part of a canonical
`StaffOperationalSummaryPort` implemented by the Reports read model. People continues to
return its existing profile DTO for compatibility, but obtains counters through this
port. Reports and People must not retain copied counter definitions.

## 8. HTTP Contract

```text
GET /api/reports/dashboard
GET /api/reports/staff/me
GET /api/reports/staff/:userId
GET /api/reports/deliveries
GET /api/reports/approvals
```

All routes require an authenticated session and reject unknown query parameters.
Reports are read-only and do not accept `clientActionId` or `expectedVersion`.

### 8.1 Dashboard

`GET /api/reports/dashboard?from=&to=` returns:

```json
{
  "range": {
    "from": "2026-07-01",
    "to": "2026-07-31",
    "timezone": "Europe/Istanbul"
  },
  "counters": {
    "activeJobCards": 18,
    "overdueJobCards": 3,
    "waitingApproval": 4,
    "revisionRequested": 2,
    "completedInPeriod": 21,
    "cancelledInPeriod": 1
  },
  "completedTrend": [
    { "date": "2026-07-01", "count": 2 }
  ]
}
```

Definitions:

- `activeJobCards` includes `NEW`, `PLANNED`, `IN_PROGRESS`, `WAITING_APPROVAL`, and
  `REVISION_REQUESTED`.
- `overdueJobCards` uses the same active statuses and `due_date` before the
  organization-local current date.
- `waitingApproval` and `revisionRequested` are current-state counts.
- `completedInPeriod` filters `manager_approved_at` by the selected local range.
- `cancelledInPeriod` filters `cancelled_at` by the selected local range.
- `completedTrend` contains every local date in the selected range, including zero-count
  dates, and counts JobCards by `manager_approved_at`. It never sums delivery quantities.

The first four counters are point-in-time state and do not change when the selected
period changes. Their labels must make that distinction visible.

### 8.2 Staff Operational Report

`GET /api/reports/staff/me?from=&to=` is the only Staff-accessible Reports route.
`GET /api/reports/staff/:userId?from=&to=` is Admin/Manager-only.

The response contains safe Staff identity, the resolved range, counters, and approved
delivery quantities by purpose and unit:

```json
{
  "staff": { "userId": "uuid", "name": "Emrah Demir", "isActive": true },
  "range": {
    "from": "2026-07-01",
    "to": "2026-07-31",
    "timezone": "Europe/Istanbul"
  },
  "counters": {
    "openJobCards": 5,
    "waitingApproval": 2,
    "revisionRequested": 1,
    "overdueJobCards": 1,
    "completedInPeriod": 8
  },
  "deliveriesByPurpose": [
    { "purpose": "SAMPLE", "unit": "kutu", "quantity": "12.500" },
    { "purpose": "SAMPLE", "unit": null, "quantity": "3.000" }
  ]
}
```

`openJobCards` includes only `NEW`, `PLANNED`, and `IN_PROGRESS`, preserving the existing
People counter meaning. Waiting approval and revision remain separate. Completed count
uses `manager_approved_at`; delivery quantities use `delivered_at` and the trusted data
policy.

The legacy People profile counters map from the same port:

```text
open                 <- openJobCards
waitingApproval      <- waitingApproval
revisionRequested    <- revisionRequested
completedThisMonth   <- completedInPeriod for the default current month
overdue              <- overdueJobCards
```

### 8.3 Delivery Report

`GET /api/reports/deliveries` accepts:

```text
from
to
groupBy=day|purpose|product|staff
staffUserId
limit
offset
```

`groupBy` is required. `staffUserId` is optional and may select active or inactive
organization Staff. Default pagination is 50, maximum is 200, and the response uses
`{ items, total, limit, offset }` plus the resolved range and `groupBy`.

Every group includes `unit: string | null`; `null`, `adet`, and `kutu` are distinct groups.
PostgreSQL `SUM(NUMERIC)` is returned as an exact decimal string. Backend and frontend do
not recalculate quantity with JavaScript floating point.

Group keys are:

```text
day:
  local delivery date + unit

purpose:
  delivery purpose + unit

product:
  productId + productNameSnapshot + productSkuSnapshot +
  productModelSnapshot + unit

staff:
  assigned Staff userId + current safe Staff name + unit
```

Product grouping uses persisted delivery snapshots, not the live Product name. If a
catalog Product was renamed, distinct historical snapshot labels remain distinct report
groups. Staff display names are current because no Staff-name snapshot exists; userId is
the stable group identity.

Sorting is deterministic: day groups newest first; purpose groups by canonical purpose;
Product and Staff groups by display name then stable identifiers; `unit` and remaining
keys break ties.

### 8.4 Approval Age

`GET /api/reports/approvals?limit=&offset=` is Admin/Manager-only and covers only current
`WAITING_APPROVAL` JobCards. Pagination defaults to 50 and permits at most 200 items. It
returns:

```json
{
  "summary": {
    "pendingCount": 6,
    "oldestWaitingMinutes": 1580,
    "averageWaitingMinutes": 285,
    "under2Hours": 2,
    "between2And8Hours": 2,
    "between8And24Hours": 1,
    "over24Hours": 1
  },
  "items": [],
  "total": 6,
  "limit": 50,
  "offset": 0
}
```

Age begins at `staff_completed_at` and ends at one authoritative server request time.
Item ages and `oldestWaitingMinutes` use completed whole minutes. Average age is rounded
to the nearest whole minute. An empty queue returns zero counts and `null` for oldest and
average.

Buckets are mutually exclusive and computed from unrounded elapsed time:

```text
under2Hours:       [0 hours, 2 hours)
between2And8Hours: [2 hours, 8 hours)
between8And24Hours:[8 hours, 24 hours)
over24Hours:       [24 hours, infinity)
```

Items are oldest first and reuse the safe, role-scoped JobCard list projection with one
additional `waitingMinutes` field. The endpoint does not expose raw activity metadata or
create a second approval-queue ownership rule.

## 9. Database and Performance

Slice 08 creates no report table, cache table, materialized view, trigger, or scheduled
aggregation. The default implementation requires no migration.

Existing indexes cover the initial access paths:

```text
job_cards (organization_id, status)
job_cards (organization_id, assigned_to, status)
job_cards (organization_id, type, status)
active job_cards (organization_id, due_date)
waiting-approval job_cards (organization_id, staff_completed_at, id)
delivery items (organization_id, product_id, delivered_at)
delivery items (organization_id, delivery_purpose, delivered_at)
```

A new migration is permitted only when disposable PostgreSQL data and
`EXPLAIN (ANALYZE, BUFFERS)` demonstrate a material query-plan problem. Any resulting
index migration is reviewed separately; implementation must not create speculative
`007_reports.sql`.

## 10. Frontend

Admin and Manager receive a `Raporlar` workspace entry. The initial report UI contains:

- restrained dashboard counters
- one lightweight daily completed-JobCard trend
- a semantic table containing the same trend data
- structured delivery breakdown tables with date, grouping, and Staff filters
- approval-age summary and an oldest-first queue
- explicit links from Staff profiles to their operational summary

Staff sees their own counters and purpose/unit delivery summary from
`/api/reports/staff/me` within the existing profile area. Admin and Manager see the same
shape for a selected Staff member. The UI does not merge, rank, or score people.

No chart dependency is added. The trend may use a small CSS/SVG presentation, but the
semantic table is authoritative and complete. The redundant graphic is hidden from
screen readers when the adjacent table already supplies the same information.

Mobile prioritizes counters, filters, summaries, and structured lists. Desktop tables
must reflow into readable rows/cards rather than being scaled down. Empty states explain
that no approved records exist in the selected range; they do not show fake zero-value
business success.

## 11. Error and Loading Behavior

- Invalid query values return `400 VALIDATION_ERROR` with safe field errors.
- Unauthorized roles receive `403 FORBIDDEN`.
- Missing or cross-organization Staff reports use concealed not-found behavior.
- Database failures use the existing safe generic server error contract.
- Every screen has explicit loading, empty, error, retry, and successful-data states.
- Applying a new filter keeps the previous data identifiable until the authoritative
  response arrives or replaces it with an explicit loading state; it never fabricates
  optimistic aggregates.
- Date-filter errors are associated with their fields and move focus to the error summary
  or first invalid field.

## 12. Accessibility

Slice 08 follows WCAG 2.2 Level AA and the shared product contract:

- semantic headings, landmarks, definition lists, tables, and forms
- captions or visible headings for report tables
- keyboard-operable filters, pagination, navigation, and retry actions
- visible focus and approximately 44x44 CSS px interaction targets where applicable
- color never acts as the only metric, bucket, lateness, or status indicator
- textual values and table equivalents for every graphic
- 200 percent text enlargement and supported 400 percent reflow
- no horizontal page scrolling for critical mobile workflows
- reduced-motion support; report comprehension never depends on animation
- understandable loading, empty, validation, forbidden, and error announcements

## 13. Verification

Automated and live verification covers:

- strict paired date parsing, inclusive range boundaries, leap days, and 366-date maximum
- organization timezone boundaries and daylight-offset behavior
- current-state dashboard counter definitions
- completion filtering by `manager_approved_at`
- cancellation filtering by `cancelled_at`
- delivery filtering by `COMPLETED` status and `delivered_at`
- exclusion of waiting, revision, and cancelled deliveries
- separate purpose and nullable-unit groups
- exact decimal-string quantities without JavaScript summation
- historical Product snapshot grouping after catalog rename/deactivation
- Staff self scope and Admin/Manager organization scope
- inactive historical Staff reporting and cross-organization concealment
- People profile counters and Reports output sharing one read model
- approval age boundaries at exactly 2, 8, and 24 hours
- empty approval queue null/zero semantics and deterministic pagination
- route query allowlists and safe errors
- frontend loading, empty, error, retry, filter, pagination, and role states
- semantic trend table equivalence
- full server/web tests, builds, and high-severity audits
- disposable PostgreSQL migrations 001–006 and report acceptance data
- query-plan inspection before adding any report index
- Playwright desktop, 390 CSS px mobile, keyboard, focus, 200/400 percent zoom,
  reflow, reduced motion, and semantics acceptance

## 14. Implementation Order

1. Correct API and slice SSOT drift and lock report contracts.
2. Add strict report query/date types and unit tests.
3. Add canonical PostgreSQL read models and the Staff summary port.
4. Add role-aware report services, handlers, routes, and route tests.
5. Integrate People counters with the canonical port without changing its public profile
   contract.
6. Add report API clients and Staff summary integration.
7. Add Manager/Admin dashboard, delivery, and approval report UI.
8. Run full automated, disposable PostgreSQL, query-plan, Playwright, documentation, and
   memory closeout.

No Reports implementation begins until a separate implementation plan is reviewed and
approved.
