# Codebase touchpoints for a future light Accounting ("Muhasebe") module

- **Date:** 2026-11-26
- **Status:** Research only. Not a decision, not an implementation authorization.
  `AGENTS.md:399-400` (§13) still forbids "Add full accounting module" and
  "Add e-invoice/e-archive integration" without explicit owner approval; this note is
  input for that decision.
- **Base:** `claude/accounting-module-research-0100ad` @ `89bf6b1` (merge of PR #511,
  operator/module pilot). Migration head is `074_installation_operator_and_module_state`.
- **Scope:** which existing tables, types, services, DTOs, docs, rules and UI surfaces a
  future Accounting layer would **read from** or **link to**, and which rules currently
  **forbid** financial data in Core. It does not design the module.
- Every repo claim carries `path:line`. Nothing in this file was executed against a
  database; all statements are read from source, migrations and documents in this
  checkout.

## Summary

- A `SALE` is an ordinary `job_cards` row of `type = 'SALE'`; its identity, lifecycle,
  approval, activity log, optimistic `version` and `clientActionId` receipts are already
  durable (`server/src/db/migrations/057_sale_from_visit.sql:4-31`).
- Sale lines are `job_card_sale_items` with a durable UUID line id and a snapshot of
  product name/SKU/brand/model/unit plus an **integer product count only** — there is no
  price, currency, discount, total, tax, invoice or payment column anywhere
  (`…/057_sale_from_visit.sql:70-90`, `…/058_sale_integer_quantity.sql:19-24`).
- `PRODUCT_DELIVERY` carries `job_card_delivery_items` with one canonical purpose
  (`SALE|SAMPLE|CONSIGNMENT|RETURN|OTHER`), positive quantity, and a nullable **actual**
  `delivered_at`; one delivery can be linked to one sale through
  `job_cards.delivery_source_sale_id` (`…/002_delivery_tracer.sql:137-162`,
  `…/009_job_acceptance_and_scheduling.sql:43-45`, `…/071_sale_standalone_and_delivery_link.sql:26-43`).
- Customers already hold the fields an invoice header needs **except title/unvan and tax
  office/vergi dairesi**: `name`, `tax_number` (normalized, unique per org), `address`,
  `city`, `district`, phone and e-mail exist; `tax_office` and a separate legal
  title/unvan do not (`…/002_delivery_tracer.sql:4-25`, `…/004_crm_contacts.sql:5-15`).
- Products hold a nullable `default_price` exposed as `referencePrice`, explicitly
  "no currency or financial meaning" and "not copied into delivery items"
  (`DECISIONS.md:549-552`, `…/005_product_catalog.sql:8-10`); nothing reads it in
  reports, sales or deliveries.
- `invoiceNumber` is a **free-text 100-char column on `job_card_notes`**, only accepted on
  `SALES_MEETING` and `PRODUCT_DELIVERY` notes, never on `SALE`, and no report reads it
  (`…/024_job_card_notes_invoice_number.sql:1-4`,
  `server/src/modules/job-cards/notes-service.ts:22,56-61`).
- Reports are quantity/purpose/count reports. There is no revenue, margin, discount,
  commission, VAT, invoice or payment field in any report DTO, query or UI
  (`DECISIONS.md:685`, `server/src/modules/reports/types.ts:19`,
  `server/src/modules/reports/repository.ts:1279-1320`).
- Audit is split three ways: organization-scoped `audit_events` (catalog/CRM/user
  mutations), per-JobCard `job_card_activity_logs` (operational lifecycle), and
  installation-level `operator_audit_events` (module state). Each writer appends inside
  the same transaction as its business change (`…/003_people.sql:32-56`,
  `server/src/modules/crm/repository.ts:321-329`, `…/074_installation_operator_and_module_state.sql:67-120`).
- The module mechanism a new `ACCOUNTING` entry must extend is small but strictly typed:
  one compile-time registry entry, one `installation_module_state` row guarded by a CHECK
  `IN ('OVERVIEW')`, one `user.capabilities` flag, one web route-access + navigation
  branch, and a fail-closed 503 gate (`DECISIONS.md:3735-3788`,
  `server/src/modules/installation-modules/registry.ts:1-27`,
  `…/074_installation_operator_and_module_state.sql:51-65`).
- Two live "leak" surfaces matter more than schema: the **operator module-state row**
  (a wrong row makes the module silently available) and the **demo-data purge plan**,
  which enumerates entities explicitly and has no sale/accounting entity today
  (`server/src/modules/demo-data/plan.ts:24-43`, `…/repository.ts:411-454`).

---

## 1. SALE JobCard and sale lines

### 1.1 Table shape

| Fact | Evidence |
| --- | --- |
| `SALE` added to `job_cards_type_check` | `server/src/db/migrations/057_sale_from_visit.sql:4-8` |
| `job_cards.sale_source_visit_id UUID` + FK `(organization_id, sale_source_visit_id) → job_cards … ON DELETE RESTRICT` | `…/057_sale_from_visit.sql:9-12` |
| 057 required a source visit (`(type='SALE') = (sale_source_visit_id IS NOT NULL)`); 071 replaced it with "only a SALE may carry a source" | `…/057_sale_from_visit.sql:13-14`; `…/071_sale_standalone_and_delivery_link.sql:22-25`; rationale `DECISIONS.md:2120-2123` |
| `job_cards_sale_source_self_check` (no self-link) | `…/057_sale_from_visit.sql:15-16` |
| `job_cards_sale_fields_check`: a SALE requires `customer_id NOT NULL`, `data_class='BUSINESS'`, and **NULL** `contact_id`, `engagement_kind`, `scheduled_at`, `scheduled_ends_at`, `due_date`, `source_job_card_id`, all follow-up proposal columns | `…/057_sale_from_visit.sql:17-25` |
| One active sale per visit: partial unique index over `NEW, ACCEPTED, IN_PROGRESS, WAITING_APPROVAL, REVISION_REQUESTED` | `…/057_sale_from_visit.sql:27-31` |
| 071 deliberately does **not** rebuild that slot index; NULL sources are distinct in a btree so standalone sales never collide | `…/071_sale_standalone_and_delivery_link.sql:9-18` |
| SALE may reach `WAITING_APPROVAL`/`COMPLETED` without `started_at` | `…/072_sale_submit_without_start.sql:20-26` |
| Terminal set is `COMPLETED, CANCELLED, INVALIDATED` | `server/src/modules/job-cards/policy.ts:42-44` |

### 1.2 `job_card_sale_details` (one row per sale)

Creates `organization_id`, `job_card_id` (PK), `sold_at`, sale-contact snapshot
(`sale_contact_id/name/title`), and source-visit snapshots (`source_visit_version`,
`source_visit_title_snapshot`, `source_customer_name_snapshot`, planned/met contact
snapshots): `…/057_sale_from_visit.sql:36-66`. All FKs are
`ON DELETE RESTRICT` (`:60-64`). 071 makes the source columns nullable and adds the
all-or-none `job_card_sale_details_source_shape_check`
(`…/071_sale_standalone_and_delivery_link.sql:45-68`).

**There is no monetary, tax, invoice, payment or stock column in this table.**

### 1.3 Sale lines (`job_card_sale_items`)

```
id UUID PK, organization_id, job_card_id, product_id,
quantity, product_name_snapshot, product_sku_snapshot, product_brand_snapshot,
product_model_snapshot, unit_snapshot, sort_order, created_at, updated_at
UNIQUE (organization_id, id); UNIQUE (organization_id, job_card_id, product_id)
```
`…/057_sale_from_visit.sql:70-88`. FK `product_id → products … ON DELETE RESTRICT`
(`:87`). Indexes `sale_items_job_sort_idx`, `sale_items_product_idx` (`:89-90`).

