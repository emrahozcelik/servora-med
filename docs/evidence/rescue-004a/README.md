# RESCUE-004/A Calendar rendered acceptance

Passed on November 28, 2026, at integrated application commit
`d4c1f2bd6eca94651a1cb5c39de6e5aa99def2ec` (built on reviewed backend base
`c71030671d562a436dc43e34efa9124b1d7b93ba`). Captures ran with Node `v22.23.3`,
headless Chromium `140.0.7339.186`, locale `tr-TR`, timezone `Europe/Istanbul`,
and fixed clock `2026-11-26T09:00:00.000Z`. The real Vite entry, `ServoraAntProvider`,
`AppShell`, `CalendarPage`, `ServoraCalendar`, and production CSS rendered against
deterministic synthetic API responses.

## Render matrix (all 7 modes)

| Mode | CSS viewport | DPR / scale / motion | Overflow X | Min touched target (CSS px) | Capture |
| --- | --- | --- | --- | --- | --- |
| Small mobile | 320 × 800 | DPR 1, 100% text | `false` (`320 / 320`) | `44 × 44` | [calendar-320.png](screenshots/calendar-320.png) |
| Standard mobile | 390 × 844 | DPR 1, 100% text | `false` (`390 / 390`) | `44 × 44` | [calendar-390.png](screenshots/calendar-390.png) |
| Tablet (non-compact) | 768 × 1024 | DPR 1, 100% text | `false` (`768 / 768`) | `44 × 44` | [calendar-768.png](screenshots/calendar-768.png) |
| Desktop | 1440 × 900 | DPR 1, 100% text | `false` (`1440 / 1440`) | `44 × 44` (`Yeni plan` `128 × 44`) | [calendar-1440.png](screenshots/calendar-1440.png) |
| 200% text enlargement | 390 × 844 | `html { font-size: 200% }` (32px root) | `false` (`390 / 390`) | `44 × 44` | [calendar-200pct-390.png](screenshots/calendar-200pct-390.png) |
| 400% reflow equivalent | 320 × 225 | DPR 4 | `false` (`320 / 320`) | `44 × 44` | [calendar-400pct-reflow-320.png](screenshots/calendar-400pct-reflow-320.png) |
| Reduced motion | 390 × 844 | `prefers-reduced-motion: reduce` | `false` (`390 / 390`) | `44 × 44` | [calendar-reduced-motion-390.png](screenshots/calendar-reduced-motion-390.png) |

### 200% text scaling measurements (`390` baseline -> `200pct`)

- Root (`html`): `16px -> 32px`
- Page create button (`.page-create-action`): `16px -> 32px`
- Agenda action button (`.calendar-event-actions button`, e.g. `Düzenle`): `16px -> 32px`
- Agenda action link (`.calendar-event-actions a`, e.g. `İşi aç`): `16px -> 32px`
- Agenda heading (`.calendar-agenda-heading`): `16px -> 32px`

### Agenda job link (`İşi aç`) computed contrast, geometry, and keyboard focus

- Computed foreground/background contrast (`390` and `1440`, initial render and settled `calendar-form-success`): `10.89:1` (`--accent-hover` `rgb(0, 59, 116)` on `--paper` `rgb(251, 252, 253)`), outranking Ant Card's injected `.servora-ant-card .servora-ant-card-actions > li > span a:not(.servora-ant-card-btn)` selector (`0-3-3`) via owned classes only (`0-4-1`, no `!important`).
- Responsive width & target height: `67.83 × 47.75 CSS px` (`width: auto` inside `326px` action bar) at `1440`, `332 × 44 CSS px` (`width: 100%` stacked) at `390`, `display: flex` (flex-blockified from `inline-flex`).
- Keyboard focus & activation (`Shift+Tab` + `Enter` on settled `İşi aç` at `390` and `1440`): `:focus-visible` matches with `3px solid` outline and navigates cleanly to `/jobs/:id`.

### Touched controls vs untouched C1 day-grid constraints

- **Touched controls (`>= 44 CSS px` exact):** Every measured control across all 7
  modes, drawer overlays, and wheel picker passed `width >= 44 && height >= 44`
  with zero exclusions of rendered event chips (`768` manual chip `93.95 × 44`,
  `768` non-released JOB chips `93.95 × 46.36`, `768` released JOB chip `93.95 × 60.75`,
  `1440` chips `91.66 × 46.36` / `91.66 × 60.75`, `1440` topbar `Yeni plan` button `128 × 44`).
- **Untouched C1 day-number buttons (`.servora-calendar-date`):** Deliberately kept
  at `min-height: 0` (`22.78 × 16.56 CSS px` at `768` and `1440`) to preserve the
  monthly grid density contract.
- **Untouched compact mobile native date cells (`.servora-calendar--compact [class*="picker-calendar-date"]`):**
  Ant Design native compact cells measure `33 × 33 CSS px` in `320` / `390` / `200pct` / `400pct-reflow` / `reduced-motion`.
