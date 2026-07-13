# Servora-Med API Draft

> Date: 2026-07-10  
> Status: Living API contract; implemented through Slice 05 CRM
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
```

Validation details may identify fields but must not expose SQL, stack traces, hashes, tokens, cookies, or internal infrastructure.

## 2. Idempotency Contract

Critical business commands include `clientActionId` in their JSON body:

- JobCard creation
- delivery-item creation
- submit for approval
- approve
- request revision
- cancel

Rules:

- trimmed string, 1 to 255 characters
- scoped by organization, user, operation, and action identifier
- atomic processing claim before business side effects
- completed duplicate returns the original status and response body
- concurrent duplicate returns `409 ACTION_IN_PROGRESS`
- a failed command may return its recorded failure according to the processed-action policy

Ordinary profile, customer, contact, product, note, and field updates do not use full processed-response caching by default. Their validation, authorization, database constraints, and JobCard version checks still apply.

## 3. JobCard Concurrency Contract

Every JobCard DTO contains `version`.

These requests require `expectedVersion`:

- JobCard field patch
- delivery-item add, patch, and removal
- note addition when it updates JobCard activity/version
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

> Slice 06 approved target contract; implementation pending.

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
`referencePrice` is null, zero, or positive and has no currency, sales, invoice,
accounting, or stock-valuation meaning.

Create accepts only the Product fields and does not accept `expectedVersion`. Patch
accepts `expectedVersion` plus Product fields and rejects `isActive`, `status`, `version`,
`organizationId`, stock, cost, currency, and tracking-policy fields. There is no physical
delete or Product `DELETE` endpoint.

Patch and lifecycle commands compare `expectedVersion` atomically. Stale mutations return
`409 VERSION_CONFLICT`; repeated lifecycle commands return
`409 INVALID_PRODUCT_STATUS_TRANSITION`. Missing and cross-organization records return
the same `404 PRODUCT_NOT_FOUND`. Failed mutations create no partial write or audit.

Deactivation prevents new delivery selection and Product replacement only. Existing
delivery rows and snapshots remain unchanged. Quantity or note may still be edited when
the existing delivery item's `productId` is not replaced. A supplied replacement Product
must be active and belong to the authenticated organization.

Web clients use this endpoint as the canonical Product catalog source. JobCard backend
transactions use a transaction-scoped Product read and never call the Product HTTP API.
After web consumers migrate, `GET /api/reference/products` is removed.

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
| GET | `/board` | authenticated | optional grouped read projection |

List filters:

```text
status
type
assignedTo
customerId
priority
dueBefore
q
limit
offset
```

### POST `/api/job-cards`

Request:

```json
{
  "clientActionId": "uuid",
  "type": "PRODUCT_DELIVERY",
  "title": "ABC Klinik ürün teslimi",
  "description": "İmplant seti teslimi",
  "customerId": "uuid",
  "contactId": "uuid",
  "assignedTo": "uuid",
  "priority": "high",
  "dueDate": "2026-07-15"
}
```

Delivery items are not accepted in this request. Staff can assign only themselves; manager and admin can assign an eligible user in the same organization.

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

Allowed only in `NEW`, `PLANNED`, `IN_PROGRESS`, and `REVISION_REQUESTED` according to role and assignment. Status is not accepted. `WAITING_APPROVAL`, `COMPLETED`, and `CANCELLED` reject field patches.

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

## 12. Notes and Activity

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/:jobCardId/notes` | visibility | paginated notes |
| POST | `/:jobCardId/notes` | note policy | append non-empty note |
| GET | `/:jobCardId/activity` | visibility | paginated immutable timeline |

Note request:

```json
{
  "expectedVersion": 5,
  "note": "Teslim alan kişi bilgisi düzeltme notunda belirtildi."
}
```

Staff may add a note to their assigned JobCard in `WAITING_APPROVAL`; this does not unlock commercial fields. Successful addition appends `NOTE_ADDED`.

