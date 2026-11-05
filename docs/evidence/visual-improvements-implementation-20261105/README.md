# Application visual slices — implementation evidence

Date: 2026-11-05. Base: `197586fd6254a73ed362fa125f489da3ecb9be47` **plus
uncommitted source changes**. [Before patch](source-before.patch),
[after patch](source-after.patch) and [current source hashes](source-hashes.json)
identify the inspected application. The base SHA alone is insufficient.
Earlier new-job-form changes were already present and were preserved.

Scope and acceptance: [A–E implementation record](../../ui/reviews/2026-11-05-visual-improvements-implementation.md).
[Verification summary](verification.json) separates executed checks from pending acceptance.
The [original 14-image review](../visual-review-20261105/README.md) remains historical.

## Reproduction

Run from the repository root with installed web dependencies and Chromium:

```bash
VISUAL_CAPTURE_DIR=/tmp/servora-visual-before node web/scripts/visual-improvements-smoke.mjs
VISUAL_PHASE=after VISUAL_CAPTURE_DIR=/tmp/servora-visual-after node web/scripts/visual-improvements-smoke.mjs
VISUAL_PHASE=after VISUAL_ONLY=overdue VISUAL_CAPTURE_DIR=/tmp/servora-visual-overdue node web/scripts/visual-improvements-smoke.mjs
```

Use the corresponding recorded source tree for a historical before/after pair;
the phase variable selects checks rather than reverting the application.
The [runner](capture.mjs.txt), [typed fixture](fixture.ts.txt),
[serialized data](fixture-data.json), [before measurements](before-results.json),
[final measurements](after-results.json) and [overdue measurements](overdue-results.json)
are retained. Native TypeScript loading in the collector used Node 26.11.0;
the application build/tests used Node 22.23.3. The fixture also passed a separate
TypeScript check and the current report parser/count-reconciliation test.

Real App, AppShell, BrowserRouter, ServoraAntProvider, React components and CSS
run against local synthetic API responses. Counts reconcile across history,
customer, Staff profile, productive type buckets and completions. Weekly reports
retain their own period. Ordinary data and the separately named long-product
case are distinct. No production/customer data is used.

Auth/roles are injected; EventSource and overview/calendar/messaging capabilities
are disabled. Reads are mocked. A single explicitly mocked customer PATCH returns
409 without writing data. Product confirmation is cancelled. The PDF endpoint
returns a synthetic download probe, which verifies UI access and filename rather
than PDF contents or persisted submission integrity. Unexpected requests fail.
Vite's development WebSocket uses the fixture's own HTTP server; it is distinct
from application realtime.

Environment: Chromium 140.0.7339.186 / Playwright 1.55.1, `tr-TR`,
`Europe/Istanbul`, fixed time `2026-11-05T06:00:00.000Z`, reduced motion.
Viewport height 844 below 768 px, otherwise 960 px; touch emulation below 768 px.

## Captures and interactions

**Passed:** 22 before states, 63 final states, 2 final overdue states. Captured
baseline/reflow/text cases have no page errors, unexpected requests or document
overflow. Expected alerts belong to the named report-error and conflict cases.
Final row-action geometry checks retain at least the 44 px height target with
1 px rounding tolerance. Screenshots were opened and inspected.

The baseline covers Staff's profile, customer detail for Admin/Manager/Staff,
customer/product lists, customer/product create, managed Staff editing and
Staff/Manager job lists at 390/1440 px. Final probes add 320/768/1024 px, 200%
root-font simulation, Staff list variants, empty/loading/report retry, long
products, customer conflict and product confirmation states.

Keyboard/interaction checks passed: the edit link opens the existing form;
the disclosure opens with Enter; closing/reopening preserves a draft; mocked
version conflict preserves that draft and focuses the error; Staff enrichment
cancellation restores focus; deletion confirmation Escape restores focus;
weekly PDF download and completed-history filtering work; report retry recovers.

The collectors generated 174 PNGs. This bundle retains **42 representative PNGs**.
The results also name generated captures that are intentionally not retained;
they can be regenerated with the runner.

| Surface | Before | After |
| --- | --- | --- |
| Own profile, mobile | [390](before/staff-profile-staff-390-baseline-full.png) | [390](after/staff-profile-staff-390-baseline-full.png) |
| Own profile, desktop | [1440](before/staff-profile-staff-1440-baseline-full.png) | [1440](after/staff-profile-staff-1440-baseline-full.png) |
| Customer detail, mobile | [390](before/customer-detail-manager-390-baseline-full.png) | [390](after/customer-detail-manager-390-baseline-full.png) |
| Customer detail, desktop | [1440](before/customer-detail-manager-1440-baseline-full.png) | [1440](after/customer-detail-manager-1440-baseline-full.png) |
| Products, mobile | [390](before/products-admin-390-baseline-full.png) | [390](after/products-admin-390-baseline-full.png) |
| Customers, mobile | [390](before/customers-manager-390-baseline-full.png) | [390](after/customers-manager-390-baseline-full.png) |
| Customer labels, mobile | [390](before/customer-create-admin-390-baseline-viewport.png) | [390](after/customer-create-admin-390-baseline-viewport.png) |
| Jobs, mobile | [390](before/jobs-staff-390-baseline-full.png) | [390](after/jobs-staff-390-baseline-full.png) |
| Jobs, desktop | [1440](before/jobs-staff-1440-baseline-full.png) | [1440](after/jobs-staff-1440-baseline-full.png) |

Representative edge cases: [version conflict](after/customer-detail-manager-390-conflict-full.png),
[product confirmation](after/products-admin-390-baseline-confirmation-viewport.png),
[report loading](after/staff-profile-staff-390-loading-viewport.png),
[report error](after/staff-profile-staff-390-retry-viewport.png),
[long product identity](after/products-admin-390-long-full.png),
[overdue job](after/jobs-overdue-staff-390-full.png),
[200% form text](after/customer-create-admin-390-baseline-text-200-full.png).

In the matched 390 px fixture, work-history heading position changed from
4491 px to 676 px; customer operational summary from 1703 px to 244 px.
Product row actions changed from 350 px width to content width while keeping
their measured 47.75 px height. These describe task access and action geometry
in this fixture; they are not universal page-height goals.

Fixed bottom navigation in full-page screenshots is captured at its scroll
position. It does not establish permanent occlusion. Viewport images are retained
for the key first-screen comparisons. Enlarged text and 320 px probes are not
actual 400% browser zoom or physical-device evidence.

## Other verification and limits

- [Build](build.log): passed; `cd web && npm run build`.
- [Full web suite](tests-full.log): passed; 215 files / 2735 tests, Node 22.23.3.
- [Responsive regression suite](responsive.log): passed; `npm run smoke:responsive`.
- [Bundle budget](bundle.log): passed; 79 JS chunks within 500000 bytes each.
- TypeScript fixture check, `git diff --check` and scoped Impeccable scan: passed.
- **Not run:** server build/tests (no server edits), hosted CI, production writes,
  Safari/physical devices, actual 400% browser zoom, complete manual screen-reader
  and contrast acceptance. Full WCAG conformance and production deployment are not claimed.

Initial collector attempts exposed fixture setup defects: canonical report bucket
order, missing existing read endpoints, error-response shape, PDF path, a history
readiness race and Vite development WebSocket sharing. These were corrected in
the collector rather than reported as application defects. A shared-style test's
old selector expectation was updated. Final build, full tests, responsive suite
and capture/interaction runs passed. Task-owned browsers and servers were closed.

[Artifact hashes](artifact-hashes.json) bind the retained files, not production state.
