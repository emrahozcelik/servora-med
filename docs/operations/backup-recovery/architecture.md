# Backup & Recovery V1 architecture — Servora-Med

```text
Date: 2026-08-22
Slice: BR0 — architecture and contracts only
Status: DOCUMENTATION_ONLY / IMPLEMENTATION_NOT_AUTHORIZED
Decision record: DECISIONS.md → OPS-002
```

## 1. Purpose

Turn the approved Servora Backup & Recovery architecture into
repository-owned, implementation-ready contracts for slices BR1–BR7.

The primary success criterion is **not** "a backup file was created". It
is:

> An encrypted Cloudflare R2 backup can be restored into a clean
> PostgreSQL target, and Servora can operate against the restored data.

Restore proof is mandatory (section 14).

## 2. Approved decision register

All decisions below are approved product decisions. Slices BR1–BR7 must
not reopen them; conflicts found during implementation must be raised,
not silently resolved. "Backuply" was used as a UX/product-model
reference only; no WordPress/Backuply implementation architecture is
carried over.

| # | Decision | Where specified |
|---|----------|-----------------|
| 1 | Backuply is UX reference only; no WordPress architecture | §3 |
| 2 | Backup/Restore (disaster recovery) and Export/Import (data portability) are separate domains | §3 |
| 3 | Backup is installation-level infrastructure state, not an organization-owned domain resource | §3, platform-contracts §1 |
| 4 | V1 primary remote destination: Cloudflare R2 | archive-and-storage §5–§6 |
| 5 | V1 backup = PostgreSQL dump + explicitly configured persistent Servora files | §5, archive-and-storage §1 |
| 6 | V1 backup excludes source, `.git`, `node_modules`, build artifacts, secrets, `.env`, R2 credentials, SMTP/push/session secrets, unrelated VPS content | §5 |
| 7 | PostgreSQL V1 mechanism: logical backup via `pg_dump` custom format | archive-and-storage §1 |
| 8 | Archive is self-describing; recoverable even if backup metadata tables are lost | §13, archive-and-storage §2 |
| 9 | Archive format versioning starts at `formatVersion = 1` | archive-and-storage §1–§2 |
| 10 | Backup is encrypted before remote upload | §10 |
| 11 | Custom cryptography is prohibited; approved direction is age/X25519 public-key encryption | §10 |
| 12 | Production server needs only the encryption public recipient | §10 |
| 13 | Private decryption identity must not be required for backup creation and must not live permanently on the production VPS | §10 |
| 14 | Remote storage credential follows least privilege (backup bucket/prefix runtime access only) | archive-and-storage §6 |
| 15 | Servora runtime must not hold Cloudflare permission to modify Bucket Lock, lifecycle, or account-wide R2 config | archive-and-storage §6 |
| 16 | Bucket Lock and lifecycle are operator/infrastructure-managed controls | archive-and-storage §6 |
| 17 | Cloudflare R2 Bucket Lock is NOT AWS S3 Object Lock API compatibility; treat it as Cloudflare infrastructure configuration | archive-and-storage §6, §7 |
| 18 | Backup creation is asynchronous; never inside an HTTP request lifetime | §9 |
| 19 | V1 direction: separate backup worker process backed by PostgreSQL job state | §9 |
| 20 | No Redis/BullMQ for BR V1; PostgreSQL-backed job claiming/locking is the baseline | §9 |
| 21 | Maximum 1 active backup per installation | §9 |
| 22 | Backup and restore operations are mutually exclusive | §9 |
| 23 | Upload success alone is not backup success | §11 |
| 24 | Success requires remote integrity verification | §11 |
| 25 | Do not rely on R2/S3 ETag as canonical integrity checksum | §11, archive-and-storage §7 |
| 26 | Canonical encrypted-object integrity: SHA-256 of the encrypted object with remote stream verification | §11 |
| 27 | Local temporary artifacts are deleted after successful remote verification | §12 |
| 28 | Crash/stale temporary workspace recovery is designed explicitly | §12 |
| 29 | V1 restore is operator-controlled | §13 |
| 30 | No one-click production restore from normal Servora web UI in V1 | §13, platform-contracts §4 |
| 31 | Restore first targets a NEW/separate PostgreSQL database | §13 |
| 32 | Existing production DB is never overwritten as the first restore action | §13 |
| 33 | Restore flow: download → checksum → decrypt → manifest → component checksums → restore into new DB → verify → `READY_FOR_CUTOVER` | §13 |
| 34 | Production cutover remains a separate controlled operation | §13 |
| 35 | A pre-restore safety backup is mandatory before any future automated/in-place cutover | §13 |
| 36 | Success criterion: clean-target restore with Servora operating on restored data | §1, §14 |

