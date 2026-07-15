# Backup and restore — Servora-Med

## Backup

Script: `ops/scripts/backup-postgres.sh`

### Properties

- `set -Eeuo pipefail`, `umask 077`
- Required env: `BACKUP_DIR`, `OPS_LOG`, `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` (no silent defaults)
- `pg_dump -Fc --no-owner --no-acl`
- Write `*.partial` then checksum `*.sha256.partial` (portable: `<hash>  <basename>`)
- Verify partial, then atomic rename dump + checksum
- `flock` single concurrent backup
- Local retention ~7 days (mtime)
- Ops log without passwords/URLs
- Optional executable `OFFSITE_COPY_HOOK` receiving dump path and checksum path (no `eval`)

### systemd

- Unit: `ops/systemd/servora-med-backup.service` with **required**
  `EnvironmentFile=/etc/servora-med/servora-med-backup.env`
- Example: `ops/examples/servora-med-backup.env.example`
- Timer: daily **02:30 UTC**
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

### Guards and fail-closed restore

- Requires `--i-accept-destructive-restore`
- Validates `TARGET_PGDATABASE` / `TARGET_PGUSER` as `^[A-Za-z_][A-Za-z0-9_]*$`
- Refuses production database name / production host+db pair
- Requires portable checksum file; mismatch exits non-zero
- `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`
- Any non-zero path: ops failure log, no success message, ERR trap cleanup
- Drops disposable DB unless explicit `--keep`

### Rehearsal cadence

1. **Required** once before first production pilot traffic (host-recorded)
2. Monthly thereafter (ops policy)

### Repository vs host claims

| Claim | Status |
|-------|--------|
| Disposable CI/local PG backup→restore acceptance | automated tests with `TEST_DATABASE_URL` |
| Live host restore rehearsal markdown under `restore-rehearsals/` | **pending** until performed |

## Product boundary

No `backup_status` table and no in-app backup UI.
