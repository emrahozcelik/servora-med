# OPS-R4-003 — historical recovery disposition and archive gate

**Status:** source contract and runbook. This document does not authorize a
production disposition, archive, profile re-seal, bootstrap, baseline,
approval, migration or deployment. Each remains a separately approved
operation.

OPS-R4-001 behavior is unchanged. OPS-R4-002's exact `67d3318` identity,
original/recovered digests, content manifest, catalog and separate adoption
slot are unchanged. OPS-R4-003 adds a **historical disposition** and an
**archive-completion precondition** for the one consumed, nonterminal
OPS-R4-001 attempt. It is not an approval and never turns the attempt into
`COMPLETED` or `ACCEPTED`.

## 1. Exact historical evidence

| Item | Expected evidence |
|---|---|
| Attempt | `6ce4cff0-fa73-450e-b540-3f54ae429e7c` |
| Last phase | `POSTDEPLOY_BACKUP_PASSED` |
| `observationPassed` | `false` |
| `smokePassed` | `true` |
| Starts | `2 / 2`; abort starts `0 / 1` |
| OLD release | `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa` |
| OLD artifact | `6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672` |
| Target release | `f5f87d450061ca12ee80451c55eb56e99b80823c` |
| Target tree | `ab6f387460259c29ff3a30ba25e9619b39b7f7c8` |
| Target artifact | `d85c13c465a4ad5e3ea33ed2a8d8d6271707d3303c000ea731648f1f49153b33` |
| Expected approval file SHA-256 | `55928f2cf6c055c96c985bd1c4c1b5bd0da1c715ed4de027514cdd6f9f9592aa` |
| Expected initial checkpoint SHA-256 | `9769519aa5eefadaf0a326c4b74ba480e27a0b2a861dfd4f89ce0fb3e27780eb` |
| Expected last checkpoint SHA-256 | `f4f1aa95313302f469ea4932842f1a401107232b21a34a2d25d8c6c68d2fa772` |
| Expected emergency receipt SHA-256 | `00c5f40ffbe839c93c80b89650fa85467c576e7bcf8c821205f267c2c9749e06` |
| Expected postdeploy log SHA-256 | `c555940fef38902fe5fcfa18c59936a154f507b542eedad0e8991f157a4460b6` |
| Expected postdeploy rc SHA-256 | `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865` |
| Expected OPS-R4-001 adoption SHA-256 | `90ffa9ac3d213c8cb344b0a137710f029cc2f32a9e44356f6216e35eef98aed5` |
| Expected OPS-R4-001 baseline manifest SHA-256 | `126878c1bba05428978b71d15df1b9bfa2c26c9acc525ff2c583f47c1c53c32f` |

The expected hashes are audit evidence for the operator. The disposition
record binds the bytes actually read through the root-private reader; source
code does not accept a caller-supplied hash, attempt, path or mode.

`r4Acceptance` is **`NOT_ACCEPTED`**. `r4TerminalState` is
`HEALTH_PASSED_FENCED`. `operationalStatus` is
`EMERGENCY_RESTART_POLICY_RESTORED`. The disposition classification is
**`ABANDONED_SUPERSEDED`**. None of these is a terminal lifecycle state.

## 2. Root authority and trusted time

The existing repository does not use a cryptographic approval signature. Root
authority is the reviewed root-owned fixed path plus host lock, root ownership,
single-link `0600` canonical records and trusted-time evidence. OPS-R4-003 uses
that existing mechanism; it does **not** invent a GPG/SSH signature or claim
one.

The disposition is a separate root authority from a deployment approval:

- It can only be created by the no-argument administrator CLI/API.
- It requires the stable `host.lock`, no pending deployment/recovery marker,
  the exact live attempt, the exact approval and the exact emergency receipt.
- It records the trusted-time sample that authorized the disposition.
- It never authorizes a start, migration, deployment, backup or restore.
- It never changes the attempt journal or creates a synthetic terminal phase.

## 3. Disposition record

Fixed path:

