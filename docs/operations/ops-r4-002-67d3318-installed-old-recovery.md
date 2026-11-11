# OPS-R4-002 — 67d3318 installed-OLD recovery

**Status:** source contract and runbook. This document does not authorize a
production baseline capture, adoption issuance, bootstrap, migration or
deployment. Each of those remains a separately approved operation.

## 1. Identity

| Item | Value |
|---|---|
| OLD release | `67d33183d22e00f231ca21a5807cf49a6c4c2a68` |
| Original artifact (missing) | `a1db5a8d8faea144f6f18006f09cd9c0f457a6a79782fd5fcd9884f528593ebf` |
| Recovered archive (not original) | `ddf12049ed483062d00b4a1c0fdd4909d01010d9dc9459c3cb5a5c39c142a220` |
| OLD content manifest | `059dedcbaf2de186608e7f975f223a5ac659651d67ca56bbb6a26407a9628aef` |
| OLD catalog (60 entries) | `43f96550a71be82e55d855a677fdf2ecbecf4acf9a0dfba6d9f5ae988bc75c28` |
| Adoption slot | `/var/lib/servora-med/deploy/installed-old-adoption-67d3318.json` |
| Baseline ID pattern | `YYYYMMDDTHHMMSSZ-ops-r4-002-67d3318` |

The recovered archive is a content-equivalent reconstruction of the installed
release. It is **not** the original artifact, does not reproduce
`a1db5a8d…`, and must never be named, hashed or approved as the original.

## 2. Contract

- OPS-R4-001 (`71ae6df6`) is unchanged: its constants, record kind, baseline
  pattern and consumed `installed-old-adoption.json` slot remain historical
  evidence. This contract never deletes, rewrites or reuses them.
- OPS-R4-002 is a separate, immutable policy in
  `ops/scripts/deployment-controller.mjs`; selection is by the approval's
  exact `oldReleaseSha`, never by a caller-supplied path, mode, force flag or
  arbitrary selector.
- A new, root-only API/CLI issues a single record to the separate slot. It
  preserves the existing host lock, pending-state rejection, root ownership,
  trusted-time validation, baseline manifest binding, `tar --compare`,
  PostgreSQL ledger validation and exclusive/fsync publication.
- `verifyAttemptRelease('old')` still prefers an exact retained
  `artifacts/<OLD>.tar.gz`. If absent, it selects the policy for the exact OLD
  release and verifies that policy's sealed adoption. There is no fallback from
  one policy to another.
- The adopted archive hash must equal `ddf12049…` and must differ from
  `a1db5a8d…`. A record whose recovered-archive hash equals the original
  artifact hash is invalid.
- The adoption record is not an approval. A genuine, separately issued root
  approval with the new profile digest remains mandatory for admission.
- OPS-R4-002 issuance also requires a separate OPS-R4-003 historical
  disposition of the consumed `6ce4…` attempt and one of two accepted proofs:
  the sealed archive (source removal, unchanged) or the non-destructive
  in-place preservation branch. Empty `attempts/`, `initializations/`,
  `admission-proofs/`, `backups/` and `logs/` directories are never sufficient
  on their own. See
  [OPS-R4-003 historical recovery disposition](./ops-r4-003-historical-recovery-disposition.md).

## 3. Baseline runbook (host-side, separately authorized)

Do not run this as part of the source PR. The baseline contains a database dump
and must be captured on the target host under an explicit operator approval.

### 3.1 Preconditions

- `current` points exactly to the 67d3318 release; the release directory is not
  a symlink and is root:servora-med with the expected modes.
- `.servora-release-artifact.sha256` is `a1db5a8d…` and the release content
  manifest hash is `059dedcb…`.
- `deploy/artifacts/67d3318….tar.gz` is absent (if it exists, no adoption is
  needed).
- The stable `host.lock` exists; no deployment, admission, recovery or
  maintenance operation is active.
- **Historical recovery state:** the issuer accepts exactly one of two proofs
  for the consumed `6ce4…` attempt:
  1. the sealed OPS-R4-003 archive plus trusted, empty
     `attempts/`, `initializations/`, `admission-proofs/`, `backups/` and
     `logs/`; or
  2. the non-destructive in-place branch: the exact 26 historical files still
     at their live paths, an `ABANDONED_SUPERSEDED / NOT_ACCEPTED` disposition
     and a verified OPS-R4-005 stage receipt whose inventory digest matches the
     live tree.

  Neither proof is satisfied by deleting files, and there is no third mode. The
  current production host has the historical attempt/backup/log state, so it
  takes branch 2 unless a separately authorized archive operation has already
  sealed branch 1. Do not delete or rewrite the historical 71ae6df6 adoption
  record or its baseline.
