---
name: Servora-Med
description: Reliable, simple, and orderly product UI for mobile field action and desktop operational oversight.
---

# Design System: Servora-Med

## Overview

**Creative North Star: "The Clear Field Ledger"**

Servora-Med should feel like a carefully maintained field ledger translated into a modern product interface. Information is calm, structured, and immediately trustworthy. The surface gives staff enough guidance to act quickly on a phone while preserving the density managers need to oversee work on a desktop.

The physical scene is a field employee using a phone in a bright clinic corridor and a manager scanning approvals on a desktop during a busy workday. This requires a light-first, high-contrast system with restrained color, readable controls, visible focus, and no dependence on subtle translucency. Dark mode is not assumed; it can be designed later from measured need.

The reference blend is Notion's calm, Linear's order, and Apple's immediate interaction feedback. None is copied. The system explicitly rejects heavy ERP density, toy-like Trello color, sterile hospital software, vague Notion freedom, decorative Apple imitation, formal bank-software severity, social-media notification pressure, and desktop layouts shrunk onto mobile.

Motion energy is responsive: immediate press and state feedback, short transitions, and no entrance choreography. Direct-manipulation physics are reserved for a real gesture such as a mobile sheet or drawer. Business state never changes through momentum or decorative movement.

**Key Characteristics:**

- Restrained, light-first surfaces with one low-chroma mineral-blue accent
- Mobile action and desktop oversight as distinct responsive structures
- Structured density without small-font ERP compression
- Semantic color used only when it carries operational meaning
- Flat by default, with elevation earned by interaction or hierarchy
- WCAG 2.2 Level AA as a design and completion constraint

## Colors

The implemented palette uses warm, lightly tinted neutrals and a low-chroma mineral-blue accent. Values below are the current CSS tokens and remain subject to WCAG contrast regression checks when components change.

### Primary

- **Mineral Blue** (`oklch(47% 0.105 238deg)`): Primary actions, current selection, and the smallest set of active state indicators. Focus uses the related `oklch(58% 0.14 238deg)` token.

### Neutral

- **Daylight Paper** (`oklch(98.5% 0.004 235deg)`): Main content background; softly tinted rather than pure white.
- **Quiet Canvas** (`oklch(95.5% 0.009 235deg)`): Navigation, toolbar, and grouped-workflow background.
- **Graphite Ink** (`oklch(26% 0.016 246deg)`): Primary text; tinted rather than pure black.
- **Muted Record** (`oklch(47% 0.018 246deg)`): Secondary text and supporting metadata.
- **Soft Rule** (`oklch(86% 0.012 238deg)`): Borders and dividers that clarify grouping without boxing every element.

### Semantic

- **Critical Red** (`oklch(44% 0.14 28deg)`): Errors and destructive outcomes only.
- **Delay Amber** (`oklch(39% 0.08 70deg)` on `oklch(95% 0.025 80deg)`): Warnings, lateness, and attention states only.
- **Confirmed Green** (`oklch(38% 0.08 150deg)` on `oklch(95% 0.025 150deg)`): Successful completion and approval only.
- **Information Blue** (`oklch(41% 0.105 238deg)` on `oklch(92% 0.025 238deg)`): Neutral informational state when the primary accent would imply action.

**The Restrained Signal Rule.** Tinted neutrals carry the interface. Mineral Blue occupies no more than roughly ten percent of a typical task screen. Semantic colors are not decoration.

**The Two-Channel Rule.** Color never carries status alone. Every priority, delay, approval, warning, and error also uses text, iconography, shape, or position.

**The No-Pure-Extremes Rule.** Pure black and pure white are prohibited. Neutrals retain a subtle relationship to the primary hue without becoming visibly blue.

## Typography

**Direction:** The implemented stack is `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`, preserving platform-native fallbacks when Inter is unavailable.

**Character:** Clear and contemporary without feeling clinical, technical, or decorative. The family must remain highly legible in Turkish, dense operational lists, form labels, quantities, dates, and status metadata.

### Hierarchy

- **Display:** Reserved for rare empty-state or onboarding headings. Product screens do not use oversized marketing typography.
- **Headline:** Clear page identity with one decisive weight step above body text.
- **Title:** Section, JobCard, and panel titles that remain scannable in compact layouts.
- **Body:** Comfortable reading with prose capped around 65 to 75 characters; dense data may run wider when structure requires it.
- **Label:** Explicit form and control labels with sufficient size and weight. Placeholder text never replaces a label.
- **Data:** Tabular numerals for quantities, dates, counters, and time-sensitive operational values when supported by the chosen family.

**The Operational Scale Rule.** Type hierarchy is produced through size and weight, not uppercase decoration, excessive tracking, or display fonts in controls.

**The No-Small-ERP Rule.** Information density may increase on desktop, but body text, metadata, and controls never shrink merely to fit more columns.

## Layout