```text
/var/lib/servora-med/deploy/historical-dispositions/6ce4cff0-…json
root:root 0600, canonical JSON + LF, one link
```

Exact keys:

```text
formatVersion kind dispositionId attemptId classification approvalSha256
profileSha256 machineId oldReleaseSha targetReleaseSha targetTreeSha
targetArtifactSha256 initialCheckpointSha256 lastCheckpointSha256
admissionProofSha256 checkpointCount lastSequence lastPhase observationPassed
smokePassed starts maxStarts abortStarts maxAbortStarts terminal r4Acceptance
emergencyReceiptSha256 postdeployLogSha256 postdeployRcSha256 oldAdoptionSha256
oldBaselineManifestSha256 oldBaselineSha256SumsSha256 issuedAtUTC issuedTime
```

Key invariants:

- `kind = HISTORICAL_RECOVERY_DISPOSITION`.
- `attemptId` is exactly `6ce4cff0-…`.
- `classification = ABANDONED_SUPERSEDED`.
- `terminal = false`; `r4Acceptance = NOT_ACCEPTED`.
- `lastPhase = POSTDEPLOY_BACKUP_PASSED`; `lastSequence = 17`;
  `checkpointCount = 18`; `observationPassed = false`; `smokePassed = true`.
- `starts = 2`, `maxStarts = 2`, `abortStarts = 0`, `maxAbortStarts = 1`.
- `approvalSha256`, `profileSha256`, checkpoint hashes, admission-proof hash,
  emergency-receipt hash, postdeploy log/rc hashes, OPS-R4-001 adoption hash,
  baseline manifest hash and baseline `SHA256SUMS` hash are all bound.
- `issuedAtUTC = issuedTime.wallAtUTC` and the trusted-time evidence is format
  2. The record is permanent historical evidence, not an expiring grant.

The administrator CLI is:

```text
/usr/local/libexec/servora-med/issue-historical-recovery-disposition-6ce4cff0
```

It accepts **no arguments**, is root-only and is never added to deploy
sudoers. It is separate from `issue-installed-old-adoption` and
`issue-installed-old-adoption-67d3318`.

## 4. Sealed archive layout

Fixed archive directory:

```text
/var/lib/servora-med-recovery-archive/6ce4cff0-…/
  ARCHIVE-MANIFEST.json
  ARCHIVE-COMPLETE.json
  SOURCE-EMPTY-PROOF.json
  preserved/profile.json
  preserved/disposition.json
  attempts/6ce4cff0-…/0000.json … 0017.json
  admission-proofs/6ce4cff0-….json
  backups/6ce4cff0-…-pre.dump
  backups/6ce4cff0-…-post.dump
  logs/6ce4cff0-…/migration.log
  logs/6ce4cff0-…/observation-80472679-….log
  logs/6ce4cff0-…/observation-8656d395-….log
  logs/6ce4cff0-…/postdeploy-operator-20261101T040551Z.log
  logs/6ce4cff0-…/postdeploy-operator-20261101T040551Z.rc
```

The archive root and every directory are `root:root 0700`; every file is
`root:root 0600`, regular, single-link, non-symlink. The exact file set is the
26 moved files, two preserved copies and three metadata files. Extra files,
missing files, symlinks, hardlinks, foreign owners or unexpected modes fail
closed.

The synthetic fixture
`ops/tests/historical-recovery-fixture.mjs` is the executable shape reference
for the three records. It contains no production data and is not a production
sealer; the reviewed one-off archive operation must use the same canonical
shape and hashes.

`ARCHIVE-MANIFEST.json` binds:

- exact attempt, disposition hash, approval hash, old profile hash, machine ID,
  OLD/TARGET release/tree/artifact;
- 26 `archivedFiles` entries with `sourcePath`, `archivePath`, type, mode,
  owner, group, link count, size, SHA-256 and `symlinkTarget: null`;
- seven `preservedEvidence` entries: the live OPS-R4-001 adoption, approval,
  baseline manifest, baseline `SHA256SUMS`, emergency receipt, archived old
  profile copy and archived disposition copy;