- **Durable sale identity** = `job_cards.id`; **durable line identity** =
  `job_card_sale_items.id`. MOD-001 §5 already names these as future reference points
  (`DECISIONS.md:2050-2051`).
- The `(organization_id, job_card_id, product_id)` unique means **one line per product
  per sale**, so "same product, different commercial terms" is not representable today
  (`docs/features/visit-to-sale/visit-to-sale-design.md:135`).
- Deleting a product or user is blocked while a sale line / sale card references it
  (`…/057_sale_from_visit.sql:86-87`; product history guard
  `server/src/modules/products/repository.ts:90-99`).

### 1.4 Quantity rule (SALE-QTY-001)

- Original: `NUMERIC(12,3)`, `0.001 … 999999999.999` (`…/057_sale_from_visit.sql:75`).
- Current: unrestricted `NUMERIC` plus
  `CHECK (quantity >= 1 AND quantity = trunc(quantity) AND quantity <= 999999999)`
  (`…/058_sale_integer_quantity.sql:19-24`); migration **fails closed** on historical
  fractional rows (`:6-17`).
- Parser: JSON safe integer 1–999 999 999, serialized as `"1.000"` for receipt-hash
  replay (`server/src/modules/job-cards/sale-input.ts:104-110`).
- Public DTO emits integer counts (`sale-reader.ts:120`; `DECISIONS.md:2090-2094`).
- Max 25 distinct lines per sale (`sale-input.ts:5`, enforced `:68-74` and
  `:105-115`).

### 1.5 Services

| Operation | Location |
| --- | --- |
| Transactional sale service class | `server/src/modules/job-cards/sale-service.ts:42` |
| Shared correction wrapper (`executeCriticalAction` + version + activity) | `sale-service.ts:57-97` |
| `patchSaleItem` / `removeSaleItem` / `addSaleItem` / `patchSaleDetails` | `sale-service.ts:99-172` |
| `createStandaloneSale` (no source visit) | `sale-service.ts:174-266` |
| `createSaleFromVisit` | `sale-service.ts:268-370` |
| Sale snapshot writer / reader SQL | `server/src/modules/job-cards/sale-repository.ts:86-183` |
| Sale read port (context / related / details projections) | `server/src/modules/job-cards/sale-reader.ts:33-131` |
| Submit / approve lifecycle entry points | `server/src/modules/job-cards/service.ts:6143` (`submitForApproval`), `:6230` (`approve`) |
| Paired visit+sale state machine | `server/src/modules/job-cards/sale-pair-policy.ts:1-40` |
| Integrity-error mapping (`SALE_FROM_VISIT_ACTIVE_EXISTS`, `SALE_DELIVERY_ALREADY_EXISTS`) | `sale-service.ts:26-40` |
| Submit readiness for SALE | `server/src/modules/job-cards/submission-policy.ts:322-352` |

Snapshot provenance is written from the locked product row, never from the request:
`sale-service.ts:135-142` and `:352-360` copy `product.name/sku/brand/model/unit`.
`SaleProductReference` deliberately has **no** `referencePrice`
(`sale-repository.ts:12-15`).

Routes (all behind `authenticate` + the legacy sale-capability guard):
`server/src/modules/job-cards/routes.ts:23` (`POST /sales`), `:46-52`
(`…/sales`, `…/sale-details`, `…/sale-items`), `:47` (visit-origin create).

---

## 2. PRODUCT_DELIVERY and delivery items

| Fact | Evidence |
| --- | --- |
| Table `job_card_delivery_items` | `…/002_delivery_tracer.sql:137-162` |
| Purpose vocabulary `SALE, SAMPLE, CONSIGNMENT, RETURN, OTHER` (CHECK) | `…/002_delivery_tracer.sql:142-143`; TS mirror `server/src/modules/job-cards/types.ts:302-303` |
| `delivered_at TIMESTAMPTZ NOT NULL` originally | `…/002_delivery_tracer.sql:144` |
| Made nullable (planned items) and **never backfilled from `scheduled_at`** | `…/009_job_acceptance_and_scheduling.sql:43-45` |
| `quantity NUMERIC(12,3) CHECK (quantity > 0)` | `…/002_delivery_tracer.sql:145` |
| `unit VARCHAR(30) NOT NULL` → nullable | `…/002_delivery_tracer.sql:146`; `…/005_product_catalog.sql:12-13` |
| Snapshots: `product_name_snapshot`, `product_sku_snapshot`, `product_model_snapshot` (**no brand**) | `…/002_delivery_tracer.sql:147-149` |
| Extra fields: `lot_no`, `serial_no`, `expiry_date`, `delivery_note`, `sort_order` | `…/002_delivery_tracer.sql:150-154` |
| Sale → delivery link `job_cards.delivery_source_sale_id` (only `PRODUCT_DELIVERY`; `ON DELETE RESTRICT`; no self-link) | `…/071_sale_standalone_and_delivery_link.sql:26-36` |
| **At most one delivery per sale, ever** (partial unique index) | `…/071_sale_standalone_and_delivery_link.sql:38-43` |
| A sale-linked delivery may never also be a follow-up child | `…/071_sale_standalone_and_delivery_link.sql:126-129` |
| Delivery created atomically with sale approval, `status='NEW'`, planned items `deliveredAt NULL`, `opened_reason='SALE_APPROVAL'` | `server/src/modules/job-cards/service.ts:2814-2925` (card `:2863-2873`, offer `:2916`) |
| Delivery activity on the sale: `SALE_DELIVERY_CREATED` with `{deliveryJobCardId, assignedTo, scheduledAt, itemCount, items}` | `service.ts:2925`; projection `server/src/modules/job-cards/activity-presenter.ts:262-289` |
| Delivery item write allowlist (no price key) | `server/src/modules/job-cards/service.ts:782-785` |
| Delivery quantity rule (whole units 1–999 999 999 for new input) | `server/src/modules/job-cards/delivery-input.ts:26-39` |
| Delivery create/patch parser (strict allowlist) | `server/src/modules/job-cards/create-input.ts:219-240` |
| Sale-approval delivery input reuses the same parsers, defaults purpose to `SALE` | `server/src/modules/job-cards/sale-approval-delivery-input.ts:47-97` |

**Financial meaning is explicitly absent.** DOM-001: "MVP does not store unit price,
discount, line total, revenue, margin, commission, invoice state, or payment state"
(`DECISIONS.md:349-356`). `SALE` purpose on a delivery line is a **purpose label**, not a
link to a `SALE` card; the only card-level link is `delivery_source_sale_id`.

---

## 3. Customers and contacts

### 3.1 What exists

`customers` (`…/002_delivery_tracer.sql:4-29`):

| Column | Type | Accounting relevance |
| --- | --- | --- |
| `name` | `VARCHAR(255) NOT NULL` | Invoice "alıcı adı"; not a separate legal title/unvan |
| `customer_type` | `clinic|hospital|dealer|company|other` | Buyer segment, not a tax concept |
| `tax_number` | `VARCHAR(50) NULL` | **VKN/TCKN holder**; normalized `upper(regexp_replace(trim(x),'[[:space:]./-]+','','g'))` and unique per organization when present (`…/004_crm_contacts.sql:5-15`) |
| `phone`, `email` | nullable | Contact data |
| `city`, `district` | nullable | Address parts |
| `address` | `TEXT NULL` | Free-text address |
| `assigned_staff_user_id` | nullable FK | Sales owner |
| `status` | `prospect|active|inactive` | Lifecycle (single source of truth) |
| `version` | optimistic concurrency | `…/004_crm_contacts.sql:1-3` |

