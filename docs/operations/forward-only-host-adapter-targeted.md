# Issue #369 — forward-only host adapter and targeted integration

Historical targeted evidence for `c81cbaf…`. The missing failure-recovery path
described below is superseded by the separately owner-authorized
[failure-recovery contract](forward-only-failure-recovery.md) and
[final safety remediation evidence](forward-only-final-safety-remediation.md).
Its original test/review results remain historical; they do not approve the
later tree.

This is implementation evidence, not a release authorization. Baseline pure
contract: `178571d0b718d70c79fcb0997bc50c486742befa`; canonical main remains
`5af00f7f34a8986c716fb3a9a881ef48c8740c85`. The pure module is unchanged.
Production OLD remains the separately reported `f5f87d450061ca12ee80451c55eb56e99b80823c`;
no production host or grant is used by these tests.

## Architecture and privilege boundary

| Module | Responsibility |
| --- | --- |
| `forward-transition.mjs` | Unchanged pure authorization, migration-free phases, supersession, observation summary and acceptance |
| `forward-host-driver.mjs` | Explicit command/phase boundaries; host hash chain; durable operation intents/results; slots derived from immutable events |
| `forward-host-storage.mjs` | Protected canonical records; exclusive append with file/directory fsync; read-only interrupted-publication inspection; apply-only reconciliation |
| `forward-host-evidence.mjs` | Retained CI integrity and Trusted Time/monotonic/process-bound observation validation |
| `forward-host-probe.mjs` | Service-UID PostgreSQL 17 identity/catalog/advisory lock and dump; entire CJS dependency graph confined to the verified release |
| `forward-host.mjs` | Root/Linux fixed paths, actual readers, host lock, owner, systemd gate, backup receipts, pointer/environment alignment and terminal handback |

The tool installs separately under `/usr/local/libexec/servora-med-forward`.
Its fixed manifest seals every module and `required-checks.txt`. Every file must
also match its corresponding source inside the exact TARGET artifact. The old
installed R4 modules are read-only imports: their complete import closure is
hash-verified against the protected parent approval/profile **before import**.
The checkpoint reader deliberately avoids `readLatestCheckpoint()` because that
reader can reconcile publication residue. Parent and emergency bytes never
change, and the parent is never `COMPLETED`.

No installer or production grant issuer is provided by this phase. Root must
provision the separately reviewed artifact, retained CI files and one-use grant
under `/var/lib/servora-med/deploy/forward` in a later authorized operation. The
adapter validates authority; an emergency receipt grants none. Root-only fixture
grant creation exists exclusively in the named disposable test helper.

## Real commands

Invoke the installed file with `/usr/bin/node`; there are no target/path/command
override arguments and no environment-driven production test clock.

| Command | Boundary |
| --- | --- |
| `preflight`, `status` | Read-only: verify grant, immutable records, artifacts, CI, systemd, process and DB; report phase, used slots, retired owner and pending publications |
| `apply` | Admission through health/schema; stops at `HEALTH_PASSED` |
| `smoke` | Verify the phase-bound administrator browser receipt/log, then create/verify postdeploy backup; stops before observation |
| `observe` | Explicit real 1800-second observation, then acceptance and terminal handback |
| `finish` | Resume only an already durable observation result or accepted terminal handback; cannot start observation |
| `start-gate` | systemd `ExecStartPre` only: exact owner/barrier/intent/ticket/boot/invocation checks and exclusive permanent slot consumption before `ExecStart` |

Mutating CLI calls re-execute under the canonical `host.lock`. The inherited
descriptor's inode and its own `/proc/self/fdinfo` WRITE FLOCK entry must match;
another process's lock does not count. Both deployment generations share
`active.json`, published exclusively under that lock. Foreign owner, pending R4
initialization, permit, drop-in or hash drift denies execution.

Preflight first proves artifact/CI/helper bytes and authority before any
candidate `pg` dependency runs as the service UID with database credentials.
Then a PG17 service-UID guard holds the migration advisory lock across the real
operation. It performs identity/catalog queries only. There is no migration or
restore command in the adapter.