- the five source directories with `afterEntries: 0`;
- checkpoint count/head/phase/flags/start budget;
- a UTC creation time after the disposition time.

`SOURCE-EMPTY-PROOF.json` binds the five source directories as present,
`root:root 0700`, non-symlink and empty, all four pending markers false, and
the disposition/manifest hashes. The issuer re-checks the live directories; the
proof is not accepted on its own.

`ARCHIVE-COMPLETE.json` binds the disposition, manifest and source proof
hashes, the exact attempt/archive ID, `complete: true`, `terminal: false`,
`lastPhase: POSTDEPLOY_BACKUP_PASSED`, `observationPassed: false`,
`starts: 2`, 18 checkpoints and the final checkpoint hash. Its completion time
must be after the proof and not later than the current trusted time.

## 5. Crash-safe order

The sequence is intentionally **copy → verify → durable seal → source removal
→ empty-state proof → complete**. It must run under the stable host lock and
with no active deployment, recovery, admission or maintenance operation.

1. **Quiescence:** `active.json`, `activation.block`, start permit and recovery
   drop-in absent; `initializations/` empty; host lock held; service healthy;
   no deployment/recovery process.
2. **Pre-state:** record every source file's type, owner, mode, link count,
   size, SHA-256 and the exact five-directory entry counts. Rehash every
   OPS-R4-001 baseline payload listed in its manifest and verify the baseline
   `SHA256SUMS`; the gate repeats the payload rehash at issuance. Do not remove
   anything yet.
3. **Disposition:** install the reviewed controller/disposition CLI and the
   reviewed TT-A `trusted-time.mjs`, keep the old profile live, and run the
   no-argument disposition CLI. This must happen **before** the profile
   re-seal, because the disposition must bind the old profile bytes and the old
   approval; the TT-A module is required so the disposition can obtain a real
   trusted-time sample. The archive procedure copies the old profile into
   `preserved/profile.json`. During this window the old profile's controller
   and time hashes are intentionally stale; do not run a deployment, admission
   or other profile-validating maintenance command until the archive is sealed
   and the profile is re-sealed. The host lock and pending-state checks remain
   mandatory.
4. **Copy:** copy the exact 26 allowlisted files and the old profile/disposition
   copies to a sibling staging directory outside the sealed archive directory
   (or remove staging before sealing). Never leave staging or audit scratch
   files inside the sealed archive directory; the gate requires its exact tree.
   Verify each copy against the pre-state hash and size. Do not remove the live
   sources.
5. **Seal manifest:** write the canonical manifest with the actual copied
   hashes/sizes and the live evidence hashes. Verify it against the copied
   bytes. If any copy or hash differs, stop; the live sources remain intact.
6. **Source removal:** only after the manifest and copies verify. Remove the
   exact allowlisted files one by one; never use `rm -rf`, globs or
   `find -delete`. Remove the now-empty attempt/log subdirectories, but keep
   `attempts/`, `initializations/`, `admission-proofs/`, `backups/` and `logs/`
   present as `root:root 0700`.
7. **Empty-state proof:** re-read the five live directories, verify they are
   present, trusted and empty, verify the four pending markers are absent, and
   write `SOURCE-EMPTY-PROOF.json`.
8. **Complete:** write `ARCHIVE-COMPLETE.json` binding the disposition,
   manifest and proof. Fsync the file and directory. The archive is sealed.
9. **Gate:** `verifyHistoricalArchiveGate()` must pass. The OPS-R4-002 issuer
   calls it automatically before publication; it is not a caller-selectable
   mode.
10. **Then** re-seal the profile with the new controller/TT-A module, capture
    the new 67d3318 baseline, issue the genuine new root approval and run
    OPS-R4-002 issuance.

Crash behavior:

| Crash point | Result |
|---|---|
| Before disposition | No disposition; issuer rejects |
| After disposition, before manifest | No complete manifest; issuer rejects |
| After copy, before manifest | No manifest; issuer rejects; live sources still nonempty |
| After manifest, before/removal | Live sources nonempty; the existing strict check rejects |
| Partial source removal | At least one source directory nonempty; strict check rejects |
| After last unlink, before proof/complete | Directories empty, but proof/complete missing; OPS-R4-003 gate rejects |
| After complete | Gate can pass; issuance still requires the new baseline, approval, profile and release |

