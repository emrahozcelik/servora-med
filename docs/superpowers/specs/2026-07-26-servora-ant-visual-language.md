# Servora-Med — Ant Design Visual Language and Component Policy
## Purpose-layered UI amendment

**Status:** Active — reconciled 2026-07-26
**Date:** 2026-07-26
**Applies to:** Phase U and later visual work
**Repository:** `emrahozcelik/servora-med`

---

## 1. Decision

Servora-Med will expand its use of Ant Design through the existing owned adapter boundary.

The previous "flat by default" rule was a product-aesthetic constraint, not a measured performance requirement. It protected the application from nested cards, generic admin-template styling, and decorative color. It now becomes **purpose-layered clarity**:

- use layout and spacing for broad grouping,
- use Card for one subject, metric, record summary, or action group,
- use emphasized Card for new/upcoming/attention/overdue/success/selected state,
- use raised layers for drawers, modals, popovers, and dropdowns,
- avoid decorative nesting and meaningless containers.

Ant Design is already an exact-pinned runtime dependency with `ConfigProvider`, Turkish locale, token mapping, lazy routes, and a bundle budget. Expanded use is therefore judged by measured bundle/runtime results, not by a blanket assumption that Ant is too heavy.

---

## 2. Reference direction

The target dashboard direction is inspired by the information architecture of:

- `https://demos.shadcndashboard.dev/dashboards/saas-ai`

Servora adopts:

- contextual greeting,
- period/view controls,
- four primary metrics,
- strong main chart/operational area,
- secondary widgets,
- recent work/notes/messages,
- responsive card composition.

Servora does not adopt:

- Tailwind,
- shadcn/Base UI runtime,
- demo router/theme/mock API,
- demo business vocabulary,
- shopping cart/country flag actions,
- generic AI claims,
- copied palette or layout code.

---

## 3. Source-of-truth hierarchy

```text
DESIGN.md
→ this visual-language policy
→ Phase U product design
→ slice/checkpoint implementation plans
→ owned adapter APIs and tests
```

Raw Ant imports remain limited to `web/src/ui/antd/`.

---

## 4. Surface model

| Level | Meaning | Typical examples |
|---|---|---|
| Canvas | Application/page background | AppShell content frame |
| Section | Broad grouping | dashboard region, documentation category |
| Card | One subject or action group | KPI, upcoming work, recent note, settings group |
| Emphasized Card | Operational state | new, upcoming, attention, overdue, success, selected |
| Raised Layer | True overlay | Drawer, Modal, Popover, Dropdown |

Rules:

1. A Card needs a stable subject or action purpose.
2. Do not add a Card merely to create padding.
3. Avoid Card-inside-Card unless the inner record is independently actionable and remains semantically valid.
4. Dense desktop tables/lists may remain flat.
5. Dashboard grids are allowed; generic identical card grids across every screen are not.

---

## 5. Operational Card contract

Candidate adapter:

```text
web/src/ui/antd/OperationalCard.tsx
```

Candidate public props:

```ts
type OperationalCardTone =
  | 'default'
  | 'new'
  | 'upcoming'
  | 'attention'
  | 'overdue'
  | 'success'
  | 'selected';

type OperationalCardProps = {
  tone?: OperationalCardTone;
  title?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  loading?: boolean;
};
```

The adapter owns Ant Card and semantic slot `classNames` / `styles`. The feature owns outer semantics (`article`, `li`, `section`, link), accessible names, business labels, and deep links.

Every non-default tone uses at least two channels:

```text
color/tone
+ visible status phrase, icon, label, time, or position
```

Examples:

- `new`: "Yeni" + created/unread time,
- `upcoming`: "2 saat kaldı" + clock icon,
- `attention`: "Aksiyon gerekiyor" + expected action,
- `overdue`: "Gecikti" + planned time,
- `success`: "Tamamlandı" + completion time,
- `selected`: `aria-current`/selection state + visual treatment.

