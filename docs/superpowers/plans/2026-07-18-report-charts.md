# PR F — Report charts implementation plan

**Goal:** Harden native chart contracts only; no package; no job-type metric.

**Branch:** `feature/report-charts`

## Approved decisions

- [x] No chart package
- [x] Harden existing three families only; job-type deferred
- [x] Stay in `reports/report-charts.tsx`

---

### Task 1: Component contract tests

- Empty / zero / single / 366-day for TrendBars density
- Calendar caption, col scope, SR day text, empty input
- Segmented legend + total + empty
- Meters empty items + label/value + non-partition note in docs/comments

### Task 2: Harden components

- IndependentMeterBars empty state
- TrendBars empty points safe render
- Any small a11y/copy gaps

### Task 3: Call-site pairing tests

- ReportsDashboardView: TrendBars aria-hidden + summary + calendar disclosure
- Empty completedTrend explicit message
- Approval/SLA uses segmented with legend values

### Task 4: Verify and push

- Full web tests + build
- Update implementation plan verification
- Push PR #24; keep draft until review
