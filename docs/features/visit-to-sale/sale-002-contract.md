# SALE-002 — Standalone sale, joint visit+sale approval and sale-driven delivery

- **Date:** 2026-11-23
- **Status:** Accepted by the product owner in chat (2026-11-23), including the recommended
  defaults for every open question in §11 (Q1, Q2, Q4–Q8). Implementation is authorized as the
  slices S1–S4 in §10; each slice ships its code, tests and owning-document updates together.
- **Baseline:** `origin/main` @ `9776243` (worktree branch `docs/sale-002-design`), migration
  head `070_overdue_incident_invalidation_closure`.
- **Owner decisions:** product owner in chat, 2026-11-23 (D1–D7 below).
- **Extends:** SALE-001, SALE-QTY-001, DELIVERY-QTY-001, JOB-006, JOB-008, JOB-009,
  JOB-010, DOM-001, DOM-003, DOM-006, MOD-001, REPORT-001.
- **Supersedes when implemented:** the specific SALE-001 sentences listed in §12. No
  earlier document is rewritten by this design.
- **Revision 2 (2026-11-23):** independent critique (2 Critical, 4 Major, 2 Minor) resolved —
  the pair reservation/locking design is complete (§4.5/§4.6), the delivery section lives in
  the visit approve dialog (§8.1/§8.2), cross-staff pairs are defined (§4.2/§4.3, R17),
  `expectedSaleVersion` is in every pair HTTP contract (§4.5), legacy mixed states are explicit
  (§4.4/§4.8), and the 049 `FAILED` retry rule is corrected (§5.4).

Evidence references are `path:line` at the baseline above. Historical discovery documents
([design](visit-to-sale-design.md), [data lifecycle](visit-to-sale-data-lifecycle.md),
[implementation plan](visit-to-sale-implementation-plan.md)) remain historical; their
"no standalone sale" and "sale never creates delivery" statements were explicitly
forward-looking, not permanent prohibitions.

---

## 1. Scope and owner decisions

### 1.1 Owner decisions (authoritative input)

