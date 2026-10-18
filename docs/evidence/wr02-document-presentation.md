# WR-02 — Weekly Report document presentation

## Scope and acceptance

Presentation-only follow-up to the accepted Weekly Report PDF projection in
`DECISIONS.md`. WR-01 remains undecided: this change makes no design or
implementation decision about reporting periods, Monday–Sunday identity,
creation dates, deadlines, duplicate policy, recurrence or persistence.

Before implementation, canonical main and remote main both matched
`8b9b2e23849cfe65a63e49381bf940eca91cd897`, tree
`653fe6ae06f72070256351a2bbebe136981bbae3`. Work used the isolated
`feat/weekly-report-document-presentation` worktree under `/Users/emrah`.

## Presentation

Previously, the PDF led with sender/report/JobCard identifiers, raw ISO dates and
large metadata rows. The detail caption and submission history exposed the
sender identifier alongside content.

The PDF now leads with **Haftalık Çalışma Raporu**, the supplied reporting period,
current staff display name, submission date and submission number. The original
six sections, frozen manager questions/answers and frozen source-work list keep
their order and values. Complete sender/report/JobCard identifiers, seq and exact
UTC submission instant appear once at the end in an 8pt gray technical record.
The record stays together; table headers repeat; bounded columns wrap long data.

Calendar DATE values are formatted textually, without recalculating a period.
The existing document model carries UTC instants but no organization timezone:
the PDF explicitly labels UTC and does not infer an organization or host zone.
The web keeps its existing instant formatter. No document-model/API change.

The web caption shows only submission number and readable time. Native
`details`/`summary` disclosures below frozen content and selected history expose
complete technical identities using the existing RecordDescriptions adapter.
History selection resets its disclosure. No submitter name is guessed from the
current JobCard assignee; the browser fixture intentionally uses different IDs.
The JobCard shell, main/work rail, lifecycle controls and history slots stay intact.

## Verification performed before the feature commit

- Baseline: PDF 17/17; web detail + PDF transport 64/64; existing weekly-report
  browser smoke PASS.
- New regressions first failed on the old UUID hierarchy and technical font size.
- `cd server && npm run build`: PASS.
- `cd server && npm test -- --run tests/weekly-report-pdf.test.ts`: 19/19 PASS,
  against a newly provisioned isolated PostgreSQL 17 test container/database
  `servora_med_test_wr02_20261018`, with PostgreSQL 17 clients and schema head 058.
- `cd web && npm run build`: PASS.
- `cd web && npm test -- --run tests/weekly-report-detail.test.tsx tests/weekly-report-pdf-transport.test.ts`:
  65/65 PASS, including unchanged lifecycle/retry/download coverage.
- Real PDF layout assertions cover line bounds, multiple pages, repeated table
  headers, final-page technical record, 8pt gray identities and full UUID text.
  Existing frozen-content, renamed-display-name, Turkish-font, inert-document
  and network-denial tests remain enabled.
- Generated real short (one-page) and long (six-page) PDFs and rendered all pages
  with Poppler. Checked prose, long questions/answers, long unbroken table titles,
  page boundaries, repeated headers, Turkish glyphs and final technical metadata.
- Browser fixture covers seven lifecycle states at 1440, 1024, 390 and 320 CSS px;
  200% text enlargement, 320px reflow (1280/400%), reduced motion, native Enter/Space
  disclosure behavior, focus outline, 44px targets, hidden/revealed UUIDs and
  opened technical-cell overflow. This is Chromium fixture evidence, not a
  manual screen-reader certification or a live production database test.
- Impeccable detector reported no findings in the changed component/new CSS block;
  11 findings in pre-existing CSS remain outside this slice.

## Exact-head release evidence and review boundary

This note is implementation/focused-verification context, not full-CI evidence.
The PR must record the committed feature SHA/tree, the external Local CI bundle,
all 27 required checks, the four opt-in R2/DR skips separately, cleanup result and
hashes, and an independent invocation of `verify-evidence.sh`. Any failed or
unexecuted gate blocks `WR02_READY_FOR_INDEPENDENT_REVIEW`; never reuse evidence
from another head. Do not automatically rerun full CI for an OVR-2 failure.

No migration/schema, API, authorization, file naming/download, submission snapshot,
audit, idempotency, approval/revision or JobCard lifecycle implementation changed.
Issue #369 A2/A3 is untouched. No production deployment, merge, force-push,
stash operation, graph reset/reindex or broad Git/Docker cleanup is authorized.
Independent code/PDF review and the user's merge decision remain outstanding.