## 3. Domain boundaries

### 3.1 Backup/Restore vs Export/Import

```text
BACKUP / RESTORE                    EXPORT / IMPORT
= disaster recovery                 = business data portability
= installation-level                = organization-level product data
= encrypted infra archives          = customer-visible documents/data
= operator/administrative           = product feature
(BR program, this directory)        (deferred admin data-management plan)
```

These two domains must not share models, APIs, or UI concepts. A backup
archive is not an export file; an import is not a restore.

### 3.2 Installation-level, not organization-owned

A Servora installation is one deployed stack (VPS/pilot host + one
PostgreSQL database, possibly containing multiple organizations — the
database is organization-scoped at the domain layer). A backup covers the
whole installation database. Therefore:

- Backup metadata tables are **installation-scoped** and carry **no
  `organization_id`** (a justified, documented exception to the domain
  table convention; precedent: `schema_migrations`).
- Backup administration is **not** an organization capability. It is an
  infrastructure administration capability restricted to `ADMIN` and,
  even then, narrower than normal Manager powers (platform-contracts §2).

## 4. System context

```text
                     ┌────────────────────────────────────────────┐
                     │                 Operator                   │
                     │  holds: R2 console access, Bucket Lock /   │
                     │  lifecycle config, age private identity    │
                     └───────┬───────────────────────┬────────────┘
                             │ config / observe      │ restore CLI (BR7)
                             ▼                       ▼
┌────────────────────────────────────────┐   ┌──────────────────────────┐
│ Servora API (Fastify)                  │   │ servora-backup CLI       │
│  backup admin module (BR1/BR5/BR6)     │   │  list/inspect/verify/    │
│  audit events, RBAC                    │   │  restore → NEW target DB │
└───────────────┬────────────────────────┘   └────────────┬─────────────┘
                │ job rows (PostgreSQL)                    │
                ▼                                          │
┌────────────────────────────────────────┐                │
│ Backup worker (separate process, BR5)  │                │
│  claim → preflight → pg_dump →         │                │
│  manifest → checksums → package →      │                │
│  encrypt (age public recipient) →      │                │
│  upload → REMOTE VERIFY → cleanup      │                │
└───────┬───────────────────┬────────────┘                │
        │                   │                             │
        ▼                   ▼                             ▼
┌──────────────┐    ┌──────────────┐          ┌─────────────────────┐
│ PostgreSQL   │    │ temp workspace│         │ Cloudflare R2       │
│ (source DB + │    │ (local disk,  │          │ dedicated bucket    │
│ job state)   │    │ deleted after │          │ production/<inst>/  │
│              │    │ verification) │          │ v1/…/<id>.sbk.age   │
└──────────────┘    └──────────────┘          └─────────────────────┘
```

Key custody facts shown above: the production server holds **only** the
age public recipient and a least-privilege R2 token; the private
decryption identity and Cloudflare administrative access stay with the
operator.

## 5. V1 scope

### In V1

| Capability | Notes |
|------------|-------|
| Manual backup request | admin-triggered, async |
| Scheduled backups | worker scheduler (BR5) |
| PostgreSQL logical backup | `pg_dump` custom format |
| Persistent Servora files when configured | no such files exist today; contract supports them |
| Self-describing manifest | section 8, archive-and-storage §2 |
| Archive format v1 | `formatVersion = 1` |
| Encryption | age/X25519 direction (section 10) |
| SHA-256 integrity | encrypted-object canonical (section 11) |
| Cloudflare R2 storage | dedicated bucket/prefix |
| Remote verification | stream re-read after upload |
| Backup history | `backup_runs` |
| Retention classification | 5 retention classes (section 6) |
| Bucket Lock / lifecycle infrastructure contract | operator-managed (archive-and-storage §6) |
| Audit events | platform-contracts §7 |
| Monitoring / failure alerting contract | platform-contracts §6 |
| Admin backup management UI contract | platform-contracts §4 (BR6) |
| Operator restore CLI contract | platform-contracts §5 (BR7) |
| Full recovery acceptance test | section 14 |

