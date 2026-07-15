# Servora-Med Slice 10 — Structured Sales Meeting Design

> Status: Approved design; implementation plan pending approval
> Date: 2026-07-15
> Scope: Structured Sales Meeting planning, result capture, approval, workspace presentation, activity, and Staff reporting

## 1. Purpose

Slice 10 activates `SALES_MEETING` as the third canonical JobCard type. It allows a
field worker or management user to plan a customer meeting, record the actual result
afterward, submit that structured result for manager review, and report approved meeting
outcomes without creating a separate workflow engine.

The existing JobCard lifecycle, assignment rules, optimistic version, processed-action
idempotency, notes, activity, approval queue, and role-scoped workspace remain the shared
operational foundation. Meeting result fields are structured data; General Task and
free-text notes do not replace them.

## 2. Product Outcomes

The completed slice provides these outcomes:

1. Staff can plan a Sales Meeting assigned to themselves from `/jobs/new-meeting`.
2. Manager and Admin can plan a Sales Meeting for an active Staff user in their
   organization.
3. Planning captures a required Customer and organization-local planned calendar day.
4. After the meeting, an authorized user records the actual instant, one canonical
   outcome, a required summary, and a follow-up instant when known.
5. Meeting result data remains editable only before review or after revision.
6. Submit-time policy prevents incomplete or materially future-dated results from
   entering the approval queue.
7. Manager review uses the existing approve or request-revision commands.
8. Staff reports show approved meeting counts by the four canonical outcomes.
9. List, board, approval, dashboard, and Staff operational counters treat Sales Meeting
   as a normal JobCard while delivery quantities remain Product Delivery-only.

## 3. Non-Goals

Slice 10 does not add or redesign:

- a planned-time `scheduledAt` field; `dueDate` is the planned local calendar day;
- automatic follow-up JobCards;
- calendar events, reminders, notifications, or a scheduler;
- a generic form builder, polymorphic details framework, or JSON details document;
- a meeting-only dashboard, conversion funnel, percentage, ranking, employee score, or
  advanced BI surface;
- quote, sample, order, invoice, accounting, inventory, or warehouse behavior;
- report tables, report caches, views, or materialized views;
- attachments, native mobile behavior, or realtime transport;
- changes to Product Delivery create semantics or delivery decimal-string contracts;
- a second lifecycle, approval engine, note system, or activity store.

## 4. Approved Product Model and Alternatives

Slice 10 uses a two-stage model:

1. Plan the meeting as a JobCard.
2. Record the actual result after the meeting, then submit it for approval.

The alternatives were evaluated as follows:

| Approach | Planning | Reportability | Mobile UX | Validation and integrity | Decision |
| --- | --- | --- | --- | --- | --- |
| Require all results during create | Cannot represent future planned meetings | Simple but only after-the-fact | One form, usable only after meeting | Loses planned-versus-actual distinction | Rejected |
| Separate planning and result capture | Tracks future work and actual execution | Reliable actual-time and outcome metrics | Short create form plus focused result form | Draft fields may be null; submit policy owns readiness | Approved |
| Model as General Task plus notes | Basic scheduling only | Outcome and actual time cannot be queried reliably | Initially simple | Structured truth is lost in prose | Rejected |

The approved model keeps planning, actual execution, and approval distinct without
inventing another domain workflow.

## 5. Canonical Vocabulary and Time Semantics

### 5.1 JobCard type

```ts
type JobCardType = 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING'
```

The canonical Turkish type label is:

```text
SALES_MEETING -> Satış görüşmesi
```

Type remains immutable after creation.

### 5.2 Meeting outcomes

```ts
type MeetingOutcome =
  | 'POSITIVE'
  | 'FOLLOW_UP_REQUIRED'
  | 'NO_DECISION'
  | 'NOT_INTERESTED'
```

Canonical order and Turkish labels are:

```text
POSITIVE           -> Olumlu
FOLLOW_UP_REQUIRED -> Takip gerekli
NO_DECISION        -> Karar verilmedi
NOT_INTERESTED     -> İlgilenmiyor
```

The API and database accept only these values. UI presentation uses the Turkish labels
through an exhaustive mapping. Free-text outcome is not accepted. Adding an outcome is
a deliberate migration and public-contract change.

### 5.3 Planned and actual time

```text
dueDate   -> planned meeting day, organization-local calendar date, PostgreSQL DATE
meetingAt -> actual meeting instant, PostgreSQL TIMESTAMPTZ
```

