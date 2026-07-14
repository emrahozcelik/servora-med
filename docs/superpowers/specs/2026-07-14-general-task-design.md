# Servora-Med Slice 09 — General Task Design

> Status: Proposed design; pending user approval
> Date: 2026-07-14
> Scope: General Task creation, lifecycle participation, type-aware detail, and workspace integration

## 1. Purpose

Slice 09 activates `GENERAL_TASK` as the second usable JobCard type without creating a
second workflow engine. A field worker or management user can create a small operational
task, move it through the existing approval lifecycle, preserve notes and activity, and
find it in the same list, board, approval, Staff, and operational-report surfaces as other
JobCards.

This slice does not turn JobCard into a generic form builder. `GENERAL_TASK` uses the
persisted common JobCard fields that already exist. It does not own products, delivery
items, custom JSON, checklists, attachments, subtasks, or type-specific tables.

## 2. Product Outcomes

The completed slice provides these outcomes:

1. Staff can create a General Task assigned to themselves from `/jobs/new-task`.
2. Manager and Admin can create a General Task for an active Staff user in their
   organization.
3. A title-only task with an eligible assignee can complete the full existing lifecycle,
   including manager approval.
4. Customer, Contact, description, priority, and due date remain optional context.
5. General Task detail shows common JobCard information, notes, activity, and valid
   lifecycle commands without requesting or presenting delivery data.
6. List, board, URL filters, approval queues, Staff summaries, and all-type operational
   metrics recognize both canonical JobCard types.
7. Delivery quantity reports and delivery subresources remain Product Delivery-only.

## 3. Non-Goals

Slice 09 does not add or redesign:

- a migration, table, column, database enum, trigger, view, or materialized view;
- Product Delivery creation or delivery item presentation;
- Sales Meeting;
- custom fields or a JSON details document;
- checklist items, subtasks, dependencies, recurrence, or templates;
- attachments, notifications, realtime updates, or native mobile behavior;
- financial, accounting, inventory, ranking, or employee-score behavior;
- a polymorphic form builder shared by every future JobCard type;
- report tables, report caches, or new report aggregations.

## 4. Existing Baseline and Required Gaps

The database already accepts `PRODUCT_DELIVERY` and `GENERAL_TASK` in
`job_cards.type`. The shared lifecycle, optimistic version, processed-action idempotency,
activity, notes, workspace projections, approval queue, and operational reports already
operate on JobCards.

The implementation currently exposes these gaps:

- create service input and validation accept only `PRODUCT_DELIVERY`;
- list and board type filters accept only `PRODUCT_DELIVERY`;
- the web detail parser accepts only `PRODUCT_DELIVERY`;
- the detail screen always requests delivery items and uses delivery-specific text;
- list rows always render delivery count and a fixed Product Delivery type label;
- `GET`, `PATCH`, and `DELETE` delivery item paths do not all enforce the same parent-type
  guard;
- detail returns raw relation identifiers and makes the web client unable to render names
  from a deep link without unrelated module reads.

Slice 09 fixes these source boundaries. It does not add frontend workarounds for them.

## 5. Canonical JobCard Types

```ts
type JobCardType = 'PRODUCT_DELIVERY' | 'GENERAL_TASK'
```

The canonical Turkish presentation labels are:

```text
PRODUCT_DELIVERY -> Ürün teslimi
GENERAL_TASK     -> Genel görev
```

Type is immutable after creation. `PATCH /api/job-cards/:jobCardId` never accepts
`type`. Changing a JobCard from one type to another requires creating a different
JobCard; no conversion command is introduced.

## 6. Exact Create Contract

The backend keeps one endpoint:

```text
POST /api/job-cards
```

Its body is the following exact discriminated union:

```ts
type ProductDeliveryCreateInput = {
  clientActionId: string
  type: 'PRODUCT_DELIVERY'
  title: string
  description?: string | null
  customerId: string
  contactId?: string | null
  assignedTo: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
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
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  dueDate?: string | null
}

type JobCardCreateInput =
  | ProductDeliveryCreateInput
  | GeneralTaskCreateInput
```

