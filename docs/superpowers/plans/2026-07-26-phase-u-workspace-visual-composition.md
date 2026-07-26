# Phase U — Workspace Visual Composition
## Dashboard, content, settings, results, and shared Ant adapters

**Status:** Proposed substantial corrective PR — reconciled 2026-07-26
**Date:** 2026-07-26
**Runs after:** U2 Calendar post-merge visual correction merge and resulting-main CI success
**Runs before:** U3 messaging and advanced analytics

---

## 1. Purpose

U1 established correct routes, data, authorization, documentation/help content, settings shells, and role-aware Overview. U2 establishes calendar domain behavior. Their first visual implementation is intentionally functional but does not yet meet the intended Servora workspace composition.

This checkpoint creates the durable visual language before U3 adds messaging and advanced analytics.

It is one substantial PR. Do not split it into separate micro-PRs for Dashboard, Docs, Help, Settings, Result, or individual adapters unless external review finds the combined diff unsafe.

---

## 2. Reference direction

Translate the information architecture of:

```text
https://demos.shadcndashboard.dev/dashboards/saas-ai
```

into Servora:

| Reference area | Servora meaning |
|---|---|
| Best Performing AI Products | staff sales/performance or completed-value performance |
| Ask AI | recent completed work or attention-required queue |
| Revenue Distribution | work-type distribution |
| main revenue chart | completion/sales trend |
| small activity widgets | upcoming calendar, recent notes, unread messages after U3 |

Remove irrelevant reference controls such as shopping cart and country flag. Preserve Servora AppShell and navigation.

---

## 3. Recommended branch and PR

```text
branch: feat/phase-u-workspace-visual-composition
PR: refactor(web): establish Servora workspace visual composition
```

Base must be exact accepted `main` after U2 Calendar post-merge visual correction merge.

---

## 4. Source-of-truth files

Replace/update in the same PR:

```text
DESIGN.md
docs/superpowers/specs/2026-07-25-phase-u-servora-workspace-design.md
docs/superpowers/plans/2026-07-25-phase-u-servora-workspace.md
docs/superpowers/specs/2026-07-26-servora-ant-visual-language.md
```

Implementation candidates:

```text
web/src/overview/OverviewPage.tsx
web/src/content/DocumentationPage.tsx
web/src/content/HelpCenterPage.tsx
web/src/settings/SettingsPages.tsx
web/src/AppRouter.tsx
web/src/AppShell.tsx
web/src/styles.css
web/src/ui/antd/
web/src/ui/servora-visual-tokens.ts
web/tests/
web/scripts/responsive-smoke.mjs
```

Use repository preflight for exact names.

---

## 5. Shared adapter work

Create only adapters justified by repeated contracts:

```text
OperationalCard.tsx
MetricStatistic.tsx
ServoraProgress.tsx
UserAvatar.tsx
IconSegmented.tsx
ContentCollapse.tsx
ContentAnchor.tsx
SettingsTabs.tsx
```

Extend/reuse:

```text
ResultState
EmptyState
LoadingSkeleton
RecordDescriptions
CompactConfirmationAction
useAppFeedback
servora-ant-theme
```

Every adapter needs focused tests and export from the owned Ant index where the repository uses one.

---

## 6. Palette and token checkpoint

The palette may change, but only systemically.

Process:

1. audit current canonical token usage and hardcoded outliers,
2. create at least two tokenized light-theme candidates,
3. render representative Overview, Calendar, Settings, Help, Job list, and Job detail fixtures,
4. compare at 390, 1024, 1440 and 200% text,
5. verify contrast and semantic distinction,
6. select one candidate through external visual review,
7. update canonical tokens first,
8. update Ant theme mapping from those tokens,
9. prohibit feature-level replacement colors.

Required token families:

```text
canvas
paper/container
muted surface
border/rule
primary/focus
text/muted text
information
success
warning
error
card default
card selected
card new
card upcoming
card attention
card overdue
chart categorical series
```

Do not introduce dark mode in this checkpoint unless separately authorized.

---

## 7. Overview/dashboard redesign

### 7.1 Shared structure

```text
contextual greeting + period/view control
→ four primary MetricStatistic cards
→ main trend/operational chart
→ upcoming calendar or attention queue
→ recent completed work
→ recent notes
→ unread messages placeholder omitted until U3
```

Requirements:

- role-specific composition,
- no more than four primary metrics,
- real deep links,
- bounded lists,
- no client-side authorization filtering,
- no fake AI wording,
- responsive DOM order,
- LoadingSkeleton / ResultState / EmptyState.

### 7.2 Staff dashboard

Candidates:

- open/today's work,
- in progress,
- revision requested,
- completed period,
- upcoming work,
- recent completed jobs,
- recent authorized notes.

Use upcoming/new/attention OperationalCard tones where semantically true.

### 7.3 Manager/admin dashboard

Candidates:

- active,
- overdue,
- awaiting approval,
- revision requested,
- completion trend,
- approval attention queue,
- upcoming team work,
- recent completed work,
- recent notes.

Advanced staff performance, work-type distribution, workload, and messages remain U3 unless already present and explicitly accepted without domain expansion.

### 7.4 Period/view controls

Use IconSegmented for real choices such as:

