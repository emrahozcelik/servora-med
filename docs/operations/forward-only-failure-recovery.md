# Forward-only failure recovery — Issue #369

Owner authorization: 2026-11-02, source implementation and disposable targeted
tests only. Production remains unauthorized. This contract does not change R4
history, TT-A quality, DB060, migration prohibition or release acceptance.

## Separate authority

`recover` requires a new root:root 0600, single-use
`FORWARD_FAILURE_RECOVERY_AUTHORIZATION` at the fixed attempt-local
`recovery-authorization.json`. It binds the original grant digest (therefore its
OLD/TARGET/artifact/CI/DB/catalog/emergency bindings), exact deployment journal
head, installed tool hash and a read-only host snapshot digest. Its admission
window is at most one hour. It is consumed by its own durable recovery INTENT;
crash resume uses that sealed binding, never a renewed expiry or start budget.
Admission also requires the exact boot and an unexpired, at-most-one-hour
monotonic uptime window. UNKNOWN Trusted Time or a rolled-back UTC clock cannot
extend that window. The initial uptime is durably recorded with admission.
The grant explicitly includes `onFailure=CLOSE_FENCED`: if the healthy process
is lost during restoration, a durable FALLBACK_INTENT can only narrow authority
to fencing/quiescence. It cannot retry startup or release the guards. Unknown
processes stay untouched. Artifact/DB/owner/journal drift still fails closed;
it is not treated as an application failure or permission to repair evidence.
No production issuer or arbitrary path/command argument is added.

The original deployment journal is frozen at recovery admission. A separate
append-only, hash-chained recovery journal binds its head. Any recovery INTENT,
including interrupted publication, prevents the old deployment from continuing.
`recovery-status` reads evidence without repairing files or reloading systemd.

## Outcomes

| State | Explicit root-approved mode | Allowed effects | Forbidden effects / outcome |
| --- | --- | --- | --- |
| Pre-stop failure; OLD pointer/env/runtime unchanged and healthy | `RELEASE_UNCHANGED_OLD` | Verify the exact OLD artifact, DB/schema and existing normal policy; seal NOT_ACCEPTED; retire the failed attempt owner | No stop/start, gate/policy/pointer/env change; `FORWARD_UNCHANGED_OLD_RELEASED_NOT_ACCEPTED` |
| TARGET healthy; observation interrupted/unverified | `RESTORE_HEALTHY_TARGET` | Recheck exact original TARGET PID/start-time/boot/invocation, artifact, DB060, schema and pointer/env; restore on-failure behind closed gate; seal separate NOT_ACCEPTED receipt; remove guards and retire owner | No start, stop, rollback, observation retry or deployment acceptance; `FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED` |
| TARGET down, unhealthy or identity uncertain | `CLOSE_FENCED` | Ensure owned gate/barrier and Restart=no; stop only an exactly identified owned OLD/TARGET process; preserve uncertain processes; seal explicit manual-intervention custody | No start, rollback, pointer/env change, owner retirement or acceptance; `FORWARD_FAILURE_FENCED_NOT_ACCEPTED` |
| Activation incomplete; OLD/TARGET pointer/env differ | `CLOSE_FENCED` | Preserve exact alignment evidence and used slots, fence further starts, quiesce only a known process | No inferred activation, repair, rollback or budget reset; same fenced NOT_ACCEPTED outcome |

Recovery cannot be used after ACCEPTED; accepted runtime handback uses `finish`.
The unchanged-OLD mode is only available before any STOP_INTENT or activation
slot; it prevents a failed predeploy backup from stranding an otherwise healthy
OLD owner. It cannot undo a cutover effect. Other modes require a durable
STOP_INTENT and their own separate root approval.
Fenced closure retains the canonical owner as explicit recovery custody. It is a
finite, inspectable terminal result, not a waiting controller. Further process
start/release repair needs a separately reviewed root authorization; this grant
cannot provide it. Healthy restoration is available without fabricating a
successful observation. A changed or rebooted TARGET cannot use that path.

Backup HTTP503 and Trusted Time UNKNOWN stay failed/unknown in the recovery
snapshot and receipt. They veto release acceptance. They do not become PASS and
cannot supply elapsed observation time. A root operator may explicitly restore
restart policy for the *same healthy application process* while acknowledging
those exact evidence limitations in the snapshot-bound recovery approval.
Completed pre/post backup receipts must both remain intact for healthy TARGET
restoration. An absent or unfinished receipt is NOT_COMPLETED, never VALID;
unchanged-OLD closure does not claim that the failed new backup succeeded.

## Durable ordering

Healthy: INTENT → POLICY_INTENT/DONE (gate closed) → SEAL_INTENT/DONE →
HANDOFF_INTENT/DONE (no process start) → RETIRE_INTENT/DONE → FINAL.

Fenced: INTENT → FENCE_INTENT/DONE → QUIESCE_INTENT/DONE → SEAL_INTENT/DONE → FINAL.

Unchanged OLD: INTENT → SEAL_INTENT/DONE → RETIRE_INTENT/DONE → FINAL, without any
service/pointer/environment mutation. Its already authorized OLD runtime keeps
normal restart protection. A temporary OLD failure grants no start; the operator
can resume owner release after normal runtime recovery.
Here “unchanged” means release/alignment/policy, not an observation continuity
claim across an OLD restart that its existing policy already authorized.
The DB probe/checker comes from the verified TARGET artifact for both releases:
their catalogs are structurally identical 060 and the live PG17 exact-catalog
guard remains held. OLD process/release identity and health are checked
separately. A legacy artifact need not acquire a new checker file; no sealed OLD
bytes or schema failures are rewritten. The TARGET checker must actually pass.

Every mutation has a durable intent. A sealed recovery receipt must exist before
guard removal. Each resumed effect re-observes only its exact intended outcome;
missing/partial/foreign evidence fails closed. Recovery never writes ACCEPTED,
COMPLETED, PRODUCTION_GO or the old R4/emergency files. Start slots remain the
original immutable START_INTENT records and exclusive slot receipts.

## Verification status

Implementation and targeted RED/GREEN evidence are recorded in the
[final safety report](forward-only-final-safety-remediation.md): 176 pure tests,
18 named systemd/PG17 scenarios and two real reboots passed incrementally.
Accepted checkpoints are synthetic terminal-I/O fixtures, never genuine
observation evidence. No full host acceptance, full Local CI or real
1800-second observation ran. Independent review remains open under the owner's
explicit no-subagent instruction; full host acceptance is STOP.