```yaml
layout:
  workspace-max: 68rem
  board-container-min: 68rem
  shell-sidebar-min: 64rem
  filter-collapse-max: 56rem
  mobile-max: 40rem
  board-viewport-fallback-min: 90rem
```

**Workspace.** Default operational content sits in a readable column capped near `{layout.workspace-max}`. The JobCard board may use a wider usable region when the board gate is open, but density must remain scannable, not ERP-compressed.

**Shell.** At `{layout.shell-sidebar-min}` and above, navigation uses a persistent sidebar. Below that threshold, navigation is mobile chrome (single top bar, drawer overflow, and bottom destinations). Layout decisions should prefer **usable content width** after chrome is accounted for, not raw viewport alone.

**Responsive structure.**

- **Mobile** (≤ `{layout.mobile-max}`): single column, bottom destinations, sheets for filters and create menus, list/card composition for jobs.
- **Tablet / mid** (through `{layout.filter-collapse-max}`): multi-column filter toolbars collapse early enough to prevent mid-band clipping (approximately 721–860px was a known failure band when collapse only happened at 720px).
- **Desktop shell** (≥ `{layout.shell-sidebar-min}`): sidebar + denser lists/tables.
- **Wide board:** prefer container query on the board region (`inline-size` ≥ ~`{layout.board-container-min}` to ~70rem). Fallback viewport gate: ≥ `{layout.board-viewport-fallback-min}`. Five equal Kanban columns must not open at 1024px with a sidebar.

**The Mobile Action Rule.** Phone layouts optimize one-hand JobCard action. Desktop layouts optimize manager oversight. Mobile is not a shrunk desktop board.

## Elevation

Servora-Med is flat by default. Background tone, spacing, grouping, and clear borders establish most hierarchy. Shadows appear only when a surface truly sits above another surface, such as a menu, popover, mobile sheet, or a JobCard actively lifted by direct manipulation.

Translucency and blur are not part of the base identity. A functional sheet may use subtle separation only after contrast and reduced-transparency fallbacks are defined.

**The Earned Elevation Rule.** A shadow indicates a real layer or interaction state. If removing the shadow does not make the hierarchy less understandable, the shadow is forbidden.

**The One-Surface Rule.** Nested cards and glass panels are prohibited. Group related content through layout before adding another container.

**Surface levels (product polish):**

```text
Canvas  → Quiet Canvas (shell / page frame)
Surface → Daylight Paper panels (filters, detail summary, calm grouping)
Raised  → menus, popovers, mobile sheets, sticky create (earned elevation only)
```

Desktop job list rows stay flat. Do not card-wrap every row.

## Shapes

```yaml
rounded:
  control: 0.6rem
  button: 0.6rem
  chip: 999px
  raised: 0.75rem
  brand-mark: 0.55rem
```

Controls and buttons share a modest radius (`{rounded.control}` / `{rounded.button}`) so forms feel consistent. Status and priority chips use a pill (`{rounded.chip}`). Raised layers (sheet, popover) may use a slightly larger radius (`{rounded.raised}`) without becoming soft “bubble” UI.

Corners stay quiet. Radius is not a brand flourish; it only keeps touch targets and grouping readable.

## Components

```yaml
components:
  button-primary:
    backgroundColor: "oklch(47% 0.105 238deg)"
    textColor: "oklch(98.5% 0.004 235deg)"
    rounded: 0.6rem
  form-control:
    height: 2.75rem
    rounded: 0.6rem
    padding: 0.72rem
  status-chip:
    rounded: 999px
  priority-chip:
    rounded: 999px
```

### Button

Variants: **primary**, **secondary**, **destructive**, **ghost**. Sizes: **btn-sm** (alias: `compact-button`), **btn-md**.  
**Width is content by default.** Full width is explicit (`.btn-full`) or reserved for stacked form footers (login, people/task/delivery forms). Primary does not mean “span the row.”  
This slice keeps a **CSS class contract**; it does not introduce a separate React `Button` abstraction.

### Surfaces

- **Surface** (`.surface`): calm grouping for job filters and detail summary.
- **Surface-flat** (`.surface-flat`): lifecycle action bar; clear but not elevated.
- **Raised** (`.surface-raised`): Yeni iş menu / mobile sheet, popovers.
Desktop list rows stay flat (no card wrappers, no side-stripe accents).

### FormControl

Text inputs, selects, and textareas share padding, border, radius, min-height, hover, focus, disabled, optional hint (`aria-describedby`), and error presentation. Bare selects (for example staff profile filters) must join this contract rather than native-unstyled outliers.

### Status and priority chips

Both are required for operational scanning. Soft fill + visible Turkish label (and optional non-color shape). Color never alone. No left side-stripe accents on cards or chips.

### New job control

One primary **Yeni iş** control. Desktop: disclosure menu without focus trap; Escape returns focus. Mobile: bottom sheet with focus containment when presented as a modal layer. Routes remain the existing create flows.

