# Phase T — Visual Consistency and Screen Polish

> **For agents:** No Ant foundation work. Execute **T0 → T5** in order. **Defect preflight** only for true P0/P1 regressions, each as its own narrow PR (does not replace T1). Skills: `executing-plans` / `subagent-driven-development`.

**Goal:** Improve visual quality, cross-screen consistency, and screen fidelity on the completed Ant/Servora stack.

**Design SSOT:** `docs/superpowers/specs/2026-07-23-phase-t-visual-polish-design.md`
**Visual SSOT:** root `DESIGN.md`
**Architecture SSOT:** `docs/ui/SERVORA-UI-ARCHITECTURE.md`
**Screen composition SSOT:** `docs/ui/SERVORA-SCREEN-SPECS.md`
**Prior Ant closeout:** `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md` (PR A–M complete)
**Code baseline:** `main` @ `e96aaeacce6094c4e36e25e794c55834d7e7f029`
**Docs branch (T0):** `docs/phase-t-visual-polish`

**Stack:** React 19, Vite, TypeScript, Ant Design `6.5.1` (exact pin), Vitest, existing responsive smoke.

Phase T mevcut Ant/Servora mimarisi üzerinde görsel tutarlılık ve ekran iyileştirmesidir. Toplu Ant migration veya default Ant admin görünümü bu fazın hedefi değildir.

---

## Status snapshot

```text
Ant Design foundation: COMPLETE
Ant runtime migration chain: COMPLETE
Optional Ant backlog A–M: COMPLETE
Ant evaluation/spike: NOT NEEDED

Phase T — Visual Consistency and Screen Polish
T0 audit/docs/baseline: COMPLETE
T1 token and shared language: COMPLETE
  T1A semantic token contract + Ant bridge: COMPLETE
  T1B shared typography/control/surface adoption: COMPLETE
T2 AppShell and navigation polish: COMPLETE
  T2A desktop shell hierarchy / workspace: COMPLETE
  T2B mobile chrome / drawer: COMPLETE
  T2C notification shell polish + closeout: COMPLETE
T3 Jobs and JobDetail polish: COMPLETE
  T3A Jobs workspace / filters / state surfaces: COMPLETE
  T3B Job list rows / action hierarchy: COMPLETE
  T3C Job board lanes / responsive geometry: COMPLETE
  T3D JobDetail information / workflow hierarchy: COMPLETE
  T3E Decisions / notes / timeline / T3 closeout: COMPLETE
T4 CRM/product/staff/forms polish: IMPLEMENTATION COMPLETE / INTEGRATION PENDING
T4A Operational create form chrome: COMPLETE (integrated into main)
T4B CRM customer and contact surfaces: COMPLETE (integrated into main)
T4C Product, staff/user and T4 closeout: IMPLEMENTATION COMPLETE (Draft PR pending)
T5 states and visual regression: NOT STARTED

P0 defect track:
RecordDescriptions container reflow: COMPLETE

ACTION_SCOPED_GEOLOCATION: false (unchanged)
```

---

## Global constraints

- Do **not** rebuild Ant provider, re-pin unless security requires, or adopt Layout/Menu/Card/Form/Table wholesale
- Do **not** enable production geolocation
- Do **not** implement deferred product gates (drag/drop, dark mode, Geciken lane, Ayarlar, chart library)
- Feature code imports only `web/src/ui/antd` + Servora UI — never raw `antd`
- No domain/API/migration changes in polish PRs
- Turkish UX copy; English identifiers and commits
- Every code slice: `cd web && npm test -- --run`, `npm run build`; geometry changes also `npm run smoke:responsive`

---

## Delivery structure

```text
Defect preflight — only true P0/P1 regressions (layout, overflow, a11y, interaction)
T0  Audit, official doc debt, screenshot baseline, this plan   [COMPLETE]
T1  Token and shared visual language
T2  AppShell and navigation polish
T3  Jobs workspace and JobDetail
T4  CRM, product, staff/user + create/edit form standardization
T5  States + visual regression matrix (closeout)
```

Prefer **one PR per slice** (or one PR per defect). Do not mix T0 docs with runtime fixes. Do not mix T1 token sweeps with T4 CRM refactors.

