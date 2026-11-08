# BR5 maintenance — PostgreSQL role fence and safe-version cutover (design + preflight)

**Scope:** review branch only. Source parent is PR #410 integrated on pinned main
`67d33183`. **Not production-qualified; no SQL role change, migration,
service restart, deployment, restore, or BR5 activation authorized.**

## What the read-only preflight proves

`ops/scripts/verify-backup-maintenance-role-fence.mjs --read-only` loads the
runtime `DATABASE_URL` (not an administrator or migrator URL) and
`BR5_MAINTENANCE_OPERATOR_ROLE`. It queries only catalog metadata and the
PAUSED singleton, and prints PASS or reason codes without a credential or
connection string. It does **not** change any database state. Do not put any
connection string on argv, paste it into logs or run this against production
without separate read-only inspection authorization.

The gate reports PASS only after these conditions are independently verified:

- Actual `session_user=current_user`; runtime is not a DB/schema owner,
  superuser, role creator, DB creator or member of the protected owner/operator.
- Dedicated protected owner is **NOLOGIN**, owns both maintenance tables,
  transition, audit and immutable-history functions; runtime cannot assume it.
- Runtime has `SELECT` on state, but no maintenance DML, no transition EXECUTE,
  and no `CREATE` authority in `public` or the database.
- Separate NOLOGIN operator group can EXECUTE the CAS transition, but cannot
  edit state/audit rows directly, inherit the protected owner, or CREATE in
  `public` or the database.
- Transition is SECURITY DEFINER with a fixed `search_path=pg_catalog`.
  Every relation/function reference inside its body and the called trigger
  function must be schema-qualified (`public....`). The original migration
  062 function is **invoker-mode and uses unqualified relations**. Merely
  toggling SECURITY DEFINER and search_path is not safe or sufficient.
- Singleton is still `paused=true` with a nonnegative revision. A RESUME is
  not an authority to permit BR5 healthy and is explicitly rejected by this
  preflight.  The independent OT3-C/D code gate remains BLOCKED.

The helper checks the effective privileges returned by PostgreSQL, not just
SQL text that happens to contain `REVOKE FROM PUBLIC`. This is a necessary
condition, not a proof that the wider application code is safe to deploy.

### F1–F4 hardening / exact function-body admission

Independent disposable PG17 testing revealed four earlier **false PASS** cases.
The follow-up code now rejects them by checking **both direct and indirect
`MEMBER`** relationships to database/schema owners, even with `INHERIT FALSE`
(which still permits `SET ROLE`); checking protected-owner `SUPERUSER`,
`CREATEROLE`, `CREATEDB`, `BYPASSRLS`, replication and NOLOGIN attributes;
checking the runtime/operator `TRUNCATE` and trigger-function EXECUTE privileges;
requiring the audit, history and transition functions to be `plpgsql`,
`SECURITY DEFINER`, and configured with **exactly**
`search_path=pg_catalog`; and verifying exactly three enabled/expected
maintenance row triggers, with no unrecognized extra user triggers.

**Function-body attestation is exact and deliberately narrow.** The preflight
SHA-256-hashes the `pg_proc.prosrc` text for *each* of the three functions and
requires three reviewed digests embedded in the committed verifier. These
correspond to the fixed, `public.`-qualified versions of migration 062's
functions reviewed in disposable PostgreSQL 17.11 evidence. Comments, whitespace,
`GRANT`, dynamic SQL, unqualified table references or any other body changes
produce **BLOCKED** rather than an attempted heuristic approval. A deliberate
function-body update therefore requires an independent source review,
real-PG negative acceptance and explicit new digest approval. This file is not
a migration or provisioning implementation.

The verifier checks the **operator group role**, not the privileges of every
individual operator-login principal; each human/machine operator account's
other memberships and administration paths must be separately examined before
release. Permission snapshots are not continuous authorization. After *every*
operator CAS, compare a fresh catalog/grant snapshot to the previously sealed
state and verify audit continuity; the PAUSED-only preflight itself will
properly return BLOCKED during RESUME and must not be misreported as a failing
CAS. No automatic post-CAS attest-and-seal workflow has been implemented.

**Known trusted-owner residual (F5):** migration 062 still has no statement
`BEFORE TRUNCATE` triggers; owner `TRUNCATE`, owner removal of any trigger and
database/schema-owner `DROP` remain outside this runtime/operator fence. A
future separately approved migration may add statement triggers, but they do
not protect against the trusted owner dropping them. Distinct migration
credentials, owner custody, R4 identity adaptation and host tests are still
release blockers. Never claim that this verifier makes audit rows immutable
against DBA/superuser/schema-owner authority.
It does not verify all third-party users, runtime process identity, HTTP
connections, NTS quality, R2, or physical 26-hour freshness.

## Current blocker, and why this is NOT an automatic migration

`server/scripts/bootstrap-app-role.mjs` creates the DB with the application
role as owner. `server/src/db/migrate.ts`, `server/src/index.ts`, the
R4 deployment controller, and installed release `run_release_node` currently
share `DATABASE_URL`. The runtime therefore has owner/DDL authority and the
preflight must report **BLOCKED** even though migration 062 has a
`REVOKE ... FROM PUBLIC`. Do not manufacture a PASS by changing expectations
or disabling the gate.

