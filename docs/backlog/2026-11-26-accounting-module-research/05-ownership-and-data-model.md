# 05 — Accounting module: ownership boundaries and data-model sketch

> **Revision notice (2026-11-26): historical schema exploration only.** [07-expanded-product-scope.md](07-expanded-product-scope.md) and [06-decision-brief.md](06-decision-brief.md) supersede conflicting proposals here. Do not copy this SQL into migrations. Cut A has identity-only references, many-to-many source links, issuer-scoped normalized identity, explicit finance grants, default-off DB initialization (no new env flag), and transactional shared state-row locking against operator disable. Legacy Core commands remain unchanged; no 7-day deadline or inferred invoice state. Supplier/payable, expense and manual cash/bank concepts are later separate slices, not speculative tables now. No migration number is reserved. Accepted decisions remain binding.

**Status:** research / design proposal for the owner's decision. **Not** a migration, not an
accepted decision, not an implementation authorisation. AGENTS.md §13 (lines 387–406) forbids
adding a full accounting module without explicit owner approval, and MOD-001 §3–§4
(`DECISIONS.md:2032–2050`) keeps the accounting layer *light* and forbids a general ledger,
chart of accounts, e-Defter, payroll, bank reconciliation and a general posting engine.

**Evidence convention.** Every repo claim carries `path:line`. Every web claim carries a URL and
the access date (2026-11-26). `ACCEPTED` marks text that already binds this project.
`PROPOSAL` marks my design suggestion; nothing in §2–§10 is a decision yet. Facts that change
often (thresholds, formats, deadlines) are marked **VOLATILE**.

---

## Summary

- **Core stays non-financial.** DOM-001 (`DECISIONS.md:349–351`) forbids price/invoice/payment
  state on delivery, DOM-004 (`:549–552`) makes the catalog informational, DOM-006 (`:633–638`)
  keeps revenue out of operational reports, and MOD-001 §5 (`:2051–2059`) forbids
  `invoiceNumber`, VAT, price and discount on SALE. Accounting therefore has to be an *additive*
  module that Core never depends on.
- **Link direction is one-way: Accounting → Core.** Accounting holds organisation-scoped
  `RESTRICT` foreign keys into `customers`, `job_cards`, `job_card_sale_items`, `products` and
  `users`. Core gains no document column, no flag and no callback. This is the only shape that
  keeps the module switchable under MOD-002 without weakening a core rule (the SCH-001 lesson,
  `DECISIONS.md:3694–3704`).
- **Tax identity is split by authority, not duplicated** (recommended Option C, §1.3): the
  *tax number* stays in `customers.tax_number` where its normalisation and per-organisation
  uniqueness already live (`server/src/db/migrations/004_crm_contacts.sql:6–15`); *vergi dairesi, ticari unvan and fatura
  adresi* become an Accounting-owned 1:1 `acct_billing_profiles` row; every issued document
  freezes a buyer snapshot. No field has two editable homes.
- **One document model, three deliverable cuts.** Cut A = external invoice reference (replaces the
  note-field debt). Cut B = commercial document + lines + tax, with numbering and immutability.
  Cut C = current-account entries + collections. Each cut is independently shippable.
- **Numbers come from a transactional counter row, never from a PostgreSQL sequence.**
  `nextval()` is explicitly documented as unable to produce gapless sequences
  (PostgreSQL 17, `functions-sequence.html`, accessed 2026-11-26). An `UPDATE … RETURNING` on
  `acct_number_sequences` inside the issue transaction allocates atomically and releases the
  number on rollback, so an aborted issue leaves no gap.
- **Money is `NUMERIC` end to end and never a JS number.** `numeric` is the type PostgreSQL
  recommends for exact monetary values and rounds ties away from zero
  (`datatype-numeric.html`, accessed 2026-11-26). The existing `Number(row.default_price)`
  mapping (`server/src/modules/products/types.ts:43`) must **not** be reused for money.
- **Every create/issue/void/collection command reuses the existing claim-first idempotency
  helper** `runCriticalAction` (`server/src/db/critical-action.ts:142–221`): claim
  `processed_actions` (`server/src/db/critical-action.ts:158–170`) **before** any business write,
  replay the stored receipt (`:172–190`), complete exactly one receipt row (`:193–202`).
- **Disabling the module deletes nothing and must not change core behaviour.** Disabled →
  `404` (Overview precedent, `docs/features/operator-module-pilot.md:156–160`); unreadable state
  → `503` (MOD-002 §5, `DECISIONS.md:3774–3775`). Only the installation operator with
  `MODULE_MANAGEMENT` may switch it (`server/src/db/migrations/074_installation_operator_and_module_state.sql:28–35`,
  `server/src/modules/operator/service.ts:123–125`).
- **Restore is the real numbering risk.** A restore rewinds the counter to the backup instant
  while the outside world (integrator, accountant, customer) keeps the numbers already issued;
  a mandatory post-restore reconciliation step is part of the design, not an operational
  afterthought (§8).
- **This module cannot claim to legally issue invoices in v1.** Turkish e-Arşiv rules make
  electronic issuance mandatory for non-e-Fatura taxpayers from 1/1/2026 regardless of amount
  (VUK GT 509 §IV.2.4.3, **VOLATILE**). Cut B therefore issues *internal commercial documents*
  and records the external legal number; an e-belge integration needs its own explicit decision
  (§2.4, §7).

---

## 0. Binding constraints this design must satisfy

| # | Constraint | Source |
| --- | --- | --- |
| C1 | Delivery purpose carries no price, discount, line total, revenue, invoice or payment state | `DECISIONS.md:349–351` |
| C2 | Product catalog is informational; `default_price` has no currency or financial meaning and is not copied into delivery items | `DECISIONS.md:549–552`; `server/src/db/migrations/002_delivery_tracer.sql:40`; `server/src/db/migrations/005_product_catalog.sql:9–10` |
| C3 | Operational reports never mix approved delivery quantities with revenue | `DECISIONS.md:633–638`, `:2066–2068` |
| C4 | SALE carries no `invoiceNumber`, price, discount, VAT or revenue computation; SALE identity and line identity may later serve as references | `DECISIONS.md:2051–2059`; `server/src/db/migrations/057_sale_from_visit.sql:17–25` |
| C5 | No generic event bus / persistent global outbox / integration queue without a concrete producer and reliable-delivery requirement | `DECISIONS.md:2041–2050` |
| C6 | No full general ledger, chart of accounts, e-Defter, payroll, bank reconciliation or posting engine | `DECISIONS.md:2032–2040` |
| C7 | Organisation scope on every business row; client never chooses `organization_id` | `DECISIONS.md:443–453`; `SERVORA_MED_SCHEMA_DRAFT.md:467–481` |
| C8 | Critical command idempotency: claim before side effects, replay stored receipt | `AGENTS.md:188–201`; `SERVORA_MED_API_DRAFT.md:145–164` |
| C9 | Optimistic concurrency with `version`/`expectedVersion` on mutable rows and named commands | `DECISIONS.md:389–398` |
| C10 | Cross-module writes use a documented lock order; same-type rows locked in stable UUID order | `DECISIONS.md:517–518`; `SERVORA_MED_SCHEMA_DRAFT.md:505–508` |
| C11 | Module state is typed rows, not a settings bag; every toggle is version-checked and audited in the same transaction | `DECISIONS.md:3765–3769`; `server/src/db/migrations/074_installation_operator_and_module_state.sql:50–65` |
| C12 | Offboarding must work even while a module is off; a module may not own a core lifecycle blocker | `docs/backlog/2026-11-25-core-modules-architecture-research.md:200–205` |
| C13 | Audit/activity rows are append-only and written in the business transaction | `DECISIONS.md:487–493`, `:590–594` |
| C14 | Do not log passwords, tokens, session ids or sensitive payloads; manager-only actions enforced server-side | `AGENTS.md:160–172`; `DECISIONS.md:524–532` |

---

## 1. Ownership matrix (question 1)

### 1.1 Rules used to assign ownership

1. **One authoritative writer per field.** A field is owned by the module that owns its
   invariant (AGENTS.md §2.1, `AGENTS.md:53–58`). Mirrors are allowed only as immutable
   snapshots taken at a business event.
2. **Core may not depend on a module.** If a core command needed Accounting to decide, turning
   the module off would silently change a core rule. SCH-001 exists because that happened once
   with Calendar (`DECISIONS.md:3671–3690`), and it fixed it by hoisting the rule into Core and
   letting the module *contribute* (`:3694–3704`). Accounting must never create that situation.
3. **A module may hold an FK into Core; Core may never hold an FK into a module.** Precedent:
   `job_card_sale_details` / `job_card_sale_items` reference `customers`, `products` and
   `job_cards` (`server/src/db/migrations/057_sale_from_visit.sql:55–58`, `:86–87`), and Core's own cross-type link
   `delivery_source_sale_id` is Core→Core (`server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:26–36`).
4. **Snapshots, not joins, at document time.** A printed/issued document must never change
   because a customer, product or sale was edited later. Precedent: SALE product snapshots
   (`server/src/db/migrations/057_sale_from_visit.sql:76–80`) and DOM-004's "deactivation does not rewrite historical
   snapshots" (`DECISIONS.md:557`).

### 1.2 Matrix

`Read` = same-organisation readers. `Link` = who may create a reference to it.

