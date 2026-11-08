# BR5 — Installation-wide maintenance admission (Path A slice)

**Status:** implemented on Draft PR #410 for Codex tests, **not qualified,
merged, migrated, deployed, or activated**.

## Scope and authority

Migration 062 adds a database singleton, an append-only revisioned transition
ledger, and an explicitly invoked compare-and-swap operator transition function.
The default state is **PAUSED** at revision zero. It is deliberately not
derived from BACKUP_WORKER_ENABLED, scheduler policy or previously verified
backups. Every API reader consults the same primary PostgreSQL row for a
prospective `healthy` result, with no cache, on every check.

`maintenanceAllowsPositiveBackupHealth(pool)` denies on PAUSED, missing table,
missing state, non-boolean paused, malformed revision or query failure. Resume
(`paused=false`) removes only this additional veto. **The existing source-owned
OT3-C/OT3-D gate still returns BLOCKED and cannot be bypassed.**

Neither worker execution nor manual restore is halted by the maintenance flag;
this is solely **positive BR5 health admission**. `failed` and definitely
`stale` classifications, safe historical projections, and remote integrity
SUCCESS are preserved. The public response exposes no operator, reason, ticket
or raw time/evidence details.

## Operator transition contract — DO NOT execute against production

Run only on a separately authorized disposable PG17 instance. Example:

```sql
-- Read first; use observed revision as the CAS precondition:
SELECT paused, revision, reason_code, changed_at
  FROM backup_health_maintenance_state WHERE singleton;

-- Example start of maintenance from revision 1:
SELECT backup_health_maintenance_transition(
  1, TRUE, 'operator', 'approved-ticket', 'SCHEDULED_MAINTENANCE');

-- Example operator release after external validation from revision 2:
SELECT backup_health_maintenance_transition(
  2, FALSE, 'operator', 'approved-ticket', 'POST_MAINTENANCE_CHECK');

SELECT revision, paused, reason_code, operator_label, ticket_ref
  FROM backup_health_maintenance_events ORDER BY revision;
```

The initial seeded PAUSED state must not be cleared in production without
separate owner approval and verified operational time/host evidence. Operator
action is not a source of new generation freshness, time synchronization,
producer provenance or restore proof.

All transitions are mutually exclusive and revision-bound. Same-state,
stale-revision or missing arguments abort. The database trigger inserts exactly
one event per successful transition, including direct SQL UPDATE by a trusted
DB owner; historical event UPDATE/DELETE is rejected. SQL superuser/DB owner,
database schema replacement and direct DDL remain inside the trusted boundary.
Provision a distinct operator DB role and read-only API role before any
production release; this migration intentionally does **not** create
credentials or change production grants. In existing single-owner development
setups, the application role may also be the schema owner, so role fencing is
**not yet production-qualified**.

## Multi-instance and race semantics

Each API instance must read the **same primary database**. Requests whose
admission query begins after a committed PAUSE see PAUSED and return
unavailable. In-flight requests that read before commit can still complete:
operators must drain in-flight health requests and disable upstream caching
after PAUSE, before making a strict all-node maintenance assertion.
`Cache-Control: no-store` remains required. Read replicas with lag are not
authorized for this gate. There is no in-process cached permit.

A maintenance RESUME does not automatically make `healthy` possible. The
source-owned `evaluateBr5PositiveHealthAdmission()` remains `BLOCKED` and
other evidence, liveness, 26h freshness, failure priority and rollback veto
remain in place. No operator command is executed automatically.

## Compatibility

New migration `062_backup_health_maintenance.sql` is additive to migration
061. Existing data, scheduled identities, immutable artifact before, R2 keys,
audit event vocabulary, TT-A/TT-B, public API schema, backup/restore worker and
26-hour limit are untouched. Old binaries that ignore this row must **never**
be allowed to serve BR5 positive health during mixed-version rollout. This
draft remains DRAFT/HOLD until full Linux CI, exact-SHA host proof,
060→060 continuity, 061/062 release plan and separate owner acceptance.

The Path A operational acceptance matrix is **not automatically PASS**. Silent
clocksource faults, interior step-and-reverse-step and OT3 producer
authenticity remain explicitly unresolved.
