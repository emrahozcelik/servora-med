# OVR-3 Second Activation — 2026-09-21

Bounded production activation of the OVR-3 clock-only overdue breach scanner.
No deploy, no migration, no source change, no manual scan, no incident rewriting.
Exactly one activation restart. The scanner was **left enabled**.

## State transition

```text
Before:
OVR-3 scanner = disabled / rollout paused
2026-09-21 bounded activation:
PASS
1 activation restart
scanner env: UNSET → true
16 observed iterations
1 new VALID LATE_SUBMISSION incident
0 scanner failures
0 rollback
After:
OVR-3 scanner = ENABLED in production
production release remains 1ff6eef...
```

The "1 new VALID LATE_SUBMISSION incident" line above refers to the mandated
observation window. The scanner has continued to run normally since, and the
extended read-only re-check recorded two further incidents — see
[Incident delta](#incident-delta).

## Activation identity

- `ACTIVATION_T0 = 2026-09-21T06:48:38Z` (`2026-09-21T09:48:38+03`)
- Production release before and after: `1ff6eefc4b2d425c3ced0447ad5593c250a83bdd`
- Canonical `main` at activation: `7b55cc2884d7766d38c17127d3bdcabbb49f384f`
  (docs-only ahead of production, so no deploy was required)
- Activation restart count: **1** (`systemctl restart servora-med.service`, exit 0)
- Main PID `65365` → `75414`

## Pre-activation state

- Service: `ActiveState=active`, `SubState=running`, `Result=success`,
  `ExecMainStatus=0`, `NRestarts=0`, `UnitFileState=enabled`,
  `Restart=on-failure`, `TimeoutStopUSec=30s`, `StartLimitBurst=5`,
  `StartLimitIntervalUSec=10s`, `StartLimitAction=none`.
  Not start-limited. `ActiveEnterTimestamp=Sun 2026-09-20 19:19:58 +03`.
- Health: `GET https://dunyadentalapp.com/api/health` → `HTTP 200`,
  `{"status":"ok","releaseSha":"1ff6eefc4b2d425c3ced0447ad5593c250a83bdd", ...}`.
- Scanner env: **UNSET**. `/etc/servora-med/servora-med.env` held 42 keys across
  44 lines with **no** `OVERDUE*` key at all. The baseline was absence, not an
  explicit `false`; `readBoolean(undefined)` resolves to `false`.
- Effective parameters were therefore the built-in defaults:
  `pollIntervalMs = 60000`, `batchSize = 50`.
- Incident history: `SCANNER=8` (7 `LATE_START`, 1 `LATE_SUBMISSION`),
  `TRANSITION=46`, total **54**.
- Read-only candidate discovery counts at `2026-09-21 08:44:49.547789+02`:
  `LATE_START=0`, `LATE_SUBMISSION=1`, `APPROVAL_WAIT=0`.
  `LATE_START=0` is genuine convergence: all seven `ACCEPTED` jobs whose
  `scheduled_ends_at` had passed already held a `LATE_START` incident at
  episode 1 / current revision, so the prefilter's `NOT EXISTS` guard correctly
  excluded them.

## Environment mutation

A single key was added to `/etc/servora-med/servora-med.env` using the same
atomic pattern the deploy host helper uses for its own transitions
(`mktemp` in the same directory → filter → append one canonical line → validate
exactly one occurrence → `chown root:servora-med` → `chmod 640` → `mv` →
post-move contract check).

- Line added: `OVERDUE_SCANNER_ENABLED=true`
- Size: `1575` → `1604` bytes (+29, exactly the new line)
- `sha256`:
  `14a8a1c8eca8ed66e6e23821fbdc2b267a7646a092aafa3e34e78c0b37c45f23` →
  `71a1dfd11af43f65f17d473dda938ce825185bfdd0f89c3b731a54070f6ace88`
- `diff` against the byte-exact backup showed exactly one added line and no
  other change; key count `42 → 43`; `OVERDUE` occurrences `= 1`
- Permissions preserved: `root:servora-med:640`
- `OVERDUE_SCANNER_POLL_INTERVAL_MS` and `OVERDUE_SCANNER_BATCH_SIZE` remain
  UNSET, so the effective `60000` / `50` defaults are unchanged
- Baseline backup (byte-identical, verified with `cmp`):
  `/root/servora-med-env-backups/servora-med.env.OVR3-activation-20260921T064709Z.bak`

Access note: the environment file is `0640 root:servora-med` and the deploy
identity `servora-deploy` is a member of `servora-med`, so it can read but not
write the file; its sudoers allowlist permits
`systemctl restart servora-med.service` but contains no environment-edit path.
The mutation was therefore performed over the separate root channel, applying
the repository's own atomic pattern.

## Restart and health gate

- `systemctl restart servora-med.service` → exit 0
- Local loopback health reachable **2 s** after the restart
- Public health `HTTP 200` with `releaseSha` unchanged
- Shutdown was clean: `{"signal":"SIGTERM","msg":"Shutting down"}`, then systemd
  `Deactivated successfully.` / `Stopped servora-med.service`.
  `Consumed 16.480s CPU time, 157.4M memory peak, 0B memory swap peak.`
- `Result=success`, `ExecMainStatus=0`, `NRestarts` delta `0 → 0`

## Observation window

The mandated window required at least 5 completed iterations **and** at least
7 minutes. Both were exceeded.

- Completed iterations: **16** (window closed), first `scanTime`
  `2026-09-21T06:48:38.747Z`, last `2026-09-21T07:03:38.864Z`
- Span: `900.1 s` (15.0 min); elapsed from `T0` to window close `15.6 min`
- Cadence gaps: min `60.004 s`, max `60.028 s`, mean `60.008 s` — no drift, no
  missed tick, no overlap
- All 16 iterations were captured with full per-field detail; iteration 1 was
  the only one with a non-zero candidate count
- Totals across the 16: `candidates=1`, `inserted=1`, `converged=0`,
  `skippedNotBreached=0`, `skippedIncompleteEvidence=0`, `skippedStateChanged=0`,
  `skippedInFlightRequest=0`, `failed=0`
- `byDelayType` totals: `LATE_START=0`, `LATE_SUBMISSION=1`, `APPROVAL_WAIT=0`

An extended read-only re-check at `2026-09-21T07:32:57Z` recorded **45**
iterations over a `2640.4 s` (44.0 min) span, with the same cadence profile
(min `60.004 s`, max `60.028 s`, mean `60.008 s`) and cumulative
`candidates=3`, `inserted=3`, `failed=0`. The scan loop is therefore still
healthy well beyond the mandated window.

Per-iteration reports are emitted at `info` level by the deployed artifact
(`server/dist/index.js`), which is what makes this evidence available. The
working tree on the `codex/vscode-main` branch still shows the older
`app?.log.debug(...)` call; the deployed release is authoritative.

## Incident delta

Baseline total **54** → **57**. The `TRANSITION` count stayed at **46** across
every check, so no other producer was involved and no historical row was
altered. `recovered_at` transitions below are lifecycle-driven, not manual.

| # | incident id | job card | deadline_at | breached_at | recorded_at | recovered_at |
|---|---|---|---|---|---|---|
| 1 | `2fa51c44-82f7-4999-88b0-b898ea5e10a2` | `318903db-7a97-4719-b79d-2ff8f07445c9` | `08:30:00.001+02` | `08:30:00.001+02` | `08:48:38.764424+02` | `09:21:37.91+02` |
| 2 | `18b01b4a-ef08-4a30-b1a2-485d2e59f6e9` | `06763e62-6f47-4863-a7a1-d323726eb503` | `09:21:00.001+02` | `09:21:00.001+02` | `09:21:39.034371+02` | — |
| 3 | `0554b5f8-818d-4598-bca5-8529e5951c73` | `dee3bb72-9813-4cb2-b641-a5adfe926ffb` | `09:28:00.001+02` | `09:28:50.594+02` | `09:29:39.095349+02` | — |

All three rows are `delay_type=LATE_SUBMISSION`, `episode_no=1`,
`accountable_role=STAFF`, `accountable_source=ASSIGNMENT_AT_BREACH`,
`source=SCANNER`. Timestamps are shown in the zone the database session
reported (`+02`); subtract two hours for UTC.

Validity: all three **VALID**.

- Incident 1 was the single candidate predicted by the pre-activation
  discovery count and was materialized on the first tick, `764 ms` after `T0`.
  The owning job was `IN_PROGRESS` / `SALES_MEETING` with
  `scheduled_ends_at=08:30:00+02`; the independently recomputed
  `COALESCE(scheduled_ends_at, …, (due_date+1)::timestamp AT TIME ZONE tz) + 1 ms`
  equals the stored `deadline_at` exactly.
- Incident 2 was materialized on the tick at `09:21:39.029+02`, with the same
  exact deadline match.
- Incident 3 is a `GENERAL_TASK` with no `scheduled_ends_at`. Its
  `breached_at` (`09:28:50.594+02`) is **later** than its `deadline_at`
  (`09:28:00.001+02`) by `50.593 s`, and equals the job's `started_at`. This is
  the documented rule, not a drift: `submissionBreachAt` is
  `max(nominalFirstLateAt, episodeActivationAt, revisionEffectiveAt)`, so a
  breach can never be dated before the episode that created the obligation was
  activated. The stored `deadline_at` still matches the recomputed renderer.
- Incident 1 was subsequently **recovered** at `09:21:37.91+02` and its job is
  now `COMPLETED`, which exercises the OVR-2 recovery contract against a
  scanner-produced row in production for the first time.

No personal data is recorded here; the identifiers above are opaque internal
UUIDs.

## Kernel and memory evidence

- Kernel journal for the window (`journalctl -k`, `133` lines from
  `09:48:46` to `10:32:44 +03`) contains only `[UFW BLOCK]` firewall entries.
  `grep -Ei 'oom|out of memory|killed process|memory cgroup'` returned **no
  matches**, as did the same grep over the full `dmesg` ring buffer.
- `/proc/vmstat` `oom_kill = 0` (cumulative since boot).
- The service cgroup `/system.slice/servora-med.service` reports
  `memory.events`: `low 0`, `high 0`, `max 0`, `oom 0`, `oom_kill 0`,
  `oom_group_kill 0` — direct cgroup-level evidence for this unit.
- PSI memory totals since boot: `some total=287500` µs, `full total=271261` µs,
  with `avg10/avg60/avg300` all `0.00`.
- Service journal since `T0`: `0` lines at `"level":(40|50|60)`, `0` scanner
  failure lines, `0` HTTP 5xx responses.

## Guards honoured

- No deploy: `releaseSha` and `/opt/servora-med/current` unchanged; releases
  directory mtime unchanged.
- No migration: `HEALTH_SCHEMA_VERSION=050_overdue_incident_scanner_source`
  unchanged.
- No source change; no manual `runOnce()`; no synthetic incident; no manual
  incident deletion or rewriting; all 54 baseline incident rows remained
  present.
- No lifecycle mutation for testing: live lifecycle reservations = `0`.
- No repeated restarts: exactly one `Started servora-med.service` line and one
  `Shutting down` line in the window.
- Unrelated production configuration unchanged: the environment diff proves a
  single added key, and no other unit was started, stopped, restarted or
  reloaded.

## Rollback

Rollback was **not** required and was **not** executed. The byte-exact baseline
backup listed under [Environment mutation](#environment-mutation) remains
available, and restoring it plus a single recovery restart would return the
scanner to its pre-activation effective-disabled state. Incident rows produced
during the activation are legitimate history and must not be removed to
simulate a rollback.

## Current operational status

OVR-3 is **enabled in production** following a successful bounded second
activation. Production remains on release `1ff6eef...`.

Do not describe OVR-3 as "scanner OFF", "disabled" or "rollout paused" any
more. Those statements were accurate for the `20de90c` and `1ff6eef` releases at
the time they were written and remain accurate as history for those releases,
but the current operational state is **scanner enabled after a successful
bounded second activation**.

Open follow-ups, none of which block the enabled state:

- The per-iteration report is logged at `info` level. Once monitoring
  confidence is established, either return it to `debug` or replace it with a
  bounded liveness signal, per the intent already written in the deployed
  comment.
- During the second-activation preflight, `LATE_START` had zero **new**
  discoverable candidates because seven `SCANNER / LATE_START` incidents from
  the first production activation already satisfied the convergence guard.
  `LATE_START` therefore **does** have production evidence; the zero observed
  here is convergence, not absence of exercise. `APPROVAL_WAIT` still has no
  observed production candidate/incident evidence and remains covered only by
  tests so far; any deliberate production exercise of it would require its own
  bounded mandate.
- Recovery of the remaining open scanner incidents is owned by ordinary
  lifecycle actions; no manual recovery should be performed.
