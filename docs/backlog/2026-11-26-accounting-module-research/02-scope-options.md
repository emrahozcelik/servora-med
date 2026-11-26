# Accounting module scope options — light commercial documents inside MOD-001 §3

Status: research input for Accounting A0 and the owner's explicit approval (AGENTS.md §13).
Date: 2026-11-26. No code, migration, `DECISIONS.md` entry or production data was changed.
No test suite was run: this is a documentation-only research task.

Definitions used below:

- **Core** = JobCard lifecycle, CRM (customers/contacts), Products, Reports, auth and audit.
- **Accounting** = the proposed module that would own commercial documents, invoice references,
  customer open-account state, collections and tax data. It is not a general ledger.
- **Slice** = one vertical delivery unit (server + web + tests + docs) in the sense of
  `SERVORA_MED_MVP_SLICES.md`.
- **TRY-only** = no foreign currency, no FX revaluation, no currency conversion.

---

## Summary

- MOD-001 §3 authorizes a *light commercial layer* — quotes, commercial documents, invoice
  references/lines, basic current-account/receivable state, collections, document tax data and
  external accounting connections — while explicitly forbidding a general ledger
  (`DECISIONS.md:2032-2040`).
- The repository today stores **no** price, currency, invoice or payment data on SALE or delivery;
  the only structured invoice trace is a free-text note of at most 100 characters
  (`DECISIONS.md:349-351`, `server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`,
  `SERVORA_MED_SCHEMA_DRAFT.md:393`).
- Three concrete cuts are viable: **A** reference-only invoice ledger, **B** priced quote/order on
  Accounting-owned documents, **C** A+B plus customer open account, receivables and field
  collections.
- Cut A resolves the recorded `invoiceNumber` domain debt without adding price, currency or VAT;
  it amends no accepted decision, costs roughly 2–3 slices and carries low legal exposure.
- Cut B introduces the first price and VAT data inside Servora. It needs a new A0 decision on
  price/VAT ownership and document numbering, costs roughly 4–6 slices, and carries medium exposure
  because its PDF must never look like an invoice.
- Cut C is only trustworthy with an explicit opening-balance/import decision and payment
  allocation; it costs roughly 3–4 slices on top of A+B and carries medium-high exposure
  (cash tevsik limit, KVKK, TTK 89 “cari hesap” vs “açık hesap”).
- Issuing e-Fatura/e-Arşiv **inside** Servora is out for all three cuts. From 1 January 2026,
  taxpayers outside the delayed simple-basis/booking group must issue invoices as e-Arşiv/e-Fatura
  regardless of amount; a PDF titled “Fatura” produced by Servora would not be a valid e-Arşiv
  invoice. Medical-supply taxpayers are also a separate e-Fatura head that does not depend on the
  3 million TL turnover test.
- The catalog `referencePrice` cannot become the price master without amending DOM-004: it has no
  currency or financial meaning and is never copied into SALE or delivery
  (`DECISIONS.md:549-552`; `web/src/ProductForm.tsx:70`).
- No cut requires the future Warehouse module. Cut B can use the existing single
  `PRODUCT_DELIVERY` link; partial delivery/invoicing remains blocked by SALE-002
  (`DECISIONS.md:2154-2155`, `DECISIONS.md:2057-2059`).
- Recommendation: approve **A** now; decide **B** together with the accountant/ERP; defer **C**
  until A+B have produced real invoice references for at least one quarter.

---

## 1. Baseline: what the repository already has

The table is the factual starting point for every cut. All citations are repo paths and lines.

| Data element | Current state | Evidence |
| --- | --- | --- |
| Customer identity | `name` required; `tax_number` optional, normalized by stripping spaces/`.`/`-`/`/`, unique per organization; **no** VKN/TCKN length or checksum validation; **no** tax office, legal title, or separate billing address | `server/src/db/migrations/002_delivery_tracer.sql:5-24`; `server/src/db/migrations/004_crm_contacts.sql:5-15`; `server/src/modules/crm/types.ts:17,189-193` |
| Product price | `default_price NUMERIC(12,2)` exposed as `referencePrice`; nullable, non-negative, **no currency**, no sales/invoice/accounting/stock meaning; UI says it is informational only | `DECISIONS.md:549-552`; `server/src/modules/products/types.ts:12,43`; `SERVORA_MED_API_DRAFT.md:479-484`; `web/src/ProductForm.tsx:67-70`; `web/src/ProductDetail.tsx:61` |
| SALE line | Durable product identity + name/SKU/brand/model/unit snapshots + integer product count 1–999,999,999; **no price, currency, total, discount, invoice or payment field**; creating/correcting a sale creates no financial/stock operation | `server/src/db/migrations/057_sale_from_visit.sql:70-88`; `server/src/db/migrations/058_sale_integer_quantity.sql:19-24`; `server/src/modules/job-cards/sale-repository.ts:23-27`; `DECISIONS.md:1982-1985`; `DECISIONS.md:2077-2086`; `docs/features/visit-to-sale/README.md:56-59` |
| Delivery line | Purpose (`SALE`/`SAMPLE`/`CONSIGNMENT`/`RETURN`/`OTHER`) + positive quantity + actual delivery time; **no** unit price, discount, line total, invoice or payment state | `DECISIONS.md:349-351`; `SERVORA_MED_SCHEMA_DRAFT.md:393` |
| Invoice trace | Free-text `job_card_notes.invoice_number TEXT` (≤100 chars), allowed only on `SALES_MEETING` and `PRODUCT_DELIVERY` notes — **not on `SALE`**; UI shows the field only for those two types | `server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`; `server/src/modules/job-cards/notes-service.ts:22,40,56-60`; `web/src/jobs/JobNotes.tsx:71` |
| Seller legal identity | `organizations` has only `id`, `name`, `created_at`, `updated_at`; no tax number, tax office, address, MERSİS or IBAN | `server/src/db/migrations/001_auth_foundation.sql:3-8` |
| Document numbering | No document-number infrastructure exists: `rg` found no `CREATE SEQUENCE` or `nextval` in `server/src/db/migrations` (command output in Evidence) | Verified negative on 2026-11-26; the schema has no sequence/counter primitive |
| Accounting module / capability | No accounting module; the installation registry has exactly one module (`OVERVIEW`); `installation_module_state.module_key` CHECK accepts only `'OVERVIEW'`; `AuthenticatedCapabilities` has no accounting flag | `server/src/modules/installation-modules/registry.ts:7-24`; `server/src/db/migrations/074_installation_operator_and_module_state.sql:52-64`; `server/src/modules/capabilities/types.ts:1-8`; `DECISIONS.md:3765-3769` |
| Reports | No revenue, margin, commission, invoice, payment or valuation metric; reports endpoints are operational only | `DECISIONS.md:685-686`; `server/src/modules/reports/routes.ts:25-44` |
| Audit | `audit_events` requires an organization + user actor; `subject_type` CHECK is only `USER`/`STAFF_PROFILE`; the event list is a closed CHECK | `server/src/db/migrations/003_people.sql:32-51`; `server/src/db/migrations/023_staff_confidential_notes.sql:96-110` |
| Idempotency | `processed_actions` unique on `(organization_id, user_id, client_action_id, operation_key)` with a SHA-256 `request_hash` | `server/src/db/migrations/002_delivery_tracer.sql:196-216`; `server/src/db/migrations/036_job_card_invalidated.sql:131-133` |
| Demo vs business data | `data_class` is `BUSINESS` or `DEMO` with `demo_dataset_id`; demo purge is a first-class concern | `server/src/db/migrations/034_demo_data_foundation.sql:41-46` |
| Roles | `ADMIN`, `MANAGER`, `STAFF` only | `server/src/modules/auth/types.ts:1` |
| PDF | `pdfmake` 0.3.11 is already a server dependency and is used by the weekly-report PDF renderer; Cut B needs no new PDF library | `server/package.json:43`; `server/src/modules/weekly-reports/pdf/renderer.ts:5,34` |

**Consequence:** the repo cannot answer “what did we quote?”, “what is outstanding?”, or “which
invoices are unpaid?” today. It can answer operational quantity questions only. That is exactly
the gap MOD-001 §3 describes (`DECISIONS.md:2032-2035`).

---

## 2. What each MOD-001 §3 capability means for this business

### 2.1 The field scenario

