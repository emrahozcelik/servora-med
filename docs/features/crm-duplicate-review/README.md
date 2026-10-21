# CRM Slice 4A — owning contracts and rollout

**Status: PR1 merged / PR2 merged / PR3 implemented-under-independent-review.**

**Production rollout: NOT DEPLOYED.**

The approved D1–D6 and T1–T5 design inputs are accepted. This records design
acceptance, not production deployment or completion of the whole Slice 4A.

- Domain, algorithm and evidence SSOT: [Design](CRM_SLICE4A_DESIGN.md).
- HTTP wire SSOT: [API contract](CRM_SLICE4A_API_CONTRACT.md).
- Schema/SQL SSOT: [Data model](CRM_SLICE4A_DATA_MODEL.md).
- Acceptance SSOT: [Test matrix](CRM_SLICE4A_TEST_MATRIX.md).
- Slice boundaries and rollout gates: [Implementation plan](CRM_SLICE4A_IMPLEMENTATION_PLAN.md).

## Source provenance

The five originals remain unchanged in the user's external approved source
packet. [source-manifest.json](source-manifest.json) records each original and
portable SHA-256 and every link substitution. The repository holds only portable
Markdown, with no second archive or normative copy. Reversing the recorded link
substitutions reconstructs the original hash. Missing external sources are
identified as external provenance, not replaced with broken repository links.
Historical NOT_RUN statements describe the original design checkpoint and are
not current runtime test results; those statements and all technical decisions
remain unchanged.

## Implemented boundary and release controls

PR #379 merged PR1: management-only candidate/comparison GETs and virtual pending
reviews. PR #380 merged PR2: persistent decisions, explicit reopen, immutable
history and the manager decision UI. Virtual pending reviews still use
id=null/version=0; the backend supplies allowed
actions from backend policy. The same-org
BUSINESS scope includes prospect, active and inactive customers. GET creates no
business, review, audit or receipt rows. Existing tax/Contact primary and STAFF
CRM permissions are unchanged.

PR3 adds the independent review register (`GET /api/customers/duplicate-reviews`)
and the dedicated registry workbench, so historical pairs that no longer match —
or whose source is deleted, converted to DEMO, or otherwise unavailable — remain
reviewable without a global candidate scan. Register paging is bounded by the
canonical pair cursor (at most 32 evaluated heads and 20 returned items per page)
and uses a domain-separated authenticated cursor. ATTENTION suppresses only
current decisions; stale, unverifiable, over-budget, pending and unavailable rows
stay visible. PR2 ALL candidate view keeps current matching
confirmed/dismissed pairs reachable for comparison, history and explicit reopen.
There is no Customer/Contact merge, identity alias, deactivation, deletion or referential
rewrite. 4B, WR-01 and Issue #369 are outside this rollout.

A lost command response is recoverable without a new intent: the comparison and
register surfaces expose a narrow replay of the actor-bound frozen attempt, which
resends the original `clientActionId` and payload and shows the stored immutable
receipt as a receipt, not as current review state. The replay is offered on every register row whose comparison cannot be shown
(unavailable source or over-budget evidence), shares the actor/org COMMAND cooldown
across all mounted recovery surfaces, and cannot be retried before the server
window expires. Only the reviewed no-commit codes close the attempt; unknown
404/422 outcomes, 429/5xx and transport failures keep it, and authorization
failures retain it without disclosing review data.

The registry also opens the safe review history for rows whose comparison cannot
be shown (unavailable source, DEMO conversion, deleted source or over-budget
evidence). History stays read-only, keeps the bounded cursor and DETAIL cooldown
semantics, and grants no new decide/reopen authority.

- CRM_DUPLICATE_COMPARISON_ENABLED defaults to false. Disabled startup does not
  require a keyring. Enabling requires strict CRM_DUPLICATE_EVIDENCE_KEYRING
  validation and the key custody/rotation/recovery ownership in Design SD-4.4.
  No real keys are committed or provisioned by this package.
- Catalog head 060 adds the review aggregate/events and deferred current-event FK;
  migration 059 retains its two read-side indexes. Env examples and the exact
  startup/schema gate must match the deployed release catalog.
- Source/evidence limits and query ownership remain Design SD-3/SD-4. The CRM
  read repository enforces a whole-request monotonic deadline and discards a
  timed-out client and its transport without awaiting an unresponsive rollback.
- Authentication -> management role guard -> one manual class limiter -> handler,
  no-store and visible-page 60-second refresh remain the accepted API contract.
  Retained results after temporary refresh failure are labelled stale; definitive
  access/source loss clears cached comparison data.
  History reads use the same actor/organization DETAIL cooldown as comparison;
  review/version/command refresh changes isolate history request generations.
  Late prior-page responses cannot replace the current immutable history window.
  History uses the bounded read-only snapshot deadline and per-query timeout.
  Expired history cursors discard the prior window and restart at a fresh first page.
  Definitive conflict/source-missing/evidence-limit commands require successful
  GET reconciliation and renewed inspection before new intent; uncertain attempts retain exact retry.
  Reopened pending cycles remain actionable through a fresh current GET after their
  head evidence key is retired; unavailable sources or incomplete evidence still block commands.
- Independent acceptance, final SHA/tree-bound 27/27 Local CI, verifier and the
  required Linux/PG17/browser evidence remain rollout gates. This documentation
  does not replace current test evidence or turn historical NOT_RUN into PASS.
- Production migration, secret provisioning and deployment have not been performed.
  PR #380 remediation authorizes local commits, push and PR updates; merge and
  production actions remain outside that authorization.
