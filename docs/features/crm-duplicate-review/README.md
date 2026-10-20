# CRM Slice 4A — owning contracts and rollout

**Status: PR1 merged / PR2 implementation-under-review / PR3 pending.**

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
reviews. PR2 in PR #380 adds persistent decisions, explicit reopen, immutable
history and the manager decision UI; its implementation remains under independent
review. Virtual pending reviews still use id=null/version=0; PR2 supplies allowed
actions from backend policy. The same-org
BUSINESS scope includes prospect, active and inactive customers. GET creates no
business, review, audit or receipt rows. Existing tax/Contact primary and STAFF
CRM permissions are unchanged.

PR3 register/workbench is pending. PR2 ALL candidate view keeps current matching
confirmed/dismissed pairs reachable for comparison, history and explicit reopen;
the independent register for historical pairs that no longer match is PR3 scope.
There is no Customer/Contact merge, identity alias, deactivation, deletion or referential
rewrite. 4B, WR-01 and Issue #369 are outside this rollout.

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
- Independent acceptance, final SHA/tree-bound 27/27 Local CI, verifier and the
  required Linux/PG17/browser evidence remain rollout gates. This documentation
  does not replace current test evidence or turn historical NOT_RUN into PASS.
- Production migration, secret provisioning and deployment have not been performed.
  PR #380 remediation authorizes local commits, push and PR updates; merge and
  production actions remain outside that authorization.
