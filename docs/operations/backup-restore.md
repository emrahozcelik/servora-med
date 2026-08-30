# Backup and restore — Servora-Med

> Backup freshness alerting: the operator alerting monitor checks the age and
> checksum validity of the latest canonical backup pair without modifying it —
> see [operator-alerting.md](./operator-alerting.md). Host backup, restore, and
> cutover operations remain operator-controlled.

> BR1–BR7 Backup & Recovery implementation and contracts live in
> [backup-recovery/](./backup-recovery/). This page remains the operating
> contract for the legacy local script/timer stack and its deployment safety
> boundary; production worker enablement and cutover remain separately gated.

> BR7 operator restore: the new-target CLI and its DR boundary are documented
> in [br7-restore-cli.md](./backup-recovery/br7-restore-cli.md). The legacy
> rehearsal script below remains preserved until a separately authorized
> production operational transition.

## Current-state boundary

Servora has three distinct backup/recovery surfaces:

- **Admin Backup & Recovery application surface** — `Settings → Data Management → Backup & Recovery` and the related admin API are implemented, but are visible/usable only for an authorized `ADMIN` capability (`BACKUP_ENABLED`). The surface provides backup status, history, schedule, storage status, and a manual backup request; it does not provide restore or production cutover.
- **Deployment backups** — the canonical `ops/deploy-production.sh` flow requires a SHA-scoped predeploy backup before migration/release switch and a postdeploy backup after health/browser smoke. These artifacts prove deployment safety only; they do not prove offsite retention or a live restore rehearsal.
- **Operator restore/rehearsal/cutover** — the BR7 CLI and legacy rehearsal path remain operator-controlled. Restore targets are isolated/new targets; web-based production restore, tenant reset, database replacement, and one-click rollback are not provided.

## Backup

The following section documents the legacy local `pg_dump`/sidecar stack. It
remains available until a separately authorized production worker/cutover
transition retires it.

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
  The template invokes the root-installed
  `ops/scripts/predeploy-backup-launcher.sh`, which validates the 40-character
  instance and rejects symlink/path escapes before executing the release
  backup script as `servora-med`.
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

No web-based restore or production database cutover UI is provided. The Admin
Backup & Recovery UI/API is capability-gated and does not replace the
operator-controlled restore, rehearsal, or cutover workflow.