`dueDate` contains no time-of-day. Slice 10 does not add `scheduledAt`. A strict valid
`YYYY-MM-DD` value is required at create, but past dates are accepted for backfill and
same-day retrospective entry. The UI may warn about a past planned day but must not
block it.

`meetingAt` is an instant. Draft details may temporarily contain a future value. Submit
requires `meetingAt <= requestTime + 15 minutes`. There is no historical lower bound.

`nextFollowUpAt` is optional for every outcome, including `FOLLOW_UP_REQUIRED`. When
present it requires `meetingAt` and must be strictly later than `meetingAt`. It need not
be later than server request time because an overdue follow-up remains valid historical
data.

## 6. Migration and Persisted Model

Slice 10 adds exactly one migration:

```text
server/src/db/migrations/007_sales_meeting.sql
```

Migrations 001–006 are immutable and their content and hashes must not change.

### 6.1 Canonical constraints

The migration replaces the named `job_cards.type` check with the exact set:

```text
PRODUCT_DELIVERY
GENERAL_TASK
SALES_MEETING
```

It replaces the activity event check with the existing 14 events plus exactly:

```text
MEETING_DETAILS_UPDATED
```

The resulting activity vocabulary contains exactly 15 unique values. Tests compare
actual count, missing values, unexpected values, and duplicate values; checking only
that the new value exists is insufficient.

### 6.2 Meeting details table

```sql
CREATE TABLE job_card_meeting_details (
  job_card_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  meeting_at TIMESTAMPTZ,
  outcome VARCHAR(40),
  meeting_summary TEXT,
  next_follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  CHECK (outcome IS NULL OR outcome IN (
    'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED'
  )),
  CHECK (
    meeting_summary IS NULL
    OR (
      char_length(meeting_summary) BETWEEN 1 AND 4000
      AND meeting_summary ~ '[^[:space:]]'
    )
  ),
  CHECK (
    next_follow_up_at IS NULL
    OR (meeting_at IS NOT NULL AND next_follow_up_at > meeting_at)
  )
);
```

Application normalization prevents Unicode whitespace-only summaries from reaching the
table. The database independently requires a non-null summary to contain at least one
non-POSIX-whitespace character and limits persisted length to 4,000 code points. It also
protects chronology. Submit-time requiredness remains a service-policy concern so the
draft row may be empty.

`job_card_id` is the one-to-one key. The composite foreign key protects organization
ownership. PostgreSQL cannot prove through this foreign key that the parent type is
`SALES_MEETING`; create and mutation services own that invariant. No trigger is added.
The child needs no redundant `(organization_id, job_card_id)` unique constraint; the
primary key supplies one-to-one uniqueness and the parent already exposes the composite
unique key required by the foreign key.

The only new report index is:

```sql
CREATE INDEX meeting_details_org_time_job_idx
ON job_card_meeting_details (organization_id, meeting_at, job_card_id)
WHERE meeting_at IS NOT NULL;
```

Null draft rows are excluded because reports use only actual meetings.

### 6.3 Migration execution guarantees

PostgreSQL tests cover both clean `001 -> 007` application and a real upgrade with
applied `001 -> 006` followed only by 007. A failed 007 transaction leaves no partial
table, constraint, index, or `schema_migrations` row. A successful migration records its
version only after commit, and the runner does not apply it a second time.

## 7. Exact Create Contract

The backend keeps one endpoint:

```text
POST /api/job-cards
```

Its public body becomes this exact three-way discriminated union:

```ts
type ProductDeliveryCreateInput = {
  clientActionId: string
  type: 'PRODUCT_DELIVERY'
  title: string
  description?: string | null
  customerId: string
  contactId?: string | null
  assignedTo: string
  priority?: JobCardPriority
  dueDate?: string | null
}

type GeneralTaskCreateInput = {
  clientActionId: string
  type: 'GENERAL_TASK'
  title: string
  assignedTo: string
  description?: string | null
  customerId?: string | null
  contactId?: string | null
  priority?: JobCardPriority
  dueDate?: string | null
}

type SalesMeetingCreateInput = {
  clientActionId: string
  type: 'SALES_MEETING'
  title: string
  customerId: string
  assignedTo: string
  dueDate: string
  description?: string | null
  contactId?: string | null
  priority?: JobCardPriority
}

type JobCardCreateInput =
  | ProductDeliveryCreateInput
  | GeneralTaskCreateInput
  | SalesMeetingCreateInput
```

The Product Delivery and General Task members remain unchanged from Slice 09.

Each discriminant has its own exact allowlist. A global allowlist is not expanded with
meeting result fields. `meetingAt`, `outcome`, `meetingSummary`, and `nextFollowUpAt` are
unknown create fields for all three types and return `400 VALIDATION_ERROR`.

