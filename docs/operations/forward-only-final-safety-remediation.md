# Issue #369 — final safety remediation (2026-11-02)

Source baseline: `c81cbaf9cc4ea4d4744550ebdbdcdad4ce1327ca`; main baseline:
`5af00f7f34a8986c716fb3a9a881ef48c8740c85`. No production action or grant.
The [separate failure-recovery contract](forward-only-failure-recovery.md)
supersedes the earlier statement that failed observation has no recovery path.
The original pure transition and TT-A source/thresholds remain unchanged.

## Review scope and independence

The implementation agent directly reviewed final TT-A client/collector binding,
effective systemd/template/socket contracts, legacy import closure, root lock,
candidate dependency execution, deployment/recovery admission, start receipts,
both journals, backup receipts, observation proof, terminal handback and
reboot/retirement interactions. The previous APPROVE is not inherited.

The owner explicitly retained the no-subagent instruction and chose to leave
independent review open. **This is direct review, not independent review.**
`TT_A_FINAL_REVIEW=BLOCKED` and full host acceptance remains STOP until a separate
reviewer examines the final tree. No independent APPROVE is claimed here.

The referenced `ISSUE369_FORWARD_ONLY_DESIGN.tr.md` was not found in the local
repository/worktrees or retained tmp files. The available accepted pure module,
`forward-only-release.md`, c81 targeted report and the owner's new instructions
were used; no contents of the absent report are inferred.

| Severity | Finding and remediation | Evidence |
| --- | --- | --- |
| CRITICAL | None observed in direct review; independent confirmation outstanding | This statement is not an independent clearance |
| HIGH | Recovery admission previously left an armed deployment permit usable by the actual systemd gate. The gate now permanently vetoes any recovery publication before consuming a slot | FSAFE-09 real RED/GREEN |
| HIGH | Strict Node-only identity inspection prevented an operator from reaching recovery for an unknown executable. Recovery now reads unit identity separately; it cannot use that identity to authorize release startup or healthy restoration | FSAFE-11 real RED/GREEN; unknown executable stays untouched |
| HIGH | A process lost during healthy restoration could strand the separate recovery. The root grant explicitly authorizes only a narrowing fallback; durable FALLBACK_INTENT fences/quiesces and seals NOT_ACCEPTED | Pure RED/GREEN; FSAFE-10 |
| HIGH | UTC-only expiry could outlive its intended window while Trusted Time is UNKNOWN. Admission now also binds boot and an at-most-one-hour monotonic interval | Pure RED/GREEN; host grants use actual uptime |
| HIGH | A failed pre-stop backup could retain an active owner despite unchanged, normally protected OLD. A separately approved unchanged-OLD closure now retires only that owner, with no service mutation | Pure RED/GREEN; FSAFE-16 |
| MEDIUM | Environment baseline was checked only during alignment. Every static check now verifies it before loading candidate DB dependencies | Read-only hash verification; targeted denial |
| MEDIUM | Queued on-failure jobs can exist with MainPID=0. Fenced quiescence explicitly stops the unit and proves an empty cgroup before recording STOPPED | FSAFE-09/10 and reboot |
| MEDIUM | A missing/uncompleted new backup was initially labelled VALID by a vacuous completed-receipt check. It now stays NOT_COMPLETED; healthy TARGET restoration requires both completed receipts | FSAFE-16 reporting RED/GREEN; no failed backup becomes PASS |
| LOW | Crash injection initially fired twice across the journal's two directory fsyncs. The second application kill saw PID0 and ended its SSH process group. The test harness now injects once and rejects PID<1 | Diagnostic-only interrupted run retained; subsequent GREEN |
| LOW | An inherited object key used as an unknown mode produced a generic error before mutation. Explicit own-key mode validation now denies it at authorization intake | Pure RED/GREEN |

No source-level CRITICAL/HIGH finding above is intentionally deferred.
Independent review itself remains an acceptance blocker.

## Authority and state transitions

The recovery grant binds the original grant digest, original host-journal head,
tool manifest, host snapshot, UTC window and same-boot uptime window. The original
grant already binds exact OLD/TARGET, DB060/cluster, catalogs, artifacts, CI and
emergency supersession. A recovery journal freezes the original deployment;
even an already armed start permit becomes unusable. Start slots never reset.

Healthy restoration requires the original TARGET PID/start-time/boot/invocation,
exact pointer/environment, health/schema and intact completed backup receipts.
Backup503 and Trusted Time UNKNOWN remain explicit snapshot evidence. They do
not become PASS, observation time, ACCEPTED, COMPLETED or PRODUCTION_GO. The
separate operator approval can restore runtime restart policy while the failed
deployment remains permanently unaccepted.

Policy restoration occurs behind the closed gate. A separate sealed recovery
receipt precedes guard/barrier removal. Owner retirement occurs only after the
handback. A runtime failure can only narrow the explicitly approved authority to
fenced custody, never retry/start/rollback. Incomplete activation does not infer
pointer/environment repair. Unknown processes remain untouched.

Fenced closure is a finite, sealed NOT_ACCEPTED outcome with retained canonical
owner custody. Further startup or release repair requires new reviewed authority;
this operation cannot provide it. Old R4 parent/emergency bytes stay unchanged.
Before STOP_INTENT, unchanged-OLD closure can instead seal failure and release
the owner without touching service, policy, pointer or environment. It cannot
undo any cutover effect. Receipt `admittedAtUTC` is the admission time; the
chained SEAL_DONE timestamp records actual receipt publication.

## Interruption matrix