---

## T0 — Audit, doc debt, baseline (docs + evidence)

**Status:** COMPLETE
**Goal:** Repository truth matches reality: Ant chain complete; Phase T is the active visual program; screens have a current synthetic baseline.

### Checklist

- [x] Confirm Ant A–M complete; evaluation spike unnecessary
- [x] Inventory Ant adapters, Servora primitives, legacy CSS, post–A–M product surfaces
- [x] Record P0 Descriptions container reflow and dual empty/error dialect
- [x] Align Phase T name and official T0–T5 + defect-preflight order
- [x] Update `SERVORA-IMPLEMENTATION-PLAN.md` status + Phase T pointer + post-closeout UI inventory
- [x] Update `SERVORA-UI-ARCHITECTURE.md` for A–M complete + Phase T
- [x] Update `SERVORA-SCREEN-SPECS.md` (composition accepted; fidelity via Phase T)
- [x] Commit Phase T baseline under `docs/ui/screenshots/phase-t-baseline/` (synthetic; `jobs-390.png` optional)

### Baseline set (committed)

| File | Viewport | Surface | Role | Notes |
| --- | --- | --- | --- | --- |
| `jobs-1024.png` | 1024 | `/jobs` workspace | STAFF | Desktop mid + sidebar |
| `jobs-1440.png` | 1440 | `/jobs` workspace | STAFF | Wide list density |
| `job-detail-1024.png` | 1024 | Job detail | STAFF | **P0 defect visible** |
| `job-detail-390.png` | 390 | Job detail | STAFF | Compact long scroll |
| `meeting-create-390.png` | 390 | Meeting create | STAFF | Create form + mobile chrome |

Full per-file metadata: `docs/ui/screenshots/phase-t-baseline/README.md`.

### Explicit non-work in T0

- No application/runtime code
- No Ant re-foundation
- No P0 fix in the same commit/PR as T0

---

## Defect preflight — RecordDescriptions container reflow (P0)

**Status:** COMPLETE
**Branch:** `fix/web-record-descriptions-reflow`
**PR title:** `fix(web): make record descriptions container-responsive`

### Root cause

```text
viewport >= 64rem → adapter set column = 2
real container (sidebar + padding + nested grid) may be < ~640px
→ crushed / glyph-stacked Descriptions cells
```

### Fix shipped

- Viewport `matchMedia` column decision removed from `RecordDescriptions`
- Host wrapper + `ResizeObserver`; threshold `RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX = 640`
- Safe `column=1` before measure / without ResizeObserver
- `wide` span only when `columns === 2`
- Boundary preserved: Ant Descriptions → owned adapter → JobDetail
- Evidence: `docs/ui/screenshots/phase-t-p0/`

### Done when

- [x] Focused + JobDetail regression tests pass
- [x] Responsive smoke 390–1440 + text zoom
- [x] After evidence under `docs/ui/screenshots/phase-t-p0/`
- [x] This plan’s P0 status → COMPLETE

---

## T1 — Token and shared visual language

**Status:** COMPLETE

Split:

```text
T1A Semantic token contract + Ant bridge   COMPLETE
T1B Shared typography/control/surface adoption   COMPLETE
```

### T1A — Semantic token contract + Ant bridge (COMPLETE)

- Canonical machine-readable contract: `web/src/ui/servora-visual-tokens.ts`
- CSS `:root` semantic variables (including info/success/warning soft pairs, control height, radii, `--shadow-raised`)
- `servora-ant-theme.ts` imports token contract (no remaining hex hardcodes in theme source)
- Drift + contrast + feature import boundary tests: `web/tests/visual-token-contract.test.ts`, extended `antd-boundary.test.ts`
- Feature screens still use CSS variables, not the TS token module
- Visual values intentionally preserved; no screen redesign

### T1B — Shared typography / control / surface adoption (COMPLETE)

Implementation record:

- shared control-height/radius adoption (`min-height: var(--control-height)`, form/button radii)
- focus-width CSS bridge (`--focus-width` + `:focus-visible`)
- shared heading/helper cleanup:
  - page headings grouped where values already matched
  - section: `.drawer-heading h2, .notification-center-heading h2` shared `1.125rem` contract
  - helper: `.field-hint, .form-help` shared muted/size; diverging margin/line-height kept
  - form-level error surface remains `.form-error` (`--error` / `--error-soft`)