### Mobile top bar

A **single** sticky top bar: optional back, section title from one route-metadata source, profile or overflow. Do not stack a second header under brand chrome. Avoid a large duplicate visual title in content for the same section name.

### Bottom navigation and Menü

Destinations come from one navigation model shared with sidebar and drawer. Manager/Admin **Menü** is a **button** that opens the existing drawer (not a route). Overflow holds lower-frequency items (Personel, Kullanıcılar, Oturumu kapat). Closing restores focus to the Menü trigger.

### Job lifecycle guidance (detail-first)

These surfaces use existing design tokens, surface levels, button variants, and chip rules.
They do not introduce a second visual system or a new dependency.

- **Lifecycle stepper** (`.job-lifecycle-steps`): ordered list of presentation phases
  (`Oluşturuldu` → `Planlandı` → `Uygulanıyor` → `Yönetici kontrolü` → `Tamamlandı`).
  Current step uses `aria-current="step"`. Complete, current, skipped (`Planlama atlandı`),
  attention (revision loop), and upcoming states use text/icon semantics plus restrained
  color—never color alone. Mobile: vertical. Desktop: five-column when space permits;
  fall back to compact vertical without horizontal page scroll.
- **Responsibility panel**: calm Surface grouping that states who should act next and what
  consequence follows the primary command. Management intervention outside review stays
  secondary even when allowed.
- **Requirements checklist**: backend requirement codes mapped to Turkish labels; met /
  missing / invalid states remain scannable for Staff during execution and correction.
- **Approval review panel**: Manager/Admin summary of submission facts and readiness before
  decision controls. Primary decision is **Kontrolü tamamla ve işi kapat** (confirmation
  required); secondary is **Düzeltme için personele geri gönder** with mandatory reason.
- **Workflow dialogs**: confirmation for completion and withdraw-to-edit; reason capture for
  revision and cancel. Contain focus, support Escape when safe, restore focus to the opener,
  disable controls while pending, announce status/errors via live regions.
- **Terminal banner**: cancellation is not a green completion. Banner shows actor, time,
  reason, and frozen source phase; completed state uses Confirmed Green only for true
  success.
- **Compact workflow summary** (list/board): ordinal phase string such as
  `3 / 5 · Uygulanıyor` with optional attention flag. Secondary to the technical status
  chip; never replaces board column status labels.
- **Accessibility / responsive**: ≥ 44×44 CSS px targets, visible focus, 200% text and 400%
  reflow without clipped meaning or horizontal task scroll, `prefers-reduced-motion`
  disables optional workflow motion, one primary action per responsibility region on mobile.

## Do's and Don'ts

### Do:

- **Do** design mobile workflows around one-hand action and desktop workflows around operational scanning.
- **Do** use familiar navigation, form, list, table, menu, and disclosure patterns.
- **Do** show JobCard status, customer, assignee, date, priority, delivery purpose, and quantity with a controlled hierarchy.
- **Do** provide immediate press feedback and short state transitions without delaying the action.
- **Do** use explicit accessible lifecycle commands; the current board is read-only and does not implement drag or swipe transitions.
- **Do** design default, hover, focus, active, disabled, loading, error, empty, forbidden, retry, and stale-version states.
- **Do** keep focus visible and interaction targets at least 44 by 44 CSS px where applicable.
- **Do** support `prefers-reduced-motion`; later translucent surfaces must also support reduced-transparency and increased-contrast preferences where the platform exposes them.
- **Do** validate typography, contrast, zoom, reflow, keyboard order, touch behavior, and screen-reader semantics in real workflows.

### Don't:

- **Don't** create small-font, table-heavy, exhausting ERP screens.
- **Don't** make every Kanban card a different color or imitate a toy-like Trello board.
- **Don't** produce cold, old, form-only sterile hospital software.
- **Don't** copy Notion's whitespace or freedom in a way that obscures required commercial data.
- **Don't** imitate Apple with oversized whitespace, excessive animation, heavy blur, decorative glass, sound, or haptics.
- **Don't** use dark navy, gray, and small type to manufacture a formal bank-software identity.
- **Don't** add distracting badges, saturated color, or notification pressure from social-media patterns.
- **Don't** shrink desktop Kanban into a crowded mobile viewport.
- **Don't** use generic healthcare white and bright turquoise as an automatic category theme.
- **Don't** use identical SaaS card grids, gradient text, side-stripe accents, hero-metric templates, or nested cards.
- **Don't** use bounce, elastic easing, confetti, particles, parallax, staggered list entrances, or page-load choreography.
- **Don't** let momentum, drag distance, or animation bypass backend JobCard transition rules.
- **Don't** use color as the only carrier of status, priority, lateness, warning, success, or error.
- **Don't** reach for a modal before inline disclosure, a dedicated page, or a non-blocking panel has been considered.
