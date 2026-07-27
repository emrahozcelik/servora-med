# Phase U2 — Calendar Runtime Visual Evidence

**Capture code SHA:** `81f015e` (approximate — evidence captured against live runtime at this commit)
**Date:** 2026-07-27
**Browser:** System Google Chrome via Playwright `channel: 'chrome'`, headless mode
**Data:** Synthetic — all users (`@servora.local`), events, and assignees are mock/test data
**API:** Mocked via Playwright route interception (`{ items: [...] }` format)

## Evidence manifest

| File | Role | Viewport | Scenario | Result |
|------|------|----------|----------|--------|
| staff-calendar-390.png | STAFF | 390×844 | Compact mobile calendar | PASS |
| staff-calendar-768.png | STAFF | 768×1024 | Tablet transition | PASS |
| staff-calendar-1024.png | STAFF | 1024×768 | Desktop calendar | PASS |
| manager-calendar-1024.png | MANAGER | 1024×768 | Desktop with staff filter | PASS |
| admin-calendar-1440.png | ADMIN | 1440×900 | Wide desktop oversight | PASS |
| calendar-selected-day-card.png | MANAGER | 1024×768 | Selected-day agenda with OperationalCard | PASS |
| calendar-empty-day.png | MANAGER | 1024×768 | EmptyState for day with no events | PASS |
| calendar-load-error.png | MANAGER | 1024×768 | ResultState on API failure with retry | PASS |
| calendar-overflow-plus-n.png | ADMIN | 1024×768 | +N plan overflow in calendar cells | PASS |
| calendar-200-percent-text.png | MANAGER | 1024×768 (deviceScaleFactor:2) | 200% text zoom | PASS |
| calendar-cancel-reason.png | MANAGER | 1024×768 | ReasonDialog for manual event cancel | PASS |
| calendar-cancel-error.png | MANAGER | 1024×768 | Cancel API error shown in EventItem | PASS |
| calendar-deep-link.png | MANAGER | 1024×768 | Deep-linked event (?event=e1) | PASS |

## Not captured

- `calendar-conflict-drawer.png` — Yeni plan button disabled (mock API assignees list requires specific conditions)

## Verification summary

- **smoke:responsive:** OK (all viewports: 1440, 390, 320, 200% font)
- **Full test suite:** 1058/1058 PASS
- **Build:** SUCCESS (1581 modules)
- **Bundle check:** OK (43 chunks, all under 500KB)
- **Audit:** PASS_WITH_WAIVER
- **CI:** server SUCCESS, web SUCCESS

## Secrets check

No passwords, tokens, cookies, Authorization headers, connection strings, `.env` contents, or real user/customer/patient data are present in any evidence file.

## Playwright acceptance

All scenarios executed via `/tmp/cal-final.cjs` and individual scenario scripts against `http://localhost:5173` with mocked `/api/calendar*` endpoints. Login flow verified for all 3 synthetic roles (admin/manager/staff@servora.local).
