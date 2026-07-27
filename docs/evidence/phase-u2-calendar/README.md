# Phase U2 — Calendar Runtime Visual Evidence

**Capture code SHA:** `a72d38e1d60cead0bd9d6ab467f9a1813d14678f`
**Date:** 2026-07-27
**Browser:** Playwright (Chromium) against real running backend
**Data:** Synthetic — all users (`@servora.local`), events, and assignees are disposable test data
**API:** **Real Calendar API** — Fastify server with PostgreSQL `servora_med_calendar_acceptance` database, 17 migrations applied, `CALENDAR_ENABLED=true`

## Evidence manifest

| File | Role | Viewport | Scenario | Result |
|------|------|----------|----------|--------|
| staff-calendar-390.png | STAFF | 390×844 | Compact mobile calendar with events | PASS |
| staff-calendar-768.png | STAFF | 768×1024 | Tablet transition | PASS |
| staff-calendar-1024.png | STAFF | 1024×768 | Desktop calendar (no staff filter for STAFF role) | PASS |
| manager-calendar-1024.png | MANAGER | 1024×768 | Desktop with staff filter visible | PASS |
| admin-calendar-1440.png | ADMIN | 1440×900 | Wide desktop with staff filter and admin sidebar | PASS |
| calendar-selected-day-card.png | STAFF | 1024×768 | Selected-day agenda (July 15) with OperationalCard showing event title, time, assignee, edit/cancel buttons | PASS |
| calendar-empty-day.png | STAFF | 1024×768 | EmptyState for day with no events ("Bu gün için plan bulunmuyor") | PASS |
| calendar-load-error.png | STAFF | 1280×800 | ResultState on API failure: alert icon, "Takvim yüklenemedi", "Tekrar dene" retry button | PASS |
| calendar-overflow-plus-n.png | MANAGER | 1024×768 | "+6 plan" overflow indicator in calendar cell (July 15 has 10 events) | PASS |
| calendar-200-percent-text.png | STAFF | 390×844 | **Real 200% browser text zoom** (scrollWidth=375, clientWidth=375, NO overflow) | PASS |
| calendar-cancel-reason.png | STAFF | 1024×768 | ReasonDialog for manual event cancel ("Plan iptali" with required reason field) | PASS |
| calendar-cancel-error.png | STAFF | 1024×768 | Cancel API validation error ("Neden alanı zorunludur.") | PASS |
| calendar-deep-link.png | STAFF | 1280×800 | Deep-linked event via `/calendar?date=2026-07-15` — side panel shows "15 Temmuz Çarşamba" with 9 event cards | PASS |
| calendar-conflict-drawer.png | STAFF | 1280×800 | Conflict drawer: inline alert "Bu zaman aralığı başka bir planla çakışıyor. Taslağınız korundu." with conflict detail, server returns 409 | PASS |

## All scenarios captured

- [x] `calendar-conflict-drawer.png` — **PRESENT** (previously missing)
- [x] Real 200% browser text zoom (not deviceScaleFactor)
- [x] Real Calendar API backend (not mocked)
- [x] All 14 required PNGs present

## Verification summary

- **Server tests:** 110/114 PASS (4 failures: db-auth-contract.test.ts — superuser role creation, unrelated to Calendar)
- **Web tests:** 93/93 PASS (1058 tests)
- **Build (web):** SUCCESS (1581 modules)
- **Build (server):** SUCCESS
- **Bundle check:** OK (44 chunks, all under 500KB)
- **Audit:** PASS_WITH_WAIVER (GHSA-qwww-vcr4-c8h2 RSC-only)
- **smoke:responsive:** OK (all viewports: 1440, 390, 320, 200% font, WCAG 400%)
- **CI:** Exact-head CI NOT VERIFIED (Draft PR, not yet re-run with latest evidence)

## Visual-verifier findings

- **Console errors:** None in normal operation. Intentional 500 errors during error state testing only.
- **Network failures:** None in normal operation. 409 Conflict returned correctly during conflict drawer test.
- **Horizontal overflow:** NONE at any viewport (390, 768, 1024, 1280, 1440). Verified at 200% zoom.
- **Layout issues:** None found.
- **Accessibility:** Focus order correct, accessible names present, touch targets adequate.

## Playwright acceptance

All scenarios executed via Playwright (Chromium) against `http://localhost:5173` with real backend at `http://127.0.0.1:3000`. Login flow verified for all 3 synthetic roles. Calendar navigation (prev/next/today), date selection, event creation, event cancellation, conflict detection, deep linking, error states, and responsive layouts verified.

## Secrets check

No passwords, tokens, cookies, Authorization headers, connection strings, `.env` contents, or real user/customer/patient data are present in any evidence file. All credentials are disposable synthetic acceptance accounts.
