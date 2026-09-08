# CALENDAR_INTERVAL_BOUNDARY_AUDIT_0

Status: backlog; implementation not authorized by PR #257 remediation.

The pre-existing JobCard calendar list includes intervals ending exactly at `from`
(`COALESCE(scheduled_ends_at, scheduled_at) >= from`), while manual events use
`ends_at > from`. Define one half-open interval contract before changing behavior.

Acceptance criteria for a separate gate:

- Interval [09:00, 10:00) does not overlap [10:00, 11:00).
- JobCard and manual-event list boundaries agree with conflict checks.
- Midnight and organization-timezone boundaries are covered.
- A GENERAL_TASK point event at `from` remains visible; null end times require
  explicit point semantics rather than a blind comparison replacement.
- Preserve organization, Staff visibility and active-status filters.

PR #257 does not change the calendar repository or implement R3.