### Out of V1

- Web one-click restore; automatic production cutover
- Migration wizard, clone-to-staging, arbitrary server migration wizard
- Incremental backup
- Organization-only restore; record/table-level restore
- Customer/product Excel import/export (that is Export/Import, not backup)
- SFTP/B2/S3/MinIO storage implementations; multiple storage destinations
- Generic cron editor
- Storing the decryption private key in normal production runtime

## 6. Terminology

Five distinct axes; never conflate them in models, APIs, or UI.

| Axis | Values | Meaning |
|------|--------|---------|
| Scope | `DATABASE`, `FULL_DATA` | what the archive contains |
| Origin | `MANUAL`, `SCHEDULED`, `PRE_RESTORE` | why the run started |
| Retention class | `DAILY`, `WEEKLY`, `MONTHLY`, `MANUAL`, `PRE_RESTORE` | restore-point policy bucket (section 9 / archive-and-storage §4) |
| Status | `QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED` | high-level run outcome |
| Phase | `PREFLIGHT` … `CLEANUP` | execution step inside `RUNNING` (section 7) |

## 7. Job state machine

### 7.1 Status × phase

Status is the authoritative lifecycle; phase is the execution progress of
a `RUNNING` run and is informational for `QUEUED` (null) and terminal
states (last attempted phase).

### 7.2 Allowed transitions

```text
QUEUED ──claim──► RUNNING ──► SUCCESS
   │                 │
   │                 ├──► FAILED
   │                 └──► CANCELLED (cooperative cancel between phases)
   └───cancel before start──► CANCELLED

RUNNING phases (linear, no backward transitions):
PREFLIGHT → DATABASE_DUMP → FILES_ARCHIVE* → MANIFEST → CHECKSUM →
PACKAGE → ENCRYPT → UPLOAD → REMOTE_VERIFY → CLEANUP

* FILES_ARCHIVE only for scope FULL_DATA when persistent files are
  configured; otherwise skipped.
```

Rules:

- Phase retry (e.g. bounded upload retry) re-enters the **same** phase;
  it never moves backward or skips forward.
- Terminal states: `SUCCESS`, `FAILED`, `CANCELLED`. Terminal rows are
  immutable except `verified_at` updates from an explicit reverify
  request.
- Invalid transitions (e.g. `SUCCESS → RUNNING`, `CANCELLED → FAILED`)
  are rejected by the service layer and logged.
- Only `REMOTE_VERIFY` success may set `sha256`/`verified_at` and mark
  the run a usable restore point. Nothing else may produce `SUCCESS`.

### 7.3 Interruption semantics

| Event | Required behavior |
|-------|-------------------|
| Worker process crashes mid-run | Job state lives in PostgreSQL, not memory. Lease/heartbeat expiry (worker-crash detection following the `reminder-worker` lease precedent) lets the next worker pass mark the orphaned `RUNNING` row `FAILED` with `WORKER_LOST` plus the interrupted phase. Never silently `SUCCESS`. |
| Process receives termination (`SIGTERM`/`SIGINT`) | Cooperative cancel: finish the current atomic step, mark `CANCELLED`, best-effort temp cleanup within the graceful-shutdown window (`server/src/shutdown.ts` pattern). If the worker dies before writing, crash handling above applies. |
| API process restarts | No effect on run state. UI reads job state from PostgreSQL and reconciles; no in-memory backup state exists. |
| Upload temporarily fails | Bounded retry with backoff inside `UPLOAD` (section 11, platform-contracts §6). Exhaustion → `FAILED` / `R2_UPLOAD_FAILED`. |
| Remote verification fails | `FAILED` / `REMOTE_CHECKSUM_MISMATCH`, fail-closed. The uploaded object is **not** a restore point and must not be presented as verified. |
| Cleanup fails after remote verification | The remote artifact is verified and intact — do not lose that evidence. Run terminal state is `SUCCESS` with the explicit `cleanup_warning` flag set (platform-contracts §1) and `CLEANUP_FAILED` recorded; stale workspace reclamation is retried by the next preflight (section 12). |