| Entity / field | Owner | Who may read | Who may link / write rule |
| --- | --- | --- | --- |
| `job_cards` root: type, status, assignee, version, approval fields | **Core** | same org; STAFF only jobs assigned to them (`server/src/modules/job-cards/policy.ts:37–40`) | Accounting reads only. Never writes, never locks with `FOR UPDATE` (§5.3 uses `FOR SHARE`). |
| `job_card_sale_details` (sold_at, sale contact, source snapshots) | **Core** | same as SALE | Accounting reads only |
| `job_card_sale_items` (durable line identity `id`, integer quantity, product snapshots) | **Core** | same as SALE | Accounting takes an FK to `(organization_id, id)`; unique key exists (`server/src/db/migrations/057_sale_from_visit.sql:84`) |
| `job_cards.delivery_source_sale_id` (sale→delivery link) | **Core** | same as SALE/delivery | Accounting ignores it in Cut A–C; delivery ≠ invoice (`server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:26–43`) |
| `job_card_delivery_items` (purpose, quantity, delivered_at) | **Core** | same as delivery | Not referenced by Accounting in Cut A–C (DOM-001 has no money) |
| `customers` operational fields (name, type, status, assignee, city/district/address) | **CRM / Core** | all same-org users (`DECISIONS.md:528–529`) | Accounting reads; never writes |
| `customers.tax_number` | **CRM / Core** | same as customer | Accounting reads only; single authority (§1.3) |
| `contacts` | **Core CRM** | same as customer | Not referenced in Cut A–C. If a buyer contact name is ever needed it is a snapshot on the document, never an FK |
| `products` (name, sku, brand, model, unit) | **Core catalog** | all same-org | Accounting snapshots at line creation; never writes |
| `products.default_price` | **Core catalog** | all same-org | Accounting must **not** treat it as a price source (`DECISIONS.md:549–552`) |
| `users` (role, is_active) | **Core** | Admin/Manager management surfaces | Accounting holds `RESTRICT` FKs for `created_by`/`issued_by`; copies no profile data |
| `audit_events` (CRM/People/Products audit) | **Core** | Admin/Manager surfaces | Accounting does **not** write here; it owns `acct_document_events` (§4) |
| `processed_actions` | **Core infrastructure** | internal | Accounting reuses the claim (`server/src/db/migrations/002_delivery_tracer.sql:196–216`) |
| `installation_module_state`, `operator_*` | **Installation level** (no `organization_id`; `server/src/db/migrations/074_installation_operator_and_module_state.sql:1–6`) | operator only | Accounting contributes one registry key + one capability (§7) |
| `job_card_notes.invoice_number` | **Core (legacy debt)** | same as notes | Accounting proposes its retirement path only (§6) |
| `acct_billing_profiles` | **Accounting** | MANAGER/ADMIN (proposal §10) | 1:1 by `customer_id`; validates against Core `tax_number`, never duplicates it |
| `acct_documents`, `acct_document_lines`, `acct_document_line_taxes` | **Accounting** | MANAGER/ADMIN; STAFF sees status only on own sale (§10) | FKs → customers / job_cards / job_card_sale_items / products |
| `acct_document_relations` (credit note → invoice) | **Accounting** | same as documents | document ↔ document, both Accounting rows |
| `acct_number_sequences` | **Accounting** | internal | not user-visible |
| `acct_invoice_references` (Cut A) | **Accounting** | MANAGER/ADMIN | may point at a SALE or stand alone; never at another module's row |
| `acct_current_account_entries` | **Accounting** | MANAGER/ADMIN | derived from issued documents and collections only |
| `acct_collections`, `acct_collection_allocations` | **Accounting** | MANAGER/ADMIN | FK → customers, documents |
| `acct_document_events` (module audit) | **Accounting** | MANAGER/ADMIN (document timeline) | append-only |
| Future Warehouse/Stok: depots and vehicle stock, physical quantities, reservations, in/out movements, transfers, returns, corrections, lot/serial/expiry, stock↔source-operation link (`DECISIONS.md:2022–2031`) | **Warehouse module** (future) | TBD by that module's contract; not part of Cut A–C | Accounting never reads or writes stock in Cut A–C. If a future document line must reference a stock movement, the FK points from Warehouse or Accounting into the other module's row only after a decision — the single stock authority is set per deployment (`DECISIONS.md:2028–2031`) |

**Explicit non-links.** Accounting never links to `calendar_events`, `conversations`,
`weekly_reports`, `staff_confidential_notes` or `notifications`. Those are other modules'
aggregates; a money document referencing a private note would leak a different module's
visibility rule.

### 1.3 Where do VKN/TCKN, vergi dairesi, unvan and fatura adresi live?

**Observed current state (all of it):**

- `customers.tax_number VARCHAR(50) NULL` — `server/src/db/migrations/002_delivery_tracer.sql:10`.
- Normalised form enforced by CHECK (upper-case, no spaces/dots/slashes/dashes) —
  `server/src/db/migrations/004_crm_contacts.sql:6–11`; normaliser in code — `server/src/modules/crm/types.ts:189–193`.
- Per-organisation uniqueness when present — `server/src/db/migrations/004_crm_contacts.sql:13–15`.
- Used as a duplicate-detection signal — `server/src/modules/crm/duplicate-evidence.ts:60`;
  import path normalises it — `server/src/modules/crm/customer-onboarding-import.ts:255`.
- Surfaced as a free-text CRM field — `web/src/CustomerDetail.tsx:53`, `:169`;
  `web/src/CustomerList.tsx:360`.
- **There is no tax office, no separate legal title and no separate billing address.** A repo
  search for `tckn|vkn|tax_office|vergi dairesi` outside `taxNumber` returns nothing, and no
  VKN/TCKN check-digit validation exists anywhere.
- CRM-S4A-001 freezes the current tax normalisation and unique index as unchanged —
  `DECISIONS.md:2195–2196`.

**Option A — put everything on the Core customer** (`tax_office`, `legal_name`,
`billing_address` added to `customers`).

- Pros: one screen, one write path, uniqueness and dedupe keep working, no join, no new concept.
- Cons: Core permanently carries invoice-only semantics that DOM-001/DOM-004 deliberately kept
  out; every Core reader (job list, delivery report, exports) now selects billing columns;
  billing edits bump `customers.version` (`server/src/db/migrations/004_crm_contacts.sql:3`) and cause spurious
  optimistic-concurrency conflicts with operational edits; and a future "sell without
  Accounting" install carries dead billing columns forever.
- Real conflict: `customers.name` is the operational display name. A clinic is "Dr. A Kliniği"
  operationally but "A Sağlık Ltd. Şti." on the invoice. One column cannot be both without
  rewriting JobCard/customer-list labels (`server/src/db/migrations/002_delivery_tracer.sql:7`).

**Option B — put everything in Accounting**, including a second `tax_number` on
`acct_billing_profiles`.

- Pros: no Core change at all; the module is fully removable.
- Cons: **two editable authorities for the same number.** The Core unique index
  (`server/src/db/migrations/004_crm_contacts.sql:13–15`) and CRM duplicate review (`DECISIONS.md:2186–2196`) would keep
  matching on one value while invoices print another. That is a data-integrity defect under
  AGENTS.md §2.1 (`AGENTS.md:53–58`), and the customer would see two different numbers on two
  screens.

**Option C — split by authority (recommended, PROPOSAL).**

| Field | Home | Rationale |
| --- | --- | --- |
| VKN/TCKN (`tax_number`) | **Core `customers`** — unchanged | already unique per organisation, already the dedupe key, already normalised; moving it would silently change CRM duplicate semantics |
| Vergi dairesi | **`acct_billing_profiles.tax_office`** | invoice-only; VUK 230/3 requires it on the invoice, nothing operational needs it |
| Ticari unvan (`legal_name`) | **`acct_billing_profiles.legal_name`** | invoice-only; keeps `customers.name` as the operational label |
| Fatura adresi | **`acct_billing_profiles.billing_address`** (+ optional `invoice_email`) | invoice-only; a delivery address and a billing address are different facts |
| e-belge party identity (later) | **`acct_billing_profiles`** | only meaningful once an e-belge integration exists |

Rules that make Option C safe:

1. `acct_billing_profiles` **must not** store a second editable `tax_number`. If a document
   needs a number that differs from the customer master (e.g. an old wrong invoice), the
   difference lives only in the **document snapshot** (`acct_documents.buyer_tax_number`).
2. Writing the profile is an Accounting capability; writing `customers.tax_number` stays
   Admin/Manager CRM (`server/src/modules/crm/service.ts:64–66`). The two screens must never be
   merged into one form, because that would give Accounting write access to a Core field.
3. Validation at profile save: if `tax_number` is empty on the customer, the profile can still
   be saved, but **issuing** an invoice-shaped document requires a non-empty buyer tax number
   (VUK 230/3). Enforced at issue, not at profile save.
4. When the module is disabled the profile is read-only and CRM is byte-identical to today.
5. Acceptance test (future): "changing `customers.tax_number` changes what the next document
   snapshots, and never rewrites an issued document."

Pros of C: exactly one authority per field; Core untouched; module-off is a no-op for Core;
historical correctness comes from snapshots. Cons: the customer's billing data lives on two
screens and the split must be explained in the UI ("Fatura bilgileri" vs "Müşteri bilgileri");
one extra join when rendering a draft.

### 1.4 Read and link protocol between the modules

- **Reading Core from Accounting:** same-transaction, read-only SQL through a narrow
  module-owned reader, mirroring `SaleReadPort` (`server/src/modules/job-cards/sale-reader.ts:33–37`)
  and the CRM precedent of querying `job_cards` directly inside its own repository
  (`server/src/modules/crm/repository.ts:178–185`). No HTTP, no cross-service call
  (`DECISIONS.md:564` records that JobCard validates within its own transaction and never calls
  HTTP).
- **Reading Accounting from Core:** not allowed in Cut A–C. If a future core screen needs a
  derived fact ("has open receivables"), the Reports pattern applies: a module-owned port
  implemented by the owning module and injected at the composition root
  (`server/src/modules/reports/ports.ts:33–39`, consumed at
  `server/src/modules/people/service.ts:143`).
- **Dashboard/Overview tiles:** contributed by the Accounting module's own route, not by Core.
  Core's Overview must render without Accounting (`DECISIONS.md:3714–3716` treats module
  screens as module-owned).

---

## 2. Data-model sketch (question 2)

Everything in this section is **PROPOSAL**. No migration is written, no migration number is
reserved. A future migration would follow `SERVORA_MED_SCHEMA_DRAFT.md` §8 conventions.

### 2.1 Conventions

| Concern | Rule | Precedent |
| --- | --- | --- |
| Tenant key | `organization_id UUID NOT NULL REFERENCES organizations(id)` on every table; composite FKs `(organization_id, x_id)` | `server/src/db/migrations/002_delivery_tracer.sql:5–6`, `:22–24` |
| Primary key | `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` | `server/src/db/migrations/057_sale_from_visit.sql:71` |
| Optimistic concurrency | `version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)` | `server/src/db/migrations/002_delivery_tracer.sql:61`; `server/src/db/migrations/004_crm_contacts.sql:3` |
| Timestamps | `TIMESTAMPTZ NOT NULL DEFAULT NOW()`; user-supplied business instants carry `CHECK (isfinite(x))` | `server/src/db/migrations/057_sale_from_visit.sql:39` |
| Quantities | `NUMERIC(18,3)`, positive; mirrors delivery's three-decimal practice (`server/src/db/migrations/002_delivery_tracer.sql:145`) | — |
| Money | `NUMERIC(19,2)` for amounts, `NUMERIC(19,6)` for unit prices, `CHAR(3)` currency | §2.2 |
| Soft lifecycle | status columns, never hard delete of business documents | AGENTS.md §6 (`AGENTS.md:174–186`) |
| No float | no `real`/`double precision`/JS `number` in the money path | §2.2 |

### 2.2 Money, currency and rounding (PROPOSAL)

