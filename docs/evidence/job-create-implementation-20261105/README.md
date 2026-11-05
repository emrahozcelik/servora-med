# Job creation implementation evidence

Date: 2026-11-05. Base source: `197586fd6254a73ed362fa125f489da3ecb9be47`
**plus working-tree changes** in [source.patch](source.patch) and the newly
added [creation styles](job-create.css.txt). [Source hashes](source-hashes.json)
identify the actual application sources. The base SHA alone does not identify
the verified UI. Unrelated pre-existing documentation/operational edits are not
part of this implementation.

Assessment and remaining acceptance:
[implementation record](../../ui/reviews/2026-11-05-job-create-implementation.md).

## Reproduce

Run from the repository root with installed web dependencies and Chromium:

```bash
JOB_CREATE_CAPTURE_DIR=/tmp/servora-job-create-capture node web/scripts/job-create-ui-smoke.mjs
```

The [runner snapshot](capture.mjs.txt), [fixture data](fixture-data.json),
[measurements](results.json) and [final browser log](browser-final.log) are
retained. Restore the recorded source revision, apply its source patch and
creation stylesheet, then use the runner snapshot to reproduce historical
output. The live runner is a reusable check for later changes.

Real App, AppShell, BrowserRouter, ServoraAntProvider, React forms and production
CSS run against mocked local API reads and advisory scheduling evaluation.
Unexpected API calls fail the run; no customer/job creation mutation is sent.
Auth is synthetic, EventSource disabled, calendar/messaging/overview capabilities
off. STAFF and MANAGER get initial/populated 390/1440 views; ADMIN gets populated
390 views. Manager populated probes also cover 320/768/1024 and 200% root-text
simulation at 390. Menu and required-field error cases complete **42 states**.

Environment: Chromium 140.0.7339.186, Playwright 1.55.1, Node 26.11.0 for the
browser collector; `tr-TR`, `Europe/Istanbul`, fixed time
`2026-11-05T06:00:00.000Z`, reduced motion. Viewport height 844 below 768 px,
otherwise 960 px. Touch emulation below 768 px.

## Result and retained images

**Passed:** no document overflow, clipped selected customer names, product
identity columns below the runner's 100 px readability floor, unexpected alerts,
page errors or unexpected requests. Visible form control heights passed the
runner's geometry check (43 px tolerance against the 44 px target).

Keyboard checks passed: menu Escape restores trigger focus; invalid meeting
submission focuses the error summary; customer side-flow opens with Enter,
dismisses with Escape and restores focus while preserving a typed task/meeting
draft; all three customer selectors accept ArrowDown/Enter selection.

The runner generates 84 PNGs. This bundle retains **23 representative PNGs**;
`results.json` also lists generated files that were intentionally not retained.
Those omitted images can be regenerated with the runner.

| State | Mobile | Desktop / reflow |
| --- | --- | --- |
| Meeting, populated | [390](meeting-filled-manager-390-full.png) | [1440](meeting-filled-manager-1440-full.png) |
| Task, populated | [390](task-filled-manager-390-full.png) | [1440](task-filled-manager-1440-full.png) |
| Task, closed optional section | [390](task-initial-manager-390-full.png) | — |
| Delivery, populated | [390](delivery-filled-manager-390-full.png) | [1440](delivery-filled-manager-1440-full.png) |
| Delivery, Staff | [390](delivery-filled-staff-390-full.png) | — |
| Delivery, enlarged text | [200% root font](delivery-text-200-manager-390-full.png) | [320 px](delivery-reflow-manager-320-full.png) |
| Required errors | [390](meeting-required-errors-manager-390-viewport.png) | — |
| New job menu | [390](new-job-menu-staff-390-viewport.png) | [1440](new-job-menu-staff-1440-viewport.png) |

Full-page PNGs place fixed bottom navigation at the capture scroll position;
this is not evidence that the bar permanently covers those fields. Viewport PNGs
are retained for first-screen comparison. Representative images were opened and
visually inspected, including the final narrow/enlarged product layout.

## Other checks and limitations

- [Web build](web-build-node22.log): passed, Node 22.23.3.
- [Full web suite](web-tests-node22.log): passed, 214 files / 2731 tests,
  Node 22.23.3. The final CSS-only narrow-product adjustment was subsequently
  checked with a fresh build and the final browser run.
- `npm run bundle:check`: passed; 79 JS chunks within the 500000-byte budget.
- `git diff --check` and Impeccable's scoped layout scan: passed.
- Initial broad suite under Node 26 failed four obsolete copy expectations and
  an unrelated duplicate-review storage test. The expectations were updated;
  the unchanged storage test and full suite passed with Node 22.
- The first geometry collector also measured a Jobs-list checkbox's input
  rather than its label target; that out-of-form input was excluded. Enlarged
  text then exposed a real product readability defect, fixed with the scoped
  container layout and a new geometry assertion.
- **Not run:** actual 400% browser zoom, complete manual screen-reader/contrast
  acceptance, Safari, physical devices, calendar-enabled states, backend/database
  mutations, server build/tests and hosted CI. Root-text simulation and a 320 px
  viewport do not establish actual browser zoom acceptance. No claim of complete
  WCAG conformance or production deployment is made.

The runner closes its browser and local servers in `finally`. The final run
exited successfully. [Artifact hashes](artifact-hashes.json) bind retained files.
