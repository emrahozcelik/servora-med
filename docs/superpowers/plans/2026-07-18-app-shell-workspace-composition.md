# App Shell and Workspace Composition Implementation Plan

> **For Codex:** Execute this plan inline with `superpowers:executing-plans`, preserving task order and every red-green-refactor checkpoint.

**Goal:** Deliver PR B’s Servora-native app shell composition and responsive horizontal workflow lanes while preserving navigation, JobCard domain, board API, status-filter, and closed-count contracts.

**Architecture:** The production navigation model remains the single source of destinations and gains only presentation grouping metadata consumed by the existing AppShell. The board response remains the canonical five-status payload. A small frontend lane presentation model owns approved labels and role-aware compact ordering; it never creates a persisted status. Desktop lanes are full-width horizontal sections with responsive card grids; compact layouts use the same semantic sections in one-column flow. Ant Design `Layout`, `Menu`, and `Card` are forbidden, and lifecycle Steps/Timeline remain PR C.

**Tech Stack:** React 19.2.7, React Router 7.13.1, Vite 8.1.4, TypeScript 5.9.3, Vitest 4.1.10, jsdom 28.1.0, owned CSS.

**Approved scope:** PR B from `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`, backed by the approved PR #18 prototypes and architecture. PR C detail lifecycle work is explicitly excluded.

**Execution status:** Implemented and locally verified on 18 July 2026; branch publication and CI remain.

---

### Task 1: Specify the navigation grouping contract

**Files:**

- Modify: `web/tests/navigation-model.test.ts`
- Modify: `web/tests/app-shell.test.tsx`
- Modify: `web/src/shell/navigation-model.ts`
- Modify: `web/src/AppShell.tsx`

- [ ] **Step 1: Write failing navigation-model tests**

Assert that every role keeps its exact existing destination and bottom-navigation order while desktop destinations expose the approved section metadata: Operasyon for İşler/Müşteriler/Ürünler, Analiz for Raporlar, and Ekip for Personel/Profilim/Kullanıcılar.

- [ ] **Step 2: Write failing AppShell tests**

Assert that the desktop sidebar renders section headings from the model for Staff, Manager, and Admin, without duplicating destinations. Assert the compact drawer continues to use the same destination model and preserves its existing focus/dismiss behavior.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `cd web && npm test -- --run tests/navigation-model.test.ts tests/app-shell.test.tsx`

Expected: FAIL only because section metadata and grouped sidebar markup do not exist.

- [ ] **Step 4: Add minimal grouping metadata and grouped rendering**

Add a typed section field to `NavLinkItem`. Group destinations in `DestinationNav` in first-seen model order, with semantic labelled sections and no secondary role list. Keep bottom and overflow derivation unchanged.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run: `cd web && npm test -- --run tests/navigation-model.test.ts tests/app-shell.test.tsx`

Expected: PASS.

### Task 2: Specify the workflow-lane presentation model

**Files:**

- Create: `web/src/jobs/workflow-lanes.ts`
- Create: `web/tests/workflow-lanes.test.ts`

- [ ] **Step 1: Write failing presentation-model tests**

Assert the canonical desktop order and labels:

```text
NEW                 Hazırlanıyor
ACCEPTED            Atandı
IN_PROGRESS         Uygulanıyor
WAITING_APPROVAL    Yönetici kontrolünde
REVISION_REQUESTED  Düzeltme istendi
```

Assert compact Staff order is REVISION_REQUESTED, IN_PROGRESS, ACCEPTED, NEW, WAITING_APPROVAL. Assert compact Manager/Admin control-queue order is WAITING_APPROVAL, REVISION_REQUESTED, IN_PROGRESS, NEW, ACCEPTED. Assert no `PLANNED`, `COMPLETED`, `CANCELLED`, or synthetic overdue status enters the active lane model.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `cd web && npm test -- --run tests/workflow-lanes.test.ts`