- surface-raised canonical radius + `--shadow-raised` (only intentional visual change)
- semantic literal drift protection: exact canonical OKLCH only inside `:root`; scan covers stylesheet **before and after** `:root` (`outsideRoot`)
- destructive-button duplicate consolidation (single paper/outline base + hover)
- drift tests: `web/tests/shared-visual-language-contract.test.ts`

Non-work: AppShell/Jobs/CRM redesign, spacing sweep, Ant Form, feature TSX.

---

## T2 — AppShell and navigation polish

**Status:** COMPLETE

```text
T2A Desktop shell hierarchy and workspace frame   COMPLETE
T2B Mobile chrome and navigation drawer           COMPLETE
T2C Notification Center visual polish + closeout  COMPLETE (this PR)
T2 overall                                        COMPLETE
```

No Ant Layout/Menu; no Ayarlar page.

### T2A — Desktop shell hierarchy and workspace frame (COMPLETE)

Implementation record:

- sidebar brand / nav / account-footer density zones (`shell-sidebar-brand`, `shell-sidebar-footer`)
- section + destination hierarchy; active item uses accent soft + **weight** (not color alone)
- long Turkish nav/account labels: `overflow-wrap: anywhere` (**sidebar-scoped**)
- account block: name/role/logout preserved; logout secondary weight; pending copy unchanged
- desktop canvas shell vs paper content frame; workspace max remains `68rem` (board gates untouched)
- **scope isolation:** shared `.shell-nav` / `.shell-account` baseline preserved for mobile drawer; T2A gap/radius/weight/wrap under `.shell-sidebar` only (`@media (min-width: 64rem)`)
- navigation model, routes, roles, mobile chrome, notifications: unchanged

### T2B — Mobile chrome and navigation drawer (COMPLETE)

Implementation record:

- mobile top bar: safe-area top, balanced zones, title ellipsis, brand/back/menu/notification targets preserved
- bottom nav: active + expanded menu weight channel (`font-weight: 760`), label wrap, safe-area bottom
- sticky create: jobs-list-only unchanged; bottom offset remains clear of bottom nav
- drawer visual only: paper surface, safe-area **top/left/bottom** padding, heading/account separation, drawer-scoped nav wrap
- shared `.shell-nav` / `.shell-account` baseline and T2A sidebar-scoped polish preserved
- drawer interaction: Escape/backdrop/focus trap/restore/body lock unchanged
- responsive smoke: mobile chrome geometry (menu/title/actions/bottom-nav/sticky) on 390 + 200% text zoom

### T2C — Notification Center visual polish + T2 closeout (COMPLETE)

Implementation record:

- notification trigger/badge hierarchy (absolute badge, 44px target, chip radius token)
- desktop raised-panel token adoption (`--radius-raised`, `--shadow-raised`)
- mobile safe-area and reflow (top/right/bottom)
- read/unread row distinction (leading marker + weight + Okundu/Okunmadı copy)
- panel-specific state/settings visual hierarchy
- responsive geometry contracts (390/1024/1440 + 200% text)
- vertical scroll reachability: short 390×600 + long list forces `scrollHeight > clientHeight`; last action (`.notification-center-more`) reachable after `scrollTop = scrollHeight`
- synthetic T2 visual evidence under `docs/ui/screenshots/phase-t-t2/`

Non-work: Notification API/SSE/Web Push behavior, AppShell/nav redesign, Jobs/board (T3), global state system (T5).

---

## T3 — Jobs workspace and JobDetail

**Status:** COMPLETE

List/board, filters, workflow hierarchy, notes/timeline, approval/revision, Jobs empty/error dialect. Deliver as five narrow PRs: T3A–T3E. P0 is already COMPLETE.

### T3A — Jobs workspace, filters and Jobs state surfaces

**Status:** COMPLETE
**Branch:** `feat/phase-t-jobs-workspace-polish`

