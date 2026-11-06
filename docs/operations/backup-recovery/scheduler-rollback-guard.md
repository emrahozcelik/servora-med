# BR5 operational scheduler continuity — clock rollback guard

Source parent: `d2f444705d212e18ffd7647c5d816e35fac4ac47` (Draft PR #410). Status: **implementation prepared; tests pending Codex execution**.

## Problem and scope

The scheduled backup worker already persists `last_scheduled_slot_key`, `last_scheduled_local_date`, `last_scheduled_for`, and `last_scheduled_run_id` transactionally under a row lock. The existing equality-only check consumed repeated slots on the same local date, but allowed a previously consumed *earlier* date to be enqueued when the host wall clock rolled back across a day boundary.

This change treats `last_scheduled_local_date` as a durable **calendar-day high-water mark**. A candidate scheduled slot whose local date is equal to or earlier than the persisted date returns `already-consumed`; the existing run pointer and audit history are not rewritten. A genuinely later local date can be enqueued normally. Slot generation still follows the existing IANA timezone/DST policy. The comparison is valid for the canonical `YYYY-MM-DD` local-date strings produced by `getDueScheduledSlot()` and read from PostgreSQL DATE. No schema change is necessary.

This is **not an automatic system clock correction**, a new time authority, or an exact-SI-age proof. A clock incorrectly jumping far into the future can advance the high-water date and suppress later slots until that date is passed; it must be treated as an operational anomaly and investigated. Never reset/rewind the singleton or generate catch-up jobs automatically to conceal that condition.

## Boundaries

- Only BR5 scheduled-run admission changes, not manual jobs, jobcard timestamps, visit timestamps, follow-up tasks, or PostgreSQL/system clocks.
- The existing advisory lock, row lock, single active run, lease fencing, durable scheduled pointer, and audit event remain authoritative.
- No modification to R2 integrity, verification evidence, `elapsedTime()`, TT-A/TT-B, 26-hour freshness, provider flags, or public BR5 health.
- **The source-owned BR5 positive-health admission remains BLOCKED** pending its separate OT3-C/D requirements. Earlier P1 false-healthy fixtures remain historically FAIL; this scheduler guard does not repair them.
- No migration, no production deployment, and no BR5 activation are authorized. Production 060→060 continuity and later 061 release remain separate gates.

## Acceptance handoff to Codex (test-only)

1. Verify the exact new PR head/tree and unchanged safety boundaries; do not modify source or test files.
2. With a disposable PostgreSQL 17 schema, show the added regression goes RED against parent `d2f444705d212e18ffd7647c5d816e35fac4ac47` and GREEN against the new head.
3. Run targeted `server/tests/backup-worker-postgres.test.ts`, scheduling/runtime and failure-ordering tests, build and relevant backup/health tests. Confirm 26-hour health does not become healthy due to this change.
4. Verify created earlier-date row count is zero, `lastScheduledRunId` remains immutable under rollback, and next later-day scheduled slot succeeds.
5. Preserve canonical checkout, REPORT-001, PR409 and five stashes. No production, R2/DR, migration activation, merge, independent review, or GitHub Actions unless independently authorized.

## Follow-up (outside this small code change)

Evaluate jobcard/follow-up queue identities separately before applying a similar invariant; do not reuse the backup singleton across business processes. External missing-run monitoring and real R2/PG17 restore acceptance remain separate owner-gated tasks. The desired architectural principle is durable **slot identity + idempotent state transitions + event history**, not timestamp-driven rewinding or advancing of the operating system clock.