---

## 6. Component policy

### 6.1 Card

Official reference: `https://ant.design/components/card/`

Use for independently understandable content. Customize Ant semantic slots through the owned adapter. Do not assume Ant's slot naming automatically supplies correct document semantics.

### 6.2 Calendar

Official reference: `https://ant.design/components/calendar/`

Use the Notice Calendar pattern for U2. Requirements:

- monthly grid,
- custom Servora header,
- selected-day agenda,
- bounded cell items and `+N`,
- compact mobile calendar,
- `[start, end)` interval semantics,
- no raw Dayjs leakage to feature APIs,
- no browser-native prompt/confirm.

### 6.3 Result

Official reference: `https://ant.design/components/result/`

Extend/reuse `ResultState` for:

- 403,
- 404,
- 500,
- blocking error,
- successful completed flow,
- warning/info endpoint.

Use full-page Result only when the route or flow cannot continue. Use a compact in-page result when the record/context must remain visible.

### 6.4 Progress

Official reference: `https://ant.design/components/progress/`

Use for real measured progress or known completion percentage. Use Steps for lifecycle phases. Never fabricate a percentage for indeterminate work.

Candidate adapter:

```text
web/src/ui/antd/ServoraProgress.tsx
```

It must provide an accessible label/summary and semantic status text.

### 6.5 Popconfirm

Official reference: `https://ant.design/components/popconfirm/`

Reuse `CompactConfirmationAction` for a short confirmation requiring no extra input. Use `ConfirmationAction` or `ReasonDialog` when consequences are complex or a reason is required. `window.confirm` and `window.prompt` are prohibited.

### 6.6 Notification progress

Official reference: `https://ant.design/components/notification/`

`showProgress` displays the remaining auto-close duration. It is allowed for transient informational feedback through `useAppFeedback`; it must not be described as upload/task completion. Persistent decisions and errors must not disappear only because a timer ended.

### 6.7 Avatar with Badge

Official reference: `https://ant.design/components/avatar/`

Candidate adapter:

```text
web/src/ui/antd/UserAvatar.tsx
```

Support:

- image when safe infrastructure exists,
- initials fallback,
- size variants,
- meaningful Badge for unread count or authoritative account state.

Do not show online presence without an authoritative presence model. Avatar upload remains deferred until storage, MIME, decode, resize, authorization, deletion, and security requirements are accepted.

### 6.8 Segmented with icons

Official reference: `https://ant.design/components/segmented/`

Candidate adapter:

```text
web/src/ui/antd/IconSegmented.tsx
```

Approved examples:

```text
Ay / Ajanda
Bugün / 7 gün / 30 gün
Kart / Liste where both modes are real and maintained
```

Prefer icon + label. Icon-only mode requires accessible names, clear meaning, keyboard behavior, tooltip where useful, and zoom/reflow verification.

### 6.9 Descriptions, Tabs, Collapse, Anchor

Use/extend owned adapters for:

- Profile and account facts: Descriptions,
- Settings groups: Tabs,
- Help FAQs: Collapse,
- Documentation navigation: Anchor,
- searchable category composition around those primitives.

### 6.10 Skeleton, Empty and state adoption

Reuse `LoadingSkeleton`, `EmptyState`, and `ResultState`. Feature-specific plain "yükleniyor" headings or inconsistent `workspace-message` states should be migrated in the Workspace Visual Composition checkpoint where scope allows.

---

## 7. Existing adapters to preserve

```text
ActivityTimeline
CompactConfirmationAction
ConfirmationAction
EmptyState
LoadingSkeleton
ReasonDialog
RecordDescriptions
ResponsiveDrawer
ResponsiveFormDrawer — migrate to owned Ant Drawer where accepted
ResultState
ServoraAntProvider
WorkflowSteps
useAppFeedback
```

Do not duplicate these under new names without a concrete missing contract.

