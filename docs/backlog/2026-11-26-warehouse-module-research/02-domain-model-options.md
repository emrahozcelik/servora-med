# Warehouse / Stock — domain model options (research, not a decision)

- **Status:** research report. Nothing here is accepted policy and nothing is implemented.
- **Date:** 2026-11-26
- **Scope:** domain model, storage shape, idempotency, audit and V1 subset for the future
  `Depo/Stok` (Warehouse) module inside the MOD-001 boundary. Read-only investigation; no
  migration, build, test or server run was performed.
- **Owner document for the boundary:** `DECISIONS.md` MOD-001 (`DECISIONS.md:1991-2070`).
- **Evidence discipline used below:**
  - `TODAY` = verified current code behaviour, cited as `path:line`.
  - `ACCEPTED` = accepted decision, cited from `DECISIONS.md` / `AGENTS.md`.
  - `PROPOSAL` = my design proposal. Every `PROPOSAL` block needs owner acceptance.

---

## Özet (TR)

- Bugün stok verisi yok: çekirdek hiçbir stok bakiyesi/hareketi üretmiyor
  (`SERVORA_MED_API_DRAFT.md:1831-1833`), "stock" kelimesi sunucu kodunda yalnızca bir JobCard
  değişiklik talebi nedeni olarak geçiyor (`server/src/modules/job-cards/types.ts:76`).
- Teslimat kalemleri zaten `lot_no`, `serial_no`, `expiry_date` taşıyor
  (`server/src/db/migrations/002_delivery_tracer.sql:150-152`) ama bunlar serbest metin; ürün
  bazlı takip politikası MVP'de bilinçli olarak yok (`PRODUCT_REQUIREMENTS.md:285`).
- Üç seçenek karşılaştırıldı: **A** saf append-only hareket defteri + sorgudan türetilen bakiye,
  **B** defter + aynı transaction'da kilit altında güncellenen bakiye tablosu, **C** belge/fiş
  (başlık + satır) modeli. Öneri: **B**, yalnızca transfer ve sayım için ince bir belge başlığı ile.
- Gerekçe: A'da negatif stok kontrolü ek bir kilit mekanizması ister ve bakiye okuma maliyeti
  geçmişle birlikte büyür; C'nin genel fiş motoru (taslak → onay → iptal, numara serisi) bu
  dilim için yetkisiz kapsam ve MOD-001'in "entegrasyon yok" sınırına dayanıyor.
- İdempotency bugünkü altyapıyla çözülür: `runCriticalAction` (`processed_actions` makbuzu,
  `server/src/db/critical-action.ts:142-208`), 049 niyet tablosu
  (`server/src/db/migrations/049_job_card_lifecycle_intents.sql:6-57`) ve `request_hash`
  (`server/src/db/migrations/036_job_card_invalidated.sql:130-133`).
- Teslimata bağlı stok çıkışı **kendi `clientActionId`'sini almaz**: JobCard `APPROVE` makbuzunun
  içinde, aynı transaction'da yazılır; ayrıca kalem başına tek hareket için unique business key
  konur (SALE-002 "tek transaction, tek makbuz" deseni, `DECISIONS.md:2104-2147`).
- Stok miktarı tam sayı ürün adedidir; katalog `unit` alanı bilgilendiricidir ve dönüşüm yoktur
  (DOM-004 `DECISIONS.md:547-552`, SALE-QTY-001 `DECISIONS.md:2073-2103`, DELIVERY-QTY-001
  `DECISIONS.md:3458-3480`).
- Rezervasyon V1'e girmiyor: konum ataması iş atanmadan belli olmuyor ve iptal/geçersizleştirme/
  offboarding ile uzlaştırılacak ikinci bir miktar yaratıyor. Öneri: onay anında negatif stok
  bloğu + satış/teslimat ekranında salt-okunur "kayıtlı stok" ipucu.
- Offboarding: araç konumu **tembel** oluşturulur; kalıcı silme kontrolüne iki `EXISTS` eklenir
  (`server/src/modules/people/repository.ts:157-315`), offboarding önizlemesi stok bloğunu dar bir
  okuma portundan gösterir. Çekirdek depo tablolarına yazmaz.
- Doğrulama: geri yükleme sonrası `SUM(movements) = balance` mutabakat sorgusu; tetikleyici yok
  (depoda hiç trigger yok, `server/src/db/migrations/043_job_card_schedule_and_assignment_history.sql:19-21`).

---

## 1. What the code and the accepted decisions already fix

These rows are not design choices; they constrain any option.

| # | Fact | Kind | Evidence |
| --- | --- | --- | --- |
| F1 | Core produces no stock balances, ledger entries or financial documents | ACCEPTED | `DECISIONS.md:2019-2020` |
| F2 | Warehouse module owns depots, vehicle stock, quantities, reservations, movements, transfers, returns, corrections, lot/serial/expiry and the movement↔source-operation link | ACCEPTED | `DECISIONS.md:2022-2025` |
| F3 | The stock source of truth is set explicitly per deployment/integration mode; no warehouse tables exist yet | ACCEPTED | `DECISIONS.md:2026-2031` |
| F4 | Stock mutations are explicitly absent from the API today | TODAY | `SERVORA_MED_API_DRAFT.md:1831-1833` |
| F5 | No `*_ENABLED`-style stock code exists; the word "stock" occurs only as a change-request reason code | TODAY | `server/src/modules/job-cards/types.ts:76`, `server/src/db/migrations/064_job_card_change_requests.sql:57` |
| F6 | Single organization per deployment; `organization_id` is an ownership boundary; client payload never chooses it | ACCEPTED | `DECISIONS.md:433-453` |
| F7 | Business tables use `organization_id UUID NOT NULL REFERENCES organizations(id)`, `UNIQUE (organization_id, id)`, and composite FKs `(organization_id, x) → t(organization_id, id)` | TODAY | `server/src/db/migrations/002_delivery_tracer.sql:4-16, 84-101`; `.../057_sale_from_visit.sql:55-60` |
| F8 | Catalog `unit` is informational, nullable, no default; reference price has no financial meaning and is not copied into delivery items | ACCEPTED | `DECISIONS.md:547-552`; `server/src/db/migrations/005_product_catalog.sql:1-12` |
| F9 | Public quantities are whole product counts; catalog units do not convert or qualify them | ACCEPTED | `DECISIONS.md:2073-2082` (SALE-QTY-001), `DECISIONS.md:3458-3466` (DELIVERY-QTY-001); `server/src/modules/job-cards/delivery-input.ts:32-39` |
| F10 | Delivery items already carry optional `lot_no`, `serial_no`, `expiry_date`; they are optional and not driven by product flags | TODAY + ACCEPTED | `server/src/db/migrations/002_delivery_tracer.sql:150-152`; `PRODUCT_REQUIREMENTS.md:285` |
| F11 | `CONSIGNMENT`/`RETURN` are classifications only and create no stock side effect today; returns stay positive and are never netted against sales in reports | ACCEPTED | `PRODUCT_REQUIREMENTS.md:283`; `DECISIONS.md:637` |
| F12 | Delivery items are editable until submission; `WAITING_APPROVAL` and terminal states are not editable | TODAY | `server/src/modules/job-cards/policy.ts:160` |
| F13 | `INVALIDATE` is ADMIN-only, works on completed cards, and materializes nothing / cascades nothing | TODAY + ACCEPTED | `server/src/modules/job-cards/service.ts:1623-1700`; `DECISIONS.md:2150-2157` |
| F14 | PostgreSQL 17 is the required server and tool version | ACCEPTED | `AGENTS.md:264-266`; `docs/operations/local-test-environment.md:143-149` |

Documentation drift noticed, not fixed here: `SERVORA_MED_SCHEMA_DRAFT.md:18` still says
"PostgreSQL 16 or newer" while `AGENTS.md:264-266` requires 17.

---

## 2. Design axes and the stance this document takes

One line per topic; the reasoning follows in §5–§9.