- **Scoped legacy C1 guard adjustment:** `web/scripts/calendar-responsive-smoke.mjs`
  and `web/tests/calendar-cell-density.test.ts` had a narrow assertion banning any
  `min-height` floor on `.servora-calendar-event-summary`; that assertion was updated
  to require the owner-approved `44px` (`var(--control-height)`) floor while
  preserving `chipHeight <= 50px` on normal chips, `min-height: 0` / `<= 24px` on
  `.servora-calendar-date`, `clippedEventCells: []`, and all other C1 checks.

## Interactive states, wheel, and window-on vs window-off behavior

- Desktop chip selection (`?event=`): [calendar-selected-1440.png](screenshots/calendar-selected-1440.png)
- Released intervention edit drawer: [calendar-detail-drawer-390.png](screenshots/calendar-detail-drawer-390.png), [calendar-detail-drawer-1440.png](screenshots/calendar-detail-drawer-1440.png)
- Shared WheelDateTimeField open (`Escape` + `ArrowUp` + `Tamam` focus restoration): [calendar-wheel-open-390.png](screenshots/calendar-wheel-open-390.png)
- API `409 CALENDAR_CONFLICT` preserving draft: [calendar-form-error-390.png](screenshots/calendar-form-error-390.png), [calendar-form-error-1440.png](screenshots/calendar-form-error-1440.png)
- Controlled held `PATCH` pending disabled/loading state: [calendar-form-pending-390.png](screenshots/calendar-form-pending-390.png), [calendar-form-pending-1440.png](screenshots/calendar-form-pending-1440.png)
- Window-on same-assignee schedule save (`17:00–18:00`): fresh `OPEN` offer opens at the new time, `staffReservationReleased` flips `false`, and Calendar warning badge/note clear: [calendar-form-success-390.png](screenshots/calendar-form-success-390.png), [calendar-form-success-1440.png](screenshots/calendar-form-success-1440.png)
- Reopened edit drawer (saved time `17:00`, released notice cleared): [calendar-form-reopened-390.png](screenshots/calendar-form-reopened-390.png), [calendar-form-reopened-1440.png](screenshots/calendar-form-reopened-1440.png)
- Module-off (`capabilities.calendar = false`, redirects to `/jobs`, no `/api/calendar` request): [calendar-module-off-1440.png](screenshots/calendar-module-off-1440.png)
- Separately named window-off scenario (`assignmentWindowEnabled: false` in `measurements.json` `windowOffScenario`): reschedule without a fresh offer preserves `staffReservationReleased: true` per `DECISIONS.md` RESCUE-004/A §7.
- Legacy omitted-field check: `legacyJobId` (without `staffReservationReleased`) renders as non-released (`false`) in all 7 modes and in `web/tests/calendar-api.test.ts` / `web/tests/calendar-page.test.tsx`.

## Web/API fixture vs PostgreSQL separation

- All checks in this package (`rescue-004a-calendar-acceptance.mjs`,
  `connected-workflows-recovery-acceptance.mjs`, `calendar-responsive-smoke.mjs`,
  and Vitest) run against deterministic synthetic fixtures (`page.route('**/api/**')`
  in Playwright, `vi.mock` / `vi.stubGlobal` in jsdom), with `EventSource` disabled
  and service workers blocked.
- They verify React rendering, CSS layout, accessibility scaling/targets, and client
  DTO/state handling under Chromium emulation; they do **not** exercise live Fastify
  routes or PostgreSQL 17 occupancy queries (`server/tests/*` on `c710306` owns backend
  and PG verification).
- Chromium `320px` and `html { font-size: 200% }` simulate reflow and text scaling,
  and do not replace Safari/WebKit or physical device verification.

## Verification commands run on `d4c1f2bd6eca94651a1cb5c39de6e5aa99def2ec`

- `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run build` (in `web/`): **passed** (`tsc -b && vite build`, 1752 modules)
- `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx vitest run tests/calendar-*.test.ts tests/calendar-*.test.tsx tests/assignment-*.test.ts tests/assignment-*.test.tsx tests/ui-button-contract.test.ts tests/type-floor-contract.test.ts tests/accessibility-contract.test.ts tests/visual-token-contract.test.ts` (in `web/`): **passed** (16 files, 294 tests)
- `FLEET_EVIDENCE_DIR=.../rescue-004a-calendar RESCUE_004A_SOURCE=d4c1f2bd6eca94651a1cb5c39de6e5aa99def2ec node scripts/rescue-004a-calendar-acceptance.mjs`: **passed** (`issues: []`, see [measurements.json](measurements.json))
- `node scripts/calendar-responsive-smoke.mjs`: **passed** (`390x844`, `390x844-200pct`, `320-wcag-400pct-reflow`, `420x844`, `768x1024`, `1024x768`, `1440x900`)
