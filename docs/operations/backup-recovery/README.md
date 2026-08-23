# Backup & Recovery V1 (BR program) — Servora-Med

```text
Date: 2026-08-22
BR0: merged (architecture and contracts only)
BR1: merged — Backup Domain Foundation
BR2: implemented — Local PostgreSQL Backup Engine
Status: BR2 delivered; BR3–BR7 future
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
| BR2 — local PostgreSQL backup engine | implemented (see below) |
| BR3–BR7 | future (encryption, R2, worker, admin UI, restore CLI) |

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
  symlinks archived as symlinks, single configured `BACKUP_FILES_ROOT`)
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