A **Saha personeli** (STAFF) visits a dental clinic, records a `SALES_MEETING`, then a `SALE`
with, say, 4 products (implant boxes, sutures, a curing light). The clinic owner asks for a
written price with KDV. The distributor's back office issues the real invoice in Logo/Netsis/Mikro
(the possible external financial authority named in `DECISIONS.md:2038-2040`) or through its
e-Fatura integrator. The goods leave the warehouse by van with a `sevk irsaliyesi`
/ e-İrsaliye. The clinic pays by bank transfer 45 days later; the accountant matches the payment
to the invoice. Servora currently records only the visit, the sale quantity, delivery
purpose/quantity and a free-text invoice number in a note
(`server/src/db/migrations/057_sale_from_visit.sql:70-88`;
`server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`).

A **Yönetici** (MANAGER) needs the quote/order trail, the invoice closure and the ageing list. An
**Admin** needs the seller legal identity, numbering, access policy and audit. The external
accountant needs a clean export, not a second ledger.

### 2.2 Capability table

Absence claims in the “Depends on” column are evidenced in the §1 baseline table.

| MOD-001 §3 capability | What it means here | Minimum data | Depends on | Legal status |
| --- | --- | --- | --- | --- |
| **Quotes (teklif)** | A non-binding priced offer left after a clinic visit; valid 7–30 days; may be revised; the clinic compares it with competitors | Customer + contact; seller identity; quote no/date/valid-until; TRY; lines (product snapshot, description, integer qty, unit, unit price, line discount, VAT rate); net/VAT/gross; status; version; author | Customer (exists), product snapshot (exists), **authoritative price (absent)**, **currency (absent)**, seller profile (absent), numbering (absent). **Does not need a SALE** — a quote precedes the agreement | Not a tax document; no GİB format. A signed, priced quote may be a commercial document; stamp-tax treatment is a legal-classification question for the accountant ([S9], [S10]; accessed 2026-11-26; **UNVERIFIED for quotes**) |
| **Commercial/sales documents (sipariş/satış belgesi)** | The clinic's confirmed order; the back office turns it into an ERP order/invoice; the field team needs a printable confirmation | Quote link/revision; order no/date; buyer legal title, tax no, tax office, billing address; delivery address; priced lines with VAT; totals; payment/delivery terms; status; confirmation time; seller profile | Quote data + **buyer legal identity (partially absent)**; SALE optional; delivery optional | Commercial document, **not** an invoice. Must not be titled “Fatura” and must not carry e-Fatura/e-Arşiv markers. A signed order may be a “mukavelename” for stamp tax ([S9], [S10]; accessed 2026-11-26; accountant to confirm) |
| **Invoice references and lines (fatura referansı ve satırları)** | The invoice is issued outside Servora; Servora records the reference so the sale/order is closed and the receivable exists | Reference: customer; invoice no; invoice date; issuer kind; TRY; gross total; optional VAT total/withholding; due date; optional SALE/delivery/order link; optional e-Arşiv UUID/ERP id; status; void reason. Lines only if quantity reconciliation or partial invoicing is needed | Customer (exists), SALE/delivery (exists), issuer (external), **due date (new)**, **currency (new)**. No price authority needed: totals come from the invoice | Records an existing legal document; does not issue one. Low risk. Duplicate invoice numbers across issuers must be handled by an issuer-qualified unique key |
| **Current account (cari hesap)** | Per-customer statement of invoices (debit) and collections (credit) with a running balance; used before a visit and for follow-up | Customer; opening position at cutover; invoice refs (date, due date, gross, withholding, payable); collections (date, amount, method); allocations; derived balance; TRY | Invoice references (A) + collection records (C1); customer; due dates; **opening balance/import** | TTK 89 “cari hesap” is a **written netting contract**; without it the relationship is an “açık hesap” ([S11], accessed 2026-11-26). The module is a ledger view, not a legal account or a substitute for the ERP ledger |
| **Receivables (alacak)** | Open invoice balances, due/overdue, ageing 0–30/31–60/61–90/90+, customer risk list | Invoice refs + due dates + allocations + customer; derived, no new table in V1 | Current account; correct due dates; withholding; credit notes/returns (out of V1) for accuracy | Management reporting, not a legal claim. Dunning/legal collection is out |
| **Collection records (tahsilat)** | Field staff or back office records a bank transfer / cash / credit-card payment; allocates it to invoices; optionally prints a receipt | Customer; date; amount; TRY; method; external reference (bank ref/cheque no); collector user; receipt no; allocations; status; void reason | Invoice refs; customer; users; **no bank/PSP integration** | “Tahsilat makbuzu” is payment evidence (TBK 103), not a VUK tax document. Settlements above 30,000 TL must go through a financial institution (VUK mükerrer 257; Tebliğ 459 as amended by 575) — a receipt does not cure it ([S12], [S13], [S14]; accessed 2026-11-26) |
| **Document tax data (KDV oranı/tutarı, tevkifat?)** | Per-line VAT rate and amount; VAT-inclusive/exclusive mode; document totals; withholding only if the buyer withholds | `vatRate` from a closed set {0,1,10,20}; `net`; `vatAmount`; `gross`; `pricesIncludeVat`; optional `withholdingAmount`; **no tax-classification engine** | Product tax class (new, optional), accountant's rules, ERP reconciliation | Rates are **VOLATILE** (20/10/1 since 10.07.2023). Medical devices/medicines are generally 10%, general rate 20%; classification liability stays with the taxpayer ([S5], [S6], accessed 2026-11-26). No general tevkifat for ordinary medical-supply deliveries; specified services/deliveries and certain buyers only ([S7], [S8], accessed 2026-11-26) |
| **External accounting connections** | Send confirmed quotes/orders to the ERP, receive invoice references, export collections; or a manual file exchange | Export batch; direction; document ids; external id; status; error; retry count; idempotency key; CSV/JSON; no credentials in repo | ERP/integrator contract; MOD-001 §4 forbids a generic bus/outbox, but a narrow module-owned contract is allowed | Data transfer/KVKK; no GİB filing, no e-Defter. Official e-document formats and integrator rules are in [S16]–[S18] (accessed 2026-11-26) |

**Invoice lines, if included:** invoice line number, description, quantity in the invoice's own
unit, unit price, VAT rate/amount, line total, and an optional source document line. Do not map the
invoice quantity to the SALE integer count without a unit decision; the invoice's unit is
authoritative for the invoice line. Lines are only justified by quantity reconciliation or partial
invoicing, neither of which exists today (SALE-002 allows one delivery per sale and no partial
deliveries, `DECISIONS.md:2154-2155`).

### 2.3 Dependency matrix

| Capability | Customer tax identity | Authoritative price | Currency | SALE line |
| --- | --- | --- | --- | --- |
| Quote | Buyer title/tax no useful for B2B, not legally required on a quote | **Required** | **Required** | Not required; optional link after acceptance |
| Order | **Required** (legal title, tax no, tax office, billing address) | **Required** | **Required** | Optional link; the order may precede or follow the SALE |
| Invoice reference | Only the CRM customer link is required; the invoice itself is authoritative | Not required (totals come from the invoice) | **Required** | Optional link; useful for the worklist |
| Current account | Customer id | Not required | **Required** | Not required |
| Receivables | Customer id | Not required | **Required** | Not required |
| Collections | Customer id | Not required | **Required** | Not required |
| Document tax data | Buyer identity for the document | **Required** (net base) | **Required** | Not required |
| External connection | Depends on the document | Depends on the document | **Required** | Optional |

### 2.4 Cross-cutting obligations

1. **Do not make Accounting documents JobCard subtypes.** `SERVORA_MED_SCHEMA_DRAFT.md:680`
   explicitly omits “quote and collection JobCard types”; MOD-001 §1 keeps job identity and
   lifecycle in Core (`DECISIONS.md:2016-2021`). Accounting needs its own aggregate and status
   machine, reusing only the idempotency, audit and authorization *patterns*.
2. **Idempotency.** Every issue/void/allocation/export is a critical mutation. Reuse the
   `processed_actions` receipt pattern (`server/src/db/migrations/002_delivery_tracer.sql:196-216`)
   and hash the exact request; do not invent a second idempotency mechanism (AGENTS.md §7).
3. **Audit.** `audit_events` cannot currently record an Accounting subject or event type
   (`server/src/db/migrations/003_people.sql:36-44`; `023_staff_confidential_notes.sql:96-110`).
   Either extend the CHECK lists (a migration) or own a module audit table; decide explicitly.
4. **Delete protection.** Products and contacts used by Accounting must join the existing
   operation-history guards, otherwise a product used in a quote could be hard-deleted
   (`server/src/modules/products/repository.ts:90-98,167-176`;
   `server/src/modules/crm/repository.ts:297-311,422-430`). Offboarding writes to many tables and
   must know the new collector/creator references (`docs/backlog/2026-11-25-core-modules-architecture-research.md:42`).
