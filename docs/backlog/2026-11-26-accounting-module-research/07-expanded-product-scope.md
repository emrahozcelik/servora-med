# Expanded preliminary accounting — product scope and staged delivery contract (proposal)

- Date: 2026-11-26
- Status: owner-approved **product direction** (expand the preliminary-accounting scope); implementation design and individual slice approvals remain pending. Research only. No approval to implement a full accounting system, e-document issuance, migrations, production changes or external integrations.
- Baseline: PR #515 original head `00be58d0ad5848f3a8f7083cfa155541d236327e`; code evidence at base `89bf6b1`. Revalidate against current main before each implementation slice.
- This document and the revised [decision brief](06-decision-brief.md) supersede conflicting design proposals in the original research notes; they do not supersede accepted DECISIONS.md records. MOD-001 §3 explicitly covers the light commercial layer; supplier/payable/expense/cash extensions need an explicit new decision in the implementing PR. MOD-002 currently authorizes Overview only. AGENTS.md §13 remains binding.

## 1. Product objective and customers

**Ön Muhasebe** is an optional paid installation module, not a general ledger or ERP. For a small business without dedicated software, provide usable operational financial tracking. For an enterprise with Logo, Netsis, Mikro, Paraşüt or another accounting system, allow the module to be off or provide a controlled reference/integration mode. The official statutory system remains external in either case. A record in Servora is not proof of legal issuance or tax compliance.

Company/installation subscription with unlimited users; module activation is controlled by the installation operator under MOD-002, not the customer ADMIN. Permissions inside the module are a separate concern. Do not implement pricing/billing or a new entitlement system here. No compulsory Warehouse, Maintenance, Calendar, Messaging or Overview subscription.

### Product scope

| Capability | Product target | Earliest slice |
| --- | --- | --- |
| Sales invoice references | Register/search external invoice number, date, issuer, customer, status; reconcile against source work | ACC-2 |
| Quotes and orders | Priced commercial documents, snapshots, quantities, discounts and tax information; clearly non-statutory PDF if separately accepted | ACC-3 |
| Customer open accounts | Opening balances, receivables, due dates, statements, ageing, credits | ACC-4 |
| Collections | Partial, multiple, allocated or unallocated receipts, reversal, payment method and external reference | ACC-4 |
| Supplier open accounts | Supplier profiles, purchase invoice references, payables, due dates and credits | ACC-5a |
| Payments | Partial payment, advance, allocation to payable, reversal | ACC-5a |
| Expenses | Expense categories, dates, amount, tax information where needed, payment link; no double counting purchase invoices | ACC-5b |
| Cash and bank | Manually maintained account registers, opening balances, deposits, withdrawals, transfers and cash/bank statement | ACC-5b |
| Financial views | Receivables/payables ageing, account statements, expense/receipt summaries, cash flow and clearly defined period-based income/expense views | ACC-6 |
| External exchange | Explicit pilot-driven import/export, then narrow vendor adapter if needed | ACC-7 |

ACC-2 is an internal milestone, not a sale-ready preliminary-accounting product. ACC-1 through ACC-4 could form a clearly labelled sales/receivables pilot; ACC-5 and ACC-6 are required before presenting the broader small-business module as complete. Delivery dates and estimates are not commitments.

### Non-goals

No chart of accounts, statutory general ledger, journals, trial balance, tax declarations, e-Defter, payroll, fixed asset depreciation, generic posting engine, full bank reconciliation, open banking, automatic tax engine, inventory valuation/COGS or profitability claims without cost data. No legal e-Fatura/e-Arşiv/e-İrsaliye/e-SMM issuance, GİB submissions, official numbering, or PDFs masquerading as statutory documents. Multi-currency, cheque/senet, debt collection automation, attachment storage and OCR are deferred pending separate evidence and decisions. No generic event bus, queue, connector marketplace, dynamic modules or framework.

## 2. Financial authority and module ownership

