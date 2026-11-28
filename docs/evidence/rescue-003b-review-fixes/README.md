# RESCUE-003/B review fixes — integrated rendered acceptance

Captured on November 28, 2026, from the exact integration tree:

- Backend base: `df42b4d523d24e8b18cf2a563099515735a7a3ad` (audited PR #543 backend). A focused PG17 file for neutral acknowledgement and `CORRECTED` closure was verified on that tree; that file is not the full backend suite. A controller follow-up over the three focused files listed below reported `3` files and `41` tests passed.
- Application commit: `7bb6f5eac7443c95d4a851168cce8e8ef3320c7a` — one clean cherry-pick of audited UI change `4e3228ec48c5fb550e9ab0fc93964dbebe58ab63` (`fix(web): align manager recovery form with server CORRECTED/closure contract and audit guards`), no remote operations.

The runner drove the real React entry, `ServoraAntProvider`, `AppShell`, the `/jobs/:id` route and production CSS through a local Vite server against a deterministic synthetic `/api/**` boundary. No production or live data was used.

## Environment and results

| Item | Value |
| --- | --- |
| Node.js | `v22.23.3` |
| Web build | `npm run build` (`tsc -b && vite build`) — exit `0` |
| Focused tests | `vitest run` on `tests/rescue-003b-manager-recovery-form.test.tsx`, `tests/reason-dialog.test.tsx`, `tests/job-detail-child-receipts.test.tsx` — `3` files, `85` tests passed, exit `0` |
| Focused backend (PG17) | `tests/rescue-003b-neutral-acknowledgement-postgres.test.ts`, `tests/job-card-assignment-time-proposal-postgres.test.ts`, `tests/job-card-assignment-offer-postgres.test.ts` — `3` files, `41` tests passed (controller follow-up; not the full backend suite) |
| Acceptance | `node scripts/connected-workflows-recovery-acceptance.mjs` — exit `0`, `completed: true`, `issues: []` |
| Browser | Headless Chromium `140.0.7339.186` (Playwright emulation) |
| Locale / timezone / clock | `tr-TR` / `Europe/Istanbul` / fixed `2026-11-26T11:00:00.000Z`; the Node process ran with `TZ=UTC` |
| Role and flags | Synthetic `MANAGER`; `overviewDashboard`, `calendar`, `messaging` disabled |
| Mocked services | HTTP `/api/**`, `EventSource` disabled, `serviceWorkers: 'block'` |

Re-run from `web/`:

```sh
FLEET_EVIDENCE_DIR=/absolute/output \
CONNECTED_VISUAL_SOURCE=7bb6f5eac7443c95d4a851168cce8e8ef3320c7a \
node scripts/connected-workflows-recovery-acceptance.mjs
```

## Seven matrix settings (MF-11, MF-12)

| Setting | CSS viewport | Drawer | Measured result |
| --- | --- | --- | --- |
| Small mobile | `320 × 800` | [320](screenshots/recovery-drawer-small-mobile-320.png) | 1 column, `320` drawer, 20 px gaps, min target `44` |
| Standard phone | `390 × 844` | [390](screenshots/recovery-drawer-phone-390.png) | 1 column, `390` drawer, 20 px gaps, min target `44` |
| Tablet | `768 × 1024` | [768](screenshots/recovery-drawer-tablet-768.png) | 1 column, `480` drawer, 20 px gaps, min target `47.75` |
| Desktop | `1440 × 900` | [1440](screenshots/recovery-drawer-desktop-1440.png) | 2 columns, `896` drawer, 24 px column gap, min target `47.75` |
| 200% text | `390 × 844`, root `32px` | [390](screenshots/recovery-drawer-text-200-390.png) | 1 column, 40 px gaps, min target `93.5` |
| 400% reflow equivalent | `320 × 225`, DPR 4 | [320](screenshots/recovery-drawer-reflow-400-320.png) | 1 column, `320` drawer, 20 px gaps, min target `44` |
| Reduced motion | `390 × 844` | [390](screenshots/recovery-drawer-reduced-motion-390.png) | 1 column, 20 px gaps, min target `44` |

[Job detail on phone](screenshots/job-detail-phone-390.png) and [desktop](screenshots/job-detail-desktop-1440.png) show the single recovery entry; every sample had `triggerCount = 1` and `duplicateTriggerCount = 1`. No sample had horizontal document, drawer-scroller or form overflow, a repeated permanent card (`nestedPermanentCards = 0`), or a non-reachable footer. Lifecycle order (`heading < lifecycle < responsibility/actions < facts`) and Jobs navigation were preserved.

## Entry cases and affected review flows

Both source cases and the coexisting case were replayed on phone and desktop (`declined-assignment`, `started-job`, `coexisting-sources`) with one recovery entry and the correct source context. Six entry cases, all passing:

| Case | Phone | Desktop |
| --- | --- | --- |
| Declined assignment (`REASSIGN`) | `declined-assignment-phone` | `declined-assignment-desktop` |
| Started job (`IN_PROGRESS` + change request) | `started-job-phone` | `started-job-desktop` |
| Coexisting offer + change request | `coexisting-sources-phone` | `coexisting-sources-desktop` |

- **Valid correction:** [gated CORRECT drawer](screenshots/correction-drawer-390.png) → [ReasonDialog with attested note](screenshots/correction-reason-dialog-390.png); the dialog validates an empty note, focuses the textarea, and does not stack two drawers. Commit sends `CORRECTED` with the request id and note.
- **Wrong product:** [wrong-product drawer](screenshots/correction-wrong-product-390.png) — record edit saves independently, no closure opt-in and no linked/replacement option (`closureHidden = true`, `linkedOptionAbsent = true`).
- **Neutral acknowledgement:** [empty-note validation](screenshots/neutral-validation-390.png) → [filled neutral preview](screenshots/neutral-filled-drawer-390.png) → [non-green info receipt](screenshots/neutral-receipt-390.png) (`detail-feedback-info`, not `detail-feedback-confirmed`; zero JobCard mutation).
- **Wheel picker:** [open wheel](screenshots/reschedule-wheel-390.png); `Escape` and `Tamam` return focus to the trigger, quick chips and available slots remain usable.
- **Feedback states:** [invalid transfer](screenshots/feedback-transfer-validation-390.png) → [409 calendar conflict with draft preserved and pending state](screenshots/feedback-transfer-pending-390.png) → [confirmed receipt](screenshots/feedback-transfer-success-390.png) → [lost response locked until fresh read](screenshots/feedback-transfer-outcome-unknown-390.png); [rejected-request receipt](screenshots/feedback-reject-receipt-390.png) remains distinct.

## Comparison vs RESCUE-003/A (MF-12)

[comparison-vs-a.json](comparison-vs-a.json) compares the same seven viewports against A (`d2bc099d4bd3131228f951d54e425ac24e75d9be`). The scattered on-page recovery actions dropped from `9` to `1` unified entry at every viewport, with `0` horizontal overflow, minimum targets of `44` CSS px (`88` at 200% text) and identical grid/overflow results.

## MF-01 … MF-14

| ID | Status | Rationale and source |
| --- | --- | --- |
| MF-01 | PASS | One recovery entry and one decision drawer for offer, change request and coexisting sources; no duplicate competing CTA (`triggerCount = 1`, `duplicateTriggerCount = 1` in all seven samples and six entry cases). Source: MF-01 test; [measurements.json](measurements.json). |
| MF-02 | DEFERRED | Deterministic ordering, expired-proposal hiding, destructive non-preselection and unknown-risk handling are covered. Richer eligibility/ranking, full candidate search and occupancy policy remain RESCUE-004/005 per spec §3–§4. Source: policy tests; `09-manager-recovery-form-ui-spec.md`. |
| MF-03 | PASS | Each eligible decision renders only its required fields and action-specific preview; keyboard radio switching and wheel `Escape`/`Tamam` focus return pass; no hidden payload. Source: focused tests; `interactions.keyboardAndRescheduleAndKeepTime`. |
| MF-04 | PASS | Exact proposal is default/accept-able, changed time and assignee are distinguished, one committed receipt is shown. Backend proposal behavior is covered by the focused `tests/job-card-assignment-time-proposal-postgres.test.ts` (proposal stored on a `SCHEDULE_CONFLICT` decline/release; a confirmation moves the interval and accepts for the proposer in one transaction; idempotent replay, supersession, stale start and calendar conflicts); offer/lifecycle enforcement by `tests/job-card-assignment-offer-postgres.test.ts`. Source: `interactions.acceptProposedTime`; those two focused files. |
| MF-05 | PASS | Atomic interval/transfer and the single offer/history record are backend-owned and covered by the focused proposal file (one confirmation transaction, idempotent replay, double-confirm rejection, supersession, calendar conflict) and offer file (`A5` pre-deadline reservation precedence, reassignment withdrawal, manager-cancel withdrawal); the rendered replay covers validation → 409 conflict → pending → success → lost response. Source: `interactions.transferFlow`, `uncertainTransfer`; `job-card-assignment-time-proposal-postgres.test.ts`, `job-card-assignment-offer-postgres.test.ts`. |
| MF-06 | PASS | The actual neutral-closure concurrency point is the `ACKNOWLEDGED_ONLY` replay/payload-conflict/single-winner case in `tests/rescue-003b-neutral-acknowledgement-postgres.test.ts`; the client stale replay is `interactions.uncertainTransfer` (draft preserved, authoritative reload). Wider offer/proposal races (`A5` reservation, proposal supersession) are covered by their own focused files and are not claimed as MF-06 evidence. Source: neutral/CORRECTED focused file; MF-09/MF-10 rendered test. |
| MF-07 | PASS | `CORRECTED` closure is gated to an `OPEN` `OTHER` request with a qualifying description or `SALES_MEETING` customer/engagement edit plus a trimmed attested note in `ReasonDialog`; `WRONG_PRODUCT` and other reasons keep the ordinary edit with no closure (`closureHidden`, `linkedOptionAbsent`), and `df42b4d` binds the PATCH closure to request evidence. The linked/replacement decision is explicitly deferred by spec §8; legacy linked follow-up paths remain outside this surface. Source: MF-07 policy/UI tests; `interactions.correct`, `correctWrongProduct`; §8 notes. |
| MF-08 | PASS | `ACKNOWLEDGED_ONLY` keeps the mandatory note, zero JobCard mutation and the non-green `detail-feedback-info` receipt. OVR-4/OVR-6 alert-resume, OVR-7 attribution/regrouping, DB `CHECK`, role/tenant/note and idempotency cases live in `tests/rescue-003b-neutral-acknowledgement-postgres.test.ts`. Source: MF-04/MF-08 test; `interactions.acknowledgedOnly`; that focused file. |
| MF-09 | DEFERRED | Started and staff behavior passed: started cases hide pre-start decisions with an explanation, staff never sees management recovery, and staff commands are refused (`A7`, `D1`, proposal cases `11`–`12`). Broader terminal/`JOB-009`/`SALE-002`/`SALE-003` branches were not specifically reverified, so this remains deferred and is not claimed from the focused `41`-test run. Source: MF-09/MF-10 test; focused offer/proposal files. |
| MF-10 | PASS | Validation, conflict with draft retention, pending, lost-response lock plus refresh, and terminal post-commit read `500`/`403` receipts are covered; no false receipt or duplicate write. Source: `interactions.transferFlow`, `uncertainTransfer`; `tests/job-detail-child-receipts.test.tsx`. |
| MF-11 | PASS | Exact integrated `AppShell` replay exited `0`: seven matrix settings, six entry cases, both source cases, wheel open, conditional fields, and error/pending/success/unknown states. Source: [measurements.json](measurements.json), screenshots above. |
| MF-12 | PASS | Targets `>= 44 × 44` (`>= 88` at 200% text), zero horizontal overflow, reachable footer, 20/24/40 px section gaps, no repeated wrappers, lifecycle order and navigation preserved; A/B comparison at the same seven viewports. Source: measurements and [comparison-vs-a.json](comparison-vs-a.json). |
| MF-13 | PASS | Observed module-off matrix: the rendered acceptance ran with `overviewDashboard`, `calendar` and `messaging` disabled, and no optional-module dependency was observed. Role/tenant enforcement is claimed only where directly proven: the `ACKNOWLEDGED_ONLY enforces role/tenant/note/linkedJobCardId` case in the neutral focused file plus the `STAFF` refusal cases in the offer/proposal files; no blanket tenant claim is made from that file. Source: MF-13/MF-09 tests; focused files. |
| MF-14 | DEFERRED | Exact application SHA (`7bb6f5e…`) and artifact hashes are evidenced here ([artifact-hashes.json](artifact-hashes.json)); hosted CI and local reviewer sign-off remain pending, so this stays deferred. Chromium emulation limitations are disclosed below. Source: this README. |

## Evidence files

- [Final measurements](measurements.json)
- [Comparison vs RESCUE-003/A](comparison-vs-a.json)
- [Artifact SHA-256 hashes](artifact-hashes.json)

## Known limitations

- Chromium emulation only; the `320 × 225` DPR 4 reflow equivalent is not a physical device, and 200% text is emulated with `html { font-size: 200% }`. No Safari/WebKit or physical iOS/Android verification.
- Synthetic fixtures verify UI presentation and client state transitions, not backend authorization enforcement. The three focused PG17 files cited above passed; the full backend suite was not run in this integration task.
- Hosted CI and reviewer sign-off for the integrated head are pending (MF-14); no push, merge, GitHub comment or deployment was performed.
