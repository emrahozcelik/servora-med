# Accounting A0 — revised owner decision brief

> **ACC-A contract follow-up:** [08-acc-a-implementation-contract.md](08-acc-a-implementation-contract.md) resolves first-slice options in this document and takes precedence for ACC-1/2 design details (not over accepted repository decisions). It fixes a single outbound issuer per organization, strict normalized number and optional ETTN, no URL/amount, three explicit finance grants with audited ADMIN self-grant, no STAFF finance access, source eligibility, correction/reopen/replace, replay admission and transaction order. Owner acceptance and real-data pilot verification remain separate gates; later ACC-3–7 scope is unchanged.

**2026-11-26 — Research / decision input, not implementation authorization.** The owner approved expansion of product direction and this documentation revision. No runtime change, full accounting module, statutory document issuance, deployment or integration was authorized. Accepted MOD-001 and MOD-002 remain binding; AGENTS.md §13 applies. The [expanded product scope](07-expanded-product-scope.md) is the controlling proposal within this research package. This brief replaces the [original decision draft](https://github.com/emrahozcelik/servora-med/blob/00be58d0ad5848f3a8f7083cfa155541d236327e/docs/backlog/2026-11-26-accounting-module-research/06-decision-brief.md); preserve historical research but do not implement superseded proposals.

## Decisions D1–D10 (revised recommendations)

| ID | Topic | Revised proposal | Gate |
| --- | --- | --- | --- |
| D1 | Scope and §13 | Product direction: expanded preliminary accounting for small businesses, optional for ERP users. Start with ACC-1/2 (Cut A), identity-only. Broader scope ACC-3–7 is staged and not authorized by this PR. | Accept ACC-A with implementing code; explicit MOD-001 extension for supplier/expense/cash scope before ACC-5. |
| D2 | Authority | Local operational financial facts owned by Accounting only in standalone mode; official documents/statutory records external. In integrated mode explicit ownership per fact, no duplicate authority. | Confirm pilot mode before financial entry; authority change requires cutover. |
| D3 | Price/tax | No monetary fields in Cut A; prices/taxes on Accounting documents only in B, not Core or catalogue authority. | Decide currency/rounding/pricing and tax policy before B. |
| D4 | Billing identity | CRM VKN/TCKN remains unchanged; Accounting billing profile and immutable snapshots. Supplier profile Accounting-owned unless shared master explicitly accepted. | Confirm tax ID visibility, issuer and counterparty namespace. |
| D5 | Legacy invoiceNumber | Keep Core note API and receipts identical on/off. UI may offer structured reference to authorized user; keep existing history and path for others. No backfill. | ACC-2; any import separate. |
| D6 | SALE correction/cancellation | No accounting block or auto-void; retain immutable source snapshot, show reconciliation. Many-to-many source links, customer/org/type checks. | ACC-2; partial amount/line allocation in later slice. |
| D7 | Reports | No financial values in Core reports; financial statements, ageing and cash views owned by Accounting only. Separate document/cash basis and no statutory/profit claims. | ACC-6; report basis and time boundaries. |
| D8 | External integration | None in A. Pilot customer determines adapter; Paraşüt/Mikro/Logo findings are dated evidence, not product commitment. | ACC-7; authority, license, privacy and recovery. |
| D9 | Access/KVKK | Fixed module-specific finance grants, default deny; no blanket MANAGER access, no fourth role, operator no financial data. ADMIN administers grants; bootstrap/self-access explicit decision. | ACC-1/2; retention/accountant verification before live finance. |
| D10 | Modules | Warehouse and Maintenance independent; no stock or finance side effects by module toggle, job completion or document creation. | Cross-module tests; future narrow contract per real integration. |

## Additional decisions before later slices

- D11 — supplier/payables/purchase references and supplier-vs-customer identity; explicit scope extension before ACC-5a.
- D12 — expense vs purchase/payment recognition; manual cash/bank account ownership, transfer/reversal, negative balance and custody policy before ACC-5b.
- D13 — opening balances, imported open documents, payment/receipt allocations, returns/credit, reconciliation and permissions before ACC-4/5.
- D14 — financial report semantics, period/timezone, data export and retention before ACC-6.
- D15 — issuer identity/normalization, correction of duplicate/voided references, source eligibility; confirm with real examples before ACC-2.
- D16 — new-module default-off initialization and same-transaction shared state row lock against operator disable; audit provenance, grants, bootstrap and revocation before ACC-1.
- D17 — staff visibility and field collection, who may reverse financial records; no access unless explicitly granted in accepted policy.

## Reconciliation of the old draft

| Conflict | Controlling proposal |
| --- | --- |
| C1: off 404 vs 503 | Known disabled 404; unreadable/missing 503, false capability, no env fallback. |
| C2: legacy notes | No import or changed Core validation; old history and receipts preserved. |
| C3: single source link | Association table; many-to-many, optional standalone, validate type/customer/org, snapshot. |
| C4: optional monetary total vs no price | A identity only: no amount, tax, currency or due date. Monetary facts deferred. |
| C5: number uniqueness | Explicit issuer/document namespace + direction + normalized external number; scoped stable external ID when available; define correction lineage. |
| C6: edits and void | Narrow versioned metadata correction; identity corrections audited with replacement/lineage, no silent reuse or local/legal void confusion. |
| C7: price authority | Catalog informational; Accounting document prices vs external authority defined before B. |
| C8: law citations | Dated/unverified evidence; current official sources and accountant review required before implementing regulatory behavior. |
| C9: connector status | No connector in A; later durable narrow contract, no auto-replay on enable. |
| L1/L2: MOD-001 price and integration modes | §5 restricts Core SALE; §3 allows accounting document tax/pricing, but precise B ownership still needs accepted decision. |
| L3: legacy Core API changes | Rejected; module off/on must not change Core command semantics. |
| L4: migration 075 | Not reserved; inspect current main and assign at implementation. |
| New: new-module env | New Accounting has no legacy flag. Initialize off in DB with explicit audit, no new ACCOUNTING_ENABLED. |
| New: toggle race | Unlocked re-read insufficient. Shared state row lock in financial transaction conflicts with operator update; two-session tests mandatory. |
| New: fixed 7 days and invoiced status | No fixed overdue rule, alerts or claim that presence of reference proves full invoicing. |
| New: broad MANAGER permissions | Default deny fixed finance grants; ADMIN grant administration not blanket access. |

## First implementation checkpoint

Review ACC-1 + ACC-2 as a vertical slice. Required: exact current-main inspection, accepted limited ACC-A/§13 scope, runtime and finance authorization contract, reference identity and source association rules, schema and acceptance tests ACC-T01–T10, T16–T17 from [expanded scope](07-expanded-product-scope.md#7-acceptance-scenarios-english-required-as-relevant-to-each-slice). A is not a customer-ready module. Do not merge an empty scaffold or reserve a migration. No e-document issuance, amount fields, cash, connector, worker or legal document PDF in A. No code, accepted decision file or product requirement change in this research PR; update them with implementation.

Open confirmations: first pilot and ERP/version; actual sales/delivery invoice reference practice; administrator finance grant bootstrap; reversal permission; issuer namespaces; staff access; accountant/privacy retention; later opening balances, suppliers, cost/expense overlap, cash negative-balance and reporting policy. The owner has approved expanded product direction, not all design defaults. Tests and legal validation have not been executed for the revision.
