# Backup & Recovery V1 (BR program) — Servora-Med

```text
Date: 2026-08-22
BR0: merged (architecture and contracts only)
BR1: implemented — Backup Domain Foundation
Status: BR1 delivered; BR2–BR7 future
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
| BR1 — backup domain foundation | implemented (see below) |
| BR2–BR7 | future (engine, encryption, R2, worker, admin UI, restore CLI) |

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
