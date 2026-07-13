# Product Catalog Design

> Date: 2026-07-13
> Status: Approved design; implementation not started
> Slice: 06 — Product Catalog

## 1. Purpose

Slice 06 replaces seeded Product reference data with a maintainable, role-aware catalog.
The catalog exists to make Products easy to find and select in operational JobCards. It
is not an inventory master, warehouse system, accounting product card, price book, or ERP
integration boundary.

The guiding product statement is:

> A flexible informational catalog that supports Product selection and operational history.

## 2. Goals

- Admin and Manager can create, update, search, activate, and deactivate Products.
- Staff can read the organization catalog but cannot mutate it.
- A Product can be created with only a non-empty name.
- Informational fields remain optional and lightly validated.
- Concurrent management edits do not silently overwrite one another.
- Deactivation prevents new selection without changing historical delivery snapshots.
- Product management and selection meet the shared WCAG 2.2 AA criteria.

## 3. Non-Goals

Slice 06 does not add:

- stock quantity or stock movement
- warehouse location or availability
- barcode management
- SKU normalization or uniqueness
- lot, serial, or expiry requirements
- costing, valuation, margin, or commission
- currency, price history, or price lists
- invoice, payment, order, or accounting behavior
- brand, category, or unit dictionaries
- a custom taxonomy or Product configuration framework

Optional lot, serial, and expiry values already supported on a delivery item remain
operational notes. They do not become Product-level tracking policy.

## 4. Product Model

User-entered required field:

```text
name
```

System-owned required fields:

```text
organizationId
isActive
version
```

Optional informational fields:

```text
sku
brand
category
model
unit
referencePrice
```

Rules:

- `name` is trimmed and rejected when empty.
- Optional text is trimmed; an empty result is persisted as `null`.
- SKU casing and punctuation are preserved.
- SKU and Product name may repeat within an organization.
- `referencePrice` is `null`, zero, or positive; negative values are rejected.
- `referencePrice` has no currency, sales-total, invoice, accounting, or valuation meaning.
- `unit` has no default. An absent unit remains unknown rather than becoming `adet`.
- New Products are active with version 1.

The existing database column `default_price` remains in place. The module maps it to the
API and UI name `referencePrice`; no column rename is needed.

## 5. Authorization and Ownership

| Capability | Admin | Manager | Staff |
| --- | --- | --- | --- |
| List and search Products | yes | yes | yes |
| Read Product detail | yes | yes | yes |
| Create Product | yes | yes | no |
| Update Product fields | yes | yes | no |
| Activate Product | yes | yes | no |
| Deactivate Product | yes | yes | no |

Every query and mutation is scoped by the authenticated organization. Missing and
cross-organization records return the same `404 PRODUCT_NOT_FOUND`. Frontend control
visibility is not an authorization boundary.

## 6. HTTP Contract

```text
GET   /api/products
POST  /api/products
GET   /api/products/:productId
PATCH /api/products/:productId

POST  /api/products/:productId/activate
POST  /api/products/:productId/deactivate
```

There is no Product `DELETE` endpoint. Active state changes only through named commands.

Create accepts:

```text
name
sku
brand
category
model
unit
referencePrice
```

Create does not accept `expectedVersion` because no persisted Product exists yet.

Patch accepts exactly:

```text
expectedVersion
name
sku
brand
category
model
unit
referencePrice
```

Patch rejects lifecycle, ownership, and out-of-scope fields, including:

```text
isActive
status
version
organizationId
stockQuantity
cost
currency
lotTracking
serialTracking
expiryTracking
```

Lifecycle commands accept only a positive integer `expectedVersion`.

## 7. Product List and Search

`GET /api/products` supports:

```text
q
status=active|inactive|all
limit
offset
```

Defaults:

```text
status=active
limit=50
offset=0
```

`limit` is between 1 and 200. `offset` is a non-negative integer. Unknown query
parameters are rejected. Search covers Product name, SKU, brand, category, and model.
Separate brand/category dictionaries and filters are deferred.

The response uses the established paginated shape `{ items, total, limit, offset }` to
avoid silent catalog truncation. The Product Delivery selector searches this endpoint with
`status=active`, `q`, `limit`, and `offset`; it does not assume all Products fit in one
fixed 200-record response. No third-party autocomplete dependency is required.

After every web consumer migrates, `GET /api/reference/products` is removed. The public
web client does not retain two Product-list contracts.

## 8. Lifecycle and Optimistic Concurrency

Lifecycle:

```text
create -> active
active -> deactivate -> inactive
inactive -> activate -> active
```

Repeated activation or deactivation returns `409 INVALID_PRODUCT_STATUS_TRANSITION`.
Patch, activate, and deactivate compare `expectedVersion` atomically. A stale mutation
returns `409 VERSION_CONFLICT`, may include a safe `currentVersion`, and creates no partial
write or audit event. Every successful mutation increments version once.

## 9. Module Boundary

Backend adds a focused module:

```text
products/
  types.ts
  repository.ts
  service.ts
  handlers.ts
  routes.ts
```

The module owns Product management, list/detail reads, permissions, lifecycle,
optimistic concurrency, and Product audit behavior.