The body must be a JSON object. Unknown fields, arrays, an absent or unknown `type`, and
fields with the wrong primitive type return `400 VALIDATION_ERROR`. Delivery fields such
as `productId`, `deliveryItems`, `deliveryPurpose`, `quantity`, `deliveredAt`, `unit`,
`lotNo`, `serialNo`, `expiryDate`, and `deliveryNote` are not members of either create
shape and are rejected as unknown fields.

### 6.1 Field normalization and validation

| Field | Contract |
| --- | --- |
| `clientActionId` | required string; trimmed; 1–255 Unicode code points; uses the existing create idempotency contract |
| `title` | required string; trimmed; 1–255 Unicode code points |
| `description` | omitted or `null` persists `null`; a string is trimmed; an empty trimmed string persists `null`; the existing database `TEXT` and request-body limits apply and Slice 09 adds no field-specific maximum |
| `assignedTo` | required UUID string in the request; effective value follows the role policy below |
| `customerId` | Product Delivery requires a UUID string; General Task accepts omitted, `null`, or a UUID string |
| `contactId` | accepts omitted, `null`, or a UUID string; a non-null value requires a non-null `customerId` |
| `priority` | omitted defaults to `normal`; otherwise one canonical priority is required |
| `dueDate` | omitted or `null` persists `null`; otherwise strict calendar date `YYYY-MM-DD` |

Malformed identifier, priority, date, and field-type input returns
`400 VALIDATION_ERROR` before PostgreSQL is called with that value. This validation does
not reveal whether a correctly formed identifier belongs to another organization.

The create response is the canonical JobCard detail projection defined in section 11.
Creation starts at `NEW`, version `1`, and appends exactly one `JOB_CREATED` activity in
the same transaction. Initial assignee identity remains part of that event; creation does
not append a second `JOB_ASSIGNED` event.

Create keeps the existing processed-action behavior. The claim key is scoped by
organization, authenticated actor, `clientActionId`, and `JOB_CREATE`. A completed replay
returns the original response and creates no duplicate JobCard or activity.

## 7. Assignment and Relation Policy

### 7.1 Staff assignment

`assignedTo` remains required in both request variants so the public shape is explicit.
For an authenticated Staff actor, the supplied identifier must equal the authenticated
Staff user ID. Equality continues through the shared assignee lookup and eligibility
policy. A different identifier returns `403 FORBIDDEN` before any assignee PostgreSQL
lookup; the service does not silently replace it with the authenticated user ID.

This prevents a Staff request from assigning a task to another user and prevents
cross-organization identifier probing. The web form sends the authenticated Staff ID and
shows the user as fixed task owner rather than rendering an assignee selector.

This pre-lookup self-assignment check is one common create policy used by both
`PRODUCT_DELIVERY` and `GENERAL_TASK`. Slice 09 preserves the existing Product Delivery
create contract; it does not introduce a different Staff assignment rule for General
Task.

### 7.2 Management assignment

Manager and Admin must supply an active, same-organization user whose role is `STAFF`.
Assignee failures use the shared Product Delivery policy and exact responses below:

- malformed `assignedTo` returns `400 VALIDATION_ERROR` before lookup;
- missing or cross-organization assignee returns `404 ASSIGNEE_NOT_FOUND`;
- inactive or non-Staff assignee returns `403 FORBIDDEN`;
- a Staff actor supplying any ID other than their own returns `403 FORBIDDEN` before
  assignee lookup.

Managers and Admins cannot assign a General Task to themselves unless their user also has
the canonical Staff role; roles are not treated as interchangeable. General Task does not
define a new assignee error standard.

The same eligibility check runs again at submit time. A user who becomes inactive or
ceases to be eligible after creation prevents submission until the task is reassigned to
an eligible Staff user.

### 7.3 Customer and Contact

General Task Customer and Contact are optional common JobCard context, not delivery data.

- A non-null Customer must be active and belong to the authenticated organization.
- A non-null Contact requires a non-null Customer.
- The Contact must be active, belong to the authenticated organization, and belong to
  the selected Customer.
- Missing or cross-organization Customer and Contact records use the existing concealed
  `CUSTOMER_NOT_FOUND` and `CONTACT_NOT_FOUND` responses.