`contacts` (`…/004_crm_contacts.sql:17-…`): `name`, `title` (free text, e.g. "Dr."),
`phone`, `email`, `is_primary`, `is_active`, `version`.

### 3.2 What does **not** exist (invoice blockers)

- **No tax office / `vergi_dairesi` column** anywhere: `rg -i 'tax_office|vergi|vkn|tckn' server/src` finds no column, only the `CUSTOMER_TAX_NUMBER_EXISTS` message text (`server/src/modules/crm/service.ts:226,359`).
- **No separate legal title / unvan** distinct from `name`. `name` is the only display
  and legal-looking field (`…/002_delivery_tracer.sql:7`).
- **No country, postal code, neighborhood (`mahalle`), or structured address parts** —
  only `city`, `district`, `address` free text.
- **No tax-number type discriminator** (VKN vs TCKN). `tax_number` is an untyped
  `VARCHAR(50)` with only length/normalization checks (`…/004_crm_contacts.sql:5-11`);
  whether it is 10-digit VKN or 11-digit TCKN is not stored or validated.
- **No e-invoice/e-archive party attributes** (taxpayer registration status, alias/ETN,
  postal box). These are external facts; see `04-external-accounting-integration.md`.
- **No customer-level currency, payment terms, or current-account balance.**

### 3.3 Rules a module must respect when linking customers

- Customer hard delete is blocked by operation history:
  `server/src/modules/crm/service.ts:373-410`, existence probe
  `server/src/modules/crm/repository.ts:407-413`.
- Contact hard delete is blocked by history that **already includes sale contact
  columns** — a precedent Accounting must extend:
  `server/src/modules/crm/repository.ts:423-430` (includes
  `job_card_sale_details.sale_contact_id`, `source_planned_contact_id`,
  `source_met_contact_id`).
- Deactivation is the only soft path; it requires no open job cards
  (`server/src/modules/crm/service.ts:412-429`).
- Sale creation re-validates the customer as `active` **and** `BUSINESS`, and the sale
  contact as active and belonging to that customer, under `FOR UPDATE`/`FOR SHARE`:
  `sale-service.ts:186-210`, `:288-306`, `sale-repository.ts:151-175`.

---

## 4. Products

| Fact | Evidence |
| --- | --- |
| DB column is `default_price NUMERIC(12,2)` (originally on `products`) | `…/002_delivery_tracer.sql:40` |
| Non-negative CHECK | `…/005_product_catalog.sql:8-10` |
| API field name is `referencePrice`; mapper `default_price → referencePrice` | `server/src/modules/products/types.ts:12,43` |
| Max `9_999_999_999.99` (matches `NUMERIC(12,2)`) | `server/src/modules/products/constraints.ts:10`; validation `service.ts:82-93`; web mirror `web/src/ProductForm.tsx:19-23` |
| Optional informational field, only `name` required | `DECISIONS.md:549-552` |
| "no currency or financial meaning, and is not copied into delivery items" | `DECISIONS.md:551-552` |
| "Inventory, warehouse, barcode, costing, currency, price-history, invoice, and accounting behavior require a later separately approved design" | `DECISIONS.md:566-568` |
| UI states it is not a sale price / accounting record / stock valuation | `web/src/ProductForm.tsx:70` |
| Sale line snapshot copies name/SKU/brand/model/unit — **never** referencePrice | `server/src/modules/job-cards/sale-service.ts:135-142`, `:352-360`; `SaleProductReference` has no price `sale-repository.ts:12-15` |
| Delivery item snapshot copies name/SKU/model/unit snapshot; no price | `…/002_delivery_tracer.sql:147-149`; `server/src/modules/job-cards/service.ts:556-562` |
| SKU is optional, not normalized, not unique | `…/005_product_catalog.sql:3-6`; `DECISIONS.md:549-552` |
| `unit` is optional free text with no default | `…/005_product_catalog.sql:5-7` |
| Product hard delete blocked by delivery **and sale** item references | `server/src/modules/products/repository.ts:90-99` |
| Product audit stores "safe identifiers and changed field names, not complete payloads or financial history" | `SERVORA_MED_API_DRAFT.md:512-513` |

A future module that needs a **real** sale price cannot reuse `default_price` without a
new decision: DOM-004 says it has no financial meaning, DOM-004 and MOD-001 both require
a separately approved design for pricing (`DECISIONS.md:566-568`,
`DECISIONS.md:2052-2056`).

---

## 5. `invoiceNumber` on JobCard notes

### 5.1 Schema

```sql
ALTER TABLE job_card_notes
  ADD COLUMN invoice_number TEXT,
  ADD CONSTRAINT job_card_notes_invoice_number_length
  CHECK (invoice_number IS NULL OR length(invoice_number) <= 100);
```
`server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`. Base note table:
`…/006_jobcard_workspace.sql:1-14` (append-only, no update/delete path — DOM-005,
`DECISIONS.md:576-607`).

### 5.2 API

- Request field `invoiceNumber` is part of the note-create allowlist:
  `server/src/modules/job-cards/handlers.ts:477-479`
  (`body(request, ['clientActionId','note','invoiceNumber'])`).
- Parsed as an optional bounded string, max 100 (`notes-service.ts:40`), part of the
  request hash `noteAddRequestHash(jobCardId,{note,invoiceNumber})`
  (`notes-service.ts:46`; hash shape `critical-action-request-hash.ts:331-338`).
- **Type restriction:** rejected with `400 VALIDATION_ERROR` unless the card is
  `SALES_MEETING` or `PRODUCT_DELIVERY` — `INVOICE_CAPABLE_JOB_TYPES` at
  `notes-service.ts:22`, enforcement `:56-61`. **`SALE` is deliberately excluded**;
  see `docs/features/visit-to-sale/visit-to-sale-design.md:125`
  ("invoice-capable type listesine SALE eklenmez").
- Read back on note list: `repository.ts:2265-2290`, DTO `types.ts:1155`.
- Write path: `POST /api/job-cards/:id/notes`, `routes.ts:114-115`.

### 5.3 Who can write it

Same rule as any note (`policy.ts:388-391` → `ADD_NOTE`), i.e. an assigned STAFF member
on `NEW/ACCEPTED/IN_PROGRESS/REVISION_REQUESTED`, or any management role on any
non-`INVALIDATED` status (`policy.ts:158-174`). There is **no** manager-only or
accounting-specific permission, and no validation that the value looks like an invoice.

### 5.4 UI

- Input shown only when `jobType === 'SALES_MEETING' || 'PRODUCT_DELIVERY'`:
  `web/src/jobs/JobNotes.tsx:71`, rendered `:238-244`, label "Fatura numarası",
  `maxLength=100`, placeholder `FT-2026-00124`.
- Read display: `<span className="job-note-invoice">Fatura: {note.invoiceNumber}</span>`
  at `web/src/jobs/JobNotes.tsx:268`.
- Retry identity includes `invoiceNumber` (`JobNotes.tsx:70,148-162`).

### 5.5 Reports

**No report, export, PDF, overview or weekly-report code reads `invoice_number`**
(`rg 'invoice_number|invoiceNumber' server/src/modules/{reports,weekly-reports,overview}` → no matches). It is
write-and-display only, so it is an unindexed, unvalidated, unreconciled free-text field.

