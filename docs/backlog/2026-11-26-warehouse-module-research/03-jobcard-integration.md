# 03 — JobCard ↔ Warehouse integration: how a delivery produces or consumes stock

> **Historical research only.** The owner-approved [README §§A–E](README.md) supersedes unconditional reversal, assignee-only source inference, unqualified approval-time posting and the re-enable/no-reconciliation assumptions in this document. Invalidation is not physical return; preserve stock until a verified correction or actual return. Readiness and count coverage must be verified before authoritative posting.


Status: **research / design proposal only.** Nothing is implemented. No decision is made
by this document. `AGENTS.md` §13 still forbids a full Warehouse module without explicit
owner approval.

Scope: how `PRODUCT_DELIVERY` and `SALE` JobCards would produce or consume a stock
movement while Core keeps no stock state (MOD-001 §1), and what happens when the
Warehouse module is enabled or disabled mid-life.

Base: worktree `warehouse-module-research-0e4def`, HEAD `89bf6b1`, clean tree except the
untracked research folder. `server/src/modules/job-cards/` = 28,052 lines (`service.ts`
9,489, `repository.ts` 7,485).

Sibling documents in this folder were written in parallel and the domain model is owned
by [`02-domain-model-options.md`](02-domain-model-options.md). Where this document and 02
disagree, §13 says so explicitly; this document does not silently overrule it.

Labels: **(CODE)** observed implementation · **(DECISION)** accepted record ·
**(PROPOSAL)** mine, not decided · **(CONFLICT)** accepted text that a proposal would
need amended.

---

## Özet (TR)

- Çekirdekte stok, depo, araç veya hareket kavramı **yok**; `server/src` ve `web/src`
  içinde `stock|warehouse|depot|vehicle` geçen tek satır bulunmuyor (rg, exit 1).
- Teslimat kalemi zaten `lot_no`, `serial_no`, `expiry_date` taşıyor
  (`002_delivery_tracer.sql:150-152`, `job-cards/types.ts:809-811`). Lot/seri için
  çekirdeğe **yeni alan gerekmiyor**.
- Fiziksel teslim anı `delivered_at`; ama stok düşecek tek güvenilir an **yönetici onayı
  (`COMPLETED`)**: kalemler submit'te donuyor (`policy.ts:160`) ve raporlar da
  `COMPLETED` + `manager_approved_at` üzerinden okuyor (`reports/repository.ts:893-896`).
- Önerilen mekanizma: onay transaction'ı içinde **senkron port**. Aynı süreç, aynı havuz,
  aynı transaction; outbox/kuyruk ilk sürüm için gereksiz (MOD-001 §4). Çekirdeğin
  **zorunlu tek entegrasyon noktası** onaydır (`APPROVE`); geçersizleştirme düzeltmesi
  isteğe bağlı ikinci noktadır (§9.4, §13 D2). Revizyon, geri çekme ve iptal hiçbir
  hareket üretmez; onaydan önce zaten hiçbir şey yazılmamıştır.
- Geçersizleştirme: önerim, tamamlanmış kartın ADMIN geçersizleştirmesinde **telafi
  hareketinin aynı transaction'da** yazılması. Alternatif (02 §12 W6) "istisna listesi +
  açık `STOCK_REVERSE`" — §13'te ayrı duruyor.
- Yetersiz stok: **onay 409 ile bloklanır** (02 §6/OQ-2 ile aynı yön). Şart: yönetici
  kendi stoğa giriş/transfer yapabilmeli; aksi halde blok personeli rehin alır.
- Araç/depo seçimi Warehouse'a aittir (MOD-001 §2); çekirdeğe "stok yeri" alanı
  **eklenmez**. Kaynak, onay anındaki `assigned_to`'nun aracı; yönetici isterse modülün
  kendi ekranından değiştirir.
- "Eski teslimatlar kendiliğinden düşmez" kuralı **kesim tarihi olmadan** yapısal olarak
  korunur: düşme yalnızca onay anında olur. Kapalıyken onaylananlar "gönderilmemiş"
  listesinde görünür; yeniden açılışta **otomatik geri doldurma yok**.
- İade: `RETURN` teslimatı bugün stok hareketi üretemez (`PRODUCT_REQUIREMENTS.md:283`,
  `DECISIONS.md:351`). 02 OQ-3 doğru çözümü veriyor: `RETURN`'ı **çıkış** say,
  müşteri iadesini ayrı bir depo komutu yap — DOM-001 değişmez.
- Core'daki en somut engel modül kaydının **tek modüllük** olması
  `installation-modules/registry.ts:7-24`, `installation-modules/takeover.ts:22,29`, migration 074'teki iki CHECK).

---

## 0. Baseline: what exists today (CODE)

| # | Fact | Evidence |
| - | ---- | -------- |
| B1 | No stock/depot/vehicle/warehouse concept exists in application code or migrations. | `rg -n -i "\b(stock\|warehouse\|depot\|vehicle)\b" server/src web/src` → exit 1; same for `server/src/db/migrations/*.sql` |
| B2 | JobCard types are `PRODUCT_DELIVERY`, `GENERAL_TASK`, `SALES_MEETING`, `WEEKLY_REPORT`, `SALE`. No return/pickup type. | `job-cards/types.ts:29` |
| B3 | Delivery purposes are `SALE`, `SAMPLE`, `CONSIGNMENT`, `RETURN`, `OTHER`, stored per line. | `job-cards/types.ts:302-303`; `002_delivery_tracer.sql:142-143` |
| B4 | Delivery lines already carry optional `lot_no`, `serial_no`, `expiry_date` — free text / date, no uniqueness, no tracking flag. | `002_delivery_tracer.sql:150-152`; `job-cards/types.ts:809-811`; `job-cards/service.ts:555-565`; `SERVORA_MED_SCHEMA_DRAFT.md:378-380` |
| B5 | `delivered_at` is nullable since migration 009; planned lines are created with `deliveredAt: null`. | `009_job_acceptance_and_scheduling.sql:42-45`; `job-cards/service.ts:2744,2759` |
| B6 | Submission requires **every** line to have a valid `delivered_at` and `quantity > 0`. | `job-cards/submission-policy.ts:74-88`; `PRODUCT_REQUIREMENTS.md:265-273` |
| B7 | Actual delivery time may only be written in `IN_PROGRESS` / `REVISION_REQUESTED`. | `job-cards/policy.ts:193-198,384-385`; `service.ts:4549-4551,4595-4598` |
| B8 | `WAITING_APPROVAL` content is read-only for everyone, so the approved lines are frozen. | `job-cards/policy.ts:160`; `DECISIONS.md:757-761` (JOB-004 §1) |
| B9 | `manager_approved_at/by/note` are written by the same statement that sets `COMPLETED`. | `repository.ts:3530-3532`; `service.ts:6233,7447-7449` |
| B10 | Terminal = `COMPLETED`, `CANCELLED`, `INVALIDATED`; terminal blocks every normal command but **not** ADMIN `invalidate`. | `policy.ts:42-44,403`; `service.ts:1623-1807` |
| B11 | Reports count only `status='COMPLETED' AND manager_approved_at IS NOT NULL`, grouped by `delivered_at`. | `reports/repository.ts:893-896,1720-1732`; `DECISIONS.md:633-638` |
| B12 | Delivery report quantities are per line and positive; `RETURN` is never netted. | `DECISIONS.md:637-638` |
| B13 | Sale approval may create **exactly one** delivery, planned, linked by `job_cards.delivery_source_sale_id`; no partial deliveries, no remaining-quantity tracking. | `service.ts:2814-2937`; `071_sale_standalone_and_delivery_link.sql:26-43`; `DECISIONS.md:2148-2155` |
| B14 | Sale-linked delivery items are freely editable at approval time, so they need not equal the sale lines. | `DECISIONS.md:2150-2153`; `sale-approval-delivery-input.ts:67-97` |
| B15 | A pair is only `SALES_MEETING` + `SALE`; a `PRODUCT_DELIVERY` can never be a pair participant. | `service.ts:6384-6414` (pair branch needs a live sale on a meeting anchor) |
| B16 | `delivered_at` accepts any parseable timestamp — no future bound, no lower bound. | `service.ts:522-532`; `submission-policy.ts:77-78` |
| B17 | Delivery-line patch/remove are **not** `clientActionId`-idempotent; only create is. They rely on `expectedVersion`. | `SERVORA_MED_API_DRAFT.md:1044-1052`; `service.ts:4532-4640` |
| B18 | Approval is one transaction with a documented lock order: users → customer → contacts → products → job_cards. | `service.ts:2766-2782`; ARC-003 `DECISIONS.md:495-533` |
| B19 | Product hard delete is blocked by a delivery/sale reference check. | `products/service.ts:215-228`; `products/repository.ts:91-99,168-177` |
| B20 | Demo-data purge knows its tables by name: the lock/delete plan lists ~35 tables and `assertNoTargetUserReferences` is a hand-written UNION over ~20. It also **deletes** `users` after that assertion. | `demo-data/repository.ts:405-470,480-491,596-640,887-894`; `demo-data/analyzer.ts:590-620` |
| B21 | Staff offboarding writes 21+ tables by hand and deactivates (never deletes) the `users` row. | `people/offboarding.ts:153,540-740`; research doc V5 `2026-11-25-…:42` |
| B22 | Module state is one typed row per installation-level module; DB CHECK `IN ('OVERVIEW')`; the registry type is single-module-shaped. | `074_installation_operator_and_module_state.sql:51-70,86-87`; `installation-modules/registry.ts:7-24`; `installation-modules/takeover.ts:22,29` |
| B23 | Fail-closed rule: unreadable module state ⇒ module API `503`, capability off, no env fallback. | `DECISIONS.md:3774-3775`; `installation-modules/state.ts:86-101`; `overview/service.ts:20-23` |

