# Visit-to-Sale — PR3 write and UI integration

Baseline: `7091b59649c55552092de0343097595c969605ee` (migration 058).
This slice exposes the already transactional Sale services and completes their
browser flow. SALE-001, SALE-QTY-001 and MOD-001 remain authoritative.

## Dedicated HTTP writes

Every route requires authentication and `includeSaleCapability=true`; the opt-in
only preserves legacy concealment. The domain service still checks current
organization, actor/assignee, source eligibility, lifecycle and optimistic version.
Unknown body fields are rejected by the existing Sale input parsers.

| Method and path under `/api/job-cards` | Body |
| --- | --- |
| `POST /:id/sales` (source visit ID) | clientActionId, expectedSourceVersion, title, optional description, soldAt, optional saleContactId, items[{productId,quantity}] |
| `PATCH /:id/sale-details` | clientActionId, expectedVersion, explicit soldAt and/or saleContactId |
| `POST /:id/sale-items` | clientActionId, expectedVersion, productId, quantity |
| `PATCH /:id/sale-items/:itemId` | clientActionId, expectedVersion, quantity |
| `DELETE /:id/sale-items/:itemId` | clientActionId, expectedVersion |

Create/add return HTTP 201; correction/removal return 200. All return the existing
receipt `{jobCardId,version}`. Same-key same-intent replay returns the original
receipt, including after response loss. A changed payload returns
`CLIENT_ACTION_REUSED`. Generic JobCard create, Delivery and follow-up cannot
create a Sale. No schema change or new receipt/hash representation is introduced.

## Source action and route

`RelatedSalesSection` uses the existing server `sale-create-context` projection.
It exposes **Satış kaydı oluştur** only when `eligible=true` and `activeSale=null`.
No new workflow action enum is needed, so legacy workflow readers do not receive
an unfamiliar `CREATE_SALE_FROM_VISIT` code. The context is advisory; the locked
create transaction remains authoritative.

The dedicated URL is `/jobs/:jobCardId/new-sale` (`jobCardId` is the source visit).
The existing job parameter name lets identity, breadcrumb and return registries
link the source visit consistently. `paths.newSale(visitId)` owns the URL builder.
STAFF, MANAGER and ADMIN may enter the route; its GET context reauthorizes the
actual source, including deep links. Actor/organization/source identity keys
isolate mounted form sessions.

Customer and assignee are read-only. Source planned contact, source actually-met
contact and explicit optional Sale contact remain distinct. Contact search is
active, customer-scoped, paginated and read-only. No contact/catalog side-flow is
opened. Actual soldAt uses the established **device-local datetime → UTC instant**
helpers, with the device timezone stated beside the input; organization timezone
is never substituted for the device timezone implicitly.

## Standalone and completed-visit creation (SALE-002 S1)

SALE-002 keeps the visit-origin route and adds one collection create:

| Method and path under `/api/job-cards` | Body |
| --- | --- |
| `POST /sales` (standalone, no visit) | clientActionId, title, optional description, customerId, assignedTo, soldAt, optional saleContactId, items[{productId,quantity}] |

The body is a strict allowlist; `type`, `status`, source fields, snapshots and
`expectedSourceVersion` are rejected. STAFF may name only themselves;
MANAGER/ADMIN may name any active same-organization STAFF user. A STAFF create is
`ACCEPTED`; a management create is `NEW`. The customer is required, active and
`BUSINESS`; the optional Sale contact must be active and belong to that customer;
1–25 distinct active `BUSINESS` products carry whole-unit quantities. Response is
the existing `{jobCardId,version}` receipt with `SALE_STANDALONE_CREATE` idempotency
(`SALE_STANDALONE_CREATE:v1`); replay returns the original receipt and a changed
payload is `409 CLIENT_ACTION_REUSED`. Domain failures keep the existing vocabulary
(`CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE`, `SALE_REFERENCE_NOT_ELIGIBLE`,
`CONTACT_NOT_FOUND`, `CONTACT_NOT_IN_CUSTOMER`, `CONTACT_INACTIVE`,
`PRODUCT_NOT_FOUND`, `SALE_PRODUCT_DUPLICATE`, `SALE_ITEM_LIMIT`, `SALE_TIME_INVALID`).
The route needs no legacy `includeSaleCapability` opt-in because it is a new surface;
authenticated authorization is still enforced by the service.

`POST /:visitId/sales` is unchanged except that the source visit may now be
`IN_PROGRESS` **or** `COMPLETED`; the customer, assignee and all origin snapshots
are still derived from the locked visit, one active sale per visit still applies,
and the `SALE_FROM_VISIT_CREATED` fact is still written on the visit. A cancelled
or invalidated visit remains ineligible.

