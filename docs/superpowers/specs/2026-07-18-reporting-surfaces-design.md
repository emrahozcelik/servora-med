# PR E — Reporting surfaces design

**Date:** 2026-07-18
**Owning PR:** PR E — Reporting surfaces
**Base:** `main` after PR #22 merge (`033d5b7`)
**Status:** Opened for design agreement before implementation

## Goal

Introduce Servora-owned report presentation adapters so dense report tables, KPI summaries, empty/loading states, and filter toolbars share one accessibility and responsive contract—without changing report data APIs or inventing metrics on the client.

## Non-goals

- Chart library selection or new chart packages (PR F)
- AppShell / navigation changes
- Overlay work already shipped in PR D
- Backend report formula or SQL changes unless a bug blocks a presentation contract
- Broad redesign of non-report screens
- OperationalDropdown unless a report secondary action truly needs it (default: out)

## Context (current production)

Reports already exist under `web/src/reports/`:

- Dashboard KPI sections and attention cards
- Delivery, Approval, Staff operational reports
- Shared `report-shell` empty/error/loading and date range form
- Custom HTML tables (`ReportTable`) and chart-like native visuals in `report-charts.tsx`
- Filters via URL search params and range validation

PR E refactors presentation ownership; it does not invent new report domains.

## Owned adapters (proposed)

| Adapter | Role | Notes |
| --- | --- | --- |
| `OperationalTable` | Dense tabular report data | Ant Table behind owned API; semantic caption/headers; no page-level horizontal scroll task failure |
| `ReportKpiSummary` | KPI metric groups | Servora-native composition first; may stay free of Ant if current markup already matches DESIGN.md |
| `ReportEmptyState` / loading | Shared empty and skeleton | May relocate existing shell helpers into `ui/antd` or keep in `report-shell` with thin re-exports |
| Filter toolbar contract | Shared report filter region | Preserve URL ownership and 64rem/container reflow; do not break existing search helpers |

## Composition rules

1. **Report data remains backend truth.** Adapters receive already-shaped DTOs/rows. No client recomputation of delivery totals, SLA, or approval age.
2. **Tables only where density justifies them.** Dashboard attention lists stay lists/cards; multi-column product/day aggregates may use `OperationalTable`.
3. **No compressed desktop table on mobile.** Below the report responsive breakpoint, provide card/list or stacked row alternative with the same fields and action links.
4. **Empty and error stay explicit.** Empty must explain why empty and what to do next (filter reset). Errors stay retryable when API says so. Critical failures stay inline, not toast-only.
5. **Loading geometry is stable.** Skeleton/loading placeholders match final layout enough to avoid focus traps and large CLS.
6. **Export affordances (optional in first ship).** If current UI has no export, do not invent CSV/PDF in PR E; only unify any existing export entry if present.
7. **Charts stay PR F.** Existing custom SVG/CSS charts remain; do not adopt a chart package here.

## Suggested first migration map

| Surface | Target |
| --- | --- |
| Delivery / Approval / Staff dense tables | `OperationalTable` + mobile alternative |
| Dashboard KPI `dl.report-metrics*` | Keep Servora-native; extract shared `ReportKpiSummary` only if duplication warrants it |
| `ReportEmptyState` / loading / error in shell | Normalize contracts; optional move under owned UI boundary |
| Date range + filter forms | Contract tests + shared class/structure only; no behavior change |

## Accessibility contract

- Tables: caption or `aria-labelledby`, column headers (`th` scope), keyboard reachability of row actions
- Mobile alternative: same information as desktop columns, not a truncated subset that hides operational fields
- Empty: heading + description + optional primary secondary action
- Loading: `aria-busy` / polite status without trapping focus
- Filters: existing min target size and reduced-motion rules from DESIGN.md

## Exit criteria

1. At least one dense report table path uses `OperationalTable` with tests.
2. Mobile alternative parity tested for that path.
3. Existing report correctness tests still pass (range, search, API clients, dashboard counters).
4. No chart package added.
5. Docs mark PR E complete and PR F next.
6. CI green; draft until review.

## Open questions for approval before code

1. First table migration: Delivery report only vs all three dense reports in one PR?
2. KPI summary: extract shared component now, or leave dashboard markup and only ship table adapter?
3. Mobile breakpoint for table→card: reuse `max-width: 720px` report table rule or align to `64rem` shell?