Body parsing rejects a non-object body, arrays, absent or unknown type, unknown fields,
wrong primitive types, malformed values, and malformed identifiers. No business
contract is attached to duplicate JSON keys because the standard JSON parser may retain
only the last value. Repeated scalar rejection applies to URL query parameters.

### 7.1 Create normalization

| Field | Contract |
| --- | --- |
| `clientActionId` | required; trimmed; 1–255 Unicode code points |
| `title` | required; trimmed; 1–255 Unicode code points |
| `customerId` | required, well-formed UUID |
| `assignedTo` | required, well-formed UUID |
| `dueDate` | required strict valid `YYYY-MM-DD`; past, today, and future accepted |
| `description` | omitted, `null`, or trimmed empty becomes `null`; otherwise trimmed string |
| `contactId` | omitted or `null` becomes `null`; otherwise well-formed UUID |
| `priority` | omitted becomes `normal`; otherwise canonical JobCard priority |

Creation starts at `NEW`, version `1`. The transaction creates the JobCard, creates one
empty `job_card_meeting_details` row, and appends exactly one `JOB_CREATED` activity.
There is no initial `MEETING_DETAILS_UPDATED` event.

The existing `JOB_CREATE` processed-action contract remains scoped by organization,
authenticated actor, and `clientActionId`. A completed replay returns the original
canonical JobCard detail without creating duplicate rows or activity.

## 8. Assignment, Customer, and Contact Policy

Sales Meeting uses the same shared assignment and relation policies as the existing
JobCard create flow.

### 8.1 Staff assignment

An authenticated Staff actor must send their own user ID as `assignedTo`. A different
identifier returns `403 FORBIDDEN` before any assignee lookup. The service does not
silently replace it. The web sends the authenticated Staff ID and displays a fixed owner
instead of an assignee selector.

### 8.2 Management assignment

Manager and Admin must select an active, same-organization user whose role is `STAFF`.

- malformed `assignedTo` -> `400 VALIDATION_ERROR` before lookup;
- missing or cross-organization -> `404 ASSIGNEE_NOT_FOUND`;
- inactive or non-Staff -> `403 FORBIDDEN`.

### 8.3 Customer and Contact

- Customer is required, active, and in the authenticated organization.
- A supplied Contact must be active, in the same organization, and belong to the
  selected Customer.
- Customer is never inferred from Contact.
- missing or cross-organization Customer -> `404 CUSTOMER_NOT_FOUND`;
- inactive Customer -> `409 CUSTOMER_INACTIVE`;
- missing or cross-organization Contact -> `404 CONTACT_NOT_FOUND`;
- inactive Contact -> `409 CONTACT_INACTIVE`;
- Contact outside the selected Customer -> `409 CONTACT_NOT_IN_CUSTOMER`.

The established global lock order is preserved when these relations participate in a
transaction:

```text
users -> customers -> contacts -> job_cards -> meeting_details
```

The create transaction locks/validates relations in that order, then writes the JobCard,
empty detail, and activity atomically.

## 9. Meeting Details HTTP Contract

The type-specific subresource is:

```text
GET   /api/job-cards/:jobCardId/meeting-details
PATCH /api/job-cards/:jobCardId/meeting-details
```

### 9.1 Exact response

```ts
type MeetingDetails = {
  jobCardId: string
  meetingAt: string | null
  outcome: MeetingOutcome | null
  meetingSummary: string | null
  nextFollowUpAt: string | null
  jobCardVersion: number
}
```

All non-null instant responses use canonical UTC ISO form such as
`2026-07-15T11:30:00.000Z`.

### 9.2 Exact PATCH body

```ts
type PatchMeetingDetailsInput = {
  clientActionId: string
  expectedVersion: number
  meetingAt?: string | null
  outcome?: MeetingOutcome | null
  meetingSummary?: string | null
  nextFollowUpAt?: string | null
}
```

At least one detail mutation field is required. `clientActionId` and `expectedVersion`
alone return `400 VALIDATION_ERROR`. Unknown fields, wrong primitives, invalid outcome,
invalid version, invalid action ID, and malformed instant return `400 VALIDATION_ERROR`
before idempotency claim or domain lookup.

Instant input must include `Z` or an explicit offset. Naive or locale-specific forms,
including `2026-07-15 10:00`, `2026-07-15T10:00:00`, and `15/07/2026`, are rejected.
JavaScript `Date.parse` alone is not the parser contract.