5. **Demo data.** Accounting rows need a `data_class` decision: either BUSINESS-only, or
   DEMO-tagged and purgeable like the rest (`server/src/db/migrations/034_demo_data_foundation.sql:41-46`).
6. **Module activation.** Adding `ACCOUNTING` to the operator registry and
   `installation_module_state` CHECK is a MOD-002 contract change, not a free registry entry
   (`DECISIONS.md:3765-3769`; `server/src/db/migrations/074_installation_operator_and_module_state.sql:52-64`).
7. **Scope authorization precedent.** Organization-wide CRM visibility does not grant mutation;
   STAFF mutation is action-scoped to the assigned customer or an active job
   (`DECISIONS.md:1934-1949`). Accounting should follow the same “visibility ≠ write” rule.

---

## 3. Scope cuts

All three cuts are **inside** MOD-001 §3. None builds a ledger, chart of accounts, journal,
e-Defter, payroll, full bank reconciliation or posting engine (`DECISIONS.md:2036-2038`).

### 3.1 Cut A — Reference-only invoice ledger

**Definition.** A small ledger of invoice *references* issued outside Servora: number, date,
issuer system, customer, TRY gross total (informational), optional VAT total, optional due date,
optional link to the SALE/delivery, optional e-Arşiv UUID/ERP id. No lines, no computed totals,
no price authority, no collections. It replaces the `invoiceNumber` note debt for new records.

**User stories.**

- **Saha personeli:** after a completed delivery/sale, opens the record and sees “Faturalandı —
  12.11.2026” or “Fatura bekliyor”; cannot create or edit a reference; does not see the money
  total unless the owner explicitly allows it (see access rule below).
- **Yönetici:** receives the invoice number/date from the accountant; records it against the
  SALE/delivery; sees a worklist of approved sales with no invoice reference after N days; voids a
  wrong reference with a reason (never deletes).
- **Admin:** sees all references, corrects issuer labels, and audits who recorded/voided what. No
  settings bag: issuer kind is a fixed enum.
- **External accountant:** no new role in V1. Do not share a MANAGER account with an external
  person; a future “accountant” capability/role is a separate decision. A CSV import/export is the
  safer collaboration surface.

**Access rule.** Write is MANAGER/ADMIN only in V1. Saha personeli is read-only on a SALE/delivery
it can already read, and sees only “invoiced / not invoiced” plus the invoice date; money totals
are hidden from STAFF by default. This follows the CRM-S2-001 “visibility ≠ mutation” precedent
(`DECISIONS.md:1934-1949`) and avoids an accidental field-wide disclosure of invoice totals before
the owner decides it.

**Data owned (one reference table and one worklist; a link table may be added for consolidated
invoices).**

| Table | Key fields | Rules |
| --- | --- | --- |
| `accounting_invoice_references` | `id`, `organization_id`, `customer_id`, nullable `sale_job_card_id` (SALE only), nullable `delivery_job_card_id` (PRODUCT_DELIVERY only), `invoice_number`, `invoice_date`, `issuer_kind` (`LOGO`/`NETSIS`/`MIKRO`/`E_FATURA_INTEGRATOR`/`E_ARSIV_PORTAL`/`OTHER`), nullable `issuer_label`, `currency` (`TRY`), nullable `total_gross NUMERIC(14,2)`, nullable `total_vat NUMERIC(14,2)`, nullable `withholding_amount NUMERIC(14,2)`, nullable `due_date`, nullable `external_document_id`, nullable `document_url`, `status` (`RECORDED`/`VOID`), nullable `void_reason`/`voided_at`/`voided_by`, `created_by`, `created_at`, `version` | `total_gross` is null or `>= 0`; `total_vat` is null or `0 <= total_vat <= total_gross`; `due_date >= invoice_date` when both exist; unique `(organization_id, issuer_kind, coalesce(issuer_label,''), upper(trim(invoice_number)))`; void is append-only (status + reason), no hard delete; `document_url` is `https` only and is a link, **not** an upload. A reference without a total is allowed in A but is a data-quality flag; Cut C needs a total to compute a balance |
| Worklist (query) | Approved (`COMPLETED`) `SALE`/`PRODUCT_DELIVERY` with no non-void reference after N days (`COMPLETED` is the terminal approved status; `server/src/modules/job-cards/types.ts:11-14`) | Derived SQL only; no stored “invoiced” flag on the JobCard; do not mutate Core |

**Consolidation caveat.** A real ERP invoice can cover several orders or sales. A single
`sale_job_card_id` then cannot express the link without duplicating the total across rows, which
would double-count a later balance. Decide in `ACC-A`: either one reference per invoice plus a link
table to the covered sales/orders, or one reference per sale plus an explicit consolidated-group
identifier. Do not copy the same total onto several reference rows.

**Reads from Core.** Customer name/tax number; SALE header/items/status; delivery header/status;
staff visibility for the linked SALE/delivery. It never writes to Core and never changes SALE
status.

**Decision impact.** Amends **nothing**. It resolves the recorded `invoiceNumber` debt
(`DECISIONS.md:2065-2066`) for new records; the historical note column stays and is not
backfilled. It needs a new `ACC-A` decision (module existence, ownership, roles, non-goals) because
AGENTS.md §13 and MOD-001 §3 require explicit approval. It does not touch DOM-001, DOM-004,
DOM-006, SALE-001/002 or REPORT-001/002. Adding the module to MOD-002 is a later registry slice.

**Regulatory exposure.** Low. Servora records a document issued elsewhere; it does not issue one.
Do not print an “invoice”; label the UI “Fatura referansı (bilgi amaçlı)”. Do not claim the total
is the accounting record. Duplicate invoice numbers are possible across issuers and across
corrected invoices; the unique key must include the issuer. Retention and KVKK follow the
customer's policy; the exact legal retention period is **UNVERIFIED** here and belongs to the
accountant.

**Size.** ≈2–3 slices: (A1) schema + service + API + tests + audit/idempotency; (A2) UI on
SALE/delivery/customer + worklist; (A3, optional) CSV import from the ERP's open-invoice/aging
export. The CSV import is the cheapest “integration” and should be preferred over an API.

**Biggest risk.** It becomes a **shadow invoice register**: finance starts reconciling against it,
but it has no lines, no payment state and no guarantee that the total matches the real invoice.
Mitigation: explicit “informational” labeling, a worklist rather than a revenue report, and an
issuer-qualified unique key.

**Explicitly not in A.** No lines, no per-line VAT, no totals computation, no payments, no
balances, no ageing, no price list, no PDF invoice, no e-Fatura/e-Arşiv issuance, no attachments.

---

### 3.2 Cut B — Priced commercial documents (quote + order)

**Definition.** Accounting owns priced **Teklif** and **Sipariş** documents built on customer,
contact and product snapshots. Per-line VAT, document totals, statuses, a non-legal PDF, and a
file export to the ERP. No official invoice.

**User stories.**

- **Saha personeli:** at the clinic, creates a quote with 5 products in a few minutes; sees
  KDV-exclusive prices and the KDV/gross total; applies a line discount within an allowed limit;
  downloads/sends a PDF; cannot confirm an order or exceed the discount limit without a manager.
- **Yönetici:** reviews quotes above a threshold or with a discount; converts an accepted quote to
  an order; confirms it; exports it to the ERP; sees the order's status; voids with a reason.
- **Admin:** maintains the seller legal profile and the document number series; sees all documents
  and the audit trail; never deletes an issued document.
- **External accountant:** receives a CSV/JSON export or the ERP order; no shared login.

**Data owned.**

