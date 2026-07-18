# PR F — Report charts design

**Date:** 2026-07-18
**Owning PR:** PR F — Charts
**Base:** `main` after PR #23 merge (`9f2fb89`)
**Status:** Opened for design agreement before implementation

## Goal

Make report chart presentation an explicit, tested contract: accessible, color-independent, empty-safe, and paired with data tables or textual summaries—without inventing metrics or silently adopting a heavy chart library.

## Current production reality

Dashboard and approval already ship **Servora-native** visuals in `web/src/reports/report-charts.tsx`:

| Component | Role |
| --- | --- |
| `CompletedTrendCalendar` | Daily completion counts as accessible month tables |
| `TrendBars` | Decorative bar strip; density classes; `aria-hidden` |
| `SegmentedDistributionBar` | Mutually exclusive SLA buckets + legend |
| `IndependentMeterBars` | Non-overlapping meters for KPI attention |

`ReportsDashboard` pairs trend bars with a disclosure calendar/table. Approval reuses segmented SLA bars.

PR F should **not** replace this stack by default. It should formalize ownership, harden contracts, and only introduce a package if a proven gap remains after native hardening.

## Package decision (default recommendation)

**Default: no new chart package in PR F.**

Rationale (KISS / YAGNI / bundle already >500 kB warning):

- Required first candidates (completed jobs over time, job-type distribution, approval waiting duration) are already covered natively.
- Native calendar is already a real data table with captions and screen-reader day text.
- Decorative bars are explicitly non-semantic and paired with text/table.
- Adding Recharts/Chart.js/etc. requires a11y dual-render tables, empty states, and color-independent series—work we can do on existing components with less risk.

**Adopt a package only if** design review documents a concrete gap that native cannot meet (e.g. multi-series interactive comparison with keyboard series isolation) **and** the package is exact-pinned with measured bundle impact.

## Approved direction if default holds

1. **Treat chart module as owned report UI**, not domain math.
2. **Hard requirements for every chart surface:**
   - color is never the only encoding (count text, patterns, or labels)
   - empty range has an explicit empty message
   - decorative visuals (`aria-hidden`) always have adjacent accessible summary or table
   - reduced-motion: no required animation for correctness
   - no page-level horizontal overflow at 390/720/1024 and 200%/400% reflow
3. **Move or re-export** chart primitives under a clear path if needed:
   - keep under `web/src/reports/report-charts.tsx`, **or**
   - extract to `web/src/ui/report-charts/` if reuse outside reports is planned (not required for first ship)
4. **Do not** recompute backend counters; only render prepared series from report DTOs.
5. **No KPI redesign** and no Delivery table changes (PR E owns tables).

## Candidate first charts (map to existing)

| Candidate | Existing surface | Gap? |
| --- | --- | --- |
| Completed jobs over time | `TrendBars` + `CompletedTrendCalendar` | Contract tests + empty/edge cases |
| Job-type distribution | Dashboard may lack a dedicated type chart | Only add if DTO already exposes series; else defer |
| Approval waiting duration | `SegmentedDistributionBar` on dashboard + approval | Contract tests + legend a11y |

## Out of PR F

- New chart library unless explicitly approved after package review
- Dark-mode chart tokens
- Drag-and-drop
- Changing report SQL/API formulas
- Migrating Approval/Staff dense tables (deferred after PR E Delivery-only)

## Open questions for approval

1. Confirm **no chart package** for PR F (recommended), or name a package + justification.
2. First ship: **harden existing three visuals only**, or also add a new job-type distribution if data exists?
3. Keep charts under `reports/report-charts.tsx` vs extract to `ui/`?

## Exit criteria

1. Chart accessibility/empty/color-independence contracts documented and tested.
2. No unapproved new dependency.
3. Bundle measured if any dependency added.
4. Existing dashboard/approval report tests still pass.
5. CI green; draft until review.
