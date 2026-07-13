# Servora-Med Customers and Contacts Design

**Date:** 2026-07-12
**Status:** Approved revised design
**Slice:** 05 — Customers and Contacts

## 1. Goal

Replace seed-only customer references with an organization-scoped CRM surface that keeps business entities, people, responsible Staff, and operational JobCard history unambiguous.

The first vertical path is:

```text
Manager creates a customer
→ optionally assigns one responsible Staff user
→ adds the customer's first Contact, which becomes primary
→ Staff reads the customer and Contact without mutation controls
→ Manager changes the primary Contact
→ Manager deactivates an eligible customer or Contact
```

## 2. Scope

### In scope

- Customer types `clinic`, `hospital`, `dealer`, `company`, and `other`
- Customer lifecycle `prospect`, `active`, and `inactive`
- Optional many-to-one responsible Staff assignment: each Customer may have zero or one responsible Staff user; one Staff user may be responsible for multiple Customers
- Nested Contact management under a Customer aggregate
- Optional Contact association on JobCards, constrained to the selected Customer
- Zero or one active primary Contact per customer
- Search, status, assignee, city, and unassigned filters
- Customer and Contact optimistic concurrency
- Explicit activation and deactivation commands
- CRM audit events in the existing management audit stream
- Admin/Manager mutation access and organization-wide Staff read access
- Mobile, keyboard, zoom/reflow, reduced-motion, and semantic accessibility acceptance

### Out of scope

- Multiple Staff assignments per customer
- Customer-level or Contact-level free-form notes
- JobCard note implementation and JobCard activity UI
- Confidential Staff-profile note implementation
- Related follow-up JobCard implementation beyond persisting the current Contact relationship
- Bulk import, merge, deduplication workflow, tags, custom fields, or attachments
- Geographic maps, route planning, realtime updates, or external CRM synchronization
- Customer deletion or Contact deletion

The deferred note and follow-up decisions are still binding: JobCard notes are shared append-only operational history; Staff-profile notes are management-confidential; deferred unfinished work stays on the same planned JobCard; completed work creates a linked follow-up JobCard instead of reopening the completed record.

## 3. Domain Boundary

Customer is the CRM aggregate root. A Contact cannot exist, move, activate, deactivate, or become primary outside its parent Customer boundary.

The backend module follows the existing modular-monolith separation:

```text
crm/routes.ts       endpoint wiring and guards
crm/handlers.ts     HTTP parsing and response mapping
crm/service.ts      permissions, invariants, transactions, and audit behavior
crm/repository.ts   organization-scoped PostgreSQL access
crm/types.ts        DTOs, row types, input types, and mapping
```

Customers are business entities. A solo doctor's practice is represented as a Customer such as `Dr. Ayşe Yılmaz Muayenehanesi`; the doctor remains a separate primary Contact. A record never switches ambiguously between company and person semantics.

## 4. Data Model

Migration `004_crm_contacts.sql` extends the minimal seeded `customers` table, creates `contacts`, adds the missing `job_cards.contact_id` relationship already present in the schema draft, and extends management-audit constraints for CRM subjects and events. The migration does not edit already-applied migrations.

### Customers

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | primary key |
| `organization_id` | UUID | not null, references `organizations` |
| `name` | VARCHAR(255) | not null, trimmed |
| `customer_type` | VARCHAR(30) | canonical type check |
| `tax_number` | VARCHAR(50) | nullable, normalized before persistence |
| `phone` | VARCHAR(50) | nullable |
| `email` | VARCHAR(255) | nullable, normalized when present |
| `city` | VARCHAR(100) | nullable |
| `district` | VARCHAR(100) | nullable |
| `address` | TEXT | nullable |
| `assigned_staff_user_id` | UUID | nullable, references `users` |
| `status` | VARCHAR(20) | `prospect`, `active`, or `inactive` |
| `version` | INTEGER | not null, default 1, greater than zero |
| `created_at` | TIMESTAMPTZ | not null, default current time |
| `updated_at` | TIMESTAMPTZ | not null, default current time |

