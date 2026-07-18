# Job Detail Lifecycle UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompose JobCard detail screens around backend-owned lifecycle truth using Servora-owned Ant Design Steps, Descriptions, and Timeline adapters.

**Architecture:** Keep `JobWorkflowPresentation`, existing command intents, dialogs, API calls, refresh behavior, and audit ordering authoritative. Add thin render-only adapters under `web/src/ui/antd/`, extend presentation facts only from existing API truth, and compose state-specific Servora panels in mobile-first DOM order.

**Tech Stack:** React 19, TypeScript, Ant Design 6.5.1, Vite 8, Vitest, jsdom, existing Servora CSS tokens.

## Global Constraints

- Do not change backend, migrations, API contracts, lifecycle commands, permissions, readiness rules, or activity creation.
- Do not introduce Ant `Modal`, `Popconfirm`, `ConfirmationAction`, reason-dialog adapters, toast migration, `Drawer`, or `Dropdown`.
- Preserve existing dialog markup, validation, focus trap, portal behavior, pending lock, and stale-version server refresh.
- Only owned adapters may import Ant `Steps`, `Descriptions`, or `Timeline`.
- Mobile DOM order must place every primary lifecycle action before Timeline.
- Components render presentation facts; they do not infer missing domain facts.

---

### Task 1: Neutral status-presentation ownership

**Files:**
- Create: `web/src/jobs/job-status-presentation.ts`
- Modify: `web/src/jobs/workflow-lanes.ts`
- Modify: `web/src/jobs/job-labels.ts`
- Test: `web/tests/workflow-lanes.test.ts`
- Test: `web/tests/job-workflow-presentation.test.ts`

**Interfaces:**
- Produces: `activeWorkflowPresentation`, `activeWorkflowStatusOptions`, and `ActiveWorkflowStatus` from the neutral module.
- Consumes: persisted active `JobCardStatus` values only; no `PLANNED` fallback.

- [ ] **Step 1: Write the failing ownership test**

Assert that `workflow-lanes.ts` imports the neutral model, that `job-labels.ts` derives current active labels from it, and that the exact approved labels remain:

```ts
expect(activeWorkflowStatusOptions).toEqual([
  { value: 'NEW', label: 'Hazırlanıyor' },
  { value: 'ACCEPTED', label: 'Atandı' },
  { value: 'IN_PROGRESS', label: 'Uygulanıyor' },
  { value: 'WAITING_APPROVAL', label: 'Yönetici kontrolünde' },
  { value: 'REVISION_REQUESTED', label: 'Düzeltme istendi' },
]);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd web && npm test -- --run tests/workflow-lanes.test.ts tests/job-workflow-presentation.test.ts`
Expected: FAIL because `job-status-presentation.ts` does not exist.

- [ ] **Step 3: Move the presentation constants without changing values**

Create the neutral module with a typed record and ordered options. Import it from lane and label consumers; keep `historicalJobStatusLabels` unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/workflow-lanes.test.ts tests/job-workflow-presentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/job-status-presentation.ts web/src/jobs/workflow-lanes.ts web/src/jobs/job-labels.ts web/tests/workflow-lanes.test.ts web/tests/job-workflow-presentation.test.ts
git commit -m "refactor(web): centralize job status presentation"
```

### Task 2: Render-only Ant adapters

**Files:**
- Create: `web/src/ui/antd/WorkflowSteps.tsx`
- Create: `web/src/ui/antd/RecordDescriptions.tsx`
- Create: `web/src/ui/antd/ActivityTimeline.tsx`
- Modify: `web/src/ui/antd/index.ts`
- Create: `web/tests/job-detail-antd-adapters.test.tsx`
- Modify: `web/tests/antd-boundary.test.ts`

**Interfaces:**
- Produces: `WorkflowSteps`, `RecordDescriptions`, `ActivityTimeline` and their presentation-only item types.
- Consumes: labels, states, React content, actor/time strings, and identifiers prepared by feature presenters.

- [ ] **Step 1: Write failing adapter contract tests**

Render all three adapters beneath `ServoraAntProvider`. Assert current-step semantics, visible state text, responsive Descriptions items, Timeline title/content/actor/time/reason, and absence of event handlers that could create commands.

```tsx
<WorkflowSteps
  currentPhase="EXECUTION"
  items={[{ key: 'EXECUTION', label: 'Uygulanıyor', state: 'current' }]}
