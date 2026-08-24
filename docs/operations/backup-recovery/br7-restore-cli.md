# BR7 operator restore CLI

BR7 is an operator-controlled, new-target restore path. It is deliberately
not an HTTP endpoint or a Backup & Recovery UI action.

## Commands

Build the server package, then invoke the installed bin or the repository
wrapper:

```bash
cd server
npm run build
node bin/servora-backup.js list --remote
node bin/servora-backup.js inspect <backup-uuid>
node bin/servora-backup.js verify <backup-uuid>
node bin/servora-backup.js restore <backup-uuid> \
  --target-db servora_dr_20260823 \
  --mode disaster-recovery \
  --identity /secure/operator/servora-age-identity.txt \
  --i-accept-destructive-restore
```

`inspect` and `verify` also accept a local plaintext `.sbk.tar`. A local
encrypted `.sbk.age` requires `--expected-sha256`; a self-computed local hash
is never presented as remote verification.

`list` proves discovery only. `inspect` proves a verified/decrypted package
before showing safe manifest fields. `verify` additionally runs `pg_restore -l`.
`restore` reports `READY_FOR_CUTOVER` only after the new target, schema, domain,
and (when present) files-root checks pass. It never reports production
cutover or `COMPLETED`.

## Environment contract

Remote commands need:

```text
BACKUP_R2_ACCOUNT_ID
BACKUP_R2_ACCESS_KEY_ID
BACKUP_R2_SECRET_ACCESS_KEY
BACKUP_R2_BUCKET
BACKUP_INSTANCE_ID
```

Restore needs an explicit administrative connection for a maintenance
database, separate from the application source `DATABASE_URL`:

```text
RESTORE_TARGET_DATABASE_URL=postgresql://operator:password@host:5432/postgres
```

Normal rehearsal additionally needs `RESTORE_CONTROL_DATABASE_URL` so the
BR5 shared backup/restore advisory lock and `restore_runs` can be held on the
live control installation. `PRODUCTION_DATABASE_URL` (or
`RESTORE_PRODUCTION_DATABASE_URL`) supplies the known production host/name
guard when available. Passwords are read only by libpq child environments;
they never appear in argv or evidence.

Optional controls are `RESTORE_WORKSPACE_ROOT`, `RESTORE_EVIDENCE_DIR`,
`BACKUP_FILES_ROOT`, `AGE_BIN`, `PG_RESTORE_BIN`, `TAR_BIN`, and `ZSTD_BIN`.
The private age identity is operator-held, must be supplied by `--identity`
or `SERVORA_BACKUP_AGE_IDENTITY`/`AGE_IDENTITY_FILE`, and is never copied into
the repository, database, R2, or generated evidence. Official age >= 1.3.0
(target 1.3.1) and the BR3 native hybrid identity are required.

## Safety and DR semantics

- Remote keys are restricted to `production/<instance-id>/v1/{daily,weekly,monthly,manual,pre-restore}` and UUID resolution fails closed on duplicates.
- HEAD metadata (`servora-backup-id`, `servora-format=1`, `servora-sha256`), streamed bytes, and SHA-256 must agree before age runs. ETag is not a checksum.
- Outer package entries are allowlisted before extraction. Manifest/component sizes and both checksum layers are checked before target creation.
- The target name must be a strict PostgreSQL identifier, must not already exist, and must not be the known production name/host pair. There is no force/overwrite/production escape hatch.
- `pg_restore` is argv-only with `--exit-on-error --single-transaction --no-owner --no-acl`; no `--clean`, `--create`, or auto-migration is used.
- `DISASTER_RECOVERY` is explicit. It does not query `backup_runs`, `backup_storage`, `backup_policy`, or source `restore_runs`. A target-side advisory lock prevents concurrent restore invocations; source-lock acquisition is truthfully reported as unavailable.
- A restored runtime snapshot is observed, not rewritten: stale backup/worker rows are included in safe evidence and remain subject to BR5 orphan recovery if a future cutover enables the worker. BR7 never fabricates SUCCESS or erases history.

`READY_FOR_CUTOVER` means “this isolated target passed validation.” It does
not authorize changing `DATABASE_URL`, restarting production, changing DNS,
enabling `BACKUP_WORKER_ENABLED`, disabling the legacy timer or
`OFFSITE_COPY_HOOK`, or switching monitoring.

## FULL_DATA

When `manifest.contents.files` is present, restore requires:

```text
--target-files-root /new/empty/restore-files
```

The root must be absent, outside the repository/source/web/production files
roots, and is never overwritten. The compressed archive is inspected before
extraction; traversal, absolute paths, links, hardlinks, devices, FIFOs and
duplicates fail closed.

The producer contract is symmetric: BR2 validates the configured files root
with `lstat` before `FILES_ARCHIVE`; any symlink, hardlink, device, FIFO or
socket makes the run `FAILED` with `FILES_ARCHIVE_FAILED`, before PACKAGE,
ENCRYPT, UPLOAD, REMOTE_VERIFY or SUCCESS.

## Evidence and acceptance

Normal mode persists `RUNNING` then `READY_FOR_CUTOVER`/`FAILED`/`CANCELLED`
through the existing `restore_runs` schema. In true DR, the source metadata
database may be gone; a separate READY row is inserted into the restored
target when possible, otherwise a 0600 evidence JSON is emitted under
`RESTORE_EVIDENCE_DIR`.

The deterministic acceptance harness uses disposable PostgreSQL, official age,
and an injected R2-semantic transport. The authoritative real Cloudflare R2
path is a separate opt-in FULL_DATA DR acceptance. It accepts only dedicated
acceptance credentials, a disposable bucket, synthetic data, an internally
generated opaque instance ID, and an ephemeral identity. Never use production
credentials or customer data. Without dedicated credentials the status is:

```text
REAL_R2_DR_ACCEPTANCE = NOT EXECUTED
```

The deterministic entrypoint is `ops/scripts/restore-dr-acceptance.sh`. The
intentional real-R2 entrypoint is:

```bash
npm --prefix server run backup:real-r2-acceptance
```

It requires the separate `SERVORA_ACCEPTANCE_R2_*` contract and never falls
back to normal production R2 variables. Full prerequisites, evidence fields,
the exact external-operation sequence, and cleanup semantics are in
[`real-r2-dr-acceptance.md`](./real-r2-dr-acceptance.md). Cleanup may target
only the current run's exact object key; Bucket Lock is never changed.

V1 integrity verification is not producer authentication: R2 metadata, SHA,
and Bucket Lock do not prove that a trusted Servora producer created the
object. The operator documentation must not make that stronger claim.