There is no `customers.notes` or duplicate `is_active` column. Customer name, phone, and email are not unique. When present, a normalized tax number is unique within the organization through a partial unique index. Tax-number normalization trims the input, removes every whitespace character plus `.`, `-`, and `/`, uppercases letters, and persists `NULL` when the result is empty. Existing case-insensitive name matches from the normal search endpoint produce a non-blocking warning in the creation experience rather than a database rejection; MVP does not add fuzzy-search infrastructure.

### Contacts

| Column | Type | Rules |
| --- | --- | --- |
| `id` | UUID | primary key |
| `organization_id` | UUID | not null, references `organizations` |
| `customer_id` | UUID | not null, references `customers` |
| `name` | VARCHAR(255) | not null, trimmed |
| `title` | VARCHAR(255) | nullable |
| `phone` | VARCHAR(50) | nullable |
| `email` | VARCHAR(255) | nullable, normalized when present |
| `is_primary` | BOOLEAN | not null, default false |
| `is_active` | BOOLEAN | not null, default true |
| `version` | INTEGER | not null, default 1, greater than zero |
| `created_at` | TIMESTAMPTZ | not null, default current time |
| `updated_at` | TIMESTAMPTZ | not null, default current time |

There is no `contacts.notes`. Contact lifecycle uses only `is_active`; unlike Customer, Contact has no prospect state. A partial unique index enforces at most one row per customer where `is_primary = true AND is_active = true`.

### JobCard Contact relationship

`job_cards` gains nullable `contact_id`. When present, the Contact must belong to the authenticated organization and to the JobCard's selected Customer. Historical JobCards continue to resolve an inactive Contact. New or edited active JobCards may select only an active Contact under an eligible Customer.

### Database ownership constraints

Organization ownership is protected at the database layer as well as in service validation:

```text
contacts (organization_id, customer_id)
  → customers (organization_id, id)

customers (organization_id, assigned_staff_user_id)
  → users (organization_id, id)

job_cards (organization_id, contact_id)
  → contacts (organization_id, id)
```

Parent tables expose the required `UNIQUE (organization_id, id)` keys. `customers` and `users` already provide these keys in applied migrations; migration 004 adds them where still required. The service additionally validates that `job_cards.customer_id` equals the selected Contact's `customer_id`, because separate organization-level foreign keys alone cannot express that equality.

## 5. Ownership and Lifecycle Rules

### Responsible Staff

- `assigned_staff_user_id` is optional and represents one primary responsible Staff user.
- The assignee must be an active `STAFF` user in the authenticated organization.
- Admin and Manager may change the assignment; Staff may not.
- Deactivating a Staff user atomically clears that user from every Customer assignment, including inactive Customers, because the field represents current ownership rather than history.
- Historical JobCard assignments are not changed.
- Multiple Staff assignments and assignment roles are deferred until pilot evidence requires `customer_staff_assignments`.

When management creates a JobCard, the customer assignee may be suggested as the default assignee but may be changed. When Staff creates a JobCard, the assignee remains the authenticated Staff user; Staff cannot create work for another person. Defaults are UI suggestions, never a substitute for backend authorization.

### Primary Contact

- A customer may have zero or one active primary Contact.
- The first active Contact becomes primary automatically.
- Making another active Contact primary clears the previous primary in the same transaction.
- An inactive Contact cannot become primary.
- Deactivating the primary Contact leaves the customer without a primary Contact; the system does not guess a replacement.
- Reactivating a Contact does not make it primary; management uses the explicit `make-primary` command when required.
- A customer's active primary Contact may be suggested when creating a JobCard, but the submitted Contact must still be active, organization-owned, and attached to that Customer.

Contact creation always produces an active Contact. `POST` does not accept `isActive`; it accepts no lifecycle override. `PATCH` changes only `name`, `title`, `phone`, and `email` and rejects `isActive`, `isPrimary`, `customerId`, and `organizationId`. Activation, deactivation, and primary selection occur only through their named commands.