## 13. Named JobCard Commands

There is no generic transition route.

| Method | Path | From | To | Roles |
| --- | --- | --- | --- | --- |
| POST | `/:id/plan` | NEW | PLANNED | staff own, manager, admin |
| POST | `/:id/start` | NEW or PLANNED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/submit-for-approval` | IN_PROGRESS | WAITING_APPROVAL | staff own, manager, admin |
| POST | `/:id/approve` | WAITING_APPROVAL | COMPLETED | manager, admin |
| POST | `/:id/request-revision` | WAITING_APPROVAL | REVISION_REQUESTED | manager, admin |
| POST | `/:id/resume` | REVISION_REQUESTED | IN_PROGRESS | staff own, manager, admin |
| POST | `/:id/cancel` | active non-review state | CANCELLED | manager, admin; limited staff policy |

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

Submit records staff completion identity/time, changes status, increments version, and appends `JOB_SUBMITTED_FOR_APPROVAL` in one transaction.

### Approval and revision review lock

While `WAITING_APPROVAL`:

- Staff cannot patch commercial fields or delivery items.
- Manager and admin cannot patch commercial fields or delivery items.
- Manager and admin can approve or request revision.
- Notes follow the documented note policy.

Approval appends `JOB_APPROVED`. Revision appends `JOB_REVISION_REQUESTED`. Resume appends `JOB_RESUMED`. Cancel appends `JOB_CANCELLED`. Plan and start append `JOB_PLANNED` and `JOB_STARTED`.

## 14. Board Read Projection

`GET /api/job-cards/board` may return grouped lists without becoming a second data source:

```json
{
  "columns": {
    "NEW": { "items": [], "count": 0 },
    "PLANNED": { "items": [], "count": 0 },
    "IN_PROGRESS": { "items": [], "count": 0 },
    "WAITING_APPROVAL": { "items": [], "count": 0 },
    "REVISION_REQUESTED": { "items": [], "count": 0 },
    "COMPLETED": { "items": [], "count": 0 },
    "CANCELLED": { "items": [], "count": 0 }
  }
}
```

Completed and cancelled records are time-limited or paginated by default. Mobile clients can use the same data as filtered lists rather than seven columns.

## 15. Reports `/api/reports`

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| GET | `/dashboard` | admin, manager | organization operational counters |
| GET | `/staff/:userId` | admin, manager | scoped staff summary |
| GET | `/deliveries` | admin, manager | quantity by date, product, staff, and purpose |
| GET | `/approvals` | admin, manager | pending approval age and counts |

Delivery reports use persisted `deliveredAt`, purpose, and quantity. They do not return revenue, margin, commission, invoice, or payment metrics.

## 16. Health `/api/health`

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| GET | `/` | public | generic status only |
| GET | `/detailed` | admin | bounded database and migration state |

Unauthenticated health responses do not expose environment, host, filesystem, database name, migration filenames, or dependency versions.

## 17. DTO Shape

Conceptual JobCard response:

```ts
type JobCardDto = {
  id: string
  organizationId: string
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK'
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
  plannedAt: string | null
  startedAt: string | null
  staffCompletedAt: string | null
  staffCompletedBy: string | null
  staffCompletionNote: string | null
  managerApprovedAt: string | null
  managerApprovedBy: string | null
  managerApprovalNote: string | null
  revisionRequestedAt: string | null
  revisionRequestedBy: string | null
  revisionReason: string | null
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  createdAt: string
  updatedAt: string
}
```

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

## 18. Explicitly Absent API Areas

- stock and warehouse mutations
- invoices, payments, revenue, margins, and commissions
- attachment upload
- notification preferences without a notification system
- user-defined tables, fields, forms, or workflows
- generic JobCard transition endpoint
- public unauthenticated CRM endpoints
- restaurant tables, orders, payments, shifts, and printer routes
- WebSocket as an MVP requirement
