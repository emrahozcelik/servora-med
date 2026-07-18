# Servora UI Architecture

Status: Approved
Scope: Architecture decision and phased implementation boundary
Production impact: PR A–D are merged; PR E reporting surfaces design is open on `feature/reporting-surfaces`

## Decision

Ant Design `6.5.1` is an exact-pinned runtime dependency, but it does not own Servora-Med's design system or product identity.

The integration boundary is:

    Ant Design primitive
            ↓
    Servora-owned adapter
            ↓
    Feature screen

Feature screens should not import Ant Design directly unless an exception is reviewed and documented. DESIGN.md remains the source of truth for visual tokens, interaction rules, responsive structure, and accessibility.

## Why this boundary

Servora already owns high-value product behavior:

- role-aware navigation from one navigation model
- desktop sidebar and mobile chrome
- accessible drawer focus containment and restoration
- JobCard lifecycle presentation
- field and button contracts
- status and priority chips
- responsive job list and board behavior
- backend-owned transition rules

Replacing these with Ant Design Layout, Menu, Card, or Form would create regression risk without improving the domain model. Ant Design is reserved for complex, mature primitives whose behavior would otherwise be costly to reproduce.

## Provider foundation

PR A introduces a single provider boundary:

    <ConfigProvider
      prefixCls="servora-ant"
      locale={trTR}
      theme={servoraAntTheme}
    >
      <AntApp>
        <ServoraApplication />
      </AntApp>
    </ConfigProvider>

Provider responsibilities:

- theme token mapping
- Turkish locale
- component sizing
- motion policy
- popup container policy
- class prefix isolation
- message, notification, and modal context