- Page title (`İşler` / `İşlerim`) and single primary `Yeni iş` action retained
- Quick views form a clearer chip group; current view uses `aria-current` + `data-state` + weight/fill/border (not color alone)
- Manager-only approval queue visibility unchanged; URL/search-param model unchanged
- Desktop filters use flat toolbar surface (no raised card-in-card); mobile FilterSheet path unchanged
- Active filter count / clear-apply / UUID validation copy unchanged
- Jobs list + board loading / empty / filtered-empty / forbidden / retryable error use owned `LoadingSkeleton` / `EmptyState` / `ResultState` adapters without global T5 migration

Non-work for T3A: JobRow density (T3B), board lanes (T3C), JobDetail (T3D/E), API/permissions, AppShell, Notification Center.

### T3B — Job list rows and action hierarchy

**Status:** COMPLETE
**Branch:** `feat/phase-t-job-list-polish`

- Scannable information order: title → type → customer/contact → workflow → status/priority metadata → facts → actions
- Desktop rows stay flat (rule + spacing; no raised per-row shadow)
- Title stronger than metadata; status/priority not color-only (existing chips)
- Long Turkish title/customer/assignee wrap safely; schedule uses tabular numerals
- Mobile single-column card layout and ≥ control-height action targets retained
- Full-row title hit target coexists with z-indexed row commands (no click collision)
- Only the owned primary open command uses primary button styling; other open commands stay secondary
- Command set/order/ownership/`allowedCommands` derivation unchanged; no new lifecycle actions

Non-work for T3B: board lanes (T3C), JobDetail (T3D/E), API/permissions, AppShell, Notification Center.

### T3C — Job board lanes and responsive geometry

**Status:** COMPLETE
**Branch:** `feat/phase-t-job-board-polish`

- Lane heading exposes status label, count chip, and `Tümünü gör` (≥ control-height target)
- Empty lanes use quieter dashed surface (not card-weight)
- Preview remains max four cards; backend count preserved; closed counts unchanged
- Role-based lane ordering via `workflowLanesFor` unchanged
- Usable-width container query + 64rem/68rem/90rem gates preserved (no five equal columns at 1024+sidebar)
- No page-level horizontal board scroll; compact stacks vertically; no drag-and-drop

Non-work for T3C: JobDetail (T3D/E), API/permissions, AppShell, Notification Center, drag-drop, Geciken lane.

### T3D — JobDetail information and workflow hierarchy

**Status:** COMPLETE
**Branch:** `feat/phase-t-job-detail-hierarchy`

- Accessible DOM order: heading → feedback → lifecycle → revision|terminal|responsibility → facts → type content → management-review → actions/notes → timeline
- Revision loop renders **after** WorkflowSteps (lifecycle-first); terminal after lifecycle; responsibility only when non-terminal
- Manager review: `data-job-detail-section="management-review"` after record-facts + type blocks, before decision actions
- Type eyebrow low emphasis; title primary; Listeye dön secondary; status/priority meta in heading
- Responsibility / revision / terminal / requirements share `job-workflow-panel` grammar
- RecordDescriptions P0 container-responsive behavior unchanged; delivery flat rule-list
- DOM-order tests cover staff normal, revision, terminal, manager waiting-approval, delivery/records blocks, notes-only

Non-work for T3D: decision panel visual polish (T3E), notes/timeline API, manager reason dialogs, AppShell, server.

---

### T3E — Decisions, notes, timeline and T3 closeout

**Status:** COMPLETE
**Branch:** `feat/phase-t-job-detail-decisions-closeout`
**PR:** #64 (Draft)

- Decision and approval hierarchy: primary → secondary → CANCEL destructive presentation only; record-edit separated after lifecycle divider
- Manager approval review: `surface-raised` + section heading; instruction emphasis; DOM before decision actions
- Revision grammar: lifecycle / expected-role / next-action hooks; long reason wrap
- Terminal/cancelled: neutral surface; single-column facts; not error-styled completion
- Notes hierarchy: `.job-note-body` / `.job-note-meta` wrap contracts; API/clientActionId unchanged
- Timeline hierarchy: activity class hooks; location privacy preserved; full-width desktop
- Responsive/accessibility contracts expanded in tests
- Browser verification: Playwright synthetic fixtures + `npm run smoke:responsive`
- Synthetic screenshot evidence: `docs/ui/screenshots/phase-t-t3/`
- T3E-3 closeout:
  - Exact-head: `57a43c78` (local = remote)
  - Full local validation: 865 tests PASS (85 files), build PASS, smoke:responsive PASS
  - Independent review: PASS (no scope creep, no server/API changes, no SSE/notification changes)
  - Browser verification: CONDITIONAL PASS (pre-existing step label wrap at 1024px — not a T3E regression)
  - Console/network: clean
  - Screenshot evidence: 11 synthetic PII-free captures across all T3 states/viewports
  - PR #64 body finalized with factual summary