Browser receipts are administrator attestations, not independently
authenticated browser provenance. They bind the exact health-phase hash,
authorization, TARGET, PID/start-time/boot/invocation, browser, recent completion
and retained log hash. The fixture explicitly labels its synthetic browser
receipt and never claims a browser acceptance run.

## systemd and crash safety

The temporary `91-servora-forward-budget.conf` sets `Restart=no`; the separate
`90-servora-forward-guard.conf` installs the root `ExecStartPre` gate. These are
new forward-owned files, not changes to the sealed R4 unit/profile. This explicit
availability tradeoff supersedes the design's unattainable whole-window
`on-failure` aspiration for this adapter phase.

The gate remains closed when `on-failure` is restored before terminal seal.
Only a durable `ACCEPTED` allows its removal. Every mutation has a prior durable
intent and an explicit result. The host chain records `migrationPerformed=false`
and the pure contract checkpoint in every envelope. Exclusive slot receipts and
volatile launch tickets prevent auto-restart/manual/reboot start reuse.

Supported resumes re-observe exact outcomes: stop, environment, pointer and
policy alignment are idempotent; a known TARGET invocation with a consumed gate
receipt may be recorded without starting it again. Unknown activation outcome,
missing backup result, partial named record, process change or reboot is a
typed failure, never a reset/retry. Even if a grant permits two starts, this
conservative first adapter uses no automatic second-start path.

Backup receipts bind the operation intent, authorization, DB identity/catalog,
real PG17 custom archive digest, completion UTC, boot and monotonic uptime.
The receipt digest is pinned in its DONE event. Reboot, stale/future/invalid time,
archive drift or an absent receipt denies activation. Dumping a fresh backup
does not renew the separate scheduled-backup heartbeat. Backup health HTTP 503
is a veto, including immediately before observation/terminal sealing.

After a durable `ACCEPTED`, deployment activation slots remain permanently
spent and ordinary runtime restart policy takes over. An interrupted terminal
handback first verifies the retained accepted artifact/DB/alignment and sealed
backup bytes, then removes its guards; if necessary it starts that already
accepted runtime under normal policy. This cannot happen before acceptance and
does not rewrite an activation slot or observation. Previously accepted backups
are verified as history across reboot, never renewed as fresh observation proof.
Current health/schema and backup health must still pass before owner retirement;
503 remains a failure even after guards have been safely handed back.

Observation is collected inside this adapter from real `sampleTrustedTime()`
samples. Every sample contains a chained digest, actual monotonic reading,
PID/start-time/boot/invocation, health and schema/release checks. Require at least
1800 real seconds, 60 samples, conservative BOOTTIME/monotonic agreement, UTC
agreement, bounded sample gaps, fresh backup evidence and one continuous
process. Proof binds the observation journal anchor and post-backup receipt.
It is revalidated after policy restoration and immediately before terminal
publication. External/fake/short/stale observation files cannot create authority.

Interrupted observation has no retry/bypass. Failed-attempt recovery and guard
retirement without acceptance require a separate approved contract. Until then
failure leaves durable guards in place; this known availability limitation is
an explicit final-host-acceptance blocker, not an indefinite polling operation
or a silently resolved R4 emergency.

## Targeted verification

### TT-A path and producer binding — authorized extension

The restricted-reader contract (`DECISIONS.md`, Issue369 amendment;
`restricted-chrony-evidence.md`, Installation and acceptance boundary) accepts
only `/usr/local/libexec/servora-med/trusted-time.mjs` or the protected release
copy. `trusted-time.mjs:validateTimeModuleContract()` deliberately rejects all
other executing paths. The first adapter imported its bundled sampler from
`/usr/local/libexec/servora-med-forward/trusted-time.mjs`; that original binding
returned `TRUSTED_TIME_UNKNOWN`. A focused regression reproduced this after the
initial independent review. Synthetic-port tests did not resolve it.

