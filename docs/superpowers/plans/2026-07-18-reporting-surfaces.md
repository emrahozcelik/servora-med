# PR E — Reporting surfaces implementation plan

> **For agents:** Wait for design answers on open questions when ambiguous. Prefer one vertical table migration first.

**Goal:** Owned report table/KPI/empty presentation contracts without changing backend report truth or adopting charts.

**Design:** `docs/superpowers/specs/2026-07-18-reporting-surfaces-design.md`

**Branch:** `feature/reporting-surfaces` from `main` after PR #22.

**Tech:** React 19.2.7, Vite 8.1.4, Vitest, Ant Design 6.5.1 (Table only via owned adapter).

---

### Task 0: Status bookkeeping

- [x] Mark PR D merged via PR #22
- [x] Set current phase to PR E
- [x] Add design + plan files
- [ ] Resolve open questions with user if needed before Task 2

---

### Task 1: Inventory and contract tests (read-only first)

- Map current `ReportTable`, empty/loading/error, dashboard KPI markup
- Write failing contract tests for `OperationalTable` props:
  - caption/headers
  - row data render-only (no domain calc)
  - empty slot
  - mobile alternative render path hook

---

### Task 2: `OperationalTable` adapter

- Create `web/src/ui/antd/OperationalTable.tsx`
- Export from `ui/antd/index.ts`
- CSS via `servora-ant-*` only for Ant internals; Servora layout classes for mobile alternative

---

### Task 3: First report migration (default: Delivery dense groups)

- Replace custom `ReportTable` usage in Delivery (and optionally Approval/Staff if approved)
- Preserve filters, range, empty copy, and API calls
- Mobile card/list fallback

---

### Task 4: KPI / empty / loading normalization (minimal)

- Only if Task 3 is green
- Extract shared KPI wrapper only when it removes real duplication
- Do not expand toast feedback

---

### Task 5: Docs, full verify, draft PR

- [ ] `cd web && npm test -- --run`
- [ ] `cd web && npm run build`
- [ ] `cd web && npm run smoke:responsive`
- [ ] Update implementation plan verification record
- [ ] Keep draft until review; do not start PR F

---

## Out of PR E

- Chart package / PR F charts
- AppShell drawer
- Popconfirm expansion
- Invented export pipelines without existing product need
