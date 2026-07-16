# Design: UI Responsive Hierarchy & Mobile Shell Polish

**Status:** Design approved; plan execution-approved after 2026-07-16 review fixes  
**Date:** 2026-07-16  
**Branch (proposed):** `feature/ui-responsive-hierarchy`  
**Baseline:** `main` (post PR #12 reporting panel)  
**Delivery:** Phase PRs A (P0.5+P0) → B (P1a) → C (P1b) → D (P1c)

## 0. Skill and design-system references (normative)

Implementation of this work **must** treat the following as binding design guidance, not optional inspiration.

### 0.1 Google Labs DESIGN.md

- Spec / format: [google-labs-code/design.md](https://github.com/google-labs-code/design.md)
- Philosophy: prose carries intent; tokens are normative values that support prose (not a second CSS engine)
- Repo SSOT for visual identity: **`DESIGN.md`** at repository root (YAML front matter + ordered prose sections)
- Canonical section order when editing `DESIGN.md`: Overview → Colors → Typography → Layout → Elevation → Shapes → Components → Do's and Don'ts
- Prefer specific product references and negative constraints already in `DESIGN.md` (“Clear Field Ledger”, two-channel status, earned elevation) over adjective lists (“modern, clean, premium”)
- Optional agent tooling (not a runtime app dependency): `npx @google/design.md lint DESIGN.md` after meaningful token/prose edits

### 0.2 Impeccable skill

- Skill: **impeccable** (`~/.agents/skills/impeccable` or harness equivalent)
- Register for this product: **product** (app UI serves the task; see root `PRODUCT.md` → `register: product`)
- Before UI implementation phases, load product context:
  - Root **`PRODUCT.md`** (users, anti-references, principles)
  - Root **`DESIGN.md`** (palette, elevation, do’s/don’ts)
- Apply **shared design laws** and **product register** rules, especially:
  - Color strategy: **Restrained** (tinted neutrals + accent ≤ ~10% of a task screen)
  - No pure black/white; OKLCH-tinted neutrals (already in CSS / DESIGN.md)
  - Absolute bans: side-stripe accents, gradient text, decorative glass, hero-metric template, nested cards, modal-as-first-thought
  - Product slop test: earned familiarity (Linear / Notion / Stripe-class tools), not decorative strangeness
  - Consistency over surprise; system fonts / Inter are legitimate; fixed rem type scale
  - Motion: 150–250ms state feedback only; no page-load choreography; honor `prefers-reduced-motion`
  - Components need full lifecycle states where introduced (default / hover / focus / disabled / loading / error)
- Useful Impeccable sub-flows for this program (not all required each task):
  - **shape** before large shell changes (mobile nav, Yeni iş)
  - **adapt** for breakpoint/container work
  - **layout** for surface hierarchy
  - **clarify** for password hints and chip labels
  - **audit** / **polish** before PR closeout

### 0.3 Precedence when guidance conflicts

```text
1. Servora-Med domain rules (AGENTS.md, JobCard approval, roles)
2. Root PRODUCT.md + DESIGN.md (project SSOT)
3. This slice design + implementation plan (scope and sequencing)
4. Impeccable product register + shared laws
5. Google DESIGN.md format conventions
```

Never invent domain behavior for visual polish. Never add a UI framework solely to satisfy a skill recipe.

## 1. Problem

Servora-Med’s UI is **consistent and accessible**, but:

1. **Visual hierarchy is flat** — canvas, filters, lists, and actions share the same white surface language.
2. **Mid-width viewports squeeze controls** — multi-column filter grids only collapse under `720px`, while desktop shell/sidebar starts near `64rem` (~1024px), so filters and Kanban can clip or feel cramped.
3. **Button/select systems are fragile** — `.primary-button` defaults to full width; some selects sit outside `.field-group` styling.
4. **Mobile feels like a responsive admin panel**, not a field staff daily tool — drawer-only nav, three separate “Yeni …” actions, filters as long inline forms, list rows only stack rather than recompose as cards.
5. **Micro-copy gaps** — password rules (12–128 chars) appear mainly after failure; priority (acil/yüksek) emphasis is weak.

This is **not** a brand or full redesign. It is focused polish on responsive layout, control primitives, hierarchy, and mobile shell — without leaving MVP modular-monolith boundaries.

## 2. Goals

| Goal | Success signal |
|------|----------------|
| No control clipping at 390 / 768 / 1024 / 1440 | Filters, selects, buttons fully visible; no reliance on body overflow clip to hide broken layout |
| Clear hierarchy | User can distinguish surface vs action vs status without reading labels alone |
| One primary create action on Jobs | “Yeni iş” opens meeting / task / delivery choices |
| Shared FormControl + Button contracts | New screens cannot accidentally full-bleed primary in toolbars |
| Mobile shell usable for field staff | Title + bottom nav + sticky create; filters via sheet pattern |
| Micro-hints before error | Password length and priority chips visible up front |

## 3. Non-goals

- Native app rewrite, React Native, or heavy design system libraries  
- Full PWA offline shell / install prompt (evaluate only in P2 note)  
- Backend/API domain changes, migrations, new npm runtime dependencies (default: **none**)  
- Kanban drag-and-drop redesign  
- Advanced BI / chart redesign (reports decision panel already shipped)  
- Changing role/permission rules  

## 4. Design principles

Aligned with `PRODUCT.md` principles and Impeccable **product** register; phrased for this polish slice:

1. **Sade, not düz** — reduce sameness via Canvas / Surface / Raised (DESIGN.md elevation), not decoration.  
2. **Container-aware layout** — prefer usable content width over raw viewport-only breakpoints where practical (`adapt`).  
3. **Two-channel status** (DESIGN.md) — color never alone; text + shape/background for priority and status chips.  
4. **Primary means “main next step”**, not “100% width” (one primary action per region).  
5. **Mobile action, desktop oversight** (`PRODUCT.md`) — recompose lists/nav; do not shrink desktop Kanban onto phone.  
6. **Surgical CSS/components** — no global restyle of every pixel; fix systems first, then high-traffic screens.  
7. **Earned familiarity** — standard nav, forms, menus; no reinvented affordances for flavor.  
8. **AI slop / category reflex** — reject healthcare teal cliché, identical SaaS card grids, side-stripes, gradient text (already in DESIGN.md Don’ts).

## 5. Surface system (three levels)

Maps to DESIGN.md **Elevation** (“flat by default”, earned elevation) and Impeccable “don’t wrap everything in a card”:

```text
Canvas   → --canvas / Quiet Canvas (nav, chrome)
Surface  → --paper / Daylight Paper (main content)
Raised   → menu, popover, mobile sheet, sticky create (shadow only if layer is real)
```

Apply Surface sparingly to: KPI/filter blocks, detail summary, critical action bars.  
Do **not** wrap every list row in a heavy card on desktop. Nested cards are forbidden.

When implementation introduces new component tokens (button widths, priority chips, sheet), update root **`DESIGN.md`** Components (and prose if rationale changes) in the same phase so agent context stays honest.

## 6. Breakpoint strategy

| Token | Approx | Use |
|-------|--------|-----|
| Mobile | ≤40rem | Single column, bottom nav, sheets |
| Tablet / mid | ≤48–56rem | Filters 1–2 cols early (fix mid-band clip) |
| Shell desktop | ≥64rem | Sidebar layout (existing) |
| Wide board | **Container** ~68–70rem inline-size preferred; fallback viewport ≥90rem | Full 5-column Kanban |

**Kanban:** Gate on **usable board container width**, not a bare `min-width: 80rem` viewport alone. Preferred: container query on the board region (`inline-size >= ~68–70rem`). Fallback: `min-width: 90rem` viewport. At 1024px with sidebar, five equal columns must stay closed. Board workspace may exceed the default ~68rem content max when the board is open.

**Filters:** Collapse multi-column job/customer filter grids at **≤56rem** (not only 720px). Report filters may stay later.

## 7. Component contracts

### Button (CSS only this slice)

```text
variant: primary | secondary | destructive | ghost
size: btn-sm | btn-md
width: content default; .btn-full or .form-actions for 100%
NO new React Button.tsx abstraction
```

### FormControl (CSS only this slice)

Shared class/selector contract for inputs, selects, textareas. Bare selects migrate into the same structure. No full form-tree React refactor.

### Status & priority chips (both in P0.5)

**Both** StatusChip and PriorityChip ship in Task 2. Soft fill + Turkish label (two-channel). No side-stripe.

## 8. Jobs create: single primary

```text
[ Yeni iş ▾ ]
  ├─ Yeni görüşme
  ├─ Yeni görev
  └─ Yeni teslim
```

- Desktop: disclosure popover; **no focus trap**; Escape + focus return  
- Mobile sheet: if true modal layer, focus containment + restore to trigger  
- When sticky mobile create is shown, toolbar must **not** show a second Yeni iş primary  
- Routes unchanged  

## 9. Mobile shell

**Single top bar** (do not stack a second PageHeader under brand chrome):

```text
optional back | section title (one metadata source) | profile/overflow
```

No duplicate large visual title + content `h1` for the same label.

**Navigation SSOT:** `buildNavigationModel(user)` feeds sidebar, drawer, bottom nav, and overflow. No second destination list.

**Menü (Manager/Admin)** is a **button** that opens the existing drawer, not a route.

**Staff bottom:** İşler | Müşteriler | Ürünler | Profil  
**Manager/Admin bottom:** İşler | Müşteriler | Raporlar | Menü  

**Filters (mobile):** Jobs sheet **first** (required), then Customers (same primitive). Open → draft from URL; Apply → URL + close; Clear → defaults; Escape → discard; active count on trigger.

## 10. Phases (implementation order)

| PR | Phase | Deliverable |
|----|-------|-------------|
| **A** | T0 + P0.5 + P0 | DESIGN.md sections; password hints; Status+Priority chips; filters; Kanban; selects; **browser smoke** |
| **B** | P1a | Button CSS; surface hierarchy (T6.5); Yeni iş |
| **C** | P1b | Unified top bar; shared nav model; bottom nav |
| **D** | P1c | Job+Customer filter sheets; mobile job cards |
| — | P2 note | PWA only documented, not required |

Each PR mergeable alone with its own test/build/audit (+ P0 browser smoke on PR A).

## 11. Verification matrix

| Viewport | Checks |
|----------|--------|
| 390×844 | Bottom nav, sticky create, filters sheet, no horizontal clip of primary controls |
| 768 | Tablet filters, readable tables/cards |
| 1024 | Sidebar on; filters/board usable; no cut-off selects |
| 1440 | Comfortable multi-column filters; Kanban 5-col if gated open |

Automated: Vitest static/markup contracts + existing a11y patterns; optional Playwright smoke later (not blocking P0.5/P0 if markup tests suffice).

## 12. Risks

| Risk | Mitigation |
|------|------------|
| CSS blast radius | Prefer modifiers + scoped sections; avoid rewriting all pages at once |
| Bottom nav covering content | `padding-bottom` on main; safe-area insets |
| Yeni iş menu a11y | Keyboard + aria-expanded + Escape |
| Scope creep into PWA/offline | Explicit non-goal until P2 decision |

## 13. DESIGN.md / PRODUCT.md maintenance during this work

| Change in UI | Update required? |
|--------------|------------------|
| New CSS tokens or renamed surfaces | Yes → `DESIGN.md` colors / elevation / components |
| Button width contract, chips, bottom nav, sheets | Yes → `DESIGN.md` Components + short prose |
| Password / priority microcopy only | Optional clarify note; no PRODUCT.md change |
| Role/permission or domain wording | PRODUCT.md only if product principles shift (unlikely this slice) |

Do not let implementation drift from root `DESIGN.md`. Prefer editing DESIGN.md over inventing parallel “theme notes” in feature folders.

## 14. Approval gate

```text
Skill refs (design.md + impeccable) → §0 of this document
Product SSOT                       → PRODUCT.md + DESIGN.md
Design direction                   → this document
Implementation                     → docs/superpowers/plans/2026-07-16-ui-responsive-hierarchy.md
Start work                         → after user approval of design + plan
Second redesign                    → not required if plan tasks stay in scope
```
