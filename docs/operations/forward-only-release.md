# Forward-only `060 -> hotfix release` transition (Issue #369)

Status: **pure contract + root host adapter implemented and targeted-tested;
final delta needs independent confirmation; not host-accepted or production-ready.**

This document defines the transition that follows the completed emergency
restart-policy handoff. It is **not** a deployment authorization and grants no
release authority. Production execution requires its own root authorization,
host acceptance, exact-main Local CI and a real observation window.

## 1. Why the R4 controller is not reused

`deployment-controller.mjs` / `deployment-attempt.mjs` implement the **first
cutover** contract, not a release-to-release transition. Reusing them would
silently re-open assumptions that no longer hold:

| R4 first-cutover assumption | Current reality |
| --- | --- |
| OLD release is the installed legacy artifact and DB is 055 | OLD is the live TARGET `f5f87d4…` on DB **060** |
| A migration 055→060 is part of the attempt | `060 -> 060`, migration-free |
| Admission needs a 3,600-second window (1,800 observation + 1,800 transition) because migrations may overrun | No migration; the observation window is the only long phase |
| `activation.block` + `Restart=no` drop-in fence the app | Normal `Restart=on-failure`; no barrier, no drop-in, no permit |
| Owner `active.json` is created by R4 admission | R4 owner was **retired** by the emergency handoff |
| Start budget 2/2 is consumed by OLD/TARGET activation | New transition needs its own bounded start budget |
| Approval binds `oldCatalog`/`targetCatalog` with migration SQL hashes | No migration; the catalogs must be **identical** |
| Terminal `COMPLETED` belongs to the R4 attempt | The R4 parent is **never** completed; the new release has its own acceptance |

Reusing those modules would also make it possible to publish a second active
owner under the old directory, which the emergency receipt explicitly forbids.

## 2. Architecture

Pure contract module: `ops/scripts/forward-transition.mjs`.
Host adapter: `ops/scripts/forward-host.mjs`, with separate orchestration,
durable storage, evidence validation and unprivileged DB probe modules.
See [adapter boundaries and targeted evidence](forward-only-host-adapter-targeted.md).

```
emergency receipt (sealed, read-only)
        |
        v
assertEmergencySupersession  -> PARENT_ATTEMPT_SUPERSESSION
        |                        SUPERSEDED_BY_EMERGENCY_HANDOFF
        |                        parentAttemptCompleted: false
        |                        grantsReleaseAuthority: false
        v
forward authorization (new, one-use, root-only)
        |
        v
append-only journal: INTENT -> ... -> ACCEPTED
        |
        v
FORWARD_RELEASE_ACCEPTED (this release only)
```

The contract never mutates the sealed R4 approval, profile, checkpoints,
backups, emergency journal or receipt. The parent directory is read-only input.

## 3. Receipt -> new owner binding

The new owner is **not** derived from the receipt; the receipt only proves the
parent is closed. All of the following must match before `INTENT`:

- `disposition = SUPERSEDED_BY_EMERGENCY_HANDOFF`;
- `parentAttemptCompleted = false` and `grantsReleaseAuthority = false`
  (a receipt claiming either is refused);
- parent attempt id, approval digest, profile digest, checkpoint sequence and
  checkpoint digest;
- emergency authorization id, emergency journal head and receipt file digest.

A different emergency authorization, a re-sealed receipt, or a receipt whose
parent checkpoint moved is rejected. The receipt alone never authorizes a
release: a new one-use authorization binding the exact OLD release, the exact
TARGET release, the CI manifest, the DB identity and the 060 catalog is
required.

## 4. `060 -> 060` migration-free flow

Phases (append-only, one durable record per step):

```text
INTENT
PREFLIGHT_PASSED
BACKUP_INTENT
PREDEPLOY_BACKUP_PASSED
STOP_INTENT
OLD_STOPPED
ACTIVATE_INTENT
TARGET_ACTIVATED
HEALTH_PASSED
SMOKE_PASSED
POSTDEPLOY_BACKUP_INTENT
POSTDEPLOY_BACKUP_PASSED
OBSERVATION_INTENT
OBSERVATION_STARTED
OBSERVATION_PASSED
ACCEPTED
```

Each mutation is preceded by a durable intent record — `BACKUP_INTENT`,
`STOP_INTENT`, `ACTIVATE_INTENT`, `POSTDEPLOY_BACKUP_INTENT`,
`OBSERVATION_INTENT` — so a crash between intent and effect is resumed
deterministically by re-observing live state and recording the completed step,
never by repeating it. `ACCEPTED` is not a normal event: it is only produced by
`sealForwardAcceptance()` from a durable `OBSERVATION_PASSED` record, and the
journal itself refuses a forged or interrupted observation proof.

Migration rules:

- `old.catalog` and `target.catalog` must be **identical**;
- any pending target version returns `MIGRATION_REQUIRED` and aborts;
- `migration.allowed`, `migration.required` and `authorizedMigrations` are
  structurally fixed at `false/false/[]`; widening them is a validation error;
- `migrationPerformed` is `false` in every journal record and cannot be
  produced otherwise.

A future migration is a separate design, a separate authorization and a
separate review.

## 5. Restart, crash and reboot model

