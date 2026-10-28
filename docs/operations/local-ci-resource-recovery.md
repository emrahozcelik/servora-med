# Local CI Resource Recovery Runbook

Runtime: Colima (`true` profile) + Docker + `postgres:17-alpine` service containers.
Authority: this runbook owns incident recovery and post-merge retirement;
`ops/local-ci/run.sh` owns automated per-run cleanup; `AGENTS.md` owns the
cleanup boundaries and standing post-merge policy.

## 1. Quiescence, Docker identity and capacity (read-only, always first)

Before moving any evidence or retrying, confirm that no CI process is active:

```bash
ps -axo pid,ppid,command | rg 'ops/local-ci/(run|docker-gated)\.sh'
test ! -d "${TMPDIR:-/tmp}/servora-med-local-ci.lock"
```

An existing lock blocks work even if its PID looks stale. Inspect the claim,
processes and recorded resources under supervision; never force-unlock it or
move a bundle while a run may still write it. A PID check alone is insufficient.

Select `colima-true` for this invocation without changing the global context:

```bash
unset DOCKER_HOST
export DOCKER_CONTEXT=colima-true
docker context show
docker context inspect colima-true --format '{{.Endpoints.docker.Host}}'
docker --context colima-true info --format '{{.ID}}'
colima ssh --profile true -- docker info --format '{{.ID}}'
docker --context colima-true system df -v
colima list
colima ssh --profile true -- sh -c 'df -h /var/lib/docker; free -h'
df -h .
```

The two daemon IDs must match. The runner rejects a different selected context
or a pre-existing `DOCKER_HOST` override **before** acquiring the lock, moving
evidence or creating resources. It resolves the local endpoint once and pins
`DOCKER_HOST` for host-side children, independent of later context selection
changes. Cleanup checks the original daemon ID; the guest-side SSE gate also
verifies its daemon before execution. Mismatch requires investigation, not retry.

Check host export/evidence disk, VM disk and available memory, Docker volumes,
images and build cache. Capacity data from another context does not qualify.
Do not start a full CI run when `/var/lib/docker` is above ~80% used or the
VM reports under ~2 GB free. The `postgres:17` WAL writer fails first and the
failure cascades (see §3).

## 2. Failure classification

| Signature | Class | Meaning |
| --------- | ----- | ------- |
| `No space left on device`, WAL `FATAL`, `Connection terminated unexpectedly` across many server test files | ENOSPC | Docker storage or VM disk exhausted. Application code is not suspect. |
| `ERR_INSUFFICIENT_RESOURCES`, Chromium fixture load failures in responsive smoke | OOM / tmp pressure | Container memory or `/tmp` pressure. |
| `qemu` crash lines, `vz` driver errors | QEMU/VZ | VM runtime fault. Restart the affected profile only. |
| `ENOTFOUND`, registry pull timeouts | DNS/network | Host or VM network fault. Retry after connectivity recovers. |
| GitHub Actions jobs with 0 steps and seconds-long duration | Runner infra | No test step started. Never count as product failure or PASS. |

## 3. Reference incident (PR3 round)

- Docker storage reached 99% (`/var/lib/docker`, 186 MB free).
- PostgreSQL WAL replay failed with ENOSPC; the CI database container exited.
- 162 server test files failed with `Connection terminated unexpectedly`.
- Cause: accumulated anonymous volumes from prior CI database containers
  (`run.sh` removed containers but left their volumes: ~10 GB across 11 volumes).
- Remediation: removed only unused anonymous volumes plus orphaned CI
  containers; protected database volumes were preserved.
- Result: 10.12 GB reclaimed, disk 99% → 29%, identical-SHA rerun 27/27 PASS.
- Durable fix: `run.sh` separates container create/start and records the
  immutable container ID before start. Its EXIT trap removes the owned PG with
  `docker rm -fv`, relying on Docker's anonymous-volume semantics. It never
  classifies volumes by empty labels or deletes volumes by guessed names.
  See `ops/local-ci/lib/resource-cleanup.sh` and
  `ops/tests/ci-resource-lifecycle.test.mjs`.

## 4. Safe retry procedure

1. Complete §1: establish quiescence/lock ownership and verify the Docker
   context/daemon before moving evidence or retrying. Classify the failure per
   §2. For ENOSPC/OOM, fix capacity before another expensive run.
2. Preserve the whole failed bundle at **`<evidence-root>/<sha>`**, including
   manifest, stdout, logs and auxiliary cleanup diagnostics. For example, after
   supervised quiescence, move it to
   `<evidence-root>/failed-<cause>/<sha>-<timestamp>` and verify the copied/moved
   bytes before retrying. Do not insert another `local-ci` path component.
   The runner also archives an existing same-SHA bundle under its acquired lock
   to `<evidence-root>/previous/<sha>/<run-id>` before creating fresh logs.
   An archive failure stops setup; old logs are never recursively deleted.
