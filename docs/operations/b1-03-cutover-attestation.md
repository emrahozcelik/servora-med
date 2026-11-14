# B1-03 — Installed-OLD cutover attestation

**Status:** owner-approved source contract (2026-11-14); implementation under
review. No production authority. Production remains **HOLD / NO-GO**.

## Problem and scope

Grant-bound adoption permanently seals one approval UUID/hash. The original
grant may expire or cross a reboot after publication but before admission; even
a valid static OLD proof then cannot be used. A pre-publication remaining-window
check alone cannot solve that later interruption.

The accepted change separates permanent identity/plan evidence from time-limited
execution authority, solely for the unused OPS-R4-002 OLD
`67d33183d22e00f231ca21a5807cf49a6c4c2a68`. No succession chain or new persistent
consumption journal is needed. Existing admission records already provide the
one-consumption boundary. This contract does not alter the database or the
application, implement a general renewal mechanism, or reinterpret an adoption.

## Two independent requirements

1. A new root-owned `0600`, single-link, canonical record at
   `/var/lib/servora-med/deploy/installed-old-cutover-attestation-67d3318.json`:
   `kind=INSTALLED_OLD_CUTOVER_ATTESTATION_OPS_R4_002`,
   `authority=IDENTITY_AND_PLAN_ONLY_NOT_EXECUTION`.
2. The existing genuine root approval, with its own UUID, hash, current TT-A v2,
   scope, budgets and admission confirmation. An attestation is never approval.

The attestation binds machine/profile/database identity; exact OLD catalog and
original marker; the distinct recovered archive/content manifest; baseline and
dump digests; exact TARGET SHA/tree/artifact/catalog/CI digest; scope ceilings;
and historical TT-A v2 attestation time. The original artifact is still missing.
The recovered archive is never relabelled as original or restore acceptance.

All baseline payload hashes, actual immutable release tree, tar members/types
and `tar --compare`, and the dump's exact migration ledger are rechecked through
the existing verifier. No dump SQL is executed and no database is contacted by
the issuer. A corrupt present retained original archive never falls back.

## Issuance and compatibility

The separate root-only source wrapper is
`ops/recovery-tools/attest-installed-old-cutover-67d3318`. It is excluded from
ordinary release packages; separately reviewed installation would use
`/usr/local/libexec/servora-med/attest-installed-old-cutover-67d3318`, root:root
`0750`. The shared libexec directory stays `0755` for `_chrony`. Do not add this
wrapper, Node or a shell to deploy sudoers.

The wrapper takes exactly `<approved-attempt-uuid> <baseline-id>`. No path,
clock, UID, force or repair selector exists. It sanitizes the environment,
pins the stable lock library, takes its existing lock and requires the RELEASED
bootstrap guard. The guard's manifest and the existing profile pin the installed
controller/dependency closure. The API independently verifies descriptor 9's
stable inode and kernel lock. No host lock is created by issuance.

The administrator must independently review the exact plan before issuance.
The issuer uses that genuine approval as the reviewed plan input, validates its
full admission window before publication and freezes the plan/ceilings; it does
not persist the input's UUID/hash as future execution authority. It preserves
the exact historical gate, current/environment OLD identity and baseline checks.
It publishes exclusively and fsyncs file/directory. A partial record burns its
slot; no overwrite, reissue or automatic repair. A failed command never proves
that no bytes were written: stop and inspect under separately authorized review.

OPS-R4-001 and its historical slot remain unchanged. Existing grant-bound
OPS-R4-002 records remain bound to their original grant. If either the new
attestation or the legacy OPS-R4-002 slot exists, issuance of the other is
refused. Dual evidence, malformed/unreadable records or dangling symlinks fail
closed; there is no automatic conversion or fallback between the two kinds.

## Admission, expiry and interruption

Before first admission, the approval must match the fixed identity/plan and must
not widen any ceiling. The existing 24-hour maximum TTL and 3600-second remaining
window, including pre/post-fsync confirmation, remain the source of truth. The
attestation's time is historical evidence; it cannot reset approval age, boot,
namespace or expiry. Admission cannot predate attestation.

A different UUID may use a new, explicitly issued approval only while the
unchanged `verifyHistoricalPreservationGate()` proves the exact historical 26
sources, or its existing sealed-archive/empty-source alternative, with no new
admission footprints. The check is repeated under host.lock in the persistence
API **before** initializer or directory creation. It never filters out a new
UUID's journal, proof, initializer, log or backup. The 26 historical files and
the old approval/adoption/baseline remain byte-identical.

Once `readRootApproval()` validates the sealed initial record **and** admission
confirmation, only that same UUID and approval hash may continue under existing
budgets after expiry/reboot. It does not reapply an empty-source gate to its own
proven consumption. Zero starts is already consumed; loss/retirement of the
active owner or a terminal abort cannot make a second UUID eligible. A changed
approval under the same UUID conflicts with its original consumption evidence.

An unconfirmed/torn initializer cannot use this exception's normal initialization
repair path. Both same-UUID automatic continuation and another UUID are refused.
No files are removed to make the gate pass. Unknown state requires an explicit
operator decision outside this source slice. A process dying releases flock,
but persistent footprints still close fresh admission. Root deliberately
overriding protected policy remains outside the threat model.

## Verification and remaining gates

Tests use deterministic synthetic records, clocks, filesystem and process ports.
The host-flow fixture substitutes **only two synthetic archive/content pins**
inside its test-only source loader, because synthetic payloads cannot reproduce
production hashes. Pure tests independently exercise the unmodified real policy
pins. Passing host-flow tests is not real archive, NTS, power-loss or production
attestation evidence. No production data enters tests or CI.

The source suite covers fresh authority after expiry/reboot, narrowed ceilings,
fixed identities/catalog/CI, missing approval, exact window bounds, confirmed
zero-start consumption, new UUID rejection, partial publication and admission,
EIO/ENOSPC, ownership/mode/link/read failures, legacy coexistence and corrupt
retained artifacts. CI additionally runs the wrapper in a disposable root Linux
container with real permissions/flock. Actual positive systemd/Chrony and reboot
acceptance, final resulting-main artifact retention, isolated backup restore,
current root-only host evidence and production authority remain separate gates.

No merge or source CI result is production installation/release/migration 061
permission. Freeze the final deployment package only after the necessary source
changes and acceptance, rather than installing each intermediate toolset.

### Source validation record — 2026-11-14

| Check | Result |
|---|---|
| Base `aef1acb…`, new identity/plan regression copied to unchanged source | Expected RED: validator does not exist |
| New identity/plan, host flow, injected faults and private CLI tests | PASS — 18 tests with Node 22 |
| Combined controller/admission/legacy/historical/fence/re-seal/package regressions | PASS — 253 passed, 7 environment-gated skipped (260 total) |
| Server TypeScript build; web TypeScript/Vite build; bundle budget | PASS |
| New/updated wrappers `bash -n`, ShellCheck; `git diff --check` | PASS |
| Exact-head hosted CI and real Linux root wrapper/lock boundary | Pending Draft PR CI; not inferred from local synthetic tests |
| Genuine positive Chrony/systemd, real reboot/power-loss; backup restore | NOT_RUN |
| Production operations, source merge | NOT_RUN |

The seven skipped local tests require the real recovered archive or a separate
explicit disposable-root/container setup. No production fixture was supplied to
make them pass. Hosted CI, source security review and real host acceptance retain
their separate meanings.
