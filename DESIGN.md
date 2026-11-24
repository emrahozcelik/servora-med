---
name: Servora-Med
description: Reliable, simple, and orderly product UI for mobile field action and desktop operational oversight.
---

# Design System: Servora-Med

## Overview

**Creative North Star: "The Clear Field Ledger"**

Servora-Med (platform name; rendered to end users under the white-label **Dünya Dental** identity) should feel like a carefully maintained field ledger translated into a modern product interface. Information is calm, structured, and immediately trustworthy. The surface gives staff enough guidance to act quickly on a phone while preserving the density managers need to oversee work on a desktop.

The physical scene is a field employee using a phone in a bright clinic corridor and a manager scanning approvals on a desktop during a busy workday. This requires a light-first, high-contrast system with restrained color, readable controls, visible focus, and no dependence on subtle translucency. Dark mode is not assumed; it can be designed later from measured need.

The reference blend is Notion's calm, Linear's order, and Apple's immediate interaction feedback. None is copied. The system explicitly rejects heavy ERP density, toy-like Trello color, sterile hospital software, vague Notion freedom, decorative Apple imitation, formal bank-software severity, social-media notification pressure, and desktop layouts shrunk onto mobile.

Motion energy is responsive: immediate press and state feedback, short transitions, and no entrance choreography. Direct-manipulation physics are reserved for a real gesture such as a mobile sheet or drawer. Business state never changes through momentum or decorative movement.

**Key Characteristics:**

- Restrained, light-first surfaces with one low-chroma mineral-blue accent
- Mobile action and desktop oversight as distinct responsive structures
- Structured density without small-font ERP compression
- Semantic color used only when it carries operational meaning
- Purpose-layered surfaces: cards, emphasis, and elevation are used when they clarify subject, urgency, or interaction
- WCAG 2.2 Level AA as a design and completion constraint

## Colors

The implemented palette uses warm, lightly tinted neutrals and a low-chroma mineral-blue accent. These values are the current baseline, not an immutable brand lock. A coordinated palette revision is allowed when it is performed through the canonical token contract, Ant theme mapping, contrast regression tests, and representative browser evidence. Screen-level one-off colors remain prohibited.

**Token source rule.** `servora-visual-tokens.ts` is the canonical implementation source for visual token values. DESIGN.md describes semantic intent and may show examples, but copied token values here MUST NOT become a competing source of truth. No token values change under this rule.

### Primary

- **Mineral Blue** (`--accent`, with `--accent-hover`, `--accent-soft`, and focus ring `--focus` defined in `servora-visual-tokens.ts`): Primary actions, current selection, and the smallest set of active state indicators.

### Neutral

- **Daylight Paper** (`--paper`): Main content background; softly tinted rather than pure white.
- **Quiet Canvas** (`--canvas`, over `--frame` page background and `--surface-hover` hover tint): Navigation, toolbar, and grouped-workflow background.
- **Graphite Ink** (`--ink`): Primary text; tinted rather than pure black.
- **Muted Record** (`--muted`): Secondary text and supporting metadata.
- **Soft Rule** (`--rule`, plus `--border-control` / `--border-control-hover` for interactive inputs): Borders and dividers that clarify grouping without boxing every element.

### Semantic

- **Critical Red** (`--error`, `--error-soft`, `--error-wash`): Errors and destructive outcomes only.
- **Delay Amber** (`--warning`, `--warning-soft`, `--warning-wash`): Warnings, lateness, and attention states only.
- **Confirmed Green** (`--success`, `--success-soft`): Successful completion and approval only.
- **Information Blue** (`--info`, `--info-soft`): Neutral informational state when the primary accent would imply action.

**The Concentrated Signal Rule.** Primary and semantic colors should clarify hierarchy, selection, urgency, and outcome without flooding the interface. There is no fixed percentage cap, but repeated saturated accents, decorative gradients, and color-only status remain prohibited.

**The Two-Channel Rule.** Color never carries status alone. Every priority, delay, approval, warning, and error also uses text, iconography, shape, or position.

**The No-Pure-Extremes Rule.** Pure black and pure white are prohibited. Neutrals retain a subtle relationship to the primary hue without becoming visibly blue.

## Typography