Ambiguous states are never normalized into `SUCCESS`; they become `FAILED`
with a stable code.

## 8. Preflight contract

Executed as the first phase of every run (and conceptually before any
storage connection test).

| Check | Hard failure (fail run) | Retryable |
|-------|------------------------|-----------|
| Database connectivity | `PREFLIGHT_DATABASE_UNAVAILABLE` | retry with backoff before failing |
| `pg_dump` binary available | `PREFLIGHT_PG_DUMP_UNAVAILABLE` | no — requires operator fix |
| `pg_dump`/server version compatibility | `PREFLIGHT_PG_DUMP_UNAVAILABLE` | no |
| Temp directory writable | `PREFLIGHT_LOW_DISK` (I/O error) | no |
| Sufficient temp disk headroom | `PREFLIGHT_LOW_DISK` | yes — may pass on retry after space frees |
| Encryption public recipient configured | `ENCRYPTION_FAILED` pre-classified as preflight hard failure | no |
| R2/storage configuration available | `PREFLIGHT_STORAGE_UNAVAILABLE` | retry with backoff before failing |
| No conflicting active backup (max 1) | request rejected as conflict before queueing | n/a |
| No restore active (mutual exclusion) | request rejected as conflict before queueing | n/a |

Hard failures keep the run `FAILED` with the given code; retryable checks
use a bounded in-phase retry before the run fails. No preflight failure
ever produces side effects (no partial dumps, no uploads).

## 9. Execution model

- **Asynchronous by design**: an HTTP request only validates and enqueues
  a `backup_runs` row; it never executes backup work (decision 18).
- **Separate worker process** (BR5) claims and executes runs. The worker
  may live beside the API (same release tree, own entrypoint) but is a
  distinct process with its own lifecycle and shutdown handling.
- **PostgreSQL is the job state store**: claiming, locking, progress, and
  history all live in `backup_runs`. Baseline claiming/locking uses
  PostgreSQL row claims with lease/heartbeat, following the existing
  in-repo precedent (`calendar/reminder-worker.ts`: `FOR UPDATE SKIP
  LOCKED` + lease tokens). No Redis/BullMQ in V1 (decision 20).
- **Mutual exclusion** (decisions 21–22):
  - At most one active backup per installation, enforced by an active-run
    check plus a PostgreSQL advisory lock as the race-free guard
    (precedent: `MIGRATION_ADVISORY_LOCK_KEY`).
  - Backup and restore are mutually exclusive across processes: the
    restore CLI acquires the same exclusion lock family before any
    download (platform-contracts §5, step 1). Exact lock keys are fixed
    in BR1; the contract is that API worker and CLI share one locking
    namespace owned by the backup domain.
- **Scheduling** (BR5): the worker evaluates `backup_policy` (time-of-day
  + timezone) and enqueues `SCHEDULED` runs. The existing systemd/launchd
  timer remains the MVP mechanism until BR5 is enabled (section 15).

## 10. Encryption and key custody

- Backups are encrypted **before** any remote upload (decision 10).
- **No custom cryptography.** Approved direction: age/X25519-style
  public-key encryption (decision 11). BR3 validates the concrete
  implementation choice (maintained Node age library vs. spawning the
  `age` binary) against repository dependency rules; no blocker is known
  at the contract level.
- Key model (decisions 12–13):

```text
Production VPS holds:   age PUBLIC recipient (env, e.g. BACKUP_ENCRYPTION_RECIPIENT)
                        least-privilege R2 token
Operator holds:         age PRIVATE identity — offline / password manager /
                        separate secure storage; NEVER permanently on the VPS
```

- A backup can always be created without the private key; decryption is
  only needed for restore/rehearsal, which are operator-controlled.
- The encrypted artifact name carries the `.age` suffix
  (`<backup-id>.sbk.age`).
- Secret material never enters manifests, job metadata, audit events, UI,
  or logs (platform-contracts §7, §8).

## 11. Integrity model

- **Upload success alone is not backup success** (decision 23). A run
  becomes `SUCCESS` only after remote verification (decision 24).