---

## 8. Candidate new adapters

```text
OperationalCard.tsx
MetricStatistic.tsx
ServoraProgress.tsx
UserAvatar.tsx
IconSegmented.tsx
ContentCollapse.tsx
ContentAnchor.tsx
SettingsTabs.tsx
```

`ServoraCalendar.tsx` already exists on the U2 branch and should be completed rather than replaced.

An adapter is justified only when it owns at least one of:

- stable domain-facing props,
- Ant import boundary,
- token/semantic slot styling,
- responsive behavior,
- accessibility behavior,
- repeated testable interaction semantics.

---

## 9. Palette and theme revision

The current mineral-blue palette is a baseline. A system-wide palette change is allowed in the Workspace Visual Composition checkpoint if:

1. canonical visual tokens change first,
2. `servora-ant-theme.ts` maps the same tokens,
3. no feature hardcodes the replacement palette,
4. primary, neutral, semantic, focus, chart, and card tones are documented,
5. WCAG contrast contracts pass,
6. representative dashboard/calendar/settings/help screenshots are reviewed at 390, 1024, and 1440 px,
7. status meaning remains two-channel,
8. reduced-motion and high-contrast behavior remain usable.

Do not choose final color values only from a static mockup. Compare at least two tokenized candidates using real synthetic Servora data.

---

## 10. Performance guardrails

Expanded Ant usage is approved under these constraints:

- preserve lazy routes,
- raw imports only in owned adapters,
- run and report `npm run bundle:check`,
- report notable chunk deltas against the PR base,
- keep bounded dashboard/calendar/message collections,
- paginate or virtualize at real scale,
- do not mount hidden duplicate desktop/mobile component trees when CSS reflow can solve it,
- do not add a second chart/UI framework without a dependency/security gate,
- investigate measured regressions rather than generic assumptions.

Calendar, Card, Statistic, Result, Progress, Popconfirm, Notification, Avatar, Badge, Segmented, Collapse, Tabs, Descriptions, Drawer, Skeleton, and Empty are normal acceptable application components when used purposefully.

---

## 11. Accessibility and interaction

Required:

- correct outer HTML semantics,
- one page `h1`,
- logical headings inside Cards,
- visible focus,
- keyboard and Escape behavior,
- focus restoration for overlays,
- 44×44 targets where applicable,
- explicit labels and status phrases,
- no color-only meaning,
- 200% text zoom in every visual PR,
- 400% reflow in Phase T5,
- reduced-motion support,
- live-region restraint,
- no timed notification as the only record of an important result.

---

## 12. Validation contract

Every PR using new/expanded Ant adapters runs:

```bash
cd web
npm test -- --run
npm run build
npm run bundle:check
npm run audit:high
npm run smoke:responsive
```

Boundary checks:

```bash
rg -n "from ['\"]antd['\"]|from ['\"]antd/" web/src \
  --glob '!ui/antd/**'

rg -n "servora-visual-tokens" web/src \
  --glob '!ui/antd/**' \
  --glob '!ui/servora-visual-tokens.ts'
```

Required review:

```text
OpenCode independent-reviewer
OpenCode visual-verifier
external GPT-5.6 final review
```

Evidence uses synthetic, PII-free data.

---

## 13. Gates

```text
Ant visual-language planning:
COMPLETE

Phase U Ant visual documentation reconciliation:
AUTHORIZED — current checkpoint

Raw feature-level Ant imports:
NOT AUTHORIZED

Purposeful Card/Result/Progress/Popconfirm/Notification/Avatar/Badge/Segmented use through adapters:
AUTHORIZED FOR IMPLEMENTATION ONLY IN A SEPARATELY AUTHORIZED CHECKPOINT

Tailwind/shadcn migration:
NOT AUTHORIZED

AppShell migration to Ant Layout/Menu:
NOT AUTHORIZED

Mass Ant Form migration:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```
