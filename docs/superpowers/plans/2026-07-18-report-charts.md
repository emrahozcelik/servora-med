# PR F — Report charts implementation plan

**Goal:** Formalize and harden Servora-native report chart contracts without a new package unless design reopens that gate.

**Design:** `docs/superpowers/specs/2026-07-18-report-charts-design.md`
**Branch:** `feature/report-charts` from `main` after PR #23.

---

### Task 0: Status bookkeeping

- [x] Mark PR E merged via PR #23
- [x] Set current phase to PR F
- [x] Add design + plan
- [ ] Resolve package / scope open questions before Task 2 code

---

### Task 1: Inventory contracts (after design approval)

- Map `report-charts.tsx` + dashboard/approval call sites
- List empty, max=0, single-point, long-range (366 day) behaviors already tested
- Identify missing a11y assertions (legend, calendar caption, summary pairing)

---

### Task 2: Harden native charts (default path)

- Strengthen tests for color-independent encoding and empty states
- Fix any layout overflow for dense trends if found
- Document pairing rule: decorative bars require table/summary nearby

---

### Task 3: Optional job-type chart

- Only if design approves and DTO already provides series
- Otherwise explicitly defer

---

### Task 4: Package path (only if design rejects default)

- Exact-pin candidate
- Dual accessible data table for every chart
- Bundle measurement recorded in plan

---

### Task 5: Verify and draft PR

- `cd web && npm test -- --run`
- `cd web && npm run build`
- smoke if layout-affecting
- Keep draft until review
