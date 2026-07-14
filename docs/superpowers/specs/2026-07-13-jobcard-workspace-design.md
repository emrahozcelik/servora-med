# Slice 07 — JobCard Workspace, Notes, Timeline, and List/Board Design

> Date: 2026-07-13
> Status: Approved design; implementation not started
> Slice: 07 — JobCard Workspace, Notes, Timeline, and List/Board

## 1. Context and current-state assessment

Servora-Med already has a working Product Delivery tracer, explicit JobCard versions,
organization-scoped records, delivery-item snapshots, four named lifecycle commands, and
an append-only activity table. Slice 07 turns that tracer into the primary operational
workspace without changing JobCard into an inventory, accounting, reporting, or generic
workflow system.

The implemented baseline on `main` at the start of this design is narrower than this
slice:

- `GET /api/job-cards` returns an unpaginated `{ items }` response. It accepts no filters,
  returns raw foreign-key identifiers, and orders by `created_at DESC, id DESC`.
- Staff list scoping is enforced by the service, but Manager/Admin approval filtering is
  performed in the web client rather than by a canonical saved query.
- `GET /api/job-cards/:id/activity` returns an unpaginated raw activity list with actor
  IDs and ascending order.
- `start`, `submit-for-approval`, `approve`, and `request-revision` exist. `plan`, `resume`,
  and `cancel` do not.
- `job_card_activity_logs` already has the full canonical database check constraint, but
  the server TypeScript event union and frontend labels cover only a subset.
- There is no `job_card_notes` table, note API, board endpoint, or board UI.
- The current repository transition statement writes `started_at` whenever the target is
  `IN_PROGRESS`; reusing it for resume would overwrite the first start time.
- The current activity query is ordered oldest-first and does not project actor names.
- The web shell is a top header plus horizontal section links. The jobs screen is a small
  list, exposes technical version values, and has no URL-owned filters or view state.
- Job detail loads detail, delivery items, and activity as one `Promise.all`; one failed
  subsection therefore hides the whole screen.
- Migrations `001` through `005` are applied history and remain immutable.

The following existing documentation statements are superseded for Slice 07:

- `SERVORA_MED_API_DRAFT.md` describes JobCard query, note concurrency, pagination, board
  columns, and cancel authority differently or incompletely. The contracts in this design
  are authoritative for the Slice 07 implementation and the API draft must be reconciled
  during closeout.
- `SERVORA_MED_SCHEMA_DRAFT.md` does not yet lock note idempotency, the 4,000-code-point
  limit, descending read indexes, or migration `006_jobcard_workspace.sql`.
- `SERVORA_MED_MVP_SLICES.md` calls drag-and-drop an optional enhancement in Slice 07.
  Drag-and-drop is explicitly outside this slice; lifecycle state changes use named
  commands only.
- Generic documentation that treats ordinary notes as non-idempotent does not apply to
  JobCard note creation. `JOB_NOTE_ADD` uses the existing processed-action mechanism.

No current implementation behavior is silently promoted to the target contract. The
implementation phase must change the producer, query, DTO, and consumer together.

## 2. Goals

- Make `/jobs` the canonical role-aware operational workspace.
- Provide a structured, paginated list as the default desktop and mobile view.
- Provide a desktop-only read projection arranged as an active-status board.
- Preserve filters, pagination, and desktop view choice through stable URLs.
- Complete the named JobCard state machine with plan, resume, and cancel.
- Add durable append-only JobCard notes that remain readable after completion,
  cancellation, or later operational follow-up.
- Present a complete, human-readable activity timeline without exposing raw event codes.
- Keep Staff scope, organization ownership, optimistic concurrency, idempotency, and
  transaction boundaries server-owned.
- Keep job summary, delivery items, notes, and activity independently recoverable in the
  detail UI.
- Meet the shared WCAG 2.2 Level AA contract on desktop and mobile.

## 3. Non-goals

Slice 07 does not add:

- drag-and-drop or gesture-driven status mutation
- WebSocket or another realtime subscription
- push, email, SMS, or in-app notification infrastructure
- saved or shared user views
- custom fields, a workflow builder, or a configurable state machine
- reports or dashboard counters; those belong to Slice 08
- `GENERAL_TASK`; that belongs to Slice 09
- Sales Meeting behavior
- attachments or photos
- stock, warehouse, accounting, invoicing, costing, or financial totals
- bulk mutation
- board column customization
- a status-history, approval-queue, saved-view, board, or notification table
- confidential Staff-profile notes; JobCard notes are operational and visible to every
  actor authorized to read the JobCard
- note editing or deletion
- Product-line search inside the JobCard free-text query
- a custom browser-history or Apple Settings-style navigation stack

## 4. Locked UX direction

The interface remains reliable, simple, and orderly: modern but understated, corporate
without becoming dense or bureaucratic. It follows the product direction in `PRODUCT.md`,
`DESIGN.md`, and UI-001.

The authenticated desktop shell uses a persistent left sidebar and a main workspace. The
Jobs screen defaults to a structured list and offers `Liste` and `Kanban` view controls at
desktop widths. The board is only a read layout over the same JobCard projection. Cards
are not draggable and no pointer, touch, momentum, or keyboard gesture changes status.
Board cards only open JobCard detail. Lifecycle commands exist only in an expanded list
row or the full detail route.

At widths below `64rem` the persistent sidebar is removed from layout. A compact header
contains the brand, current section, account access, and a `Menüyü aç` button with a
minimum 44 by 44 CSS-pixel target. The button opens a modal navigation drawer containing
the same permitted destinations. Focus moves to the drawer heading, Tab remains within
the open drawer, Escape closes it, and focus returns to the trigger. Route selection also
closes the drawer. This is responsive navigation, not a narrow desktop sidebar.

