# SOF-1 — StaffOffboarding terminal history integrity

Scope: OF-03 P1 containment, authorized on 2026-10-22. This implements the existing terminal-history invariant and the explicitly authorized fail-closed fallback. No migration, CRM merge, WeeklyReport ownership, acceptance-policy or generic lifecycle redesign is included.

## Terminal responsibility boundary

`COMPLETED`, `CANCELLED` and `INVALIDATED` JobCards retain their original assignee, status, version, proposal fields, activities, assignment history and accountability facts during offboarding. No assignment/field-edit event is synthesized on a terminal source. The mutation also requires an active status in SQL.

A future proposal assigned to the target Staff on any terminal source returns `409 OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW` in both preview and execute. This is a whole-operation blocker: no partial transfer, session revocation, deactivation, audit or processed-action claim survives. The existing UI shows the server's explanation in its blocking load-error state. No plan DTO or frontend permission change is required.

A terminal record without such a proposal is untouched while normal active JobCards and their mutable future proposals, Customers, Calendar, Reminders, messaging and session revocation continue through their existing paths. Past proposals and proposals assigned to another eligible user are not reassigned as historical facts.

## Why a child link cannot waive the blocker

The approval command can create a linked follow-up child in the approval transaction (`job-cards/service.ts`, `runLifecycle`, `createFollowUpChild`). It may override the persisted proposal's assignee, type, instructions or schedule. The separate post-hoc `createFollowUp` command also uses `source_job_card_id`; it accepts only completed sources. Migration 022 establishes source/child identity, not a unique proposal-consumption witness. Cancellation/invalidation do not authorize offboarding to rewrite frozen proposal facts.

Consequently this fix does not infer that any child, a matching timestamp or a terminal child proves a pending proposal resolved. Even when a child exists, the future terminal proposal blocks offboarding. Actual active children remain ordinary independent responsibilities; the blocked operation does not silently drop them.

**Pending product decision:** define an explicit, audited resolution/consumption record and its authorization before selectively waiving this blocker. Do not edit a terminal proposal, fabricate its consumption, wait for time to elapse as a workaround, or offer a bypass flag. This PR adds no resolution command. The blocker is conservative containment and can prevent an otherwise safe offboarding where a future historical proposal was already consumed; that availability limit is explicit.

## Regression and release acceptance

- Six future-proposal variants: all terminal statuses × same/different current assignee. The original code mutates historical data; the fixed command blocks without changes.
- Six no-proposal variants: terminal snapshots unchanged while active work transfers; exact same-intent replay has no new effects.
- Past/other-assignee proposal preservation; child-link ambiguity; execute recheck after preview; stale plan; real PostgreSQL row-lock concurrency; late transaction rollback; populated historical facts; organization/role isolation.
- State assertions cover JobCard fields, activity, assignment/accountability history, audit, processed actions, users/sessions, Customers, Calendar/Reminders, participants and realtime rows.
- Existing offboarding/calendar/follow-up/reminder/history/weekly regressions remain required. Exact committed head must pass full server/web builds and tests, Local CI 27/27, evidence verification and browser smoke. External SHA/tree-bound evidence records execution results; this document does not turn unexecuted gates into PASS.

Sources: [offboarding service](../../server/src/modules/people/offboarding.ts), [PG regressions](../../server/tests/staff-offboarding-postgres.test.ts), [terminal policy](../../server/src/modules/job-cards/policy.ts), [follow-up source contract](../../server/src/db/migrations/022_job_card_follow_up_links.sql), [API contract](../../SERVORA_MED_API_DRAFT.md).