The implementation **does not preserve `Restart=on-failure` throughout the
transition**. The previous design aspiration conflicts with bounded activation:
systemd 255 automatic restarts skip `ConditionPathExists`. The owner-authorized
adapter phase therefore uses a separate, narrow forward guard and budget
drop-in. The sealed R4 unit/profile/helpers and recovery drop-in are untouched.

`STOP_INTENT` precedes installing the forward barrier, `ExecStartPre` gate and
temporary `Restart=no`. A fully stopped service, empty cgroup and disappearance
of OLD's exact PID/start time precede environment/pointer alignment. Every
TARGET activation reserves a durable `START_INTENT` slot; `ExecStartPre` must
exclusively consume it before candidate code executes. A consumed or ambiguous
slot is never started again, including after reboot. This cut does not use a
second slot as an automatic retry, even when a grant permits two.

| Window | Behaviour | Rationale |
| --- | --- | --- |
| Preflight, predeploy backup | OLD retains normal restart protection; exact admission identity must remain stable | No stop or pointer mutation before durable intent |
| `STOP_INTENT -> OLD_STOPPED` | Forward gate and temporary `Restart=no`, then controlled stop and empty-cgroup proof | No stale auto-restart can launch the wrong release after alignment |
| `ACTIVATE_INTENT` | Exact environment/pointer alignment, durable slot, one-use gate consumption, bounded identity discovery | Unknown outcomes never cause another start |
| After `TARGET_ACTIVATED` through observation | Forward guard remains; crashes fail closed with the slot retained | Availability tradeoff is explicit; no uncounted candidate start |
| Observation | A restart, PID change or boot change **invalidates** the observation | Acceptance cannot be claimed across a process discontinuity |
| Reboot during observation | `OBSERVATION_STARTED` without a completed proof stops the run; a new attempt is required | No reboot-tolerant observation is claimed |
| `OBSERVATION_PASSED -> ACCEPTED` | Restore `on-failure` while the start gate remains closed; revalidate proof, health and PID before seal | Automatic restart still cannot bypass the slot |
| Accepted terminal handback | Remove the gate, reload and prove normal policy, remove barrier, then retire owner | Same deployment's durable acceptance authorizes release of its guards |

If the controller or accepted process crashes in that last window, `finish`
can release the accepted guards before demanding current runtime health. Normal
startup of that already accepted release is runtime handback, not a reset or
reuse of deployment activation slots. Current health/schema/backup checks still
gate owner retirement. Historical accepted backup receipts retain their bytes;
they do not become fresh new-boot observation evidence.

There is **no automatic rollback**. A failed transition records the last safe
phase and stops; an operator decides between completing forward and an
explicitly authorized recovery. A rollback that rewrites the release pointer
and DB identity automatically is forbidden.

An interrupted observation with no sealed result is terminally blocked for this
grant; it cannot be restarted, renamed successful, silently unfenced, or adopted
by a new owner. A separate failed-attempt recovery authorization/closure contract
is still required before production readiness. There is no unbounded controller
wait, but the safety guards intentionally persist on failure. This limitation
must not be described as solved normal restart availability.

## 6. Authorization and artifact contract

One root-owned, one-use authorization
(`FORWARD_TRANSITION_AUTHORIZATION`, scope `FORWARD_ONLY_RELEASE_TRANSITION`)
binds:

- parent: attempt, approval, profile, checkpoint, emergency authorization,
  emergency journal head, receipt digest, disposition;
- OLD: release SHA, artifact digest, schema head, full catalog;
- TARGET: release SHA, tree SHA, artifact digest, **CI manifest digest**,
  schema head, full catalog;
- host: machine id, database cluster/name/OID/role/host/port;
- budgets: at most two starts, exactly one observation attempt;
- fixed action and forbidden lists.

Issuance requires the app to be running under `Restart=on-failure`, the OLD
release to be live, no active owner of either generation, an identical catalog
and an open time window (maximum 24 hours). The grant is consumed at `INTENT`;
resumption afterwards is bounded by the sealed journal, not by the wall clock.

Acceptance (`FORWARD_RELEASE_ACCEPTED`) requires:

- every step true, `migrationPerformed = false`;
- an uninterrupted observation of at least 1,800 seconds and 60 samples;
- one PID, start-time and boot id at start and end;
- the observation recorded durably before the terminal seal.

`verifyForwardAcceptance()` returns `grantsReleaseAuthority: false`: the
acceptance is evidence for this exact release, not a standing deployment
authority and not `PRODUCTION_GO`.

## 7. Targeted test coverage

`ops/tests/forward-transition.test.mjs` (29 tests): foreign/completed parent,
wrong emergency receipt, changed checkpoint, wrong schema head, wrong artifact
and tree, wrong CI manifest, foreign owner, missing authorization, migration
without authority, failed activation, failed pre/post backup, PID/boot change
during observation, short or forged observation, early acceptance, direct
`ACCEPTED`, journal tamper/sequence gaps, and the migration-free happy path.

## 8. Not yet done

- Full real Ubuntu/systemd 255 host acceptance (targeted fixture tests are separate).
- Exact-main Local CI for the final head.
- Real 1,800-second observation.
- Any production authorization, deployment, migration or restart.

Until those exist: `HOST_ACCEPTANCE=NOT_RUN`, `FULL_LOCAL_CI=NOT_RUN`,
`PRODUCTION_DEPLOYMENT=NOT_AUTHORIZED`, `R4_ACCEPTANCE=NOT_ACCEPTED`,
`PRODUCTION_GO=false`.
