# Sale-aware read integration — PR2

Base: 54f17a03c4511f451cd0fbc952bc8951bde947f7, tree
0f7f309209753b045ce22f5090b32c69c779d73a. Migration head remains
057_sale_from_visit. This slice implements readers and existing lifecycle UI;
Sale creation/correction HTTP routes and UI remain closed.

## HTTP contract

New GET routes require an authenticated session and includeSaleCapability=true:

| Route | Response |
| --- | --- |
| /api/job-cards/:visitId/sale-create-context | sourceVisitId/sourceVersion, fixed customer/assignee, plannedContact/metContact, eligible/blockedReason, activeSale |
| /api/job-cards/:visitId/sales?limit=20&offset=0 | items/total/limit/offset; each accessible item has access=FULL, id/title/status |
| /api/job-cards/:saleId/sale-details | jobCardId/jobCardVersion, soldAt, saleContact, sourceVisit, historical items |

Context is advisory. The private creation service still rechecks source version,
ownership, references and active slot under its existing transaction locks.
Related-sale pages default to 20, allow 1–100 rows and nonnegative integer
offsets. Source authorization, visible child count and bounded page selection
share one SQL statement; hidden children do not consume visible pagination.
Detail authorization, origin projection and all item snapshots share one
statement. There is no per-line or per-child query.

Items expose stable line/product IDs, name/SKU/brand/model/nullable unit and
quantity as an exact three-decimal string. Current catalog/contact changes do
not replace snapshot values. soldAt is the agreement time, not submission,
approval or physical delivery time. Origin title/customer/planned/met snapshots
are distinct from the Sale contact and the source's current title/status.

## Authorization and privacy

| Viewer | Sale detail | Origin | Source related-sales page |
| --- | --- | --- | --- |
| Current Sale STAFF assignee, also owns visit | Full Sale snapshots | FULL | Only accessible children |
| Current Sale STAFF assignee, cannot reach visit | Full Sale snapshots | RESTRICTED | Source request is 404 |
| Visit STAFF assignee, cannot reach Sale | Sale request is 404 | No child identity | Hidden Sale excluded; context may say restricted active slot |
| Same-organization MANAGER/ADMIN | Full | FULL | Full bounded history |
| Other organization / unrelated STAFF | 404 | No identity or snapshots | 404 / no hidden children |

Restricted origin is exactly {access: RESTRICTED, kind: SALE_FROM_VISIT};
it contains no source ID, URL, title, staff or contact snapshot. Restricted
activeSale is exactly {access: RESTRICTED}; it contains no child ID, title,
status, products or contact. Reassignment is evaluated at every read. A closed
source remains independently readable when authorized and never closes the Sale.
No general CRM, Contact or Product mutation permission is added.

## Deployed bundle compatibility

The narrow opt-in follows existing location/met-contact reader gates.
Old list/board/approval/history readers exclude Sale in SQL before counting,
ordering and pagination. Direct Sale detail/lifecycle responses without opt-in
are concealed as 404. Old source activity pages exclude Sale event vocabulary
before count/page selection. Old report aggregates use the same filtered job
source as their buckets and queue pages.

The new bundle opts in on JobCard list/board/detail, root PATCH and lifecycle
responses, activity, CRM history/summary, Staff history, operational reports,
Overview type distribution and weekly report detail/draft/submission responses.
Meeting, physical delivery and note DTOs retain their existing vocabulary.
Weekly immutable rows are never rewritten or backfilled; the legacy HTTP
projection omits Sale source-work entries, while the new reader labels Sale.
The existing weekly-report ownership policy and frozen historical facts remain
authoritative; opening any referenced live JobCard still rechecks current access.

No global API versioning or new configuration system is introduced.

### Independent review remediation — SALE-PR2-P2

All 33 registered JobCard routes with a parent :id now share the authenticated
Sale visibility guard, including nested weekly PDF and delivery-item paths and
automatic HEAD handling. The former suffix allowlist left activity, notes and
lateness/history subresources reachable without Sale capability. Concealment
now runs before the handler: missing/cross-organization parents and inaccessible
Sale assignments return the same identity-free 404. A Sale requires explicit
capability; subsequent role, type, lifecycle and transactional checks still apply.
The guard performs one organization-scoped parent lookup per :id request.

