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
INTEGRATED INTO MAIN

Phase U documentation merge:
06a0d2a92d1776874ec5de13cf2d15e7c5e7460b

U1 code and automated-test implementation:
COMPLETE — Draft PR checkpoint

U1 implementation commit:
0d45d501a0ace8c54555efaccb431780a2818476

U1 direct browser verification:
PENDING — BLOCKED BY BROWSER AVAILABILITY

U1 persistent visual evidence:
PENDING

U1 visual acceptance:
NOT COMPLETE

U1 integration:
PENDING

U2:
NOT STARTED

U3:
NOT STARTED

T5:
NOT STARTED

Staging/production:
NOT AUTHORIZED
```

## U1 Draft PR checkpoint

The U1 implementation is based on exact Phase U documentation merge
`06a0d2a92d1776874ec5de13cf2d15e7c5e7460b`.

Implemented contracts:

- `OVERVIEW_DASHBOARD_ENABLED`, `CALENDAR_ENABLED`, and `MESSAGING_ENABLED`
  are explicit authenticated capabilities and default to `false`.
- Login and `/me` return the same capability and safe support configuration.
- `GET /api/overview` is server-gated and returns a Staff or Management
  discriminated union.
- Staff recent work and notes are limited to assigned JobCards; management
  results remain organization-scoped. Both recent lists use server-side
  `LIMIT 10` and deterministic timestamp/ID ordering.
- Root/login routing uses Overview only when enabled. Docs, Help, and the
  read-only Profile/Security/current-device Notification settings remain
  independently reachable.
- Overview realtime messages carry invalidation keys only; canonical data is
  refetched from REST.

Automated checkpoint:

```text
Focused server:
7 files / 120 tests PASS

Full local server DB suite:
NOT RUN
Reason: TEST_DATABASE_URL or DATABASE_URL unavailable
Security: no .env or credential was opened, copied or created
Final authority: exact-head GitHub CI server job

Web:
90 files / 1004 tests PASS

Server build:
PASS

Web build:
PASS

Server audit:
0 vulnerabilities

Web audit:
PASS_WITH_WAIVER — existing GHSA-qwww-vcr4-c8h2 RSC-only waiver

Bundle budget:
PASS — 39 JavaScript chunks, each at most 500000 bytes

Responsive smoke:
PASS
```

Direct self-review found and repaired one U1-owned issue: optional support
email and HTTPS URL parsing accepted unsafe mailto query and credential forms.
Server validation and client parsing now fail those values closed, with
regression coverage.

Direct browser verification was attempted through the configured browser
control surface, but no browser target was available. The 390/1024/1440
Staff/Manager/Admin matrix, capability-disabled rendered fallback,
console/network checks, genuine PNG evidence, and final visual acceptance
remain pending. No screenshot directory or placeholder evidence was created.