/>
```

Also extend the architecture test to scan production imports and allow each primitive only in its matching owned file.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/job-detail-antd-adapters.test.tsx tests/antd-boundary.test.ts`
Expected: FAIL because adapters and exports are absent.

- [ ] **Step 3: Implement minimal adapters**

Map prepared states only:

```ts
const statusByState = {
  complete: 'finish', current: 'process', upcoming: 'wait',
  skipped: 'wait', attention: 'error',
} as const;
```

Use `Steps` with horizontal/vertical orientation from the existing `64rem` shell media contract, `Descriptions` with `{ xs: 1, lg: 2 }`, and `Timeline` with prepared items. Add Servora class names and do not re-export raw Ant primitives.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/job-detail-antd-adapters.test.tsx tests/antd-boundary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/antd web/tests/job-detail-antd-adapters.test.tsx web/tests/antd-boundary.test.ts
git commit -m "feat(web): add owned job detail adapters"
```

### Task 3: Preserve Timeline behavior through ActivityTimeline

**Files:**
- Modify: `web/src/jobs/JobTimeline.tsx`
- Modify: `web/tests/job-timeline.test.tsx`

**Interfaces:**
- Consumes: `ActivityTimelineItem[]` prepared from persisted `JobCardActivity` records.
- Preserves: `listActivity(jobId, { limit: 50, offset })`, newest-first input order, refresh reset, fallback warning, retry, and pagination.

- [ ] **Step 1: Add failing Timeline preservation tests**

Assert rendered item order by stable item markers, actor fallback `Sistem`, semantic `<time dateTime>`, transition reason, unknown-event fallback, retry, next/previous page calls, and refresh-key offset reset.

- [ ] **Step 2: Run Timeline tests and verify RED for adapter markers**

Run: `cd web && npm test -- --run tests/job-timeline.test.tsx`
Expected: FAIL because `JobTimeline` still renders its native ordered list.

- [ ] **Step 3: Prepare adapter items inside JobTimeline**

Keep fetching and state locally. Convert each persisted record without reordering:

```ts
const items = state.page.items.map((activity) => ({
  key: activity.id,
  action: jobActivityLabel(activity.eventType),
  detail: detailText(activity.details),
  reason: transitionReason(activity.details),
  actor: activity.actor?.name ?? 'Sistem',
  occurredAt: activity.createdAt,
  occurredAtLabel: formatInstant(activity.createdAt),
}));
```

Pass the array to `ActivityTimeline`; retain loading/error/empty/pagination DOM outside it.

- [ ] **Step 4: Run Timeline and adapter tests and verify GREEN**

Run: `cd web && npm test -- --run tests/job-timeline.test.tsx tests/job-detail-antd-adapters.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/JobTimeline.tsx web/tests/job-timeline.test.tsx
git commit -m "feat(web): adapt persisted job activity timeline"
```

### Task 4: Extend presentation facts and state panels

**Files:**
- Modify: `web/src/jobs/job-workflow-presentation.ts`
- Modify: `web/src/jobs/JobWorkflowPanels.tsx`
- Modify: `web/src/jobs/JobApprovalReviewPanel.tsx`
- Create: `web/src/jobs/JobDecisionPanel.tsx`
- Test: `web/tests/job-workflow-presentation.test.ts`
- Test: `web/tests/job-detail.test.tsx`
- Test: `web/tests/manager-review.test.tsx`

**Interfaces:**
- Produces: revision actor/time, completion actor/time, cancellation facts, and existing permitted transitions as presentation data.
- Consumes: only `workflowContext.lifecycle`, `submissionReadiness`, and `allowedCommands` already returned by the API.

- [ ] **Step 1: Write failing presentation and panel tests**

Cover revision reason/actor/time, completion approver/time, cancellation reason/actor/time/source status, missing source staying “Bilgi kaydedilmemiş”, and decision buttons exactly matching supplied transitions.

```ts
expect(model.revisionLoop).toMatchObject({
  reason: 'Miktarı düzeltin', actorName: 'Emrah Yönetici',
  at: '2026-07-17T10:00:00.000Z',
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/job-workflow-presentation.test.ts tests/job-detail.test.tsx tests/manager-review.test.tsx`
Expected: FAIL on absent actor/time and state-specific panel contracts.

- [ ] **Step 3: Extend the presentation builder from lifecycle facts**

Add typed facts without changing command derivation. `JobDecisionPanel` receives transitions and callbacks, renders only supplied actions, explains consequence, and never checks role/status/readiness itself. Update revision and terminal panels to consume prepared facts rather than raw lifecycle objects.

- [ ] **Step 4: Preserve dialog intents and focus restoration**

Keep `JobWorkflowDialog` unchanged. Integration tests click the new panel triggers, close with `Vazgeç` or Escape, wait for `requestAnimationFrame`, and assert `document.activeElement` is the original new trigger.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `cd web && npm test -- --run tests/job-workflow-presentation.test.ts tests/job-detail.test.tsx tests/manager-review.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/jobs/job-workflow-presentation.ts web/src/jobs/JobWorkflowPanels.tsx web/src/jobs/JobApprovalReviewPanel.tsx web/src/jobs/JobDecisionPanel.tsx web/tests/job-workflow-presentation.test.ts web/tests/job-detail.test.tsx web/tests/manager-review.test.tsx
git commit -m "feat(web): present job lifecycle responsibility"
```

### Task 5: Recompose JobDetail with Steps and Descriptions

**Files:**
- Modify: `web/src/JobDetail.tsx`
- Remove: `web/src/jobs/JobLifecycleSteps.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/manager-review.test.tsx`
- Modify: `web/tests/accessibility-contract.test.ts`

**Interfaces:**
- Consumes: `WorkflowSteps`, `RecordDescriptions`, state panels, existing commands, and unchanged dialog callbacks.
- Produces: mobile-first detail DOM with action/decision before `JobTimeline`.

- [ ] **Step 1: Write failing composition tests**

Assert title/revision/lifecycle/responsibility/facts/delivery/requirements/action/Timeline order for the three principal states. Assert COMPLETED has approval facts and no active checklist/action; CANCELLED has non-success terminal semantics. Assert summary uses the owned Descriptions adapter and current lifecycle uses owned Steps.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx tests/accessibility-contract.test.ts`
Expected: FAIL on old summary, old step list, and incomplete state ordering.

- [ ] **Step 3: Recompose JobDetailPanel**

Move revision panel directly after heading feedback, render lifecycle next, then responsibility. Replace the summary `<dl>` with `RecordDescriptions`. Group facts/type records as main content and requirements/decision as the side region while preserving DOM order. Render `ActionGroup` behavior through `JobDecisionPanel`; keep `onCommand`, `onRecordEdit`, pending state, and existing dialog ownership unchanged.

- [ ] **Step 4: Add responsive Servora styling**

Use the existing tokens and `64rem` boundary. Mobile remains one column; desktop uses a bounded main/side grid; Timeline spans below. Keep 44px controls, visible focus, no horizontal task scroll, and no custom entrance motion.

- [ ] **Step 5: Run focused tests and build**

Run: `cd web && npm test -- --run tests/job-detail.test.tsx tests/manager-review.test.tsx tests/accessibility-contract.test.ts tests/antd-boundary.test.ts`
Expected: PASS.
Run: `cd web && npm run build`
Expected: PASS with only the existing bundle-size warning.

- [ ] **Step 6: Commit**

```bash
git add web/src/JobDetail.tsx web/src/jobs/JobLifecycleSteps.tsx web/src/styles.css web/tests/job-detail.test.tsx web/tests/manager-review.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat(web): compose job detail lifecycle UI"
```

### Task 6: Durable verification and PR C record

**Files:**
- Modify: `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`
- Modify: `docs/ui/SERVORA-UI-ARCHITECTURE.md`

**Interfaces:**
- Records: exact adapter ownership, overlay deferral, test counts, bundle measurement, and responsive evidence.

- [ ] **Step 1: Update durable documentation**

Mark PR C implementation complete on its feature branch, list the three adapters, state that all overlays remain PR D, and record actual verification outputs only.

- [ ] **Step 2: Run full web verification**

```bash
cd web
npm test -- --run
npm run build
npm run smoke:responsive
```

Expected: all tests and responsive checks pass; report the measured bundle warning rather than hiding it.

- [ ] **Step 3: Run full server regression verification**

```bash
cd server
npm run build
npm test -- --run
```

Expected: build passes; 911 tests pass and the known environment-dependent tests may remain skipped if unchanged.

- [ ] **Step 4: Verify repository scope**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only PR C files changed.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/ui/SERVORA-IMPLEMENTATION-PLAN.md docs/ui/SERVORA-UI-ARCHITECTURE.md
git commit -m "docs: record job detail lifecycle verification"
```

- [ ] **Step 6: Push for review without merging**

Push `feature/job-detail-lifecycle-ui`, create a draft PR C, include exact verification results, and wait for GitHub web/server CI. Do not start PR D.