| Column kind | Type | Why |
| --- | --- | --- |
| `unit_price` | `NUMERIC(19,6)` | a sub-kuruş unit price (e.g. 0.0125 TL/ml) is stored once and rounded once, at line level |
| `line_net`, `tax_amount`, `total_net`, `total_tax`, `total_gross` | `NUMERIC(19,2)` | invoice money is two-decimal; assignment rounds ties away from zero (`datatype-numeric.html`) |
| `currency` | `CHAR(3) CHECK (currency ~ '^[A-Z]{3}$')` | ISO 4217; one currency per document |
| API representation | exact decimal **string** (`"1234.56"`) | the DB row type already declares quantity as `string` (`server/src/modules/job-cards/repository.ts:2151`), matching node-postgres' `NUMERIC`→string behaviour, so the money path needs no conversion; do **not** call `Number(...)` as `server/src/modules/products/types.ts:43` and `server/src/modules/job-cards/repository.ts:2433` do |

**Rounding algorithm (deterministic, one place):**

1. `line_net = round_half_up(quantity × unit_price, 2)`
2. per tax line: `tax_amount = round_half_up(line_net × rate / 100, 2)`
3. `line_gross = line_net + Σ tax_amount` (no further rounding)
4. `document.total_net = Σ line_net`, `total_tax = Σ tax_amount`, `total_gross = total_net + total_tax`

Because every component is already rounded to two decimals before summing, the document total is
an exact sum and there is never a residual "rounding line". PostgreSQL's `numeric` rounds ties
away from zero (`datatype-numeric.html`, accessed 2026-11-26), which is exactly half-up for
positive money; the app must not implement its own rounding on floats.

**Multi-currency (PROPOSAL: out of scope for v1).** Keep the `currency` column from day one, but
restrict Cut A–C to one currency per installation and never sum across currencies in a report
(group by `currency`). An FX rate table would be a separate, later decision.

### 2.3 Cut A — external invoice reference (smallest slice)

Replaces the free-text `job_card_notes.invoice_number` with a structured, searchable record.
No numbering, no lines, no immutability machinery beyond append-only application semantics.

```sql
-- PROPOSAL
CREATE TABLE acct_invoice_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  sale_job_card_id UUID,                       -- optional: the SALE this invoice belongs to
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('SALES','PURCHASE')),
  invoice_number VARCHAR(64) NOT NULL CHECK (length(btrim(invoice_number)) > 0),
  invoice_date DATE NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_net NUMERIC(19,2) CHECK (total_net IS NULL OR total_net >= 0),
  total_tax NUMERIC(19,2) CHECK (total_tax IS NULL OR total_tax >= 0),
  total_gross NUMERIC(19,2) NOT NULL CHECK (total_gross >= 0),
  source VARCHAR(24) NOT NULL
    CHECK (source IN ('MANUAL','LEGACY_NOTE_IMPORT','EXTERNAL_SYNC')),
  external_system VARCHAR(60),
  external_id VARCHAR(120),
  superseded_by_id UUID,
  recorded_by UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_invoice_references_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT acct_invoice_references_customer_fk
    FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_invoice_references_sale_fk
    FOREIGN KEY (organization_id, sale_job_card_id) REFERENCES job_cards (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_invoice_references_supersede_fk
    FOREIGN KEY (organization_id, superseded_by_id)
    REFERENCES acct_invoice_references (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT acct_invoice_references_no_self_supersede
    CHECK (superseded_by_id IS DISTINCT FROM id),
  CONSTRAINT acct_invoice_references_actor_fk
    FOREIGN KEY (organization_id, recorded_by) REFERENCES users (organization_id, id)
);
CREATE UNIQUE INDEX acct_invoice_references_number_unique
  ON acct_invoice_references (organization_id, direction, invoice_number);
CREATE INDEX acct_invoice_references_customer_idx
  ON acct_invoice_references (organization_id, customer_id, invoice_date DESC, id DESC);
```

Notes:

- A duplicate invoice number for the same direction in the same organisation is a data error,
  not a workflow: the unique index fails closed. Corrections use `superseded_by_id`, never an
  update of `invoice_number`.
- `source = 'LEGACY_NOTE_IMPORT'` exists only for the one-time migration in §6 and carries the
  originating note id in `external_id`.
- Cut A is deliberately **not** the same table as Cut B's `acct_documents`: an externally issued
  invoice has no lines, no internal number and no immutability contract of ours, and pretending
  otherwise would force nullable totals onto the document table.

### 2.4 Cut B — commercial document, lines and tax

**Scope reality check (ACCEPTED product boundary + VOLATILE law).** MOD-001 §3 defines this as
"quotes/commercial documents, invoice references and lines" (`DECISIONS.md:2032–2035`). Turkish
rules require e-Arşiv issuance for a seller outside e-Fatura from 1/1/2026 regardless of amount
(VUK GT 509 §IV.2.4.3, **VOLATILE**, verify before build), and AGENTS.md §13 (`AGENTS.md:387–406`)
forbids e-invoice integration without explicit approval. Therefore Cut B issues **internal
commercial documents**; the legally issued number is recorded as `external_number`. The UI must
label the two differently or an operator will believe a PDF is a legal invoice.

```sql
-- PROPOSAL: the Accounting half of the buyer identity split (§1.3, Option C).
CREATE TABLE acct_billing_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  legal_name VARCHAR(255) NOT NULL CHECK (length(btrim(legal_name)) > 0),
  tax_office VARCHAR(100),
  billing_address TEXT,
  invoice_email VARCHAR(255),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_billing_profiles_org_id_unique UNIQUE (organization_id, id),
  -- exactly one profile per customer: the tax number itself stays in customers (§1.3)
  CONSTRAINT acct_billing_profiles_customer_unique UNIQUE (organization_id, customer_id),
  CONSTRAINT acct_billing_profiles_customer_fk
    FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT
);
```

```sql
-- PROPOSAL
CREATE TABLE acct_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  kind VARCHAR(16) NOT NULL
    CHECK (kind IN ('QUOTE','PROFORMA','INVOICE','CREDIT_NOTE')),
  status VARCHAR(10) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ISSUED','VOID')),
  customer_id UUID NOT NULL,
  billing_profile_id UUID,                       -- optional; buyer snapshot is authoritative
  sale_job_card_id UUID,                         -- many documents may reference one SALE
  sale_version_at_issue INTEGER CHECK (sale_version_at_issue IS NULL OR sale_version_at_issue > 0),
  document_date DATE NOT NULL,                   -- VUK 230/1 "düzenlenme tarihi"
  issue_date DATE,                               -- set at ISSUED
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  series VARCHAR(10) NOT NULL DEFAULT '',
  fiscal_year SMALLINT NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2999),
  document_number BIGINT CHECK (document_number IS NULL OR document_number > 0),
  display_number VARCHAR(40),
  number_kind VARCHAR(20) CHECK (number_kind IN ('INTERNAL_REGISTER','OFFICIAL')),
  external_number VARCHAR(64),
  external_etn UUID,
  external_status VARCHAR(24) NOT NULL DEFAULT 'NOT_SENT'
    CHECK (external_status IN ('NOT_SENT','SENT','ACCEPTED','REJECTED','CANCELLED',
                               'NEEDS_RECONCILIATION')),
  buyer_name VARCHAR(255) NOT NULL CHECK (length(btrim(buyer_name)) > 0),
  buyer_tax_number VARCHAR(50),
  buyer_tax_office VARCHAR(100),
  buyer_address TEXT,
  total_net NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (total_net >= 0),
  total_tax NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (total_tax >= 0),
  total_gross NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (total_gross >= 0),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID NOT NULL,
  issued_by UUID,
  voided_by UUID,
  voided_at TIMESTAMPTZ,
  void_reason_code VARCHAR(40),
  void_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT acct_documents_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT acct_documents_customer_fk
    FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_documents_sale_fk
    FOREIGN KEY (organization_id, sale_job_card_id) REFERENCES job_cards (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_documents_profile_fk
    FOREIGN KEY (organization_id, billing_profile_id)
    REFERENCES acct_billing_profiles (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT acct_documents_creator_fk
    FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id),
  -- issued documents must carry a date and a number; drafts must carry neither
  CONSTRAINT acct_documents_issue_shape_check CHECK (
    (status = 'DRAFT' AND issue_date IS NULL AND document_number IS NULL
      AND number_kind IS NULL AND display_number IS NULL)
    OR (status IN ('ISSUED','VOID') AND issue_date IS NOT NULL
      AND document_number IS NOT NULL AND number_kind IS NOT NULL
      AND display_number IS NOT NULL)),
  CONSTRAINT acct_documents_void_shape_check CHECK (
    (status <> 'VOID') OR (voided_at IS NOT NULL AND voided_by IS NOT NULL
      AND void_reason_code IS NOT NULL)),
  -- the header total must equal its two components; the sum against the lines is
  -- verified in the same transaction by the issue service (§2.6)
  CONSTRAINT acct_documents_total_shape_check
    CHECK (total_gross = total_net + total_tax)
);
CREATE UNIQUE INDEX acct_documents_number_unique
  ON acct_documents (organization_id, kind, series, fiscal_year, document_number)
  WHERE document_number IS NOT NULL;
CREATE UNIQUE INDEX acct_documents_external_number_unique
  ON acct_documents (organization_id, external_number)
  WHERE external_number IS NOT NULL;
CREATE INDEX acct_documents_customer_idx
  ON acct_documents (organization_id, customer_id, document_date DESC, id DESC);
CREATE INDEX acct_documents_sale_idx
  ON acct_documents (organization_id, sale_job_card_id)
  WHERE sale_job_card_id IS NOT NULL;
```

```sql
-- PROPOSAL
CREATE TABLE acct_document_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL,
  line_no SMALLINT NOT NULL CHECK (line_no > 0),
  product_id UUID,
  sale_item_id UUID,                              -- durable Core line identity
  description VARCHAR(255) NOT NULL CHECK (length(btrim(description)) > 0),
  product_name_snapshot VARCHAR(255),
  product_sku_snapshot VARCHAR(100),
  unit_snapshot VARCHAR(30),
  quantity NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(19,6) NOT NULL CHECK (unit_price >= 0),
  line_net NUMERIC(19,2) NOT NULL CHECK (line_net >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_document_lines_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT acct_document_lines_no_unique UNIQUE (organization_id, document_id, line_no),
  CONSTRAINT acct_document_lines_document_fk
    FOREIGN KEY (organization_id, document_id) REFERENCES acct_documents (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_document_lines_product_fk
    FOREIGN KEY (organization_id, product_id) REFERENCES products (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_document_lines_sale_item_fk
    FOREIGN KEY (organization_id, sale_item_id)
    REFERENCES job_card_sale_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT acct_document_lines_sale_item_needs_product
    CHECK (sale_item_id IS NULL OR product_id IS NOT NULL)
);
CREATE INDEX acct_document_lines_sale_item_idx
  ON acct_document_lines (organization_id, sale_item_id)
  WHERE sale_item_id IS NOT NULL;
```

