# OPS-R4-002 root-only atomic profile re-seal

**Status:** bootstrap/review tool. It is **not** a production release component.
`ops/deploy-production.sh` explicitly excludes this directory from the release
artifact. The reviewed bytes must be transferred and hash-pinned separately
during bootstrap. Never add this tool to deploy sudoers.

The separate `attest-installed-old-cutover-67d3318` wrapper is also outside the
normal artifact. It issues only the new B1-03 immutable identity/plan record,
never execution authority. See [B1-03](../../docs/operations/b1-03-cutover-attestation.md)
for compatibility, same-lock admission and separate production authorization.

## Fixed paths

The production CLI has no path selector, force flag, recovery mode or archive
selector. It only reads:

```text
/var/lib/servora-med/deploy/profile.json
/var/lib/servora-med/deploy/historical-dispositions/6ce4cff0-fa73-450e-b540-3f54ae429e7c.json
/var/lib/servora-med-recovery-archive-staging/6ce4cff0-fa73-450e-b540-3f54ae429e7c/
/var/lib/servora-med-recovery-archive-staging/6ce4cff0-fa73-450e-b540-3f54ae429e7c.stage-receipt.json
/etc/servora-med/servora-med.env
/etc/machine-id
/usr/local/libexec/servora-med/*
/etc/systemd/system/servora-med.service
/etc/chrony/chrony.conf
```

Usage:

```text
profile-reseal --dry-run
profile-reseal --apply --expected-old <64-hex> --expected-candidate <64-hex>
```

## Security contract

- Stable `/var/lib/servora-med/deploy/host.lock`: the wrapper takes the kernel
  lock on fd 9 and `servora_assert_no_pending_attempt` runs before Node. Node
  re-checks the inherited fd 9 inode, owner, mode, link count and `flock`.
- Pending state is fail-closed: `active.json`, `activation.block`, the start
  permit, the recovery systemd drop-in and any reserved initialization abort.
- Profile, disposition, receipt and contract files are opened with
  `O_NOFOLLOW`; root ownership, exact mode and `nlink=1` are enforced, with
  parent-directory checks.
- The old profile is an exact SHA-256 compare-and-swap (`--expected-old`). The
  candidate is built only from live installed bytes and must equal
  `--expected-candidate`.
- The disposition must bind `profileSha256` to the old profile, be
  `ABANDONED_SUPERSEDED / NOT_ACCEPTED`, `terminal=false`,
  `lastSequence=17` and `starts=2`.
- Historical acceptance verification is mandatory even in the core API. A missing
  verifier fails closed; only the exact `IN_PLACE_PRESERVATION_VERIFIED` result
  from the installed controller allows a candidate to be computed.
- The OPS-R4-005 stage receipt must bind the same old profile and disposition;
  the OPS-R4-006 readback verifies all 28 staged files and the exact tree.
- All nine contract values are measured from the live files:
  helper, node, unit, attempt, db guard, reconciliation, controller, TT-A and
  chrony config. No old profile value is trusted for the candidate.
- TT-A must return formatVersion 2 evidence. The environment baseline, machine
  id and read-only PostgreSQL cluster/database identity must match the old
  profile.
- The candidate is canonical `JSON.stringify(record) + "\n"` with exactly the
  six profile keys and nine contract keys.
- Apply writes a same-directory `O_EXCL|O_NOFOLLOW` temp at `0600`, fsyncs it,
  rereads and validates it, performs a final old-profile CAS, `rename(2)`, then
  fsyncs the directory and performs an exact post-rename readback.
- On failure before rename only the tool's own temp file is removed. On failure
  after rename there is no rollback, repair or second write. The staged
  `preserved/profile.json` is the authoritative pre-reseal copy; restoring it
  also requires restoring the old installed tool set and is a separate,
  explicitly authorized operation.

## Install layout

Install the reviewed bytes together, root-only:

```text
/usr/local/libexec/servora-med-profile-reseal/          0750 root:root
  profile-reseal                                        0750 root:root
  profile-reseal.mjs                                    0644 root:root:1
```

`/usr/local/libexec/servora-med/host-operation-lock.sh` must already be the
reviewed `a5564b6e...` file (`0644 root:root:1`). The tool does not create or
reclaim the stable lock.

