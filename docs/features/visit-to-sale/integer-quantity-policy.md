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

Migration 058 keeps NUMERIC(12,3), historical metadata and existing constraints.
It locks the Sale item table, preflights existing stored values and adds a
validated CHECK: `quantity >= 1 AND quantity = trunc(quantity) AND quantity <= 999999999`.
Migration SQL and its ledger entry commit together through the existing runner.
A historical invalid row raises SQLSTATE 23514 with a SALE-QTY-001 remediation
message; neither data nor migration history is changed. It never converts data.
The migration is deliberately blocking during table validation; plan maintenance
accordingly if a future deployment has a large Sale history.

PostgreSQL's existing three-decimal typmod can round excess-scale raw SQL before
a CHECK sees it. The CHECK protects the **stored** integer invariant; it does not
claim to detect all pre-cast SQL precision. The numeric JSON service validator
rejects fractional values without passing them to SQL. No NUMERIC(12,0) cast,
trigger or column rewrite is used.

Private normalized quantities remain `"1.000"` for storage, readiness, noop
comparison, v1 request hashes and durable audits. Do not bump operation tags or
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
