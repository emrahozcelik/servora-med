# Accounting ("Muhasebe") module — owner decision brief (MOD-001 A0)

- **Date:** 2026-11-26
- **Status:** Decision input. **Not** a decision and **not** an implementation
  authorization. `AGENTS.md:387-404` (§13) still forbids "Add full accounting module"
  (`:399`) and "Add e-invoice/e-archive integration" (`:400`) until the owner approves
  explicitly.
- **Base:** `89bf6b1` (merge of PR #511, operator/module pilot). Migration head `074`.
- **Synthesis of:** `01-codebase-touchpoints.md`, `02-scope-options.md`,
  `03-turkish-e-document-landscape.md`, `04-external-accounting-integration.md`,
  `05-ownership-and-data-model.md` (this folder).
- **Evidence convention.** Repo claims carry `path:line`. Web claims carry a URL and the
  access date (2026-11-26) plus the publication/effective date where visible. Facts that
  move are **VOLATILE**; facts not confirmed against an official source are **UNVERIFIED**.
  `01`–`05` abbreviate the five notes listed above, cited by section.
- **Reading time:** the decisions are under "Decisions the owner must make"; if you read
  nothing else, read D1, D5, D6 and "Smallest safe first slice".

---

## Summary

- **Servora cannot price, invoice or collect today, by design.** Delivery stores purpose +
  quantity only (`DECISIONS.md:349-356`), the catalog price is informational
  (`:549-552`), reports exclude revenue (`:685-686`), and SALE carries no invoice, price,
  discount or VAT (`:2051-2059`).
- **The only structured invoice trace in production is a 100-character free-text field**:
  `job_card_notes.invoice_number`, accepted only on `SALES_MEETING` and `PRODUCT_DELIVERY`
  notes (`server/src/modules/job-cards/notes-service.ts:22,56-61`), never on `SALE`
  (`docs/features/visit-to-sale/visit-to-sale-design.md:125`), read by no report.
  MOD-001 records it as domain debt whose resolution "belongs to Accounting A0"
  (`DECISIONS.md:2065-2066`).
- **Recommendation: approve Cut A only** — an invoice-reference ledger inside an
  `ACCOUNTING` module that is **off by default**. No price, VAT, lines, balances,
  payments, PDF, numbering, connector or document issuance. ≈2–3 slices.
- **e-Fatura/e-Arşiv/e-İrsaliye issuance stays out of every option.** From 1 January 2026
  a balance-sheet taxpayer has no amount threshold for e-Arşiv (VUK 573; simple/ledger
  basis deferred to 1.1.2027 by VUK 589, RG 31.12.2025) — **VOLATILE**. A Servora PDF
  titled "Fatura" would not be a valid invoice.
- **Medical supply is an e-Fatura sector head since VUK 526 (RG 9.2.2021, effective
  1.7.2021), independent of the 3M TL turnover test — but the exact bent letter is
  UNVERIFIED** because VUK 550 (RG 7.10.2023) reorganised §IV.1.4(a). Cite the obligation,
  never the bent number.
- **GİB has a dedicated medical invoice scenario** (`ILAC_TIBBICIHAZ`, v1.2 June 2025)
  requiring UNO/lot/serial/production date per device line. This is the strongest single
  argument against Servora ever issuing: the identifiers live in ÜTS and only partially in
  the catalog.
- **Core must never depend on the module.** Accounting links one-way into Core, and a
  core command must not change behaviour when Accounting is off — the SCH-001 lesson
  (`DECISIONS.md:3671-3704`).
- **Module-off is `404`, unreadable state is `503`.** The accepted pilot contract
  distinguishes them (`server/src/modules/overview/service.ts:88-101`,
  `docs/features/operator-module-pilot.md:152-161`); the task phrasing "off → 503" is
  imprecise and must not be implemented as written (see C1).
- **SALE cancel/invalidate after a reference exists: flag, do not block** (D6). Blocking
  would make Core ask Accounting, which fails when the module is off.
- **Ten decisions (D1–D10).** Five gate Cut A (D1, D5, D6, D7, D9); the other five can be
  settled now but only bind later cuts — settling them now is cheaper than reopening them
  under delivery pressure.

---

## What "MOD-001 A0" is

`docs/architecture/decision-reconciliation-report.md:83` introduces the list as:

> "## 5. Gelecek backlog başlıkları (W0 / A0 — discovery, implementasyon yetkisi yok)"

The Accounting list itself, `docs/architecture/decision-reconciliation-report.md:95-104`:

```
**Accounting A0**

- Ticari belge ve kaynak satış ilişkisi
- Fiyat ve KDV veri sahipliği
- Cari hesap/tahsilat sınırı
- `invoiceNumber` domain debt (JobCard not alanındaki fatura referansının
  ticari belge katmanına taşınması)
- Dış muhasebe ve e-belge entegrasyon yaklaşımı
- İptal/iade/düzeltme davranışı
- Yetki, KVKK ve audit
```

(Vocabulary: commercial document ↔ source sale; price and VAT ownership; current
account/collection boundary; the `invoiceNumber` debt; external accounting and
e-document integration approach; cancel/return/correction behaviour; authority, KVKK
and audit.)

**It is a discovery list, not a decision and not an authorization.**

- The heading says so in the source: "discovery, implementasyon yetkisi yok"
  (`docs/architecture/decision-reconciliation-report.md:83`).
- MOD-001's consequences repeat it: "W0 (Warehouse) and A0 (Accounting) discovery titles
  are defined in [the reconciliation report]; they carry no implementation authorization"
  (`DECISIONS.md:2069-2071`).
- The list has no sequence, no acceptance criteria and no schema. It tells us *what to
  investigate*, not what to build. The next section turns each title into an owner decision.

**The `invoiceNumber` debt points here.** MOD-001 Consequences: "`invoiceNumber` on JobCard
notes stays recorded domain debt; its resolution belongs to Accounting A0"
(`DECISIONS.md:2065-2066`). The reconciliation report's own row says the same and records
it as a temporary debt that belongs to the commercial-document layer
(`docs/architecture/decision-reconciliation-report.md:49`). Cut A is the smallest thing
that resolves it for new records.

---

## Decisions the owner must make

Each decision follows the same shape: question → options → recommendation and why →
what it unblocks → which accepted record it would amend.

### D1 — What exactly does the §13 approval cover?

**Question.** `AGENTS.md` §13 lists "Add full accounting module" (`:399`) and
"Add e-invoice/e-archive integration" (`:400`) as forbidden without explicit owner
approval. What is being approved?

**Options.**

1. **None.** Accounting stays discovery-only; `invoiceNumber` remains free text. Zero
   risk, but the recorded debt stays open and the business keeps a shadow process in
   spreadsheets.
2. **Cut A only** — an invoice-*reference* ledger in an `ACCOUNTING` module that is off by
   default. No price, VAT, lines, balances, payments, PDF, numbering, connector or
   issuance. ≈2–3 slices (`02` §3.1).
3. **A + B** — Cut A plus priced quote/order documents with per-line VAT and internal
   numbering (`02` §3.2, ≈4–6 slices).
4. **A + B + C** — plus customer open account, receivables, collections, ageing
   (`02` §3.3, ≈3–4 slices on top of A+B).

**Recommended: option 2 (Cut A only).** It is the only cut that resolves a recorded debt
(`DECISIONS.md:2065-2066`) without a price/VAT/numbering/legal-document decision, and it
is reversible: switch the module off and the data stays inert. Cut B without a price
decision produces "a commercial record whose authority is undefined" (`02` §10). Cut C
without an opening-balance decision produces a balance finance will not trust (`02` §7).

**Under every option, e-Fatura/e-Arşiv/e-İrsaliye issuance stays out.** The approval must
say so in words, not imply it: the owner is authorizing a recorder of externally issued
documents, never an issuer.

**Unblocks.** The first slice, migration 075, the `ACCOUNTING` registry key.

**Amends.** Nothing. `DOM-001/004/006`, `SALE-001/002`, `MOD-001/002` stay as accepted;
MOD-001 §3 already describes the layer (`DECISIONS.md:2032-2035`). Record the approval as a
**new** `ACC-A` entry in `DECISIONS.md` (date, status Accepted, scope, explicit
non-goals) before any code — that is the established pattern (MOD-002 was accepted in chat
and then recorded, `DECISIONS.md:3735-3744`).

---

### D2 — Who is the financial authority, per deployment?

**Question.** For each installation (and, for Mode 2/3, each customer), which system is
authoritative for price, invoice, balance and stock? `04` §5 defines four cumulative modes.

**Options.**

1. **Mode 1 only** — the external ERP/integrator issues; Servora stores a reference and
   nothing else. No credentials, no network path, no outbox.
2. **Mode 1 + Mode 2a** — Servora pushes unpriced orders (customer + product + quantity);
   the ERP applies price, VAT and currency and returns the priced document; Servora may
   display returned amounts read-only, marked `source=ERP`.
3. **Mode 2b or Mode 3** — Servora owns price/VAT snapshots (2b) or holds a light current
   account and collections for customers with no ERP (3).

**Recommended: approve Mode 1 now; name Mode 2a as the only future push mode; leave 2b and
3 unapproved.** Authority must be declared per customer, not per vendor brand — a customer
can invoice in Logo while the accountant keeps the ledger in Mikro (`04` §5.1).
Mode 2b contradicts MOD-001 §5's "no price, discount, VAT" on SALE and DOM-004's "no
financial meaning"; Mode 3 needs the opening-balance/import decision and `ACC-C`.

**Unblocks.** D8 (connector choice), the `source` / `external_system` columns, any future
outbox. Nothing in Cut A depends on it.

**Amends.** Mode 2b would amend `DECISIONS.md:2051-2059` (MOD-001 §5) and require a
DOM-004 re-read; Modes 1 and 2a amend nothing.

---

### D3 — Where do price and VAT live, and does `referencePrice` stay informational?

**Question.** The first priced document (Cut B) needs an authoritative price. What is it?

**Options.**

1. **Promote `products.default_price` / `referencePrice` to the price master.**
   *Rejected.* It has "no currency or financial meaning" and is never copied into delivery
   or sale items (`DECISIONS.md:549-552`, `server/src/modules/job-cards/sale-repository.ts:12-15`);
   promoting it would silently reinterpret existing data and require a DOM-004 amendment,
   currency, price history and governance (`02` §5 option 4).
2. **Accounting-owned price per document line**, typed by the user, with a read-only
   "last price used for this customer/product" suggestion. No master list to govern.
3. **ERP is the price authority**; Servora stores returned amounts read-only, never
   editable price fields (this is Mode 2a).

**Recommended: 2 for the first priced document, 3 if the pilot's ERP can price; never 1.**
`referencePrice` stays informational and DOM-004 is **not** amended. Option 2 is the only
one that ships without a price-master governance project (`02` §5 recommendation).
Whatever is chosen, money must be SQL `NUMERIC` end to end and serialized as strings —
never `Number(...)` as `server/src/modules/products/types.ts:43` does for the reference
price (`05` §2.2).

**Unblocks.** Cut B only. Cut A has no price at all: the invoice total, when recorded,
comes from the issuer.

**Amends.** None if `referencePrice` stays informational (the recommended path). Option 1
would amend DOM-004 (`DECISIONS.md:534-568`).

---

### D4 — Where do tax identity fields live?

**Observed state.** `customers` holds `name`, optional `tax_number` (normalised, unique per
organisation) and a free-text address (`server/src/db/migrations/002_delivery_tracer.sql:4-25`,
`server/src/db/migrations/004_crm_contacts.sql:5-15`). There is **no** `tax_office`, **no**
legal title distinct from `name`, **no** structured billing address, **no** VKN/TCKN type
discriminator and **no** check-digit validation anywhere (`01` §3.2, `05` §1.3).

**Options.**

1. **Widen `customers`** with `tax_office`, `legal_name`, `billing_address`.
2. **Put everything in Accounting**, including a second editable `tax_number`.
3. **Split by authority**: `tax_number` stays in `customers` untouched;
   `acct_billing_profiles` (1:1 by `customer_id`) holds `tax_office`, `legal_name`,
   `billing_address`, optional `invoice_email`; every document freezes a buyer snapshot.

**Recommended: 3.** One editable home per field, Core untouched, module-off is a no-op for
CRM, and the operational name ("Dr. A Kliniği") can legitimately differ from the invoice
title ("A Sağlık Ltd. Şti.") — one column cannot be both (`05` §1.3). Option 1 bumps
`customers.version` on billing edits and pollutes every core reader; option 2 creates two
authorities for one number while the CRM unique index and duplicate review keep matching
the other one (`DECISIONS.md:2195-2196` freezes that normalisation and unique index).

**Rules that make option 3 safe:** no second editable `tax_number` (a historical mismatch
lives only in the document snapshot); the profile is read-only when the module is off; a
document may only be *issued* with a non-empty buyer tax number (VUK 230/3), validated at
issue, not at profile save.

**Unblocks.** Cut B. Cut A needs only `customer_id` and never writes billing data.

**Amends.** None. `CRM-S4A-001`'s frozen tax normalisation, CHECK/unique and STAFF CRM
rights stay exactly as accepted (`DECISIONS.md:2195-2196`).

---

### D5 — What happens to the `invoiceNumber` note debt?

**Observed state.** `job_card_notes.invoice_number TEXT` with a ≤100-char CHECK
(`server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`), accepted only on
`SALES_MEETING` and `PRODUCT_DELIVERY` (`server/src/modules/job-cards/notes-service.ts:22,56-61`,
UI gate `web/src/jobs/JobNotes.tsx:71`), part of the note's request hash, never on `SALE`,
read by no report; notes are append-only by contract (`DECISIONS.md:576-601`).

**Options.**

1. **Leave as legacy forever.** Two places to look up a number, forever; the note and the
   reference can disagree.
2. **One-time copy into references.** One searchable place; needs an approved data
   migration and a rule for duplicates; must not rewrite notes.
3. **Hide + reject while the module is on; byte-identical while it is off; copy later only
   by a separate approved migration.**

**Recommended: 3.** New records land in the reference table, history is neither rewritten
nor deleted, and a module-off installation behaves exactly as today — a module may add,
never remove, a core capability. The copy migration (option 2) stays available but is a
separate, explicitly approved step, because it touches historical rows.

**Mechanics if approved.** API returns a coded `400 ACCT_INVOICE_REFERENCE_REQUIRED`
pointing at the reference form; the note UI hides the field; the note request hash keeps
including `invoiceNumber` so completed receipts still replay byte-identically (`05` §6).

**Amends.** None. **Resolves** the debt for new records; the column remains.
**Unblocks.** Cut A's contract (acceptance test 13).

---

### D6 — What happens to a SALE correction, cancel or invalidate after a linked document exists?

**Question.** A SALE is manager-approved, an invoice reference is recorded against it, then
the sale is corrected, cancelled or ADMIN-invalidated. What must change?

**Options.**

1. **Block** the core command while a live reference exists.
2. **Flag on read**: the core command succeeds unchanged; a reconciliation list shows the
   divergence; documents keep their snapshots.
3. **Core-owned rule**: invalidating a `COMPLETED` sale requires an extra reason code
   (`DOCUMENT_ISSUED_EXTERNALLY`), independent of whether the module is on.

**Recommended: 2 now; 3 only if the owner wants a hard stop, and then as a core decision.**
Blocking from Accounting would make a core command depend on a module — it fails when the
module is off, and the same edit would be legal in one install and illegal in another. That
is the SCH-001 defect pattern (`DECISIONS.md:3671-3704`); module-off independence is an
explicit requirement (`docs/backlog/2026-11-25-core-modules-architecture-research.md:204-205`).

**Concretely.** The reference stores `sale_version_at_record` and its own snapshot; a
derived reconciliation list shows `SALE_CHANGED_AFTER_REFERENCE` /
`SALE_INVALIDATED_AFTER_REFERENCE`. Nothing recalculates, nothing cascades, no event bus
(MOD-001 §4, `DECISIONS.md:2041-2050`). Residual risk: an ADMIN can invalidate a sale whose
invoice is already with the customer; the list makes it visible but does not prevent it.
That residual is exactly what option 3 would close, and it must be decided in Core.

**Unblocks.** Cut A's acceptance behaviour (test 9). **Amends.** None — SALE-001/SALE-002
stay exactly as accepted.

---

### D7 — May amounts ever appear in operational reports?

**Question.** Cut A optionally records the issuer's gross/VAT total. May that money, or any
future accounting money, reach `/reports`, `/reports/deliveries`, `/overview` or the weekly
report?

**Options.**

1. **No.** DOM-006 stays money-free; amounts live only in Accounting screens and
   Accounting-owned reports.
2. **Only in a new Accounting report surface** that reuses the report infrastructure — a new
   reporting decision, not a silent extension.
3. **Amend DOM-006** to allow revenue in operational reports.

**Recommended: 1 for Cut A; 2 is acceptable later for receivable ageing as its own accepted
record; 3 rejected.** "No revenue" is currently enforced by construction, not by a guard:
every report DTO is counts/quantities (`server/src/modules/reports/types.ts:19`), the
delivery grouping SQL selects no money (`server/src/modules/reports/repository.ts:1279-1320`),
and `/overview` consumes the same read model (`01` §6.1). One money field in a report query
would silently change DOM-006 for every consumer, including the dashboard.

**Consequence for Cut A:** the reference's amount is shown on the reference detail only, to
MANAGER/ADMIN. If the owner wants zero amount surfaces at all, Cut A can ship with the
amount optional and not displayed — the reference still closes the sale.

**Amends.** None today. Option 2 creates a new reporting decision; option 3 would amend
DOM-006 (`DECISIONS.md:609-686`).

---

### D8 — Which external integration first, and when?

**Question.** Which ERP/integrator does Servora integrate with, and in which slice?

**Options.**

1. **None in the approved slice**; decide when a named pilot's system is known.
2. **Paraşüt first** — cloud, OAuth2 + PKCE, OpenAPI 3.0 v4.1.0 with 152 paths,
   `sales_invoices/find_by_external_reference_key`, webhook `event_id` documented as stable.
3. **Mikro first** — full SME document coverage (cari, stok, sipariş, fatura,
   tahsilat/tediye, e-belge status), API-key licensing, but a local Windows service with no
   documented idempotency key.

**Recommended: 1.** `04` §7 ranks Paraşüt first **on documented capability**, Mikro second;
`04` §7.5 states plainly that no measured market-share data was collected, and that "the
owner should name the first 1–3 pilot customers and their actual systems; that single fact
outweighs everything". Cut A needs no connector: manual reference entry is the designed
first mode (`04` §5, Mode 1).

**When.** Only after (a) the pilot's ERP brand *and edition* is named — Logo Go vs Tiger 3
changes the answer, and whether Logo Go 3 exposes REST is **UNVERIFIED** (`04` §3.2);
(b) Mode 2a is chosen; (c) Cut A has produced real references for at least a quarter.
Credentials stay env-only at first (MOD-002 §4, `DECISIONS.md:3770-3773`); a narrow
module-owned outbox only when a connector actually starts (MOD-001 §4).

**Amends.** None. **Unblocks.** Nothing in Cut A; the whole of any future connector slice.

---

### D9 — KVKK for TCKN and customer financial data

**Question.** A sole proprietor's VKN *is* their TCKN; KVKK guidance treats identity, tax
and insurance numbers as personal data when they identify a real person (KVKK guide on
TCKN processing, published 16.01.2024, accessed 2026-11-26). Who may see a full tax number
and a customer balance?

**Options.**

1. **Keep today's behaviour** and extend it to references: plain text to anyone who can open
   the customer (`web/src/CustomerDetail.tsx:53`).
2. **Mask in lists, exports and search**; full value only on the reference/document detail
   and its print/export; never log a tax number; MANAGER/ADMIN only; STAFF cannot search by
   tax number.
3. **Add a new role/permission** for financial data.

**Recommended: 2.** Option 1 widens an existing exposure; option 3 introduces a fourth
role, which breaks the `role !== 'STAFF'` checks that the operator design already flagged
as a hazard (`docs/backlog/2026-11-25-core-modules-architecture-research.md:192-199`).
Lawful basis for storing and printing the buyer tax number on a commercial document is the
legal obligation itself (VUK 230/3); the rule is "store and print, never repurpose".

**Scope note.** Today's plain-text rendering of `customers.tax_number` in CRM is a
pre-existing Core exposure. Accounting must not widen it; masking it in CRM is a separate
Core decision (open question).

**Amends.** None. **Unblocks.** Cut A's permission model and any later document surface.

---

### D10 — Relation to the Depo/Stok (Warehouse) module

**Question.** e-İrsaliye, ÜTS notifications and `ILAC_TIBBICIHAZ` lot/serial requirements all
sit near invoicing. Who owns them?

**Options.**

1. **Accounting owns** lot/serial, ÜTS and dispatch-note data.
2. **Warehouse owns** physical stock, lot/serial/expiry, ÜTS and dispatch-note needs;
   Accounting only references externally issued documents.
3. **No relation at all.**

**Recommended: 2.** The evidence is one-directional:

- e-İrsaliye is a VUK 230/5 dispatch document with **no medical-sector rule**; the trigger
  is e-Fatura registration plus a 10M TL turnover test (`03` §3.1). A Servora
  `PRODUCT_DELIVERY` is an operational hand-over record, not a dispatch note (`03` §3.2).
- ÜTS is a separate TİTCK system whose "belge numarası" is free text that ÜTS does not
  validate against the invoice (`03` §8).
- The `ILAC_TIBBICIHAZ` e-Fatura scenario requires UNO/LNO/SNO/URT per device line
  (`03` §1.5) — but only an **issuer** needs it, and Servora does not issue.
- Delivery items already carry `lot_no`, `serial_no`, `expiry_date`
  (`server/src/db/migrations/002_delivery_tracer.sql:150-152`); the catalog has no
  GTIN/UNO (`server/src/modules/products/types.ts:7-11`). Those gaps are W0 work
  (`docs/backlog/2026-11-25-core-modules-architecture-research.md:230`), and the separate
  Depo/Stok research session owns ÜTS.

**Consequence.** No cut needs the Warehouse module (`02` §6). What would force it in:
partial deliveries/invoicing, stock reservation at order confirmation, lot/serial printed on
an invoice, consignment stock, shipped-quantity invoicing. Today SALE-002 allows at most one
delivery per sale and no partial deliveries (`DECISIONS.md:2154-2155`).

**Amends.** None. **Unblocks.** Removes a false dependency for Cut B.

---

### Conflicts between the notes, and how I resolved them

Where the five notes disagree, this is the call and the evidence behind it.

**C1 — "Module off" status code.** The task brief says "module off → 503". The accepted
pilot distinguishes the two cases: a deliberate disable keeps the existing `404`
("Sayfa bulunamadı."), a missing row or read failure is `503`, with no env fallback
(`server/src/modules/overview/service.ts:88-101`,
`docs/features/operator-module-pilot.md:152-161`, MOD-002 §5 `DECISIONS.md:3774-3775`).
`05` §7 flags the same discrepancy. **Resolution: follow the accepted contract — `404` when
disabled, `503` when unreadable.** Inventing a third behaviour would break the pilot's
tested invariant.

**C2 — Does the legacy `invoiceNumber` get backfilled?** `02` §3.1 says the historical note
column "stays and is not backfilled". `05` §6 recommends hiding now, copying later by a
separately approved migration. **Resolution: both are right at different times.** Slice 1
does not copy anything (they agree); a later copy is permissible only as its own approved
migration, and even then notes are copied, never updated or deleted (`DECISIONS.md:576-601`).

**C3 — Does a Cut A reference link to a delivery?** `02` §3.1 carries both
`sale_job_card_id` and `delivery_job_card_id`; `05` §2.3 carries only `sale_job_card_id`.
**Resolution: `02` is right.** Today's invoice capture happens on `PRODUCT_DELIVERY` notes —
`invoiceNumber` is accepted on `SALES_MEETING` and `PRODUCT_DELIVERY` and deliberately **not**
on `SALE` (`server/src/modules/job-cards/notes-service.ts:22,56-61`;
`docs/features/visit-to-sale/visit-to-sale-design.md:125`). A Cut A that can only attach to a
SALE would replace nothing that exists. Allow an optional link to either card, at most one.

**C4 — Is the invoice total mandatory?** `02` §3.1 makes `total_gross` nullable and calls a
missing total a data-quality flag, adding that Cut C needs one. `05` §2.3 makes
`total_gross` `NOT NULL`. **Resolution: `02` for Cut A.** A required amount either blocks
capture (the manager often has only the number) or invites a guessed figure, and a guessed
figure is worse than a flagged blank. Make it required before Cut C computes a balance.

**C5 — Shape of the duplicate-invoice-number constraint.** `02` §3.1 uses
`(organization_id, issuer_kind, coalesce(issuer_label,''), upper(trim(invoice_number)))`;
`05` §2.3 uses `(organization_id, direction, invoice_number)`. **Resolution: for a
sales-side-only Cut A, the key is `(organization_id, invoice_number)`.** A single
organisation is a single seller (ARC-002 `DECISIONS.md:433-453`), and VUK 231/1 requires
sequential numbering within a series, so the same seller cannot legitimately issue the same
number twice; `02`'s issuer-qualified key would silently permit exactly that. `05`'s
`direction` column implies purchase invoices, which `02` §4 excludes (supplier payables are
out). If purchase-side references are ever admitted, the key must gain `direction` and an
issuer qualifier. Naming: use `acct_*` (`05`) rather than `accounting_*` (`02`) — shorter,
and `05`'s schema is the more developed one.

**C6 — How is a wrong reference corrected?** `04` §5 (Mode 1) says "editing a reference
after the fact is an audited correction, never a silent overwrite"; `05` §2.3 says
"corrections use `superseded_by_id`, never an update of `invoice_number`". **Resolution:
split by field.** `invoice_number`, `invoice_date` and amounts are immutable after record —
a mistake is corrected by `VOID` + a new record. `issuer_label`, `due_date`,
`external_document_id` and `document_url` may be corrected with `expectedVersion` and an
event row. That keeps the audit trail single and avoids a supersede chain for a typo in a
label.

**C7 — Manual price vs ERP price.** `02` §5 recommends manual per-document price (option 2)
for Cut B, with an ERP feed (option 3) preferred only if the customer already has a reliable
price list. `04` §5 recommends Mode 2a — the ERP prices and Servora displays read-only
returned amounts. **Resolution: they are the same policy at different maturity.** Manual
per-document pricing is the correct first priced cut; Mode 2a supersedes it as soon as a
connector exists. Both reject the catalog price as master. Not a blocker for Cut A.

**C8 — The medical e-Fatura "bent 6".** Both `02` (open question 3) and `03` (§1.2,
obligation table) cite "509 IV.1.4(a)(6)" as the medical-supply head. That lettering is
**UNVERIFIED**: VUK 550 (published 7.10.2023, RG 32332) reorganised §IV.1.4(a) and inserted
a new bent, so the letter that carried the medical head in 2021 is not the letter in the
current consolidated text. The *obligation* is solid — it entered via VUK 526 (RG 9.2.2021,
transition 1.7.2021) and does not depend on the 3M TL turnover test. **Resolution: cite the
obligation and VUK 526/VUK 509 §IV.1.4(a), never the bent number.** The accountant confirms
the applicability per installation; it is a customer attribute Servora does not model.

**C9 — Should a Cut A reference carry the integrator's document status and an XML hash?**
`03` §9 recommends storing integrator status (SENT/ACCEPTED/REJECTED/RETURNED/CANCELLED) and
a hash of the received UBL XML. `02` §3.1 and `05` §2.3 keep Cut A to number/date/issuer/
total/links. **Resolution: `02`/`05` for v1.** Without a connector the status cannot be kept
current, and a stale "ACCEPTED" is worse than no status. Store `external_document_id` and an
optional `document_url`; add status mirroring with the first connector, when there is a
source of truth to mirror.

---

## Smallest safe first slice

**Cut A — invoice reference, behind the `ACCOUNTING` module key, off by default.**

### Scope in

- One new module key `ACCOUNTING` (Turkish label "Muhasebe") in the MOD-002 registry, with
  one new capability `accounting`, default `false`.
- One ledger of invoice **references** issued outside Servora: number, date, issuer kind,
  currency, optional gross/VAT, optional due date, optional external id/URL, optional link
  to one SALE or one PRODUCT_DELIVERY card.
- Append-only recording, append-only void, a narrow audited correction (C6).
- A derived worklist: manager-approved `COMPLETED` SALE / `PRODUCT_DELIVERY` cards with no
  live reference after 7 calendar days (constant in code, not a setting).
- Manager/admin web surface on the SALE detail and the delivery detail, plus a list screen.
- Tests, docs, migration 075.

### Scope out

No lines, no per-line VAT, no computed totals, no document numbering, no PDF, no
attachments, no payments, no balances, no ageing, no collections, no CSV import (that is
A2), no connector, no credentials, no outbox, no e-Fatura/e-Arşiv/e-İrsaliye, no change to
any Core table or Core DTO.

### Tables (PROPOSAL — no migration is written or numbered beyond 075)

`acct_invoice_references`

| Column | Type / rule |
| --- | --- |
| `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `organization_id` | `UUID NOT NULL REFERENCES organizations(id)` |
| `customer_id` | `UUID NOT NULL`; composite FK `(organization_id, customer_id) → customers` `ON DELETE RESTRICT` |
| `sale_job_card_id` | `UUID NULL`; composite FK → `job_cards` `RESTRICT`; must be `type='SALE'` |
| `delivery_job_card_id` | `UUID NULL`; composite FK → `job_cards` `RESTRICT`; must be `type='PRODUCT_DELIVERY'` |
| link shape | `CHECK (sale_job_card_id IS NULL OR delivery_job_card_id IS NULL)` (at most one) |
| `invoice_number` | `VARCHAR(64) NOT NULL CHECK (length(btrim(...)) > 0)` |
| `invoice_date` | `DATE NOT NULL` |
| `issuer_kind` | `TEXT NOT NULL CHECK IN ('LOGO','NETSIS','MIKRO','E_FATURA_INTEGRATOR','E_ARSIV_PORTAL','OTHER')` |
| `issuer_label` | `VARCHAR(120) NULL` (free label, not an authority) |
| `currency` | `CHAR(3) NOT NULL DEFAULT 'TRY' CHECK (currency ~ '^[A-Z]{3}$')` |
| `total_gross` | `NUMERIC(19,2) NULL CHECK (total_gross IS NULL OR total_gross >= 0)` |
| `total_vat` | `NUMERIC(19,2) NULL CHECK (total_vat IS NULL OR total_gross IS NULL OR (total_vat >= 0 AND total_vat <= total_gross))` |
| `due_date` | `DATE NULL CHECK (due_date IS NULL OR due_date >= invoice_date)` |
| `external_document_id` | `VARCHAR(120) NULL` (ETTN/UUID/ERP id) |
| `document_url` | `TEXT NULL CHECK (document_url IS NULL OR document_url ~ '^https://')` — a link, never an upload |
| `status` | `TEXT NOT NULL DEFAULT 'RECORDED' CHECK IN ('RECORDED','VOID')` |
| `void_reason_code`, `void_note`, `voided_at`, `voided_by` | all `NULL` unless `status='VOID'`; CHECK enforces the shape |
| `linked_job_card_version` | `INTEGER NULL` — the linked SALE/delivery card's `version` at record time (D6) |
| `recorded_by`, `recorded_at`, `version` | `recorded_by` composite FK → `users` `RESTRICT`; `version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)` |

Constraints: `UNIQUE (organization_id, id)`; `UNIQUE (organization_id, invoice_number)`
(C5); index `(organization_id, customer_id, invoice_date DESC, id DESC)`; index
`(organization_id, sale_job_card_id)` and `(organization_id, delivery_job_card_id)` where
not null. `total_net` is **not** stored — it is `total_gross - total_vat`, derived, so three
columns can never disagree (`05` §2.2). v1 is **TRY only**: `currency` exists from day one
(multi-currency later must not need a migration) but the service rejects any value other
than `TRY` as a validation error, so no CHECK has to be rewritten to widen it.

`acct_reference_events` (append-only; no update/delete surface)

`id`, `organization_id`, `reference_id` (composite FK `RESTRICT`), `actor_user_id NULL`,
`actor_kind IN ('USER','SYSTEM')`, `event_type IN
('REFERENCE_RECORDED','REFERENCE_CORRECTED','REFERENCE_VOIDED','REFERENCE_LEGACY_IMPORTED')`,
`old_value JSONB`, `new_value JSONB`, `metadata JSONB NOT NULL DEFAULT '{}'`, `occurred_at`.
Index `(organization_id, reference_id, occurred_at, id)`. Payloads carry field names and
changed values for non-sensitive fields only; the buyer tax number is never duplicated into
`old_value`/`new_value` (`AGENTS.md:160-172`).

*Why not `audit_events`*: its `subject_type`/`event_type` vocabularies are closed CHECKs and
its rows surface in CRM/People admin screens (`server/src/db/migrations/003_people.sql:32-51`;
`05` §4.1). *Why not `acct_documents`*: a Cut A reference has no lines, no internal number and
no immutability contract of ours (`05` §2.3).

### API (PROPOSAL)

| Method + path | Purpose |
| --- | --- |
| `POST /api/accounting/invoice-references` | record a reference (`clientActionId` required) |
| `PATCH /api/accounting/invoice-references/:id` | narrow correction of `issuer_label`/`due_date`/`external_document_id`/`document_url` with `expectedVersion` (C6) |
| `POST /api/accounting/invoice-references/:id/void` | void with `clientActionId`, `expectedVersion`, reason code + note |
| `GET /api/accounting/invoice-references` | paged list, filters: customer, status, issuer, date range |
| `GET /api/accounting/invoice-references/:id` | detail |
| `GET /api/accounting/sales/:jobCardId/invoice-status` | STAFF-safe summary: `{ invoiced: boolean, invoiceDate: string \| null }` |
| `GET /api/accounting/deliveries/:jobCardId/invoice-status` | same for a delivery |
| `GET /api/accounting/worklist` | approved cards without a live reference after 7 days |
| `PUT /api/operator/modules/ACCOUNTING` | **existing** operator endpoint; no new operator route |

No Core route or Core DTO changes. The web fetches the invoice status from Accounting only
when `capabilities.accounting` is true, so Core never calls Accounting (`05` §1.4).

### Permissions (PROPOSAL)

| Action | STAFF | MANAGER | ADMIN | Operator |
| --- | --- | --- | --- | --- |
| Record a reference | ✗ | ✓ | ✓ | ✗ |
| Correct mutable fields | ✗ | ✓ | ✓ | ✗ |
| Void (reason required) | ✗ | ✓ | ✓ | ✗ |
| List / detail with amounts | ✗ | ✓ | ✓ | ✗ |
| Own SALE/delivery invoice status + date (no number, no amount) | ✓ | ✓ | ✓ | ✗ |
| Worklist | ✗ | ✓ | ✓ | ✗ |
| Toggle the module | ✗ | ✗ | ✗ | ✓ `MODULE_MANAGEMENT` |

No new role, no "accountant" account, no shared login (`02` §3.1). Enforcement is
backend-only; UI hiding is navigation, never authorization (`DECISIONS.md:531`).

### Enable / disable behaviour

- **Default off.** Env takeover inserts the `ACCOUNTING` row from `ACCOUNTING_ENABLED`;
  unset or `false` → off, explicit `true` → on (`server/src/modules/installation-modules/takeover.ts:20-64`).
  The takeover insert **must** run for the new key — a missing row is a permanent `503`, not
  "off" (`01` §11.2).
- **Disabled → `404`** on every `/api/accounting/*` route; `capabilities.accounting=false`
  in `/api/auth/login` and `/api/auth/me`; navigation entry, routes and any tile hidden; an
  open page moves to `/jobs` on the next revalidation (`docs/features/operator-module-pilot.md:173-178`).
- **Unreadable / missing state → `503`**, capability false, error logged, **no env
  fallback** (`server/src/modules/overview/service.ts:88-101`).
- **Data untouched.** No cascade, no rewrite; re-enabling shows byte-identical data. No
  background jobs in this cut; nothing is replayed on re-enable.
- **Command-time re-read.** Record/correct/void re-read the module row inside the command
  transaction before writing, so a toggle that commits mid-request cannot create a
  reference after switch-off (`05` §7). One primary-key read, not a cache.
- **Operator UI.** One row ("Muhasebe") with state, last change, version-checked switch and
  a confirmation that states how many live references exist. No document content, no
  customer data (`04` §6.4).

### Migration impact

- **075 (additive only; 074 is not edited** — `AGENTS.md:174-186`):
  1. widen `installation_module_state_key_check` to `('OVERVIEW','ACCOUNTING')`
     (currently `CHECK (module_key IN ('OVERVIEW'))`,
     `server/src/db/migrations/074_installation_operator_and_module_state.sql:59`);
  2. widen `operator_audit_events_module_key_check` likewise (`:86-87`);
  3. create `acct_invoice_references` and `acct_reference_events` with their indexes and
     composite FKs.
- No backfill. Existing `job_card_notes.invoice_number` values are not read, copied or
  changed by 075.
- `HEALTH_SCHEMA_VERSION` moves to 075; deploy needs `allow_migrations`
  (`docs/features/operator-module-pilot.md:192-194`).
- Registry widening (`server/src/modules/installation-modules/registry.ts:8-14,26`) is
  compile-time: the literal `'OVERVIEW'` type forces every switch site, capability map and
  operator UI branch to be updated or the build fails.
- Restore: a pre-075 backup restores through the normal flow and the first start performs
  takeover (ACCOUNTING off unless env says true); a post-075 backup restores references and
  module state to the backup instant together — there is no module-level restore
  (`01` §10.1).
- Web wiring in one change: `AuthenticatedCapabilities`
  (`web/src/services/api.ts:19-25`), its strict parser (`:183-190`),
  `web/src/shell/route-access.ts:35-40`, `web/src/shell/navigation-model.ts:89-112`,
  `.env.example` and the ops env examples (`ops/ci/verify-env-examples.sh` flag list).

### Authorization mechanics

Before code: record **`ACC-A`** in `DECISIONS.md` — date, status Accepted, scope = Cut A as
written here, non-goals copied from "What stays forbidden", D1/D5/D6/D7/D9 answers embedded,
and one line stating that §13 approval was given explicitly. Without that record, §13 is
still in force and the slice is not authorized.

### Acceptance tests

1. **Module off.** Given `ACCOUNTING` disabled, when any `/api/accounting/*` route is called
   with a valid MANAGER session, then `404 NOT_FOUND`; login and `/me` report
   `capabilities.accounting=false`; no "Muhasebe" navigation entry; a direct `/accounting`
   URL lands on `/jobs`.
2. **Unreadable state.** Given the row is missing or the read throws, when any
   `/api/accounting/*` route is called, then `503` with a coded body, capability false, one
   error log, and `ACCOUNTING_ENABLED=true` in env does **not** re-enable it.
3. **STAFF permissions.** STAFF can read `{invoiced, invoiceDate}` for a SALE/delivery they
   can already read, and cannot list, record, correct or void (`403`). The summary for a card
   they cannot read is `404`, and contains no invoice number and no amount.
4. **MANAGER/ADMIN permissions.** Both can record, correct and void; the recorded actor is
   the authenticated user; a role outside the matrix gets `403`; UI hiding alone never
   authorizes.
5. **Organisation scoping.** Given a customer, SALE or delivery id from another
   organisation, when recording, then `404` (indistinguishable from nonexistent), zero rows,
   zero events; a hand-crafted cross-organisation row is rejected by the composite FK and
   mapped, not surfaced raw.
6. **Idempotent create.** Same `clientActionId` + identical payload → the original status and
   body replayed, exactly one row and one event. Same key + different payload →
   `409 CLIENT_ACTION_REUSED`. Two concurrent identical requests → one row; the other gets
   the replay or `409 ACTION_IN_PROGRESS` (`server/src/db/critical-action.ts:142-221`).
7. **Audit atomicity.** Forced failure of the event insert rolls back the reference row and
   the idempotency receipt together; after success exactly one `REFERENCE_RECORDED` event
   exists, written through the same client, with no post-commit path.
8. **Cross-organisation SALE reference.** Recording against a SALE of another organisation is
   rejected with `404` even when the customer id belongs to the caller, and no partial row
   survives.
9. **SALE lifecycle independence.** Given a live reference, a SALE correction, cancel or
   ADMIN invalidation succeeds exactly as today; the reference keeps its snapshot; the
   reconciliation list shows `SALE_CHANGED_AFTER_REFERENCE` or
   `SALE_INVALIDATED_AFTER_REFERENCE`. With the module disabled, the SALE command and its
   responses are unchanged.
10. **No money in operational reports.** `/reports`, `/reports/deliveries`, `/overview` and
    the weekly report contain no accounting field or amount; the reports module has no join
    or port into `acct_*`; the existing report contract tests are unchanged.
11. **Restore.** A pre-075 backup restores through the normal flow and the first start
    creates the ACCOUNTING row (off unless env true); a post-075 backup restores references
    and module state to the backup instant, revokes operator sessions and creates no
    duplicate `invoice_number`.
12. **Offboarding.** Offboarding a MANAGER who recorded references completes with no new
    blocker; `recorded_by` is retained and never rewritten; any active SALE owned by that
    person still requires an explicit transfer or cancel decision.
13. **Legacy notes untouched.** Module off: `invoiceNumber` is still accepted on
    `SALES_MEETING`/`PRODUCT_DELIVERY` and still rejected on `SALE`; existing notes render
    byte-identically; completed note receipts replay identically. Module on: a new non-null
    `invoiceNumber` returns `400 ACCT_INVOICE_REFERENCE_REQUIRED`, the field is hidden in
    the UI, and existing note text is unchanged.
14. **Delete protection and demo data.** A customer, product or user referenced by a
    reference cannot be hard-deleted; the response is the coded operation-history blocker
    (`server/src/modules/crm/service.ts:399-409`,
    `server/src/modules/products/service.ts:238-248`), not a raw `23503`. A demo purge either
    has registered accounting dependencies or fails closed with an explicit
    unexpected-ownership error — never silent leftovers
    (`server/src/modules/demo-data/plan.ts:24-43`).

---

## What stays forbidden

Under the recommended approval — and under A+B or A+B+C if the owner ever chooses them —
these remain outside the module and outside Core:

**Bookkeeping and statutory output**
- General ledger (defter-i kebir), trial balance (mizan), financial statements.
- Chart of accounts (tekdüzen hesap planı), journals (yevmiye), opening/closing entries.
- e-Defter and berat; any XBRL-GL output.
- Payroll (bordro), SGK bildirgeleri, wage withholding.
- Tax filing: KDV/KV declarations, BA-BS, e-Beyanname, stamp-tax computation.
- A posting engine or any generic double-entry mechanism.
- Full bank reconciliation, bank statement import, open banking.
- Fixed assets and depreciation.

**Document issuance**
- Issuing e-Fatura, e-Arşiv, e-İrsaliye or e-SMM from Servora, in any cut.
- Official invoice numbering or a legal invoice series.
- UBL-TR generation or submission, mali mühür/e-imza handling.
- GİB registered-user (mükellefiyet) lookup.
- Presenting any Servora output as an invoice or a dispatch note, including a PDF titled
  "Fatura" or "İrsaliye".

**Commercial scope not yet decided**
- Credit notes, debit notes, return invoices (needs `ACC-B`/`ACC-C` and an accountant's
  document-type decision).
- Cheque/senet portfolio, endorsement, protest, bounce.
- Dunning, legal collection, default interest, credit limits.
- Multi-currency, FX revaluation, FX gain/loss.
- Cost accounting, inventory valuation, COGS, margin, commission.
- Supplier payables and purchase invoices.
- Attachment upload or file storage (a URL reference only).
- E-signature of quotes/orders; email/WhatsApp sending; customer portal.
- Invoice OCR / PDF parsing.
- A product tax-classification engine (the user selects the rate; the taxpayer remains
  liable).

**Architecture**
- A new `ACCOUNTANT` role, or any fourth customer role.
- Money, invoice or payment fields on `job_cards`, `job_card_sale_items`,
  `job_card_delivery_items`, `products` or `customers`.
- Money in `/reports`, `/overview` or the weekly report.
- A cached customer balance column (balances are derived, never stored).
- A generic event bus, global outbox, integration queue or webhook framework.
- A per-organization credential store or a connector marketplace.
- Core reading Accounting to decide a core command.
- Accounting documents as JobCard types.

---

## Risks

1. **Shadow invoice register.** Cut A has no lines, no payment state and (by default) a
   possibly blank total, so finance could start reconciling against it. Mitigation: label it
   "Fatura referansı (bilgi amaçlı)", never "Fatura"; a worklist rather than a revenue
   report; an issuer-qualified key if scope ever widens.
2. **A blank total is a weak record.** Making the amount optional (C4) reduces friction but
   leaves references that cannot support receivables. Mitigation: show a "total missing"
   flag in the list and require a total before Cut C.
3. **Duplicate numbers across years or issuers.** A sales-only key is correct today; the day
   purchase-side references or a second issuer appear, the key must widen or the unique index
   will reject legitimate rows. Mitigation: document the assumption in `ACC-A`.
4. **The `503` trap after deploy.** If the takeover insert does not run for `ACCOUNTING`, the
   module answers `503` forever and no UI can explain it. Mitigation: an explicit deploy
   check plus acceptance test 2.
5. **Two authorities for the invoice number.** Hiding the note field (D5) without retiring the
   column leaves a legacy path; with the module off it is still writable. Mitigation: the
   note and the reference are never merged into one "invoice" screen; the reference detail
   states that it is not the legal document.
6. **Restore rewinds module state.** An operator who enabled Accounting after the backup will
   find it off after a restore; references return to the backup instant. Documented, expected
   (`docs/features/operator-module-pilot.md:188-189`), but it will generate a support call.
7. **KVKK.** A TCKN in a reference is personal data; amounts plus customer identity form a
   financial profile. Masking (D9) is a design control, not a legal opinion — the retention
   period is **UNVERIFIED** and belongs to the accountant.
8. **Scope creep.** Cut A is the only approved thing. Every "while we are here" addition
   (a total, a PDF, a CSV import, a status mirror) moves the slice toward Cut B without the
   price/VAT/numbering decisions that B requires.
9. **Legal reliance.** A reference is not proof that an invoice exists or that its total is
   right. The UI, the API documentation and the `ACC-A` record must say so.

---

## Open questions

1. **Which ERP/system does the first pilot actually run**, and which edition? Logo Go vs
   Tiger 3 changes whether a connector is even possible (`04` §7.5, §3.2). This is the single
   fact that most changes D8.
2. **Where is the invoice number captured today — deliveries or sales?** The code says
   `SALES_MEETING`/`PRODUCT_DELIVERY` notes only; confirm the real practice before finalising
   the link shape (C3).
3. **Is the invoice total typed at capture time, or later?** Decides whether a blank total is
   normal (C4) and how the worklist should behave.
4. **Who voids a wrong reference — MANAGER or ADMIN only?** This brief recommends
   MANAGER/ADMIN because a void is append-only and audited; ADMIN-only would mirror JobCard
   invalidation more strictly.
5. **Retention period for references** (10 years is the safe default per TTK 82; VUK 253
   gives 5). **UNVERIFIED** — do not hard-code a number before the accountant confirms.
6. **Should CRM mask `customers.tax_number` for STAFF?** A pre-existing Core exposure; a
   separate decision, not part of this module.
7. **Does the worklist window of 7 days match how the business works?** It is a constant, not
   a setting; changing it later is a code change, which is intentional (no settings bag).
8. **Is a CSV import from the ERP's open-invoice/aging export wanted in A2?** It is the
   cheapest "integration" and preferable to an API (`02` §3.1), but it is a separate slice.
9. **Which exact legal provision currently carries the medical-supply e-Fatura head?** The
   obligation is established (VUK 526); the bent letter is **UNVERIFIED** after VUK 550. The
   accountant should confirm the citation before any UI or documentation quotes it.
10. **Does the operator need per-document replay visibility** (queue depth is not enough for
    a failed invoice)? Only relevant once a connector exists.

---

## Sources

### This folder (read 2026-11-26)

- `01-codebase-touchpoints.md` — §1 SALE, §2 delivery, §3 customers, §5 `invoiceNumber`,
  §6 reports, §8 idempotency, §10 backup, §11 module registry, §13 forbidden-rule inventory.
- `02-scope-options.md` — §1 baseline, §2 capability table, §3.1/3.2/3.3 cuts, §4 exclusions,
  §5 where price lives, §6 Warehouse interaction, §10 cut comparison.
- `03-turkish-e-document-landscape.md` — §1 e-Fatura, §2 e-Arşiv, §3 e-İrsaliye, §4 e-Defter,
  §7 KDV, §8 ÜTS, §9 retention, §11 obligation table.
- `04-external-accounting-integration.md` — §3 vendor landscape, §5 deployment modes,
  §6 integration mechanics, §7 first targets and §7.5 evidence strength.
- `05-ownership-and-data-model.md` — §1 ownership matrix and tax-identity split, §2 data model,
  §3 numbering, §4 audit/idempotency, §5 SALE relationship, §6 note debt, §7 enable/disable,
  §8 restore, §9 offboarding, §10 permissions and KVKK.

### Repository (read-only; `89bf6b1`)

- `AGENTS.md` §5 (`:160-172`), §6 (`:174-186`), §7 (`:188-201`), §13 (`:387-404`,
  accounting `:399`, e-invoice `:400`).
- `DECISIONS.md`: DOM-001 `:337-357`; DOM-004 `:534-568`; DOM-005 `:576-607`;
  DOM-006 `:609-686`; SALE-001 `:1966-1989`; MOD-001 `:1991-2071` (§3 `:2032-2040`, §4
  `:2041-2050`, §5 `:2051-2059`); SALE-QTY-001 `:2073-2102`; SALE-002 `:2104-2182`
  (one delivery per sale `:2154-2155`; reports never summed `:2177-2178`); CRM-S4A-001
  `:2186-2196`; SCH-001 `:3671-3733`; MOD-002 `:3735-3788`; ARC-002 `:433-453`.
- `docs/architecture/decision-reconciliation-report.md:49` (invoiceNumber debt row),
  `:83` (§5 heading, discovery only), `:95-104` (A0 titles), `:116` (concrete integration
  and document ownership left to A0).
- `docs/features/operator-module-pilot.md:152-161` (404/503 contract), `:173-178` (UI
  revalidation), `:188-194` (restore, migrations).
- `docs/features/visit-to-sale/visit-to-sale-design.md:125` (SALE not invoice-capable);
  `docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md:195` (demo support is its own
  slice).
- `docs/backlog/2026-11-25-core-modules-architecture-research.md:192-199` (no fourth role),
  `:204-205` (offboarding while a module is off), `:230` (Depo/Stok step), `:232`
  (Accounting needs §13 approval + A0).
- Migrations `002_delivery_tracer.sql:4-25,137-162,150-152,196-216`;
  `003_people.sql:32-51`; `004_crm_contacts.sql:5-15`; `005_product_catalog.sql:8-10`;
  `024_job_card_notes_invoice_number.sql:1-4`; `057_sale_from_visit.sql:17-25,70-88`;
  `058_sale_integer_quantity.sql:19-24`; `071_sale_standalone_and_delivery_link.sql:26-43`;
  `074_installation_operator_and_module_state.sql:28-35,50-65,67-120,86-87`.
- `server/src/db/critical-action.ts:142-221`; `server/src/modules/job-cards/notes-service.ts:22,56-61`;
  `server/src/modules/job-cards/sale-repository.ts:12-15`;
  `server/src/modules/job-cards/policy.ts:21-23`;
  `server/src/modules/installation-modules/registry.ts:1-27`;
  `server/src/modules/overview/service.ts:88-101`;
  `server/src/modules/capabilities/types.ts:1-8`;
  `server/src/modules/capabilities/service.ts:5-36`;
  `server/src/modules/products/types.ts:7-11,43`;
  `server/src/modules/reports/types.ts:19`;
  `server/src/modules/reports/repository.ts:1279-1320`;
  `server/src/modules/crm/service.ts:399-409`; `server/src/modules/crm/repository.ts:423-430`;
  `server/src/modules/products/service.ts:238-248`;
  `server/src/modules/demo-data/plan.ts:24-43`.
- Web: `web/src/jobs/JobNotes.tsx:70-71,238-245`; `web/src/services/api.ts:19-25,183-190`;
  `web/src/shell/route-access.ts:35-40`; `web/src/shell/navigation-model.ts:89-112`;
  `web/src/CustomerDetail.tsx:53`.

### Web (accessed 2026-11-26 unless stated)

| # | Source | Used for |
| --- | --- | --- |
| W1 | VUK Genel Tebliği (Sıra No: 509), consolidated — <https://ebelge.gib.gov.tr/dosyalar/tebligler/Dipnotlu_Guncel_Sekli_ile_509_Sira_No'lu_VUK_Genel_Tebligi.pdf> | e-Fatura obligation groups, e-Arşiv, e-İrsaliye, content and retention §§IV.1–IV.3, V.1–V.5, VI |
| W2 | VUK 573, RG 12.11.2024/32720 — <https://ebelge.gib.gov.tr/dosyalar/tebligler/Vergi_Usul_Kanunu_Genel_Tebligi_(Sira_No_509)'nde_Degisiklik_Yapilmasina_Dair_Teblig_(Sira_No_573).pdf> | e-Arşiv 3,000 TL for 2025 and amount-independent from 1.1.2026 |
| W3 | VUK 589, RG 31.12.2025/33124 — <https://ebelge.gib.gov.tr/dosyalar/tebligler/Vergi_Usul_Kanunu_Genel_Tebligi_(Sira_No_509)'nde_Degisiklik_Yapilmasina_Dair_Teblig_(Sira_No_589).pdf> | simple/ledger-basis e-Arşiv deferral to 1.1.2027 |
| W4 | VUK 526, RG 9.2.2021/31390 — <https://gib.gov.tr/mevzuat/kanun/434/teblig/7885> | medical material/medicine e-Fatura head, no threshold, transition 1.7.2021 |
| W5 | GİB announcement, VUK 550 published 7.10.2023 (RG 32332) — <https://www.gib.gov.tr/duyuru-arsivi/guncel/434_vergi_usul_kanunu_genel_tebligi_sira_no%3A_509nde_degisiklik_yapilmasina_dair_teblig_sira_no%3A_550_resmi_gazetede_yayimlandi> | §IV.1.4(a) reorganised, so the medical bent letter is **UNVERIFIED** |
| W6 | İlaç ve Tıbbi Cihaz Teslimlerine İlişkin Fatura Teknik Kılavuzu v1.2 (June 2025) — <https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/Ilac_ve_Tibbi_Cihaz_Teslimlerine_Iliskin_Fatura_Teknik_Kilavuzu_V.1.2.pdf> | `ILAC_TIBBICIHAZ`, UNO/LNO/SNO/URT; versions **VOLATILE** |
| W7 | e-Arşiv Teknik Kılavuzu v1.19 (October 2026) — <https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Teknik_Kilavuzu_V.1.19.pdf> | daily T+1 e-Arşiv reporting duty |
| W8 | GİB, KDV oranları (2007/13033 consolidated, CBK 7346) — <https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv/yardim-kaynaklar/yararli-bilgiler/kdv-oranlari.pdf> | 20/10/1 rates; medical devices in list (II); **VOLATILE** |
| W9 | KVKK, Türkiye Cumhuriyeti Kimlik Numaralarının İşlenmesi Hakkında Rehber, published 16.01.2024 — <https://www.kvkk.gov.tr/Icerik/7798/Turkiye-Cumhuriyeti-Kimlik-Numaralarinin-Islenmesi-Hakkinda-Rehber> | TCKN is personal data |
| W10 | PostgreSQL 17, numeric types — <https://www.postgresql.org/docs/17/datatype-numeric.html>; sequences — <https://www.postgresql.org/docs/17/functions-sequence.html> | exact money; sequences cannot be gapless |
| W11 | Paraşüt developer hub, OpenAPI v4.1.0 — <https://devhub.parasut.com/openapi.json>; OAuth — <https://devhub.parasut.com/oauth-rehberi> | Mode 2a target capability and idempotency primitives |
| W12 | Mikro API docs — <https://apidocs.mikro.com.tr/apis>, <https://apidocs.mikro.com.tr/guides> | second target; local Windows service, no idempotency key |
| W13 | Logo product docs — <https://polaris.logo.cloud/product/tiger-uyarlama-araci/a53ad11d-f54a-4af7-bb23-7a221835f167> | Logo Objects REST v1.6, port 32001, licence-gated |

**VOLATILE, re-check before build:** the 2026/2027 e-Arşiv cut-off dates, the 3M TL and 10M TL
thresholds, the 20/10/1 VAT rates, the 30,000 TL cash tevsik limit, e-Fatura package/version
numbers, integrator plan quotas and token lifetimes.
