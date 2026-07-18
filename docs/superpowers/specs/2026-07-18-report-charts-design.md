# PR F — Report charts design

**Date:** 2026-07-18
**Owning PR:** PR F — Charts
**Base:** `main` after PR #23 merge (`9f2fb89`)
**Status:** Scope approved for implementation (18 July 2026 review)

## Approved decisions

1. **PR F adds no chart package.**
2. **PR F hardens the existing three visualization families only**; job-type distribution is deferred because no prepared DTO series exists.
3. **Report chart components remain under `web/src/reports/report-charts.tsx`**; generic `ui/` extraction is deferred until cross-feature reuse is proven.

## Goal

Harden Servora-native report chart contracts: accessible pairing, color-independent semantics, empty/zero/single/long-range edge cases, and reflow safety—without backend metric changes.

## In scope

| Family | Components |
| --- | --- |
| Completion trend | `TrendBars` + textual summary + `CompletedTrendCalendar` |
| Approval waiting distribution | `SegmentedDistributionBar` |
| Independent KPI meters | `IndependentMeterBars` |

## Out of scope

- New chart package (Recharts, Chart.js, ECharts, …)
- Job-type distribution (requires new DTO/backend series)
- Backend/API/DTO metric changes
- New KPI definitions
- Delivery table changes
- Dark-mode chart tokens
- Generic `ui/` extraction

## Contracts

### Trend

- `TrendBars` is always `aria-hidden`
- Call site provides visible total/summary
- Accessible calendar (or data view) in the same section
- Empty series: explicit “tamamlanma yok” style message
- Test single point, all-zero max, and 366-day density

### Calendar

- Visible native caption per month
- Weekday `scope="col"`
- In-range days expose date + count to SR
- Out-of-range days clearly separated
- Empty input → visible empty message
- Zero-count days are not confused with out-of-range

### Segmented

- Track is decorative (`aria-hidden`)
- Legend: label + numeric value per segment
- Textual total summary
- Zero distribution → explicit empty message
- Color/swatch never sole meaning
- Segments are mutually exclusive (input contract)

### Meters

- Visible label + value
- Bar track decorative
- Values are **not** a percentage partition of 100%
- All-zero values do not break scaling
- Empty `items` → visible empty message
- Long labels must not force page overflow

## Package gate (future only)

Reopen package discussion only for multi-series interactive comparison with keyboard series selection and native proven inadequacy, with exact pin + bundle measurement.
