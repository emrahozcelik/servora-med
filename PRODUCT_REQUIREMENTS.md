# Servora-Med Product Requirements

> Date: 2026-07-10  
> Status: Approved Phase 0 product requirements  
> Responsibility: Product scope and business behavior SSOT

Technical architecture belongs to `SERVORA_MED_ARCHITECTURE_PLAN.md`; data design belongs to `SERVORA_MED_SCHEMA_DRAFT.md`; API behavior belongs to `SERVORA_MED_API_DRAFT.md`; delivery order belongs to `SERVORA_MED_MVP_SLICES.md`; durable decisions belong to `DECISIONS.md`.

## Purpose

Servora-Med is a browser-based B2B operations platform for medical and dental product companies. It combines customer relationship management, product-delivery recording, staff work tracking, manager approval, and operational reporting around one central domain object: `JobCard`.

The product must provide the speed of a card-based workflow without sacrificing structured commercial data, role boundaries, auditability, or backend-owned business rules.

## Users and Roles

### Admin

- Manages users and roles.
- Has organization-wide operational visibility.
- Performs manager actions when authorized by the same domain rules.
- Cannot bypass immutable completed or cancelled records in MVP.

### Manager

- Views organization-wide JobCards and operational summaries.
- Assigns and reassigns work.
- Approves work submitted by staff or requests revision.
- Manages customers, contacts, and products.

### Staff

- Creates JobCards assigned to themselves.
- Views and works only on JobCards assigned to themselves.
- Records product deliveries and notes.
- Submits completed work for approval.
- Cannot directly mark a JobCard as `COMPLETED`.

All permissions are enforced by the backend. Hiding an action in the UI is not authorization.

## Core Workflows

### Product delivery

```text
Staff signs in
  -> creates a PRODUCT_DELIVERY JobCard
  -> adds one or more delivery items
  -> records delivery purpose, quantity, and delivered time
  -> starts the JobCard
  -> submits it for approval
Manager reviews the immutable submission
  -> approves it
  -> or requests revision with a reason
```

### General task

```text
Staff or manager creates a GENERAL_TASK
  -> assignee starts the task
  -> assignee submits it for approval
Manager approves or requests revision
```

### Revision

When a manager requests revision, the reason is mandatory. The JobCard returns to the assignee, who resumes it, corrects the data, and submits it again. The previous attempt remains visible in the activity history.

## JobCard Types and Lifecycle

### Pilot core types

- `PRODUCT_DELIVERY`
- `GENERAL_TASK`

### Deferred structured type

`SALES_MEETING` is delivered in a later, explicit slice after its structured meeting details are designed. The intended details are meeting time, outcome, follow-up time, and summary. It is not an active pilot-core type.

### Lifecycle

```text
NEW -> PLANNED -> IN_PROGRESS -> WAITING_APPROVAL -> COMPLETED
                              -> REVISION_REQUESTED -> IN_PROGRESS
NEW | PLANNED | IN_PROGRESS | REVISION_REQUESTED -> CANCELLED
```

Allowed transitions are explicit backend commands. Status is never free text and cannot be changed by a generic field update.

### Lifecycle invariants

- Staff can never transition directly to `COMPLETED`.
- Only manager or admin can approve a `WAITING_APPROVAL` JobCard.
- Revision requires a non-empty reason.
- Commercial fields are immutable for staff and manager while `WAITING_APPROVAL`.
- `COMPLETED` and `CANCELLED` JobCards are immutable in MVP.
- Admin override and lifecycle reversal are outside MVP.

## Product Delivery Requirements

Before a `PRODUCT_DELIVERY` JobCard can be submitted for approval, it must have:

- customer
- assigned staff user
- at least one delivery item
- active product reference for every item
- quantity greater than zero for every item
- `deliveryPurpose` for every item
- `deliveredAt` for every item

Allowed delivery purposes:

- `SALE`
- `SAMPLE`
- `CONSIGNMENT`
- `RETURN`
- `OTHER`

`CONSIGNMENT` and `RETURN` are operational classifications only. They do not create or alter stock movements in MVP.

MVP does not record unit price, discount, line total, revenue, margin, commission, invoice state, payment state, or accounting entries. Staff performance is measured through delivery purpose and product quantity, not financial amounts.

Lot number, serial number, and expiry date may be recorded when available. They are optional and are not controlled by product-level tracking flags in MVP.

## Approval and Revision Rules

- Staff submission moves the JobCard to `WAITING_APPROVAL` and records who submitted it and when.
- Submission validates type-specific requirements before changing state.
- Manager approval moves the JobCard from `WAITING_APPROVAL` to `COMPLETED` and records approver, time, and optional note.
- Manager revision request moves the JobCard to `REVISION_REQUESTED` and records manager, time, and mandatory reason.
- A manager cannot silently edit commercial fields while reviewing a submission.
- Every lifecycle command is transactional and idempotent where it creates an important business event.
- Conflicting concurrent JobCard updates are rejected rather than silently overwritten.