The new bundle additionally opts in on notes GET/POST, submission-lateness,
submission-reminder and overdue-incidents. Their DTOs and existing management-only
permissions remain unchanged. Meeting/delivery/follow-up calls and collection
creation/scheduling routes do not receive a blanket subresource capability.
Normal JobCard, meeting, delivery and weekly reader parity is covered with real
records. Reassignment, source-only STAFF, unrelated STAFF and both cross-org
roles are tested; concealed writes append no note, receipt or realtime event.

### Independent review remediation — final P2 round

Overview recent rows honor the same gate: legacy readers exclude Sale from
recent completed work and recent notes in SQL before ordering and the fixed
ten-row window, so Sale rows can neither render as links nor displace
accessible rows. Opted-in readers keep the full window.

Related-sales pagination recovers when the accessible total shrinks below the
current offset: the client clamps to the last valid page and keeps the
previous control reachable whenever the offset is nonzero. Stale responses
never overwrite newer state. No Sale identity leaks through paging.

Source handover stays visible to the former source owner: assignment events
keep their persisted before-owner audience through current-access replay and
high-water, and project as the source assignment (workspace keys) with only
the viewer's own personal origin key — even when the viewer still owns
historical Sales, where the origin-only rewrite previously masked the
handover. No foreign Sale, source-contact or hidden key is exposed.

## Lifecycle, timeline and realtime

Sale has an explicit detail loader and never fetches meeting-details or
delivery-items. Satış kaydı appears in existing filters, rows, board, histories
and approval UI. The detail renders soldAt, separate Sale/planned/met contacts,
origin access and historical product/quantity lines. Existing role-gated
accept/start/submit/approve/revision/withdraw/resume/cancel/invalidate commands
remain available. Generic edit, scheduling and follow-up controls are not
offered for Sale. There is no SaleCreate page or Sale correction editor.

Typed timeline projections expose Sale line name/quantity/operation, safe changed
field names and a relationship fact. The relationship event never emits a raw
child ID. Raw audit JSON, organization IDs and contact snapshots are not added
to timeline details.

The approved design's two independently scoped invalidation audiences are
implemented using the existing activity-backed realtime mechanism:

- Creation persists a child creation event and the source link activity's own
  bodyless update event; the source event contains no child identity.
- Corrections and lifecycle updates keep one durable event per owning activity.
  Its relation resource key/audience is projected at replay using current Sale
  and source assignments in a bounded SQL join.
- A source-only STAFF viewer receives a source job.updated identity and only
  the source detail key plus bodyless workspace invalidation keys. A Sale-only STAFF viewer receives the Sale identity
  without the source key. Management can invalidate both accessible views.
- Sale STAFF envelopes contain only the viewer's own staff-profile key. Other
  assignee profile IDs are removed. Generic list/board/report invalidation keeps
  revoked cards from remaining in an old assignee's open workspace.
- Current-access filtering also applies to high-water calculation. Historical
  persisted audience membership cannot restore revoked Sale access.
- Receipt replay does not append another realtime event or notification.

This is a schema-compatible implementation refinement: the existing
realtime_events_activity_source_check requires an owning activity and
source_activity_id is unique. A second sourceless persistent event was rejected
by PostgreSQL during the disposable fixture test; no migration, invented audit
fact, domain outbox or event bus was added to bypass that constraint.
The public SSE envelope still uses the existing vocabulary.

### Source-to-Sale current-access reconciliation

Source title, assignment and lifecycle activities also invalidate Sale origins.
The owning source activity still has exactly one durable realtime event; its
internal `sale-origin-context` wake-up hint is persisted only when an indexed
same-organization Sale-history existence probe succeeds. No additional audit
event, receipt, notification or migration is introduced. The hint itself is
removed from every public envelope.

Replay and high-water share current-assignment SQL. A history-index probe picks
at most one accessible related Sale, including terminal Sales. Public projection:

| Current viewer access | Public identity | Origin invalidation |
| --- | --- | --- |
| Sale only | One currently accessible Sale | `sale-origin-context:<viewerId>`, own Sale detail key; no source identity/key |
| Source only | Source | Source keys; no Sale identity/key |
| Source and Sale, or same-org management | Source | Source keys and personal origin key |
| Former Sale assignee, now neither | Own notification-center identity on assignment events only | Personal origin/workspace keys; neither card identity |
| Former source assignee in handover audience | Source assignment | Source/workspace keys plus own personal origin key; already-known source only |
| Neither / other organization | None | None |

The personal key intentionally refreshes all open Sale origins for that viewer;
it never enumerates historical Sale IDs or owners. A source-only viewer receiving
a Sale event retains the existing source projection and also receives the
personal key, so an open Sale can recheck revoked access without leaking its ID.
Every Sale origin screen subscribes to its own personal key. On invalidation it
conceals the old source link, title and contact snapshots until the authoritative
reader succeeds, including across failed or superseded refreshes. A concealed
Sale reader's 404 clears the old Sale screen. The same authoritative-404 rule
applies to every JobCard type: when the current screen's authorized detail GET
returns 404 after a realtime invalidation, the old detail state is cleared to a
non-retryable access-lost state instead of lingering behind a stale banner.
Transient (5xx/network) failures keep the existing stale/retry path, and the
clear only applies to the currently open session and job.

Live admission uses the existing bus only as a wake-up hint. A same-org source
hint outside the persisted direct audience runs one bounded (`LIMIT 1`),
current-access replay probe per stream, coalescing bursts before normal catch-up.
There is no cross-org wake-up, public global fanout, per-Sale query loop or new
subscription framework. Ordinary events retain their direct-audience path.
The existing 501-event replay/overflow-to-sync contract remains unchanged.

Regression coverage includes replay/live RED-to-GREEN, independent owners,
multiple historical Sales, terminal sources, regained/revoked access, high-water,
cross-org concealment, coalesced probes, unchanged durable-event counts and
receipt replay. Browser and exact-head CI evidence is kept in the external
review bundle rather than asserting an untested commit in this document.

## Operational reports and weekly source work

Sale joins productive work-type buckets and normal approval/operational counts.
Existing event-time, ownership, cancellation/invalidated and weekly-report
exceptions remain unchanged. A visit and its agreement are two operational
jobs. Approved agreement counts are not revenue. Product delivery quantities
and meeting outcome cohorts remain explicitly restricted to their own types.
Weekly source-work validation/mapping accepts Sale and rejects unknown and
administrative source types; existing frozen submissions are not recomputed.

## Verification and PR3 handoff

Real PostgreSQL 17 fixtures cover snapshot persistence after rename/deactivation,
source closure, independent ownership, cross-organization concealment, bounded
query counts/pagination, operational bucket and legacy parity, source row
preservation, replay notification/event counts and per-viewer SSE privacy.
Existing meeting/delivery/lifecycle/report/weekly suites remain regression gates.
The frontend tests cover Sale label/vocabulary, explicit detail loading,
restricted links, absence of create/edit/follow-up controls and existing flows.

Real STAFF/MANAGER/ADMIN browser sessions use private-service BUSINESS fixtures
in an isolated loopback database. Chromium and WebKit acceptance covers
desktop/mobile, keyboard focus, console/network, 200% text resizing and 320 CSS
px reflow equivalent to a 1280px viewport at 400%. Native browser zoom is not
automated. Source-only/Sale-only STAFF browser sessions exercise normal
management reassignment without exposing forbidden links or response identities.

Exact-head results and hashes are recorded outside tracked source to avoid
self-referential evidence commits. Required final gate: server/web full suites,
all 27 ops/local-ci/run.sh checks and EVIDENCE_VERIFY_PASS. Four opt-in R2/DR
tests remain SKIPPED and must not be counted as passed.

PR3 may now wire the approved context into SaleCreate and reuse ProductSelect.
It must preserve the private service's source/version, quantity/snapshot,
active-slot and frozen idempotent-attempt contracts. Enable dedicated write
routes only with that complete UI. Manager-only future Ön Muhasebe and Stok/Depo
information remains PR3 scope under MOD-001; no financial or warehouse behavior
is shipped here.