- Inactive or mismatched records use the existing `CUSTOMER_INACTIVE`,
  `CONTACT_INACTIVE`, and `CONTACT_NOT_IN_CUSTOMER` responses.
- Clearing Customer clears Contact in the same patch.
- Changing Customer without supplying a compatible Contact clears the previous Contact.

No Customer is inferred from the Contact. No Customer or Contact is required before a
General Task can be submitted.

## 8. Patch and Edit Contract

The existing common patch route remains:

```text
PATCH /api/job-cards/:jobCardId
```

Its exact field allowlist remains `expectedVersion`, `title`, `description`,
`customerId`, `contactId`, `assignedTo`, `priority`, and `dueDate`. It never accepts
`type`, status, product, delivery, lifecycle timestamp, organization, creator, or activity
fields.

The same edit-state, role, assignment, optimistic concurrency, activity, and relation
rules apply to both JobCard types. The title invariant is 1–255 trimmed Unicode code
points for either type. `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED` remain immutable
through this route. Assignment changes append `JOB_ASSIGNED`; other changed common fields
append `JOB_FIELDS_UPDATED` in the same transaction.

General Task patch does not gain any type-specific details shape. Product and delivery
data can only be mutated through Product Delivery delivery-item endpoints.

## 9. Type-Specific Submission Policy

All JobCard types use the existing transition runner for authorization, source and target
status validation, row locking, expected-version comparison, processed-action claim,
lifecycle timestamps, activity append, replay, and transaction rollback.

Only readiness validation varies by type. `submission-policy.ts` owns this exhaustive
policy registry:

```ts
type SubmissionPolicy = (
  transaction: JobCardTransaction,
  actor: JobCardActor,
  jobCard: JobCard,
) => Promise<void>

const submissionPolicies: Record<JobCardType, SubmissionPolicy> = {
  PRODUCT_DELIVERY: validateProductDeliverySubmission,
  GENERAL_TASK: validateGeneralTaskSubmission,
}
```

This registry is an internal domain boundary, not a plugin framework. Adding a new
JobCard type must cause a compile-time missing-policy failure.

### 9.1 Product Delivery readiness

The existing rules remain unchanged:

- valid same-organization Customer;
- eligible assigned Staff user;
- at least one valid delivery item;
- every item has Product, canonical purpose, valid delivered time, and positive quantity.

### 9.2 General Task readiness

A General Task is ready when:

- its persisted trimmed title contains 1–255 Unicode code points; and
- its persisted assignee is an active, same-organization Staff user.

Description, Customer, Contact, priority other than the persisted default, due date, and
delivery items are not submission requirements. Therefore a title-only General Task with
an eligible assignee can be started and submitted.

Both policies feed the same `SUBMIT_FOR_APPROVAL` command. Successful submission sets the
same staff completion identity and time, moves to `WAITING_APPROVAL`, increments version,
and appends `JOB_SUBMITTED_FOR_APPROVAL` atomically.

## 10. Delivery Subresource Boundary

All delivery item endpoints are valid only when the visible parent JobCard has type
`PRODUCT_DELIVERY`:

```text
GET    /api/job-cards/:jobCardId/delivery-items
POST   /api/job-cards/:jobCardId/delivery-items
PATCH  /api/job-cards/:jobCardId/delivery-items/:itemId
DELETE /api/job-cards/:jobCardId/delivery-items/:itemId
```

For a visible `GENERAL_TASK`, every endpoint returns:

```text
409 INVALID_JOB_TYPE
```

The canonical Turkish message is
`Teslim kalemleri yalnız ürün teslimi işlerinde kullanılabilir.` The check runs after
parent visibility/not-found concealment and before
version comparison, item lookup, Product lookup, or mutation. Thus a General Task gets the
same type error for list, add, patch, and delete, regardless of a supplied item ID or
expected version.

This is an application-domain guard. No migration or trigger is added. A General Task
does not acquire delivery items through any supported repository or HTTP path, and the web
client never calls these endpoints for that type.

`INVALID_JOB_TYPE` is added to the canonical API error vocabulary if absent. It is not
treated as retryable by the web client.