Non-work for T3E: server / permissions / allowedCommands, notes/timeline API/SSE, AppShell, Notification Center, T4 forms, T5 global states.

T3 overall: **COMPLETE** after this closeout lands on main.

---

## T4 — CRM, product, staff/user + forms

**Status:** COMPLETE (IMPLEMENTATION) / INTEGRATION PENDING

### T4A — Operational create form chrome (COMPLETE — integrated into main)

Shared action-footer contract: Cancel secondary first, Submit primary second in DOM and visual order. Desktop content-width flex-end; compact scoped column. Landed on main as PR #66.

### T4B — CRM customer and contact surfaces (COMPLETE — integrated into main)

Customer-create form adopts T4A `create-heading` + `form-actions` contract. Cancel button removed from heading (duplicate). Customer-edit and contact-edit forms gain `form-actions` wrapper with Cancel before Save. Contact-create form `inline-record-form .form-actions` uses column (not column-reverse) at compact width. Landed on main as PR #67.

### T4C — Product, staff/user and T4 implementation closeout (IMPLEMENTATION COMPLETE — Draft PR)

**Product list/detail/create/edit polish:**
- `ProductForm` gains `useCreateHeading` prop; create route uses `create-heading` (T4 contract), edit route keeps `detail-heading`
- Product row responsive: single-column layout at ≤47rem; long names/metadata use `overflow-wrap: anywhere`
- Product detail heading uses `overflow-wrap: anywhere` for long product names
- Product create/edit `form-actions` already T4-compliant (İptal before Submit/Save)

**ProductSelect polish:**
- No behavior changes; search, selection, pagination, request gates unchanged
- CSS wrap protection for product names and metadata in select list

**Staff directory/own/managed profile polish:**
- `StaffProfileEditView`: `Listeye dön` moved from heading to `form-actions` footer (before `Profili kaydet`)
- `Operasyon raporunu aç` stays as heading action
- No duplicate `Listeye dön`; exactly one form-actions region
- `people-actions` gains `flex-wrap: wrap` for narrow viewports
- People row metadata uses `overflow-wrap: anywhere`

**User list/create/detail polish:**
- `UserCreateForm`: `Vazgeç` removed from heading, moved to `form-actions` footer; heading uses `create-heading` class
- User list heading and row identity preserved
- User detail sections remain separate; security commands unchanged
- User detail heading uses `overflow-wrap: anywhere`

**T4 form-contract adoption:**
- Product create/edit, Staff edit, User create all follow T4 contract: Cancel/Vazgeç secondary before primary submit
- Compact form-actions use explicit scoped column (not column-reverse)
- `create-heading` used for create routes, `detail-heading` for detail/edit routes

**Behavior/API/security invariants preserved:**
- Product API calls, payloads, delete rules unchanged
- ProductSelect request-gate and pagination semantics unchanged
- Staff editable-field and role boundaries unchanged
- User role/password/security operations unchanged
- No global state migration, no raw Ant imports, no token boundary leaks

**Focused validation:** 6 files, 53 tests PASS (baseline 48, delta +5)
**Full validation:** 86 files, 981 tests PASS (baseline 981, delta 0 — existing tests preserved)
**Cross-cutting:** 6 files, 78 tests PASS
**Build:** SUCCESS | **Audit:** PASS | **Bundle:** PASS | **Smoke:** PASS

**Browser verification:** PERFORMED — 11/11 surfaces PASS (Playwright + Chromium, synthetic data, admin + staff roles). All surfaces verified at 390px and/or 1024px viewports with zero console errors, zero horizontal overflow.
**Evidence:** `docs/ui/screenshots/phase-t-t4c/README.md` (verification matrix)
**Draft PR:** PENDING

