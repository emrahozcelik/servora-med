# Backup and restore — Servora-Med

## Backup

Script: `ops/scripts/backup-postgres.sh`

### Properties

- `set -Eeuo pipefail`, `umask 077`
- `pg_dump -Fc --no-owner --no-acl`
- Write `*.partial` then atomic rename
- `*.sha256` sidecar
- `flock` single concurrent backup
- Local retention ~7 days (mtime)
- Ops log: `/var/log/servora-med/backup-ops.log` (no passwords/URLs)
- Optional `OFFSITE_COPY_CMD` after success

### Environment

| Variable | Purpose |
|----------|---------|
| `BACKUP_DIR` | Default `/var/backups/servora-med` |
| `OPS_LOG` | Ops log path |
| `PGHOST` `PGPORT` `PGUSER` `PGDATABASE` | Connection |
| `PGPASSFILE` | Preferred secret material |
| `OFFSITE_COPY_CMD` | Optional encrypted copy hook |

### Schedule

- systemd timer: daily **02:30 UTC** (`servora-med-backup.timer`)
- Always take a **pre-deploy** backup before migrate/release switch

### Targets

| Target | Value |
|--------|--------|
| Local retention | 7 days |
| Offsite retention | ≥ 30 days (operator hook) |
| RPO | 24 hours |
| RTO | 4 hours |

Do **not** claim offsite success unless the hook exits 0.

## Restore rehearsal

Script: `ops/scripts/restore-rehearsal.sh`

```bash
./ops/scripts/restore-rehearsal.sh /var/backups/servora-med/servora-med-….dump \
  --i-accept-destructive-restore
```

### Guards

- Requires `--i-accept-destructive-restore`
- Refuses when `TARGET_PGDATABASE == PRODUCTION_PGDATABASE`
- Refuses production host+database pair when `PRODUCTION_PGHOST` is set
- Verifies checksum when `*.sha256` exists
- Restores only into disposable DB (default `servora_med_restore_rehearsal`)
- Verifies `schema_migrations` non-empty
- Drops disposable DB unless `--keep`

### Rehearsal cadence

1. **Required** once before first production pilot traffic  
2. Monthly thereafter (ops policy)

### Record template

Store under `docs/operations/restore-rehearsals/` (no secrets):

```text
date/time (UTC):
operator:
application SHA:
backup timestamp / filename:
checksum:
safe target db name:
duration:
result: pass|fail
follow-up:
```

## Product boundary

No `backup_status` table and no in-app backup UI.
