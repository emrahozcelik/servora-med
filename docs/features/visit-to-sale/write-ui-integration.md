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
The unit remains metadata, never a quantity conversion. Delivery retains its
fractional min/step=0.001 behavior.

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
Delivery detail product CRUD/follow-up initial items remain a separate functional
backlog. Production deployment and migration remain unauthorized.