### Customer status state machine

Customer creation accepts an initial status of `prospect` or `active`; omission defaults to `prospect`. Lifecycle status is never accepted by general `PATCH`.

```text
prospect → activate   → active
active   → deactivate → inactive
prospect → deactivate → inactive
inactive → activate   → active
```

Commands outside the listed transitions return `409 INVALID_CUSTOMER_STATUS_TRANSITION` without mutation or audit. Reactivation always returns to `active`, never to `prospect`.

### Customer deactivation

A customer cannot be deactivated while it has a JobCard in any active workflow status:

```text
NEW
PLANNED
IN_PROGRESS
WAITING_APPROVAL
REVISION_REQUESTED
```

The command returns `409 CUSTOMER_HAS_ACTIVE_JOB_CARDS`. Management must complete, cancel, or intentionally move the active work before deactivation. Inactive customers and their historical JobCards remain readable, but inactive customers are excluded from new JobCard selectors. A customer may later be reactivated.

Customer deactivation does not cascade to Contacts. The Customer's Contacts retain their individual lifecycle state, are excluded from new JobCard selectors while the parent Customer is inactive, and become eligible again according to their own active state if the Customer is reactivated.

### Contact deactivation

A Contact cannot be deactivated while referenced by a JobCard in `NEW`, `PLANNED`, `IN_PROGRESS`, `WAITING_APPROVAL`, or `REVISION_REQUESTED`. The command returns `409 CONTACT_HAS_ACTIVE_JOB_CARDS`. Completed and cancelled JobCards retain and display the historical Contact even after later deactivation.

## 6. Authorization and Visibility

| Capability | Admin | Manager | Staff |
| --- | --- | --- | --- |
| List/read organization customers | yes | yes | yes |
| List/read organization Contacts | yes | yes | yes |
| Create/update customers | yes | yes | no |
| Activate/deactivate customers | yes | yes | no |
| Create/update Contacts | yes | yes | no |
| Activate/deactivate/make primary | yes | yes | no |
| Read CRM management audit | deferred | deferred | no |

All identifier lookups are constrained by authenticated `organization_id`. Missing and cross-organization records produce the same not-found behavior.

Customer detail does not widen JobCard visibility. Management may see all organization JobCards related to the customer; Staff may see only JobCards permitted by the existing assigned-Staff policy. JobCard notes appear only inside an accessible JobCard context. Confidential Staff-profile notes are never included in Customer, Contact, JobCard, or general Staff responses.

## 7. API Contract

### Customers

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| `GET` | `/api/customers` | authenticated | paginated organization list/search |
| `POST` | `/api/customers` | Admin, Manager | create customer |
| `GET` | `/api/customers/:customerId` | authenticated | customer detail, Contact summary, and role-scoped JobCard summaries |
| `PATCH` | `/api/customers/:customerId` | Admin, Manager | update editable fields |
| `POST` | `/api/customers/:customerId/activate` | Admin, Manager | activate eligible customer |
| `POST` | `/api/customers/:customerId/deactivate` | Admin, Manager | deactivate eligible customer |

Filters are `q`, `status`, `customerType`, `assignedStaffUserId`, `city`, `unassigned`, `limit`, and `offset`. The default status view includes `prospect` and `active` and hides `inactive`. Explicit filters can request inactive records. Customer `q` searches Customer name, normalized tax number, phone, and email plus Contact name, title, phone, and email through an organization-scoped `EXISTS` query. Search is case-insensitive and contains-based; fuzzy search is not part of MVP.

Customer `PATCH` accepts only `name`, `customerType`, `taxNumber`, `phone`, `email`, `city`, `district`, `address`, and `assignedStaffUserId`. It rejects `status`, `version`, `organizationId`, and lifecycle fields.

### Contacts nested under Customer