| Area | Standalone preliminary-accounting mode | External authority mode |
| --- | --- | --- |
| Operational customer, product, job and SALE | Core | Core |
| Official invoice, statutory records and tax compliance | External statutory process/accountant | External ERP/accounting system |
| Operational quote/order, open-account, collections/payments | Accounting is the sole local authority for the agreed local scope | External system authoritative for synchronized financial facts; local records are explicitly read-only mirrors or pending submissions |
| Stock, serial/lot and physical delivery | Warehouse when enabled, otherwise Core delivery is operational evidence only | Designated external stock authority or Warehouse; no dual ownership |
| Manual cash/bank register | Accounting operational register; not bank truth | Only explicit mirror or non-overlapping local register |

Select financial ownership explicitly for each installation and fact type before integration. Do not blend independent local and external balances. In the first slice, external invoice references are manual informational records only. No connectors, credentials, automatic imports or API calls. Switching authority later is an approved reconciliation/cutover, not an ordinary toggle. A failed integration must show pending/failed state; never imply success. Do not push personal/financial data to a provider without approved data scope and access.

Core owns operational identity, assignments, approval and lifecycle. Accounting owns financial data and reads Core through narrow organization-scoped queries; no reverse dependency in Core commands. No price/VAT/financial status in JobCards, Core product/customer DTOs or operational reports. Catalogue referencePrice remains informational. Warehouse and Maintenance retain ownership; integration requires its own narrow, durable contract only once a real producer and consumer exist. No automatic financial transaction on approval of SALE, delivery or service, no automatic stock decrement on financial document creation. An explicit authorized action or later approved reconciliation workflow is required.

Customer VKN/TCKN stays in CRM; accounting-specific billing title, tax office and address belong to the accounting profile; snapshot document counterparties when recording/finalizing. Supplier identity belongs to Accounting initially; do not create fake CRM customers or duplicate an existing supplier master if a future shared-party contract is accepted. Link dual-role counterparties deliberately and keep receivable/payable balances separate. Supplier, expense and cash ownership needs a new accepted extension to MOD-001, not a silent rewrite.

## 3. Runtime module contract — ACC-1

- Typed registry key `ACCOUNTING`, Turkish label **Ön Muhasebe**, module capability `accounting`; initialize **false** on all existing and fresh installations. There is no legacy active Accounting module to take over: do not introduce a new env switch. Adapt MOD-002 initialization/audit vocabulary explicitly for a new module rather than falsely labelling its initialization as legacy env takeover. Overview semantics unchanged.
- DB state is the sole runtime source; use the existing operator identity/session, versioned update, same-transaction operator audit and fixed MODULE_MANAGEMENT capability. No customer role can toggle; operator sees state and safe aggregate confirmation only, not customer financial content.
- Always registered guarded routes. Known off => 404; missing/unreadable state => 503, capability false, error log, no env fallback. Enabled but unauthorized => 403; unauthenticated => existing authentication contract. Backend checks every route. Hidden navigation, disabled deep links, no financial UI fetches when off, stale financial UI/cache cleared on disable, on focus/revalidation and relevant 404/503. Apply the existing throttled capability refresh without logging a user out on transient failure; preserve Core identity.
- Disable means retain all data and history, no reallocation, deletion, cancellation, silent backfill or auto-replay. Re-enable restores visibility with explicit reconciliation for changed source jobs. Core jobs, SALE, customer management and ordinary offboarding remain functional in either state. Customer/product hard delete may still be rejected by history preservation; this invariant must be identical when off and on and must return the existing coded error. Historical actor identity survives offboarding; revoke sessions/grants, retain audit.
- **Concurrency:** a second unlocked read is not a serialization guarantee. For each financial mutation, acquire a compatible shared row lock on the ACCOUNTING state row within the same transaction (e.g. SELECT ... FOR SHARE) before any financial writes; the operator's versioned UPDATE must acquire a conflicting lock. Hold until commit/rollback; define consistent lock order with permissions, receipts, account/document rows and audit. After disable commits, no new financial mutation may commit under the old state. A mutation serialized first may finish before disable commits; missing row/read failure fails closed. Verify with two real PostgreSQL sessions and deterministic barriers, including idempotent replay, reversal and timeouts. No generic locking infrastructure.
- If future workers exist, no new claim while disabled; recheck/serialize before committing local effects; external side effects need separate drain/reconciliation policy (DB locks cannot make remote calls atomic). No workers in ACC-1/2.
- Backup/restore preserves financial rows, grants and state at backup instant; pre-module restore initializes off; restore after module introduction follows MOD-002 operator reset. Protect export and backup access, test cross-org isolation and restoration. No module-specific destructive restore.
- No reserved migration number. At implementation, inspect current main/head, use the next free additive migration, update actual schema expectations, coordinate parallel PRs and verify historical migrations unchanged.

