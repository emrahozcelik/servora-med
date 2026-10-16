# Local CI Resource Recovery Runbook

Runtime: Colima (`true` profile) + Docker + `postgres:17-alpine` service containers.
Authority: this runbook owns incident recovery; `ops/local-ci/run.sh` owns the
automated per-run cleanup; `AGENTS.md` owns the prohibition on broad cleanups.

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
success. Keep the caller's full stdout/stderr log beside the bundle. Use the
recorded run ID, resource IDs and daemon to attribute leftovers before action.

`--keep-containers` intentionally retains container, network and volumes, while
releasing the run lock and removing only its temporary source export. Named
volumes and volumes still referenced by another container are protected by
Docker's container-removal semantics. See [Docker rm documentation](https://docs.docker.com/reference/cli/docker/container/rm/)
and [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/).

## 6. Prohibited operations

- `docker system prune -a --volumes` and bare `docker volume prune`
- `colima delete` / `limactl delete` as part of CI work
- Deleting the independent `servora-r4-*` Lima VM (protected recovery scope)
- Touching named/shared database volumes or other projects' containers

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
