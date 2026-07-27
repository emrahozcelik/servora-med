# Phase U2 — Calendar Visual Closeout
## Ant Notice Calendar, agenda, states, and interaction correction

**Status:** Post-merge corrective checkpoint — reconciled 2026-07-26
**Date:** 2026-07-26
**Based on:** U2 merged via PR #72 at 8cbb8b5a7c65e391f1b007919db40e1b098bc2ae
**Recommended branch:** `fix/phase-u2-calendar-visual-closeout`
**Execution:** Post-merge corrective PR; no new domain slice

PR #71:
CLOSED / SUPERSEDED

Its problematic ancestry must not enter main.

Clean U2 PR #72:
MERGED at 8cbb8b5a7c65e391f1b007919db40e1b098bc2ae

---

## 1. Context

U2 server/domain behavior and automated validation are substantially complete and merged. The branch now contains:

- `ServoraCalendar`,
- a 42-day visible month range,
- selected-day agenda,
- `ResponsiveFormDrawer`,
- calendar deep links,
- staff/manager/admin scope,
- reminders and notification integration.

This checkpoint completes the product-quality visual and interaction contract on the accepted merged main. It must not redesign the calendar schema, authorization, audit, reminders, or notification projection.

---

## 2. Goals

1. Make `/calendar` immediately recognizable and usable as a real planning calendar.
2. Align it with Ant Notice Calendar while retaining Servora colors, semantics, and responsive behavior.
3. Replace browser-native confirmation prompts with owned interactions.
4. Make loading, empty, error, conflict, selected, upcoming, and cancelled states visually understandable.
5. Produce direct browser evidence before PR Ready.

---

## 3. Current files to inspect

```text
web/src/calendar/CalendarPage.tsx
web/src/ui/antd/ServoraCalendar.tsx
web/src/ui/antd/ResponsiveFormDrawer.tsx
web/src/ui/antd/ResponsiveDrawer.tsx
web/src/ui/antd/CompactConfirmationAction.tsx
web/src/ui/antd/ConfirmationAction.tsx
web/src/ui/antd/ReasonDialog.tsx
web/src/ui/antd/ResultState.tsx
web/src/ui/antd/EmptyState.tsx
web/src/ui/antd/LoadingSkeleton.tsx
web/src/ui/antd/servora-ant-theme.ts
web/src/styles.css
web/tests/calendar-page.test.tsx
web/tests/*calendar*
web/scripts/responsive-smoke.mjs
docs/evidence/phase-u2-calendar/
```

Use repository truth for exact test names.

---

## 4. Required implementation

### 4.1 Calendar header

Provide a Servora-owned custom header:

- previous/next month,
- `Bugün`,
- clear month/year label or selectors,
- optional `Ay / Ajanda` icon + label Segmented control only if both views are maintained,
- manager/admin staff filter in the same hierarchy without crowding mobile.

Do not copy the demo palette or add unnecessary toolbar actions.

### 4.2 Notice Calendar cells

- Show date number and bounded event summaries on desktop/tablet.
- Show compact count/markers on mobile.
- Use explicit source/status text or accessible labels.
- Show `+N plan` overflow.
- Keep today, selected day, outside month, JOB, MANUAL, cancelled, upcoming, and overdue states distinguishable through more than color.
- Preserve meaningful DOM order and click targets.

### 4.3 Interval correctness

Preserve and reuse the existing shared `[start, end)` date helper contract. Add/retain regression coverage for midnight end boundaries and multi-day rendering. Do not rewrite server date semantics in this visual corrective PR.

The current adapter's multi-day mapping must not include the next day when an event ends exactly at midnight. Add focused tests for:

```text
same-day interval
multi-day interval
end exactly at 00:00
no explicit end
DST/time-zone boundary supported by current conventions
```

### 4.4 Selected-day agenda

Use an OperationalCard-style composition for agenda entries:

- source/status label,
- title,
- start/end,
- assigned person when authorized,
- related Job deep link,
- edit/cancel actions,
- selected/deep-linked state.