MOD-001 records it as explicit debt: "`invoiceNumber` on JobCard notes stays recorded
domain debt; its resolution belongs to Accounting A0" (`DECISIONS.md:2065-2066`).

---

## 6. Reports module (DOM-006) — where "no revenue" lives

DOM-006 owns report semantics (`DECISIONS.md:609-686`). "No revenue" is enforced by
**construction, not by a runtime guard**:

| Layer | Evidence |
| --- | --- |
| Consequence text: "Revenue, margin, commission, stock, invoice, payment, and employee-ranking metrics remain outside MVP." | `DECISIONS.md:685-686` |
| Report DTOs contain only counts/quantities/purposes; `BusinessTrendCounts` is `{visits, followUps, sales}` | `server/src/modules/reports/types.ts:19` |
| Delivery grouping SQL selects only `delivered_at`, `delivery_purpose`, `product_*_snapshot`, `unit`, `SUM(quantity)` | `server/src/modules/reports/repository.ts:1279-1320` |
| Business trend counts approved `SALE` rows (`sales` counter) using `sold_at`, no amount | `server/src/modules/reports/business-trend.ts:28-36`, `:60-78` |
| No report query touches `products.default_price` | `rg 'default_price|reference_price' server/src/modules/reports` → no matches |
| Sale and delivery are never summed: "Reports keep separate meanings: approved sale agreements, approved delivery quantities. They are never summed." | `DECISIONS.md:2177-2178` |
| Returns stay positive under `RETURN` and are not netted against sales | `DECISIONS.md:637-638` |
| Explicitly absent API areas include "invoices, payments, revenue, margins, and commissions" | `SERVORA_MED_API_DRAFT.md:1835-1836` |
| Explicit schema omissions include "price snapshot, discount, and delivery totals" and "invoice and payment records" | `SERVORA_MED_SCHEMA_DRAFT.md:674-675` |

### 6.1 Where a price/amount could leak (ranked)

1. **Product grouping.** If Accounting writes a price onto `products` and a report later
   groups by product, the report gains a monetary dimension without any report change
   review — `server/src/modules/reports/repository.ts:1304-1310` is the exact place a `SUM(price*qty)` would
   be tempting.
2. **Business trend "sales".** The counter already exists
   (`business-trend.ts:33`), so "sales value" is one column away from "sales count".
3. **`SALE_DELIVERY_CREATED` activity payload.** It carries `items` (identity + quantity)
   into the sale timeline (`activity-presenter.ts:262-289`); unit prices would
   automatically become part of an existing audit payload shape.
4. **`invoiceNumber` on notes.** Already visible to any viewer of a
   `SALES_MEETING`/`PRODUCT_DELIVERY` note (`JobNotes.tsx:268`) with no accounting
   authorization check.
5. **Overview dashboard** consumes `ReportsReadModel`/`ReportsReadModel.getWorkTypeDistribution`
   (`server/src/modules/overview/service.ts:51-66`), so any report money field is
   reachable from `/overview` without a new gate.

---

## 7. Audit and activity

Three separate, non-interchangeable trails:

| Trail | Scope | Vocabulary constraint | Writer |
| --- | --- | --- | --- |
| `audit_events` | organization + `actor_user_id NOT NULL` | `subject_type` and `event_type` CHECKs, extended by each slice (latest full list `…/041_user_lifecycle_reconciliation.sql:1-31`, further widened by `…/060_crm_duplicate_review_decisions.sql:91-100` and `…/061_weekly_report_removal.sql:52`) | `server/src/modules/crm/repository.ts:321-329`, `people` `appendAudit`, products, backup |
| `job_card_activity_logs` | per JobCard, `actor_id` nullable, `client_action_id` recorded | `job_card_activity_logs_event_type_check` — latest full list `…/071_sale_standalone_and_delivery_link.sql:88-124` (includes `SALE_FROM_VISIT_CREATED`, `SALE_DETAILS_UPDATED`, `SALE_ITEM_ADDED/UPDATED/REMOVED`, `SALE_DELIVERY_CREATED`) | `tx.appendActivity(...)` inside the critical-action transaction |
| `operator_audit_events` | installation level, no `organization_id` | `event_type IN (OPERATOR_*, MODULE_STATE_TAKEN_OVER, MODULE_STATE_CHANGED, OPERATOR_ACCESS_RESET_BY_RESTORE)`; small JSONB payloads (≤512 chars) | `…/074_installation_operator_and_module_state.sql:67-120`; takeover `installation-modules/takeover.ts:29-64`; restore reset `operator/restore-reset.ts:17-56` |

### 7.1 How a module records audit inside the same transaction

The established pattern (CRM, product, job, backup, operator):

1. Open one database transaction (`pg` client, or `runCriticalAction`).
2. Write the business rows.
3. Write the audit/activity row **through the same client** — e.g.
   `INSERT INTO audit_events …` in `PostgresCrmTransaction.appendAudit`
   (`server/src/modules/crm/repository.ts:321-329`), or
   `tx.appendActivity(...)` in `sale-service.ts:88-90`.
4. Commit. A failed audit write rolls the business change back; the code has no
   post-commit audit path.

Accounting would need its own `subject_type`/`event_type` values added to
`audit_events` CHECKs (a migration), or its own table. There is **no generic event bus**;
MOD-001 §4 forbids one without a concrete producer/consumer and reliable delivery
requirement (`DECISIONS.md:2041-2048`).

---

## 8. Idempotency — the pattern a new module must reuse

| Piece | Evidence |
| --- | --- |
| `processed_actions` receipt table: unique `(organization_id, user_id, client_action_id, operation_key)`, `status processing|completed|failed`, `response_body JSONB`, completed-pair CHECK | `…/002_delivery_tracer.sql:196-218` |
| `runCriticalAction`: claim → work in ONE transaction → persist response → replay on exact resubmission; changed intent = `409 CLIENT_ACTION_REUSED` | `server/src/db/critical-action.ts:142-215` |
| Request-hash comparison | `critical-action.ts:42-53` |
| `40P01`/`40001` map to retryable `409 ACTION_IN_PROGRESS` | `critical-action.ts:64-71` |
| Optional timeouts / whole-request deadline (CRM opt-in) | `critical-action.ts:82-134`, `:142-190` |
| Durable lifecycle reservations (the pattern for *two-intent* commands) | `…/049_job_card_lifecycle_intents.sql:1-70` |
| Sale operations already use the receipt pattern with operation keys `SALE_STANDALONE_CREATE`, `SALE_FROM_VISIT_CREATE`, `SALE_ITEM_ADD/UPDATE/REMOVE`, `SALE_DETAILS_UPDATE` | `sale-service.ts:60-68`, `:178-190`, `:272-284`, `:99-172` |
| Sale receipt hash representations (normalized body, `:v1` discriminator) | `sale-service.ts:181-190`, `:276-283` |
| HTTP contract: `409 ACTION_IN_PROGRESS`, `409 CLIENT_ACTION_REUSED` | `SERVORA_MED_API_DRAFT.md:145-165` |

A new Accounting mutation must either reuse `processed_actions` (organization-scoped,
requires a `user_id`) or justify a different key. Note the constraint: `processed_actions`
has `FOREIGN KEY (organization_id, user_id) → users` (`…/002_delivery_tracer.sql:210-211`),
so an **installation-level** (operator) accounting action cannot reuse it as-is.

