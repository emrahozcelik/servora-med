# Admin Weekly Report removal and period release

Status: accepted for implementation by the product owner on 2026-11-07.
Rollout: source/PR implementation; production migration and deployment are separate.

## Policy

An active same-organization ADMIN may remove an incorrectly created Weekly
Report with a mandatory reason. This includes completed, cancelled and already
invalidated reports. Removal retains the original JobCard, report draft,
submissions, PDFs, source-work snapshots, notes, activity and attribution.
No source work or other business record is deleted or reassigned.

The report's JobCard becomes INVALIDATED through the existing correction
semantics; an already invalidated root remains invalidated. WeeklyReport records
the removal actor, time and reason. That metadata releases its identity claim
on the Staff/week, not another workflow status. Generic cancellation and
invalidation continue to reserve the week unless Admin explicitly removes the
report. There is no restore/reopen command in this slice.

This explicitly supersedes Weekly Report V1 Slice 1's lifetime Staff/week
uniqueness and exclusion of replacement semantics **only for removed reports**.
Migration 061 adds nullable removal metadata and a partial unique index over
non-removed reports. Existing rows are retained and continue reserving their
periods. JobCard owns lifecycle; WeeklyReport owns current report identity.

Single create and bulk request share the current-report lookup and uniqueness
constraint. A replacement is a new independent report with new identities and
normal Staff authorship/manager approval. Original create receipts replay the
original identities, never the replacement. Removed history remains readable
through the existing detail, submission, PDF and personnel-history paths.

## Commands and reads

- `GET /api/job-cards/:id/weekly-report/removal-preview`: Admin-only advisory
  target/period/status/version/submission summary and removal eligibility.
- `POST /api/job-cards/:id/weekly-report/remove`: Admin-only command with
  `clientActionId`, `expectedVersion`, `expectedReportVersion`, mandatory
  trimmed reason (1–2000 Unicode code points). Unknown fields are rejected.
- Current actor and owner, root/report ownership, versions, removal state and
  active follow-up blockers are revalidated under User → JobCard → WeeklyReport
  locks. No historical mismatch is repaired.
- Removal, invalidation when needed, append-only activity/audit, version changes,
  idempotency receipt and realtime effects commit together. Failed commands roll
  back. New keys for an already removed target conflict; exact retries converge.
- New removal fields on existing strict weekly-report reads are reader-gated by
  `includeWeeklyReportRemovalCapability=true` during the frontend rollout.

## UI

Extend the existing Weekly Report detail with backend-authorized Admin removal.
Show the exact Staff, week, status and submission presence, preservation scope,
mandatory reason and one explicit confirmation. Preserve reason/action identity
when an outcome is uncertain; reconcile the original target and retry the same
intent. Successful removal shows a historical banner and a normal-create link;
it never copies content or creates a report automatically. Removed rows stay in
personnel history, marked as removed, with their original PDF history.

Use existing tokens, reason/confirmation adapters and providers. Cover mobile,
keyboard, focus return, pending/error/conflict states, reduced motion, 200% text
and applicable reflow checks. No broad Admin redesign or new dependency.

## Acceptance criteria

- Reject Manager/Staff, inactive/demoted Admin, cross-organization and wrong-type targets without mutation.
- Preserve completed frozen content and cancelled history; permit a new independent report for the same Staff/week.
- Preserve every source JobCard and unrelated report, customer, contact, product, Staff record and history row.
- Enforce versions, ownership and removal state under locks; serialize removal/create and competing creates.
- Keep generic cancel/invalidate uniqueness, historical receipts, immutable submissions/PDFs and Staff-only authorship unchanged.
- Roll back all effects on any late error; persist one removal outcome for identical retries and reject changed intent.
- Prove current-report uniqueness in PostgreSQL, single/bulk convergence and repeated removal/replacement cycles.
- Verify role visibility, preview, reason/confirmation, uncertain retry, historical display and create link with real rendered components.

## Implementation / verification ledger

- [x] Migration, backend command/read model and regression tests.
- [x] Weekly Report UI/API, historical display and interaction tests.
- [x] Server build/full suite, web build/tests and rendered accessibility evidence.
- [ ] Exact PR-head hosted CI and review-ready PR.

Local evidence (2026-11-08/09, isolated PostgreSQL 17): migration 061 applies on a
fresh database to full head; server suite 4366 passed / 8 skipped with one
environment-only `db-auth-contract` failure that passes 11/11 against a
`scram-sha-256` cluster matching CI; web suite 2771 passed; 11 rendered
Playwright scenarios passed. Hosted CI on the exact PR head is still pending.
