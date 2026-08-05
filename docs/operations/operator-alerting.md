# Operator alerting — Servora-Med

Host-level monitoring for the operators of a Servora-Med deployment. The
monitor is a separate one-shot process that reports application health,
PostgreSQL backup freshness, disk free space and its own state health through
a vendor-neutral HTTPS JSON webhook. It is **default disabled**, is **not
installed by default**, and is **not** part of the in-app Notification Center.

## Purpose and threat model

The in-app Notification Center only works while the application is running and
its users are logged in. If the API is down, the database is full, or the
nightly backup silently stopped producing valid files, no in-app channel can
report it. The operator alerting monitor runs on the host independently of the
application process so that it can report when the application itself is
unavailable.

The monitor:

- never writes to the application database
- never creates or restores backups
- never sends notifications to users or customers
- keeps no customer, patient, job, message or user data in state or payloads
- exits after one evaluation (one-shot); scheduling is done by launchd/systemd

## Monitored conditions

| Check | Condition |
|-------|-----------|
| `health` | GET the configured health URL. Failure = timeout, connection/TLS error, redirect, non-200, or a body that does not match the Servora-Med contract (`{"status":"ok"}`). |
| `backup` | Read-only inspection of the backup directory. The **newest** canonical completed pair `servora-med-YYYYMMDDTHHMMSSZ.dump` + `.dump.sha256` is authoritative: it must exist, be a regular file (symlinks rejected), match the portable sidecar contract (digest + basename only, no absolute paths), pass SHA-256 verification and be at most `SERVORA_ALERT_BACKUP_MAX_AGE_HOURS` old. `.partial` files and future-dated timestamps are rejected. An invalid newest backup **fails closed** — older backups are never hashed or accepted as a fallback, so the failure becomes alertable. |
| `disk` | Free space on the configured path via `statfs`. Failure below `SERVORA_ALERT_DISK_MIN_FREE_PERCENT`. |
| `monitor` | The monitor's own state file: corruption is quarantined, a fresh default state is created and a `monitor` alert is emitted. Unsupported future state versions fail the run without overwriting. |

## Default-disabled behavior

`SERVORA_ALERTING_ENABLED` is a strict boolean (`true`|`false`). With `false`
(or unset) the monitor exits `0` immediately: no network access, no state
mutation, no lock. Host activation is a separate, explicitly authorized
operation; this repository only ships the monitor and example units.

## Configuration

Private operator environment file, e.g. `/etc/servora-med/servora-med-alerting.env`
(mode 0600, root-owned). Never commit real values; see
`ops/examples/operator-alerting.env.example`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SERVORA_ALERTING_ENABLED` | `false` | Strict boolean; disabled performs no work. |
| `SERVORA_ALERT_WEBHOOK_URL` | — | HTTPS webhook (plain http allowed only for loopback hosts). Required when enabled. |
| `SERVORA_ALERT_HEALTH_URL` | `http://127.0.0.1:3000/api/health` | Application health endpoint (app contract is unchanged). |
| `SERVORA_ALERT_BACKUP_DIR` | — | Read-only backup directory. Required when enabled. |
| `SERVORA_ALERT_BACKUP_MAX_AGE_HOURS` | `26` | Max accepted age of the latest valid backup. |
| `SERVORA_ALERT_DISK_PATH` | `/` | Filesystem to check (internal only, never leaves the host). |
| `SERVORA_ALERT_DISK_LABEL` | `disk-target` | Safe payload label for the disk target; validated as a safe label and must not equal the disk path. |
| `SERVORA_ALERT_DISK_MIN_FREE_PERCENT` | `15` | Minimum free percent (0–100). |
| `SERVORA_ALERT_FAILURE_THRESHOLD` | `3` | Consecutive failures before an alert (>= 1). |
| `SERVORA_ALERT_COOLDOWN_MINUTES` | `60` | Minimum gap between reminders while a check stays failing. |
| `SERVORA_ALERT_TIMEOUT_MS` | `5000` | Per-request timeout for probe and delivery. |
| `SERVORA_ALERT_STATE_DIR` | — | Operator state directory (mode 0700, state file 0600). Required when enabled. |
| `SERVORA_ALERT_ENVIRONMENT` | `local` | Safe payload label (alphanumeric, `.`, `-`, `_`). |
| `SERVORA_ALERT_INSTANCE_LABEL` | `servora-med` | Safe payload label identifying the instance. |

Validation rules: strict booleans only; finite numbers with safe ranges; no
negative ages/cooldowns/timeouts; disk threshold within 0–100; webhook URL
must be HTTPS (loopback http allowed), must not contain credentials, and
redirects are treated as delivery failures.

## Webhook payload