## Reviewed release identity (audit snapshot, not standing authorization)

The 2026-11-11 read-only production preflight reviewed the following **exact**
release identity. This is historical evidence for a specifically frozen target,
**not** an instruction to use these bytes for a later main commit.

| Field | Reviewed value |
|---|---|
| Target commit | `570710a4ce3cb4cd8748c6e94d45781232b78e82` |
| GitHub push CI | `43079287578` — SUCCESS (server, web, Auth KDF, release-package) |
| GitHub artifact ID | `13885572970` |
| Artifact name | `servora-med-release-570710a4ce3cb4cd8748c6e94d45781232b78e82` |
| Release tarball SHA-256 | `6e68ed862772f691563f47172775deb4fca54ba31716ed985b40f4aa0b89784d` |
| `ops/deploy-production.sh` source SHA-256 | `22fe69e83eda35dc51d5d979dda665d13af09c79157d0123a0b98b9f2933f810` |

The **old** `411251d8` artifact
`8aa70edbacfe88c80ef491e7150f99095be46484797862c97c795d8e145488fb`
must not be substituted for this target; it is not the approved exact-main
artifact and predates the reviewed packaging exclusion.

Before any separately authorized bootstrap, an operator must freeze the target
commit and independently verify the corresponding *completed successful*
exact-head push CI, artifact identity, tarball and one-line checksum sidecar,
and the absence of `ops/recovery-tools/` members. Require `origin/main` to
match the frozen exact-main target at that approval gate. A changed main SHA,
new artifact, differing sidecar, expired/unavailable artifact or live host
drift is a **STOP**: repeat the source/CI/artifact review and obtain fresh
release-specific authority. Do not update a SHA in this README and infer
approval; the release/CI identity belongs in a separately reviewed operator
approval, not an automatically advancing documentation pin.

## Bootstrap sequence

1. Install the exact-main OPS-R4-002 host modules and CLIs only from the
   verified, operator-frozen artifact described above, including the reviewed
   M1 `deploy-production-host` helper
   `3455e5881baf770458bc044ca73c50660b75822ec0827a42c9eb7ea39575363c`.
   Re-check installed bytes against the reviewed manifest; do not assume
   that a source hash proves the live host bytes. Do **not** install the
   `profile-reseal` tool from the artifact: it is deliberately excluded.
2. Transfer this directory separately, verify the manifest hashes below,
   install the wrapper/module layout above and keep the old profile live.
3. Verify `sampleTrustedTime()` returns v2 evidence through the
   **canonical installed** `/usr/local/libexec/servora-med/trusted-time.mjs`
   with SHA-256 `d28fb396...`. A successful sample from a forward-time
   overlay alone does not prove that the canonical module has been upgraded.
4. Issue the historical disposition, then stage and read back the 28 files.
5. Run `profile-reseal --dry-run` and review the candidate hash and changed
   contracts. The expected M1 candidate is
   `a5f2dbd5b17ed55b2b3f46e46c6772a146b5cffd90bee509b3f9a92183b0c86d`.
   The expected old profile is
   `7a26bd58923a567992b9c9ca5abc6cad7922b2ac51c5c0a79e7e839ffacdf31d`.
6. Only after a separately authorized, reviewed `--dry-run` **and
   a separate, explicit owner authorization for `--apply`**, execute the
   atomic re-seal. **A dry-run approval does not authorize `--apply`.**
   The apply authorization must bind the exact live old-profile SHA-256 and
   the exact candidate SHA-256 measured and reviewed in the dry-run.
   Supply **both complete 64-character lowercase SHA-256 values**:
   `profile-reseal --apply --expected-old <full-old-sha256> --expected-candidate <full-candidate-sha256>`.
   The abbreviated audit examples above are not valid executable inputs and
   must never be copied as authority. Any mismatch is STOP; do not force,
   repair, retry or infer authorization from a prior approval.
7. Verify the new profile hash, all nine contracts, env/machine/DB identity,
   TT-A v2 and `verifyHistoricalPreservationGate()`.
8. Only then capture the 67d3318 baseline, issue the new root approval, issue
   the OPS-R4-002 adoption and run attempt-preflight/admission. Each remains a
   separately authorized operation.

## STOP / crash matrix