---

## 9. Offboarding and customer deactivation

### 9.1 Staff offboarding (`OFFBOARD`)

- Plan collects active jobs (`ACTIVE_JOB_STATUSES = NEW, ACCEPTED, IN_PROGRESS,
  WAITING_APPROVAL, REVISION_REQUESTED`), customers, follows-ups, calendar events,
  reminders, conversations: `server/src/modules/people/offboarding.ts:23-40`.
- Every active job of the leaving user — **including `SALE` cards** — must receive an
  explicit `transfer` or `cancel` decision; the SQL transfer updates `job_cards` for
  `type <> 'WEEKLY_REPORT'` only, with `assigned_to`/acceptance reset:
  `offboarding.ts:526-596` (SQL at `:580-596`).
- A transferred `SALE` gets **no assignment offer** — offers exist only for
  `PRODUCT_DELIVERY` and `SALES_MEETING`
  (`server/src/modules/job-cards/assignment-offer-policy.ts:35-37`), so the sale is
  reassigned directly and an `ACCEPTED` sale drops to `NEW`.
- A transfer voids live early-start authorizations (`offboarding.ts:604-610`) and writes
  `job_card_assignment_history` plus the notification (`offboarding.ts:727-735`).
- Permanent user delete is blocked by **business history**, which already includes job
  cards, activity, accountability facts, notes, confidential notes and calendar events:
  `server/src/modules/people/service.ts:65-77`, `:285-347`; the history probe
  `server/src/modules/people/repository.ts:157-215`. FK `ON DELETE RESTRICT` from
  sale/delivery rows is the last authority

### 9.2 Customer deactivation / deletion

- `deactivateCustomer` sets `status='inactive'`, requires `version`, rejects while open
  job cards exist (`CUSTOMER_HAS_ACTIVE_JOB_CARDS`), audits `CUSTOMER_DEACTIVATED`:
  `server/src/modules/crm/service.ts:369-430`.
- Inactive customers block new sales (`CUSTOMER_INACTIVE`, `sale-service.ts:201`,
  `:299`) and block the sale-approval delivery, rolling the whole approval back
  (`service.ts:2838-2840`).
- Customer hard delete requires ADMIN, no job cards, and is blocked by FK otherwise
  (`server/src/modules/crm/service.ts:373-410`). Deactivation **never rewrites historical sale/delivery
  snapshots** (`DECISIONS.md:556-557`).

**Accounting consequence:** an invoice/cari record must survive customer deactivation.
The precedent is "deactivate only, never rewrite snapshots", and the counter-precedent is
"hard delete blocked by history" — Accounting rows would need to be added to the
`has_operation_history` probes (`server/src/modules/crm/repository.ts:423-430`) and to the user-deletion
history probe (`server/src/modules/people/repository.ts:157-215`), or the delete guards will silently allow a
delete that orphans accounting references.

---

## 10. Backup and restore

| Fact | Evidence |
| --- | --- |
| OPS-002: installation-level backup (no `organization_id`), R2 + age + worker, operator CLI restore, no in-app restore button | `DECISIONS.md:921-958` |
| Restore validates into a **separate** target DB first; production cutover is separate; PRE_RESTORE safety backup mandatory | `DECISIONS.md:940` |
| Restore requires the manifest's `schemaVersion` to match the exact recovery history | `server/src/modules/backup/restore/postgres.ts:280-294` (`assertExactRecoveryHistory`) |
| `pg_restore` client must not be older than the source server | `backup/restore/postgres.ts:142-158` |
| MOD-002 §6: restore revokes **all** operator sessions and deactivates **all** operator accounts before traffic opens | `DECISIONS.md:3776-3777`; implementation `server/src/modules/backup/restore/operator-reset.ts:12-33` and `server/src/modules/operator/restore-reset.ts:17-56` |
| "Module state and audit return to the backup instant (documented)" | `docs/features/operator-module-pilot.md:185-188` |
| A pre-074 backup restores through the normal flow; first start performs takeover | `docs/features/operator-module-pilot.md:189-191` |
| Migration 074 requires `allow_migrations` on deploy | `docs/features/operator-module-pilot.md:192-194` |

### 10.1 Module-specific implications

- Accounting tables would live in the same database and therefore in the same `pg_dump`;
  a restore rolls accounting data **and** `installation_module_state` back to the backup
  instant together. There is no partial/module-level restore.
- If Accounting ever stores **externally-held credentials** (e-invoice integrator
  password, ERP API key), MOD-002 §4/§6 is the precedent: secrets stay in env, and
  restore must invalidate/reset anything session-like. No such mechanism exists for a
  future module today.
- Nothing in `backup/` enumerates application tables; only whole-database dump/restore, so
  a new module adds no backup code path — but also gets no restore-safety review for free.

---

## 11. Module registry (MOD-002) — what an `ACCOUNTING` entry needs

### 11.1 Current mechanism

| Element | Evidence |
| --- | --- |
| Decision: operator identity, module state, env takeover, fail-closed 503, restore | `DECISIONS.md:3735-3788` |
| Compile-time registry with exactly one entry, descriptor `{key,label,capability,legacyEnvKey}`, and the comment "Each later module needs its own slice and contract" | `server/src/modules/installation-modules/registry.ts:1-27` |
| `installation_module_state` — one typed row per key; `module_key CHECK IN ('OVERVIEW')`; `source IN ('ENV_TAKEOVER','OPERATOR')`; actor-pair CHECK | `…/074_installation_operator_and_module_state.sql:51-65` |
| `operator_audit_events` — `module_key CHECK (… IN ('OVERVIEW'))`, `MODULE_STATE_CHANGED` requires old+new `{enabled:boolean}` | `…/074_installation_operator_and_module_state.sql:67-120` (`module_key` CHECK at `:86-87`) |
| Capability projection into the customer session (`/api/auth/login`, `/api/auth/me`) | `server/src/modules/auth/handlers.ts:22-46`; `server/src/modules/capabilities/service.ts:1-36` |
| Fail-closed gate in the module service: `404 NOT_FOUND` when disabled, `503 MODULE_STATE_UNAVAILABLE` when the row is missing or unreadable, **no env fallback** | `server/src/modules/overview/service.ts:20-24`, `:91-101` |
| Capability read helper returns `false` + logs on any failure | `server/src/modules/installation-modules/state.ts:82-101` |
| One-time env takeover, `INSERT … ON CONFLICT DO NOTHING RETURNING`, audit in the same transaction, throws if a takeover event exists without the row | `server/src/modules/installation-modules/takeover.ts:20-64` |
| Operator `PUT /api/operator/modules/:key`: `expectedVersion`, `409 MODULE_VERSION_CONFLICT`, audit in the same transaction | `docs/features/operator-module-pilot.md:130-146`; `server/src/modules/operator/service.ts:136-161` |
| Route wiring (customer tree, then `/api/operator`) | `server/src/app.ts:620-630`; module routes e.g. `:366-380` |
| Env ceiling rule: env is a **ceiling only** for modules whose secrets/infrastructure live in env; not for Overview | `DECISIONS.md:3770-3773`; `docs/features/operator-module-pilot.md:113-116` |

### 11.2 Concrete change list for `ACCOUNTING`

1. **Migration 075** (do not edit 074): widen
   `installation_module_state_key_check` to `IN ('OVERVIEW','ACCOUNTING')` and
   `operator_audit_events_module_key_check` likewise. Editing 074 is forbidden by
   `AGENTS.md` §6 (already-applied migrations).