## Activity and Audit Requirements

The system stores both current state and append-only activity history.

Activity is required for:

- JobCard creation and assignment
- planning and starting
- approval submission
- manager approval
- revision request and resume
- cancellation
- commercial field updates
- delivery-item add, update, and removal
- note addition

Lifecycle activities include old and new status. A second generic status-change event is not created for the same command.

JobCard activity is not a general system audit log. Future organization-setting audit must use a separate design.

## Mobile and Desktop Experience

### Mobile

- Primary staff workflows are designed for approximately 390 CSS px and one-hand use.
- A seven-column desktop Kanban is not squeezed into the mobile viewport.
- Mobile uses status filters, lists, and clear primary actions.
- Drag and drop is never the only way to change status.
- Loading, success, error, empty, offline/retry, and version-conflict states are visible.

### Desktop

- Managers can scan the operation through a Kanban or structured list.
- Completed and cancelled work is limited, collapsed, or filtered by default so the board remains usable.
- Dense information is allowed when it improves oversight, but small-font ERP layouts are not.

UI strategy, brand personality, anti-references, and accessibility requirements are defined in `PRODUCT.md` and decision `UI-001` in `DECISIONS.md`.

## Reports and Staff Profiles

Staff profiles are part of MVP and can show, subject to permission rules:

- open JobCards
- waiting-approval JobCards
- revision-requested JobCards
- overdue JobCards
- completed JobCards
- product-delivery history
- delivery quantities grouped by purpose
- monthly operational summary

Managers can view organization staff profiles. Staff can view only their own profile unless explicitly authorized. Reports are derived from persisted backend data, never frontend state.

Financial performance, revenue, margin, accounting, and inventory valuation reports are outside MVP.

## Configurability Boundary

Servora-Med may support controlled user preferences and saved views. Configuration cannot modify:

- canonical domain fields
- JobCard lifecycle and transition rules
- manager approval requirement
- role permissions
- required product-delivery data
- organization ownership boundary
- idempotency and concurrency behavior
- activity and audit obligations
- completed and cancelled record immutability

User-defined physical database tables, custom fields, form builders, workflow builders, and unrestricted JSON configuration are outside MVP.

Company profile fields may be managed within admin scope. Small user preferences may be introduced with the Kanban UI when a verified need exists. Shared card layouts and configurable field ordering require post-pilot validation.

## MVP Scope

- Secure authentication and admin bootstrap
- Admin, manager, and staff roles
- Users and staff profiles
- Customers and contacts
- Product catalog without stock quantity
- `PRODUCT_DELIVERY` and `GENERAL_TASK` JobCards
- Explicit backend state machine
- Product delivery purpose, quantity, and delivered time
- Manager approval and revision workflow
- Notes and append-only activity timeline
- Mobile staff workflow
- Desktop manager Kanban or list
- Staff and operational reports
- VPS deployment guidance
- Backup and restore procedure
- WCAG 2.2 Level AA as a completion criterion

The MVP Product catalog is informational rather than an inventory, accounting, or ERP
master. Only Product name is user-required. SKU, brand, category, model, unit, and
reference price are optional. SKU has no uniqueness, format, stock, or accounting meaning.
Reference price has no currency, sales-total, invoice, or valuation behavior and is never
copied into delivery items. Product deactivation prevents future selection without
rewriting historical delivery snapshots.

## Out of Scope

- Native mobile application
- Offline-first local database
- Warehouse and stock movements
- Accounting, invoices, payments, and e-invoice integration
- Revenue, margin, discount, and commission tracking
- Full quote, order, invoice, and collection chain
- Attachments and file upload in the pilot core
- SMS, WhatsApp, and notification system
- Native multi-tenant SaaS administration
- User-defined tables, custom fields, form builder, and workflow designer
- Mandatory drag and drop
- Mandatory WebSocket realtime
- Advanced BI dashboard
- Restaurant POS tables, orders, payments, shifts, printers, or roles

## Pilot Success Criteria

The pilot is ready when:

1. Authentication and all three roles enforce backend permissions.
2. Staff can complete the product-delivery workflow on a mobile browser.
3. A product delivery cannot reach approval without purpose, delivered time, product, and positive quantity.
4. Staff cannot approve; manager can approve or request revision.
5. Duplicate critical commands do not create duplicate business events.
6. Concurrent stale JobCard writes return a clear version conflict.
7. Every critical mutation creates the canonical activity event in the same transaction.
8. Organization ownership prevents cross-organization relationships and access.
9. Manager can inspect approval queues and staff operational summaries.
10. Critical flows meet WCAG 2.2 AA acceptance requirements.
11. Backend build/tests and web build pass.
12. Deployment, backup, and restore instructions are verified for the VPS target.
