# Servora-Med Schema Draft

> Date: 2026-07-10  
> Status: Living schema contract; implemented incrementally through slice migrations
> Responsibility: Data model, database constraints, and persisted invariant SSOT

Product behavior is defined in `PRODUCT_REQUIREMENTS.md`. Architecture boundaries are defined in `SERVORA_MED_ARCHITECTURE_PLAN.md`. API JSON uses camelCase; database columns use snake_case.

## 1. Global Data Rules

- PostgreSQL 16 or newer
- UUID primary keys generated with `gen_random_uuid()`
- `TIMESTAMPTZ` for instants; `DATE` only for date-only business values
- Quantity uses `NUMERIC(12,3)` and must be greater than zero
- Money fields do not exist in the MVP delivery model
- Business history uses status-based deactivation or append-only records instead of hard deletion
- `organization_id` is an ownership boundary even though V1 runs one organization
- Critical multi-row mutations and their activity events use one transaction
- Applied migrations are never edited

## 2. Controlled Vocabularies

### user_role

```text
admin | manager | staff
```

### customer_type

```text
clinic | hospital | dealer | company | other
```

### customer_status

```text
prospect | active | inactive
```

### job_card_type

```text
PRODUCT_DELIVERY | GENERAL_TASK | SALES_MEETING
```

Quote and collection types are outside MVP.

### job_card_status

```text
NEW | PLANNED | IN_PROGRESS | WAITING_APPROVAL | REVISION_REQUESTED | COMPLETED | CANCELLED
```

### job_card_priority

```text
low | normal | high | urgent
```

### delivery_purpose

```text
SALE | SAMPLE | CONSIGNMENT | RETURN | OTHER
```

### activity_event_type

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

### idempotency_status

```text
processing | completed | failed
```

## 3. MVP Tables

### 3.1 organizations

One organization per V1 deployment.

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| name | VARCHAR(255) NOT NULL | |
| timezone | VARCHAR(64) NOT NULL | default `Europe/Istanbul` |
| is_active | BOOLEAN NOT NULL | default true |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

### 3.2 users

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| name | VARCHAR(255) NOT NULL | |
| email | VARCHAR(255) NOT NULL | normalized for login |
| password_hash | VARCHAR(255) NOT NULL | raw password never persisted |
| role | VARCHAR(20) NOT NULL | `user_role` check |
| must_change_password | BOOLEAN NOT NULL | default false |
| is_active | BOOLEAN NOT NULL | default true |
| version | INTEGER NOT NULL | default 1; optimistic concurrency |
| last_login_at | TIMESTAMPTZ NULL | |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

Constraints and indexes:

- unique index on `lower(email)` for unambiguous V1 email login
- index on `(organization_id, role)`
- partial index on `(organization_id)` where `is_active = true`

### 3.3 sessions

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| user_id | UUID NOT NULL | FK to users |
| token_hash | VARCHAR(255) NOT NULL | unique; raw token never persisted |
| expires_at | TIMESTAMPTZ NOT NULL | |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| revoked_at | TIMESTAMPTZ NULL | set by logout or forced revoke |

Indexes:

- unique on `token_hash`
- index on `user_id`
- index on `expires_at` for cleanup

### 3.4 staff_profiles

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| user_id | UUID NOT NULL | FK to users; unique |
| title | VARCHAR(255) NULL | |
| phone | VARCHAR(50) NULL | |
| region | VARCHAR(100) NULL | |
| manager_user_id | UUID NULL | FK to users |
| version | INTEGER NOT NULL | default 1; optimistic concurrency |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

Profile lifecycle follows `users.is_active`. No duplicate active flag, internal notes, or undefined target value is stored. Profile user and optional manager must belong to the same organization; the user must have role `STAFF`, and the manager must be an active `MANAGER` according to backend invariants.

### 3.5 audit_events

People, security, CRM, and Product administration use an audit stream separate from JobCard activity.

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| actor_user_id | UUID NOT NULL | same-organization FK to users |
| subject_type | VARCHAR(40) NOT NULL | `USER`, `STAFF_PROFILE`, `CUSTOMER`, `CONTACT`, or `PRODUCT` |
| subject_id | UUID NOT NULL | audited subject identifier |
| event_type | VARCHAR(80) NOT NULL | canonical People, CRM, or Product audit event |
| old_value | JSONB NULL | safe changed fields only |
| new_value | JSONB NULL | safe changed fields only |
| metadata | JSONB NOT NULL | default empty object |
| created_at | TIMESTAMPTZ NOT NULL | default now |