| Method | Path | Roles | Behavior |
| --- | --- | --- | --- |
| `GET` | `/api/customers/:customerId/contacts` | authenticated | paginated Contact list/search |
| `POST` | `/api/customers/:customerId/contacts` | Admin, Manager | create Contact |
| `GET` | `/api/customers/:customerId/contacts/:contactId` | authenticated | Contact detail |
| `PATCH` | `/api/customers/:customerId/contacts/:contactId` | Admin, Manager | update Contact fields |
| `POST` | `/api/customers/:customerId/contacts/:contactId/activate` | Admin, Manager | activate Contact |
| `POST` | `/api/customers/:customerId/contacts/:contactId/deactivate` | Admin, Manager | deactivate Contact |
| `POST` | `/api/customers/:customerId/contacts/:contactId/make-primary` | Admin, Manager | atomically select primary |

Contact list filters are `q`, `status=active|inactive|all`, `limit`, and `offset`; the default hides inactive Contacts. Contact `q` searches name, title, phone, and email case-insensitively. Contact `POST` creates an active Contact and does not accept `isActive` or `isPrimary`. Contact `PATCH` accepts only name, title, phone, and email.

Every DTO exposes `version`. `PATCH` and command requests require `expectedVersion`; the SQL mutation includes the version predicate and increments the affected record. Stale writes return `409 VERSION_CONFLICT` with `currentVersion` when safely available. Ordinary CRM CRUD does not use processed-action response caching.

The frontend disables a CRM submit action while its request is pending and does not automatically retry `POST` mutations. If a network result is unknown, it refetches the relevant list/detail before offering another submission. Create-command idempotency must be revisited before adding offline queues or automatic mutation retries.

### Existing JobCard contract extension

JobCard create and editable-field patch accept nullable `contactId`. When `contactId` is present, `customerId` must also be present and the locked Contact must be active and belong to that Customer and organization. Changing `customerId` without also supplying a compatible `contactId` clears the old Contact explicitly; the API never silently carries a Contact to a different Customer. JobCard responses include the persisted `contactId` for historical resolution.

Customer detail includes two bounded, backend-scoped collections: up to five JobCards in active workflow statuses and up to five most recently completed JobCards. Management receives organization-visible summaries; Staff receives only assigned JobCards. These summaries contain identifiers, title, status, assignee, due date, and relevant timestamps, not notes or full activity.

## 8. Error Contract

Canonical Slice 05 errors include:

```text
CUSTOMER_TAX_NUMBER_EXISTS
CUSTOMER_HAS_ACTIVE_JOB_CARDS
CUSTOMER_ASSIGNEE_NOT_ELIGIBLE
INVALID_CUSTOMER_STATUS_TRANSITION
CONTACT_NOT_IN_CUSTOMER
CONTACT_PRIMARY_REQUIRES_ACTIVE
CONTACT_HAS_ACTIVE_JOB_CARDS
VERSION_CONFLICT
```

Validation errors identify the invalid field and correction. Duplicate normalized tax numbers return `409 CUSTOMER_TAX_NUMBER_EXISTS`. Cross-organization input never reveals whether the supplied identifier exists.

## 9. Audit and Transaction Boundaries

Canonical CRM audit events are:

```text
CUSTOMER_CREATED
CUSTOMER_FIELDS_UPDATED
CUSTOMER_ASSIGNEE_CHANGED
CUSTOMER_ACTIVATED
CUSTOMER_DEACTIVATED
CONTACT_CREATED
CONTACT_FIELDS_UPDATED
CONTACT_MADE_PRIMARY
CONTACT_ACTIVATED
CONTACT_DEACTIVATED
```

They use the existing `audit_events` management stream and never enter the JobCard activity timeline. Each successful mutation and its audit event commit in the same transaction.

Migration 004 replaces the existing `audit_events.subject_type` and `audit_events.event_type` CHECK constraints with expanded constraints containing the People events plus the new `CUSTOMER` and `CONTACT` subjects and CRM events. Existing People audit rows remain valid throughout the migration.

