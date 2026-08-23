# Backup platform contracts — Servora-Med

```text
Date: 2026-08-23
Slice: BR7 — operator restore CLI / disaster-recovery acceptance
Status: IMPLEMENTED on an isolated Draft PR branch; exact-head review and production enablement are not authorized
Parent: architecture.md (decision register §2)
```

## 1. Data model contract (BR1)

The BR0 contract is now implemented through BR1–BR5 migrations. Types
follow repository SQL conventions: snake_case tables/columns, `UUID PRIMARY KEY DEFAULT
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
| `remote_key` | TEXT NULL | full object key, set only after streamed remote verification succeeds |
| `size_bytes` | BIGINT NULL CHECK (>= 0) | encrypted object size |
| `sha256` | TEXT NULL CHECK (64 hex) | **verified** encrypted-object checksum |
| `verified_at` | TIMESTAMPTZ NULL | set only when CLEANUP completion terminalizes an already remote-verified run as SUCCESS |
| `lease_token` | UUID NULL | opaque worker ownership token; never exposed in DTOs or logs |
| `lease_until` / `heartbeat_at` | TIMESTAMPTZ NULL | lease expiry and liveness evidence for `RUNNING` claims |
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

BR5 migration `033_backup_worker_runtime` implements the worker-claiming
columns following the `reminder-worker` lease precedent. Claims are
race-free (`FOR UPDATE SKIP LOCKED`), leases expire, and orphaned
non-CLEANUP `RUNNING` rows are terminalized as `WORKER_LOST` — never
silently completed. An expired `RUNNING@CLEANUP` row is recoverable only
when the complete remote evidence is already durable.

Indexes (BR1): active-run lookup (`status` partial where non-terminal),
history keyset (`created_at DESC`), retention queries
(`retention_class`, `created_at`).

### 1.5 `backup_worker_state` (BR5 singleton)

Migration `033_backup_worker_runtime` adds one installation-scoped row with
only operational liveness and scheduler evidence:

| Field | Meaning |
|-------|---------|
| `worker_heartbeat_at` | last worker loop/active-lease heartbeat |
| `scheduler_last_tick_at` | last scheduler evaluation tick |
| `last_scheduled_slot_key` | consumed `timezone|local-date|HH:MM` key |
| `last_scheduled_local_date` / `last_scheduled_for` | durable slot calendar/instant |
| `last_scheduled_run_id` | run created by that slot |

No credentials, filesystem paths, customer data, or process identifiers are
stored. Slot creation and slot-state advancement commit in one transaction;
an active backup/restore leaves the current-day slot eligible for a later
tick.

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

BR4 keeps credentials in env and returns configuration truth as a safe
runtime overlay: `enabled` means all required R2 fields are present,
`bucket_alias` is the optional safe display alias, and `prefix` is the
fixed canonical `production/`. The DB singleton remains the source of
truth for `last_connection_test_*`; secrets are never synchronized into
the row.

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
| `POST /api/admin/backups/:backupId/reverify` | re-run remote verification — **internal primitive delivered in BR4; HTTP endpoint remains deferred** because BR5 does not introduce a parallel queue solely for reverify | no misleading 202 without a durable reverify job |
| `GET /api/admin/backup-policy` | read schedule/retention policy | |
| `PUT /api/admin/backup-policy` | update policy | validated; audited |
| `GET /api/admin/backup-storage` | storage configuration state | safe fields only (§1.3) |
| `POST /api/admin/backup-storage/test` | storage connection test — **implemented in BR4** (ADMIN only; safe probe: list + create/abort multipart on a reserved key; updates `last_connection_test_*`; never echoes credentials) | synchronous short probe is intentional; never a backup/reverify stream |

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

Implemented in BR6 as an ADMIN-only management surface. Location follows the
pre-designated Settings expansion (see the deferred admin data-management
plan):

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

BR6 implementation notes:

- Navigation is emitted by the existing navigation-model SSOT only when the
  authenticated user is `ADMIN` and the `backup` capability (`BACKUP_ENABLED`)
  is true. Direct route and API access remain backend-protected.
- The read-only `GET /api/admin/backup-overview` projection exposes active and
  last-verified summaries, next scheduled instant, and safe worker heartbeat
  fields. Its next-schedule value is resolved by the BR5 IANA/DST scheduler
  utility; the web client does not reproduce scheduler math.
- `POST /api/admin/backups` is rendered as a `202 QUEUED` asynchronous action.
  `POST /api/admin/backups/:backupId/reverify` remains absent, so BR6 exposes
  no reverify action. Restore, deletion/pruning, credential editing, and
  production worker/monitoring cutover remain outside this slice.

## 5. Restore CLI contract (BR7)

Implemented operator CLI (`servora-backup`), preserving the role of
`ops/scripts/restore-rehearsal.sh` as a legacy operational script until a
separate cutover decision. The new path adds explicit destructive
acknowledgement, regex-validated identifiers, refusal of production
database names/hosts, and a mandatory new-target boundary.

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
  operator at restore time through an explicit identity file path or
  supported age identity environment variable; it is never stored by the
  CLI, never logged, and never written into any repository or generated
  evidence.
- `list --remote` works purely from R2 contents (DR: no metadata DB
  required); `verify`/`restore` use the R2 object custom metadata as the
  DB-independent expected-checksum source (architecture §11,
  archive-and-storage §3.1); `inspect` reads the decrypted manifest only
  after checksum and manifest validation.
- Results are recorded in `restore_runs` (when an installation DB is
  reachable) and in safe operator evidence; identifiers logged are safe
  (backup id, target database name, outcome). In explicit DR mode the source
  metadata DB is not queried. A restored runtime snapshot is observed with
  aggregate counts only; BR7 does not rewrite stale worker/lease history or
  fabricate terminal backup SUCCESS.

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
| `PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE` | PREFLIGHT | configuration | no retry — operator fix (missing/unreadable `BACKUP_FILES_ROOT`, or required tar/zstd unavailable) |
| `PREFLIGHT_WORKSPACE_CONFLICT` | PREFLIGHT | environment / recovery | no automatic retry in BR2 — fail closed; workspace exists for this run (active run, crashed run awaiting BR5 lease recovery, or failed prior cleanup); BR5 decides safe reclamation from DB run state |
| `PG_DUMP_FAILED` | DATABASE_DUMP | deterministic | fail run; no loop |
| `FILES_ARCHIVE_FAILED` | FILES_ARCHIVE | deterministic | fail run |
| `MANIFEST_FAILED` | MANIFEST | deterministic | fail run |
| `CHECKSUM_FAILED` | CHECKSUM | deterministic | fail run (checksums.sha256 materialization I/O) |
| `PACKAGE_FAILED` | PACKAGE | deterministic | fail run |
| `ENCRYPTION_FAILED` | ENCRYPT | deterministic | fail run |
| `R2_AUTH_FAILED` | UPLOAD / REMOTE_VERIFY | auth | fail; operator must correct credentials |
| `R2_UPLOAD_FAILED` | UPLOAD | transient | bounded exponential backoff, then fail run |
| `R2_DOWNLOAD_FAILED` | restore | transient | bounded exponential backoff, then fail |
| `R2_OBJECT_TOO_LARGE` | UPLOAD | deterministic / capability | fail closed before remote write; BR4 does not use race-prone multipart finalization |
| `R2_OBJECT_CONFLICT` | UPLOAD | integrity | fail closed; never overwrite, delete, or retry automatically |
| `R2_VERIFY_FAILED` | REMOTE_VERIFY | transient | same-phase bounded retry by BR5 (three attempts total) |
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
- **Internal diagnostics**: bounded stable SDK error names/status classes
  only. Raw SDK messages, endpoints, canonical requests, signed headers,
  and credentials are discarded at the adapter boundary; diagnostics are
  never returned by the API or written to audit events.
- Secrets, raw credentials, and secret-bearing subprocess command lines
  never enter user-visible fields, logs, or audit records.

### 6.3 Retry principles

Not every failure is retried blindly:

- Transient R2/network → bounded exponential backoff (same phase).
- Retryable preflight, UPLOAD, and REMOTE_VERIFY failures retain the exact
  phase/handoff; BR5 invokes the bounded same-phase retry entry points
  (`retryUploadRemoteBackup()` / `verifyRemoteBackup()`) without moving
  backward.
- Deterministic dump/manifest/package/encryption failures → fail the
  run; retrying cannot change the outcome.
- Checksum mismatches → fail closed, never retried automatically.
- Authentication failures → fail; requires operator correction.
- Ciphertext above the atomic R2 single-PUT ceiling → fail terminally with
  `R2_OBJECT_TOO_LARGE`; no automatic retry or multipart fallback.
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
(`ops/scripts/operator-alerting.mjs`) remains the **single** monitor.
Its default `SERVORA_ALERT_BACKUP_SOURCE=legacy` mode derives freshness
from local dump files + sha256 sidecars. The explicit
`SERVORA_ALERT_BACKUP_SOURCE=verified-runs` mode reads the safe aggregate
`backup` evidence surfaced by `/api/health` and reuses the same freshness,
failure threshold, cooldown, and webhook state machine. In that mode
`latestScheduledVerifiedAt` is the freshness source; a manual verified run
does not satisfy scheduled freshness. No second monitor or parallel alert
state is introduced.

## 8. Audit contract

BR5 migration `033_backup_worker_runtime` adds the worker lifecycle events
below (SCREAMING_SNAKE, CHECK-constrained) and permits only these backup
lifecycle rows to use the explicit system actor (`organization_id = NULL`,
`actor_user_id = NULL`):

```text
BACKUP_REQUESTED          BACKUP_POLICY_UPDATED
BACKUP_STARTED            BACKUP_COMPLETED
BACKUP_VERIFIED           BACKUP_FAILED
```

`BACKUP_REQUESTED` and `BACKUP_POLICY_UPDATED` remain unchanged. The
worker appends `BACKUP_STARTED`, `BACKUP_VERIFIED`, `BACKUP_COMPLETED`, and
`BACKUP_FAILED` idempotently. Storage-test and reverify audit events remain
outside this slice because no new durable system operation was introduced
for either path.

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