| # | Topic | Stance | Kind |
| --- | --- | --- | --- |
| D1 | Location model | One `stock_locations` table, `location_type IN ('DEPOT','VEHICLE')`; vehicle location is owned by a staff user and created lazily | PROPOSAL |
| D2 | Ledger vs stored balances | Append-only `stock_movements` is the only truth; `stock_balances` is a same-transaction materialization | PROPOSAL (option B) |
| D3 | Reservations | Not in V1 | PROPOSAL |
| D4 | Transfers | One immutable header + exactly two movement legs (OUT/IN) | PROPOSAL |
| D5 | Returns | `RETURN_IN` movement with optional BUSINESS customer reference; vehicle→depot is a transfer | PROPOSAL |
| D6 | Counts / corrections | Post-time immutable `stock_counts` + lines with `system_quantity` snapshot; adjustments are normal movements | PROPOSAL |
| D7 | Lot/serial/expiry | Keep optional attributes on movements (copied from delivery items); **no** lot-level balances and no per-product tracking policy in V1 | PROPOSAL |
| D8 | Unit | Whole product count (`INTEGER`); `unit_snapshot` is display text only, never a factor | PROPOSAL (follows F8/F9) |
| D9 | Negative stock | Deny by default (`CHECK (quantity >= 0)` + conditional update), no ALLOW switch in V1 | PROPOSAL |
| D10 | Tracking policy per product | Module-owned 1:1 table, V1.1, not part of the first migration | PROPOSAL |
| D11 | Idempotency | `clientActionId` per warehouse command; delivery-driven issue redeems the JobCard approval receipt, protected by a unique business key | PROPOSAL |
| D12 | Audit | Movements/documents are the module's own audit; `audit_events` only for ADMIN configuration changes | PROPOSAL |
| D13 | Offboarding / delete | Lazy vehicle location + two `EXISTS` clauses in the permanent-delete check; offboarding preview blocks non-empty vehicles | PROPOSAL |
| D14 | Restore validation | Reconciliation query after restore; no rebuild command in V1 | PROPOSAL |

---

## 3. Options

### 3.1 Option A — pure append-only ledger, balances derived by query

`PROPOSAL` (evaluated, not recommended)

One table of signed movements. Balance of `(location, product)` is
`SELECT SUM(quantity_delta) ... GROUP BY location_id, product_id`. Nothing else is stored.

- **Correctness:** one truth, no possible drift, no reconciliation needed. Strongest property of
  the three.
