# Backup platform contracts — Servora-Med

```text
Date: 2026-08-22
Slice: BR0 — architecture and contracts only
Status: DOCUMENTATION_ONLY / IMPLEMENTATION_NOT_AUTHORIZED
Parent: architecture.md (decision register §2)
```

## 1. Data model contract (BR1)

Contract only — **no migrations in BR0**. Types follow repository SQL
conventions: snake_case tables/columns, `UUID PRIMARY KEY DEFAULT
gen_random_uuid()`, `TIMESTAMPTZ`, enum values via CHECK constraints,
`<table>_<cols>_idx` indexes.

All backup-domain tables are **installation-scoped and carry no
`organization_id`** (architecture §3.2; precedent: `schema_migrations`).
No table stores secret material — credentials live only in operator env
files.

### 1.1 `backup_runs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | also the archive `backupId` |
| `status` | TEXT CHECK | `QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED` |
| `phase` | TEXT NULL CHECK | `PREFLIGHT`, `DATABASE_DUMP`, `FILES_ARCHIVE`, `MANIFEST`, `CHECKSUM`, `PACKAGE`, `ENCRYPT`, `UPLOAD`, `REMOTE_VERIFY`, `CLEANUP`; last attempted phase |
| `origin` | TEXT CHECK | `MANUAL`, `SCHEDULED`, `PRE_RESTORE` |
| `scope` | TEXT CHECK | `DATABASE`, `FULL_DATA` |
| `retention_class` | TEXT CHECK | `DAILY`, `WEEKLY`, `MONTHLY`, `MANUAL`, `PRE_RESTORE` |
| `created_by` | UUID NULL → `users(id)` | null for system/scheduled runs |
| `created_at` / `started_at` / `completed_at` | TIMESTAMPTZ | nullable before the corresponding point |
| `format_version` | INT NOT NULL DEFAULT 1 | |
| `app_version` | TEXT | |
| `git_commit` | TEXT | |
| `schema_version` | TEXT | latest applied migration id |
| `database_server_version` | TEXT | |
| `dump_version` | INT | |
| `remote_key` | TEXT NULL | full object key, set at upload |
| `size_bytes` | BIGINT NULL CHECK (>= 0) | encrypted object size |
| `sha256` | TEXT NULL CHECK (64 hex) | **verified** encrypted-object checksum |
| `verified_at` | TIMESTAMPTZ NULL | set only by REMOTE_VERIFY success or reverify |
| `warning_code` | TEXT NULL | non-fatal operational warning (e.g. `CLEANUP_FAILED`); see invariants below |
| `warning_summary` | TEXT NULL | admin-safe warning summary (§6.2) |
| `failure_code` | TEXT NULL | stable code from §6 taxonomy — **only ever set on `FAILED` runs** |
| `failure_summary` | TEXT NULL | admin-safe summary (§6) |

Invariant (enforced by CHECK constraint in BR1): a row is `SUCCESS`
with `failure_code IS NULL`, or `FAILED` with `failure_code IS NOT
NULL` — never `SUCCESS` with a `failure_code`. Non-fatal conditions on
successful runs (verified remote artifact exists, but operational
remediation is needed) use `warning_code` exclusively; anticipated
future warnings include `RETENTION_CLEANUP_DELAYED` and
`MONITOR_SYNC_WARNING`.

Additional worker-claiming columns (lease token, heartbeat timestamp)
are finalized in BR1 following the `reminder-worker` lease precedent;
the contract is: claims are race-free, leases expire, and orphaned
`RUNNING` rows are terminalized — never silently completed.

Indexes (BR1): active-run lookup (`status` partial where non-terminal),
history keyset (`created_at DESC`), retention queries
(`retention_class`, `created_at`).

### 1.2 `backup_policy` (singleton row)

| Column | Type | Notes |
|--------|------|-------|
| `enabled` | BOOLEAN NOT NULL | scheduler on/off |
| `schedule_time_local` | TEXT NOT NULL | `HH:MM` |
| `timezone` | TEXT NOT NULL | IANA name |
| `daily_retention` / `weekly_retention` / `monthly_retention` | INT NOT NULL | restore-point counts (defaults 7/4/6) |
| `default_scope` | TEXT NOT NULL CHECK | `DATABASE`, `FULL_DATA` |
| `updated_at` | TIMESTAMPTZ NOT NULL | |
| `updated_by` | UUID → `users(id)` | |

Singleton enforcement (fixed id or unique constraint) is a BR1 migration
decision consistent with existing conventions.

