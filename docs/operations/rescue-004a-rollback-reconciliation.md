# Occupancy-semantics rollback gate and read-only inventory

Operational runbook for a candidate release that contains the RESCUE-004/A
released-reservation predicate (`JOB_STAFF_RESERVATION_RELEASED_SQL`,
`server/src/modules/job-cards/occupancy.ts`). Read it together with the
OPS-DEPLOY-002 addendum in `DECISIONS.md` and SCH-001 §7.

This runbook changes no deployment code, invents no live-host capability, and
performs no automatic data action. The workflow is manual: it defines the
pre-dispatch decision, the write-quiescence evidence standard, the read-only
SQL inventory, and the operator-driven reconciliation sequence. It does not
authorize a deployment, a rollback, or production access by itself.

## Why the normal route needs a gate

The normal one-action Production Deploy route activates and restarts the
candidate, checks host health, and only then runs the public browser smoke
(`ops/deploy-production.sh`, `run_browser_smoke` against `https://$FQDN`). If
that smoke fails and zero migrations were applied, the runner automatically
switches the previous release back and restarts the service (`rollback_remote`).
Because `run_browser_smoke` requires public reachability of `/`, `/login`,
`/api/health`, and anonymous `/api/auth/me` (`401`), the candidate can serve
public ingress and persist new released-offer / occupancy state before the older
binary serves.

SCH-001 §7 requires write quiescence, an overlap inventory, and explicit
reconciliation before reverting. The older binary counts a `DECLINED`/`RELEASED`
newest offer as occupying again: it re-counts released rows and cannot
interpret the new released state, so stored overlaps may be reported as
conflicts.

## 1. Pre-dispatch gate (manual)

Record before dispatching a release:

- candidate SHA and whether it contains `JOB_STAFF_RESERVATION_RELEASED_SQL`;
- production `CALENDAR_ENABLED` (manual plans contribute only when `true`);
- the chosen route and verified fence/approval posture:

| Situation | Route and action |
| --- | --- |
| A safe, independently verified write fence covers candidate activation, smoke, and any old-service restart without breaking the selected route | Normal OPS-DEPLOY-002 route is acceptable. Keep the fence intact across any automatic rollback and run §3–§4 before writers return. |
| Writers cannot be safely fenced on the normal route, and a **separately authorized attempt-bound R4 route** is available | Do not rely on the normal route's automatic rollback. Use `ops/deploy-production.sh --attempt-id ...` with a separate genuine root approval: browser-smoke failure stops at `MANUAL_REQUIRED_ATTEMPT_FENCED` instead of reverting. Keep a forward-fix candidate ready. Any later manual rollback remains gated by §2–§4. |
| Neither a safe verified write fence nor a separately authorized attempt-bound R4 path is available | **Keep the candidate on production HOLD.** Do not dispatch the release. |

Production Deploy is manual. The gate is decided before dispatch, not after a
failure, and must not be bypassed by editing deployment code or adding skip
flags.

## 2. Effective write quiescence and required evidence

Write quiescence means no user, public caller, API client, or background worker
can persist a job, offer, assignment, or calendar change across the fenced
window.

**Required evidence of effective write quiescence** (all three must be
independently verified and recorded; never invent a host fencing capability that
is not present and verified on the host):

1. **Blocked authenticated, public, and API ingress:** independently verify at
   the ingress/proxy boundary (for example reverse proxy / tunnel / firewall
   rules, and negative probes confirming write-capable API endpoints are blocked)
   that authenticated, public, and API callers cannot reach write handlers.
2. **Drained in-flight write paths:** verify in-flight HTTP requests and
   database write transactions touching jobs, offers, assignments, or calendar
   events have completed and no active write transaction remains open.
3. **Drained/stopped relevant workers:** verify background workers and timers
   capable of mutating job, offer, or calendar state (such as
   `assignmentOfferExpiryWorker`, `overdueBreachScanner`,
   `overdueReminderWorker`, `calendarReminderWorker`, `latenessAlertWorker`, and
   any host timer/job writing those tables) are stopped or drained and inactive.

**Fence retention:** retain the fence continuously through candidate activation,
browser smoke (or smoke failure), and any old-service restart until §3–§4
reconciliation completes and the inventory is zero.

**Limits of timestamp snapshots:** `max(created_at)` / `max(updated_at)` /
`max(opened_at)` queries are **supporting negative-evidence signals only** and
are **never sole proof** of write quiescence. They can miss backdated
timestamps, non-max updates to older rows, deletes, in-flight transactions, or
mutations in tables not sampled (such as `job_card_activity` or
`job_card_change_requests`). If you record a supporting snapshot alongside the
fence evidence above, label it explicitly as supporting-only and treat any
movement as proof that quiescence failed.

## 3. Read-only collision inventory

Run `docs/operations/sql/rescue-004a-rollback-inventory.sql` inside its
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;` block.

**Credential and connection hygiene:**

- **Never** put a credential-bearing PostgreSQL URL in `psql` process `argv`
  (never `psql "$PRODUCTION_DATABASE_URL"` or an inline password URL).
- Connect using either:
  - local OS **peer** authentication as a preauthorized read-only role, or
  - a **preauthorized read-only PostgreSQL service alias** (`PGSERVICE` /
    `~/.pg_service.conf`) paired with `PGPASSFILE` (mode `0600`).
- This runbook does not fabricate an already-configured service alias and never
  creates, edits, or prints credentials.
- **Testing on isolated PostgreSQL:** validating this SQL file against a
  disposable/isolated PostgreSQL 17 fixture is allowed and recommended; keep
  synthetic validation outputs strictly separate from production gate records.
- Never edit production rows to "prepare" or quiet the audit.

Example invocation (replace `<readonly_service_alias>` and `PGPASSFILE` with
preauthorized environment values, or omit both when using local peer auth as a
preauthorized read-only role):

```bash
PGSERVICE=<readonly_service_alias> PGPASSFILE=/path/to/readonly.pgpass \
  psql \
    --set=ON_ERROR_STOP=1 \
    --set=calendar_enabled=true \
    --file docs/operations/sql/rescue-004a-rollback-inventory.sql