2. **Registry** (`installation-modules/registry.ts`): add
   `{ key:'ACCOUNTING', label:'Muhasebe', capability:<new flag>, legacyEnvKey:<new env> }`
   and widen `InstallationModuleDescriptor`/`InstallationModuleKey` (currently literal
   `'OVERVIEW'`, `registry.ts:8-14`, `:26`).
3. **Capability** `server/src/modules/capabilities/types.ts:1-10` +
   `service.ts:5-36` (default `false`, projection function) + `AuthHandlers` runtime read.
4. **Takeover input** `server/src/modules/installation-modules/takeover.ts:20-24`
   (add the env value) and `server/src/index.ts:321-330`.
5. **Route gate**: a new module service must implement the same
   `assertEnabled()` shape as `server/src/modules/overview/service.ts:91-101` — 503 on unreadable/missing
   row, not 404, and no env fallback.
6. **Operator UI** modules page row (currently Overview only: `web/src/operator/OperatorModulesPage.tsx`,
   contract `docs/features/operator-module-pilot.md:169-172`).
7. **Web**: `AuthenticatedCapabilities` (`web/src/services/api.ts:19-25`), strict parser
   (`api.ts:183-190`), `route-access.ts:35-40`, `navigation-model.ts:89-112`.
8. **Env example + ops gate**: `.env.example`, `ops/examples/servora-med-staging.env.example`,
   `ops/ci/verify-env-examples.sh:54-67` (staging flags), production deploy note
   (`docs/operations/production-deployment.md:765`).

**Fail-closed trap:** a missing `ACCOUNTING` row after deploy is `503`, not "off". Only a
`disabled` row is "off" (`server/src/modules/overview/service.ts:99-100`). The takeover insert must run for
the new key or the module will 503 forever.

---

## 12. Web: SALE detail and the "Ön Muhasebe" placeholder

| Fact | Evidence |
| --- | --- |
| SALE detail is the normal job detail route; the sale block is
  `SaleDetailsSection` | `web/src/JobDetail.tsx:3587`; component `web/src/jobs/SaleDetails.tsx:11-42` |
| It renders: sold-at, sale contact, source-visit (standalone / restricted / full snapshot), and product lines as `"<n> ürün" + name + SKU/brand/model/unit` | `SaleDetails.tsx:13-41` |
| Correction UI: `SaleCorrectionSection` | `web/src/JobDetail.tsx:3594`; `web/src/jobs/SaleCorrection.tsx:98-…` |
| Sale create routes | `web/src/AppRouter.tsx:434` (`/jobs/:jobCardId/new-sale`), `:268-276` (`SaleCreateRoute`, standalone) |
| Sale API client type has no price field and rejects unknown keys | `web/src/jobs/sale-api.ts:18-31` |
| Delivery link on a sale is rendered by `SaleDeliveryLinks` / `SalePairPanels` | `web/src/jobs/SaleDeliveryLinks.tsx`; `web/src/jobs/SalePairPanels.tsx` |

### 12.1 "Ön Muhasebe" / "Gelecek sürümde"

**No such placeholder exists in the code.** `rg 'Ön Muhasebe|Muhasebe|Gelecek sürümde' web/src server/src`
returns nothing. The only statement is a *plan note* describing what a future manager sale
detail **may** show:

> "Yönetici SALE detayında 'Ön Muhasebe' ve 'Stok/Depo' için iki küçük, salt-okunur
> bilgilendirme bölümü bulunabilir; ikisi de açıkça 'Gelecek sürümde' şeklinde
> işaretlenir. Gerçek muhasebe/stok verisi, belge durumu, finansal toplam veya miktar
> gösterilmez. Sahte buton, devre dışı bırakılmış işlem simülasyonu veya veri kaynağı
> olmayan durum göstergesi bulunmaz."
> — `docs/features/visit-to-sale/visit-to-sale-implementation-plan.md:148`

So the placeholder is **permitted and unfilled**, not implemented. Adding it is a UI change
that must follow `DECISIONS.md` UI-001/UI-003 and
`docs/ui/visual-review-workflow.md`.

---

## 13. Every existing rule that forbids price / VAT / invoice / payment / stock in Core

Ordered by authority. "Code" rules are the ones that actually reject data today.

### 13.1 Accepted decisions and contracts

| # | Rule | Evidence |
| --- | --- | --- |
| 1 | MVP delivery stores no unit price, discount, line total, revenue, margin, commission, invoice state or payment state; `CONSIGNMENT`/`RETURN` create no stock movements | `DECISIONS.md:349-356` |
| 2 | Product `reference price` has "no currency or financial meaning, and is not copied into delivery items" | `DECISIONS.md:551-552` |
| 3 | Inventory, warehouse, barcode, costing, currency, price-history, invoice and accounting need a separately approved design | `DECISIONS.md:566-568` |
| 4 | Reports: "Revenue, margin, commission, stock, invoice, payment, and employee-ranking metrics remain outside MVP." | `DECISIONS.md:685-686` |
| 5 | SALE "creation/correction never changes the source visit or creates delivery, follow-up, financial, stock or accounting operations" | `DECISIONS.md:1982-1985` (SALE-001) |
| 6 | SALE-002 keeps "the non-financial rules unchanged" | `DECISIONS.md:2127-2128` |
| 7 | Core never produces stock balances, ledger entries, financial documents or collections | `DECISIONS.md:2017-2021` (MOD-001 §1) |
| 8 | Core never gains chart of accounts, journals, e-Defter, payroll, full bank reconciliation or a general posting engine | `DECISIONS.md:2036-2040` (MOD-001 §3) |
| 9 | "At this stage no `invoiceNumber` field, warehouse/location link, invoice/payment/stock status, price, discount, VAT or revenue computation is added" | `DECISIONS.md:2052-2056` (MOD-001 §5) |
| 10 | No generic event bus / outbox / integration queue without a concrete producer-consumer and reliability requirement | `DECISIONS.md:2041-2048` (MOD-001 §4) |
| 11 | SALE quantity is a product count; catalog units do not convert or qualify it; "No delivery, stock or accounting behavior changes" | `DECISIONS.md:2073-2102`; `DECISIONS.md:2098-2099` |
| 12 | `AGENTS.md` §13 forbidden without approval: "Add full accounting module", "Add e-invoice/e-archive integration" | `AGENTS.md:399-400` |
| 13 | `AGENTS.md` §6 requires schema changes through migrations, forbids edits to applied migrations, and points critical invariants at `SERVORA_MED_SCHEMA_DRAFT.md` §4–§5 | `AGENTS.md:174-184` |
| 14 | Schema §9 explicit omissions: stock quantity/movements, tracking flags, price snapshot/discount/delivery totals, invoice and payment records, quote and collection JobCard types | `SERVORA_MED_SCHEMA_DRAFT.md:670-680` |
| 15 | API §19 explicitly absent: stock/warehouse mutations, invoices, payments, revenue, margins, commissions | `SERVORA_MED_API_DRAFT.md:1831-1841` |
| 16 | API §9: "There are no stock, warehouse, costing, price-history, currency, barcode, or tracking-requirement endpoints in MVP." | `SERVORA_MED_API_DRAFT.md:515-516` |
| 17 | API §11: "Price and financial fields are rejected as unknown input." | `SERVORA_MED_API_DRAFT.md:1090` |
| 18 | Visit-to-sale design: price, currency, discount, revenue, collection, payment, invoice/e-invoice, stock, lot/serial/expiry, accounting and sale→delivery automation are out of scope; `referencePrice` is not taken into the sale snapshot | `docs/features/visit-to-sale/visit-to-sale-design.md:135` |
| 19 | Sale creation "does not complete the visit, create a follow-up, deliver products or create financial entries" | `docs/features/visit-to-sale/visit-to-sale-design.md:144` |
| 20 | Sale item has no `delivery_purpose`, `delivered_at`, price, currency, total, stock, invoice, lot/serial/expiry or payment field; `referencePrice` is not copied | `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:93` |
| 21 | `SALE` is not added to the invoice-capable note type list | `docs/features/visit-to-sale/visit-to-sale-design.md:125` |
| 22 | No mutation updates "financial state" on a sale | `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:205` |
| 23 | No financial or warehouse behavior is added by the sale read integration | `docs/features/visit-to-sale/read-integration.md:245` |