## 11. Canonical JobCard Detail Projection

`GET /api/job-cards/:jobCardId` and successful common JobCard mutations return one exact,
type-aware projection:

```ts
type RelatedIdentity = {
  id: string
  name: string
}

type JobCardDetail = {
  id: string
  organizationId: string
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK'
  status:
    | 'NEW'
    | 'PLANNED'
    | 'IN_PROGRESS'
    | 'WAITING_APPROVAL'
    | 'REVISION_REQUESTED'
    | 'COMPLETED'
    | 'CANCELLED'
  version: number
  title: string
  description: string | null
  customerId: string | null
  contactId: string | null
  assignedTo: string
  createdBy: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  dueDate: string | null
  assignee: RelatedIdentity
  customer: RelatedIdentity | null
  contact: RelatedIdentity | null
}
```

The repository produces this projection with organization-scoped joins in one read. The
web client does not call People or CRM endpoints to compose assignee, Customer, or Contact
names during a detail deep link or refresh.

The relation identifiers already present in Product Delivery responses are retained.
`assignee`, `customer`, and `contact` are additive display projections. Existing Product
Delivery field meanings and delivery-item endpoints do not change. The web parser is
updated to accept both type discriminants and the exact relation projections before a
General Task creation route becomes reachable. No API version fork is introduced.

Delivery items are intentionally not embedded in `JobCardDetail`. Product Delivery detail
continues to fetch its existing subresource; General Task detail does not.

## 12. List, Board, and URL-Owned Type Filter

The existing canonical `JobCardListItem` remains shared by list, board, approval
projection, and report consumers. Its `type` accepts both canonical values. For a General
Task, `deliveryItemCount` is exactly `0`.

Server list and board query parsers accept:

```text
type=PRODUCT_DELIVERY
type=GENERAL_TASK
```

Omitted `type` means both types. Empty, repeated, or unknown type values return
`400 VALIDATION_ERROR` on the API. The web URL parser accepts the same two values. Invalid
web URL values are removed with replace navigation so refresh, deep link, Back, and
Forward preserve a canonical filter state without adding a history entry.

Changing type or any other list filter resets list offset to `0`. Entering board view
removes list-only status and offset according to the existing workspace contract. Mobile
continues to force the structured list and does not request the board.

Type presentation always includes the text label. Color is not the sole type indicator.
Product Delivery rows may show delivery item count. General Task rows do not render a
delivery count, delivery empty state, Product label, purpose, quantity, or delivered time.
The expanded summary uses the correct type label for each item.

## 13. Lifecycle, Notes, Activity, and Reports

General Task uses the existing commands without new routes:

```text
plan
start
submit-for-approval
approve
request-revision
resume
cancel
```

Role rules, terminal immutability, review lock, reason requirements, first `started_at`
preservation, optimistic version behavior, replay semantics, and canonical activity events
are identical to Product Delivery. Notes remain append-only through the application
contract and are available in every lifecycle state under the existing policy.

Reporting scope is explicit:

| Surface | General Task behavior |
| --- | --- |
| Dashboard active/overdue/waiting/revision/completed/cancelled/trend | included because these metrics cover all JobCard types |
| Staff open/waiting/revision/overdue/completed counters | included through `assigned_to` ownership |
| Approval queue and approval age | included when status is `WAITING_APPROVAL` |
| Delivery quantities and `deliveriesByPurpose` | excluded because these metrics cover only Product Delivery items |

No report service or aggregation contract changes. Tests prove the established all-type
and delivery-only boundaries rather than adding a second reporting path.

## 14. Backend Component Design

The implementation remains inside the JobCards modular-monolith boundary:

- `handlers.ts` validates an exact body allowlist and translates HTTP input/output;
- `service.ts` owns discriminated create behavior, assignment policy, relation policy,
  transactions, and lifecycle orchestration;
- `submission-policy.ts` owns the exhaustive type-to-readiness mapping;
- `repository.ts` adds the canonical detail projection query and keeps persistence access
  within JobCards;
- `workspace-query.ts` accepts both canonical type filter values;
- `types.ts` owns the canonical type union and DTOs.