`meetingSummary` is Unicode-trimmed. Omitted means unchanged; `null` or a trimmed empty
string normalizes to `null`; a non-null value is limited to 4,000 Unicode code points.
The application uses code-point-aware length, not UTF-16 `string.length`.

The service creates a candidate from current persisted details plus the normalized
partial patch, then validates:

```text
candidate.nextFollowUpAt != null
  -> candidate.meetingAt != null
  -> candidate.nextFollowUpAt > candidate.meetingAt
```

Clearing `meetingAt` while retaining a follow-up fails. Sending both fields as `null`
clears both. Draft PATCH does not enforce the submit-time future bound.

### 9.3 Access, type, and edit order

PATCH performs these checks in order:

1. Validate the exact body; malformed body identifiers return `400 VALIDATION_ERROR`.
   Validate `:jobCardId` separately; a malformed path returns
   `404 JOB_CARD_NOT_FOUND` before claim or PostgreSQL access.
2. Claim the target-scoped critical action for syntactically valid PATCH input.
3. Lock and resolve the parent within organization and role scope.
4. Conceal missing, cross-organization, or Staff-inaccessible parents as
   `404 JOB_CARD_NOT_FOUND`.
5. Assert `SALES_MEETING`; another type returns `409 INVALID_JOB_TYPE`.
6. Compare `expectedVersion`; mismatch returns `409 VERSION_CONFLICT`.
7. Apply the existing JobCard edit policy.
8. Lock and read meeting details.
9. Build, validate, and compare the candidate.

GET performs no idempotency claim, version comparison, edit-policy check, or row lock. It
validates the path without sending a malformed UUID to PostgreSQL, resolves/conceals the
parent through the same organization and Staff visibility scope, applies the type guard,
then reads the detail. A missing detail row has the same invariant-failure behavior for
GET and PATCH.

The existing shared edit policy is authoritative. `NEW`, `PLANNED`, `IN_PROGRESS`, and
`REVISION_REQUESTED` are editable within role scope. `WAITING_APPROVAL`, `COMPLETED`, and
`CANCELLED` return the existing `409 JOB_NOT_EDITABLE`; Slice 10 does not create another
immutability code. Staff may edit only their assigned JobCard. Manager and Admin retain
their existing organization-scoped edit authority.

If a visible Sales Meeting parent has no detail row, the server returns a safe
`500 INVARIANT_VIOLATION`. It exposes no table, SQL, row, organization, or stack detail.

## 10. Mutation, Locking, Concurrency, and Idempotency

Meeting details use `job_cards.version` as the only concurrency source of truth. There
is no detail version column.

The fixed PATCH transaction order is:

```text
job_cards row FOR UPDATE
-> job_card_meeting_details row
-> update details
-> bump JobCard version exactly once
-> append MEETING_DETAILS_UPDATED exactly once
-> complete processed action
-> commit
```

Meeting PATCH does not re-lock Customer, Contact, or assignee. Any future common-field
mutation that includes relations must retain the global order from section 8.

The version check, detail write, single version increment, activity append, and
processed-action completion occur in one transaction. Any failure rolls back all of
them.

The operation key is target-scoped:

```text
MEETING_DETAILS_UPDATE:<jobCardId>
```

The claim identity is organization + actor + clientActionId + operation key. A completed
replay returns the first successful response even when the retry carries a different
payload. Clients must never reuse one action ID for a different logical save. An action
still processing returns `409 ACTION_IN_PROGRESS`.

Database-dependent no-op detection occurs inside the transaction after the current row
is read. If every provided normalized value equals its current value, the request returns
`400 VALIDATION_ERROR`; it does not bump version or append activity.

## 11. Submission, Lifecycle, Revision, and Immutability

Sales Meeting uses the existing named lifecycle commands and manager approval invariant.
It adds one exhaustive third submission policy; there is no fallback policy.

At service-operation entry, `requestTime` is captured once and passed through submission
validation. Validation order is deterministic and matches the shared submission-policy
shape:

1. Validate Customer existence, organization ownership, and active state.
2. Validate persisted assignee eligibility.
3. Validate Sales Meeting structured readiness.

A Customer failure therefore returns `CUSTOMER_NOT_FOUND` or `CUSTOMER_INACTIVE` before
any assignee or meeting-readiness error. With a valid Customer, an invalid assignee
returns `ASSIGNEE_NOT_ELIGIBLE`. Only when both relation checks pass can structured
detail failure return `MEETING_NOT_READY`.

The complete readiness contract requires:

