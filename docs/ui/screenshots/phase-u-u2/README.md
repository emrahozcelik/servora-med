# Phase U2 browser evidence

Status: **COMPLETE** (Round 1 + Round 2)

Capture commit: `8796c053fe8512414e5f070f35931e29fdf1e9d4`
Capture dates: 2026-07-26
Browser: Chromium 140 (Playwright 1.55.1), headless
Database: disposable `servora_u2_browser` seeded with synthetic identities
Pre-created fixture: JobCard `69f133f4` ("Test zamanlı teslimat", PRODUCT_DELIVERY, scheduledAt/EndsAt, assigned to Demo Staff)

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
| `admin-calendar-1024.png` | ADMIN | 1024×768 | Organization-wide calendar with staff filter | ✓ |
| `staff-calendar-zoom-390.png` | STAFF | 390×844 | Calendar at 200% text zoom — no overflow, controls accessible | ✓ |
| `staff-calendar-job-deeplink-390.png` | STAFF | 390×844 | JobCard detail page reached via "İşi aç" link from calendar event | ✓ |

## Verified contracts

- [x] Staff sees only own calendar events
- [x] Manager sees authorized team calendar
- [x] Admin sees organization-wide calendar with staff filter
- [x] Manager can filter by staff
- [x] CALENDAR_CONFLICT returns 409 with preserved draft
- [x] Manual event create form (mobile and desktop)
- [x] JOB/MANUAL discrimination in list
- [x] JobCard deep-link ("İşi aç") navigates to canonical job detail
- [x] Overview upcoming-work widget renders for both roles
- [x] Calendar notification route accessible
- [x] `/calendar` redirects to `/jobs` when capability disabled
- [x] "Takvim" navigation hidden when capability disabled
- [x] 200% text zoom: navigation usable, no horizontal overflow, forms reflow
- [x] No PII or real customer data in any screenshot
- [x] No secrets, credentials, or production data

## Console errors

- 401 (Unauthorized) × 4: Non-impact resource loads during page transitions (Round 1)
- 409 (Conflict): **Expected** — CALENDAR_CONFLICT test case (Round 1)
- Round 2 (visual-verifier): **0 application errors** — only benign navigation-race aborts on `/api/notifications/unread-count`

## NOT VERIFIED (documented limitation)

- [ ] Stale-version (VERSION_CONFLICT) recovery — requires concurrent edit simulation
- [ ] Service-worker Web Push delivery path — `WEB_PUSH_ENABLED=false` in test config
- [ ] Reminder worker runtime behavior — requires separate worker-process observation
- [ ] SSE realtime invalidation — requires WebSocket observation in browser

## Deferred scenarios

These are documented explicitly. Server-side contracts are covered by automated tests:

