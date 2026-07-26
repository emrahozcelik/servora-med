# Servora-Med Phase U Superpowers Package

This package contains the proposed product/design specification and implementation plan for the role-aware Servora workspace.

## Files

```text
docs/superpowers/specs/2026-07-25-phase-u-servora-workspace-design.md
docs/superpowers/plans/2026-07-25-phase-u-servora-workspace.md
```

## Intended order

```text
Finish and merge Phase T4
→ run Phase U repository preflight (U0)
→ external review
→ implement U1
→ merge/main-CI gate
→ implement U2
→ merge/main-CI gate
→ implement U3
→ Phase U external closeout
→ Phase T5 final visual/state regression closeout
```

## Delivery structure

```text
U1 — Workspace foundation, overview, docs/help and settings
U2 — Calendar, scheduling and reminders
U3 — Messaging and advanced dashboard analytics
```

The work is intentionally limited to three substantial implementation slices.

## Important architecture decision

The downloaded shadcn dashboard is a visual and information-architecture reference.

Servora-Med should not migrate to Tailwind or shadcn/ui for this program. The implementation should use:

- existing Servora AppShell,
- Servora visual tokens and CSS,
- owned Ant adapters,
- current reporting/chart primitives,
- existing notification center,
- existing SSE/Web Push infrastructure,
- existing authorization and domain services.

## Gate state

```text
Phase T4:
COMPLETE and integrated into main

T4 merge commit:
0f47841ea23d744c188a7fecf12050f585296f34

T4 resulting-main CI:
SUCCESS

U0 repository preflight:
COMPLETE

U0 external review:
APPROVED WITH DOCUMENT AMENDMENTS

Phase U documentation:
THIS DOCS-ONLY DRAFT PR

U1 implementation:
NOT AUTHORIZED

U2/U3:
NOT AUTHORIZED

T5:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```