An approved separate DBA/provisioning phase needs to:

1. Snapshot the exact DB/cluster/release identity and seal the pre-change
   backup. Keep customer data in place; use a disposable PostgreSQL 17.11 DB
   for all initial testing.
2. Create dedicated roles with separate responsibilities: database/migration
   owner, protected BR5-object owner (NOLOGIN), BR5 operator group (NOLOGIN)
   and API runtime DML role. The runtime is **read-only only for the maintenance
   objects**, not for business tables. Keep passwords/secrets out of Git and argv.
3. Move DB/schema ownership away from the API runtime; explicitly remove its
   schema/database CREATE privilege, including role-membership paths.
   Preserve the least privileges needed for all existing business DML,
   scheduled workers, `pg_dump` and REST APIs.
4. Transfer the two maintenance tables and all related functions to the
   protected NOLOGIN owner. Rewrite both transition and audit trigger function
   bodies to use fully qualified relation names before securing the definer
   transition with `SET search_path=pg_catalog`. Revoke runtime and PUBLIC
   EXECUTE; grant CAS EXECUTE **only** to the isolated operator group.
   Do not grant operator UPDATE/INSERT/DELETE on the protected tables.
5. Use distinct, separately protected migration credentials. The current
   R4 deploy runner executes migrations under the API service UID and shared
   `DATABASE_URL`. Do **not** simply change that credential; it changes R4
   cluster/role identity and forward-only recovery assumptions. Adapt the
   deployment controller and re-prove release identity, rollback fencing,
   interruption/resume, backups and host contracts on disposable Ubuntu
   24.04/PostgreSQL 17.11 before enabling this mode.
6. Independently test as **real PostgreSQL roles**, not merely mocked metadata:
   - runtime SELECT allowed, transition, UPDATE, DELETE, INSERT, CREATE, ALTER,
     role SET and ownership attempts denied (including indirect membership)
   - operator CAS succeeds once, stale/same-state/invalid reason fails, append
     audit exact, direct DML and trigger bypass rejected
   - future migrations can run only with migrator authority, API remains DDL-free
   - host R4 preflight/forward recovery remain tied to the same cluster and DB

No role setup SQL is auto-applied by this slice. No migration 063 or modification
of the already validated migration 062 is introduced.

## Controlled release — required sequence

**This section is a blocked runbook, NOT an authorization to run it.**

- Preserve pinned OLD/TARGET identities, forward-only R4 receipts, production
  backups and migration intent. Prior to pause, block ingress for *every* API
  node; disable upstream cache; stop accepting health requests. Stop disabled
  BR5 workers explicitly if present; keep the accepted legacy/host-observation
  backup path intact. Never infer worker status from backup health alone.
- Drain HTTP in-flight requests **and** database sessions, prove old systemd
  instances cannot restart, and independently inventory all old binaries and
  reverse-proxy upstreams. A stopped service on one node does not prove global
  maintenance. Freeze any external scheduler/writer as directed by R4.
- Recheck the exact database identity and migration catalog **after** writer
  fencing. Only then admit 061→062 on the protected operator-approved host.
  Migration 062 seeds PAUSED/revision 0. No old API may serve while 062 is
  present; do not restart old release after forward-only migration.
- Complete role provisioning and negative tests in the quiescent environment.
  Execute the read-only role fence with actual API credentials. Require both
  explicit role-fence PASS and fresh `schema:check` COMPATIBLE; fail closed
  on missing or stale evidence. No pre-migration PASS is reusable after DDL.
- Start only the exact target API with BR5 worker and BR5 positive health still
  disabled; verify releaseSha, primary database identity, maintenance PAUSED,
  HTTP no-store, and negative BR5 health. Reopen ingress only after explicit
  owner acceptance. Observe in-flight HTTP requests with bounded probes (no
  unapproved 30-minute soak). If any check fails, remain fenced and follow
  forward-recovery; do not auto-rollback through applied migrations.
- Even if the role preflight is PASS, keep `OT3_C=BLOCKED`,
  `OT3_D=BLOCKED`, physical-time P1 OPEN and real R2 DR NOT_QUALIFIED.

## Test responsibility and release decision

This slice introduces **read-only role preflight + unit regression tests**
only. It does not claim actual DB role isolation, rollout drain, production
readiness, or security-definer correctness. Codex must test exact source/tree,
Node 22 tests, PG17 real positive/negative grants in an isolated DB, and
main/PR integration; any missing PG role proof remains a blocker.

```
SEC_API_ROLE_FENCING=BLOCKED_PENDING_REAL_PG17
SEC_OPERATOR_CAS=BLOCKED_PENDING_REAL_PG17
SEC_MIGRATION_IDENTITY=BLOCKED_PENDING_R4_ADAPTATION
SEC_MIXED_VERSION_DRAIN=BLOCKED_PENDING_HOST_ACCEPTANCE
BR5_POSITIVE_ADMISSION=BLOCKED
PR410_MERGE=NOT_AUTHORIZED
PRODUCTION_DEPLOY=NO
```