Feedback must be exposed through a Servora-owned hook based on App.useApp(). Feature code must not spread static message.success, Modal.confirm, or notification.open calls. Ant Design documents that App.useApp() must run beneath App and that ConfigProvider must wrap App for theme tokens to be available: [App](https://ant.design/components/app/) and [ConfigProvider](https://ant.design/components/config-provider/).

PR A selected and exact-pinned Ant Design `6.5.1`, the npm `latest` release on 18 July 2026. Its official 13 July 2026 changelog was reviewed; the patch includes responsive breakpoint and reduced-motion fixes relevant to the planned primitives. The package accepts the existing React and React DOM 19.2.7 versions through its `>=18.0.0` peer contract.

## Owned adapter surface

Implemented foundation surface:

    web/src/ui/antd/
      ServoraAntProvider.tsx
      servora-ant-theme.ts
      index.ts
      useAppFeedback.ts

Implemented job detail adapter surface:

    web/src/ui/antd/
      WorkflowSteps.tsx
      ActivityTimeline.tsx
      RecordDescriptions.tsx

PR D overlay adapter surface (narrowed ship):

    web/src/ui/antd/
      ConfirmationAction.tsx   # modal-only; Popconfirm deferred
      ReasonDialog.tsx
      ResponsiveDrawer.tsx     # Job + Customer filters only
      overlay-focus.ts

PR E reporting adapter (Delivery-first):

    web/src/ui/antd/
      OperationalTable.tsx

Still planned for later PRs:

    web/src/ui/antd/
      OperationalDropdown.tsx
      ResultState.tsx

The PR C adapters are render-only: they receive presentation data and do not call APIs, calculate permissions or readiness, create command intents, or translate domain status. Overlay migration is owned by PR D; see `docs/superpowers/specs/2026-07-18-feedback-overlays-design.md`.

## Component decision matrix

| Primitive | Decision | Servora use | Boundary and accessibility |
| --- | --- | --- | --- |
| ConfigProvider | Use | Theme, locale, prefix, popup behavior | One root provider; no feature-level providers without a documented isolation need |
| App | Use | Context-aware message, notification, modal | Owned hook only; App and ConfigProvider remain paired |
| Steps | Use | Expected JobCard lifecycle | Render a presentation model, never raw status index; mobile vertical, desktop horizontal when space permits; text and icon accompany color |
| Timeline | Use | Persisted audit and activity history | Preserve event order and content; each event exposes action, actor, time, description, and reason |
| Descriptions | Use | Read-only structured JobCard facts | One column on mobile, two when useful on desktop; never replace editable fields |
| Dropdown | Selective | Secondary, low-frequency commands | Main lifecycle actions remain visible; keyboard and focus behavior must be tested |
| Drawer | Selective | Mobile filters, create menu, secondary detail | Existing navigation drawer is not replaced in the first implementation PR; compare focus containment and restoration first |
| Table | Selective | Dense reports and administration | Semantic headers, keyboard reachability, owned empty/loading states; mobile gets card/list alternative rather than a compressed table |
| Result | Use | Forbidden, not found, success, retryable failure | Clear heading, consequence, and next action |
| Empty | Use | Empty operational collections | Explain why empty and what the user can do next |
| Skeleton | Use | Stable content loading | Match final geometry; mark loading without trapping focus |
| Popconfirm | Limited | Short, single-outcome confirmations | Never collect a reason or explain a complex lifecycle consequence |
| Modal | Limited | Reason capture or complex consequence | Focus containment, Escape when safe, restoration, pending lock, labelled title and description |
| Segmented | Optional | Small, mutually exclusive view control | Only if native view controls do not already meet the need |

Official component references: [Steps](https://ant.design/components/steps/), [Timeline](https://ant.design/components/timeline/), [Descriptions](https://ant.design/components/descriptions/), [Drawer](https://ant.design/components/drawer/), [Table](https://ant.design/components/table/), [Empty](https://ant.design/components/empty/), [Skeleton](https://ant.design/components/skeleton/), and [Popconfirm](https://ant.design/components/popconfirm/).

## Servora-native boundary

These surfaces remain owned by Servora:

- AppShell
- desktop sidebar
- mobile top bar
- mobile bottom navigation
- navigation model and role filtering
- horizontal workflow lanes
- JobCard
- customer, product, and staff cards
- status and priority chips
- form-field contract
- primary, secondary, destructive, and ghost button contracts
- lifecycle and permission decisions
- responsive breakpoints and reflow rules

Explicit non-goals:

- rebuilding the shell with Ant Design Layout
- replacing navigation with Menu
- wrapping every surface in Card
- converting every button, input, and form in one pass
- accepting default Ant Design blue or admin-dashboard styling
- installing Tailwind or shadcn
- adding charts, drag and drop, or dark mode in this phase

## Token bridge

DESIGN.md stays canonical:

    Servora CSS/design token
              ↓
        servoraAntTheme
              ↓
      Ant global token
              ↓
    component token override

The table below records proposed sRGB adapter values for environments where Ant Design does not safely preserve the canonical OKLCH value. They are derived values, not a second design system.

| Servora role | Canonical value | Proposed sRGB | Ant token |
| --- | --- | --- | --- |
| Mineral Blue | oklch(47% 0.105 238deg) | #00628E | colorPrimary |
| Focus | oklch(58% 0.14 238deg) | #0084C3 | active outline support |
| Graphite Ink | oklch(26% 0.016 246deg) | #1E252B | colorText |
| Muted Record | oklch(47% 0.018 246deg) | #535C65 | colorTextSecondary |
| Daylight Paper | oklch(98.5% 0.004 235deg) | #F8FBFC | colorBgBase, colorBgContainer |
| Quiet Canvas | oklch(95.5% 0.009 235deg) | #EBF1F5 | layout support, not Ant Layout adoption |
| Soft Rule | oklch(86% 0.012 238deg) | #CAD2D8 | colorBorder |
| Critical Red | oklch(44% 0.14 28deg) | #902822 | colorError |
| Delay Amber | oklch(39% 0.08 70deg) | #603C07 | colorWarning |
| Confirmed Green | oklch(38% 0.08 150deg) | #1D4E2B | colorSuccess |
| Information Blue | oklch(41% 0.105 238deg) | #00507C | colorInfo |

Supporting semantic backgrounds:

- warning: #F7EDDC
- success: #E3F4E6
- information: #D6E7F4

Measured contrast ratios for the proposed pairs:

- Mineral Blue on Daylight Paper: 6.44:1
- Graphite Ink on Daylight Paper: 14.91:1
- Muted Record on Daylight Paper: 6.54:1
- Delay Amber on its background: 8.43:1
- Confirmed Green on its background: 8.43:1
- Information Blue on its background: 6.81:1
- Focus against Daylight Paper: 3.97:1

Implementation must repeat automated contrast checks after Ant algorithms and component overrides are applied. Visual estimation is not sufficient.

Additional target tokens:

| Ant token | Proposed direction |
| --- | --- |
| borderRadius | 10 px, aligned with Servora's 0.6rem contract |
| controlHeight | 44 px minimum |
| fontFamily | Inter, ui-sans-serif, system fallbacks from DESIGN.md |
| fontSize | 16 px body baseline where Servora controls content; compact metadata must remain readable |
| boxShadow | Reduce global elevated shadow; no shadow on flat content |
| motion | Short state feedback only; disable optional motion under reduced-motion preference |

Component overrides follow global tokens. The adapter must not create CSS specificity battles with production classes. Portals must be tested inside the shell for z-index, clipping, focus restoration, and scroll locking.

## Workflow lanes

The PR B desktop implementation replaces five tall, narrow Kanban columns with full-width horizontal workflow lanes:

- NEW: Hazırlanıyor
- ACCEPTED: Atandı
- IN_PROGRESS: Uygulanıyor
- WAITING_APPROVAL: Yönetici kontrolünde
- REVISION_REQUESTED: Düzeltme istendi

COMPLETED and CANCELLED remain outside the active lanes and are reached through closed-work filters.

Each lane shows three or four responsive desktop cards and a Tümünü gör link to a filtered list. Compact layouts show two preview cards in a one-column flow. The page does not depend on horizontal scrolling. Cards prioritize title, customer, assignee, schedule, type-specific summary, workflow summary, then attention signal.

Mobile lanes become vertical sections with one-column cards. They do not become miniature horizontal columns.

Implemented compact Staff order:

1. Düzeltme istendi
2. Uygulanıyor
3. Atandı
4. Hazırlanıyor
5. Yönetici kontrolünde

Implemented compact Manager/Admin order:

1. Yönetici kontrolünde
2. Düzeltme istendi
3. Uygulanıyor
4. Hazırlanıyor
5. Atandı

This ordering is a presentation decision, not a new domain transition rule. Desktop keeps canonical domain order. The preserved board API returns exact counts per persisted status but no complete overdue collection, so PR B does not synthesize a separate Geciken lane from limited previews. Existing overdue reports and `dueBefore` list filtering remain the source for that view.

## Canonical status vocabulary

The domain and presentation terms have distinct responsibilities:

- persisted domain status: ACCEPTED
- workflow lane label: Atandı
- lifecycle presentation phase: Planlandı
- historical event text: Planlandı or İş kabul edildi, according to the persisted event

PLANNED is not a persisted JobCard status. Root AGENTS.md records ACCEPTED accordingly. No compatibility fallback or domain transition change is introduced by this architecture decision or PR A.

## DESIGN.md amendment

PR A amends DESIGN.md with the approved foundation rules covering:

- selected Ant Design primitives
- owned adapter boundary
- no direct feature-level Ant imports
- toast policy
- provider locale, prefix, popup, and reduced-motion policy

Horizontal workflow lanes, table/mobile fallback, charts, drag and drop, and dark mode remain governed by their later PR gates. The obsolete lifecycle statement that no dependency exists is revised by PR A; existing visual and accessibility rules remain intact.
