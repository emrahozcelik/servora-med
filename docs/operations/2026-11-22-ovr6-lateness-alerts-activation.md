# OVR-6 lateness alerts activation — 2026-11-22

Production activation of the OVR-6 lateness alert worker (`DECISIONS.md` OVR-6,
[contract](../features/lateness-notifications-quiet-hours.md)). The owner
merged and approved the release and asked for everything to start as built
("herşey olduğu gibi başlasın"), without the staged procedure of contract §9.3
(pre-activation candidate counts and a reduced first batch). The worker was
**left enabled** with its default batch size.

## State transition

```text
Before:
release 4ef582d, schema 068, LATENESS_ALERTS_* unset (worker not constructed)
2026-11-22:
deploy 2dd1baf (migration 069) → 1 environment line → 1 restart
After:
release 2dd1baf, schema 069, LATENESS_ALERTS_ENABLED=true (worker running)
```

## Deploy

- Deploy-production run `45007514247`, main `2dd1baf` (PR #477), CI run
  `45004616866` green.
- `PRODUCTION_DEPLOYMENT_COMPLETE … migrations_applied=1 browser_smoke=PASS
  postdeploy_backup=PASS observation=PASS`; public health `ok`.

## Activation

- Channel: key-only root SSH (no password authentication).
- Environment file before the change (read-only check): `WEB_PUSH_ENABLED`,
  `OVERDUE_SCANNER_ENABLED`, `OVERDUE_REMINDER_ENABLED` and
  `JOB_ASSIGNMENT_WINDOW_ENABLED` were `true`; no `LATENESS_ALERTS_*` key.
  OVR-4 therefore runs in production and follows the quiet-hours window from
  this deploy on (contract §9.1).
- Byte-exact backup
  `/root/servora-med-env-backups/servora-med.env.OVR6-activation-20261122T095132Z.bak`;
  atomic replace, ownership `root:servora-med`, mode `0640`; keys 51 → 52; diff
  against the backup is exactly `LATENESS_ALERTS_ENABLED=true`.
- One restart at `2026-11-22T12:51:39+03`: `Result=success`, `NRestarts=0`; the
  running process environment contains the key; no error log lines; public
  health `ok`, `releaseSha 2dd1baf`.

## Expected behavior and evidence still to collect

- Activation day was a Sunday (window closed all day), so the first alerts are
  due at the next window opening, Monday 2026-11-23 08:00 (Europe/Istanbul).
  Every condition already open then alerts once (catch-up, contract §9).
- Not yet observed: delivery rows, activities and notifications per kind after
  the first in-window ticks.

## Rollback

- Stop alerts: remove the line from the environment file (the backup is
  byte-exact) and restart the service once.
- Release rollback below `2dd1baf` only with zero rows of the new notification
  kinds, activity events and `job_card_lateness_alert_deliveries` (contract
  §9.2); otherwise fixes go forward.