Reports, People, CRM, Products, and the web app do not call each other over HTTP to build
JobCard detail. JobCards may use its existing transaction-scoped reference reads. No new
runtime circular dependency is introduced.

The implementation must not scatter `if (type === ...)` readiness rules through route,
repository, and UI layers. Type-specific rendering is expected in the detail presentation;
type-specific submission readiness belongs only to the backend policy boundary.

## 15. Frontend Routes and Navigation

The stable creation routes are:

```text
/jobs/new-delivery  existing Product Delivery creation
/jobs/new-task      General Task quick creation
```

The existing Product Delivery route, form, request sequence, and success behavior are not
rewritten as part of this slice. Workspace creation controls expose two explicit actions:

- `Yeni teslim`
- `Yeni görev`

They are real links or buttons with stable accessible names, visible focus, and at least
44×44 CSS px interaction targets. Role visibility follows existing JobCard creation
permission; Staff and management can open General Task creation.

Refresh and direct navigation to `/jobs/new-task` render the same form. Authentication and
mandatory-password-change gates continue to run before this route. Successful creation
navigates to `/jobs/:jobCardId`; cancellation returns to the workspace without creating a
record.

## 16. General Task Quick-Create Form

The form is a separate component and request builder. It is not a conditional branch in
`DeliveryCreate`, and it does not introduce a generic schema-driven form system.

Primary fields are always visible:

- title — required;
- assignee — fixed authenticated Staff identity or required active-Staff select for
  Manager/Admin;
- description — optional.

An accessible `Ek bilgiler` disclosure contains:

- priority — default `normal`;
- due date — optional;
- Customer — optional active-customer select;
- Contact — optional and disabled until a Customer is selected.

The disclosure is reachable and operable by keyboard and exposes its expanded state
semantically. Hidden optional values are still represented by the explicit defaults:
`priority: 'normal'`, `dueDate: null`, `customerId: null`, and `contactId: null`.

### 16.1 Reference loading

- Staff actors do not load the Staff list; their authenticated identity is fixed.
- Manager/Admin load active Staff through the existing People client. A Staff-list failure
  prevents submit and provides an inline retryable error because assignee is required.
- Customer data is loaded through the existing CRM client when the optional section is
  opened. Failure does not prevent a context-free General Task; it disables Customer and
  Contact selection and presents a retry action.
- Selecting a Customer loads its active Contacts through the existing CRM behavior.
- Changing or clearing Customer clears Contact immediately.
- Stale Contact responses from a previous Customer selection are ignored using the
  existing request-generation gate pattern.

Shared Staff, Customer, and Contact selection behavior may be extracted only where the
interaction, loading, error, and value semantics are genuinely identical. Product and
delivery controls are never shared with General Task.

### 16.2 Submission behavior

Frontend validation provides early feedback for required title, title length, assignee,
date, and Contact-without-Customer. Backend validation remains authoritative.

The form generates one `clientActionId` for a logical submission and retains it across an
ambiguous or retryable retry until the server outcome is known. While pending, duplicate
submission is disabled. Errors are summarized in a focusable alert and associated field
errors remain adjacent to their labels. A failed request preserves entered values.

## 17. Type-Aware Detail Shell

`/jobs/:jobCardId` uses one shared detail shell for:

- page heading and textual type label;
- title, description, status, priority, due date;
- assignee, optional Customer, and optional Contact;
- lifecycle command area and feedback focus;
- notes;
- activity timeline;
- back navigation, loading, not-found, retry, and conflict recovery states.

The shell selects a small type presentation by the parsed `job.type`.

### 17.1 Product Delivery

- Keeps the existing delivery item request and section.
- Keeps Product, purpose, quantity, delivered time, and delivery-specific review text.
- Keeps lifecycle, notes, and timeline behavior.

### 17.2 General Task

Shows:

- `Genel görev` type label;
- title and optional description;
- status, assignee, priority, and optional due date;
- optional Customer and Contact identities;
- valid lifecycle commands for current role and status;
- notes and activity timeline.

