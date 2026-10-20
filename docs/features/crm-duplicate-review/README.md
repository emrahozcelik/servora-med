# CRM Slice 4A — owning contracts and PR1 rollout

**Status: Accepted Design / PR1 Rollout Pending.**

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

PR #379 implements PR1 only: management-only candidate/comparison GETs and
virtual pending reviews (id=null, version=0, allowedActions=[]). The same-org
BUSINESS scope includes prospect, active and inactive customers. GET creates no
business, review, audit or receipt rows. Existing tax/Contact primary and STAFF
CRM permissions are unchanged.

PR2/PR3 persistent decisions, reopen and history are not implemented. There is
no Customer/Contact merge, identity alias, deactivation, deletion or referential
rewrite. 4B, WR-01 and Issue #369 are outside this rollout.

- CRM_DUPLICATE_COMPARISON_ENABLED defaults to false. Disabled startup does not
  require a keyring. Enabling requires strict CRM_DUPLICATE_EVIDENCE_KEYRING
  validation and the key custody/rotation/recovery ownership in Design SD-4.4.
  No real keys are committed or provisioned by this package.
- Catalog head 059 adds two read-side indexes only. Env examples and the exact
  startup/schema gate must match the deployed release catalog.
- Source/evidence limits and query ownership remain Design SD-3/SD-4. The CRM
  read repository enforces a whole-request monotonic deadline and discards a
  timed-out client and its transport without awaiting an unresponsive rollback.
- Authentication -> management role guard -> one manual class limiter -> handler,
  no-store and visible-page 60-second refresh remain the accepted API contract.
  Retained results after temporary refresh failure are labelled stale; definitive
  access/source loss clears cached comparison data.
- Independent acceptance, final SHA/tree-bound 27/27 Local CI, verifier and the
  required Linux/PG17/browser evidence remain rollout gates. This documentation
  does not replace current test evidence or turn historical NOT_RUN into PASS.
- Production migration, secret provisioning and deployment have not been performed.
  Push/PR update, merge and production actions require their own authorization.