## 4. Authorization and privacy

Keep STAFF/MANAGER/ADMIN and the installation operator separate; no fourth role or shared finance login. Proposed narrow, fixed accounting grants (not generic RBAC): finance read, commercial document write, receivable/collection write, payable/payment write, cash/expense write, financial reversal/adjustment and export. ADMIN alone administers grants inside its organization, with audited, explicit grants and in-transaction revalidation on critical writes. Do not grant broad financial access to all MANAGER users or infer finance rights from `role !== STAFF`. Default deny. Decide ADMIN self-access/bootstrap explicitly before coding (proposed: audited explicit grant, not implicit blanket finance access). Operator cannot grant customer finance privileges or view amounts. STAFF sees no financial content by default; optional minimal status only on an already readable own job requires a later explicit policy, with no invoice number/amount, cross-customer search or finance list. No field collection permission in first slice.

Server-enforced organization filters on every list, detail, lookup, export, aggregate, event and mutation; composite organization FKs, validate link customer and job type in transaction; foreign org identifiers return indistinguishable 404. Never expose numbers, tokens, signed URLs, TCKN or sensitive payloads in logs/telemetry. Mask tax identity where not needed; restrict retention/export and backup access; separate CRM exposure review. Audit grant/revoke, create, correction, void, reversal, allocation and transfer atomically with actor, timestamp, reason and safe changed values; financial audit never accessible via operator module-management capability. Specify retention with accountant/privacy owner before a production finance pilot; original legal evidence is dated research only.

## 5. Data model and integrity principles (not schema authorization)

Use module-owned tables and narrow services. No speculative tables for unapproved slices. PostgreSQL NUMERIC for money, decimal strings end-to-end (no JS floating point), TRY only for initial product, explicit rounding and precision per amount type; server recalculates totals in ACC-3. Freeze customer/product snapshots and price/tax facts on finalized documents. Catalog price is never authoritative. Each approved migration is additive, not a rewrite of applied migrations.

### ACC-2 — external invoice reference

A contains **identity only**: counterparty, external number/date, issuer identity/system, optional external stable ID, status, audit, links. No gross/VAT, price, currency, due date, payment or balance in A; later monetary slice extends the appropriate record after authority/rounding decisions. UI calls it “Fatura referansı”, not “Faturalandı” or “Fatura”. The presence of a reference is not proof of invoice issuance or full coverage.

Use one reference header and an explicit association table between reference and operational source job (SALE or PRODUCT_DELIVERY), with unique pair, organization/customer/type checks, source version and immutable relevant snapshot. Zero links allowed for a standalone reference. Supports multiple sources per reference and multiple references per source; a SALE and its delivery can be linked together without duplicating the reference. Do not auto-link or infer amount/quantity coverage in A. In ACC-3/4, link approved document lines to source sale lines where partial quantity allocation is required; never count delivery and sale as separate revenue facts.

Define normalized external identity by issuer/legal document namespace, direction and normalized number (normalization rule documented; retain original); separately enforce uniqueness of external stable ID scoped to the correct provider/issuer when present. Do not use year as an automatic namespace if number already embeds year; confirm issuer namespace with pilot data before schema finalization. Duplicate retries replay original response; duplicate real-world identity is a coded conflict. A wrong number/date can be corrected by audited void + replacement with explicit lineage. A voided reference cannot be silently reused; a mistaken capture of an otherwise identical external identity uses an explicit audited correction/version path, not a second active record. Distinguish local void from legal cancellation. Reconcile Core version/invalidated source changes without blocking Core or changing source history. No fixed 7-day overdue rule; optional derived list of eligible sources lacking a reference, with explicit filters and neutral labels. No automatic reminders/escalation. Review eligible types and statuses before implementation.