Audit data includes organization, actor, subject type and ID, event type, timestamp, and safe changed-field names. It does not copy old/new phone, email, address, or full request payloads. Assignee changes may retain old/new user IDs; primary changes may retain old/new Contact IDs.

Atomic operations include:

- customer creation plus audit
- versioned customer update plus audit
- customer deactivation eligibility check, versioned status update, and audit
- first Contact creation, automatic primary selection, and audit
- primary replacement, both Contact updates, version handling, and audit
- Contact activation/deactivation plus primary invariant and audit
- Staff deactivation plus clearing every current customer assignment, as an extension of the People transaction

Any failure rolls back the entire operation.

People does not import or call the CRM repository directly. It depends on a narrow port implemented by CRM:

```text
CustomerAssignmentCleanupPort
  clearAssignmentsForDeactivatedStaff(organizationId, staffUserId, actorId, transaction)
```

The implementation clears every matching `assigned_staff_user_id`, increments affected Customer versions, and emits one `CUSTOMER_ASSIGNEE_CHANGED` event per Customer with old/new Staff IDs and `reason: STAFF_DEACTIVATED`. User deactivation, session revocation, assignment cleanup, People audit, and CRM audit share the caller-supplied transaction.

### Shared row-lock protocol

Services use one lock order to prevent check-then-act races and reduce deadlock risk:

```text
users → customers → contacts → job_cards
```

Rows of the same type are locked in stable UUID order when more than one may be touched.

- JobCard creation locks the assignee User, then selected Customer, then optional Contact. It verifies Staff eligibility, Customer eligibility, Contact activity, and Customer/Contact equality before insertion.
- Customer assignment changes lock the proposed assignee User before the Customer. Staff deactivation locks the User before all assigned Customer rows.
- Customer deactivation locks the Customer before checking active JobCards and updating status.
- Contact creation, activation, deactivation, and `make-primary` lock the parent Customer before Contact rows.
- Contact deactivation checks active JobCard references while holding the parent and Contact locks.
- JobCard relationship patches acquire Customer and optional Contact locks before the JobCard lock; ordinary JobCard lifecycle commands that do not change those relationships keep their existing JobCard lock behavior.

The partial primary-Contact unique index and composite foreign keys remain final database defenses, not substitutes for the locking protocol.

`make-primary` locks the parent Customer, then the target and current primary Contact rows in stable order. It validates the target's `expectedVersion`, activity, ownership, and parent; clears the previous primary with a version increment; sets the target primary with a version increment; writes one audit event; and returns the target's new version plus the previous primary Contact ID. The client does not submit the previous primary version because the transaction owns and locks that state.

## 10. Frontend Design

The workspace adds a `Müşteriler` section and introduces React Router as the application's navigation layer. This is the slice where list, customer detail, Contact detail/edit, browser Back, refresh restoration, direct links, and URL-persisted filters become required. Reimplementing those semantics over the native History API would create application-specific routing infrastructure with higher maintenance and accessibility risk.

React Router is the only new runtime dependency approved by this design. It replaces the growing top-level `screen` state navigation; it does not introduce a UI framework, data store, or server-rendering architecture. Existing login, forced-password, JobCard, Users, and Staff views receive stable routes without changing their domain behavior.

Initial route map:

```text
/login
/change-password
/jobs
/jobs/new-delivery
/jobs/:jobCardId
/users
/staff
/staff/:staffUserId
/customers
/customers/new
/customers/:customerId
/customers/:customerId/contacts/:contactId
```

Role guards remain backend-owned and are mirrored only for navigation usability. Direct navigation to a forbidden frontend route renders the established forbidden state rather than leaking data or silently redirecting to an unrelated screen. Customer filters use URL search parameters so Back, Forward, refresh, and copied links preserve the list context.

### Customer list

