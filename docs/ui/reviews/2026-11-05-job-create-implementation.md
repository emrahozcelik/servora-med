# Job creation visual improvements

Date: 2026-11-05. Status: implemented in the working tree; automated verification
passed as recorded below. Manual accessibility acceptance remains open.
Scope authorized by the user's approval of the [creation-form review](2026-11-05-job-create.md).
This is a presentation slice for `/jobs/new-meeting`, `/jobs/new-task` and
`/jobs/new-delivery` and their new-job menu entry.

## Changes

- Shared form rhythm, section headings, responsive pairs and action placement.
  Page openings have one short description; the redundant “Yeni kayıt” eyebrow
  and separate introductory paragraph are removed.
- The existing route registry supplies distinct titles to the page header,
  mobile top bar, breadcrumb and browser document title.
- Meeting fields follow customer/purpose/title, planning, then extra information.
  All existing engagement choices remain available.
- General-task planning is visible outside the optional disclosure, including
  its existing default time. The disclosure names its contents and indicates
  when a customer has been selected. Description guidance uses a dental-business
  example and a smaller initial textarea that remains editable/resizable.
- Delivery's semantic fieldset is normalized. Product identity and fractional
  quantities remain in their existing shared selector. Very narrow product
  rows stack quantity, identity and remove in the existing DOM order; this also
  prevents unreadable columns with enlarged text. Staff see their fixed
  responsibility without an assignment selector.
- Customer selectors have a bounded width. In these forms the selected name
  and city/phone wrap onto readable lines. Search choices retain their metadata.
- Delivery copy describes creating a planned delivery job and the later approval.

No request builder, mutation/retry logic, scheduling default, permission rule,
JobCard lifecycle, product quantity policy or backend file was changed.

## Acceptance evidence

The [retained evidence](../../evidence/job-create-implementation-20261105/README.md)
uses real App/AppShell/router, Ant provider, components and CSS with synthetic
API responses. The reproducible runner is
[`web/scripts/job-create-ui-smoke.mjs`](../../../web/scripts/job-create-ui-smoke.mjs).

| Criterion | Result |
| --- | --- |
| CREATE-VIS-01 | No page overflow, clipped selected customer name or unreadably narrow product identity column in the captured 320/390/768/1024/1440 px cases and 200% root-text simulation. Actual browser zoom/physical-device acceptance remains open. |
| CREATE-VIS-02 | Type-specific titles use the existing registry; route tests and rendered document/H1 records verify the result. |
| CREATE-VIS-03 | Shared sections/actions and fieldset semantics implemented. Control-height checks and the affected keyboard interactions passed. Full screen-reader traversal remains open. |
| CREATE-VIS-04 | Task planning stays outside the disclosure. Existing default-time submission tests pass; a closed disclosure indicates customer selection. |
| CREATE-VIS-05 | Existing form tests cover ownership, validation, pending and original-request retries. Browser checks cover customer side-flow dismissal/focus return and draft preservation. Synthetic roles do not verify backend authorization. |
| CREATE-VIS-06 | Product identity/quantity/remove remain together. Delivery decimal input rules and request tests are preserved. Narrow layout keeps the same reading/DOM order. |

## Verification

- **passed:** web build (`tsc -b && vite build`), Node 22.23.3.
- **passed:** full web suite, 214 files / 2731 tests, Node 22.23.3.
- **passed:** `npm run bundle:check`.
- **passed:** final creation-form Chromium runner: 42 captured states plus
  menu Escape/focus, error-summary focus, customer drawer dismissal/focus/draft
  and keyboard customer selection checks.
- **passed:** `git diff --check`; Impeccable layout detector reported no findings.
- **not run:** server build/tests (no server changes), hosted CI, real database
  writes, calendar-enabled browser states, Safari/physical devices, actual 400%
  browser zoom and manual screen-reader acceptance.

The first broad suite run used the shell's Node 26. Four old route-copy
expectations were updated for the approved titles. An unrelated duplicate-review
storage test failed under Node 26 and passed under the project's CI runtime,
Node 22, without modifying duplicate-review code/tests. The final full suite
passed under Node 22. Existing jsdom CSS/pseudo-element warnings remain visible
in the retained test log.

Visual inspection also caught a narrow product column under enlarged text after
page overflow had already been fixed. The final scoped container layout and
browser regression assertion address that distinct readability problem.