| ID | Decision |
| --- | --- |
| **D1** | Phone order already works and stays: staff or manager opens a `PRODUCT_DELIVERY`, management may assign it to any staff member, delivery completes, card closes. Verify and describe current behaviour; no change unless a gap is found. |
| **D2** | A `SALE` can be opened (a) from an `IN_PROGRESS` visit (exists), (b) from a `COMPLETED` visit, (c) standalone with no visit (phone order). Standalone: staff for themselves, management for any staff; customer required. |
| **D3** | A visit and its linked sale close with **one** submission and **one** approval: submitting the visit also submits its active linked sale; one manager approval completes both; a revision request returns **both** together and they come back together. |
| **D4** | On a `SALE` approval the dialog offers an easy **"Teslim işi aç"** action (optionally with a note). The manager reviews products (prefilled from the sale items; may reduce quantity, remove or add products), chooses staff (default: the sale's staff, may differ) and date/time; on approval the `PRODUCT_DELIVERY` is created **atomically** with the approval. Only one delivery per sale for now (no partial deliveries; remaining-quantity tracking belongs to the future warehouse module). Items are planned (`deliveredAt` NULL); whole-unit quantities (DELIVERY-QTY-001); BUSINESS product eligibility as in delivery create. |
| **D5** | Owner principle: make the staff member's work easier, avoid system barriers. Visits spawn visits (routine visits are core), visits turn into sales (most valuable), the sale later drives warehouse/logistics (MOD-001 boundary: no stock or accounting now). |
| **D6** | Attribution: work belongs to the staff assigned at completion (REPORT-002, being implemented on a parallel branch); sale and delivery counts follow that rule. |
| **D7** | Calendar changes are deferred. |

### 1.2 Terms used in this contract

- **Pair / çift:** a `SALES_MEETING` visit plus the one active `SALE` whose
  `sale_source_visit_id` is that visit.
- **Live source:** the source visit of a sale, while it is in a *coordinating* status
  (`IN_PROGRESS`, `WAITING_APPROVAL`, `REVISION_REQUESTED`). A terminal source
  (`COMPLETED`, `CANCELLED`, `INVALIDATED`) releases the sale to its independent lifecycle.
- **Sale-linked delivery:** the single `PRODUCT_DELIVERY` whose
  `delivery_source_sale_id` is the approved sale.
- **Standalone sale:** a `SALE` with `sale_source_visit_id IS NULL`.

### 1.3 Non-goals (explicit)

No stock, inventory, lot/expiry tracking, price, currency, discount, revenue, margin,
invoice, payment or accounting data. No partial or multi-delivery per sale. No automatic
delivery from *sale creation* (only from approval, and only when the manager asks). No
`SALE` in generic create, follow-up, or calendar flows. No new state machine, no new
`JobCardStatus`, no new module boundary. No calendar feature change (D7). No change to
D1's existing phone-order path.

---

## 2. Current state and the rules that must change

### 2.1 D1 verification — phone order works today (no change)

Verified behaviour at the baseline:

1. Any authenticated user may create a `PRODUCT_DELIVERY` through
   `POST /api/job-cards/product-deliveries` (`server/src/modules/job-cards/routes.ts:20`).
   `createProductDelivery` validates type, a non-empty title, customer, assignee,
   priority, a `scheduledAt` with its canonical `scheduledEndsAt`, and 1–25 initial item
   lines (`server/src/modules/job-cards/service.ts:2595-2607`,
   `service.ts:486-504`, `create-input.ts:219-235`).
2. **Assignment:** staff may only create for themselves
   (`policy.ts:219-221`), management may assign any active same-organization STAFF user
   (`policy.ts:223-227`). A staff self-create is `ACCEPTED`; a management create is `NEW`
   (`service.ts:2655-2668`).
3. **Items:** initial lines are created with `deliveredAt = NULL` in the same transaction
   (`service.ts:2552-2593`); the actual delivery time is recorded later through the
   existing delivery-item patch while the card is `IN_PROGRESS` / `REVISION_REQUESTED`
   (`policy.ts:184-190`).
4. **Completion:** `SUBMIT_FOR_APPROVAL` requires an eligible customer, eligible assignee,
   at least one item with product, canonical purpose, actual `deliveredAt` and a positive
   quantity (`submission-policy.ts:58-98`). `APPROVE` moves the card to `COMPLETED`
   (`policy.ts:136-138`, `service.ts:5484-5491`).
5. **JOB-010:** a management-created delivery with a planned time opens an assignment
   offer and may be rejected with `ASSIGNMENT_WINDOW_TOO_SHORT` /
   `PAST_START_ACKNOWLEDGEMENT_REQUIRED` (`service.ts:2706-2716`,
   `service.ts:1186-1247`).

Conclusion: **D1 is satisfied by the current implementation; SALE-002 changes nothing in
this path.** The only pre-existing constraint worth naming is JOB-006 §4: a delivery needs
a planned `scheduledAt` even for a phone order, which the creator enters. That is accepted
existing policy, not a gap in this slice.

### 2.2 Rules that must change (implementation checklist)

| # | Current rule | Evidence | Required change |
| --- | --- | --- | --- |
| **R1** | A `SALE` must have a source visit: `CHECK ((type = 'SALE') = (sale_source_visit_id IS NOT NULL))` | `server/src/db/migrations/057_sale_from_visit.sql:13-14` | Relax to "only a `SALE` may carry a source": `sale_source_visit_id IS NULL OR type = 'SALE'`. Standalone sales become representable. |
| **R2** | `job_card_sale_details` source snapshot columns are `NOT NULL` | `057_sale_from_visit.sql:43-45` | Drop `NOT NULL` on `source_visit_version`, `source_visit_title_snapshot`, `source_customer_name_snapshot`; add an all-or-none "source shape" CHECK (§3). |
| **R3** | A sale source must be `IN_PROGRESS` | `server/src/modules/job-cards/sale-policy.ts:10-16` | Accept `IN_PROGRESS` **or** `COMPLETED`. Terminal non-completed sources stay ineligible. |
| **R4** | Sale submission requires a valid visit origin | `server/src/modules/job-cards/submission-policy.ts:324`, `:336` (`SALE_ORIGIN_VALID`) | The requirement becomes "a details row exists AND (its source is absent OR the source `EXISTS` check passes)". A missing `job_card_sale_details` row keeps failing; only a genuinely standalone sale satisfies it without a source. `SaleSubmissionSnapshot.sourceVisitId` becomes nullable (`sale-repository.ts:28-33`). |
| **R5** | Only `createSaleFromVisit` exists; generic create rejects `SALE` | `sale-service.ts:151-253`, `create-input.ts` type allowlists | Add a dedicated standalone create service + route (§6). Generic create and follow-up allowlists stay closed to `SALE`. |
| **R6** | Visit and sale are two independent lifecycles with two submissions and two approvals | `policy.ts:134-138`, `service.ts:5426-5491` | Add coordinated pair commands while the source is live (§4). Single-card commands keep working when the pair is not live. |
| **R7** | SALE-001: "Sale creation/correction never changes the source visit or creates delivery, follow-up, financial, stock or accounting operations" | `DECISIONS.md:1919-1920` | Creation/correction still never create a delivery. **Sale approval** may now create exactly one `PRODUCT_DELIVERY` when the manager explicitly asks (D4). |
| **R8** | No relationship between a sale and a delivery | — | Add `job_cards.delivery_source_sale_id` with a same-organization FK and a unique index (one delivery per sale) (§3). |
| **R9** | A `SALE` submission requires `START` first (`ACCEPTED → START → IN_PROGRESS → SUBMIT`) | `policy.ts:125-134` | Allow `SUBMIT_FOR_APPROVAL` from `ACCEPTED` **for `SALE` only** (§4.3, `[Accepted Q1]`). Without this, every joint submit costs an extra location-capturing `START` that carries no meaning for an agreement that already happened. Implemented with migration 072 (see §3.4). |
| **R10** | Sale detail copy says a sale never creates a delivery | `web/src/JobDetail.tsx:2789-2791` | Replace with the MOD-001 wording that stays true: no stock/accounting; a delivery may be opened at approval. **Ships in S3**, together with approval delivery creation — never in S1, where it would promise an unshipped feature. |
| **R11** | Read projection assumes a source visit; a missing source renders the restricted origin | `server/src/modules/job-cards/sale-reader.ts:105-114`; `read-integration.md:49-50` ("Restricted origin is exactly `{access: RESTRICTED, kind: SALE_FROM_VISIT}`") | Add an explicit `{ kind: 'STANDALONE' }` origin projection (no source to conceal) and extend the read-integration statement; the UI must never show "kaynağa erişiminiz yok" for a standalone sale. |
| **R12** | `sale-create-context` derives customer/assignee from the visit only | `sale-reader.ts:41-79` | Unchanged for visit-origin creation (including completed visits, which the query already returns). Standalone creation does not use this endpoint. |
| **R13** | Assignment offer `opened_reason` vocabulary has no reason for a sale-driven delivery | `server/src/db/migrations/065_job_card_assignment_offers.sql:53-61` | Add `'SALE_APPROVAL'` to the CHECK vocabulary. |
| **R14** | Activity vocabulary has no "delivery opened from a sale" fact | `057_sale_from_visit.sql` event CHECK | Add `SALE_DELIVERY_CREATED` (DOM-003 extension). |
| **R15** | `getAllowedLifecycleCommands` is type-agnostic for submit | `policy.ts:115-143` | Add the pair guards of §4.2/§4.3; they are state-derived, not type-derived, so no new command name enters the DTO vocabulary. |
| **R16** | The 057 "one active sale per visit" index remains the only slot rule | `057:27-31` | Unchanged. A terminal sale releases the slot; a standalone sale (NULL source) never participates (NULL is distinct in a unique btree). No index rebuild in 071. |
| **R17** | Management may reassign a `SALE` independently of its source visit | `service.ts:3418-3431`, `policy.ts:363-364`; `read-integration.md:41-53` cross-staff concealment | Add the live-pair ownership invariant: a reassignment that would diverge from a coordinating source visit fails `409 SALE_PAIR_ASSIGNEE_CONFLICT`; a pre-existing divergent pair is **decoupled** (no coordination, no shared ids) instead of blocked (§4.2, §4.3). |
| **R18** | `expectedSaleVersion` is not in any HTTP allowlist | `handlers.ts:169-180`, `:372-376` | Add it to `SUBMIT_FIELDS`, `APPROVE_FIELDS`, `requestRevision`, and new `WITHDRAW_FIELDS`/`RESUME_FIELDS`; `LIFECYCLE_FIELDS`, `START_FIELDS` and `ASSIGNMENT_DECISION_FIELDS` stay untouched (§4.5). |
| **R19** | `reserveLifecycleIntent` locks one JobCard; `finalizeLifecycleIntent` locks one JobCard and has no pre-JobCard reference hook | `repository.ts:5174-5234`, `:5247-5345` | Extend both for a sorted `jobCardIds` set, **two intent rows**, and a `lockReferences` hook between user locks and JobCard locks (§4.6). |
| **R20** | `APPROVE` may lock the customer **after** the JobCard row | `service.ts:7087-7090`, `:7133-7136` | Move the approve-path customer lock into the pre-JobCard `lockReferences` phase for single and pair approve, removing the `job_cards -> customers` inversion (§4.6). |
| **R21** | `SALE` realtime handling assumes a source visit; cross-owner events add the source key/assignee unconditionally | `service.ts:1003-1009` | Guard on `snapshot?.sourceVisitId`; add the source key/assignee only for the pair owner or management (§4.7). |
| **R22** | A pair command reports the minimal stored receipt | `service.ts:6212-6224` | Present `{ linkedSaleJobCardId?, deliveryJobCardId? }` on the full `JobCardDetail` response and store them in the receipt for replay parity (§5.1). |

### 2.3 Rules that intentionally stay

These are not changed by SALE-002 and every slice must preserve them:

- Sale commands never write to the source visit row (no status, version, assignment,
  customer, contact or meeting-detail change). The only source-side write remains the
  append-only `SALE_FROM_VISIT_CREATED` fact at creation (`sale-service.ts:239-241`).
- At most one active sale per visit, including after a delivery is created.
- Sale snapshots (source title/customer/planned/met contact, product name/SKU/brand/model/
  unit, quantities) remain immutable historical metadata; renames and deactivations never
  rewrite them.
- Generic create, follow-up creation/suggestion and the calendar never accept `SALE`.
- STAFF do not gain CRM, contact or catalog write rights; the sale contact remains a
  selection from active same-customer contacts.
- No price, currency, discount, total, stock, invoice or payment field, and no sale →
  delivery automation beyond the explicit approval action.
- Terminal cards stay immutable except the existing ADMIN `INVALIDATE`; no reversal, no
  credit note, no reopen.
- The existing 049 lifecycle intent, receipt, version and hash contracts stay authoritative;
  SALE-002 extends them with pair-scoped identities and a participant reservation, never a
  second concurrency mechanism.

---

## 3. Data model — proposed migration `071_sale_standalone_and_delivery_link.sql`

### 3.1 Constraints

Each migration runs inside one transaction
(`server/src/db/index.ts:44-57`), so `CREATE INDEX CONCURRENTLY` is unavailable and every
DDL statement below takes its normal locks. `070` is the current head; `071` becomes the
new head and `HEALTH_SCHEMA_VERSION` must move with it (`server/src/db/schema-check.ts:39-70`).

```sql
-- SALE-002: standalone sales and the sale -> delivery link. Additive; no DML, no backfill.

-- R1: a SALE may now exist without a source visit; only a SALE may carry one.
ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_sale_source_present_check,
  ADD CONSTRAINT job_cards_sale_source_type_check
    CHECK (sale_source_visit_id IS NULL OR type = 'SALE'),
  ADD COLUMN delivery_source_sale_id UUID,
  ADD CONSTRAINT job_cards_delivery_source_sale_fk
    FOREIGN KEY (organization_id, delivery_source_sale_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT job_cards_delivery_source_type_check
    CHECK (delivery_source_sale_id IS NULL OR type = 'PRODUCT_DELIVERY'),
  ADD CONSTRAINT job_cards_delivery_source_self_check
    CHECK (delivery_source_sale_id IS DISTINCT FROM id);

-- R8: at most one delivery per sale, ever. Cancelled/invalidated deliveries keep the slot
-- (D4: no partial deliveries; a replacement is a separate future decision, §11 Q4).
CREATE UNIQUE INDEX job_cards_one_delivery_per_sale_idx
  ON job_cards (organization_id, delivery_source_sale_id)
  WHERE delivery_source_sale_id IS NOT NULL;

-- R2: a standalone sale stores no source snapshots; a visit-origin sale stores all of them.
ALTER TABLE job_card_sale_details
  ALTER COLUMN source_visit_version DROP NOT NULL,
  ALTER COLUMN source_visit_title_snapshot DROP NOT NULL,
  ALTER COLUMN source_customer_name_snapshot DROP NOT NULL,
  ADD CONSTRAINT job_card_sale_details_source_shape_check CHECK (
    (source_visit_version IS NULL
      AND source_visit_title_snapshot IS NULL
      AND source_customer_name_snapshot IS NULL
      AND source_planned_contact_id IS NULL
      AND source_planned_contact_name_snapshot IS NULL
      AND source_planned_contact_title_snapshot IS NULL
      AND source_met_contact_id IS NULL
      AND source_met_contact_name_snapshot IS NULL
      AND source_met_contact_title_snapshot IS NULL)
    OR (source_visit_version IS NOT NULL AND source_visit_version > 0
      AND source_visit_title_snapshot IS NOT NULL
      AND length(trim(source_visit_title_snapshot)) > 0
      AND source_customer_name_snapshot IS NOT NULL
      AND length(trim(source_customer_name_snapshot)) > 0));

-- R13: the sale-approval delivery is its own offer producer.
ALTER TABLE job_card_assignment_offers
  DROP CONSTRAINT job_card_assignment_offers_opened_reason_check,
  ADD CONSTRAINT job_card_assignment_offers_opened_reason_check CHECK (opened_reason IN (
    'CREATE', 'REASSIGN', 'RESCHEDULE', 'FOLLOW_UP_CREATE',
    'APPROVE_FOLLOW_UP', 'CANCEL_REPLACEMENT', 'OFFBOARDING_TRANSFER',
    'REOFFER', 'SALE_APPROVAL'));

-- R14: one canonical fact on the sale when the approval opens a delivery.
ALTER TABLE job_card_activity_logs
  DROP CONSTRAINT job_card_activity_logs_event_type_check,
  ADD CONSTRAINT job_card_activity_logs_event_type_check CHECK (event_type IN (
    /* the full 057 vocabulary, unchanged */ ..., 'SALE_DELIVERY_CREATED'));

-- R8 precision: a sale-linked delivery can never also be a follow-up child.
ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_delivery_source_not_follow_up_check
    CHECK (delivery_source_sale_id IS NULL OR source_job_card_id IS NULL);
```

Notes that must hold in the real migration file:

- The activity CHECK must repeat the complete current vocabulary (the 057 list plus every
  later addition). It may not be "restated from memory"; copy the applied constraint first.
- The existing `job_cards_one_active_sale_per_visit_idx` (`057:27-31`) is **not** rebuilt.
  A NULL `sale_source_visit_id` never collides in a unique btree, so multiple standalone
  sales are allowed without touching the index. A comment must state that intent.
- `job_cards_sale_source_self_check` (`057:15-16`) and `job_cards_sale_fields_check`
  (`057:17-25`) stay as they are: a standalone sale still requires a customer, `BUSINESS`
  data class, no root contact, no schedule/due date, no follow-up fields.
- `job_card_sale_items` is untouched: SALE-QTY-001 integer CHECK, unique product per sale
  and snapshot columns already cover standalone sales.
- The database cannot prove that `delivery_source_sale_id` points at a `SALE` row (a
  composite FK only proves existence in the same organization). The service must verify
  `source.type = 'SALE'` under lock, and a PostgreSQL test must prove that an FK-only insert
  pointing at a `PRODUCT_DELIVERY` is rejected by the service, not silently accepted.
- The complementary invariant `job_cards.sale_source_visit_id IS NULL ⇔
  job_card_sale_details.source_visit_version IS NULL` spans two tables and therefore cannot
  be a CHECK. It is service-enforced in both writers (visit-origin create writes both;
  standalone create writes neither) and covered by a PostgreSQL test. State this next to the
  shape CHECK so a future reader does not assume database enforcement.

### 3.2 Backward compatibility

- Every existing `SALE` row has a non-null source and satisfies `job_cards_sale_source_type_check`.
- Every existing `job_card_sale_details` row has all source snapshots and satisfies
  `job_card_sale_details_source_shape_check`.
- Every existing `PRODUCT_DELIVERY` row has `delivery_source_sale_id IS NULL`.
- No DML, no backfill, no snapshot fabrication, no quantity change. Existing activity and
  receipt bytes are untouched.
- **Rollback floor:** after one sale-linked delivery exists, a downgrade drops the link
  column and loses provenance. The contract requires a forward fix, not a downgrade;
  state this in the release notes, like DELIVERY-QTY-001's rollback statement.
- Reading before write: 071 must be deployed before the new code path is reachable
  (schema-first, as with 057/058).

### 3.3 Repository shape

Minimum surface changes (all in `server/src/modules/job-cards/repository.ts` unless noted):

- `CreateJobCardRecord` gains one optional field, `deliverySourceSaleId`, used only by the
  sale-approval delivery path (`repository.ts:3643-3680`). The DEMO insert branch never sets
  it: a DEMO card cannot reference a sale, because a sale is `BUSINESS`-only by `057:17-25`.
- `SaleSubmissionSnapshot.sourceVisitId` becomes `string | null` (`sale-repository.ts:28-33`),
  and `selectSaleSubmission` returns a JSON `null` rather than a typed string for a
  standalone sale (`sale-repository.ts:36-57`).
- `LifecycleIntentReservationInput` gains `additionalJobCardIds` and `expectedVersions`, and
  `preflight` receives a job map (§4.6). `LifecycleIntentClaim` is unchanged; the
  `expectedSaleVersion` travels in the request hash and in the reservation input.
- `finalizeLifecycleIntent` gains `options.jobCardIds` and `options.lockReferences` (§4.6).
  These two signature changes plus the create-record field are the complete repository
  surface; any wider change is a design error.
- `appendRealtimeForActivity`'s `SALE` branch is guarded for a null source (§4.7, R21).

### 3.4 Migration 072 (S2): sale submit without START

Dated 2026-11-23. Implemented in `server/src/db/migrations/072_sale_submit_without_start.sql`.
Accepted Q1 / R9 lets a `SALE` be submitted from `ACCEPTED` without a `START`, which 006's
`job_cards_started_status_timestamp_check` did not allow. This was not foreseen when §3 was
written.

- **Change:** the CHECK is dropped and re-added. A row with status `IN_PROGRESS`,
  `WAITING_APPROVAL`, `REVISION_REQUESTED` or `COMPLETED` must have `started_at` **or**
  `type = 'SALE'`. Other types keep the original requirement.
- **Why it is safe:** the predicate is weaker, so every existing row still satisfies it.
  The migration is additive, has no DML and no backfill, and fabricates no `started_at`.
  The accountability facts (`STARTED` / `SUBMITTED`), not `started_at`, remain the audit
  evidence. A sale has no schedule that uses `started_at` as a lateness boundary.
- **Fail-closed verification:** a `DO` block raises an exception unless the constraint exists
  with a definition that mentions `SALE`. A partially applied or hand-edited database cannot
  pass silently.
- **Deployment:** schema-first. 072 must be deployed before any code path that submits a
  `SALE` from `ACCEPTED` is reachable. `HEALTH_SCHEMA_VERSION` moves to
  `072_sale_submit_without_start`.

---

## 4. Lifecycle — exact joint semantics

### 4.1 Pair discovery

The linked sale of a visit is the row with `type = 'SALE'`,
`sale_source_visit_id = visit.id` and a status in the canonical active set
(`NEW, ACCEPTED, IN_PROGRESS, WAITING_APPROVAL, REVISION_REQUESTED`). The partial unique
index guarantees at most one. Discovery is a locked read inside the command transaction,
never a client input.

### 4.2 Coordinating predicates (the whole rule)

**Precondition — one owner per live pair (R17).** While the source visit is in a
coordinating status, a pair is coordinated only when
`sale.assigned_to = visit.assigned_to`. A pair whose assignees diverge is **decoupled**:
neither card redirects, each runs its own lifecycle, and no command ever names the other
card. Divergence cannot be created after S2 (management may not reassign a `SALE` away from
its live source owner, §4.3 last item); it can exist only in data written before S2, where
management had already reassigned the sale (`service.ts:3418-3431` allows `assignedTo` on a
`SALE` today).

Rationale: `read-integration.md:41-53` guarantees that a Staff member who can read only one
card never receives the other card's id, status or details. A coordinated cross-staff pair
would have to leak `saleId`/`visitId` in redirect errors and readiness payloads, or block the
visit owner from submitting their own visit. Both are unacceptable, so the invariant removes
the situation instead of papering over it. The business need for a different person is met
by the **delivery assignee** at approval (D4), not by splitting the pair.

With the ownership invariant satisfied, a single-card command is redirected to the pair only
when the **source visit** is in the coordinating status for that command:

| Sale command | Redirected when the source visit is | Error | `expectedSaleVersion` |
| --- | --- | --- | --- |
| `SUBMIT_FOR_APPROVAL` | `IN_PROGRESS` or `REVISION_REQUESTED` | `409 SALE_SUBMIT_VIA_VISIT_REQUIRED` | required |
| `APPROVE` | `WAITING_APPROVAL` | `409 SALE_APPROVE_VIA_VISIT_REQUIRED` | required |
| `REQUEST_REVISION` | `WAITING_APPROVAL` | `409 SALE_REVISION_VIA_VISIT_REQUIRED` | required |
| `WITHDRAW_FROM_APPROVAL` | `WAITING_APPROVAL` | `409 SALE_WITHDRAW_VIA_VISIT_REQUIRED` | required |
| `RESUME` | `REVISION_REQUESTED` | `409 SALE_RESUME_VIA_VISIT_REQUIRED` | required |

Every other case keeps today's independent behaviour:

- a sale whose source is `COMPLETED`, `CANCELLED` or `INVALIDATED` submits, approves,
  revises, withdraws and resumes on its own card;
- a standalone sale always acts on its own card;
- a **decoupled legacy pair** (divergent assignee) always acts per card, with no redirect;
- a sale in `NEW` whose visit is `IN_PROGRESS` can still `ACCEPT_ASSIGNMENT` (acceptance is
  never blocked); once `ACCEPTED`, its own `SUBMIT` is redirected so D3's single submission
  still holds;
- a sale in `IN_PROGRESS` whose visit is already `WAITING_APPROVAL` (legacy) may submit on
  its own card; the visit approval then completes both (§4.4);
- `CANCEL` and `INVALIDATE` are never redirected and never cascade (§4.3, §4.8).

Every redirect error carries `details: { visitId, saleId, saleStatus, allowedSaleCommand }`.
That payload is only ever produced for an actor who can already read both cards — with the
ownership invariant, the pair owner (both sides are theirs) or management. A decoupled pair
never produces a redirect, so a staff member can never receive the other card's id from this
path.

### 4.3 Visit-side commands

**`SUBMIT_FOR_APPROVAL` on a visit with a linked active sale**

1. Run the existing visit submission validation first (`submission-policy.ts:345-393`), so
   the familiar `MEETING_NOT_READY` field errors keep their order.
2. Resolve and validate the sale (`evaluateSale`, `submission-policy.ts:315-343`) with
   `SALE_ORIGIN_VALID` satisfied per R4. A failure returns the sale's own error
   (`400 SALE_NOT_READY` with `details: { readiness }`, the sale's readiness items) and
   **writes nothing**. The same error and payload apply to a single-card sale submit. D3 forbids a silent
   split submission; the contract has no "skip the sale" option (§11 Q2).
3. Validate the sale state:
   - `ACCEPTED` or `IN_PROGRESS` → it will be submitted with the visit;
   - `WAITING_APPROVAL` → already submitted (legacy); it is left untouched and keeps its own
     submission facts;
   - `NEW` → `409 SALE_PAIR_STATE_CONFLICT`, `allowedSaleCommand: 'ACCEPT_ASSIGNMENT'`;
   - `REVISION_REQUESTED` → the same conflict, `allowedSaleCommand: 'RESUME'`.
4. Compute and persist the visit's follow-up proposal exactly as today (JOB-008), including
   automatic slot selection and its user locks (`service.ts:5710-5765`).
5. Transition the visit `IN_PROGRESS → WAITING_APPROVAL`, then transition the sale
   `ACCEPTED|IN_PROGRESS → WAITING_APPROVAL` (no transition when it is already
   `WAITING_APPROVAL`; its `staff_completed_at`/`staff_completed_by`/note stay untouched).
   Both use the same reservation instant (`reservedAt`, §4.6).
6. Append `JOB_SUBMITTED_FOR_APPROVAL` on each card this command submitted (the visit
   always; the sale only when step 5 moved it) with
   `metadata: { pair: true, linkedJobCardId: <the other id> }`. The visit's completion note
   is written to both `staff_completion_note` fields; the sale has no separate note input.
   No second submission event is ever written for an already-submitted legacy sale.
7. Accountability facts: the visit keeps its existing `SUBMITTED` fact; the sale gets one
   only when this command itself performed its submission (not when it was already
   `WAITING_APPROVAL`). A sale submitted from `ACCEPTED` without `START` writes no
   `STARTED` fact — nothing is fabricated (R9, Accepted Q1; schema in §3.4).
8. Overdue machinery (OVR-2/5b) evaluates each card with its own historical inputs; the
   visit's episode logic is unchanged, and an `APPROVAL_WAIT` obligation exists per card.

**`APPROVE` on a visit with a linked sale**

This is the single approval surface for a pair, so it carries **both** manager decisions that
may produce children: the JOB-008 follow-up proposal (existing) and the §5 delivery
(`[Accepted Q7]` default-on "Teslim işi aç"). The delivery control is rendered here, not on the
sale card (§8.1/§8.2).

1. Resolve the visit approval exactly as today (follow-up proposal, calendar).
2. Validate the optional delivery payload (§5) **before** any write.
3. Transition the visit to `COMPLETED`. Transition the sale to `COMPLETED` **only if it is
   `WAITING_APPROVAL`**; a legacy sale in any other state is left untouched (never forced
   into `COMPLETED`) and becomes independent once the visit is terminal (§4.4).
4. Both completed cards carry the same `manager_approved_at`, `manager_approved_by` and
   `manager_approval_note` (one note input, written to both).
5. Append `JOB_APPROVED` on every card this command completed, with the pair metadata;
   append `SALE_DELIVERY_CREATED` on the sale when a delivery is created.
6. Create the follow-up child (existing path, `service.ts:6045-6094`) and then the delivery
   card, in that order, in the same transaction.
7. Close each completed card's OPEN assignment offer/change request with the existing command
   rules (`service.ts:5826-5860`). An untouched legacy sale keeps its own open state.
8. If the visit has no active linked sale, the command behaves exactly as today.

**`REQUEST_REVISION`** on the visit: the visit moves to `REVISION_REQUESTED`; the sale moves
**only if it is `WAITING_APPROVAL`**. A legacy `NEW`/`ACCEPTED`/`IN_PROGRESS` sale is never
pushed into `REVISION_REQUESTED` it never earned. Same reason text, timestamp and actor;
two `JOB_REVISION_REQUESTED` rows when both move; the correction-deadline (OVR-5b) behaviour
stays visit-only. Both cards' history keeps the previous submission facts (append-only).

**`WITHDRAW_FROM_APPROVAL`** on the visit: the visit returns to `IN_PROGRESS`; the sale
returns **only if it is `WAITING_APPROVAL`**. A legacy `NEW` sale is never jumped to
`IN_PROGRESS`. The sale's `staff_completed_*` facts stay as historical evidence.

**`RESUME`** on the visit: every card of the pair that is currently `REVISION_REQUESTED`
returns to `IN_PROGRESS`. A card in another state (legacy data) is left untouched rather
than forced into a state it never had.

**`CANCEL` / `INVALIDATE`** on the visit: unchanged, single-card. The sale is **not**
cancelled, invalidated, edited or deleted. After the visit becomes terminal the sale becomes
independent and management may approve, revise, cancel or invalidate it alone. This preserves
the SALE-001 rule that a visit's later cancellation does not silently change the sale.

**`START` / `ACCEPT_ASSIGNMENT` / `DECLINE_ASSIGNMENT` / `RELEASE_ASSIGNMENT`:** unchanged,
single-card, per card.

**Assignment changes and the pair invariant.** The generic `SALE` patch accepts
`assignedTo` today (`service.ts:3418-3431`). While the sale's source visit is in a
coordinating status, a reassignment that would make `assigned_to` differ from the visit's
assignee is rejected with `409 SALE_PAIR_ASSIGNEE_CONFLICT`
(`details: { visitAssignee, requestedAssignee }`, both readable by management). Management
may still reassign the pair's owner by reassigning the **visit** first (allowed only in
`NEW`/`ACCEPTED`, so in practice only before the sale can exist) — and once the source is
terminal, reassignment is free again. The delivery assignee at approval is the supported way
to give the physical work to someone else (D4).

### 4.4 Resulting state matrix

"Reachable" distinguishes states the API can produce after S2 from states that exist only in
pre-S2 data. Every legacy row is handled without a data migration and without a barrier.

| Visit | Linked active sale | Reachable | Visit submit | Visit approve |
| --- | --- | --- | --- | --- |
| `IN_PROGRESS` | none | yes | today's behaviour | — |
| `IN_PROGRESS` | `NEW` | yes (management-created) | `409 SALE_PAIR_STATE_CONFLICT`, `ACCEPT_ASSIGNMENT` | — |
| `IN_PROGRESS` | `ACCEPTED` | yes | both → `WAITING_APPROVAL` | — |
| `IN_PROGRESS` | `IN_PROGRESS` | yes | both → `WAITING_APPROVAL` | — |
| `IN_PROGRESS` | `WAITING_APPROVAL` | legacy | visit → `WAITING_APPROVAL`, sale untouched | — |
| `IN_PROGRESS` | `REVISION_REQUESTED` | legacy | `409 SALE_PAIR_STATE_CONFLICT`, `RESUME` | — |
| `WAITING_APPROVAL` | `WAITING_APPROVAL` | yes | — | both → `COMPLETED` (+ optional delivery) |
| `WAITING_APPROVAL` | `NEW` / `ACCEPTED` / `IN_PROGRESS` / `REVISION_REQUESTED` | legacy | — | visit → `COMPLETED`; sale **untouched**, then independent |
| `WAITING_APPROVAL` | none | yes | — | today's behaviour |
| `REVISION_REQUESTED` | `REVISION_REQUESTED` | yes | after a joint resume, both submit | — |
| `REVISION_REQUESTED` | other | legacy | sale untouched | — |
| `COMPLETED` / `CANCELLED` / `INVALIDATED` | any | yes | sale is independent | — |
| any | active, assignee **diverges** | legacy | decoupled: no coordination, per-card commands | decoupled |

Why the legacy `WAITING_APPROVAL` visit row does not block: the manager can complete the
visit and leave the un-submitted sale open, then handle it on its own card (submit → approve,
with the delivery offered there). The UI states this explicitly before confirming
("bağlı satış kaydı onaylanmadan kalacak") instead of failing the approval or silently
completing an unsubmitted sale. Blocking would violate D5 for data the manager cannot fix in
that dialog.

### 4.5 Idempotency, request identity and HTTP contract

Coordinated commands reuse the 049 lifecycle reservation. The **visit is the receipt anchor**;
the sale is a **participant reservation** (§4.6). Operation keys:

| Command | Anchor key (visit) | Participant key (sale) |
| --- | --- | --- |
| submit | `JOB_SUBMIT_FOR_APPROVAL_PAIR:<visitId>` | `<anchor>:participant` |
| approve | `JOB_APPROVE_PAIR:<visitId>` | `<anchor>:participant` |
| revision | `JOB_REQUEST_REVISION_PAIR:<visitId>` | `<anchor>:participant` |
| withdraw | `JOB_WITHDRAW_FROM_APPROVAL_PAIR:<visitId>` | `<anchor>:participant` |
| resume | `JOB_RESUME_PAIR:<visitId>` | `<anchor>:participant` |

All keys stay under the 100-character `processed_actions.operation_key` limit
(`002_delivery_tracer.sql:201`). No new command name is added to `LifecycleCommand`; the 049
`command` CHECK is unchanged because a pair command records its canonical command name.

Request hash (`critical-action-request-hash.ts`), discriminator `<PAIR_OPERATION>:v1`, used
for both intent rows:

```
{ pairOperation, visitId, visitExpectedVersion, saleId, saleExpectedVersion,
  note, revisionReason, followUpProposal, locationCapture, delivery }
```

- `saleId` is part of the identity: the same key applied to a *different* linked sale must
  return `409 CLIENT_ACTION_REUSED`, never act on the new card.
- `saleExpectedVersion` is a real concurrency precondition, not a hint, exactly like
  `expectedVersion` (`service.ts:6840-6842`).
- `delivery` is hashed in normalized form: item lines in request order (sorted only for
  product locks), canonical ISO instants, trimmed note, canonical purpose. Omitted optional
  fields stay omitted; an explicit `null` is distinct from an omitted key, as in the existing
  sale hash contract (`README.md:102-108`).
- Replay returns the stored anchor receipt and publishes no events; a rolled-back attempt
  leaves no receipt and no live intent.

**HTTP contract for all five pair commands.** Every pair-capable handler must accept
`expectedSaleVersion` explicitly, because `body(request, FIELDS)` rejects unknown keys
(`handlers.ts:169-180`, `:372-376`). Required changes:

| Handler | Current fields | Required |
| --- | --- | --- |
| `submit` | `SUBMIT_FIELDS` (`handlers.ts:179`) | add `expectedSaleVersion` |
| `approve` | `APPROVE_FIELDS` (`handlers.ts:180`) | add `expectedSaleVersion` and `delivery` |
| `requestRevision` | inline list (`handlers.ts:372`) | add `expectedSaleVersion` |
| `withdrawFromApproval` | `LIFECYCLE_FIELDS` (`handlers.ts:374`) | new `WITHDRAW_FIELDS` = `LIFECYCLE_FIELDS` + `expectedSaleVersion` |
| `resume` | `LIFECYCLE_FIELDS` (`handlers.ts:376`) | new `RESUME_FIELDS` = `LIFECYCLE_FIELDS` + `expectedSaleVersion` |

`LIFECYCLE_FIELDS` itself stays untouched: it is still used by `accept` (and today also by
`withdraw`/`resume`, which move to the dedicated constants above). `cancel` uses its own
inline list (`cancelReason`, `followUpContinuity`), and `decline`/`release` use
`ASSIGNMENT_DECISION_FIELDS`; all three must keep rejecting `expectedSaleVersion`.
`START_FIELDS` is unchanged.

Rules for the field, identical on all five endpoints:

- **Required** when the pair is coordinated for that command (§4.2 row).
- **Rejected** with `409 SALE_PAIR_STATE_CONFLICT` when supplied but no coordinated pair
  exists for that command (a race or a stale client view is a conflict, not a validation
  error). `details: { reason: 'NO_COORDINATED_PAIR' }`.
- Part of the request hash in both cases, so a client cannot flip pair-mode silently under
  the same `clientActionId`.

### 4.6 Lock order, reservation and the single transaction

A pair command is **one** database transaction with **two** intents and **two** JobCard row
locks. The 049 reservation is not a side channel: it must lock the same rows in the same
order as finalization, or it becomes the deadlock source.

Canonical order for the whole command:

```
processed_actions claim (anchor operation key)
  -> users            FOR NO KEY UPDATE / FOR UPDATE, sorted, one call
  -> customers        FOR UPDATE
  -> contacts         FOR SHARE, sorted
  -> products         FOR SHARE, sorted
  -> job_cards        FOR UPDATE, sorted by id (visit + sale)
  -> lifecycle intents FOR UPDATE (anchor, then participant)
  -> work: transitions, activities, follow-up child, delivery, receipt
```

**Reservation transaction** — `reserveLifecycleIntent` needs four changes
(`repository.ts:5174-5234`):

1. `additionalJobCardIds?: readonly string[]` and a lock set
   `[jobCardId, ...additionalJobCardIds].sort()`, all locked `FOR UPDATE` **before** the
   receipt recheck and the `reservedAt` sample. Locking the anchor first and then the sale in
   `preflight` is forbidden: when `saleId < visitId` it inverts the sorted order and
   deadlocks against a concurrent finalization; reading the sale unlocked in `preflight`
   creates a TOCTOU window between reservation and finalization.
2. `preflight(tx, jobs: ReadonlyMap<string, JobCard>, reservedAt)` receives **both** locked
   rows, so `assertLifecycleReservation` can validate the visit's transition/offer/deadline
   state and the sale's transition/offer state in one place, with no extra locks.
3. **Two intent rows** in the same reservation transaction, both `state = 'PENDING'`, same
   `reserved_at`/`expires_at`:
   - anchor: `job_card_id = visitId`, `operation_key = <PAIR_OPERATION>:<visitId>`;
   - participant: `job_card_id = saleId`, `operation_key = <anchor>:participant`, same
     `command`, same `request_hash`, `expected_version = expectedSaleVersion`.

   This satisfies the 049 FK/history model per card, makes `listLiveLifecycleIntents` report
   an in-flight command for **both** cards (`overdue-breach-scanner.ts:167`,
   `assignment-offer-expiry-worker.ts:183`), and keeps demo purge correct
   (`demo-data/repository.ts:417,466` delete/lock intents by `job_card_id`). Only the anchor
   owns a `processed_actions` row, so `lifecycleReceipt` (which joins on `operation_key`,
   `repository.ts:5152-5171`) is only ever called with the anchor claim; the participant's
   key has no receipt and is not used for replay.
4. **Version fence for both cards before insertion**: `expectedVersion` for the anchor and
   `expectedSaleVersion` for the participant are compared under the locks. A mismatch is
   `409 VERSION_CONFLICT` and inserts neither intent row.

**Finalization transaction** — `finalizeLifecycleIntent` needs these changes
(`repository.ts:5247-5345`):

- `options.jobCardIds` (anchor + participant, sorted internally) replaces the single
  `options.jobCardId` lock; the intent SELECT still filters on the anchor `job_card_id`.
- a **new `options.lockReferences` hook** that runs after `lockUsers` and before the JobCard
  locks. It exists because `finalize` currently goes straight from user locks to
  `getJobForUpdate` (`repository.ts:5271-5274`) with no place for
  `customers -> contacts -> products`. Without it, §4.6's order is unimplementable.
- Both intent rows are read `FOR UPDATE` (anchor then participant), hashed, state-checked and
  `reserved_at`-checked exactly like the single-card path; the participant must be
  `PENDING` with the reservation's `reserved_at`.
- `work(tx)` runs with both rows locked; on success **both** intents become `COMPLETED` and
  the anchor's `processed_actions` row becomes `completed`.
- On a 4xx `AppError` (except `CLIENT_ACTION_REUSED`/`ACTION_IN_PROGRESS`) **both** intents
  become `FAILED` with the same `failure_code`/`failed_at`, in the same recovery transaction,
  after re-locking the sorted job ids (the existing recovery path re-locks only the anchor,
  `repository.ts:5318-5327`). Expiry marks both `LIFECYCLE_INTENT_EXPIRED`; there is no
  half-failed pair.

**Reference locks in `lockReferences`.** The ids are known before the JobCard locks: the
visit's customer from an unlocked snapshot (lock planning, re-verified after the locks — the
same pattern `lockUsers` already uses) and the delivery products from the request body.
- customer: the visit's customer; the sale's customer must equal it, verified after the
  locks (`INVARIANT_VIOLATION` if not, since the pair cannot span customers);