- Structured responsive cards/list rows rather than a compressed mobile table
- Search by customer name and supported contact information
- Filters for status, type, city, responsible Staff, and unassigned customers
- Default view hides inactive records
- Each item shows name, type, location summary, status, responsible Staff, and primary Contact when present
- Loading, empty, no-results, error/retry, and forbidden states are explicit

### Customer detail

```text
Customer identity and status
General information
Responsible Staff
Contacts
Accessible open work
Accessible JobCard history
```

The JobCard area is summary-only in Slice 05: at most five active JobCard summaries and five most recently completed JobCard summaries, constrained by the viewer's existing JobCard visibility. There is no JobCard note editor, activity timeline, reporting, or follow-up creation here. The full filtered JobCard-list destination and its `Tümünü gör` navigation are added with Slice 07; Slice 05 does not render a dead or misleading link.

There is no generic Customer notes editor. Operational notes remain attached to accessible JobCards. CRM audit is not exposed as a Staff timeline in this slice.

### Editing

- Admin/Manager see create and edit actions; Staff sees a read-only surface
- Contact creation is performed inside the Customer context
- Primary Contact is identified with text and icon, not color alone
- Deactivation requires an explicit confirmation and explains active-JobCard conflicts
- Similar customer names are shown as a non-blocking duplicate warning before creation
- Version conflicts preserve unsaved user input where safe and offer a reload action

### JobCard defaults

- Management sees the customer assignee suggested as JobCard assignee and may change it
- Staff-created JobCards remain assigned to the authenticated Staff user
- Active primary Contact is suggested as the selected Contact
- Inactive Customers and Contacts are absent from new JobCard selectors
- The backend validates every submitted relationship independently of frontend defaults

## 11. Accessibility Acceptance

- Primary actions and form controls use at least 44 by 44 CSS pixel interaction areas where applicable.
- List, detail, create, edit, filter, primary selection, and confirmation flows are keyboard usable with visible focus.
- Labels do not rely on placeholders; required and error states do not rely on color alone.
- Status and primary indicators include text or accessible names.
- Modal or dialog focus is contained, restored, and announced correctly.
- Result and conflict feedback uses an appropriate live region without notification noise.
- At 200 percent text size and supported 400 percent zoom, content reflows without losing primary actions or requiring page-level horizontal scrolling.
- At approximately 390 CSS pixels, list and form layouts remain usable without desktop-table compression.
- `prefers-reduced-motion: reduce` removes nonessential movement.
- Automated checks supplement manual keyboard, focus, zoom/reflow, touch-target, and screen-reader semantic checks.

## 12. Verification and Completion

Server tests cover:

- role and organization boundaries
- customer and Contact CRUD
- normalized tax-number uniqueness
- customer status transitions and lifecycle-field payload rejection
- responsible-Staff eligibility and clearing on Staff deactivation
- primary Contact creation, replacement, deactivation, and concurrent protection
- active-JobCard customer and Contact deactivation guards
- JobCard Contact association and Customer/Contact mismatch rejection
- shared lock ordering under concurrent create/deactivate/assignment scenarios
- composite organization foreign-key enforcement
- inactive default filters and explicit filtering
- version conflicts with no partial mutation or audit
- transaction rollback and canonical audit creation

Frontend tests cover:

- Admin/Manager write controls and Staff read-only behavior
- customer search and filters
- create/edit/deactivate/reactivate flows
- nested Contact and make-primary flows
- direct routes, browser Back/Forward, refresh restoration, and URL-persisted filters
- loading, empty, error, conflict, and retry states
- JobCard selector defaults and inactive-record exclusion
- accessibility contracts and critical keyboard flows

Required verification:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
cd web && npm test -- --run
```

Live PostgreSQL verification runs migration `004_crm_contacts.sql`, seeds development references, executes the authenticated CRM tracer flow, and verifies constraints, audit rows, rollback behavior, and organization isolation.

Slice 05 is complete only when the API and responsive UI provide the approved vertical path, all checks pass, and the slice SSOT documents reflect implemented behavior.