---

## 1. At which exact lifecycle moment does a delivery consume stock?

### 1.1 The four candidate moments against the code

| Moment | What the code has | Posting verdict |
| ------ | ----------------- | --------------- |
| **Planned** (`NEW`/`ACCEPTED`) | Lines exist with `deliveredAt = null` (B5). Nothing physical happened. | No quantity/date to post; lines change freely. |
| **Execution** (`IN_PROGRESS`) | Staff writes `deliveredAt`; the physical handover is recorded here (B7). The line can still be patched or deleted (B17) and the card revised, withdrawn or cancelled. | No — this is where "stock follows the van" would post, and exactly where every correction becomes a reversal. |
| **Submitted** (`WAITING_APPROVAL`) | Lines frozen (B8). No manager authority. Still revisable/cancellable; Staff cancellation is additionally gated by the assignment-window flag (`policy.ts:148-150`). | No. A staff claim is not an accepted business fact. |
| **Completed** (`APPROVE`) | `manager_approved_at` set in the same statement (B9); lines frozen since submit; terminal to every normal command (B10). | **Yes — the only posting point.** |

### 1.2 Why `COMPLETED` and not `deliveredAt`

The physical event and the accountable event are already separate in this codebase, and
the accepted reporting contract chose the accountable one: physical time is
`job_card_delivery_items.delivered_at`; accountable time is `manager_approved_at`, and
DOM-006 counts **only approved** quantities (B11).

Posting at `deliveredAt` would require a reversal for each ordinary path — line patched,
line removed, revision requested, withdrawn, cancelled, invalidated. Posting at
`COMPLETED` needs one reversal path (ADMIN invalidation), because the item set read under
the approval lock is the item set posted: nothing behind the approval can change it.

The cost is latency: goods leave the van before the manager approves. That is already the
product's accepted reporting posture, so alignment beats immediacy. The module should
therefore record the movement at the **approval instant** (`occurred_at`, matching
`02-domain-model-options.md` §8.2) and keep `source_id = delivery item id` for
traceability. Two reasons not to back-date the movement to `delivered_at`:

1. Back-dating re-opens the enablement question. An approval that happens after the module
   is enabled would post a movement dated before it, and every balance query needs an
   opening-balance/effective-date reconciliation (§5.2). Posting-dated movements need
   none of that.
2. `delivered_at` is unconstrained (B16): staff can enter a future timestamp, or a
   timestamp months in the past. A ledger that inherits that value inherits the problem.

The delivery date stays one join away (`source_id` → `job_card_delivery_items`), so no
information is lost.

### 1.3 Revision / withdraw / cancel / invalidation

| Command | Code path | Movement effect |
| ------- | --------- | --------------- |
| `REQUEST_REVISION` (`WAITING_APPROVAL → REVISION_REQUESTED`) | `service.ts:6261-6281` | None. Nothing was posted. |
| `WITHDRAW_FROM_APPROVAL` (`WAITING_APPROVAL → IN_PROGRESS`) | `service.ts:6282-6299` | None. |
| `CANCEL` (any non-terminal state) | `service.ts:6317-6326`; filter `policy.ts:144-150` | None. |
| `INVALIDATE` on `IN_PROGRESS` / `WAITING_APPROVAL` / `REVISION_REQUESTED` | `service.ts:1623-1807` | None. |
| `INVALIDATE` on `COMPLETED` | same, ADMIN only (B10) | **One compensating movement per original movement** (recommendation; see §13 D2 for the alternative). |

Reversal rules (PROPOSAL):

1. The original movement is **never** updated or deleted. The reversal is a new row with
   `reversal_of_movement_id`; both stay in history (same shape as 02 §7.1 `REVERSAL`).
2. Quantity = exact negation of the original. No partial reversal.
3. `occurred_at` = the invalidation instant (`requestTime`, `service.ts:1650`), not the
   original movement time: the stock was genuinely present until the record was corrected.
4. Reason = the `JOB_CARD_INVALIDATION_REASON_CODES` value (`job-cards/types.ts:16-18`)
   plus the invalidation note reference.
5. Idempotency: one `REVERSAL` per target movement
   (`UNIQUE (organization_id, source_id, movement_kind)` where `source_type='REVERSAL'`,
   02 §8.2). A second invalidation is refused anyway
   (`JOB_ALREADY_INVALIDATED`, `service.ts:1669-1671`).
6. The reversal is **not** a `RETURN` delivery. DOM-006 keeps `RETURN` positive and
   un-netted (`DECISIONS.md:637-638`); a correction is its own movement kind. DOM-001 and
   DOM-006 stay untouched.

A cancelled card that already recorded `delivered_at` leaves Core data behind with no
movement. That is a pre-existing Core gap (staff recorded a delivery, then the card was
cancelled), not something the Warehouse should invent a movement for. It shows up as "not
approved, not counted" in the delivery reports and is the operator's cue to post a
`COUNT_ADJUSTMENT` or `RECEIPT` if the goods really went out.

---

## 2. Integration mechanism options

### 2.1 The three candidates