- A genuine root approval for the target release exists (or will exist) with
  `oldReleaseSha=67d3318…`, `oldArtifactSha256=a1db5a8d…`, OLD catalog digest
  `43f96550…`, the target release/tree/artifact/CI manifest and the new profile
  digest.

### 3.2 Capture

Create a root-only baseline directory:

```text
/var/lib/servora-med-recovery-baselines/<YYYYMMDDTHHMMSSZ>-ops-r4-002-67d3318
  mode 0700 root:root
```

Capture, with root-only `0600` payload files:

1. `installed-old-content.sha256` — the exact release content manifest; verify
   SHA-256 `059dedcb…`.
2. `installed-old-release.adopted.tar.gz` — the recovered archive built from the
   installed release; verify SHA-256 `ddf12049…`, member types/list and
   `tar --compare --directory <release-root>`. Never extract or execute it.
3. `database.dump` — a fresh `pg_dump -Fc` of the 060 database under a separate
   authorized backup operation. Verify `pg_restore --list`; read only the
   `schema_migrations` ledger into memory and require exactly the 60 OLD
   catalog versions (JSON digest `43f96550…`). Do not restore or execute SQL.
4. `configuration.tar.gz` — the reviewed configuration capture for the
   baseline; `database-metadata.json` — cluster/database/role identity.
5. `baseline-manifest.json` — canonical one-line JSON + LF, `root:root 0600`,
   `formatVersion:1`, `kind:"RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT"`,
   `baselineId`, `machineId`, `sourceReleaseSha=67d3318…`,
   `originalArtifactSha256=a1db5a8d…`,
   `installedContentManifestSha256=059dedcb…`, the 60-entry catalog,
   `restoreAcceptance:false`, `completedAtUTC` and all six verification flags
   (`dumpList`, `dumpCatalogExact`, `adoptedArchiveComparedToInstalled`,
   `configurationArchiveCompared`, `originalObservationAndMarkerUnchanged`,
   `appPidUnchanged`) set true.
6. `SHA256SUMS` and a retained capture log; verify every payload hash and the
   baseline manifest digest.

### 3.3 Issuance (separate root authority)

After the baseline and the new root approval exist, and with the new controller
and profile installed:

```text
/usr/local/libexec/servora-med/issue-installed-old-adoption-67d3318 \
  <approved-attempt-uuid> <baseline-id>
```

The command accepts exactly two arguments. It does not accept a path, force,
mode, clock or arbitrary selector. It takes the ordinary stable host lock and
publishes exactly one `installed-old-adoption-67d3318.json`. Duplicate,
partial, foreign-owned or torn publication is refused and burns the slot; there
is no repair, renewal or reissue.

## 4. TT-A and release ordering

The controller change alters `controllerModuleSha256`. A production bootstrap
must, in one separately reviewed sequence:

1. Produce a new exact-main CI run and Linux artifact after the source merge.
2. Install the new `deployment-controller.mjs`, the shared
   `historical-recovery-evidence.mjs`, the reviewed OPS-R4-003 disposition CLI,
   the reviewed OPS-R4-005 staging CLI and the reviewed TT-A `trusted-time.mjs`
   (`d28fb396…`) as root-owned modules. Keep the old profile live for the
   historical binding.
3. Create the OPS-R4-003 disposition, keep the old profile live, then either
   seal the archive (source removal) **or** run the OPS-R4-005 staging CLI to
   create the in-place preservation record. Both must happen **before** the
   profile re-seal, as specified in
   [OPS-R4-003 historical recovery disposition](./ops-r4-003-historical-recovery-disposition.md).
4. Re-seal the host profile with both new contract hashes and the unchanged
   environment/database identity; verify all nine contract digests and
   `sampleTrustedTime()`.
5. Capture the 67d3318 baseline (section 3).
6. Issue a genuine new root approval bound to the new target CI/artifact/profile.
7. Issue the installed-OLD adoption, run `attempt-preflight`, then follow the
   ordinary sealed deployment path.

Preserve all historical approval files, the 71ae6df6 adoption record and its
baseline. Admission remains impossible without a real, unexpired root approval;
the adoption record never substitutes for it.

### Measured source impact (11 November 2026)

The OPS-R4-002 historical acceptance contract changed after exact-main
`402e350af9d057bafe77bfeaeef23fa33b25989a`. These are the current source
hashes on this branch. They are **audit values for the operator, not a
production authorization**: the bootstrap must recompute all installed bytes,
the nine live contracts and the final profile, and any later main/source update
invalidates them.