`GET /api/products` is the canonical HTTP catalog source for web clients. The JobCard
backend never calls this HTTP endpoint. During a delivery-item transaction, JobCard uses
a transaction-scoped Product read operation to lock or read the referenced Product,
validate organization ownership and active state when selection changes, and create the
delivery snapshot. Products does not depend on JobCards.

## 10. Delivery Snapshot Behavior

Product deactivation affects future selection only:

- inactive Products are excluded from new delivery-item selection
- an inactive Product cannot be supplied as a replacement `productId`
- existing delivery rows remain valid
- existing name, SKU, model, and unit snapshots remain unchanged
- changing catalog fields never rewrites historical delivery rows
- permitted quantity or note edits remain possible when `productId` is unchanged

When a new active `productId` is supplied, the transaction stores the current catalog
name and optional SKU, model, and unit as the new snapshot.

Reference and snapshot contracts make `sku`, `model`, and `unit` nullable. UI display is:

```text
unit present: 3 kutu
unit absent:  3
```

The system never invents `adet` for an unknown unit.

## 11. Migration 005

`005_product_catalog.sql` changes the existing schema rather than creating a second
Product table:

- add `products.version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)`
- make `products.sku` nullable
- remove organization/SKU uniqueness
- make `products.unit` nullable and remove its `adet` default
- make `job_card_delivery_items.unit` nullable
- protect `default_price` with a null-or-non-negative check
- extend audit subject constraints with `PRODUCT`
- extend audit event constraints with the four Product events

Migration implementation must verify the actual installed constraint names before
dropping them. Applied migrations 001–004 remain immutable. Existing Product and delivery
rows retain their values.

## 12. Audit

Successful Product mutations append exactly one relevant management audit event in the
same transaction:

```text
PRODUCT_CREATED
PRODUCT_FIELDS_UPDATED
PRODUCT_ACTIVATED
PRODUCT_DEACTIVATED
```

The audit subject is `PRODUCT`. Field updates record safe identifiers and changed field
names only. They do not copy the complete request body, descriptions, reference-price
history, or financial projections. Lifecycle events are separate, so `isActive` is not
reported as a normal field update.

## 13. Frontend

Stable routes:

```text
/products
/products/new
/products/:productId
```

The workspace navigation adds `Ürünler`.

The list provides search, active/inactive/all status views, pagination, and explicit
loading, empty, no-results, error, retry, and forbidden states. Search and status state
are represented in the URL where practical so Back, Forward, refresh, and direct links
preserve context.

Admin and Manager receive create, edit, activate, and deactivate controls. Staff receives
the same catalog information in a read-only view. Only Product name is marked required.
Every other informational field is visibly optional.

Reference-price helper text explains that the value is informational catalog data, not a
sale, invoice, accounting entry, or stock valuation. Deactivation requires a confirmation
that names the Product and explains that history is unchanged. The initial focus is not
placed on the destructive action, and focus returns to the trigger when the dialog closes.
Activation completes directly with accessible result feedback.

Mobile layouts use structured rows or cards and never compress a desktop table into the
viewport.

## 14. Error Behavior

Canonical errors include:

```text
404 PRODUCT_NOT_FOUND
403 FORBIDDEN
409 VERSION_CONFLICT
409 INVALID_PRODUCT_STATUS_TRANSITION
field-specific validation errors
```

On version conflict, unsaved form data remains available. The UI explains that persisted
data changed and offers an explicit current-values reload before resubmission. No optimistic
success is displayed before the backend transaction commits. Failed lifecycle actions
preserve or refetch backend truth.

## 15. Accessibility

Slice 06 follows WCAG 2.2 Level AA and the shared UI contract:

- semantic headings, landmarks, lists, forms, and status feedback
- visible labels; placeholders never replace labels
- keyboard operation for every critical action
- visible focus and correct focus restoration
- approximately 44x44 CSS px interactive targets where applicable
- color never acts as the only state indicator
- 200 percent text enlargement and supported 400 percent reflow
- no horizontal page scrolling for critical mobile flows
- reduced-motion support
- validation errors associated with their fields and focused appropriately

## 16. Verification

Automated and manual verification covers:

- migration and schema contracts
- nullable SKU and unit
- repeated SKU values
- Product version creation and increment
- organization and role boundaries
- exact request and query allowlists
- stale mutations with no partial mutation or audit
- Product audit transaction and rollback
- inactive Product selection rules
- unchanged historical delivery snapshots
- existing delivery-item edits that do not replace Product
- searchable Product selection beyond one fixed catalog page
- canonical HTTP route acceptance
- UI loading, empty, no-results, error, forbidden, read-only, retry, and conflict states
- router Back, Forward, refresh, and direct URLs
- full server and web suites, builds, and high-severity audits
- disposable PostgreSQL migrations 001–005 and live role/lifecycle/snapshot tracer
- Playwright MCP desktop and 390 CSS px mobile acceptance
- keyboard, focus, touch targets, text enlargement, reflow, reduced motion, and semantics

## 17. Implementation Order

1. Migration and schema contract
2. Product repository, normalization, service policy, audit, and HTTP routes
3. Delivery reference and snapshot integration
4. Product client, routed management UI, and searchable delivery selector
5. Full automated, disposable PostgreSQL, Playwright, SSOT, and memory closeout

No Product implementation begins until a separate implementation plan is reviewed and
approved.
