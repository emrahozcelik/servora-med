# Emergency restart-policy handoff (Issue #369)

Status: **implemented and host-accepted; not executed in production.**

This runbook describes the separately authorized mechanism that returns the
fenced R4 production app to normal `Restart=on-failure` protection **without
restarting the app** and **without claiming R4 acceptance**.

It does not replace the R4 observation. It cannot produce
`OBSERVATION_PASSED`, `ACCEPTED`, `COMPLETED` or `PRODUCTION_GO`.

## 1. What it may and may not do

Allowed (exact action list bound in the authorization):

- `remove_barrier` — unlink the owned `activation.block`;
- `restore_restart_on_failure` — unlink the owned recovery drop-in and
  `daemon-reload`, so the base unit's `Restart=on-failure` becomes effective;
- `retire_owner` — unlink the sealed `active.json` owner after the barrier and
  policy steps are durable.

Forbidden (bound in the authorization; the validator rejects any widening):

- observation/acceptance/completion;
- migration, restore or schema change;
- release/pointer/artifact change;
- starting, stopping or restarting the app;
- resetting the start budget;
- editing the sealed approval, profile, checkpoint chain or backups.

The terminal record is an operational status, not R4 acceptance:

```json
{
  "operationalStatus": "EMERGENCY_RESTART_POLICY_RESTORED",
  "r4TerminalState": "HEALTH_PASSED_FENCED",
  "r4Acceptance": "NOT_ACCEPTED",
  "observationPassed": false,
  "parentAttemptCompleted": false,
  "futureReleaseAuthority": false,
  "handoff": {
    "processContinuity": "PRESERVED",
    "rebootObservationSha256": null
  }
}
```

A reboot during an interrupted handoff necessarily replaces the process. The
tool never starts it; after an operator-authorized start it records a sealed
`reboot.json` observation (`previous`/`current` boot and PID/start-time) and the
receipt says `processContinuity: "REBOOT_OBSERVED"`. A second restart in the
same boot is still a hard stop.

`futureReleaseAuthority: false` is deliberate: the receipt lets a future
forward-only transition **recognize and supersede** the old owner. It does not
authorize the new release.

## 2. Root authorization

One file, one use, root-only:

`/var/lib/servora-med/deploy/emergency/authorization.json` (root:root 0600,
single link, canonical JSON).

Bound fields:

- authorization id, issue/expiry (maximum 60 minutes), `maxUses: 1`, reason,
  fixed scope `EMERGENCY_RESTART_POLICY_HANDOFF`;
- exact parent attempt, approval sha256, profile sha256, checkpoint sequence
  and checkpoint sha256, phase, `migrationCommitted`, approved schema head,
  start budget and last start result;
- exact host machine-id, database cluster id/name/oid/role/host/port, release
  sha, approved artifact sha256, installed time-module and chrony-config hashes;
- sealed pre/post backup receipt hashes;
- the installed emergency tool artifact sha256.

A different authorization cannot adopt an existing journal. A completed
handoff cannot be re-authorized; a re-run is an idempotent no-op.

The authorization is written by:

```bash
/usr/local/libexec/servora-med-emergency/issue-emergency-handoff.mjs \
  --parent <attempt-uuid> --expires-minutes 45 \
  --reason R4_OBSERVATION_TRUSTED_TIME_BLOCKED
```

Issuance is read-only against deployment state. It refuses a non-terminal or
non-exact parent, a missing/corrupt backup, a wrong DB head, a foreign owner, a
live permit or any installed contract drift.

## 3. Tool artifact

Installed directory: `/usr/local/libexec/servora-med-emergency/` (root:root
0755; files 0644/0755). `manifest.json` seals the exact file list, modes and
sha256 values; the `artifactSha256` is recomputed from bytes and modes on every
run. Any drift, extra file, symlink or group-writable root refuses execution.

The artifact is a new, separate root tool. Existing sealed modules under
`/usr/local/libexec/servora-med/` are read-only imports; they are never
modified. This is required because the R4 profile binds their hashes.

## 4. Ordering: policy first, barrier second

```text
INTENT
  -> POLICY_INTENT       (durable before the unlink)
  -> POLICY_RESTORED     (daemon-reload + live Restart=on-failure re-read)
  -> BARRIER_INTENT      (durable before the unlink)
  -> BARRIER_REMOVED
  -> OWNER_INTENT
  -> OWNER_RETIRED
  -> HANDOFF_COMPLETE
  -> receipt.json
```

This is the crash-safe order on systemd 255. The restart policy is effective
before the barrier is touched, so a crash at any point after `POLICY_RESTORED`
is automatically recovered. The reverse order would leave a window where the
app still has `Restart=no`.

The app is never restarted by the tool. PID and `/proc/<pid>/stat` start time
are captured at INTENT and must be identical before every subsequent step;
otherwise the tool stops.

## 5. Real systemd 255 contract

The production unit uses:

```ini
ConditionPathExists=|!/var/lib/servora-med/deploy/activation.block
ConditionPathExists=|/run/servora-med-recovery/start.permit
Restart=on-failure
```

`systemd.unit(5)` defines the `|` prefix as a **triggering condition**: the unit
starts if at least one triggering condition applies and all regular conditions
apply. These two lines are therefore OR, not AND:

| barrier | permit | start allowed |
| --- | --- | --- |
| absent | absent | yes |
| absent | present | yes |
| present | absent | no |
| present | present | yes |

