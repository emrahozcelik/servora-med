# Job creation visual review evidence

Date: 2026-11-05. Source: `197586fd6254a73ed362fa125f489da3ecb9be47`.
Application sources were unchanged; the checkout also contained documentation and
unrelated operational-document edits. This bundle is synthetic UI evidence, not
production or backend acceptance.

Assessment: [job creation visual review](../../ui/reviews/2026-11-05-job-create.md).

## Reproduction and scope

- Final command, from the repository root:
  `node /tmp/servora-job-create-review-20261105/capture.mjs`.
- [Runner source](capture.mjs.txt) and [sample data](fixture-data.json) are retained.
  To reproduce, copy the runner to a task-owned directory as `capture.mjs`, restore
  the named application revision/dependencies and run from its repository root.
  Output is written next to the runner. No backend/database is required.
- Real App, AppShell, BrowserRouter, ServoraAntProvider, pages and CSS; native
  request parsers consume local synthetic API responses. All unexpected requests
  fail the capture. No create/mutation call was made; only the advisory schedule
  evaluation POST was mocked. Auth is injected, EventSource disabled and calendar,
  messaging and overview capabilities off. Install prompting is outside scope.
- Chromium `140.0.7339.186`, Playwright `1.55.1`, locale `tr-TR`, timezone
  `Europe/Istanbul`, fixed clock `2026-11-05T06:00:00.000Z`, reduced motion.
- Mobile 390×844 with touch emulation; desktop 1440×960. This does not establish
  physical-device or OS-native date-picker behavior.
- 12 initial views (3 forms × 2 roles × 2 sizes), 6 filled Manager views, 2 Staff
  new-job menu views, 1 required-field-error view: **21 cases / 42 PNGs**.
- [Results](results.json) record every case, labels, submit positions and requests.
  [Hashes](artifact-hashes.json) bind the runner, data and results. The original
  manifest also lists the capture files below, which are retained locally only
  and are not tracked in Git. The manifest is preserved unchanged as historical
  provenance; it is not a live verifier of this directory.

## Results

The final collector completed with no page exceptions or unexpected API requests.
Three populated mobile forms overflow: meeting/task full-page PNGs are 466 px
wide and delivery is 496 px, for a 390 px viewport. Initial forms do not overflow.
Exit 0 means evidence collection completed; these findings are **not passed
responsive acceptance**. The meeting error case intentionally contains an alert.

| Representative state | Viewport | Full page |
| --- | --- | --- |
| Meeting, filled mobile | 390: `meeting-filled-manager-390-viewport.png` | Full: `meeting-filled-manager-390-full.png` |
| Task, initial mobile | 390: `task-initial-manager-390-viewport.png` | Full: `task-initial-manager-390-full.png` |
| Task, expanded mobile | 390: `task-filled-manager-390-viewport.png` | Full: `task-filled-manager-390-full.png` |
| Delivery, filled mobile | 390: `delivery-filled-manager-390-viewport.png` | Full: `delivery-filled-manager-390-full.png` |
| Delivery, initial desktop | 1440: `delivery-initial-manager-1440-viewport.png` | Full: `delivery-initial-manager-1440-full.png` |
| Meeting, required errors | 390: `meeting-required-errors-manager-390-viewport.png` | Full: `meeting-required-errors-manager-390-full.png` |
| New job menu | 390: `new-job-menu-staff-390-viewport.png` | 1440: `new-job-menu-staff-1440-viewport.png` |

The initial runner attempts failed on sandbox listening, Vite transport and fixture
provider/selector readiness. Those setup defects were corrected before the final
run, and are not product findings. Servers/browsers were closed after execution.
No application edit, full test suite, keyboard/zoom/accessibility acceptance or
real create request was performed. Calendar-enabled states and other widths remain
outside this review.
