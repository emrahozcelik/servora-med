> PR3 checkpoint: dedicated Sale HTTP writes and create/correction UI are implemented
> in this slice. See [write-ui-integration.md](write-ui-integration.md) for the current
> exposure, integer selection, frozen retry and authorization contract. PR1 rollout
> statements below remain historical. Production deployment is not authorized.

# Visit-to-Sale — approved V1 contract and PR1 handoff

Baseline: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`.
Approved: 2026-10-14. Public Sale creation/editing remains closed in PR1.

The five adjacent documents preserve the reviewed discovery facts and the approved
product design. Their baseline observations describe `main` before PR1. This file
records the implementation boundary; PR2–PR4 targets are not shipped features.
Original documents in the ignored discovery worktree must remain unchanged.

## Product rules

- `SALE` is an independent product/quantity agreement JobCard. `POSITIVE` is a
  meeting outcome; delivery purpose `SALE` is physical delivery. Neither is a Sale.
- `job_cards.sale_source_visit_id` expresses `SALE_FROM_VISIT`. Do not reuse
  `source_job_card_id`, which belongs exclusively to follow-up relationships.
- V1 accepts only BUSINESS, IN_PROGRESS SALES_MEETING sources with engagement kind
  CUSTOMER_VISIT, SALES_MEETING, PRODUCT_DEMO or FOLLOW_UP. Source customer must be
  active; source assignee must be active STAFF. STAFF may create only from their
  own currently assigned source. Management may create for that source's staff.
- Server selects customer, assignee and origin. STAFF creates ACCEPTED; management
  creates NEW. Sale has no schedule, due date, engagement kind or root contact.
- At most one active Sale per source: NEW, ACCEPTED, IN_PROGRESS,
  WAITING_APPROVAL and REVISION_REQUESTED occupy the slot. COMPLETED, CANCELLED
  and INVALIDATED release it. A second independent agreement still requires an
  eligible IN_PROGRESS source. Terminal history remains persisted.
- Source status, version, meeting results and assignment remain unchanged by
  Sale creation/correction. There is no automatic delivery, follow-up, invoice,
  payment, stock transaction or backup. No price/currency/total/discount fields
  or revenue calculation are introduced.
- These are narrow V1 policies. Retrospective recording from completed visits or
  standalone orders needs a later product decision and migration, not a global
  permanent prohibition inferred from this slice.
- Module boundary for future Warehouse/Accounting/integration: [DECISIONS.md
  MOD-001](../../../DECISIONS.md).

## Migration and historical references

Canonical baseline head was rechecked with the repository catalog loader:
`056_meeting_met_contact`. PR1 adds `057_sale_from_visit.sql`; applied migrations
001–056 remain byte-identical.

The additive migration extends the JobCard type and audit event CHECKs; adds a
same-organization, non-self, RESTRICT source FK and a partial unique active-slot
index; and creates `job_card_sale_details` / `job_card_sale_items`.

Details preserve sold time, optional Sale contact name/title, source visit
version/title/customer name, planned source contact and actually-met contact
IDs/name/title. Planned and met references never fall back to each other.
Historic inactive planned/met contacts may be copied; a newly selected Sale
contact must be active and belong to the source customer. Changing Sale contact
refreshes only its own snapshot, preserving all origin snapshots.

Items preserve product ID, name, SKU, brand, model and nullable unit at addition.
Later product rename/deactivation does not rewrite snapshots or prevent quantity
correction. Removing a draft item preserves its historical snapshot in the
removal audit. Duplicate product IDs are forbidden within one Sale.

SALE-QTY-001 (Accepted 2026-10-15) explicitly supersedes PR1's original
three-decimal Sale quantity policy. Requests accept only numeric safe integers
1–999999999; no rounding, truncation or unit conversion. Private request-hash,
application-write and durable audit quantities retain v1 three-scale strings (`1.000`)
for integer receipt replay. Public detail/activity readers return integer strings
(`"1"`, `"15"`), and the UI presents `15 ürün`, with unit metadata separately.

Forward migration `058_sale_integer_quantity.sql` preserves migrations 001–057,
preflights historical rows under a table lock, removes the fixed scale to use
unrestricted NUMERIC and adds the integer/range CHECK. This PR #373 review
refinement supersedes the initial unmerged 058 design, whose NUMERIC(12,3)
typmod rounded some raw SQL fractions before CHECK. Fractional historical rows
fail without changes; data owners must decide remediation separately. Exact raw
SQL fractions now fail as well. Private reads preserve v1 `1.000` identity across
valid storage scales; public reads emit `"1"`. Delivery's fractional quantity
policy is unchanged. See [integer quantity policy](integer-quantity-policy.md)
for rollout, lock behavior and recovery of local databases on the earlier draft.

Creation requires 1–25 distinct lines. Draft removal may leave zero lines;
submission rejects an empty Sale. Sale-only product/contact history participates
in existing delete protection and `hasOperationHistory` projections. Historical
contact deactivation policy is retained; generic STAFF write permissions stay
unchanged.

## Private service contract

`JobCardService` delegates to `JobCardSaleService` using the existing transactional
critical-action receipt implementation. No Sale create/edit route is registered.

| Method | Strict input allowlist |
| --- | --- |
| `createSaleFromVisit(actor, sourceVisitId, input)` | clientActionId, expectedSourceVersion, title, description, soldAt, saleContactId, items[{productId,quantity}] |
| `patchSaleDetails(actor, saleId, input)` | clientActionId, expectedVersion, soldAt, saleContactId |
| `addSaleItem(actor, saleId, input)` | clientActionId, expectedVersion, productId, quantity |
| `patchSaleItem(actor, saleId, itemId, input)` | clientActionId, expectedVersion, quantity |
| `removeSaleItem(actor, saleId, itemId, input)` | clientActionId, expectedVersion |

Receipts return `{jobCardId, version}`. Each operation hashes normalized client
intent including target IDs and expected version, excluding clientActionId,
server clock, generated IDs and reference metadata. Omitted correction fields
remain omitted in the hash; explicit contact null means clear. Same key/intent
returns the original receipt. Reused key/changed intent returns
`CLIENT_ACTION_REUSED`; ambiguous response loss is recovered with the same key.
Replay rechecks current role/activity and child access, without replaying effects.

Creation lock order: receipt claim → sorted actor/assignee user rows
FOR NO KEY UPDATE → source JobCard FOR UPDATE → customer FOR UPDATE → sorted
contacts FOR SHARE → sorted products FOR SHARE. The unlocked source read is only
lock planning; version, source eligibility and ownership are rechecked after locks.
The partial unique index is authoritative; its named violation maps to
`SALE_FROM_VISIT_ACTIVE_EXISTS`, not a generic database error.

Root, assignment history, details, items, child audit, source link audit, normal
creation notification/realtime effects and receipt commit together. Corrections
lock sorted users then the Sale parent, require its current version and
EDIT_JOB_FIELDS permission, mutate only allowed child data, bump the parent
version and append one audit in the same transaction. They do not lock/change
the source visit. No-op corrections are rejected without consuming a version.

## Lifecycle and exposure

Existing accept/start/submit/withdraw/revision/resume/approve/cancel/invalidate
commands remain authoritative. SALE has explicit submission dispatch rather than
falling into meeting/delivery readiness: eligible customer/assignee, persisted
origin/details, valid sold time and valid nonempty snapshot lines are required.
Current source status and current catalog activity do not invalidate a previously
created agreement at submission time. Staff cannot approve; review edits require
withdraw or revision. Normal terminal immutability applies to all Sale writers.

Generic creation and manual follow-up creation have runtime type allowlists that
exclude SALE. SALE is also excluded from V1 follow-up source/suggestion/proposal
flows. Generic Sale patch allows existing title/description/priority and normal
assignment policy; rejects customer/contact/schedule/due-date/engagement/follow-up
fields. Delivery and meeting writers retain their explicit type guards.

Public readers are not complete Sale projections in PR1. Root DTOs do not yet
include Sale origin/details/items. New audit types have an explicit safe NONE
presenter; raw origin/contact/line data are not emitted by the old presenter.
The normal JOB_CREATED notification/realtime path is reused. Sale-specific item
presentation, scoped source/child links and cross-card invalidation belong to PR2.
Do not enable public Sale writes before those readers and UI are ready.

## Verification and independent review

The committed tests cover real PostgreSQL 17 creation/retry/rollback, same-visit
and same-key concurrency, product/contact rename/deactivation lock races, source
submit/cancel/ownership races, exact source-row preservation, quantities/snapshot
identity, approval/correction/terminal slot rules, tenant isolation, closed HTTP
routes, SQL FK/index/quantity contracts, clean migration, real 056→057 upgrade
with existing data and no-reapply. Source ownership races use a competing
repository transaction because public assignment policy forbids reassignment
after START; they are not presented as a newly enabled public reassignment action.

Run server build before tests. Use an explicitly isolated password-bearing
loopback TEST_DATABASE_URL and PostgreSQL 17 client tools as required by
[the environment contract](../../operations/local-test-environment.md).

```sh
cd server
npm run build
npm test -- --run
cd ../web
npm run build
npm test -- --run tests/product-select.test.tsx tests/delivery-create-screen.test.tsx
```

Exact-head CI must run `ops/local-ci/run.sh` with all 27 mandatory checks and an
explicit local evidence root, then `ops/local-ci/verify-evidence.sh`. Execution
results, logs and manifest hashes live outside the tracked checkout so they can
bind to the committed head without a self-referential documentation commit.
The four existing real-R2/DR tests remain SKIPPED without their opt-in environment;
they must never be reported as passed. No production or Actions execution is
authorized by this PR.

## PR2 handoff

The PR2 implementation contract, scoped GET routes, bundle compatibility and
schema-compatible realtime projection are recorded in
[read-integration.md](read-integration.md). Exact-head execution evidence remains
outside tracked source; passing that gate is required before independent review.

Build typed, permission-scoped Sale detail/line/contact/origin projections and
source linked-sale history; finish JobCard/CRM/approval queue/report type dispatch,
timeline presentation and targeted realtime invalidation. Reports count product
agreements, not revenue. Preserve origin snapshots when source contacts or
assignments change. Confirm old bundles do not receive an unsupported Sale enum
until compatible readers/UI are enabled. Public create/edit activation stays PR3,
alongside reuse of existing ProductSelect; no catalog quantity field or new
dependency is needed. Delivery follow-up line creation and detail add-line UX
remain distinct functional backlog items for PR4, not CSS-only fixes.
