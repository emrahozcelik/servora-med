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
- OPS-R4-002 issuance also requires the separate OPS-R4-003 historical
  disposition and sealed-archive gate for the consumed `6ce4…` attempt. Empty
  `attempts/`, `initializations/`, `admission-proofs/`, `backups/` and `logs/`
  directories are necessary but not sufficient. See
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
- **Strict empty recovery state:** the issuer requires
  `attempts/`, `initializations/`, `admission-proofs/`, `backups/` and `logs/`
  to be trusted, empty directories. The current production host has historical
  attempt/backup/log state; a separate authorized archival/quiescence decision
  is required before issuance. Do not delete or rewrite the historical
  71ae6df6 adoption record or its baseline.
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
2. Install the new `deployment-controller.mjs`, the reviewed OPS-R4-003
   disposition CLI and the reviewed TT-A `trusted-time.mjs` (`d28fb396…`) as
   root-owned modules. Keep the old profile live for the historical binding.
3. Create the OPS-R4-003 disposition and sealed archive **before** the profile
   re-seal, as specified in
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

### Measured exact-main impact (10 November 2026)

These are the independently checked hashes of merged main `dee9c5f5067eec86d00bbab728f3b24ea01bf358`
and its Linux release artifact. The projected profile value is an **audit estimate,
not a production authorization**. The bootstrap must recompute all installed
bytes, nine live contracts and the final profile; any later main/source update
invalidates these hashes.

| Item | Value |
|---|---|
| Previous installed controller | `f2f6272b972871d8c8529355629e3132a3375e4591791b499de5202130c9bb81` |
| New controller bytes (exact merged main) | `0cf7ffe077d0de8e6c10c7171bc817653e2e43bf5959799d8d895f0e26d7a230` |
| Previous installed time module | `e76f85d9955d711cc8f89060e778d4bb57ffd77a8022d670af90d19d5fbba7d1` |
| TT-A time module | `d28fb396527bf91a25ab73fd8dd4f5f3138e2279efc1c6414cdf0d44d93717ab` |
| Current profile digest | `7a26bd58923a567992b9c9ca5abc6cad7922b2ac51c5c0a79e7e839ffacdf31d` |
| Projected profile digest (audit-only, **not** to be blindly installed) | `918f8a98cc986257c47ed0956eab92bd85aeb384c32500c4c5c285b49e7fd4aa` |
| New OPS-R4-002 administrator CLI | `eaa7209132c3e1f5b84e4f9187a8b61f6c222c5ffd034ec76872d87095c1f378` |
| New OPS-R4-003 disposition CLI | `b65108636e3a6e298227f3f9bfd237c8ef7674506d00645c6b3a256d62ec61de` |

The exact-main GitHub CI run `42822508045` passed and produced artifact
`servora-med-release-dee9c5f5067eec86d00bbab728f3b24ea01bf358`.
The inner tarball SHA-256 is
`294426ad1d6527a354da8195f00f7c7ac33217ef1b6da1836781107e5060b9e9`.
The new root approval must bind the **live** final profile, this exact artifact
and target CI evidence, not an obsolete source-PR controller hash.

**Separate blocker:** the reviewed archive-removal/sealing tool and independent
retention/restore evidence are still absent. The read-only OPS-R4-004 inventory
tool only checks the old evidence; it does not permit file movement, unlinks,
disposition, approval, profile re-seal or deployment.

### Current production state precondition

The OPS-R4-002 issuer preserves the existing strict empty-state checks
(`attempts/`, `initializations/`, `admission-proofs/`, `backups/`, `logs/`) and
adds the OPS-R4-003 sealed-archive gate. The current production host still has
the historical `6ce4…` attempt/backup/log state from the consumed OPS-R4-001
cutover. Production issuance remains blocked until a separately authorized
disposition/archive operation preserves that history and presents both trusted
empty directories and a valid `ARCHIVE-COMPLETE`/`SOURCE-EMPTY-PROOF` chain.
The source does not relax the strict check and does not perform that archival
step.

## 5. Stop conditions

- Original artifact bytes are found: stop this recovery path and use the exact
  `a1db5a8d…` retained archive instead; no adoption is needed.
- Any policy, baseline, catalog, content-manifest, archive or profile digest
  differs: stop; do not repair by rewriting the baseline or record.
- Pending recovery state, a nonempty/untrusted state directory, a non-root
  caller, a duplicate slot, an UNKNOWN trusted time, or a missing/invalid
  OPS-R4-003 disposition/sealed archive: stop.
- Never use `ddf12049…` as the original artifact, never create a synthetic
  original hash, and never weaken the existing OPS-R4-001 controls.