Versioned, vendor-neutral JSON (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "application": "Servora-Med",
  "instance": "servora-med-prod-1",
  "environment": "production",
  "event": "alert",
  "check": "health",
  "severity": "critical",
  "summary": "Application health failing after 3 consecutive failures",
  "observedAt": "2026-08-05T12:00:00.000Z",
  "details": { "consecutiveFailures": 3, "httpStatus": 503, "latencyMs": 42 }
}
```

- `event`: `alert` (threshold reached), `reminder` (still failing after
  cooldown), `recovery` (became healthy again), `monitor` (monitor self-state).
- `severity`: `critical` (health, backup, monitor) or `warning` (disk).
- `details` carries only allowlisted safe metrics: health — consecutive
  failures, timeout flag, HTTP status, latency; backup — age hours, canonical
  basename, checksum validity, latest backup timestamp, error category;
  disk — free percent, free/used bytes, and the configured safe target label (`SERVORA_ALERT_DISK_LABEL`, default `disk-target`) — never the filesystem path; `consecutiveFailures` appears only on failed disk alerts/reminders, never on a successful recovery payload.

The payload never contains: the webhook URL or tokens, `DATABASE_URL`, DB
host/user/name, cookies, sessions, raw API response bodies, customer/user/
patient/job/message data, absolute backup paths, filesystem inventories,
environment dumps, stack traces, or any credential. The webhook URL is never
logged or persisted; only a scheme+host redaction is available for operator
diagnostics.

## State, threshold, cooldown and recovery

State lives in `$SERVORA_ALERT_STATE_DIR/state.json` (mode 0600, atomic
temp-write + rename) and holds only deduplication data per check:
`consecutiveFailures`, `alertActive`, `lastAlertAt`, `lastReminderAt`,
`lastRecoveryAt`, `lastDeliveredAt`.

1. Healthy: failures reset; if an alert was active and delivered, exactly one
   `recovery` event is sent.
2. Failed below the threshold: failures increment, no webhook.
3. Failed at the threshold: one `alert` event; on successful delivery the
   check becomes active (delivery-applied state).
4. Active and still failing: nothing until the cooldown expires, then one
   `reminder` event (timestamp updated only after successful delivery).
5. Delivery failure: the event is not marked delivered (retried on the next
   run) and the monitor exits non-zero.
6. Multiple checks transitioning in the same run each produce their own event;
   a single check never produces duplicates in one run.
7. Every successful delivery is applied to state and persisted **before** the
   next event is attempted, so a later delivery failure in the same run can
   never lose an earlier successful delivery; the failed event stays
   retryable and prior events are never duplicated on retry.
8. **Recovery commits on delivery.** A failed recovery webhook never closes
   the alarm: the check stays `alertActive`, previous delivery timestamps are
   preserved and `lastRecoveryAt` stays untouched. The next healthy run retries
   the recovery, and only a successful delivery closes the alarm and records
   `lastRecoveryAt`; the run after that stays quiet.
9. **Corrupt-state monitor incidents stay pending until delivered.** When
   corrupt state is detected, the file is quarantined and
   `monitor.pendingIncident` (`state-corrupt`) is persisted. The monitor event
   is retried on every run until its webhook succeeds; a successful delivery
   clears the pending incident and persists before any check event is
   attempted, so a later check delivery failure never duplicates the monitor
   event.
10. Delivery semantics are **at-least-once** around crash boundaries only: a
    process crash between a successful webhook delivery and the state write
    can cause a duplicate on the next run. Known webhook failures never lose
    an event — every failed event stays persisted and retryable.

Corrupt state files are renamed to `state.json.corrupt-<timestamp>` inside the
same state directory, replaced with a fresh default, and the incident is
persisted as `monitor.pendingIncident` — **atomically, before any probe or
webhook work** — until a `monitor` webhook is delivered successfully (retried
every run on failure). If that initial pending write fails, the run exits
non-zero with zero probes, zero webhooks and no overwrite of the quarantined
file. Unsupported future state versions stop the run with a clear error
without overwriting.

State read errors are classified: a missing state file (`ENOENT`) is a normal
first run and produces the default state; any other read error
(`EACCES`/`EPERM`, `EIO`, `EISDIR`, other) fails closed with a structured
`state-read-failed` log (allowlisted category only), exit 1, no probes, no
webhooks and no state reset.

## Concurrency

`$SERVORA_ALERT_STATE_DIR/lock.lock` (mode 0600) is acquired atomically with
owner PID and creation time. A live PID blocks a concurrent run (exit code 2);
a stale lock from a dead PID is reclaimed. Malformed or unreadable locks and
unexpected lock filesystem errors resolve to structured exit code 1 with a
safe `lock-invalid`/`lock-error` log (no raw lock content, no stack traces) and
no probes or webhooks; the malformed lock file is preserved, never deleted.
Normal and handled error exits release the lock; abrupt termination may leave
a stale lock, which is reclaimed on the next run.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Checks completed; any delivered alert/recovery was delivered. |
| `1` | Configuration error, unsupported state version, or monitor execution error. |
| `2` | Lock busy — another run is active. |
| `3` | Webhook delivery failed (state is left retryable). |

An unhealthy application is not hidden behind exit codes; it is represented in
state and alert delivery.

## Logging

Structured JSON lines to stdout/stderr with timestamp, run result, check name,
state transition, safe metrics and delivery outcome. Never logged: webhook
URL, tokens, response bodies, DB URLs, absolute backup paths, environment
dumps, customer/user data. Exception stack traces are not written to operator
logs; state/lock errors log only allowlisted categories (`permission`, `io`,
`wrong-type`, `other`, `malformed`, `unreadable`, `unexpected`).

## macOS launchd (example — not installed)

1. Install the private env file: `/etc/servora-med/servora-med-alerting.env` (0600).
2. Install the wrapper:
   `sudo install -o root -g wheel -m 0755 ops/launchd/run-alerting.sh.example /usr/local/libexec/servora-med/run-alerting.sh`
3. Install the plist:
   `sudo install -o root -g wheel -m 0644 ops/launchd/com.servora-med.alerting.plist.example /Library/LaunchDaemons/com.servora-med.alerting.plist`
4. Activate (separate operator authorization required; the plist ships with
   `StartInterval` 300 and `RunAtLoad false`):
   `sudo launchctl bootstrap system /Library/LaunchDaemons/com.servora-med.alerting.plist`

## Linux systemd (example — not installed)

`ops/systemd/servora-med-alerting.service` (oneshot, dedicated `servora-med`
identity, hardened: `NoNewPrivileges`, `UMask 0077`, read-only backup dir,
writable only state/log) and `ops/systemd/servora-med-alerting.timer`
(OnBootSec 5min, OnUnitActiveSec 5m, Persistent, RandomizedDelaySec 30).

```sh
sudo install -o root -g servora-med -m 0600 /etc/servora-med/servora-med-alerting.env
sudo install -o root -g root -m 0644 ops/systemd/servora-med-alerting.service /etc/systemd/system/
sudo install -o root -g root -m 0644 ops/systemd/servora-med-alerting.timer /etc/systemd/system/
sudo systemctl daemon-reload
# Activation (separate operator authorization required):
# sudo systemctl enable --now servora-med-alerting.timer
```

## Manual one-shot verification

```sh
# Disabled run — exits 0, no network, no state:
node ops/scripts/operator-alerting.mjs