It does not call `listDeliveryItems` and does not render a delivery section, Product,
purpose, quantity, delivered time, delivery count, or delivery-specific empty/review text.
The initial detail load first obtains and parses JobCard detail, then requests delivery
items only for `PRODUCT_DELIVERY`. This makes the no-delivery-call contract observable and
testable.

Conflict recovery reloads backend truth and applies the same type-aware request rule.
Success feedback and dialog focus behavior retain the existing accessible lifecycle
contract.

## 18. Accessibility and Responsive Contract

The Slice 09 UI must meet the product-wide WCAG 2.2 AA target:

- every field has a persistent label; placeholder text is not a label;
- required state and errors are conveyed by text and programmatic association, not color;
- keyboard order follows the visual and task order;
- disclosure, selects, links, lifecycle controls, and dialogs are fully keyboard-operable;
- visible focus is preserved after validation errors, cancellation, successful creation,
  lifecycle dialogs, and backend-truth reloads;
- primary touch targets are at least 44×44 CSS px;
- type and status use text in addition to restrained color/shape cues;
- layouts reflow at 390×844 and 320 CSS px effective width without horizontal dependence;
- content remains usable at 200% text enlargement and 400% browser zoom where reflow is
  applicable;
- `prefers-reduced-motion: reduce` removes non-essential transitions;
- loading, success, validation, and server errors use appropriate status or alert
  semantics.

General Task creation and its complete lifecycle must be testable without drag-and-drop.

## 19. Error Contract

Slice 09 reuses existing canonical JobCard errors and adds only the missing type-boundary
code:

| Condition | Response |
| --- | --- |
| invalid/unknown create field, malformed value, invalid date, invalid type | `400 VALIDATION_ERROR` |
| missing/cross-organization visible JobCard | `404 JOB_CARD_NOT_FOUND` |
| malformed `assignedTo` | `400 VALIDATION_ERROR` before assignee lookup |
| missing/cross-organization assignee | `404 ASSIGNEE_NOT_FOUND` |
| inactive/non-Staff assignee | `403 FORBIDDEN` |
| Staff actor supplies an assignee other than self | `403 FORBIDDEN` before assignee lookup |
| missing/cross-organization Customer | `404 CUSTOMER_NOT_FOUND` |
| inactive Customer | `409 CUSTOMER_INACTIVE` |
| missing/cross-organization Contact | `404 CONTACT_NOT_FOUND` |
| Contact belongs to another Customer | `409 CONTACT_NOT_IN_CUSTOMER` |
| inactive Contact | `409 CONTACT_INACTIVE` |
| delivery operation on General Task | `409 INVALID_JOB_TYPE` |
| stale mutation | `409 VERSION_CONFLICT` |
| invalid lifecycle source/role | existing `INVALID_TRANSITION` or `FORBIDDEN` contract |
| processed action still running | existing `ACTION_IN_PROGRESS` contract |

Cross-organization concealment remains identical for Staff and management reads. Failed
create, patch, transition, and delivery operations append no partial activity and leave no
processed successful response.

## 20. Verification Strategy

Implementation follows TDD. Existing Product Delivery tests remain regression gates.

### 20.1 Backend unit and service tests

- exact Product Delivery and General Task create discriminants;
- absent, unknown, and wrong-type discriminants;
- unknown fields and delivery fields rejected on General Task create;
- Unicode-whitespace-only title and title over 255 code points rejected;
- description trim/null behavior, default priority, and strict due date;
- Staff self assignment succeeds for Product Delivery and General Task when
  `assignedTo` equals the authenticated Staff ID;
- Staff request with another identifier returns `403 FORBIDDEN` before assignee lookup
  for both create discriminants;
- malformed assignee returns `400 VALIDATION_ERROR` before lookup;
- Manager/Admin active same-organization Staff assignment;
- missing and cross-organization assignee returns `404 ASSIGNEE_NOT_FOUND`;
- inactive and non-Staff assignee returns `403 FORBIDDEN`;
- optional Customer and Contact validation;
- Contact without Customer, wrong Customer, inactive Contact, and stale Customer response
  paths;
- General Task creation transaction, `JOB_CREATED`, replay, concurrent duplicate, and
  rollback;
