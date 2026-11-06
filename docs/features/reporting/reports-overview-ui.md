# Reports overview and team presentation

Status: implemented 2026-11-04; responsive review corrections applied 2026-11-05.
Hosted CI passed for `bfe72c546275c764ddc9b1341c9876cf3b440a05`
([run 41910043312](https://github.com/emrahozcelik/servora-med/actions/runs/41910043312)).
Later revisions require their own successful PR-head run; the current result is
tracked in [PR #409 checks](https://github.com/emrahozcelik/servora-med/pull/409/checks).
Merge is pending. The individual staff page remains a separate UI/UX slice.

User-authorized slice: improve Reports / Summary and Reports / Staff in the
existing Ant Design system. The confirmed main chart is visits, follow-up visits
and approved sales. The individual staff page remains a separate UI/UX slice.

## Read contract

- Management-only `GET /api/reports/business-trend`, existing range validation,
  organization timezone and organization scoping. One SQL statement supplies
  the complete response from one database snapshot; no schema changes.
- Visits are currently approved (`COMPLETED`) `SALES_MEETING` cards, dated by
  `meeting_at`. All engagement kinds remain included. Follow-up visits are the
  subset with an explicit `source_job_card_id`; they are not extra visits.
- Sales are currently approved `SALE` cards, dated by their own `sold_at`.
  Each card counts once, independently of its product lines or the source
  visit's performer. Delivery purpose `SALE` is not a sale agreement.
- Only elapsed dates are plotted. The current local day is partial. Comparison
  uses the immediately preceding equal number of observed calendar days and
  the same local cutoff time on its last day when today is partial. No future
  zeroes, cumulative always-rising curve, invented score or revenue metric.
- Current cohort: approved visits occurring in the observed selected range.
  Count distinct cohort visits with an approved, explicitly linked follow-up
  meeting for the same customer; distinct cohort visits with an approved sale;
  and the subset of follow-up visits with an approved sale. Related events may
  occur after the selected range, up to the response's `asOf`. This is current
  recorded linkage, not a causal or time-window conversion rate. No inferred
  links from customer equality, positive notes or meeting outcomes.
- Cancelled, invalidated and unapproved cards do not count as approved results.
  The sale capability parameter continues to gate sale counts and links.
- These are organization-level facts. This slice does not implement the future
  verified-performer attribution or lateness explanation mechanisms in
  [REPORT-001](README.md), and must not advertise the existing staff counters
  as that new attribution system.
- Staff comparison uses the available content width after shell chrome and text
  enlargement. Narrow tablet/desktop content uses the same sortable cards as
  mobile; sufficiently wide content retains the comparison table. Header words
  must remain intact and details controls must stay inside their cells. A raw
  viewport wider than 720 px does not require the table.

## Acceptance criteria

- [x] The first summary visualization shows three labelled line series, period
  totals, prior-period counts and explicit absolute changes (no division by zero).
- [x] Mouse, touch and keyboard users can inspect the same data; a semantic
  table offers the full daily values. Series differ by stroke as well as color.
- [x] Relationship counts explain their cohort, link requirements and observation
  cutoff. Existing operational queues and delivery reports remain available.
- [x] Staff comparison has readable columns, an explicit details action without
  plus buttons, sorting and a mobile layout. Existing facts remain accessible.
- [x] Loading, empty, future, zero, partial-day, error/retry and request-race
  behavior are covered. No frontend-derived business facts.
- [x] PostgreSQL integration tests cover timezone, boundary, approval,
  invalidation, organization isolation and distinct linkage semantics.
- [x] Server/web builds and relevant tests run; desktop/mobile, keyboard,
  200% text and 400% reflow are checked in a real browser. Evidence and any
  unavailable checks are recorded below.

## Verification

Original acceptance recorded 2026-11-04 on the working tree that became branch
`codex/reports-overview-20261104`. PostgreSQL 17 preflight passed against an
isolated database with the schema at repository head
`060_crm_duplicate_review_decisions`.

| Check | Command | Result |
| --- | --- | --- |
| Server build | `cd server && npm run build` | exit 0 |
| Server suite | `cd server && npm test -- --run` | 372 files passed, 5 skipped; 4339 tests passed, 8 skipped |
| Server reports scope | `cd server && npm test -- --run reports- tests/local-evidence-deploy-gate.test.ts tests/db-auth-contract.test.ts tests/customer-search-normalization-postgres.test.ts` | 21 files, 216 tests passed |
| Web build | `cd web && npm run build` | exit 0 |
| Web suite | `cd web && npm test -- --run` | 214 files, 2730 tests passed |
| Browser acceptance | `cd web && node scripts/reports-ui-smoke.mjs` | 16 Chromium checks passed |

The browser run uses the synthetic fixture in `web/scripts/reports-ui-fixture.tsx`
at 1440 px, 390 px and 320 px, 200% root text and 400% reflow, with reduced motion
and keyboard operation. It covers desktop/mobile series inspection, the semantic
daily table, staff expansion and sorting, zero/future/long-range states, local
trend failure with retry, and document/component overflow. The skipped server
files are the repository's environment-gated suites; they are not report
failures. Raw captures and `browser-checks.json` are regenerated local artifacts
under `.impeccable/review/` and are not committed.

Not verified here and not claimed: screen-reader output, production data,
and physical-device behavior. Hosted CI evidence is bound to the commit and run
above; a successful earlier run does not verify a later revision.
The verified-performer attribution and lateness explanations in
[REPORT-001](README.md) remain unimplemented.

### Responsive review corrections — 2026-11-05

- The new header-word geometry assertion failed on the previous 40rem layout at
  768 px (`bekliyor`, `Geciken` split across lines), then passed after the staff
  container threshold returned to 52rem. The existing responsive suite now
  checks that exactly one staff layout is visible instead of forcing the table
  at every viewport above 720 px.
- `reports-ui-smoke.mjs` is now a named step in the web CI job. Its captures use
  the runner's temporary directory. The local-CI fallback runs the same script
  within its existing `web-geometry` gate and records captures under its owned
  auxiliary logs; the 27-gate evidence contract is unchanged.
  The script covers 768/1024 px summary and staff views, 1440/1920 px with 200%
  root text, existing 390 px mobile and 320 px
  reflow, full-word headers, in-cell details controls, sorting and keyboard
  disclosure. These are Chromium fixture checks, not physical-device evidence.
- Local follow-up verification: server/web builds passed; the complete web suite
  passed (214 files, 2730 tests); bundle budgets passed; the report browser suite
  passed all 26 checks; `npm run smoke:responsive` passed. Local-CI shell/static
  checks and all 25 `ops/tests/ci-resource-cleanup.test.mjs` tests passed.
  The unchanged server suite was not rerun locally in this correction; its prior
  result and the PR-head hosted gate remain distinct.