# Enabled against a local receiver (loopback http is allowed):
SERVORA_ALERTING_ENABLED=true \
SERVORA_ALERT_WEBHOOK_URL=http://127.0.0.1:9000/hook \
SERVORA_ALERT_HEALTH_URL=http://127.0.0.1:3000/api/health \
SERVORA_ALERT_BACKUP_DIR=/var/backups/servora-med \
SERVORA_ALERT_STATE_DIR=/var/lib/servora-med-alerting \
node ops/scripts/operator-alerting.mjs
```

### Failure drills (temp directories only — never touch real backups)

- **Health failure:** point `SERVORA_ALERT_HEALTH_URL` at a dead port, run the
  monitor three times; expect one `alert` on the third run.
- **Stale backup:** create `servora-med-<old-timestamp>.dump` + matching
  `.sha256` in a temp backup dir, run; expect a `backup` alert.
- **Disk threshold:** set `SERVORA_ALERT_DISK_MIN_FREE_PERCENT=99`, run; expect
  a `disk` alert (the monitor uses the real `statfs` of the configured path).
- **Recovery:** point the health URL back at a healthy endpoint; expect exactly
  one `recovery` event, then silence on the next run.

## State/cooldown drill

After an `alert`, keep the check failing: no webhook until `COOLDOWN_MINUTES`
passes, then exactly one `reminder`. Inspect the state file to confirm
`alertActive` and timestamps; stop the monitor, delete the state file (or
corrupt it), restart: a `monitor` alert is emitted and a fresh state file is
recreated.

## Log locations

- macOS (example): `/usr/local/var/log/servora-med/alerting.stdout.log` and
  `alerting.stderr.log`.
- systemd (example): `journalctl -u servora-med-alerting.service`.

## Troubleshooting

- Exit 1: check configuration syntax; `SERVORA_ALERT_STATE_DIR` and
  `SERVORA_ALERT_BACKUP_DIR` must be absolute; enabled mode requires the
  webhook URL and state dir.
- Exit 2: another run is in progress (check `lock.lock` PID).
- Exit 3: webhook rejected the payload (check the receiver; non-2xx and
  redirects are failures). The state remains retryable.
- Backup alerts: verify the backup directory contains the canonical pair
  without `.partial` leftovers and that the sidecar has no absolute paths.
- Monitor alerts: a state file was corrupt and was quarantined; confirm the
  `.corrupt-*` file in the state directory and that no unauthorized writes
  occurred there.

## Disable / rollback

Set `SERVORA_ALERTING_ENABLED=false` (or remove the env file) and remove the
timer/daemon:

- systemd: `sudo systemctl disable --now servora-med-alerting.timer`
- launchd: `sudo launchctl bootout system/com.servora-med.alerting`

Deleting `$SERVORA_ALERT_STATE_DIR` resets all deduplication state.

## Boundaries

- Production enablement requires separate operator authorization; a real
  webhook endpoint is never configured by this repository.
- Real webhook credentials are never committed to the repository.
- Backup creation and restore remain fully manual
  (see [backup-restore.md](./backup-restore.md)); this monitor only checks
  freshness and checksum validity.
