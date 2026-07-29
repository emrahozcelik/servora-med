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

U1:
COMPLETE / INTEGRATED — PR #70

U1 implementation commit:
0d45d501a0ace8c54555efaccb431780a2818476

U1 direct browser verification:
COMPLETE — Playwright MCP matrix plus Chrome DevTools MCP spot-check

U1 persistent visual evidence:
COMPLETE — `docs/ui/screenshots/phase-u-u1/`

U1 integration:
COMPLETE — merged at 5d5ee5dc15638b94ed3c3267971839b4c6fa36dd

U2:
COMPLETE / INTEGRATED — PR #72

U2 calendar visual correction:
COMPLETE / INTEGRATED — PR #74

U2 browser verification:
COMPLETE — Playwright MCP matrix, Chrome DevTools spot-check

U2 persistent evidence:
COMPLETE — 16 PNGs in docs/ui/screenshots/phase-u-u2/

U2 integration:
COMPLETE — merged at 8cbb8b5a7c65e391f1b007919db40e1b098bc2ae

U2 merge baseline:
5d5ee5dc15638b94ed3c3267971839b4c6fa36dd

U2 visual code SHA:
d516a61f8a8a8b6add2a5e3d19354ffebc8ff839

U2 clean branch:
feat/phase-u-calendar-planning-clean

PR #71:
SUPERSEDED / CLOSED

PR #72:
MERGED — https://github.com/emrahozcelik/servora-med/pull/72

U3:
COMPLETE / INTEGRATED — PR #76 merged at f43e48fcb9875082b605c357343916d4c8007c84

T5:
COMPLETE / MERGED — PR #77

T5 approved head:
e19b937c017d880ae65a630bd8515e0961c65219

T5 merge commit:
41f893a9cd90dc7c62b5047c6946a3de5b6a40d1

T5 resulting-main CI:
30470763526 — SUCCESS

Next product phase:
PRODUCT DECISION REQUIRED

No next implementation phase is automatically authorized.
A bounded product decision and canonical plan are required.

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
109 files / 1323 of 1324 tests PASS on a disposable migrated database
One environment-contract test cannot pass because the local Homebrew
PostgreSQL host accepts an intentionally wrong password through trust auth
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

Direct Playwright MCP verification completed the Staff and Manager
390/1024/1440 matrix, Admin 1024 check, empty/error states, Docs/Help/Settings,
mobile drawer, keyboard focus, and capability-disabled fallback. Chrome
DevTools MCP independently repeated the Manager 1024 console/network and
rendered-state check. No horizontal overflow, clipped inspected headings,
application console errors, unexpected network failures, role leakage,
password values, push endpoints, or keys were observed.

Twelve genuine synthetic PNGs and their per-capture contract index are stored
under `docs/ui/screenshots/phase-u-u1/`. Their exact visual code/capture head is
`2e353a461729b483668c36ae914a4ff580a8991b`.