| Table | Key fields | Rules |
| --- | --- | --- |
| `accounting_issuer_profiles` | `organization_id`, `legal_title`, `tax_number`, `tax_office`, `address`, `phone`, `email`, optional `mersis_no`, optional `iban`, `version`, `is_active` | One active profile per organization in V1; Admin-only mutation; snapshot into every document; no logo/file upload |
| `accounting_documents` | `id`, `organization_id`, `type` (`QUOTE`/`ORDER`), `number`, `revision`, `status`, `customer_id`, nullable `contact_id`, nullable `sale_job_card_id`, nullable `source_quote_id`, `issuer_profile_id`, `buyer_title`, `buyer_tax_number`, `buyer_tax_office`, `buyer_address`, `delivery_address`, `currency` (`TRY`), `prices_include_vat` (false in V1), nullable `valid_until`, nullable `confirmed_at`, `notes`, `subtotal_net`, `total_vat`, `total_gross`, `version`, `created_by`, nullable `issued_at`, nullable `cancelled_at`/`cancel_reason` | Quote statuses: `DRAFT` → `ISSUED` → `ACCEPTED`/`REJECTED`/`EXPIRED`/`CANCELLED`; order statuses: `DRAFT` → `CONFIRMED` → `FULFILLED`/`CANCELLED` (`FULFILLED` is an explicit command in V1; it is not auto-set by a delivery event). Issued documents are immutable; totals are computed server-side and snapshotted at issue; a revision is a new row linked to the prior one; no hard delete; status transitions checked in the service and by DB constraints |
| `accounting_document_lines` | `id`, `organization_id`, `document_id`, `sort_order`, nullable `product_id`, `description`, `quantity` (integer 1–999,999,999 in V1), `unit_snapshot`, `unit_price NUMERIC(14,4)`, `discount_amount NUMERIC(14,2)`, `vat_rate` (0/1/10/20), `line_net`, `line_vat`, `line_gross`, nullable `source_sale_item_id` | `discount_amount >= 0` and `<= quantity * unit_price`; line net = qty × price − discount; VAT = net × rate; line totals are computed server-side and frozen at issue; document totals = sum of lines; no document-level discount in V1; no mixed VAT-inclusive lines |
| `accounting_document_counters` | `organization_id`, `type`, `year`, `last_number` | `SELECT … FOR UPDATE` in the issue transaction; number format `TKF-2026-000001` / `SIP-2026-000001`; gaps are allowed (these are not legal invoice series); never reuse a number |
| `accounting_document_events` (or extended `audit_events`) | document id, event (`ISSUED`/`ACCEPTED`/`REJECTED`/`CONFIRMED`/`CANCELLED`/`VOIDED`/`EXPORTED`), actor, at, metadata | Append-only; same transaction as the document mutation |

**Reads from Core.** Customer + contact; product identity (snapshot at line add; the same pattern as
`server/src/db/migrations/057_sale_from_visit.sql:70-88`); optional SALE header/items (prefill or
link); optional `PRODUCT_DELIVERY` status for `FULFILLED`. It never writes to Core and never changes
SALE status.

**Decision impact.** Needs a new `ACC-B` decision covering at least: (a) **price/VAT data
ownership**, (b) document numbering, (c) buyer legal identity, (d) statuses and approval authority,
(e) whether a priced panel appears on the SALE detail. DOM-004 is **not amended**, but
`referencePrice` cannot be the master: it has no currency or financial meaning and is never copied
(`DECISIONS.md:549-552`). SALE-001/002 stay unchanged if Accounting keeps money out of the SALE
DTO/UI; if a priced quote panel is added to the SALE detail, the UX note that says no financial
totals are shown must be amended (`docs/features/visit-to-sale/visit-to-sale-implementation-plan.md:148`;
`docs/features/visit-to-sale/README.md:58`). DOM-006 stays unchanged unless document totals enter
operational reports; that would be a new reporting decision, not a silent extension
(`DECISIONS.md:685-686`). DOM-001 stays: no money on delivery items (`DECISIONS.md:349-351`).

**Regulatory exposure.** Medium.

- A quote/order is not a tax invoice. Label it **“TEKLİF”** / **“SİPARİŞ”**, print “Bu belge fatura
  yerine geçmez”, and never use “Fatura”, “e-Fatura”, “e-Arşiv”, a GİB QR code or a mali mühür
  image.
- From 1 January 2026, taxpayers outside the delayed simple-basis/booking group must issue invoices
  as e-Arşiv/e-Fatura regardless of amount; a Servora PDF titled “Fatura” would not be a valid
  e-Arşiv invoice ([S2], [S4]; accessed 2026-11-26). **VOLATILE:** thresholds and dates change by
  tebliğ.
- e-Fatura is already a separate obligation head for medical-supply taxpayers, independent of the
  3 million TL turnover test ([S1] §IV.1.4(a)(6); [S3]); the customer's accountant must confirm the
  exact scope.
- VAT rates are 20% general, 10% for list (II) (including medicines and medical devices), 1% for
  list (I), since 10.07.2023 ([S5], [S6]; accessed 2026-11-26). **VOLATILE.** Servora must not
  classify products; the user selects the rate, and the taxpayer remains liable.
- No general tevkifat applies to ordinary medical-supply deliveries; tevkifat is limited to
  specified services/deliveries and certain buyers ([S7], [S8]; accessed 2026-11-26). Do not
  compute it in V1; store an optional `withholdingAmount` only if the ERP invoice shows one.
- A signed, priced order may be a “mukavelename” under the stamp-tax table (binde 9,48 in 2026);
  whether a particular quote/order is taxable is a legal-classification question for the
  accountant ([S9], [S10]; accessed 2026-11-26). **UNVERIFIED for quotes.** The module must not
  compute or declare stamp tax.

**Size.** ≈4–6 slices: (B1) issuer profile + counters + document/line schema + totals + statuses +
tests; (B2) quote create/edit/issue UI; (B3) order conversion + PDF (reuse `pdfmake`); (B4) export
+ audit + permissions + delete-protection integration; (B5) hardening/round-trip tests with the
accountant's examples.

**Biggest risk.** **Price authority and legal drift.** Without an authoritative price source, either
staff type every price (inconsistent, discount abuse) or `referencePrice` becomes de facto money
(contradicts DOM-004). The second risk is that a well-designed PDF is mistaken for an invoice,
which turns a commercial feature into a tax-compliance incident.

**Explicitly not in B.** No e-Fatura/e-Arşiv issuance, no invoice number generation, no official
invoice series, no credit notes/returns, no partial invoicing, no stock reservation, no cost/margin,
no multi-currency, no e-signature, no customer portal, no email/WhatsApp sending.

---

### 3.3 Cut C — Light open account, receivables and field collections

**Definition.** Cut A + Cut B + per-customer open-account state: invoice references with due dates,
collection records, allocation of collections to invoices, derived balance, ageing, statement
export, and a field collection receipt. No general ledger, no bank reconciliation.

**User stories.**

- **Saha personeli:** before a visit, sees that the clinic has 2 open invoices and one is 45 days
  overdue (only if the owner grants this visibility); after a bank transfer / credit-card / cash
  collection, records the amount, method and reference; cheque and senet are out of V1; cannot
  allocate or void without a manager.
- **Yönetici:** works the ageing list; allocates a 30,000 TL bank transfer across three invoices;
  records a partial payment; voids a wrong collection with a reason; exports a customer statement.
- **Admin:** sees all balances and audit; manages the collector policy; handles cutover opening
  balances.
- **External accountant:** receives a collections/aging export; never shares a login.

**Data owned.**

| Table | Key fields | Rules |
| --- | --- | --- |
| `accounting_collections` | `id`, `organization_id`, `customer_id`, `collection_date`, `amount NUMERIC(14,2)`, `currency` (`TRY`), `method` (`BANK_TRANSFER`/`CASH`/`CREDIT_CARD` in V1), nullable `external_reference`, `collector_user_id`, `receipt_number`, `status` (`RECORDED`/`VOID`), nullable `void_reason`/`voided_at`/`voided_by`, `created_by`, `version` | Amount > 0; receipt number unique per organization (same transactional counter pattern as documents); void is append-only; no hard delete; a `CASH` row above the current tevsik limit requires a reason and a manager-visible warning, but that warning **does not** make the settlement compliant — the legal route is a bank/PSP/PTT payment |
| `accounting_collection_allocations` | `id`, `organization_id`, `collection_id`, `invoice_reference_id`, `amount NUMERIC(14,2)` | Sum of allocations ≤ collection amount; sum per invoice ≤ invoice payable − prior allocations; unique `(collection_id, invoice_reference_id)`; allocation and collection commit atomically; voiding a collection reverses its allocations in the same transaction. An unallocated remainder is an on-account credit (avans), not a negative invoice |
| `accounting_opening_positions` (optional) | `organization_id`, `customer_id`, `as_of_date`, `amount`, `note`, `created_by` | Only for residual cutover differences; prefer importing all open invoices (number, date, due date, gross, paid-to-date) so ageing is correct; one opening position per customer per cutover date |
| Balance / ageing (query) | Opening + invoice debits − collection credits; ageing by due date | Derived SQL, not a stored mutable balance; if performance requires a projection later, it must be rebuildable from the append-only rows |

**Reads from Core.** Customer, users (collector), SALE/delivery links, role/capability. It never
writes to Core.