| Interruption / condition | Targeted coverage |
| --- | --- |
| Before / after OBSERVE_INTENT | FSAFE-02/03 |
| Observation process crash | FSAFE-04 |
| Real observation-phase reboot | Separate prepare/reboot/verify case |
| Trusted Time UNKNOWN | FSAFE-05 + proof/expiry regressions |
| Backup health503 | FSAFE-06; receipt keeps FAIL |
| Partial observation publication | FSAFE-07; invalid bytes retained, no acceptance |
| Mixed OLD pointer / TARGET environment | FSAFE-08; no inferred repair or start |
| Armed start permit after recovery admission | FSAFE-09; real ExecStartPre denial |
| Process crash during separate policy restoration | FSAFE-10; fenced fallback |
| Unknown executable | FSAFE-11; inspect/fence only |
| Recovery seal before guard removal / before owner retirement | FSAFE-12/13; readonly inspection and resume |
| Accepted terminal handback | FSAFE-14, synthetic accepted checkpoint with real same-process systemd operations |
| Accepted real reboot | Separate synthetic-checkpoint prepare/real reboot/verify case |
| Environment drift | FSAFE-15; read-only denial before candidate DB code |
| Pre-stop backup failure with unchanged OLD | FSAFE-16; owner-only closure |
| Crash after owner unlink and runtime process crash | FSAFE-17; ordinary policy recovers runtime, no deployment slot reset |
| Unchanged OLD with failing TARGET DB checker | FSAFE-18; actual failure denies closure, no schema PASS substitution |
| ACCEPTED before policy restoration | Structurally impossible: pure regression proves no acceptance when POLICY fails |
| POLICY_DONE / HANDOFF_INTENT/DONE / RETIRE_INTENT/DONE crashes | Pure synthetic terminal regressions |

Every host case checks start count, owner/barrier, effective Restart,
PID/start-time/boot and journal consistency as applicable. Accepted checkpoints
in this matrix are explicitly synthetic terminal-I/O fixtures. Their UTC offset
exists only in the hostname/root-guarded test preload, absent from the installed
tool. No host clock changes, real 1800s claim or genuine NTS evidence are involved.

## Verification and remaining gates

- Pure/regression set: **176/176 PASS** locally and on Linux Node22; includes
  adapter 32, recovery 19, unchanged pure forward 29 and restricted-reader 20.
- Disposable Linux/amd64, systemd255, PG17: **18/18 distinct named FSAFE
  scenarios PASS**, run incrementally with individual `--test-name-pattern`
  calls. Affected scenarios received focused RED/GREEN reruns. Individual
  host scenarios were capped at 270 seconds; no five-minute timed test ran.
- **Two real reboot cases PASS**: observation-phase reboot cannot start/reset a
  slot and closes fenced under a new grant; a synthetic accepted checkpoint
  hands back normal runtime after reboot while retaining the spent deployment
  slot. The latter is terminal-I/O evidence, not genuine observation acceptance.
- `node --check` (17 files), `bash -n` (two touched CI scripts),
  `git diff --check`: PASS.
- Final installed-tool manifest equals the final local module bytes:
  `f0a4ccb73dad81b20776c9dabf75bc0451b841f48816eef42ac9751adfee1227`.
  Runs span intermediate source revisions; this is **not exact-SHA full host
  acceptance**. The first frozen set and final manifest/log hashes are retained.
- Fixture closure: original OLD/environment/on-failure policy restored;
  owner/barrier/guards/permits absent; originally absent owned Time units removed;
  legacy seals unchanged. VM `servora-eh-20261101` returned to **Stopped** with
  disk and private raw evidence retained.

Intermediate RED/diagnostic failures are retained, not counted as successful
runs. One early FSAFE-09 attempt stopped at FENCE with
`FORWARD_HOST_OPERATION_FAILED`; its cause was not reproduced, and the focused
diagnostic and frozen-source reruns passed. The harness double-injection failure
and missing OLD checker were diagnosed separately and fixed with focused runs.

Full acceptance and full Local CI are NOT_RUN. No PR, push, merge, Actions or
production operation is part of this change.

Standard `npm ci` in the isolated worktree restored the missing build tools;
server and web builds passed without package/lockfile changes. These local
macOS builds do not claim Linux production artifact acceptance. Full server
tests were not run in this targeted phase.

Retained normal test logs live at
`/private/tmp/issue369-final-safety-20261102/`. Raw fixture grants/journals/dumps
stay private in the same disposable VM, including retained per-attempt copies
under `/var/lib/servora-forward-fixture/final-safety-retained/`. No raw-payload
export is performed. Production, sealed R4 history and unrelated resources stay
outside this work.

## Acceptance decision

**STOP for starting full host acceptance.** The remaining prerequisite is
independent review of the final TT-A/terminal/recovery tree, explicitly left open
by the owner. Direct review and targeted tests do not substitute for it.
Genuine NTS, real browser/service/artifact integration, the real 1800-second
observation, exact-source full host acceptance and exact-main Local CI remain
later release-acceptance work. Fenced custody intentionally grants no new start
or rollback; further startup/repair requires new reviewed root authority.

```text
FORWARD_ONLY_HOST_ADAPTER=TARGETED_TESTED
TT_A_FINAL_REVIEW=BLOCKED
FAILED_OBSERVATION_RECOVERY=PASS
INTERRUPTION_RECOVERY=PASS
FULL_HOST_ACCEPTANCE=NOT_RUN
FULL_LOCAL_CI=NOT_RUN
PRODUCTION_DEPLOYMENT=NOT_AUTHORIZED
PRODUCTION_GO=false
```