3. Free capacity with ownership-proven cleanup only:
   `docker volume prune` is forbidden (it cannot tell CI leftovers from other
   projects' data). Remove only volumes you can attribute to a finished run,
   or rely on the automated per-run cleanup.
4. Recheck §1, then run the identical SHA from its clean worktree with
   `DOCKER_CONTEXT=colima-true ops/local-ci/run.sh --sha <sha> --evidence-root <evidence-root>`.
   A code correction requires a new SHA/tree and fresh evidence; do not reuse
   the previous head's PASS bundle.
5. Verify all 27 checks, the evidence verifier, `logs/aux/cleanup.status`, and
   post-run capacity/resource IDs. Record before/after measurements externally.

## 5. Ownership, partial setup and cleanup failures

Successful create replies prove ownership of immutable Docker IDs. Creation
includes `com.servora.local-ci.run=<run-id>` labels. If a create command fails
after allocating a resource, recovery inspects only that run's exact attempted
name and requires both the matching label and full ID. Foreign labels, failed
inspection or an unknown lock claim never authorize deletion.

A successful captured create ID remains usable if later inspection fails;
cleanup does not need a mount list. If both the create reply and ownership
inspection are unavailable, cleanup leaves the ambiguous resource in place and
reports it for supervised recovery. Unavailable daemon access cannot guarantee
automatic reclamation. Never turn that uncertainty into a blind removal.

Cleanup errors are visible on stderr and in `logs/aux/cleanup.log`; status is
`PASS` or `FAIL` in `logs/aux/cleanup.status`. Unknown lock ownership is reported
on stderr without modifying the possibly foreign bundle. The original CI exit
status is retained, including zero: a 27/27 PASS does not by itself prove cleanup
success. **Evidence acceptance requires both 27/27 PASS and explicit cleanup
PASS.** Manifest schema 2 includes a separate `cleanup` object with result,
mode (`remove` or `keep-containers`), and SHA-256 hashes of the fixed
`logs/aux/cleanup.log` and `logs/aux/cleanup.status` files. The initial test
manifest is provisional; the EXIT trap finalizes it under the CI lock after
resource cleanup. Lock-release failure changes the files and invalidates their
finalized hashes. Cleanup finalization never changes the original test result
or CI exit code, and does not add or replace any of the 27 mandatory gates.

`verify-evidence.sh` rejects FAIL, missing/invalid status, missing finalization,
or mismatched cleanup bytes. Production's local-evidence gate invokes that
same verifier for both explicit and default bundle selection; there is no
cleanup bypass. Hashes establish operator-attested file integrity, not
independently authenticated execution (see `ops/local-ci/lib/evidence.sh`).

Schema-1 bundles remain intact as historical evidence, including earlier PR
review packages. The new verifier refuses them with `SCHEMA_MISMATCH`; do not
backfill a PASS or upgrade them in place. Run the exact authorized source again
to obtain schema-2 acceptance evidence.

Keep the caller's full stdout/stderr log beside the bundle. Use the
recorded run ID, resource IDs and daemon to attribute leftovers before action.

`--keep-containers` intentionally retains container, network and volumes, while
releasing the run lock and removing only its temporary source export. This
retention is recorded as `cleanup.mode=keep-containers` with PASS when those
requested cleanup operations succeed; the verifier accepts this explicit mode.
It does not claim that resources were removed. The operator must account for
the retained resources before another expensive run. Both removal and retention
verify the pinned daemon identity; a mismatch records cleanup FAIL while
preserving resources and the original CI exit. Named
volumes and volumes still referenced by another container are protected by
Docker's container-removal semantics. See [Docker rm documentation](https://docs.docker.com/reference/cli/docker/container/rm/)
and [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/).

## 6. Prohibited operations

- `docker system prune -a --volumes`, bare `docker volume prune`, or deleting a
  volume because its label/name merely resembles a CI resource.
- `colima delete` / `limactl delete` during CI, incident recovery, or any
  active owner/lock. Per-run cleanup remains in `run.sh`.
- Deleting a Lima guest, Colima profile, or disk without proving exclusive
  disposable ownership, quiescence, and preservation of necessary evidence.
- Touching named/shared database volumes, production state, or other projects'
  containers/VMs. Unknown scope means HOLD.

Historical note (2026-10-27): the owner-authorized cleanup removed the former
`servora-r4-20261012` guest (hostname `lima-servora-r4-20261012`), TT-A lab
guests, and the old `true` Colima profile/data disks. It also deleted local
acceptance/CI bundles, including PR #394's resulting-main bundle. The retained
`~/.local/share/servora-med/records-20261027/` reports, indices and hashes are
historical records, **not currently verifiable CI or host-acceptance bundles**.
They cannot authorize a deploy. Re-running an authorized exact source produces
new evidence; it cannot reconstruct the deleted execution logs. Fixture impact
is recorded in [the R4 contract](./r4-forward-recovery.md#evidence-and-platform-limits).
This one-off cleanup does not authorize repeating its broad deletions.

## 7. Worktree state rule

Never use `git stash` to juggle worktree state during CI or incident work. A
stash push/pop cycle in a linked worktree was observed to coincide with
worktree index corruption (foreign staged entries plus unmerged paths while
HEAD and the remote stayed intact; causation not proven, recovery was
`git read-tree HEAD` plus selective checkout). Prefer explicit patch files
(`git diff > /tmp/<name>.patch`) or small commits. Preserve staged, unstaged and
untracked work separately if recovery is needed; an unstaged patch alone does
not capture all three. Verify `git status --short` before and after. The five
existing protected stash entries must remain unchanged during this task.

## 8. Mandatory post-merge resource retirement (not CI cleanup)

The merge agent must review retirement after every authorized merge. Destructive
retirement requires successful **resulting-main exact-SHA** CI, finalized
cleanup PASS and evidence verification; PR-head or same-tree/different-SHA
evidence is insufficient. Use the accepted CI mode in the
[deployment runbook](./production-deployment.md#local-first-operation-when-github-hosted-runners-are-unavailable):
local mode requires all 27 mandatory checks and the exact-source verifier;
hosted mode requires successful exact-main CI. Never treat skipped Actions as
PASS. This policy creates no scheduled service and does not change `run.sh`.

The checklist may close with explicit per-resource **HOLD** entries, but those
resources remain deferred, not successfully retired. No missing ownership,
quiescence, evidence, or protected-data proof may be waived to reclaim space.

1. **Read-only preflight and exclusive window:** record resulting-main SHA/tree,
   CI mode/result and verification. Coordinate with other operators and suspend
   launchers that could start CI, guest tests or recovery until closeout.
   Complete §1 and check other launchers' lock locations too: absence of one
   PID or the current shell's `TMPDIR` lock alone cannot establish exclusion.
   Never acquire, delete or repurpose CI/recovery locks as a retirement lock.
   Inspect `colima list`, `limactl list`, `limactl disk list`, profile/guest
   configuration, host mounts and disk paths. For a running Docker profile,
   verify the context/guest daemon IDs, then inspect all containers (including
   stopped), networks, volumes and `system df -v` on that explicit daemon.
   Record creation/run ownership and every data dependency; names, empty labels
   and stopped status alone do not prove disposability. A guest may mount host
   directories: those directories remain outside deletion scope. If a stopped
   VM's contents cannot be proven from existing records, HOLD; starting it for
   inspection requires task authorization. Recheck identities and quiescence
   immediately before each stop/delete. If exclusion cannot be maintained, HOLD.
2. **Preserve required bytes:** retain the **complete** completed CI bundle,
   including `manifest.json`, `report.md`, all logs/auxiliary files, the caller's
   full stdout/stderr, and separate release/acceptance-required artifacts.
   Storage must survive deletion of the VM, disk and disposable checkout.
   A persistent host evidence root already meeting this condition needs no
   redundant copy. Otherwise copy first; verify the destination before removing
   originals. Keep bundles in `<archive-root>/<sha>/` and execute the verifier
   from the checkout at the recorded source SHA:

   ```bash
   ops/local-ci/verify-evidence.sh --evidence-root <archive-root> \
     --sha <resulting-main-sha> --tree <resulting-main-tree>
   ```

   Record its output and the manifest digest. Compare complete file inventories
   and hashes after a copy; the CI verifier alone does not cover every auxiliary
   or external acceptance artifact. Verify those through their owning contract.
   A compressed archive must be extracted and verified before claiming it is
   reusable. Production local-evidence selection requires the canonical
   `<archive-root>/<sha>/manifest.json` layout; supply the new bundle path with
   `--evidence` when it differs from the default root. Preserve failure/RED
   history needed by open reviews or recovery. Never edit/relabel a manifest
   for a different SHA or replace raw files with a JSON index/digest list.
   Missing required bytes mean unavailable evidence, not PASS.
3. **Colima:** if profile `true` is proven dedicated to Servora-Med CI,
   idle, and every guest file/container/volume is disposable or safely preserved,
   stop it with `colima stop --profile true`, then use
   `colima delete --profile true --data` (automation may add `--force` only to
   suppress its confirmation after all gates pass). Plain `colima delete`
   preserves runtime data; stopping alone also leaves disks allocated. The
   `--data` operation destroys **all** profile images/volumes, including named
   volumes, so a protected, shared, named database or unexplained volume blocks
   profile deletion under this standing policy.
   An intentional `--keep-containers` PASS does not cancel its retention need.
   Use Colima to manage its own Lima instance/disks; do not delete its internals
   through `limactl` or filesystem removal. Inspect installed CLI help first.
   A failed deletion, locked disk or residual disk is HOLD for supervised
   recovery, never permission to force-unlock or `rm -rf` profile directories.
   Preserve the user's selected Docker context; use per-command selection.
4. **Lima:** enumerate exact guest identities. Retire an individual guest
   only after identifying it as owner-authorized disposable test infrastructure
   with no open host recovery/acceptance activity and externally preserved
   required evidence. Use `limactl stop <exact-instance>` followed by
   `limactl delete <exact-instance>`; never force-kill a guest to bypass activity.
   Additional Lima disks can survive guest deletion and can be shared. Inspect
   references across all guest configs; only an individually proven disposable,
   unreferenced disk may be removed with `limactl disk delete <exact-disk>`.
   Never use wildcard names or clear Lima's shared config/keys/cache. A removed
   fixture means `NOT_RUN_HOST` for dependent tests until authorized bootstrap
   restores their reviewed prerequisites; a new guest name alone is insufficient.
5. **Closeout:** verify recorded owned resources/locks were released, or report
   exact leftovers as HOLD without clearing unknown locks. After deleting a
   daemon, use saved IDs plus profile/disk absence; a failed connection is not
   proof of zero remaining containers/volumes. Re-run retained-bundle verification
   after retirement. Report identities, commands/results, evidence paths/digests,
   deletions and HOLD reasons. Compare host free space and **allocated** disk
   usage (`df -h`, `du -sk <recorded-path>`); virtual disk capacity or apparent
   file size is not reclaimed host space. APFS/concurrent writes can affect the
   free-space delta, so distinguish measured change from attributable reclamation.
   Record expected next-run image downloads and profile/fixture reprovisioning.
   Preserve the canonical checkout, all worktrees/stashes, retained release
   artifacts, sealed recovery records and the persistent evidence root.

Do not perform any profile retirement following a failed/incomplete
resulting-main CI, while an evidence consumer needs the original bundle, or
when ownership cannot be established. Resolve a HOLD through its owning task;
do not silently drop it from the report. Blanket prune, worktree/stash deletion
and production maintenance are outside this standing policy.

CLI semantics: [Colima delete/data persistence](https://colima.run/docs/commands/#colima-delete)
and [Lima additional disks](https://lima-vm.io/docs/config/disk/).

## 9. Recreating a retired CI profile

For the retained Phase 1 optimization profile and its persistent caches, see
[local CI caches](local-ci-caches.md). That task retains the profile/data disk;
normal per-run cleanup still removes only its temporary owned resources.

Retirement discards one-time VM setup as well as images. Before the next CI:

1. Use Node 22 on the operator host and provision the exact `true` Docker
   profile. A fresh Apple Silicon configuration can use
   `colima start --profile true --activate=false --vm-type vz --vz-rosetta --cpu 3 --memory 4 --disk 40`.
   These are resource settings, not a promise of enough free space; repeat §1.
2. Confirm the checkout, `ops/local-ci/chains`, evidence root and shared
   `~/.local/share/servora-med/ci-tmp` are visible inside the guest at the
   **same physical absolute paths**, with required log/temp write access.
   The default home mount does not cover a checkout under `/private/tmp`.
   Configure explicit `--mount` entries before running CI (see installed
   `colima start --help`); custom mounts must retain all needed shared paths.
   Check actual files from `colima ssh --profile true`, not just directory
   existence: Docker's `-v` can silently create an empty guest directory.
3. Provision a Linux Node 22 binary inside the guest, matching its architecture,
   from an approved [official Node.js distribution](https://nodejs.org/en/download).
   Verify its upstream checksum before installation and record version/digest.
   `ops/local-ci/docker-gated.sh` discovers guest `node` or
   `$HOME/.local/bin/node`; a host macOS executable cannot replace it. Confirm
   the guest executable reports major 22 and that the same guest can run
   Docker and curl. Without guest Node, the host fallback cannot share Docker's
   network namespace for the SSE behavior check and cannot qualify as PASS.
4. Recheck the matching daemon IDs, Linux/amd64 emulation and §1 capacity.
   Run CI with invocation-local `DOCKER_CONTEXT=colima-true`, `DOCKER_HOST`
   unset and host Node 22 on PATH. Preserve any failed setup attempt and its
   full stdout before retrying; use the exact source SHA, never edited logs.

This preparation installs no application dependency and weakens no gate.
R4/TT-A real-host fixture provisioning remains a separate authorized task.