| Point | State | Required behavior |
|---|---|---|
| Before temp | old profile | Abort; no write |
| During temp write (ENOSPC/EIO) | old profile, partial temp | Remove only own temp; STOP |
| After temp fsync, before rename | old profile, complete temp | Final CAS; abort and remove temp on any mismatch |
| During rename / power loss | atomically old or new | Verify hash; never repair |
| After rename, before dir fsync | old or new (never torn) | Verify hash; STOP if unexpected |
| After dir fsync, before readback | new profile | Readback; STOP on failure |
| Post-rename readback failure | new profile | **No rollback, no repair, no second write** |
| Missing/busy lock | old profile | STOP before any read/write |
| Pending marker | old profile | STOP before any read/write |
| CAS/candidate/contract/env/DB/machine/TT-A/historical mismatch | old profile | STOP before any write |

## Tests

Targeted Linux tests (no 27/27 requirement):

```bash
node --test ops/recovery-tools/profile-reseal.test.mjs
node --test ops/recovery-tools/profile-reseal-failures.test.mjs
node --test ops/recovery-tools/profile-reseal-cli.test.mjs
node --test ops/recovery-tools/profile-reseal-lock.test.mjs
node --test ops/recovery-tools/packaging-exclusion.test.mjs
```

The wrapper integration test is hard-gated to a disposable root Linux
container. The full acceptance image adds a real PostgreSQL cluster for the
database-identity probe:

```bash
docker build -t servora-profile-reseal-test:bookworm - <<'EOF'
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql postgresql-client util-linux \
 && rm -rf /var/lib/apt/lists/*
EOF

docker run --rm -e PROFILE_RESEAL_CONTAINER_TEST=1 \
  -v "$PWD":/work:ro -w /work servora-profile-reseal-test:bookworm \
  node --test --test-concurrency=1 ops/recovery-tools/*.test.mjs
```

The E2E test (`profile-reseal-e2e.test.mjs`) builds a fully synthetic old host
state, installs the real wrapper/module and the real host modules, creates a
real read-only PostgreSQL identity, and runs a successful `--dry-run` and
`--apply` through the actual root wrapper. It verifies the atomic write,
post-rename readback, all nine live contracts, the 26/28 historical evidence
chain, and that every historical byte is unchanged.

A non-privileged container cannot run systemd/chrony/NTS. The E2E therefore
installs a synthetic TT-A adapter at the installed `trusted-time.mjs` boundary
that emits a schema-valid v2 record; the real `validateCurrentTimeEvidence`
still consumes it. Production must install the real `trusted-time.mjs`
(`d28fb396...`), not this test adapter. The E2E never runs on a real host and
refuses to start if any production state path already exists.

## Release-artifact impact

The `ops/recovery-tools/` directory is excluded from `package_artifact()`;
the profile re-seal tool is not shipped and needs separate reviewed,
hash-pinned transfer. The `570710a4...` artifact in the audit snapshot above
was verified to contain no recovery-tool members; the old `411251d8`
artifact must not be used for that target.

**Even a docs-only merge of this README changes the main commit SHA.** An
exact-main release built for that new SHA needs a new successful CI run,
artifact identity, checksum and release-specific approval. Although this
README is excluded from the tarball, neither the earlier target SHA nor its
artifact/CI approval may be silently relabelled for a new main. Conversely,
this README edit does not by itself revoke the integrity of the historical
`570710a4...` artifact; its use is subject to the separately reviewed
freeze/authorization policy. Never infer production authorization from this
document, a successful CI, or an old approval.

The source hashes in the manifest below bind the independently transferred
tool bytes, not any deployment artifact or live profile.

## Source manifest

Reviewed install bytes (2026-11-11):

| File | SHA-256 |
|---|---|
| `profile-reseal` (wrapper) | `dc4be7b49edf294ac6ab3d82b7c588ef75746a5b34a0e3685e904b767050548e` |
| `profile-reseal.mjs` (module) | `c069b9ebdb695987f99525ec481830a1fb5de0c068137053af64c13583f4ca2f` |
| `host-operation-lock.sh` (unchanged dependency) | `a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e` |

The wrapper pins the module's exact SHA-256; a reviewed module update requires
updating the wrapper constant, the manifest and the review evidence together.

