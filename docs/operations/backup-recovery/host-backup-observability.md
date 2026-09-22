# Host-side backup observability contract

```text
Date: 2026-09-07
Gate: OPS-BACKUP-OBS-1
Status: accepted design; implemented by OPS_BACKUP_OBS_1_IMPLEMENTATION (see §8)
Decision record: DECISIONS.md -> OPS-004
```

## 1. Current production boundary

The accepted production path is:

```text
servora-med-backup.timer (daily 02:30 UTC, Persistent=true)
  -> servora-med-backup.service
  -> ops/scripts/backup-postgres.sh
```

The current `/api/health` backup projection is not evidence for that path. It
reads the disabled BR5 application worker's PostgreSQL state:

```text
GET /api/health
  -> backup health readiness adapter
  -> backup_runs (mixed generic + BR5/R2 concepts)
  -> backup_worker_state (BR5-specific scheduler/lease state)
```

Until the implementation gate is completed, `status=unavailable` and
`latestRunStatus=null` remain expected and must not be "fixed" by enabling BR5.

## 2. Chosen architecture

Use a failure-atomic host-side state artifact (Option A) as the active host
provider's observation source.

| Responsibility | Contract |
|---|---|
| SSOT | `/var/lib/servora-med-backup/observation-v1.json` |
| Writer | `backup-postgres.sh`, through one narrow atomic writer/helper |
| Health reader | host backup adapter behind the existing health readiness port |
| Alert reader | `operator-alerting.mjs` in future `OPS-BACKUP-ALERT-1` |
| Directory | `servora-med:servora-med`, mode `0700` |
| State file | `servora-med:servora-med`, mode `0600` |
| Backup artifact directory | remains `/var/backups/servora-med` at `0700`; never loosened for health |

The versioned state must represent at least:

- schema version;
- latest attempt start/completion, result and safe failure class;
- latest successful local artifact timestamp and checksum-verification result;
- trigger class when known (`scheduled`, `predeploy`, `postdeploy`, `manual`);
- last scheduled attempt and last scheduled verified success.

Paths, artifact filenames, database names, hostnames, credentials, remote object
keys and raw errors are operator-internal and must never be projected publicly.

## 3. Failure-atomic state rules

The writer creates a restrictive temporary file in the state directory, flushes
and closes it, then renames it atomically over the prior state on the same
filesystem. A partial file is never readable as canonical state.

State semantics are fail-closed:

| Failure point | Required observation behavior |
|---|---|
| `pg_dump` fails | latest attempt becomes failed; prior successful restore point remains intact |
| checksum creation/verification fails | no new successful restore point is recorded |
| artifact atomic rename fails | no new successful restore point is recorded |
| process killed mid-run | stale/incomplete attempt cannot become success; prior success remains |
| disk full/state write fails | backup command fails visibly; previous canonical state remains |
| future offsite hook fails | local verified success remains local success; offsite result is a separate dimension |

Writer failure must never silently convert a run to healthy. The implementation
gate must define stable, secret-safe failure classes and test interrupted writes.

## 4. Health and freshness semantics

Public backup health means:

> Does the active production backup provider expose a sufficiently recent,
> checksum-verified local restore point?

The minimal public fields are a stable status plus non-sensitive timestamps,
for example latest attempt, latest successful verified backup and observation
time. The stable status vocabulary should distinguish at least:

- `healthy`: verified local success age is <= 26 hours;
- `stale`: a verified local success exists but is older than 26 hours;
- `failed`: latest attempt failed, while prior-success timestamp remains visible;
- `unavailable`: state cannot be read or validated;
- `disabled`: the selected mechanism is intentionally disabled.

"Never run" is not `disabled`; it is unavailable/not-yet-observed until the
first accepted execution. "Unconfigured" is not a failed backup run. Exact API
names remain an additive implementation decision, but these distinctions must
not be collapsed into a misleading healthy state.

Canonical freshness rule:

```text
latest local artifact finalized
AND checksum sidecar finalized
AND checksum verified
AND timestamp is not in the future
AND age <= 26 hours
```

Any valid host backup may satisfy recoverability freshness:

| Trigger | Counts for local freshness | Counts for schedule heartbeat |
|---|---:|---:|
| scheduled timer | yes | yes |
| predeploy | yes | no |
| postdeploy | yes | no |
| manual operator | yes | no |

## 5. Schedule heartbeat

Fresh data and scheduler liveness are independent. After the first natural
scheduled slot has been accepted, the schedule heartbeat requires:

```text
latest scheduled attempt = success
AND latest scheduled verified success age <= 26 hours
```

A deploy-created backup must not hide a broken timer. Public health may expose
only the safe aggregate/projection, while operator alerting must retain the
independent heartbeat diagnosis.

The first heartbeat baseline is established by:

```text
OPS_BACKUP_TIMER_1_FIRST_RUN_ACCEPTANCE
```

It proves a natural timer trigger, successful service, verified dump/sidecar and
the next scheduled trigger. It does not manually invoke the backup service.

## 6. Option disposition

