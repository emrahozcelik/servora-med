# Servora UI Implementation Plan

Status: **PR A–F merged** — mandatory UI implementation chain complete
Current main (closeout record): `0d1ee816212da47b0932492899ba390978b07ffd`
Current phase: **Post A–F backlog** (optional / deferred / product-decision work only)

The original Ant Design foundation → shell → lifecycle → overlays → reporting table → charts sequence is finished. Remaining UI work is **not** part of that mandatory chain; it is classified under [Post A–F backlog](#post-af-backlog).

## Entry gate

The production implementation gates were satisfied before PR A:

- [x] the five required screenshots were reviewed
- [x] desktop lane structure was approved
- [x] mobile Staff and Manager/Admin ordering was approved
- [x] Ant Design `6.5.1`, the npm `latest` release on 18 July 2026, was selected after official changelog review and exact-pinned

The vocabulary gate is resolved in this planning PR: ACCEPTED is the persisted status, Atandı is its lane label, and Planlandı is a lifecycle presentation phase. PLANNED must not be reintroduced as a persisted status or compatibility fallback.

## PR A: Ant Design foundation

Implementation status: Merged through PR #19 at `3ae12fec59fc443681b34f6375600973ef036806`.

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

Completion checklist:

- [x] exact-pinned `antd` dependency
- [x] paired ConfigProvider and Ant Design App at the React root
- [x] Turkish locale and `servora-ant` prefix
- [x] canonical `servoraAntTheme` token bridge and reduced-motion policy
- [x] document-body popup policy
- [x] owned `web/src/ui/antd` boundary and `useAppFeedback`
- [x] provider, token, contrast, root-wiring, and import-boundary tests
- [x] no PR B screen, shell, navigation, domain, or API change

## PR B: App shell and workspace composition

Implementation status: Merged through PR #20 at `e5d34d17ce36ad809b7226b2e9418e248149548c`.

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

Completion checklist:

- [x] desktop sidebar groups derive from the existing role-aware navigation model
- [x] approved horizontal lane labels are isolated in a frontend presentation model
- [x] desktop uses canonical domain order; compact Staff and Manager/Admin use role-priority order
- [x] `Tümünü gör` preserves active filters, selects the lane status, switches to list, and resets offset
- [x] each lane renders no more than four response items while preserving the backend total count
- [x] responsive CSS exposes two compact, three desktop, and four wide preview cards
- [x] compact toolbar selects Liste or Pano immediately, outside the staged filter sheet
- [x] closed aggregate links and direct `view=board&status=closed` URLs canonicalize to list view
- [x] active lane, filter, chip, and summary labels derive from one presentation model while historical timeline wording stays isolated
- [x] COMPLETED/CANCELLED filters and closed counts remain outside active lanes and unchanged
- [x] exact shell boundary is compact below `64rem` and desktop at `64rem` or above
- [x] no Ant Design Layout, Menu, or Card adoption
- [x] no JobDetail, Steps, Timeline, domain, API, server, or migration change

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 59 files and 542 tests passed
- `cd web && npm run build`: passed; emitted JS was 758.27 kB raw and 224.91 kB gzip, with the existing 500 kB chunk warning
- `cd web && npm run smoke:responsive`: 390, 768, 1024, 1440, 200 percent text, and 400 percent reflow checks passed; lane previews measured 2, 2, 3, and 4 respectively with no horizontal page overflow
- `cd server && npm run build`: passed
- `cd server && npm test -- --run`: 911 passed and 29 environment-dependent tests skipped

The approved board API has exact counts only for persisted status columns. A separate Manager/Admin `Geciken` collection is therefore not synthesized from the limited lane previews: doing so would expose an incomplete count and duplicate records across lanes. Existing overdue reporting and `dueBefore` list filtering remain unchanged. Compact Manager/Admin ordering is control queue first across the five canonical active lanes.

## PR C: Job detail lifecycle UI

Implementation status: Merged through PR #21 at `e73f05644cc643e95a7bd4b22311a27cafa37c3f`.

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

Completion checklist:

- [x] owned `WorkflowSteps`, `RecordDescriptions`, and `ActivityTimeline` adapters
- [x] render-only responsibility, requirements, decision, revision, completion, and cancellation surfaces
- [x] existing `JobWorkflowPresentation`, command intents, API/domain commands, and server refresh flow preserved
- [x] existing confirmation and revision-reason dialogs preserved for PR D
- [x] dialog focus restoration targets the relocated decision trigger
- [x] persisted timeline ordering, reason, actor, time, fallback, retry, and pagination behavior preserved
- [x] compact DOM order keeps the primary lifecycle action before the Timeline
- [x] desktop detail composition begins at the canonical `64rem` shell boundary

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 60 files and 554 tests passed
- `cd web && npm run build`: passed; emitted JS was 829.95 kB raw and 246.83 kB gzip, and CSS was 64.76 kB raw and 11.38 kB gzip, with the existing 500 kB chunk warning
- `cd web && npm run smoke:responsive`: 390, 768, 1024, 1440, 200 percent text, and 400 percent reflow checks passed; JobDetail used one, one, two, two, one, and one columns respectively, without horizontal overflow and with the primary action before the Timeline; the real owned Descriptions and Timeline adapter DOM also preserved full summary width, content bounds, and Timeline rail layout
- `cd server && npm run build`: passed
- `cd server && npm test -- --run`: 911 passed and 29 environment-dependent tests skipped

## PR D: Feedback and overlays

Implementation status: Merged through PR #22 at `033d5b7935069d71e5499249af5f1a2da3516d3a`.

Design: `docs/superpowers/specs/2026-07-18-feedback-overlays-design.md`
Plan: `docs/superpowers/plans/2026-07-18-feedback-overlays.md`

Ship scope (only):

- ConfirmationAction (modal-only; Popconfirm deferred)
- ReasonDialog
- ResponsiveDrawer for existing Job and Customer filters

Out of this PR:

- ResultState, EmptyState, LoadingSkeleton, OperationalDropdown
- AppShell navigation drawer
- broad toast / useAppFeedback helper expansion

Constraints:

- adapters remain presentation/orchestration only; domain authority stays in services and presentation builders
- reason capture never uses Popconfirm
- critical errors stay inline
- ConfirmationAction does not auto-select Popconfirm
- focus restoration for migrated overlays is owned solely by the adapter
- existing navigation drawer unchanged

Verification:

- Escape and focus restoration
- scroll lock and portal layering (filters)
- pending action duplicate prevention
- reason validation announcements
- product/customer delete, job workflow dialog, and filter-sheet parity tests

Completion checklist:

- [x] owned ConfirmationAction, ReasonDialog, and ResponsiveDrawer adapters
- [x] product/customer delete and JobWorkflowDialog paths migrated
- [x] JobFilters and Customer filters use ResponsiveDrawer with FilterSheet parity
- [x] AppShell navigation drawer left unchanged
- [x] no Result/Empty/Skeleton/Dropdown adapters shipped

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 62 files and 568 tests passed
- `cd web && npm run build`: passed; JS ~829 kB raw / 246 kB gzip (existing 500 kB chunk warning)
- `cd web && npm run smoke:responsive`: 390, 768, 1024, 1440, 200% text, and 400% reflow checks passed

## PR E: Reporting surfaces

Implementation status: Merged through PR #23 at `9f2fb8984ce8104f05dd3592688ea8fa3630b106`.

Design: `docs/superpowers/specs/2026-07-18-reporting-surfaces-design.md`
Plan: `docs/superpowers/plans/2026-07-18-reporting-surfaces.md`

Approved ship:

- OperationalTable adapter
- Delivery dense report migration only
- Mobile card/list at max-width 720px (not 64rem)
- No ReportKpiSummary extraction

Constraints:

- tables only where structured density justifies them
- no compressed desktop table on mobile
- report data remains derived from persisted backend truth
- no chart package (PR F)
- adapters do not recompute report metrics
- Approval/Staff report migration out of this PR

Verification:

- semantic headers and captions
- responsive alternative parity at 720px
- pagination, filtering, empty, and error states
- current report correctness tests

Completion checklist:

- [x] owned OperationalTable
- [x] Delivery dense report migrated with mobile card alternative
- [x] existing report API/search/range tests still pass
- [x] no chart dependency / KPI extraction / Approval-Staff migration

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 63 files and 576 tests passed
- `cd web && npm run build`: passed
- `cd web && npm run smoke:responsive`: 390, 768, 1024, 1440, 200% text, and 400% reflow checks passed

## PR F: Charts

Implementation status: Merged through PR #24 at `0d1ee816212da47b0932492899ba390978b07ffd`.

Design: `docs/superpowers/specs/2026-07-18-report-charts-design.md`
Plan: `docs/superpowers/plans/2026-07-18-report-charts.md`

Approved ship:

- No chart package
- Harden existing three families only
- Job-type distribution deferred (no DTO series)
- Keep components in `web/src/reports/report-charts.tsx`

Completion checklist:

- [x] chart a11y/empty/color contracts tested for shipped surfaces
- [x] no chart dependency added
- [x] existing dashboard/approval tests still pass
- [x] package decision recorded: native keep

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 64 files and 585 tests passed
- `cd web && npm run build`: passed

## Post A–F backlog

Work below is **out of the mandatory A–F chain**. Each item needs its own design gate when it starts. Suggested optional sequence after this closeout:

| ID | Slice | Class |
| --- | --- | --- |
| PR G | UI plan closeout | Docs-only — merged via PR #25 |
| PR H | Approval report → `OperationalTable` | Optional runtime — merged via PR #26 |
| PR I | Staff report → `OperationalTable` | Optional runtime — merged via PR #27 |
| PR J | Shared Result / Empty / Skeleton adapters | Optional runtime — complete on `feature/shared-result-states`; awaiting review |

### PR H: Approval report → `OperationalTable`

Implementation status: Merged via PR #26 at `f3e3e33`.

Completion checklist:

- [x] Approval queue dense list migrated to the existing Servora-native `OperationalTable`
- [x] summary, SLA distribution, API contract, URL pagination, loading, error, retry, and empty behavior unchanged
- [x] type, job title, assignee, customer, and waiting duration preserved across desktop and mobile surfaces
- [x] JobCard title is the desktop row header and its link has a specific accessible name
- [x] real Approval view uses mobile cards at and below `720px`, desktop table above `720px`, and does not overflow
- [x] Staff report, KPI redesign, charts, backend formulas, API, and export remain out of scope

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 64 files and 587 tests passed
- `cd web && npm run build`: passed; emitted JS was 831.88 kB raw and 246.67 kB gzip, and CSS was 64.30 kB raw and 11.30 kB gzip, with the existing 500 kB chunk warning
- `cd web && npm run smoke:responsive`: 390, 720, 768, 1024, 1440, 200% text, and 400% reflow checks passed; Approval desktop/mobile field parity, title row header, accessible row link, exact `720px` switch, and no overflow were verified from the real view
- `cd server && npm run build`: passed
- `cd server && npm test -- --run`: 911 passed and 29 environment-dependent tests skipped

### PR I: Staff report → `OperationalTable`

Implementation status: Merged via PR #27 at `efeae5c`.

Completion checklist:

- [x] approved-delivery purpose and meeting-outcome dense tables migrated to the existing Servora-native `OperationalTable`
- [x] API/DTO contracts, five counters, report range, quantities, meeting counts, loading, error, retry, inactive-personnel, and empty behavior unchanged
- [x] delivery purpose and meeting outcome explicitly selected as desktop row headers with `rowHeaderKey`
- [x] every field preserved across desktop tables and mobile cards without recomputing report data
- [x] real Staff operational view uses mobile cards at and below `720px`, desktop tables above `720px`, and does not overflow with long values
- [x] KPI redesign, backend metrics/formulas, API changes, charts, export, Result/Skeleton standardization, and Popconfirm remain out of scope

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 64 files and 587 tests passed
- `cd web && npm run build`: passed; emitted JS was 831.22 kB raw and 246.65 kB gzip, and CSS was 64.30 kB raw and 11.30 kB gzip, with the existing 500 kB chunk warning
- `cd web && npm run smoke:responsive`: 390, 720, 768, 1024, 1440, 200% text, and 400% reflow checks passed; both real Staff report tables preserved desktop/mobile field parity, explicit row headers, the exact `720px` switch, and no overflow
- `cd web && npm audit --omit=dev`: passed with zero vulnerabilities
- `cd server && npm run build`: passed
- `cd server && npm test -- --run`: 911 passed and 29 environment-dependent tests skipped
- `cd server && npm audit --omit=dev`: passed with zero vulnerabilities

### PR J: Shared Result / Empty / Skeleton adapters

Implementation status: Complete on `feature/shared-result-states`; awaiting review.

Completion checklist:

- [x] owned `ResultState`, `EmptyState`, and `LoadingSkeleton` adapters added under `web/src/ui/antd`
- [x] raw Ant `Result`, `Empty`, and `Skeleton` imports restricted to their matching owned adapter files
- [x] report Dashboard, Delivery, and Approval states migrated through existing `Report*State` wrappers
- [x] Staff operational loading, retryable error, and delivery-empty states migrated without changing API calls, retry callbacks, state conditions, or report calculations
- [x] semantic heading levels, error announcement, loading live/busy state, explanatory empty copy, and existing actions preserved
- [x] real adapters verified without overflow at 390, 720, 768, 1024, and 1440 px plus 200% text and 400% reflow
- [x] Product, Customer, Job, global 403/404, success flows, Popconfirm, AppShell drawer, backend/API, and feedback migration remain out of scope

Verification record (18 July 2026):

- `cd web && npm test -- --run`: 65 files and 591 tests passed
- `cd web && npm run build`: passed; emitted JS was 870.74 kB raw and 259.79 kB gzip, and CSS was 64.93 kB raw and 11.41 kB gzip, with the existing 500 kB chunk warning
- `cd web && npm run smoke:responsive`: 390, 720, 768, 1024, 1440, 200% text, and 400% reflow checks passed; Result announcement, Empty explanation/action, Skeleton busy state, and no-overflow behavior were verified from real adapters
- `cd web && npm audit --omit=dev`: passed with zero vulnerabilities
- `cd server && npm run build`: passed
- `cd server && npm test -- --run`: 911 passed and 29 environment-dependent tests skipped
- `cd server && npm audit --omit=dev`: passed with zero vulnerabilities

### Optional (implementation when prioritised)

- Approval queue list → `OperationalTable` (720px mobile card parity; summary + SLA chart unchanged; no API change) — **PR H, merged via PR #26**
- Staff dense table → `OperationalTable` — **PR I, merged via PR #27**
- `ResultState` / shared Empty / Skeleton adapters — **PR J, complete; awaiting review**
- Popconfirm for proven low-risk, short confirmations only
- AppShell navigation drawer parity vs Ant Drawer (behavior tests first)
- Responsive smoke chart fixtures (long meter labels, segmented legend, 366-point trend)
- Bundle / code-split work for the Vite 500 kB chunk warning (measure; do not hide the limit)

### Deferred (explicit product/design gate)

- Drag and drop: optional alternative input only; cannot bypass backend transitions; keyboard alternative required; cannot silently approve or request revision
- Dark mode: only after light theme completion; separate token set; contrast and chart validation
- Job-type distribution chart: requires prepared dashboard DTO series + backend definition (not a presentation-only PR)
- Chart library adoption: only if multi-series interactive needs prove native surfaces inadequate; exact pin + bundle measurement
- Manager/Admin synthetic “Geciken” board lane: board API has no full overdue collection; keep overdue report / `dueBefore` filtering
- Settings (`Ayarlar`) destination: not in production navigation model
- Generic `ui/` extraction of report charts until cross-feature reuse is proven

### Product decision (MVP / AGENTS out of scope unless explicitly requested)

- Native mobile app
- Full warehouse / accounting modules
- e-invoice / e-archive / ERP integrations
- SMS/WhatsApp, AI features, multi-tenant SaaS
- User-defined Notion-style custom tables
- Mandatory drag/drop Kanban as primary workflow

## Historical acceptance checklist for architecture/prototype PR #18

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
| Domain status confused with phase | Presentation model maps persisted facts; keep ACCEPTED persisted, Atandı as its lane label, and Planlandı as presentation only; do not add a PLANNED fallback |
| Direct imports spread | Lint or architecture test after adapter boundary exists |
| Toast hides critical information | Feedback policy keeps decisions, reasons, and critical errors inline |

## Verification record for architecture/prototype PR #18

Recorded on 18 July 2026:

- npm test -- --run: 56 test files and 508 tests passed
- npm run build: TypeScript and Vite production build passed
- static prototype scan: five HTML files, local CSS only, no script or backend request
- screenshots: desktop and detail images are 1440 by 1000; mobile is 390 by 844
- production path diff: web source, server, package files, lockfiles, and DESIGN.md unchanged
- final verification: rerun immediately before commit and PR publication

Production implementation remained stopped after PR #18 until the user approved the prototype set; that gate is now satisfied.

## PR A verification record

Recorded on 18 July 2026 on the PR A feature branch:

- `cd web && npm test -- --run`: 58 test files and 528 tests passed
- `cd web && npm run build`: TypeScript and Vite production build passed
- `cd web && npm run smoke:responsive`: 390, 768, 1024, 1440, 200 percent text, and 400 percent reflow checks passed
- `cd server && npm run build`: passed with migrations copied
- `cd server && npm test -- --run`: 911 tests passed and 29 environment-dependent tests skipped
- production JS baseline: 496.93 kB raw and 135.04 kB gzip
- production JS with the provider foundation: 758.27 kB raw and 224.68 kB gzip
- measured Ant Design foundation delta: +261.34 kB raw and +89.64 kB gzip
- Vite reports the resulting single application chunk above its 500 kB warning threshold; the warning is retained and recorded rather than hidden by increasing the limit
- server, API, domain, shell, navigation, and feature-screen source files are unchanged
