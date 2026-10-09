# PR #361 final production safety reconciliation

Baseline: base `878066ada4c87c325db99f6daa6fae13fe102976`, reviewed head
`f3c5ec1be0745759e4716510705aa20ec84b5af8`, branch `chore/local-first-ci-deploy`.
Scope: targeted reconciliation only; no merge, deploy or production SSH.

## Review disposition

All 16 inline Codex comments from both completed reviews were inspected,
along with the conversation review summary. Comment IDs link to the PR threads.

| Comment | Finding | Correction / proof | Status |
| --- | --- | --- | --- |
| [4223689983](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223689983) | Multiline SSH keys | Protected key-file references; existing synthetic ed25519 loader/deploy regressions | Fixed in reviewed head; retained |
| [4223689991](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223689991) | amd64 age on arm64 container | Server toolchain explicitly runs `linux/amd64`; platform regression and full server chain | Fixed |
| [4223689997](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223689997) | Operator-specific VM Node path | VM probes `command -v node` and guest-relative fallback; existing regression rejects hardcoded guest paths | Fixed in reviewed head; retained |
| [4223690007](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690007) | Exceptions cannot override aggregate failure | Exceptions removed; mandatory failures always block; argument-rejection regression | Superseded by no-exception policy |
| [4223690015](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690015) | Unsigned evidence cannot establish authenticity | Explicit five-dimensional operator-trust model; separate human review and exact-SHA verification; fabricated self-consistent evidence remains possible | Superseded by explicitly authorized operator-trust policy; no cryptographic authenticity claimed |
| [4223690022](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690022) | Shared Docker resources | Per-run network/PG/server/web names; fixed PG DNS alias inside isolated network; no removal of preexisting containers; owner-verified cleanup | Fixed |
| [4223690028](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690028) | Persistent source/dependency export | Per-run temporary export removed by cleanup; logs retained; real-runner acceptance test | Fixed |
| [4223690037](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690037) | Local deploy requires gh/jq | Conditional GitHub-mode command requirements; isolated PATH regression | Fixed |
| [4223690045](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4223690045) | Duplicated required-check lists | `required-checks.txt` consumed by assembler/verifier/runner helpers/fixtures; dispatch-producer coverage; unknown/duplicate check rejection | Fixed |
| [4224201381](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201381) | Failing chains abort before evidence | Captured chain exits; manifest FAIL, failed check FAIL, unexecuted check ABSENT, nonzero final exit and preserved logs | Fixed |
| [4224201394](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201394) | Cleanup trap installed late | Armed immediately after mkdir, before claim/setup writes; nonce ownership, successful-create flags; early-error then successful-next-run test | Fixed |
| [4224201405](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201405) | Origin token persisted | Canonical non-secret host/owner/repo; raw URL unset; synthetic token remote acceptance test | Fixed |
| [4224201412](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201412) | Stale deployment lock TOCTOU | No automatic recovery; deterministic paused stale reader cannot steal a new owner; atomic mkdir and exact owner release retained | Fixed |
| [4224201417](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201417), [4224201426](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201426) | known_hosts owner/mode (duplicate comments) | Shared regular-file/non-symlink/owner/non-writable/content validation at loading and every SSH/SCP use; negative mode/owner/content/symlink regressions | Fixed |
| [4224201434](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4224201434) | Inherited credential alternatives | Unset credential variables before exporting validated selected values; both inline/file inherited-environment regressions | Fixed |

## Validation and completion gates

- [x] Preserve original five stash object IDs and unrelated worktrees; continue
  inherited changes in a separate worktree without editing their originals.
- [x] RED: six main regressions fail against the reviewed head, including the
  deterministic stale-lock interleaving. Additional SSH-use and unknown-check
  tests failed before their fixes.
- [x] GREEN: focused deploy/CI regression files pass on the host; shellcheck
  passes for every changed shell entrypoint/helper.
- [x] Document supervised recovery: suspend launchers, verify no local or
  remote deployment process/phase is active, remove only inspected claim then
  empty directory; unknown state blocks recovery.
- Required post-commit gate: commit and normal push to the existing PR branch.
- Required post-commit gate: exact-new-head local CI: all 27 mandatory checks, full server/web suites,
  exact SHA/tree verifier, manifest SHA-256 and clean worktree.
- Required post-commit gate: publish exact-head evidence and this per-comment disposition on PR #361.
- Required post-commit gate: wait for completed Codex review of that head and reconcile new findings.

Post-commit gates and final hashes are recorded in the PR conversation and the
external evidence bundle, avoiding a self-referential evidence commit. The required
post-commit gates above are not claims of completed verification. Production is untouched.
