# PR D — Feedback and overlays implementation plan

> **For agents:** Execute with TDD where behavior changes. Prefer one vertical slice per task. Do not merge without green CI. Do not start PR E.

**Goal:** Ship Servora-owned feedback and overlay adapters and migrate the highest-risk existing dialogs/sheets without changing domain authority.

**Architecture:** Design: `docs/superpowers/specs/2026-07-18-feedback-overlays-design.md`. Boundary: `docs/ui/SERVORA-UI-ARCHITECTURE.md`. Sequence: `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`.

**Tech stack:** React 19.2.7, Vite 8.1.4, TypeScript 5.9.3, Vitest 4.1.10, Ant Design 6.5.1.

**Branch:** `feature/feedback-overlays` from `main` after PR #21 merge.

---

### Task 0: Status bookkeeping

**Files:**

- Modify: `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`
- Modify: `docs/ui/SERVORA-UI-ARCHITECTURE.md`

- [x] Mark PR C merged via PR #21.
- [x] Set current phase to PR D.
- [x] List planned adapter files under the architecture owned surface.

---

### Task 1: Expand `useAppFeedback` contract

**Files:**

- Modify: `web/src/ui/antd/useAppFeedback.ts`
- Modify: `web/tests/antd-foundation.test.tsx` (or dedicated feedback test)

- [ ] Keep returning App.useApp context APIs.
- [ ] Add thin helpers only if needed (`success`, `info`, `warning`) that wrap message API without becoming a second SSOT for copy.
- [ ] Forbid feature modules from importing `antd` message/modal/notification static APIs (boundary test already covers direct imports).

---

### Task 2: `ConfirmationAction`

**Files:**

- Create: `web/src/ui/antd/ConfirmationAction.tsx`
- Create/modify: `web/tests/confirmation-action.test.tsx`
- Modify: `web/src/ui/antd/index.ts`

Contract:

- props: trigger, title, details?, confirmLabel, cancelLabel, pending, onConfirm, onCancel?, destructive?
- focus restore to trigger
- Escape cancels when not pending
- pending disables confirm and prevents double fire

Migrate first:

- Product delete dialog
- Customer delete dialog

---

### Task 3: `ReasonDialog`

**Files:**

- Create: `web/src/ui/antd/ReasonDialog.tsx`
- Create/modify: `web/tests/reason-dialog.test.tsx`
- Modify: `web/src/jobs/JobWorkflowDialog.tsx` to compose adapters or replace internals
- Modify: job-detail / manager-review tests as needed

Contract:

- required reason when configured
- empty reason shows field error (`role="alert"`)
- max length preserved (2000)
- pending lock
- Escape / focus restore parity with current `JobWorkflowDialog`

Approve / withdraw-edit may stay on ConfirmationAction path; revision / cancel use ReasonDialog.

---

### Task 4: `ResponsiveDrawer` for filters

**Files:**

- Create: `web/src/ui/antd/ResponsiveDrawer.tsx`
- Modify: `web/src/ui/FilterSheet.tsx` to re-export or wrap
- Modify: `web/tests/filter-sheet.test.tsx`

Contract:

- open/dismiss/apply/clear unchanged for JobFilters and CustomerList
- 64rem desktop does not use sheet (callers already gate)
- body scroll lock + focus trap + Escape + return focus

Do **not** migrate AppShell navigation drawer in this task.

---

### Task 5: `ResultState`, Empty, Skeleton (minimal)

**Files:**

- Create: `web/src/ui/antd/ResultState.tsx` (+ Empty/Skeleton helpers if thin)
- Tests for render-only props
- Optional: one clear empty-state call site if it reduces duplication without layout churn

Keep adoption surgical; do not rewrite every list empty UI.

---

### Task 6: `OperationalDropdown` (optional if time)

Only if Tasks 1–4 are green:

- secondary actions only
- no lifecycle primary actions
- keyboard open/close tests

Otherwise document as deferred inside PR D exit notes and leave for a follow-up on the same branch only if review asks.

---

### Task 7: Docs, verification, draft PR

- [ ] Update implementation plan checklist and verification record with real commands.
- [ ] `cd web && npm test -- --run`
- [ ] `cd web && npm run build`
- [ ] `cd web && npm run smoke:responsive` after drawer changes
- [ ] `git diff --check`
- [ ] Push and open/keep draft PR until review approval
- [ ] Do not start PR E

---

## Suggested commit slices

1. docs: open PR D phase after PR C merge  
2. feat(web): ConfirmationAction + delete dialog migration  
3. feat(web): ReasonDialog + JobWorkflowDialog migration  
4. feat(web): ResponsiveDrawer filter parity  
5. feat(web): ResultState / empty / skeleton minimal adapters  
6. docs: PR D verification record  

## Risks

- Ant Drawer/Modal focus behavior differs from current custom dialogs — parity tests are mandatory before call-site removal.
- Double-mount of Ant App message context if a second provider is introduced — keep single `ServoraAntProvider`.
- Bundle size already warns at 500 kB; avoid extra Ant entry points outside owned adapters.
