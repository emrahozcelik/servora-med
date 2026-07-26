# Phase U2 browser evidence — Monthly Calendar

Status: **COMPLETE** (visual correction round)

Capture commit: a81b308b27d04279d1823234063d695b810c1d85
Capture date: 2026-07-26
Browser: Chromium 140 (Playwright 1.55.1), headless
Database: disposable `servora_u2_v2` seeded with synthetic identities

## Synthetic identities

| Role    | Email                    |
|---------|--------------------------|
| STAFF   | staff@servora.local      |
| MANAGER | manager@servora.local    |
| ADMIN   | admin@servora.local      |

Organization: Servora Med Demo (synthetic)
Authentication material was supplied only to the disposable local runtime and is not documented here.

## Screenshot matrix — Monthly Calendar

| File | Role | Viewport | State | PII-free |
|------|------|----------|-------|----------|
| `staff-calendar-month-390.png` | STAFF | 390×844 | Compact monthly calendar + agenda | ✓ |
| `staff-calendar-month-1024.png` | STAFF | 1024×768 | Desktop monthly grid + agenda | ✓ |
| `staff-calendar-month-1440.png` | STAFF | 1440×900 | Large grid + agenda side-by-side | ✓ |
| `staff-selected-day-agenda-390.png` | STAFF | 390×844 | Selected-day agenda with events | ✓ |
| `staff-manual-create-drawer-390.png` | STAFF | 390×844 | New plan form in dedicated drawer | ✓ |
| `staff-calendar-conflict-drawer-390.png` | STAFF | 390×844 | CALENDAR_CONFLICT — drawer stays open, draft preserved | ✓ |
| `calendar-zoom-200-390.png` | STAFF | 390×844 | 200% text zoom — no overflow, controls reachable | ✓ |
| `calendar-job-deeplink-390.png` | STAFF | 390×844 | Deep-linked event selects month and date | ✓ |
| `manager-calendar-month-390.png` | MANAGER | 390×844 | Compact team month + Staff filter | ✓ |
| `manager-calendar-month-1440.png` | MANAGER | 1440×900 | Team month grid + agenda | ✓ |
| `manager-calendar-filtered-1024.png` | MANAGER | 1024×768 | Team calendar filtered to one staff | ✓ |
| `admin-calendar-month-1024.png` | ADMIN | 1024×768 | Organization calendar with staff filter | ✓ |
| `calendar-capability-off-390.png` | STAFF | 390×844 | /calendar falls back when disabled | ✓ |
| `overview-upcoming-staff.png` | STAFF | 390×844 | Overview upcoming-work widget | ✓ |
| `overview-upcoming-manager.png` | MANAGER | 1024×768 | Manager overview upcoming work | ✓ |
| `calendar-notification.png` | STAFF | 390×844 | Notification Center | ✓ |

## Verified contracts

- [x] Monthly calendar grid (ServoraCalendar adapter)
- [x] Selected-day agenda
- [x] Desktop grid + agenda split layout (≥1024px)
- [x] Compact mobile calendar with count markers
- [x] Staff owns only own calendar
- [x] Manager team filter
- [x] Admin organization-wide access
- [x] JOB/MANUAL source distinction (color + label)
- [x] Form in dedicated drawer (ResponsiveFormDrawer)
- [x] CALENDAR_CONFLICT preserves draft in drawer
- [x] Event deep-link selects month/date
- [x] JobCard deep-link available
- [x] 200% zoom — no overflow
- [x] Capability-off fallback
- [x] No raw antd imports outside ui/antd
- [x] No PII or credentials

## Console errors

- 401 (Unauthorized): benign resource loads during page transitions
- 409 (Conflict): expected CALENDAR_CONFLICT test case

## NOT VERIFIED

- Stale-version (VERSION_CONFLICT) recovery — concurrent edit simulation needed
- Web Push delivery — WEB_PUSH_ENABLED=false
- Reminder worker runtime — separate process observation needed
- SSE realtime — WebSocket observation needed