Read integration: the Sale detail `sourceVisit` union gains
`{kind: 'STANDALONE'}` for a card whose `sale_source_visit_id IS NULL`. It must
render as "Bağımsız satış kaydı (ziyaret yok)", never as the restricted-source
message; the restricted `{access: RESTRICTED, kind: SALE_FROM_VISIT}` variant is
unchanged for a concealed visit-origin source. S1 writes **no**
`delivery_source_sale_id` and exposes no approval-dialog delivery section; those
arrive with S3.

## Pair dialogs (SALE-002 S2, web worker contract)

While a `SALES_MEETING` visit has one **active** linked sale (`NEW`, `ACCEPTED`,
`IN_PROGRESS`, `WAITING_APPROVAL`, `REVISION_REQUESTED`) and both cards share the
same assignee, the **visit** is the pair's only submit/approve/revision/withdraw/
resume surface. The five visit endpoints accept one extra optional field,
`expectedSaleVersion`:

| Endpoint (under `/api/job-cards/:visitId`) | Body |
| --- | --- |
| `POST /submit` | clientActionId, expectedVersion, note, optional followUpProposal/locationCapture, **expectedSaleVersion** |
| `POST /approve` | clientActionId, expectedVersion, optional note/followUp, **expectedSaleVersion** |
| `POST /request-revision` | clientActionId, expectedVersion, revisionReason, optional correctionDueAt, **expectedSaleVersion** |
| `POST /withdraw` | clientActionId, expectedVersion, **expectedSaleVersion** |
| `POST /resume` | clientActionId, expectedVersion, **expectedSaleVersion** |

Rules the UI must implement exactly:

- Send `expectedSaleVersion` **only** when the dialog knows a coordinated pair
  exists (the linked sale is active and the visit is in the command's state).
  Sending it without a pair is `409 SALE_PAIR_STATE_CONFLICT` with
  `details.reason = 'NO_COORDINATED_PAIR'`; omitting it for a coordinated pair is
  `400 VALIDATION_ERROR` with `fieldErrors.expectedSaleVersion`. Never "retry
  without it" after that 400 — reload the pair state instead.
- `expectedSaleVersion` is part of the request hash under the same
  `clientActionId`, so it is frozen with the rest of the body.
- `START`, accept/decline/release, cancel, invalidate, the generic patch and the
  sale-specific sale-details/item routes must **not** send it (strict allowlist).
- A single-card sale command while the source is live returns one of
  `SALE_SUBMIT_VIA_VISIT_REQUIRED`, `SALE_APPROVE_VIA_VISIT_REQUIRED`,
  `SALE_REVISION_VIA_VISIT_REQUIRED`, `SALE_WITHDRAW_VIA_VISIT_REQUIRED` or
  `SALE_RESUME_VIA_VISIT_REQUIRED` with
  `details: { visitId, saleId, saleStatus, allowedSaleCommand }`. Navigate to the
  visit dialog named by `allowedSaleCommand` — never render the ids to a viewer
  who cannot read both cards (the server only emits this for the pair owner or
  management). A terminal sale card is never redirected (it keeps the ordinary
  terminal rejection). A `NEW` pair sale is redirected too; the visit submit then
  returns `409 SALE_PAIR_STATE_CONFLICT` with `allowedSaleCommand:
  'ACCEPT_ASSIGNMENT'`, so render that exact next step.
- A visit submit blocked by its linked sale returns the sale's own readiness
  error (`SALE_NOT_READY` with `readiness`, or
  `409 SALE_PAIR_STATE_CONFLICT` with `allowedSaleCommand: 'ACCEPT_ASSIGNMENT'`
  for a `NEW` sale and `'RESUME'` for a `REVISION_REQUESTED` sale). Render the
  blocking panel and the direct link; there is no "submit without the sale".
- The response is the **visit** `JobCardDetail`. `linkedSaleJobCardId` appears
  only when the sale actually moved in that command; render it as the second
  affected card (and keep the replay byte-identical).
- A definitive 4xx marks **both** 049 intents `FAILED`: reset the
  `clientActionId` and the field that must change, exactly like the existing
  sale-create "definitive rejection → new intent" rule. Reuse the key only for
  an uncertain outcome (network/timeout/5xx/`ACTION_IN_PROGRESS`) and only with
  the byte-identical body.
- Legacy data: a visit approval whose linked sale is not `WAITING_APPROVAL`
  completes the visit and leaves the sale open. Warn before confirming
  ("bağlı satış kaydı onaylanmadan kalacak"); the sale then runs its own
  lifecycle and its own dialog. Revision/withdraw/resume likewise move only the
  cards in the matching state.
- `SALE_PAIR_ASSIGNEE_CONFLICT` (`details: { visitAssignee, requestedAssignee }`)
  means management tried to reassign one side of a live pair; the supported
  alternative is the delivery assignee at approval (S3).
- R9/Q1: a `SALE` may be submitted from `ACCEPTED` without a START, so the sale
  detail's command set now offers `SUBMIT_FOR_APPROVAL` next to `START`. Do not
  require or invent a location capture for it.

The approval dialog's **"Teslim işi aç"** section, the `delivery` field and
`deliveryJobCardId` are S3; S2 adds neither.

## Selection and correction

Canonical `GET /api/products` accepts an optional `dataClass=BUSINESS` filter.
Its SQL predicate applies to both count and page before LIMIT/OFFSET. Omission
retains the previous catalog/Delivery behavior. Other dataClass values are
rejected. Sale loads active BUSINESS products; mutations recheck current validity.

ProductSelect multi-selection accepts only the shared identity fields needed for
presentation (id/name/SKU/brand/model/unit). Search results and onAdd still use real
catalog Products; single-selection is unchanged. React instance IDs keep labels,
search controls and selected headings unique. No fake Product fields or global
cart are introduced.

Sale quantities default to 1, use min=1/max=999999999/step=1/inputMode=numeric and
reject empty, fractional, non-positive or overflow values without rounding.
Product ID owns each quantity; removal/re-addition resets the new selection to 1.
The unit remains metadata, never a quantity conversion. Delivery uses the same
whole-unit input contract under DELIVERY-QTY-001
(min=1/max=999999999/step=1/inputMode=numeric) and rejects fractions without
rounding.

Sale correction is rendered only with server `EDIT_JOB_FIELDS` permission.
Waiting approval and terminal records remain read-only. Each details/add/quantity/
removal intent owns one key and the current parent version. Existing line IDs and
historical metadata are retained; quantity correction does not read live Product
metadata and works for subsequently deactivated products. The normal lifecycle,
including withdrawal/revision/resume and mandatory manager approval, is reused.

## Frozen requests and current access

Before sending, the form retains a fully constructed normalized request, including
key, version, selected product identities/counts, soldAt, contact, title and
description. A synchronous in-flight guard prevents double submission. Pending
or ambiguous results lock semantic controls and cancel/new-intent actions.
Network/timeout/5xx/ACTION_IN_PROGRESS keep the original attempt; explicit retry
uses the same key/body/version. Realtime can reauthorize or clear visible source
context but cannot modify that retained request. No persistent draft store exists;
reload reconciles through canonical active-Sale context.

A definitive create rejection refreshes source context before a deliberate new
intent. A definitive correction rejection requires a canonical reload before
editing resumes. A failed post-commit read still permits exact receipt replay.
Mounted-session checks prevent delayed responses from updating a departed screen.
The correction lock also blocks competing lifecycle/notes/record controls on the
same detail surface. A 404 current-access refresh clears old details. Failed
realtime reads stop the current drain, including concurrent queued invalidations;
a new signal or explicit retry can reconcile later. This prevents a 404/5xx hot
retry loop while retaining the existing transient-error stale view.

## Boundaries and acceptance

Sale writes do not change source status/version, delivery, follow-up, invoice,
payment or stock. Manager-only future-module explanations contain no invented
financial/stock values or inactive action controls. No STAFF CRM/catalog write
permission is added. Existing Sale-aware reader, timeline, reports, weekly and
SSE privacy contracts remain in force.

Verification includes PostgreSQL HTTP create/correction/tenant/concurrency/replay
cases, shared selector and Delivery regressions, frozen-intent/access-loss tests,
route identity/navigation parity, full suites/builds, real-role Chromium/WebKit
acceptance and exact committed-head canonical local CI evidence. Executed results
and SHA/tree/log/manifest hashes belong to the external PR review evidence bundle;
unexecuted or environment-dependent checks must not be counted as PASS.

PR4 remains limited to the separately planned existing-surface parity work.
Delivery detail product CRUD on an existing card remains a separate functional
backlog. Follow-up initial delivery items are no longer part of that backlog: a
`PRODUCT_DELIVERY` follow-up now carries the same initial `deliveryPurpose`,
`deliveryNote` and `items` batch as the normal delivery create and creates those
lines in the same transaction, with the same active BUSINESS-product eligibility
(checking the child's data class), deterministic product resolution order, and
25-line cap, so `FollowUpCreatePage` uses the shared `ProductSelect` and its
BUSINESS-scoped loader. Production deployment and migration remain unauthorized.