### 13.2 Database constraints and column absence

| # | Rule | Evidence |
| --- | --- | --- |
| 24 | `job_card_sale_items` has exactly the columns listed; there is **no** price/currency/tax/total column | `…/057_sale_from_visit.sql:70-88` |
| 25 | `job_card_sale_details` has no monetary column | `…/057_sale_from_visit.sql:36-66` |
| 26 | `job_card_delivery_items` has no price/amount column; purpose is a 5-value CHECK | `…/002_delivery_tracer.sql:137-162` |
| 27 | `job_cards_sale_fields_check` forbids contact/engagement/schedule/due/follow-up data on a SALE — the only "commercial" fields on a sale are `customer_id`, title, description, `sold_at` | `…/057_sale_from_visit.sql:17-25` |
| 28 | `products.default_price` is only `numeric(12,2) NULL` with `>= 0`; no currency column exists | `…/002_delivery_tracer.sql:40`; `…/005_product_catalog.sql:8-10` |
| 29 | `job_card_notes.invoice_number` is a bare `TEXT` ≤ 100 with no format, no FK, no uniqueness, no state | `…/024_job_card_notes_invoice_number.sql:1-4` |
| 30 | `audit_events` subject types are `USER, STAFF_PROFILE, CUSTOMER, CONTACT, PRODUCT, STAFF_CONFIDENTIAL_NOTE, BACKUP_RUN, BACKUP_POLICY, JOB_CARD, DEMO_DATASET` — no invoice/document subject | `…/038_demo_dataset_audit_types.sql:15-21` |
| 31 | `installation_module_state.module_key CHECK IN ('OVERVIEW')` and `operator_audit_events.module_key CHECK IN ('OVERVIEW')` — an accounting module cannot be switched on without a migration | `…/074_installation_operator_and_module_state.sql:59`, `:86-87` |

### 13.3 Code rejections (strict allowlists)

| # | Rule | Evidence |
| --- | --- | --- |
| 32 | Sale create/line parsers reject every unknown key, including `price` | `sale-input.ts:4-9` (`MAX_SALE_ITEMS`, `record()` allowlist), tests `server/tests/sale-input.test.ts:44`, `:103`; `server/tests/sale-write-routes.test.ts:119`; `server/tests/sale-002-s1-standalone-create-postgres.test.ts:398` |
| 33 | Sale quantity parser rejects non-integers and out-of-range values, never rounds | `sale-input.ts:104-110`; `server/tests/sale-input.test.ts:34-40` |
| 34 | Delivery item write allows exactly `expectedVersion, productId, deliveryPurpose, deliveredAt, quantity, lotNo, serialNo, expiryDate, deliveryNote` | `server/src/modules/job-cards/service.ts:782-785` |
| 35 | Delivery create/patch parsers use strict key allowlists | `create-input.ts:219-240`, `sale-approval-delivery-input.ts:33-45`, `:66-72` |
| 36 | `invoiceNumber` rejected outside `SALES_MEETING`/`PRODUCT_DELIVERY` | `notes-service.ts:22`, `:56-61` |
| 37 | Product input normalizes to exactly `name,sku,brand,category,model,unit,referencePrice` | `server/src/modules/products/service.ts:19-41`, `:95-105`; handlers `:7`, `:96-108` |
| 38 | Sale snapshot writer never reads a price from the product reference | `sale-service.ts:135-142`, `:352-360`; `sale-repository.ts:12-15` |
| 39 | Web sale API parser rejects unknown response keys (a new server field breaks the client loudly) | `web/src/jobs/sale-api.ts:27-31` |

### 13.4 Tests that pin the boundary

`server/tests/sale-input.test.ts:44,103`; `server/tests/sale-write-routes.test.ts:119`;
`server/tests/sale-002-s1-standalone-create-postgres.test.ts:394-402`;
`server/tests/product-service.test.ts` and `server/tests/product-postgres-routes.test.ts`
cover `referencePrice` as an informational field only.

---

## Touchpoint map

| Touchpoint | Read/Link/Own | Risk if Accounting touches it |
| --- | --- | --- |
| `job_cards` (`type='SALE'`) identity, status, `version`, `manager_approved_at`, `sold_at` | **Read / Link** (FK only) | Mutating sale rows would break the one-active-sale index, the pair state machine, 049 intents and approval audit. Link by id only. |
| `job_card_sale_details` | **Read / Link** | Its all-or-none source-shape CHECK (071:51-68) and contact-history guards are hand-maintained; extra columns here force every reader/DTO/allowlist to change and can leak into `sale-details` responses. |
| `job_card_sale_items` | **Read / Link** | The `(org, card, product)` unique forbids a second priced line for the same product → a real priced-invoice model directly conflicts with this constraint. Quantity is an integer count, not a measurement. |
| `job_cards.sale_source_visit_id` | **Read / Link** | Re-pointing it violates `job_cards_sale_source_type_check` and the audit story; `ON DELETE RESTRICT` already prevents deleting a visit with a sale. |
| `job_cards.delivery_source_sale_id` | **Read / Link** | `job_cards_one_delivery_per_sale_idx` makes "partial delivery / second invoice delivery" impossible without a new decision (MOD-001 §5 leaves it as research, DECISIONS.md:2056-2059). |
| `job_card_delivery_items` (`SALE` purpose) | **Read / Link** | A `SALE`-purpose delivery line is **not** a sale reference; treating it as revenue would double-count against approved `SALE` cards (DECISIONS.md:2177-2178). |
| `customers` / `contacts` | **Read / Link** | Adding `tax_office`, legal title, or a second status field breaks "customer lifecycle has one source: `status`" (`SERVORA_MED_SCHEMA_DRAFT.md:243-244`) and the `(org,tax_number)` unique. Any new FK must join the CRM delete-history probe, or hard delete orphans accounting rows. |
| `products` (`default_price`/`referencePrice`), `sku`, `unit` | **Read / Link** | Reinterpreting `default_price` as a sale price silently changes DOM-004 meaning for existing data with no currency and no history; writing prices back into Product makes them visible to every Staff catalog reader. |
| `job_card_notes.invoice_number` | **Read now → Own later** | Currently free text on two job types with no validation or report. Moving it "into Accounting" is a data-migration decision (existing values must not be lost) and must not create a second invoice reference authority (MOD-001 debt, DECISIONS.md:2065-2066). |
| `audit_events` | **Link (append)** | Requires new `subject_type`/`event_type` CHECK values in a migration. Reusing existing types would make financial events indistinguishable from CRM events. |
| `job_card_activity_logs` | **Link (append)** | Vocabulary is a hard CHECK (071:88-124) and every payload is presented to staff/management viewers; adding price fields here exposes money to every job-detail reader. |
| `operator_audit_events` + `installation_module_state` | **Own (extend)** | `module_key CHECK IN ('OVERVIEW')` and the "one typed row per module" rule (UI-002) mean a generic settings bag is forbidden. A wrong/missing row yields permanent 503 (no env fallback). |
| `processed_actions` / `job_card_lifecycle_intents` | **Read the pattern** | `processed_actions` is organization+user scoped with an FK to `users`; an installation-level accounting action cannot reuse it. Ignoring the pattern creates duplicate invoices on retry. |
| `users` (`assigned_to`, `created_by`, audit actors) | **Read / Link** | Sale/delivery FKs are `ON DELETE RESTRICT`; the permanent-delete probe must learn accounting references or ADMIN delete will fail with a raw FK error instead of a coded blocker. |
| Reports (`server/src/modules/reports/*`) | **Read** | The "no revenue" contract is structural, not asserted; adding one money field to `DELIVERY_GROUPS` or `business-trend.ts` silently changes DOM-006 for every consumer including `/overview`. |
| Backup / restore (`server/src/modules/backup/*`, `operator/restore-reset.ts`) | **Read** | Whole-DB restore rolls accounting data **and** module state back together; any external credential or numbering sequence must be re-validated after restore, and no module-level restore exists. |
| Demo-data purge plan (`server/src/modules/demo-data/*`) | **Read** | The plan enumerates entities explicitly and has no sale entity; the visit-to-sale precedent says demo support for a new domain is a **separate mandatory slice** with purge order/preflight/count contracts (`visit-to-sale-data-lifecycle.md:195`). |
| Web shell (`web/src/services/api.ts`, `shell/route-access.ts`, `shell/navigation-model.ts`, `AppRouter.tsx`) | **Own (add entry)** | A capability must be added to the strict parser, route access, navigation and env example together; a partial addition gives a menu entry that renders `ForbiddenView` or a route no user can reach. |