The last row is the reason the gate is mandatory: empty directories alone are
not evidence that the archive sealed correctly.

## 6. Reference impact

After the move, these historical commands no longer resolve the attempt at the
live path:

- `attempt-status` / `currentAttempt` for `6ce4…`;
- `emergency-handoff preflight --parent 6ce4…`;
- `adopt-backup` / `assertRetainedBackups` for the old pre/post dumps.

The archive manifest records the exact `sourcePath → archivePath` mapping. Do
**not** create symlinks, stub files or tombstones in the live `deploy/`
directories; they would violate the strict empty-state check. Historical
inspection or rollback must restore the archive in an isolated environment,
not by repopulating the live directories before issuance.

## 7. Rollback and restore

Rollback is a copy-back, not a move back:

1. Hold the host lock; verify the archive complete/manifest/proof and every
   archived hash.
2. Restore exact files to staging under the live parent, verify type/mode/
   owner/size/SHA-256, then publish with exclusive creation. Never overwrite a
   different existing file.
3. Restore the exact checkpoint chain, admission proof, backups and logs;
   verify the pre/post receipt hashes, the admission proof initial hash and the
   approval/disposition bindings.
4. Keep the sealed archive; do not delete it.
5. After restore, the five live directories are nonempty again, so the
   OPS-R4-002 strict check **must fail** and issuance must remain blocked until
   a new authorized disposition/archive decision.

Test rollback in a disposable Linux environment with synthetic files. Do not
copy production dumps, logs, approvals, adoption records or secrets into a
test workstation. Acceptance: restored tree is byte-identical to the pre-state,
checkpoint chain is valid, receipt/initial hashes match, and the strict
empty-state check fails as expected.

## 8. Sensitive retention

The two PostgreSQL dumps and all historical logs move into the root-only
archive. The OPS-R4-001 baseline dumps remain in the baseline root and the
issuer rehashes every payload listed in the baseline manifest. Access is
root-only `0700`/`0600`; do not place the archive in a world-readable path.
This slice does not create an offsite copy. A separate approved retention
operation must copy the sealed archive to independent storage; the archive
root on the same disk is not disaster-recovery proof by itself.

Archive acceptance requires all of the following:

- root-only `0700` archive root/directories and `0600` regular single-link
  files; no symlinks, hardlinks, devices or foreign owners;
- exact 26-file moved set, two preserved copies and three metadata files;
- pre/post dump `pg_restore --list` readability and checkpoint receipt hashes;
- every OPS-R4-001 baseline payload rehashed against its manifest;
- manifest/proof/complete hash chain and source-empty proof;
- a separate independent retention copy with verifiable hashes before any
  production disaster-recovery claim;
- a successful synthetic restore rollback test;
- `verifyHistoricalArchiveGate()` passing without running production issuance.

## 9. Gate scope and stop conditions

The new gate is applied only when the issuance policy is exactly
`OPS_R4_002_POLICY`. `OPS_R4_001_POLICY` keeps its historical behavior and is
not made dependent on OPS-R4-003.

Stop and do not issue if any of the following is true:

- disposition missing, malformed, wrong attempt, terminal/`ACCEPTED`, wrong
  start budget, wrong approval/profile/checkpoint/receipt hash;
- archive manifest, source proof or complete record missing or mismatched;
- any archived file missing, extra, symlinked, hardlinked, foreign-owned or
  hash-mismatched;
- source directories missing, untrusted or nonempty;
- active/activation/start-permit/recovery marker present;
- current machine ID differs from the disposition/host profile;
- trusted time is UNKNOWN or a record claims a future completion;
- the OPS-R4-001 adoption, approval, baseline, emergency receipt or old
  profile copy changed after the disposition.

There is no force, bypass, alternate path, caller-selected archive or
"empty directories imply complete" shortcut.
