# Servora-Med API Draft

> **Authority scope:** retained baseline HTTP contract with accepted amendments.
> Read it with the latest applicable [DECISIONS.md](DECISIONS.md) records and
> approved [feature contracts](docs/features/). Its slice-era endpoint coverage
> is not an exhaustive inventory of the current API; verify registration in the
> current source before claiming an endpoint is shipped. Report policy/code
> disagreements through [AGENTS.md §15](AGENTS.md#15-document-authority-and-reading-map).

> Date: 2026-07-10  
> Status: Living API contract; implemented and verified through Slice 11 Production Deployment and U3 User/Staff lifecycle reconciliation
> Responsibility: HTTP contract, authorization behavior, command semantics, and error model SSOT

## 1. General Contract

### Base

- Prefix: `/api`
- JSON: camelCase
- Database mapping: snake_case in module `types.ts`
- Default content type: `application/json`
- Organization identity: authenticated session only
- Date-time values: ISO 8601 with offset or `Z`

### Authentication cookie

Successful login sets a high-entropy opaque token in a cookie:

```text
HttpOnly
Secure in production
SameSite=Lax
Path=/
explicit Max-Age or Expires
```

Only the token hash is persisted. Login JSON does not return the token. Frontend requests use browser credentials.

### CSRF and CORS posture

- Production allows one configured web origin with credentials.
- Unsafe methods (`POST`, `PATCH`, `PUT`, `DELETE`) require an `Origin` matching the configured web origin.
- Production rejects a missing or mismatched `Origin` on unsafe browser requests.
- Mutation bodies use `application/json`; simple cross-site form payloads are not accepted.
- `SameSite=Lax` is defense in depth, not the only origin check.
- If later deployment requires multiple origins or cross-site embedding, CSRF design is revisited before enabling it.

### Pagination

Request:

```text
?limit=50&offset=0
```

Response:

```json
{
  "items": [],
  "total": 0,
  "limit": 50,
  "offset": 0
}
```

Default limit is 50; maximum is 200.

### Error shape

```json
{
  "error": "Kullanıcıya yönelik Türkçe açıklama",
  "code": "VALIDATION_ERROR",
  "details": null
}
```

Canonical codes:

```text
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
VALIDATION_ERROR
CONFLICT
ACTION_IN_PROGRESS
INVALID_TRANSITION
INVARIANT_VIOLATION
FOLLOW_UP_CANCEL_DECISION_REQUIRED
FOLLOW_UP_CANCEL_DECISION_INVALID
FOLLOW_UP_RESCHEDULE_IN_PAST
VERSION_CONFLICT
EMAIL_ALREADY_EXISTS
STAFF_PROFILE_REQUIRED
STAFF_PROFILE_NOT_ALLOWED
STAFF_PROFILE_NOT_FOUND
MANAGER_NOT_ELIGIBLE
STAFF_ROLE_CHANGE_NOT_SUPPORTED
USER_HAS_ACTIVE_JOB_CARDS
MANAGER_HAS_ASSIGNED_STAFF
SELF_ROLE_CHANGE_FORBIDDEN
SELF_DEACTIVATION_FORBIDDEN
LAST_ACTIVE_ADMIN_REQUIRED
USER_VERSION_CONFLICT
STAFF_PROFILE_VERSION_CONFLICT
USER_NOT_FOUND
USER_PERMANENT_DELETE_BLOCKED
SELF_DELETE_FORBIDDEN
DEMO_USER_DELETE_FORBIDDEN
OFFBOARDING_REQUIRED
OFFBOARDED_STAFF_REACTIVATION_FORBIDDEN
OFFBOARDING_UNAVAILABLE
OFFBOARDING_TARGET_NOT_STAFF
OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW
OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION
WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE
USER_ALREADY_INACTIVE
INVALID_REPLACEMENT_STAFF
CALENDAR_CONFLICT
STALE_PLAN
CLIENT_ACTION_REUSED
PASSWORD_CHANGE_REQUIRED
CUSTOMER_NOT_FOUND
CONTACT_NOT_FOUND
CUSTOMER_TAX_NUMBER_EXISTS
CUSTOMER_HAS_ACTIVE_JOB_CARDS
CONTACT_HAS_ACTIVE_JOB_CARDS
CUSTOMER_INACTIVE
INVALID_CUSTOMER_STATUS_TRANSITION
INVALID_CONTACT_STATUS_TRANSITION
CONTACT_PRIMARY_REQUIRES_ACTIVE
CONTACT_ALREADY_PRIMARY
CUSTOMER_ASSIGNEE_NOT_ELIGIBLE
ASSIGNEE_NOT_FOUND
ASSIGNEE_NOT_ELIGIBLE
INVALID_JOB_TYPE
JOB_CARD_NOT_FOUND
JOB_NOT_EDITABLE
MEETING_NOT_READY
```

Validation details may identify fields but must not expose SQL, stack traces, hashes, tokens, cookies, or internal infrastructure.

## 2. Idempotency Contract

Critical business commands include `clientActionId` in their JSON body:

- JobCard creation
- delivery-item creation
- JobCard note addition
- every named JobCard lifecycle command

Rules:

- trimmed string, 1 to 255 characters
- scoped by organization, user, operation, and action identifier
- atomic processing claim before business side effects
- completed duplicate returns the original status and response body
- concurrent duplicate returns `409 ACTION_IN_PROGRESS`
- a transaction rolled back by PostgreSQL deadlock (`40P01`) or serialization failure (`40001`) also returns `409 ACTION_IN_PROGRESS`; no receipt remains, so the identical request may be retried; a failing `ROLLBACK` never replaces the original error and the broken connection is not returned to the pool
- a failed command may return its recorded failure according to the processed-action policy

Ordinary profile, customer, contact, product, and field updates do not use full processed-response caching by default. Their validation, authorization, database constraints, and applicable version checks still apply.

## 3. JobCard Concurrency Contract

Every JobCard DTO contains `version`.

These requests require `expectedVersion`:

- JobCard field patch
- delivery-item add, patch, and removal
- every named lifecycle command

The service updates with a version predicate and increments atomically. A stale request returns:

```http
HTTP/1.1 409 Conflict
```

```json
{
  "error": "İş kartı başka bir kullanıcı tarafından güncellendi. Güncel veriyi yükleyip tekrar deneyin.",
  "code": "VERSION_CONFLICT",
  "details": {
    "currentVersion": 8
  }
}
```

No partial mutation or activity event is written on version conflict.

## 4. Auth `/api/auth`

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| POST | `/login` | public | email/password; rate limited; sets session cookie |
| POST | `/logout` | session | revokes session and clears cookie |
| GET | `/me` | session | current safe user identity |
| POST | `/change-password` | session | validates current password and changes hash |

### Mandatory password change guard

After session authentication, requests from a user whose `mustChangePassword` value is `true` return `403 PASSWORD_CHANGE_REQUIRED` before domain authorization or handler execution. Only these endpoints remain available:

- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `POST /api/auth/logout`

A successful password change clears the mandatory-change flag, revokes every session including the current one, clears the current cookie, and requires a new login.

### POST `/api/auth/login`

Request:

```json
{
  "email": "staff@demo.local",
  "password": "user-supplied-secret"
}
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "name": "Ayşe Yılmaz",
    "email": "staff@demo.local",
    "role": "staff",
    "organizationId": "uuid",
    "mustChangePassword": false
  },
  "staffProfile": {
    "id": "uuid",
    "title": "Saha Uzmanı",
    "region": "İstanbul Avrupa"
  }
}
```

Email comparison is case-insensitive. Failure returns a generic `401 UNAUTHORIZED` message. The response never reveals whether the email exists.

### POST `/api/auth/logout`

Logout is safe to repeat. It revokes the current session when present and clears the cookie.

## 5. Users `/api/users`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/` | admin | safe organization user list |
| POST | `/` | admin | create user and required or forbidden Staff profile according to role |
| GET | `/:userId` | admin | safe organization user detail |
| DELETE | `/:userId` | admin | permanently delete an eligible pristine BUSINESS user; returns `204` |
| PATCH | `/:userId` | admin | update only `name` |
| POST | `/:userId/change-role` | admin | apply an allowed Admin/Manager role command |
| POST | `/:userId/activate` | admin | activate an eligible user |
| POST | `/:userId/deactivate` | admin | deactivate an eligible user and revoke all sessions |
| POST | `/:userId/reset-password` | admin | set an Admin-provided temporary password and revoke all sessions |
| POST | `/:userId/offboarding/preview` | admin | return the current Staff responsibility plan |
| GET | `/:userId/offboarding/weekly-report-blockers` | admin | read a bounded metadata page of unresolved WeeklyReport blockers |
| POST | `/:userId/offboarding/execute` | admin | apply an exact, idempotent Staff offboarding plan |

Staff reads their identity through `/api/auth/me` and profile through `/api/staff/me`.

Safe user responses include `id`, `organizationId`, `name`, normalized `email`, `role`, `isActive`, `mustChangePassword`, `lastLoginAt`, `version`, `createdAt`, and `updatedAt`. `GET /api/users/:userId` additionally returns the server-derived `canPermanentlyDelete` boolean and `permanentDeleteBlockers` array. Password hashes, temporary passwords, tokens, cookies, and session data are never returned.

PATCH and the ordinary named user commands require `expectedVersion`, perform an atomic version-predicate update, and increment `version`. A stale mutation returns `409 USER_VERSION_CONFLICT`. Named commands accept only the fields required for that command; role and activation changes cannot be combined with a general patch. `DELETE /api/users/:userId` accepts an optional body containing only `expectedVersion` and returns `204` on success.

Permanent deletion is Admin-only and succeeds only for a pristine `BUSINESS` user with no meaningful business or operational history and no blocking active responsibilities. The server computes `permanentDeleteBlockers` from `SELF`, `LAST_ADMIN`, `HAS_BUSINESS_HISTORY`, `HAS_ACTIVE_RESPONSIBILITIES`, and `DEMO_USER`; the UI must not infer eligibility. Self-delete, deletion of the last active Admin, Demo-user deletion, and deletion with business blockers return their corresponding `409` error codes, including `USER_PERMANENT_DELETE_BLOCKED` where applicable. Technical login/session history alone does not create a business-history blocker. A successful deletion writes the `USER_DELETED` audit event with `metadata.deletionMode=PERMANENT` and returns no user payload.

Role changes to or from `STAFF` are rejected with `STAFF_ROLE_CHANGE_NOT_SUPPORTED`. An Admin cannot change their own role or deactivate their own account. Generic deactivation of a Staff user returns `409 OFFBOARDING_REQUIRED`; history-bearing Staff users must use the dedicated offboarding flow. Activating an inactive (offboarded) Staff user returns `409 OFFBOARDED_STAFF_REACTIVATION_FORBIDDEN`; Admin and Manager users can still be reactivated. Offboarding revokes the target's sessions, resolves explicitly planned jobs, customers, calendar assignments, follow-ups, and reminders, deactivates the Staff user, preserves historical attribution, and appends `USER_OFFBOARDED`.

`POST /api/users/:userId/offboarding/preview` is Admin-only and accepts `{}`. It returns the current plan and its `planHash`. The Admin then submits that exact plan to the idempotent, serializable execute command:

```json
{
  "clientActionId": "<operator-action-id>",
  "planHash": "<sha256>",
  "reasonCode": "ACCESS_ENDED",
  "jobDecisions": [{ "jobCardId": "<uuid>", "replacementUserId": "<staff-uuid>" }],
  "calendarDecisions": [{ "calendarEventId": "<uuid>", "replacementUserId": "<staff-uuid>" }],
  "followUpDecisions": [{ "jobCardId": "<uuid>", "replacementUserId": "<staff-uuid>" }],
  "customerDecisions": [{ "customerId": "<uuid>", "action": "REASSIGN", "replacementUserId": "<staff-uuid>" }],
  "reminderDecisions": [{ "reminderId": "<uuid>", "action": "TRANSFER", "replacementUserId": "<staff-uuid>" }]
}
```

Terminal JobCards are never mutable offboarding responsibilities. If a `COMPLETED`, `CANCELLED`, or `INVALIDATED` card retains a future follow-up proposal assigned to the target Staff, both preview and fresh execute validation return `409 OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW`. The operation makes no partial transfers, session revocations, user deactivation or durable receipt/audit changes. A linked child alone does not prove that the persisted proposal has been resolved; this case requires separate explicit domain review, not a rewrite of historical assignment or proposal fields. See [SOF-1 terminal integrity](docs/features/staff-offboarding-terminal-integrity.md).

Unfinished WeeklyReports linked through either root assignee or original report
owner block preview/fresh execute as `409 OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION`.
SOF-1 keeps priority. `details.weeklyReports` returns the complete `total`,
`limit: 50`, `hasMore` and deterministic metadata-only `items`; missing report
rows, ownership mismatches and attached-report/root-type inconsistencies fail
closed. A completed original intent still replays its receipt. Actual ordinary
WeeklyReport reassignment is rejected at the locked PATCH boundary as
`409 WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE`. Same-value PATCH retains existing
version/update semantics without assignment history or acceptance reset. See
[SOF-2 ownership and detail fields](docs/features/staff-offboarding-weekly-report-ownership.md).

The SOF-2C metadata continuation accepts `limit=1..50` (default 50), and an
exclusive `afterJobCardId=<uuid>&afterPeriodStart=<YYYY-MM-DD|null>` cursor.
Both cursor fields are required together. It rechecks active Admin and target
Staff in the same organization and returns the 409's `weeklyReports` shape in
a read-only response. Each page has a consistent total; clients must refresh
the authoritative offboarding preview after any resolution or changed page.
No draft or historical submission content is returned.

SOF-2B WeeklyReport draft/cancellation contract:

- Draft PATCH retains complete replacement and the WeeklyReport's own
  `expectedVersion`; it is not the JobCard version. One transaction locks the
  current Staff user (`FOR SHARE`), root (`FOR UPDATE`) and report (`FOR UPDATE`),
  validates tenant, active STAFF role, assignee/original owner and
  ACCEPTED/IN_PROGRESS status, then writes through that same client.
- A non-editable current status returns `409 WEEKLY_REPORT_DRAFT_LOCKED` before
  UPDATE; stale/future report versions return `409 VERSION_CONFLICT`. Unauthorized
  authors remain 403, inaccessible/missing reports 404. No draft-only lifecycle
  activity or processed-action receipt is introduced.
- STAFF WEEKLY_REPORT CANCEL is absent from canonical `workflowContext.allowedCommands`
  and rejected by reservation preflight and locked finalize as
  `409 INVALID_TRANSITION`. Existing reasoned MANAGER/ADMIN cancellation remains;
  non-weekly permissions are unchanged. Exact completed historical scoped intent
  receipts replay before fresh authorization; different intent hashes still fail.
- Frozen submission/PDF content and owner attribution are preserved. No new
  endpoint, migration, replacement flow or OF-09 recovery behavior is introduced.

`reasonCode` is one of `ACCESS_ENDED`, `ROLE_CHANGED`, `ACCOUNT_CORRECTION`, or `OTHER_ADMINISTRATIVE`; replacement users must be active Staff in the same organization. A changed plan returns `409 STALE_PLAN`; reusing a `clientActionId` for different input returns `409 CLIENT_ACTION_REUSED`. The response is `{ status: "OFFBOARDED", targetUserId, planHash, summary }`.


## 6. Staff `/api/staff`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/` | admin, manager | organization Staff list with role-aware status filtering |
| GET | `/me` | staff | own profile and counters |
| GET | `/:userId` | admin, manager | organization-scoped profile and operational summary |
| PATCH | `/:userId` | admin, manager | update title, phone, region, and manager |

Staff cannot use the ID routes or edit profiles in this slice. No `notes` or undefined monthly-target field is accepted.

`GET /api/staff` defaults to `status=active`. Admin may request `status=active`, `status=inactive`, or `status=all`; Manager may request only `status=active`. Inactive Staff remain resolvable where historical JobCard records need their persisted identity.

Staff profile responses include backend-derived counters:

```json
{
  "counters": {
    "open": 0,
    "waitingApproval": 0,
    "revisionRequested": 0,
    "completedThisMonth": 0,
    "overdue": 0
  }
}
```

- `open`: assigned JobCards in `NEW`, `ACCEPTED`, or `IN_PROGRESS`
- `waitingApproval`: assigned JobCards in `WAITING_APPROVAL`
- `revisionRequested`: assigned JobCards in `REVISION_REQUESTED`
- `completedThisMonth`: assigned JobCards approved into `COMPLETED` during the current organization-local calendar month
- `overdue`: assigned JobCards whose `dueDate` is before the organization-local current date and whose status is neither `COMPLETED` nor `CANCELLED`

`CANCELLED` contributes to no counter. An overdue card may also contribute to a lifecycle counter. The backend calculates timezone boundaries; the frontend does not derive these values.

`PATCH /api/staff/:userId` requires `expectedVersion`, increments the profile `version` atomically, and returns `409 STAFF_PROFILE_VERSION_CONFLICT` when stale. A supplied manager must be an active Manager in the same organization.

## 7. Customers `/api/customers`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/` | authenticated | list/search; staff read organization records |
| POST | `/` | admin, manager | create |
| GET | `/:customerId` | authenticated | detail and contact summary |
| PATCH | `/:customerId` | admin, manager | update |
| POST | `/:customerId/activate` | admin, manager | named activation command |
| POST | `/:customerId/deactivate` | admin, manager | named deactivation command |
| GET | `/:customerId/contacts` | authenticated | nested Contact list |
| POST | `/:customerId/contacts` | admin, manager | create nested Contact |
| GET | `/:customerId/contacts/:contactId` | authenticated | nested Contact detail |
| PATCH | `/:customerId/contacts/:contactId` | admin, manager | update nested Contact |
| POST | `/:customerId/contacts/:contactId/activate` | admin, manager | named activation command |
| POST | `/:customerId/contacts/:contactId/deactivate` | admin, manager | named deactivation command |
| POST | `/:customerId/contacts/:contactId/make-primary` | admin, manager | select the active primary Contact |

Filters:

```text
q
status
customerType
assignedStaffUserId
city
unassigned
limit
offset
```

`limit` defaults to 50 and must be between 1 and 200; `offset` defaults to 0 and must
be a non-negative integer. Unknown query parameters are rejected.

When `status` is omitted, the list includes `prospect` and `active` Customers and hides
`inactive` records. `status=inactive` exposes inactive records explicitly.

Customer lifecycle uses the `prospect`, `active`, and `inactive` state machine. Activation
is permitted only from `inactive`; deactivation is permitted from `prospect` or `active`.
The API does not expose a duplicate active flag. Lifecycle commands and
patches require a positive integer `expectedVersion`; successful mutations increment
`version`, while stale requests return `409 VERSION_CONFLICT` with `currentVersion`.
Customers with active JobCards cannot be deactivated. Customer mutation bodies use
an exact allowlist and never accept or return a `notes` field.

Customer detail includes at most five open and five completed JobCard summaries. Staff
receives only summaries for JobCards assigned to that Staff user; Manager and Admin
receive organization-scoped summaries. The CRM detail response does not expose an audit
timeline or Staff-confidential profile notes.

`assignedStaffUserId` accepts only `null` or a non-empty string. The referenced user
must be an active Staff user in the same organization; a missing, inactive,
cross-organization, or non-Staff user returns `409 CUSTOMER_ASSIGNEE_NOT_ELIGIBLE`.

## 8. Contacts `/api/customers/:customerId/contacts`

Contacts are always addressed beneath their parent Customer; there is no top-level
`/api/contacts` collection. `contactId` is valid only together with the path's
`customerId`. Reads are organization-scoped and cross-organization parents or records
are concealed with `404 CUSTOMER_NOT_FOUND` or `404 CONTACT_NOT_FOUND`.

List filters are `q`, `status=active|inactive|all`, `limit`, and `offset`; status defaults
to `active`, and the same pagination bounds as Customers apply. Contact active state is
changed only through the named `activate` and `deactivate` commands. A deactivated
Contact is never primary, cannot be made primary, and cannot be deactivated while an
active JobCard references it. Creating the first active Contact makes it primary;
reactivation does not. `make-primary` atomically clears the previous primary Contact.

Contact patches and all named commands require a positive integer `expectedVersion`.
Successful mutations increment `version`; stale requests return `409 VERSION_CONFLICT`.
Mutation bodies use exact allowlists and never accept or return a `notes` field. Staff
may read Customers and Contacts but every CRM mutation returns `403 FORBIDDEN`.

Customer assignment and Contact/JobCard eligibility mutations use the shared lock order
`users -> customers -> contacts -> job_cards`, with stable UUID order when more than one
row of the same type is locked. A JobCard Contact must be active, in the authenticated
organization, and belong to the selected Customer. Changing Customer without supplying
a compatible Contact clears `contactId`.

## 9. Products `/api/products`

Slice 06 implemented and verified this canonical contract.

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/` | authenticated | paginated catalog search; Staff read-only |
| POST | `/` | admin, manager | create active Product; no expected version |
| GET | `/:productId` | authenticated | organization-scoped detail |
| PATCH | `/:productId` | admin, manager | exact field allowlist; requires expected version |
| POST | `/:productId/activate` | admin, manager | named lifecycle command; requires expected version |
| POST | `/:productId/deactivate` | admin, manager | named lifecycle command; requires expected version |

Filters:

```text
q
status=active|inactive|all
limit
offset
```

Defaults are `status=active`, `limit=50`, and `offset=0`. `limit` is between 1 and
200, `offset` is non-negative, and unknown query parameters are rejected. Search covers
name, SKU, brand, category, and model. The response uses
`{ items, total, limit, offset }` so Product selectors do not silently truncate catalogs
above a fixed first page.

Only non-empty `name` is required. `sku`, `brand`, `category`, `model`, `unit`, and
`referencePrice` are nullable informational fields. Empty optional text maps to `null`.
SKU casing and punctuation are preserved, and duplicate SKU values are allowed.
`name` is limited to 255 characters; `sku`, `brand`, `category`, and `model` to 100;
and `unit` to 30. `referencePrice` is null or between `0` and `9999999999.99` and has
no currency, sales, invoice, accounting, or stock-valuation meaning. Field-level
validation failures return `VALIDATION_ERROR` with `details.fieldErrors`.

Create accepts only the Product fields and does not accept `expectedVersion`. Patch
accepts `expectedVersion` plus Product fields and rejects `isActive`, `status`, `version`,
`organizationId`, stock, cost, currency, and tracking-policy fields. There is no physical
delete or Product `DELETE` endpoint.

Patch and lifecycle commands compare `expectedVersion` atomically. Stale mutations return
`409 VERSION_CONFLICT`; repeated lifecycle commands return
`409 INVALID_PRODUCT_STATUS_TRANSITION`. Missing and cross-organization records return
the same `404 PRODUCT_NOT_FOUND`. Malformed Product UUID path values are concealed with
that same response before reaching PostgreSQL. Failed mutations create no partial write
or audit.

Deactivation prevents new delivery selection and Product replacement only. Existing
delivery rows and snapshots remain unchanged. Quantity or note may still be edited when
the existing delivery item's `productId` is not replaced. A supplied replacement Product
must be active, belong to the authenticated organization and be eligible for the
job's data class: a BUSINESS delivery accepts only BUSINESS products, a DEMO
delivery also accepts a DEMO product from its own dataset (DELIVERY-QTY-001).

Web clients use this endpoint as the canonical Product catalog source. JobCard backend
transactions use a transaction-scoped Product read and never call the Product HTTP API.
The legacy `GET /api/reference/products` endpoint has been removed; Customer reference
loading remains separate.

Product audit events are `PRODUCT_CREATED`, `PRODUCT_FIELDS_UPDATED`,
`PRODUCT_ACTIVATED`, and `PRODUCT_DEACTIVATED`. Audit stores safe identifiers and changed
field names, not complete Product payloads or financial history.

There are no stock, warehouse, costing, price-history, currency, barcode, or
tracking-requirement endpoints in MVP.

## 10. JobCards `/api/job-cards`

### Visibility

| Resource | Staff | Manager and admin |
| --- | --- | --- |
| JobCard list | assigned to self | all organization records |
| JobCard detail | assigned to self | all organization records |
| Delivery items | visible JobCard | visible JobCard |
| Notes and activity | visible JobCard | visible JobCard |
| Approval commands | forbidden | allowed by transition rules |

Staff-provided `assignedTo` filters never broaden server-enforced self scope.

### CRUD and list

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/` | authenticated | scoped list with filters |
| POST | `/` | authenticated | idempotent JobCard creation |
| GET | `/:jobCardId` | visibility | detail with optional related sections |
| PATCH | `/:jobCardId` | edit policy | fields only; requires expected version |
| GET | `/board` | authenticated | read-only active-state projection plus closed counts |

List filters:

```text
status
type
assignedTo
customerId
priority
dueBefore
dueAfter
overdue
q
limit
offset
```

`type` accepts exactly `PRODUCT_DELIVERY`, `GENERAL_TASK`, or `SALES_MEETING`. Repeated scalar filters,
unknown values, and unknown query keys return `400 VALIDATION_ERROR`.

`overdue=true` is a server-owned filter: the backend resolves the authoritative request
time through the organization timezone and applies `status IN (active statuses)` with
`due_date IS NOT NULL` and `due_date < (requestTime AT TIME ZONE organization.timezone)::date`.
Clients never compute the overdue boundary. `overdue=true` may be combined with an omitted
or `active` status only; any other status or a `dueBefore`/`dueAfter` combination returns
`400 VALIDATION_ERROR`. `overdue=false`, malformed values, and repeated parameters are
rejected. The board projection does not accept `overdue`.

The list response is canonical and paginated. Board cards reuse the same item shape,
group only `NEW`, `ACCEPTED`, `IN_PROGRESS`, `WAITING_APPROVAL`, and
`REVISION_REQUESTED`, and expose `COMPLETED`/`CANCELLED` as counts. Mobile clients use
the list route and do not request the board projection. Status filter values follow active
statuses plus `active` / `closed` / `all`; `PLANNED` is rejected as an unknown filter.

### POST `/api/job-cards`

The request body is one exact discriminated union:

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
  scheduledAt: string
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
  scheduledAt?: string | null
}

