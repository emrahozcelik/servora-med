# PR E — Reporting surfaces design

**Date:** 2026-07-18
**Owning PR:** PR E — Reporting surfaces
**Base:** `main` after PR #22 merge (`033d5b7`)
**Status:** Scope approved for implementation (18 July 2026 review)

## Approved decisions

1. **Required first migration: Delivery only.** Approval and Staff are not start or merge criteria.
2. **ReportKpiSummary is deferred.** PR E is table-first; existing KPI markup stays Servora-native.
3. **Compact alternative uses the existing 720px report-specific breakpoint.** The 64rem AppShell breakpoint is not reused as the table SSOT.

## Goal

Ship an owned `OperationalTable` adapter and migrate the Delivery dense report to it, with a real mobile card/list alternative under 720px—without changing report APIs, metrics, filters, or charts.

## Ship scope (IN)

- `OperationalTable`
- Delivery dense report migration (all groupBy variants)
- Delivery mobile card/list parity at `max-width: 720px`
- Caption or `aria-labelledby`
- Column headers and row labels accessible
- Existing empty/error/loading behavior preserved
- Responsive smoke and contract tests

## Out of PR E (OUT)

- Approval report migration
- Staff report migration
- ReportKpiSummary extraction
- KPI markup redesign
- Chart package or chart refactor
- New export feature
- Backend metric/formula changes
- Global 64rem report breakpoint migration

## Native table decision (approved for Delivery)

Delivery uses a **Servora-native** dual-layout component at
`web/src/ui/OperationalTable.tsx`, not Ant Design `Table` under `ui/antd/`.

Reasons:

- static report rows need caption, `scope`, and equal mobile cards without sort/expand
- KISS for the Delivery-only first slice
- Ant Table remains selective for future admin/sortable surfaces

Mobile surface must show the same caption as desktop as **visible text** (not only
`aria-label`).

## Adapter rules

`OperationalTable` must not:

- call APIs
- compute totals or metrics
- own URL/filter state
- invent domain columns
- own pagination
- decide which fields are “unimportant” on mobile

Feature (Delivery) prepares columns and row cells from API truth. Adapter only renders desktop table + mobile cards from that prepared data.

## Breakpoint

```css
@media (max-width: 720px) {
  /* desktop table hidden */
  /* mobile card/list visible */
}
```

- `<720px` / `max-width: 720px`: real card/list alternative
- above that: desktop table
- Same prepared rows for both surfaces
- Mobile cards must show every operational field present in desktop columns
- No compressed Ant table, page-level horizontal scroll, or hidden critical columns

If 721–900px evidence later proves the table does not fit, choose an adapter-specific threshold from tests—not by defaulting to 64rem.

## Exit criteria

1. Delivery uses `OperationalTable` for non-empty dense groups.
2. Mobile card alternative covers all columns at 720px.
3. Existing delivery/report tests pass; accessibility caption/headers preserved for Delivery desktop table.
4. No KPI extraction, no Approval/Staff migration, no chart package.
5. CI green; draft until review.
