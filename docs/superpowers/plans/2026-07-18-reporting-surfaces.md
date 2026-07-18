# PR E — Reporting surfaces implementation plan

**Goal:** Owned `OperationalTable` + Delivery-only migration at 720px card parity.

**Design:** `docs/superpowers/specs/2026-07-18-reporting-surfaces-design.md`
**Branch:** `feature/reporting-surfaces`

## Approved decisions

- [x] Required first migration: Delivery only
- [x] ReportKpiSummary deferred; table-first
- [x] Compact alternative uses existing 720px report breakpoint (not 64rem)

---

### Task 1: OperationalTable contract tests + adapter

- Create `web/src/ui/antd/OperationalTable.tsx`
- Create `web/tests/operational-table.test.tsx`
- Export from boundary index
- Desktop semantic table + mobile card list; CSS 720px switch
- No API/domain logic

### Task 2: Delivery migration

- Replace local `ReportTable` with `OperationalTable`
- Preserve caption, empty state, groupBy column sets, quantities as strings
- Feature owns row preparation; adapter owns dual layout

### Task 3: A11y / CSS contracts

- Update Delivery-specific accessibility expectations for dual surface
- Keep Staff/Approval on existing `responsive-report-table` path
- CSS for `.servora-operational-table` at 720px

### Task 4: Verify and push

- Full web tests, build, responsive smoke
- Update implementation plan verification
- Push PR #23; keep draft until review
