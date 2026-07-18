# PR D — Feedback and overlays design

**Date:** 2026-07-18
**Owning PR:** PR D — Feedback and overlays
**Base:** `main` at merge of PR #21 (`e73f056`)
**Status:** Scope narrowed and approved for implementation (18 July 2026 review)

## Goal

Migrate existing high-risk dialog and filter overlays into Servora-owned adapters under `web/src/ui/antd/` without losing accessibility or domain authority.

## Approved PR D ship scope (narrowed)

1. `ConfirmationAction` — **modal-only** (Popconfirm deferred)
2. `ReasonDialog` — required reason capture
3. `ResponsiveDrawer` — **only** existing Job and Customer filter sheets

### Explicitly out of PR D

- `ResultState`, `EmptyState`, `LoadingSkeleton`
- `OperationalDropdown`
- AppShell navigation drawer
- Broad toast migration
- Popconfirm support on `ConfirmationAction`

## Approved decisions (must remain true)

### 1. ConfirmationAction is modal-only in PR D

Do not branch on short vs long copy to pick Popconfirm. All first migration surfaces are high-impact (product delete, customer delete, approve-and-complete, withdraw-and-edit). Popconfirm may be added later for a proven low-risk secondary use.

```ts
type ConfirmationActionProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  details?: readonly string[];
  confirmLabel: string;
  cancelLabel?: string;
  pending: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};
```

The adapter must not:

- choose Popconfirm because text is short
- invent destructive vs primary from domain rules (caller passes `destructive`)
- produce commands or consequences
- calculate permissions

### 2. State / focus ownership

```text
Feature
→ open/closed intent
→ command presentation copy
→ pending flag
→ command callback

Adapter
→ dialog DOM
→ transient reason draft/error (ReasonDialog only)
→ focus trap
→ Escape policy
→ opener capture and focus restoration
```

Focus restoration has **one owner: the adapter**. Parent-side restoration used only for these overlays must be removed during migration so both do not restore focus.

Initial focus parity (do not change in PR D):

- confirmation dialog → **Vazgeç**
- reason dialog → **Vazgeç**

Do not auto-focus the reason textarea.

### 3. ReasonDialog

```ts
type ReasonDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  reasonLabel: string;
  confirmLabel: string;
  cancelLabel?: string;
  maxLength: number;
  required: boolean;
  pending: boolean;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};
```

Acceptance:

- whitespace-only reason rejected when required
- error linked via `aria-describedby` and `role="alert"`
- 2000 character limit preserved where callers set it
- pending prevents double submit
- Escape/cancel while pending match existing behavior
- reopening clears prior reason/error draft

### 4. ResponsiveDrawer (filters only)

Preserve FilterSheet contracts for JobFilters and Customer filters. AppShell drawer unchanged.

| Behavior | Expectation |
| --- | --- |
| Open | Close/Vazgeç control receives focus |
| Escape | Panel closes |
| Mask/backdrop | `onDismiss` |
| Tab / Shift+Tab | Cycles inside panel |
| Body scroll | Locked while open; restored on close |
| Focus restoration | Returns to provided trigger ref |
| Vazgeç | Draft not applied |
| Uygula | Only `onApply` |
| Temizle | Only `onClear`; does not auto-close |
| Unmount | No leftover body scroll lock |
| Desktop | Existing caller gate preserved |
| AppShell | Unchanged |

### 5. useAppFeedback

Do not expand into a speculative helper SSOT. Critical errors stay inline. Only truly ephemeral success/secondary notices use feedback if a real migrated call site needs it. Task 1 may remain a no-op beyond existing boundary tests.

## Migration map

| Current surface | Target |
| --- | --- |
| Product / customer delete dialogs | `ConfirmationAction` |
| `JobWorkflowDialog` approve / withdraw-edit | `ConfirmationAction` |
| `JobWorkflowDialog` revision / cancel | `ReasonDialog` |
| `FilterSheet` (jobs + customers) | `ResponsiveDrawer` |

## Boundary

- Ant imports remain under `web/src/ui/antd/` only.
- Adapters are presentation/orchestration only.
- Domain commands, readiness, and permissions stay in feature/service layers.

## Exit criteria

1. Three owned adapters exist and own the migrated call sites above.
2. Job workflow reason/confirmation paths keep product copy and server command ownership.
3. Filter sheets keep apply/clear/dismiss and focus contracts.
4. AppShell drawer unchanged.
5. No Popconfirm, Result/Empty/Skeleton, or OperationalDropdown ship in this PR.
6. Docs and CI green; PR remains draft until review.
