# Servora UI Implementation Plan

Status: Proposed sequence after prototype approval
Current PR: Architecture, specs, static prototypes, and screenshots only

## Entry gate

Do not begin production implementation until:

- the five required screenshots are reviewed
- desktop lane structure is approved
- mobile Staff and Manager/Admin ordering is approved
- the ACCEPTED and PLANNED documentation drift has a canonical decision
- the exact Ant Design version is selected from the then-current official release

## PR A: Ant Design foundation

Scope:

- add the pinned antd dependency
- add ConfigProvider and Ant App
- add Turkish locale
- add servoraAntTheme adapter
- add the owned web/src/ui/antd boundary
- add useAppFeedback
- add provider and token contract tests

Constraints:

- no large production screen redesign
- no Layout or Menu adoption
- no feature-level static message or modal calls
- no unreviewed direct feature-level antd imports
- preserve current shell, navigation, domain, and API contracts

Verification:

- provider renders existing application
- prefix and locale are applied
- App.useApp feedback runs under provider context
- token and contrast contracts pass
- web tests and production build pass

## PR B: App shell and workspace composition

Scope:

- refine desktop workspace surface without replacing AppShell behavior
- introduce horizontal workflow lanes
- preserve existing board API contract
- add Tümünü gör filtered navigation
- add responsive lane card count
- add role-aware mobile section ordering after approval
- preserve the existing navigation model as the only destination source

Verification:

- Staff, Manager, and Admin navigation tests
- desktop at 1440 and 1024 usable widths
- mobile at 390 and 320 CSS pixels
- 200 percent text and 400 percent reflow
- no page-level horizontal workflow scroll
- backend status filters and closed counts remain unchanged

## PR C: Job detail lifecycle UI

Scope:

- owned WorkflowSteps adapter
- responsibility panel
- owned RecordDescriptions adapter
- requirements checklist
- manager approval review
- revision presentation
- owned ActivityTimeline adapter
- terminal-state presentation

Constraints:

- consume existing JobWorkflowPresentation or its reviewed equivalent
- do not derive transition permission inside Ant adapters
- preserve mandatory manager approval
- keep revision reason visible above the fold
- keep cancellation distinct from completion

Verification:

- Staff IN_PROGRESS command coverage
- Manager WAITING_APPROVAL approval and revision coverage
- Staff REVISION_REQUESTED recovery coverage
- invalid and stale version paths
- focus, keyboard, screen-reader, and responsive checks

## PR D: Feedback and overlays

Scope:

- App.useApp based feedback
- OperationalDropdown
- mobile filter ResponsiveDrawer
- ResultState
- Empty and Skeleton standardization
- ConfirmationAction
- reason dialog adapter where inline or dedicated surfaces are unsuitable

Constraints:

- no lifecycle primary action inside Dropdown
- Popconfirm only for short, single-outcome confirmation
- reason capture never uses Popconfirm
- critical errors stay inline
- existing navigation drawer changes only after behavior parity tests

Verification:

- Escape and focus restoration
- scroll lock and portal layering
- pending action duplicate prevention
- error announcements
- reduced-motion behavior

## PR E: Reporting surfaces

Scope:

- KPI summary using Servora-native composition
- OperationalTable adapter for dense data
- mobile card/list fallback
- filter toolbar
- export affordances

Constraints:

- tables only where structured density justifies them
- no compressed desktop table on mobile
- report data remains derived from persisted backend truth

Verification:

- semantic headers and captions
- responsive alternative parity
- pagination, filtering, empty, and error states
- current report correctness tests

## PR F: Charts

Separate dependency and architecture decision.

Candidate first charts:

- completed jobs over time
- job-type distribution
- approval waiting duration

No chart package is selected by this plan. Chart accessibility, data tables, empty states, and color-independent series identification are required before adoption.

## Deferred

Drag and drop:

- optional alternative input only
- cannot bypass backend transitions
- requires keyboard alternative
- cannot silently approve or request revision

Dark mode:

- only after light theme completion
- separate token set
- contrast and chart validation

## Acceptance checklist for this planning PR

- [x] Production application code is unchanged
- [x] web/package.json and lockfiles are unchanged
- [x] Ant Design is not installed
- [x] UI architecture decision is documented
- [x] Component decision matrix is documented
- [x] Servora-native boundary is explicit
- [x] Token bridge includes proposed conversions and contrast evidence
- [x] Desktop and mobile workflow behavior is specified
- [x] Four screen concepts are prototyped across five HTML files
- [x] Five required PNG screenshots are included
- [x] Three lifecycle detail states are visibly distinct
- [x] Accessibility conditions are included for each primitive
- [x] Implementation work is split into small PRs
- [x] Backend, API, and domain contracts are unchanged
- [x] Charts, drag and drop, and dark mode remain out of scope

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Default Ant Design look overwhelms Servora | Root token adapter, owned components, visual regression review |
| Mixed component vocabulary | One adapter boundary and phased replacement only where approved |
| CSS specificity | Prefix isolation, shallow selectors, component tokens before CSS overrides |
| Portal and focus regression | Shell-level integration tests for container, z-index, Escape, restore, and scroll lock |
| Bundle growth | Pin and measure dependency in PR A; avoid Pro and Charts packages |
| Mobile reflow | Card/list alternatives, structural breakpoints, 320 and 390 pixel checks |
| Domain status confused with phase | Presentation model maps persisted facts; Ant primitives never decide workflow |
| ACCEPTED and PLANNED drift | Confirm canonical vocabulary before PR B and update durable documentation |
| Direct imports spread | Lint or architecture test after adapter boundary exists |
| Toast hides critical information | Feedback policy keeps decisions, reasons, and critical errors inline |

## Verification record for this PR

Recorded on 18 July 2026:

- npm test -- --run: 56 test files and 508 tests passed
- npm run build: TypeScript and Vite production build passed
- static prototype scan: five HTML files, local CSS only, no script or backend request
- screenshots: desktop and detail images are 1440 by 1000; mobile is 390 by 844
- production path diff: web source, server, package files, lockfiles, and DESIGN.md unchanged
- final verification: rerun immediately before commit and PR publication

Production implementation stops after this planning PR until the user approves the prototype set.