- a still-valid same-organization Customer;
- a still-active same-organization Staff assignee;
- non-null `meetingAt`;
- one canonical non-null `outcome`;
- a non-null, non-empty normalized `meetingSummary`;
- valid follow-up chronology when a follow-up exists;
- `meetingAt <= requestTime + 15 minutes`.

`FOLLOW_UP_REQUIRED` does not require `nextFollowUpAt`. There is no past lower bound for
either instant and no server-time requirement for follow-up.

Structured readiness failures return `400 MEETING_NOT_READY`. The response may include
safe `details.fieldErrors` keys limited to:

```text
meetingAt
outcome
meetingSummary
nextFollowUpAt
```

Messages explain correction without returning persisted values. SQL details, raw rows,
meeting summary content, organization data, and concealed relation information are never
included.

Relation errors keep their canonical meanings. An ineligible persisted assignee returns
`400 ASSIGNEE_NOT_ELIGIBLE`; missing/cross-organization Customer returns
`404 CUSTOMER_NOT_FOUND`; inactive Customer returns `409 CUSTOMER_INACTIVE`.

Successful submit moves to `WAITING_APPROVAL` and freezes meeting details for every role.
Manager/Admin may approve or request revision but may not silently edit the submitted
result. Revision returns the JobCard to `REVISION_REQUESTED`, where authorized editing is
enabled again. `COMPLETED` and `CANCELLED` remain terminal and immutable.

## 12. Activity Contract and Safe Projection

The only new canonical event is:

```text
MEETING_DETAILS_UPDATED
```

Its persisted and public safe detail is:

```ts
type MeetingDetailsActivity = {
  kind: 'MEETING_DETAILS'
  changedFields: Array<
    | 'meetingAt'
    | 'outcome'
    | 'meetingSummary'
    | 'nextFollowUpAt'
  >
}
```

`changedFields` uses this canonical order regardless of JSON body order:

```text
meetingAt
outcome
meetingSummary
nextFollowUpAt
```

The activity stores no old or new field values and no full summary. The server presenter
allowlists only `changedFields`; the web exact parser accepts only the safe projection.
Unknown/raw activity JSON is not exposed. The Turkish event label is
`Görüşme sonucu güncellendi`.

Create appends only `JOB_CREATED`. Existing lifecycle, note, and common-field events are
unchanged.

## 13. Canonical Detail and Workspace Boundaries

The web loaded-detail state is an exact small discriminated union, not a generic details
framework:

```ts
type LoadedJobDetail =
  | {
      kind: 'PRODUCT_DELIVERY'
      job: JobCardDetail & { type: 'PRODUCT_DELIVERY' }
      deliveryItems: DeliveryItem[]
    }
  | {
      kind: 'GENERAL_TASK'
      job: JobCardDetail & { type: 'GENERAL_TASK' }
    }
  | {
      kind: 'SALES_MEETING'
      job: JobCardDetail & { type: 'SALES_MEETING' }
      meetingDetails: MeetingDetails
    }
```

Loading always starts with canonical JobCard detail, then requests exactly one
type-specific boundary:

```text
PRODUCT_DELIVERY -> delivery-items
GENERAL_TASK     -> no structured subresource
SALES_MEETING    -> meeting-details
```

After the Sales Meeting subresource loads, the web compares `job.version` with
`meetingDetails.jobCardVersion`. A mismatch reloads the complete canonical detail once.
A second mismatch stops; it shows a retryable concurrency message. There is no unbounded
retry loop.

List, board, detail, create, and URL parsers accept all three exact types. The workspace
adds `Yeni görüşme`, `/jobs/new-meeting`, and the `Satış görüşmesi` label. Direct route,
refresh, Back, and Forward work. Invalid or repeated scalar `type` query values are
canonicalized or rejected according to the existing URL contract; duplicate scalar API
query parameters return `400 VALIDATION_ERROR`.

Sales Meeting has `deliveryItemCount === 0` in canonical list data, but delivery count is
not rendered for it. It never requests delivery items. Color is not the only type cue.

Type-aware labels include:

```text
PRODUCT_DELIVERY due date -> Son tarih
GENERAL_TASK due date     -> Son tarih
SALES_MEETING due date    -> Planlanan görüşme günü
```

Review-lock messages are:

```text
PRODUCT_DELIVERY -> Teslim bilgileri inceleme tamamlanana kadar değiştirilemez.
GENERAL_TASK     -> Görev bilgileri inceleme tamamlanana kadar değiştirilemez.
SALES_MEETING    -> Görüşme bilgileri inceleme tamamlanana kadar değiştirilemez.
```

## 14. Web Create, Result, and Review Flows