Passwords, password hashes, temporary passwords, tokens, cookies, and session identifiers are forbidden in audit payloads.

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

Canonical Product audit events are:

```text
PRODUCT_CREATED
PRODUCT_FIELDS_UPDATED
PRODUCT_ACTIVATED
PRODUCT_DEACTIVATED
```

### 3.6 customers

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| name | VARCHAR(255) NOT NULL | |
| customer_type | VARCHAR(30) NOT NULL | `customer_type` check |
| tax_number | VARCHAR(50) NULL | normalized; unique per organization when present |
| phone | VARCHAR(50) NULL | |
| email | VARCHAR(255) NULL | |
| city | VARCHAR(100) NULL | |
| district | VARCHAR(100) NULL | |
| address | TEXT NULL | |
| assigned_staff_user_id | UUID NULL | FK to users |
| status | VARCHAR(20) NOT NULL | `customer_status` check |
| version | INTEGER NOT NULL | default 1; optimistic concurrency |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

Customer lifecycle has one source: `status`. There is no second `is_active` field.
Customer tax numbers are normalized before persistence and unique per organization when present. Customer references use composite organization-scoped foreign keys.

Indexes:

- `(organization_id, name)`
- `(organization_id, assigned_staff_user_id)`
- `(organization_id, status)`

### 3.7 contacts

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| customer_id | UUID NOT NULL | FK to customers |
| name | VARCHAR(255) NOT NULL | |
| title | VARCHAR(255) NULL | |
| phone | VARCHAR(50) NULL | |
| email | VARCHAR(255) NULL | |
| is_primary | BOOLEAN NOT NULL | default false |
| is_active | BOOLEAN NOT NULL | default true |
| version | INTEGER NOT NULL | default 1; optimistic concurrency |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

The contact and its customer must belong to the same organization through a composite foreign key. At most one active primary Contact may exist per Customer, enforced by a partial unique index on `(organization_id, customer_id)` where `is_primary = true` and `is_active = true`.

### 3.8 products

Informational catalog only; no stock, accounting, pricing-engine, or ERP-master behavior.

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| sku | VARCHAR(100) NULL | optional; duplicates allowed; no case conversion |
| name | VARCHAR(255) NOT NULL | |
| brand | VARCHAR(100) NULL | |
| category | VARCHAR(100) NULL | simple MVP text |
| model | VARCHAR(100) NULL | |
| unit | VARCHAR(30) NULL | optional informational text; no default |
| default_price | NUMERIC(12,2) NULL | null or non-negative reference only; API `referencePrice` |
| is_active | BOOLEAN NOT NULL | default true |
| version | INTEGER NOT NULL | default 1; optimistic concurrency |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

There is no SKU uniqueness or format constraint. Product name may also repeat. Optional
text is trimmed by the service and empty values are persisted as `NULL`.

Product-level lot, serial, and expiry requirement flags are not part of MVP.

### 3.9 job_cards

Optimistic concurrency column:

```text
version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
```

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| type | VARCHAR(40) NOT NULL | `job_card_type` check |
| status | VARCHAR(30) NOT NULL | default `NEW`; status check |
| version | INTEGER NOT NULL | default 1; greater than zero |
| title | VARCHAR(255) NOT NULL | |
| description | TEXT NULL | |
| customer_id | UUID NULL | FK to customers |
| contact_id | UUID NULL | composite organization-scoped FK to contacts |
| assigned_to | UUID NOT NULL | FK to users |
| created_by | UUID NOT NULL | FK to users |
| priority | VARCHAR(20) NOT NULL | default `normal` |
| due_date | DATE NULL | |
| planned_at | TIMESTAMPTZ NULL | |
| started_at | TIMESTAMPTZ NULL | |
| staff_completed_at | TIMESTAMPTZ NULL | approval-submission time |
| staff_completed_by | UUID NULL | FK to users |
| staff_completion_note | TEXT NULL | |
| manager_approved_at | TIMESTAMPTZ NULL | |
| manager_approved_by | UUID NULL | FK to users |
| manager_approval_note | TEXT NULL | |
| revision_requested_at | TIMESTAMPTZ NULL | |
| revision_requested_by | UUID NULL | FK to users |
| revision_reason | TEXT NULL | |
| cancelled_at | TIMESTAMPTZ NULL | |
| cancelled_by | UUID NULL | FK to users |
| cancel_reason | TEXT NULL | |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

Indexes:

- `(organization_id, status)`
- `(organization_id, assigned_to, status)`
- `(organization_id, type, status)`
- `(organization_id, customer_id)`
- `(organization_id, contact_id)`
- partial `(organization_id, due_date)` for active statuses
- `(organization_id, created_at DESC)`

Persisted integrity:

- `version > 0`
- `COMPLETED` requires manager approval identity and time
- `WAITING_APPROVAL` requires staff submission identity and time
- `REVISION_REQUESTED` requires a non-empty revision reason
- `CANCELLED` requires cancellation identity, time, and reason according to command policy

The service remains responsible for transition order, authorization, type-specific submit requirements, and immutable-state rules.

### 3.10 job_card_delivery_items

Only `PRODUCT_DELIVERY` JobCards can own delivery items.

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| job_card_id | UUID NOT NULL | FK to job_cards; delete restricted |
| product_id | UUID NOT NULL | FK to products |
| delivery_purpose | VARCHAR(20) NOT NULL | `delivery_purpose` check |
| delivered_at | TIMESTAMPTZ NOT NULL | actual delivery time |
| quantity | NUMERIC(12,3) NOT NULL | check greater than zero |
| unit | VARCHAR(30) NULL | optional product snapshot; no invented default |
| product_name_snapshot | VARCHAR(255) NOT NULL | |
| product_sku_snapshot | VARCHAR(100) NULL | |
| product_model_snapshot | VARCHAR(100) NULL | |
| lot_no | VARCHAR(100) NULL | optional |
| serial_no | VARCHAR(100) NULL | optional |
| expiry_date | DATE NULL | optional |
| delivery_note | TEXT NULL | |
| sort_order | INTEGER NOT NULL | default 0 |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| updated_at | TIMESTAMPTZ NOT NULL | default now |

Indexes:

- `(job_card_id, sort_order)`
- `(organization_id, job_card_id)`
- `(organization_id, product_id, delivered_at)`
- `(organization_id, delivery_purpose, delivered_at)`

There are no unit-price, discount, line-total, stock-movement, invoice, or payment fields.

### 3.11 job_card_notes

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| job_card_id | UUID NOT NULL | FK to job_cards |
| author_id | UUID NOT NULL | FK to users |
| note | TEXT NOT NULL | non-empty after trim |
| created_at | TIMESTAMPTZ NOT NULL | default now |

Notes are append-only through the MVP application contract. Public routes, service and
repository surfaces expose no note update/delete operation, and the UI exposes no such
control. This does not claim physical immutability for controlled database maintenance;
no mutation-prevention trigger is required. Staff may add a note to their own JobCard in
every lifecycle state, including review and terminal states, without changing its version
or unlocking commercial fields.

### 3.12 job_card_activity_logs

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| job_card_id | UUID NOT NULL | FK to job_cards |
| actor_id | UUID NULL | FK to users; null for system actor |
| event_type | VARCHAR(50) NOT NULL | canonical activity check |
| old_value | JSONB NULL | |
| new_value | JSONB NULL | |
| metadata | JSONB NULL | bounded event metadata |
| client_action_id | VARCHAR(255) NULL | correlation |
| created_at | TIMESTAMPTZ NOT NULL | default now |

Indexes:

- `(job_card_id, created_at, id)`
- `(organization_id, created_at DESC)`
- `(organization_id, event_type, created_at DESC)`

Application permissions expose no update or delete path.

### 3.13 processed_actions

Used only for critical business commands.

| Column | Type | Rules |
| --- | --- | --- |
| id | UUID PK | |
| organization_id | UUID NOT NULL | FK to organizations |
| user_id | UUID NOT NULL | FK to users |
| client_action_id | VARCHAR(255) NOT NULL | |
| operation_key | VARCHAR(100) NOT NULL | canonical command name |
| status | VARCHAR(20) NOT NULL | idempotency status check |
| status_code | INTEGER NULL | |
| response_body | JSONB NULL | |
| error_code | VARCHAR(50) NULL | |
| created_at | TIMESTAMPTZ NOT NULL | default now |
| completed_at | TIMESTAMPTZ NULL | |

Constraint: unique `(organization_id, user_id, client_action_id, operation_key)`.

Atomic sequence:

```text
insert processing claim
  -> execute service transaction and activity append
  -> store completed response
```

No business side effect occurs before the claim is secured.

## 4. Ownership Invariants

For every mutation, the authenticated organization must match all referenced records:

```text
job_card.organization_id
customer.organization_id
contact.organization_id
product.organization_id
delivery_item.organization_id
assigned_user.organization_id
actor.organization_id
```