Mobile never requests or renders the board, even when a copied URL contains
`view=board`. The router replaces that value with `view=list`, retains valid non-view
filters, stops any board request, and does not automatically restore board after the
viewport becomes desktop-sized again. Mobile uses status links and a structured list.
Browser and React Router history remain canonical for Back, Forward, refresh, and deep
links.

Status, priority, date, and a small number of semantic accents distinguish records.
Color is never the only signal. Completed and cancelled jobs do not fill the default
active workspace.

## 5. Domain and lifecycle contracts

The canonical states remain:

```text
NEW
PLANNED
IN_PROGRESS
WAITING_APPROVAL
REVISION_REQUESTED
COMPLETED
CANCELLED
```

The complete transition graph is:

```text
NEW                         --plan----------------> PLANNED
NEW | PLANNED               --start---------------> IN_PROGRESS
IN_PROGRESS                 --submit-for-approval-> WAITING_APPROVAL
WAITING_APPROVAL            --approve-------------> COMPLETED
WAITING_APPROVAL            --request-revision----> REVISION_REQUESTED
REVISION_REQUESTED          --resume--------------> IN_PROGRESS
NEW | PLANNED | IN_PROGRESS |
REVISION_REQUESTED          --cancel--------------> CANCELLED
```

No other transition is valid. `COMPLETED` and `CANCELLED` are terminal for business
fields in this slice. Notes remain appendable under the separate notes contract.

| Command | Source | Target | Staff on own assigned job | Manager/Admin in organization | Required reason |
| --- | --- | --- | --- | --- | --- |
| `plan` | `NEW` | `PLANNED` | yes | yes | none |
| `start` | `NEW`, `PLANNED` | `IN_PROGRESS` | yes | yes | none |
| `submit-for-approval` | `IN_PROGRESS` | `WAITING_APPROVAL` | yes | yes | none |
| `approve` | `WAITING_APPROVAL` | `COMPLETED` | no | yes | none |
| `request-revision` | `WAITING_APPROVAL` | `REVISION_REQUESTED` | no | yes | `revisionReason` |
| `resume` | `REVISION_REQUESTED` | `IN_PROGRESS` | yes | yes | none |
| `cancel` | `NEW`, `PLANNED`, `IN_PROGRESS`, `REVISION_REQUESTED` | `CANCELLED` | no | yes | `cancelReason` |

Every reason is trimmed and must contain between 1 and 2,000 Unicode code points
inclusive. Submission and approval notes are trimmed and accept zero through 2,000 code
points; omission or a whitespace-only value is persisted as `null`. Frontend validation
uses the same limits for early feedback, while backend validation is authoritative. The
existing database text fields remain the persistence location. User-facing forms explain
the consequence before revision or cancellation and return focus to the command summary
after success.

Persistence semantics are exact:

- `plan` sets `planned_at` to the command time.
- The first `start` sets `started_at`. A transition implementation uses
  `COALESCE(started_at, command_time)` and never replaces a non-null first-start value.
- `resume` does not change `started_at`; its time is the `JOB_RESUMED` activity
  `created_at` value.
- Submission writes staff-completion fields; approval, revision request, and cancellation
  write their existing dedicated fields in the same transaction as the state change.
- Revision columns retain the latest revision request across resume and are replaced by
  the next successful revision request. The immutable activity sequence is the canonical
  history of every revision cycle.
- Each successful command increments JobCard `version` exactly once and creates exactly
  one matching named activity. It never creates a generic `STATUS_CHANGED` event.

## 6. Notes contract

`job_card_notes` is a new operational resource that is append-only through the
application contract:

```text
id
organization_id
job_card_id
author_id
note
created_at
```

The note body is trimmed, must contain between 1 and 4,000 Unicode code points inclusive,
and is stored in PostgreSQL `TEXT`. Backend validation counts Unicode code points with
`Array.from(value).length`, not UTF-16 code units or database bytes. The frontend uses
the same counting rule for guidance and early validation; backend validation remains
authoritative.

A note belongs to one JobCard and cannot be moved. The public API, service, and repository
expose append and list operations only; the UI exposes no edit or delete control. There are
no update, delete, or single-note public endpoints. This is not a claim that note rows are
physically immutable under every database maintenance operation, and migration 006 does
not add an `UPDATE`/`DELETE` prevention trigger. Therefore `NOTE_NOT_FOUND` is not part of
the public Slice 07 HTTP contract.

Adding a note:

- does not change JobCard `version`
- does not accept `expectedVersion`
- is allowed for `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED` jobs
- does not unlock or change any commercial field
- allows concurrent authors to append independently
- requires `clientActionId`
- claims the processed action with operation key `JOB_NOTE_ADD`
- inserts the note and one `NOTE_ADDED` activity in one transaction
- stores only `{ "noteId": "<id>" }` in activity metadata
- never copies note text into activity `old_value`, `new_value`, or `metadata`
- returns the canonical Note DTO; an idempotent replay returns that same DTO
- returns `201` for both the first committed append and a completed duplicate replay

The note row is the single source of truth for its text. `NOTE_ADDED` proves the action
occurred and links by identifier; it is not a second note store. A rollback after either
insert leaves neither row committed.

JobCard notes are not private. Staff can read and append notes only on jobs assigned to
them. Manager and Admin can read and append notes on any JobCard in their organization.

## 7. Activity contract

The only canonical JobCard activity event values are:

```text
JOB_CREATED
JOB_ASSIGNED
JOB_PLANNED
JOB_STARTED
JOB_SUBMITTED_FOR_APPROVAL
JOB_APPROVED
JOB_REVISION_REQUESTED
JOB_RESUMED
JOB_CANCELLED
JOB_FIELDS_UPDATED
DELIVERY_ITEM_ADDED
DELIVERY_ITEM_UPDATED
DELIVERY_ITEM_REMOVED
NOTE_ADDED
```

The database constraint, server union, policy/service inputs, repository writes, API DTO,
frontend presentation map, and tests use this exact vocabulary. There is no
`STATUS_CHANGED` event and no lifecycle command writes two events for one transition.

Activity rows are immutable and append-only. No update or delete route exists. Activity
reads order by `created_at DESC, id DESC`, so the most recent event is first and ties are
deterministic.

Persisted `old_value`, `new_value`, and `metadata` remain internal audit fields. The
public API never returns those JSONB objects directly. `activity-presenter.ts` converts
each event to one event-specific, allowlisted detail shape:

```ts
type JobCardActivityDetails =
  | {
      kind: 'STATUS_TRANSITION'
      fromStatus: JobCardStatus
      toStatus: JobCardStatus
    }
  | {
      kind: 'FIELDS_UPDATED'
      changedFields: Array<
        'title' | 'description' | 'customer' | 'contact' |
        'assignee' | 'priority' | 'dueDate'
      >
    }
  | {
      kind: 'DELIVERY_ITEM'
      operation: 'ADDED' | 'UPDATED' | 'REMOVED'
      itemId: string
      purpose: DeliveryPurpose | null
      quantity: number | null
    }
  | { kind: 'NOTE'; noteId: string }
  | { kind: 'NONE' }
```

Lifecycle events use `STATUS_TRANSITION`; `JOB_FIELDS_UPDATED` and `JOB_ASSIGNED` use
`FIELDS_UPDATED`; delivery events use their matching `DELIVERY_ITEM.operation`;
`NOTE_ADDED` uses `NOTE`; `JOB_CREATED` uses `NONE`. Missing or malformed internal values
produce `NONE` rather than exposing raw persistence data. Note text never enters a public
activity payload.

The frontend owns one exhaustive mapping from every canonical event to a Turkish label,
semantic icon or shape, and safe summary. Raw event codes are never rendered. If a newer
server event reaches an older client, the client displays `İş kaydında bir işlem yapıldı`
and reports the unknown event code through the existing non-sensitive client diagnostic
logger in development and error telemetry adapter when one exists. It does not include
old/new values, note text, tokens, or personal data in that report. Absence of a telemetry
adapter does not block rendering.

## 8. List and board read models

`GET /api/job-cards` is the canonical list source. Its exact query allowlist is:

```text
q
status
type
assignedTo
customerId
priority
dueBefore
dueAfter
limit
offset
```

Defaults are `status=active`, `limit=25`, and `offset=0`. `limit` is an integer from 1
through 100. `offset` is a non-negative integer. Unknown keys, repeated scalar keys,
invalid UUIDs, unsupported enum values, impossible dates, or `dueAfter > dueBefore`
return `400 VALIDATION_ERROR` with field-safe details.

Slice 07 accepts exactly `type=PRODUCT_DELIVERY`. `GENERAL_TASK` is not exposed as a
supported filter or workflow until Slice 09. Priority accepts exactly
`low|normal|high|urgent`.

Status accepts exactly:

```text
active
closed
all
NEW
PLANNED
IN_PROGRESS
WAITING_APPROVAL
REVISION_REQUESTED
COMPLETED
CANCELLED
```

`active` expands to `NEW`, `PLANNED`, `IN_PROGRESS`, `WAITING_APPROVAL`, and
`REVISION_REQUESTED`. `closed` expands to `COMPLETED` and `CANCELLED`. `all` adds no
status predicate.

`q` is trimmed. An omitted, empty, or whitespace-only value acts as no query predicate.
A non-empty value contains 1 through 200 Unicode code points; a longer value returns
`400 VALIDATION_ERROR`. Search is case-insensitive across JobCard title, Customer name,
and Contact name only. It does not search descriptions, note bodies, delivery snapshots,
or Product rows. `dueAfter` and `dueBefore` accept only `YYYY-MM-DD` calendar dates;
timestamps are rejected. Both bounds are inclusive over `due_date`.

The canonical list response is:

```ts
type PaginatedJobCardList = {
  items: JobCardListItem[]
  total: number
  limit: number
  offset: number
}

type JobCardListItem = {
  id: string
  type: JobCardType
  status: JobCardStatus
  version: number
  title: string
  priority: JobCardPriority
  dueDate: string | null
  createdAt: string
  updatedAt: string
  staffCompletedAt: string | null
  customer: { id: string; name: string } | null
  contact: { id: string; name: string } | null
  assignee: { id: string; name: string }
  deliveryItemCount: number
}
```

The default order is `updated_at DESC, id DESC`. The `total` reflects all rows after
authorization and filters but before limit/offset. Delivery rows are counted with a
grouped subquery or lateral projection that cannot multiply the total. Quantities with
different or missing units are never summed into a false total.

The approval queue is not another aggregate. It calls:

```text
GET /api/job-cards?status=WAITING_APPROVAL&limit=25&offset=0
```

An exact `WAITING_APPROVAL` filter switches ordering to
`staff_completed_at ASC, id ASC`; the longest-waiting submission appears first. All
other status choices retain the default list order.

`GET /api/job-cards/board` is a read projection over the same authorization predicate,
filter builder, and `JobCardListItem` mapper. Its exact query allowlist is:

```text
q
type
assignedTo
customerId
priority
dueBefore
dueAfter
limit
```

