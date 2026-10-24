# Weekly Report ownership and resolution — SOF-2A / SOF-2B / SOF-2C

Status: accepted product policy, 2026-10-22; SOF-2B implementation amendment,
2026-10-23; SOF-2C resolution amendment, 2026-10-24.

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
An unfinished report created after preview returns the resolution blocker before
the stale-plan check; resolved legacy plans still require a fresh preview.
WeeklyReport must never reach a generic replacement assignment mutation; SQL
also fences out typed weekly roots and roots attached to a WeeklyReport row.

## Explicit follow-on boundaries

- SOF-2B: manager-only WeeklyReport cancellation and atomic draft validation
  are implemented by the separate amendment below. Other JobCard cancellation
  policy remains unchanged.
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


## SOF-2B atomic draft and cancellation amendment

Draft replacement uses the existing JobCard repository transaction with locks in
this order: current user `FOR SHARE`, root `FOR UPDATE`, WeeklyReport `FOR UPDATE`.
The active STAFF role and tenant are re-read, and the current root must be a
WEEKLY_REPORT assigned to the actor with the same original reporting owner.
Missing rows and historical owner/assignee mismatches fail closed; no repair.
Only ACCEPTED/IN_PROGRESS may write. Validation of frozen questions/answers and
the report's expectedVersion occurs under the locks; SQL keeps its version fence
and executes on that transaction client. JobCard version is not substituted.

Draft-first and lifecycle-first execution serialize at the root. A preceding
CANCEL, SUBMIT, APPROVE or REQUEST_REVISION leaves the draft locked; RESUME may
make it editable again, subject to the fresh report version. Full replacements
never silently merge content. Stale or future versions conflict without UPDATE.
A late error rolls back draft, report version and all transactional effects.
Ordinary drafts create no lifecycle activity or processed-action receipt.

The existing user snapshot primitive supplies `FOR SHARE`: it blocks role and
deactivation changes, but is compatible with SUBMIT/standalone note author SHARE
locks. Weekly manual reminders take that same target snapshot before the root
and avoid a later lock upgrade. Non-weekly reminder behavior is unchanged.
Standalone WeeklyReport `updateDraft`, pool-level JobCard draft UPDATE and the
Pool-capable shared update helper are removed; only the locked transaction
exposes draft SQL. Repository test fixtures now write via the authorized service.

STAFF cannot issue a new CANCEL for any of the five unfinished WEEKLY_REPORT
statuses. The same canonical command policy drives UI capabilities, reservation
preflight and locked finalize. MANAGER/ADMIN keep existing reasoned CANCEL;
activity, reason notes, actor and receipt semantics remain. Other JobCard types
retain their cancellation policy. A successful pre-amendment scoped receipt
replays before fresh policy validation; a pending old reservation is not approval
for a new Staff cancellation. Unknown-outcome/recovery rules are not expanded.

Frozen seq1/seq2 submissions, submittedBy, PDF models and original attribution
remain unchanged. Original Staff/week uniqueness, independent replacement
creation, SOF-2A both-owner blockers and SOF-1 terminal-proposal priority remain.
OF-02 stays open pending SOF-2C and closure verification. No migration or new
front-end authorization rule is needed: WeeklyReport UI uses canonical commands.

## SOF-2C actionable resolution amendment

The existing preview and fresh execute 409 contract remains capped at its first
50 metadata items. The Admin offboarding drawer validates that metadata before
display, shows the total and visible count, and links only `UNFINISHED` items to
their existing JobCard. `MISSING_REPORT`, `OWNER_ASSIGNEE_MISMATCH` and
`ROOT_TYPE_MISMATCH` are identified as data-integrity cases without a normal
resolution link. They require separate authorized review; this slice neither
repairs them nor forces cancellation.

`GET /api/users/:userId/offboarding/weekly-report-blockers` is an Admin-only,
same-organization, read-only metadata continuation. `limit` is 1–50 (default
50); `afterJobCardId` and `afterPeriodStart` form an exclusive cursor. Both
cursor fields must be supplied together; the latter is a valid period date or
the literal `null` for missing periods. Unknown or invalid query fields fail
validation. The response uses the same `total`, `limit`, `hasMore`, `items`
shape and the same period/null-last/root-id order as the 409. Each read uses a
consistent snapshot for its bounded page and total. Concurrent changes between
reads can shift membership; the UI restarts when the count changes and always
requires a fresh preview before confirmation. The endpoint exposes no draft,
answers, submission or PDF content and authorizes no mutation.

Management uses existing JobCard approval/revision or reasoned WeeklyReport
`CANCEL` commands. The return route keeps the target Staff id and requests a
new authoritative preview; previous plan hashes and decisions are discarded.
A replacement report, when needed, is created independently through the normal
manual form, without copying former content or impersonating Staff. Preview
blockers create no execute attempt. A deterministic execute blocker retires
only its matching persisted attempt before allowing a fresh plan; ambiguous
outcomes retain exact-intent recovery. SOF-1 terminal blocker priority and the
atomic offboarding barrier remain unchanged.

SOF-2C review requires focused PG17 and frontend tests, real desktop/mobile
browser flows including 201 blockers, exact-head Local CI 27/27 and verifier.
OF-02 closure is a separate integrated audit. OF-01, OF-09, terminal proposal
resolution and legacy data repair remain open.

### Known out-of-scope issue found during SOF-2C verification

With `prefers-reduced-motion: reduce`, the shared `ServoraAntProvider` disables
antd motion app-wide, and `@rc-component/trigger` then never re-aligns a Select
popup: the option list stays at its `-1000vw/-1000vh` placeholder offset and a
mouse click opens an invisible list (keyboard entry plus Enter still selects).
This reproduces unchanged at `6054474` with a byte-identical antd bundle, so it
is not a SOF-2C regression and this slice does not change it. SOF-2C browser
verification therefore validates the blocker panel under reduced motion and the
untouched manual report form under the default motion preference. Repairing the
popup is a separate authorized UI/accessibility slice.