### 14.1 Planning form

`/jobs/new-meeting` is a separate focused form. It collects title, required Customer,
optional Contact, assignee, required planned day, optional description, and optional
priority. It contains no outcome, actual time, summary, or follow-up controls.

- Staff does not request the Staff list and submits its authenticated ID.
- Manager/Admin cannot submit until the active Staff list loads.
- No role can submit until the active Customer list loads.
- Selecting Customer loads active Contacts; Contact failure does not block a Customer-
  only create because Contact is optional.
- Changing Customer clears Contact immediately.
- A request-generation gate ignores a late response for a previous Customer.
- Failed reference loads show an adjacent retry action.
- One create `clientActionId` survives ambiguous network retries until a definitive
  success or business error.

### 14.2 Result form and mutation coordination

The result form renders only for Sales Meeting. It uses native labeled controls for
actual time, canonical outcome, summary, and optional follow-up. Editable-state and role
rules come from the backend contract.

When outcome is `FOLLOW_UP_REQUIRED`, the UI displays a prominent but non-blocking
recommendation to enter `nextFollowUpAt`. The control does not receive HTML, ARIA, or
visual required semantics. Omitting the follow-up does not prevent save or submit.

For each logical save, the client creates one `clientActionId`. An ambiguous network
retry reuses it. A definitive success or business error releases it; a later logical save
uses a new ID. Pending double-submit is disabled.

Meeting save and lifecycle commands share a JobDetail-level mutation mutex and cannot
run concurrently. Notes do not change JobCard version and need not be blocked by that
mutex. The conceptual states are `idle`, `savingMeeting`, and `runningLifecycle`; notes
retain their existing independent pending state.

On successful PATCH, one state update sets both `job.version` and normalized
`meetingDetails` from the response. The timeline refreshes, workspace change is signaled,
and success feedback receives focus. A version conflict reloads JobCard and meeting
details together.

### 14.3 Timezone presentation

`datetime-local` displays device-local wall time. Visible helper text identifies the
device timezone or UTC offset. Submission converts that wall time to an ISO instant with
the device offset. Canonical UTC responses convert back to device-local display.

Naive input must not gain a `Z` suffix or be treated as UTC. The input has no hard
server-time `max`; the backend owns the submit-time 15-minute rule. Report range and
grouping remain backend-owned organization-timezone calculations.

### 14.4 Accessibility

- Controls and actions target at least 44 by 44 CSS pixels where practicable.
- Outcome starts with `Sonuç seçin` and an empty value.
- Follow-up guidance is attached to the follow-up control with `aria-describedby`.
- Labels never rely on placeholders or color.
- Validation moves focus to a safe error summary, then exposes field-linked errors.
- Successful save moves focus to status feedback.
- Conflict reload moves focus to a status announcing refreshed backend truth.
- Read-only results use semantic description markup rather than disabled controls.
- A character counter, if rendered, does not announce every keystroke as live content.
- Keyboard order, 200 percent text sizing, 400 percent reflow, reduced motion, and
  visible focus meet the project WCAG 2.2 AA target.

## 15. Staff Report Contract

The existing Staff report responses add exactly one field:

```ts
type MeetingOutcomeItem = {
  outcome: MeetingOutcome
  count: number
}

type StaffReportResponse = {
  staff: StaffIdentity
  range: ResolvedReportRange
  counters: StaffOperationalCounters
  deliveriesByPurpose: DeliveryPurposeItem[]
  meetingsByOutcome: MeetingOutcomeItem[]
}
```

Both `GET /api/reports/staff/me` and
`GET /api/reports/staff/:staffUserId` return the exact shape. The existing Staff target
not-found behavior remains unchanged.

The read model adds only:

```ts
getStaffMeetingsByOutcome(
  input: StaffOperationalSummaryOneInput
): Promise<MeetingOutcomeItem[]>
```

The existing Reports service reads identity, operational summary, delivery purposes, and
meeting outcomes in parallel. No new service or route is introduced.

The repository returns exactly four unique items in canonical order, including zero
counts. A canonical SQL `VALUES` set left-joins the aggregate. Every `count` is a
non-negative integer. The web parser verifies exact array length, exact order, no
duplicates, known outcomes, and valid counts; frontend zero-fill is forbidden.

The aggregate scope is exactly:

```text
job_cards.organization_id = request organization
job_cards.type = SALES_MEETING
job_cards.status = COMPLETED
job_cards.assigned_to = target Staff
meeting_details.meeting_at in organization-local resolved range
```