Do not Card-wrap every nested metadata row.

### 4.5 Create/edit Drawer

Migrate `ResponsiveFormDrawer` to an owned Ant Drawer implementation or consolidate it with the existing owned Drawer when this reduces custom overlay maintenance.

Preserve:

- form-owned actions,
- draft on conflict,
- focus containment/restoration,
- Escape behavior when safe,
- mobile full-width/safe-area behavior,
- native form controls unless a separate form migration is authorized.

### 4.6 Cancellation and confirmation

Remove:

```text
window.prompt
window.confirm
```

Manual-event cancellation requires a reason, therefore use `ReasonDialog` or a reason-owning confirmation dialog—not Popconfirm alone. Use `CompactConfirmationAction` only for short confirmation without extra input.

### 4.7 States

Adopt:

```text
LoadingSkeleton — page/calendar loading
ResultState     — blocking load error
EmptyState      — selected-day/no-event and authorized empty states
ResultState     — forbidden/not-found deep-link where applicable
```

Conflict and stale-version messages remain close to the form and preserve the draft.

### 4.8 Responsive behavior

Do not rely on a non-reactive one-time `window.innerWidth` snapshot for component mode. Use an owned responsive hook, Ant breakpoint only inside the adapter, or CSS/container behavior with deterministic tests.

Acceptance:

```text
390  — compact month + agenda; safe drawer; no horizontal overflow
768  — usable calendar/agenda transition
1024 — monthly grid + agenda with sidebar accounted for
1440 — balanced grid and agenda; no excessive empty space
200% text zoom — usable and no clipped controls
```

---

## 5. Explicit invariants

Do not change:

- migration `017_calendar.sql`,
- Staff/Manager/Admin authorization,
- JobCard scheduling authority,
- conflict rules,
- version checks,
- audit records,
- reminder worker,
- notification kinds and privacy,
- deep-link contract,
- API payloads,
- feature default-off behavior.

A server change requires a concrete visual-blocking defect and separate external review.

---

## 6. Tests

Minimum focused contracts:

- ServoraCalendar import boundary,
- custom header controls,
- selected date,
- bounded cell events and overflow,
- half-open multi-day mapping,
- mobile compact cell behavior,
- selected-day agenda,
- deep-linked event selection,
- reason-required cancellation without browser prompts,
- Drawer focus restoration,
- loading/error/empty state adapters,
- staff filter role visibility,
- no behavior/payload drift.

Run full web validation and existing U2 server validation authority.

---

## 7. Browser evidence

Required synthetic captures:

```text
staff-calendar-390
staff-calendar-768
staff-calendar-1024
manager-calendar-1024
admin-calendar-1440
calendar-selected-day
calendar-overflow-plus-n
calendar-empty-day
calendar-load-error
calendar-conflict-drawer
calendar-cancel-reason
calendar-deep-link
calendar-200-percent-text
```

Verify console, network, focus, overflow, deep links, and role scope.

Evidence README must contain no passwords, credentials, real names, customer data, or secrets.

---

## 8. Validation

```bash
cd web
npm test -- --run
npm run build
npm run bundle:check
npm run audit:high
npm run smoke:responsive
```

Boundary checks and full repository diff checks remain mandatory.

Verification:

```text
OpenCode independent-reviewer
OpenCode visual-verifier + Playwright MCP + Chrome DevTools MCP
external GPT-5.6 final review
```

---

## 9. Done criteria

```text
U2 domain behavior:
PRESERVED

Monthly Notice Calendar composition:
COMPLETE

Browser-native prompt/confirm:
REMOVED

Result/loading/empty adoption:
COMPLETE

390–1440 evidence:
COMPLETE

`[start, end)` helper contract:
PRESERVED with regression coverage

Independent review:
APPROVED

Exact-head CI:
SUCCESS

Workspace Visual Composition:
NOT AUTHORIZED until this corrective merge and resulting-main CI

U3:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```
