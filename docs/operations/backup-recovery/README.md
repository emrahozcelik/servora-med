# Backup & Recovery V1 (BR program) — Servora-Med

```text
Date: 2026-08-23
BR0: merged (architecture and contracts only)
BR1: merged — Backup Domain Foundation
BR2: merged — Local PostgreSQL Backup Engine
BR3: merged — Post-Quantum Backup Encryption (native age HybridRecipient)
BR4: merged — Cloudflare R2 Storage + Upload + Remote Verification
BR5: merged — worker / scheduling / retry / cleanup / crash recovery
BR6: merged — admin Backup & Recovery UI
BR7: implemented — operator restore CLI + DR acceptance harness on an isolated Draft PR branch
Status: BR7 Draft PR / exact-head CI and DR acceptance evidence required before external review; Ready, merge, cleanup, and production cutover are not authorized
```

This directory holds the approved architecture and implementation-ready
contracts for Servora-Med Backup & Recovery V1, and the BR1–BR7
implementation roadmap. BR0 changed documentation only: no backup engine,
no migrations, no API endpoints, no UI, and no Cloudflare resources were
added or configured.

## Implementation status

| Slice | Status |
|-------|--------|
| BR0 — architecture + contracts | merged (`eceb94d`, PR #187) |
| BR1 — backup domain foundation | merged (`8530990`, PR #188) |
| BR2 — local PostgreSQL backup engine | merged (`12452f0`, PR #189) |
| BR3 — post-quantum backup encryption | merged (`d57bca7`, PR #190) |
| BR4 — Cloudflare R2 storage + verification | merged; REAL_R2 acceptance remains a BR5 production gate |
| BR5 — worker / scheduling / retry / recovery | merged; production enablement remains separately authorized |
| BR6 — admin backup UI | merged; web restore remains intentionally absent |
| BR7 — restore CLI | implemented on the isolated Draft PR branch; exact-head CI/DR evidence pending |

BR1 delivered (metadata foundation only — no pg_dump, encryption, R2,
worker, scheduler, UI, or restore execution):

- Migration `030_backup_domain_foundation` — installation-scoped
  `backup_runs`, `backup_policy` (seeded singleton), `backup_storage`
  (seeded singleton, safe state only), `restore_runs`; durable
  single-active partial unique indexes; canonical CHECK vocabularies and
  invariants; `audit_events` vocabulary extension
  (`BACKUP_REQUESTED`, `BACKUP_POLICY_UPDATED`).
- Module `server/src/modules/backup` — canonical types and state machine
  (status/phase transitions, failure/warning taxonomy, shared
  `BACKUP_EXCLUSION_ADVISORY_LOCK_KEY`), repository (keyset history,
  transition primitives, `processed_actions` idempotency), service
  (ADMIN-only RBAC, atomic run+audit creation, policy validation), routes.
- API: `GET/POST /api/admin/backups`, `GET /api/admin/backups/:backupId`,
  `GET/PUT /api/admin/backup-policy`, `GET /api/admin/backup-storage`,
  gated by `BACKUP_ENABLED` (default false; app starts without BR2–BR4
  secrets). Deliberately deferred: `POST /api/admin/backups/:id/reverify`
  and `POST /api/admin/backup-storage/test` (would not be truthful before
  BR4).

BR2 delivered (local engine only — stops at the PACKAGE phase; no age
encryption, no R2, no worker/scheduler, no UI, no restore CLI):

- `server/src/modules/backup/engine.ts` — `LocalBackupEngine.buildLocalBackup`:
  PostgreSQL source → isolated 0700 workspace (`workspace.ts`, UUID-derived,
  containment-checked) → `pg_dump -Fc --no-owner --no-acl` (argv-safe
  execFile, connection via libpq child env only — password never on argv,
  disk, or in logs) → optional `files.tar.zst` (system `tar` + `zstd`,
  producer-validated regular files/directories only (symlink, hardlink and
  special entries fail during `FILES_ARCHIVE`), single configured
  `BACKUP_FILES_ROOT`)
  → manifest V1 (`dumpVersion` = archive "Dump Version" via `pg_restore -l`, plus additive `dumpToolVersion`; see archive-and-storage §2)
  → streaming SHA-256 components → `checksums.sha256` (two-space sidecar)
  → plaintext package `<run-id>.sbk.tar` (uncompressed tar — decision
  recorded in archive-and-storage §1.1).
- Phase progression exclusively through BR1 service primitives; a completed
  run stays `RUNNING` at `PACKAGE` (never SUCCESS, no `verified_at`, no
  canonical sha256 — those belong to BR3/BR4).
- Local preflight subset only (temp root + disk headroom, pg_dump presence
  and server-major compatibility, database reachability, files-archive
  prerequisites). No HTTP surface: `POST /api/admin/backups` still only
  enqueues domain intent.
- Config: optional `BACKUP_TEMP_ROOT` / `BACKUP_FILES_ROOT` (empty = not
  configured, which is valid; app startup never requires BR3/BR4 secrets).

BR3 delivered (local encryption only — stops at the ENCRYPT phase; no R2,
no upload, no remote verification, no worker/scheduler, no UI, no restore
CLI):

- `server/src/modules/backup/encryption.ts` — `LocalEncryptionEngine.encryptLocalBackup`:
  BR2 plaintext `<run-id>.sbk.tar` (RUNNING @ PACKAGE) → official `age` CLI
  (argv-safe `spawn`, shell:false, recipient on argv — it is public) with
  ONE native post-quantum hybrid recipient → binary `<run-id>.sbk.age`.
  Decision record: `OPS-003` (native HybridRecipient, ML-KEM-768 +
  X25519, `age1pq1…`; no classic fallback, no mixing; age >= 1.3.0,
  validated 1.3.1; no custom crypto).
- Streaming design: age stdout is piped simultaneously into an exclusive
  0600 partial file (`<run-id>.sbk.age.partial`, `wx`) and a SHA-256
  hash — the ciphertext never lands in memory; finalization is an
  atomic no-overwrite hard-link + unlink. Pre-existing final/partial
  outputs fail closed and the ambiguous workspace is preserved for BR5.
- The run advances PACKAGE → ENCRYPT and stays RUNNING: never SUCCESS,
  no `verified_at`, no `backup_runs.sha256`, no `remote_key` (those are
  BR4 REMOTE_VERIFY semantics). `localCiphertextSha256` is the LOCAL
  EXPECTED value returned for the BR4 handoff and is deliberately not
  persisted as the canonical hash.
- Failures map to `ENCRYPTION_FAILED` (age missing/too old, missing or
  non-hybrid recipient, process failure, output failure, empty output);
  the plaintext package is kept only on success — ordinary handled
  failures best-effort remove the run workspace, collision-class
  failures preserve everything.
- Key custody: production config carries only the PUBLIC recipient
  (`BACKUP_ENCRYPTION_RECIPIENT`, structural validation at startup,
  full hybrid policy enforced lazily at encryption time). There is no
  supported private-identity config path; key generation and rotation
  are operator actions (architecture §10, `OPS-003`).
- CI installs official `age` 1.3.1 pinned with the published SHA-256
  (linux-amd64 release artifact, checksum-verified — no curl|sh, no
  mirrors, no vendored binaries). Production VPS prerequisite:
  install official age >= 1.3.0 before enabling the BR5 worker.

BR4 implemented (remote boundary only — stops at the CLEANUP phase; no
worker, no scheduler, no SUCCESS transition, no retention pruning, no
bucket administration, no UI, no restore CLI):

- `server/src/modules/backup/r2.ts` — `CloudflareR2Storage` adapter over
  the official `@aws-sdk/client-s3` (the only new dependency; justified:
  SigV4 signing and streaming S3 mechanics are not reimplementable by
  hand under the no-custom-crypto rule). Endpoint derived strictly from
  the validated `BACKUP_R2_ACCOUNT_ID` (`region: auto`); no arbitrary
  endpoint override exists. Provides: HEAD, atomic conditional single PUT
  (`If-None-Match: *` — R2-documented), streamed conditional GET, and the
  connection-test probe
  (List + Create/Abort multipart on a reserved `.connection-test` key —
  no completed object, nothing retained by Bucket Lock).
- `server/src/modules/backup/object-keys.ts` — canonical key builder
  `production/<instance-id>/v1/<retention>/<backup-id>.sbk.age` with a
  conservative opaque `BACKUP_INSTANCE_ID` grammar; retention → path
  mapping (daily/weekly/monthly/manual/pre-restore).
- `server/src/modules/backup/remote-engine.ts` — `RemoteBackupEngine`:
  RUNNING@ENCRYPT → UPLOAD → REMOTE_VERIFY → `recordVerification()` →
  RUNNING@CLEANUP (STOP). Upload is byte-exact streaming with
  `servora-backup-id`/`servora-format`/`servora-sha256` metadata
  (`application/octet-stream`); verification is the canonical three-way
  composition (expected SHA == object metadata SHA == streamed remote
  SHA, plus exact byte count). The methods require the exact BR3 handoff
  (`encryptedPath`, `ciphertextBytes`, `localCiphertextSha256`), which is
  revalidated before upload. `uploadAndVerifyRemoteBackup()` enters from
  ENCRYPT; `retryUploadRemoteBackup()` and `verifyRemoteBackup()` are the
  BR5 same-phase re-entry points; `reverify()` is the read-only
  internal primitive for BR7/future reverify requests.
- No-overwrite contract: single PUT is a genuinely atomic conditional
  create (412 → §20 resolution). R2 does NOT document an equivalent
  conditional destination operation for multipart finalization. The
  2026-08-23 reconciliation therefore limits BR4 to R2's effective
  single-PUT maximum: 5 GiB − 5 MiB (5,363,466,240 bytes). A larger
  artifact fails before any R2 command with
  `R2_OBJECT_TOO_LARGE`; completed backup multipart is deferred rather
  than falling back to a destructive race. Multipart create/abort remains
  only in the non-object-producing connection probe.
- Failure taxonomy (migration `032`): new `R2_OBJECT_TOO_LARGE`
  (terminal approved-limit failure), `R2_OBJECT_CONFLICT` (terminal
  integrity conflict, never overwrite/delete/retry), and
  `R2_VERIFY_FAILED` (retryable verify transport). Terminal failures persist FAILED;
  retryable transport failures (`R2_UPLOAD_FAILED`, `R2_VERIFY_FAILED`)
  deliberately leave the run RUNNING at its phase for the BR5 bounded
  phase retry. `R2_AUTH_FAILED` / `REMOTE_CHECKSUM_MISMATCH` keep their
  BR0 meanings. Upload-then-verify-failure leaves the remote object in
  place (forensics/Bucket Lock); no blind DeleteObject anywhere.
- Connection test: `POST /api/admin/backup-storage/test` (ADMIN only via
  service layer; MANAGER/STAFF 403). Persists only
  `backup_storage.last_connection_test_at/_ok`; response carries
  `ok`/`testedAt`/safe failure class — never credentials or raw SDK
  errors. `BACKUP_STORAGE_TESTED` audit vocabulary remains future work
  (BR0 audit table), not expanded in migration 032 by scope discipline.
- Reverify HTTP endpoint: intentionally still NOT exposed — BR5 does not
  invent a parallel queue solely for reverify; no misleading 202 is returned.
- Config: optional validated-if-present `BACKUP_R2_ACCOUNT_ID` (32-hex),
  `BACKUP_R2_ACCESS_KEY_ID` / `BACKUP_R2_SECRET_ACCESS_KEY` (env only;
  redacted log paths), `BACKUP_R2_BUCKET`, `BACKUP_INSTANCE_ID`,
  `BACKUP_R2_BUCKET_ALIAS`; absent config keeps startup valid and a
  connection-test request records a safe `CONFIG` failure. The safe
  storage-state response overlays configured/alias truth from runtime env
  while retaining DB-backed last-test evidence. Tests run
  through a deterministic injected fake client; an opt-in real-R2
  acceptance suite exists behind explicit disposable env credentials
  (REAL_R2_ACCEPTANCE = NOT EXECUTED without them).

BR5 delivered (separate worker process; production enablement remains a
separate authorized gate):

- Migration `033_backup_worker_runtime` adds lease token/expiry/heartbeat
  ownership, durable scheduler slot state, and the narrow system-actor audit
  vocabulary (`BACKUP_STARTED`, `BACKUP_VERIFIED`, `BACKUP_COMPLETED`,
  `BACKUP_FAILED`). Stale non-CLEANUP runs become `FAILED/WORKER_LOST`;
  expired `RUNNING@CLEANUP` rows are recoverable only with complete remote
  evidence (`remote_key`, byte count, and SHA-256).
- `server/src/backup-worker.ts` is a separate opt-in process. PostgreSQL
  `FOR UPDATE SKIP LOCKED`, the shared `BACKUP_EXCLUSION_ADVISORY_LOCK_KEY`,
  lease heartbeats, bounded three-attempt same-phase retry, DST-aware IANA
  scheduling, current-local-day catch-up, and durable slot dedupe are
  implemented in `modules/backup/worker.ts`, `scheduler.ts`, `retry.ts`, and
  `pipeline.ts`.
- The pipeline composes BR2 → BR3 → BR4. Only remote verification followed by
  cleanup may call `completeRun()` and produce `SUCCESS`; cleanup failure is a
  verified `SUCCESS` with `warning_code = CLEANUP_FAILED`. Terminal workspace
  reclamation is symlink-safe and DB-state-gated.
- `GET /api/health` may surface aggregate backup evidence, while the existing
  `ops/scripts/operator-alerting.mjs` remains the sole monitor. Its default
  source is the legacy local dump/sidecar check; `SERVORA_ALERT_BACKUP_SOURCE=verified-runs`
  is an explicit reconciliation switch.
- Systemd and launchd examples supervise the same worker entrypoint. The old
  MVP timer/script remains untouched. `REAL_R2_ACCEPTANCE = NOT EXECUTED`
  remains a mandatory disposable-bucket gate before enabling the worker in
  production.

BR6 delivered (admin management UI only; production execution remains gated):

- Admin path: `Settings → Data Management → Backup & Recovery`, visible only
  to `ADMIN` users when the `BACKUP_ENABLED` capability is present. Manager and
  staff users remain forbidden by the backend and the UI navigation model.
- Sections: Overview, Backups, Schedule, and Storage. `POST /api/admin/backups`
  remains an asynchronous `202 QUEUED` request with client idempotency; history
  uses bounded keyset pagination. A narrow read-only
  `GET /api/admin/backup-overview` projection supplies the next scheduled
  instant using the BR5 scheduler utility and excludes remote object details.
- Storage is status-only: no credential values or masked secrets are rendered.
  The connection test remains the bounded BR4 probe and is not a real-R2 or
  production-readiness acceptance.
- Status axes remain separate (execution, verification, and cleanup warning).
  `SUCCESS + verified_at + CLEANUP_FAILED` remains a verified success with a
  warning; `SUCCESS` without `verified_at` is never healthy.
- Reverify UI is deferred because the durable HTTP reverify endpoint remains
  absent. Restore, deletion/pruning, credential editing, Bucket Lock/lifecycle
  controls, worker enablement, legacy timer retirement, and monitoring cutover
  are not part of BR6.

BR7 delivered (operator CLI only; no production cutover):

- `server/bin/servora-backup.js` exposes `list --remote`, `inspect`, `verify`,
  and explicit-acknowledgement `restore` commands. The CLI uses only the
  canonical `production/<instance-id>/v1/` prefix and never writes to R2.
- Remote verification is metadata-driven and database-independent: required
  R2 metadata, streamed byte count, and SHA-256 are checked before age
  decryption. ETag is diagnostic only; it is never the canonical checksum.
- Decrypted packages are still untrusted. The allowlist reader rejects
  traversal, absolute paths, duplicates, links, special entries, unexpected
  members, and component byte/checksum mismatches before `pg_restore`.
- Restore always creates a new target database. Existing targets, production
  name/host pairs, `--clean`, `--create`, and automatic migrations/cutover are
  refused. `READY_FOR_CUTOVER` means an isolated validated target only; it is
  not `COMPLETED` and is not production cutover.
- Normal rehearsal uses the BR5 shared advisory-lock session and persists
  `restore_runs`; explicit `DISASTER_RECOVERY` mode uses a target-side
  session lock and can proceed without the source metadata database. After a
  successful target restore it records a separate READY evidence row when
  possible (or a restrictive operator evidence file).
- `FULL_DATA` archives require an explicit new files root and reject unsafe
  nested archive entries. The producer rejects symlinks, hardlinks and
  special entries during `FILES_ARCHIVE`, so producer and restore contracts
  are symmetric. The legacy scripts, timer, `OFFSITE_COPY_HOOK`,
  monitoring source, and `BACKUP_WORKER_ENABLED=false` production state remain
  unchanged.
- Real disposable Cloudflare R2 DR acceptance is an opt-in operator gate.
  Without supplied disposable credentials the truthful status is exactly
  `REAL_R2_DR_ACCEPTANCE = NOT EXECUTED`.

## File map

| File | Contents |
|------|----------|
| [architecture.md](./architecture.md) | Approved decision register, domain boundaries, V1 scope, terminology, job state machine, preflight, execution model, encryption and key custody, integrity model, restore and disaster recovery, acceptance contract, BR1–BR7 roadmap, reconciliation with the current MVP backup stack |
| [archive-and-storage-contract.md](./archive-and-storage-contract.md) | Archive format v1, manifest v1 schema, checksum contract, Cloudflare R2 object key contract, retention contract, R2 infrastructure and least-privilege credential contract, verified Cloudflare facts |
| [platform-contracts.md](./platform-contracts.md) | Data model contract (BR1), RBAC contract, admin API contract (BR slices), admin UI contract (BR6), operator restore CLI contract (BR7), failure taxonomy, retry contract, monitoring/health contract, audit contract |

## Relationship to existing documents

- [../backup-restore.md](../backup-restore.md) remains the **operating
  contract for the current script-based MVP backup stack**
  (`ops/scripts/backup-postgres.sh`, systemd/launchd timers,
  `restore-rehearsal.sh`). Nothing on that page changes until the BR
  slices that replace it are merged and enabled.
- The MVP-era product boundary "no `backup_status` table and no in-app
  backup UI" is **superseded for post-MVP V1** by decision
  `OPS-002` in [`DECISIONS.md`](../../../DECISIONS.md). The boundary stays
  in force until the BR slices that introduce the domain (BR1) and the UI
  (BR6) are actually merged.
- Backup/restore is a **disaster recovery domain** and is deliberately
  separate from business-data export/import; see the deferred
  `docs/superpowers/plans/2026-08-04-admin-data-management-deferred-plan.md`
  for the export/import side.

## Reading order

1. `architecture.md` — start here for decisions and boundaries.
2. `archive-and-storage-contract.md` — what a backup artifact is.
3. `platform-contracts.md` — how Servora models, exposes, and audits it.