- common patch behavior and type immutability;
- Product Delivery submission invariants unchanged;
- General Task submission succeeds without Customer or delivery item;
- General Task submission fails after assignee becomes ineligible;
- exhaustive submission-policy mapping for both JobCard types;
- plan, start, submit, approve, request revision, resume, and cancel;
- role matrix, terminal immutability, stale version, completed replay, concurrent duplicate,
  first-start preservation, and activity rollback;
- organization visibility and concealment.

### 20.2 Delivery boundary tests

For a visible General Task, each of list, add, patch, and delete delivery-item service and
route paths returns exactly `409 INVALID_JOB_TYPE`. Tests prove the type guard happens
before item/Product lookup and mutation and that no version, item, or activity changes.
Product Delivery delivery tests remain unchanged and passing.

### 20.3 Repository, query, report, and PostgreSQL tests

- canonical detail query returns exact assignee, optional Customer, and optional Contact
  projections without cross-organization joins;
- list and board parse and apply both type filters;
- omitted type includes both types;
- repeated, empty, and unknown type query values are rejected;
- General Task list/board `deliveryItemCount` is `0`;
- approval queue includes waiting General Tasks;
- dashboard and Staff all-type metrics include General Tasks;
- delivery quantity reports exclude General Tasks;
- disposable PostgreSQL flow runs migration, seed/auth setup, General Task create, start,
  submit, approve and revision paths, notes, activity, visibility, and report regression;
- no migration is created or applied for Slice 09.

### 20.4 Web parser and client tests

- exact JobCard detail parser accepts both discriminants and rejects malformed relation
  projections;
- create request builders produce exact discriminated bodies;
- workspace API and URL parser accept both type filters and canonicalize invalid values;
- Back, Forward, refresh, and deep link preserve type filter;
- changing filters resets offset;
- General Task rows and cards show textual type and no false delivery presentation;
- Product Delivery presentation remains unchanged.

### 20.5 Web flow and accessibility tests

- `/jobs/new-task` direct route, refresh, cancel, success navigation, auth, and password
  gates;
- Staff self creation without Staff-list request;
- Manager/Admin Staff loading, selection, failure, and retry;
- optional Customer disclosure, Contact dependency, clearing, stale-response protection,
  and context-free submit after CRM failure;
- pending lock, stable retry action ID, error focus, and value preservation;
- General Task detail makes zero delivery-item requests on initial load and truth reload;
- Product Delivery detail still makes its delivery request;
- type-aware heading, summary, lifecycle actions, notes, and timeline;
- keyboard-only create-to-submit flow and lifecycle commands;
- visible focus, dialog focus, 44×44 targets, semantic feedback, and color-independent type;
- responsive checks at 390×844 and 320 CSS px effective width;
- 200% text enlargement, reduced motion, and applicable 400% reflow.

### 20.6 Required verification commands