- contacts: only when a reference must be validated (none in the pair commands today);
- products: the delivery item products, sorted, `FOR SHARE`.
This also **fixes a pre-existing inversion**: the single-card `APPROVE` path currently locks
the customer inside `resolveApproveFollowUp` **after** the JobCard row
(`service.ts:7087-7090`), and the submit-time `autoScheduleFollowUpProposal` can do the same
when `lockCustomer` is true (`service.ts:7133-7136`). S2 moves the approve customer lock into
`lockReferences` for **both** the single and the pair approve path, so a concurrent pair
approve and a single visit approve of the same customer cannot form a
`customers -> job_cards` / `job_cards -> customers` cycle. The later reads stay but must not
be the ordering authority (re-locking an already-held row is a no-op).

**Work-callback re-validation.** Under the locks the callback re-reads both rows and proves:
the versions, the visit→sale linkage (`sale.sale_source_visit_id = visit.id`), the pair
ownership invariant (`assigned_to` equality), and the stored assignees against the pre-lock
snapshot (`sale.assignedTo === lockedSaleSnapshot.assignedTo` and the visit equivalent —
the same fence as `service.ts:5636-5640`). Any change fails `409 VERSION_CONFLICT` and writes
nothing.

**Deadlock policy.** Unchanged: `40P01`/`40001` rolls back to `409 ACTION_IN_PROGRESS` with no
receipt and no live intent (`SERVORA_MED_API_DRAFT.md:152-158`).