type SalesMeetingCreateInput = {
  clientActionId: string
  type: 'SALES_MEETING'
  title: string
  description?: string | null
  customerId: string
  contactId?: string | null
  assignedTo: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  dueDate: string
  scheduledAt: string
}

type JobCardCreateInput =
  | ProductDeliveryCreateInput
  | GeneralTaskCreateInput
  | SalesMeetingCreateInput
```

Unknown fields and delivery-item fields are rejected. Product Delivery requires a Customer
and a non-null `scheduledAt` (planned delivery instant). General Task permits nullable
Customer/Contact context and optional `scheduledAt`. Sales Meeting requires an active
Customer, organization-local planned calendar day in `dueDate`, and non-null
`scheduledAt` (planned meeting instant). Instants require an explicit offset or `Z`.
A non-null Contact requires an active same-organization Customer and must belong to it.

Create status:

| Actor and assignee | Initial status |
| --- | --- |
| Staff self-assigned | `ACCEPTED` with `acceptedAt` / `acceptedBy` set to the actor |
| Manager/Admin assigned to Staff | `NEW` without acceptance facts |

Web create forms pre-fill `scheduledAt` with a local default of now + 60 minutes rounded
up to the next 30-minute boundary. The default is applied only on initial form state;
retries and validation errors must not overwrite a user-edited value. Create never
populates delivery-item `deliveredAt` from that planned default.

Create and patch assignee resolution is shared by all three variants:

| Input and actor | Response |
| --- | --- |
| malformed `assignedTo` | `400 VALIDATION_ERROR` before lookup |
| Staff sends an ID other than their own | `403 FORBIDDEN` before lookup |
| missing or cross-organization assignee | `404 ASSIGNEE_NOT_FOUND` |
| inactive or non-Staff assignee | `403 FORBIDDEN` |

The Staff web form sends the authenticated Staff ID and renders no assignee selector.
Manager and Admin select an active same-organization Staff user.

At submit readiness, a persisted assignee that is no longer an active,
same-organization Staff user returns `400 ASSIGNEE_NOT_ELIGIBLE`. This existing Product
Delivery behavior is shared by all canonical JobCard types.

Response creates `JOB_CREATED` with the initial assignee in event metadata. Initial assignment does not create a second activity row.

### PATCH `/api/job-cards/:jobCardId`

Request:

```json
{
  "expectedVersion": 3,
  "title": "ABC Klinik ürün ve numune teslimi",
  "priority": "urgent",
  "dueDate": "2026-07-16",
  "scheduledAt": "2026-07-16T14:30:00+03:00"
}
```

Allowed only in `NEW`, `ACCEPTED`, `IN_PROGRESS`, and `REVISION_REQUESTED` according to
role and assignment. Status is not accepted as a free field. `WAITING_APPROVAL` rejects an
in-place patch; the UI first invokes the named withdrawal command and then patches the
resulting `IN_PROGRESS` card. `COMPLETED` and `CANCELLED` reject field patches.

`assignedTo` and `scheduledAt` may change only while status is `NEW` or `ACCEPTED`. After
`START`, both are rejected with `409 JOB_NOT_EDITABLE`.

Acceptance invalidation (same transaction as the field update):

- Management reassignment of an `ACCEPTED` job returns status to `NEW` and clears
  `acceptedAt` / `acceptedBy`.
- Management schedule change of an `ACCEPTED` job does the same.
- Staff schedule edit does not clear their own acceptance.
- Reassignment of a `NEW` job keeps status `NEW`.

When `assignedTo` changes, the successful patch appends `JOB_ASSIGNED`. Other meaningful
field changes append `JOB_FIELDS_UPDATED` with bounded old/new values. A patch that changes
assignment and other fields may append both canonical events in the same transaction
because they represent different business facts.

The patch samples its business instant **after** it holds the user locks and the JobCard
`FOR UPDATE` lock (OVR-5 §4.0), not before the transaction. That single instant drives
time validation, the appended schedule revision's `created_at`, the pre-mutation and
post-revision MUTATION producers, the deadline-extension boundary comparison and the
change-request `resolved_at`. A patch that waited behind another transaction is judged at
the moment it actually applies.

### PATCH deadline extension and change-request resolution (OVR-5b)

Two optional request keys carry the OVR-5 write intent. They are request intent, never
JobCard columns:

```ts
type PatchDeadlineExtensionInput = {
  expectedVersion: number
  // ...ordinary editable fields
  /** Required when the change ends at least one open deadline obligation. */
  deadlineExtensionReason?: string
  /** Resolves the job's OPEN change request atomically with a deadline move. */
  changeRequestResolution?: {
    changeRequestId: string
    resolution: 'RESCHEDULED'
    note?: string | null
  }
}
```

- `deadlineExtensionReason` is validated whenever it is sent: a non-string or more than
  500 trimmed characters is `400 VALIDATION_ERROR` with
  `fieldErrors.deadlineExtensionReason`. A blank string means "no reason". A reason sent
  when nothing ends is ignored and never stored.
- **Staff may not move a late deadline.** A STAFF patch that changes `dueDate`,
  `scheduledAt` or `scheduledEndsAt` on a job with an open `LATE_START` or
  `LATE_SUBMISSION` incident returns `409 DEADLINE_CHANGE_REQUIRES_MANAGEMENT`
  ("Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi
  gönderin.") and writes nothing. The rule runs after the existing `SALE` /
  `WEEKLY_REPORT` / JOB-010 `CUSTOMER_TIME_MANAGEMENT_ONLY` / `JOB_NOT_EDITABLE` guards
  and after the pre-mutation incident materialization, so its precedence is exact and a
  breach the scanner has not ticked yet still rolls back. A STAFF patch that sends
  `changeRequestResolution` is `400 VALIDATION_ERROR` with
  `fieldErrors.changeRequestResolution`.
- **Removing a governing deadline is refused (management).** A MANAGER/ADMIN patch that
  would make the first-late boundary of an open obligation `NULL` (for example
  `dueDate: null` on a General Task whose deadline is its due date) returns
  `409 OPEN_LATENESS_DEADLINE_REQUIRED` ("Gecikmesi açık işin son tarihi kaldırılamaz;
  ileri bir tarih seçin.") and writes nothing. Removing a field that is not the open
  obligation's governing deadline is allowed and ends nothing.
- **An extension ends the obligation.** A MANAGER/ADMIN patch that appends a schedule
  revision ends every still-open row of an affected `(job, delayType, episodeNo)` in the
  same transaction when the new first-late boundary is after the patch instant: the
  current `LATE_SUBMISSION` episode (with its `correctionDueAt` included) and `LATE_START`
  episode 1, in any status including `NEW`. Those rows receive `endedAt`, `endedBy`,
  `endReason = 'DEADLINE_EXTENDED'`, `endNote` and the appended revision; evidence
  (`deadlineAt`, `breachedAt`, accountability, `scheduleRevisionNo`, `source`) never
  changes. A new deadline still at or before the patch instant ends nothing.
  `APPROVAL_WAIT` is never ended. When at least one obligation ends without a reason the
  patch returns `400 DEADLINE_EXTENSION_REASON_REQUIRED` with
  `fieldErrors.deadlineExtensionReason` ("Gecikmeyi sonlandıran tarih değişikliği için
  gerekçe yazın.") and nothing is written. One `JOB_OVERDUE_ENDED_BY_EXTENSION` activity
  is appended per patch that ended something, with the delay types, per-episode old/new
  boundary, reason and revision number.
- **Atomic change-request resolution.** `changeRequestResolution` is accepted only from
  MANAGER/ADMIN and only when the same patch appends a schedule revision; otherwise
  `400 VALIDATION_ERROR` with `fieldErrors.changeRequestResolution`. The named request
  must be this job's OPEN request: another job's or an unknown id is
  `404 CHANGE_REQUEST_NOT_FOUND`, an already resolved one is
  `409 CHANGE_REQUEST_NOT_OPEN`, and nothing is written. Only `RESCHEDULED` is accepted;
  `note` is optional and at most 2 000 characters. The resolution commits inside the
  patch transaction (state, resolution, `resolved_by`, `resolved_at` = the patch instant,
  `JOB_CHANGE_REQUEST_RESOLVED` activity, Staff notification and realtime event), in the
  users → JobCard → change-request lock order. The server never resolves a request the
  patch did not name. A replay of the same patch fails with the ordinary
  `409 VERSION_CONFLICT` and resolves nothing twice.

### Overdue incident history (OVR-2 / OVR-4 / OVR-5 readers)

`GET /api/job-cards/:jobCardId/overdue-incidents?limit&offset`

MANAGER/ADMIN only (`403 FORBIDDEN` for STAFF before any lookup), newest breach first
(`breached_at DESC, id DESC`). An incident is one immutable breach fact: `delayType`
(`LATE_START` / `LATE_SUBMISSION` / `APPROVAL_WAIT`), `episodeNo`, `scheduleRevisionNo`,
`deadlineAt`, `breachedAt`, accountability (`accountableRole`, `accountableSource`,
`accountableUser: { id, name } | null`), `source`, `recordedAt`. Identity and evidence
fields never change.

The one-way closing facts are reported next to it:

- `recoveredAt: string | null`, `recoveryActor: { id, name } | null` — the lifecycle action
  that resolved the obligation.
- `endedAt: string | null`, `endedBy: { id, name } | null`,
  `endReason: 'DEADLINE_EXTENDED' | 'CARD_INVALIDATED' | null`, `endNote: string | null`,
  `endedByScheduleRevisionNo: number | null` — `DEADLINE_EXTENDED`: OVR-5, an authorized
  deadline extension ended the obligation; `CARD_INVALIDATED`: OVR-2 (2026-11-20), an
  administrative `INVALIDATE` ended it with the card, without a schedule revision or a
  note. Recovery and ending are mutually exclusive; an ended incident is
  never reported as recovered, on time or successfully completed. These five fields (and
  `endedDurationSeconds` below) are null on a non-ended row.
- `totalDelaySeconds` — `recoveredAt - breachedAt` in whole seconds; `null` while open and
  `null` for an ended row.
- `endedDurationSeconds` — `endedAt - breachedAt` in whole seconds (same rounding);
  `null` for a non-ended row.
- `manualReminderSentAt`, `manualReminderCount` — OVR-4 manual manager reminders of that
  incident (LATE_SUBMISSION only) up to the closing instant (`recoveredAt` or `endedAt`);
  statistics stop at `endedAt`. `postReminderDelaySeconds` = `recoveredAt -
  manualReminderSentAt`, `null` for ended rows.

`GET /api/job-cards/:jobCardId/submission-lateness` reports the canonical open
`LATE_SUBMISSION` breach of the job and the automatic/manual reminder state. "Open" means
`recovered_at IS NULL AND ended_at IS NULL` in every current-state reader: the open-late
list, the per-job snapshot, the scanner and OVR-4 discovery, the manual reminder guard
(`409 SUBMISSION_NOT_LATE`) and recovery. OVR-4 delivery state is keyed on the canonical
open incident: a reminder/escalation kind is due for an episode only while no delivery of
that kind references a still-open incident of the same `(job, delayType, episodeNo)`.

### Sale origin and standalone creation (SALE-001 / SALE-002 S1)

`POST /api/job-cards/sales` creates a standalone `SALE` with no source visit
(authenticated; no legacy `includeSaleCapability` opt-in is required for this new
surface):

```ts
type SaleStandaloneCreateInput = {
  clientActionId: string
  title: string                        // 1–255 code points after trim
  description?: string | null         // ≤ 4000
  customerId: string                  // active, BUSINESS, same organization
  assignedTo: string                  // STAFF: must equal the actor
  soldAt: string                      // ISO instant, not in the future
  saleContactId?: string | null       // active, belongs to customerId
  items: Array<{ productId: string; quantity: number }>  // 1–25 distinct BUSINESS lines
}
```

The body is a strict allowlist; `type`, `status`, `expectedSourceVersion`, source
fields and snapshots are rejected with `400 VALIDATION_ERROR`. STAFF create only
for themselves and receive `ACCEPTED`; MANAGER/ADMIN may name any active
same-organization STAFF user and receive `NEW`. `201` returns the existing
`{ jobCardId, version }` receipt. Idempotency is `SALE_STANDALONE_CREATE`
(discriminator `SALE_STANDALONE_CREATE:v1`, normalized body hash): replay returns
the original receipt and a changed payload is `409 CLIENT_ACTION_REUSED`. Errors
are the existing `CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE`,
`SALE_REFERENCE_NOT_ELIGIBLE`, `CONTACT_NOT_FOUND`, `CONTACT_NOT_IN_CUSTOMER`,
`CONTACT_INACTIVE`, `PRODUCT_NOT_FOUND`, `SALE_PRODUCT_DUPLICATE`,
`SALE_ITEM_LIMIT` and `SALE_TIME_INVALID`. Lock order is sorted users → customer
`FOR UPDATE` → sorted contacts `FOR SHARE` → sorted products `FOR SHARE` →
insert. The transaction writes the root, `job_card_sale_details` with every
source column NULL, items, `JOB_CREATED` plus one `SALE_ITEM_ADDED` per line,
realtime, and the receipt; it writes no delivery, follow-up or visit mutation.

`POST /api/job-cards/:visitId/sales` keeps its existing body and behavior; the
locked source visit may now be `IN_PROGRESS` **or** `COMPLETED` (a cancelled or
invalidated visit stays `409 SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE`). Customer,
assignee and origin snapshots are still derived from the visit, the one-active-sale
slot rule is unchanged, and the visit receives `SALE_FROM_VISIT_CREATED`.

`GET /api/job-cards/:saleId/sale-details` keeps the `sourceVisit` key. Its union
is now:

```ts
type SaleOrigin =
  | { kind: 'STANDALONE' }                                   // no source to conceal
  | { access: 'RESTRICTED'; kind: 'SALE_FROM_VISIT' }
  | { access: 'FULL'; kind: 'SALE_FROM_VISIT'; /* snapshots as before */ }