- **Concurrency:** a negative-stock check needs serialization per `(location, product)`. There is
  no row to lock, so the options are (a) `pg_advisory_xact_lock(hashtextextended(key,0))` — the
  idiom already exists in the repo (`server/src/modules/products/pilot-import.ts:145`,
  `server/src/modules/crm/customer-onboarding-import.ts:582`) — or (b) `SERIALIZABLE` with retry.
  Both work; both are new code on every command path, and multi-line documents must acquire the
  advisory keys in sorted order or deadlock (PostgreSQL docs, §13.3.4, accessed 2026-11-26:
  "The best defense against deadlocks is generally to avoid them by being certain that all
  applications ... acquire locks on multiple objects in a consistent order").
- **Report speed:** every stock screen aggregates history. A stock board covering all
  locations × products scans the full ledger each time; index-only scans help but the cost grows
  with age. (Order-of-magnitude reasoning only; **UNVERIFIED** — no benchmark was run, see the
  "Unverified / gaps" section.)
- **Auditability:** perfect. No second artefact to explain.
- **Restore validation:** nothing to validate beyond row counts, because there is no derived state.
- **Migration complexity:** lowest — two tables (`stock_locations`, `stock_movements`).
- **ERP-mode fit:** medium. Movement rows map to ERP lines, but there is no document identity to
  reconcile against an external document number without later schema work.

### 3.2 Option B — ledger + materialized balance updated in the same transaction

`PROPOSAL` (recommended)

`stock_movements` stays the truth; `stock_balances (organization_id, location_id, product_id,
quantity)` is maintained by the same transaction that inserts the movement, inside the existing
critical-action receipt. Reads are O(1) per key.

- **Correctness:** the invariant `balance = Σ movements` is enforced by construction (same
  transaction, single writer method) and *verified* by a reconciliation query (`§8.4`). The cache
  is reconstructible, so a bug is detectable and repairable rather than terminal.
- **Concurrency:** a row lock on `(location, product)` is the natural serialization point; the
  arithmetic is `quantity = quantity + delta` inside one `UPDATE`, so lost updates are impossible.
  Deadlock is possible for multi-line commands when two transactions touch the same two products
  in different orders; the codebase already maps `40P01` to a retryable
  `409 ACTION_IN_PROGRESS` inside the critical-action helper
  (`server/src/db/critical-action.ts:56-72`, documented in `SERVORA_MED_API_DRAFT.md:157-158`),
  and processing lines in a deterministic `(product_id, location_id)` order makes it rare.
- **Report speed:** O(1) per key; the stock board is a join over balances, and movements are only
  read as paged history.
- **Auditability:** identical to A for facts (the ledger is complete); the balance row is a cache
  with no independent business meaning and no client-facing version.
- **Restore validation:** a reconciliation query is required and cheap
  (`§8.4`), plus a "no orphan balance row" check in both directions.
- **Migration complexity:** low — one table (`stock_balances`) and one index more than A.
- **ERP-mode fit:** medium-high. The balance is only a projection; movements carry
  `source_type`/`source_id` and can carry an external document reference later.

The critical implementation detail — the balance must never be updated with a single-statement
`INSERT ... ON CONFLICT DO UPDATE` when the delta may be negative: the "no existing row" branch
would insert a negative quantity and violate the CHECK, and in PostgreSQL an error aborts the whole
transaction, so every following statement fails until rollback unless a savepoint is used. Use
"ensure-zero, then conditional update" (`§8.3`), and treat `rowCount = 0` as `INSUFFICIENT_STOCK`.
PostgreSQL's `ON CONFLICT DO UPDATE` is atomic
(PostgreSQL 17 docs, `sql-insert`, accessed 2026-11-26: "ON CONFLICT DO UPDATE guarantees an
atomic INSERT or UPDATE outcome ... This is also known as UPSERT") and is a deterministic
statement that "will not be allowed to affect any single existing row more than once" — which is
also why multi-line commands must aggregate per `(location, product)` before touching the balance.

### 3.3 Option C — document/voucher model (stock fişi header + lines)

`PROPOSAL` (evaluated, only the narrow part is recommended)

Every stock change is a numbered document (`stock_documents` header + `stock_document_lines`),
with `status` `DRAFT → POSTED → CANCELLED`; posting generates movements, cancelling posts
reversal movements. Balance is either derived (C-A) or materialized (C-B).

This is the shape Turkish ERPs are usually described with (the "stok fişi" family:
giriş/çıkış/transfer/sayım). That description comes from this task's brief and owner context,
not from a verified product document — **UNVERIFIED**.

- **Correctness:** two facts can disagree (document status vs. resulting movements), and the
  posting/cancel state machine must itself be guarded against double posting.
- **Concurrency:** same as B for balances, plus a document-state transition guard and a
  numbered-series allocator (a row lock or a sequence per period), i.e. two new concurrency
  surfaces.
- **Report speed:** same as A or B depending on whether balances are materialized.
- **Auditability:** best for humans — a number the warehouse staff can quote, print and reconcile
  with an external document. That is a real operational benefit, not a technical one.
- **Restore validation:** reconciliation *plus* document-total checks and a numbering-gap audit.
- **Migration complexity:** highest — 5–7 tables, a status machine, a numbering allocator,
  reversal semantics, and print/export expectations.
- **ERP-mode fit:** best 1:1 mapping when an external ERP becomes the authority, because its
  documents and ours have the same shape.

The cost that decides against C for V1: delivery-driven issues already have a document (the
JobCard + approved delivery), returns have one (the JobCard or a customer reference), and an
opening balance has one (the count). Only transfers and counts genuinely need a header. A general
voucher engine with draft/post/cancel and numbering is exactly the kind of speculative
generalization `AGENTS.md:26-27` (KISS/YAGNI, no new abstraction layers) and MOD-001's
"no integration yet" boundary exclude from the first slice.

---

## 4. Comparison

| Dimension | A: ledger only | B: ledger + balance | C: voucher documents |
| --- | --- | --- | --- |
| Single source of truth | Perfect (one table) | Good (ledger truth + reconstructible cache) | Weaker (document status + movements) |
| Negative-stock enforcement | Needs advisory lock or SERIALIZABLE on every write path | Row lock + conditional update; `rowCount=0` ⇒ `409` | Same as B plus posting-state guard |
| Concurrent duplicate command | `processed_actions` receipt | Same | Same, plus double-post guard |
| Deadlock exposure | Advisory keys per line (must be sorted) | Balance rows per line (must be sorted; `40P01`→`409` exists) | Balance rows + counter row + document row |
| Report speed | O(history) per board render | O(1) per `(location, product)` | O(1) if C-B; O(history) if C-A |
| Auditability for staff | Full history, no number to quote | Same | Full history + quotable document number |
| Restore validation | Nothing to reconcile | `SUM(movements) = balance` check required | Same + document totals + numbering gaps |
| Migration complexity | 2 tables | 3 tables + 2 indexes | 5–7 tables + state machine + counters |
| ERP-mode fit | Movements map to ERP lines | Same, plus `source_*` references | Native 1:1 document mapping |
| Fits `AGENTS.md` KISS/YAGNI | Yes | Yes | Only the narrow header part |
| V1 risk | Balance correctness lives in one complex lock idiom | Cache drift (mitigated, detectable) | Scope creep, unfinished state machine |

**Recommendation: B, plus the narrow part of C.** Two immutable batch headers — `stock_transfers`
and `stock_counts` — where a single user action genuinely spans several lines and must be
perceivable as one event. No `DRAFT`, no `POSTED`, no cancellation state, no document numbering in
V1: a header is created already-posted in the same transaction as its movements, and a mistake is
corrected by a *new* document that points at the old one (`reversal_of_*`).

Table-count note: the matrix compares the three balance mechanisms (A = 2 tables, B = 3, C = 5–7).
The recommendation, with the two headers and the count lines, lands at 7 tables (§8.1–§8.5), and
`warehouse_settings` is the only singleton.

Why not A: the deciding factor is not raw speed but the negative-stock gate. With B the gate is one
`UPDATE ... WHERE quantity + delta >= 0` inside the module's only balance writer, and the
`CHECK (quantity >= 0)` backs it if a future writer forgets; with A it is a lock protocol every
future writer must remember. B keeps A's guarantee (`balance` is derivable) while making the common
read cheap and the guard local.

---

## 5. Location model (depots and vehicle stock)

`PROPOSAL`

| Question | Answer | Why |
| --- | --- | --- |
| One table or two? | One `stock_locations` with a typed discriminator | Movements, balances and transfers reference "a location"; two tables would force every FK and every query to union them |
| Which types in V1? | `DEPOT`, `VEHICLE` only; `CONSIGNMENT_AT_CUSTOMER`, `SUPPLIER`, `IN_TRANSIT` are later migrations | MOD-001 names depots and vehicle stock only (`DECISIONS.md:2023`) |
| Depot identity | `code` (normalized upper-case, unique per organization) + `name` | Staff quote codes; unique names are unrealistic |
| Vehicle identity | `owner_user_id` (staff) + optional `plate` | Stock in a car belongs to the person who drives it; the plate is the human handle |
| One vehicle per staff? | At most one **active** vehicle location per owner (partial unique index) | Two active cars per rep is not a real case; if it becomes one, drop the index in a migration |
| When is a vehicle location created? | Lazily: on the first stock operation for that staff member, or by an explicit "araç stoğu aç" action | Otherwise every staff member gets a location row, which then becomes a permanent-delete blocker for people who never touched stock (§10.2) |
| Depot count | Unlimited from day one, with `warehouse_settings.default_depot_id` as the default destination | A single-depot limit is a fake constraint that needs a migration later |
| Deactivation | `is_active = FALSE`; rows are never deleted | Business history (`AGENTS.md:182` prefers status-based deactivation) |
| Can an inactive location hold stock? | Yes, but it is an exception surfaced on the board; offboarding blocks it (§10.2) | Deleting or silently moving stock on deactivation would rewrite history |

Deliberate non-goal: a location is **not** a customer, a supplier or an order. Putting a customer
in the location table would silently turn consignment stock into tracked stock and contradict
`PRODUCT_REQUIREMENTS.md:283`.

---

## 6. Reservations — V1 verdict: no

`PROPOSAL`

What would reserve stock today: an approved `SALE` with quantities, or a `PRODUCT_DELIVERY` whose
items have a planned quantity and a NULL `deliveredAt`
(`server/src/modules/job-cards/service.ts:2740-2749`,
`SERVORA_MED_API_DRAFT.md:1086-1090`). So a "planned" quantity already exists in the system — but
it is not attributed to a stock location, because the delivery may be carried by a different
staff member than the sale owner (`DECISIONS.md:2152-2157`: the delivery assignee may differ).

Costs of adding reservations in V1:

| Cost | Detail |
| --- | --- |
| Location attribution | A reservation needs a location; at sale approval the carrying staff member is known, but vehicle locations are lazy and may not exist |
| Release matrix | Delivery completed, delivery cancelled, job invalidated, sale cancelled, revision requested, reassignment, offboarding — each must release or move the reservation |
| Second quantity | `reserved` must be reconciled with `on hand` on every board and every negative-stock check |
| Partial deliveries | `DECISIONS.md:2155-2157` explicitly keeps partial delivery and remaining-quantity tracking as an open research topic, so a reservation has no defined consumption rule |

Recommended V1 substitute:

1. **Read-only availability hint** at delivery/sale creation: "araçta kayıtlı: 3" from
   `stock_balances` (a `WarehouseStockPort` read, §10.3).
2. **Hard gate at approval**: the issue movement fails with `INSUFFICIENT_STOCK` when the chosen
   location cannot cover the quantity, and the manager sees exactly which product and how much is
   missing.
3. Revisit reservations only when the owner can point at real double-promising (two staff
   promising the same unit in the same week). The trigger is an operational complaint, not a
   feeling.

---

## 7. Movement ledger, transfers, returns, counts

### 7.1 Movement kinds and sign rules

`PROPOSAL`

| `movement_kind` | Sign | Source | Meaning |
| --- | --- | --- | --- |
| `OPENING` | `> 0` | `STOCK_COUNT` | Opening balance entered as a count, never a fake receipt |
| `RECEIPT` | `> 0` | `MANUAL` | Mal kabul into a depot (no purchase document exists yet) |
| `ISSUE` | `< 0` | `JOB_CARD_DELIVERY` | Approved delivery leaves a location |
| `TRANSFER_OUT` | `< 0` | `TRANSFER` | Leg 1 of a transfer |
| `TRANSFER_IN` | `> 0` | `TRANSFER` | Leg 2 of a transfer |
| `RETURN_IN` | `> 0` | `MANUAL` | Customer return arrives at a vehicle or depot |
| `COUNT_ADJUSTMENT` | `≠ 0` | `STOCK_COUNT` | Difference found by a count |
| `REVERSAL` | `≠ 0` | `REVERSAL` | Compensates an earlier movement |

A single signed `quantity_delta` column (instead of `direction` + positive quantity) keeps the
balance arithmetic trivial and makes `SUM(quantity_delta)` the definition of balance. The sign
rule per kind is a database CHECK, so a mis-signed `ISSUE` cannot be stored.

`OPENING` vs `COUNT_ADJUSTMENT` is decided by the count header, not by the line: a count with
`is_opening = TRUE` posts `OPENING` movements (and every `system_quantity` is 0 by definition on a
fresh enablement), any other count posts `COUNT_ADJUSTMENT`. The "opening ⇒ system_quantity = 0"
rule cannot be a cross-table CHECK and must be service-enforced with a test. Keeping `OPENING`
distinct matters for reporting: without it, the entire opening balance would be counted as
shrinkage.

### 7.2 Transfers: one pair **and** one header

`PROPOSAL`

- A transfer is **one logical fact** and therefore one header row `stock_transfers`
  (from, to, occurred_at, actor, note, `reversal_of_transfer_id`) plus **exactly two** movement
  legs sharing `movement_group_id = stock_transfers.id`.
- A unique partial index enforces exactly one `TRANSFER_OUT` and one `TRANSFER_IN` per group, so a
  half-transfer cannot exist.
- Allowed directions in V1: depot→vehicle, vehicle→depot, depot→depot, vehicle→vehicle (handover).
  `from_location_id <> to_location_id` is a CHECK.
- No "in transit" state: the physical move is instantaneous from the system's point of view; the
  transfer commits atomically or not at all.
- A wrong transfer is corrected by a new transfer with `reversal_of_transfer_id`; the original is
  never edited.

Why a header rather than only a pair: the pair alone has no id, no note, no actor and no target
for a reversal; a `movement_group_id` alone could carry those columns, but then every receipt and
issue would carry unused transfer columns. The header is 8 columns and one FK, and it gives the
warehouse staff something to quote.

### 7.3 Returns

`PROPOSAL`

Two distinct flows, deliberately not merged:

| Flow | Model | Reason |
| --- | --- | --- |
| Customer → vehicle/depot | `RETURN_IN` movement, manual command, optional `customer_id` (BUSINESS only) + required note | The goods were never in the tracked perimeter; there is no source location to subtract |
| Vehicle → depot | Normal transfer | Both ends are tracked locations |
| Wrong return entry | `REVERSAL` movement referencing the original | History is never edited |

The BUSINESS-only rule for the customer reference follows SALE, which rejects a DEMO customer or
DEMO product with `409 SALE_REFERENCE_NOT_ELIGIBLE`
(`server/src/modules/job-cards/sale-service.ts:202,222`); the same restriction keeps the demo purge
from meeting a warehouse FK. `PROPOSAL`.

`DOM-001` defines delivery purposes as things "a product left with a customer" represents
(`DECISIONS.md:347-352`), so a `PRODUCT_DELIVERY` item with purpose `RETURN` is **outbound** and
must map to `ISSUE`, not to an inbound movement. This is the single most misread mapping in the
whole topic and it needs an owner confirmation (Open questions, Q3).

### 7.4 Counts / sayım — correcting without editing history

`PROPOSAL`

- `stock_counts` header: location, `occurred_at`, actor, note. Created already-posted.
- `stock_count_lines`: `product_id`, `system_quantity` (snapshot read under the same locks),
  `counted_quantity`, `difference`, optional `movement_id`.
- Zero-difference lines are stored with `movement_id = NULL`. They are the evidence that a human
  counted the shelf; dropping them would make the count unreviewable.
- One `COUNT_ADJUSTMENT` movement per non-zero line, `source_type = 'STOCK_COUNT'`,
  `source_id = stock_count_lines.id`.
- No `DRAFT` state in V1: a count is submitted as one command with all its lines. A 40-line count
  entered in one dialog is acceptable; multi-session counting is a later slice.
- The first enablement uses a count with `is_opening = TRUE` (its movement kind is `OPENING`): from
  zero to the counted quantity. No backfill of historical deliveries, which satisfies the
  acceptance idea "enabling the module does not auto-deduct old deliveries".

`ASSUMPTION`: a count can be posted while other movements happen. The `system_quantity` snapshot
is taken under the same balance locks as the adjustment, so the difference always equals
`counted - system-at-post-time`, and any movement that slipped in before the count is already
reflected. This is correct but means the count "explains" only the difference it created, not the
reason for the pre-count drift.

### 7.5 Lot / serial / expiry (SKT)

`PROPOSAL` for V1: attributes only, no lot-level balances.

| Aspect | V1 | V1.1 (needs a decision) |
| --- | --- | --- |
| Storage | `lot_no`, `serial_no`, `expiry_date` on the movement, copied from the delivery item or typed by the operator | `stock_lots` (lot identity per product, expiry) and balances keyed by lot |
| Validation | Format checks only (`expiry_date` is a real date); no requirement | Product tracking policy decides whether a lot is mandatory |
| Serial uniqueness | Not enforced | A serial is one unit: `UNIQUE (organization_id, product_id, serial_no)` plus a serial state/location row |
| Expiry (SKT) | Displayed and filtrable on the board | Expiry alerts and "FEFO" picking |
| Why not now | `PRODUCT_REQUIREMENTS.md:285` says lot/serial/expiry are optional and not controlled by product flags; enforcing them is a new product rule | — |

If lot-level balances were added later, the balance key becomes
`(organization_id, location_id, product_id, lot_id)`, and `lot_id` NULL must still be unique per
key — PostgreSQL 17 supports `UNIQUE NULLS NOT DISTINCT`
(`sql-createtable`, accessed 2026-11-26: "For the purpose of a unique constraint, null values are
not considered equal, unless NULLS NOT DISTINCT is specified"). That is the seam to design
against now; it costs one nullable column later, not a redesign.

---

## 8. Candidate tables

All blocks are **PROPOSAL**. They are not a migration. Conventions copied from existing migrations:
`organization_id UUID NOT NULL REFERENCES organizations(id)` and `UNIQUE (organization_id, id)`
(`server/src/db/migrations/002_delivery_tracer.sql:4-16`), composite FKs
(`.../002_delivery_tracer.sql:88-101`), normalized-text CHECKs
(`.../074_installation_operator_and_module_state.sql:18-19`), fail-closed empty-table guards
(`.../049_job_card_lifecycle_intents.sql:65-71`), and `ON DELETE RESTRICT` on business history
(`.../057_sale_from_visit.sql:55-60`).

### 8.1 `stock_locations`, `warehouse_settings`

```sql
-- PROPOSAL
CREATE TABLE stock_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  location_type VARCHAR(10) NOT NULL
    CHECK (location_type IN ('DEPOT', 'VEHICLE')),
  code VARCHAR(40) NOT NULL
    CHECK (code = upper(btrim(code)) AND length(code) BETWEEN 1 AND 40),
  name VARCHAR(120) NOT NULL CHECK (length(trim(name)) > 0),
  owner_user_id UUID,
  plate VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, owner_user_id) REFERENCES users (organization_id, id),
  CONSTRAINT stock_locations_owner_check CHECK (
    (location_type = 'DEPOT'   AND owner_user_id IS NULL     AND plate IS NULL)
    OR (location_type = 'VEHICLE' AND owner_user_id IS NOT NULL)
  )
);
-- One active vehicle per staff member.
CREATE UNIQUE INDEX stock_locations_active_vehicle_owner_idx
  ON stock_locations (organization_id, owner_user_id)
  WHERE location_type = 'VEHICLE' AND is_active;
CREATE UNIQUE INDEX stock_locations_plate_idx
  ON stock_locations (organization_id, upper(plate))
  WHERE plate IS NOT NULL;
```

Read as: a `DEPOT` has no owner and no plate; a `VEHICLE` must have an owner and may carry a
plate. A plate is not the identity because the same plate can be re-registered after a sale of the
car; the owner is the identity the stock follows.

```sql
-- PROPOSAL
CREATE TABLE warehouse_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  stock_authority VARCHAR(20) NOT NULL DEFAULT 'SERVORA'
    CHECK (stock_authority IN ('SERVORA')),        -- MOD-001 F3: mode recorded, one mode exists
  default_depot_id UUID,
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  UNIQUE (organization_id),
  FOREIGN KEY (organization_id, default_depot_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, updated_by) REFERENCES users (organization_id, id),
  CONSTRAINT warehouse_settings_default_depot_check
    CHECK (default_depot_id IS NOT NULL OR activated_at IS NULL)
);
```

Typed singleton per organization, not a JSONB bag (`DECISIONS.md:112`, UI-002). Precedent for a
typed singleton is `backup_policy`
(`server/src/db/migrations/030_backup_domain_foundation.sql:116-138`), which is installation-level;
this one is organization-level because it is business data (ARC-002).

The `CHECK (stock_authority IN ('SERVORA'))` looks odd but is intentional: MOD-001 requires the
authority to be *set explicitly* per deployment, and the migration that adds `'EXTERNAL_ERP'` is
exactly where a reviewer must look when integration mode starts.

### 8.2 `stock_movements`

```sql
-- PROPOSAL
CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  movement_group_id UUID NOT NULL,
  sequence_in_group SMALLINT NOT NULL CHECK (sequence_in_group >= 1),
  movement_kind VARCHAR(20) NOT NULL CHECK (movement_kind IN
    ('OPENING','RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN',
     'RETURN_IN','COUNT_ADJUSTMENT','REVERSAL')),
  location_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity_delta INTEGER NOT NULL
    CHECK (quantity_delta <> 0 AND quantity_delta BETWEEN -999999999 AND 999999999),
  unit_snapshot VARCHAR(30),
  product_name_snapshot VARCHAR(255) NOT NULL
    CHECK (length(trim(product_name_snapshot)) > 0),
  product_sku_snapshot VARCHAR(100),
  lot_no VARCHAR(100),
  serial_no VARCHAR(100),
  expiry_date DATE,
  occurred_at TIMESTAMPTZ NOT NULL CHECK (isfinite(occurred_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID NOT NULL,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN
    ('MANUAL','JOB_CARD_DELIVERY','TRANSFER','STOCK_COUNT','REVERSAL')),
  source_id UUID,
  source_job_card_id UUID,
  reversal_of_movement_id UUID,
  note TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, movement_group_id, sequence_in_group),
  FOREIGN KEY (organization_id, location_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products (organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, source_job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reversal_of_movement_id)
    REFERENCES stock_movements (organization_id, id),
  CONSTRAINT stock_movements_source_check CHECK (
       (source_type = 'MANUAL'            AND source_id IS NULL     AND source_job_card_id IS NULL     AND reversal_of_movement_id IS NULL)
    OR (source_type = 'JOB_CARD_DELIVERY' AND source_id IS NOT NULL AND source_job_card_id IS NOT NULL AND reversal_of_movement_id IS NULL)
    OR (source_type = 'TRANSFER'          AND source_id IS NOT NULL AND source_job_card_id IS NULL     AND reversal_of_movement_id IS NULL)
    OR (source_type = 'STOCK_COUNT'       AND source_id IS NOT NULL AND source_job_card_id IS NULL     AND reversal_of_movement_id IS NULL)
    OR (source_type = 'REVERSAL'          AND source_id IS NOT NULL AND source_job_card_id IS NULL     AND reversal_of_movement_id IS NOT NULL)
  ),
  -- A kind may only come from its own source. Without this, an ISSUE could be
  -- stored as a manual row and skip every delivery-side guard.
  CONSTRAINT stock_movements_kind_source_check CHECK (
       (movement_kind = 'RECEIPT'      AND source_type = 'MANUAL')
    OR (movement_kind = 'RETURN_IN'    AND source_type = 'MANUAL')
    OR (movement_kind = 'ISSUE'        AND source_type = 'JOB_CARD_DELIVERY')
    OR (movement_kind IN ('TRANSFER_OUT','TRANSFER_IN') AND source_type = 'TRANSFER')
    OR (movement_kind IN ('OPENING','COUNT_ADJUSTMENT') AND source_type = 'STOCK_COUNT')
    OR (movement_kind = 'REVERSAL'     AND source_type = 'REVERSAL')
  ),
  CONSTRAINT stock_movements_sign_check CHECK (
       (movement_kind IN ('OPENING','RECEIPT','RETURN_IN','TRANSFER_IN') AND quantity_delta > 0)
    OR (movement_kind IN ('ISSUE','TRANSFER_OUT')                       AND quantity_delta < 0)
    OR (movement_kind IN ('COUNT_ADJUSTMENT','REVERSAL'))
  )
);

-- Exactly one leg of each kind per transfer group.
CREATE UNIQUE INDEX stock_movements_transfer_legs_idx
  ON stock_movements (organization_id, movement_group_id, movement_kind)
  WHERE movement_kind IN ('TRANSFER_OUT','TRANSFER_IN');

-- One delivery item posts at most one ISSUE, ever (double-post protection
-- independent of the command receipt).
CREATE UNIQUE INDEX stock_movements_delivery_item_once_idx
  ON stock_movements (organization_id, source_id, movement_kind)
  WHERE source_type = 'JOB_CARD_DELIVERY';

-- A movement can be reversed at most once.
CREATE UNIQUE INDEX stock_movements_one_reversal_idx
  ON stock_movements (organization_id, reversal_of_movement_id)
  WHERE movement_kind = 'REVERSAL';

CREATE INDEX stock_movements_board_idx
  ON stock_movements (organization_id, location_id, product_id, occurred_at DESC, id DESC);
CREATE INDEX stock_movements_job_idx
  ON stock_movements (organization_id, source_job_card_id)
  WHERE source_job_card_id IS NOT NULL;
```

Notes that matter:

- `actor_user_id` is `NOT NULL` on purpose. Every movement has a human actor in V1, and a movement
  is business history, so it blocks permanent user deletion exactly like `job_cards.created_by`
  does. The `audit_events` "actor OR actor snapshot" pattern
  (`server/src/db/migrations/035_demo_data_purge_foundation.sql:17-37`) exists for *technical*
  actors, not for business facts; adopting it here would silently weaken deletion protection.
- `quantity_delta` is `INTEGER`, matching F9 (whole counts). If measured goods (ml/mg) are ever
  authorized, `ALTER COLUMN TYPE NUMERIC(14,3)` is a widening conversion with no data loss — a
  cheap future path, which is why INTEGER is the low-regret choice now.
- `source_id` is deliberately **not** a foreign key: it is polymorphic over `source_type`
  (delivery item, transfer, count line, reversed movement). Traceability to core is carried by
  `source_job_card_id`, which *is* an FK with `ON DELETE RESTRICT`; the service validates the
  polymorphic target in the same transaction that inserts the row.
- No `unit` column participates in arithmetic; `unit_snapshot` is display text copied at post time
  so a later catalog edit does not rewrite history (same idea as `product_*_snapshot` on
  delivery items, `server/src/db/migrations/002_delivery_tracer.sql:147-149`).
- No UPDATE/DELETE endpoint will exist, and no trigger will enforce it: the repo has zero triggers
  and two migrations state the policy explicitly
  (`.../043_job_card_schedule_and_assignment_history.sql:19-21`,
  `.../044_job_card_accountability_facts.sql:23-24`; DOM-005, `DECISIONS.md:576-601`).
  Immutability is application discipline plus the reconciliation check.

### 8.3 `stock_balances`

```sql
-- PROPOSAL
CREATE TABLE stock_balances (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  location_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  last_movement_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, location_id, product_id),
  FOREIGN KEY (organization_id, location_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products (organization_id, id),
  FOREIGN KEY (organization_id, last_movement_id)
    REFERENCES stock_movements (organization_id, id)
);
-- "Where is product X?" needs a product-first path; the PK is location-first.
CREATE INDEX stock_balances_product_idx
  ON stock_balances (organization_id, product_id, location_id);
-- Optional but useful: never show a zero-quantity row as stock.
-- (A zero row is kept, not deleted, so movement history keeps its last_movement link.)
```

The single balance-write primitive (inside the caller's transaction, per aggregated key):

```sql
-- PROPOSAL — never a bare upsert for a possibly-negative delta
INSERT INTO stock_balances (organization_id, location_id, product_id, quantity)
VALUES ($1, $2, $3, 0)
ON CONFLICT (organization_id, location_id, product_id) DO NOTHING;

UPDATE stock_balances
   SET quantity = quantity + $4,
       last_movement_id = $5,
       updated_at = NOW()
 WHERE organization_id = $1 AND location_id = $2 AND product_id = $3
   AND quantity + $4 >= 0
RETURNING quantity;
-- rowCount = 0  =>  409 INSUFFICIENT_STOCK (no exception, transaction stays usable)
```

Why not one statement: with `ON CONFLICT DO UPDATE ... WHERE quantity + delta >= 0`, the
*no-row-yet* branch inserts `delta` directly; a negative first delta then violates
`CHECK (quantity >= 0)` and aborts the transaction, which inside `runCriticalAction` means the
whole command fails with a 23514 instead of a clean 409. "Ensure zero, then conditionally update"
has one error-free failure path.

Why no `version` column: no client ever writes a balance, so there is no lost-update problem to
solve at the API level; the row lock is internal.

**Variant considered and rejected: snapshot + delta.** The third way to answer "how much is there"
is a periodic balance snapshot (for example end-of-month) plus the movements after it. It is the
right tool when as-of-date balances must be cheap and history is huge. Here it adds a second
derived artefact, a job that must run on schedule, and its own restore validation, while the
question it optimizes ("what was the balance on 2026-03-31?") is rare and answerable from the
ledger with one indexed range scan per `(location, product)`:
`SUM(quantity_delta) WHERE occurred_at < $date` over the proposed `stock_movements_board_idx`
(§8.2). Snapshot+delta is the natural escape hatch if a future reporting requirement makes
historical balances hot; it is not V1.

### 8.4 Reconciliation (restore validation)

```sql
-- PROPOSAL — ADMIN-only read, also the post-restore acceptance check
SELECT b.location_id, b.product_id, b.quantity, COALESCE(m.total, 0) AS movement_total
  FROM stock_balances b
  LEFT JOIN (
    SELECT location_id, product_id, SUM(quantity_delta) AS total
      FROM stock_movements
     WHERE organization_id = $1
     GROUP BY location_id, product_id
  ) m ON m.location_id = b.location_id AND m.product_id = b.product_id
 WHERE b.organization_id = $1
   AND b.quantity <> COALESCE(m.total, 0);
```

Plus the reverse direction (a movement key without a balance row) via
`FULL OUTER JOIN` on the same aggregation. Expected result after restore: zero rows.

### 8.5 `stock_transfers`, `stock_counts`, `stock_count_lines` (the narrow part of option C)

```sql
-- PROPOSAL
CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- equals movement_group_id
  organization_id UUID NOT NULL REFERENCES organizations(id),
  from_location_id UUID NOT NULL,
  to_location_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL CHECK (isfinite(occurred_at)),
  note TEXT,
  actor_user_id UUID NOT NULL,
  reversal_of_transfer_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, from_location_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, to_location_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, reversal_of_transfer_id)
    REFERENCES stock_transfers (organization_id, id),
  CONSTRAINT stock_transfers_distinct_locations_check
    CHECK (from_location_id <> to_location_id)
);

CREATE TABLE stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- equals movement_group_id
  organization_id UUID NOT NULL REFERENCES organizations(id),
  location_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL CHECK (isfinite(occurred_at)),
  note TEXT,
  counted_by_user_id UUID NOT NULL,
  is_opening BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, location_id)
    REFERENCES stock_locations (organization_id, id),
  FOREIGN KEY (organization_id, counted_by_user_id) REFERENCES users (organization_id, id)
);

CREATE TABLE stock_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  count_id UUID NOT NULL,
  product_id UUID NOT NULL,
  system_quantity INTEGER NOT NULL CHECK (system_quantity BETWEEN 0 AND 999999999),
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity BETWEEN 0 AND 999999999),
  difference INTEGER NOT NULL,
  movement_id UUID,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, count_id, product_id),
  FOREIGN KEY (organization_id, count_id)
    REFERENCES stock_counts (organization_id, id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products (organization_id, id),
  FOREIGN KEY (organization_id, movement_id)
    REFERENCES stock_movements (organization_id, id),
  CONSTRAINT stock_count_lines_difference_check
    CHECK (difference = counted_quantity - system_quantity),
  CONSTRAINT stock_count_lines_movement_check
    CHECK ((difference = 0) = (movement_id IS NULL))
);
```

`difference` could be `GENERATED ALWAYS AS (counted_quantity - system_quantity) STORED`
(legal: the expression references only same-row columns; PostgreSQL 17 `sql-createtable`, accessed
2026-11-26: "The generation expression can refer to other columns in the table, but not other
generated columns"). A plain column + CHECK is recommended because the repo has no generated
columns today and one fewer new mechanism is one fewer surprise.

Two equalities cannot be expressed in DDL and must be service-enforced with tests:

1. `stock_movements.movement_group_id = stock_transfers.id` / `= stock_counts.id` for the
   corresponding kinds (a CHECK cannot reference another table).
2. `stock_counts.is_opening = TRUE ⇒ every line's system_quantity = 0`.

### 8.6 Deferred tables (V1.1, not in the first migration)

| Table | Purpose | Why deferred |
| --- | --- | --- |
| `warehouse_product_policies` | `(organization_id, product_id) → tracking_policy IN ('NONE','LOT','SERIAL','LOT_AND_SERIAL')` | V1 enforces `NONE` only; a table plus a policy that is always `NONE` is dead flexibility |
| `stock_lots` | Lot identity per product, expiry, supplier reference | Only meaningful with lot-level balances |
| `stock_serials` | One row per serial unit with current location | Only meaningful with serial tracking |
| `stock_receipts` | Purchase/receipt header | No purchase or supplier document exists in the product yet |

---

## 9. Idempotency, concurrency and audit

### 9.1 The machinery that already exists

| Mechanism | Behaviour | Evidence |
| --- | --- | --- |
| `processed_actions` receipt | `UNIQUE (organization_id, user_id, client_action_id, operation_key)`; claim before side effects; completed duplicate replays the stored body | `server/src/db/migrations/002_delivery_tracer.sql:196-216`; `server/src/db/critical-action.ts:158-208` |
| Request identity | `request_hash` (`^[0-9a-f]{64}$`) makes "same key, different intent" a `409 CLIENT_ACTION_REUSED` | `server/src/db/migrations/036_job_card_invalidated.sql:130-133`; `server/src/db/critical-action.ts:42-53` |
| Retryable conflict | `40P01`/`40001` ⇒ `409 ACTION_IN_PROGRESS`, identical request may be retried | `server/src/db/critical-action.ts:56-72`; `SERVORA_MED_API_DRAFT.md:157-158` |
| Lifecycle reservation | `job_card_lifecycle_intents` `PENDING→COMPLETED/FAILED` with a 60 s budget, finalized in the same transaction as the receipt | `server/src/db/migrations/049_job_card_lifecycle_intents.sql:6-57`; completion at `server/src/modules/job-cards/repository.ts:5800-5807` |
| Lock order | `users → customers → contacts → products → job_cards`, stable UUID order inside a type | `DECISIONS.md:517-518`; `server/src/modules/job-cards/service.ts:2770-2782`; `server/src/modules/job-cards/assignee-lock.ts:28-42` |

### 9.2 Per-command contract

`PROPOSAL`

| Command | `clientActionId` | `operationKey` | Hash identity (normalized) | Independent business key |
| --- | --- | --- | --- | --- |
| Create/update/deactivate location | No (reference data) | — | — | `UNIQUE (organization_id, code)` |
| Update `warehouse_settings` | No (reference data) | — | — | singleton `UNIQUE (organization_id)` |
| Receipt | Required | `STOCK_RECEIPT` | location, `occurred_at`, sorted lines | `UNIQUE (org, movement_group_id, sequence_in_group)` |
| Transfer | Required | `STOCK_TRANSFER` | from, to, `occurred_at`, sorted lines, `reversal_of_transfer_id` | one `OUT` + one `IN` per group |
| Count post | Required | `STOCK_COUNT_POST` | location, `occurred_at`, sorted counted lines | `UNIQUE (org, count_id, product_id)` |
| Return in | Required | `STOCK_RETURN_IN` | location, `occurred_at`, lines, customer id | group sequence |
| Reverse a movement/group | Required | `STOCK_REVERSE` | target id, reason code, `occurred_at` | `UNIQUE (org, reversal_of_movement_id) WHERE movement_kind='REVERSAL'` |
| Delivery issue at approval | **No own key** | — | — | `UNIQUE (org, source_id, movement_kind) WHERE source_type='JOB_CARD_DELIVERY'` |

The two reference-data rows (location, settings) follow ARC-001's rule that ordinary reference-data
updates do not use response-caching idempotency by default (`DECISIONS.md:393`); their protection
is the unique constraint plus the version/audit rules of §9.4.

The last row is the important one. The delivery-driven issue is **not** an independent command:

- It runs inside the JobCard `APPROVE` transaction, whose receipt is the existing
  `JOB_APPROVE:<jobCardId>` operation (`DECISIONS.md:2104-2147`, SALE-002 "one transaction, two
  intents"). Giving it its own `clientActionId` would allow the stock issue to commit while the
  approval failed, or vice versa.
- The `UNIQUE (org, source_id, movement_kind)` index is the second, receipt-independent guard: even
  a future repair job, a re-run or a manual SQL fix cannot post the same delivery item twice.
- The approval path must reject an insufficient balance **before** mutating the JobCard, because a
  failed approval must leave no version bump (the existing `40001/40P01` retry contract survives,
  but a business rejection must not look like a transient conflict).
- Approved quantities come from `job_card_delivery_items` rows, which are not directly editable in
  `WAITING_APPROVAL` for `PRODUCT_DELIVERY` and become editable again only in `REVISION_REQUESTED`
  (`server/src/modules/job-cards/policy.ts:160,193-198`), so the item set read under the approval
  locks is the item set posted.
- DEMO data never posts stock, and the rule has two halves:
  - a delivery whose `data_class = 'DEMO'` is **skipped** (not rejected), because a demo approval
    must still work and the demo purge deletes `job_cards` and `job_card_delivery_items` and would
    be blocked by the warehouse FK (`server/src/modules/demo-data/repository.ts:411-480`);
  - every manual warehouse command (receipt, return, transfer, count) accepts only BUSINESS
    products, users and customers, mirroring SALE's `SALE_REFERENCE_NOT_ELIGIBLE`
    (`server/src/modules/job-cards/sale-service.ts:202,222`), so no warehouse row can ever
    reference a demo dataset.
  This is a V1 rule, not an optimization.

### 9.3 Proposed lock order extension

`PROPOSAL`

```
users → customers → contacts → products → job_cards → stock_locations → stock_balances
```

Rules that make it safe:

1. Users are always first (existing invariant, `server/src/modules/job-cards/service.ts:1019-1023`).
2. Stock rows are always after `job_cards`, because an approval writes stock.
3. A warehouse command that must read a JobCard (e.g. a reversal of a delivery-linked movement)
   takes the JobCard lock **before** any stock row, even if it only needs a read.
4. Balance rows are locked in deterministic `(location_id, product_id)` order; multi-line commands
   aggregate per key first, then update in that order.
5. Offboarding never locks stock rows (it uses a read-only port and rejects), which keeps the
   cross-module lock surface at zero (Open questions, Q6).

This order has to be added to ARC-003 by an amendment; until then it is a proposal that a reviewer
must accept before implementation.

### 9.4 Audit

`PROPOSAL`

| Change | Where it is recorded | Same transaction |
| --- | --- | --- |
| Stock movement / transfer / count | `stock_movements` (+ `stock_transfers` / `stock_counts`) | Yes — inside `runCriticalAction` |
| Delivery-driven issue | `stock_movements` + the JobCard `JOB_APPROVED` activity that already exists | Yes |
| Location created/renamed/deactivated | `audit_events`, subject `STOCK_LOCATION` | Yes |
| Warehouse settings changed | `audit_events`, subject `WAREHOUSE_SETTINGS` | Yes |
| Product tracking policy changed (V1.1) | `audit_events`, subject `WAREHOUSE_PRODUCT_POLICY` | Yes |

No `audit_events` row per movement: that would duplicate the ledger into a core table whose
`event_type` CHECK is a manually rewritten list
(`server/src/db/migrations/030_backup_domain_foundation.sql:222-245`,
`.../061_weekly_report_removal.sql:52-74`), and it would put stock vocabulary into core —
the exact coupling the module boundary exists to avoid. `AGENTS.md:129-131` requires mutations and
their audit/activity records to commit together; here the movement *is* that record.

The `audit_events` extension a migration would need (PROPOSAL, additive only):

```
subject_type  += 'STOCK_LOCATION', 'WAREHOUSE_SETTINGS', 'WAREHOUSE_PRODUCT_POLICY'
event_type    += 'STOCK_LOCATION_CREATED', 'STOCK_LOCATION_UPDATED',
                 'STOCK_LOCATION_DEACTIVATED', 'STOCK_LOCATION_REACTIVATED',
                 'WAREHOUSE_SETTINGS_UPDATED', 'WAREHOUSE_PRODUCT_POLICY_UPDATED'
```

Risk to name: the CHECK is one long literal list; a copy-paste omission silently forbids a
legitimate event until the next migration. The migration must re-list every existing value from
`server/src/db/migrations/061_weekly_report_removal.sql:52-74` plus later additions.

---

## 10. Integration with existing core behaviour

### 10.1 Module activation (MOD-002)

`TODAY`

| Fact | Evidence |
| --- | --- |
| The module registry is a compile-time list with literal types for one module | `server/src/modules/installation-modules/registry.ts:7-24` |
| Runtime state is one typed row per module key, CHECKed in the database | `server/src/db/migrations/074_installation_operator_and_module_state.sql:52-60` |
| Module state unreadable ⇒ module API answers `503`, no env fallback | `DECISIONS.md:3774-3777` |

`PROPOSAL` prerequisites for this module (small, but they must be authorized):

1. Widen `InstallationModuleDescriptor` (`server/src/modules/installation-modules/registry.ts:8-14`): `key`, `capability` and
   `legacyEnvKey` are single-value literal types today, so a second module cannot be added without
   generalizing them (`legacyEnvKey` must become nullable — a brand-new module has no legacy env
   key).
2. Add `'WAREHOUSE'` to `installation_module_state.module_key` CHECK (migration).
3. Add `warehouse: boolean` to `AuthenticatedCapabilities`
   (`server/src/modules/capabilities/types.ts`) and gate the routes at request time.
4. Warehouse routes stay registered and fail closed, following the Overview pilot.

### 10.2 Offboarding, permanent delete, demo purge

`TODAY`

| Fact | Evidence |
| --- | --- |
| Offboarding plan covers jobs, customers, calendar, follow-ups, reminders, conversations — no extension point | `server/src/modules/people/offboarding.ts:76-110` |
| Offboarding writes core tables directly (the research report counted 21 tables) | `docs/backlog/2026-11-25-core-modules-architecture-research.md:42` (V5) |
| Permanent delete is blocked by a hand-written list of `EXISTS` subqueries | `server/src/modules/people/repository.ts:157-315` |
| Technical audit actors can be detached to a snapshot instead of blocking delete | `server/src/modules/people/repository.ts:425-437`; `.../migrations/035_demo_data_purge_foundation.sql:17-37` |
| Demo purge pre-checks a hand-written list of user-referencing tables | `server/src/modules/demo-data/repository.ts:596-650` |

`PROPOSAL`

| Situation | Behaviour | Mechanism |
| --- | --- | --- |
| Staff member never used stock | No vehicle location row exists, nothing blocks | Lazy creation (D1) |
| Staff member has an (empty or used) vehicle location | Permanent delete answers `409 USER_PERMANENT_DELETE_BLOCKED` with `HAS_BUSINESS_HISTORY` | One `EXISTS` on `stock_locations.owner_user_id` added to `inspectUserDeletion` |
| Staff member has any movement as actor | Same blocker | One `EXISTS` on `stock_movements.actor_user_id` |
| Vehicle holds stock and offboarding is confirmed | `409 VEHICLE_STOCK_NOT_EMPTY` with the non-empty lines | Offboarding preview shows the blocker through a narrow read port; a manager performs a vehicle→depot transfer first |
| Offboarding succeeds | The vehicle location is deactivated in the same transaction through the same port | Deactivation, never deletion |
| Demo purge | No warehouse rows can reference demo users, because DEMO deliveries post no stock and receipts/transfers are BUSINESS-only | §9.2 last bullet |

The port direction matters: core **reads** warehouse state to block, and calls one warehouse
command to deactivate a location. Core never inserts a movement and never updates a balance. That
is the same shape the research report calls the correct pattern (a module-owned port used by
people, `docs/backlog/2026-11-25-core-modules-architecture-research.md:164-168`), and it revives it
for a read instead of adding a 22nd hand-written table write.

Plain offboarding (not deletion) is the common case and needs no special FK handling: deactivation
sets `users.is_active = FALSE` and keeps the row (`server/src/modules/people/service.ts:250-254,
257-262`), so `stock_locations.owner_user_id` and `stock_movements.actor_user_id` remain valid
references and the history keeps its attribution. Offboarding's own acceptance idea — "staff
offboarding keeps history" — therefore reduces to two things: block when the car still holds stock,
and deactivate the location.

Residual risk, stated honestly: the blocker is read inside the offboarding transaction without
locking the warehouse row, so a stock movement that commits in the same instant could leave stock
in a deactivated vehicle. The result is not corruption (the balance stays, the location is
inactive and shows up in the exception list), but it is possible. Closing it would require a
cross-module lock, which this proposal deliberately avoids.

### 10.3 Reports

`TODAY`: reports compose one read-only `REPEATABLE READ` snapshot and receive ports that accept a
`SqlExecutor` (`server/src/modules/reports/read-snapshot.ts:24-31`,
`server/src/modules/reports/ports.ts:1-37`).

`PROPOSAL`: the module exposes a `WarehouseStockPort` with `SqlExecutor`-based reads
(`onHandByLocation`, `onHandByProduct`, `movementsForJob`) so a stock section on an operations
report observes exactly the same snapshot as the rest of the report. Stock is never mixed into
delivery quantity reports: `DECISIONS.md:631-643` fixes delivery reporting semantics, and MOD-001
forbids Core from producing stock numbers.

---

## 11. Answers to the remaining brief questions

| Question | Answer | Kind |
| --- | --- | --- |
| What unit does stock use? | Whole product count (`INTEGER`), identical to SALE/DELIVERY counting. Catalog `unit` is display metadata snapshotted on the movement, never a conversion factor and never summed across products | PROPOSAL following F8/F9 |
| Is a separate base-unit per product needed? | No. It would contradict DOM-004 and SALE-QTY-001, and measured goods need a new accepted decision | — |
| Negative stock policy | Deny. `CHECK (quantity >= 0)` + conditional update + `409 INSUFFICIENT_STOCK`. An ALLOW mode is a later decision with an explicit per-deployment switch | PROPOSAL |
| Tracking policy per product | `NONE` only in V1; `LOT`/`SERIAL`/`LOT_AND_SERIAL` are schema-ready but unimplemented (V1.1) | PROPOSAL |
| Stock valuation / cost | Explicitly out of scope. No unit cost, no FIFO/average, no inventory value; `products.default_price` is informational and must not be used to value stock | ACCEPTED (`DECISIONS.md:549-552`, `DECISIONS.md:2032-2041`) |
| Partial deliveries | Unchanged open research topic; stock deducts per approved delivery item exactly once | ACCEPTED (`DECISIONS.md:2155-2157`) |
| Consignment stock at a customer | Out of V1; would need a `CONSIGNMENT_AT_CUSTOMER` location type and a decision | PROPOSAL |
| Warehouses in an external ERP | Out of V1; `warehouse_settings.stock_authority` records that Servora is the authority | ACCEPTED (`DECISIONS.md:2026-2031`) + PROPOSAL |
| Vehicle→vehicle transfer | Allowed (staff handover) | PROPOSAL |
| Pool car without a single owner | Not modelled in V1; a pool car needs its own decision (a vehicle location requires an owner) | PROPOSAL |

---

## 12. Recommended V1 subset

`PROPOSAL` — ordered slices, each independently verifiable.

| Slice | Content | Acceptance |
| --- | --- | --- |
| W1 | Migration (7 tables + audit vocabulary + `module_key` CHECK), location ADMIN CRUD, settings singleton, module capability, registry widening | A second module key can be enabled/disabled; a duplicate location code is rejected; every config change has an `audit_events` row in the same transaction |
| W2 | Stock board read (per location, per product, search, zero-stock toggle) + opening count | Posting an opening count creates exactly one `OPENING` movement and one balance per counted line with a non-zero count; repeating the command with the same `clientActionId` creates no second movement |
| W3 | Transfers (4 directions) + negative-stock rejection | A transfer creates exactly 2 legs; insufficient stock answers `409 INSUFFICIENT_STOCK` and writes nothing; concurrent opposite transfers never produce a negative balance |
| W4 | Delivery-driven issue at approval | Approved delivery posts one `ISSUE` per item from the chosen location; a repeated approval creates no second movement; insufficient stock blocks approval with no version bump |
| W5 | Returns (customer→vehicle/depot) and reversal of any movement/group | A reversal references the original and cannot itself be reversed twice; the board shows the net effect |
| W6 | Reconciliation read + invalidated-delivery exception list | Post-restore reconciliation is zero rows; a delivery invalidated after approval appears in the exception list until reversed |

Explicitly **not** in V1: reservations, lot/serial balances, tracking policies, expiry alerts,
consignment locations, ERP integration, document numbering/printing, negative-stock ALLOW,
stock valuation, pool cars, partial deliveries, transfer "in transit" state, multi-session count
drafts.

The V1 outcome is deliberately small: a staff member can see what is in the depot and in their car,
a manager can move stock between them, an approved delivery deducts exactly once, and every number
can be explained by a list of movements.

---

## Open questions for the owner

1. **Storage shape: A (ledger only), B (ledger + balance table), or C (voucher documents)?**
   Options: A — simplest, no drift, but the negative-stock gate becomes a lock protocol and board
   reads grow with history. B — ledger truth plus a same-transaction balance and a reconciliation
   check. C — ERP-shaped documents with numbering and posting states, 5–7 tables.
   **Recommendation: B**, plus an immutable header only for transfers and counts (the narrow part
   of C). Reasons: the guard is one `UPDATE ... WHERE` that no future writer can bypass, reads are
   constant-time, and the cache is provably reconstructible.

2. **Do we ship an ALLOW-negative mode?**
   Options: (a) block everywhere in V1; (b) per-depot flag `BLOCK|ALLOW`; (c) allow negative on
   vehicles only. **Recommendation: (a).** A blocked approval is visible immediately and fixable
   with a transfer; silent negative stock destroys trust in every number on the board. Revisit only
   if the pilot reports blocked field work.

3. **What does a `PRODUCT_DELIVERY` item with purpose `RETURN` mean for stock?**
   Options: (a) outbound `ISSUE` — a replacement/return handed to the customer; (b) inbound
   `RETURN_IN` — the customer gave goods back. DOM-001 frames all five purposes as "a product left
   with a customer" (`DECISIONS.md:347-352`), which points to (a).
   **Recommendation: (a)**, and model customer returns as a separate warehouse command, not as a
   delivery purpose. This must be confirmed before W4, or stock will be wrong in one direction.

4. **Which location does an approved delivery deduct from?**
   Options: (a) the assigned staff member's vehicle, always; (b) a location chosen by the approving
   manager, defaulting to the vehicle; (c) the default depot, always.
   **Recommendation: (b)** — direct depot shipments are a real case, and the approve dialog is
   already the manager's decision point (`DECISIONS.md:2152-2157`).

5. **Do we need reservations before the first field season?**
   Options: (a) none, with an availability hint and an approval-time gate; (b) reserve on approved
   sales; (c) reserve on scheduled deliveries. **Recommendation: (a)**, revisit with evidence of
   real double-promising.

6. **Offboarding with stock in a vehicle: block or auto-transfer?**
   Options: (a) block with `VEHICLE_STOCK_NOT_EMPTY` until a manager transfers it; (b) fold a
   vehicle→depot transfer into the offboarding transaction as a second intent (SALE-002 pattern).
   **Recommendation: (a)** for V1 — no cross-module lock, no second receipt inside one command,
   and the transfer gets its own audit and idempotency key. (b) is the natural later refinement.

7. **Opening balance: count or receipt?**
   Options: (a) `OPENING` count from zero; (b) a synthetic "açılış girişi" receipt.
   **Recommendation: (a)**. A receipt implies a supplier and a purchase document that do not exist;
   a count is exactly what physically happens on day one.

8. **Vehicle location: lazy or one per staff member?**
   Options: (a) lazy on first stock use; (b) created for every staff member at enablement.
   **Recommendation: (a)**, because (b) creates a permanent-delete blocker for people who never
   touched stock and pollutes the location list.

9. **Do we add lot-level balances in V1?**
   Options: (a) attributes only, no lot balances; (b) full lot balances with per-product policy;
   (c) serial-level tracking. **Recommendation: (a)** — `PRODUCT_REQUIREMENTS.md:285` keeps
   lot/serial/expiry optional and policy-free, and enforcing them is a new product rule. Design the
   nullable `lot_id` seam now, implement in V1.1 if SKT compliance becomes a sales requirement.

10. **Where does the movement history live for the user — a separate "Hareketler" screen, or on
    the product and location detail pages?**
    Options: (a) one filterable ledger screen (location, product, date, kind, actor);
    (b) contextual lists only. **Recommendation: (a) plus contextual links** — warehouse staff
    reconcile by scanning a filtered list, and hiding it makes every dispute a support ticket.

---

## Unverified / gaps

- **No benchmark was run.** All statements about read cost ("constant-time", "grows with history")
  are structural reasoning, not measurements. No build, migration, server or test was executed in
  this task (the brief forbids it). **UNVERIFIED**: actual `SUM` cost at realistic row counts.
- **Turkish ERP voucher practice is not verified against a product document.** The claim that
  Turkish ERPs model stock as numbered vouchers (giriş/çıkış/transfer/sayım) comes from this task's
  brief and general domain context, not from a cited Logo/Netsis/Mikro document. **UNVERIFIED**.
- **Database documentation drift:** `SERVORA_MED_SCHEMA_DRAFT.md:18` says "PostgreSQL 16 or newer"
  while `AGENTS.md:264-266` and `docs/operations/local-test-environment.md:143-149` require 17. The
  `UNIQUE NULLS NOT DISTINCT` and generated-column statements above assume 17 (both exist since
  15, so the design is safe either way).
- **`stock_authority` with a single allowed value** (`CHECK (stock_authority IN ('SERVORA'))`) is a
  judgment call. It records MOD-001's requirement that the mode is explicit, but a reviewer could
  reasonably call it dead flexibility. The alternative is to omit the column and treat "module
  enabled" as "Servora is the authority".
- **Offboarding race:** the vehicle-stock blocker is read without a stock-row lock (§10.2). The
  window is small and the outcome is an exception, not corruption, but it is not closed.
- **Demo data:** the "DEMO deliveries post no stock / manual commands are BUSINESS-only" rule is my
  proposal; it is not in any accepted document, and the demo purge's table list
  (`server/src/modules/demo-data/repository.ts:596-650`) will need a review when the module lands.
- **Workload on `products`:** `stock_movements.product_id` and `stock_balances.product_id` add two
  more FKs to `products`. No product delete path exists outside the demo purge, but the purge and
  permanent-delete enumerations were not exhaustively re-read for products in this task.
- **`expiry_date` semantics:** the delivery path normalizes a date-only string
  (`server/src/modules/job-cards/delivery-input.ts:5-20`), including unpadded input. Whether the
  warehouse copies the normalized value or the raw text was not decided here; copying the
  normalized value is the only consistent option, but it is a proposal.
- **Line-number citations** were taken from the working tree at this run's checkout
  (`warehouse-module-research-0e4def`). If the branch moves, the numbers drift; the quoted text is
  the durable part.