**Migration impact: none.** 049's table, `command` CHECK, FK and UNIQUE already support two
rows per action because their `operation_key` differs; no 071 change is needed for intents.

### 4.7 Atomicity, activity and realtime

- One transaction: two transitions (or one, for a legacy card that is not coordinated), two
  activity rows, follow-up proposal/child, optional delivery card + its item rows, both
  intents, the anchor receipt and realtime rows. Any failure rolls all of it back.
- Exactly one lifecycle activity row per card that actually moved, plus the existing child
  facts. No duplicate `JOB_COMPLETED`-style event, no status-change event.
- Realtime: the existing bodyless `job.updated` invalidation for both cards, plus the
  existing `job.created` / assignment for the delivery and the follow-up child. The
  restricted-origin audience rules of `visit-to-sale-data-lifecycle.md` §7 apply unchanged:
  a staff member who cannot read the source must not receive its id.
- **Standalone-sale guard (R21).** `appendRealtimeForActivity` currently calls
  `getSubmissionSale` and then `getJob(..., snapshot.sourceVisitId)` for every `SALE`
  (`service.ts:1003-1009`). With a nullable source that would query `getJob(org, null)`.
  The branch becomes `if (snapshot?.sourceVisitId) { ... }`, and it adds the source key and
  the source assignee to the audience **only when that assignee is the sale's own assignee**
  (the live-pair invariant) or the viewer is management. A decoupled legacy pair therefore
  never receives the other card's `job-detail:` key.