Range comparison uses the existing half-open UTC interval derived from organization
local dates: `[from local-day start, day-after-to local-day start)`. It does not use
`dueDate`, create time, activity actor, submitter, approval actor, or approval time.
Inactive historical Staff remains reportable. Outcome is read from final persisted
meeting details.

The UI adds a small semantic `Görüşme sonuçları` table or description list. All four
rows remain visible when all counts are zero; a short no-approved-meeting explanation may
also appear. No chart, percentage, score, or ranking is added.

### 15.1 Report regressions

- Dashboard all-type active, overdue, waiting, revision, completed, cancelled, and trend
  counters include Sales Meeting.
- Approval queue includes Sales Meeting.
- Staff open, waiting, revision, overdue, and completed counters include Sales Meeting.
- Delivery quantities and `deliveriesByPurpose` exclude Sales Meeting.
- Product Delivery quantities remain exact three-decimal strings.
- General Task report behavior remains unchanged.

## 16. Exact Error Matrix

| Condition | Public response |
| --- | --- |
| Unknown body field, wrong primitive, malformed body/query UUID, malformed date/instant/outcome, invalid version/action ID | `400 VALIDATION_ERROR` |
| Repeated scalar URL query parameter | `400 VALIDATION_ERROR` |
| Staff sends another assignee ID | pre-lookup `403 FORBIDDEN` |
| Assignee missing or cross-organization | `404 ASSIGNEE_NOT_FOUND` |
| Assignee inactive or non-Staff | `403 FORBIDDEN` |
| Customer missing or cross-organization | `404 CUSTOMER_NOT_FOUND` |
| Customer inactive | `409 CUSTOMER_INACTIVE` |
| Contact missing or cross-organization | `404 CONTACT_NOT_FOUND` |
| Contact outside Customer | `409 CONTACT_NOT_IN_CUSTOMER` |
| Contact inactive | `409 CONTACT_INACTIVE` |
| Malformed `:jobCardId` path parameter | pre-PostgreSQL `404 JOB_CARD_NOT_FOUND` |
| Parent missing, cross-organization, or outside Staff scope | concealed `404 JOB_CARD_NOT_FOUND` |
| Parent is not Sales Meeting | `409 INVALID_JOB_TYPE` |
| Required detail row missing | safe `500 INVARIANT_VIOLATION` |
| PATCH has no mutation field or is normalized no-op | `400 VALIDATION_ERROR` |
| JobCard version mismatch | `409 VERSION_CONFLICT` |
| Existing edit policy rejects status | existing `409 JOB_NOT_EDITABLE` |
| Structured submit readiness fails | `400 MEETING_NOT_READY` with optional safe field keys |
| Persisted assignee is no longer eligible at submit | `400 ASSIGNEE_NOT_ELIGIBLE` |
| Same target-scoped action is still processing | existing `409 ACTION_IN_PROGRESS` |
| Staff report target invalid | existing `404 STAFF_PROFILE_NOT_FOUND` |

Error responses never include SQL, stack traces, raw persisted rows, meeting summary
content, organization identifiers beyond already authorized resource DTOs, or concealed
relation details.

## 17. Verification Matrix

### 17.1 Migration and PostgreSQL

- clean database applies 001 through 007;
- an applied 001–006 database applies only 007;
- 001–006 content and hashes are unchanged;
- runner does not reapply successful 007;
- failed 007 leaves no partial schema object or migration row;
- exact three-value JobCard type set;
- exact 15-value activity event set with no missing, extra, or duplicate value;
- exact four-value outcome check;
- one-to-one and cross-organization foreign-key behavior;
- summary null/visible-text/4,000-code-point limits, including rejection of space-, tab-,
  and newline-only persisted values;
- follow-up chronology and null behavior;
- partial report index definition;
- service prevents non-Sales-Meeting parents from owning meeting details.

### 17.2 Server unit, route, and integration tests

- exact three-way create parser and per-type allowlists;
- unchanged Product Delivery and General Task create tests;
- assignment, Customer, Contact, idempotent create, rollback, and activity rules;
- meeting GET/PATCH scope, type-guard order, edit status, role, and invariant failure;
- strict instant parsing, normalization, code-point limit, merged candidate validation;
- deterministic Customer, assignee, then structured-readiness submit error priority;
- empty patch, no-op, replay, in-progress, version conflict, and concurrent updates;
- single version bump and safe deterministic activity projection;
- every submit readiness field and canonical relation error;
- exact 15-minute boundary and immediately later failure;
- revision editing and review/terminal immutability;
- list, board, filter, detail, approval, and activity response contracts;
- report zero-fill, order, attribution, status, type, range, timezone/DST, isolation, and
  inactive historical Staff;