Legacy invoiceNumber notes remain accepted by Core regardless of module state and old receipts replay identically. UI may guide users to structured references when module is on and authorized; do not hide old history or force users without finance access to use a path they cannot access. No automatic migration; separately approved preview/dedupe/rollback import if needed.

### ACC-3/4/5 — financial integrity

Quotes/order drafts mutable with version checks; finalized amounts and identity immutable, corrections/reversals explicit. Distinguish operational quote/order, recorded external invoice, credit/return and receivable/payable entry; **quote/order is not a booked receivable**. Recognize only verified external document/approved opening or adjustment under the selected authority. Never recognize revenue by job approval.

Opening balances are dated, sourced, auditable and imported idempotently; distinguish open invoices imported individually from residual opening credit/debit to avoid double counting. Derive balances from signed entries and allocations, never mutable cached customer balances. Allocation sum <= payment/receipt and eligible outstanding amount; use row locks on target records in deterministic order, test concurrent allocation and void. Partial and overpayment supported as unallocated credit/advance; void reverses allocations and resulting balance atomically. Treat supplier payables independently; no automatic offset across customer/supplier or currencies. Correct a financial transaction with reversal/replacement, not deletion. No generic double-entry engine; explicit domain movements and invariants.

Purchase references, expenses and payment movements have distinct roles; one cost source may be associated with a payment but not recognized twice. Cash/bank registers are manual operational accounts: opening position, incoming/outgoing movement, transfer pair atomic with same amount and currency, reversal of both legs together, no effect on total cash or income for internal transfer. A collection/payment linked to an account generates exactly one corresponding movement in the same transaction; retry and correction must not duplicate. Define whether negative balances are allowed by account type before ACC-5b. No bank API or reconciliation engine. No unexplained balance edits. Reporting separates accrual-like document activity and actual cash movements; neither is statutory financial statement, profit or taxable income.

Each command uses existing critical-action receipts with distinct operation keys and normalized payload, same transaction as audit/domain writes; optimistic expectedVersion where mutable. Same id + same payload replays; same id + different payload returns coded conflict; concurrent duplicate produces one effect. Scope and authorization remain enforced on replay; disable does not expose stored response. Retain established audit/idempotency lifecycle; no sensitive payload dump.

## 6. Delivery stages and implementation gates

| Slice | Deliverable | Required gate before code |
| --- | --- | --- |
| ACC-0 | Scope and decision reconciliation (this PR) | Owner approves product direction; unresolved detailed decisions remain explicit |
| ACC-1 | Runtime registry/capability, grants, protected navigation and access/audit | Accept implementation contract incl. initialization, grants and locking; no empty future scaffold beyond needed ACC-2 vertical path |
| ACC-2 (Cut A) | Reference-only ledger, source linking, reconciliation view, legacy preservation | Accept ACC-A scope and §13-limited authorization, identity/links/role decisions |
| ACC-3 (Cut B) | Quotes/orders and separately approved price/tax/document contract | Authority, document lifecycle, exact arithmetic, numbering, PDF labelling decisions |
| ACC-4 (Cut C) | Customer open accounts, opening balances, receivables, collections and allocations | Recognition, opening import, reversal/credit, permission and cash policy |
| ACC-5a (Cut D1) | Suppliers, purchase references, payables and payments | Explicit MOD-001 scope extension; counterparty identity, legal document references and payment/credit decisions |
| ACC-5b (Cut D2) | Expenses, cash/bank registers and transfers | Expense overlap, custody, negative balance policy, transaction invariants |
| ACC-6 (Cut E) | Financial dashboard, statements, ageing, cash flow, reports/exports | Report basis, timezone, periods, permissions and totals reconciliation |
| ACC-7 (Cut F) | Pilot-driven external import/export/adapter | Pilot system/version, licensing, authority, idempotent external identity, privacy and recovery contract |

ACC-1 and ACC-2 can be one vertical implementation PR if smaller and safer; do not merge an empty module scaffold alone. Every implementation PR carries the accepted decision(s), PRODUCT_REQUIREMENTS and schema/feature contract updates where relevant, code, tests and evidence together. No implementation against a moving or stale head: compare current main, resolve parallel module registry/migration changes, follow normal CI/release gates. Production deployment and enabling remain separately authorized.

