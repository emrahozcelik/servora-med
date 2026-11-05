# Visual improvement slices A–E

Date: 2026-11-05. Status: implemented in the working tree following the user's
request to finish the [reviewed work](2026-11-05-visual-improvements.md).
Implementation and automated verification are recorded separately from manual
accessibility acceptance and deployment.

## Delivered scope

| Slice | Implemented result |
| --- | --- |
| Preparation | A dedicated typed fixture replaces the old stress fixture. Current workload, history, customer counts, completion totals, dates and type buckets reconcile. The actual Ant provider is mounted. |
| A — Forms | Nested labels and wrapping labels share typography. Wrapping labels preserve regular-sized, regular-weight input text. Customer, product and Staff forms are included in the responsive checks. |
| B — Own Staff profile | Compact profile facts and a single current-counter group precede job history and weekly reports. Period analytics follow them; the independent report retains its current counters. The embedded report keeps its distinct current type distribution. The monthly completion counter remains separate from period results. |
| B — Attribution copy | Completion descriptions now explain the recorded submission attribution used by the existing SQL. The explanation explicitly does not claim a separately verified performer. Longer calculation details have a named disclosure. Repeated visible delivery/outcome table captions are removed while accessible names remain. |
| C — Customer detail | Operational summary precedes general information and editing. Readable facts stay visible; a native disclosure opens the existing management form without remounting it when closed. The list's edit link uses `?edit=1` to open that disclosure directly. History precedes administrative deletion guidance. Staff enrichment stays separate. |
| D — Customer/product rows | Names and identifying data remain visible. Mobile row actions use their content width with retained touch targets. Product deletion uses a quiet secondary entry and the existing destructive confirmation. Customer facts reflow without fixed minimum columns. |
| E — Job rows | Status/priority precede the quieter process summary; customer identity has stronger contrast. Phase, expected actor, assignee, scheduling, lateness and actual role-scoped commands remain distinct. |

The existing single-page profile composition was retained with a new reading
order. There is no new business metric, attribution calculation, workflow,
permission, API, database or dependency. The recorded REPORT-001 performer and
lateness-explanation implementation remains a separate feature.

## Verification record

Exact commands and retained images are in the
[implementation evidence](../../evidence/visual-improvements-implementation-20261105/README.md).

- **passed:** `cd web && npm run build` with Node 22.23.3.
- **passed:** `cd web && npm test -- --run`, 215 files / 2735 tests, Node 22.23.3.
- **passed:** typed fixture check with the installed TypeScript CLI and the
  current report parser/count reconciliation test.
- **passed:** `cd web && npm run bundle:check`.
- **passed:** `cd web && npm run smoke:responsive`.
- **passed:** 22 reconciled before states, 63 final surface states and 2 overdue
  states; edit-intent, draft/conflict/focus, confirmation, history, PDF-download
  and report-retry interactions.
- **passed:** `git diff --check` and the scoped Impeccable layout detector.
- **not run:** server build/tests (no server edits), hosted CI, production writes,
  physical devices, WebKit/Safari, actual 400% browser zoom and a complete manual
  screen-reader/contrast acceptance pass. Chromium reflow probes and root-text
  enlargement are recorded with their exact scope.

## Acceptance boundaries

Current workload is displayed once per scope; unique distribution data is kept.
The capture matrix includes separate current-month and weekly-report dates,
populated/empty/loading/report-retry states and a mocked version conflict. The
existing unit suite covers additional form mutations, ownership, history
concurrency and role boundaries. Synthetic roles verify presentation rather than
backend authorization.

The management edit disclosure keeps its child form and existing `formRevision`
key. Closing/reopening it preserves a draft. Server conflict/reload behavior and
the Staff-only enrichment flow continue to use their original producers. A
missing next planned work item is still shown as missing data, without inferring
that a person failed to follow up.

The original 14-image bundle stays historical. The new before/after evidence
includes the actual providers, reconciled baseline data and explicit readiness
checks. It does not retroactively validate the old fixture or promote old
captures into current acceptance evidence.