```

A standalone origin is exactly `{ kind: 'STANDALONE' }` and must not render the
restricted-source message. `job_cards.delivery_source_sale_id` exists from
migration `071_sale_standalone_and_delivery_link`; it is written only by the
sale approval delivery (SALE-002 S3, below).

### Coordinated visit+sale commands (SALE-002 §4, S2)

A `SALES_MEETING` visit plus its one active linked `SALE`
(`sale_source_visit_id`, status in `NEW/ACCEPTED/IN_PROGRESS/WAITING_APPROVAL/
REVISION_REQUESTED`) form a **pair**. Pair discovery is server-side: no route
accepts a card id of the other side, and the visit is the only submission and
approval surface.

While the source visit is live (`IN_PROGRESS`, `WAITING_APPROVAL`,
`REVISION_REQUESTED`) **and** both cards share one assignee, the five lifecycle
commands act on the pair. The five pair-capable handlers accept
`expectedSaleVersion` (`SUBMIT_FOR_APPROVAL`, `APPROVE`, `REQUEST_REVISION`,
`WITHDRAW_FROM_APPROVAL`, `RESUME`). `START`, accept/decline/release,
`CANCEL`/invalidate, the generic patch allowlists, `POST /:visitId/sales` and
the standalone sale create keep rejecting it with `400 VALIDATION_ERROR`.

| Command | Behavior |
| --- | --- |
| `SUBMIT_FOR_APPROVAL` (`:id` = visit) | Validates the visit first (`MEETING_NOT_READY`), then the linked sale (`400 SALE_NOT_READY` with `details: { readiness }`, nothing written; the same error and payload apply to a single-card sale submit), then moves both `→ WAITING_APPROVAL` in one transaction with one instant. A sale already `WAITING_APPROVAL` keeps its own submission facts (no second event). A sale in `NEW`/`REVISION_REQUESTED` is `409 SALE_PAIR_STATE_CONFLICT` with `allowedSaleCommand: ACCEPT_ASSIGNMENT` / `RESUME`. |
| `APPROVE` (`:id` = visit) | Completes the visit and completes the sale **only if** it is `WAITING_APPROVAL`. Both completed cards share `manager_approved_at/by/note`. The JOB-008 follow-up child is still created from the visit. A legacy sale in another state is left untouched and becomes independent. |
| `REQUEST_REVISION` | Moves the visit and, only when it is `WAITING_APPROVAL`, the sale; the same reason/instant/actor, one `JOB_REVISION_REQUESTED` per moved card. The OVR-5b correction deadline stays visit-only. |
| `WITHDRAW_FROM_APPROVAL` | Returns the visit to `IN_PROGRESS` and, only when it is `WAITING_APPROVAL`, the sale. Prior submission facts stay. |
| `RESUME` | Returns every pair card currently in `REVISION_REQUESTED` to `IN_PROGRESS`. |

`CANCEL`/`INVALIDATE` on the visit stay single-card and never cascade; after the
source is terminal the sale runs its own lifecycle. A pair whose assignees
diverge (pre-S2 data only) is **decoupled**: no redirects, no shared ids, each
card acts alone.

**Request identity.** `clientActionId` + operation key
(`JOB_SUBMIT_FOR_APPROVAL_PAIR:<visitId>`, `JOB_APPROVE_PAIR:<visitId>`,
`JOB_REQUEST_REVISION_PAIR:<visitId>`, `JOB_WITHDRAW_FROM_APPROVAL_PAIR:<visitId>`,
`JOB_RESUME_PAIR:<visitId>`) is the identity; the discriminator is
`<PAIR_OPERATION>:v1` and the hash covers
`{pairOperation, visitId, visitExpectedVersion, saleId, saleExpectedVersion,
note, revisionReason, followUpProposal, locationCapture}` (S3 adds normalized
`delivery`). As in the single-card lifecycle identity, the manager's approval follow-up
override (`approveFollowUp`, normalized the same way) and the OVR-5b `correctionDueAt`
(`REQUEST_REVISION`) are included **only when the client sent them** (present-only, so a
receipt recorded without them keeps replaying byte-identically). Replay returns the stored anchor (visit) detail and publishes
nothing; a changed `saleExpectedVersion`/note/proposal/location, or the same key
applied to a different linked sale, is `409 CLIENT_ACTION_REUSED`.

**Response.** The anchor detail gains `linkedSaleJobCardId` when the sale moved
in that command and `deliveryJobCardId` when the approval opened a delivery
(S3, below). Both are persisted in the stored receipt, so replays are
byte-identical.

**`expectedSaleVersion` rules.** Required iff a coordinated pair exists for the
command (`400 VALIDATION_ERROR` otherwise); supplied without one is
`409 SALE_PAIR_STATE_CONFLICT` with `details: { reason: 'NO_COORDINATED_PAIR' }`
(a race or a stale view, never a validation error). It is part of the request
hash in both cases.

**New error codes (all `409` unless noted).**

| Code | Raised when | `details` |
| --- | --- | --- |
| `SALE_SUBMIT_VIA_VISIT_REQUIRED` | single-card sale submit while the source visit is `IN_PROGRESS`/`REVISION_REQUESTED` | `{ visitId, saleId, saleStatus, allowedSaleCommand }` |
| `SALE_APPROVE_VIA_VISIT_REQUIRED` | single-card sale approve while the source is `WAITING_APPROVAL` | idem |
| `SALE_REVISION_VIA_VISIT_REQUIRED` | single-card sale revision request while the source is `WAITING_APPROVAL` | idem |
| `SALE_WITHDRAW_VIA_VISIT_REQUIRED` | single-card sale withdraw while the source is `WAITING_APPROVAL` | idem |
| `SALE_RESUME_VIA_VISIT_REQUIRED` | single-card sale resume while the source is `REVISION_REQUESTED` | idem |
| `SALE_PAIR_STATE_CONFLICT` | visit submit blocked by an unsubmittable linked sale; `expectedSaleVersion` missing/extra race. For a `NEW` linked sale (`allowedSaleCommand: ACCEPT_ASSIGNMENT`) the message is `Bağlı satış kaydı önce kabul edilmelidir.` | `{ visitId?, saleId?, saleStatus?, allowedSaleCommand? }` or `{ reason: 'NO_COORDINATED_PAIR' }` |
| `SALE_PAIR_ASSIGNEE_CONFLICT` | reassignment that would make a live pair diverge (either card) | `{ visitAssignee, requestedAssignee }` |
| `VALIDATION_ERROR` (`400`) | coordinated pair without `expectedSaleVersion` | `{ fieldErrors: { expectedSaleVersion } }` |

**Locking and atomicity (SALE-002 §4.6).** One transaction, two 049 intents and
two `job_cards` row locks, in the documented order:
`processed_actions claim → users (sorted) → customers → contacts → products →
job_cards (sorted by id) → intents`. The visit owns the anchor intent and the
receipt; the sale owns the participant intent `<anchor>:participant` with the
same `reserved_at`/`request_hash` and `expected_version = expectedSaleVersion`.
A definitive 4xx marks **both** intents `FAILED` with the same failure code, so
a corrected attempt needs a new `clientActionId` (049 §5.4). Expiry marks both
`LIFECYCLE_INTENT_EXPIRED`; there is no half-failed pair. The approve path takes
the customer lock **before** any `job_cards` row (single and pair), removing the
former `job_cards -> customers` inversion.

### Sale approval opens the delivery (SALE-002 §5, S3)

`POST /api/job-cards/:id/approve` accepts one optional `delivery` object next to
`clientActionId`, `expectedVersion`, `note`, `followUp` and `expectedSaleVersion`:

```ts
type SaleApprovalDelivery = {              // strict allowlist, every other key => 400
  assignedTo?: string                      // active same-org STAFF; omitted = the sale's assignee
  scheduledAt: string                      // ISO instant, required (JOB-006 §4)
  scheduledEndsAt?: string                 // must equal the canonical PRODUCT_DELIVERY end
  deliveryPurpose?: 'SALE' | 'SAMPLE' | 'CONSIGNMENT' | 'RETURN' | 'OTHER'   // default 'SALE'
  note?: string | null                     // trimmed, <= 4000; stored as the card description
  items: Array<{ productId: string; quantity: number }>   // 1-25 distinct, whole units 1..999999999
  pastStartAcknowledgement?: { code: 'CUSTOMER_CONFIRMED_LATER_TIME' | 'CUSTOMER_WAITING' | 'OTHER'; text: string }
}
```

`delivery: null` is invalid; absent means no delivery. `delivery` is accepted only
when the command **completes a `SALE`**: `:id` is an independent sale (standalone,
or its source visit is terminal), or `:id` is a visit whose coordinated sale is
`WAITING_APPROVAL` and is completed by the same pair approval. On any other
approval (a visit with no coordinated sale, a legacy visit whose sale is not
`WAITING_APPROVAL`, any other job type) the answer is `400 VALIDATION_ERROR` with
`details.fieldErrors.delivery`, and nothing is executed. Parser errors are field
errors rooted under `delivery.` (`delivery.scheduledAt`, `delivery.items`,
`delivery.items.quantity`, `delivery.note`, ...); the item batch, quantity,
purpose, past-start acknowledgement and canonical-end parsers are the ones the
plain Product Delivery create uses.

**One transaction.** The `PRODUCT_DELIVERY` card is created inside the same
finalization as the approval (single-sale approve and pair approve share one
helper): status `NEW`, `created_by` = the approving manager, `customer_id` = the
sale's customer, `delivery_source_sale_id` = the sale, `due_date` and
`source_job_card_id` NULL, title = the sale title (<= 255 code points), planned
items with `deliveredAt` NULL, the note as the card description (never a
`deliveryNote`), priority `normal`. Activities: `JOB_CREATED` and one
`DELIVERY_ITEM_ADDED` per line on the delivery, and `SALE_DELIVERY_CREATED` on the
sale with `{ deliveryJobCardId, assignedTo, scheduledAt, itemCount, items }`. The
JOB-010 assignment offer is opened as a direct producer with
`opened_reason = 'SALE_APPROVAL'`. Any failure rolls the approval back with it:
the sale (and visit) stay `WAITING_APPROVAL`, no card, item, offer or realtime
event exists, and both 049 intents are `FAILED`, so a corrected attempt needs a
new `clientActionId` (049 / SALE-002 §5.4).

**Response and replay.** The response is the existing anchor detail plus
`deliveryJobCardId` (and `followUpJobCardId` / `linkedSaleJobCardId` as before).
The id is persisted in the stored receipt; a replay returns it byte-identically,
creates nothing and publishes nothing. The normalized `delivery` is part of the
request hash for both the single approve (`JOB_CARD_LIFECYCLE`) and the pair
approve (`JOB_APPROVE_PAIR:v1`), present-only (item lines keep request order,
instants are canonical, the note is trimmed); the same key with a different
delivery is `409 CLIENT_ACTION_REUSED`.

| Code | Raised when | `details` |
| --- | --- | --- |
| `VALIDATION_ERROR` (`400`) | malformed/unknown `delivery` member; `delivery` on an approval that completes no sale | `{ fieldErrors: { 'delivery' \| 'delivery.<field>' } }` |
| `ASSIGNMENT_WINDOW_TOO_SHORT` (`409`) | the planned window ends within the JOB-010 minimum window | `{ fieldErrors: { 'delivery.scheduledAt' } }` |
| `PAST_START_ACKNOWLEDGEMENT_REQUIRED` (`409`) | the planned start already passed and no acknowledgement was sent | `{ fieldErrors: { 'delivery.scheduledAt' } }` |
| `CUSTOMER_INACTIVE` (`409`) | the sale's customer is inactive; blocks the whole approval | - |
| `PRODUCT_NOT_FOUND` (`404`) | unknown, inactive, cross-organization or non-BUSINESS product | - |
| `FORBIDDEN` / `ASSIGNEE_NOT_FOUND` | assignee is not an active same-organization STAFF user | - |
| `SALE_DELIVERY_ALREADY_EXISTS` (`409`) | the sale already has a delivery (unique index `job_cards_one_delivery_per_sale_idx`) | - |

**Lock order (ARC-003).** `processed_actions claim -> users (sorted, now
including the delivery assignee) -> customer -> products (sorted, FOR SHARE) ->
job_cards (sorted) -> intents`. The customer and product locks of an approval
are taken by one shared pre-JobCard `lockReferences` phase for the single and
the pair path, so no `job_cards -> customers/products/users` inversion exists.

**Realtime.** After commit only: `job.created` (and the offer's `job.updated`)
for the delivery, whose audience is the delivery assignee, the sale's assignee
and management; no event of the delivery carries the sale's `job-detail` key.

**Read side.** The job detail of a delivery gains `deliverySourceSaleId`: the
source sale id when the viewer can read the sale (management, or the sale's own
assignee), otherwise `null`. The job detail of a sale gains
`linkedDelivery: { id, status } | null`: `null` when no delivery exists;
`{ id, status }` for management and for the delivery's assignee; `{ id: null, status }`
for the sale's owner when another staff member carries the delivery (its existence and
status are visible, its id is not). The web client accepts `id: null`. Both are keys of
the JobCard detail DTO on every card type (null where not applicable); the
`GET /:saleId/sale-details` projection is unchanged. The sale
activity timeline projects `SALE_DELIVERY_CREATED` as
`{ kind: 'SALE_DELIVERY', deliveryJobCardId, assignedTo, scheduledAt, itemCount, items }`
for sale-capable readers and as `{ kind: 'NONE' }` for every other reader.

### Database note: SALE without START (SALE-002 R9, migration `072`)

Accepted Q1 allows `SUBMIT_FOR_APPROVAL` from `ACCEPTED` for a `SALE`, so a sale
may reach `WAITING_APPROVAL`/`IN_PROGRESS`/`COMPLETED` without a START.
`006_job_cards_started_status_timestamp_check` required `started_at` for those
statuses; migration `072_sale_submit_without_start` exempts `type = 'SALE'`.
Nothing is fabricated: no `STARTED` accountability fact is written and
`started_at` stays NULL. `072` is additive (a weaker predicate; every existing
row still satisfies it), is deployed schema-first, and moves
`HEALTH_SCHEMA_VERSION` to `072_sale_submit_without_start`.


## 11. Delivery Items

| Method | Path | Roles | Idempotency |
| --- | --- | --- | --- |
| GET | `/:jobCardId/delivery-items` | visibility | none |
| POST | `/:jobCardId/delivery-items` | edit policy | required |
| PATCH | `/:jobCardId/delivery-items/:itemId` | edit policy | not processed-cache by default |
| DELETE | `/:jobCardId/delivery-items/:itemId` | edit policy | not processed-cache by default |

Delivery-item POST and PATCH share a date-only `expiryDate` normalizer. Valid
`YYYY-MM-DD` and unpadded `YYYY-M-D` values normalize to `YYYY-MM-DD` before
hashing and persistence; null/undefined normalize to null when creating a record.
PATCH omission preserves the current field. Invalid calendar dates, year zero,
timestamps and ambiguous locale formats return `400 VALIDATION_ERROR`. For example,
`2026-9-1` and `2026-09-01` have the same request identity; `2026-02-29` is invalid.
No migration or historical backfill is performed.

### POST delivery item

```json
{
  "clientActionId": "uuid",
  "expectedVersion": 1,
  "productId": "uuid",
  "deliveryPurpose": "SAMPLE",
  "deliveredAt": "2026-07-10T11:30:00+03:00",
  "quantity": 2,
  "lotNo": "L-001",
  "serialNo": null,
  "expiryDate": "2028-06-30",
  "deliveryNote": "Doktor değerlendirmesi için bırakıldı"
}
```

Rules:

- Parent type must be `PRODUCT_DELIVERY`.
- Parent must be in an editable state.
- Product belongs to the authenticated organization and is active at creation.
- Quantity is a whole-unit product count in 1–999999999 (DELIVERY-QTY-001);
  fractions, zero, negatives and overflow are rejected without rounding.
- Purpose is one canonical delivery purpose.
- Delivered time (`deliveredAt`) is the actual delivery instant. It may be null while the
  job is still being planned or prepared; submission requires every item to have a valid
  actual time. Never copy `job.scheduledAt` into `deliveredAt`.
- Product name, SKU, model, and unit snapshots come from the catalog.
- Price and financial fields are rejected as unknown input.

Successful commands append `DELIVERY_ITEM_ADDED`, `DELIVERY_ITEM_UPDATED`, or `DELIVERY_ITEM_REMOVED` and increment JobCard version atomically.

## 12. Sales Meeting Details

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/:jobCardId/meeting-details` | visible Sales Meeting | canonical structured result |
| PATCH | `/:jobCardId/meeting-details` | edit policy | target-scoped idempotent update |

