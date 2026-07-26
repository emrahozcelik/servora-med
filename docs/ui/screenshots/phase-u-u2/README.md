# Phase U2 browser evidence

Status: **COMPLETE**

Capture commit: `8796c053fe8512414e5f070f35931e29fdf1e9d4`
Capture date: 2026-07-26
Browser: Chromium 140 (Playwright 1.55.1), headless
Database: disposable `servora_u2_browser` seeded with synthetic identities

## Synthetic identities

| Role    | Email                    | Password       |
|---------|--------------------------|----------------|
| STAFF   | staff@servora.local      | Demo1234!Test  |
| MANAGER | manager@servora.local    | Demo1234!Test  |
| ADMIN   | admin@servora.local      | Demo1234!Test  |

Organization: Servora Med Demo (synthetic)

## Screenshot matrix

| File | Role | Viewport | State | PII-free |
|------|------|----------|-------|----------|
| `staff-calendar-390.png` | STAFF | 390×844 | Personal calendar with JOB and MANUAL events | ✓ |
| `staff-calendar-1024.png` | STAFF | 1024×768 | Desktop personal calendar | ✓ |
| `staff-manual-create-390.png` | STAFF | 390×844 | Creating manual plan form (mobile) | ✓ |
| `staff-calendar-conflict-390.png` | STAFF | 390×844 | CALENDAR_CONFLICT error with preserved draft | ✓ |
| `calendar-empty.png` | STAFF | 390×844 | Empty week (distant future) | ✓ |
| `overview-upcoming-staff.png` | STAFF | 390×844 | Overview page with upcoming-work widget | ✓ |
| `manager-calendar-390.png` | MANAGER | 390×844 | Mobile team calendar with Staff filter | ✓ |
| `manager-calendar-1440.png` | MANAGER | 1440×900 | Large desktop team calendar | ✓ |
| `manager-calendar-filtered.png` | MANAGER | 1024×768 | Team calendar filtered to one staff | ✓ |
| `manager-creates-for-staff.png` | MANAGER | 1024×768 | Manager creating manual event for a staff member | ✓ |
| `overview-upcoming-manager.png` | MANAGER | 1024×768 | Manager overview with team upcoming work | ✓ |
| `calendar-notification.png` | STAFF | 390×844 | Notification Center showing calendar notifications | ✓ |
| `capability-off-overview.png` | STAFF | 390×844 | Overview when `CALENDAR_ENABLED=false` — widget absent | ✓ |

## Verified contracts

- [x] Staff sees only own calendar events
- [x] Manager sees authorized team calendar
- [x] Manager can filter by staff
- [x] CALENDAR_CONFLICT returns 409 with preserved draft
- [x] Manual event create form (mobile and desktop)
- [x] JOB/MANUAL discrimination in list
- [x] Overview upcoming-work widget renders for both roles
- [x] Calendar notification route accessible
- [x] `/calendar` redirects to `/jobs` when capability disabled
- [x] "Takvim" navigation hidden when capability disabled
- [x] No PII or real customer data in any screenshot
- [x] No secrets, credentials, or production data

## Console errors

- 401 (Unauthorized) × 4: Non-impact resource loads during page transitions
- 409 (Conflict): **Expected** — CALENDAR_CONFLICT test case

## NOT VERIFIED (documented limitation)

- [ ] 200% text zoom (headless Chromium does not reliably apply browser zoom)
- [ ] Stale-version (VERSION_CONFLICT) recovery — requires concurrent edit simulation
- [ ] JobCard reschedule deep-link end-to-end — no JobCard fixture in test database
- [ ] Service-worker Web Push delivery path — WEB_PUSH_ENABLED=false in test config
- [ ] Admin organization-wide calendar — verified structurally; role-tested as MANAGER
- [ ] Reminder worker runtime behavior — requires separate worker-process observation
- [ ] SSE realtime invalidation — requires WebSocket observation in browser

## Deferred scenarios

These are documented explicitly; automated tests cover the server-side contracts.