**Known limitations:**
- Product list compact row treatment and form-actions column verified via CSS contract tests only
- ProductSelect long-name wrap verified via CSS contract only
- User detail section hierarchy unchanged from baseline

### T4 — CRM / product / people / forms (overall)

IMPLEMENTATION COMPLETE / INTEGRATION PENDING

T4A (form chrome): integrated into main
T4B (CRM): integrated into main  
T4C (product/people): implementation complete, PR pending

---

## T5 — States and visual regression (closeout)

**Status:** NOT STARTED

Loading/empty/error/success; 390–1440; 200% text / 400% reflow; screenshot matrix; implementation-plan closeout note.

---

## Progress tracker

| ID | Slice | Status |
| --- | --- | --- |
| T0 | Audit + docs + baseline | **COMPLETE** |
| P0 | RecordDescriptions container reflow | **COMPLETE** |
| T1A | Semantic token contract + Ant bridge | **COMPLETE** |
| T1B | Shared typography/control/surface adoption | **COMPLETE** |
| T1 | Tokens / visual language (overall) | **COMPLETE** |
| T2A | Desktop shell hierarchy / workspace | **COMPLETE** |
| T2B | Mobile chrome / drawer | **COMPLETE** |
| T2C | Notification shell polish + T2 evidence | **COMPLETE** |
| T2 | AppShell / nav (overall) | **COMPLETE** |
| T3A | Jobs workspace / filters / states | **COMPLETE** |
| T3B | Job list rows / actions | **COMPLETE** |
| T3C | Job board lanes / geometry | **COMPLETE** |
| T3D | JobDetail hierarchy | **COMPLETE** |
| T3E | Decisions / notes / timeline / closeout | **COMPLETE** |
| T3E-2A | Revision / terminal grammar + feedback checkpoint | COMPLETE |
| T3E-2B | Notes + Timeline visual hierarchy contract | COMPLETE |
| T3E-3 | Visual evidence / final closeout | COMPLETE |
| T3 | Jobs + JobDetail (overall) | **COMPLETE** |
| T4A | Operational create form chrome | COMPLETE |
| T4B | CRM customer and contact surfaces | COMPLETE — integrated into main |
| T4C | Product, staff/user and T4 implementation closeout | IMPLEMENTATION COMPLETE — Draft PR pending |
| T4 | CRM / product / people / forms | IMPLEMENTATION COMPLETE / INTEGRATION PENDING |
| T5 | States + regression closeout | NOT STARTED |

---

## Verification matrix

| Check | When |
| --- | --- |
| Docs-only review + `git diff --check` | T0 |
| `cd web && npm test -- --run` | Every code PR |
| `cd web && npm run build` | Every code PR |
| `cd web && npm run smoke:responsive` | Geometry / layout slices |
| Ant boundary tests | Always; no raw feature `antd` |
| Server build/test | Only if server touched (must not be for Phase T polish) |

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Token pass becomes redesign | Limit T1 to contracts; screen content in T2–T4 |
| JobDetail mega-diff | Surgical sections; P0 adapter-first |
| Screenshot PII | Synthetic data only; README confirms |
| Scope creep into deferred gates | Hard list in design §8 |
| Mixing T0 docs with runtime fix | Separate PRs |

---

## Relationship to later work

| Work | Relation |
| --- | --- |
| P0 RecordDescriptions fix | Defect preflight after T0 merge |
| T1 token language | First polish implementation after P0 or in parallel only if no file conflict |
| Geolocation Console / controlled egress | Ops; not Phase T |
| Production geolocation enablement | Policy gates; not Phase T |
| Phase U assisted address entry | Soft-depends on stable form contracts from T1/T4 |

---

## Suggested commit sequence

1. **T0** docs + baseline (`docs/phase-t-visual-polish`) — this closeout
2. **P0** RecordDescriptions container-responsive (`fix/web-record-descriptions-reflow`)
3. T1 tokens
4. T2 shell
5. T3 jobs
6. T4 CRM/forms
7. T5 closeout