Consequences, verified on real systemd 255 (`ops/tests/emergency-handoff-systemd-host.test.mjs`):

- A **manual** start or restart evaluates the conditions: with the barrier
  present and no permit, the unit is refused and stays inactive.
- An **automatic** `Restart=on-failure` job does **not** re-evaluate the
  conditions. With the barrier still present, a crash is restarted normally
  once `Restart=on-failure` is loaded.
- A **reboot** is a fresh start and does evaluate the conditions. The volatile
  permit is gone, so a durable barrier still blocks the boot start.
- Therefore the policy is restored first. That makes crash protection real
  immediately; removing the barrier afterwards only re-enables manual and
  post-reboot starts. The reverse order would leave a crash window with
  `Restart=no`, so the state machine refuses it.

## 6. Interruption and reboot matrix

| Interruption point | Durable state | Deterministic recovery |
| --- | --- | --- |
| before INTENT | no journal; runtime temp at most | orphan temp removed; retry |
| after INTENT | INTENT | re-observe; require pre-state |
| before barrier unlink | BARRIER_INTENT | unlink again |
| after barrier unlink, before record | BARRIER_INTENT, barrier gone | record BARRIER_REMOVED |
| after policy unlink, before reload | POLICY_INTENT, drop-in gone, `NeedDaemonReload=yes` | `daemon-reload` then record |
| after reload | POLICY_RESTORED candidate | re-read `Restart=on-failure` then record |
| before owner unlink | OWNER_INTENT | unlink again |
| after owner unlink, before record | OWNER_INTENT, owner gone | record OWNER_RETIRED |
| after HANDOFF_COMPLETE, before receipt | complete journal, no receipt | seal receipt |
| after receipt link before temp unlink | receipt nlink 2 | reconcile owned temp, verify receipt |

Reboot behavior:

- barrier still present after an interrupted run → **no start** (the permit is
  volatile and a boot is a fresh start); the runbook requires completing the
  handoff, not assuming success;
- a crash in the same boot after `POLICY_RESTORED` is automatically restarted
  even while the barrier remains;
- barrier removed and policy restored → normal boot start;
- owner absent with a complete receipt → the old R4 controller cannot resume;
  the receipt is the only supersession input.

The host lock (`/var/lib/servora-med/deploy/host.lock`, root:root 0600) is held
for the whole mutation. The tool re-executes itself under `flock` and verifies
the lock fd is actually held.

## 7. Live preconditions

Issuance and apply both require, before any mutation:

- app `active/running`, core `/api/health` 200 with the approved release sha;
- exact DB identity and exact approved migration catalog (service-UID guard,
  advisory lock, read-only);
- parent approval/profile/checkpoint chain byte-exact and canonical;
- exact release artifact marker, content manifest, retained archive, installed
  module equality and unit equality;
- barrier and owner bound to the same attempt/approval;
- permit absent, no foreign emergency owner;
- both sealed backups present with matching sha256;
- start budget exhausted (2/2), which the handoff never changes.

Any mismatch is a STOP with no mutation.

## 8. Owner continuity

The handoff retires `active.json` only after the barrier and policy are durable.
The R4 journal, approval, profile, checkpoints and backups remain byte-identical
and the old attempt is **not** COMPLETED.

A future `060 -> hotfix release` forward-only transition must:

1. require the sealed receipt (`verifyEmergencyHandoffReceipt`);
2. accept the parent only as `SUPERSEDED_BY_EMERGENCY_HANDOFF`, never COMPLETED;
3. require no active owner, no barrier, no permit and no recovery drop-in;
4. require normal `Restart=on-failure`;
5. acquire its own new root authorization, artifact/CI and observation.

`assertForwardTransitionEligible` implements these checks and returns a
supersession record with `grantsReleaseAuthority: false`.

## 9. Operator sequence (production, separate approval)

```bash
# 1. Read-only preflight (no mutation)
/usr/local/libexec/servora-med-emergency/emergency-handoff-host.mjs verify

# 2. Only after explicit production approval: issue the one-use authorization
/usr/local/libexec/servora-med-emergency/issue-emergency-handoff.mjs \
  --parent <attempt-uuid> --expires-minutes 30 --reason <reason>

# 3. Apply; the app PID must not change
/usr/local/libexec/servora-med-emergency/emergency-handoff-host.mjs apply

# 4. Read-only status
/usr/local/libexec/servora-med-emergency/emergency-handoff-host.mjs status
```

STOP, do not retry and do not hand-edit state, if any command returns a
non-zero status, the PID changes, health is not 200, a contract/hash mismatch
appears, a foreign owner/permit exists, or the receipt is not
`EMERGENCY_RESTART_POLICY_RESTORED` / `NOT_ACCEPTED`.

Production execution is **not** authorized by this document. It requires a
separate explicit operator approval for the artifact install, the one-use
authorization and the application window.

## 10. What still requires the forward-only project

The Trusted Time `LastRx` fix (PR #400) is not installed in production. The
collector remains hash-bound to the sealed R4 profile. A true R4 `COMPLETED`
and `PRODUCTION_GO=true` still require:

- a new release carrying the collector fix;
- new artifact/CI evidence;
- a new forward-only transition contract based on DB 060 and the current
  TARGET identity;
- a fresh, real 1800-second observation;
- a new root authorization and deployment window.