```text
Bugün / 7 gün / 30 gün
```

Do not add controls that the API cannot honor. Icon-only display is optional and must retain accessible names.

---

## 8. Documentation redesign

Implement:

- search/filter,
- category navigation,
- active article view,
- ContentAnchor for long sections,
- ContentCollapse for concise guides/FAQs,
- version/date/audience metadata,
- full legal-document reading mode,
- ResultState for unavailable/forbidden content.

Do not invent legal/KVKK text.

---

## 9. Help Center redesign

Implement:

- clear search prompt,
- common issue categories,
- Collapse articles,
- Alert for security/privacy warnings,
- Steps only for genuinely ordered troubleshooting,
- support-contact Card from safe runtime configuration,
- distinction between support and operational messages.

---

## 10. Profile and Settings redesign

Implement:

- route-aware SettingsTabs,
- UserAvatar with initials fallback,
- meaningful Badge only when backed by data,
- RecordDescriptions for account facts,
- Cards for Profile/Security/Notifications groups,
- ResultState for unsupported or forbidden settings,
- existing password and Web Push behavior unchanged.

Avatar upload remains deferred unless a separately accepted storage/security capability exists.

---

## 11. Result-state adoption

Use existing ResultState for:

```text
403
404
500
blocking load error
successful completed flow
warning/info endpoint
```

Candidate routes/surfaces:

- AppRouter ForbiddenView,
- NotFoundView,
- capability-disabled destination where a route is directly opened,
- completed task/job flow when a clear endpoint is appropriate,
- settings unsupported state.

Do not hide authoritative Job detail/timeline after completion.

---

## 12. Progress and feedback

### Progress

Use only for real measured progress or known percentage. Candidate uses:

- file upload when supported,
- import/export when measured,
- bounded task completion percentage only if the domain owns it.

Do not convert lifecycle Steps into a fake percentage.

### Notification progress

Through `useAppFeedback`, transient informational notifications may use:

```text
showProgress: true
pauseOnHover: true
```

The bar is auto-close duration, not operation progress. Persistent/decision-required feedback must remain visible or live in page state.

### Popconfirm

Use existing CompactConfirmationAction for short no-input confirmation. Use ReasonDialog/ConfirmationAction for reason-required or complex actions.

---

## 13. AppShell refinements

Allowed:

- UserAvatar in account area,
- unread Badge when real messaging data exists (U3),
- clearer Support section for Documentation/Help,
- remove irrelevant reference-demo controls,
- icon and label consistency.

Not allowed:

- rewrite to Ant Layout/Menu,
- duplicate desktop/mobile navigation models,
- speculative online presence,
- navigation authorization changes.

---

## 14. Performance acceptance

- preserve lazy routes,
- raw Ant imports only in adapters,
- no new UI framework,
- full bundle report and chunk delta,
- all chunks within existing budget,
- bounded Card/list rendering,
- no duplicate hidden responsive trees,
- no measured regression in initial Overview/Calendar interaction,
- no broad dependency update.

Expanded Ant use is not rejected solely due to component count.

---

## 15. Test plan

Focused tests:

- owned import boundary,
- OperationalCard tone semantics,
- MetricStatistic links/labels,
- UserAvatar fallback/Badge semantics,
- IconSegmented accessible labels and keyboard behavior,
- ResultState route adoption,
- Notification timeout-progress semantics,
- docs/help search and Collapse,
- settings Tabs/Descriptions,
- staff/manager Overview privacy and composition,
- responsive CSS contracts,
- palette/token contract and no hardcoded drift.

Full web suite, build, bundle, audit, and responsive smoke remain required.

---

## 16. Browser matrix

```text
staff-overview-390
staff-overview-1024
staff-overview-1440
manager-overview-390
manager-overview-1024
manager-overview-1440
overview-loading
overview-empty
overview-error
documentation-390
documentation-1024
help-390
help-1024
settings-profile-390
settings-profile-1024
settings-security
403
404
completed-result
notification-progress
200-percent-text
```

Verify focus, console, network, overflow, role leakage, and synthetic-data safety.

---

## 17. Validation

```bash
cd web
npm test -- --run
npm run build
npm run bundle:check
npm run audit:high
npm run smoke:responsive
```

Boundary checks, `git diff --check`, clean worktree, independent review, visual verification, and handoff are mandatory.

---

## 18. Explicit non-work

- no messaging database/API,
- no U3 advanced analytics,
- no calendar schema/reminder changes,
- no server domain changes unless a concrete existing Overview correctness bug is separately accepted,
- no Tailwind/shadcn,
- no AppShell Ant Layout/Menu rewrite,
- no mass Ant Form migration,
- no dark mode,
- no T5 application-wide state sweep,
- no staging/production.

---

## 19. Gates

```text
Workspace Visual Composition planning:
COMPLETE

Current checkpoint:
Phase U Ant visual documentation reconciliation

Implementation:
NOT AUTHORIZED until Calendar corrective merge and resulting-main CI

PR Ready:
NOT AUTHORIZED by this plan

PR Merge:
NOT AUTHORIZED by this plan

U3:
NOT AUTHORIZED until this PR merge, resulting-main CI, and external visual approval

T5:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```
