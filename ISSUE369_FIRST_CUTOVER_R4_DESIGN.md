# Issue #369 — First-cutover installed OLD adoption

Status: implemented for review in PR #397; **not installed or invoked on production**.
Base main: `d6bb6483f983fbacaff2141355d2dfc04c5d1161`.
OLD: `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa`.
Original archive digest, preserved:
`6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672`.

`PRODUCTION_GO=false`; Issue #369 stays OPEN. The final PR commit is a new source
identity. Base-main evidence cannot authorize deploying changed helper bytes.

## Authority

Owner-authorized OPS-R4-001 qualifies the strict retained-original-OLD contract
for this single first cutover. The original upload archive was not located.
The new baseline captures installed content; it does not reconstruct the
original upload or prove restoration. Its adopted archive has its own digest.

Normal format-2 grants keep `oldArtifactSha256` equal to the original digest.
A separate administrator attestation binds the recovery baseline to that exact
grant UUID and raw digest, profile, machine, database, original 55-entry SQL
catalog and TARGET SHA/tree/artifact. No grant/journal is modified or resealed.

## Fixed scope and publication

There is one permanent root-private slot:
`/var/lib/servora-med/deploy/installed-old-adoption.json`.
It is canonical JSON plus newline, format 1, kind
`ADOPTED_INSTALLED_OLD_FIRST_CUTOVER`, root:root 0600, single-link regular file.

The validator pins the exact OLD SHA, original digest and canonical 055 catalog
hash `d285479365412eaf25133adec8853be75cb97ac87a46980b814e5321333ee62d`.
The baseline ID is a constrained timestamp plus `-issue369-71ae6df6`, under the
fixed private recovery-baselines root. The chosen exact ID and manifest hash
are sealed into the record. That pattern is not an automatic authorization of
all packages with similar names.

Issuance requires the reviewed root profile/contracts, the OLD current/env
identity and marker, no retained original archive, no active owner/barrier/start
permit/recovery drop-in, and empty, trusted 0700 R4 attempts/initializations/
admission-proofs/backups/logs namespaces. These raw filesystem guards run before
`loadAttempt()` so issuance cannot enter its checkpoint-reconciliation paths.
The administrator independently reviews all inputs through a separate root
channel. The deploy identity receives no issuer capability.

The CLI `issue-installed-old-adoption.sh` is installed only after separate
approval, root:root 0750. It accepts exactly the grant UUID and baseline ID,
checks physical root-owned protected tools, pins the shared lock library digest,
requires an already provisioned host.lock and holds its kernel lock on fd 9.
It clears Node environment overrides and prints only a status and record digest.

The API independently verifies the named/inherited host.lock inode and confirms
or acquires its nonblocking kernel lock before reading state. A direct root call
without that descriptor fails. Issuance and ordinary deployment/admission share
the same kernel exclusion. A root writer ignoring the contract is outside the
root-trusted threat model; bootstrap and other administrative changes require an
exclusive window too.

After verification, the issuer exclusively creates the permanent slot, file-
and directory-fsyncs it, revalidates actual trusted time and checks readback.
A competing publisher cannot overwrite it. A partial record burns reuse and is
never repaired automatically. The record is retained after completion/abort.

## Independent payload verification

Both issuance and OLD proof re-read protected files and:

1. Validate exact record keys and binding to the same grant, profile, machine,
   OLD/content/catalog, TARGET and baseline manifest. Historical attestation
   time must be inside the original grant window; it does not re-anchor age.
2. Match baseline database identity to the sealed profile and its 055 SQL
   catalog to the pinned catalog. Preserve `restoreAcceptance=false`.
3. Rehash every named payload and match its size, including the separate dump,
   adopted release archive, configuration archive and content manifest.
4. Walk every immutable installed entry against the original content marker.
   Require exact adopted tar member count/names/types, no duplicate/extra/
   omitted/special entries, and `tar --compare` in place. Never extract or
   execute adopted code during proof.