| Item | Value |
|---|---|
| Previous installed controller (`71ae6df6` cutover) | `f2f6272b972871d8c8529355629e3132a3375e4591791b499de5202130c9bb81` |
| Current controller bytes | `7f50d0cdea947cb4d22d95cac908a99eab66aecfcbd81f00051cb1aa2b947604` |
| Current shared evidence-module bytes | `c6c4eada519183056a05d8c982ef4eaba311289ed271456182a665b7362d254f` |
| Current OPS-R4-002 administrator CLI | `69a655282c72bb85fa2c7d68f99968df46104ba8ac479f8e08aea8c43193264f` |
| Current OPS-R4-003 disposition CLI | `9417cecb254f8e2e65d33c832b72bd2132634873fa9b736e97273946ccb00094` |
| TT-A time module (unchanged by this slice) | `d28fb396527bf91a25ab73fd8dd4f5f3138e2279efc1c6414cdf0d44d93717ab` |
| Obsolete profile estimate from `dee9c5f` (**audit-only, never install**) | `918f8a98cc986257c47ed0956eab92bd85aeb384c32500c4c5c285b49e7fd4aa` |

The earlier GitHub CI run `42822508045` and artifact
`servora-med-release-dee9c5f5067eec86d00bbab728f3b24ea01bf358` remain context
only. The new root approval must bind the **live** final profile, the new
exact-main Linux artifact and its CI evidence, never an obsolete source-PR
controller hash.

The shared evidence module must be installed as
`/usr/local/libexec/servora-med/historical-recovery-evidence.mjs`
`root:root 0750`-directory / `0644`-file, single link, exactly like the other
controller imports. The administrator wrappers and `r4_controller()` check its
owner, mode and link count before invoking Node, and
`verifyHistoricalInPlacePreservation()` additionally pins its **exact SHA-256**
in the controller before calling any function from it. It is deliberately not a
tenth profile contract key: every historical profile carries exactly nine keys
and must stay readable for the retained OPS-R4-001 evidence and the emergency
handoff. The profile already pins this controller's bytes, so the dependency is
pinned transitively without a profile schema change or a second protocol.

The OPS-R4-002 adoption gate and the in-place source-inventory reader also
verify all four pending deployment/recovery marker paths using `lstat`: a
dangling symlink, an unreadable marker (`EACCES`/`ENOTDIR`), or any existing
entry fails closed. This hardening does not alter the OPS-R4-001 issuance path.

**Remaining (non-blocking) gap:** the reviewed archive-removal/sealing tool and
independent off-host retention/restore evidence are still absent. They are
**no longer required** for OPS-R4-002 issuance, because the in-place branch
never removes a source. They remain required for the sealed OPS-R4-003 branch
and for any disaster-recovery claim.

### Current production state precondition

`issueInstalledOldAdoptionForPolicy()` no longer requires the five state
directories to be empty for OPS-R4-002. It calls
`verifyHistoricalPreservationGate()` and accepts either the sealed
`ARCHIVE-COMPLETE` chain over trusted empty sources, or the in-place
`verifyHistoricalInPlacePreservation()` proof described in OPS-R4-003 §12.

So the historical `6ce4…` attempt/backup/log state no longer blocks production
issuance by itself. The remaining prerequisites are operational, not
structural:

- the root-only disposition (`issue-historical-recovery-disposition-6ce4cff0`);
- the root-only OPS-R4-005 stage (`stage-historical-recovery-6ce4cff0`), run
  after the disposition and before the profile re-seal;
- the profile re-seal with the new controller and evidence-module bytes;
- the new 67d3318 baseline;
- a genuine new root approval bound to the new target CI/artifact/profile;
- the exact-main Linux artifact.

OPS-R4-001 issuance is unchanged and still requires the trusted empty
directories; the new branch is selected only by the exact `67d3318` OLD release
SHA.

## 5. Stop conditions

- Original artifact bytes are found: stop this recovery path and use the exact
  `a1db5a8d…` retained archive instead; no adoption is needed.
- Any policy, baseline, catalog, content-manifest, archive or profile digest
  differs: stop; do not repair by rewriting the baseline or record.
- Pending recovery state, a non-root caller, a duplicate slot, an UNKNOWN
  trusted time, or a missing/invalid OPS-R4-003 disposition **and** historical
  proof: stop. A nonempty or untrusted state directory is accepted only through
  the exact in-place inventory proof; an extra, missing or modified historical
  entry is still a stop condition.
- Never use `ddf12049…` as the original artifact, never create a synthetic
  original hash, and never weaken the existing OPS-R4-001 controls.