- Canonical integrity is **SHA-256 of the encrypted object** (decision
  26): after upload, the worker re-reads the remote object as a stream,
  hashes it, and compares against the locally hashed ciphertext. Only
  this verified value is stored in `backup_runs.sha256` and
  `verified_at`.
- **ETag is not the canonical checksum** (decision 25). Verified
  Cloudflare fact: R2 multipart ETags are a hash of part-MD5s, not the
  content MD5 of the object (archive-and-storage §7). ETags may be logged
  as diagnostics only.
- Component-level checksums (inside the encrypted archive) protect the
  decrypted payload: `checksums.sha256` covers `database.dump` and
  `files.tar.zst` (archive-and-storage §1).
- Reverify (admin request, BR slices) repeats the remote stream check
  against the stored `sha256`.

## 12. Temporary workspace lifecycle

- Each run gets an exclusive temp workspace under a dedicated backup temp
  root (path from configuration; never inside the repo or web roots).
- Workspace is **deleted after successful remote verification**
  (decision 27) — never before `REMOTE_VERIFY` passes.
- Crash/stale workspace recovery (decision 28) is explicit:
  - Workspaces are named by run id, so stale ones are attributable.
  - `PREFLIGHT` of the next run reclaims workspaces of runs that are
    terminal (`FAILED`/`CANCELLED`/`SUCCESS`) — including `SUCCESS` runs
    whose cleanup failed (`cleanup_warning`).
  - Workspaces of non-terminal runs are never touched; the crash
    recovery in section 7.3 first terminalizes the run.
- Temp artifacts use restrictive permissions (`umask 077` precedent in
  `ops/scripts/backup-postgres.sh`).

## 13. Restore and disaster recovery contract

### 13.1 V1 restore posture

- Restore is **operator-controlled** via the `servora-backup` CLI
  (decision 29; contract in platform-contracts §5). No application role
  performs production restore.
- There is **no restore button** in the normal web UI (decision 30).
- Restore always targets a **new/separate PostgreSQL database** first
  (decision 31); the existing production database is never overwritten as
  the first restore action (decision 32).

### 13.2 Restore flow

```text
1. acquire backup/restore exclusion lock
2. download <backup-id>.sbk.age from R2
3. verify encrypted-object SHA-256 against backup_runs / manifest record
4. decrypt with operator-held age private identity
5. validate manifest (format, formatVersion ≤ supported)
6. reject unsupported format versions (fail closed)
7. validate component checksums (checksums.sha256)
8. inspect PostgreSQL dump metadata
9. create/use a separate restore target database (never the production name)
10. pg_restore into target
11. schema checks (schema_migrations non-empty, core relations present —
    restore-rehearsal.sh precedent)
12. domain integrity checks (representative invariants)
13. report READY_FOR_CUTOVER
```

`READY_FOR_CUTOVER` means "restored target validated and ready for a
separate cutover decision" — nothing more (decision 34). Production
cutover remains a distinct, explicitly controlled operation outside V1
automation. Before any future automated/in-place cutover workflow, a
**pre-restore safety backup** (`PRE_RESTORE` origin) is mandatory
(decision 35).

### 13.3 Disaster recovery inputs

The architecture must support losing the VPS, the production DB, the
backup metadata tables, and the normal Servora runtime. Recovery inputs
are limited to:

```text
- Servora source / deployment artifact
- required operator-managed application secrets
- R2 backup archive(s)
- decryption private identity
- PostgreSQL environment (new instance)
```

Because the archive is self-describing (manifest + checksums inside the
encrypted payload), the `backup_runs` table is **not** required to
understand or restore a valid archive (decision 8): the CLI can
`list --remote`, download, decrypt, and inspect purely from R2 contents.

## 14. Acceptance contract (final BR7 gate)

Backup & Recovery V1 is complete only when the end-to-end acceptance test
passes with **synthetic data only**:

```text
 1. create a disposable/synthetic Servora PostgreSQL database
 2. populate representative synthetic domain data
 3. create backup
 4. upload encrypted backup to R2-compatible test target / approved infra
 5. verify remote encrypted checksum
 6. stop using the source DB
 7. create a clean target PostgreSQL database
 8. retrieve the backup
 9. decrypt
10. validate manifest/checksums
11. pg_restore
12. start Servora against restored target
13. API health passes
14. representative domain data matches expected values
15. authentication works where relevant
16. critical domain invariants pass
```

