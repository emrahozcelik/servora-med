# PR #361 final production safety reconciliation

Baseline: base `878066ada4c87c325db99f6daa6fae13fe102976`, reviewed head
`f3c5ec1be0745759e4716510705aa20ec84b5af8`, branch `chore/local-first-ci-deploy`.
Scope: targeted reconciliation only; no merge, deploy or production SSH.

## Review disposition

All 23 inline Codex comments from the completed reviews through head
`1990636dc89dff6768499d8e7e1b4d90cbd79f80` were inspected,
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
| [4227729484](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227729484) | Invalid explicit evidence silently falls back | Distinguish omitted option from explicit empty/missing/symlink path; refuse invalid selection even with valid default evidence; function and CLI regressions | Fixed |
| [4227729489](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227729489) | Host UID/root logs not writable by node | Retain host ownership; grant node group access to log/aux directories; root-stage acceptance proves writes and original-owner removal for UID 501 and root 0; exact-tree mount remains read-only | Fixed |
| [4227729497](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227729497) | Dedicated SSH account claim not enforced | Shared `servora-deploy` account constant, exact enforcement in loader and authoritative deploy gate; other valid non-root username rejected | Fixed |
| [4227942443](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227942443) | Explicitly selected manifest never itself verified | Canonical-path equality: the selected manifest must be exactly `<evidence-root>/<sha>/manifest.json`, the file the verifier opens; sibling non-canonical files are refused; regression `refuses a different selected file beside a valid canonical manifest` | Fixed |
| [4227942451](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227942451) | Deploy lock depended on caller `TMPDIR` | Lock moved to the fixed machine-wide `/tmp/servora-med-production-deploy.lock`; cross-`TMPDIR` serialization regression, alongside the retained 12-process contended acquisition and deterministic stale-window interleaving tests | Fixed |
| [4227942462](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227942462) | CI tools not bound to the verified `--repo` checkout | `run.sh` refuses a script/target checkout mismatch with `CI_TOOL_ROOT_MISMATCH` before any lock, resource, evidence or docker use; regression proves no evidence directory and no docker invocation | Fixed |
| [4227942472](https://github.com/emrahozcelik/servora-med/pull/361#discussion_r4227942472) | Lock decision record described removed automatic recovery | `DECISIONS.md` local-first paragraph and F2 entry now record the machine-wide fail-closed lock, supervised manual recovery and the real tests; runbook lock path updated | Fixed |

## Validation and completion gates

- [x] Preserve original five stash object IDs and unrelated worktrees; continue
  inherited changes in a separate worktree without editing their originals.
- [x] RED: six main regressions fail against the reviewed head, including the
  deterministic stale-lock interleaving. Additional SSH-use and unknown-check
  tests failed before their fixes.
- [x] RED (second review round): the three code findings on `1990636` each
  failed first — cross-`TMPDIR` lock, non-canonical selected manifest, foreign
  CI tool root — before their fixes; the fourth (stale decision record) was a
  documentation correction.
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

## Full-suite reconciliation notes

The first post-change run correctly produced `FAIL` with 16 PASS, one FAIL and
10 ABSENT checks after a Linux shellcheck source-path failure. Relative source
paths and all deploy-fixture dependencies were corrected. The next full server
run exposed only the missing macOS packaging fixture and six default-5s CLI
timeouts under amd64 emulation. Fixture assertions remain unchanged; the CLI
file now uses a bounded 60s test budget (an unchanged assertion took 13.4s in
an emulated container). Host focused runs and cross-UID container acceptance pass.

One responsive smoke run encountered `ERR_INSUFFICIENT_RESOURCES`; its
container inherited a soft file-descriptor limit of 1024. The browser chain
now explicitly uses 65536 soft/hard descriptors, verified in a disposable
container. No browser assertions, geometry tolerances or application code changed.

The full server suite contains four explicitly opt-in R2/DR acceptance tests
across three files. Without dedicated non-production acceptance credentials
and opt-in flags, they report SKIPPED, never PASSED. They do not substitute for
any of the 27 mandatory local-CI checks; no real credentials were read.