```sql
-- PROPOSAL: the only tax storage. One row per (line, tax kind).
CREATE TABLE acct_document_line_taxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  line_id UUID NOT NULL,
  tax_kind VARCHAR(12) NOT NULL CHECK (tax_kind IN ('KDV','OTV','TEVKIFAT','DIGER')),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100),
  taxable_base NUMERIC(19,2) NOT NULL CHECK (taxable_base >= 0),
  tax_amount NUMERIC(19,2) NOT NULL CHECK (tax_amount >= 0),
  exemption_code VARCHAR(20),
  withholding_code VARCHAR(10),
  CONSTRAINT acct_document_line_taxes_line_fk
    FOREIGN KEY (organization_id, line_id) REFERENCES acct_document_lines (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_document_line_taxes_unique UNIQUE (organization_id, line_id, tax_kind, tax_rate)
);
```

**Why there is no separate document-level tax table.** A stored per-document tax summary would
be a second source of truth that can disagree with the lines (AGENTS.md §2.1). The document tax
breakdown that an e-invoice needs is a `GROUP BY tax_kind, tax_rate` over
`acct_document_line_taxes`. A line can carry ÖTV **and** KDV simultaneously, which is exactly why
tax lives in its own per-line table rather than in columns on the line.

```sql
-- PROPOSAL: document-to-document relations (credit note -> invoice, proforma -> invoice)
CREATE TABLE acct_document_relations (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  from_document_id UUID NOT NULL,
  to_document_id UUID NOT NULL,
  relation VARCHAR(16) NOT NULL CHECK (relation IN ('CREDIT_OF','CORRECTS','PROFORMA_OF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, from_document_id, to_document_id, relation),
  FOREIGN KEY (organization_id, from_document_id)
    REFERENCES acct_documents (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, to_document_id)
    REFERENCES acct_documents (organization_id, id) ON DELETE RESTRICT,
  CHECK (from_document_id IS DISTINCT FROM to_document_id)
);
```

### 2.5 Cut C — current-account entries and collections

```sql
-- PROPOSAL
CREATE TABLE acct_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  received_on DATE NOT NULL,
  amount NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method VARCHAR(16) NOT NULL
    CHECK (method IN ('CASH','BANK_TRANSFER','CHEQUE','CARD','OTHER')),
  reference VARCHAR(120),
  status VARCHAR(10) NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOID')),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_by UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_collections_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT acct_collections_customer_fk
    FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_collections_creator_fk
    FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id),
  CONSTRAINT acct_collections_void_shape_check
    CHECK ((status = 'VOID') = (voided_at IS NOT NULL))
);

CREATE TABLE acct_collection_allocations (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  collection_id UUID NOT NULL,
  document_id UUID NOT NULL,
  amount NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, collection_id, document_id),
  FOREIGN KEY (organization_id, collection_id)
    REFERENCES acct_collections (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, document_id)
    REFERENCES acct_documents (organization_id, id) ON DELETE RESTRICT
);

-- PROPOSAL: append-only ledger. No stored balance anywhere.
CREATE TABLE acct_current_account_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  entry_kind VARCHAR(24) NOT NULL CHECK (entry_kind IN (
    'INVOICE_DEBIT','CREDIT_NOTE_CREDIT','COLLECTION_CREDIT',
    'ADJUSTMENT_DEBIT','ADJUSTMENT_CREDIT','REVERSAL')),
  document_id UUID,
  collection_id UUID,
  reverses_entry_id UUID,
  entry_date DATE NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_current_account_entries_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT acct_current_account_entries_customer_fk
    FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_current_account_entries_document_fk
    FOREIGN KEY (organization_id, document_id) REFERENCES acct_documents (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_current_account_entries_collection_fk
    FOREIGN KEY (organization_id, collection_id) REFERENCES acct_collections (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT acct_current_account_entries_reversal_fk
    FOREIGN KEY (organization_id, reverses_entry_id)
    REFERENCES acct_current_account_entries (organization_id, id) ON DELETE RESTRICT,
  -- exactly one side is posted
  CONSTRAINT acct_current_account_entries_one_side_check
    CHECK ((debit > 0) <> (credit > 0)),
  -- an entry must be attributable
  CONSTRAINT acct_current_account_entries_source_check CHECK (
    document_id IS NOT NULL OR collection_id IS NOT NULL OR reverses_entry_id IS NOT NULL)
);
CREATE INDEX acct_current_account_entries_balance_idx
  ON acct_current_account_entries (organization_id, customer_id, currency, entry_date, id);
```

**Balance is always derived:** `SUM(debit) - SUM(credit)` grouped by customer and currency, over
the index above. A cached `balance` column is rejected because it would be a second authority
that can drift on restore, void or reversal.

**Allocation rules (PROPOSAL, enforced inside the collection transaction):**

- only against `ISSUED` documents of the same customer and the same currency;
- `Σ allocations of a collection ≤ collection.amount` (`409 ACCT_ALLOCATION_EXCEEDS_COLLECTION`);
- `Σ allocations of a document ≤ document.total_gross − Σ issued credit notes`
  (`409 ACCT_ALLOCATION_EXCEEDS_DOCUMENT`);
- allocations are append-only; a wrong allocation is corrected by voiding the collection (which
  posts a `REVERSAL` ledger entry) and recording a new one, never by editing the allocation row.

**Void effects.** `DOCUMENT_VOIDED` writes a reversing ledger entry in the same transaction; the
original entry stays. A voided collection writes a `REVERSAL` credit/debit pair. Nothing is
deleted, so a restored or audited ledger always explains itself.

### 2.6 Cross-row verification inside the transaction (PROPOSAL)

CHECK constraints cannot sum child rows. Instead of a fragile trigger, the issue/void service
runs, inside the same transaction and after writing lines:

```sql
SELECT COALESCE(SUM(l.line_net),0) AS net,
       COALESCE(SUM(t.tax_amount),0) AS tax
  FROM acct_document_lines l
  LEFT JOIN acct_document_line_taxes t ON t.organization_id = l.organization_id AND t.line_id = l.id
 WHERE l.organization_id = $1 AND l.document_id = $2
```

and raises `ACCT_TOTAL_MISMATCH` if it differs from the stored header. This keeps the invariant
enforced where the data is written (AGENTS.md §6, `AGENTS.md:178–181`) without a hidden trigger.

### 2.7 Worked example (rounding)

Two lines, TRY, KDV 20 %:

| Line | Qty | Unit price | `line_net = round(q×p, 2)` | KDV base | `tax = round(base×0.20, 2)` |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 12.345678 | 37.04 | 37.04 | 7.41 (7.408) |
| 2 | 1 | 0.005 | 0.01 | 0.01 | 0.00 (0.002) |
| **Doc** | | | **37.05** | | **7.41** |

`total_gross = 44.46`. Note that computing tax on the *document* net (37.05 × 0.20 = 7.41) gives
the same answer here but not in general; the rule is fixed at line level so the result never
depends on grouping.

---

## 3. Document immutability and numbering (question 3)

### 3.1 States

```
DRAFT ──issue──▶ ISSUED ──void──▶ VOID
                   │
                   └──credit note (new document, relation CREDIT_OF)
```

| State | Editable | Number allocated | Accounting ledger effect |
| --- | --- | --- | --- |
| `DRAFT` | yes, `PATCH` with `expectedVersion` (`DECISIONS.md:389–398`) | no | none |
| `ISSUED` | **no** substantive edit | yes (internal or external) | debit/credit entry created in the same transaction |
| `VOID` | no; only `voided_*` metadata | number retained | reversing entry in the same transaction |

### 3.2 Three enforcement layers (PROPOSAL)

1. **Repository surface:** no update/delete method exists for an issued document. This is the
   DOM-005 pattern (`DECISIONS.md:584–594`).
2. **Service guard:** the command locks the row, checks `status` and `expectedVersion`, and
   refuses any field list containing a frozen column (`ACCT_DOCUMENT_IMMUTABLE`).
3. **Database trigger:** `BEFORE UPDATE OR DELETE` on `acct_documents`,
   `acct_document_lines`, `acct_document_line_taxes` that raises unless the only changed columns
   are the whitelisted lifecycle/transport ones (`status`, `external_status`, `external_number`,
   `external_etn`, `voided_at`, `voided_by`, `void_reason_code`, `void_note`, `version`,
   `updated_at`).

**Why a trigger here but not for notes.** DOM-005 explicitly declined a trigger for JobCard notes
because notes are not a regulatory ledger (`DECISIONS.md:584–601`). An issued commercial document
*is* one: VUK 231/1 requires sequential numbering and the document is the evidence of the
transaction (mevzuat.gov.tr VUK 213 m.229–231, accessed 2026-11-26). DOM-005's other lesson
still applies: if the owner rejects the trigger, the contract and docs must say
"append-only by application contract", never "physically immutable".

### 3.3 Correction paths (no edit-in-place)

| Situation | Allowed action | Forbidden |
| --- | --- | --- |
| Draft has a mistake | edit the draft | — |
| Issued document has a wrong amount/line | `VOID` + reissue, or a `CREDIT_NOTE` referencing it | editing the issued row |
| Customer returns goods | `CREDIT_NOTE` with `relation = CREDIT_OF` | deleting the original |
| Price correction after delivery | `CREDIT_NOTE` (accountant decides the legal document type) | rewriting line amounts |
| External system rejects the document | `void` or reissue under a new number; the rejected external number is retained | reusing the rejected number |

**Turkish nuance that must not be hard-coded.** In UBL-TR, `InvoiceTypeCode = IADE` is defined as
the invoice **the buyer** issues to return goods (UBL-TR Kod Listeleri v1.27 §1.4, accessed
2026-11-26), and since 2025 an `IADE`/`TEVKIFATIADE` invoice must carry a reference to the invoice
it corrects (secondary source: PwC e-Dönüşüm Bülteni 2025/08, 14.02.2025). The module therefore
stores a neutral `CREDIT_NOTE` + `correction_reason`, and the *integrator mapping* decides the
legal type code. Do not bake `IADE` into the schema.

### 3.4 Numbering

```sql
-- PROPOSAL
CREATE TABLE acct_number_sequences (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('QUOTE','PROFORMA','INVOICE','CREDIT_NOTE')),
  series VARCHAR(10) NOT NULL DEFAULT '',
  fiscal_year SMALLINT NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2999),
  next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, kind, series, fiscal_year)
);
```

Allocation, inside the issue transaction, after the idempotency claim:

```sql
-- PROPOSAL
INSERT INTO acct_number_sequences (organization_id, kind, series, fiscal_year)
VALUES ($1, $2, $3, $4)
ON CONFLICT (organization_id, kind, series, fiscal_year) DO UPDATE
  SET next_value = acct_number_sequences.next_value + 1,
      version = acct_number_sequences.version + 1,
      updated_at = NOW()
RETURNING next_value - 1 AS allocated;
```

Properties:

- **Atomic and serialised per key.** The `UPDATE` takes the row lock; two concurrent issues in
  the same series/year queue behind each other. At this business volume (tens of invoices per
  day) that is invisible; it is *not* a general-purpose high-throughput counter.
- **Gap-free on rollback.** The increment is transactional, so a failed issue (validation,
  deadlock, crash before commit) releases the number. This is the decisive difference from
  `CREATE SEQUENCE`.
- **Per type / series / fiscal year**, matching VUK 231/1's "sıra numarası dahilinde teselsül"
  and its branch/series allowance (mevzuat.gov.tr VUK 213 m.231, accessed 2026-11-26).
- **Display format** `SM-<series>-<year>-<9 digits>`, e.g. `SM-A-2026-000000042` (PROPOSAL).
  It must be *visibly different* from a GİB e-Fatura number, which is a 3-character unit code +
  4-digit year + 13-digit sequence (GİB Karekod Standardı Kılavuzu v1.0, 17.02.2023, accessed
  2026-11-26) — otherwise an internal register number will be quoted to a customer as an
  e-invoice number.

### 3.5 Gaps, voids and external numbers

| Case | Rule |
| --- | --- |
| Allocation rolled back | no gap: the counter increment rolls back with the transaction |
| Number allocated, document then voided | the row stays with `status = 'VOID'`; the number is used, not skipped. GİB's position on a skipped e-Fatura number is that the skipped numbers may be recorded with a cancellation entry (GİB özelge 07.01.2015, no. 53445970-105[27-54]-3, accessed 2026-11-26) — i.e. never silently skip |
| Number comes from an integrator/ERP | `number_kind = 'OFFICIAL'`, `external_number` + `external_etn`; the internal register number is still allocated for our own audit trail but is labelled "iç kayıt" in the UI |
| External number duplicated | `acct_documents_external_number_unique` fails closed |
| Year rollover | new `fiscal_year` key starts at 1; no reset of history |
| Branch/series | separate `series` values, each gap-free; series selection is a document-type policy, not user-free-text |

### 3.6 Why not a PostgreSQL sequence (evidence)

> "PostgreSQL sequence objects cannot be used to obtain 'gapless' sequences."
> — PostgreSQL 17, *Sequence Manipulation Functions*, accessed 2026-11-26.

The same page notes that a `nextval()` value is not reclaimed if the transaction aborts, and that
a sequence value used for persistent outside-the-database purposes must be committed before use —
which is precisely the invoice-number situation. A transactional counter row is the correct
primitive here; `nextval` is correct only where gaps are harmless (internal surrogate ids).

---

## 4. Audit and idempotency (question 4)

### 4.1 Audit

**Reuse:** the *pattern* of writing the audit row inside the business transaction, exactly as CRM
and Products do (`server/src/modules/crm/service.ts:424–426`,
`server/src/modules/products/service.ts:230–234`), and the append-only rule from DOM-005
(`DECISIONS.md:590–594`).

**Do not reuse the table.** `audit_events` requires a non-null `organization_id` and
`actor_user_id` and constrains `subject_type` to a closed vocabulary (`server/src/db/migrations/003_people.sql:32–51`,
widened by `server/src/db/migrations/004_crm_contacts.sql:57–60`). Every new module entity would need a migration to widen
that CHECK, and Accounting events would appear in CRM/People admin screens. MOD-002 already set
the precedent of a module/installation-owned audit table (`operator_audit_events`,
`server/src/db/migrations/074_installation_operator_and_module_state.sql:67–120`).

```sql
-- PROPOSAL
CREATE TABLE acct_document_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL,
  actor_user_id UUID,                        -- nullable only for SYSTEM (e.g. migration)
  actor_kind VARCHAR(10) NOT NULL CHECK (actor_kind IN ('USER','SYSTEM')),
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN (
    'DOCUMENT_CREATED','DOCUMENT_UPDATED','DOCUMENT_ISSUED','DOCUMENT_VOIDED',
    'LINE_ADDED','LINE_UPDATED','LINE_REMOVED','CREDIT_NOTE_LINKED',
    'EXTERNAL_NUMBER_RECORDED','EXTERNAL_STATUS_CHANGED','LEGACY_REFERENCE_IMPORTED')),
  old_value JSONB,
  new_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acct_document_events_document_fk
    FOREIGN KEY (organization_id, document_id) REFERENCES acct_documents (organization_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX acct_document_events_timeline_idx
  ON acct_document_events (organization_id, document_id, occurred_at, id);
```

Boundary rules:

- The **module toggle** is never written here; it belongs to `operator_audit_events`
  (`server/src/db/migrations/074_installation_operator_and_module_state.sql:81–85`).
- Payloads carry field names and changed values only for non-sensitive fields; buyer tax numbers
  are **not** duplicated into `old_value`/`new_value` (AGENTS.md §5, `AGENTS.md:164–166`).
- `acct_document_events` is append-only; no update/delete surface, same contract as DOM-005.
- Cut A (`acct_invoice_references`) also needs its own append-only event row or an
  `acct_reference_events` table — decide when the cut is scoped; do not silently reuse the
  document timeline for a table that has no document.

### 4.2 Idempotency

**Reuse the shared helper, not a copy.** `runCriticalAction`
(`server/src/db/critical-action.ts:142–221`) already implements exactly the contract AGENTS §7
demands:

| Step | Line | Behaviour |
| --- | --- | --- |
| `BEGIN` + claim | `server/src/db/critical-action.ts:155–164` | `INSERT INTO processed_actions … ON CONFLICT DO NOTHING RETURNING id` |
| Duplicate path | `:172–190` | read existing row, `assertCriticalActionRequestHash` (`:42–53`), replay body if `completed`, else `processing` (`409 ACTION_IN_PROGRESS`) |
| Work + receipt | `:192–202` | one `UPDATE … RETURNING id`; `rowCount !== 1` → `CRITICAL_ACTION_RECEIPT_INCOMPLETE` |
| Failure | `:209–221` | rollback; deadlock/serialisation mapped to `ACTION_IN_PROGRESS` |
| Unique identity | `server/src/db/migrations/002_delivery_tracer.sql:209` | `(organization_id, user_id, client_action_id, operation_key)` |
| Key length | `server/src/db/migrations/002_delivery_tracer.sql:201` | `operation_key VARCHAR(100)` |

**Command and key map (PROPOSAL, all ≤ 100 chars):**

| Command | `operation_key` | Required body |
| --- | --- | --- |
| Create draft | `ACCT_DOC_CREATE` | `clientActionId`, `kind`, customer, lines |
| Edit draft | `ACCT_DOC_UPDATE:<documentId>` | `clientActionId`, `expectedVersion`, changed fields |
| Issue | `ACCT_DOC_ISSUE:<documentId>` | `clientActionId`, `expectedVersion`, `documentDate`, number series |
| Void | `ACCT_DOC_VOID:<documentId>` | `clientActionId`, `expectedVersion`, reason code, note |
| Link credit note | `ACCT_DOC_LINK:<documentId>` | `clientActionId`, `expectedVersion`, target id, relation |
| Record external number | `ACCT_DOC_EXTERNAL:<documentId>` | `clientActionId`, `expectedVersion`, number, ETN |
| Cut A reference | `ACCT_REF_CREATE` | `clientActionId`, number, date, amount |
| Collection | `ACCT_COLLECTION_CREATE` | `clientActionId`, customer, amount, date |
| Allocation | `ACCT_ALLOCATION:<collectionId>` | `clientActionId`, `expectedVersion`, document, amount |

**Request hash.** Reuse the normalised-semantics convention from
`server/src/modules/job-cards/critical-action-request-hash.ts` (`:331–338` shows a hashed
normalised payload): the hash covers the semantic intent including `expectedVersion`, so the same
key with a different amount is `409 CLIENT_ACTION_REUSED` (`server/src/db/critical-action.ts:42–53`), not a
silent second document.

**Ordering rule.** Claim → lock → validate → write lines/taxes → allocate number → write audit →
`UPDATE` ledger entry → complete receipt → `COMMIT`. No side effect (number, ledger, notification)
exists before the claim (`AGENTS.md:199`, `SERVORA_MED_API_DRAFT.md:158`).

**What is *not* idempotent by default.** Draft `PATCH` uses `expectedVersion` only, matching the
accepted rule that ordinary field updates do not use processed-response caching
(`DECISIONS.md:393`; `SERVORA_MED_API_DRAFT.md:164`). Issuing is a critical command and always
takes `clientActionId`.

---

## 5. Relationship to SALE (question 5)

### 5.1 Direction (ACCEPTED)

MOD-001 §5 (`DECISIONS.md:2051–2059`) says the SALE already carries durable sale identity,
durable line identity, snapshots, customer and approval history, "these may later serve as
references for Warehouse and Accounting", and that no `invoiceNumber`, price, VAT or revenue
field is added to SALE. SALE-001 (`DECISIONS.md:1982–1985`) says sale creation/correction never
creates financial operations.

**Therefore:** `acct_documents.sale_job_card_id` → `job_cards` and
`acct_document_lines.sale_item_id` → `job_card_sale_items`. Core keeps **zero** knowledge of
documents: no `invoice_id`, no `invoiced_at`, no `is_invoiced` flag.

### 5.2 Cardinality and partial invoicing (PROPOSAL)

- **One SALE → many documents.** `acct_documents.sale_job_card_id` is not unique. A proforma, a
  final invoice and one or more credit notes legitimately reference the same sale.
- **Partial invoicing is allowed** at line level: the sum of *issued* invoice line quantities
  minus *issued* credit-note quantities may never exceed the referenced sale line quantity.
  Validation query inside the issue transaction:

  ```sql
  -- PROPOSAL
  SELECT COALESCE(SUM(CASE WHEN d.kind = 'CREDIT_NOTE' THEN -l.quantity ELSE l.quantity END), 0)
    FROM acct_document_lines l
    JOIN acct_documents d ON d.organization_id = l.organization_id AND d.id = l.document_id
   WHERE l.organization_id = $1 AND l.sale_item_id = $2 AND d.status = 'ISSUED'
  ```

  with `≤ job_card_sale_items.quantity`. Exceeding it is `409 ACCT_SALE_LINE_EXCEEDED`.
- **Note the deliberate asymmetry with delivery.** SALE-002 allows at most one delivery per sale
  and explicitly no partial deliveries, no remaining-quantity tracking
  (`DECISIONS.md:2148–2159`; `server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:38–43`). Invoicing must *not* inherit that rule: partial
  invoicing is normal commercial practice and the sale quantity is an integer count
  (SALE-QTY-001, `DECISIONS.md:2077–2086`).
