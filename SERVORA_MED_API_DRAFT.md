# Servora-Med API Draft

> Date: 2026-07-10  
> Status: Living API contract; implemented and verified through Slice 11 Production Deployment
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
| PATCH | `/:userId` | admin | update only `name` |
| POST | `/:userId/change-role` | admin | apply an allowed Admin/Manager role command |
| POST | `/:userId/activate` | admin | activate an eligible user |
| POST | `/:userId/deactivate` | admin | deactivate an eligible user and revoke all sessions |
| POST | `/:userId/reset-password` | admin | set an Admin-provided temporary password and revoke all sessions |

Staff reads their identity through `/api/auth/me` and profile through `/api/staff/me`.

Safe user responses include `id`, `organizationId`, `name`, normalized `email`, `role`, `isActive`, `mustChangePassword`, `lastLoginAt`, `version`, `createdAt`, and `updatedAt`. Password hashes, temporary passwords, tokens, cookies, and session data are never returned.

Every mutation requires `expectedVersion`, performs an atomic version-predicate update, and increments `version`. A stale mutation returns `409 USER_VERSION_CONFLICT`. Named commands accept only the fields required for that command; role and activation changes cannot be combined with a general patch.

Role changes to or from `STAFF` are rejected with `STAFF_ROLE_CHANGE_NOT_SUPPORTED`. An Admin cannot change their own role or deactivate their own account. The final active Admin, a Staff user with active JobCards, and a Manager with assigned active Staff are protected by their corresponding conflict codes.

Eligible Staff deactivation clears every matching Customer `assignedStaffUserId` in the
same transaction, increments each affected Customer version, and appends one
`CUSTOMER_ASSIGNEE_CHANGED` audit event with reason `STAFF_DEACTIVATED`. Session revocation,
user deactivation, assignment cleanup, and audit insertion either commit or roll back
together.

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

- `open`: assigned JobCards in `NEW`, `PLANNED`, or `IN_PROGRESS`
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
must be active and belong to the authenticated organization.

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
q
limit
offset
```

`type` accepts exactly `PRODUCT_DELIVERY`, `GENERAL_TASK`, or `SALES_MEETING`. Repeated scalar filters,
unknown values, and unknown query keys return `400 VALIDATION_ERROR`.

The list response is canonical and paginated. Board cards reuse the same item shape,
group only `NEW`, `PLANNED`, `IN_PROGRESS`, `WAITING_APPROVAL`, and
`REVISION_REQUESTED`, and expose `COMPLETED`/`CANCELLED` as counts. Mobile clients use
the list route and do not request the board projection.

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
}

type JobCardCreateInput =
  | ProductDeliveryCreateInput
  | GeneralTaskCreateInput
  | SalesMeetingCreateInput
```

Unknown fields and delivery-item fields are rejected. Product Delivery still requires a
Customer; General Task permits nullable Customer and Contact context; Sales Meeting
requires an active Customer and an organization-local planned calendar day in `dueDate`.
A non-null Contact requires an active same-organization Customer and must belong to it.

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
  "dueDate": "2026-07-16"
}
```

Allowed only in `NEW`, `PLANNED`, `IN_PROGRESS`, and `REVISION_REQUESTED` according to role and assignment. Status is not accepted. `WAITING_APPROVAL` rejects an in-place patch; the UI first invokes the named withdrawal command and then patches the resulting `IN_PROGRESS` card. `COMPLETED` and `CANCELLED` reject field patches.

When `assignedTo` changes, the successful patch appends `JOB_ASSIGNED`. Other meaningful field changes append `JOB_FIELDS_UPDATED` with bounded old/new values. A patch that changes assignment and other fields may append both canonical events in the same transaction because they represent different business facts.

## 11. Delivery Items

| Method | Path | Roles | Idempotency |
| --- | --- | --- | --- |
| GET | `/:jobCardId/delivery-items` | visibility | none |
| POST | `/:jobCardId/delivery-items` | edit policy | required |
| PATCH | `/:jobCardId/delivery-items/:itemId` | edit policy | not processed-cache by default |
| DELETE | `/:jobCardId/delivery-items/:itemId` | edit policy | not processed-cache by default |

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
- Quantity is greater than zero.
- Purpose is one canonical delivery purpose.
- Delivered time is present and valid.
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
non-meeting parent returns `409 INVALID_JOB_TYPE`. `NEW`, `PLANNED`, `WAITING_APPROVAL`,
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
Meeting note creation is limited to `IN_PROGRESS` and `REVISION_REQUESTED`; `NEW`,
`PLANNED`, review, and terminal states return exact `409 JOB_NOT_EDITABLE`. Note reads remain
available for persisted read-only history. Successful addition atomically appends `NOTE_ADDED`.
Notes are append-only through the application contract; no public or repository
update/delete operation exists.

## 14. Named JobCard Commands

There is no generic transition route.

| Method | Path | From | To | Roles |
| --- | --- | --- | --- | --- |
| POST | `/:id/plan` | NEW | PLANNED | staff own, manager, admin |
| POST | `/:id/start` | NEW or PLANNED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/submit-for-approval` | IN_PROGRESS | WAITING_APPROVAL | staff own, manager, admin |
| POST | `/:id/approve` | WAITING_APPROVAL | COMPLETED | manager, admin |
| POST | `/:id/request-revision` | WAITING_APPROVAL | REVISION_REQUESTED | manager, admin |
| POST | `/:id/withdraw-from-approval` | WAITING_APPROVAL | IN_PROGRESS | assigned staff, manager, admin |
| POST | `/:id/resume` | REVISION_REQUESTED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/cancel` | NEW, PLANNED, IN_PROGRESS, WAITING_APPROVAL, or REVISION_REQUESTED | CANCELLED | assigned staff own, manager, admin |

Base lifecycle command body:

```json
{
  "clientActionId": "uuid",
  "expectedVersion": 6,
  "note": "İşlem açıklaması"
}
```

`request-revision` requires `revisionReason`; `cancel` requires `cancelReason` according to cancellation policy.

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

`meetingAt` may be at most 15 minutes after the authoritative request time. A non-null
follow-up must be later than the meeting; `FOLLOW_UP_REQUIRED` does not make follow-up
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

Approval appends `JOB_APPROVED`. Revision appends `JOB_REVISION_REQUESTED`. Resume appends `JOB_RESUMED`. Cancel appends `JOB_CANCELLED`. Plan and start append `JOB_PLANNED` and `JOB_STARTED`.

## 15. Board Read Projection

`GET /api/job-cards/board` may return grouped lists without becoming a second data source:

```json
{
  "columns": {
    "NEW": { "items": [], "count": 0 },
    "PLANNED": { "items": [], "count": 0 },
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
