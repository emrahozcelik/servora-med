# Backup and restore — Servora-Med

> Backup freshness alerting: the operator alerting monitor checks the age and
> checksum validity of the latest canonical backup pair without modifying it —
> see [operator-alerting.md](./operator-alerting.md). Backup creation and
> restore remain manual as documented below.

> Post-MVP direction: the approved Backup & Recovery V1 architecture and
> contracts (R2 + age encryption + worker) live in
> [backup-recovery/](./backup-recovery/) (BR0, documentation-only). This page
> remains the operating contract for the current script-based stack until the
> BR slices replace it; see `DECISIONS.md` → `OPS-002`.

> BR7 operator restore: the new-target CLI and its DR boundary are documented
> in [br7-restore-cli.md](./backup-recovery/br7-restore-cli.md). The legacy
> rehearsal script below remains preserved until a separately authorized
> production operational transition.

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
- This scheduled/operator unit follows `/opt/servora-med/current` after a
  release is active. Production deployment uses the separate
  `ops/systemd/servora-med-predeploy-backup@.service` template so the mandatory
  first-deploy backup runs from the exact SHA release before `current` exists.
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
| Real offsite copy | **pending** until destination + credentials + successful hook |
| Cloudflare Tunnel moves backups off-host | **no** — tunnel is app ingress only |

### macOS pilot scheduling

On the macOS pilot host, use `ops/launchd/com.servora-med.backup.plist.example` (LaunchDaemon + wrapper sourcing private env). See [local-macos-cloudflare-tunnel.md](./local-macos-cloudflare-tunnel.md).

## Product boundary

No `backup_status` table and no in-app backup UI.