- all report regressions from section 15.1.

### 17.3 Web tests

- exact create, detail, list, board, activity, and report parsers;
- planning route, direct load, refresh, Back, Forward, and URL type ownership;
- role-specific assignee UI and reference-load failure/retry behavior;
- stale Contact response suppression;
- discriminated detail state and exact type-specific request counts;
- bounded version mismatch reload and retryable failure;
- result normalization, idempotent retry, pending guard, and mutation mutex;
- `FOLLOW_UP_REQUIRED` reveals a prominent recommendation without required semantics;
- save and submit remain available when its follow-up instant is omitted;
- lifecycle/version conflict recovery with both JobCard and meeting details;
- type labels, review text, due-date label, and no delivery count for Sales Meeting;
- exact four-row Staff outcome presentation and all-zero state;
- error focus, success focus, conflict status, semantic read-only output, and timezone
  helper text.

### 17.4 Browser and accessibility acceptance

- Staff plans a meeting, records a result, submits, and sees review lock;
- `FOLLOW_UP_REQUIRED` shows follow-up guidance, remains accessibility-optional, and
  permits save and submit without a follow-up instant;
- Manager reviews and approves an outcome;
- Manager requests revision, Staff corrects the result, and resubmits;
- deep-link and reload preserve the correct type-aware screen;
- mobile single-column flow and desktop flow;
- keyboard-only completion, visible focus, modal focus behavior, 44-pixel targets,
  200-percent text sizing, 400-percent reflow, and reduced-motion behavior;
- activity timeline exposes changed-field names but no values;
- Staff report shows approved counts only.

### 17.5 Closeout gates

The implementation verification SHA must record successful results for:

```text
server build
server ordinary tests
server PostgreSQL-enabled full tests
server production audit
web build
web tests
web production audit
Playwright acceptance
git diff --check
clean worktree
local/remote SHA parity
```

A later documentation-only closeout commit need not rerun the full suites, but the docs
must cite the exact previously verified implementation SHA and state that tests were not
rerun for the docs-only commit.

## 18. Documentation and Codebase Memory Closeout

After implementation and verification, update only the SSOTs whose current-state claims
changed:

- `PRODUCT_REQUIREMENTS.md`;
- `SERVORA_MED_ARCHITECTURE_PLAN.md`;
- `SERVORA_MED_SCHEMA_DRAFT.md`;
- `SERVORA_MED_API_DRAFT.md`;
- `SERVORA_MED_MVP_SLICES.md`;
- `DECISIONS.md`, recording the approved two-stage model, `dueDate` versus `meetingAt`
  time semantics, closed four-outcome vocabulary, and optional follow-up behavior for
  `FOLLOW_UP_REQUIRED`;
- `README.md` current scope and exact verification totals;
- this design status and the implementation plan checklist.

Codebase Memory is refreshed only after verified implementation. Generated artifacts
must describe the implementation commit they indexed. Documentation must not claim
Sales Meeting is implemented before code and verification are complete.

## 19. Self-Review

The design was checked against the current Product Requirements, Architecture, Schema,
API, MVP Slice, Decision records, migrations 001–006, Slice 09 design, JobCard create and
submission policies, delivery subresources, Reports read model, JobDetail, JobWorkspace,
General Task create, and exact web parser boundaries.

Results:

- planned day and actual instant have one unambiguous meaning;
- the four outcomes are exact, ordered, and closed;
- two-stage planning and result capture is preserved end to end;
- every Sales Meeting receives exactly one empty detail row through the application
  create contract;
- one JobCard version owns concurrency;
- PATCH lock order, no-op, idempotency, and rollback behavior are explicit;
- WAITING_APPROVAL and terminal immutability reuse `JOB_NOT_EDITABLE`;
- safe activity contains changed-field names only;
- frontend requests exactly one type-specific boundary;
- Staff report attribution, actual-time range, completed-only scope, zero-fill, and exact
  order are explicit;
- all-type counters and delivery-only quantities remain distinct;
- no new report table, view, cache, materialized view, trigger, generic form, JSON detail,
  scheduler, financial behavior, inventory behavior, ranking, or score is introduced;
- no unresolved drafting marker, placeholder choice, optional alternative, or
  implementation-plan instruction remains in the contract.

## 20. Execution Stop

This document is the only deliverable of this design turn. Implementation has not
started. The written spec must receive explicit user approval before
`superpowers:writing-plans` is used. The implementation plan must then receive separate
user review and approval before application code, tests, or migration 007 are written.
