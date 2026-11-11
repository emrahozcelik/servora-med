# OPS-R4-002 root-only atomic profile re-seal

**Status:** bootstrap/review tool. It is **not** a production release component.
`ops/deploy-production.sh` explicitly excludes this directory from the release
artifact. The reviewed bytes must be transferred and hash-pinned separately
during bootstrap. Never add this tool to deploy sudoers.

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

## Bootstrap sequence

1. Install the exact-main OPS-R4-002 host modules and CLIs from artifact
   `8aa70edbacfe88c80ef491e7150f99095be46484797862c97c795d8e145488fb`
   (`411251d8`). Do not install this tool from that artifact; it is excluded.
2. Transfer this directory separately, verify the manifest hashes below,
   install the wrapper/module layout above and keep the old profile live.
3. Verify `sampleTrustedTime()` returns v2 evidence through the installed
   TT-A `d28fb396...`.
4. Issue the historical disposition, then stage and read back the 28 files.
5. Run `profile-reseal --dry-run` and review the candidate hash and changed
   contracts. The expected M1 candidate is
   `a5f2dbd5b17ed55b2b3f46e46c6772a146b5cffd90bee509b3f9a92183b0c86d`.
   The expected old profile is
   `7a26bd58923a567992b9c9ca5abc6cad7922b2ac51c5c0a79e7e839ffacdf31d`.
6. Apply only the approved candidate:
   `profile-reseal --apply --expected-old 7a26bd58... --expected-candidate a5f2dbd5...`
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
container:

```bash
docker run --rm -e PROFILE_RESEAL_CONTAINER_TEST=1 \
  -v "$PWD":/work -w /work node:22-bookworm-slim \
  node --test ops/recovery-tools/profile-reseal-wrapper.test.mjs
```

It must never run on a real host.

## Release-artifact impact

The directory is excluded from `package_artifact()`; the tool is not shipped.
The exclusion line itself changes `ops/deploy-production.sh`, so a merge will
produce a new exact-main artifact hash. The baseline `411251d8` artifact
`8aa70edb...` remains the only valid bootstrap source until a new CI/artifact
review is completed. A new artifact invalidates the existing CI/approval
evidence and requires a new root approval.

## Source manifest

Reviewed install bytes (2026-11-11):

| File | SHA-256 |
|---|---|
| `profile-reseal` (wrapper) | `8e47d9f76efebfe43a91bd1862a1ae15eea5c46c592b74f16b58698d610482c8` |
| `profile-reseal.mjs` (module) | `0837ea57670903839fa1bd24fe9a0c4c67e71a565b4623dbde6874082aa7b424` |
| `host-operation-lock.sh` (unchanged dependency) | `a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e` |

The wrapper pins the module's exact SHA-256; a reviewed module update requires
updating the wrapper constant, the manifest and the review evidence together.

