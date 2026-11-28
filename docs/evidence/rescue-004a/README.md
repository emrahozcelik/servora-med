# RESCUE-004/A Calendar rendered acceptance

Passed on November 28, 2026, at integrated application commit
`6a3a249d43e3c715d298cfbda16bd82f91e3de8b` (built on reviewed backend +
test-double parity `4e7c05b` / `1c4285caa8fad82355f94f9195617293a6c19e9a` and
docs delta `8fc2f04` matching `f2a034a3fbe205bf787019a53c5e0d364cf0c2fe`).
Captures ran with Node `v22.23.3`, headless Chromium `140.0.7339.186`, locale
`tr-TR`, timezone `Europe/Istanbul`, and fixed clock `2026-11-26T09:00:00.000Z`.
The real Vite entry, `ServoraAntProvider`, `AppShell`, `CalendarPage`,
`ServoraCalendar`, and production CSS rendered against deterministic synthetic
API responses.

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

### Compact count & warning indicator geometry (all 5 compact modes)

- **Root cause & scoped fix:** Under `200%` text scaling (`1rem = 32px`),
  `1.5rem` end-padding on `[class*="picker-calendar-date-value"]` and
  `1.3rem` (`41.6px`) absolute count badge dimensions previously exceeded the
  `46.56px`-wide compact cell and `33px`-tall AntD cell-inner, pushing the
  badge across the adjacent cell boundary (`27`) and row above (`19`).
  `.servora-calendar--compact` now establishes `container-type: inline-size`
  (`servora-compact-calendar`), caps `[class*="picker-cell-inner"][class*="picker-calendar-date"]`
  at `max-width: 100%`, and at `@container servora-compact-calendar (max-width: 16rem)`
  switches compact cells to a stacked vertical flex layout (`position: static`
  badge below the date number) while preserving the standard `390px` and
  `320px`/`400pct-reflow` (`>= 18rem`) side-by-side layout.
- **Measured `compactAttention` (`.servora-calendar-count--attention`, text `3`, `3 plan, 1 müdahale gerekiyor`):**
  - `320` & `400pct-reflow`: badge `156.36..177.16 × 595.7..616.5` (`20.8 × 20.8 CSS px`) inside `td` `139.42..180.56 × 580.19..626.19` (`41.14 × 46`), clear of own date text `142.81..156.34` and adjacent cells (`withinOwnCell: true`, `overlapWithDate: false`, `touchesAdjacentCell: false`, `touchesAdjacentDateText: false`).
  - `390` & `reduced-motion`: badge `191.36..212.16 × 595.7..616.5` (`20.8 × 20.8 CSS px`) inside `td` `169.42..220.56 × 580.19..626.19` (`51.14 × 46`), clear of own date text `177.81..191.34` and adjacent cells (`withinOwnCell: true`, `overlapWithDate: false`, `touchesAdjacentCell: false`, `touchesAdjacentDateText: false`).
  - `200pct` (`390 × 844`, `html { font-size: 200% }`): badge `177.38..212.56 × 1214.58..1248.17` (`35.19 × 33.59 CSS px`) stacked cleanly inside `td` `171.69..218.25 × 1162.73..1263.73` (`46.56 × 101`), `4.52px` below own date text `181.44..208.48 × 1171.06..1210.06` and `5.69px` clear of adjacent cells (`withinOwnCell: true`, `overlapWithDate: false`, `touchesAdjacentCell: false`, `touchesAdjacentDateText: false`).
  - All compact badges (`allWithinOwnCell`, `allClearOfOwnDate`, `allClearOfAdjacent`) passed `true` across all 5 compact modes in [measurements.json](measurements.json), and `calendar-responsive-smoke.mjs` verified two-digit count (`12`) cell containment in `390x844`, `390x844-200pct`, `320-wcag-400pct-reflow`, and `420x844`.

### Agenda job link (`İşi aç`) computed contrast, geometry, and keyboard focus

- Computed foreground/background contrast (`390` and `1440`, initial render and settled `calendar-form-success`): `10.89:1` (`--accent-hover` `rgb(0, 59, 116)` on `--paper` `rgb(251, 252, 253)`), outranking Ant Card's injected `.servora-ant-card .servora-ant-card-actions > li > span a:not(.servora-ant-card-btn)` selector (`0-3-3`) via owned classes only (`0-4-1`, no `!important`).
- Responsive width & target height: `67.83 × 47.75 CSS px` (`width: auto` inside `326px` action bar) at `1440`, `332 × 44 CSS px` (`width: 100%` stacked) at `390`, `display: flex` (flex-blockified from `inline-flex`).
- Keyboard focus & activation (`Shift+Tab` + `Enter` on settled `İşi aç` at `390` and `1440`): `:focus-visible` matches with `3px solid` outline and navigates cleanly to `/jobs/:id`.