Backup creation alone does not satisfy V1. Restore proof is mandatory.

## 15. Reconciliation with the current MVP backup stack

BR0 changes documentation only. Until the replacing slices merge and are
enabled, the current stack stays the operating contract
([../backup-restore.md](../backup-restore.md)):

| Current mechanism | V1 direction | Transition |
|-------------------|--------------|------------|
| `ops/scripts/backup-postgres.sh` + systemd/launchd daily timer (02:30 UTC) | worker executes runs from `backup_runs` | script stack remains active until BR5 worker is enabled; then the timer is retired by the operator |
| `OFFSITE_COPY_HOOK` offsite copy | native R2 upload + remote verify (BR4) | hook path superseded once R2 destination is verified |
| `ops/scripts/restore-rehearsal.sh` | `servora-backup` restore CLI (BR7) | rehearsal script remains until CLI delivers equivalent guards; its fail-closed conventions carry over |
| operator-alerting backup freshness check (dump age + sidecar sha256) | health derived from **verified** `backup_runs` (platform-contracts §6) | BR5 reconciles the monitor to the new source of truth; no second monitoring model is created; monitor code is not rewritten in BR0 |
| "No `backup_status` table / no in-app backup UI" product boundary | V1 backup admin domain + BR6 admin UI | boundary remains in force until BR1/BR6 merge; superseded for post-MVP V1 by `OPS-002` |

Known conflicts found during BR0 repository research, and their
reconciliations:

1. **Multi-tenant `organization_id` convention vs installation-level
   backup tables.** Resolved by documented exception: backup/restore
   metadata tables are installation-scoped without `organization_id`
   (§3.2), because they describe infrastructure state of the whole
   installation and must remain meaningful in disaster scenarios
   involving organization data.
2. **RPO/RTO targets.** The MVP targets (RPO 24h, RTO 4h) remain the V1
   targets; V1's verified offsite copy improves the evidence quality
   behind them but does not change the numbers.
3. **Cloudflare assumption corrections** (verified against official
   documentation on 2026-08-22, see archive-and-storage §7): R2
   lifecycle **is** manageable via the S3 API, but the least-privilege
   runtime token (object-level only) cannot use it — so "lifecycle is
   operator-managed" (decision 16) holds regardless. Bucket Lock is
   Cloudflare-native configuration, never S3 Object Lock API
   (decision 17).

## 16. BR1–BR7 roadmap

| Slice | Scope | Key contents |
|-------|-------|--------------|
| BR0 | Architecture + contracts | this directory (docs only) |
| BR1 | Backup domain foundation | DB migration/model (`backup_runs`, `backup_policy`, `backup_storage`, `restore_runs`), repository/service, RBAC, audit foundations |
| BR2 | Local PostgreSQL backup engine | temp workspace, `pg_dump`, manifest, component checksums, archive packaging, cleanup |
| BR3 | Encryption | encrypted archive, ciphertext SHA-256, age key-handling contract implementation (library/binary decision) |
| BR4 | Cloudflare R2 | storage adapter, upload, remote verification, connection test, retention/storage integration |
| BR5 | Backup worker | PostgreSQL-backed job claiming, locking, scheduler, retry, failure recovery, monitoring reconciliation |
| BR6 | Admin backup UI | Overview, History, Schedule, Storage, Backup Now — **no restore UI** |
| BR7 | Operator restore CLI | archive discovery/inspect/verify, new-target restore, integrity validation, full disaster-recovery acceptance |

Later slices must not reopen the decisions in section 2. If an approved
concept conflicts with a newly discovered repository/architectural
constraint, the implementer documents the conflict and proposes the
narrowest reconciliation instead of silently changing the decision.

## 17. Open questions

Genuine unresolved points (none block BR0; each is assigned to its slice):

1. **age implementation choice** (BR3): maintained Node age library vs.
   `age` binary subprocess — to be decided under the dependency rules in
   AGENTS.md §10.
2. **Worker hosting on the macOS pilot** (BR5): launchd agent/unit
   equivalent of the systemd worker service — operational decision when
   BR5 lands.
3. **Files-archive container details** (BR2): concrete container and
   compression choice for `files.tar.zst` (no persistent files exist
   today, so this does not block BR2's database path).