Expected: FAIL because the presentation module does not exist.

- [ ] **Step 3: Implement the smallest typed model**

Export immutable lane definitions and a `workflowLanesFor(role, compact)` selector. Keep labels local to workspace presentation; do not change canonical domain labels or backend types.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run: `cd web && npm test -- --run tests/workflow-lanes.test.ts`

Expected: PASS.

### Task 3: Replace narrow columns with horizontal workflow lanes

**Files:**

- Modify: `web/tests/job-board.test.tsx`
- Modify: `web/src/jobs/JobBoard.tsx`

- [ ] **Step 1: Rewrite board behavior tests first**

Assert five semantic lane sections use the approved labels, counts, status shapes, and role/viewport order. Assert each lane exposes `Tümünü gör`, preserving all current filters while selecting its status, switching to list view, and resetting offset. Preserve canonical card facts, workflow summaries, closed links/counts, and the no-drag contract.

- [ ] **Step 2: Add responsive-card DOM contract tests**

Provide at least five fixture items in one response column. Assert the board renders at most four preview cards for a lane and retains the backend total count. Assert a lane with no items renders an explicit compact empty message rather than an empty scrolling region.

- [ ] **Step 3: Run focused board tests and observe RED**

Run: `cd web && npm test -- --run tests/job-board.test.tsx`

Expected: FAIL on old column markup, old labels/order, missing filtered links, unlimited previews, and missing empty state.

- [ ] **Step 4: Implement horizontal lane markup**

Consume `workflowLanesFor`. Render a heading group, total count, and filtered `Tümünü gör` link per lane. Slice preview data to four without modifying response counts. Keep `BoardCard`, closed links, status filtering, and all existing JobCard facts intact. Add a `compact` prop supplied by the workspace.

- [ ] **Step 5: Run focused board tests and observe GREEN**

Run: `cd web && npm test -- --run tests/job-board.test.tsx`

Expected: PASS.

### Task 4: Make board composition available on compact shells

**Files:**

- Modify: `web/tests/job-board.test.tsx`
- Modify: `web/tests/filter-sheet.test.tsx`
- Modify: `web/src/jobs/JobWorkspace.tsx`
- Modify: `web/src/jobs/JobFilters.tsx`

- [ ] **Step 1: Write failing routed compact-board tests**

Replace the old forced-list expectations. Assert `view=board` remains canonical below 64rem, calls the unchanged board endpoint, renders compact role-aware lanes, and remains stable across desktop/compact resize. Assert a stale request is still ignored by the request gate.

- [ ] **Step 2: Write a failing compact view-control test**

Assert the compact filter sheet exposes a labelled Liste/Pano selector when board selection is allowed and that choosing Pano calls the existing `onViewChange('board')` contract.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `cd web && npm test -- --run tests/job-board.test.tsx tests/filter-sheet.test.tsx`

Expected: FAIL because compact board URLs are forced to list and the filter sheet has no view selector.

- [ ] **Step 4: Remove only the temporary compact-board gate**

Keep the 64rem shell detection solely for `compact` presentation. Do not redirect board URLs on compact viewports or invalidate them on resize. Pass `compact={isDesktop === false}` to `JobBoard`. Keep list default, canonical search parsing, request filters, Staff assignee scoping, error states, and list behavior unchanged.

- [ ] **Step 5: Add the compact view selector**

Render it inside the existing filter sheet using the same `onViewChange` callback. Do not create a second URL state owner.

- [ ] **Step 6: Run focused tests and observe GREEN**

Run: `cd web && npm test -- --run tests/job-board.test.tsx tests/filter-sheet.test.tsx`

Expected: PASS.

### Task 5: Implement the approved shell and lane CSS composition

**Files:**

- Modify: `web/tests/responsive-layout-contract.test.ts`
- Modify: `web/tests/accessibility-contract.test.ts`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing responsive CSS contracts**