**Direction:** The implemented stack is `'Source Sans 3 Variable', 'Source Sans 3', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. The variable font is self-hosted through `@fontsource-variable/source-sans-3` (no CDN; `latin-ext` covers Turkish glyphs), with platform-native fallbacks. `servora-visual-tokens.ts` owns the canonical family string. Source Sans 3 replaced Plus Jakarta Sans on 2026-11-24 (owner choice): Jakarta's wide geometric forms and tight word spacing crowded dense Turkish text. The owner chose Source Sans 3 from a side-by-side render of Inter, IBM Plex Sans and Source Sans 3 on the job-detail guidance screen at 390 px; it is compact and open, so dense lists, numbers and dates stay legible.

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

**Shell.** At `{layout.shell-sidebar-min}` and above, navigation uses a persistent sidebar. Below that threshold, navigation is mobile chrome (single top bar, bottom destinations, and one menu panel). The 768–1023 band intentionally keeps mobile chrome; there is no separate tablet shell in this contract. Layout decisions should prefer **usable content width** after chrome is accounted for, not raw viewport alone.

**Responsive structure.**

- **Mobile** (≤ `{layout.mobile-max}`): single column, bottom destinations, sheets for filters and create menus, list/card composition for jobs.
- **Tablet / mid** (through `{layout.filter-collapse-max}`): multi-column filter toolbars collapse early enough to prevent mid-band clipping (approximately 721–860px was a known failure band when collapse only happened at 720px).
- **Desktop shell** (≥ `{layout.shell-sidebar-min}`): sidebar + denser lists/tables.
- **Wide board:** prefer container query on the board region (`inline-size` ≥ ~`{layout.board-container-min}` to ~70rem). Fallback viewport gate: ≥ `{layout.board-viewport-fallback-min}`. Five equal Kanban columns must not open at 1024px with a sidebar.

**The Mobile Action Rule.** Phone layouts optimize one-hand JobCard action. Desktop layouts optimize manager oversight. Mobile is not a shrunk desktop board.

## Elevation and purpose-layered surfaces

Servora-Med uses layers according to purpose rather than enforcing flatness as an end in itself. Background tone and spacing remain the first tools for hierarchy, but cards, borders, tonal fills, and restrained shadows are allowed when they make a subject, deadline, action group, or selected state easier to understand.

Translucency and blur are not part of the base identity. A functional overlay may use subtle separation only after contrast and reduced-transparency fallbacks are defined.

**The Purpose-Layer Rule.** A layer must communicate at least one concrete distinction: a single subject, a grouped action, a selected item, operational urgency, or a true overlay. Decorative containers with no information role are prohibited.

**The No-Container-Stack Rule.** Card-inside-card and repeated framed wrappers remain prohibited unless the inner element is an independently actionable record and the responsive DOM remains understandable without visual nesting.

**Surface levels:**

```text
Canvas          → shell / page frame
Section         → broad content grouping without a mandatory border
Card            → one subject, metric, record summary, or action group
Emphasized Card → new, upcoming, attention, overdue, selected, or successful state
Raised Layer    → drawer, modal, popover, dropdown, sticky interaction layer
```

A subtle default card shadow is permitted when it materially improves separation from the canvas; it must remain tokenized and lighter than overlay elevation. Operational emphasis should usually combine tonal background, border, label/icon, and explicit text before increasing shadow.

Desktop job-list rows may remain flat when table/list scanning is superior. Dashboard widgets, calendar agenda entries, profile summaries, help categories, settings groups, and other independently understandable subjects may use Servora-owned Card adapters.

## Shapes

```yaml
rounded:
  control: 0.6rem
  button: 0.6rem
  chip: 999px
  raised: 0.75rem
  brand-mark: 0.55rem
```

Controls and buttons share a modest radius (`{rounded.control}` / `{rounded.button}`) so forms feel consistent. Status and priority chips use a pill (`{rounded.chip}`). Raised layers (sheet, popover) may use a slightly larger radius (`{rounded.raised}`) without becoming soft "bubble" UI.

Corners stay quiet. Radius is not a brand flourish; it only keeps touch targets and grouping readable.

## Components

```yaml
components:
  button-primary:
    backgroundColor: "var(--accent) (via servora-visual-tokens.ts)"
    textColor: "var(--paper)"
    rounded: 0.6rem
  form-control:
    height: 2.75rem
    rounded: 0.6rem
    padding: 0.72rem
  status-chip:
    rounded: 999px
  priority-chip:
    rounded: 999px
  card:
    rounded: 0.75rem
    border: "Soft Rule"
    shadow: "tokenized subtle card separation"
  emphasized-card:
    channels: "tone + border + icon/label + explicit text"