Canonical response:

```ts
type MeetingOutcome =
  | 'POSITIVE'
  | 'FOLLOW_UP_REQUIRED'
  | 'NO_DECISION'
  | 'NOT_INTERESTED'

type MeetingDetails = {
  jobCardId: string
  meetingAt: string | null
  outcome: MeetingOutcome | null
  meetingSummary: string | null
  nextFollowUpAt: string | null
  jobCardVersion: number
}
```

PATCH accepts exactly `clientActionId`, `expectedVersion`, and at least one of
`meetingAt`, `outcome`, `meetingSummary`, or `nextFollowUpAt`. Instants require an explicit
offset or `Z`. Summary is trimmed, blank becomes null, and the maximum is 4000 Unicode
code points. A follow-up, when present, must be strictly later than `meetingAt`.

Parent concealment occurs before the Sales Meeting type guard and version/detail work.
Malformed `:jobCardId` returns `404 JOB_CARD_NOT_FOUND` before PostgreSQL; a visible
non-meeting parent returns `409 INVALID_JOB_TYPE`. `NEW`, `ACCEPTED`, `WAITING_APPROVAL`,
`COMPLETED`, and `CANCELLED` reuse exact `409 JOB_NOT_EDITABLE` with
`JobCard bu durumda düzenlenemez.` Stale version returns `409 VERSION_CONFLICT`.
A body without any result field returns `400 VALIDATION_ERROR`; a valid canonical no-op returns
`400 MEETING_DETAILS_UNCHANGED` with `Görüşme sonucunda kaydedilecek bir değişiklik yok.`
A successful transaction locks
JobCard then detail, updates the result, increments the parent version once, and appends
one `MEETING_DETAILS_UPDATED` event containing only ordered changed-field names.