Board `limit` defaults to 25 and accepts 1 through 100. It is a per-active-column item
limit. Counts are computed before the per-column limit. Board rejects `status`, `offset`,
and unknown keys because its columns define status and it has no offset-based page.
Every active column orders items by `updated_at DESC, id DESC`. `closedCounts` applies the
same non-status filters and authorization scope, but returns counts only.

```ts
type JobCardBoard = {
  columns: {
    NEW: { items: JobCardListItem[]; count: number }
    PLANNED: { items: JobCardListItem[]; count: number }
    IN_PROGRESS: { items: JobCardListItem[]; count: number }
    WAITING_APPROVAL: { items: JobCardListItem[]; count: number }
    REVISION_REQUESTED: { items: JobCardListItem[]; count: number }
  }
  closedCounts: { COMPLETED: number; CANCELLED: number }
}
```

The board does not load completed or cancelled items. A closed-count link navigates to
the canonical list with `status=closed&view=list&offset=0`. Board cards have no lifecycle
buttons, quick-status controls, command menus, or mutation gestures. Their only action is
opening `/jobs/:jobCardId`.

## 9. Authorization and organization scope

Every read and mutation starts from the authenticated organization. Cross-organization
records and Staff attempts to read another assignee's JobCard use the existing concealment
policy and return `404 JOB_CARD_NOT_FOUND`.

Staff scope is always `job_cards.assigned_to = authenticated_user.id`. A Staff-supplied
`assignedTo` equal to their own ID is accepted as a redundant filter. Any other value
produces an empty result and can never widen scope. The same predicate applies to list,
board, detail, delivery items, notes, and activity.

Manager and Admin can read all JobCards in their organization and may narrow with
`assignedTo`. They cannot cross the organization boundary.

Mutation authority is the matrix in section 5 plus these rules:

- Staff can change permitted JobCard fields and delivery items only on their own assigned
  editable job.
- Manager/Admin can change permitted fields only while the existing commercial-edit
  policy allows it.
- Nobody changes commercial fields in `WAITING_APPROVAL`, `COMPLETED`, or `CANCELLED`.
- Notes use their own append policy and do not bypass the commercial lock.
- Frontend visibility improves clarity but is never the authorization boundary.

## 10. Concurrency and idempotency

Every lifecycle and note mutation contains a `clientActionId` that is trimmed and contains
1 through 255 Unicode code points. The web client generates it with
`crypto.randomUUID()`, but the backend does not require UUID syntax. Every lifecycle
request also contains a positive integer `expectedVersion`. The operation keys are exact:

```text
JOB_PLAN
JOB_START
JOB_SUBMIT_FOR_APPROVAL
JOB_APPROVE
JOB_REQUEST_REVISION
JOB_RESUME
JOB_CANCEL
JOB_NOTE_ADD
```

The existing unique processed-action key remains
`(organization_id, user_id, client_action_id, operation_key)`. A service first claims the
action inside its transaction, locks the JobCard where a versioned mutation is required,
validates role and source status, performs the state/version write, appends the named
activity, stores the response, and commits. A failed validation or write rolls back the
claim and every side effect.

A completed duplicate returns its stored canonical response without another transition,
version increment, note, or activity. A duplicate whose claim is still processing returns
`409 ACTION_IN_PROGRESS`. The UI does not invent success and may retry with the same
clientActionId after a short user-triggered delay.

The note append path has a fixed HTTP result contract: both the first committed append
and a completed duplicate replay return `201` with the same canonical Note DTO. It does
not require a generalized per-operation HTTP-status abstraction. An in-progress duplicate
still returns `409 ACTION_IN_PROGRESS`.

A stale lifecycle version returns `409 VERSION_CONFLICT` and commits no mutation or
activity. Notes intentionally have no expected version and do not bump JobCard version;
their action claim prevents duplicate appends while allowing different users or different
action IDs to append concurrently.

The first-start preservation rule is enforced in the repository update expression, not
only in the web client. All state-machine checks are repeated against the locked row.

## 11. API routes and DTOs

The canonical Slice 07 JobCard routes are:

```text
GET    /api/job-cards
GET    /api/job-cards/board
POST   /api/job-cards
GET    /api/job-cards/:id
PATCH  /api/job-cards/:id

GET    /api/job-cards/:id/delivery-items
POST   /api/job-cards/:id/delivery-items
PATCH  /api/job-cards/:id/delivery-items/:itemId
DELETE /api/job-cards/:id/delivery-items/:itemId

POST   /api/job-cards/:id/plan
POST   /api/job-cards/:id/start
POST   /api/job-cards/:id/submit-for-approval
POST   /api/job-cards/:id/approve
POST   /api/job-cards/:id/request-revision
POST   /api/job-cards/:id/resume
POST   /api/job-cards/:id/cancel

GET    /api/job-cards/:id/notes?limit=25&offset=0
POST   /api/job-cards/:id/notes
GET    /api/job-cards/:id/activity?limit=50&offset=0
```

Lifecycle request bodies use exact body allowlists:

```ts
type VersionedCommand = {
  clientActionId: string // 1–255 Unicode code points after trim
  expectedVersion: number
}

type SubmissionCommand = VersionedCommand & { note?: string } // 0–2,000 code points
type ApprovalCommand = VersionedCommand & { note?: string }   // 0–2,000 code points
type RevisionCommand = VersionedCommand & { revisionReason: string } // 1–2,000
type CancelCommand = VersionedCommand & { cancelReason: string }     // 1–2,000
```

