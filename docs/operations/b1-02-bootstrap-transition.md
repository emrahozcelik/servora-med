# B1-02 — CLOSED installation and separately authorized release

Status: owner-authorized **source implementation and synthetic acceptance**.
Production **HOLD / NO-GO**. This contract grants no host access, provisioning,
sudoers change, disposition, staging, profile re-seal, baseline, approval,
adoption, deployment, migration, restart or backup operation.

Decision: [OPS-B1-003](../../DECISIONS.md#ops-b1-003--separate-closed-installation-and-released-issuance).
Prerequisites: [B1-01 fence](b1-01-persistent-bootstrap-fence.md) and
[deployment-account sudo quarantine](b1-02-delegation-quarantine.md).

## 1. Source and artifact boundary

Development starts at `8aebdb0f1bf0075dc43e1af4c576f826d691a24e`, the squash
merge of PR #436. Exact-main CI `43491759476` passed all four jobs. Artifact
`14072535195` has release tarball SHA-256
`c2207e462162f5ef128fdbbad9cb9a370afc7c8a150e0f7dc47debc11276c1e0`.
The ZIP, gzip, tar reads and sidecar were verified; `ops/recovery-tools/` is
absent. This is the **development baseline**, not an installation target for
the new producer. Its package predates this change. After an authorized merge,
freeze the resulting exact-main, successful CI, new artifact and separately
reviewed root bundle before proposing any host installation. A complete secret
scan was not performed during that baseline artifact review.

The producer is a separately provisioned root-only CLI, excluded from normal
release artifacts. It does not install itself, create owner permissions or
establish external quarantine. Its wrapper pins its complete 15-file import and
minimum-payload closure. There is no dependency download, alternate root/path,
clock overlay, verification flag, force, repair, retry or resume argument.

## 2. Fixed paths and trusted inputs

| Path | Contract |
|---|---|
| `/usr/local/libexec/servora-med-bootstrap` | Physical root:root 0750; separately reviewed source bundle. Preserve the quarantine CLI and dependencies already required by PR #436. |
| `ops/recovery-tools/bootstrap-transition` under that bundle | Physical root:root 0750, nlink 1; clean environment, fixed `/usr/bin/node`, literal dependency hashes. |
| The wrapper's pinned source files | Physical root:root 0644, nlink 1; no writable/symlinked ancestors. The pin list is the authoritative bundle file inventory. |
| `/var/lib/servora-med-bootstrap-transition` | Physical root:root 0700 private operation state, distinct from the public guard chain. |
| Private `manifest.json`, permissions and evidence files | Physical root:root 0600, nlink 1; canonical hash envelopes. |
| Private `prepared/<sha256>` | Root:root 0600 in a 0700 directory; exactly the payload hashes named by the manifest. |
| Private `install-review/` and `release-review/` | Separate root:root 0700 evidence trees. Installation evidence is retained when release evidence is provisioned. |
| `/var/lib/servora-med/deploy/bootstrap` | Existing B1-01 0700 guard directory; records 0600, nlink 1. Must be positively absent before first installation. |
| `/var/lib/servora-med/deploy/host.lock` | Existing trusted empty 0600 inode; held through the operation. Never created, replaced, reclaimed or treated as the persistent barrier. |
| `/usr/local/libexec/servora-med` | Remains physical root:root **0755**, preserving `_chrony` traversal and canonical reader access. |
| `/usr/local/libexec/servora-med-profile-reseal` | Separate existing root-only 0750 contract; not changed by this tool. |

Ancestors must be physical, root-owned and not group/other writable. Target
directories must already exist and be trusted. Absence uses `lstat`: dangling
links, EACCES and ENOTDIR are errors, never positive absence. Prepared and live
file reads use the shared descriptor-based trusted reader. Owner review must
bind the wrapper's own bytes and the frozen source; its self-hash is not an
independent trust root.

The shared manifest validator requires the ten canonical management files,
sorted unique paths, exact modes and hashes. This is a minimum, **not** an
automatic discovery of all live entrypoints. The authorized manifest must also
cover every active forward/emergency wrapper and import closure from the actual
host inventory. Minimum payloads must equal the private pinned source bytes.
Existing content-addressed forward/emergency sets cannot be modified or created
by the installer; unchanged sets can be verified as inputs. New sets require
their existing factory and separate authorization.

## 3. External quarantine is an independent prerequisite

Before invoking this tool, an authorized operator must independently establish
and audit persistent closure of all non-root management routes. This includes
effective sudo policy, SSH/forced commands, polkit, other identities, management
cron/timers and automation. Privileged management processes must be drained.
Keep ordinary app runtime, scheduled backup and the TT-A collector operating.
Validate an independent root SSH or console channel that survives loss of
`servora-deploy` sudo; historical access evidence is not a fresh access test.

The producer rechecks the actual four comment-only sudoers files, the original
quarantine permission/receipt and actual `visudo` / `sudo -l -U servora-deploy`.
That receipt alone is deliberately insufficient for installation or release.

Each phase consumes a different protected operator evidence tree. The external
authorization is a canonical envelope with:

`formatVersion`, `kind=BOOTSTRAP_EXTERNAL_QUARANTINE_AUTHORIZATION`,
`scope=ALL_NON_ROOT_MANAGEMENT_CLOSED_AND_PRIVILEGED_MUTATIONS_DRAINED`,
`fenceId`, `machineId`, `bootId`, `hostLock`, `sudoReceiptSha256`,
`managementReviewSha256`, `rootAccessProofSha256`, `processDrainProofSha256`.

The exact review schemas are validated by `validateOperatorEvidence()`:

| Evidence | Required authority / binding |
|---|---|
| `management-review.json` | `BOOTSTRAP_MANAGEMENT_ROUTE_REVIEW`; `ALL_NON_ROOT_ROUTES_CLOSED`; exact source, manifest, machine, boot and inventory hash. |
| `management-inventory.json` and `route-evidence/` | Same machine/boot; five sorted categories: autonomous-management, other-identities, polkit, ssh, sudo. Every retained category file is hash-bound. |
| `root-access-proof.json` | `BOOTSTRAP_INDEPENDENT_ROOT_ACCESS_PROOF`; uid 0 / root; SSH or CONSOLE; independent of `servora-deploy-sudo`; same machine/boot. |
| `process-drain-proof.json` | `BOOTSTRAP_PRIVILEGED_MUTATION_DRAIN_PROOF`; `NO_INFLIGHT_OR_AUTONOMOUS_MANAGEMENT`; same machine/boot and inventory hash. |
| `management-process-inventory.json` | `BOOTSTRAP_MANAGEMENT_PROCESS_INVENTORY`; `MANAGEMENT_MUTATION_PROCESSES`; empty relevant management process list. App/backup/collector runtime is outside this list. |

These files are **operator attestations**, not automatic proof that all Linux
routes were discovered or processes independently scanned by this CLI. Root
ownership and hashes establish origin/integrity, not completeness or truth.
The owner must review retained real observations before authorizing them. The
CLI never manufactures these permissions or accepts `--verified=true`.
Synthetic CI inventories cannot be copied to production or called root host
acceptance. Deliberate root policy override remains outside the threat model.

No quarantine is lifted by installation or release. Any later delegation
restoration is a separate owner-authorized host-policy operation limited to
reviewed guarded entrypoints; never restore arbitrary systemctl/node/env/shell,
legacy helpers or SQL authority. Other identities and automation must remain
closed throughout the transition, including after process death or reboot.

## 4. Installation protocol and state

CLI forms (the wrapper lives at the fixed bundle path above):

```text
bootstrap-transition install --capture --source-sha <40-hex> --fence-id <uuid-v4>
bootstrap-transition install --dry-run --expected-authorization <64-hex>
bootstrap-transition install --apply --expected-authorization <64-hex>
bootstrap-transition release --capture
bootstrap-transition release --apply --expected-authorization <64-hex> --expected-external-authorization <64-hex>
```

`install --capture` holds the existing host lock, verifies the prepared closure,
external authority and preserved state, and reports a read-only
`BOOTSTRAP_INSTALL_PROPOSAL`. It creates no permission or operation files.
An independent owner decision/provisioning step is mandatory. The exact
installation permission at private `install-authorization.json` has:

`formatVersion=1`, `kind=BOOTSTRAP_INSTALL_AUTHORIZATION`,
`scope=PUBLISH_CLOSED_AND_INSTALL_TOOLS`, `fenceId`, `machineId`, `hostLock`,
`sourceSha`, `manifestSha256`, `externalAuthorizationSha256`, `preservedState`,
`previousTools`.

`preservedState` binds current release, old profile hash, service identity hash
(MainPID/InvocationID/NRestarts/active/running/NeedDaemonReload=no) and the
existing 26-file historical source inventory. That inventory also rejects all
four pending markers and non-empty initializations. `previousTools` contains
the same sorted paths/modes with each old hash, or null for positively absent
files. Full canonical byte hashes are the CLI authorization arguments.

`--dry-run` checks the entire authorized plan without publication. Apply:

1. Recheck identity, stable locked inode, same boot, external authority, prepared
   bytes, old tool bytes and unchanged preserved state.
2. Exclusively and durably reserve `install-operation.json`. Retain old tool
   bytes and a hash index under private `originals/`; fsync files/directories.
3. Exclusively create the guard directory and publish the unchanged B1-01
   manifest/CLOSED record formats, durably, **before** replacing any tool.
4. Recheck preserved state/external authority/CLOSED before each sequential
   same-directory file replacement. Check old inode/bytes, fsync candidate,
   atomically publish one file, fsync parent and verify hash/mode/nlink.
   Unchanged files are not rewritten. New targets publish exclusively.
5. Recheck again and publish private `BOOTSTRAP_INSTALLED_CLOSED` receipt. Its
   explicit authority is `NO_RELEASE_OR_DEPLOYMENT_AUTHORITY`.

This is not an atomic multi-file upgrade. Its safety comes from persistent
external quarantine plus durable CLOSED before canonical writes. Old binaries
that cannot read CLOSED stay blocked by external quarantine. Partial sets
cannot be used for normal management. Neither flock nor profile mismatch is
claimed to close old entrypoints.

## 5. Crash, reboot and uncertain outcomes

| Interruption | Required outcome |
|---|---|
| Before reservation | No canonical write. Fixing/reprovisioning an invalid proposal needs a new owner review; no auto-authorization. |
| Reservation/original retention or CLOSED publication fails | Keep all residue. External quarantine remains essential; do not assume a valid CLOSED record exists. No canonical replacement has started. |
| Mid-tool replacement, ENOSPC/EIO/SIGKILL | Retain old bytes, reservation, candidate residue and observed partial set; CLOSED plus external quarantine remain. No completed install receipt. |
| Process death / released flock | Does not publish RELEASED or lift external policy. A new invocation refuses an existing reservation or publication residue. |
| Reboot or app service identity/history change | Same-boot authority and preserved-state checks fail. Remain HOLD; no implicit re-baseline, cleanup or second install. |
| Release fails before its commit point | Leave reservation/evidence; no retry. Without a valid complete guard chain, management remains denied. |
| Valid final RELEASED publication but lost acknowledgement/fsync error | Outcome can be committed despite an error. Retain evidence and external quarantine; independently read back the complete chain before any separate owner action. Never automatically roll back or republish. |

The producer does not implement generic partial-install repair or recovery.
An observed interrupted state needs a separately reviewed, explicitly authorized
plan binding the retained originals and actual installed hashes. No automatic
rollback, profile repair, deletion, receipt rewrite or second write is offered.
Physical storage durability and real reboot acceptance remain host gates.

## 6. Separate release protocol

After completed installation, perform only the independently authorized existing
historical disposition/staging/readback and profile re-seal operations. Their
policies are unchanged and this tool does not call them. Preserve original
historical sources. Provision fresh `release-review/` and a different private
`release-external-authorization.json`; do not overwrite installation evidence.

`release --capture` requires completed install permission/receipt linkage and
rechecks all active tool hashes, original current/service/history, pending
state, fresh operator authority, all **nine** live profile contracts and the
canonical `/usr/local/libexec/servora-med/trusted-time.mjs --read-chrony` v2
reader (same boot, pinned module/config, existing NTS policy). No forward-time
overlay is accepted. Runtime hash checking of the physical Node executable is
streamed; the shared small-file reader remains bounded. Its output is a
read-only proposal containing the existing eight-check verification envelope
and actual canonical time evidence, never owner permission.

The owner separately reviews that evidence and provisions the existing B1-01
`verification.json` and `release-authorization.json` envelopes at the public
guard directory. Permission kind is `BOOTSTRAP_RELEASE_AUTHORIZATION`, scope
`ENABLE_APPROVAL_GATED_MANAGEMENT`, bound to fence, manifest, profile and full
verification byte hashes. Installation permission cannot substitute for it.

Release apply checks both explicit authorization hashes, recomputes verification,
durably reserves private `release-operation.json`, repeats the checks, and
retains private before/after `release-evidence.json`. It exclusively publishes
`released.json` **last**, then reads the actual guard. That publication is the
release commit point. Existing B1-01 guard states and record schemas are
unchanged; shared validation/check names avoid a second schema source.

Normal management still requires its existing approval, accepted attempt,
profile, phase, time and database checks. Attempt-less deployment, rollback and
legacy in-place restore remain refused. Release restores no sudo grant and
issues no baseline, approval, adoption or deployment. Perform separately
authorized new baseline/approval/adoption work only after the relevant release
gates: creating new attempt/backup source files before this release would
invalidate the exact original historical source snapshot. The known adoption
expiry/interruption problem remains a separate blocker before live adoption;
this producer does not change or resolve that contract.

## 7. Acceptance boundaries and remaining GO/NO-GO gates

| Verification | Environment / meaning |
|---|---|
| Install/release unit ports | Synthetic record/hash/scope, partial writes, ENOSPC/EIO, boot/service/history drift, no replay, immutable toolsets and separate release authority. Positive release is synthetic only. |
| Wrapper/parser tests | Exact dependency pins, fixed CLI, rejected caller path/time/check/force switches and operator binding schemas. |
| Disposable Linux containers | Actual root file ownership/modes/nlink, no-follow reads, fsync/publication, flock, sudo/visudo, installation and a real SIGKILL after first canonical replacement. A fresh process refuses the partial operation. |
| Linux release negative | Actual canonical reader fails without real TT-A evidence; no verification, permission or RELEASED is synthesized. |
| Runtime preservation in containers | Synthetic service process/current/history stay unchanged; systemctl observations and route reports are explicit test doubles, not real host acceptance. `_chrony` traversal is checked with the actual separate uid. |
| Real systemd/Chrony, positive host release, reboot, physical disk faults | **NOT_RUN by the portable/container suite**. Require separate owner-authorized disposable Linux integration acceptance. |
| Production root inventories, external route quarantine, root access | **NOT_RUN by source CI**. Fresh real host evidence and separate installation authority required. |

Existing server/web/auth CI, PG17 regressions, shell checks and artifact
exclusion checks stay mandatory. New tests run in the existing server job;
they do not replace existing gates. No new dependency or full local CI regime
is introduced. If local Docker is unavailable, report that rather than claiming
Linux acceptance; exact-head GitHub CI is the source acceptance record.

Before production: independent security review; resulting-main CI and frozen
release/root bundle; complete effective host inventory and accepted interrupted
state procedure; real reboot/systemd/Chrony integration; fresh root-only evidence;
separate quarantine/install/historical/re-seal/release permissions. Production
deployment additionally needs adoption interruption closure, a restricted
backup restore rehearsal proving recoverability and the existing deployment /
migration 061 approvals. Do not copy production data into shared test/CI DBs.
Source merge, installed CLOSED, RELEASED and permission to deploy are different
gates. Production remains NO-GO until the applicable gates are actually met.