## 13. Notes and Activity

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/:jobCardId/notes` | visibility | paginated notes |
| POST | `/:jobCardId/notes` | note policy | append non-empty note |
| GET | `/:jobCardId/activity` | visibility | paginated immutable timeline |

Note request:

```json
{
  "clientActionId": "uuid",
  "note": "Teslim alan kişi bilgisi düzeltme notunda belirtildi."
}
```

Product Delivery and General Task retain note creation across lifecycle states. Sales
Meeting note creation is allowed in `NEW`, `ACCEPTED`, `IN_PROGRESS`, and
`REVISION_REQUESTED` so assigned Staff can communicate before start; review and terminal
states return exact `409 JOB_NOT_EDITABLE`. Note reads remain available for persisted
read-only history. Successful addition atomically appends `NOTE_ADDED`.
Notes are append-only through the application contract; no public or repository
update/delete operation exists.

## 14. Named JobCard Commands

There is no generic transition route. There is no public `/plan` route.

| Method | Path | From | To | Roles |
| --- | --- | --- | --- | --- |
| POST | `/:id/accept` | NEW | ACCEPTED | assigned staff only |
| POST | `/:id/start` | ACCEPTED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/submit-for-approval` | IN_PROGRESS | WAITING_APPROVAL | staff own, manager, admin |
| POST | `/:id/approve` | WAITING_APPROVAL | COMPLETED | manager, admin |
| POST | `/:id/request-revision` | WAITING_APPROVAL | REVISION_REQUESTED | manager, admin |
| POST | `/:id/withdraw-from-approval` | WAITING_APPROVAL | IN_PROGRESS | assigned staff, manager, admin |
| POST | `/:id/resume` | REVISION_REQUESTED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/cancel` | NEW, ACCEPTED, IN_PROGRESS, WAITING_APPROVAL, or REVISION_REQUESTED | CANCELLED | assigned staff own, manager, admin |

Base lifecycle command body:

```json
{
  "clientActionId": "uuid",
  "expectedVersion": 6,
  "note": "İşlem açıklaması"
}
```

`request-revision` requires `revisionReason`; `cancel` requires `cancelReason` according to cancellation policy.

### Revision correction deadline (OVR-5b)

`POST /api/job-cards/:id/request-revision` accepts one optional extra key:

```json
{
  "clientActionId": "uuid",
  "expectedVersion": 6,
  "revisionReason": "Fotoğraflar eksik.",
  "correctionDueAt": "2026-11-22T09:00:00.000Z"
}
```

- **Syntax first.** `correctionDueAt` must be a valid ISO instant string. A `null`,
  non-string or unparsable value returns `400 VALIDATION_ERROR` with
  `fieldErrors.correctionDueAt` ("Geçerli bir düzeltme son tarihi seçin.") before the
  lifecycle intent is claimed and before the request hash is computed.
- **Bound under the 049 clock.** `reserved_at + 1 hour ≤ correctionDueAt ≤ reserved_at +
  14 days`, checked in the reservation preflight and again in finalize against the same
  `reserved_at`. Outside the bound returns `400 VALIDATION_ERROR` with
  `fieldErrors.correctionDueAt` ("Düzeltme son tarihi en az 1 saat, en fazla 14 gün
  sonrası olmalı.") and nothing is armed or written.
- **Stored value.** The activation row of the armed episode records the supplied value,
  or `reserved_at + 24 hours` when omitted. `WITHDRAW_FROM_APPROVAL` never stores one.
  When the job has no original effective submission deadline (no `scheduledEndsAt`, no
  `scheduledAt` except for SALES_MEETING, and no `dueDate`) nothing is stored and a
  syntactically valid supplied value is ignored: a correction never creates lateness
  where none existed. The bound is skipped in that case.
- The armed episode's effective deadline is `max(original effective deadline,
  correctionDueAt)`; equality at the effective deadline is still on time. The
  `JOB_REVISION_REQUESTED` activity metadata records the stored `correctionDueAt` (or
  `null`); the notification text is unchanged.
- **Idempotency.** The request hash includes the normalized `correctionDueAt` only when
  the client sent the key, so a pre-OVR-5b receipt recorded without it keeps replaying
  byte-identically and the same `clientActionId` with a different value conflicts.

`ACCEPT_ASSIGNMENT` is not gated by `scheduledAt`; the acceptance deadline belongs to
JOB-010 release 2b. `START` for `PRODUCT_DELIVERY` and `SALES_MEETING` is allowed from
`scheduledAt − 30 minutes` (inclusive); earlier needs a reschedule or a valid management
early-start authorization. Every other type keeps `requestTime >= scheduledAt`. See
[assignment acceptance and SLA](docs/features/assignment-acceptance-sla.md) §1 and §1a.

### Early-start authorization (JOB-010 release 1)

`POST /api/job-cards/:id/early-start-authorization`

```json
{ "clientActionId": "uuid", "expectedVersion": 6 }
```

MANAGER/ADMIN only (STAFF is rejected with `403 FORBIDDEN` before any lookup; unknown and
cross-org jobs stay `404 JOB_CARD_NOT_FOUND`). The JobCard row is locked, the version is
checked, `job_cards.version` increments and a `JOB_EARLY_START_AUTHORIZED` activity plus
its realtime `job.updated` event commit in the same transaction. The job must be
`PRODUCT_DELIVERY` or `SALES_MEETING`, in `NEW` or `ACCEPTED`, with a `scheduledAt`; otherwise
`409 EARLY_START_NOT_APPLICABLE`. A still-valid authorization returns
`409 EARLY_START_ALREADY_AUTHORIZED`; a stale version returns `409 VERSION_CONFLICT`; a replay
of the same `clientActionId` returns the stored receipt.

Response `200`:

```json
{ "jobCardId": "uuid", "authorizationId": "uuid", "grantedAt": "2026-11-20T08:00:00.000Z" }
```

The row records the assignee, the current schedule revision number and the planned interval
it was granted for. It stays valid only while that assignee and planned interval are
unchanged; a management reassignment or reschedule (and the Staff offboarding transfer)
voids it one-way in the same transaction with `REASSIGNED`, `RESCHEDULED` or
`OFFBOARDING_TRANSFER`. A `dueDate`-only change keeps it. The job detail exposes the
currently valid grant as `earlyStartAuthorization: { grantedAt, grantedBy: { id, name } } | null`.

Cancelling a follow-up visit (`type = SALES_MEETING` with `engagementKind = FOLLOW_UP`) also
requires `followUpContinuity` ([JOB-009](DECISIONS.md)); every other JobCard must omit it:

```json
{ "clientActionId": "uuid", "expectedVersion": 6, "cancelReason": "Müşteri bu hafta uygun değil",
  "followUpContinuity": { "decision": "RESCHEDULE", "scheduledAt": "2026-11-24T07:30:00.000Z" } }