### Touched controls vs untouched legacy constraints

- **Touched controls (`>= 44 CSS px` exact):** Every measured control across all 7
  modes, drawer overlays, and wheel picker passed `width >= 44 && height >= 44`
  with zero exclusions of rendered event chips (`768` manual chip `93.95 × 44`,
  `768` non-released JOB chips `93.95 × 46.36`, `768` released JOB chip `93.95 × 60.75`,
  `1440` chips `91.66 × 46.36` / `91.66 × 60.75`, `1440` topbar `Yeni plan` button `128 × 44`).
- **Untouched C1 day-number buttons (`.servora-calendar-date`):** Deliberately kept
  at `min-height: 0` (`22.78 × 16.56 CSS px` at `768` and `1440`) to preserve the
  monthly grid density contract.
- **Untouched compact mobile native cells & mobile shell/selector behavior:**
  Ant Design native compact cells remain `33 × 33 CSS px` (`40.72 × 33`) in
  `100%` text modes (`320`, `390`, `400pct-reflow`, `reduced-motion`), and mobile
  shell navigation / personnel selector behavior remain unchanged.
- **Scoped legacy C1 guard adjustment:** `web/scripts/calendar-responsive-smoke.mjs`
  and `web/tests/calendar-cell-density.test.ts` retain the `44px`
  (`var(--control-height)`) floor on `.servora-calendar-event-summary`,
  `chipHeight <= 50px` on normal chips, `min-height: 0` / `<= 24px` on
  `.servora-calendar-date`, `clippedEventCells: []`, and now additionally
  assert compact count badge containment inside its own cell (`countWithinOwnCell`,
  `!countTouchesAdjacentCell`, `!countDateOverlap`) and `@container servora-compact-calendar`.

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

## Web/API fixture vs PostgreSQL & prior regression proof

- All checks in this package (`rescue-004a-calendar-acceptance.mjs`,
  `calendar-responsive-smoke.mjs`, and Vitest) run against deterministic
  synthetic fixtures (`page.route('**/api/**')` in Playwright, `vi.mock` /
  `vi.stubGlobal` in jsdom), with `EventSource` disabled and service workers blocked.
- Prior manager `AppShell` regression proof (`connected-workflows-recovery-acceptance.mjs`)
  remains unaffected by this strictly `.servora-calendar--compact` CSS adjustment.
- `server/` runtime and tests match reviewed `1c4285c` (`git diff --exit-code 1c4285c HEAD -- server/` clean) and owning docs match `f2a034a` (`505/505` targeted and main baseline proof already present; the earlier 448-file full local run predated the `1c4285c` test-double fix, so the full local suite is not claimed green).
- Chromium `320px` and `html { font-size: 200% }` simulate reflow and text scaling,
  and do not replace Safari/WebKit or physical device verification.

## Verification commands run on `6a3a249d43e3c715d298cfbda16bd82f91e3de8b`

- `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run build` (in `web/`): **passed** (`tsc -b && vite build`, 1752 modules)
- `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx vitest run tests/calendar-*.test.ts tests/calendar-*.test.tsx tests/assignment-*.test.ts tests/assignment-*.test.tsx tests/ui-button-contract.test.ts tests/type-floor-contract.test.ts tests/accessibility-contract.test.ts tests/visual-token-contract.test.ts tests/mobile-spacing-styles.test.ts tests/responsive-layout-contract.test.ts` (in `web/`): **passed** (18 files, 318 tests)
- `PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/calendar-responsive-smoke.mjs` (in `web/`): **passed** (`390x844`, `390x844-200pct`, `320-wcag-400pct-reflow`, `420x844`, `768x1024`, `1024x768`, `1440x900`)
- `FLEET_EVIDENCE_DIR=.../evidence RESCUE_004A_SOURCE=6a3a249d43e3c715d298cfbda16bd82f91e3de8b PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/rescue-004a-calendar-acceptance.mjs` (in `web/`): **passed** (`issues: []`, see [measurements.json](measurements.json))