| | (a) Synchronous in-transaction port | (b) Module-owned durable outbox | (c) Warehouse pulls approved deliveries by watermark |
| - | --- | --- | --- |
| **Atomicity** | Perfect: approval and movements commit or roll back together. | Eventual. Approval commits, movement retries later. | Eventual. Window = poll interval. |
| **Core coupling** | One optional dependency + one tx read + one call site (§9.4). | A writer in the approval tx + worker + cursor + DLQ. | Zero write coupling; module gets a read grant. |
| **Module failure while enabled** | Approval `503`; card stays `WAITING_APPROVAL`. | Approval always succeeds; divergence invisible until someone looks. | Approval always succeeds; divergence visible as lag. |
| **Module failure while disabled** | Port is a no-op; nothing written. | Rows accumulate for a module that is off and must be drained or dropped. | Nothing to drain. |
| **Idempotency** | Unique per delivery item inside the same tx. | Same key, but must survive redelivery and out-of-order create/reverse. | Same key; cursor gives cheap re-reads. |
| **Ordering** | Transaction order. | Must be defined; a reversal must not overtake its create. | Cursor order; reversal needs a second pass. |
| **Lock surface** | New last step in the approval lock order. | No new locks in Core. | No new locks in Core. |
| **Enablement / back-fill** | Free: nothing posts before an approval. | Ambiguous: a drained backlog looks like a back-fill. | Free: start the watermark at the enable instant. |
| **MOD-001 §4** | Allowed; a port is not a bus. | Allowed **only** with a real producer/consumer (`DECISIONS.md:2041-2050`). | Allowed; it is a read port. |
| **Fits this repo** | Yes — `JobHistoryReadPort`, `StaffOperationalSummaryPort`, `MessagingReadPort`, `CustomerAssignmentCleanupPort`. | No domain-level precedent. The web-push outbox is explicitly "not domain integration" (`DECISIONS.md:2049-2050`). | Partly — `reports` already reads `job_cards` directly (`reports/repository.ts:1720-1732`). |

### 2.2 Recommendation: (a), with (c) as the reconciliation view

**(PROPOSAL)** (a) for the write path, (c) as a read-only "unposted" view. Reasons:

1. **Single failure domain.** Warehouse lives in the same process and the same pool.
   "Warehouse is down" means "the database is down", in which case the approval could not
   commit either. (a) therefore adds almost no availability risk while buying exact
   atomicity.
2. **MOD-001 §2 demands one authority.** If an approval can commit without its movement,
   the module cannot claim to be the stock source of truth; someone reconciles forever.
3. **(b) is premature and it re-opens the enablement question.** A durable outbox needs a
   producer contract, a consumer, retry, monitoring and a drain policy for the disabled
   state — for a single in-process consumer. MOD-001 §4 allows it "when real
   Warehouse/Accounting integration starts"; V1 has no external consumer. A drained
   backlog is also indistinguishable from a back-fill, which weakens the one rule the
   acceptance criteria care about.
4. **(c) alone cannot be the stock authority**: it reports divergence instead of
   preventing it. It is the right shape for the operator's unposted list and for the
   disabled-period reconciliation, and it needs no writes while the module is off.

Rejected: posting from the web client, posting from a realtime event, computing stock as a
derived view over deliveries. All three either duplicate authority or lose corrections.

### 2.3 What (a) costs, concretely

- `JobCardService` gains one optional constructor dependency, following the existing
  `calendar`/`webPush`/`assignmentWindow` pattern (`service.ts:944-975`).
- One call site (`APPROVE`) and one new `JobCardTransaction` read, so the module never
  reads a Core table itself.
- A new last step in the approval lock order: balance rows locked `FOR UPDATE` in
  `(location_id, product_id)` order. This matches
  `02-domain-model-options.md` §9.3 (`… → job_cards → stock_locations → stock_balances`)
  and the rules that stock rows come after `job_cards` and are locked deterministically.
  Nothing else in the transaction takes stock locks, so no inversion is possible.
