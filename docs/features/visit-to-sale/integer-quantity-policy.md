# SALE-QTY-001 — Integer quantity and forward-upgrade contract

Accepted 2026-10-15. Implementation baseline: main
`b6e37e1cee0d60a5561e4e7cb732f781f487e407`, tree
`203fe8777eddcb8a7b8fb526128f97e90fd52943`, catalog 057.
[DECISIONS.md](../../../DECISIONS.md) is the product decision authority.

## Quantity semantics

Sale quantity is product count, regardless of catalog unit: JSON numeric safe
integer, 1–999999999. Fractions (including 0.001, 0.5, 1.5, 2.75), nonnumbers,
nonfinite numbers, zero, negatives and overflow fail validation before persistence.
Create, add, correction and submit readiness share `saleQuantity`. No rounding,
truncation or conversion. Delivery, shared ProductSelect and ProductForm retain
their existing contracts; Warehouse physical measurement remains a future policy.

This explicitly supersedes the decimal Sale input/public presentation in PR1/PR2
and the initial discovery documents. Their historical baseline observations and
migration 057 are not rewritten. Other SALE-001 and MOD-001 rules remain intact.

## Persistence, request identity and presentation

Migration 058 locks the Sale item table, preflights existing stored values,
removes the NUMERIC(12,3) typmod (`ALTER COLUMN quantity TYPE NUMERIC`, no USING
conversion), and adds a validated CHECK:
`quantity >= 1 AND quantity = trunc(quantity) AND quantity <= 999999999`.
Unrestricted NUMERIC preserves the input value until CHECK evaluation, so raw SQL
fractions including 1.0001, 2.9999, 15.0004 and 999999998.9999 are rejected rather
than rounded. Existing metadata, foreign keys and other constraints remain.
Migration SQL and its ledger entry commit together through the existing runner.
A historical invalid row raises SQLSTATE 23514 with a SALE-QTY-001 remediation
message; neither data nor migration history is changed. No automatic data UPDATE,
rounding, truncation, deletion or NUMERIC(12,0) conversion is performed.

This is the accepted PR #373 refinement of **unmerged** 058. The first reviewed
058 retained NUMERIC(12,3); that approach could round excess-scale SQL before its
CHECK and is superseded here. Migrations 001–057 remain byte-identical. Precision
already lost by historical 057 writes cannot be reconstructed by this migration.

The migration needs AccessExclusiveLock and scans rows for preflight and CHECK
validation; it blocks concurrent readers/writers until commit. PostgreSQL 17
integration tests observe the lock waiting behind a reader, verify unchanged heap
filenode/size and row xmin, and record dependent index filenodes separately.
They also verify unchanged audit/receipt bytes and xmin, receipt replay, and
complete rollback on invalid history. This does not imply zero lock or validation
cost for a large table; future deployment requires an appropriate maintenance window.

Application writes and private repository projections retain `"1.000"` for
readiness, noop comparison, v1 request hashes and durable audits. Valid direct SQL
counts may have different storage scales (`1`, `1.0`, `1.0000`); private reads
normalize them without rounding, independently of public presentation. Do not bump operation tags or
switch the hash to integer strings. Old successful **integer** create/add/update
receipts replay with their original `{jobCardId, version}` result and current
access checks. Different payloads conflict; a same-quantity correction is a
NO_CHANGES error without version/audit/receipt consumption. Former fractional
requests are now invalid and cannot create a second mutation; historical data
remediation does not silently rewrite their receipts.

The detail SQL uses `trim_scale` to expose `"1"`, `"15"` without rounding. Safe
activity projections accept durable integer three-scale values and expose the
same integer strings; malformed/fractional historical audit quantities are not
coerced into counts (safe NONE detail, raw audit preserved). Frontend detail and
activity parsing share a strict positive integer-string parser. Sale UI shows
`15 ürün`; nullable unit appears only among historical product metadata. Timeline
corrections read `1 ürün → 2 ürün`. No quantity is appended to ml/mg/litre.

## Deployment compatibility and data preflight

No deployment or production DB access is part of this change. On 2026-10-15,
readonly public health reported release `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa`.
Its public index bundle `index-CM6EZpJT.js` has no `includeSaleCapability`, and its
JobCard type labels/parser exclude SALE (delivery purpose SALE is unrelated).
The matching release source also lacks Sale-aware JobCard types. This is a
point-in-time public bundle observation, not a claim about production database
contents or all cached browser sessions.

Local databases that already recorded the first unmerged 058 will not rerun the
revised file: the migration runner tracks versions, not an amended-file upgrade.
Rebuild disposable test databases from the catalog. Do not delete ledger entries
or silently reapply 058 to an existing database. Any non-disposable environment
that applied the earlier draft requires a separate, authorized recovery plan.

A pre-Sale bundle remains protected by PR2's capability gate. An intermediate
PR2 Sale-aware bundle expects decimal strings, so pairing it with integer-only
readers is incompatible. A future authorized rollout must ship migration 058,
backend and matching web artifact together through the existing fail-closed
schema/release gates, and reload intermediate Sale-aware test/staging sessions.
Do not enable PR3 writes against mixed contracts. No generic API versioning or
fractional compatibility fallback is introduced.

Before any future authorized DB upgrade, a data owner can run this read-only
check against the target environment (not executed against production here):

```sql
SELECT count(*) AS invalid_sale_item_count
FROM job_card_sale_items
WHERE quantity < 1 OR quantity <> trunc(quantity) OR quantity > 999999999;
```

Any nonzero count is a deployment blocker requiring an explicit data-owner plan,
including audit/receipt implications. Do not automatically round, delete or rewrite
those rows. The migration repeats the authoritative check under its table lock,
so a prior clean preflight cannot bypass a concurrent invalid legacy write.

## Verification and PR3 handoff

Focused RED→GREEN covers input, historical-fraction migration STOP, public reader,
audit projection, frontend parser, count rendering and timeline count text.
PostgreSQL tests cover 057→058 without row/receipt rewrites, direct INSERT/UPDATE
rejection, both boundaries, replay hashes for create/add/correction, 1→2→1 and
noop/conflict, snapshot preservation and unchanged tenant/role guards. Full
server/web and canonical 27-check CI evidence must bind to the exact PR head/tree
outside the source checkout. Four opt-in R2/DR skips remain SKIPPED.

PR3 defaults to 1 and must use integer-only input (`min=1`, `step=1`,
`inputMode=numeric`) for create/add/correction, with no conversion or silent
fallback. A Sale-specific adapter may configure ProductSelect there; Delivery
fractions must remain supported. Public Sale create/correction routes and their
UI remain closed in this task. No financial, stock or delivery effects are added.