---

## Open questions

1. **Invoice identity.** `invoiceNumber` today is free text on notes with no uniqueness,
   no format and no issuer. Does Accounting **migrate** existing note values into a
   document table (and keep the note text immutable per DOM-005), or leave them as
   historical free text? MOD-001 records the debt but not the resolution
   (`DECISIONS.md:2065-2066`).
2. **Line model.** `job_card_sale_items` is unique per `(sale, product)` and quantity is
   an integer product count. A priced document needs per-line price/VAT/discount and
   often several lines of the same product. Is a **new** accounting line table the
   intended answer (Core unchanged), or is the sale line to be widened? Widening it
   changes DOM-001/004 and SALE-001 snapshots.
3. **Who owns VAT rates.** DOM-004 forbids currency on Product; MOD-001 says "document
   tax data" belongs to Accounting. Is the VAT rate a document-time snapshot (no master
   data), or does Core need a tax-rate reference table?
4. **Customer master data.** `tax_office`/vergi dairesi, legal title (unvan) and VKN/TCKN
   type do not exist. Does Accounting own a customer-commercial-profile table keyed by
   `customers.id`, or does Core's `customers` grow those columns? The second option
   changes the CRM contract, `(org, tax_number)` unique semantics and the Staff-visible
   customer screen.
5. **Partial delivery / multiple deliveries per sale.** `job_cards_one_delivery_per_sale_idx`
   allows exactly one, ever (071:38-43), and MOD-001 §5 keeps multi-delivery as research
   (`DECISIONS.md:2056-2059`). Can an invoice reference more than one delivery, and can a
   sale produce more than one document, without reopening 071?
6. **Installation-level vs organization-level.** `processed_actions` requires a `user_id`
   FK to `users`; `operator_*` tables are installation-level. Which actor performs an
   accounting mutation — a customer user role (new role? new capability?), or the
   installation operator? MOD-002 §1 says each further operator capability needs its own
   decision including "how it is recorded in the owning module's audit"
   (`DECISIONS.md:3757-3760`).
7. **Module-state rollout order.** A new `ACCOUNTING` key needs migration 075, a takeover
   input, and an operator UI row. What is the default for existing installs (off), and
   what happens on a pre-075 backup restore followed by first start?
8. **Demo data.** Does Accounting need demo-able fixtures, and if so which purge
   order/preflight/count contracts does it owe? The precedent is explicit that "FK cascade
   already handles it" is not an acceptable answer
   (`docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:195`).
9. **Reporting boundary.** DOM-006 forbids revenue metrics. If Accounting is enabled, does
   `/reports` stay permanently money-free (Accounting gets its own screens), or does
   DOM-006 need an amendment? No one has decided this.
10. **Durable integration.** MOD-001 §4 forbids a generic event bus. If accounting must
    push documents to Logo/Netsis/Mikro, a narrow module-owned outbox contract must be
    designed first (`DECISIONS.md:2041-2048`); nothing exists today beyond the
    notification-scoped web-push outbox.

---

## Sources

All repository, read on 2026-11-26 from
`/Users/emrah/Documents/Servora-Med/.claude/worktrees/accounting-module-research-0100ad`
@ `89bf6b1`:

- `AGENTS.md` §6, §13 (`:174-184`, `:399-400`)
- `DECISIONS.md` DOM-001 (`:337-357`), DOM-004 (`:534-574`), DOM-005 (`:576-607`),
  DOM-006 (`:609-686`), SALE-001 (`:1966-1989`), MOD-001 (`:1991-2071`),
  SALE-QTY-001 (`:2073-2102`), SALE-002 (`:2104-2185`), OPS-002 (`:921-958`),
  MOD-002 (`:3735-3788`)
- `SERVORA_MED_SCHEMA_DRAFT.md` §3.6-3.10, §9 (`:223-300`, `:670-680`)
- `SERVORA_MED_API_DRAFT.md` §2, §9, §11, §19 (`:145-165`, `:451-516`, `:1044-1092`,
  `:1831-1841`)
- `docs/architecture/decision-reconciliation-report.md:95-104` ("Accounting A0" titles)
- `docs/features/operator-module-pilot.md` §5, §6, §7, §9
- `docs/features/visit-to-sale/visit-to-sale-design.md:125,135,144`
- `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:93,195,205`
- `docs/features/visit-to-sale/read-integration.md:245`
- `docs/features/visit-to-sale/visit-to-sale-implementation-plan.md:148`
- `docs/backlog/2026-11-25-core-modules-architecture-research.md` (prior research)
- Migrations `002`, `003`, `004`, `005`, `006`, `009`, `024`, `038`, `041`, `049`,
  `057`, `058`, `060`, `061`, `071`, `072`, `074` under `server/src/db/migrations/`
- Server modules `job-cards/`, `products/`, `crm/`, `reports/`, `people/`, `overview/`,
  `installation-modules/`, `operator/`, `capabilities/`, `backup/`, `demo-data/`,
  `auth/`, `db/critical-action.ts`
- Web `src/jobs/SaleDetails.tsx`, `SaleCorrection.tsx`, `JobNotes.tsx`, `sale-api.ts`,
  `src/JobDetail.tsx`, `src/ProductForm.tsx`, `src/services/api.ts`,
  `src/shell/route-access.ts`, `src/shell/navigation-model.ts`, `src/AppRouter.tsx`
- Tests `server/tests/sale-input.test.ts`, `sale-write-routes.test.ts`,
  `sale-002-s1-standalone-create-postgres.test.ts`, `sale-schema-postgres.test.ts`

No web sources were used; this note makes no external factual claim.