### 1.3 `backup_storage` (singleton row)

No secret material. The runtime credential is env-only; this row
describes **configuration state** for display and connection testing.

| Column | Type | Notes |
|--------|------|-------|
| `provider` | TEXT CHECK | `CLOUDFLARE_R2` (V1 single provider) |
| `bucket_alias` | TEXT | display identity only, not a secret |
| `prefix` | TEXT | |
| `enabled` | BOOLEAN NOT NULL | |
| `last_connection_test_at` | TIMESTAMPTZ NULL | |
| `last_connection_test_ok` | BOOLEAN NULL | |

### 1.4 `restore_runs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `backup_id` | UUID NULL → `backup_runs(id)` | null when restoring a bare archive without metadata (DR case) |
| `mode` | TEXT CHECK | `REHEARSAL`, `DISASTER_RECOVERY` |
| `status` | TEXT CHECK | `RUNNING`, `READY_FOR_CUTOVER`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `started_at` / `completed_at` | TIMESTAMPTZ | |
| `initiated_by` | TEXT | operator identity label (CLI context, not an app user FK) |
| `target_database` | TEXT | database **name** only — never a connection string |
| `pre_restore_backup_id` | UUID NULL → `backup_runs(id)` | mandatory before future cutover workflows |
| `verification_result` | JSONB NULL | schema/domain check evidence (§5 step 11–12) |
| `failure_code` | TEXT NULL | §6 taxonomy |

## 2. RBAC contract

| Role | V1 backup administration |
|------|--------------------------|
| `ADMIN` | backup overview/status; backup history; manual backup request; reverify request; schedule/policy management; storage connection test |
| `MANAGER` | **none** — no backup administration in V1 |
| `STAFF` | **none** |
| Restore | **no application role** performs V1 production restore — operator-controlled only (CLI) |

Backup administration is infrastructure-sensitive and is **intentionally
narrower** than normal Manager capabilities: a Manager may run the
business, but may not touch installation-level disaster-recovery state.
Enforcement follows the repository pattern — service-layer
`requireAdmin(actor)` helpers (like `people/service.ts`), never UI-only
hiding.

## 3. Admin API contract (future slices)

Not implemented in BR0. Contracts follow existing conventions: Fastify
module routes with `/api` prefixes, `AppError(code, status, Turkish
message)` responses `{ error, code, details? }`, ADMIN-only via service
layer, sensitive payload redaction via logger redact paths.

| Method & path | Purpose | Notes |
|---------------|---------|-------|
| `GET /api/admin/backups?limit&cursor` | backup history | keyset pagination (default limit, bounded max), ordered `created_at DESC` |
| `GET /api/admin/backups/:backupId` | single run detail | 404 `BACKUP_NOT_FOUND` |
| `POST /api/admin/backups` | manual backup request | body: `{ scope?, retentionClass? }`; **202** with run resource; idempotency via `clientActionId` (AGENTS.md §7); 409 conflict if an active run or restore exists |
| `POST /api/admin/backups/:backupId/reverify` | re-run remote verification | 202; idempotent per run state |
| `GET /api/admin/backup-policy` | read schedule/retention policy | |
| `PUT /api/admin/backup-policy` | update policy | validated; audited |
| `GET /api/admin/backup-storage` | storage configuration state | safe fields only (§1.3) |
| `POST /api/admin/backup-storage/test` | storage connection test | updates `last_connection_test_*`; never echoes credentials |

Rules:

- **No API exists for browser submission of R2 secret credentials** in
  V1. Storage credentials are operator-managed env configuration.
- Authorization is backend-owned (ADMIN). Errors are opaque for storage
  internals: an R2 failure surfaces as a stable failure code with an
  admin-safe summary; raw SDK errors, stack traces, credentials, or
  signed URLs are never returned or logged.
- Enqueue endpoints return immediately (async execution); progress is
  read via history/detail endpoints.

## 4. Admin UI contract (BR6)

Not implemented in BR0. Location follows the pre-designated Settings
expansion (see the deferred admin data-management plan):

```text
Settings
  → Data Management
     → Backup & Recovery
```

Backup & Recovery is its own area and is **not** merged with
"Product Data Management" (export/import) — separate domains
(architecture §3.1). Final navigation labels/paths are a BR6 decision
under the navigation-model SSOT; the boundary above is the contract.

Tabs/sections:

| Section | Contents |
|---------|----------|
| Overview | overall backup health; **last VERIFIED backup**; next scheduled backup; storage connectivity; manual **"Backup Now"** action |
| Backups | history distinguishing `Completed`, `Verified`, `Verification failed`, `Failed` (and warning states such as `CLEANUP_FAILED` on verified runs) |
| Schedule | policy editing (enabled, time, timezone, retention) |
| Storage | configuration state and connection test |

Rules:

- Storage UI must **not display recoverable secret values**. Use
  `Configured` / `Not configured` status (per §1.3 state), never masked
  secrets.
- There is **no Restore button** anywhere in normal application UI
  (decision 30). Restore is operator CLI only.
- UI state reflects backend truth via the API; no invented business
  rules. Feature availability follows the capability-flag pattern (e.g.
  `BACKUP_ENABLED`) wired through the navigation model.
- Loading/success/error states are mandatory for every action
  (AGENTS.md §8).

## 5. Restore CLI contract (BR7)

Future operator CLI (`servora-backup`), replacing the role of
`ops/scripts/restore-rehearsal.sh` with equivalent fail-closed guards
(explicit destructive-acceptance flag, regex-validated identifiers,
refusal of production database names/hosts).

```text
servora-backup list --remote
servora-backup inspect <archive-or-id>
servora-backup verify <archive-or-id>
servora-backup restore <archive-or-id> --target-db <new-db>
```

Restore executes the 13-step flow (architecture §13.2):

```text
 1. acquire restore/backup exclusion lock
 2. download backup
 3. verify encrypted-object SHA-256 against R2 object custom metadata
    (and `backup_runs` when available — DR works without it)
 4. decrypt (operator-held age private identity)
 5. validate manifest
 6. reject unsupported format versions (fail closed)
 7. validate internal component checksums
 8. inspect PostgreSQL dump
 9. create/use a separate restore target database
10. pg_restore into target
11. schema checks
12. domain integrity checks
13. report READY_FOR_CUTOVER
```

- The CLI **never automatically overwrites the current production
  database**; cutover is a separate controlled operation.
- Decryption key handling: the private identity is supplied by the
  operator at restore time (path/passphrase prompt); it is never stored
  by the CLI, never logged, and never written into any repository or
  host file beyond its operator-managed source.
- `list --remote` works purely from R2 contents (DR: no metadata DB
  required); `verify`/`restore` use the R2 object custom metadata as the
  DB-independent expected-checksum source (architecture §11,
  archive-and-storage §3.1); `inspect` reads the decrypted manifest only
  after checksum and manifest validation.
- Results are recorded in `restore_runs` (when an installation DB is
  reachable) and in the operator ops log; identifiers logged are safe
  (backup id, target database name, outcome).

## 6. Failure taxonomy and retry contract

### 6.1 Stable failure codes

Codes are SCREAMING_SNAKE_CASE, aligned with `AppError` conventions, and
are the **only** machine-readable failure surface. BR1+ must keep this
list authoritative and extend it only additively.

| Code | Phase | Category | Retry policy |
|------|-------|----------|--------------|
| `PREFLIGHT_DATABASE_UNAVAILABLE` | PREFLIGHT | environment | bounded retry, then fail run |
| `PREFLIGHT_PG_DUMP_UNAVAILABLE` | PREFLIGHT | configuration | no retry — operator fix |
| `PREFLIGHT_LOW_DISK` | PREFLIGHT | environment | bounded retry (space may free), then fail run |
| `PREFLIGHT_STORAGE_UNAVAILABLE` | PREFLIGHT | environment | bounded retry, then fail run |
| `PG_DUMP_FAILED` | DATABASE_DUMP | deterministic | fail run; no loop |
| `FILES_ARCHIVE_FAILED` | FILES_ARCHIVE | deterministic | fail run |
| `MANIFEST_FAILED` | MANIFEST | deterministic | fail run |
| `PACKAGE_FAILED` | PACKAGE | deterministic | fail run |
| `ENCRYPTION_FAILED` | ENCRYPT | deterministic | fail run |
| `R2_AUTH_FAILED` | UPLOAD / REMOTE_VERIFY | auth | fail; operator must correct credentials |
| `R2_UPLOAD_FAILED` | UPLOAD | transient | bounded exponential backoff, then fail run |
| `R2_DOWNLOAD_FAILED` | restore | transient | bounded exponential backoff, then fail |
| `REMOTE_CHECKSUM_MISMATCH` | REMOTE_VERIFY | integrity | **fail closed** — no retry; object is not a restore point |
| `WORKER_LOST` | crash recovery | infrastructure | orphaned RUNNING run terminalized as FAILED |
| `RESTORE_MANIFEST_INVALID` | restore | integrity | fail closed |
| `RESTORE_FORMAT_UNSUPPORTED` | restore | compatibility | fail closed |
| `RESTORE_CHECKSUM_FAILED` | restore | integrity | fail closed |
| `RESTORE_DATABASE_CREATE_FAILED` | restore | environment | fail; operator reviews target |
| `RESTORE_PG_RESTORE_FAILED` | restore | deterministic | fail closed |
| `RESTORE_INTEGRITY_FAILED` | restore | integrity | fail closed — no READY_FOR_CUTOVER |