**Decision impact.** Needs a new `ACC-C` decision covering: (a) **who may see customer balances and
invoice totals** (STAFF vs MANAGER/ADMIN), (b) collection custody and receipt printing, (c)
opening balances/import at cutover, (d) whether ageing appears in `/reports` or only in the
Accounting module, (e) KVKK/retention. DOM-006 is **not amended as a record**, but adding an ageing
surface to `/reports` extends the reporting domain and needs an explicit reporting decision; do not
mix receivables with Staff performance metrics (`DECISIONS.md:685-686`; REPORT-001/002 at
`DECISIONS.md:613-620`). REPORT-001/002 remain untouched. DOM-001/004 and SALE-001/002 remain
unchanged.

**Regulatory exposure.** Medium-high.

- **TTK 89 “cari hesap”**: a cari hesap contract is valid only in writing and nets mutual claims;
  without it the relationship is an “açık hesap” ([S11], accessed 2026-11-26). The module should
  call the object “customer open account (açık hesap)” internally and may use “Cari Hesap” as a UI
  label with a disclaimer; it is not a legal account or a substitute for the ERP ledger.
- **Tahsilat makbuzu**: payment evidence under TBK 103, not a VUK tax document
  ([S12], accessed 2026-11-26). It does not replace an invoice.
- **Cash tevsik**: settlements above 30,000 TL must go through a bank/PSP/PTT; a receipt does not
  cure a cash settlement above the limit ([S13], [S14]; accessed 2026-11-26). **VOLATILE**
  (the limit was 7,000 TL before 30.11.2024). Do not silently block legitimate historical records;
  warn, require a reason, and surface high-cash collections to a manager.
- **Cheque/senet**: portfolio instruments with endorsement/protest/bounce states; do not treat them
  as cash. V1 should exclude them unless the business actually collects them; then a separate
  portfolio sub-slice is required.
- **KVKK**: sole-proprietor clinics are real persons; tax number, address, phone and balances are
  personal data. Role-scope reads, audit exports, avoid public document URLs, and never log
  financial payloads (AGENTS.md §5; [S15], accessed 2026-11-26).

**Size.** ≈3–4 slices on top of A+B: (C1) collections + allocations + receipt; (C2) balance/ageing
queries + UI; (C3) opening balances/import + statement PDF/CSV; (C4) cash policy + visibility +
audit hardening.

**Biggest risk.** **Trust/reconciliation.** A half-built receivable ledger that disagrees with the
accountant's ERP is worse than no ledger. The opening balance, allocation rules and withholding
handling must be exact, or finance will abandon the module. Cash custody and staff access to
financial data are the second risk.

**Explicitly not in C.** No general ledger, no bank statement import/reconciliation, no cheque/senet
portfolio, no dunning/legal collection/interest, no credit limit enforcement, no supplier payables,
no expense/petty cash, no multi-currency, no tax filing.

---

### 3.4 What is common to all cuts

- A new module directory with `routes.ts`/`handlers.ts`/`service.ts`/`types.ts` and its own
  migrations, following the repo's separation rules (AGENTS.md §2.4).
- Organization-scoped rows, composite FKs, optimistic `version`, named commands, append-only
  history, idempotent mutations, same-transaction audit.
- No generic settings bag (UI-002, `DECISIONS.md:102-121`): issuer kinds, methods, VAT rates and
  statuses are typed code enums, not JSON.
- No new dependency for Cut A; Cut B reuses `pdfmake`; Cut C needs no new dependency.
- No production data, credentials or external calls in this research.

---

## 4. Explicit exclusions (with reasons)

MOD-001 citations for the ledger/payroll/reconciliation/posting exclusions:
`DECISIONS.md:2036-2038`. Warehouse ownership: `DECISIONS.md:2022-2031`.

| Excluded item | Why it is out | Who owns it instead |
| --- | --- | --- |
| General ledger (defter-i kebir), trial balance (mizan), financial statements | Legal bookkeeping, account balances, period close and statements; MOD-001 forbids a full GL | ERP / SMMM |
| Chart of accounts (hesap planı) | Tekdüzen Hesap Planı discipline, account hierarchy and posting rules | ERP / SMMM |
| Journals (yevmiye), opening/closing entries | Double-entry posting and legal books; MOD-001 forbids | ERP / SMMM |
| e-Defter | GİB berat, certified software, legal electronic ledger; MOD-001 forbids | ERP / e-Defter software |
| Payroll (bordro), SGK bildirgeleri, wage withholding | Employment law, SGK, payroll; MOD-001 forbids payroll | Payroll/HR system |
| Full bank reconciliation (banka mutabakatı) | Statement import, matching rules, bank APIs; MOD-001 forbids full reconciliation | ERP / bank |
| Posting engine / generic double-entry | MOD-001 forbids a general posting engine; the ERP is the posting authority | ERP |
| Fixed assets (duran varlıklar), depreciation (amortisman) | Asset register, depreciation schedules, legal reporting | ERP |
| Cost accounting, inventory valuation, COGS, margin | Requires purchase cost and stock valuation; DOM-004 keeps the catalog informational; MOD-001 excludes | Warehouse + ERP |
| Multi-currency, FX revaluation, FX gain/loss | No currency exists today; requires TCMB rates, revaluation and legal reporting | ERP |
| Tax filing (KDV/KV beyannamesi, BA-BS, e-Beyanname) | Filing liability and GİB credentials; Servora has no filing role | Accountant / ERP |
| **e-Fatura / e-Arşiv issuance** | Requires GİB registration, mali mühür/e-imza, UBL-TR, an integrator or GİB portal; AGENTS.md §13 forbids e-invoice integration without explicit approval. **Out for A, B and C** | ERP / e-Fatura integrator |
| **e-İrsaliye / sevk irsaliyesi issuance** | VUK 230/5 legal dispatch document; a `PRODUCT_DELIVERY` row is an operational record, not a dispatch note. **Out for A, B and C** | ERP / e-İrsaliye integrator |
| e-SMM (serbest meslek makbuzu) | Not applicable to a distributor | — |
| Official invoice numbering / invoice series | Only the issuer (ERP/integrator) may generate the legal number; Servora stores references | ERP / integrator |
| Credit notes, returns, debit notes (iade/düzeltme) | A0 open item; returns are operational (`RETURN` purpose) and the financial correction belongs to the ERP | ERP |
| Cheque/senet portfolio, endorsement, protest, bounce | Portfolio lifecycle and legal follow-up; not cash | ERP / finance |
| Dunning, legal collection (icra), default interest | Legal process and interest calculation | Finance / lawyer |
| Customer credit limit / sales blocking | A policy layer over receivables; needs its own decision | Future decision |
| Supplier payables / purchase invoices | The module is sales-side only | ERP |
| Expense management / petty cash | Different domain | ERP |
| Bank API / open banking / statement import | Integration and credential risk; not needed for V1 | Bank / ERP |
| Attachment upload / file storage | Explicitly out of scope (`PRODUCT_REQUIREMENTS.md:424`; `SERVORA_MED_SCHEMA_DRAFT.md:677`); a URL reference only | Document store |
| E-signature of quotes/orders | Legal e-signature infrastructure; not needed for a commercial offer | Future decision |
| Customer portal / email / WhatsApp sending | Notification channel; not part of the document record | Messaging |
| Invoice OCR / PDF parsing | Error-prone, not needed when the ERP exports structured data | — |
| GİB registered-user (e-Fatura mükellefiyet) query | Requires GİB integration; the ERP/integrator already does it | ERP / integrator |
| Product tax classification engine | Classification is the taxpayer's/accountant's liability; the user selects the rate | Accountant |
| Revenue recognition (TFRS 15), margin, commission | DOM-001 and DOM-006 exclude revenue/margin/commission (`DECISIONS.md:351`; `DECISIONS.md:685-686`) | ERP / future decision |
| Budgeting, forecasting, consolidation | Out of product scope | ERP / BI |
| Multi-tenant SaaS administration | ARC-002 is single-organization (`DECISIONS.md:445`) | — |

**e-Fatura/e-Arşiv per cut:** **A — out** (records a reference only); **B — out** (commercial
quote/order only, explicitly “fatura yerine geçmez”); **C — out** (collections/statement only).
No cut moves Servora into the legal e-document issuer role. That would be a separate integration
decision, not an Accounting A0 slice.

---

## 5. Where price lives

DOM-004 is explicit: `referencePrice` is nullable, non-negative, has **no currency or financial
meaning**, and is **not copied into delivery items** (`DECISIONS.md:549-552`). The API repeats that
it has “no currency, sales, invoice, accounting, or stock-valuation meaning”
(`SERVORA_MED_API_DRAFT.md:483-484`), and the UI says it is informational only
(`web/src/ProductForm.tsx:70`). SALE lines have no price at all
(`server/src/db/migrations/057_sale_from_visit.sql:70-88`;
`server/src/modules/job-cards/sale-repository.ts:23-27`). Therefore price authority is a **new**
decision, not an existing field to reuse.

