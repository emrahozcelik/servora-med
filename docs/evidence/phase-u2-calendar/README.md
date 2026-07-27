# Phase U2 — Calendar Runtime Visual Evidence

**Capture code SHA:**
- Screenshot'ların alındığı anda çalışan uygulama kodu SHA'sı.

**Evidence commit:**
- Git history'deki commit; README kendi commit SHA'sını yazmaya çalışmaz.

**Capture-time SHA:** `fcc310bcf8225f8418b6e83e8ad6328e8ba5ef33`
**Date:** 2026-07-27
**Browser:** Playwright (Chromium) + Chrome DevTools against real running backend
**Data:** Synthetic — all users (`@servora.local`), events, and assignees are disposable test data
**API:** **Real Calendar API** — Fastify server with PostgreSQL `servora_med_calendar_acceptance` database, 17 migrations applied, `CALENDAR_ENABLED=true`

## Repair fixes applied

1. **Empty toolbar removed for STAFF** — `<div className="calendar-toolbar surface">` conditionally renders only for non-STAFF roles (MANAGER/ADMIN)
2. **Calendar header nowrap at all viewports** — `flex-wrap: nowrap` + `min-width: 0` on children keeps prev/today/next on single row
3. **Compact prev/next arrows** — `‹` / `›` instead of `‹ Önceki` / `Sonraki ›` in compact mode; `aria-label` preserves accessible names
4. **Mobile bottom nav short labels** — `shortLabel` on long items ("Müşteriler"→"Müşt.", "Ürünler"→"Ürün.", "Genel Bakış"→"Bakış", "Raporlar"→"Rapor"); accessible names preserved via `aria-label`
5. **Shell-content padding** — increased to `calc(8rem + ...)` for text-resize clearance

## Evidence manifest

| File | Role | Viewport | Scenario | Method | Result |
|------|------|----------|----------|--------|--------|
| staff-calendar-390.png | STAFF | 390×844 | Compact mobile — NO empty toolbar | Real API | PASS |
| staff-calendar-768.png | STAFF | 768×1024 | Tablet transition | Real API | PASS |
| staff-calendar-1024.png | STAFF | 1024×768 | Desktop calendar | Real API | PASS |
| manager-calendar-1024.png | MANAGER | 1024×768 | Desktop with staff filter, header single-line | Real API | PASS |
| admin-calendar-1440.png | ADMIN | 1440×900 | Wide desktop with filter | Real API | PASS |
| calendar-selected-day-card.png | STAFF | 1440×900 | July 15 agenda with 10 OperationalCards | Real API | PASS |
| calendar-empty-day.png | STAFF | 1440×900 | EmptyState "Bu gün için plan bulunmuyor" | Real API | PASS |
| calendar-load-error.png | STAFF | 390×844 | ResultState with "Tekrar dene" retry | Real API | PASS |
| calendar-overflow-plus-n.png | STAFF | 1440×900 | "+7 plan" overflow indicator (10 events on July 15) | Real API | PASS |
| calendar-200-percent-text.png | STAFF | 390×844 | **200% text resize** via `html { font-size: 200% !important }` | Real API | PASS |
| calendar-cancel-reason.png | STAFF | 1440×900 | ReasonDialog "Plan iptali" with required reason | Real API | PASS |
| calendar-cancel-error.png | STAFF | 1440×900 | Cancel validation error "Neden alanı zorunludur." | Real API | PASS |
| calendar-deep-link.png | STAFF | 1280×800 | Deep-linked via `/calendar?date=2026-07-15` | Real API | PASS |
| calendar-conflict-drawer.png | STAFF | 1440×900 | Real 409 Conflict: "Bu zaman aralığı başka bir planla çakışıyor. Taslağınız korundu." | Real API | PASS |

## 200% text resize method

Repository-standard method: `html { font-size: 200% !important; }` injected via Playwright `addStyleTag`.
This is **text resize**, not browser zoom (Ctrl/Cmd +).

Verified at 390px viewport with 200% text resize:
- No horizontal overflow (scrollWidth 375 === clientWidth 375)
- Bottom nav labels display as shortened forms ("Müşt.", "Ürün.") — no mid-word breaking
- Calendar header stays single-row (flex-wrap: nowrap, min-width: 0) — no control overlap with nav
- Accessible names preserved on shortened nav items via `aria-label`
- Clear 4px gap between header button bottom and nav top

## Verification summary

- **Web tests:** 93/93 PASS (1058 tests)
- **Build (web):** SUCCESS
- **Build (server):** SUCCESS
- **Bundle check:** OK
- **Audit:** PASS_WITH_WAIVER
- **smoke:responsive:** OK (all viewports including 200% text, 400% WCAG reflow)
- **Capture-code CI:** PENDING (check via gh pr checks 74 after push)

## Visual-verifier verdict: PASS

Four Playwright/Chrome DevTools sessions verified all 14 scenarios against the real running backend:

- **Session 1:** STAFF 390/768/1024, 200% text resize, deep link, load error — PASS
- **Session 2:** MANAGER 1024 (header single-line verified), ADMIN 1440, overflow +N, selected day cards — PASS
- **Session 3:** Cancel ReasonDialog, cancel error, conflict drawer (409), empty day — PASS
- All sessions: real API, no route interception, no mocking

### Key blocker verifications
- **STAFF 390 empty toolbar:** GONE — `document.querySelector('.calendar-toolbar')` returns null ✅
- **MANAGER 1024 header single-line:** All elements share same bounding box top ✅
- **200% text resize:** No overlap (4px gap), no mid-word breaks, no horizontal overflow, accessible names preserved ✅
- **Calendar header nowrap:** Single row at all viewports including 200% text resize ✅

## Secrets check

No passwords, tokens, cookies, Authorization headers, connection strings, `.env` contents, or real user data in any evidence file. All credentials are disposable synthetic acceptance accounts.