There is also a producer binding: the accepted systemd template executes the
old installed path. Client and collector must have the same exact module hash.
Merely moving the client to the allowed TARGET release copy would not fix an
old collector/new client mismatch. Overwriting the old installed file would
break the sealed R4 profile and is forbidden. The original emergency fixture
had no reader units; its synthetic HTTP health was not evidence for this path.

The owner explicitly included this narrow source/test extension:

1. Accept one additional **fixed** forward-tool path with the existing strict
   root ownership, single-link, mode and ancestor checks; no arbitrary path or
   caller-selected endpoint.
2. Bind a separately owned collector template drop-in to that exact manifested
   TARGET module, preserving `_chrony`, empty capabilities, sandbox, nonce,
   time-quality policy and all bounded deadlines.
3. Add durable `COLLECTOR_INTENT`/`COLLECTOR_DONE` under `ACTIVATE_INTENT`, verify its
   effective unit/module binding before TARGET start, and keep every old sealed
   module/profile/receipt byte unchanged.
4. Add focused path/producer/mismatched-hash/sandbox/resume tests. Real NTS and
   real 1800-second observation remain separate final acceptance gates.

`DECISIONS.md` records the reconciliation; old installed bytes stay unchanged.
Preflight validates TARGET module metadata, pinned base units, actual socket
metadata and effective sandbox. Collector selection is the only new mutation:
the adapter neither rewrites base units nor restarts the socket/Chrony daemon.
A bounded 4.5s drain covers the base template's 3s runtime + 1s stop allowance;
nonce/module binding still rejects a stale response.

The initial independent review preceded this extension; its APPROVE is not an
independent review of the TT-A and terminal-resume delta. Per the owner's
instruction no further sub-agent is used. These changes received direct review
and targeted tests; independent confirmation remains a final-acceptance gate.
Genuine NTS and real 1800-second host acceptance remain NOT_RUN.

Disposable guest: Lima `servora-eh-20261101`, hostname
`lima-servora-r4-20261012`, Linux/amd64, systemd 255, PostgreSQL 17. Existing sealed
parent/emergency files are snapshotted and checked unchanged. Every test returns
the fixture to its original OLD pointer/environment and normal restart policy.
Only resources identified as this new test's artifacts are reset. The existing
guest, evidence and prior artifacts are retained.

Pure adapter tests use synthetic ports/time and are not production evidence.
Targeted host tests use the real adapter with synthetic release/CI/browser
fixtures, real PG17 dumps, systemd and crash injection. They are not full host
acceptance, actual browser acceptance or full CI.

| Scenario | Evidence |
| --- | --- |
| Read-only preflight / exact DB060 / receipt | FHOST-01 |
| One activation / actual automatic restart gate | FHOST-02 |
| STOP_INTENT / OLD_STOPPED / ACTIVATE_INTENT crash-resume | FHOST-03/04/05 |
| Exhausted/ambiguous START_INTENT / known invocation + owned permit | FHOST-06/07 |
| Wrong DB/catalog/artifact/CI/receipt, missing grant, foreign owner | FHOST-08 + pure contract |
| Backup failure | FHOST-09 |
| TARGET health / schema failure | FHOST-10/11 |
| Interrupted publication; read-only inspection | FHOST-12 |
| Sealed post backup, browser boundary, backup503, fake/early acceptance | FHOST-13 + pure proof validator |
| Same-PID policy handback and real normal restart mechanics | FHOST-14 (platform mechanics only; no acceptance record) |
| Hash drift and read-only failure | FHOST-15 |
| Foreign lock cannot authorize unlocked descriptor | FHOST-16 |
| Manifested collector selection, real module metadata and app-UID isolation | FHOST-17 |
| Collector publication crash/read-only inspection/resume | FHOST-18 |
| Foreign collector path denial without reload | FHOST-19 |
| Actual socket worker UID/capabilities/NoNewPrivs/new executable path; malformed input denial | FHOST-20 |
| Real reboot / no silent start-budget reset | Separate prepare/reboot/verify targeted scenario |
| Terminal acceptance/owner retirement and accepted-crash recovery | Pure synthetic tests; real observation end-to-end NOT_RUN |