| Option | How it works | Consequences |
| --- | --- | --- |
| **1. Accounting price list (master)** | Versioned lists per customer segment/currency; approval; import/export with the ERP | Consistent field pricing, but duplicates the ERP master, needs governance, sync and price-history ownership; heaviest build. Requires an explicit price/VAT decision |
| **2. Manual per document** | Staff/manager types the unit price per line; optional “last price used for this customer/product” suggestion derived from prior documents | Smallest correct build; no master to govern; but price inconsistency, discount abuse and typing errors. Needs a discount/price approval threshold. Still requires an explicit price/VAT decision |
| **3. External ERP authority** | The ERP holds the price list; Servora reads a price feed/export, or the quote is created in the ERP and Servora only displays/downloads it | Single authority, no duplicate master; but integration dependency, stale/offline prices, and the field may not have a price at the clinic. Requires an integration contract under MOD-001 §4 |
| **4. Catalog `referencePrice` as authority** | Use the existing product field as the default/authoritative price | **Rejected.** Contradicts DOM-004 (no currency, no financial meaning, never copied); would require a DOM-004 amendment, currency, price history, and governance. Using an informational field as money is a data-integrity defect |

**Recommendation.**

- **Cut A:** no price at all. The invoice total is informational and comes from the issuer.
- **Cut B:** start with **option 2 (manual per document)** plus a read-only “last price used”
  suggestion. It is the only option that ships without a price-master governance project. If the
  customer already has a reliable ERP price list, prefer **option 3**; do not build **option 1**
  unless the ERP cannot provide prices and the owner accepts the duplication.
- **Cut C:** no price ownership; invoice references carry the issuer's totals. The receivable is
  derived from those totals, not from Servora's prices.

**Price rules that must be decided before B:** currency (TRY only), VAT-exclusive vs VAT-inclusive
(default exclusive in V1; no mixed lines), unit-price scale (4 decimals is the safe default),
line-level rounding (half-up, documented), discount mechanism (line amount only in V1), and who may
set/override a price. Money must be stored as SQL `NUMERIC` and serialized as strings, never
computed with JS floats; DOM-006's exact-string quantity rule is the precedent
(`DECISIONS.md:675-676`).

**Quantity caveat.** SALE quantity is an integer product count (1–999,999,999), and catalog units
do not convert or qualify it (`DECISIONS.md:2077-2079`). New delivery quantity input is also a whole
integer, with historical fractional rows preserved (`DECISIONS.md:3463-3476`). V1 Accounting lines
should therefore use integer quantities too, with the unit as a snapshot; fractional billing (ml,
mg, litre) is out until a new accepted measurement decision (`DECISIONS.md:3486-3489`). Do not
create a third quantity semantics silently.

---

## 6. Interaction with a future Warehouse/Stock module

MOD-001 §2 gives Warehouse ownership of depots, physical quantities, reservations, movements,
transfers, returns, lot/serial/expiry and the source-operation link; the stock source of truth is
set per deployment/integration mode (`DECISIONS.md:2022-2031`). No Warehouse tables exist today
(`DECISIONS.md:2031`; `SERVORA_MED_SCHEMA_DRAFT.md:672`).

| Cut | Needs Warehouse? | Why | What it uses instead |
| --- | --- | --- | --- |
| **A — invoice references** | **No** | It links to customer/SALE/delivery, not stock | SALE/delivery ids and the invoice reference |
| **B — quote/order** | **No for the document** | A quote/order is a commercial agreement, not a stock movement. It needs Warehouse only if order confirmation must reserve stock or if invoicing must follow shipped quantity | `PRODUCT_DELIVERY` status for `FULFILLED`; SALE/delivery link; no stock balance |
| **C — open account/collections** | **No** | Receivables are financial, not physical | Invoice references + collections |

**What would force Warehouse into the picture:** partial deliveries/invoicing, stock reservation at
order confirmation, lot/serial/expiry printed on the invoice, consignment stock, or shipped-quantity
invoicing. Partial delivery is blocked today: SALE-002 allows **at most one delivery per sale; no
partial deliveries, no remaining-quantity tracking** (`DECISIONS.md:2154-2155`), and MOD-001 §5
leaves “one SALE → several PRODUCT_DELIVERY records” as a research topic
(`DECISIONS.md:2057-2059`). Until that changes, B's order-to-invoice matching is at whole-sale
granularity.

**Ownership rule.** Accounting must not derive money from stock movements, and Warehouse must not
derive stock from invoices. Cost/valuation (which would couple them) is explicitly excluded
(`DECISIONS.md:567-568`; `DECISIONS.md:2036-2038`). Warehouse may later read confirmed order lines
for reservations; that is a W0 contract, not an A0 deliverable.

---

## 7. Decision impact and rollout

| Cut | New decision required | Amends | Does not change | Module activation |
| --- | --- | --- | --- | --- |
| **A** | `ACC-A`: invoice reference ledger, ownership, roles, non-goals | None | DOM-001, DOM-004, DOM-006, SALE-001/002, REPORT-001/002 | Add `ACCOUNTING` to MOD-002 registry/state in a later slice |
| **B** | `ACC-B`: price/VAT ownership, numbering, buyer identity, statuses/approval | Possibly the “no financial totals on SALE” UX note if a priced panel is added (`visit-to-sale-implementation-plan.md:148`; `README.md:58`); no DOM-004 amendment if `referencePrice` stays informational | DOM-001, DOM-004, DOM-006 (unless money enters reports), SALE-001/002 DTO/API | Same MOD-002 extension |
| **C** | `ACC-C`: balance visibility, collection custody, opening balances, ageing surface, KVKK | A new reporting decision if ageing appears in `/reports`; no DOM-006 record rewrite | REPORT-001/002, DOM-001/004, SALE-001/002 | Same MOD-002 extension |

**Recommended sequence.**

1. **Approve Cut A now.** It is the only cut that resolves a recorded debt
   (`DECISIONS.md:2065-2066`) with no price, currency or VAT decision, no legal-document risk, and
   a small surface. Ship it with an ERP CSV import in a second slice.
2. **Decide Cut B with the accountant and the ERP vendor.** The first question is not UI; it is
   “where does the price come from, and who is allowed to change it?” If the ERP already produces
   quotes/orders, B may shrink to a mobile quote PDF and an export, or disappear.
3. **Defer Cut C until A+B have real data.** Without an opening-balance/import decision, C's
   balance is “since go-live”, which finance will not trust. Cheque/senet, if used, is a separate
   portfolio decision.

**Do not** build B before the price decision; **do not** build C before the opening-balance
decision; **do not** build any cut as a JobCard type.

---

## Open questions

1. **Financial authority:** does the pilot customer use Logo, Netsis, Mikro, or another ERP? Does
   it expose an API/file export, or is CSV the only channel? (Owner + ERP vendor)
2. **e-Fatura/e-Arşiv:** which integrator/GİB portal does the customer use today? Can it return
   invoice references (number, date, UUID, totals, due date) automatically? (Accountant)
3. **Scope confirmation:** is the distributor inside the medical-supply e-Fatura head
   (509 §IV.1.4(a)(6)), or does its accountant rely only on the 3M TL turnover test? (Accountant)
4. **Price source:** ERP price list, manual per document, or both? Are there dealer/segment price
   lists? Is quoting KDV-inclusive or exclusive? (Owner + accountant)
5. **Discount authority:** who may discount, by how much, and does a discount need a manager
   approval separate from the JobCard approval? (Owner)
6. **Quote bindingness:** is a quote an offer, a price indication, or a commitment? What validity
   period is normal? (Owner)
7. **Buyer legal identity:** who maintains legal title, tax office, billing address and MERSİS?
   The CRM has only a display name and an optional tax number
   (`server/src/db/migrations/002_delivery_tracer.sql:5-24`). (Owner/accountant)
8. **Staff financial visibility:** may Saha personeli see invoice totals and customer balances, or
   only “invoiced/not invoiced” and “overdue/not overdue”? (Owner; KVKK)
9. **Opening balances:** import all open invoices at cutover, or start clean and label “since
   go-live”? (Accountant)
10. **Collections:** does the field actually collect cash, cheque or senet? If yes, what is the
    custody chain and who prints the receipt? (Owner/finance)
11. **Cash tevsik:** how should the module react to a cash collection above the current 30,000 TL
    limit — block, warn, or require a manager reason? (Owner/accountant; **VOLATILE** rule)
12. **Returns/credit notes:** how are returns and invoice corrections handled today? They affect
    balances and are currently out of V1. (Accountant)