The API never accepts organization ownership as a trusted client choice. Service validation is mandatory. Composite unique keys and foreign keys may reinforce ownership for relationships where the added constraint remains clear.

## 5. Domain Invariant Matrix

| Invariant | Protection |
| --- | --- |
| Staff cannot approve | service authorization and test |
| Approval only from `WAITING_APPROVAL` | transition service and test |
| Product delivery requires customer, assignee, valid items | transaction query and test |
| Delivery item requires purpose, delivered time, product, positive quantity | DB checks plus service |
| Review-state commercial fields are immutable | service update policy |
| Completed and cancelled are immutable | service update policy |
| Revision requires reason | service plus persisted check |
| Lifecycle activity uses same transaction | service transaction test |
| Duplicate critical command is safe | processed-action unique claim |
| Stale JobCard update does not overwrite | atomic version predicate |
| Cross-organization reference is rejected | service plus selected composite constraints |
| Login email is unambiguous | global unique index on `lower(email)` |
| Stale Customer or Contact mutation does not overwrite | atomic version predicate |
| Customer assignee is active same-organization Staff | service validation under User lock |
| At most one active primary Contact exists | partial unique index plus transaction policy |
| Customer or Contact with active JobCards cannot deactivate | locked guard query and service test |
| Staff deactivation clears Customer assignments atomically | caller-owned People transaction plus CRM cleanup port |

Cross-module mutations use the lock order `users -> customers -> contacts -> job_cards`.
Multiple rows of the same type are locked in stable UUID order. Customer/Contact
lifecycle guards, JobCard relationship validation, and Staff-assignment cleanup reuse
the caller-owned transaction so the eligibility check cannot interleave with the write.

## 6. Structured Sales Meeting

Migration `007_sales_meeting.sql` adds the third type, the fifteenth canonical activity
event `MEETING_DETAILS_UPDATED`, and this one-to-one detail table together:

```text
job_card_meeting_details
- job_card_id
- organization_id
- meeting_at
- outcome
- next_follow_up_at
- meeting_summary
```

`job_card_id` is the primary key. `(organization_id, job_card_id)` references the parent
JobCard ownership key with `ON DELETE RESTRICT`. Draft result fields are nullable;
`outcome`, when present, is one of `POSITIVE`, `FOLLOW_UP_REQUIRED`, `NO_DECISION`, or
`NOT_INTERESTED`. A summary is at most 4000 characters and contains at least one
non-whitespace character. A non-null `next_follow_up_at` requires a non-null
`meeting_at` and must be strictly later. The partial
`meeting_details_org_time_job_idx` indexes only rows with actual meeting time.

The database does not infer the parent type through a trigger. Create and mutation
services enforce that only `SALES_MEETING` owns a detail row, while PostgreSQL integration
tests protect the one-to-one, ownership, vocabulary, chronology, and migration rollback
contracts. `job_cards.version` remains the only concurrency version.

## 7. Development Seed and Production Bootstrap

Development and test reference data is loaded by:

```bash
npm run db:seed:dev
```

The command must refuse to run in production. It may create one organization, admin/manager/staff users, minimal customers, contacts, products, and representative JobCards.

Production creates the first admin through a separate bootstrap CLI or environment-controlled one-shot command. Known demo credentials are never installed by a production migration.

## 8. Migration Groups

Applied slice-aligned migrations:

| Group | Content |
| --- | --- |
| `001_auth_foundation.sql` | organizations, users, sessions, auth indexes |
| `002_delivery_tracer.sql` | minimal customers, products, job_cards, delivery_items, activity, processed_actions |
| `003_people.sql` | user versions, organization timezone, staff_profiles, audit_events |
| `004_crm_contacts.sql` | versioned Customers, Contacts, JobCard Contact relationship, CRM indexes and audits |
| `005_product_catalog.sql` | nullable informational Product fields, Product versions/audits, duplicate SKU support, nullable delivery unit snapshots |
| `006_jobcard_workspace.sql` | application-contract append-only JobCard notes, workspace indexes, planned/started timestamp guards |
| `007_sales_meeting.sql` | Sales Meeting type/event vocabularies, one-to-one structured results, constraints and report index |

Applied migrations 001–007 are immutable. Reports and General Task required no schema
migration.

## 9. Explicit Omissions

- stock quantity and stock movements
- product tracking requirement flags
- price snapshot, discount, and delivery totals
- invoice and payment records
- backup status table
- attachments
- custom fields and settings JSON bags
- WebSocket event replay table
- quote and collection JobCard types
