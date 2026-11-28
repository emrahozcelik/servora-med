# RESCUE-003/B — Manager recovery form rendered acceptance

Captured on November 28, 2026, at application commit `bca74bfb1bb2542111d4636f0e4938d07246bbea` on `feat/rescue-003b-manager-recovery-form` (including `ManagerRecoverySection`, `ManagerRecoveryDrawer`, `manager-recovery-policy`, `JobDetail`, and `styles.css`).

## Environment and mocked boundary

- **Runner:** [web/scripts/connected-workflows-recovery-acceptance.mjs](../../../web/scripts/connected-workflows-recovery-acceptance.mjs) against the real React entry, `ServoraAntProvider`, `AppShell`, `/jobs/:id` route, and production CSS via local Vite dev server.
- **Browser:** Headless Chromium `140.0.7339.186` (Playwright emulation).
- **Locale / Timezone / Clock:** `tr-TR`, `Europe/Istanbul`, fixed clock `2026-11-26T11:00:00.000Z`.
- **Role and feature flags:** Synthetic `MANAGER` (`Murat Yönetici`) with optional modules disabled (`overviewDashboard: false`, `calendar: false`, `messaging: false`).
- **Mocked services:** All `/api/**` HTTP endpoints (auth, job card, staff, customers, linked jobs, available slots, customer schedule evaluation, and mutation endpoints for accept-proposal, patch, reoffer, change-request resolve, and cancel); `EventSource` (realtime SSE) disabled; `serviceWorkers: 'block'`.

> [!NOTE]
> **Known limitations:** Chromium emulation (`320×225` at DPR 4 for 400% reflow equivalent, and `html { font-size: 200%; }` for 200% text enlargement) is not physical iOS/Android hardware or Safari/WebKit verification. Synthetic `MANAGER` fixtures verify UI presentation and client state transitions, not backend authorization enforcement (covered separately by server PostgreSQL tests).

## Matrix coverage (MF-11)

| Setting | Viewport / Mode | Job detail summary | Open decision drawer | Footer / scroll reach |
| --- | --- | --- | --- | --- |
| Small mobile | `320 × 800` | [Capture](screenshots/small-mobile.png) | [Capture](screenshots/small-mobile-drawer.png) | `hitTargetOk: true` |
| Standard phone | `390 × 844` | [Capture](screenshots/phone.png) | [Capture](screenshots/phone-drawer.png) | `hitTargetOk: true` |
| Tablet | `768 × 1024` | [Capture](screenshots/tablet.png) | [Capture](screenshots/tablet-drawer.png) | `hitTargetOk: true` |
| Desktop | `1440 × 900` | [Capture](screenshots/desktop.png) | [Capture](screenshots/desktop-drawer.png) | 2-column grid (`896px` drawer) |
| 200% text | `390 × 844`, `html { font-size: 200% }` | [Capture](screenshots/text-200.png) | [Capture](screenshots/text-200-drawer.png) | [Footer](screenshots/text-200-drawer-footer.png) (`16px → 32px`) |
| 400% reflow equivalent | `320 × 225`, DPR 4 | [Capture](screenshots/reflow-400-equivalent.png) | [Capture](screenshots/reflow-400-equivalent-drawer.png) | [Footer](screenshots/reflow-400-equivalent-drawer-footer.png) |
| Reduced motion | `390 × 844`, `prefers-reduced-motion: reduce` | [Capture](screenshots/reduced-motion.png) | [Capture](screenshots/reduced-motion-drawer.png) | `hitTargetOk: true` |

## Entry cases and interactive flows

