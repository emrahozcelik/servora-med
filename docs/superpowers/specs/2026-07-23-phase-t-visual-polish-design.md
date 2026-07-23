# Phase T — Visual Consistency and Screen Polish (Design)

**Status:** T0 COMPLETE — audit, official doc alignment, and synthetic screenshot baseline
**Name:** Phase T — Visual Consistency and Screen Polish
**Code baseline:** `main` @ `e96aaeacce6094c4e36e25e794c55834d7e7f029` (post PR #51)
**Docs branch:** `docs/phase-t-visual-polish`
**Date:** 2026-07-23
**SSOT:** root `DESIGN.md`, `docs/ui/SERVORA-UI-ARCHITECTURE.md`, `docs/ui/SERVORA-SCREEN-SPECS.md`
**Plan:** `docs/superpowers/plans/2026-07-23-phase-t-visual-polish.md`

---

## 1. Program position (current truth)

```text
Ant Design foundation: COMPLETE
Ant runtime migration chain: COMPLETE
Optional Ant backlog A–M: COMPLETE
Ant evaluation/spike: NOT NEEDED

Phase T — Visual Consistency and Screen Polish
T0 audit/docs/baseline: COMPLETE
T1 token and shared language: NOT STARTED
T2 AppShell and navigation polish: NOT STARTED
T3 Jobs and JobDetail polish: NOT STARTED
T4 CRM/product/staff/forms polish: NOT STARTED
T5 states and visual regression: NOT STARTED

P0 defect track:
RecordDescriptions container reflow: OPEN
```

Phase T mevcut Ant/Servora mimarisi üzerinde görsel tutarlılık ve ekran iyileştirmesidir. Toplu Ant migration veya default Ant admin görünümü bu fazın hedefi değildir.

Ant Design is **not** Servora-Med’s design system. It is a mature primitive provider behind owned adapters:

```text
Ant primitive
  → Servora-owned adapter (web/src/ui/antd/*)
  → feature screen
```

DESIGN.md remains visual SSOT. Servora keeps AppShell, navigation, JobCard surfaces, chips, form/button contracts, and responsive rules. Explicitly rejected (unchanged from architecture):

- Ant `Layout` shell rebuild
- Ant `Menu` navigation replacement
- wrapping every surface in `Card`
- mass conversion of all inputs/buttons/forms to Ant
- default Ant blue admin-panel look

---

## 2. Purpose of Phase T

Raise **visual quality, cross-screen consistency, and screen fidelity** on the already-complete Ant/Servora stack.

Phase T is **not**:

- a second Ant adoption program
- reopening PR A–M decisions
- production geolocation enablement
- deferred product gates (drag/drop, dark mode, synthetic Geciken lane, Ayarlar, chart library)

---

## 3. Delivery shape

```text
Defect preflight — only true P0/P1 regressions (layout, overflow, a11y, interaction)
T0 — audit, docs, baseline
T1 — token and shared visual language
T2 — AppShell and navigation
T3 — Jobs and JobDetail
T4 — CRM, product, staff, and forms
T5 — state standard and visual regression
```

| Slice | Focus | Type |
| --- | --- | --- |
| **T0** | Audit, doc debt, screenshot baseline, plan | Docs + evidence — **COMPLETE** |
| **T1** | Token and shared visual language | CSS / contracts |
| **T2** | AppShell and navigation polish | Shell chrome |
| **T3** | Jobs workspace + JobDetail | Highest daily path |
| **T4** | CRM, products, staff/users + create/edit forms | Secondary daily path |
| **T5** | Loading/empty/error/success + visual regression matrix | Closeout |

### Defect preflight rules

Defect preflight:

- Does **not** replace T1 token work
- Is **not** a general polish backlog
- Accepts only broken layout, overflow, accessibility, or interaction regressions
- Each defect ships as its **own narrow PR**

### Open P0 — RecordDescriptions container reflow

**Status:** OPEN
**Evidence:** `docs/ui/screenshots/phase-t-baseline/job-detail-1024.png`

Known presentation defect: Job detail `RecordDescriptions` can force two columns from viewport media while the real content container is narrower (AppShell sidebar + padding + nested grid), producing crushed or glyph-stacked text.

Fix direction (separate runtime PR after T0 merge):

- Drop viewport `matchMedia('(min-width: 64rem)')` as the sole column decision
- Observe adapter wrapper width (`ResizeObserver`)
- `column=1` below ~640px container width; `column=2` when wider
- Safe single-column default before measurement / without ResizeObserver
- Stay inside owned adapter; no JobDetail domain changes; no global Ant hacks

---

## 4. Inventory (T0)

### 4.1 Owned Ant adapters (`web/src/ui/antd/`)

| Adapter | Ant primitive | Notes |
| --- | --- | --- |
| `ServoraAntProvider` | ConfigProvider + App | `servora-ant` prefix, tr_TR |
| `servora-ant-theme` | ThemeConfig | DESIGN.md → sRGB bridge |
| `useAppFeedback` | App.useApp | Exported; feature adoption sparse |
| `WorkflowSteps` | Steps | Job lifecycle presentation |
| `ActivityTimeline` | Timeline | Audit history |
| `RecordDescriptions` | Descriptions | **P0 container reflow OPEN** |
| `ConfirmationAction` | Modal | Confirmations |
| `CompactConfirmationAction` | Popconfirm | Primary-contact only |
| `ReasonDialog` | Modal | Revision/cancel reasons |
| `ResponsiveDrawer` | Drawer | Job + Customer filters |
| `ResultState` / `EmptyState` / `LoadingSkeleton` | Result / Empty / Skeleton | Strong on reports; sparse elsewhere |

**antd:** exact pin `6.5.1`.
**Direct feature imports of `antd`:** none (boundary healthy at T0).

### 4.2 Servora-native UI

Shell (sidebar, mobile top/bottom, navigation model, brand), StatusChip / PriorityChip, FilterSheet, OperationalTable, form/button CSS contracts, JobCard list/board/lanes, report charts (native).

### 4.3 Legacy CSS

`web/src/styles.css` remains the primary Servora-native styling surface (~1600+ lines). Phase T tightens contracts; no wholesale rewrite; no second token system.

### 4.4 Post–A–M product surfaces (current product, not foreign)

Shipped after Ant optional closeout and in scope for Phase T polish:

```text
Dünya Dental branding ve logo yüzeyleri
Notification Center
Minimal install / Web Push settings UI
JobDetail workflow + notes + timeline yerleşimi
Görüşme/ziyaret engagement türleri
Google approximate-address attribution
Yeni müşteri ve CRM yüzeyleri
```

Also relevant: SSE client reconciliation UX; action-scoped job-start geolocation UI (flag default-off).

Do **not** classify these as legacy or out-of-phase “foreign” surfaces.

### 4.5 Dual state vocabulary (consistency debt for T3–T5)

| Dialect | Where |
| --- | --- |
| `EmptyState` / `ResultState` / `LoadingSkeleton` | Reports, some route loading |
| `workspace-message` + optional retry | Jobs, CRM, products, people, many errors |

---

## 5. Inconsistency themes (for T1+)

| Theme | Examples |
| --- | --- |
| Spacing / surface | Filter card height at 1024; mixed section padding |
| Typography | Heading rhythm vs denser create forms |
| Form contract | Vazgeç/primary placement and helper density differ |
| Descriptions density | Container vs viewport column decision (P0) |
| Empty/error dialect | Reports vs operational screens |
| Shell / brand | Largely solid; Notification Center and mobile chrome get T2 pass |

---

## 6. Screenshot baseline policy

**Historical prototypes** remain under `docs/ui/screenshots/` and `docs/ui/prototypes/`.

**Phase T baseline:** `docs/ui/screenshots/phase-t-baseline/` (see directory README for per-file metadata).

Rules:

- Synthetic user, customer, JobCard, and notes only
- No browser tokens, API keys, full coordinates, real people, localhost query tokens, or notification endpoints
- Each implementation slice adds after evidence when geometry changes
- T5 owns the full regression matrix

Minimum met at T0:

- Jobs desktop (1024 and 1440)
- Job detail 1024 with P0 visible
- Create form (meeting create 390)
- Compact/mobile (job detail 390, meeting create 390)

`jobs-390.png` is useful but not a T0 blocker when compact baselines already exist.

---

## 7. Principles

1. Surgical diffs; one slice (or one defect) per PR
2. Presentation only — backend remains authority
3. Adapters over raw Ant
4. CSS contracts before one-off styles
5. Prove on 390 / 768 / 1024 / 1440 (+ text zoom when geometry changes)
6. No mass Ant Form migration
7. Evidence over assertion
8. Critical errors stay inline; toasts never replace reason dialogs

---

## 8. Deferred (not Phase T)

- Drag and drop Kanban
- Dark mode
- Job-type distribution chart + DTO
- Chart library adoption
- Synthetic Manager “Geciken” lane
- Ayarlar destination
- Generic `ui/` extraction of report charts

Geolocation production enablement stays out of scope (`ACTION_SCOPED_GEOLOCATION_ENABLED=false`).

---

## 9. Phase T overall acceptance

- [x] Official UI docs status lines agree on Ant COMPLETE + Phase T program
- [x] Phase T screenshot baseline committed (minimum set)
- [ ] P0 Descriptions container reflow fixed and regression-guarded
- [ ] T1 shared visual language applied
- [ ] T2 shell polish recorded
- [ ] T3 Jobs + JobDetail consistency improved vs baseline
- [ ] T4 CRM/product/people forms aligned
- [ ] T5 state surfaces + responsive regression matrix green
- [ ] No new direct `antd` feature imports; geolocation flag remains false

---

## 10. Defaults for open product choices

1. Descriptions: one column when **container** &lt; ~640px; two columns when wider (not viewport-only).
2. Empty migration: Jobs + Customers in T3/T4; residual in T5.
3. Notification Center in T2: visual polish only.
