# Issue #369 — First-cutover installed OLD adoption

Status: **implemented in `codex/issue369-first-cutover-baseline`; not deployed.**
Base (TARGET): `d6bb6483f983fbacaff2141355d2dfc04c5d1161`
Installed OLD: `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa`
Original OLD artifact SHA-256 (preserved, never replaced):
`6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672`

`PRODUCTION_GO=false`. Issue #369 stays OPEN. This document describes a code
path that has not run on production; it is not deployment authorisation.

## 1. Problem

R4 proves the OLD release by comparing a **retained upload archive**
(`/var/lib/servora-med/deploy/artifacts/<sha>.tar.gz`) against
`approval.oldArtifactSha256`, then walking the installed tree against its
content marker. The 10 October upload archive no longer exists anywhere that
was searched (`ISSUE369_OLD_ARTIFACT_DISCOVERY.tr.md` →
`ORIGINAL_ARTIFACT_NOT_LOCATED`). The strict path therefore blocks the first
v1→v2 cutover forever, even though the installed tree is byte-identical to its
own root-owned content marker (8,114 files / 9,559 manifest lines verified under
root).

Two things must not be traded away to fix this:

* The original artifact digest and marker stay exactly as they are. The missing
  archive is never recreated, renamed or re-declared as the original.
* A recovery package is not a substitute for artifact provenance. It is a
  **separate identity** with its own digest, bound to one grant, one host, one
  database and one attempt.

## 2. Design

A single, permanent host record authorises exactly one first cutover:

`/var/lib/servora-med/deploy/installed-old-adoption.json`
kind `ADOPTED_INSTALLED_OLD_FIRST_CUTOVER`, `formatVersion: 1`, 18 keys, mode
`0600`, root-owned, canonical JSON.

It is created by `issueInstalledOldAdoption(attemptId, baselineId)`, an
administrator API that is **deliberately absent from the deploy CLI** and
refuses any non-root EUID (`RECOVERY_ADOPTION_ADMIN_REQUIRED`).

`verifyAttemptRelease(attemptId, 'old')` consults it only when the retained
archive is **absent**. Every other path is unchanged.

### 2.1 Why this is not a generic bypass

Four values are compile-time constants, not inputs:

| Constant | Value | Meaning |
| --- | --- | --- |
| `ADOPTABLE_OLD` | `71ae6df6…` | The only release this record can describe |
| `ORIGINAL_OLD_ARTIFACT` | `6f9dbb6a…` | The preserved original digest, re-checked against the installed marker |
| `ORIGINAL_OLD_CATALOG` | `d2854793…` | Canonical digest of the 55-entry OLD migration catalog |
| baseline id pattern | `^\d{8}T\d{6}Z-issue369-71ae6df6$` | The single authorised recovery package |

There is no environment variable, CLI flag, config file or operator-selected
mode that widens this. A different SHA, host, catalog, database or release
fails the binding check. The second and every later release returns to the
strict artifact rule because `verifyAttemptRelease` only falls back for
`direction === 'old'` and only when the sealed record is present.

### 2.2 Issuance preconditions

Issuance refuses to run unless all of these hold:

1. `EUID === 0`.
2. The adoption slot is empty — `RECOVERY_ADOPTION_ALREADY_SEALED` otherwise.
   A partially written record burns the slot; there is no renewal, overwrite,
   repair or delete-and-retry.
3. The host is quiescent: no `active.json`, no `activation.block`, no
   `/run/servora-med-recovery/start.permit`, no
   `servora-med.service.d/90-servora-recovery.conf`, and empty `attempts/`,
   `initializations/`, `admission-proofs/` — else
   `RECOVERY_ADOPTION_STATE_NOT_EMPTY`.
4. `loadAttempt()` passes: root grant, root profile, `/etc/machine-id`, host
   contract hashes, env baseline.
5. `/opt/servora-med/current` resolves to `/opt/servora-med/releases/71ae6df6…`,
   the env tuple names that release and schema `055_…`.
6. No retained archive exists at `artifacts/71ae6df6….tar.gz`. If one does, the
   strict path already applies and adoption is refused.
7. `<release>/.servora-release-artifact.sha256` still reads exactly
   `6f9dbb6a…\n`.

### 2.3 Independent verification before sealing

`verifyInstalledOldBaseline()` re-derives the evidence instead of trusting the
manifest flags:

* `validateInstalledOldAdoption()` — pure 18-key binding: grant identity, grant
  digest, profile, machine, OLD release, original digest, catalog digest,
  target release/tree/artifact, baseline id shape, and every 64-hex field.
* The attestation is validated **against the grant's original window**
  (`validateApproval(approval, record.attestedTime)`). It proves a historical
  root action inside that window; it does not re-anchor or extend the grant.
* Baseline must declare `restoreAcceptance: false`, must not complete after the
  attestation, must agree on database identity, and must carry all six static
  verifications true.
* Every payload named in the manifest is re-read through `trustedFile(…, 0o600)`
  and must match its recorded size and SHA-256.
* The installed `/.servora-release-content.sha256` must hash to
  `record.oldContentManifestSha256`.
* `tar --list` (with types) must produce **exactly** the installed release entry
  set plus `.` and the two marker files — no missing, extra or duplicate member.
* `tar --compare --file <archive> --directory <releaseRoot>` compares bytes,
  file types, modes, owners and symlink targets in place. The archive is never
  extracted or executed.