`plan`, `start`, and `resume` accept `VersionedCommand`. `submit-for-approval` accepts
`SubmissionCommand`, `approve` accepts `ApprovalCommand`, and revision/cancel accept their
specialized bodies. Unknown keys are rejected. The optional submission or approval `note`
populates only the existing lifecycle-specific completion/approval field; it does not
create a `job_card_notes` row. Operational notes use the note endpoint.

Note creation accepts exactly:

```ts
type CreateJobCardNote = {
  clientActionId: string
  note: string
}
```

It returns `201` with the canonical Note DTO for both the first committed append and a
completed duplicate replay. The canonical Note DTO is:

```ts
type JobCardNoteDto = {
  id: string
  jobCardId: string
  note: string
  author: { id: string; name: string }
  createdAt: string
}
```

Notes and activity use `{ items, total, limit, offset }`. Note limits default to 25;
activity limits default to 50. Both accept integer limits from 1 through 100 and
non-negative offsets, reject every other query key, and order by
`created_at DESC, id DESC`.

```ts
type JobCardActivityDto = {
  id: string
  jobCardId: string
  eventType: CanonicalJobCardActivityEvent
  actor: { id: string; name: string } | null
  details: JobCardActivityDetails
  createdAt: string
}
```

The API projects author and actor names. Web clients do not join raw IDs to a separately
loaded user list. `actor` may be null for a system-originated or historically unavailable
actor; note `author` is always present because organization-scoped author deletion is not
part of the current model. The server domain and server DTO retain the canonical 14-event
union. The web transport parser accepts `eventType` as `string`: known values enter the
exhaustive canonical presentation map, while an unknown value uses the safe fallback in
section 7 without failing the entire timeline response.

## 12. Database changes

The only new migration is `server/src/db/migrations/006_jobcard_workspace.sql`. Applied
migrations `001` through `005` are not edited.

Migration 006 creates:

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
```

The 4,000-code-point limit is enforced by the backend because PostgreSQL `length` counts
characters according to database semantics but the HTTP contract explicitly uses Unicode
code points. The non-empty database check is defense in depth.

Required indexes are:

```text
job_card_notes (job_card_id, created_at DESC, id DESC)
job_cards (organization_id, updated_at DESC, id DESC)
job_cards (organization_id, staff_completed_at ASC, id ASC)
  WHERE status = 'WAITING_APPROVAL'
```

The existing `activity_job_time_idx (job_card_id, created_at, id)` supports the required
descending order through a backward B-tree scan and is retained; migration 006 does not
create a duplicate reverse-direction index. The existing activity `event_type` check in
migration 002 already contains the exact section 7 vocabulary and is also retained.

Migration 006 adds two named lifecycle consistency constraints:

```text
job_cards_planned_status_timestamp_check:
  status <> 'PLANNED' OR planned_at IS NOT NULL

job_cards_started_status_timestamp_check:
  status NOT IN ('IN_PROGRESS', 'WAITING_APPROVAL',
                 'REVISION_REQUESTED', 'COMPLETED')
  OR started_at IS NOT NULL
```

The migration validates existing rows before adding these checks and fails with a clear
diagnostic when invalid legacy data exists. It does not silently repair operational
history. It creates no board, approval queue, status history, saved view, or notification
table.

## 13. Backend module boundaries

The JobCard module remains one modular-monolith boundary. Responsibilities are split only
where Slice 07 introduces independently testable behavior:

```text
server/src/modules/job-cards/
  types.ts                 canonical domain, command, filter, and DTO types
  policy.ts                visibility, edit, transition, and note policies
  workspace-query.ts       exact query parsing and shared list/board filter model
  repository.ts            transaction primitives and persisted row mapping
  service.ts               JobCard CRUD and lifecycle orchestration
  notes-service.ts         note validation, idempotent append, and note reads
  activity-presenter.ts    safe activity DTO projection
  handlers.ts              HTTP translation and response status
  routes.ts                endpoint and middleware wiring
```

`workspace-query.ts` produces one typed filter object used by list and board repository
queries. Authorization predicates cannot be supplied by the client and are composed by
the service/repository boundary. Projection SQL and mappers are shared; board grouping
does not duplicate domain policy.

`notes-service.ts` is justified by the independent append/idempotency/version contract.
It uses repository transactions from the same JobCard module and does not become a second
aggregate. `activity-presenter.ts` centralizes safe actor projection and event typing.

Existing files are not split merely for directory symmetry. If a focused unit remains
small and clearer in an existing file, implementation may keep it there while preserving
the responsibility and test boundary described above.

## 14. Frontend routes and component boundaries

Stable routes remain:

```text
/jobs
/jobs/new-delivery
/jobs/:jobCardId
/customers
/customers/:customerId
/customers/:customerId/contacts/:contactId
/products
/products/:productId
/staff
/staff/:staffUserId
/users
```

`/jobs` owns these URL search parameters:

```text
q
status
type
assignedTo
customerId
priority
dueBefore
dueAfter
view=list|board
offset
```

Missing values resolve to `status=active`, `view=list`, and `offset=0`. Invalid values are
removed or replaced with defaults using a history-replacing navigation, then the canonical
URL is requested. Changing any filter resets offset to zero. Browser Back/Forward restores
the previous query exactly.

Selecting board view removes both `status` and `offset`, preserves every other valid
non-status filter, and requests the board endpoint without either parameter. The canonical
board URL is `/jobs?view=board` plus any retained non-status filters. Selecting a status
quick link while viewing the board switches to `view=list`, writes the selected status,
and uses `offset=0`. Moving from desktop board to a smaller viewport replaces `view=board`
with `view=list`, cancels or ignores the board request, and never restores board merely
because the viewport later grows.

Focused frontend units are:

```text
web/src/jobs/
  JobWorkspace.tsx
  JobFilters.tsx
  JobList.tsx
  JobRow.tsx
  JobBoard.tsx
  JobNotes.tsx
  JobTimeline.tsx
  job-labels.ts
  jobs-api.ts
