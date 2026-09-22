# Jobs Workspace Control Surface Audit

Status: **AUDIT ONLY** — no code changed, no DESIGN.md change, Slice 3A not started.
Base verified: `origin/main` = local HEAD = `a5a519a` (docs PR #321 merged). Worktree clean before and after (measurement fixtures created under `web/` temporarily, removed afterwards; `git status` clean).
Normative source: `DESIGN.md` (shell contract). Decision record: `test-results/ux-shell-design-decisions-2026-09-21.md` v2.1.

Scope: Jobs workspace control stack only — quick views, Liste/Pano mode, search, filters, mobile density. Overdue semantics NOT reopened (Geciken membership, scanner, lifecycle untouched).

Evidence: current source (`web/src/jobs/JobWorkspace.tsx`, `JobFilters.tsx`, `job-search.ts`, `workflow-lanes.ts`, `jobs-api.ts`, server `job-cards/workspace-query.ts` + `service.ts`) + live Chromium geometry of the real control components (real `JobFilters` + verbatim quick-view/heading markup + real `styles.css`, served via vite, measured with Playwright at 320/360/390/430/768/1024) + one WebKit spot check at 390px.

---

## 1. Current architecture

- **JobWorkspace** (`web/src/jobs/JobWorkspace.tsx`): owns URL-as-truth via `useSearchParams` + `parseJobSearch`; canonicalizes params (`canonicalJobSearchParams`, replace). Renders heading (eyebrow + H1 `İşler`/`İşlerim` + `NewJobMenu`), quick-view nav (6 links manager / 5 staff, `aria-current="page"`), optional order note, `JobFilters`, then `JobBoard` or `JobList`. `showBoard = filters.view === 'board' && filters.status !== 'closed'`; `showViewControl={status !== 'closed' && overdue !== true}`.
- **JobFilters** (`web/src/jobs/JobFilters.tsx`): two modes gated by the same 64rem query as AppShell. Narrow (<1024): compact grid — search field + `Ara` submit + `Filtreler (n)` trigger + optional Liste/Pano switcher + `FilterSheet` (status + advanced). Desktop: primary row (search + Görünüm select + Durum select + `Ara`) + `Diğer filtreler` disclosure.
- **job-search helpers** (`web/src/jobs/job-search.ts`): `parseJobSearch` (normalization with silent forcing), `canonicalJobSearchParams` (drops defaults), `updateJobSearch` (filter apply: deletes `overdue` + `offset`), `enterBoard` (deletes status/offset/overdue, sets board), `selectStatus` (deletes overdue, sets status + `view=list` + `offset=0`), `statusQuickSearch` (selectStatus + drops dates/followUp), `overdueJobsSearch` (keeps q/type/assignedTo/customerId/priority; drops status/offset/dates/view/followUp; sets `overdue=true`), `followUpJobsSearch` (keeps ordinary filters; drops status/offset/dates/overdue/view), `forceMobileList`.
- **JobBoard / lanes**: columns are exactly the 5 active workflow statuses (`workflow-lanes.ts`: NEW, ACCEPTED, IN_PROGRESS, WAITING_APPROVAL, REVISION_REQUESTED) + `closedCounts`. No lanes exist for terminal states.
- **Server** (`server/src/modules/job-cards/`): `BOARD_KEYS` accepts q/type/assignedTo/customerId/priority/dates/followUp/limit — **no `status`, no `overdue`, no `offset`**. List query accepts `overdue=true` only with active status and no date bounds (else 400). `closed` = COMPLETED + CANCELLED.
- **CSS ownership** (`web/src/styles.css`): `.job-quick-views` (wrap flex, ~44px chip links), `.job-filter-compact-bar` (3-col grid → **single column at ≤56rem/896px**), `.job-view-switcher` (2-col grid, 44px buttons), desktop `.job-filters` primary row + disclosure.

---

## 2. Existing behavior matrix

URL result = canonical params after helpers run (defaults dropped: `status=active`, `view=list`, `offset=0` omitted).

| Quick view | List | Board | Switcher visible | Quick-view URL result | Filters | Pagination |
|---|---|---|---|---|---|---|
| Aktif | yes | yes | yes | `/jobs` (+ preserved q/type/assigned/person/customer/priority) | preserved (dates dropped) | reset to 0 |
| Takip | yes | yes (via switcher after) | yes | `?followUp=only` (+ ordinary filters; view/dates/status/overdue dropped) | ordinary preserved | reset to 0 |
| Onay (manager+) | yes | yes (via switcher after) | yes | `?status=WAITING_APPROVAL` (+ preserved; dates/followUp dropped) | preserved minus dates | reset to 0 |
| Düzeltme | yes | yes (via switcher after) | yes | `?status=REVISION_REQUESTED` (same rule) | preserved minus dates | reset to 0 |
| Biten | yes | **no** | **no** | `?status=closed` (same rule) | preserved minus dates | reset to 0, list-only |
| Geciken | yes | **no** | **no** | `?overdue=true` (+ q/type/assigned/customer/priority only) | dates dropped, rest preserved | reset to 0, list-only |

Additional actual behaviors (all verified in code):

- Clicking **any** quick view forces `view=list` (`selectStatus`). Board preference is silently discarded on every quick-view click, with no visible explanation.
- Board → Geciken: URL becomes `?overdue=true`; view silently becomes Liste. Nothing tells the user the mode changed.
- Geciken → Aktif: `view=list`; previous board preference does not return.
- Filter apply (`updateJobSearch`, incl. FilterSheet apply/clear): **deletes `overdue`** — applying any filter inside Geciken silently exits the overdue view. Sheet apply with non-active status additionally forces `view=list` (via `selectStatus` in `onApply`).
- Desktop Durum dropdown change (`onChange` → `selectStatus`): forces `view=list` even mid-board session — changing status while in Pano silently drops to Liste.
- `enterBoard` always resets to the active-lane board (deletes status/offset/overdue); board never shows a status-filtered lane set.
- `status=INVALIDATED` also forces `view=list` client-side (same line as `closed`).
- Orphan highlight: Aktif + date bounds (or any ordinary filter combo outside the pristine patterns) matches **no** quick view's `current` predicate — the nav shows six idle chips with no indication of where the user is. Takip requires an exact pristine set; Onay/Düzeltme ignore dates but not followUp.

---

## 3. Root causes

### Semantic / API constraints (not negotiable in this audit)

- **Biten has no board because the board has no terminal lanes.** Columns are the 5 active statuses; `closed` = COMPLETED + CANCELLED, which cannot be honestly rendered as lifecycle lanes. Board endpoint accepts no `status` param. → REQUIRED BY PRODUCT/API SEMANTICS.
- **Geciken has no board because overdue is a server-owned list-only query** (`overdue=true` requires active status, no date bounds; board keys exclude `overdue`). An overdue board (same 5 lanes, lateness-filtered) is technically conceivable but needs a new API capability + product decision; OVR-1 deliberately stayed list-oriented. → HISTORICAL IMPLEMENTATION LIMITATION on top of a list-oriented product decision, NOT a data impossibility. Do not expose it without that API work.

### State-machine / search-param behavior (silent normalization — the systemic issue)

- `selectStatus`/`statusQuickSearch`/`overdueJobsSearch` conflate three jobs: change membership, reset pagination, **and** reset view mode. View reset rides along unannounced (Board→click→Liste, §2 rows).
- `updateJobSearch` deletes `overdue` on any filter apply → silent view exit.
- `parseJobSearch` forces `view=list` for overdue/closed/INVALIDATED without any surface explaining the coercion.
- `current` predicates are pristine-state matchers, so filtered states routinely show no active quick view.

### Presentation / CSS choices (density — the visible issue)

- `.job-quick-views` wrap flex: 4 rows at 320px / 3 at 360–390 / 2 at 430–768 / 1 at ≥1024 (manager, 6 chips). STAFF (5 chips) shifts every breakpoint by ~one row.
- Compact bar is 3-col only in the 896–1023 band; **below 896px it collapses to a single column: search, `Ara`, `Filtreler` stack as 3 full-width 44px rows** — the dominant mobile cost.
- View switcher is a full extra 44px row whenever visible (≈56px with gap), and its presence/absence (≈56px delta) makes Biten/Geciken stacks shorter but visually inconsistent.
- Active chip uses heavier weight (760 vs 680), which measurably changes wrap (e.g. Onay at 360px wraps to 4 rows while Aktif stays at 3) — selection state perturbs geometry.

---

## 4. Mobile geometry

Method: real `JobFilters` component + verbatim heading/quick-view markup + production `styles.css`, Chromium, `networkidle`. Fixture contains control chrome only (no shell topbar/bottom nav, no order note, no result rows), so `stackBottom` = Y where results begin; real pages add shell chrome (~topbar + bottom nav) and list chrome on top — **all fractions below are lower bounds; the real fold is worse.** Viewport heights are representative device values. WebKit spot check at 390px Aktif: stackBottom 605 vs Chromium 602, same 3 qv rows, no overflow, 44px targets — engines agree.

| Viewport | View | QV rows | Bar rows | Switcher | Stack bottom (px) | Viewport frac. | First result vs fold |
|---|---|---|---|---|---|---|---|
| 320×568 | Aktif+Liste | 4 | 3 (stacked) | +1 row | 653 | **1.15** | below fold — zero job content visible initially |
| 320×568 | Aktif+Pano | 4 | 3 | +1 row | 653 | **1.15** | below fold |
| 320×568 | Biten | 4 | 3 | absent | 597 | **1.05** | below fold (list-only saves ~56px, still fails) |
| 320×568 | Geciken | 4 | 3 | absent | 597 | **1.05** | below fold |
| 320×568 | Aktif STAFF | 3 | 3 | +1 row | 602 | 1.06 | below fold (role changes geometry, not outcome) |
| 360×740 | Aktif+Liste | 3 | 3 | +1 row | 602 | 0.81 | first result starts at 81% — ~one row visible |
| 360×740 | Biten/Geciken | 3 | 3 | absent | 546 | 0.74 | partial first row |
| 360×740 | Onay | 4 | 3 | +1 row | 653 | 0.88 | active-weight wrap costs a row (see §3) |
| 390×844 | Aktif+Liste | 3 | 3 | +1 row | 602 | 0.71 | partial results |
| 390×844 | Biten/Geciken | 3 | 3 | absent | 546 | 0.65 | partial results |
| 430×932 | Aktif+Liste | 2 | 3 | +1 row | 551 | 0.59 | usable |
| 430×932 | Biten/Geciken | 2 | 3 | absent | 495 | 0.53 | usable |
| 768×1024 | Aktif+Liste | 2 | 3 | +1 row | 591 | 0.58 | usable (compact mode still applies <1024) |
| 768×1024 | Biten/Geciken | 2 | 3 | absent | 535 | 0.52 | usable |
| 1024×768 | any (desktop form) | 1 | 1 row form | in-form select | 375 | 0.49 | usable |

Invariants across all widths: **no horizontal overflow anywhere**; **all touch targets 44px** (quick chips, `Ara`, `Filtreler`, switcher buttons). Targets are compliant — density must not be fixed by shrinking them.

Stack composition at 320px Aktif (653px total): heading 63 + quick views 215 (4 rows) + compact bar ~250 (search 3 stacked rows ≈ 3×44+gaps+label) + switcher 44 + margins/gaps ≈ 80. The two largest costs are wrapping quick views and the stacked search/Ara/Filtreler column.

---

## 5. Consistency findings

- **P1 systemic — Silent view-mode resets.** Every quick-view click, every filter apply in Geciken, and every desktop status change force `view=list` (or exit overdue) with no user-visible explanation. The URL is truthful but the UI never announces the coercion. (state-machine root cause, §2/§3)
- **P1 systemic — Quick views are unclassified.** They look like tabs (segmented-style active state, `aria-current="page"`) but behave like shortcut links (each resets view/pagination/dates, none is exhaustive — filtered states show no current item). Users cannot form a correct mental model because the surface promises tabs and delivers resets. (classification A: they are **saved-filter shortcuts**, currently dressed as tabs)
- **P1 local (320–360px) — First results below the fold.** 1.15 viewports of chrome at 320px Aktif; even list-only Biten/Geciken fail at 1.05. Real pages are worse (shell chrome excluded from measurement). (presentation root cause)
- **P2 systemic — Asymmetric chrome without explanation.** Switcher present/absent changes stack height by ~56px between views; Biten/Geciken give no list-only signal, so absence reads as inconsistency rather than semantics. (presentation + communication)
- **P2 local — Role/selection geometry instability.** STAFF vs manager shifts rows; active-weight (760) re-wraps chips (Onay 360px: 4 rows vs 3). Layout shifts under the user's feet. (presentation)
- **P2 local — `Ara` redundancy unexamined.** Form submits on Enter natively (`type=search` + submit handler); the dedicated full-width `Ara` row costs 44px + gap on every ≤896px screen. Whether it earns its row needs the F evaluation, not an assumption. (presentation/interaction)
- **P3 local — Orphan highlight states.** Ordinary filtered views (e.g. Aktif + date bounds) match no `current` predicate; the nav goes fully idle. (state-machine predicates)
- **P3 local — Desktop status dropdown kills board.** Changing Durum while in Pano drops to Liste silently. Same P1 mechanism, desktop surface. (state-machine)

---

## 6. Recommended control hierarchy

**Quick views (membership shortcuts) → content mode (Liste/Pano) → search/filter (narrowing) → results.** One sentence: quick views choose *which* jobs, the mode control chooses *how* they are shown, search/filters narrow *within* that choice — and mode must survive membership changes instead of being reset by them.

Why: it matches the URL semantics already in place (`status`/`overdue`/`followUp` = membership; `view` = presentation; `q`/advanced = narrowing), it gives each layer one job (ending the tabs-vs-shortcuts confusion), and it makes the P1 fix structural — view becomes an orthogonal, preserved dimension except where semantics forbid (Biten/Geciken list-only, communicated per §7).

---

## 7. Biten / Geciken policy

- **Board eligibility: no for both in this workstream.** Biten: semantic (no terminal lanes; would need new API + lane design). Geciken: current API limitation + standing list-oriented product decision; an overdue board needs new endpoint capability first. Do not change overdue semantics or membership.
- **Communication: behavioral symmetry, not visual symmetry.** Do not hide the mode control silently (current) and do not show a dead disabled Pano without reason (pure visual symmetry). Recommended: keep one persistent mode row everywhere AND, in list-only views, render the list-only state explicitly — e.g. a compact `Liste · pano bu görünümde yok` indicator in the mode slot — so the surface is stable in height (~56px delta disappears) and the restriction reads as semantics, not a bug. Exact copy is a product-owner call (§12).
- **Both rules**: symmetry of *behavior* (same rows, same order, same state honesty) over symmetry of *pixels*.

---

## 8. Mobile compact contract

Observable rules (all measurable, no invented pixel thresholds):

- **Persistent rows before results: max 3 on ≤430px** — (1) one quick-view selector row (pattern per §12 decision, not prescribed here), (2) one search row with `Filtreler` beside it (no full-width `Ara` row unless F resolves it earns its place), (3) one mode row, always present, showing list-only state where applicable (§7). Everything else (advanced fields, status select) lives in FilterSheet.
- **Quick views: max 1 row of chrome.** Wrapping to 2–4 rows is the measured failure (215px at 320px). Whether that row scrolls horizontally, becomes a select, or uses shortened labels is the §12 pattern decision — but multi-row wrap is rejected by measurement at ≤390px.
- **320/360/390/430 behavior:** the contract is stated as outcomes, verified by geometry tests: stack-bottom fraction ≤ ~0.5 of a representative viewport with shell chrome included; no overflow; 44px targets intact. Current measured fractions (0.59–1.15 *without* shell chrome) fail this; the numbers, not aesthetics, gate the redesign.
- **768–1023:** compact mode still applies (64rem gate, per DESIGN.md — no tablet shell); same 3-row contract, which current 768 already nearly meets (0.52–0.58 without shell chrome — re-verify with shell included).
- **Collapse rule:** only FilterSheet-bound controls may leave the persistent surface; membership (quick views), mode, and search entry must stay visible.

---

## 9. Interaction/state contract

Recommended expected behavior (documents what SHOULD hold; current deviations are §2):

- Board → Geciken: URL `?overdue=true` (+ preserved narrowing); view becomes Liste **with an explicit, dismissible notice** ("Geciken görünümü liste olarak gösterilir") rather than silent coercion. Membership change is the user's action; mode loss must be announced.
- Geciken → Aktif: restores the user's last board preference when the previous view was board (board is valid for Aktif); otherwise list. Preference stored per session (URL or session state — implementation choice), never silently dropped.
- Board → Biten: same announced-coercion rule as Geciken (list-only is semantic here).
- Biten → Aktif: same preference-restore rule.
- Filters active → quick view: quick view replaces membership (status/overdue/followUp/dates per current helpers) but preserves narrowing filters (q/type/assigned/customer/priority) — current behavior, keep — AND preserves view mode where the target view supports it.
- Quick view → FilterSheet apply/clear: apply narrows within the current membership; **apply must not silently exit Geciken** (current `updateJobSearch` deletes `overdue` — the P1 fix); clear returns to the canonical Aktif list and announces the reset.
- General rule: **membership changes reset pagination, never view mode, except into announced list-only states.**

---

## 10. Implementation boundary

**Its own Jobs UX slice, after 3A foundation lands but not inside it.** Reasoning: the P1 state-contract fixes (§9) touch `job-search.ts` + `JobWorkspace`/`JobFilters` only — no PageHeader/registry dependency — so they are separable from 3A. But the control hierarchy (§6) must render *below* PageHeader in the documented page-owned region, so the slice should follow the 3A foundation (which establishes where page-owned controls live) rather than precede it. Do not expand Slice 3A: nothing here is inseparable from the identity registry. Proposed order: 3A (foundation) → Jobs control slice (this audit) → 3B (breadcrumb/ReturnLink migration) → 4, with 3B/4 unaffected by Jobs internals. The mobile compact contract (§8) is pure Jobs CSS + `JobFilters` structure — zero shell impact.

---

## 11. Proposed regression tests

- URL/search-param state: each quick view produces its canonical URL from representative starting states (board active, filtered, Geciken); board preference preserved across Aktif↔Takip↔Onay↔Düzeltme; announced coercion into Geciken/Biten carries a notice assertion.
- List-only semantics: `view=board&status=closed`, `view=board&overdue=true`, `status=INVALIDATED&view=board` all canonicalize to list; board endpoint never receives `status`/`overdue` (API-shape test).
- Filter apply in Geciken preserves `overdue=true`; sheet clear returns to canonical Aktif.
- Mobile geometry (real components + production CSS, Chromium): stack-bottom fraction per §8 at 320/360/390/430 with shell chrome included; quick-view selector occupies 1 row; no horizontal overflow at any width; all persistent controls ≥44px.
- First-result visibility: first job row top within initial viewport at 360/390/430 (representative heights), Biten/Geciken included.
- Accessibility: quick-view group exposes current state (no orphan-idle confusion — at least a `aria-current` or an explicit "filtered" indicator); `Ara` decision (keep/remove) covered by keyboard-operability test either way; FilterSheet focus trap/return retained.

---

## 12. Product-owner decisions

Only genuine subjective calls (everything else has a recommendation above):

1. **List-only indicator copy + pattern** (§7): explicit inline indicator vs alternative presentation of "pano bu görünümde yok", and its exact Turkish wording.
2. **Quick-view selector pattern on ≤430px** (§8): horizontal scroller vs select/menu vs shortened labels — discoverability vs density tradeoff; measurement constrains it to one row but the pattern is a product call.
3. **Whether `Ara` keeps its row** (§F): explicit submit button vs Enter/icon-integrated submit on compact — depends on how much the product values an always-visible submit affordance for field staff.
4. **Board-preference restore scope** (§9): per-session restore vs per-navigation default-to-list when returning to board-eligible views.

Technical items (asymmetry cause, hierarchy order, slice placement, geometry gates) are decided by this audit's recommendations, not bounced back.

---

## IMPLEMENTATION VERIFICATION — 2026-09-22

Status: **POST-FIX VERIFICATION** — this section is additive evidence. The audit baseline and findings above are unchanged.

Implementation base: `444e529127ac4d54b6bc2e23ce6005c285980aa0` (current `origin/main`; the commit after the prompt's expected base was inspected and was disjoint operational backup/health work).

Method: a deterministic, non-production Vite fixture renders the real `JobWorkspace`, `PageHeader`, `JobFilters`, `JobList`, `JobBoard`, application shell chrome and production CSS. Measurements use Playwright Chromium at all required widths, a WebKit spot check at 390px, manager and STAFF quick-view sets, and representative active-list, active-board, approval-board, closed and overdue states. The geometry runner is part of `npm run smoke:responsive`.

| Viewport / case | QV rows | Persistent control rows | First result Y | Viewport fraction | Page overflow | Minimum target |
|---|---:|---:|---:|---:|---:|---:|
| 320×568 Aktif list | 1 | 3 | 430.55px | 0.758 | 0px | 61.03×44px |
| 360×740 Aktif list | 1 | 3 | 430.55px | 0.582 | 0px | 61.03×44px |
| 390×844 Aktif list | 1 | 3 | 430.55px | 0.510 | 0px | 61.03×44px |
| 430×932 Aktif list | 1 | 3 | 430.55px | 0.462 | 0px | 61.03×44px |
| 768×1024 Aktif list | 1 | 3 | 470.22px | 0.459 | 0px | 80×44px |
| 1024×768 Aktif list | 2 | 6 (desktop composition) | 741.14px | 0.965 | 0px | 91.28×44px |
| 1440×900 Aktif list | 1 | 4 (desktop composition) | 480.17px | 0.534 | 0px | 80.02×44px |
| 390×844 Aktif board | 1 | 3 | 566.53px | 0.671 | 0px | 61.03×44px |
| 390×844 Onay board | 1 | 3 | 570.53px | 0.676 | 0px | 61.03×44px |
| 390×844 Biten | 1 | 3 | 430.55px | 0.510 | 0px | 61.03×44px |
| 390×844 Geciken | 1 | 3 | 430.55px | 0.510 | 0px | 61.03×44px |
| 390×844 Aktif list, STAFF | 1 | 3 | 430.55px | 0.510 | 0px | 61.03×44px |
| 390×844 Aktif list, WebKit | 1 | 3 | 433.58px | 0.514 | 0px | 61.03×44px |

At 320px, first-result Y improved from the 653px / 1.15-viewport audit failure to 430.55px / 0.758 with actual shell chrome included, a 222.45px reduction while retaining the full membership labels, explicit submit affordance, filters, PageHeader semantics and 44px targets. At 360/390/430px, real result content begins inside the initial viewport. The quick-view strip owns its horizontal overflow (for example 358px client width / 771px scroll width at 390px); the page itself has no horizontal overflow.

The 1024px row count reflects the existing desktop shell/sidebar reducing content width to 720px; the Jobs-specific desktop form and quick-view wrap rules were not compacted or globally reworked in this bounded mobile-density slice.
