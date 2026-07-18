# PR D — Feedback and overlays implementation plan

> **For agents:** TDD where behavior changes. Narrowed ship scope only. No PR E.

**Goal:** Migrate high-risk confirmation, reason, and filter overlays to owned adapters without domain or a11y regression.

**Design:** `docs/superpowers/specs/2026-07-18-feedback-overlays-design.md`

**Branch:** `feature/feedback-overlays`

**Approved ship (only):**

1. `ConfirmationAction` (modal-only)
2. `ReasonDialog`
3. `ResponsiveDrawer` for Job + Customer filters

**Out of PR D:** ResultState, EmptyState, LoadingSkeleton, OperationalDropdown, AppShell Drawer, Popconfirm, broad toast migration.

---

### Task 0: Record narrowed decisions — DONE

- [x] ConfirmationAction modal-only; Popconfirm deferred
- [x] Result/Empty/Skeleton/Dropdown removed from exit criteria
- [x] Feature vs adapter state/focus ownership documented

---

### Task 2A: ConfirmationAction contract tests + adapter

- Create: `web/src/ui/antd/ConfirmationAction.tsx`
- Create: `web/tests/confirmation-action.test.tsx`
- Export from `web/src/ui/antd/index.ts`

### Task 2B: Product / customer delete migration

- Replace local delete dialogs with `ConfirmationAction`
- Keep copy, API, list refresh, destructive presentation
- Adapter owns focus restore; remove dialog-local restore duplication

### Task 3A: ReasonDialog contract tests + adapter

- Create: `web/src/ui/antd/ReasonDialog.tsx`
- Create: `web/tests/reason-dialog.test.tsx`

### Task 3B: JobWorkflowDialog migration

- approve / withdraw-edit → ConfirmationAction
- revision / cancel → ReasonDialog
- Preserve command intents and server refresh
- Remove parent-side dialog focus restoration that duplicates adapter ownership

### Task 4: ResponsiveDrawer

- Create: `web/src/ui/antd/ResponsiveDrawer.tsx`
- Wire JobFilters + Customer filters; FilterSheet becomes thin re-export or is replaced
- AppShell drawer unchanged
- Parity tests for Escape, trap, scroll lock, apply/clear/dismiss, restore

### Task 5: Boundary, smoke, docs, verify

- [ ] Boundary tests still pass
- [ ] `cd web && npm test -- --run`
- [ ] `cd web && npm run build`
- [ ] `cd web && npm run smoke:responsive` after drawer changes
- [ ] Update implementation plan verification record
- [ ] Push; keep draft until review