```

```json
{ "clientActionId": "uuid", "expectedVersion": 6, "cancelReason": "Rakip firmayla anlaşma yaptı",
  "followUpContinuity": { "decision": "END_CYCLE", "endReason": "WORKS_WITH_COMPETITOR" } }
```

- `RESCHEDULE` cancels the visit and creates its replacement follow-up visit in the same
  transaction. `scheduledAt` must be in the future; the replacement keeps customer, contact,
  assignee, title, priority, source link, instructions and data class (a DEMO visit's
  replacement stays in its demo dataset), and passes the normal calendar
  availability and customer frequency checks.
- `END_CYCLE` persists `endReason` (`NOT_INTERESTED`, `WORKS_WITH_COMPETITOR`,
  `CUSTOMER_INACTIVE`, `DUPLICATE_RECORD`, `OTHER`) on the cancelled JobCard, exposed as
  `followUpCycleEndReason` in the lifecycle facts.
- Each object accepts exactly the keys shown. A missing decision returns
  `400 FOLLOW_UP_CANCEL_DECISION_REQUIRED`, a decision on any other JobCard
  `400 FOLLOW_UP_CANCEL_DECISION_INVALID`, a past replacement time
  `400 FOLLOW_UP_RESCHEDULE_IN_PAST`, and a malformed object `400 VALIDATION_ERROR`
  (`field: followUpContinuity`).
- The decision is part of the idempotent request identity; a cancel without it keeps its
  previous request hash.

### Change/termination request (JOB-010 release 2a, decision D1)

Staff never cancel a customer's JobCard (release 2c). From release 2a the assigned Staff
member raises a reasoned request instead; it never changes the JobCard row, status or
version and deletes nothing. At most one request per job is `OPEN`.

`POST /api/job-cards/:id/change-requests`

```json
{ "clientActionId": "uuid", "reasonCode": "CUSTOMER_POSTPONED", "reasonText": "Müşteri teslimi önümüzdeki haftaya aldı." }
```

- `reasonCode` is one of `CUSTOMER_CHANGED_MIND`, `CUSTOMER_POSTPONED`, `CUSTOMER_ABSENT`,
  `WRONG_PRODUCT`, `MISSING_STOCK_OR_EQUIPMENT`, `VISIT_NOT_POSSIBLE`, `OTHER`;
  `reasonText` is mandatory (trimmed, 1–2000 code points).
- Assigned STAFF only: any other role gets `403 FORBIDDEN` before any lookup, and a STAFF
  member who is not the current assignee (or a cross-org / unknown job) gets
  `404 JOB_CARD_NOT_FOUND`.
- A terminal job returns `409 JOB_NOT_ACTIVE`; a second open request returns
  `409 CHANGE_REQUEST_ALREADY_OPEN`; a replay of the same `clientActionId` returns the
  stored receipt.
- The `JOB_CHANGE_REQUESTED` activity, its realtime `job.updated` event and a
  `job.change_requested` in-app notification (plus web push when enabled) to every active
  MANAGER/ADMIN commit in the same transaction.

Response `201`:

```json
{ "jobCardId": "uuid", "changeRequestId": "uuid", "requestedAt": "2026-11-20T09:00:00.000Z" }
```

`POST /api/job-cards/:id/change-requests/:requestId/resolve`

```json
{ "clientActionId": "uuid", "resolution": "REJECTED", "note": "Müşteri teslimi bekliyor, iş devam ediyor." }
```

- MANAGER/ADMIN only: STAFF gets `403 FORBIDDEN` before any lookup; cross-org and unknown
  jobs or requests return `404`.
- `resolution` is `CORRECTED`, `RESCHEDULED`, `LINKED_JOB_CREATED` or `REJECTED`.
  `REJECTED` requires `note` (1–2000 code points); `LINKED_JOB_CREATED` requires a
  `linkedJobCardId` that belongs to the same organization and is not this job. Both are
  `400 VALIDATION_ERROR` otherwise.
- An already closed request returns `409 CHANGE_REQUEST_NOT_OPEN`.
- It records the decision only; correcting, rescheduling, creating the linked job and
  cancelling stay the existing commands. The `JOB_CHANGE_REQUEST_RESOLVED` activity, its
  realtime `job.updated` event and a `job.change_request_resolved` notification to the
  requester (while still active) commit in the same transaction.

Response `200`:

```json
{ "jobCardId": "uuid", "changeRequestId": "uuid", "resolution": "LINKED_JOB_CREATED",
  "resolvedAt": "2026-11-20T11:00:00.000Z" }