- Notifications: unchanged kinds. `job.awaiting_approval` once per submitted card (two
  notifications for a pair), approval/revision notifications per card. No new notification
  kind, no push template.

### 4.8 Edge cases (explicit answers)

| Case | Answer |
| --- | --- |
| The linked sale is **not ready** (missing items, invalid sold time, ineligible assignee) | The visit submit fails with the sale's own error/readiness payload and writes nothing (§4.3 step 2). The UI links to the sale. No partial submission. |
| The linked sale is **already approved** (`COMPLETED`) | It is not active, so no pair exists. The visit submits and approves exactly as today; the visit approval offers **no** delivery (the sale's own approval already had that chance). |
| The linked sale is **cancelled / invalidated** | Same as approved: not active, no pair. The visit proceeds alone. |
| The linked sale is **already `WAITING_APPROVAL`** (legacy, submitted before S2) | The visit submit does not re-submit it; it keeps its own submission facts. One visit approval then completes both. |
| The **visit was completed earlier** and the sale is created afterwards (D2b) | The source is terminal, so the sale never enters the pair and runs its own submit/approve. Its approval may still create the delivery (§5). |
| The **visit is cancelled or invalidated** while the sale is `WAITING_APPROVAL` | No cascade. The sale becomes independent and management approves, revises, cancels or invalidates it alone. |
| The **visit is `WAITING_APPROVAL`** and the sale is `NEW` / `ACCEPTED` / `IN_PROGRESS` / `REVISION_REQUESTED` (possible in pre-S2 data: the sale was created from the `IN_PROGRESS` visit and only the visit was submitted) | The visit approve completes the visit and leaves the sale **untouched**; it then runs its own lifecycle on its own card, with the delivery offered at its approval. If the staff submits the sale on its own card first (allowed while the visit is `WAITING_APPROVAL`, §4.2), the visit approval completes both. Revision/withdraw/resume on the visit only move a sale that is `WAITING_APPROVAL` (§4.3). The dialog warns before confirming. No blocker. |
| A legacy sale is `NEW` and the visit submits | `409 SALE_PAIR_STATE_CONFLICT`, `allowedSaleCommand: 'ACCEPT_ASSIGNMENT'`. Only the assigned staff can accept (`policy.ts:390-391`). |
| A legacy sale is `REVISION_REQUESTED` while the visit is `IN_PROGRESS` | `409 SALE_PAIR_STATE_CONFLICT`, `allowedSaleCommand: 'RESUME'`; after the single-card resume the pair submits normally. |
| The pair is **decoupled** (legacy `assigned_to` divergence) | No coordination at all: no redirects, no pair commands, no shared ids in errors or realtime. Each card runs its own lifecycle. Management can re-align by reassigning the sale to the visit owner, which restores the pair. |
| Management tries to reassign a live-pair `SALE` to another staff member | `409 SALE_PAIR_ASSIGNEE_CONFLICT`. The delivery assignee at approval is the supported alternative. |
| The visit has **no** linked sale | Every command behaves exactly as today; `expectedSaleVersion` is rejected with `SALE_PAIR_STATE_CONFLICT` (`NO_COORDINATED_PAIR`). |
| The delivery payload is present on a non-`SALE` approval | `400 VALIDATION_ERROR`; the approval is not executed. |
| The sale already has a delivery (`SALE_DELIVERY_CREATED`) and a second one is requested | `409 SALE_DELIVERY_ALREADY_EXISTS`; the unique index is the last authority (§3). In v1 this can only occur through a repeated approve with a different payload, which is already `CLIENT_ACTION_REUSED`. |

---

## 5. Sale approval → delivery

### 5.1 API shape

Approval stays on the existing named command; only the body grows by one optional object.
`APPROVE_FIELDS` gains `delivery` and `expectedSaleVersion`
(`server/src/modules/job-cards/handlers.ts:180`).

```http
POST /api/job-cards/:id/approve
{
  "clientActionId": "…",
  "expectedVersion": 7,                 // :id card version
  "note": "…",                          // optional, existing
  "expectedSaleVersion": 3,             // required iff a coordinated pair exists
  "delivery": {                         // optional; absent = no delivery
    "assignedTo": "uuid",
    "scheduledAt": "2026-11-24T07:00:00.000Z",
    "scheduledEndsAt": "2026-11-24T07:30:00.000Z",   // optional; must equal the canonical end
    "deliveryPurpose": "SALE",          // optional; default "SALE"
    "note": "…",                        // optional, ≤ 4000; stored as the card description
    "items": [ { "productId": "uuid", "quantity": 2 } ],
    "pastStartAcknowledgement": { "code": "…", "text": "…" }  // optional, existing shape
  }
}
```

- `:id` may be the visit (pair) or a standalone/retro sale. A sale approve whose source is
  `WAITING_APPROVAL` is redirected (`SALE_APPROVE_VIA_VISIT_REQUIRED`).
- `delivery` is accepted only when the command completes a `SALE`: either `:id` is the sale,
  or `:id` is a visit with a coordinated sale. On any other approval it is a
  `400 VALIDATION_ERROR`.
- `expectedSaleVersion` is required iff a coordinated pair exists for this command; supplied
  without one → `409 SALE_PAIR_STATE_CONFLICT` (`NO_COORDINATED_PAIR`); a coordinated pair
  without it → `400 VALIDATION_ERROR` (`expectedSaleVersion`). Identical on all five pair
  commands (§4.5).
- **Response shape.** The HTTP response is the existing `presentLifecycleReceipt` output: the
  full `JobCardDetail` of the anchor card merged with `{ followUpJobCardId? }`
  (`service.ts:6212-6224`), not the minimal stored receipt. S2 adds
  `{ linkedSaleJobCardId?, deliveryJobCardId? }` to **both** the stored receipt and the
  presented detail (the presenter copies them from the receipt, so replay is identical).
  `linkedSaleJobCardId` appears only when the sale actually moved in that command.

### 5.2 Validation reuse (no second implementation)

| Concern | Rule and source |
| --- | --- |
| Item batch | `assertInitialProductDeliveryItems` / `parseInitialDeliveryItems`: 1–25 distinct products (`service.ts:490-504`, `create-input.ts:219-235`). |
| Quantity | `parseDeliveryQuantity`: whole integer 1–999999999, no rounding (DELIVERY-QTY-001, `delivery-input.ts:32-39`). |
| Product eligibility | `assertDeliveryProductEligible` against the `BUSINESS` scope (`service.ts:462-467`), identical to `createProductDelivery` (`service.ts:2642-2652`). Inactive/cross-org products stay `404 PRODUCT_NOT_FOUND`. |
| Customer | The sale's customer. It is already `BUSINESS` by 057's sale-fields CHECK (`057:17-25`), so the delivery path reuses `validateJobReferences` (`service.ts:4087-4102` → `getCustomerForUpdate`, which selects only `id, status`, `repository.ts:3482-3488`): same organization and active. An inactive customer blocks **only** the delivery, with the existing `409 CUSTOMER_INACTIVE`; no second data-class check is invented. |
| Assignee | `assertCanCreateForAssignee` (`policy.ts:223-227`): active same-organization STAFF; management may choose anyone, including a different person from the sale's staff. Default is the sale's `assigned_to`. |
| Schedule | `scheduledAt` required (JOB-006 §4); `scheduledEndsAt` canonical (`canonicalScheduledEnd('PRODUCT_DELIVERY', …)`) when supplied. Calendar availability is checked when the calendar module is enabled, exactly like `createProductDelivery` (`service.ts:2629-2637`). |
| Purpose | `DELIVERY_PURPOSES` from DOM-001. Default `SALE`. |
| Note | ≤ 4000 characters, trimmed; stored once as the card `description`. It is never duplicated into `deliveryNote`. |
| Planned vs actual | Items are inserted with `deliveredAt = NULL` through `insertInitialDeliveryItems` (`service.ts:2552-2593`). The staff records the actual time later; submission still requires it (`submission-policy.ts:74-80`). Nothing is fabricated. |

### 5.3 Card properties

- `type = 'PRODUCT_DELIVERY'`, `data_class = 'BUSINESS'`, `status = 'NEW'` (management
  created it: `APPROVE` is management-only (`policy.ts:387-389`), and
  `assertCanCreateForAssignee` independently requires the assignee to be an active STAFF
  user, so the self-accepted branch of `createProductDelivery` cannot apply),
  `created_by = actor`, `customer_id = sale.customer_id`,
  `delivery_source_sale_id = sale.id`, `due_date = NULL`, `source_job_card_id = NULL`.
- Title: the sale title, trimmed to 255 code points (a sale title is already ≤ 255).
- One `JOB_CREATED` plus one `DELIVERY_ITEM_ADDED` per line, exactly like the normal create
  (`service.ts:2685-2705`).

### 5.4 JOB-010 interplay

- The manager-created delivery is a **direct producer** and opens an assignment offer with
  `opened_reason = 'SALE_APPROVAL'` (`service.ts:2706-2716`), which requires R13.
- The two existing hard returns are surfaced as field errors on `delivery.scheduledAt` in the
  approval dialog, not as opaque failures:
  `409 ASSIGNMENT_WINDOW_TOO_SHORT` (pick a later time) and
  `409 PAST_START_ACKNOWLEDGEMENT_REQUIRED` (supply `pastStartAcknowledgement`).
- **Retry contract after a definitive failure (049 `FAILED`).** Any 4xx `AppError` inside the
  intent finalization marks **both** intent rows `FAILED` with that `failure_code`
  (`repository.ts:5318-5327`); a later attempt with the same `clientActionId` is always
  refused: a byte-identical body throws `lifecycleIntentError` (message: "Yeni bir işlem
  anahtarıyla tekrar deneyin"), and a changed body fails the ARC-001 request-identity check
  first with `409 CLIENT_ACTION_REUSED`. Therefore:
  - after `ASSIGNMENT_WINDOW_TOO_SHORT`, `PAST_START_ACKNOWLEDGEMENT_REQUIRED`,
    `CUSTOMER_INACTIVE`, `PRODUCT_NOT_FOUND`, `VALIDATION_ERROR` or any other definitive 4xx,
    the corrected approval **must use a new `clientActionId`** with the new time,
    acknowledgement or line set;
  - the same key is reused **only** for an uncertain outcome where no definitive answer was
    received (network/timeout/5xx/`ACTION_IN_PROGRESS`, or a `40P01`/`40001` rollback), and
    then only byte-identically.
  The UI must not pre-compute a key before the manager commits: the key is created when the
  request is first sent, and a definitive error resets it together with the field that must
  change (same pattern as the existing sale-create "definitive rejection → new intent" rule,
  `write-ui-integration.md:78-92`).
- The offer's accept/decline/release, expiry, notifications and reports rules are unchanged.
  A short-notice or past-start delivery is an operational reality, never staff fault.

### 5.5 Atomicity, activity, realtime

- The delivery card, its item rows, every `COMPLETED` transition this command performed (one
  or two, depending on whether the sale was coordinated), the follow-up child, the activity
  rows, **both intents** and the anchor receipt commit together. A failure in any part leaves
  the sale and the visit in `WAITING_APPROVAL` and both intents `FAILED`.
- New fact on the sale: `SALE_DELIVERY_CREATED` with
  `metadata: { deliveryJobCardId, assignedTo, scheduledAt, itemCount, items: [{productId, quantity}] }`.
  Raw internal payloads are not emitted; the safe presenter projects this shape.
- The delivery's own `JOB_CREATED` carries no link back; provenance lives in the column and
  in the sale's fact. The delivery detail shows "Satış kaydından oluşturuldu" with a link
  only when the viewer can read the sale.
- Realtime: `job.created` + assignment invalidation for the delivery, `job.updated` for the
  completed cards, the existing follow-up child events. Publishing happens after commit only;
  a replay publishes nothing. The delivery event's audience includes the sale's owner and the
  manager; a staff member who cannot read the sale never receives its id.

---

## 6. Standalone and completed-visit sale creation

### 6.1 Standalone (`sale_source_visit_id IS NULL`)

```http
POST /api/job-cards/sales
{
  "clientActionId": "…",
  "title": "…",                       // 1–255 after trim
  "description": "…",                  // optional, ≤ 4000
  "customerId": "uuid",               // required
  "assignedTo": "uuid",               // STAFF: must equal the actor
  "soldAt": "2026-11-23T09:30:00.000Z",
  "saleContactId": "uuid|null",        // optional
  "items": [ { "productId": "uuid", "quantity": 3 } ]
}
```

Rules:

- **Permissions (D2):** STAFF creates only for themselves (`assertCanCreateForAssignee`);
  MANAGER/ADMIN may name any active same-organization STAFF user. Customer required, active,
  `BUSINESS`, same organization. No `type`, `status`, snapshot, source, assignee-override or
  unknown keys are accepted (strict allowlist, same parser style as
  `sale-input.ts`/`create-input.ts`).
- **Sale contact:** optional; when present must be active and belong to the chosen customer
  (`sale-service.ts:127-136` semantics reused).
- **Items:** 1–25 distinct active `BUSINESS` products; integer counts; snapshots
  name/SKU/brand/model/unit captured at creation (SALE-QTY-001).
- **Status:** STAFF → `ACCEPTED` (`accepted_at`/`accepted_by` = request instant/actor);
  management → `NEW`. Same rule as visit-origin creation (`sale-service.ts:202-211`).
- **Details row:** `sold_at`, optional sale contact snapshot; **all** source columns NULL
  (the shape CHECK enforces it). `source_*` snapshots are never fabricated.
- **Activity:** `JOB_CREATED` + one `SALE_ITEM_ADDED` per line. No source event exists.
- **Identity:** `operationKey = 'SALE_STANDALONE_CREATE'`, discriminator
  `SALE_STANDALONE_CREATE:v1`, hash over the normalized body (customer, assignee, title,
  description, `soldAt`, contact, ordered items). Replay returns the original
  `{ jobCardId, version }`.
- **Lock order:** users (actor + assignee, sorted) → customer `FOR UPDATE` → contacts
  `FOR SHARE` (sorted) → products `FOR SHARE` (sorted) → insert.
- **Errors:** `CUSTOMER_NOT_FOUND` / `CUSTOMER_INACTIVE` / `SALE_REFERENCE_NOT_ELIGIBLE`
  (non-BUSINESS customer or product) / `CONTACT_NOT_FOUND` / `CONTACT_NOT_IN_CUSTOMER` /
  `CONTACT_INACTIVE` / `PRODUCT_NOT_FOUND` / `SALE_PRODUCT_DUPLICATE` /
  `SALE_ITEM_LIMIT` / `SALE_TIME_INVALID` (existing vocabulary).
- **No delivery, no follow-up, no visit mutation.** A standalone sale is still a `SALE`
  card: its submission/approval path is its own until it is approved; its approval may
  create a delivery per §5.

### 6.2 Sale from a `COMPLETED` visit

- Same `POST /api/job-cards/:visitId/sales` route and body as today
  (`write-ui-integration.md:16`); only `assertSaleSourceEligible` widens (R3).
- Customer, assignee and all origin snapshots are still derived from the locked visit
  (`sale-service.ts:180-223`). The sale still writes one `SALE_FROM_VISIT_CREATED` fact on
  the visit, which remains accurate: the sale was recorded from that visit.
- One active sale per visit is unchanged; a completed visit whose previous sale is still
  active returns `409 SALE_FROM_VISIT_ACTIVE_EXISTS` (`sale-service.ts:143-149`).
- The sale's own lifecycle applies immediately (independent approval), because a
  `COMPLETED` source never enters the coordinating states (§4.2). Its approval may create a
  delivery per §5 — this is the "retro record the sale, then ship it" flow.
- STAFF may create only from their own currently assigned visit; management for that visit's
  staff. Assignment therefore follows the *current* visit owner, which is operational
  ownership, not sale credit (D6/REPORT-002, §7).

### 6.3 UI entry points

- Visit detail (`IN_PROGRESS` and now `COMPLETED`): the existing secondary
  **Satış kaydı oluştur** action and **Bağlı satışlar** block
  (`web/src/jobs/SaleDetails.tsx:43-87`, `web/src/JobDetail.tsx:2793`). No new route.
- Global create menu: one new entry **Satış kaydı** opening a standalone form
  (customer picker → staff picker for management → sale contact → sold time → products →
  description). The existing `SaleCreate` screen is reused with a new context mode rather
  than a second form implementation.

---

## 7. Reports impact

- **Sale counts.** Approved `SALE` cards (`status = 'COMPLETED'`, `manager_approved_at` set)
  keep their current meaning: product agreements, never revenue. A pair approval and a
  independent approval produce the same counting input. Standalone sales need no new report
  branch: the type bucket already exists (`server/src/modules/reports/repository.ts:344`,
  `:1380`, `:1817-1820`) and the capability gate still hides `SALE` from legacy readers
  (`:346`, `:367-368`).
- **Delivery counts.** The sale-linked delivery is a normal `PRODUCT_DELIVERY`. It is counted
  only when `COMPLETED` with `manager_approved_at`, grouped by persisted `delivered_at`,
  purpose and unit (DOM-006). Default purpose `SALE` therefore lands in the existing
  `SALE` purpose bucket — that is the intended meaning (physical delivery under a sale),
  not a new metric.
- **Never summed.** A visit, its sale and its delivery are three operational jobs. Reports
  must not add sale counts to delivery quantities, and must not treat a delivery as a sale.
  The existing separation (`reports/repository.ts:883-897` restricts quantities to
  `PRODUCT_DELIVERY`) is preserved.
- **Attribution (D6).** Sale and delivery counts follow REPORT-002's recorded performer
  ("the staff assigned at completion"), not the button-press actor, not the approver and not
  the creator. Consequences this contract requires:
  - a delivery created for a *different* staff member than the sale creates two independent
    attributions: the sale result belongs to the sale's completion performer, the delivery
    result to the delivery's. This is intentional and must be stated in the UI copy of the
    approval dialog ("teslim işi farklı personele atanabilir").
  - The current delivery-purpose aggregate filters on `staff_completed_by`
    (`reports/repository.ts:882`). REPORT-002 owns replacing that with the verified
    performer; SALE-002 must **not** introduce a third attribution rule, and must not
    "fix" this line on its own.
- **Invalidation.** An invalidated sale is excluded like any invalidated card. The delivery
  it created keeps existing, keeps its link and keeps counting if it is itself completed:
  the physical delivery happened. No cascade, no automatic reversal (§11 Q5).
- No new report table, view, index, cache or metric contract is introduced.

---

## 8. UI changes

All UI work follows UI-001 (WCAG 2.2 AA, 44 px targets, keyboard, 200 % text and 400 %
reflow, `prefers-reduced-motion`) and produces UI-003 rendered evidence.

### 8.1 Screens and states

| Surface | Change |
| --- | --- |
| Visit detail — `IN_PROGRESS` | Unchanged: related sales + create action. |
| Visit detail — `COMPLETED` | Create action now available (R3); blocked reasons unchanged (`ACTIVE_SALE_EXISTS`, `REFERENCE_NOT_ELIGIBLE`). |
| Visit submit dialog | When a coordinated sale exists: a summary line "Bu gönderim bağlı satış kaydını da onaya gönderir", a link to the sale, and — when the sale is not ready — a blocking panel listing the sale's unmet requirements with a direct link. No "sale'i atla" control. |
| **Visit approve dialog (the pair's only approval surface)** | Must render **both** manager preludes, in this order: the existing JOB-008 `FollowUpProposalSection` (when a follow-up is required) and the interactive **"Teslim işi aç"** section of §8.2 — offered whenever the pair's sale is `WAITING_APPROVAL`, i.e. it will be completed by this same approval. A summary line states that the approval completes the sale too, and — for a legacy sale that is not `WAITING_APPROVAL` — a warning that the sale will stay open and unapproved ("bağlı satış kaydı onaylanmadan kalacak"; the delivery section is then not offered, because no sale is being completed). |
| Visit / sale revision + withdraw dialogs | A line stating whether the pair moves together or only the card in hand (legacy sale in another state). |
| Sale detail | Remove the false "teslimat oluşturmaz" copy (`JobDetail.tsx:2791`) **in S3**, together with the feature it describes; keep the MOD-001 "no stock/accounting" statements. Add a **Bağlı teslimat** panel (status + link, or "henüz teslim işi açılmadı") when `deliverySourceSaleId` is exposed. |
| Sale detail — standalone | Origin block renders "Bağımsız satış kaydı (ziyaret yok)" instead of the restricted-source message (R11). |
| **Sale approve dialog (independent sale only)** | The same §8.2 **"Teslim işi aç"** section, because a standalone sale or a sale from a terminal visit has no visit approval to carry it. A coordinated pair never reaches this dialog: it is redirected (`SALE_APPROVE_VIA_VISIT_REQUIRED`). |
| Standalone create | New menu entry + form (customer, staff for management, contact, sold time, products, description). |
| Delivery detail | Provenance line "Satış kaydından oluşturuldu" with a link only when the sale is readable; otherwise no id is shown. |

Component consequence: `SaleApprovalDeliverySection` is **one** component mounted by two
dialogs (visit approve and independent sale approve). It must not be duplicated, and it takes
the sale detail projection as a prop so the pair dialog can prefill it without a second
request.

### 8.2 "Teslim işi aç" section (visit approval and independent sale approval)

`[Accepted Q7]`: D4 says the approval "offers an easy 'Teslim işi aç' button"; the default
below is the recommended one, not an owner-confirmed rule.

- A single labelled switch/checkbox. Recommended default: **on** when the sale has at least one
  item and an eligible customer, because the owner's intent is that a sale normally ships
  (D5), and unticking is one click. Off and explained when no eligible assignee or an inactive
  customer makes it impossible.
- Product lines prefilled from `saleDetails.items` with editable integer quantity
  (`min=1`, `max=999999999`, `step=1`, `inputMode=numeric`), each removable, plus the
  shared `ProductSelect` for additions (BUSINESS-scoped loader, identical to
  `SaleCreate`/`DeliveryCreate`). A local pre-check rejects empty, fractional or duplicate
  products; the server remains authoritative.
- Assignee select defaulting to the sale's staff; any active STAFF member is selectable. This
  is the supported way to give the physical delivery to a different person (D4) — the sale
  itself stays with the pair owner (§4.2).
- Planned datetime defaulting to tomorrow at the next half-hour boundary
  (`defaultScheduledLocalValue(now + 24h)`), device-local with the timezone stated, matching
  the existing create form convention (`write-ui-integration.md:43-48`). Tomorrow avoids a
  needless `SHORT_NOTICE` offer.
- Purpose select (default `SALE`) and one optional note (≤ 4000).
- Helper text states the consequence exactly once: "Onayla birlikte planlanmış bir ürün
  teslimi oluşturulur; teslim personeli kabul edip gerçekleşen zamanı girdikten sonra onaya
  gönderir."
- For a **standalone** sale or a sale from a terminal visit, the section also states that the
  delivery is the only downstream job this approval creates (no visit exists to carry it).

### 8.3 Error, focus and accessibility contract

- The dialog has one accessible summary region (`role="status"` while pending,
  `role="alert"` on failure) and moves focus to the first invalid control.
- `ASSIGNMENT_WINDOW_TOO_SHORT`, `PAST_START_ACKNOWLEDGEMENT_REQUIRED`,
  `CUSTOMER_INACTIVE`, `PRODUCT_NOT_FOUND`, `VALIDATION_ERROR(items)`,
  `SALE_PAIR_ASSIGNEE_CONFLICT` and `SALE_PAIR_STATE_CONFLICT` map to their exact field or to
  the pair summary, never to a generic banner.
- All new controls are native form controls inside a labelled `fieldset`/`legend`; the
  switch is a real checkbox, not a styled div; the product rows keep the existing
  quantity-before-identity order.
- Pending/ambiguous semantics are inherited: while an approval is unresolved, the switch,
  product rows, assignee, datetime and the confirm button stay locked; the exact original
  body is retried only with the same `clientActionId`. A **definitive** failure resets the
  key (049 `FAILED`, §5.4) and re-enables the controls; the UI must not silently resend the
  old key.
- No information is carried by colour alone; the pair summary uses text plus iconography.

---

## 9. Test matrix

PostgreSQL tests require the isolated `TEST_DATABASE_URL` and PostgreSQL 17 contract
(`docs/operations/local-test-environment.md`). No test may report a skipped
environment-dependent case as passed.

### 9.1 PostgreSQL schema and migration (`sale-schema-postgres.test.ts` extension)

- Clean migrate to `071`; an applied `070` database upgrades to `071` with existing sale rows
  and existing deliveries; no re-apply; exact catalog head; `HEALTH_SCHEMA_VERSION` moves.
- `sale_source_visit_id` NULL allowed only for `SALE`; a non-`SALE` row with a source is
  rejected; a `SALE` without a source is accepted.
- Sale details: all-null source shape accepted; a partially-null shape rejected; the
  visit-origin shape still accepted.
- `delivery_source_sale_id`: FK same-organization; self-link rejected; non-`PRODUCT_DELIVERY`
  rejected; two deliveries for one sale rejected by
  `job_cards_one_delivery_per_sale_idx` (23505) with a domain mapping.
- Activity CHECK accepts `SALE_DELIVERY_CREATED`; assignment-offer CHECK accepts
  `SALE_APPROVAL`; every pre-existing event/reason value still accepted.

### 9.2 Unit / policy

- `sale-origin-policy`: `IN_PROGRESS` and `COMPLETED` eligible; `NEW`, `ACCEPTED`,
  `WAITING_APPROVAL`, `REVISION_REQUESTED`, `CANCELLED`, `INVALIDATED`, DEMO, missing
  customer/engagement rejected.
- Standalone input parser: strict allowlist, unknown keys, missing customer, missing
  assignee, staff-for-another-staff, 0/26 items, fractional/zero/overflow quantity,
  duplicate product, inactive product/customer/contact, contact of another customer.
- Sale readiness: `SALE_ORIGIN_VALID` = `met` for a standalone sale, `invalid` for a
  source-linked sale whose source disappeared.
- Pair policy table: each of the five redirect predicates, both directions, plus the
  "terminal source releases the sale" cases.
- Submitting a `SALE` from `ACCEPTED` (Accepted Q1, migration 072); every other type unchanged.

### 9.3 Service and HTTP (`sale-pair-lifecycle-postgres.test.ts`,
`sale-approval-delivery-postgres.test.ts`, `sale-standalone-postgres.test.ts`)

- Joint submit: one transaction, two `JOB_SUBMITTED_FOR_APPROVAL` rows, both
  `WAITING_APPROVAL`, same instant, same note, sale `ACCEPTED → WAITING` without a
  `STARTED` fact, visit follow-up proposal still persisted.
- Joint submit blocked: sale not ready (no write, sale readiness errors returned), sale
  `NEW`, sale `REVISION_REQUESTED`, stale `saleExpectedVersion`.
- **Reservation and locking (R19/R20):**
  - both intent rows exist with the same `reserved_at`/`request_hash`, anchor on the visit and
    participant on the sale; both become `COMPLETED` together and `FAILED` together;
  - a definitive 4xx marks both `FAILED`, and a retry with the same key throws
    `lifecycleIntentError` (049), proving §5.4;
  - `listLiveLifecycleIntents` returns an in-flight command for **both** cards during a slow
    pair transaction;
  - a deliberately delayed `reserve` proves the sorted id lock set (visit id greater **and**
    smaller than the sale id) and that no `job_cards -> customers` inversion occurs: a
    concurrent single visit approve of the same customer and a pair approve do not deadlock
    (repeat under a contended customer row);
  - a stale `lockedSaleSnapshot.assignedTo` fails `VERSION_CONFLICT` and writes nothing.
- **Cross-staff ownership (R17):** reassigning a live-pair `SALE` to another staff fails
  `SALE_PAIR_ASSIGNEE_CONFLICT`; a legacy divergent pair is decoupled (visit submit/approve
  succeeds alone, sale submit/approve succeeds alone, no cross ids in errors, activity or
  realtime); management re-aligning the sale to the visit owner restores coordination.
- Joint approve: both `COMPLETED`, same `manager_approved_at/by`, one approval note, two
  activity rows, follow-up child and delivery child both created.
- **Legacy mixed states:** visit `WAITING_APPROVAL` + sale `NEW`/`ACCEPTED`/`IN_PROGRESS`/
  `REVISION_REQUESTED` — the visit approves without touching the sale, revision/withdraw do
  not force the sale, and the sale then runs its own lifecycle.
- Joint approve without `delivery`: no delivery row, no `SALE_DELIVERY_CREATED`.
- Delivery payload: default purpose, canonical `scheduledEndsAt`, integer quantities,
  BUSINESS-only products, 25-line cap, note → description, different assignee from the sale.
- JobCard/offer interplay: `SALE_APPROVAL` offer opened, `SHORT_NOTICE` vs
  `ASSIGNMENT_WINDOW_TOO_SHORT`, `PAST_START_ACKNOWLEDGEMENT_REQUIRED` with and without the
  acknowledgement, calendar conflict, inactive customer → `CUSTOMER_INACTIVE` and **no**
  partial approval; the corrected attempt uses a **new** `clientActionId`.
- Revision/withdraw/resume pairs: both cards move, prior submission facts preserved.
- Cancel/invalidate: visit cancel leaves the sale untouched and the sale then acts alone;
  sale invalidate leaves the delivery untouched.
- Idempotency: replay of every pair command returns the identical receipt with no new rows;
  same key + changed `saleExpectedVersion`/delivery payload → `CLIENT_ACTION_REUSED`;
  two concurrent pair commands → one commit, other `ACTION_IN_PROGRESS`/conflict;
  `expectedSaleVersion` missing/extra → `400`/`409 SALE_PAIR_STATE_CONFLICT`.
- Deadlock/lock order: concurrent pair approve and single-card patch; concurrent standalone
  create and pair submit; sorted-id lock proof (two pair commands anchored on opposite
  members cannot deadlock).
- Standalone create: HTTP 201, receipt, replay, tenant isolation, STAFF self only,
  `NEW` vs `ACCEPTED`, no source event, no visit mutation, and no realtime source lookup
  (`getJob` is never called with a null source id).
- Retro sale from a `COMPLETED` visit: created, snapshots preserved, source event on the
  visit, second active sale blocked, own approval path.
- Cross-org and capability gates: legacy Sale concealment unchanged; a staff member who
  cannot read the source never receives its id in any pair response, activity or realtime.

### 9.4 Web

- `sale-create-screen.test.tsx`: standalone mode (customer/staff/contact), completed-visit
  mode, frozen-intent retry, blocked eligibility states.
- `sale-approval-delivery-dialog.test.tsx`: the **same** `SaleApprovalDeliverySection`
  mounted by the visit approve dialog and the independent sale approve dialog; default-on
  switch (Q7 default), prefill from sale items, quantity edit/removal/addition, assignee
  default and change, datetime default, error mapping, locked state while pending, confirm
  payload shape, and the legacy "sale stays open" warning.
- Pair dialogs: submit/approve/revision summaries, not-ready sale panel, link navigation,
  `expectedSaleVersion` included in every pair request body, definitive-failure key reset.
- `sale-details` / standalone origin copy; delivery provenance panel; no restricted-source
  message for standalone or when the sale is readable.
- Full `npm test -- --run` plus `npm run build` in `web`; server `npm run build` and
  `npm test -- --run`.

### 9.5 UI-003 rendered evidence

Playwright + headless Chromium against real components with deterministic synthetic
medical/dental data, actual `ServoraAntProvider` and production CSS:

- 390 px and 1440 px: the **visit approve dialog** with the follow-up proposal and the
  delivery section together (on/off, error states, long product names, 25 lines), plus the
  independent sale approve dialog with the same section.
- STAFF view of the pair submit (no delivery section) and MANAGER view of the pair approval.
- Keyboard-only completion of the visit approval with delivery; focus order across two
  preludes and focus return.
- Record evidence limits: synthetic roles prove presentation, not backend authorization.

---

## 10. Delivery plan

Four small, independently reviewable PRs. Each one ends green (server build + tests, web
build + tests) and updates the owning documents in the same commit.

| Slice | Content | Depends on | Explicitly not included |
| --- | --- | --- | --- |
| **S1 — schema + standalone/retro sale** | Migration 071 (constraints only, no link usage yet); `assertSaleSourceEligible` widened; standalone create service/route + input parser; root DTO origin `STANDALONE`; `SaleSubmissionSnapshot` nullability + conditional `SALE_ORIGIN_VALID`; standalone realtime guard (R21); UI entry for standalone + completed-visit create | — | No pair commands, no delivery link, no approval dialog section, **no R10 copy change** |
| **S2 — pair submit/approve/revision** | Migration 072 (R9: `SALE` may reach a post-start status without `started_at`, §3.4); pair discovery, ownership invariant (R17), redirect guards (R15), joint submit/approve/revision/withdraw/resume, `expectedSaleVersion` in all five handlers (R18), pair intent keys + hashes + **two intent rows** and the `reserve`/`finalize` extensions incl. `lockReferences` (R19), approve customer pre-lock (R20), pair activity/realtime, web dialogs | S1 (policy and nullability) | No delivery payload |
| **S3 — sale approval → delivery** | `delivery` payload, validation reuse, `delivery_source_sale_id` write, `SALE_APPROVAL` offer, `SALE_DELIVERY_CREATED`, `SaleApprovalDeliverySection` in the **visit** approve dialog and the independent sale dialog, delivery provenance read/panel, **R10 copy fix**, full PG concurrency tests | S2 (atomic pair approval) and S1 (column) | No replacement/partial delivery |
| **S4 — UI completion and evidence** | Mobile/keyboard/zoom UI-003 evidence for both dialogs, standalone form polish, docs and `DECISIONS.md` record | S1–S3 | No calendar work (D7) |

Sequencing rules:

- 071 lands **before** any code writes `delivery_source_sale_id` or a nullable sale source,
  because the deployment gate is schema-first. S1 may ship the column unused; S3 is the first
  reader/writer.
- The R10 copy change is deliberately **not** in S1: between S1 and S3 the product must not
  claim that approval opens a delivery before that exists.
- S2 must land the reservation/finalization changes as one unit. Splitting "pair commands"
  from "two intents + `lockReferences`" would ship the deadlock §4.6 prevents.

Implementation status (S3 backend): the `delivery` payload, validation reuse, the
atomic delivery card, the `SALE_APPROVAL` offer, `SALE_DELIVERY_CREATED`, the request-hash
and receipt members, the shared pre-JobCard reference locks and the read-side fields
(`deliverySourceSaleId` on the delivery's JobCard detail, `linkedDelivery` on the sale's JobCard detail) ship
with the server (`sale-approval-delivery-input.ts`, `createSaleApprovalDelivery`,
`lockApprovalReferences` in `service.ts`; tests `sale-002-s3-approval-delivery-postgres`).
Interpretations the implementation fixed where this contract is silent: `delivery.assignedTo`
may be omitted and then means the sale's assignee (§5.2 default); `delivery: null` is a
`400`; the delivery priority is `normal`; the conflict code for a second delivery is
`SALE_DELIVERY_ALREADY_EXISTS` (§4.8); `linkedDelivery` is `null` for a STAFF viewer who is
not the delivery's assignee. The web section/dialogs and the R10 copy fix are not part of
this backend note.

Verification per slice: the AGENTS.md minimum commands, plus targeted suites, plus
`ops/local-ci/run.sh --sha <sha>` evidence when the release contract requires it. Never
report an unexecuted gate as passed.

---

## 11. Open questions and risks

Only genuine questions remain. `D2` already answers who may create a standalone sale (staff
for themselves, management for any staff), so that is a rule (§6.1), not a question. Each
remaining question has a recommended default; the owner may answer any of them with "use the
default". Where a default is already written into normative text, the text is marked
`[Accepted Qn]`. **Owner answer (2026-11-23): every recommended default below is accepted.**

**Q1 — Must a `SALE` be started before submission?** `[Accepted Q1]`
Today `ACCEPTED → START → IN_PROGRESS → SUBMIT` (`policy.ts:125-134`), and `START` asks for
location evidence even though a sale has no field interval.
*Recommended default:* allow `SUBMIT_FOR_APPROVAL` from `ACCEPTED` for `SALE` only (R9).
Consequence: one less click and no meaningless location capture; the `IN_PROGRESS` state
remains reachable and valid for sales that do start.

**Q2 — May a staff member submit the visit while deliberately leaving the sale behind?**
D3 says one submission closes both.
*Recommended default:* no. The sale must be submitted with the visit or cancelled by
management (staff raise a JOB-010 change request if they disagree). Alternative: an explicit
"satışı dahil etme" checkbox that leaves the sale `IN_PROGRESS` — it re-creates the split
approval D3 removes, so it is not recommended.

**Q4 — If the sale-linked delivery is cancelled, may a new delivery be opened for the same
sale?**
D4 says only one delivery per sale, no partial deliveries.
*Recommended default:* not in SALE-002. The unique index covers all statuses, so a cancelled
delivery keeps the slot; the physical follow-up is an ordinary delivery card created by
management, with no link. Re-opening the link requires a separate decision and migration.
Alternative: index only over non-terminal statuses plus a "reopen delivery" action on the
completed sale — more surface, more rules, not needed yet.

**Q5 — Does invalidating a completed sale affect its delivery?**
*Recommended default:* no. Invalidation is history correction, not physical reversal; the
delivery card, its items and its report contribution stay. The link remains as provenance.

**Q6 — Should cancelling the visit cascade to the linked sale?**
*Recommended default:* no (SALE-001). The sale becomes independent and management decides.
A cascade would delete commercial history on an operational action.

**Q7 — Is the delivery section on by default in the approval dialog?** `[Accepted Q7]`
*Recommended default:* on (D5), off when no eligible assignee or an inactive customer makes
it impossible, with the reason shown.

**Q8 — Should the sale-linked delivery default to tomorrow instead of "now + 1h"?**
*Recommended default:* tomorrow at the next half-hour boundary. "Now + 1h" produces a
`SHORT_NOTICE` offer (`acceptance_due_at = opened + 10 min`) for no operational reason.
This is a UI default only; the manager may pick any time.

### Risks

1. **Two transactions pretending to be one.** The pair command must be a single
   transaction; a "call the two services in sequence" implementation would leave half-closed
   pairs. The design forbids reusing the public single-card commands for the pair path.
2. **Reservation/finalization asymmetry (highest deadlock risk).** If `reserve` locks only the
   anchor and finalization locks both sorted ids, two pair commands anchored on opposite
   members deadlock. §4.6 requires the same sorted set in both, plus the participant intent
   row; S2 must land them together.
3. **Lock-order inversion at approval.** Creating the delivery inside the approval needs the
   customer and products *before* the JobCard locks; the follow-up path already locks the
   customer after the JobCard today (`service.ts:7087-7090`), so R20 must also cover the
   single-card approve path or the pair path re-introduces the cycle.
4. **Cross-staff pairs.** The invariant (R17) means management cannot hand a live sale to
   another staff member. That is intentional (privacy + D3), but it removes an ability that
   exists today; the delivery assignee is the supported alternative and the reassignment
   error must say so.
5. **Attribution drift.** D6 depends on REPORT-002, which is not on this branch. If SALE-002
   ships first, sale and delivery counts temporarily follow today's rules; the dependency
   must be recorded in the DECISIONS record and the release note so nobody "fixes" it twice.
6. **Legacy pair states.** Pre-S2 data can hold `Visit = WAITING_APPROVAL` with an
   unsubmitted sale; §4.4 handles it without a migration and without a blocker, but the
   manager must see the "sale stays open" warning or they will assume it was approved.
7. **Approval blocked by an inactive customer.** If the customer is deactivated mid-review,
   the delivery cannot be created and the approval fails until the manager unticks the
   delivery (then the sale completes without one). This is honest but visible; the error must
   name the customer, never a generic failure.
8. **Definitive-failure keys.** 049 turns any 4xx into `FAILED`; a UI that reuses the key
   after a corrected payload will show a confusing conflict. §5.4/§8.3 make the key reset
   mandatory, and the web tests cover it.
9. **"One delivery per sale" is permanent for a cancelled delivery** (Q4). This is a
   deliberate simplification; users must not expect an automatic replacement.
10. **Visible copy drift.** Several documents and the sale detail currently state that a sale
    never creates a delivery. R10 ships in S3 with the feature, and §12 lands with the code,
    or the product contradicts itself.
11. **Report expectation.** A sale and its delivery are two counted jobs. Users may read
    "1 satış + 1 teslim" as double counting; UI labels must say "onaylı satış kaydı" and
    "onaylı ürün teslimi", never "satış adedi".
12. **Documentation index.** This file is added under `docs/features/visit-to-sale/`; the
    `docs/README.md` index and `visit-to-sale/README.md` status line need a one-line update in
    S1 (not done in this documentation-only task, because the task allowed exactly one new
    file).

---

## 12. `DECISIONS.md` record (add when implementation ships)

```markdown
## SALE-002 — Standalone sale, joint visit+sale approval and sale-driven delivery

- **Date:** <ship date>
- **Status:** Accepted by product owner in chat (2026-11-23); implemented in S1–S4
  (<PR links>); production activation is a separate gate.
- **Scope:** `SALE` origin eligibility, standalone creation, coordinated visit+sale
  lifecycle, sale-approval delivery creation.
- **Supersedes in part:** SALE-001's statements that a source visit is always required,
  that sources are only `IN_PROGRESS`, and that a sale never creates a delivery.
  SALE-001's provenance, snapshot, one-active-sale, permission and non-financial rules
  remain.

### Decision

1. **Origins.** A `SALE` may be created from an `IN_PROGRESS` visit, from a `COMPLETED`
   visit, or standalone (no visit), for example a phone order. A source, when present,
   must still be a same-organization `BUSINESS` `SALES_MEETING` with an eligible engagement
   kind and an active STAFF assignee. Migration 071 replaces the "SALE ⇔ source" CHECK with
   "only a SALE may carry a source" and relaxes the source snapshots to all-or-none.
2. **Creation and authorization.** STAFF create only for themselves; MANAGER/ADMIN may
   create for any active STAFF member. Self-created cards are `ACCEPTED`, management-created
   cards are `NEW`. A customer is required, and the standalone contact must be active and
   belong to that customer. Snapshot, quantity, one-active-sale-per-visit and non-financial
   rules are unchanged.
3. **One submission, one approval.** While a sale's source visit is live, the visit is the
   only submission and approval surface: the visit's submit also submits its active linked
   sale, the visit's approve completes both, and revision/withdraw/resume move both cards
   in one transaction. The approve dialog therefore carries both manager preludes — the
   follow-up proposal and the "Teslim işi aç" section. A single-card sale command is rejected
   with a coded redirect while the source is in the coordinating status; once the source is
   terminal the sale acts independently. Cancel and invalidate never cascade. A card that is
   not in the matching state (legacy data) is never forced into a state it never had.
4. **One owner per live pair.** While the source visit is coordinating, the sale and the visit
   share one assignee. A reassignment that would diverge is rejected; a pre-existing
   divergent pair is decoupled (independent lifecycles, no shared identifiers) rather than
   blocked or leaked. Handing the physical work to another person is the delivery assignee's
   job, not the sale's.
5. **One transaction, two intents.** A coordinated command reserves and finalizes **both**
   cards in one transaction under the documented lock order (users → customer → contacts →
   products → both JobCards sorted by id → both lifecycle intents). The visit owns the
   receipt; the sale owns a participant reservation. `saleExpectedVersion` is required on
   every pair command. Any definitive failure marks both intents `FAILED`, so a corrected
   attempt uses a new client action key.
6. **Sale approval may open one delivery.** The approval offers an optional
   "Teslim işi aç" action (visit approval for a pair; sale approval for a standalone or
   retro sale): prefilled sale items (quantity adjustable, lines removable or added), chosen
   staff (default the sale's staff, may differ), planned date/time, purpose and note. When
   requested, exactly one `PRODUCT_DELIVERY` is created atomically with the approval, linked
   by `job_cards.delivery_source_sale_id`, with planned items (`deliveredAt` NULL), whole-unit
   quantities, BUSINESS eligibility and the existing assignment-offer window. At most one
   delivery per sale; no partial deliveries, no remaining-quantity tracking. Sale creation and
   correction still never create a delivery.
7. **Staff friction.** Making the staff member's work easier governs these choices: the
   sale may be submitted from `ACCEPTED` without the meaningless `START` (Q1 default), the
   delivery is the default offer at approval (Q7 default), and blocked pair commands always
   return the exact next action.
8. **Attribution.** Sale and delivery counts follow REPORT-002's verified performer (the
   staff assigned at completion). Choosing a different delivery assignee therefore creates
   two independent attributions by design. No third attribution rule is introduced.

### Consequences

- Migration 071 is additive (CHECK replaced, columns added/nullable, one unique index,
  two vocabularies widened, one follow-up-exclusion CHECK); existing rows remain valid; no
  backfill. Migration 072 (S2) relaxes the started-timestamp CHECK for `SALE` only so a
  sale can be submitted from `ACCEPTED` (Q1); it is additive with no backfill.
  `HEALTH_SCHEMA_VERSION` moves to 072. 049's intent table needs no migration.
- The sale detail no longer claims that a sale never creates a delivery; the MOD-001
  no-stock/no-accounting boundary is unchanged.
- Reports keep separate meanings: approved sale agreements, approved delivery quantities.
  They are never summed.
- A cancelled sale-linked delivery is not replaced automatically; reopening the link needs a
  new decision.
- Management can no longer reassign a live-pair sale to another staff member; the delivery
  assignee covers that need.
- Calendar changes remain deferred.
```

---

*This file is design documentation. It authorizes no code, migration, route, UI, deployment
or production change. Implementation starts only through the S1–S4 slices above, each with
its own review and verification.*