* `pg_restore --list <dump>` must succeed. This is a catalog/history check, not
  a restore.

Only after all of that does it write the record with
`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600`, `fsync` the file, `fsync` the
directory, re-sample trusted time to re-validate the grant, then read the record
back through `readProtectedRecord` and compare digests.

### 2.4 Consumption

`verifyAttemptRelease(attemptId, 'old')`:

```
marker file === expected digest          -> else RECOVERY_RELEASE_UNPROVEN
verifiedReleaseEntries(root)             -> unchanged walk + content marker
retained archive present?
  yes -> digest must equal expected      -> corrupt/foreign/dangling never falls back
  no  -> direction must be 'old'         -> else RECOVERY_RELEASE_UNPROVEN
         read sealed adoption
         verifyInstalledOldBaseline(...) -> full re-derivation above
```

The target direction keeps its existing helper/module/unit hash comparisons and
never consults the adoption record.

## 3. Preserved invariants

| Invariant | Where enforced |
| --- | --- |
| Original digest and marker never change | Constant + marker comparison; `record.adoptedArchiveSha256 !== approval.oldArtifactSha256` |
| Recovery package is a separate identity | Distinct `sha256` for `installed-old-release.adopted.tar.gz`; `kind: RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT` |
| Installed content manifest verified | Marker digest + full `tar --compare` |
| Independent root attestation | Root-only API, separate record, absent from CLI |
| Separate DB backup identity bound | `databaseDumpSha256`, `databaseIdentity` equality, `pg_restore --list` |
| No general bypass | Compile-time constants, single baseline-id pattern, single slot |
| Old grants/journals never re-sealed | Record is a new file; no journal, checkpoint or grant file is written |
| Fail-closed on missing/inconsistent records | Unknown/extra keys, missing verifications, future completion, foreign DB, stale attestation all throw |
| Second and later releases use strict rule | Fallback requires `direction === 'old'` |

## 4. Test coverage

`ops/tests/installed-old-adoption.test.mjs` — 29 tests, all passing on
Node 22 / macOS. Wired into `server-tests` in
`ops/local-ci/chains/server-chain-user.sh` and into the GitHub `server` job.

Pure binding (15): valid record accepted; content-manifest contradiction;
different OLD release; renamed original digest; non-preserved catalog; foreign
machine; attestation outside the grant window; baseline completed after
attestation; baseline claiming restore acceptance; missing static verification;
different database; extra/missing keys; adopted archive reusing the original
digest; baseline id outside the authorised slot; target binding mismatch.

Host boundary, in-memory Linux fixture that executes the real controller and the
real protected readers (14): deploy user cannot issue; administrator seals
exclusively and the record is byte-exact; `tar --compare` and
`pg_restore --list` are actually invoked; retained archive present; another
attempt owns the host; an admission record exists; archive member list differs;
archive member type differs; dump cannot be listed; installed content marker
changed after the baseline; payload bytes drifted; sealed record is permanent;
partially published record burns the slot; OLD verification succeeds only
through a sealed adoption; corrupt retained archive never falls back to
adoption.

Every host-level rejection also asserts that **no partial adoption record was
written**.

Not covered by this slice, and deliberately not claimed:

* Real root issuance on production (forbidden by the task).
* Real `tar`/`pg_restore` behaviour on the actual 16.7 MB archive and 4.6 MB
  dump (the fixture returns synthetic output).
* Migration abort / forward-only boundaries — these are the existing R4
  contract (`docs/operations/r4-forward-recovery.md`), untouched here.
* Cross-process/reboot continuity for the adoption path.
* Full local CI 27 gates.

## 5. Open items

1. **No operator CLI for issuance.** The task forbade root approval issuance, so
   the API exists without a reviewed root-only entry point. A future slice must
   add a fixed, root-only command (mirroring the `issueRootApproval` pattern)
   before this can be used. Until then the fallback is unreachable in
   production and behaviour is unchanged.
2. **`baseline.verifications` booleans are trusted.** `pg_restore --list` is
   re-run, but `dumpCatalogExact` is not recomputed against the OLD catalog at
   adoption time. The manifest is root-owned, `0600` and covered by
   `baselineManifestSha256`, so the threat model is narrow; recomputing the
   catalog comparison would still be stronger.
3. **Compile-time pinning is intentional debt.** `ADOPTABLE_OLD`,
   `ORIGINAL_OLD_ARTIFACT`, `ORIGINAL_OLD_CATALOG` and the baseline-id regex must
   be removed or superseded once the first cutover completes, or they become a
   second, permanent release selector beside the real one.
4. **Backup producer is not a committed tool.** The recovery set was built by
   one-off scripts under `/private/tmp`; only its manifest and outputs are
   retained. Reproducibility of the recovery point depends on those scripts
   surviving outside the repo.

## 6. Evidence

* Recovery baseline: `/Users/emrah/.local/share/servora-med/recovery-baselines/20261028T055858Z-issue369-71ae6df6/`
* Baseline report: `/Users/emrah/.local/share/servora-med/issue369-recovery-baseline-20261028/ISSUE369_NEW_RECOVERY_BASELINE.tr.md`
* Deployment gate that consumes this: `production-deployment.md`, `r4-forward-recovery.md`
* Prior audits: `ISSUE369_R4_IMPACT.md`, `ISSUE369_ACCEPTANCE_MATRIX.md`