- **Locks.** The issue transaction reads the sale item rows with `FOR SHARE` (not `FOR UPDATE`),
  ordered by id, after the customers lock and before any `acct_*` write. `FOR SHARE` blocks a
  concurrent sale-line edit (which takes `FOR UPDATE` on the JobCard) while allowing other
  readers, and it fits the documented order `users → customers → contacts → products → job_cards`
  (`DECISIONS.md:517–518`; `SERVORA_MED_API_DRAFT.md:934–939`). Accounting never takes a
  `FOR UPDATE` lock on a Core row.
- **Eligible sale states (PROPOSAL).** `QUOTE`/`PROFORMA` may reference a sale in any
  non-`INVALIDATED` state; `INVOICE` requires `COMPLETED` (manager-approved), because approval is
  the commercial commitment (`DECISIONS.md:2129–2136`). If the owner wants prepayment invoicing,
  `ACCEPTED` must be added deliberately.
- **Demo data.** `ISSUE` is refused when the referenced sale is `data_class = 'DEMO'`
  (`server/src/db/migrations/034_demo_data_foundation.sql:89–102`): a demo record must never consume a real invoice
  number.

### 5.3 SALE corrections, cancel and invalidate after a document exists (PROPOSAL)

The SALE lifecycle stays exactly as accepted: draft correction while `NEW`/`ACCEPTED`/
`IN_PROGRESS`/`REVISION_REQUESTED`, closed after `COMPLETED`/`CANCELLED`/`INVALIDATED`, and
ADMIN invalidation as the terminal historical correction
(`docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:162–169`;
`DECISIONS.md:1976–1979`; `server/src/modules/job-cards/policy.ts:21–23`).

**Recommendation: flag, do not block, and never mutate the document.**

1. `acct_documents.sale_version_at_issue` stores `job_cards.version` at issue time.
2. A read-only divergence report compares it to the current `job_cards.version` and to
   `job_cards.status`; any difference produces `SALE_CHANGED_AFTER_ISSUE` /
   `SALE_INVALIDATED_AFTER_ISSUE` on the document's reconciliation list.
3. Documents keep their snapshots; nothing is recalculated.
4. No core hook, no event, no outbox: divergence is *derived on read*. This respects MOD-001 §4's
   prohibition on a generic event bus (`DECISIONS.md:2041–2050`) and keeps Core independent.

**Why not block** (rejected alternative): blocking a SALE edit or invalidate would require Core to
ask Accounting, which fails when the module is off (C12) and recreates the SCH-001 defect. Blocking
only while the module is on would mean the same SALE edit is legal in one install and illegal in
another — worse than a visible reconciliation flag.

