# PR D — Feedback and overlays design

**Date:** 2026-07-18  
**Owning PR:** PR D — Feedback and overlays  
**Base:** `main` at merge of PR #21 (`e73f056`)

## Goal

Introduce Servora-owned overlay and feedback adapters under `web/src/ui/antd/` so feature screens stop growing ad-hoc dialog, sheet, and toast code. Preserve existing accessibility contracts (focus trap, Escape, restoration, pending lock, labelled titles) and keep lifecycle permissions, readiness, and API commands outside adapters.

## Non-goals

- AppShell navigation drawer replacement (parity tests required first; not first slice)
- Report tables (PR E)
- Charts (PR F)
- Lifecycle primary actions inside Dropdown
- Collecting revision/cancel reasons with Popconfirm
- Changing backend contracts, JobCard state machine, or command intents
- Broad visual redesign of list/detail pages

## Owned adapters (PR D)

| Adapter | Role | Ant primitive |
| --- | --- | --- |
| `useAppFeedback` (extend) | Typed success / informational toast and non-critical notice | App.useApp `message` / `notification` |
| `ConfirmationAction` | Short, single-outcome confirm with optional consequence list | Popconfirm **or** owned modal shell when consequence is multi-line |
| `ReasonDialog` | Required reason capture (revision, cancel, similar) | Modal-class dialog (owned), never Popconfirm |
| `ResponsiveDrawer` | Mobile filter / secondary sheet with shared a11y | Drawer or owned sheet parity with `FilterSheet` |
| `ResultState` | Forbidden / not found / success / retryable failure | Result |
| `EmptyState` / `LoadingSkeleton` | Operational empty and stable loading | Empty, Skeleton |
| `OperationalDropdown` | Secondary, low-frequency commands only | Dropdown |

## Composition rules

1. **Adapters render and orchestrate presentation only.** They receive titles, labels, consequences, pending flags, and callbacks. They do not call job APIs, invent permissions, or decide readiness.
2. **Feedback goes through `useAppFeedback` only.** No static `message.success`, `Modal.confirm`, or `notification.open` in feature modules.
3. **Critical errors stay inline** (field `role="alert"`, detail feedback banners). Toasts are for non-blocking success / secondary notice.
4. **Reason capture always uses a full dialog** with labelled textarea, client validation, pending disable, Escape-when-safe, and focus restore to the trigger.
5. **Short confirmations** may use Popconfirm when: single outcome, no free-text reason, short copy, and no complex lifecycle consequence list that needs a multi-line dialog.
6. **Lifecycle primary actions** remain visible buttons (JobDecisionPanel / list commands). Dropdown may hold secondary only (for example share-less admin helpers if added later).
7. **Filter sheet migration** must keep: 64rem desktop gate, body scroll lock, Escape, focus trap, apply/clear/dismiss, return focus to trigger, and existing active-filter count UX.
8. **AppShell drawer** is out of the first migration slice. A later optional slice may compare Ant Drawer only after behavior parity tests against the current shell drawer.

## Migration map (first PR D ship)

| Current surface | Target |
| --- | --- |
| Product / customer delete confirm dialogs | `ConfirmationAction` (short single-outcome) |
| `JobWorkflowDialog` approve / withdraw-edit | `ConfirmationAction` with multi-line consequence (modal form) |
| `JobWorkflowDialog` revision / cancel | `ReasonDialog` |
| `FilterSheet` (jobs + customers) | `ResponsiveDrawer` preserving contracts |
| Success-only ephemeral copy (where already toast-like) | `useAppFeedback().message` |
| Inline empty lists (minimal) | `EmptyState` only where a shared empty contract already fits |
| Loading placeholders that already exist | `LoadingSkeleton` only where geometry is stable |

Out of first ship unless time remains: operational dropdown adoption, ResultState on every route, shell navigation drawer.

## Accessibility contract

Every overlay must provide:

- labelled title (`aria-labelledby` or equivalent)
- modal semantics when blocking (`role="dialog"` + `aria-modal="true"` or Ant equivalent that yields the same tree)
- initial focus inside the overlay
- Tab cycle containment
- Escape dismiss when not pending
- focus restoration to the opener
- pending lock: no double submit; cancel disabled or no-op while pending only if product already does that
- reduced-motion: no required entrance animation for correctness

Tests must cover Escape, restore, pending duplicate prevention, and reason validation where applicable.

## Provider / boundary

- All Ant imports remain under `web/src/ui/antd/` (plus existing reviewed foundation).
- Feature code imports adapters from `web/src/ui/antd` or thin re-exports under `web/src/ui/` when the surface is not Ant-backed (`FilterSheet` may become a re-export of `ResponsiveDrawer`).
- `prefixCls="servora-ant"` stays global; owned CSS targets `servora-ant-*` only for Ant internals.

## Verification bar

- Focused unit/integration tests for each new adapter
- Existing job-detail, manager-review, filter-sheet, product/customer delete, and app-shell drawer tests still pass
- Escape + focus restoration regression for dialog migrations
- Pending action cannot fire twice
- `cd web && npm test -- --run`
- `cd web && npm run build`
- `cd web && npm run smoke:responsive` when layout-affecting drawer changes land
- Server suite unchanged unless a doc-only path requires it; CI must still be green

## Exit criteria

PR D is mergeable when:

1. Owned adapters exist and are the only Ant overlay entry points used by migrated call sites.
2. Job workflow reason and confirmation paths keep product copy and server command ownership.
3. Mobile filters keep parity with pre-migration FilterSheet behavior.
4. No lifecycle primary action lives only inside a Dropdown.
5. Docs (`SERVORA-IMPLEMENTATION-PLAN.md`, architecture surface list) record PR D completion and leave PR E next.