### 6.1.1 Warning codes (non-fatal, `warning_code` — never `failure_code`)

A `SUCCESS` run always has `failure_code IS NULL`. Non-fatal operational
conditions are recorded as warnings without downgrading the verified
restore point:

| Warning code | Meaning | Remediation |
|--------------|---------|-------------|
| `CLEANUP_FAILED` | remote artifact verified; local temp workspace cleanup failed | next preflight reclaims the stale workspace (architecture §12) |
| `RETENTION_CLEANUP_DELAYED` (future) | logical retention pruning pending | monitored; not urgent |
| `MONITOR_SYNC_WARNING` (future) | monitoring reconciliation lag | monitored |

Future non-fatal conditions extend this table additively; they never
move into `failure_code`.

### 6.2 User-safe summary vs internal diagnostics

- **Admin/user-safe summary** (`failure_summary`, UI, Turkish): one
  sentence, no internals — e.g. "Uzaktan doğrulama başarısız oldu;
  yedek doğrulanmış olarak işaretlenmedi."
- **Internal diagnostics** (server logs only): SDK errors, endpoints,
  object keys. Never returned by the API and never written to audit
  events.
- Secrets, raw credentials, and secret-bearing subprocess command lines
  never enter user-visible fields, logs, or audit records.

### 6.3 Retry principles

Not every failure is retried blindly:

- Transient R2/network → bounded exponential backoff (same phase).
- Deterministic dump/manifest/package/encryption failures → fail the
  run; retrying cannot change the outcome.
- Checksum mismatches → fail closed, never retried automatically.
- Authentication failures → fail; requires operator correction.
- Cleanup failure after successful remote verification → represented
  explicitly as `warning_code = CLEANUP_FAILED` on the `SUCCESS` run
  (`failure_code` stays null); the evidence that a **verified remote
  artifact exists** is never lost or downgraded.

## 7. Monitoring / health contract

Backup health is derived **primarily from VERIFIED backups** (`SUCCESS`
runs with `verified_at`), not from mere upload existence.

| State | Meaning |
|-------|---------|
| `HEALTHY` | last verified scheduled backup within the expected window |
| `DEGRADED` | backup exists but a verification/storage issue exists, or the current run is delayed but still within the critical window |
| `CRITICAL` | no verified backup beyond threshold; scheduled backup failed; remote verification failed; worker/scheduler not functioning |

Integration with existing monitoring: the operator alerting monitor
(`ops/scripts/operator-alerting.mjs`) currently derives backup
freshness from local dump files + sha256 sidecars. BR5 **reconciles**
it with the `backup_runs` source of truth (e.g. an ops-visible health
endpoint reporting last verified backup) rather than creating a second,
unrelated monitoring model. BR0 changes no monitoring code; until BR5
the existing checks stay authoritative.

## 8. Audit contract

Future audit events (SCREAMING_SNAKE, appended to `audit_events`
following its conventions — CHECK-constrained enums extended by the BR1
migration):

```text
BACKUP_REQUESTED          BACKUP_POLICY_UPDATED
BACKUP_STARTED            BACKUP_STORAGE_TESTED
BACKUP_COMPLETED
BACKUP_VERIFIED
BACKUP_FAILED
BACKUP_REVERIFY_REQUESTED
```

Safe metadata: backup id, scope, origin, retention class, failure code,
actor user id, timestamps. Restore lifecycle evidence (`RESTORE_*`) is
produced in operator CLI context, not application context: it is
recorded in `restore_runs` plus the operator ops log; it is appended to
`audit_events` only when an application-managed restore path exists
(none in V1).

Never audited (or logged):

- credentials of any kind
- private encryption identities or passphrases
- raw secret-bearing subprocess command lines
- decrypted backup content