**Residual risk:** an ADMIN can invalidate a sale whose invoice is already with the customer. The
report makes it visible, but nothing prevents it. If the owner wants a hard stop, it must be a
core-owned rule (e.g. "invalidating a COMPLETED sale requires a reason code
`DOCUMENT_ISSUED_EXTERNALLY`"), not a module dependency.

---

## 6. `invoiceNumber` note debt (question 6)

**Current state (ACCEPTED as debt).** `job_card_notes.invoice_number TEXT` with a ≤100-char CHECK
(`server/src/db/migrations/024_job_card_notes_invoice_number.sql:1–4`); accepted only for `SALES_MEETING` and
`PRODUCT_DELIVERY` (`server/src/modules/job-cards/notes-service.ts:22`, `:56–62`); part of the
note's request hash (`server/src/modules/job-cards/critical-action-request-hash.ts:331–338`);
notes are append-only by contract (`DECISIONS.md:576–601`). MOD-001 §Consequences records it as
domain debt whose resolution belongs to Accounting A0 (`DECISIONS.md:2065–2066`).

| Option | Pros | Cons |
| --- | --- | --- |
| **1. Leave as legacy** | zero risk, zero migration | two places to look up a number forever; the module and the note can disagree; search stays split |
| **2. One-time import into references** | single searchable place; historical numbers become first-class | needs an owner-approved data migration; ambiguous rows (same number on two notes) need a rule; must not rewrite notes |
| **3. Hide when module is on** | new data lands in the right place immediately | a runtime UI/API contract change; the field must come back if the module is later disabled |

**Recommendation: 3 now, 2 as a separate approved migration, 1 as the permanent fallback for rows
that cannot be mapped.** Concretely:

1. While the module is enabled, the note form hides "Fatura:" and the note API rejects a non-null
   `invoiceNumber` with a coded `400 ACCT_INVOICE_REFERENCE_REQUIRED` pointing at the reference
   form. While the module is disabled, the field behaves exactly as today (C12: a module may add,
   never remove, a core capability unless the owner explicitly retires it).
2. A later, separately approved migration copies `job_card_notes.invoice_number` into
   `acct_invoice_references` with `source = 'LEGACY_NOTE_IMPORT'` and `external_id = note id`.
   Rows are **copied, never deleted or updated** (DOM-005, `DECISIONS.md:590–601`).
3. Note rendering labels imported values "Fatura (eski kayıt)" so a reader knows it is a legacy
   free-text value, not a validated document.
4. Replay compatibility: the note request hash keeps including `invoiceNumber`
   (`server/src/modules/job-cards/critical-action-request-hash.ts:331–338`), so already-completed receipts still replay
   byte-identically; only *new* non-null values are rejected.

---

## 7. Enable / disable behaviour (question 7)

**ACCEPTED mechanics.** MOD-002 defines a typed per-module row
(`server/src/db/migrations/074_installation_operator_and_module_state.sql:50–65`), a single read port with no cache (`server/src/modules/installation-modules/state.ts:42–63`),
fail-closed projection (`server/src/modules/installation-modules/state.ts:82–101`), and audited, version-checked toggles
(`DECISIONS.md:3765–3769`). The pilot contract fixes the HTTP behaviour:
disabled → existing `404`; missing row or read failure → `503`, no env fallback
(`docs/features/operator-module-pilot.md:152–160`; `server/src/modules/overview/service.ts:87–101`).

> Note on the task brief's "routes (503 fail-closed)": the accepted pilot distinguishes the two
> cases. `503` is the *unreadable state* path; a deliberate disable is `404`. Accounting should
> follow the accepted contract, not invent a third behaviour.

| Aspect | Behaviour (PROPOSAL unless cited) |
| --- | --- |
| Data | Never deleted, never cascaded, never rewritten. FKs remain. Re-enabling shows byte-identical data. |
| Routes | Always registered; gate inside the service (pilot precedent `docs/features/operator-module-pilot.md:160–161`). Disabled → `404 NOT_FOUND`; unreadable state → `503 ACCT_MODULE_STATE_UNAVAILABLE`. |
| Capability | `capabilities.accounting = false` in `/api/auth/login` and `/api/auth/me`; read failure logs and reports `false` (`server/src/modules/capabilities/service.ts:24–29`, `docs/features/operator-module-pilot.md:287–290`). |
| UI | Navigation entry, routes and dashboard tiles disappear; an open page moves to `/jobs` on the next revalidation, like Overview (`docs/features/operator-module-pilot.md:173–178`). No partial "read-only" mode. |
| Money path (stricter) | `ISSUE`, `VOID` and collection commands re-read the module row **inside** the command transaction before allocating a number or writing a ledger entry, so a toggle that commits mid-request cannot produce a numbered document after the switch-off. This is one extra PK read; it is not a cache. (PROPOSAL; stricter than Overview because money leaves the system.) |
| Background jobs | **None in Cut A–C.** If a reminder/scanner is added later, it must check state *at claim time*, not at tick start, and must not bulk-revive queued items on re-enable (`docs/backlog/2026-11-25-core-modules-architecture-research.md:202–204`). |
| Outbox / notifications | No durable domain outbox in this cut (MOD-001 §4, `DECISIONS.md:2041–2050`). If in-app notifications are added, they are best-effort and must not be replayed on re-enable. |
| Reports | Accounting's own reports sit behind the gate. Core and Overview reports never include accounting money (DOM-006, `DECISIONS.md:633–638`), so disabling cannot change a core number. |
| Restore interaction | Module state rewinds to the backup instant — documented, not a bug (`docs/features/operator-module-pilot.md:188–189`). |
| Who may switch | Only an installation operator holding `MODULE_MANAGEMENT` (`server/src/db/migrations/074_installation_operator_and_module_state.sql:28–35`; `server/src/modules/operator/service.ts:123–125`). Customer ADMIN cannot see, grant or reach it (`DECISIONS.md:3753–3757`). Every change is `expectedVersion`-checked and audited in `operator_audit_events` in the same transaction (`server/src/db/migrations/074_installation_operator_and_module_state.sql:67–120`). |
| Registry cost | Adding the key needs: a descriptor in `server/src/modules/installation-modules/registry.ts:7–24`, a widened `installation_module_state_key_check` (`server/src/db/migrations/074_installation_operator_and_module_state.sql:59`), a widened `operator_audit_events_module_key_check` (`server/src/db/migrations/074_installation_operator_and_module_state.sql:87`), and a new capability field in `server/src/modules/capabilities/service.ts:7–13`. |
| Operator UI warning | Before disabling, the operator panel should state how many `ISSUED` documents exist and that they remain visible. Disabling is not destructive, so it is not blocked. |

**What must never happen:** a Core screen, Core command or Core report changing behaviour because
Accounting is off. If a future requirement looks like that, it belongs in Core (SCH-001 pattern)
or nowhere.

---

## 8. Restore and fresh install (question 8)

### 8.1 What a restore means

- **Restore targets are isolated/new; there is no web-triggered production restore, tenant reset
  or one-click rollback** (`docs/operations/backup-restore.md:24`). The host operator drives it.
- **Operator access is reset before traffic opens:** all sessions revoked, all accounts
  deactivated, `OPERATOR_ACCESS_RESET_BY_RESTORE` audited, accounts re-granted over the host CLI
  (`server/src/modules/operator/restore-reset.ts:13–56`; MOD-002 §6, `DECISIONS.md:3776–3777`).
- **Module state and audit return to the backup instant** (`docs/features/operator-module-pilot.md:188–189`);
  an operator who enabled Accounting after the backup will find it disabled. Documented, expected,
  data untouched.

### 8.2 Numbering after a restore (the real hazard)

A restore rewinds `acct_number_sequences` to the backup instant, while numbers already printed,
sent to a customer, or transmitted through an integrator still exist outside the database. Blindly
continuing would re-issue a number that is already in the world.

**Mandatory post-restore procedure (PROPOSAL, host-run, audited):**

1. Issuance stays closed (the API is not serving, or the module is off).
2. For each `(kind, series, fiscal_year)`, compute
   `max(restored document_number)` and `max(external_number)` from the restored database **and**
   from the external record (integrator portal export, accountant's list).
3. Set `next_value = greatest(db_max, external_max) + 1`; record the source and the operator in a
   `acct_number_reconciliations` row (or an operator audit event with a document-count summary).
4. For every `ISSUED` document whose `external_status` is `SENT`/`ACCEPTED`, verify against the
   integrator that the number and ETN still exist; mark unverifiable rows `NEEDS_RECONCILIATION`
   rather than resending. Nothing is auto-resent (there is no durable outbox to resend anyway).
5. Only then open traffic.

Supporting append-only row (PROPOSAL):
`acct_number_reconciliations (organization_id, kind, series, fiscal_year, previous_next_value,
new_next_value, db_max, external_max, source, reconciled_by, reconciled_at, note)` — one row per
counter per restore. It is the evidence that the jump was deliberate, and the reason the counter
values are trusted afterwards.

**Why this cannot be automated safely:** the database cannot know what happened outside it. The
step is therefore an operational gate, not a migration.

### 8.3 Fresh install

- **Nothing is copied from production.** No customers, no documents, no counters beyond the
  implicit `next_value = 1`, no operator accounts, no `installation_module_state` rows before the
  one-time env takeover.
- The takeover inserts exactly one row per registry key from the env value and audits
  `MODULE_STATE_TAKEN_OVER` in the same transaction (`server/src/modules/installation-modules/takeover.ts:20–64`;
  `docs/features/operator-module-pilot.md:117–126`). A fresh empty database with `ACCOUNTING_ENABLED` unset is
  **off**; explicit `true` is **on**.
- The first operator is granted by the host CLI after deploy, with explicit owner approval
  (`docs/features/operator-module-pilot.md:196–197`).
- **Demo data must not fabricate a legal document.** PROPOSAL: demo datasets may create `DRAFT`
  documents only, `ISSUE` refuses `data_class = 'DEMO'` sales (§5.2), and the demo purge must
  treat accounting tables as known dependencies — its postcondition check enumerates tables
  explicitly (`server/src/modules/demo-data/repository.ts:695–719`) and its deletion helpers fail
  closed on unexpected ownership (`:90–96`, `:181–186`), so a new table that is not registered
  would either block the purge or leave rows.

---

## 9. Offboarding (question 9)

### 9.1 Staff who created or issued documents

- `created_by`, `issued_by`, `voided_by`, `recorded_by` are `RESTRICT` FKs to `users`. Staff
  users are never hard-deleted — generic Staff deactivation is rejected and only the offboarding
  flow deactivates, and an offboarded Staff user can never be reactivated
  (`DECISIONS.md:2936–2948`). History therefore survives by construction.
- **No increase in offboarding blockers.** Core offboarding must work while a module is off
  (`docs/backlog/2026-11-25-core-modules-architecture-research.md:204–205`). Weekly Report blocks
  offboarding (`server/src/modules/people/offboarding.ts:1055–1067`) because it is *unfinished
  work owned by that person*; an issued tax document is a finished historical fact. Adding a
  module-owned blocker would recreate the SCH-001 defect and would make offboarding behave
  differently per install.
- Open `DRAFT` documents owned by the leaver are **informational**: they appear in an Accounting
  "open drafts" list; management can issue or void them, and `created_by` is never rewritten
  (it is history, not an assignment). PROPOSAL; the alternative (block until drafts are
  resolved) is rejected for the reason above.
- Attribution for reports: Accounting reports attribute by the *actor fields on the document*
  (`issued_by`), not by the current customer assignee — the same principle REPORT-002 applies to
  JobCard metrics (`DECISIONS.md:2164–2166`).

### 9.2 Customer deactivation with open receivables

- Today, deactivation only refuses while the customer has active JobCards
  (`server/src/modules/crm/service.ts:412–428`, guard query
  `server/src/modules/crm/repository.ts:178–185`). Receivables are invisible to Core.
- **Recommendation: do not block deactivation.** Deactivation is reversible, deletes nothing and
  does not affect the customer's ability to pay. Blocking would be a Core rule that depends on a
  module, and would fail open when the module is off.
- Instead: (a) Accounting shows an "open balance" warning on the deactivate confirmation when the
  module is on; (b) an Accounting-owned report "inactive customers with open balance" lists them;
  (c) the receivables stay fully operational (collections can still be recorded for an inactive
  customer).
- If the owner wants a hard block, it must be written as an explicitly documented *module-off
  relaxation* — the Calendar precedent shows what happens when that trade-off is left implicit
  (`DECISIONS.md:3720–3726`).
- **Hard delete is already safe.** `deleteCustomer` maps any Postgres `23503` to
  `CUSTOMER_HAS_OPERATION_HISTORY` 409 (`server/src/modules/crm/service.ts:399–409`), and
  `deleteProduct` does the same for products (`server/src/modules/products/service.ts:238–248`).
  A `RESTRICT` FK from accounting tables therefore makes hard delete fail closed **without any
  Core change**; only the user-facing wording ("geçmiş teslimat veya satış kayıtlarında") may
  later need to mention invoices.

---

## 10. Permissions and KVKK (question 10)

### 10.1 Capability matrix (PROPOSAL)

Roles are the existing `STAFF`/`MANAGER`/`ADMIN` (`server/src/db/migrations/001_auth_foundation.sql:16`; no new role is
introduced — a fourth role would break `role !== 'STAFF'` checks, exactly the risk recorded for
the operator account, `docs/backlog/2026-11-25-core-modules-architecture-research.md:192–199`).

| Capability | Saha personeli (STAFF) | Yönetici (MANAGER) | Admin (ADMIN) | Operator |
| --- | --- | --- | --- | --- |
| Read documents, balances, collections | ✗ (see own-sale status only) | ✓ | ✓ | ✗ (module switch only) |
| Create/edit `DRAFT` documents | ✗ | ✓ | ✓ | ✗ |
| Issue a document (allocates a number) | ✗ | ✗ (recommended) | ✓ | ✗ |
| Void a document | ✗ | ✗ | ✓ | ✗ |
| Record a collection / allocation | ✗ | ✓ | ✓ | ✗ |
| Cut A invoice reference | ✗ | ✓ | ✓ | ✗ |
| Edit `acct_billing_profiles` | ✗ | ✓ | ✓ | ✗ |
| Edit `customers.tax_number` (Core) | ✗ | ✓ | ✓ | ✗ |
| Toggle the module | ✗ | ✗ | ✗ | ✓ `MODULE_MANAGEMENT` |
| Read own SALE's document status (no amounts, no numbers) | ✓ (proposal) | ✓ | ✓ | ✗ |

- **Issue/void = ADMIN only** mirrors ADMIN-only JobCard invalidation
  (`server/src/modules/job-cards/policy.ts:21–23`). If the owner's sales manager is the person who
  actually issues invoices, MANAGER must be added deliberately — this is open question OQ-1.
- **STAFF gets no money.** DOM-001/DOM-006 keep financial facts out of field workflows; the only
  STAFF-visible accounting fact is "this sale has a document, dated X" on the sale they own, with
  no amounts and no counterparty data.
- Enforcement is backend-only; UI hiding is navigation, never authorization
  (`DECISIONS.md:531`).

### 10.2 KVKK notes for sole-proprietor tax ids

- **TCKN is personal data.** KVKK's guidance treats numbers that identify a real person —
  explicitly including identity, tax and insurance numbers — as personal data
  (`https://www.kvkk.gov.tr/SharedFolderServer/CMSFiles/a9eb73e7-bf35-46d7-84e7-58a4618128cc.pdf`,
  accessed 2026-11-26), and the Kurum published a dedicated guide on processing Turkish identity
  numbers (`https://www.kvkk.gov.tr/Icerik/7798/…`, published 16.01.2024, accessed 2026-11-26).
  A sole proprietor's VKN *is* their TCKN, so a `customers.tax_number` that holds 11 digits may be
  personal data.
- **Lawful basis:** the invoice is a legal obligation (VUK 230/3 requires the buyer's name, title,
  address and tax office/account number on the invoice — mevzuat.gov.tr VUK 213, accessed
  2026-11-26). Accounting may therefore store and print it; it may not repurpose it.
- **Minimisation rules (PROPOSAL):**
  1. Full tax number only on the document detail and the document print/export; list, search and
     report endpoints return a masked form (`*********34` for 11 digits, `**********` for 10).
  2. Never log a request body containing a tax number (AGENTS.md §5, `AGENTS.md:164–166`); audit
     payloads exclude it (§4.1).
  3. No customer/company/person name may be used in web searches by agents working on this repo
     (research rule; no data leaves the installation).
  4. Search by full tax number is allowed only for roles that may already read full documents;
     STAFF cannot search by tax number.
  5. Documents are retained per the legal storage obligation and are never deleted with the
     customer; the FK `RESTRICT` already guarantees that.
- **Pre-existing exposure to note (not changed by this module):** `customers.tax_number` is
  currently rendered as plain text to any user who can open the customer
  (`web/src/CustomerDetail.tsx:53`; `web/src/CustomerList.tsx:360`). That is a Core/CRM KVKK
  follow-up; this module must not *widen* it, and open question OQ-6 asks whether CRM should mask
  it for STAFF.

---

## 11. Rejected alternatives and residual risks

| Rejected | Why |
| --- | --- |
| Full general ledger / chart of accounts / journals | MOD-001 §3 explicitly forbids it (`DECISIONS.md:2036–2040`) |
| Storing `invoiceNumber` / price / VAT on SALE | MOD-001 §5 (`DECISIONS.md:2051–2059`), DOM-001, DOM-004 |
| Core reading Accounting to decide a core command | Module-off would change core behaviour (SCH-001 defect pattern) |
| A generic domain event bus / outbox for sale→document sync | MOD-001 §4 (`DECISIONS.md:2041–2050`); divergence is derived on read instead |
| A cached customer balance column | Second authority; drifts on void/restore/reversal |
| PostgreSQL `SEQUENCE` for invoice numbers | Documented as unable to be gapless (PostgreSQL 17 docs) |
| Float/`Number` money | `numeric` is exact and is what PostgreSQL recommends for money |
| A second editable `tax_number` in the billing profile | Two authorities for one fact (Option B) |
| A new `ACCOUNTANT` role | No role change without an explicit decision; would break `role !== 'STAFF'` checks |
| Blocking SALE edit/invalidate when a document exists | Requires a Core→module dependency; fails when the module is off |
| Blocking customer deactivation on open receivables | Same dependency problem; deactivation is reversible and deletes nothing |

**Residual risks to record in the decision:**

1. `ISSUE` without an e-belge integration produces a document that is *not* a legally issued
   invoice (VOLATILE legal basis: VUK GT 509 §IV.2.4.3). The UI wording is a compliance control,
   not cosmetics.
2. The post-restore numbering reconciliation is a human gate; if it is skipped, duplicate numbers
   can reach customers.
3. A SALE invalidated after invoicing leaves an unreconciled receivable until someone acts; the
   report makes it visible but does not prevent it.
4. `customers.tax_number` remains a single free-text field with no VKN/TCKN check-digit
   validation; a typo is only caught by a human or by the integrator's rejection.
5. Cut A can record a number that does not correspond to any document in the system (by design);
   it is a reference, not proof.

---

## Open questions

- **OQ-1 — Who may issue?** ADMIN only (my recommendation, mirrors invalidation) or MANAGER too?
  This decides `accounting.issue` and cannot be changed later without a migration-free policy
  change but a visible workflow change.
- **OQ-2 — Partial invoicing in v1, or one invoice per SALE?** I recommend allowing partial
  invoicing (line-quantity tracking) because real orders ship in instalments; the simpler
  alternative is one invoice per sale with a hard unique index.
- **OQ-3 — Is the legal number ours or the integrator's?** If an e-belge integration is approved
  later, `number_kind = 'OFFICIAL'` changes meaning. Until then everything is
  `INTERNAL_REGISTER`.
- **OQ-4 — Billing profile placement (Option C).** Accept the two-screen split
  ("Müşteri bilgileri" in CRM, "Fatura bilgileri" in Accounting), or accept Option A and widen
  `customers`?
- **OQ-5 — Customer deactivation with open receivables:** warn only (recommended) or block with a
  documented module-off relaxation?
- **OQ-6 — Should CRM mask `customers.tax_number` for STAFF?** KVKK-adjacent, but it is a Core
  change and belongs to its own decision.
- **OQ-7 — Do we need ÖTV and tevkifat in Cut B, or can they wait?** The schema seam
  (`tax_kind`) exists either way; the computation and the e-invoice mapping do not.
- **OQ-8 — TRY-only in v1?** I recommend yes, with `currency` present from day one and no FX
  table.
- **OQ-9 — Void vs credit note windows.** The exact rules for cancelling an e-Fatura/e-Arşiv
  document within a period are legal advice, not engineering; the module must not encode a
  window until an accountant confirms it. **UNVERIFIED** in this session.
- **OQ-10 — Demo datasets:** drafts only (recommended) or no accounting data at all?
- **OQ-11 — Retention period** for documents and audit rows: legal obligation, not decided here.
  **UNVERIFIED** in this session; do not hard-code a number.
- **OQ-12 — Trigger-based immutability:** accept the three-layer enforcement of §3.2, or accept
  DOM-005-style application-only immutability and document it honestly?

---

## Sources

### Repository (read-only; no file changed except this one)

- `AGENTS.md` §2–§9, §13, §15.
- `DECISIONS.md`: DOM-001 `:337–357`; ARC-001 `:379–411`; ARC-002 `:433–453`; ARC-003 `:495–532`;
  DOM-004 `:534–574`; DOM-005 `:576–607`; DOM-006 `:609–653`; SALE-001 `:1966–1989`;
  MOD-001 `:1991–2071`; SALE-002 `:2104–2182`; SALE-QTY-001 `:2073–2101`;
  CRM-S4A-001 `:2186–2200`; U3-A `:2930–2950`; SCH-001 `:3671–3733`; MOD-002 `:3735–3788`.
- `SERVORA_MED_SCHEMA_DRAFT.md`: §3.6 customers `:223–250`; §4–§5 `:467–508`; §8 migration groups.
- `SERVORA_MED_API_DRAFT.md`: §2 idempotency `:145–164`; §3 concurrency `:166–186`;
  SALE pair identity `:896–908`; lock/atomicity `:934–944`.
- Migrations: `server/src/db/migrations/002_delivery_tracer.sql:4–25, 31–50, 51–90, 145, 170–216`;
  `server/src/db/migrations/003_people.sql:32–56`; `server/src/db/migrations/004_crm_contacts.sql:1–15, 54–72`;
  `server/src/db/migrations/005_product_catalog.sql:9–10`; `server/src/db/migrations/017_calendar.sql:98–114`; `server/src/db/migrations/024_job_card_notes_invoice_number.sql:1–4`;
  `server/src/db/migrations/034_demo_data_foundation.sql:41–102`; `server/src/db/migrations/049_job_card_lifecycle_intents.sql:1–71`;
  `server/src/db/migrations/057_sale_from_visit.sql:1–121`; `058_sale_integer_quantity.sql`;
  `server/src/db/migrations/065_job_card_assignment_offers.sql:194–197`;
  `server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:1–243`;
  `server/src/db/migrations/074_installation_operator_and_module_state.sql:1–130`.
- `server/src/db/critical-action.ts:42–53, 142–221`.
- `server/src/modules/job-cards/critical-action-request-hash.ts:331–338`.
- `server/src/modules/job-cards/notes-service.ts:16–22, 40–62`.
- `server/src/modules/job-cards/policy.ts:21–23, 37–43`.
- `server/src/modules/job-cards/service.ts:1623–1660` (ADMIN invalidation).
- `server/src/modules/job-cards/sale-service.ts:64, 148–165, 179, 274`.
- `server/src/modules/job-cards/sale-reader.ts:33–37`.
- `server/src/modules/job-cards/repository.ts:2151, 2433, 5188–5208`.
- `server/src/modules/crm/service.ts:64–74, 399–409, 412–428, 529`.
- `server/src/modules/crm/repository.ts:59, 178–193`.
- `server/src/modules/crm/types.ts:189–193`.
- `server/src/modules/crm/duplicate-evidence.ts:60`.
- `server/src/modules/products/service.ts:55–61, 146–150, 215–249`.
- `server/src/modules/products/types.ts:12, 43`.
- `server/src/modules/reports/ports.ts:33–39`; `server/src/modules/people/service.ts:143`.
- `server/src/modules/people/offboarding.ts:1055–1067`.
- `server/src/modules/installation-modules/registry.ts:7–26`; `server/src/modules/installation-modules/state.ts:42–63, 82–101`;
  `server/src/modules/installation-modules/takeover.ts:20–64`.
- `server/src/modules/operator/service.ts:36–40, 123–125, 135–141`; `server/src/modules/operator/restore-reset.ts:13–56`.
- `server/src/modules/overview/service.ts:87–101`.
- `server/src/modules/capabilities/service.ts:7–13, 24–29`.
- `server/src/modules/demo-data/repository.ts:90–96, 141–147, 181–186, 695–719`.
- `docs/features/operator-module-pilot.md:102–126, 128–150, 152–161, 180–200, 287–290`.
- `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:156–169, 189–207`.
- `docs/backlog/2026-11-25-core-modules-architecture-research.md:183–218, 220–237`.
- `docs/architecture/decision-reconciliation-report.md:85–104`.
- `docs/operations/backup-restore.md:17–24`.

### Web (all accessed 2026-11-26)

| Source | Used for | Note |
| --- | --- | --- |
| <https://mevzuat.gov.tr/mevzuatmetin/1.4.213.pdf> (VUK 213, consolidated text) | m.229–231: invoice definition, mandatory content (date, series+sequence, buyer name/title/address/tax office), sequential numbering, 7-day issuance | primary official |
| <https://gib.gov.tr/mevzuat/kanun/434/madde/7131> | same m.231 text from GİB | primary official |
| <https://gib.gov.tr/mevzuat/kanun/434/ozelge/25872> (özelge 07.01.2015) | a skipped e-Fatura number may be recorded with a cancellation entry | primary official |
| <https://gib.gov.tr/mevzuat/kanun/434/ozelge/26228> (özelge 26.08.2011) | skipped numbers are a document-order irregularity; recording/justification required | primary official |
| <https://mevzuat.gov.tr/File/GeneratePdf?mevzuatNo=33905&mevzuatTertip=5&mevzuatTur=Teblig> (VUK GT 509) | §IV.2.4.3 e-Arşiv obligation; 3,000 TL threshold for 2025, amount-independent from 1/1/2026 for general taxpayers; 589 no. tebliğ extension for simple-basis taxpayers | **VOLATILE** — verify the current consolidated text before build |
| <https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/UBL-TR_Kod_Listeleri-V_1_27.pdf> (v1.27, Nov 2021) | §1.4 `InvoiceTypeCode`: `SATIS`, `IADE` (issued by the buyer for a return), `TEVKIFAT`, `TEVKIFATIADE`, `ISTISNA`, `OZELMATRAH`, `IHRACKAYITLI` | primary official; later versions exist (v1.42 per 2026 circulars) |
| <https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/Karekod_veya_Barkod_Standardi_Kilavuzu_V.1.0.pdf> (17.02.2023) | e-Fatura/e-Arşiv "Belge Numarası" = 3-char unit code + 4-digit year + 13-digit sequence | primary official; **VOLATILE** format |
| <https://www.kvkk.gov.tr/Icerik/7798/Turkiye-Cumhuriyeti-Kimlik-Numaralarinin-Islenmesi-Hakkinda-Rehber> (published 16.01.2024) | TCKN is personal data; minimise processing | primary official |
| <https://www.kvkk.gov.tr/SharedFolderServer/CMSFiles/a9eb73e7-bf35-46d7-84e7-58a4618128cc.pdf> | personal data includes "kimlik, vergi, sigorta numarası" when it identifies a person | primary official |
| <https://www.postgresql.org/docs/17/functions-sequence.html> | sequences cannot produce gapless series; `nextval` not reclaimed on abort | primary official |
| <https://www.postgresql.org/docs/17/datatype-numeric.html> | `numeric` is exact and recommended for monetary amounts; ties round away from zero | primary official |
| <https://www.pwc.com.tr/tr/hizmetlerimiz/vergi/dolayli-vergi/bultenler/e-donusum-bultenleri/2025/ubl-tr-kod-listeleri-kilavuzu-ve-e-fatura-paketindeki-guncellemesi-hakkinda.html> (14.02.2025) | `IADE`/`TEVKIFATIADE` invoices must carry at least one `BillingReference/InvoiceDocumentReference` | **secondary source** — confirm against the current GİB technical guide before implementation |

**Marked unverified in this document:** the exact legal windows for cancelling an e-Fatura/e-Arşiv
document (OQ-9); the statutory retention period (OQ-11); whether a seller-side correction invoice
for a price difference must be typed `IADE` or another code (depends on the integrator and the
accountant); and whether the local production environment currently has `ACCOUNTING_ENABLED` set
anywhere (no such key exists in the repo today — the registry has exactly one entry,
`server/src/modules/installation-modules/registry.ts:17–24`).