- **Declined assignment (`REASSIGN`):** [Phone](screenshots/declined-assignment-phone.png) / [Phone drawer](screenshots/declined-assignment-phone-drawer.png), [Desktop](screenshots/declined-assignment-desktop.png) / [Desktop drawer](screenshots/declined-assignment-desktop-drawer.png).
- **Declined assignment (`RESCHEDULE_SELF` valid proposal):** [Accept proposed time drawer](screenshots/decision-accept-proposed-time-drawer.png) → [Confirmed receipt](screenshots/decision-accept-proposed-time-success.png).
- **Expired proposal & `CANCEL_REQUEST`:** [Expired proposal notice](screenshots/entry-expired-proposal-drawer.png) (`ACCEPT_PROPOSED_TIME` hidden); [`CANCEL_REQUEST` non-preselection](screenshots/entry-cancel-request-no-preselect.png) (`checkedCount: 0`, submit blocked with validation).
- **Coexisting offer + change request:** [Phone](screenshots/coexisting-sources-phone.png) / [Phone drawer](screenshots/coexisting-sources-phone-drawer.png), [Desktop](screenshots/coexisting-sources-desktop.png) / [Desktop drawer](screenshots/coexisting-sources-desktop-drawer.png) (single `Görevi çözüme ulaştır` entry, both source blocks visible).
- **Started job (`IN_PROGRESS` + change request):** [Phone](screenshots/started-job-phone.png) / [Phone drawer](screenshots/started-job-phone-drawer.png), [Desktop](screenshots/started-job-desktop.png) / [Desktop drawer](screenshots/started-job-desktop-drawer.png) (pre-start decisions hidden with explanation).
- **Conditional fields & mutation states:**
  - Keyboard radio `ArrowDown`/`ArrowUp` switching with single active `[data-recovery-fields]` block.
  - `RESCHEDULE`: [Wheel open](screenshots/decision-reschedule-wheel-open.png) (`Escape` & `Tamam` restore focus to trigger), [Quick chips + slots](screenshots/decision-reschedule-slots.png), [Desktop native input](screenshots/decision-reschedule-desktop-drawer.png).
  - `REASSIGN_KEEP_TIME`: [Drawer](screenshots/decision-reassign-keep-time-drawer.png) + committed `PATCH` without `scheduledAt`.
  - `REASSIGN_AND_RESCHEDULE`: [Validation](screenshots/decision-transfer-validation.png) → [409 calendar conflict (draft preserved)](screenshots/decision-transfer-calendar-conflict.png) → [Pending `Kaydediliyor…`](screenshots/decision-transfer-pending.png) → [Confirmed receipt](screenshots/decision-transfer-success.png) → [Lost response lock + refresh](screenshots/decision-transfer-outcome-unknown.png).
  - `REOFFER`: [Drawer](screenshots/decision-reoffer-drawer.png).
  - `CORRECT` (`SALES_MEETING`): [Drawer with CustomerSearchSelect & gated closure](screenshots/decision-correct-drawer.png).
  - `LINKED_JOB_CREATED`: [Same-customer job selector](screenshots/decision-linked-job-drawer.png).
  - `ACKNOWLEDGED_ONLY`: [Validation on empty note](screenshots/decision-acknowledged-validation.png) → [Neutral non-green preview](screenshots/decision-acknowledged-filled-drawer.png) → [Neutral `detail-feedback-info` receipt](screenshots/decision-acknowledged-receipt.png).
  - `REJECT_CHANGE_REQUEST`: [Drawer](screenshots/decision-reject-drawer.png) → [Receipt](screenshots/decision-reject-success.png).
  - `CANCEL`: [Destructive preview](screenshots/decision-cancel-selected-drawer.png) → [Non-stacked `ReasonDialog`](screenshots/decision-cancel-confirm-dialog.png) (`Vazgeç` restores draft; confirm commits cancel).

## Geometry and baseline comparison vs RESCUE-003/A (MF-12)

- **Targets:** Every measured interactive target (trigger button, drawer close `DrawerCloseButton`, radio row labels, slots, wheel controls, checkbox labels, footer `Vazgeç` & submit buttons) is `>= 44 × 44` CSS px (`>= 88 × 88` CSS px at `text-200`).
- **Overflow & nesting:** Zero horizontal overflow on document, drawer scroller, and form (`scrollWidth <= clientWidth + 1`) across all 7 matrix settings and 6 entry cases. Zero repeated permanent cards inside the drawer (`nestedPermanentCards: 0`).
- **Section gaps:** Recovery summary gaps `20px` (`40px` at `text-200`); drawer vertical gaps `20px` (`40px` at `text-200`), desktop horizontal column gap `24px`.
- **Lifecycle order & nav:** `[data-job-detail-section]` preserves `heading < lifecycle < facts`, `responsibility` is not nested inside recovery, and mobile bottom nav `/jobs` remains reachable with `aria-current="page"`.
- **Baseline comparison ([comparison-vs-a.json](comparison-vs-a.json)):** Compared against RESCUE-003/A (`d2bc099d4bd3131228f951d54e425ac24e75d9be`) at all 7 shared matrix viewports; on-page recovery action buttons reduced from `9` scattered actions to `1` unified `Görevi çözüme ulaştır` entry while keeping `0` horizontal overflow, `>= 44px` minimum targets, and preserved lifecycle order.

## Evidence files

- [Measurements](measurements.json)
- [Comparison vs RESCUE-003/A](comparison-vs-a.json)
- [Artifact SHA-256 hashes](artifact-hashes.json)

Re-run from `web/`:

```sh
FLEET_EVIDENCE_DIR=/absolute/path/to/evidence \
CONNECTED_VISUAL_SOURCE=bca74bfb1bb2542111d4636f0e4938d07246bbea \
node scripts/connected-workflows-recovery-acceptance.mjs
```