```

Set `calendar_enabled` to the target environment's `CALENDAR_ENABLED` boolean
(`true` or `false`). In `REPEATABLE READ READ ONLY`, all four result sets read
one consistent MVCC snapshot:

1. **Released reservations:** `NEW` on-site jobs whose newest offer (`opened_at
   DESC, id DESC`) belongs to the current assignee and is `DECLINED` or
   `RELEASED` with a positive interval (the population the older binary counts
   again).
2. **Same-assignee active job-overlap pairs involving a released job:** every
   pair `(r, b)` where `r` is released and `b` is an active on-site job
   (`NEW`, `ACCEPTED`, `IN_PROGRESS`, `WAITING_APPROVAL`, `REVISION_REQUESTED`)
   whose JOB-007 `occupied_ends_at` strictly exceeds `b.scheduled_at` (matching
   legacy `occupancy.ts` SQL) and overlaps `[r.scheduled_at, r.scheduled_ends_at)`.
   Includes both `released+held` (`overlapping_job_also_released = false`) and
   `released+released` pairs, deduplicating `released+released` pairs with
   canonical ID order (`r.id < b.id`, `overlapping_job_also_released = true`).
3. **Same-assignee active manual-calendar-overlap pairs:** populated only when
   `calendar_enabled=true` (SCH-001 §2), and empty when `calendar_enabled=false`.
4. **Summary:** records `calendar_enabled` explicitly alongside
   `released_reservations`, `overlapping_active_jobs`, and
   `overlapping_active_manual_plans`, matching the detail result sets.

The SQL output is limited to opaque UUID identifiers, enums, booleans, and
timestamps (no unnecessary organization, staff, or customer names and no titles)
so downloadable gate evidence avoids unnecessary PII. The inventory is
staff-scoped because SCH-001 occupancy is staff-scoped.

## 4. Rollback and reconciliation sequence (under the fence)

Execute rollback and reconciliation in this strict order:

1. **Maintain the write fence:** keep authenticated/public/API ingress blocked
   and relevant workers stopped/drained.
2. **Inventory under the fence before rollback:** run §3 before reverting to
   the older binary (or, if an automatic rollback already switched binaries
   inside a continuous verified fence, before any normal writers or workers are
   permitted to run on the older binary).
3. **Approve and execute each reconciliation via application commands using
   authorized operator-only access:** while the general write fence remains in
   force, an authorized operator reconciles every overlapping row through normal
   authorized application commands (for example reassign, reschedule, or cancel
   via the application). Never `UPDATE`/`DELETE` job cards, offers, assignments,
   customers, or calendar rows directly in SQL, and never infer facts from
   client state. Record each decision and resulting state.
4. **Repeat until zero:** rerun §3 after reconciliation until
   `overlapping_active_jobs = 0` and `overlapping_active_manual_plans = 0`.
   An unintended real double-booking that cannot be cleanly reconciled is an
   incident: keep affected planning paused, hold the fence or forward-fix (§5),
   and record evidence.
5. **Maintain the fence across return:** keep writers fenced across any binary
   switch and old-service restart until zero overlaps are confirmed on the
   serving state.
6. **Optional post-check, then lift fence:** optionally rerun §3 read-only as a
   post-check under the fence; once confirmed zero, lift the ingress/worker
   fence and resume normal planning.

An initial inventory with zero overlaps is valid: record the summary and
timestamp, keep the fence across return, and resume after verification.

## 5. Forward fix instead of a blind revert

If writers cannot be safely fenced, or if an attempt-bound R4 deployment
stopped at `MANUAL_REQUIRED_ATTEMPT_FENCED` after candidate persistence, prefer a
forward fix on a new candidate through normal review and deployment gates rather
than an unfenced revert. Do not run automatic SQL, do not automatically edit
customer appointments, and do not change deployment code as part of recovery.

## 6. Evidence template

Record in the deployment/incident notes (identifiers/counts/times only, never
credentials or unnecessary PII):

```text
Date/time (UTC):
Candidate SHA:
Contains released-reservation predicate: yes/no
Production CALENDAR_ENABLED:
Gate decision: normal-with-verified-fence | attempt-bound-R4 | HOLD
Ingress block verified (method + timestamp):
In-flight write paths & workers drained (method + timestamp):
Fence retained across activation/smoke/old-service restart: yes/no
Supporting timestamp snapshot (if any, supporting-only):
Pre-rollback inventory run time (UTC):
  calendar_enabled:
  released_reservations:
  overlapping_active_jobs:
  overlapping_active_manual_plans:
Reconciliation rounds (authorized operator-only app commands + decisions):
Final pre-return inventory run time (UTC) and counts (must be zero overlaps):
Optional post-check inventory run time (UTC) and counts:
Forward-fix SHA / HOLD reason (if any):
Operator:
```