## 7. Acceptance scenarios (English; required as relevant to each slice)

| ID | Given / when / then |
| --- | --- |
| ACC-T01 | New installation and upgrade initialize ACCOUNTING disabled; existing Overview state unchanged; only authorized operator can toggle; audited version conflict does not change state. |
| ACC-T02 | With a valid session, disabled routes return 404; missing/unreadable state returns 503 and false capability; no env fallback; existing Core responses unchanged. |
| ACC-T03 | An enabled module denies ungranted users and operator business-data access; organization-scoped grants and revocation checked server-side, including direct URLs, exports and replay. |
| ACC-T04 | Two transactions race an accounting write against disable: either write commits before disable or is rejected after disable; no stale-state commit, deadlock leak or partial audit. Test both orderings and missing row. |
| ACC-T05 | Disable/re-enable retains exact records and audit; offboarding remains possible; Core SALE correction/cancel/invalidate succeeds identically; reconciliation shows changed/invalidated link on reopen. |
| ACC-T06 | Cross-org/customer-mismatched and wrong-type source link is rejected atomically; one reference can link multiple sales/deliveries, one sale multiple references; duplicate link cannot double count; standalone valid. |
| ACC-T07 | Duplicate normalized issuer identity fails coded; same number in distinct valid namespaces succeeds; same clientActionId replays once; changed payload conflicts; correction/void/replacement and audit atomic. |
| ACC-T08 | Legacy notes, API and replay identical on/off; no auto-backfill; no fixed overdue/alert; reference presence cannot imply full invoicing, revenue or payment. |
| ACC-T09 | Forced audit/receipt failure rolls back mutation; delete protection returns coded history error independent of state; demo purge explicitly accounts for module data or fails closed. |
| ACC-T10 | Backup before/after schema introduction restores safely; pre-module state initializes off, later state and rows match backup, operator access reset; no duplicate history or stale grants. |
| ACC-T11 | Quote/order does not create receivable; exact decimal/rounding and immutable final snapshots; operational reports still contain no financial fields. |
| ACC-T12 | Opening balance/import plus open invoices cannot double count; partial/multiple/unallocated receipts and credits reconcile; concurrent allocation cannot over-allocate; reversal restores exact residual. |
| ACC-T13 | Supplier purchase, payable, payment and expense remain distinct; supplier/customer dual role not silently netted; expense and payment not counted as two costs. |
| ACC-T14 | Transfer updates both accounts atomically with zero net cash/income effect; retry/void does not duplicate movement; cash register equals derived balance, no direct edits. |
| ACC-T15 | Financial reports reconcile to source records, separate document and cash basis, use explicit date boundaries, scope and permissions; no false profit or statutory claims. |
| ACC-T16 | All four combinations of Accounting and Warehouse off/on preserve independent functions; no automatic stock/finance mutation; service/calendar/messaging/overview independence. |
| ACC-T17 | Enabled-to-disabled UI invalidates financial views/cache, deep link safe, Core identity unaffected; desktop 1440px and mobile 390px accessibility/smoke evidence under UI-003. |
| ACC-T18 | External retries/recovery cannot duplicate a document; authority conflict shown, never silently overwritten; disable/restore requires explicit reconcile before replay. |

Tests are proposed, not executed. Legal research and tax/retention assertions in notes 03/04 require current official verification and accountant review at the relevant slice; no hard-coded regulatory threshold from this package.

## 8. Open decisions and review checkpoint

Product direction is broadened. Still confirm before relevant implementation: initial pilot system and actual document practices; whether field staff need financial visibility/collection; ADMIN bootstrap and who can reverse; issuer identity/normalization and eligibility filters; price/tax/rounding/numbering; opening balance/import and returns; supplier identity and account negative balance policy; report basis; retention and legal/tax requirements. Implementation permission must be specific to a slice; owner approval of product direction or merging a research PR does not grant it. First review target is ACC-1/2 contract, not all future schemas.

Original research remains traceable in notes 01–05 and [original decision brief](https://github.com/emrahozcelik/servora-med/blob/00be58d0ad5848f3a8f7083cfa155541d236327e/docs/backlog/2026-11-26-accounting-module-research/06-decision-brief.md). No repository runtime changes in this revision.