13. **Document numbering:** does the accountant require a series aligned with the ERP, or is an
    independent `TKF-`/`SIP-` series acceptable? (Accountant)
14. **e-İrsaliye linkage:** does the ERP invoice carry a dispatch-note number that Servora should
    store on the invoice reference? e-Fatura content requires the delivery date and dispatch-note
    number ([S1] §IV.1.3(d)). (Accountant/warehouse)
15. **Module activation:** should Accounting be switchable by the installation operator from day
    one, or always on when installed? MOD-002 currently supports only `OVERVIEW`
    (`server/src/modules/installation-modules/registry.ts:7-24`). (Owner/operator)
16. **Retention/KVKK:** what retention period and access policy apply to invoice references,
    balances and collection records? (Owner/accountant; **UNVERIFIED** legal period)

---

## Sources

### Repository sources (path:line)

- `DECISIONS.md:337-357` — DOM-001, delivery purpose without financial tracking.
- `DECISIONS.md:433-453` — ARC-002, single-organization boundary.
- `DECISIONS.md:534-568` — DOM-004, informational Product catalog boundary.
- `DECISIONS.md:609-686` — DOM-006, operational reports and excluded financial metrics.
- `DECISIONS.md:1934-1949` — CRM-S2-001, action-scoped STAFF enrichment.
- `DECISIONS.md:1966-1989` — SALE-001.
- `DECISIONS.md:1991-2071` — MOD-001, including §3 Accounting boundaries and §5 SALE compatibility.
- `DECISIONS.md:2073-2102` — SALE-QTY-001, integer product counts.
- `DECISIONS.md:2104-2184` — SALE-002, standalone sale, coordinated approval, one delivery per sale.
- `DECISIONS.md:3458-3489` — DELIVERY-QTY-001, whole-unit delivery quantities.
- `DECISIONS.md:3735-3788` — MOD-002, installation operator and module state.
- `PRODUCT_REQUIREMENTS.md:283-286` — no price/discount/invoice/payment in MVP delivery.
- `PRODUCT_REQUIREMENTS.md:407-424` — catalog informational; accounting/invoices/e-invoice out of scope.
- `SERVORA_MED_MVP_SLICES.md:53` — warehouse/accounting are not slices in the MVP plan.
- `SERVORA_MED_MVP_SLICES.md:331,337` — product catalog has no accounting/price-history behavior.
- `SERVORA_MED_MVP_SLICES.md:416` — reports contain no revenue/invoice/payment.
- `SERVORA_MED_SCHEMA_DRAFT.md:285` — `default_price` is reference only.
- `SERVORA_MED_SCHEMA_DRAFT.md:393` — no unit-price/discount/line-total/invoice/payment fields.
- `SERVORA_MED_SCHEMA_DRAFT.md:670-680` — explicit omissions, including quote/collection JobCard types.
- `SERVORA_MED_API_DRAFT.md:479-484` — `referencePrice` has no financial meaning.
- `SERVORA_MED_API_DRAFT.md:515` — no stock/warehouse/costing/price-history/currency endpoints.
- `SERVORA_MED_API_DRAFT.md:1831-1841` — invoices/payments/revenue explicitly absent.
- `docs/architecture/decision-reconciliation-report.md:95-104` — Accounting A0 discovery titles.
- `docs/features/visit-to-sale/README.md:56-59` — no invoice/payment/price/currency/total/discount.
- `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:93` — sale item has no price/currency/total/invoice/payment; `referencePrice` not copied.
- `docs/features/visit-to-sale/visit-to-sale-implementation-plan.md:148` — future-module panel must not show financial totals.
- `docs/features/operator-module-pilot.md:30-31,102-112` — other modules need their own contract; registry is one entry.
- `docs/backlog/2026-11-25-core-modules-architecture-research.md:42` — offboarding writes to 21 tables; every new module must handle it.
- `server/src/db/migrations/001_auth_foundation.sql:3-8` — organizations has only name/timestamps.
- `server/src/db/migrations/002_delivery_tracer.sql:5-24` — customers table; optional tax number/address.
- `server/src/db/migrations/002_delivery_tracer.sql:196-216` — `processed_actions` idempotency.
- `server/src/db/migrations/003_people.sql:32-51` — `audit_events` subject/event CHECKs.
- `server/src/db/migrations/004_crm_contacts.sql:5-15` — tax-number normalization/unique index.
- `server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4` — free-text invoice number on notes.
- `server/src/db/migrations/034_demo_data_foundation.sql:41-46` — BUSINESS/DEMO data class.
- `server/src/db/migrations/036_job_card_invalidated.sql:131-133` — `request_hash` on `processed_actions`.
- `server/src/db/migrations/057_sale_from_visit.sql:70-88` — sale items, no price fields.
- `server/src/db/migrations/058_sale_integer_quantity.sql:19-24` — integer sale quantity CHECK.
- `server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:26-43` — delivery link, one delivery per sale.
- `server/src/db/migrations/074_installation_operator_and_module_state.sql:52-64` — module state CHECK only OVERVIEW.
- `server/src/modules/installation-modules/registry.ts:7-24` — only OVERVIEW is switchable.
- `server/src/modules/capabilities/types.ts:1-8` — no accounting capability.
- `server/src/modules/auth/types.ts:1` — ADMIN/MANAGER/STAFF.
- `server/src/modules/products/types.ts:12,43` — `referencePrice` mapping.
- `server/src/modules/products/repository.ts:90-98,167-176` — product delete protection only covers delivery/sale items.
- `server/src/modules/crm/types.ts:17,189-193` — customer `taxNumber` and normalization.
- `server/src/modules/crm/repository.ts:297-311,422-430` — contact/customer operation-history guards.
- `server/src/modules/job-cards/sale-repository.ts:23-27` — `SaleItem` has no price.
- `server/src/modules/job-cards/notes-service.ts:22,40,56-60` — invoice number only for SALES_MEETING/PRODUCT_DELIVERY.
- `server/src/modules/reports/routes.ts:25-44` — operational report endpoints only.
- `web/src/ProductForm.tsx:67-70` — reference price is informational only.
- `web/src/ProductDetail.tsx:61` — reference price displayed without currency.
- `web/src/jobs/JobNotes.tsx:71` — invoice field only for SALES_MEETING/PRODUCT_DELIVERY.
- `server/package.json:43` — `pdfmake` dependency.
- `server/src/modules/weekly-reports/pdf/renderer.ts:5,34` — existing PDF renderer.

### Web sources (official first; accessed 2026-11-26)