| Option | Decision | Reason |
|---|---|---|
| A — host-side state artifact | chosen | precise trigger/failure evidence, atomic, scoped permissions, shared health/alert SSOT |
| B — directory/artifact observation | rejected as SSOT | filename/retention coupling, incomplete-artifact ambiguity and checksum cost |
| C — write host runs to PostgreSQL | rejected | circular dependency on the backed-up DB, credentials/migration cost and BR5 semantic mismatch |
| D — alerting owns truth | rejected | creates a second freshness definition and leaves public health misleading |
| E — unified provider abstraction | deferred to a thin adapter boundary | useful only when a second provider is enabled; a generalized framework is premature |

## 7. Implementation and program boundaries

The smallest next slice is `OPS_BACKUP_OBS_1_IMPLEMENTATION`:

- define and test the versioned observation schema/helper;
- make `backup-postgres.sh` publish attempt and verified-success state atomically;
- add the deliberately scoped state directory and read-only application access;
- add a host provider reader and safe additive health projection;
- preserve BR5 disabled state and existing backup API contract.

It does not install alerting, configure offsite storage, perform a restore
rehearsal, enable BR5, deploy, or run a manual production backup. Those remain
independent gates:

```text
OPS-BACKUP-ALERT-1
OPS-BACKUP-OFFSITE-1
OPS-BACKUP-RESTORE-1
```

Expected implementation assessment (recorded before implementation):

```text
MIGRATION_REQUIRED: NO
API_CONTRACT_CHANGE: ADDITIVE
NEW_CONFIG_REQUIRED: YES
SYSTEMD_CHANGE_REQUIRED: YES
BACKUP_SCRIPT_CHANGE_REQUIRED: YES
HEALTH_MODULE_CHANGE_REQUIRED: YES
ALERTING_CHANGE_REQUIRED: FUTURE_GATE
```

## 8. Implementation status (`OPS_BACKUP_OBS_1_IMPLEMENTATION`)

Sections 1–7 above remain the accepted design and are unchanged. This section
records what was actually built against it.

Realized artefacts:

| Responsibility | Implementation |
|---|---|
| SSOT | `/var/lib/servora-med-backup/observation-v1.json`, `schemaVersion: 1` |
| Writer helper | `ops/scripts/backup-observation.sh` (the only writer) |
| Writer caller | `ops/scripts/backup-postgres.sh` via `BACKUP_OBSERVATION_PATH` |
| State directory | `StateDirectory=servora-med-backup`, `StateDirectoryMode=0700` |
| Health reader | `server/src/modules/health/host-backup-observation.ts` |
| Shared evaluator | `server/src/modules/health/backup-freshness.ts` |
| Writer contract proof | `ops/ci/verify-backup-observation.sh` |
| Server contract proof | `server/tests/backup-observation.test.ts` |

Notes on the realized contract:

- The document is deliberately **flat** (one scalar per top-level key, fixed key
  order) so the pure-bash writer can carry prior evidence forward without a JSON
  parser and without a new runtime dependency, while remaining one versioned JSON
  document for readers.
- The failure-class vocabulary is a **closed set on both sides**
  (`DUMP_FAILED`, `CHECKSUM_FAILED`, `ARTIFACT_FINALIZE_FAILED`,
  `OFFSITE_COPY_FAILED`, `OBSERVATION_WRITE_FAILED`, `UNKNOWN`). The writer
  refuses to publish anything else and the reader treats anything else as
  untrusted. A test asserts the shell and TypeScript lists never drift, so no
  free-form text — including raw stderr — can enter the state.
- Both sides validate instants with a range-limited shape check **plus** an epoch
  round-trip, so calendar-impossible values such as `2026-02-30T00:00:00Z` are
  rejected rather than silently normalized.
- Trigger provenance is an explicit `--trigger` argument from four distinct
  units. The post-deploy and manual classes have their own units so they cannot
  be recorded as `scheduled`.
- The compatibility aggregate `status: ok | unavailable` keeps its pre-existing
  meaning (`ok` only for the fully healthy provider state); the accepted
  vocabulary and provider detail travel in additive fields.
- `BACKUP_PROVIDER` selects the active provider explicitly. An unset value
  preserves the previously wired application-side projection, so deploying this
  slice activates nothing by itself.

Actual assessment (matches the expectation above):

```text
MIGRATION_REQUIRED: NO
API_CONTRACT_CHANGE: ADDITIVE
NEW_CONFIG_REQUIRED: YES
SYSTEMD_CHANGE_REQUIRED: YES
BACKUP_SCRIPT_CHANGE_REQUIRED: YES
HEALTH_MODULE_CHANGE_REQUIRED: YES
ALERTING_CHANGE_REQUIRED: FUTURE_GATE
```

Explicitly **not** done by this slice — do not read this document as claiming
otherwise:

- operator alerting is not installed and consumes nothing yet;
- no offsite/R2 cutover; BR5 and `BACKUP_WORKER_ENABLED` remain disabled;
- no restore rehearsal, no real-R2 DR acceptance;
- no production activation: `BACKUP_PROVIDER` is unactivated in the committed
  env examples, no production env was modified and no production service was
  restarted or manually backed up;
- `OPS_BACKUP_TIMER_1_FIRST_RUN_ACCEPTANCE` still has to prove the first natural
  timer chain.

`DECISIONS.md` → OPS-004 remains the unchanged decision record; this section
records implementation state only.

