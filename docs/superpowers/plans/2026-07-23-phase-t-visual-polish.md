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
T1 token and shared language: NOT STARTED
T2 AppShell and navigation polish: NOT STARTED
T3 Jobs and JobDetail polish: NOT STARTED
T4 CRM/product/staff/forms polish: NOT STARTED
T5 states and visual regression: NOT STARTED

P0 defect track:
RecordDescriptions container reflow: OPEN

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

**Status:** OPEN (runtime PR after T0 merge only)
**Branch (planned):** `fix/web-record-descriptions-reflow`
**PR title (planned):** `fix(web): make record descriptions container-responsive`

### Root-cause hypothesis

```text
viewport >= 64rem → adapter sets column = 2
real container (sidebar + padding + nested grid) may be < ~640px
→ crushed / glyph-stacked Descriptions cells
```

### Required approach (summary)

- Remove viewport-only column decision from adapter
- `ResizeObserver` on owned wrapper; threshold `RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX = 640`
- Safe `column=1` before measure / without ResizeObserver
- `wide` span only in two-column mode
- Stay in Ant → owned adapter → JobDetail boundary
- No global Ant selector hacks, no overflow-x hide, no font shrink, no domain changes

### Done when

- [ ] Focused + JobDetail regression tests pass
- [ ] Responsive smoke 390–1440 + text zoom
- [ ] After evidence under `docs/ui/screenshots/phase-t-p0/`
- [ ] This plan’s P0 status → COMPLETE

Full implementation brief lives with the runtime PR; do not expand T0.

---

## T1 — Token and shared visual language

**Status:** NOT STARTED

Typography scale, spacing rhythm, border/radius/shadow, page/section headings, form label/helper/error, button/focus contract drift — without mass component replacement.

---

## T2 — AppShell and navigation polish

**Status:** NOT STARTED

Sidebar hierarchy, account/footer, mobile chrome, Notification Center **visual** polish, workspace width — no Ant Layout/Menu; no Ayarlar page.

---

## T3 — Jobs workspace and JobDetail

**Status:** NOT STARTED

List/board, filters, workflow hierarchy, notes/timeline, approval/revision, Jobs empty/error dialect. P0 must be closed before or as defect preflight prior to claiming T3 complete.

---

## T4 — CRM, product, staff/user + forms

**Status:** NOT STARTED

Customer/contact, product, staff/user lighter pass; create/edit form chrome contract for meeting/delivery/task/product/customer. Native controls retained.

---

## T5 — States and visual regression (closeout)

**Status:** NOT STARTED

Loading/empty/error/success; 390–1440; 200% text / 400% reflow; screenshot matrix; implementation-plan closeout note.

---

## Progress tracker

| ID | Slice | Status |
| --- | --- | --- |
| T0 | Audit + docs + baseline | **COMPLETE** |
| P0 | RecordDescriptions container reflow | **OPEN** |
| T1 | Tokens / visual language | NOT STARTED |
| T2 | AppShell / nav | NOT STARTED |
| T3 | Jobs + JobDetail | NOT STARTED |
| T4 | CRM / product / people / forms | NOT STARTED |
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
