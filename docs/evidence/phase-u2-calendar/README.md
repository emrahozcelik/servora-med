# Phase U2 browser evidence

Status: **DEFERRED TO OPERATOR**

Automated server, web, bundle, and responsive-smoke validation is recorded in the Phase
U plan. Direct browser verification and persistent PNG capture are not claimed by this
implementation checkpoint.

## Short operator prompt

> Check out the exact Draft PR head and use the repository’s synthetic test database.
> Start the API and Vite app with `CALENDAR_ENABLED=true`. With Playwright or Chrome
> DevTools, verify Staff and Manager calendar flows at 390, 1024, and 1440 px: busy and
> empty week, Manager team filter, manual create/edit/cancel, JobCard reschedule,
> half-open adjacency, overlap conflict with preserved draft, stale-write recovery,
> Overview upcoming work, and calendar-notification deep link. Also check 200% text zoom.
> Use synthetic identities only, keep free-text fields non-sensitive, leave password
> fields empty, and save the approved PNG matrix in this directory. Record the exact
> capture commit SHA and any deferred/failed scenario here; do not mark browser evidence
> complete from automated tests alone.

Expected filenames:

- `staff-calendar-390.png`
- `staff-calendar-1024.png`
- `manager-calendar-1440.png`
- `manager-calendar-filtered.png`
- `calendar-conflict.png`
- `calendar-empty.png`
- `overview-upcoming-staff.png`
- `overview-upcoming-manager.png`
- `calendar-notification.png`
