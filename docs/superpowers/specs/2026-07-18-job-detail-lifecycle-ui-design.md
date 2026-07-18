# Job Detail Lifecycle UI Design

**Date:** 18 July 2026
**Status:** Approved
**Owning PR:** PR C — Job detail lifecycle UI

## Goal

Make JobCard lifecycle truth, current responsibility, record requirements, decisions, revision context, terminal outcomes, and audit history easier to understand without recreating backend permissions, readiness, transitions, or activity records in the UI.

## Architecture

The existing API response and `JobWorkflowPresentation` remain the source for all display decisions. `JobDetail` composes Servora-owned panels and thin Ant Design adapters. Adapters render prepared presentation data only; they do not call APIs, derive permissions or readiness, create command intents, translate domain status, or invent Timeline events.

The active status presentation model moves from lane-specific ownership into neutral `job-status-presentation.ts` ownership because detail, filter, chip, summary, and lane consumers share it. This is a cohesion move only and does not change persisted status or domain behavior.

The stable data flow is:

```text
API truth
→ existing JobWorkflowPresentation
→ Servora-owned panels and adapters
→ existing command intent
→ existing dialog when required
→ existing API/domain command
→ refreshed server truth
```

## Owned Adapter Boundary

PR C adds these files under `web/src/ui/antd/`:

- `WorkflowSteps.tsx` wraps Ant Design `Steps`.
- `RecordDescriptions.tsx` wraps Ant Design `Descriptions`.
- `ActivityTimeline.tsx` wraps Ant Design `Timeline`.

Only these owned adapters may import those three Ant primitives. Feature components receive narrow, typed presentation inputs and never receive raw domain permission logic through the adapters.

`WorkflowSteps` preserves complete, current, upcoming, skipped, attention/correction-loop, and cancelled semantics. Current steps expose `aria-current="step"`; every state has text or icon semantics in addition to color. It is horizontal when usable desktop width permits and vertical on narrow layouts.

`RecordDescriptions` presents read-only facts in one column on mobile and two columns where desktop width permits. It never replaces editable controls.

`ActivityTimeline` presents action, actor, time, description, and reason in the existing newest-first order. Existing loading, retry, unknown-event fallback, pagination, and refresh behavior remain owned by `JobTimeline`.

## Detail Composition

The mobile-first document order is title, lifecycle, responsibility, facts, type-specific content, requirements, action or decision panel, then Timeline. Desktop CSS Grid may place requirements and actions in a right column, but DOM and keyboard order do not change.

### Staff IN_PROGRESS

```text
Lifecycle
→ Responsibility
→ Record facts
→ Delivery or type-specific content
→ Requirements
→ Submit for control action
→ Timeline
```

The primary action appears only when the existing presentation/command contract allows it. Backend readiness is authoritative. Missing or invalid requirements are explained beside the action instead of being represented only by a disabled button.

### Manager WAITING_APPROVAL

```text
Lifecycle
→ Manager responsibility
→ Submission and requirement facts
→ Delivery records
→ Decision panel
→ Timeline
```

The panel renders only existing permitted decisions. “Kontrolü tamamla ve işi kapat” and “Düzeltme için personele geri gönder” invoke the existing command intents and accessible dialogs.

### Staff REVISION_REQUESTED

```text
Heading
→ Prominent revision panel
→ Correction-loop lifecycle
→ Responsibility
→ Preserved records
→ Requirements
→ Start correction action
→ Timeline
```

The revision reason, actor, and time remain visible above the fold and are not discoverable only through Timeline. “Düzeltmeye başla” is shown only when it maps to an existing backend command intent.

### Terminal States

COMPLETED uses true success treatment, identifies who approved it and when, and exposes no active checklist or lifecycle action. CANCELLED is read-only without green success treatment and shows reason, actor, time, and source phase only when supplied by API truth or the existing presentation model. The UI does not infer a cancellation source phase from activity history.

## Servora-Owned Panels

- Responsibility panel states who acts next and explains the consequence of the available primary command.
- Requirements checklist renders backend-derived met, missing, and invalid requirements with Turkish labels and non-color semantics.
- Manager decision panel renders only supplied decisions and invokes existing command intents.
- Revision panel renders supplied reason, actor, and time.
- Terminal banner differentiates successful completion from cancellation.

If revision, cancellation, completion, decision, or readiness data is absent from the current presentation contract, the presentation builder may be extended from existing API truth with focused tests. Components must not derive missing values.

## Overlay Boundary

PR C preserves existing approval confirmation, revision-reason, cancellation, and confirmation dialogs. Moving a trigger into a new panel and updating approved product copy is allowed. Rewriting dialog DOM, focus trap, portal behavior, reason validation, backdrop/Escape policy, or feedback is forbidden.

Ant `Modal`, `Popconfirm`, `ConfirmationAction`, reason-dialog adapters, toast/message standardization, `Drawer`, `Dropdown`, and feedback migration belong to PR D. Existing focus restoration must return to the new trigger and is covered by integration tests.

## Error and Refresh Behavior

Existing inline loading, retryable error, forbidden behavior, command pending lock, duplicate-submit prevention, and stale-version server refresh remain intact. Successful commands refresh server truth; the UI does not advance local workflow status optimistically. Critical errors, readiness explanations, decisions, and revision reasons stay inline or in the existing dialog, never only in a toast.

## Accessibility and Responsive Contract

- Interactive targets are at least 44 by 44 CSS pixels.
- Focus remains visible and dialog focus returns to the new trigger.
- Meaning never depends on color alone.
- Mobile DOM puts the primary action before Timeline.
- Layout supports 390, 768, 1024, and 1440 pixel viewports, 200 percent text, and 320 pixel 400 percent reflow without horizontal task scrolling or clipped meaning.
- Reduced-motion preferences remain governed by the existing Ant provider and CSS contracts.

## Test Contract

- Adapter contract tests prove that prepared presentation inputs are rendered without API, permission, readiness, or command logic.
- Staff IN_PROGRESS tests cover readiness explanation, permitted command, and action-before-Timeline order.
- Manager WAITING_APPROVAL tests cover permitted decisions, existing dialog intents, pending lock, and focus restoration.
- Staff REVISION_REQUESTED tests cover above-the-fold reason/actor/time and correction-loop semantics.
- COMPLETED and CANCELLED tests assert distinct terminal semantics.
- Timeline tests preserve newest-first ordering, reason, actor, time, unknown-event fallback, retry, pagination, and refresh.
- Architecture tests allow Ant `Steps`, `Descriptions`, and `Timeline` imports only in the three owned adapters.
- Responsive smoke and full web/server regression suites run before completion.

## Non-Goals

- No backend, migration, API, state-machine, permission, readiness, transition, or audit-event changes.
- No direct Ant primitive use in feature components.
- No overlay or feedback migration.
- No unrelated JobCard refactor and no PR D work.
