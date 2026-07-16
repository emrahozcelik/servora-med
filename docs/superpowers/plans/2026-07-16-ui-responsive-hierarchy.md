# UI Responsive Hierarchy & Mobile Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS:  
> 1. **impeccable** (product register) — load `PRODUCT.md` + `DESIGN.md` before UI work.  
> 2. **Google Labs DESIGN.md** — root `DESIGN.md` is visual SSOT ([format](https://github.com/google-labs-code/design.md)).  
> 3. superpowers:subagent-driven-development or superpowers:executing-plans.  
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliberate minimal field/ops web app: mid-width reflow fixed, surface hierarchy, CSS button/select contracts, one Jobs primary create, unified mobile shell — no full redesign, no new runtime deps.

**Design SSOT (slice):** `docs/superpowers/specs/2026-07-16-ui-responsive-hierarchy-design.md`  
**Visual identity SSOT:** root `DESIGN.md` + `PRODUCT.md`  
**Baseline:** `main` after PR #12  
**Branch:** `feature/ui-responsive-hierarchy` (all phase PRs from this branch or stacked commits)

**Architecture:** Frontend-only. CSS class contracts (no new React Button abstraction). Shared `buildNavigationModel(user)`. Chips, NewJob menu/sheet, filter sheets, mobile chrome. Align every contract with DESIGN.md.

**Tech stack:** React 18, React Router, CSS. Vitest + **real browser smoke for P0** (existing Playwright MCP or project browser method; static CSS alone is not enough for P0 closeout).

## Global constraints

- No backend domain/migration/API breaks.  
- No new runtime npm dependencies. Optional dev-only: `npx @google/design.md lint DESIGN.md`.  
- Turkish UX copy; English code/commits.  
- WCAG 2.2 AA; two-channel status/priority; no side-stripe, nested cards, gradient text, glass.  
- JobCard approval rules untouched.  
- Surgical diffs.  
- **Phase PRs** (not one mega-PR): each phase has its own test/build/audit/visual-smoke closeout.

## Delivery structure (phase PRs)

```text
PR A — P0.5 + P0
  T0–T5
  DESIGN.md Layout/Shapes/Components, micro-hints, Status+Priority chips,
  filter reflow, Kanban content-width gate, select consistency
  + browser smoke 390 / 768 / 1024 / 1440 / 200% / 400%

PR B — P1a
  T6, T6.5, T7
  Button CSS contract, surface hierarchy, Yeni iş menu/sheet

PR C — P1b
  T8–T9
  Unified mobile top bar, shared nav model, bottom nav

PR D — P1c
  T10–T11
  JobFilters sheet (required), CustomerFilters sheet (required same primitive or follow-up PR),
  mobile job cards
```

Each PR: `cd web && npm test -- --run`, `npm run build`, `npm audit --audit-level=high`, phase visual smoke as applicable.

## File map

### Create

```text
web/src/ui/PriorityChip.tsx
web/src/ui/StatusChip.tsx
web/src/jobs/NewJobMenu.tsx
web/src/shell/navigation-model.ts     # buildNavigationModel(user)
web/src/shell/MobileBottomNav.tsx
web/src/shell/MobileTopBar.tsx        # single mobile top bar (not second header)
web/src/ui/FilterSheet.tsx            # shared sheet primitive if useful
web/tests/ui-button-contract.test.tsx
web/tests/new-job-menu.test.tsx
web/tests/mobile-shell.test.tsx
web/tests/navigation-model.test.ts
web/tests/responsive-browser-smoke.*  # or ops script using existing browser harness
```

### Modify

```text
DESIGN.md
web/src/styles.css
web/src/App.tsx / shell
web/src/jobs/*
web/src/CustomerList.tsx
web/src/PasswordChange.tsx
web/src/UserManagement.tsx
web/src/StaffProfiles.tsx
```

### Explicit non-choices

```text
NO new web/src/ui/Button.tsx abstraction this slice
NO second nav destination list parallel to shell
NO second mobile header under existing sticky chrome
```

---

## Task 0: DESIGN.md Layout + Shapes + Components (mandatory before code)

**Files:** `DESIGN.md` only (section order: … Typography → **Layout** → **Elevation** stays → **Shapes** → **Components** → Do's and Don'ts).

Canonical Google section order: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts.

Current file is missing Layout, Shapes, Components. **Must add before any UI code.**

Minimum content:

**Layout**

- Workspace max width (~68rem default; board may be wider when gated open)
- Shell/sidebar ≥64rem
- Mobile ≤40rem; filter collapse ≤56rem; wide-board preferred via **container** (see Kanban)
- Mobile action vs desktop oversight

**Shapes**

- Control / button radius (~0.6rem)
- Chip radius (pill 999px)
- Raised sheet/popover radius + separation

**Components**

- Button: primary | secondary | destructive | ghost; btn-sm | btn-md; **btn-full explicit** (not default)
- FormControl: shared padding, border, radius, min-height, focus, hint, error
- StatusChip + PriorityChip (two-channel)
- NewJob menu (desktop disclosure) / sheet (mobile modal layer)
- Mobile top bar (single bar)
- Bottom navigation + overflow Menü as **button** opening drawer

- [ ] **Step 1:** Insert Layout, Shapes, Components with prose + YAML tokens where useful.  
- [ ] **Step 2:** Optional `npx @google/design.md lint DESIGN.md`.  
- [ ] **Step 3:** Commit.

```bash
git commit -m "docs(design): add Layout, Shapes, and Components to DESIGN.md"
```

---

## Task 1: Password and temporary-password field hints

**Files:** `PasswordChange.tsx`, `UserManagement.tsx`, tests.

- Visible hint before submit: `En az 12, en fazla 128 karakter.`  
- `aria-describedby` wired.

- [ ] Failing test → implement → pass → commit.

```bash
git commit -m "fix(web): show password length requirements before submit"
```

---

## Task 2: StatusChip + PriorityChip (both required)

**Files:** `StatusChip.tsx`, `PriorityChip.tsx`, JobRow/Board/Detail, `styles.css`, DESIGN.md if needed.

- Two-channel: soft fill + Turkish label (+ optional shape/icon, no side-stripe).  
- Priority: Acil / Yüksek / Normal / Düşük.  
- Status: existing lifecycle labels with soft backgrounds matching semantic tokens.

- [ ] Tests for both chips.  
- [ ] Wire job list/board/detail.  
- [ ] Commit.

```bash
git commit -m "feat(web): status and priority chips with two-channel emphasis"
```

---

## Task 3: Filter grid mid-width reflow

**Files:** `styles.css` (`.customer-filters`, job filters, report wide filters if same family).

- Collapse multi-column filters at **≤56rem** (not only 720px).  
- Unit/CSS contract tests OK as **helpers**.  
- **P0 closeout (Task 5b) requires real browser smoke** — static CSS alone is not P0 done.

- [ ] Implement + commit.

```bash
git commit -m "fix(web): collapse multi-column filters before mid-width clip"
```

---

## Task 4: Kanban content-width gate

**Canonical gate (not viewport-only 80rem):**

```text
Preferred: board container inline-size >= ~68–70rem (container query on .job-board)
Fallback:  viewport min-width: 90rem
```

At 1024px with sidebar, five equal columns must **not** open. At 1440px (or wide container), usable board allowed. Board workspace may exceed default 68rem workspace when open.

- [ ] Implement container query preferred; document fallback.  
- [ ] Commit.

```bash
git commit -m "fix(web): gate Kanban five-column layout on usable content width"
```

---

## Task 5: Unified FormControl / select styling

**Contract:** CSS class/selector only. Move bare selects into shared structure. **No full form tree React refactor.**

- Staff “Durum” and all job/customer filters share control look.  
- Commit.

```bash
git commit -m "fix(web): align select and form control styles"
```

---

## Task 5b: P0 browser smoke (required for PR A)

Viewports / conditions:

```text
390 × 844
768 × 1024
1024 × 768
1440 × 900
200% text scaling
400% browser zoom/reflow
```

Minimum automatic checks:

```text
document.documentElement.scrollWidth <= clientWidth
filter/control boxes inside container
same-row controls do not intersect
1024: five-column Kanban not active
1440 (or wide): board usable when gated
bottom nav (when present in later PR) does not cover pagination — N/A for PR A if nav not yet shipped
```

Use existing browser acceptance (Playwright MCP/session tools OK). **Do not claim P0 done with CSS string tests only.**

- [ ] Run smoke; record results in PR A body.  
- [ ] Fix regressions if any.

---

## Task 6: Button width CSS contract (no React Button)

```text
.primary-button → content width by default in toolbars (margin-top 0 in rows)
.btn-full or .form-actions .primary-button → width 100%
variants: primary | secondary | destructive | ghost
sizes: btn-sm | btn-md (compact-button maps to sm)
```

No `web/src/ui/Button.tsx` this slice.

- [ ] CSS + sweep form footers with `.btn-full` / `.form-actions`.  
- [ ] Update DESIGN.md Components.  
- [ ] Commit.

```bash
git commit -m "refactor(web): primary button full-width is opt-in"
```

---

## Task 6.5: High-traffic surface hierarchy

```text
Job filters → calm Surface
Job detail summary → readable Surface
Lifecycle action bar → clear flat Surface (not raised unless sticky overlay)
Menu / sheet → real Raised (earned shadow)
Desktop list rows → flat, no cards, no side-stripe
```

- [ ] CSS classes e.g. `.surface`, `.surface-raised` applied surgically.  
- [ ] Commit.

```bash
git commit -m "feat(web): surface hierarchy on high-traffic job screens"
```

---

## Task 7: Yeni iş menu / sheet

- Single primary “Yeni iş”.  
- Desktop: disclosure popover, **no focus trap**; Escape + focus return.  
- Mobile sheet: if true modal layer, **focus containment** + restore.  
- When sticky mobile create is visible (PR C+), **hide toolbar duplicate** primary.  
- Routes: existing new meeting/task/delivery.

```bash
git commit -m "feat(web): consolidate job creation into Yeni iş menu"
```

---

## Task 8: Single mobile top bar

**Not** a second header under brand/menu chrome.

```text
One mobile top bar
├─ optional back
├─ route/section title (single metadata source)
└─ profile or overflow
```

No duplicate large visual `h1` in content for the same title (keep one semantic heading strategy).

```bash
git commit -m "feat(web): unify mobile top bar with route title"
```

---

## Task 9: Shared navigation model + bottom nav

```ts
buildNavigationModel(user) // single SSOT
→ desktop sidebar
→ mobile drawer
→ bottom navigation
→ overflow items
```

Manager/Admin **Menü** is a **`<button>`** that opens the existing drawer (not a route link). Overflow: Personel, Kullanıcılar, Oturumu kapat. Focus returns to trigger on close.

Staff bottom: İşler | Müşteriler | Ürünler | Profil.  
Manager: İşler | Müşteriler | Raporlar | Menü.

```bash
git commit -m "feat(web): shared navigation model and role-based bottom nav"
```

---

## Task 10: Mobile filter sheets (Jobs first)

**Order (required):**

1. **JobFilters** mobile sheet — **required**  
2. **CustomerFilters** mobile sheet — same primitive; **required** or dedicated follow-up PR if time-boxed  
3. Report filters — **out of this slice**

**Sheet behavior:**

- Open: draft from current URL filters  
- Apply: write URL, close sheet  
- Clear: canonical defaults  
- Dismiss/Escape: discard draft  
- Active filter count on trigger  

```bash
git commit -m "feat(web): mobile job and customer filter sheets"
```

---

## Task 11: Mobile job list card composition

Desktop density preserved; mobile stacked card: title, status chip, priority chip, customer/staff, due, full-width next action when present.

```bash
git commit -m "feat(web): mobile job list card composition"
```

---

## Phase closeout checklist (each PR)

- [ ] `cd web && npm test -- --run`  
- [ ] `cd web && npm run build`  
- [ ] `cd web && npm audit --audit-level=high`  
- [ ] DESIGN.md honest for shipped contracts  
- [ ] PR A additionally: Task 5b browser smoke  
- [ ] PR description; do not merge without green CI  

---

## Spec coverage

| Item | Task | PR |
|------|------|-----|
| DESIGN Layout/Shapes/Components | T0 | A |
| Password hint | T1 | A |
| Status + Priority chips | T2 | A |
| Filter mid-width | T3 | A |
| Kanban content-width | T4 | A |
| FormControl/select | T5 | A |
| Browser smoke | T5b | A |
| Button CSS contract | T6 | B |
| Surface hierarchy | T6.5 | B |
| Yeni iş | T7 | B |
| Unified top bar | T8 | C |
| Nav model + bottom nav | T9 | C |
| Job+Customer filter sheets | T10 | D |
| Mobile job cards | T11 | D |

## Risk notes

1. Button full-width flip needs simultaneous `.form-actions` / `.btn-full` on forms.  
2. Nav model extraction must not drop ADMIN-only destinations.  
3. Container query support: provide 90rem fallback.  
4. Sticky create + toolbar: one primary only.  
5. Desktop menu no trap; mobile sheet yes if modal.

## Execution status

```text
Design direction       → APPROVED
Plan after 10 fixes    → execution-approved
Execution mode         → inline
Start                  → PR A, Task 0
```