5. Run `pg_restore --list`, then `pg_restore --data-only
   --table=schema_migrations --file=-` against the dump. Read only that ledger
   into bounded memory, require exactly one expected COPY block and the exact
   sorted 055 ledger. Missing, duplicate, malformed or diverged history fails.
   No database connection or SQL execution occurs.

The original manifest's static flags preserve capture history; they cannot
substitute for these current hash/archive/ledger checks. Configuration capture
and unchanged source PID/observation are historical producer attestations;
proof does not assert that today's running configuration is unchanged forever.

## Strict path and lifecycle

`verifyAttemptRelease()` still requires the original marker and complete
immutable content/catalog. A present retained archive must match its ordinary
grant digest; corrupt/foreign/dangling archives never fall back. Only an absent
OLD archive can consult the sealed adoption. TARGET never uses it.

The grant digest/UUID binding denies renewal, changed scopes and another attempt.
An unconsumed grant expires normally and cannot cross reboot. Proven consumption
continues only the same journal/scopes/budgets; read-only verification does not
rewrite authority. Completed/aborted attempts do not acquire another start.
After the first release, a different OLD cannot match this record and needs its
ordinary retained artifact. No operator bypass flag or generic compatibility
mode is introduced.

Pre-migration abort still needs a never-committed boundary and fresh OLD EXACT
DB proof; committed/ambiguous TARGET migration remains forward-only. This
baseline is not the mandatory fresh TARGET PRE receipt, postdeploy receipt or
scheduled v2 proof. TARGET's predeploy v2 writer can publish `running` before
dump completion: observation format can already restrict v1 rollback before any
migration. Adoption does not undo that separate reader compatibility boundary.

## Verification

- 43 adoption regressions: binding, root authority, ledger parsing, grant/UUID
  replay, protected-file metadata, torn publication, controller restart,
  consumed versus unconsumed authority, subsequent strict releases, pre-
  migration abort and post-migration forward-only/start-budget rules.
- Real root CLI/kernel test in a disposable Linux container: no-fd direct API
  denial, competing host lock denial, foreign inode denial, library drift denial,
  stable inode preservation. It reaches the real controller and intentionally
  stops at the missing grant; no live attestation is issued.
- Real GNU tar/PostgreSQL 17 integration with a synthetic isolated database:
  valid 055 dump and adopted archive pass; a rehashed wrong-content archive and
  readable rehashed dump missing a migration fail. Host paths/time remain
  fixture-controlled; this is not production/systemd/Chrony acceptance.
- All new checks join existing CI gates. Root CLI checks run in the disposable
  local-CI root stage; ordinary adoption/tool checks run in server-tests. The
  27 required gate IDs are unchanged.

Exact-head Local CI results and source identity are recorded in the permanent
operator validation report and PR after execution. No PASS is inferred from a
skipped check or blocked hosted Actions. No new R4/TT-A systemd fixture is created.

## Recovery evidence and remaining approvals

Baseline `20261028T055858Z-issue369-71ae6df6` is retained under the private
production recovery-baselines root and the protected Mac recovery-baselines
directory. Manifest digest:
`126878c1bba05428978b71d15df1b9bfa2c26c9acc525ff2c583f47c1c53c32f`.
Adopted archive digest:
`104644552259256597c8c563d84eff46698b8bbd02599aa4f4b87ddbdb2d9176`.
Dump digest:
`50d6ef5a6cf46b7c46e7987240ec0f15c4d2e8ccf50f5a7193f790f51e2e204c`.

Capture static checks and transfer checksum verification passed; real isolated
restore acceptance and third-site survivability remain unverified. The manual
Mac copy is plaintext by explicit owner instruction, directory 0700/files 0600.
This changes no normal BR5/OPS-003 policy and does not enable an offsite provider.
Private configuration, dumps and approval payloads are excluded from this PR.

Chrony/R4/monitoring bootstrap, independent review and issuance of the final
source-bound root profile/grant/adoption, migrations 056–060, scheduled-event
acceptance and deployment remain separate decisions. The compile-time pins are
intentional first-cutover scope; retiring them requires later reviewed evidence.