- A `503` path when the module is enabled and posting throws, plus a `409`
  business rejection for insufficient stock (§4). The two must be distinguishable: a
  business rejection must not look like a transient conflict. **Order matters**: the
  balance check must run **before** the JobCard mutation, so a rejected approval leaves no
  version bump (this is 02 §9.2's rule and it is easy to get wrong).

---

## 3. Source vehicle / depot, and lot/serial ownership

### 3.1 What identifies the source today

Nothing. Core has no location concept for goods (B1). What Core has at approval time is
`job_cards.assigned_to`, which is also the attribution subject (REPORT-002,
`DECISIONS.md:2164-2166`). Geo-location rows (`job_action_locations`,
`start-location-input.ts`) are GPS evidence of a person, not a stock location, and must
not be reused.

### 3.2 Recommendation (PROPOSAL)

| Question | Proposal | Why |
| -------- | -------- | --- |
| Who owns the location model? | `02-domain-model-options.md` §5: one `stock_locations` table with a `DEPOT`\|`VEHICLE` discriminator, vehicle `owner_user_id`, lazy creation, at most one active vehicle per owner. | MOD-001 §2 ("depots and vehicle stock") is module-owned (`DECISIONS.md:2022-2025`). This document does not redesign it. |
| Who picks the source? | Default: the delivery assignee's vehicle, resolved **at approval** from `job_cards.assigned_to`. A manager who needs a direct depot shipment changes the location in the module's own delivery panel **before** approving. | The assignee at completion is already the product's attribution rule; the choice is a stock decision, so it belongs to the module's surface, not to Core's approve body. |
| Does Core need a `stockLocation` field? | **No.** | A location id in `job_card_delivery_items` is module state in a Core table (MOD-001 §2) and goes stale on reassignment. The movement↔source-operation link is a Warehouse field by decision. |
| Does Core need an opaque location id in the approve body? | **No** under the recommended design. It becomes necessary only if the owner insists the choice happen inside the existing approve dialog; that is the alternative to reject unless it is asked for. | Keeps Core's API free of module ids. Divergence with `02…` OQ-4 option (b) is recorded in §13 D3. |
| Does submission readiness need a location item? | **No** new requirement code. | `evaluateDelivery` (`submission-policy.ts:58-98`) must stay free of module concepts; a missing vehicle is a configuration error, not a staff submission error. |
| Lot/serial: Core item or movement? | **Both, different roles.** Core keeps the staff-recorded optional value (already exists). The movement is the authoritative lot actually deducted; it copies the Core value when present and otherwise applies the module's lot policy (e.g. FEFO). | No Core schema change; provenance stays where it is. |
| Serial-level tracking? | Not in V1. | `serial_no` is optional free text with no uniqueness (B4), no tracking flags (`PRODUCT_REQUIREMENTS.md:287`), and 02 §12 excludes lot/serial balances from V1. |

Consequence: staff cannot correct a wrong vehicle from the Core delivery screen.
Corrections are a module transfer or a location change in the module panel. That is
deliberate: the correction belongs where the state lives.

---

## 4. Insufficient stock

### 4.1 Options

| Option | Effect on the field team | Effect on stock truth | Verdict |
| ------ | ------------------------ | --------------------- | ------- |
| **Block approval (`409 INSUFFICIENT_STOCK`)** | Manager cannot close a job until stock is corrected; work waits. | Balance never lies; someone must record the missing goods. | **Recommend**, with preconditions below. |
| Silent allow | Nothing visible. | Negative balance with no explanation. | Reject. |
| Allow negative + flag | Approval flows; operator cleans up later. | Honest signal, but nobody is forced to act, and a `quantity >= 0` balance table cannot even store it (02 §8.3). | Reject for V1. |

### 4.2 Recommendation (PROPOSAL)

Block, and make the block cheap to clear:

1. The module's balance-row guard is `UPDATE … WHERE quantity >= n` (02 §3.2 option B), so
   negative stock is unrepresentable. The same check runs **before** the JobCard mutation.
2. The manager sees exactly which product, which location, how much is needed and how much
   is there, plus the fix (a `RECEIPT` into that location or a `TRANSFER` from the depot).
3. **Precondition:** a MANAGER must be able to post that receipt/transfer without the
   installation operator. Without this, the block holds the field team hostage to someone
   else's availability and the recommendation should flip to allow-negative-on-vehicles.
4. **Precondition:** the location must have been counted at least once. Otherwise "0" means
   "never counted", not "empty" — see the gap in §13 D5. Until a count exists the approve
   error must say *"depo sayımı yapılmadı"*, not *"stok yetersiz"*.
5. What staff sees (advisory, never blocking): a read-only panel on the delivery screen fed
   by the module's own endpoint (`GET /api/warehouse/deliveries/:jobCardId/stock-advisory`),
   rendered only when `capabilities.warehouse` is true. Turkish copy:
   `"Araç stoğu: {productName} — istenen {n}, kayıtlı {m}. Onayda stok kontrolü yapılır."`
6. Demos never post (02 §9.2: a `data_class='DEMO'` delivery is skipped, not rejected), so
   the gate must not fire on demo cards.

Why the change of position: an earlier draft of this document recommended warn-and-allow.
The decisive counter-argument is that a `quantity >= 0` balance table makes negative stock
unrepresentable without weakening the invariant, and the same-transaction port makes the
gate atomic and cheap. The residual risk is operational, which is why preconditions 3 and
4 are part of the recommendation rather than footnotes.

---

## 5. Enable / disable / re-enable mid-life

### 5.1 "Old deliveries are not auto-deducted" is structural

Posting happens **only** at approval (§1). A delivery approved before the module was
enabled can never post: no code path walks history. The rule needs no remembered cutoff,
no migration flag, and no operator discipline — which is why it survives a bad deploy.

### 5.2 No cutoff timestamp is needed under posting-dated movements

A cutoff is only required when movements carry an *effective* date (e.g.
`effective_at = delivered_at`) that can precede enablement. With `occurred_at` = approval
instant (02 §8.2) and a balance defined as `SUM(quantity_delta)`, every posted movement is
after enablement by construction, and the opening count is the only setup step.

If a future design chooses effective dating, it inherits two extra requirements: a
`stock_cutoff_at` predicate, and a balance rule that also counts movements posted after the
count with an earlier effective date. That is a real complication, and it is avoidable.

### 5.3 Disable

| Concern | Rule (PROPOSAL) |
| ------- | --------------- |
| Pending movements | None — posting is synchronous (§2.2). |
| Open reservations | V1 has none (§6, 02 §6). If added later: frozen, not deleted, not honoured while disabled, re-validated on re-enable. |
| Data | Never deleted. Tables keep `organization_id`; FKs stay; nothing is archived away. |
| UI | Navigation entry and module routes disappear; `capabilities.warehouse` reports `false`. **The Core delivery detail must still render** — it is a Core page; only the module's panel is omitted. (Contrast: Overview 404s *its own* page, `docs/features/operator-module-pilot.md:156-159`; that precedent does not transfer to a panel inside a Core page.) |
| Reports | Core delivery reports are unaffected (they read Core tables, B11). Warehouse reports are unavailable. Core reports must **not** start joining module tables. |
| Approvals while off | Commit normally; no movement; no module row written. They surface afterwards in the unposted list (§5.4). |
| Reversals while off | The module command still works when the module is enabled again; while it is off there is no port call to make (see §13 D2). |
| Offboarding | Must work with the module off (`2026-11-25-…:200-207`); this design adds no Core dependency to offboarding (§8). |
| Restore | A restore rewinds module tables and `installation_module_state` together; operator sessions are reset (MOD-002 §6). 02 §8.4 owns restore reconciliation. |

### 5.4 Re-enable: no automatic back-fill

- Nothing is posted on enable. Not one row.
- The unposted list is a **read-only anti-join** the module runs against Core (option (c)):
  `type='PRODUCT_DELIVERY'`, `status='COMPLETED'`, `manager_approved_at IS NOT NULL`,
  `data_class='BUSINESS'`, with at least one line that has no `ISSUE` movement. Because it
  is derived it is always accurate, and it needs no writes while the module was off.
- Each unposted line is decided explicitly: **post an `ISSUE` now** (attributed to the
  person deciding, `occurred_at` = the decision instant — never back-dated to
  `delivered_at`) or **mark as not to be posted** (a module-owned decision row, audited).
  Never both, never automatic.
- This is the only path that can create a **delivery-linked** movement outside an approval,
  and it is always an explicit human decision.

---

## 6. SALE: reservation, or consume-only?

| Question | Accepted text | Consequence |
| -------- | ------------- | ----------- |
| Does a sale reserve stock? | SALE-002 §6: "At most one delivery per sale; no partial deliveries, no remaining-quantity tracking" (`DECISIONS.md:2154-2155`) | A reservation needs a remaining quantity, which the decision forbids tracking. |
| Do delivery lines match sale lines? | No: quantities adjustable, lines removable or added at approval (`DECISIONS.md:2150-2153`) | A sale-based reservation would not describe what actually leaves. |
| When is the delivery card created? | At sale approval, planned, `deliveredAt` NULL (B13) | Nothing physical happened; no movement. |
| What if the delivery is cancelled? | "A cancelled sale-linked delivery is not replaced automatically" (`DECISIONS.md:2179-2180`) | No movement, no automatic re-issue. |

**(PROPOSAL)** No sale-level reservation in V1 — same verdict as `02-domain-model-options.md`
§6, which lists the release matrix and the second-quantity cost. The delivery consumes; the
sale only explains why. A later "soft allocation" needs an amendment to SALE-002 §6 plus a
release rule for sale cancel / invalidate / delivery cancel (**CONFLICT-2**).

---

## 7. Returns from customers

| Question | Answer |
| -------- | ------ |
| Is there a RETURN / pickup JobCard type? | **No** (B2, `types.ts:29`). |
| How does a return enter today? | As an ordinary `PRODUCT_DELIVERY` with `delivery_purpose='RETURN'` and a positive quantity (`types.ts:302-303`; `DECISIONS.md:3463-3467`; un-netted per `DECISIONS.md:637-638`). |
| Does a `RETURN` delivery restock? | **Not allowed today.** `PRODUCT_REQUIREMENTS.md:283` and DOM-001 (`DECISIONS.md:351`): `CONSIGNMENT` and `RETURN` are operational classifications only and do not create or alter stock movements. |
| So what is the right model? | `02-domain-model-options.md` OQ-3: keep `RETURN` as an **outbound** `ISSUE` (a replacement, or a return handed *to* the customer — DOM-001 frames all five purposes as "a product left with a customer", `DECISIONS.md:345`), and model a **customer return** as a separate warehouse command (`RETURN_IN`) that is not a delivery purpose at all. |
| Why is that better than amending DOM-001? | It needs no amendment: the accepted product text stays literally true, and the module gains a return path with its own inspection/restock/scrap decision where it belongs. |
| What is still missing for a real return path? | Inspection outcome, restock vs scrap, expired/opened goods, and the destination rule (vehicle first, then depot, or depot directly). None of it exists. |

Recommendation: V1 posts `ISSUE` for every purpose including `RETURN`, and ships no
`RETURN_IN` command. `CONSIGNMENT` is excluded for a different reason: goods at a customer
are still ours, so an `ISSUE` understates the balance (it should be a transfer to a
consignment location, `02…` §5 defers that location type). If `CONSIGNMENT` deliveries must
be approvable in V1, they need their own decision before the gate of §4 applies to them.

---

## 8. Offboarding and the vehicle of a departing staff member

| Fact | Evidence |
| ---- | -------- |
| Offboarding deactivates the `users` row; it does not delete it. | `people/offboarding.ts:153`, `:540-740` |
| Active jobs are transferred or cancelled in the same transaction; `assigned_to` is rewritten. | `people/offboarding.ts:552-600` |
| It writes 21+ tables by hand; each new module breaks it. | research doc V5, `2026-11-25-…:42` |
| Offboarding must work while a module is off. | research doc §4 item 4, `2026-11-25-…:200-207` |

**(PROPOSAL)** No change to `people/offboarding.ts` in this slice — and this is a
cross-document divergence, see §13 D4.

- The `users` row survives, so a `VEHICLE` location owned by that user survives with its
  stock and history. Nothing is orphaned.
- The module shows "vehicle of an inactive user — N units in M products" and offers a
  transfer. This is a module action, audited in the module, the same pattern the research
  report calls correct for module-owned writes (`2026-11-25-…:164-169`).
- `02-domain-model-options.md` §10.2 goes further and proposes a **blocking** offboarding
  pre-check (`VEHICLE_STOCK_NOT_EMPTY`) plus a location-deactivation command, through a
  read-only port. That is defensible; it is also 02's slice to argue. The two positions and
  their trade-off are stated in §13 D4 so the lead can pick one.
- Neither position may change attribution: REPORT-002 keeps the assignee at completion
  (`DECISIONS.md:2164-2166`), so transferring a vehicle never rewrites delivery history.

---

## 9. Recommended path

### 9.1 One-line statement

An approved `PRODUCT_DELIVERY` posts one `ISSUE` per delivery line, inside the approval
transaction, out of the delivery assignee's vehicle location; the Warehouse owns the
quantity, the movement, the link to the line and the correction. Core never stores a
balance, and its only mandatory integration point is the approval; the invalidation
correction in §9.4 is the one optional addition.

### 9.2 Sequence — normal path

```mermaid
sequenceDiagram
    autonumber
    actor S as Staff (assignee)
    actor M as Manager
    participant JC as job-cards.Service
    participant TX as PostgreSQL transaction
    participant WH as Warehouse posting port
    participant DB as warehouse tables

    Note over S,JC: Planned
    S->>JC: POST /api/job-cards (PRODUCT_DELIVERY + items)
    JC->>TX: create card + lines (delivered_at NULL)
    Note over JC: no warehouse call

    Note over S,JC: Execution (IN_PROGRESS / REVISION_REQUESTED)
    S->>JC: PATCH delivery-item (deliveredAt, quantity, lotNo…)
    JC->>TX: update line, bump job version
    Note over JC: no warehouse call (line is still editable)

    Note over S,JC: Submit (WAITING_APPROVAL)
    S->>JC: POST /:id/submit-for-approval
    JC->>TX: readiness requires delivered_at on every line
    S-->>WH: GET stock-advisory (module API, only if capability on)
    WH-->>S: kayıtlı / istenen (advisory only)
    JC->>TX: status = WAITING_APPROVAL, lines frozen

    Note over M,DB: Approve (COMPLETED) — the only posting point
    M->>JC: POST /:id/approve
    JC->>TX: BEGIN; lock users → customer → products → job_cards
    JC->>JC: read lines under the lock (immutable since submit)
    JC->>WH: precheckDeliveryStock(client, assignee, lines)
    alt insufficient stock
        WH-->>JC: 409 INSUFFICIENT_STOCK (product, needed, on hand)
        JC->>TX: ROLLBACK — no version bump, no movement
    else ok, or DEMO card (skipped)
        JC->>TX: transitionWithVersion(APPROVE) → COMPLETED + manager_approved_at
        JC->>WH: postApprovedDelivery(client, lines, actor, approvedAt)
        WH->>TX: read installation_module_state('WAREHOUSE') in-tx (no cache)
        WH->>WH: resolve location (assignee vehicle → module-chosen override)
        WH->>DB: SELECT … FOR UPDATE balance rows, sorted (location, product)
        WH->>DB: UPDATE stock_balances (delta = −qty, WHERE quantity >= qty)
        WH->>DB: INSERT stock_movements (kind = ISSUE, source_id = delivery item)
        WH-->>JC: movement ids
        JC->>TX: COMMIT  (approval + stock together, or neither)
    end
```

Plain-text form, for readers without Mermaid:

1. **Create** → card + lines, `delivered_at` NULL, no module call.
2. **Execute** → staff writes `delivered_at`/quantity; line still editable; no module call.
3. **Submit** → readiness requires `delivered_at` on every line; lines freeze; advisory
   panel only.
4. **Approve** → one transaction: precheck stock (fail = rollback, no version bump) →
   `COMPLETED` + `manager_approved_at` → post one `ISSUE` per line from the resolved
   location, locking balance rows in `(location, product)` order.
5. **Commit** → approval and stock are one fact. Any throw rolls back both.

### 9.3 Sequence — ADMIN invalidation of a completed delivery

```mermaid
sequenceDiagram
    autonumber
    actor A as ADMIN
    participant JC as job-cards.Service
    participant WH as Warehouse posting port
    participant DB as warehouse tables

    A->>JC: POST /:id/invalidate { reasonCode, note }
    JC->>JC: assertCanInvalidate — ADMIN only
    JC->>JC: BEGIN; lock users → job_cards; reject if already INVALIDATED
    JC->>JC: status = INVALIDATED + JOB_INVALIDATED + audit + OVR-2 closure
    JC->>WH: reverseDeliveryMovements(client, lines, reasonCode, requestTime)
    alt no movement exists (never posted / module was off / DEMO)
        WH-->>JC: { reversed: 0 }
    else movement exists
        WH->>DB: INSERT stock_movements (kind = REVERSAL, reversal_of_movement_id, occurred_at = requestTime)
        WH->>DB: UPDATE stock_balances (delta = +qty)
    end
    JC->>JC: COMMIT (invalidation + reversal together)
```

### 9.4 Exact Core call sites (PROPOSAL — one mandatory, one recommended)

| # | File | Location | Condition |
| - | ---- | -------- | --------- |
| 1 | `server/src/modules/job-cards/service.ts` | inside `runLifecycle` finalize: precheck **before** `transitionWithVersion` (`:7447-7449`), post **after** it | `definition.command === 'APPROVE' && job.type === 'PRODUCT_DELIVERY'` |
| 2 (recommended, see §13 D2) | same file | inside `invalidate`, after `invalidateWithVersion` (`:1686-1697`) | `job.type === 'PRODUCT_DELIVERY' && job.status === 'COMPLETED'` |

Pair approvals (`applyPairApprove`, `:7099-7176`) complete a `SALES_MEETING` and a `SALE`,
never a delivery (B15). Sale-approval delivery creation (`:2814`) creates a `NEW` card.
Neither is a call site.

### 9.5 Module shape (canonical model belongs to 02; only the integration columns here)

`02-domain-model-options.md` §8 owns `stock_locations`, `stock_balances`, `stock_movements`
and the movement-kind vocabulary (`OPENING`, `RECEIPT`, `ISSUE`, `TRANSFER_OUT`,
`TRANSFER_IN`, `RETURN_IN`, `COUNT_ADJUSTMENT`, `REVERSAL`). This document adds only the
requirements the JobCard integration imposes on it:

| Requirement | Why |
| ----------- | --- |
| `stock_movements.kind='ISSUE'` with `source_type='JOB_CARD_DELIVERY'`, `source_id` = delivery item id, `source_job_card_id` = card id | Already in 02 §8.2/§9.2. `source_id` is what makes the per-line once-only index possible. |
| `UNIQUE (organization_id, source_id, movement_kind) WHERE source_type='JOB_CARD_DELIVERY'` | The receipt-independent guard: a repair job or a manual SQL fix cannot double-post a line. |
| `occurred_at` = approval instant; `recorded_at` default | Posting-dated ledger, no cutoff (§1.2, §5.2). |
| `actor_user_id` = the approving manager | The approval is the authority; the staff member's identity is already on the card and the item. |
| DEMO cards post nothing | 02 §9.2. Also keeps the demo purge FK-free. |
| Reversal linked by `reversal_of_movement_id`, one per target | §1.3. |

A unique constraint as the idempotency key is the standard PostgreSQL mechanism. Where the
module needs an upsert it uses `INSERT … ON CONFLICT (…) DO NOTHING RETURNING`, which is
atomic under concurrency: "ON CONFLICT DO UPDATE guarantees an atomic INSERT or UPDATE
outcome; provided there is no independent error, one of those two outcomes is guaranteed,
even under high concurrency" (PostgreSQL 17 documentation, `INSERT` / ON CONFLICT,
<https://www.postgresql.org/docs/17/sql-insert.html>, accessed 2026-11-26).

---

## 10. Acceptance scenarios

Legend: `[CORE]` Core invariant, `[WH]` module invariant, `[CUT]` enable/disable rule.

**A1 — a repeated command creates no second movement** `[CORE][WH]`
Given an enabled Warehouse and a `WAITING_APPROVAL` business delivery with 2 lines, When the
manager approves it and the same `clientActionId` is retried, Then exactly 2 `ISSUE`
movements exist, the retry returns the same receipt (`service.ts:7239-7249`), and no third
movement is written.

**A2 — a revision never posts** `[WH]`
Given a submitted delivery, When the manager requests revision, staff edits a quantity and
resubmits, Then zero movements exist until the final approval, and that approval posts the
*corrected* quantity only.

**A3 — withdraw and cancel never post** `[WH]`
Given a submitted delivery, When staff withdraws and then cancels with a reason, Then zero
movements and zero reversals exist for that card.

**A4 — approval is the only posting moment** `[CORE]`
Given a delivery whose lines all carry `delivered_at`, When the card is still `IN_PROGRESS`,
Then no movement exists; after approval, one movement per line exists.

**A5 — invalidating a completed delivery reverses it** `[CORE][WH]`
Given an approved delivery with 2 posted movements, When an ADMIN invalidates it with reason
`DUPLICATE`, Then 2 `REVERSAL` movements exist, each referencing its original, each original
unchanged, the balance returns to its pre-approval value, and the reversal `occurred_at`
equals the invalidation instant.

**A6 — a double invalidation cannot double-reverse** `[WH]`
Given an already invalidated card, When invalidate is retried, Then `409 JOB_ALREADY_INVALIDATED`
(`service.ts:1669-1671`) and no additional reversal.

**A7 — module disabled at approval writes nothing** `[CUT]`
Given the module disabled, When a business delivery is approved, Then the approval succeeds,
delivery reports are unchanged, and **no** `stock_movements`, `stock_balances` or
reconciliation row is written.

**A8 — enabling does not auto-deduct old deliveries** `[CUT]`
Given 10 deliveries approved while the module was off, When the operator enables the module,
Then zero movements exist, the 10 appear in the unposted list, and no scheduled job posts
them.

**A9 — opening count then issue** `[WH]`
Given a freshly enabled module with no balances, When the operator posts an opening count and
a manager approves a delivery for 3 units of a product counted at 10, Then the balance is 7
and the board shows exactly two movements (`OPENING` +10, `ISSUE` −3).

**A10 — re-enable requires an explicit decision** `[CUT]`
Given the module re-enabled after a month off, When the operator opens the reconciliation
list, Then each unposted line must be decided `POSTED` or `NOT_POSTED` explicitly; `POSTED`
writes an `ISSUE` with `occurred_at = now()`, attributed to the person deciding; there is no
"apply all automatically" path.

**A11 — a reversal is impossible twice** `[WH]`
Given a movement already reversed, When the reversal is retried with a new action key, Then
`409` and no second `REVERSAL` for that target.

**A12 — insufficient stock blocks without a version bump** `[WH][CORE]`
Given a balance of 0 and a line of quantity 3, When the manager approves, Then
`409 INSUFFICIENT_STOCK` naming the product, needed and on-hand quantities; the card stays
`WAITING_APPROVAL` at the **same version**, and no movement exists.

**A13 — unreadable module state fails closed** `[CORE]`
Given the module enabled but `installation_module_state` unreadable, When a manager approves a
delivery, Then `503 WAREHOUSE_POSTING_FAILED`, the card stays `WAITING_APPROVAL`, and no
movement exists.

**A14 — concurrent approvals of the same product** `[WH]`
Given two business deliveries of the same product from two vehicles, When both are approved
concurrently, Then both post, each balance is correct, and there is no deadlock, lost update
or negative row.

**A15 — the sale path posts nothing twice** `[WH]`
Given a `SALE` approved with "Teslim işi aç", When the sale approval completes, Then the
created delivery is `NEW` with planned lines and zero movements; movements appear only when
that delivery is later approved.

**A16 — a `RETURN` line posts an outbound issue** `[CORE]`
Given a delivery with `deliveryPurpose='RETURN'`, When it is approved, Then one `ISSUE` is
written (02 OQ-3 direction), the delivery report still counts the quantity positively
(DOM-006), and no `RETURN_IN` exists.

**A17 — a DEMO delivery posts nothing and still approves** `[CORE][WH]`
Given a `data_class='DEMO'` delivery, When it is approved, Then the approval succeeds, no
movement is written, and the purge plan for that dataset contains no warehouse row (C5 proves
this either by registering the FK target or by showing no demo vehicle location can exist).

**A18 — product deletion stays explainable** `[CORE]`
Given a product referenced only by a stock movement, When an ADMIN deletes it, Then
`409 PRODUCT_HAS_OPERATION_HISTORY` naming the stock history — not a raw FK violation.

**A19 — offboarding keeps the vehicle and its history** `[CORE][WH]`
Given an offboarded staff member whose vehicle holds 5 units, When offboarding completes,
Then the vehicle, its stock and its movements still exist, attributed to the inactive user,
and the module offers a transfer; no Core table is rewritten.

**A20 — the module never becomes a Core dependency** `[CORE]`
Given the module disabled and its tables empty, When the full delivery lifecycle runs, Then
every existing Core acceptance test for `PRODUCT_DELIVERY` passes unchanged.

---

## 11. Required Core changes (minimal ports, PROPOSAL only)

### 11.1 Summary

| # | Change | Kind | Blocking for slice 1? |
| - | ------ | ---- | --------------------- |
| C1 | Widen the registry type + add key `'WAREHOUSE'` | code | Yes |
| C2 | Migration: widen the two module-key CHECKs | migration | Yes |
| C3 | Capability `warehouse` in `/api/auth/me` + web | code | Yes |
| C4 | `WarehousePostingPort` + call site(s) + one tx read | code | Yes |
| C5 | `demo-data`: vehicle-location FK to `users` must be registered, or prove it cannot happen | code | Yes |
| C6 | `products` delete guard includes module references | code | Yes (or delete 500s) |
| C7 | Web: navigation, route access, advisory panel, location override | code | No |
| C8 | Docs: schema/API drafts, `docs/README.md` | docs | No |

### 11.2 C1/C2/C3 — identical to `02-domain-model-options.md` §10.1

`installation-modules/registry.ts:7-14` hard-codes `key: 'OVERVIEW'`, `capability: 'overviewDashboard'`,
`legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED'`; `installation-modules/takeover.ts:22` takes
`{ overviewDashboard: boolean }` and `:29` indexes `legacy[module.capability]`;
`app.ts:257-260` builds the pool-less fallback from `config.capabilities?.overviewDashboard`
only; `capabilities/types.ts:1-8` has no `warehouse` field. Minimal widen:

```ts
key: 'OVERVIEW' | 'WAREHOUSE'
capability: 'overviewDashboard' | 'warehouse'
legacyEnvKey: string | null          // null = starts disabled, no env source
```

plus a `legacy` map instead of single booleans in `installation-modules/takeover.ts:22` and `app.ts:260`, and
`'WAREHOUSE'` in both migration-074 CHECKs (`:59`, `:86-87`). No dependency graph, no
dynamic loading — MOD-002 §3 stays intact. A module with no legacy env key needs an explicit
fresh-install default (OQ-1).

### 11.3 C4 — the port

```ts
// server/src/modules/warehouse/posting-port.ts (module-owned interface, consumed by
// job-cards; mirrors reports/ports.ts and people/customer-assignment-port.ts)
export type WarehouseLineSnapshot = Readonly<{
  deliveryItemId: string;
  productId: string;
  quantity: number;
  deliveryPurpose: 'SALE' | 'SAMPLE' | 'CONSIGNMENT' | 'RETURN' | 'OTHER';
  deliveredAt: Date;
  lotNo: string | null;
  serialNo: string | null;
  expiryDate: string | null;
}>;

export interface WarehousePostingPort {
  /** Runs on the caller's client, before the JobCard mutation. Read-only. */
  precheckDeliveryStock(client: PoolClient, input: {
    organizationId: string; jobCardId: string; assigneeUserId: string;
    lines: readonly WarehouseLineSnapshot[];
  }): Promise<
    | { ok: true }
    | { ok: false; shortfall: readonly {
          productId: string; productName: string;
          /** Ready to render: Core never resolves a module-owned id. */
          locationLabel: string;
          needed: number; onHand: number;
        }[] }
  >;

  /** Runs on the caller's client, after COMPLETED. Idempotent on deliveryItemId. */
  postApprovedDelivery(client: PoolClient, input: {
    organizationId: string; jobCardId: string; assigneeUserId: string;
    approvedAt: Date; actorUserId: string;
    lines: readonly WarehouseLineSnapshot[];
  }): Promise<{ posted: number; skipped: 'MODULE_DISABLED' | 'DEMO_CARD' | 'PURPOSE_EXCLUDED' | null }>;

  /** Optional in V1 if §13 D2 goes the "explicit reversal" way. Idempotent per movement. */
  reverseDeliveryMovements(client: PoolClient, input: {
    organizationId: string; jobCardId: string; reasonCode: string;
    invalidatedAt: Date; actorUserId: string;
  }): Promise<{ reversed: number }>;
}
```

Deliberate properties: the module receives **data**, not table names, so it never reads
`job_card_delivery_items`; the port takes a `PoolClient`, so atomicity is not optional;
`skipped` is a return value, not an error, so "module off" and "demo card" are not failures;
the shortfall carries a **renderable label**, so Core never resolves a module-owned id;
`503` happens only when the module is enabled and posting throws.

New transaction read (one method, alongside `getSubmissionDeliveryItems`):

```ts
listDeliveryLinesForApproval(organizationId: string, jobCardId: string):
  Promise<WarehouseLineSnapshot[]>
```

### 11.4 Explicitly *not* changed

| Thing | Why not |
| ----- | ------- |
| `job_card_delivery_items` schema | Lot/serial/expiry already exist (B4). |
| `JobCardStatus`, `DeliveryPurpose`, `JOB_CARD_TYPES` | No new status/purpose/type is needed; `RETURN` is not a new type. |
| Submit readiness codes (`submission-policy.ts:58-98`) | Advisory stock state must not become a Core readiness requirement (§4). |
| `reports/*` | Core reports stay Core-only (B11); no module join. |
| `people/offboarding.ts` | §8 (and the §13 D4 divergence). |
| A generic event bus / global outbox | MOD-001 §4 (`DECISIONS.md:2041-2050`). |
| `invoiceNumber`, price, VAT, financial fields | MOD-001 §3/§5; DOM-001. |

---

## 12. Conflicts with accepted text that need an owner amendment

| # | Conflict | Accepted text | What a Warehouse module needs |
| - | -------- | ------------- | ----------------------------- |
| CONFLICT-1 | Sale-level reservation | `DECISIONS.md:2154-2155` (SALE-002 §6): "no partial deliveries, no remaining-quantity tracking" | A reservation needs a remaining quantity, plus a release rule for sale cancel/invalidate and delivery cancel (`DECISIONS.md:2179-2180`). Not needed in V1. |
| CONFLICT-2 | `CONSIGNMENT` and stock | `PRODUCT_REQUIREMENTS.md:283`; `DECISIONS.md:351`: they "do not create or alter stock movements" | If consignment stock must be tracked, it is neither "no movement" nor "issue": it needs a consignment location (02 §5 defers it) and an amendment. Exclude consignment from slice 1 or decide it explicitly. |
| CONFLICT-3 | "One stock authority" vs. an external ERP | `DECISIONS.md:2027-2030` (MOD-001 §2): the single source of truth is set **per deployment/integration mode** | If an external ERP is ever the authority, this design inverts (the module mirrors instead of posting). The mode must be declared before slice 1 ships, or the module silently becomes a second authority. `05-erp-integration-mode.md` owns that decision. |
| CONFLICT-4 | Delivery quantity scale | DELIVERY-QTY-001 (`DECISIONS.md:3463-3467`): whole units 1–999999999 | A signed `INTEGER` stock quantity is compatible today (02 §8.2 uses `INTEGER`) and needs the measured-goods decision (`DECISIONS.md:3486-3489`) before ml/mg stock can post. Not a blocker. |

Note: an earlier draft framed `RETURN` restocking as CONFLICT-1. Applying
`02-domain-model-options.md` OQ-3 (keep `RETURN` outbound, customer returns as a separate
command) removes that conflict entirely, so it is no longer listed. Consignment remains.

Reported per `AGENTS.md` §15: neither side is silently rewritten here.

---

## 13. Alignment with the sibling research documents

Written after the sibling files landed. Read this before treating any §13 divergence as
settled.

### 13.1 Where this document and 02 agree (no action needed)

| Topic | Agreement |
| ----- | --------- |
| Posting moment | Only an approval posts; nothing posts at create, execution or submit. |
| Mechanism | A synchronous in-transaction module command inside the approval transaction (02 §9.2, §12 W4). |
| Per-item idempotency | A unique key over the delivery item id, independent of the command receipt (02 §8.2's partial unique index). |
| Lock order | Report-lines lock first; stock rows last, locked in deterministic order (02 §9.3). |
| Reservations | None in V1 (02 §6, §12). |
| Returns | `RETURN` stays outbound; customer returns are a separate command (02 OQ-3). |
| Demo data | A DEMO delivery posts nothing and must still approve (02 §9.2). |
| Module plumbing | Widening the registry, the module-key CHECK and `AuthenticatedCapabilities` (02 §10.1). |
| Reject before mutating | An insufficient-stock rejection must leave no JobCard version bump (02 §9.2). |

### 13.2 Divergences, with my position and the reason

**D1 — Insufficient stock (was: allow negative).** Resolved in §4: this document now
recommends the **hard gate**, matching 02 §6/OQ-2, because a `quantity >= 0` balance table
(02 §8.3) makes negative stock unrepresentable and the same-transaction port makes the gate
atomic. The two conditions (§4.2 items 3–4) are mine and should travel with the decision.

**D2 — Who reverses an invalidated delivery.** This document recommends posting the
`REVERSAL` **inside the `invalidate` transaction** (call site 2 in §9.4). 02 §12 W6 instead
recommends that an invalidated-after-approval delivery appear in an **exception list** until
someone runs an explicit `STOCK_REVERSE`. Trade-off: automatic reversal closes a
contradiction immediately (the system says the delivery never happened, yet the balance says
it did); the exception list adds zero Core coupling and no module work inside `invalidate`.
My position: automatic, because `invalidate` is already an ADMIN "correct history" command
with a reason code, and a balance that stays wrong until a human notices is a data-integrity
hole. If the owner prefers minimal coupling, dropping call site 2 costs nothing else in this
design — every other rule is unchanged.

**D3 — Who chooses the source location.** This document: the assignee's vehicle by default,
overridable in the module's own delivery panel before approval. 02 OQ-4 option (b): the
approving manager chooses in the approve dialog, defaulting to the vehicle. Both agree the
manager should be able to divert a delivery to a depot. The difference is where the choice
lives: 02's version needs an opaque location id in Core's approve body (a module concept in
a Core contract); mine keeps Core's body free of module ids at the cost of one extra
module-screen step. My position: keep Core clean, unless the owner explicitly wants the
choice in the approval dialog.

**D4 — Offboarding blocking.** This document: change nothing; the `users` row survives, so
the vehicle and its stock do; the module offers a transfer. 02 §10.2: block offboarding with
`VEHICLE_STOCK_NOT_EMPTY` and deactivate the location through a port. Both are safe; 02's is
stricter and costs a Core read port plus a lock-free race (which 02 states honestly). My
position: start with no block, add 02's block only if a pilot shows stock stranded on a
departed user's vehicle. It is also the smaller slice, which the research order prefers.

**D5 — A precision gap in 02's wording, not in its model: "0" versus "never counted".**
02's `stock_balances.quantity >= 0` plus "only non-zero count lines produce a movement"
means a product counted at 0 gets no balance row, so it is indistinguishable from a product
never counted at all. 02's `stock_counts` header still answers "was this *location* counted",
which is enough for the gate; what is missing is only the *per-product* explanation, i.e.
whether "0" means "counted and empty" or "never counted". The gate outcome is identical, so
this is a message-quality issue, not a correctness one: the approve error should point at
the count screen (`stock_counts`) rather than assert a shortfall the system cannot prove.
§4.2 precondition 4 depends on this distinction being available.

**D6 — Enablement cutoff.** This document concludes no cutoff is needed once movements are
posting-dated (§5.2). 02 never introduces one, so this is agreement by construction rather
than a divergence; recorded here because the brief asked for a cutoff definition and the
answer is "none, and here is why".

---

## 14. Open questions for the owner

**OQ-1 — Fresh-install default for a module with no legacy env key.**
(a) starts **disabled**; (b) a new `WAREHOUSE_ENABLED` env key taken over like Overview;
(c) on by default. **Recommend (a)**: MOD-002 §4's takeover exists to preserve an existing
install's behaviour, and a new module has none. A stock module that turns itself on with no
count produces "insufficient stock" on every delivery (D5).

**OQ-2 — Reversal on invalidation: automatic or exception-list (§13 D2)?**
(a) automatic in the same transaction; (b) explicit `STOCK_REVERSE` from an exception list.
**Recommend (a).** Drop to (b) only if the lead wants the smallest possible Core diff.

**OQ-3 — Location choice in the approve dialog (§13 D3)?**
(a) module panel before approval (no Core change); (b) an opaque location id in the approve
body. **Recommend (a).**

**OQ-4 — Should a MANAGER be able to post a `RECEIPT`/`TRANSFER` (§4.2 precondition 3)?**
(a) yes, manager; (b) operator only. **Recommend (a)** — without it the hard gate holds the
field team hostage. If (b), the alternative is an ALLOW-negative mode on vehicles, which
needs a 02 schema amendment (`quantity >= 0` is a CHECK).

**OQ-5 — Should `CONSIGNMENT` deliveries be approvable in slice 1 (CONFLICT-2)?**
(a) exclude the purpose from the stock gate (no movement, like today); (b) block consignment
deliveries until the consignment location exists; (c) add the consignment location type in
slice 1. **Recommend (a)** — smallest change, keeps today's behaviour for a purpose that has
no stock meaning yet.

**OQ-6 — Does the vehicle get deactivated when its owner is offboarded (§13 D4)?**
(a) no, it becomes an exception row; (b) yes, 02 §10.2's port. **Recommend (a)** for V1.

**OQ-7 — Is the unposted list a manager or an operator surface?**
(a) operator only; (b) customer ADMIN/MANAGER too; (c) both, different detail.
**Recommend (b)** for visibility and **(a)** for the decision: counting stock is the
customer's operational work; the module switch stays with the operator (MOD-002).

**OQ-8 — Does the approve dialog show the current location balance even when it is enough?**
(a) no, only on shortfall; (b) yes, read-only per line. **Recommend (b)** — cheapest way to
catch "the vehicle was never stocked" without turning approval into an inventory ritual.

---

## 15. Unverified / gaps

- **No Warehouse code exists.** Every table shape in §9.5 defers to
  `02-domain-model-options.md` §8; this document contributes integration requirements only.
- **The `503`/`409` split is a proposal.** MOD-002 §5 defines fail-closed for *reading*
  module state, not for a Core command that calls a module.
- **Lock-order claim not stress-tested.** Reasoned from `service.ts:2766-2782`, ARC-003 and
  02 §9.3; no concurrency test can exist before the tables do.
- **`delivered_at` is unbounded** (B16). Posting-dated movements make the ledger immune, but
  whether Core *should* bound it is a separate question I did not resolve.
- **Duplicate product lines are allowed** by `addDeliveryItem` (no `seen` set, unlike
  `assertInitialProductDeliveryItems`, `service.ts:571-585`). Posting per line makes this
  harmless, but "quantity per product" is never a single number on a card.
- **Restore behaviour untested.** A restored balance plus deliveries approved after the
  backup instant is 02 §8.4's reconciliation; I did not verify any of it.
- **`demo-data` cost estimated, not measured.** Read `demo-data/analyzer.ts:590-620` and
  `demo-data/repository.ts:405-470,480-491,596-640`; I did not enumerate every place that must learn a
  new table. C5 assumes 02's lazy vehicle creation makes a demo-user vehicle impossible; that
  assumption should be tested, not assumed.
- **SALE-002 S4 state not verified.** `docs/README.md:20` says "S4 in progress"; I did not
  confirm whether S4 touches delivery posting.
- **`PRODUCT_REQUIREMENTS.md` return wording.** I relied on line 283 and DOM-001 line 351
  read literally. If the owner reads "operational classifications only" as "no stock
  *policy* yet" rather than "no movements ever", §7 and A16 change shape.
- **External source.** One citation only (PostgreSQL 17 `INSERT`/`ON CONFLICT`, accessed
  2026-11-26); the documentation site banner showed "PostgreSQL 19 Released, November 19,
  2026" on the same date, so the 17 page is the archived-but-supported version.
