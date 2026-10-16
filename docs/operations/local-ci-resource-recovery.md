# Local CI Resource Recovery Runbook

.models: Colima (`true` profile) + Docker + `postgres:17-alpine` service containers.
Authority: this runbook owns incident recovery; `ops/local-ci/run.sh` owns the
automated per-run cleanup; `AGENTS.md` owns the prohibition on broad cleanups.

## 1. Pre-CI capacity check (read-only, always first)

```bash
docker --context colima-true system df
colima list
colima ssh --profile true -- sh -c 'df -h /var/lib/docker; free -h'
```

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
- Durable fix: `run.sh` now records its PG container's volumes at creation and
  the EXIT trap removes exactly those volumes
  (`ops/local-ci/lib/resource-cleanup.sh`, tested in
  `ops/tests/ci-resource-cleanup.test.mjs`).

## 4. Safe retry procedure

1. Classify the failure per §2. For ENOSPC/OOM, do not immediately rerun the
   expensive full CI; fix capacity first.
2. Preserve the failed evidence: move `<evidence-root>/local-ci/<sha>` aside
   (e.g. `failed-<cause>/<sha>`) before rerunning, never delete it.
3. Free capacity with ownership-proven cleanup only:
   `docker volume prune` is forbidden (it cannot tell CI leftovers from other
   projects' data). Remove only volumes you can attribute to a finished run,
   or rely on the automated per-run cleanup.
4. Verify §1 readings are healthy, then rerun the identical SHA.
5. Confirm no second CI run is active first (the run.sh lock fails closed;
   stale-lock recovery is supervised, never forced).

## 5. Prohibited operations

- `docker system prune -a --volumes` and bare `docker volume prune`
- `colima delete` / `limactl delete` as part of CI work
- Deleting the independent `servora-r4-*` Lima VM (protected recovery scope)
- Touching named/shared database volumes or other projects' containers

## 6. Worktree state rule

Never use `git stash` to juggle worktree state during CI or incident work. A
stash push/pop cycle in a linked worktree was observed to coincide with
worktree index corruption (foreign staged entries plus unmerged paths while
HEAD and the remote stayed intact; causation not proven, recovery was
`git read-tree HEAD` plus selective checkout). Prefer explicit patch files
(`git diff > /tmp/<name>.patch`) or small commits, verify with
`git status --short` before and after, and keep stash usage to the five
canonical entries.