Assert the old five-column grid and independently scrolling columns are absent. Assert horizontal lane sections, a default one-column card grid, three-card desktop layout, four-card wide-container layout, and 2/3/4 preview visibility rules. Assert the exact shell boundary is `<64rem` compact and `>=64rem` desktop.

- [ ] **Step 2: Write failing accessibility/style contracts**

Assert lane headings and links can wrap, cards and facts use `min-width: 0`, the board clips no task content through horizontal scroll dependence, 320px reflow has one-column cards, focus targets remain at least 44px, and no Ant `Layout`, `Menu`, `Card`, gradient, glass, or card shadow styling appears.

- [ ] **Step 3: Run CSS contract tests and observe RED**

Run: `cd web && npm test -- --run tests/responsive-layout-contract.test.ts tests/accessibility-contract.test.ts`

Expected: FAIL on the old column CSS and missing lane/card-grid contracts.

- [ ] **Step 4: Implement flat Servora-native shell grouping styles**

Style sidebar section headings and grouped links using existing tokens, thin rules, flat surfaces, and current focus behavior. Do not change AppShell breakpoints or drawer behavior.

- [ ] **Step 5: Implement horizontal lane and preview styles**

Use full-width sections separated by rules. Cards form one column on compact layouts, three columns at desktop, and four columns when the board container reaches 68rem (with the existing 90rem viewport fallback). Hide previews beyond two on compact, beyond three on normal desktop, and reveal the fourth only at wide usable width. Ensure the `Tümünü gör` link is always reachable.

- [ ] **Step 6: Run CSS contract tests and observe GREEN**

Run: `cd web && npm test -- --run tests/responsive-layout-contract.test.ts tests/accessibility-contract.test.ts`

Expected: PASS.

### Task 6: Update PR B records and verify the complete slice

**Files:**

- Modify: `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`
- Modify: `docs/ui/SERVORA-UI-ARCHITECTURE.md`
- Verify: all changed files

- [ ] **Step 1: Make the implementation record current**

Mark PR A merged and PR B implemented on its feature branch. Record the actual navigation, compact ordering, lane-label, card-preview, filter-link, mobile-board, and responsive verification results. Clarify that a separate Manager/Admin Geciken lane remains outside PR B because the preserved board API has no exact overdue collection/count; existing overdue filters and card attention remain unchanged. Keep PR C-F pending.

- [ ] **Step 2: Run all focused PR B tests together**

Run: `cd web && npm test -- --run tests/navigation-model.test.ts tests/app-shell.test.tsx tests/workflow-lanes.test.ts tests/job-board.test.tsx tests/filter-sheet.test.tsx tests/responsive-layout-contract.test.ts tests/accessibility-contract.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the complete web suite and build**

Run: `cd web && npm test -- --run`

Expected: all tests pass.

Run: `cd web && npm run build`

Expected: production build passes; report the emitted JS raw/gzip measurement and any Vite warning honestly.

- [ ] **Step 4: Run responsive smoke**

Run: `cd web && npm run smoke:responsive`

Expected: 390, 768, 1024, 1440, 200% text, and 400% reflow scenarios pass with no task-level horizontal workflow scroll.

- [ ] **Step 5: Re-run server safety checks**

Run: `cd server && npm run build`

Expected: PASS.

Run: `cd server && npm test -- --run`

Expected: existing suite passes with only documented environment-dependent skips; no server or API source changed.

- [ ] **Step 6: Review scope and repository state**

Run: `git diff --check && git status --short && git diff --stat`

Expected: changes are limited to PR B plan/docs, navigation presentation, shell/board/filter composition, CSS, and focused tests. No JobDetail, Steps, Timeline, server, migration, or API contract changes.

- [ ] **Step 7: Commit and publish for review**

Create one or more surgical English commits on `feature/app-shell-workspace-composition`, push the branch, open PR B as a draft with verification evidence, and wait for CI. Do not merge and do not begin PR C.
