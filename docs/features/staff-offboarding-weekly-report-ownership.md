# Weekly Report ownership containment — SOF-2A

Status: accepted product policy, 2026-10-22. Implementation scope is SOF-2A only.

## Ownership and authorization

`weekly_reports.staff_user_id` is the original reporting Staff identity.
`weekly_report_submissions.submitted_by`, frozen content/source-work, PDF content
models and historical attribution are never reassigned. A real assignee change
on a WEEKLY_REPORT is rejected for all otherwise-authorized actors, including
ADMIN, as `409 WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE`; same-value PATCH semantics
remain unchanged. Current row/version checks apply at the locked write boundary.

Unfinished reports block offboarding when linked to the target through either
`job_cards.assigned_to` or `weekly_reports.staff_user_id`. Missing report rows,
owner/assignee mismatches and report/root type inconsistencies fail closed.
There is no automatic repair, cancellation, completion or replacement creation.
Manager/Admin uses existing authorized resolution commands; offboarding remains
ADMIN-only and tenant-scoped. Inactive Staff history stays readable by authorized
same-organization management through existing history paths; this explicitly
clarifies the older Slice 4 “active STAFF” wording without expanding list,
Staff, messaging or tenant permissions.

## Blocker contract

Preview and fresh locked execute return
`409 OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION`. `details.weeklyReports`
contains `total`, `limit: 50`, `hasMore` and `items`, ordered by reporting Monday
(missing periods last), then root id. The total covers every matching report;
only metadata delivery is capped. No paging parameter or new endpoint is added
in 2A; actionable navigation/paging is SOF-2C.

Each item contains `jobCardId`, nullable `reportId`, `staffUserId`, `periodStart`,
`reportVersion`, plus `assignedTo`, `status`, `jobVersion` and `reason`:
`UNFINISHED`, `MISSING_REPORT`, `OWNER_ASSIGNEE_MISMATCH` or `ROOT_TYPE_MISMATCH`.
Draft, answers, frozen submission content and other tenants' data are excluded.
Existing error rendering displays the explanatory message; the full resolution
journey is not implemented in 2A.

SOF-1's terminal future-proposal blocker keeps priority. Completed exact-intent
receipts are returned before fresh business validation. Blocker failure rolls
back all transfers, session revocations, deactivation, audit and receipt writes.
WeeklyReport must never reach a generic replacement assignment mutation; SQL
also fences out typed weekly roots and roots attached to a WeeklyReport row.

## Explicit follow-on boundaries

- SOF-2B: accepted manager-only WeeklyReport cancellation and transactional
  draft/status/owner validation. Neither is implemented by 2A. Other JobCard
  cancellation policy is unchanged.
- SOF-2C: actionable report links, management resolution and fresh-plan journey.
- Replacement: a normal independent report for the new Staff/week. Former draft,
  answers and history are not copied; explicitly entered new instructions and
  questions are allowed by the existing create contract. No new workflow in 2A.
- OF-02 stays open until 2A/2B/2C closure review. OF-01, OF-09, terminal follow-up
  resolution, CRM4B and historical mismatch repair remain separate.

## Acceptance

Real PG17 regressions must prove all five unfinished statuses, both sides of a
legacy mismatch, missing/inconsistent rows, terminal preservation, SOF-1
priority, forged decisions, no partial mutation, normal non-weekly transfers,
stale review/exact replay, competing writers, role/tenant isolation and complete
blocker detection with 1/50/201 records. Exact-head CI and available error-UI
browser smoke are required before review; no migration or dependency is needed.