At implementation closeout, run and record at minimum:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
cd web && npm test -- --run
```

Run server and web lint/audit commands already owned by the repository, the disposable
PostgreSQL suite with `TEST_DATABASE_URL`, and browser checks for the critical mobile and
keyboard flows. A command not run must be recorded as not run.

## 21. Compatibility and Rollout

There is no schema rollout. Server and web changes ship together because the current web
detail parser accepts only Product Delivery while the server will begin returning General
Task records through shared workspace routes.

Compatibility rules:

- Product Delivery create input and behavior remain valid;
- Product Delivery detail retains all existing raw fields and gains relation projections;
- existing delivery endpoints and item shapes do not change for Product Delivery;
- list and board shapes remain stable; only the already-declared second type becomes
  reachable and its count is correctly zero;
- report response shapes do not change;
- no feature flag, dual write, backfill, or compatibility fallback is required.

After code and tests are verified, closeout updates the API contract, architecture plan,
MVP slice status, decisions/index references, README verification evidence, and Codebase
Memory. The schema draft does not change because Slice 09 adds no schema behavior.
Documentation must not claim Slice 09 is implemented before that closeout.

## 22. Acceptance Criteria

Slice 09 implementation is complete only when all statements below are true:

- [ ] One exact `POST /api/job-cards` discriminated union supports Product Delivery and
      General Task.
- [ ] Staff create requires `assignedTo` to equal the authenticated Staff ID and rejects a
      different ID with pre-lookup `403 FORBIDDEN`; management accepts only eligible
      same-organization Staff.
- [ ] General Task supports optional Customer and Contact with the canonical relation
      invariants.
- [ ] A title-only General Task with an eligible assignee can complete manager approval.
- [ ] Submission readiness is selected by an exhaustive type policy while lifecycle
      execution remains shared.
- [ ] All four delivery subresource operations return `409 INVALID_JOB_TYPE` for General
      Task and perform no partial work.
- [ ] Canonical detail provides assignee, Customer, and Contact display identities in one
      organization-scoped read.
- [ ] `/jobs/new-task` is refresh-safe, accessible, responsive, and separate from Product
      Delivery creation.
- [ ] General Task detail never requests or renders delivery data.
- [ ] List, board, and URL-owned type filters support both types without false delivery
      presentation.
- [ ] Approval, Staff, and all-type operational metrics include General Tasks; delivery
      metrics exclude them.
- [ ] Existing Product Delivery behavior and tests remain passing.
- [ ] No migration, new details model, generic form builder, or out-of-scope feature is
      introduced.
- [ ] Server, web, PostgreSQL, browser, accessibility, and documentation closeout evidence
      is recorded truthfully.

## 23. Alternatives Considered

### 23.1 One polymorphic `/jobs/new?type=` form

Rejected for Slice 09. It would mix structured Product Delivery requirements with a short
General Task form, increase conditional validation and focus complexity, and encourage a
generic form-builder abstraction before Sales Meeting requirements exist.

### 23.2 Workspace drawer or sheet

Rejected for Slice 09. It provides a fast entry point but makes mobile space, focus return,
deep-link/refresh behavior, and future field growth harder to guarantee. A stable page is
more testable and does not prevent a later shortcut to the same route.

### 23.3 Separate General Task endpoint or table

Rejected. General Task is a JobCard type and already shares persistence, permissions,
lifecycle, notes, activity, workspace, approval, and reports. A separate endpoint or table
would duplicate the core domain and create divergent invariants.

### 23.4 Embed delivery items in a polymorphic detail response

Rejected. Delivery items remain an existing Product Delivery subresource. Embedding an
empty or nullable delivery shape in every General Task would weaken the type boundary and
encourage false delivery UI.

## 24. Design Self-Review

- [x] The create body is an exact discriminated union with no unknown-field escape hatch.
- [x] Required, nullable, defaulted, normalized, and role-derived fields are explicit.
- [x] Title-only General Task submission is explicitly allowed.
- [x] Staff self-assignment uses equality plus a pre-lookup `403 FORBIDDEN`, not silent
      identifier replacement.
- [x] Malformed, missing, cross-organization, inactive, and non-Staff assignee failures
      have exact responses.
- [x] Assignment, Customer, Contact, organization, and concealment rules are explicit.
- [x] Product Delivery create and submission behavior is unchanged.
- [x] Submission readiness has one exhaustive type-owned policy boundary.
- [x] Lifecycle, idempotency, versioning, activity, notes, and rollback remain shared.
- [x] Every delivery operation has the same General Task type guard and error.
- [x] Detail identity composition is backend-owned and does not require frontend joins.
- [x] Product Delivery response compatibility is additive and explicit.
- [x] General Task detail performs no delivery request or delivery presentation.
- [x] List, board, API query, and URL type filters accept both canonical values.
- [x] All-type operational metrics and delivery-only metrics are not mixed.
- [x] Mobile, keyboard, focus, target size, zoom, motion, and semantic requirements are
      explicit.
- [x] No migration, report storage, financial, inventory, score, custom JSON, checklist,
      attachment, subtask, notification, realtime, or Sales Meeting scope was introduced.
- [x] No implementation claim is made for Slice 09.
- [x] No placeholder or unresolved behavior remains.

## 25. Execution Stop

This document is a proposed design awaiting user approval. Slice 09 implementation has
not started. The next step is user review of this committed specification. Only after
explicit spec approval may `superpowers:writing-plans` be used to create a separate
implementation plan. That plan also requires review before implementation begins.