```

### Ant Design foundation

Ant Design (exact-pinned in `web/package.json`, currently `6.7.0`) is the runtime
library for reviewed complex primitives. `DESIGN.md` and `servora-visual-tokens.ts` remain
the source of truth for visual tokens, interaction rules, responsive structure, and
accessibility. Production modules outside `web/src/ui/antd/` must not import Ant Design
directly; feature screens consume Servora-owned adapters instead of raw primitives.

The application root pairs `ConfigProvider` with Ant Design `App`, uses the
`servora-ant` class prefix and Turkish locale, maps the canonical Servora tokens
through `servoraAntTheme`, and keeps popup layers at the document-body viewport
level. Feedback is obtained only through the owned `useAppFeedback` hook so it
inherits provider context. Optional Ant motion is disabled when
`prefers-reduced-motion: reduce` is active.

This foundation does not adopt Ant Design `Layout` or `Menu`, does not replace the Servora shell or navigation model, and does not authorize a mass migration to Ant `Form`. Ant `Card`, `Calendar`, `Statistic`, `Result`, `Progress`, `Popconfirm`, `Notification`, `Avatar`, `Badge`, `Segmented`, `Descriptions`, `Collapse`, `Tabs`, `Drawer`, `Skeleton`, `Empty`, `Tooltip`, and related reviewed primitives are authorized through Servora-owned adapters when they improve comprehension, accessibility, or maintenance. Direct feature-level static message, notification, modal, or raw component imports remain prohibited.

### Ant component adoption policy

Ant Design is an implementation resource, not the visual source of truth. Feature modules express Servora domain concepts; adapters own Ant imports, semantic slot styling, theme mapping, responsive behavior, and accessibility fixes.

**Reuse or extend existing adapters before adding new wrappers:**

```text
ResultState
EmptyState
LoadingSkeleton
RecordDescriptions
ResponsiveDrawer / ResponsiveFormDrawer
CompactConfirmationAction
ConfirmationAction
ReasonDialog
WorkflowSteps
ActivityTimeline
OperationalCard
MetricStatistic
ServoraCalendar
UserAvatar
IconSegmented
ContentCollapse / ContentAnchor
SettingsTabs
ServoraTable / StaffPerformanceTable
ServoraPagination / ServoraListPagination
ServoraSelect
ServoraCheckbox
useAppFeedback
```

Future Ant adapter families (such as `ServoraProgress`) require repository preflight to confirm genuine need before being added.

Do not wrap every Ant component merely to rename it. Create an adapter when Servora needs stable domain props, token/semantic styling, accessibility behavior, responsive behavior, or an import boundary.

### Card and operational emphasis

Ant Card semantic slots (`root`, `header`, `title`, `extra`, `body`, `actions`) may be styled through owned `classNames` and `styles`. These slot APIs improve styling control but do not automatically choose the correct outer HTML semantics. Independent records remain wrapped or rendered as appropriate `article`, `li`, `section`, or link structures with stable accessible names.

Recommended operational tones:

```text
default   → ordinary subject
new       → newly created/unread, with explicit "Yeni" text
upcoming  → approaching deadline, with remaining-time text
attention → action required or revision requested
overdue   → missed deadline, with explicit overdue text
success   → genuinely completed/approved result
selected  → current calendar/message/list selection
```

Color never acts alone. Every non-default tone needs a visible label, icon, status phrase, time phrase, or structural cue. Do not represent a continuously changing deadline only through a stale color class; derive the phrase from server-authoritative time or a bounded client clock strategy.

### Result

Use the existing `ResultState` adapter for 403, 404, 500, blocking error, success, warning, and completed-flow feedback. Full-page Result is appropriate when the current route cannot continue or an operation has reached a clear endpoint. Use a compact in-page Result when the surrounding record must remain visible. A completed JobCard may show a success result/banner with next actions, but it must not hide the authoritative completed record or timeline.

### Progress

Use Progress only for a real percentage, known step completion, or operation expected to take more than roughly two seconds. Do not invent percentages for indeterminate server work. Job lifecycle remains `Steps` unless the domain owns a real numeric completion value.

A notification `showProgress` bar represents the remaining auto-close duration of that notification; it is not task progress. Actual upload/import/export progress must be driven by measured operation data and rendered with `ServoraProgress` or an equivalent owned surface.

### Popconfirm and confirmation dialogs

Use `CompactConfirmationAction` / Popconfirm for short, low-complexity confirmations that need no additional input. Use `ConfirmationAction` or `ReasonDialog` when the user must review consequences, enter a reason, resolve conflicts, or confirm an irreversible/destructive workflow. Never combine `window.confirm` or `window.prompt` with the Servora interaction system.

### Notifications

All message/notification APIs are obtained through `useAppFeedback`. Auto-closing informational notifications may use `showProgress` and `pauseOnHover`. Persistent errors, security notices, or actions requiring a decision must not disappear solely on a timeout. Notification copy and progress styling use canonical Servora tokens and privacy-safe payloads.

### Avatar and Badge

Use an owned Avatar with initials fallback. Image upload remains gated by storage and image-security requirements. Badge may communicate unread count, verified/active state, or another real status. Presence dots and "online" claims are prohibited unless the product has an authoritative presence model.

### Segmented controls

Segmented controls are suitable for small mutually exclusive view or period choices such as `Ay / Ajanda`, `Bugün / 7 gün / 30 gün`, or icon-supported dashboard modes. Prefer icon + visible label. Icon-only items require an accessible name, tooltip where helpful, familiar meaning, and no ambiguity at 200% text zoom.

### Performance and bundle guardrails

Expanded Ant use is allowed under measured budgets:

- preserve route-level lazy loading,
- import reviewed components only inside owned adapter modules,
- keep the existing per-chunk bundle budget and report deltas in each visual PR,
- avoid rendering unbounded Card, Calendar, Timeline, Table, or message collections,
- use pagination, bounded summaries, or virtualization where scale requires it,
- avoid decorative animation and repeated timers,
- profile only when a real interaction or render regression is observed,
- do not reject a useful component based on generic "Ant is heavy" assumptions without bundle/runtime evidence.

### Button

Variants: **primary**, **secondary**, **destructive**, **ghost**. Sizes: **btn-sm** (alias: `compact-button`), **btn-md**.
**Width is content by default.** Full width is explicit (`.btn-full`) or reserved for stacked form footers (login, people/task/delivery forms). Primary does not mean "span the row."
This slice keeps a **CSS class contract**; it does not introduce a separate React `Button` abstraction.

### Overlay dismiss control

Modal panel headers (Menü panel, notification center, form drawer, desktop command palette) dismiss through one shared icon-only control, `DrawerCloseButton` (`.drawer-close`): a fixed square `var(--control-height)` target (44 × 44 CSS px at default text size) with a 1rem stroke X glyph that is `aria-hidden`. The accessible name names the panel (`Menüyü kapat`, `Bildirimleri kapat`, `Formu kapat`, `Aramayı kapat`). The control never stretches to fill a grid column or flex track, never shows a visible `Kapat` text label in a modal panel header, and never uses a text glyph such as `✕` in place of the SVG. Backdrop dismiss, Escape and focus return stay owned by the panel. Inline, non-modal notices and dialog footers keep visible text actions (`Kapat`, `Vazgeç`).

### Surfaces

- **Section**: broad grouping that may rely on spacing and heading hierarchy.
- **Surface** (`.surface`): calm grouping for filters, detail summary, and low-emphasis panels.
- **Card**: one subject, summary, record, or action group through an owned Card adapter.
- **Emphasized Card**: operationally meaningful new/upcoming/attention/overdue/success/selected state using the Two-Channel Rule.
- **Surface-flat** (`.surface-flat`): lifecycle action bar or dense scanning region.
- **Raised** (`.surface-raised`): menus, popovers, drawers, mobile sheets, and sticky interactions.
Desktop list rows stay flat when list/table scanning is better; Card is not mandatory for every record.

### FormControl

Text inputs, selects, and textareas share `--border-control` / `--border-control-hover` / `--focus`, `--radius-control`, `--control-height`, padding (`0.72rem 0.85rem` for inputs/textareas; `0 0.85rem` for selects), hover/focus/disabled/error states, and optional hint (`aria-describedby`). Static short option lists (including filter toolbars, calendar assignee filter, report dropdowns, and duplicate resolution reason selects) use native `<select>` under this shared FormControl CSS contract; async or searchable large datasets use the owned `ServoraSelect` adapter.

### Filter Bars, Search & Pagination

- List and report toolbars wrap filters inside `.filter-region` and prefer `.surface-flat` (`var(--canvas)` + `--rule` border, no card-on-card shadow) with a desktop reset action (`Filtreleri temizle` / `Filtreleri sıfırla` / `Temizle`) whenever non-default filters are active. On viewports below `64rem`, high-density list filters collapse into `FilterSheet` while keeping primary search accessible.
- Fixed-page offset lists standardize on `ServoraListPagination` (`Sayfa X / Y · Toplam N <öğe>`), hiding automatically on single-page results and preserving keyboard focus across page transitions. Cursor-based continuation streams (duplicate pair scan, job notes, older messages, notifications, append-mode staff lateness) intentionally keep explicit cursor buttons rather than total-page counters.

### Status and priority chips

Both are required for operational scanning. Soft fill + visible Turkish label (and optional non-color shape). Color never alone. No left side-stripe accents on cards or chips.

The shape channel is the shared inline SVG set in `web/src/ui/signal-icons.tsx` (status, priority, job type, lifecycle command, and signal glyphs). Glyphs are `aria-hidden` and never replace the visible label; no icon library is introduced. Status tones: `Atandı` neutral, `Kabul edildi` Information Blue, `Uygulanıyor` accent, `Yönetici kontrolünde` and `Düzeltme istendi` Delay Amber (attention, never Critical Red), `Tamamlandı` Confirmed Green, `İptal edildi` Critical Red, `Geçersiz` muted. Lateness signals use Delay Amber with explicit time text. The `Takip` badge marks follow-up continuity (a card created from another card's follow-up), not the `Takip görüşmesi` meeting kind, which is already the type label. Activity timeline markers use the same five tones (success, info, warning, danger, neutral); an advisory location difference is shown once, as a Delay Amber badge.

### New job control

One primary create control per viewport. Desktop (≥1024px): the top bar owns it. By default it is the global **Yeni iş** disclosure menu, without focus trap; Escape returns focus. A page whose own primary job is creating a different record registers that create action (`web/src/shell/page-create-action.tsx`) and the top bar shows it in place of **Yeni iş**: Ürünler → **Yeni ürün** (only for roles that may manage the catalog), Müşteriler → **Yeni müşteri**, Takvim → **Yeni plan**. The page decides the label, permission and disabled state; when it registers nothing the top bar falls back to **Yeni iş**. Jobs and every other route keep **Yeni iş**. On desktop, page headers do not render a second create control (the page's own button carries `.page-create-action` and is hidden at ≥1024px); below 1024px those page buttons stay, because the mobile top bar has no create control. Create options come from one ordered source (`web/src/jobs/new-job-options.ts`) shared by the create menu and the command palette quick actions. Mobile/tablet (`<1024px`): the single create entry is the centered bottom-navigation action, which opens the existing bottom sheet with focus containment while it is modal; it is available on every mobile route for the roles that could already create jobs. The former jobs-list sticky create bar is removed. Routes remain the existing create flows.

### Mobile top bar

A **single** sticky top bar: resolved route title from the single route-identity source and the notification affordance. The top bar MUST NOT contain a menu trigger (the single Menü entry is the bottom-navigation control), MUST NOT contain brand chrome below 1024px, MUST NOT contain breadcrumb or return logic (return renders through the PageHeader region), and MUST NOT repeat the route title as a second visible copy in content. The notification target size MUST NOT be reduced to recover title space. Common static section names MUST remain readable at supported widths (named regression: at 320px `Genel Bakış` MUST NOT degrade to a meaningless clip); long dynamic entity names MAY ellipsize. Readability is judged by rendered geometry, never by character counts.

### Route identity and navigation registries

Navigation and route identity are coordinated but separate systems. The navigation model owns destinations, role/capability filtering, bottom-navigation and menu-panel placement, and landing/home policy. The route identity registry owns static route identity, the generic fallback title, deterministic hierarchy, param-aware parent location, and breadcrumb semantics. Authorization and home policy MUST NOT be duplicated into route identity.

Every distinct static route with a different canonical title, hierarchy position, or document-title identity MUST have its own route identity key. Umbrella ids covering multiple differently titled static routes are prohibited. Dynamic instances sharing one semantic pattern share one id and use a runtime label overlay.

A route identity entry owns `id`, `title` (generic fallback), `parentId`, optional `parentLocation(params)`, and optional authenticated-shell `section`. Parent URLs MUST reuse the canonical builders from `paths.ts`; URL templates MUST NOT be duplicated. Shell-external routes (login, forbidden, not-found) MUST NOT carry a fake navigation section. Route metadata MUST NOT contain primary/secondary actions, tabs, filters, authorization, loading/business state, home eligibility, or mobile-specific title aliases.

### Resolved active identity

There is exactly ONE resolved active route identity. It combines static route identity, current params, and an optional plain runtime label supplied by the page after domain data loads into one resolved value. The identity layer MUST NOT fetch domain data and MUST NOT import domain entity types.

PageHeader H1, MobileTopBar title, breadcrumb current item, and `document.title` MUST all consume this same resolved value. No surface MUST independently reconstruct a title fallback.

### PageHeader

PageHeader owns identity presentation: optional section/eyebrow, the semantic H1, optional description, the desktop breadcrumb region, the return-context region, and a page-owned actions passthrough region. Tabs and filters remain page composition below the header. Actions arrive as rendered page-owned controls, never as serialized route metadata. PageHeader MUST NOT own authorization decisions, business actions, pending/loading business logic, tabs, filters, or page data fetching.

### Route identity by viewport

**Desktop (≥1024px).** PageHeader renders the visible semantic H1; nested routes render the hierarchy breadcrumb above it. The desktop top bar MUST NOT repeat the route title and MUST NOT contain a second brand; it remains global shell actions/chrome.

**Mobile/tablet (<1024px).** MobileTopBar renders the visible route title; PageHeader retains the semantic H1 visually hidden. There MUST NOT be a second visible copy of the route title in content.

### Breadcrumb

Desktop breadcrumb is hierarchy-derived, param-aware, never browser history, and never entry context. It appears on nested routes where hierarchy adds information (for example `İşler / <iş>`, `Raporlar / Personel`, `Ayarlar / Güvenlik`, `Müşteriler / <müşteri> / <ilgili kişi>`). Root/list routes MUST NOT render decorative breadcrumbs. A Calendar entry into a job MUST NOT insert Calendar into the breadcrumb; the crumb stays `İşler / <iş>`.

### Return model

Three distinct concepts MUST NOT be conflated. **Hierarchy parent** is deterministic and registry-derived; it drives the breadcrumb and provides the fallback for nested routes. **Context return** is optional and entry-context-derived (for example Calendar → Job). **Return target** is the valid context return when available, otherwise the hierarchy parent.

### Mobile ReturnLink

Nested routes on mobile/tablet expose one ReturnLink, `‹ {label}`, through the PageHeader return-context region: Calendar → Job shows `‹ Takvim`; a direct job URL shows `‹ İşler`; Settings Security shows `‹ Ayarlar`. Root routes have no ReturnLink. The legacy mixture (`Geri`, `İşlere dön`, `Listeye dön`, `Müşterilere dön`, and similar hierarchy-return labels) is not part of this design. Flow-local controls such as compose-close/cancel remain separate.

### Desktop context return

Desktop breadcrumb remains hierarchy-only. PageHeader MAY additionally show a compact contextual-return control ONLY when a valid context return exists AND differs meaningfully from the deterministic hierarchy parent. Calendar → Job Detail shows breadcrumb `İşler / <iş>` plus `Takvime dön`. Jobs → Job Detail shows the breadcrumb with no redundant return control. Direct URL shows the breadcrumb with no context control.

### Context-return safety

Context return is optional, ephemeral, non-portable, and untrusted input; a deterministic hierarchy fallback is always required. A valid context return MUST resolve to a known internal route, contain no external scheme/host, satisfy current-user route access, preserve safe internal query/search, preserve hash only where useful, and fail closed to the hierarchy fallback. `history.back()` MUST NOT serve as the application return contract. Open-redirect-shaped raw URL mechanisms are prohibited.

### Document title

The unified rule is `{resolved route title} · Dünya Dental`, applied consistently in browser mode and standalone PWA mode with no fork. While entity data is unavailable the generic fallback applies (for example `İş detayı · Dünya Dental`); after the runtime label resolves, `{entity label} · Dünya Dental` applies. `CANONICAL_DOCUMENT_TITLE` remains boot/fallback behavior only.

### Brand

Approved brand variants are `full` and `login-hero`. A compact variant is future work and MUST NOT be required. The brand component owns the canonical variant-to-asset mapping, accessible branding semantics, the rendered sizing contract, and linked/non-linked rendering based on the supplied target. It MUST NOT inspect user role, choose role-aware landing, or import authorization/navigation policy; shell/navigation policy resolves home and passes `to`.

Placement is normative. Desktop (≥1024px): sidebar shows the full brand; the top bar shows no brand. Mobile/tablet (<1024px): the top bar shows no brand and the mobile menu carries no brand block. Login shows the login hero brand. At most one prominent shell brand is visible in the active shell context. Small-screen title pressure MUST NOT be solved by resizing the wordmark.

### Home

Role-aware home remains navigation policy: overview when eligible/enabled, otherwise jobs, per existing product rules. Home eligibility MUST NOT be added to route identity. AppShell/navigation resolves the home destination and passes it to the brand component; the brand stays presentational.

### Shell responsibility matrix

- **Navigation model:** destinations, role/capability filtering, bottom-navigation and menu-panel placement, landing/home policy. MUST NOT own identity facts or title strings.
- **Route identity registry:** static identity, generic titles, deterministic param-aware hierarchy, breadcrumb semantics. MUST NOT own authorization, home policy, fetching, or domain types.
- **Resolved-identity layer:** the single combination of static identity, params, and runtime label. MUST NOT fetch or render.
- **AppShell:** viewport switch, drawer with focus trap/restore, topbar/bottom-nav/content composition, document-title wiring from the resolved identity, home-target resolution passed to Brand. MUST NOT recompute titles or return targets.
- **Desktop top bar:** global quick search (`⌘K` / `Ctrl K`, lazy-loaded command palette over pages, customers and job cards through existing role-scoped endpoints), the single desktop create control (**Yeni iş**, or the current page's registered create action), notifications, and the account menu (a disclosure with profile, security and settings links and `Oturumu kapat`). Search yields width before the account name truncates. MUST NOT render the route title or a brand. The desktop sidebar footer carries only copyright and build identity.
- **PageHeader:** H1, eyebrow, description, breadcrumb region, return-context region, actions passthrough. MUST NOT own authorization, business actions, tabs, filters, or data fetching.
- **MobileTopBar:** resolved route title, notification affordance. MUST NOT own a menu trigger, breadcrumb, hierarchy, return logic, or brand.
- **Brand component:** variant-to-asset mapping, accessible semantics, sizing contract, linked/non-linked rendering from supplied target. MUST NOT own role, home, or authorization policy.
- **Page/route:** business content, actions with pending states, tabs, filters, entity loading, plain-string runtime label supply, flow-local back. MUST NOT hand-roll hierarchy chrome, bespoke hierarchy back buttons, document-title strings, or per-surface title fallbacks.

No layer SHOULD recompute another layer's identity or policy facts.

### Preserved shell systems

This contract integrates with, and MUST NOT replace: role-aware navigation filtering, the navigation destination source of truth, drawer focus trap and restore, `aria-current`, bottom-navigation and single-menu-panel behavior, forms and destructive confirmations, the Slice 2 focus contract, Slice 1 responsive chart systems, and the 64rem shell breakpoint.

### Bottom navigation and Menü

Destinations come from one navigation model shared with sidebar and menu panel. Exactly one mobile **Menü** control exists, in the bottom navigation; the mobile top bar has none. The panel opens from the right edge and shows the account row (name, role, `Oturumu kapat`) first, then destinations in two groups: `Çalışma` (operational destinations) and `Hesap ve destek` (settings, documentation, help, backup). It carries no brand block. Closing restores focus to the Menü trigger.

The bottom navigation holds at most five slots. Every destination shows an `aria-hidden` inline SVG icon above an always-visible text label, interaction targets stay at least 44 × 44 CSS px, and one centered `Yeni iş` action opens the create sheet for the roles that could already create jobs.

### Job lifecycle guidance (detail-first)

These surfaces use existing design tokens, surface levels, button variants, and chip rules.
They do not introduce a second visual system. Reviewed lifecycle adapters may
use the owned Ant Design boundary in later implementation PRs.

- **Lifecycle stepper** (`.servora-workflow-steps` via `WorkflowSteps`): screen-reader
  ordered list plus visual Ant Steps of presentation phases
  (`Atandı` → `Kabul edildi` → `Uygulanıyor` → `Yönetici kontrolü` → `Tamamlandı`).
  Current step uses `aria-current="step"`. Complete, current, skipped (`Atlandı`),
  attention (revision loop), and upcoming states use text/icon semantics plus restrained
  color—never color alone. Attention is Delay Amber with explicit text; it is never
  Critical Red and never Ant's `error` status. Desktop: five-column when space permits;
  fall back to compact vertical without horizontal page scroll. Mobile: a one-line
  compact summary (`3 / 5 · Uygulanıyor`) that expands into the full vertical stepper
  through a native disclosure (UI-005).
- **Mobile job detail order** (UI-005, below 1024px): title and status chips →
  responsibility panel with its primary command(s) → compact lifecycle summary →
  requirements, record details, notes and history. Manager-only lateness history is a
  collapsed disclosure below the workflow; the open lateness signal keeps its place.
  Desktop keeps the stepper above the record and the decision group in the work rail.
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
- **Terminal banner**: cancellation (`CANCELLED` / `İptal edildi`) and historical
  invalidation (`INVALIDATED` / `Geçersiz`) are not green completions. Banner shows actor,
  time, reason, and frozen source phase (plus restoration cue where applicable); completed
  state (`COMPLETED` / `Tamamlandı`) uses Confirmed Green only for true success.
- **Planning & scheduling surfaces**: job creation and schedule-edit forms pair native
  `datetime-local` inputs with `ScheduleQuickControls` (quick non-Sunday presets, planned
  interval/duration preview, and non-blocking Sunday/past-start `status` hints) plus
  same-day/horizon `AvailableSlotsNotice` that preserves the chosen slot selection.
  Unacknowledged past-start submissions recover in-flow through `PastStartAcknowledgementDrawer`
  with an optional shortcut to shift forward to the next open working slot. Calendar unifies
  manual plans under **Kişisel plan** (concise `Plan` chip in desktop month cells to prevent
  1024px clipping; `Yeni plan` in the desktop top bar via `page-create-action.tsx`).
- **Compact workflow summary** (list/board): ordinal phase string such as
  `3 / 5 · Uygulanıyor` with optional attention flag. Secondary to the technical status
  chip; never replaces board column status labels.
- **Jobs list control surface** (below 1024px): search stays visible; filters and the
  Liste/Pano view switch live in the existing filter sheet so the first record is
  reachable in the first screen. The status quick-view strip never clips without a
  visible overflow affordance (UI-005).
- **Accessibility / responsive**: ≥ 44×44 CSS px targets, visible focus, 200% text and 400%
  reflow without clipped meaning or horizontal task scroll, `prefers-reduced-motion`
  disables optional workflow motion, one primary action per responsibility region on mobile.

## Visual review evidence

Follow [the rendered UI evidence workflow](docs/ui/visual-review-workflow.md)
under DECISIONS.md UI-003 for design and visual implementation. Its default is
Playwright + headless Chromium rendering real React components with consistent
synthetic data. Use the existing design tokens and owned Ant adapters in those
captures. UI-001 and PRODUCT.md continue to own accessibility completion.

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
- **Don't** copy generic SaaS card grids without role-specific information hierarchy; do not use decorative gradient text, meaningless side stripes, fake hero metrics, or nested containers. Purposeful dashboard grids and operational Card variants are allowed.
- **Don't** use bounce, elastic easing, confetti, particles, parallax, staggered list entrances, or page-load choreography.
- **Don't** let momentum, drag distance, or animation bypass backend JobCard transition rules.
- **Don't** use color as the only carrier of status, priority, lateness, warning, success, or error.
- **Don't** reach for a modal before inline disclosure, a dedicated page, or a non-blocking panel has been considered.


## Historical Direction Pointer (Phase U — 2026-07-26)

The July 2026 Phase U visual direction amendment (overview/analytics/calendar/messaging integration against Ant primitives) has been shipped and incorporated into the sections above. Archival rationale and resolved plans live in `docs/superpowers/specs/2026-07-26-servora-ant-visual-language.md`, `docs/superpowers/plans/2026-07-26-phase-u2-calendar-visual-closeout.md`, and `docs/superpowers/plans/2026-07-26-phase-u-workspace-visual-composition.md`.
