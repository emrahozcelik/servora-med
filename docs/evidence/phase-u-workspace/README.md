# Phase U — Workspace Visual Composition Evidence

**Capture code SHA:** `004a001...`
**Date:** 2026-07-27
**Browser:** Playwright (Chromium) against real running backend
**Data:** Synthetic — all users (`@servora.local`), disposable test data
**API:** Real Fastify + PostgreSQL, CALENDAR_ENABLED=true, OVERVIEW_DASHBOARD_ENABLED=true

## Palette

Candidate B — Clinical Cool (canonical production palette)

| Token | Value |
|---|---|
| Paper | `oklch(99% 0.002 245deg)` |
| Canvas | `oklch(94% 0.01 245deg)` |
| Ink | `oklch(23% 0.018 250deg)` |
| Accent | `oklch(41% 0.13 242deg)` |
| Error | `oklch(36% 0.16 28deg)` |
| Success | `oklch(35% 0.09 150deg)` |

## Evidence manifest

| File | Role | Viewport | Scenario | Result |
|------|------|----------|----------|--------|
| overview-staff-390.png | STAFF | 390×844 | Overview KPI + sections | PASS |
| overview-manager-1024.png | MANAGER | 1024×768 | Overview + trend + approval | PASS |
| overview-admin-1440.png | ADMIN | 1440×900 | Wide overview | PASS |
| overview-200-percent-text.png | STAFF | 390×844 | 200% text resize | PASS |
| documentation-1024.png | STAFF | 1024×768 | Docs search + categories | PASS |
| documentation-long-content.png | STAFF | 1440×900 | Expanded ContentCollapse + Anchor | PASS |
| help-center-390.png | STAFF | 390×844 | Help mobile | PASS |
| help-center-1024.png | STAFF | 1024×768 | Help + support contact | PASS |
| settings-profile-390.png | STAFF | 390×844 | Profile mobile | PASS |
| settings-profile-1024.png | STAFF | 1024×768 | Profile + SettingsTabs + UserAvatar | PASS |
| result-403.png | STAFF | 390×844 | Forbidden ResultState | PASS |
| result-404.png | N/A | 390×844 | Not Found ResultState | PASS |
| calendar-regression-390.png | STAFF | 390×844 | Calendar header single-row | PASS |
| job-list-regression-1024.png | STAFF | 1024×768 | Job list intact | PASS |
| job-detail-regression-1440.png | STAFF | 1440×900 | Job detail intact | PASS |

## Verification summary

- **Web tests:** 94/94 PASS (1106 tests)
- **Build (web):** SUCCESS
- **Bundle check:** OK
- **smoke:responsive:** OK
- **Console/network:** Clean (no errors, no 4xx/5xx)
- **Candidate B accent:** Verified via computed style
- **Calendar regression:** PR #74 fixes intact (single-row header, short labels)
- **200% text resize:** No horizontal overflow

## Visual-verifier verdict: PASS

All 15 scenarios PASS. No blockers. One pre-existing Ant Descriptions warning on job detail — not a Phase U regression.

## Secrets check

No passwords, tokens, cookies, Authorization headers, or real user data in any evidence file.