```

An open request is closed by the command that ends the job's open question, inside that
command's transaction: `cancel` writes `CANCELLED` with the cancelling actor, `approve` and
the ADMIN `invalidate` write `SUPERSEDED`. The cancel reason stays the actor's own text.

`GET /api/job-cards/change-requests/open?limit&offset`

Management only (`403 FORBIDDEN` for STAFF), oldest first. Item:
`{ changeRequestId, jobCardId, jobTitle, jobType, jobStatus, reasonCode, reasonText,
requestedAt, requestedBy: { id, name }, customer: { id, name } | null, jobPath }`, plus
`total`, `limit`, `offset`.

The job detail exposes the currently open request as
`changeRequest: { id, reasonCode, reasonText, requestedAt, requestedBy: { id, name } } | null`,
and `workflowContext.allowedActions` gains `REQUEST_CHANGE` (assigned STAFF, active job, no
open request) and `RESOLVE_CHANGE_REQUEST` (MANAGER/ADMIN, open request).

While a request is open, the automatic OVR-4 submission reminders for that job pause
(incidents are kept and manual manager reminders stay allowed) and
`GET /:id/submission-lateness` reports `open.changeRequestOpenSince`.

### Assignment offers (JOB-010 release 2b)

Release 2b is inert until `JOB_ASSIGNMENT_WINDOW_ENABLED=true`: with the flag off no offer
is recorded, none of the commands below exists, Staff patch and `CANCEL` rules are unchanged
and no expiry worker runs. A job is "in the acceptance window" when it has at least one
offer row (`PRODUCT_DELIVERY` / `SALES_MEETING` with a `scheduledAt`, assigned by a non-self
actor).

Every offer row records the assignee, `openedAt`, `openedReason` (`CREATE`, `REASSIGN`,
`RESCHEDULE`, `FOLLOW_UP_CREATE`, `APPROVE_FOLLOW_UP`, `CANCEL_REPLACEMENT`,
`OFFBOARDING_TRANSFER`, `REOFFER`), the opening management actor, the acceptance deadline,
the urgency reason (`SHORT_NOTICE` / `START_PASSED` / none), an optional past-start
acknowledgement, and its state (`OPEN`, `ACCEPTED`, `DECLINED`, `RELEASED`, `EXPIRED`,
`WITHDRAWN`). At most one offer per job is `OPEN`; closed offers are append-only history.

`acceptanceDueAt = max(scheduledAt − 60 min, openedAt + 10 min)`. An answer reserved before
that instant is on time; at or after it the server rejects the answer with
`409 ACCEPTANCE_WINDOW_CLOSED` and writes nothing, whether or not the expiry worker ran.

Management producers that fail the minimum-window rule (`openedAt + 10 min >= scheduledEndsAt`)
return `409 ASSIGNMENT_WINDOW_TOO_SHORT`. A producer whose `openedAt >= scheduledAt` returns
`409 PAST_START_ACKNOWLEDGEMENT_REQUIRED` unless the request carries
`pastStartAcknowledgement: { code, text }` with `code` in `CUSTOMER_CONFIRMED_LATER_TIME`,
`CUSTOMER_WAITING`, `OTHER` and mandatory text (1–2000). The field is accepted (and ignored
when not needed) on create, product-delivery create, follow-up create, patch and re-offer,
and participates in the request hash. Compound producers (JOB-008 approval, JOB-009
replacement, offboarding transfer) record the offer without an acknowledgement and close it
`WITHDRAWN` / `PLANNED_WINDOW_PASSED` when the planned window no longer fits.

`POST /api/job-cards/:id/decline`

```json
{ "clientActionId": "uuid", "expectedVersion": 6, "reasonCode": "SCHEDULE_CONFLICT",
  "reasonText": "Aynı saatte başka bir teslimim var." }
```

Assigned STAFF only, `NEW` with an `OPEN` offer before the deadline. `reasonCode` is one of
`SCHEDULE_CONFLICT`, `ON_LEAVE`, `TOO_FAR`, `MISSING_STOCK_OR_EQUIPMENT`, `OTHER`;
`reasonText` is mandatory. The status stays `NEW` (`version` +1), the offer closes
`DECLINED`, the `JOB_ASSIGNMENT_DECLINED` activity commits with the reason, and every active
MANAGER/ADMIN receives `job.assignment_declined`. A missing/stale offer returns
`409 ASSIGNMENT_OFFER_NOT_OPEN`.

`POST /api/job-cards/:id/release` — same body, from `ACCEPTED` while the latest offer is
`ACCEPTED` for the actor. In one transaction: the pre-release OVR-2 `LATE_START` obligation is
materialized, the job returns to `NEW` with `acceptedAt`/`acceptedBy` cleared, the offer
moves `ACCEPTED -> RELEASED`, the `JOB_ASSIGNMENT_RELEASED` activity commits and management
receives `job.assignment_declined`.

`POST /api/job-cards/:id/assignment-offers/reoffer`

```json
{ "clientActionId": "uuid", "expectedVersion": 6,
  "pastStartAcknowledgement": { "code": "CUSTOMER_WAITING", "text": "Müşteri teslimi bekliyor." } }
```

MANAGER/ADMIN only (`403 FORBIDDEN` before lookup), flag on (else
`409 ASSIGNMENT_WINDOW_DISABLED`), job `NEW`, `PRODUCT_DELIVERY` / `SALES_MEETING` with a
`scheduledAt`. A live `OPEN` offer (`requestTime < acceptanceDueAt`) returns
`409 ASSIGNMENT_OFFER_ALREADY_OPEN`; an overdue one is closed `EXPIRED` (no actor) in the
same transaction. A new `REOFFER` offer opens to the current assignee and `version` +1.
Idempotent through the request hash.

Response `201`:

```json
{ "jobCardId": "uuid", "offerId": "uuid",
  "acceptanceDueAt": "2026-11-20T11:50:00.000Z", "urgentReason": "SHORT_NOTICE" }
```

`GET /api/job-cards/assignment-offers/needs-action?limit&offset`

Management only. Jobs still `NEW` whose latest offer is `DECLINED`, `RELEASED`, `EXPIRED`,
`WITHDRAWN`/`PLANNED_WINDOW_PASSED`, or `OPEN` with an `urgentReason` or a passed deadline
(evaluated at read time), oldest deadline first. Item:
`{ jobCardId, jobTitle, jobType, offerId, state, closeReason, closeText, acceptanceDueAt,
urgentReason, scheduledAt, assignee: { id, name }, customer: { id, name } | null, jobPath }`,
plus `total`, `limit`, `offset`.

`GET /api/job-cards/pending-acceptance/past-start?limit&offset`

Management only (`403 FORBIDDEN` before any lookup). `NEW` jobs with an assignee whose
`scheduled_at` has passed and that JOB-010 does not own: no offer at all, a stale
`ACCEPTED` offer, or a `WITHDRAWN` offer whose reason is not `PLANNED_WINDOW_PASSED` (the
OVR-6 ownership matrix). A still answerable `OPEN` offer keeps the job in the offer flow
and on **neither** list, and every offer state the needs-action list claims is never
listed here, so a job has exactly one owner. Evaluated against the request clock, oldest
planned start first; a job with an open change request stays listed but receives no
notification. Item:
`{ jobCardId, title, type, jobPath, assignee: { id, name, active }, scheduledAt,
elapsedSeconds, hasOpenChangeRequest }`, plus `total`, `limit`, `offset`. This list is
never quiet-hours gated; only the automatic alert is.

With `LATENESS_ALERTS_ENABLED=true` the worker writes one activity per delivery
(`JOB_START_REMINDER_SENT`, `JOB_APPROVAL_WAIT_ALERT_SENT`,
`JOB_PENDING_ACCEPTANCE_ALERT_SENT`) and one in-app notification per recipient
(`job.start_reminder` → the assignee, `job.approval_wait_alert` and
`job.pending_acceptance_alert` → every active MANAGER/ADMIN at send time). All three are
sent only Monday–Saturday 08:00–21:00 organization time; outside that window they wait.

The job detail exposes the latest offer as
`assignmentOffer: { id, state, acceptanceDueAt, openedAt, urgentReason, assignee: { id, name } } | null`
(management and assignee); an `OPEN` offer past its deadline is presented with
`state: EXPIRED`. With the flag on, `allowedCommands` in the window are
`ACCEPT_ASSIGNMENT` + `DECLINE_ASSIGNMENT` in `NEW`, and `START` + `RELEASE_ASSIGNMENT` in
`ACCEPTED`; Staff never receive `CANCEL` for any JobCard type or status.

For a job in the window in `NEW`/`ACCEPTED`, a Staff patch that changes `scheduledAt`,
`scheduledEndsAt` or `dueDate` returns `403 CUSTOMER_TIME_MANAGEMENT_ONLY`.

When enabled, `createAssignmentOfferExpiryWorker` closes an overdue `OPEN` offer as
`EXPIRED` (once, with `job.acceptance_expired` to management) and sends one
`job.acceptance_reminder` to the assignee at the half-way point. A lifecycle reservation
reserved before the deadline and still in flight wins over expiry.

Every offer change appends an activity row in the same transaction:
`JOB_ASSIGNMENT_OFFER_OPENED`, `JOB_ASSIGNMENT_DECLINED`, `JOB_ASSIGNMENT_RELEASED`,
`JOB_ASSIGNMENT_OFFER_EXPIRED`, `JOB_ASSIGNMENT_OFFER_WITHDRAWN`, and
`JOB_ASSIGNMENT_REMINDER_SENT` for the automatic half-way reminder. The reminder is a
system-authored fact, not a lifecycle transition (`actor_id` is `null`), but every in-app
notification is transported by an activity-backed realtime event, so
`JOB_ASSIGNMENT_REMINDER_SENT` is the source of the `job.acceptance_reminder` notification.
A re-offer that supersedes an overdue `OPEN` offer writes the
`JOB_ASSIGNMENT_OFFER_EXPIRED` activity without the `job.acceptance_expired`
notifications, because the acting manager is already handling the recovery.

### Submit requirements

For `PRODUCT_DELIVERY`:

- customer exists in the same organization
- assignee exists in the same organization
- at least one delivery item
- every item has product, canonical purpose, delivered time, and positive quantity

For `GENERAL_TASK`:

- non-empty title
- eligible assignee

For `SALES_MEETING`, validation order is deterministic:

1. active same-organization Customer
2. eligible assignee
3. actual `meetingAt`, one canonical outcome, and normalized non-empty summary

`meetingAt` may be at most 15 minutes after the authoritative request time. It may be
empty only when `outcome` is `FOLLOW_UP_REQUIRED` and a structured `unsuccessfulReason` is
set — a visit that did not take place is submitted truthfully and never gets a fabricated
time (JOB-010 release 2a, decision D1). Every other outcome requires it.
A non-null follow-up must be later than the meeting; `FOLLOW_UP_REQUIRED` does not make follow-up
mandatory. Relation failures retain `CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE`, and
`ASSIGNEE_NOT_ELIGIBLE`; structured field failures return `400 MEETING_NOT_READY` with
safe `details.fieldErrors` keys only.

An exhaustive backend policy keyed by the canonical JobCard type selects these readiness
requirements. The lifecycle transaction, state transition, timestamps, versioning,
idempotency, and activity append remain shared.

Submit records staff completion identity/time, changes status, increments version, and appends `JOB_SUBMITTED_FOR_APPROVAL` in one transaction.

### Approval and revision review lock

While `WAITING_APPROVAL`:

- Staff cannot patch commercial fields or delivery items.
- Manager and admin cannot patch commercial fields or delivery items.
- Manager and admin can approve or request revision.
- Notes follow the documented note policy.

Approval appends `JOB_APPROVED`. Revision appends `JOB_REVISION_REQUESTED`. Resume appends
`JOB_RESUMED`. Cancel appends `JOB_CANCELLED`. Accept appends `JOB_ACCEPTED` and records
`accepted_at` / `accepted_by`. Start appends `JOB_STARTED`. Historical `JOB_PLANNED` rows
remain readable on the activity timeline; new code does not write them.

Accept body uses the base lifecycle command shape (`clientActionId`, `expectedVersion`,
optional note). Manager/Admin calling `/accept` receive `403 FORBIDDEN`.

## 15. Board Read Projection

`GET /api/job-cards/board` may return grouped lists without becoming a second data source:

```json
{
  "columns": {
    "NEW": { "items": [], "count": 0 },
    "ACCEPTED": { "items": [], "count": 0 },
    "IN_PROGRESS": { "items": [], "count": 0 },
    "WAITING_APPROVAL": { "items": [], "count": 0 },
    "REVISION_REQUESTED": { "items": [], "count": 0 }
  },
  "closedCounts": {
    "COMPLETED": 0,
    "CANCELLED": 0
  }
}
```

Completed and cancelled records are represented only by filtered counts in the board projection. Their records remain available through the canonical paginated list. Mobile clients use the list route rather than rendering a squeezed board.

## 16. Reports `/api/reports`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/dashboard` | admin, manager | organization operational counters |
| GET | `/business-trend` | admin, manager | daily approved visits, linked follow-up visits and sale agreements; equal observed-period comparison and explicit relationship counts |
| GET | `/staff/me` | staff | own operational summary |
| GET | `/staff/:userId` | admin, manager | organization Staff operational summary |
| GET | `/deliveries` | admin, manager | quantity by date, product, staff, and purpose |
| GET | `/approvals` | admin, manager | pending approval age and counts |