- **[S1]** Gelir İdaresi Başkanlığı, *Vergi Usul Kanunu Genel Tebliği (Sıra No: 509) — güncel metin*, PDF published 2026-01-02. §IV.1.3(d) invoice content (delivery date and dispatch-note number); §IV.1.4(a)(1) 3M TL turnover; §IV.1.4(a)(6) SGK-contracted health providers and all taxpayers supplying medical materials/medicine; §IV.1.5 transition. https://cdn.gib.gov.tr/api/gibportal-file/file/getFile?objectKey=MEVZUAT_TEBLIGLER%2FUNIVERSAL%2F2026%2FMEVZUAT_TEBLIGLER_2026_VukTeb509_Guncel.pdf
- **[S2]** Gelir İdaresi Başkanlığı, *VUK Genel Tebliği (Sıra No: 509)'nde Değişiklik Yapılmasına Dair Tebliğ (Sıra No: 573)*, published 2024-11-12 (RG 32720). Changes §IV.2.4.3: 2025 threshold 3,000 TL; from 1/1/2026 no amount threshold. https://gib.gov.tr/mevzuat/kanun/434/teblig/7838
- **[S3]** Gelir İdaresi Başkanlığı, *VUK Genel Tebliği (Sıra No: 526)*, published 2021-02-09 (RG 31390). Adds the medical-material/medicine e-Fatura obligation head. https://gib.gov.tr/mevzuat/kanun/434/teblig/7885
- **[S4]** TÜRMOB, *E-Fatura ve e-Arşiv fatura uygulamasına dahil olmayan mükelleflerin GİB portaldan e-Arşiv fatura düzenleme zorunluluğu*, 2026-01-02, sirküler 02.01.2026/16-1. From 1/1/2026, taxpayers outside the delayed group must issue all invoices as e-Arşiv regardless of amount; simple-basis/booking taxpayers retain the 3,000 TL threshold until 31.12.2026 and lose it on 1/1/2027. https://www.turmob.org.tr/ekutuphane/Read/9208c1d3-f311-468d-9dd7-0d50a202bd6c
- **[S5]** Gelir İdaresi Başkanlığı, *Güncel KDV Oranları* (2007/13033 Karar, 7346 sayılı Cumhurbaşkanı Kararı işlenmiş), PDF. General 20%, list (II) 10%, list (I) 1%; dental items in list (II). https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Fyardim-kaynaklar%2Fyararli-bilgiler%2Fkdv-oranlari.pdf
- **[S6]** Gelir İdaresi Başkanlığı, *Mal ve Hizmetlere Uygulanacak KDV Oranlarının Tespitine İlişkin Kararda Değişiklik (Karar Sayısı: 7346)*, announcement 2023-07-07; Resmî Gazete 2023-07-07/32241; effective 10.07.2023. https://www.gib.gov.tr/duyuru-arsivi/guncel/477_477_mal_ve_hizmetlere_uygulanacak_katma_deger_vergisi_oranlarinin_tespitine_iliskin_kararda_degisiklik_yapilmasina_dair_karar_karar_sayisi:_7346_resmi_gazetede_yayimlandi
- **[S7]** Gelir İdaresi Başkanlığı, *KDV Genel Uygulama Tebliği* (2026 consolidated PDF), 2026-04-15. Partial withholding lists; no general medical-supply delivery item. https://cdn.gib.gov.tr/api/gibportal-file/file/getFile?objectKey=MEVZUAT_TEBLIGLER/UNIVERSAL/2026/kdv_genteb.pdf
- **[S8]** Gelir İdaresi Başkanlığı, *KDV'de kısmi tevkifat uygulanan işlemler ve tevkifat oranları*, PDF, 2024-02-16. Service/delivery withholding table; no ordinary medical-supply delivery line. https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv/yardim-kaynaklar/yararli-bilgiler/kdvde-kismi-tevkifat-uygulamasinda-tevkifat-oranlari.pdf
- **[S9]** Gelir İdaresi Başkanlığı, *Damga Vergisi Kanunu* (488), madde 9/10/14 and the (1) numbered table. https://www.gib.gov.tr/mevzuat/kanun/438
- **[S10]** Gelir İdaresi Başkanlığı, *71 Seri No.lu Damga Vergisi Kanunu Genel Tebliği*, RG 2025-12-31/33124 (5. Mükerrer), effective 2026-01-01. 2026 maximum 29,115,961.10 TL; contract rate binde 9.48. https://www.gib.gov.tr/mevzuat/kanun/438/teblig/11858 ; PDF: https://cdn.gib.gov.tr/api/gibportal-file/file/getFile?objectKey=MEVZUAT_TEBLIGLER%2FUNIVERSAL%2F2025%2F488_Teblig71.pdf
- **[S11]** Türk Ticaret Kanunu (6102), madde 89–101, *Cari Hesap*; madde 89/2 written-form validity. TTK PDF (İTO mirror): https://ito.org.tr/documents/Ticaret-Sicil/mevzuat/Kanunlar/6102_ttk.pdf
- **[S12]** Türk Borçlar Kanunu (6098), madde 103 (debtor's right to demand a receipt). Mevzuat Bilgi Sistemi: https://www.mevzuat.gov.tr/mevzuat?MevzuatNo=6098&MevzuatTur=1&MevzuatTertip=5
- **[S13]** *Vergi Usul Kanunu Genel Tebliği (Sıra No: 459)*, consolidated text; 30,000 TL tevsik limit (as amended by 575, RG 30.11.2024/32738). https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/9.5.21303.pdf
- **[S14]** Gelir İdaresi Başkanlığı, *Belirli Tutarın (30 Bin) Üzerindeki Tahsilat ve Ödemelerde Tevsik (Belgeleme) Zorunluluğu Rehberi*, 2024-12-18. Bank/PSP/PTT documents; a receipt does not replace them. https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Fonceki-dokumanlar%2Ftevsik_2024.pdf
- **[S15]** Kişisel Verilerin Korunması Kanunu (6698). Mevzuat Bilgi Sistemi: https://www.mevzuat.gov.tr/mevzuat?MevzuatNo=6698&MevzuatTur=1&MevzuatTertip=5
- **[S16]** Gelir İdaresi Başkanlığı, *e-Arşiv Teknik Kılavuzu*, v1.18, August 2025. UBL-TR, `EARSIVFATURA` profile, mali mühür/NES signature. https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Teknik_Kilavuzu_V.1.18.pdf
- **[S17]** Gelir İdaresi Başkanlığı, *e-Fatura Uygulaması Özel Entegrasyon Kılavuzu*, v1.14, 2026-06-29. Integrator contract/authorization; mali mühür requirement. https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Fatura_Uygulamasi_Ozel_Entegrasyon_Kilavuzu_v1.14.pdf
- **[S18]** Gelir İdaresi Başkanlığı, *e-İrsaliye Uygulama Kılavuzu*, v1.2, 2022-09-07. VUK 230/5 dispatch note; e-İrsaliye requires e-Fatura registration. https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Irsaliye_Uygulama_Kilavuz_1.2.pdf

**VOLATILE facts:** the 2026 e-Arşiv cut-off and the 3,000 TL/30,000 TL thresholds; the 20/10/1 VAT
rates; the 30,000 TL cash tevsik limit; the 2026 stamp-tax amounts and rates; e-Fatura transition
dates. These must be re-checked with the accountant before implementation and before any UI text is
frozen.

---

## 10. Cut comparison

**Bottom line:** Cut A is the smallest correct step and the only one that needs no new financial
policy. Cut B is a product decision about price ownership, not a schema task. Cut C is a finance
trust decision, not a UI task. Building B or C before those decisions would create a commercial
record whose authority is undefined — the exact ownership question MOD-001 §3 leaves to Accounting
A0 (`DECISIONS.md:2032-2040`).

| Dimension | **Cut A — reference-only** | **Cut B — priced quote/order** | **Cut C — light open account** |
| --- | --- | --- | --- |
| **One-line scope** | Record invoice references issued elsewhere; close the sale; worklist | Price and issue quotes/orders; VAT per line; totals; statuses; ERP export | A+B + invoice due dates + collections + allocation + balance/ageing/statement |
| **New authoritative data** | Invoice reference (number/date/issuer/total) | Seller profile, buyer legal identity, price, discount, VAT, document number | Everything in B + collection, allocation, opening position |
| **Explicitly not owned** | Lines, payments, balances, prices, VAT computation | Official invoice/number, e-Fatura/e-Arşiv, stock, cost/margin, credit notes | General ledger, bank reconciliation, cheque/senet, dunning, tax filing |
| **Depends on Core** | Customer, SALE/delivery ids, visibility | Customer/contact, product snapshot, optional SALE/delivery link | Customer, users, invoice refs, SALE/delivery link |
| **Depends on external** | ERP/integrator invoice number (manual/CSV) | ERP price list (optional), ERP order import, accountant's VAT rules | ERP open invoices/opening balances, bank/PSP evidence |
| **First decision needed** | `ACC-A` module decision only | `ACC-B` price/VAT ownership + numbering + buyer identity | `ACC-C` visibility + opening balances + ageing/KVKK |
| **Issues a legal document?** | No | No (commercial quote/order, explicitly “fatura yerine geçmez”) | No (collection receipt is payment evidence) |
| **e-Fatura/e-Arşiv inside Servora?** | **Out** | **Out** | **Out** |
| **Main regulatory exposure** | Low: duplicate numbers, retention/KVKK | Medium: invoice-like PDF, VAT rate/rounding, stamp tax (UNVERIFIED for quotes) | Medium-high: cash tevsik 30k, TTK 89 vs açık hesap, KVKK, custody |
| **Approx. size** | ≈2–3 slices | ≈4–6 slices | ≈3–4 slices on top of A+B |
| **Needs Warehouse?** | No | No for the document; yes only for stock reservation/partial shipped invoicing | No |
| **Price authority** | None (invoice total is informational) | Manual per document (recommended), ERP feed, or price list; **never** `referencePrice` as master | Same as B; receivables use invoice totals, not Servora prices |
| **Reports impact** | A worklist, no revenue metric | Commercial document report is a new domain; no revenue in `/reports` unless decided | Ageing report is a new domain; do not mix with Staff performance |
| **Staff visibility** | “Invoiced/not invoiced”; totals only if owner allows | STAFF create drafts/quotes for assigned/active-job customers; MANAGER/ADMIN issue/override | Default MANAGER/ADMIN balances; STAFF only if explicitly granted |
| **Biggest risk** | Shadow invoice register | Price authority + invoice-looking PDF | Ledger disagrees with ERP; opening balance/allocation/cash custody |
| **Recommended timing** | **Now** | After the ERP/accountant price decision | After A+B have ≥1 quarter of real references |