Use `node --test --test-name-pattern=FHOST-xx
ops/tests/forward-host-systemd.test.mjs` on the authorized guest. Fault injection
is a separate hostname/root-guarded preload absent from the installed artifact;
production code has no fault flag. Do not run `observe` as a short host test.
Each timed scenario was below five minutes; no real 1800-second test was run.

## Results and remaining gates (2026-11-02)

- Pure targeted set: **146/146 PASS**, including adapter **21**, unchanged
  forward contract **29**, restricted-reader **20** and time/emergency contracts.
- Linux Node 22 selected pure set: **70/70 PASS**.
- Disposable Linux/amd64 + systemd255 + PG17: **20/20 named targeted scenarios
  PASS**, run incrementally with `--test-name-pattern`; affected cases were
  repeated after the TT-A change. This is not exact-SHA full host acceptance.
- Real reboot veto: PASS both after early activation intent and after durable
  `START_INTENT`; no boot start, no additional slot and stale-boot backup denial.
- Actual socket worker: forward executable path, `_chrony` UID, zero effective
  capabilities, `NoNewPrivs=1`, malformed-input denial, and unchanged legacy file
  verified. This is not a successful genuine NTS/observation proof.
- `node --check`, `bash -n` for the two touched CI scripts, and `git diff --check`:
  PASS. No 27-check CI run was started.
- `server/npm run build` and `web/npm run build`: **FAILED** because this isolated
  worktree has no installed `tsc`. Full server tests were NOT_RUN in this
  explicitly targeted phase. No application dependency or lockfile was changed.
- Pure forward module/tests remain byte-unchanged from `178571d0…`.

The first independent review found and closed import-before-hash, candidate
dependency-before-verification, effective-policy drift, backup-resume/receipt
binding, terminal backup503, foreign-lock and read-only/publication boundaries.
It ended APPROVE for that source. Later direct review discovered the TT-A path
and executable-entry binding and accepted-crash ordering; their regressions were
reproduced RED and closed GREEN. **INDEPENDENT_REVIEW remains PARTIAL for the
final delta**, not an unconditional APPROVE of the final tree.

Retained logs and the source/installed-tool comparison live outside the checkout
at `/private/tmp/issue369-forward-targeted-20261101/`. Frozen tool hash:
`725fc4033e0d6897f1e318d409129d82dd47bc2c4381d43a1976d4f5d161ee99`.
The actual installed manifest equals the frozen local module bytes.
Automatic approval review refused exporting grant/journal/PG dump payloads;
those actual files remain private inside the preserved VM under
`/var/lib/servora-med/deploy/forward/`. No indirect export was attempted.

Before final acceptance: independent review of the final delta; genuine time
and browser/service integration; real 1800-second observation; one exact-source
full host acceptance and one exact-main full Local CI. Failed/interrupted
observation without a sealed result still requires a separate authorized
recovery/closure contract. No automatic unfence, rollback or second observation
is provided by this grant. D1 and Local CI resource-isolation documentation work
remain separate.

`FORWARD_ONLY_HOST_ADAPTER=IMPLEMENTED_TARGETED_TESTED`
`SYSTEMD_START_BUDGET_SAFETY=TARGETED_PASS`
`EMERGENCY_SUPERSESSION_BINDING=PASS`
`TARGETED_HOST_TESTS=20/20_PASS`
`INDEPENDENT_REVIEW=PARTIAL_FINAL_DELTA_PENDING`

`FULL_HOST_ACCEPTANCE=NOT_RUN`
`FULL_LOCAL_CI=NOT_RUN`
`PRODUCTION_DEPLOYMENT=NOT_AUTHORIZED`
`PRODUCTION_GO=false`