```

`JobWorkspace` coordinates URL state and read models. `JobList` and `JobBoard` render the
same list-item contract. `JobRow` owns compact and expanded presentation, not data fetching.
`JobNotes` and `JobTimeline` own independent request states. `job-labels.ts` is the one
exhaustive status, priority, delivery-purpose, and activity presentation source.
`jobs-api.ts` owns request parsing and DTO validation. Existing top-level files may become
thin route compositions; unrelated screens are not reorganized.

## 15. Desktop behavior

At `64rem` and wider the shell renders a persistent sidebar with:

- `İşler`
- `Müşteriler`
- `Ürünler`
- `Personel` for Manager/Admin and `Profilim` for Staff
- `Kullanıcılar` for Admin only

The current route uses `aria-current="page"`, a text/shape indicator, and a visible
non-color-only selection treatment. Account identity and logout remain available without
hiding navigation.

The Jobs header provides:

- list/board segmented controls
- quick links for `Aktif işler`, `Onay kuyruğu`, and `Düzeltme bekleyenler`
- filters listed in section 8
- a role-appropriate `Yeni teslim` action

List is the default. It renders status, priority, title, customer, optional contact,
assignee, due date, and delivery-item count. Technical version is carried in the DTO but
not displayed. Pagination uses previous/next controls, announces the visible result range,
and preserves filters in links.

Each row starts compact. An explicit button toggles an associated inline summary region
with `aria-expanded` and `aria-controls`. The region shows description, contact, due date,
delivery-item count, currently permitted named actions, and `Tam detayı aç`.
Opening the detail uses `/jobs/:jobCardId`; returning through browser history restores the
workspace URL. Inline expansion is ephemeral UI state and need not be encoded in the URL.

Board view renders the five active columns in section 8. Every card is a link/summary with
one action: open the full JobCard detail. It has no lifecycle buttons, quick-status
controls, command menu, draggable attributes, drag handles, pointer capture, reorder
semantics, or gesture instructions. Lifecycle commands are available only in the expanded
list row or full detail. A column whose count exceeds its loaded item limit links to the
corresponding exact-status list. Closed counts link to closed list history.

Loading, empty, no-results, error, forbidden, retry, and stale/conflict states are explicit.
An empty organization state differs from a filter with no matches. Approval queue text
explains that the oldest submission is first.

## 16. Mobile behavior

Below `64rem`, Jobs always renders list mode and canonicalizes `view=board` to
`view=list`. It does not request `/api/job-cards/board` and does not mount hidden board
markup. This canonicalization uses history replacement and does not restore board after a
later desktop resize.

Status navigation is a wrapping landmark of normal React Router links, not an ARIA tab
widget that imitates application focus behavior:

```text
Aktif       -> status=active
Yeni        -> status=NEW
Planlandı   -> status=PLANNED
Devam       -> status=IN_PROGRESS
Onay        -> status=WAITING_APPROVAL
Düzeltme    -> status=REVISION_REQUESTED
Kapalı      -> status=closed
```

The landmark is labelled `İş durumu`, each link has a 44 by 44 CSS-pixel interaction
area, and the selected link uses `aria-current="page"`. Links wrap instead of requiring a
seven-column board or page-level horizontal scrolling.

Mobile rows stack identity, semantic status/priority, customer/contact, assignee, due date,
and delivery count. The inline summary control remains available, while the full detail is
a separate route. Actions use full-width or clearly separated 44-pixel targets. Filters
open in an accessible disclosure panel; applying them updates the URL and returns focus to
the result heading. No desktop table or board is merely squeezed into the viewport.

## 17. Error and truth-recovery behavior

Errors are mapped centrally and preserve backend truth:

| Code or condition | UI behavior |
| --- | --- |
| `JOB_CARD_NOT_FOUND` | Replace the affected detail with a safe not-found message and a link to the canonical Jobs URL. Staff are not told another assignee owns it. |
| `FORBIDDEN` | Show a role-safe forbidden state; do not retry automatically. |
| `VERSION_CONFLICT` | Do not show success. Reload detail, delivery items, permitted actions, notes summary, and activity from the backend; explain that another device changed the job. |
| `ACTION_IN_PROGRESS` | Keep the action pending result unconfirmed, offer a retry using the same `clientActionId`, and allow a truth reload. |
| `INVALID_TRANSITION` | Reload the JobCard and explain that the action is no longer valid for its current status. |
| `REVISION_REASON_REQUIRED` | Keep the dialog/form open, associate the message with the reason field, and focus it. |
| `CANCEL_REASON_REQUIRED` | Keep the dialog/form open, associate the message with the reason field, and focus it. |
| `VALIDATION_ERROR` | Show a safe form or query error; enforce the exact type/priority/date enums, 200-code-point query limit, 255-code-point action ID limit, 2,000-code-point lifecycle text limits, and 4,000-code-point operational-note limit. Invalid URL filters are canonicalized before a request, while server rejection remains visible. |
| Invalid pagination/query | Reset only the invalid field through a replace navigation and announce that the view was corrected. |
| Network/server read failure | Preserve already loaded independent sections and provide a section-local retry. |
| Ambiguous note POST result | Retain the note draft and retry with the same `clientActionId`; a replay supplies the original Note DTO. |

Named lifecycle commands never use optimistic success. Controls enter a pending state,
remain labelled, and update only from a successful server DTO. A failed command keeps the
previous record visibly unconfirmed until truth is reloaded.

Job detail loads its base record and delivery items independently from notes and activity.
A notes failure affects only notes; an activity failure affects only the timeline. Each
section has its own loading, empty, error, and retry state. A base-detail failure does not
misrepresent stale lifecycle controls as usable.

## 18. Accessibility

Slice 07 targets WCAG 2.2 Level AA and follows UI-001:

- Every function is keyboard-operable; no lifecycle operation depends on drag, hover, or
  touch gesture.
- Buttons, navigation items, board-card actions, disclosures, filters, pagination, and
  mobile controls provide at least 44 by 44 CSS pixels where practicable.
- Visible `:focus-visible` treatment is maintained against every surface.
- Sidebar and mobile drawer use semantic navigation landmarks. Drawer focus is contained
  only while modal and restored on close.
- Status and priority combine text with shape/icon; color is supplemental.
- List content uses semantic lists/articles or a correctly headed table only when the
  responsive structure remains usable. Board columns use labelled sections and lists.
- Dialogs for revision and cancellation have accessible names, descriptions, initial
  focus, Escape behavior, error association, and trigger-focus restoration.
- Note textarea has a persistent label, required guidance, live remaining-code-point text,
  and programmatically associated errors. Hint text is not its label.
- Command and note result messages use appropriate polite status or alert semantics and
  do not move focus unnecessarily.
- At 200% text size content does not clip or overlap. At 400% zoom and a 320 CSS-pixel
  effective width the layout reflows without page-level horizontal scrolling.
- `prefers-reduced-motion: reduce` removes nonessential transition movement. No information
  depends on animation.
- Dates use visible localized text and machine-readable `dateTime` values.
- Loading state is exposed with `aria-busy` at the affected section, not the whole app
  when other sections remain usable.

Automated checks supplement manual keyboard, screen-reader semantics, zoom/reflow, touch
target, reduced-motion, and color-independence review.

## 19. Test strategy

Backend unit and route tests cover:

- migration/schema contract and immutable migration history
- Staff server scope that cannot be widened by `assignedTo`
- Manager/Admin organization scope and cross-organization concealment
- exact query allowlists, repeated keys, enums, dates, limit, and offset
- exact `PRODUCT_DELIVERY` type and four-value priority contracts
- whitespace query omission, 200-code-point query boundary, and `YYYY-MM-DD`-only dates
- free-text search over title, Customer, and Contact only
- default and approval-queue deterministic ordering
- list pagination totals and related-record projection
- board/list projection parity and filtered closed counts
- the complete lifecycle state machine and role matrix
- required revision and cancel reasons
- expected-version conflict with no partial state/activity
- processed-action claim, completed replay, and in-progress response
- action IDs from 1–255 code points without a server-side UUID requirement
- 2,000-code-point submission, approval, revision, and cancellation boundaries
- operational note validation at 1 and 4,000 code points, including rejection outside
  those bounds
- exactly one canonical activity per lifecycle transition
- original `started_at` preservation across resume
- duplicate note replay with one note and one activity
- first and replayed note responses both return `201` with the same DTO
- concurrent note append with different action IDs
- note and activity atomic rollback
- no JobCard version change after note append
- deterministic note/activity ordering and projected author/actor names
- complete canonical server event union and event-specific allowlisted public details
- no raw activity JSONB fields or note text in public activity DTOs
- completed/cancelled commercial immutability with permitted note append

PostgreSQL-backed tests run migrations `001` through `006` and exercise real SQL for:

- list and board projections
- pagination totals without join multiplication
- Staff visibility and Manager/Admin organization visibility
- approval queue ordering by submission time
- concurrent notes and duplicate idempotency claims
- transactional rollback between note and activity insert
- activity and note tie ordering
- first-start preservation and lifecycle constraints

Frontend tests cover:

- URL-owned filters, view, and pagination through Back/Forward-style navigation
- board URL removal of status/offset and status-link return to canonical list view
- desktop list and related-record fields
- desktop board parity, read-only semantics, and absence of drag behavior
- board cards that only open detail and expose no lifecycle command surface
- mobile forced-list history replacement without a board request or automatic restoration
- status navigation, filter disclosure, pagination, and expandable rows
- named action visibility by role/status
- no optimistic lifecycle success and conflict truth recovery
- independent base, notes, and activity loading/error/retry states
- string-tolerant transport parsing, exhaustive known labels, and safe unknown-event
  presentation without timeline failure
- all lifecycle and operational-note text boundaries, pending note state, ambiguous error,
  same-action retry, and successful draft clearing
- technical version hidden from list and board presentation

Playwright acceptance covers Manager desktop, Staff desktop, `390x844` mobile, and a
320-CSS-pixel effective reflow. Scenarios cover keyboard-only navigation, visible focus,
sidebar/mobile drawer, status navigation, note append, approval, revision, resume,
cancellation, focus after dialogs/actions, 44-pixel targets, 200% text, applicable 400%
reflow, reduced motion, no mobile board overflow, and color-independent status meaning.

Existing PostgreSQL-backed server and web CI jobs remain. If browser acceptance is added
to CI, it is a separate Playwright job using the same application build and disposable
PostgreSQL service. No dependency is added unless the implementation proves the existing
stack cannot meet a named acceptance criterion.

## 20. Migration/rollout

Implementation order for safe rollout is contractual but is not an implementation task
plan:

1. Deploy migration `006_jobcard_workspace.sql` before code that writes notes or new
   lifecycle events.
2. Deploy server support for the expanded list/activity DTOs, board, notes, and complete
   lifecycle as one compatible API release.
3. Deploy the web workspace against that API. Server and web are versioned together in
   the modular-monolith release, so no long-lived dual response contract is introduced.
4. Run the disposable-PostgreSQL tracer and full CI gates before production deployment.

Migration 006 is forward-only and must fail clearly if prerequisite tables or constraints
from migrations 001–005 are absent. Rollback of application code does not drop note or
activity data. A production rollback keeps migration 006 applied and restores a server
version that tolerates the added table/indexes; destructive down migrations are not used.

No data backfill is required. Existing JobCards keep their current first-start and
lifecycle timestamps. Existing activity rows already use values within the canonical
vocabulary.

## 21. SSOT documents that implementation must update

The implementation closeout updates these sources together so they describe shipped
behavior rather than design intent:

- `DECISIONS.md`: record the read-only board, completed lifecycle, append-only note, and
  Staff visibility decisions. This design turn already adds the spec index link.
- `SERVORA_MED_API_DRAFT.md`: replace stale JobCard list, board, notes, activity,
  idempotency, concurrency, cancellation, DTO, pagination, and error contracts.
- `SERVORA_MED_SCHEMA_DRAFT.md`: add migration 006, notes, indexes, canonical event
  alignment, and first-start/resume persistence semantics.
- `SERVORA_MED_MVP_SLICES.md`: remove Slice 07 drag-and-drop wording, record verified
  acceptance, and retain reports/General Task as later slices.
- `SERVORA_MED_ARCHITECTURE_PLAN.md`: record focused JobCard workspace query and note
  boundaries if the implemented module split materially changes the architecture.
- `README.md`: update implemented-through status and exact verified commands only after
  Slice 07 passes.
- `DESIGN.md`: document real shell/workspace tokens and component behavior after the UI
  exists, following UI-001 rather than inventing speculative tokens in this design turn.

The implementation must also correct its server/frontend contract types and tests. It
must not claim completion merely because these documents were edited.

## 22. Explicit acceptance criteria

Slice 07 is accepted only when all statements below are true:

- [ ] `/jobs` defaults to a paginated active structured list ordered by
  `updated_at DESC, id DESC`.
- [ ] List filters use the exact allowlist and stable URL state defined here.
- [ ] Type accepts only `PRODUCT_DELIVERY`, priority accepts exactly four canonical values,
  query text is at most 200 code points after trim, and dates accept only `YYYY-MM-DD`.
- [ ] Staff list, board, detail, notes, and activity access cannot escape own-assignee
  scope; Manager/Admin remain organization-scoped.
- [ ] List DTOs include Customer, optional Contact, assignee, timestamps, and delivery-item
  count without fabricating a mixed-unit quantity total.
- [ ] Approval queue uses the canonical list projection and orders oldest submission
  first by `staff_completed_at ASC, id ASC`.
- [ ] Desktop board uses the shared projection/filter policy, contains five active columns,
  exposes closed counts only, and has no mutation controls or drag-driven behavior.
- [ ] Entering board removes status/offset while preserving non-status filters; selecting a
  status from board returns to list with offset zero.
- [ ] Mobile never requests or renders board UI and canonicalizes board URLs to list while
  preserving filters, without automatically restoring board after a desktop resize.
- [ ] All seven named lifecycle endpoints enforce the exact state and role matrix.
- [ ] Staff cannot cancel or approve; Manager/Admin cancellation requires a reason.
- [ ] Every lifecycle mutation requires action ID and expected version, increments version
  once, writes one named activity atomically, and safely replays duplicates.
- [ ] Action IDs accept 1–255 code points without requiring UUID syntax; lifecycle notes
  and reasons enforce their exact 2,000-code-point boundaries.
- [ ] Resume preserves the original first-start timestamp and records resume time through
  `JOB_RESUMED` activity.
- [ ] Server, database, API, frontend labels, and tests share the exact 14-event vocabulary
  and never emit a generic status event.
- [ ] JobCard notes are append-only, 1–4,000 Unicode code points, role-scoped, and available
  in review and terminal states without unlocking commercial fields.
- [ ] Note creation has no expected version, does not bump JobCard version, and atomically
  commits one note plus one `NOTE_ADDED` activity containing only `noteId` metadata.
- [ ] Retrying a note with the same action ID returns the same DTO with no duplicate rows.
- [ ] First note append and completed duplicate replay both return `201`; an in-progress
  duplicate returns `409 ACTION_IN_PROGRESS`.
- [ ] Note and activity endpoints paginate, order newest-first deterministically, and
  project author/actor names.
- [ ] Public activity DTOs contain only event-specific allowlisted details and never expose
  raw audit JSONB or note text.
- [ ] Desktop uses a persistent accessible sidebar; smaller layouts use the specified
  focus-managed navigation drawer.
- [ ] List rows and board cards hide technical version while retaining it for commands.
- [ ] Job detail keeps base, delivery, notes, and activity failure/retry states independent.
- [ ] Lifecycle conflicts reload backend truth and never show optimistic success.
- [ ] Every canonical activity has a centralized Turkish presentation; unknown values use
  safe generic copy and non-sensitive diagnostics without failing the timeline parser.
- [ ] Migration 006 is the only schema-history change and creates no board, approval,
  history, saved-view, or notification table.
- [ ] Backend, real PostgreSQL, frontend, and Playwright coverage described in section 19
  passes in CI or in the documented local acceptance environment.
- [ ] Keyboard, focus, 44-pixel targets, 200% text, applicable 400% reflow, reduced motion,
  mobile overflow, and color-independent status checks pass.
- [ ] The SSOT files in section 21 match verified implementation behavior before the slice
  is marked complete.