Dashboard and Staff endpoints accept paired inclusive `from=YYYY-MM-DD` and `to=YYYY-MM-DD` values. Omitting both selects the organization-local current month. Delivery reports use the same range contract and require `groupBy=day|purpose|product|staff`. The inclusive range contains at most 366 calendar dates. Frontend code does not construct UTC boundaries.

Reports query parameters are scalar. Repeating `from`, `to`, `groupBy`, `staffUserId`, `limit`, or `offset`, even with the same value, returns `400 VALIDATION_ERROR` before coercion or repository access. Unknown parameters and parameters outside the endpoint-specific allowlist also return `400 VALIDATION_ERROR`.

Delivery quantities include only manager-approved `COMPLETED` Product Delivery JobCards. They use persisted `deliveredAt`, purpose, exact decimal-string quantity, nullable unit, and historical Product snapshots. Different or unknown units are never summed together. Reports do not return revenue, margin, commission, invoice, payment, stock, or inventory-valuation metrics.

All Staff attribution uses `job_cards.assigned_to`. `staff_completed_by` is the approval-submission lifecycle actor; `created_by`, manager approver identity, and activity actors do not determine report ownership. This rule is identical for Staff summaries, `groupBy=staff`, and `staffUserId` delivery filters.

`GET /api/reports/staff/:userId` returns `404 STAFF_PROFILE_NOT_FOUND` for a missing, cross-organization, non-Staff, or malformed UUID. Malformed UUID input is rejected before PostgreSQL access.

For `GET /api/reports/deliveries`, omitting `staffUserId` means all organization Staff. Empty, repeated, or malformed `staffUserId` returns `400 VALIDATION_ERROR`; a malformed query UUID does not reach PostgreSQL. A valid missing, cross-organization, or non-Staff UUID returns `404 STAFF_PROFILE_NOT_FOUND`. An inactive same-organization Staff UUID is accepted. The query behavior is intentionally different from the concealed malformed-path response on `/api/reports/staff/:userId`.

For delivery pagination, `total` is the canonical grouped-row count after filters and before pagination, not the raw delivery-item count. The count query and item query use the same group keys. `items` is the deterministically ordered `limit`/`offset` page of those groups. Persisted unit values are not normalized: `null`, `kutu`, and `Kutu` remain distinct. Every quantity is a three-decimal-scale string such as `0.500`, `3.000`, or `12.500`; frontend code never uses `Number`, `parseFloat`, or JavaScript arithmetic to combine report quantities.

Delivery responses are discriminated by `groupBy` into exact day, purpose, Product, and Staff item arrays. Staff report `deliveriesByPurpose` uses the same purpose item DTO. Purpose groups sort by `SALE`, `SAMPLE`, `CONSIGNMENT`, `RETURN`, `OTHER`, then persisted unit ascending with null last.

Dashboard completion counts and the single daily completion trend use `managerApprovedAt`; cancellation counts use `cancelledAt`. Current active, overdue, waiting-approval, and revision-requested counters are point-in-time values. Approval age covers only `WAITING_APPROVAL`, begins at `staffCompletedAt`, and is calculated against one authoritative server request time.

Dashboard counters and trend, Staff JobCard counters, and approval queue metrics include every JobCard type. Delivery report quantities and Staff `deliveriesByPurpose` include only `PRODUCT_DELIVERY`. General Task and Sales Meeting therefore affect operational counters and approval metrics but never delivery quantities.

Staff responses also contain exactly four zero-filled `meetingsByOutcome` rows in
canonical order. They include only `COMPLETED SALES_MEETING` JobCards, attribute ownership
through `job_cards.assigned_to`, and apply the requested organization-local date range to
actual `meeting_at`, not `due_date`, submission, or approval time.

Approval elapsed time is clamped with `GREATEST(requestTime - staff_completed_at, interval '0 seconds')`. Summary values cover the complete filtered queue rather than the current item page. `pendingCount` equals `total` and the sum of the four mutually exclusive age buckets. A future `staffCompletedAt` contributes zero minutes to `under2Hours`.

Approval `items` use the canonical `JobCardListItem` projection plus a non-negative integer `waitingMinutes` containing completed whole minutes.

The complete Slice 08 DTO, timezone, grouping, bucket, sorting, and accessibility contract is defined in `docs/superpowers/specs/2026-07-14-operational-reports-design.md`.

### Business trend extension (2026-11-04)

`GET /business-trend` accepts the same paired `from`/`to` range (at most 366
calendar dates) and the existing scalar `includeSaleCapability=true` opt-in.
Without that opt-in, sale totals and sale relationships are zero. It never
accepts a client-selected organization or staff identity.

The response has `range`, `asOf`, nullable `observedThrough`, `partialDay`,
`totals: { visits, followUps, sales }`, daily `points` with those counts plus
`date`, nullable `comparison: { range, totals }`, and
`relationships: { visitsWithFollowUp, visitsWithSale, followUpsWithSale }`.
Counts are non-negative integers; `followUps` is a subset of `visits`.
All facts come from one read statement. Calendar bounds, partial-day comparison,
actual event timestamps and distinct relationship scope are specified in the
[overview UI/read contract](docs/features/reporting/reports-overview-ui.md).
This endpoint does not implement verified personal performer attribution.

### Lateness extension (2026-11-22)

Implements `DECISIONS.md` OVR-7 and
[docs/features/reporting/lateness-reports.md](docs/features/reporting/lateness-reports.md).
Read-only; no migration or write path.

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/lateness` | admin, manager | organization lateness groups and management approval wait |
| GET | `/staff/:userId/lateness-incidents` | admin, manager | paged proven Staff lateness incidents |
| GET | `/staff/me/lateness-incidents` | staff | the authenticated Staff member's own incidents |

`GET /api/reports/staff/:userId` and `GET /api/reports/staff/me` now also return
`lateness: StaffLatenessSummary`. `/staff/me/lateness-incidents` is registered
before `/staff/:userId/lateness-incidents`; Staff calling the management paths
or `/lateness` receives `403`, and a malformed or non-Staff `userId` on the
management path receives the existing `404 STAFF_PROFILE_NOT_FOUND`.

The three reads accept the existing paired `from`/`to` range, the 366-day limit
and `includeSaleCapability=true` opt-in; the incident list additionally accepts
`limit` (integer 1–200, default 50) and `offset` (integer from 0, default 0).
An incident belongs to the organization-local period of its `breached_at`.
Incidents on `INVALIDATED` jobs and, without the capability opt-in, on `SALE`
jobs are excluded. Incidents are written from 2026-09-21 onward, so earlier
periods may be incomplete and responses carry `trackingStartedOn`.

Each cohort incident is exactly one accountability class (`STAFF_PROVEN`,
`STAFF_UNKNOWN`, `MANAGEMENT`) and one outcome (`RECOVERED`, `EXTENDED`,
`OPEN`). Staff groups show `LATE_START` and `LATE_SUBMISSION` in that fixed
order with per-outcome count, median and maximum integer seconds; a proven
Staff incident that overlaps the same Staff member's own change request that
management provably resolved is regrouped as operational (`byReason`) and is
never added to Staff responsibility. No response contains a summed duration,
rate, score or ranking. Durations use
`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (end - breached_at))))::int`.

The management incident list is ordered `breached_at DESC, id DESC` and returns
`range`, `items`, `total`, `limit`, `offset`. For a Staff viewer, `job` is
present only while the JobCard is currently assigned to that Staff member,
otherwise it is `null`; reason text and the requesting user are never exposed.
The organization card returns `totalIncidentCount` plus the four incident
counts (`staffResponsibility`, `operational`, `unknownAccountability`,
`managementApprovalWait`), which reconcile to the cohort size.

## 17. Health `/api/health`

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| GET | `/` | public | readiness: `200 {"status":"ok"}` when the database is reachable and required schema is present; otherwise `503 {"status":"unavailable"}` |

Unauthenticated health responses do not expose environment, host, filesystem, database name, migration filenames/versions, exception text, or dependency versions.

Admin `GET /detailed` remains **deferred** (not implemented in Slice 11).

## 18. DTO Shape

Canonical JobCard detail response:

```ts
type JobCardDetail = {
  id: string
  organizationId: string
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING'
  status: JobCardStatus
  version: number
  title: string
  description: string | null
  customerId: string | null
  contactId: string | null
  assignedTo: string
  createdBy: string
  priority: JobCardPriority
  dueDate: string | null
  assignee: { id: string; name: string }
  customer: { id: string; name: string } | null
  contact: { id: string; name: string } | null
  // JOB-010 §1a: the currently valid early-start authorization, or null.
  earlyStartAuthorization: {
    grantedAt: string
    grantedBy: { id: string; name: string | null }
  } | null
  // OVR-5b §5.3: an open (neither recovered nor ended) LATE_START or
  // LATE_SUBMISSION incident exists right now. The Staff deadline rule and the
  // management reason field read this server-computed fact.
  hasOpenOverdueIncident: boolean
  // OVR-5b §3.7: the effective submission deadline of the current submission
  // episode — max(original, stored correction) — when that episode was armed by
  // REQUEST_REVISION with a stored value and the job is REVISION_REQUESTED or
  // IN_PROGRESS; otherwise null.
  correctionDueAt: string | null
}
```

The organization-scoped JobCard repository produces these related identities in the same
canonical detail projection. Product Delivery loads its delivery-items subresource,
Sales Meeting loads its meeting-details subresource, and General Task loads neither.
Delivery list/add/patch/remove attempts for either non-delivery type return
`409 INVALID_JOB_TYPE` after parent visibility checks and before item, Product, or
version work. Meeting-details requests for either non-meeting type follow the same parent
concealment and type-guard order.

Conceptual delivery-item response:

```ts
type DeliveryItemDto = {
  id: string
  jobCardId: string
  productId: string
  deliveryPurpose: 'SALE' | 'SAMPLE' | 'CONSIGNMENT' | 'RETURN' | 'OTHER'
  deliveredAt: string
  quantity: string
  unit: string
  productNameSnapshot: string
  productSkuSnapshot: string | null
  productModelSnapshot: string | null
  lotNo: string | null
  serialNo: string | null
  expiryDate: string | null
  deliveryNote: string | null
}
```

## 19. Explicitly Absent API Areas

- stock and warehouse mutations
- invoices, payments, revenue, margins, and commissions
- attachment upload
- notification preferences without a notification system
- user-defined tables, fields, forms, or workflows
- generic JobCard transition endpoint
- public unauthenticated CRM endpoints
- restaurant tables, orders, payments, shifts, and printer routes
- WebSocket as an MVP requirement
