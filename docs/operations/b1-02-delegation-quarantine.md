# B1-02 — Deployment-account sudo quarantine

Status: source component and review scope, 2026-11-13. Production **NO-GO**.
This is the first concrete prerequisite of B1-02, not the completed bootstrap
installer, a RELEASED issuer or deployment authorization.

## Observed reason for this component

Authorized read-only production inspection found that `servora-deploy` can
start, stop and restart the application directly, start backups, activate/reload
Caddy and invoke the fixed deployment helper. The permissions are distributed
across four files. Therefore B1-01's **single-delegated-helper candidate does not
apply to this host**. Replacing only the helper would leave mutation routes open.

| Fixed sudo policy | Observed SHA-256 on 2026-11-13 |
| --- | --- |
| `/etc/sudoers.d/servora-deploy` | `4ed15b8888e03dfe158af7ff13ffdaf9f40b47503853cf97c0407987bed3ad70` |
| `/etc/sudoers.d/servora-deploy-caddy-activation` | `5da36c61a6c47d7a04d429d6ae504e1de836e2e541f6e321ac2d02e9934693e0` |
| `/etc/sudoers.d/servora-med-predeploy-backup` | `90e0c6e3175f0da2e41fcaf1046ef2098440e8f61d8adea7430dc65753b5145d` |
| `/etc/sudoers.d/servora-med-production-deploy` | `503b5d2c686a25d61c04a63fe11bb8549621c9b9b5c10756444b7da45fc20729` |

These are historical audit measurements, never an authorization to use stale
evidence. Actual installation requires a fresh independently reviewed capture.
No production file or grant was changed during this inspection.

## Narrow operation

The root-only `bootstrap-delegation-quarantine` wrapper and two modules live
outside normal release artifacts under a separately provisioned
`/usr/local/libexec/servora-med-bootstrap` directory (`root:root 0750`). The
bundle retains the source layout:

```text
ops/recovery-tools/bootstrap-delegation-quarantine           0750
ops/recovery-tools/bootstrap-delegation-quarantine-host.mjs  0644
ops/recovery-tools/bootstrap-delegation-quarantine.mjs       0644
ops/scripts/bootstrap-fence.mjs                             0644
ops/scripts/historical-recovery-evidence.mjs                 0644
```

All files are physical, `root:root`, single-link files. The wrapper pins the
complete direct import closure and existing host lock library. It has no sudo
delegation, path override, force, resume, release or restore command. The shared
`/usr/local/libexec/servora-med` directory remains unchanged at 0755.

The only accepted command forms are:

```text
bootstrap-delegation-quarantine --capture
bootstrap-delegation-quarantine --dry-run --expected-authorization <sha256>
bootstrap-delegation-quarantine --apply --expected-authorization <sha256>
```

The existing stable, empty root-owned 0600 `host.lock` is mandatory. Its inode
is opened without O_CREAT and checked through an owned descriptor and actual
nonblocking flock, held until the callback fulfills or rejects. No lock is
created, reclaimed or deleted. Normal pending markers and the historical
inventory's positive absence and exact-directory checks must pass.

`--capture` is read-only and emits `BOOTSTRAP_SUDO_QUARANTINE_PROPOSAL`, with
authority `READ_ONLY_NOT_AUTHORIZATION`. Copying it to the authorization slot
does not authorize a write. Separate owner review and separately authorized
root-only provisioning must create the exact canonical JSON authorization at
`/var/lib/servora-med-bootstrap-quarantine/authorization.json` (directory 0700,
file 0600, physical root:root paths, no additional files). Its full byte hash
must be explicitly supplied to apply. The tool never creates this authorization.

The authorization has exactly the documented source fields: formatVersion 1,
kind `BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION`, scope
`CLOSE_SERVORA_DEPLOY_SUDO_ONLY`, machineId, hostLock device/inode,
sudoListingSha256, otherPolicySha256, preservedState and the four sorted
path/hash policies. `preservedState` binds current release, profile bytes,
service identity and the owning module's exact 26-source historical inventory.
No verification booleans or secret/configuration payloads are accepted.

### Supported policy contents

Both dry-run and apply validate **all four complete original files before any
reservation or policy write**. The supported subset is deliberately small:
ASCII/LF text, blank lines, full-line comments (`#` followed by space/tab or
end-of-line) and positive grants of
the form `servora-deploy ALL=(root) NOPASSWD: /absolute/command arguments`.
Spaces/tabs, command lists and simple path/argument wildcards are supported.
Only letters, digits, `_ . / @ * ? + -` and argument `=` are accepted in commands.
Comment-only files are harmless no-ops. This is not a general sudoers parser.

Negation, Defaults, aliases, both forms of include/include-directory directives,
other users/groups (including numeric `#UID` rules), additional tags, command
digests, continuations, quoting, non-ASCII/control bytes and unsupported syntax
fail with `POLICY_UNSUPPORTED`.
A matching owner-authorized hash does not override this check. Nothing is
normalized, edited into a supported form or automatically retried.

This closes the counterexample where a removed file contains a deny masking an
allow in another unchanged file. Removing the deny could uncover that allow
before a later EIO stops publication. Unknown or more complex production policy
contents require STOP and separate review; these source tests do not establish
that the observed production files conform to this subset. Independent owner
review of the other effective policies and policy sources remains necessary.

## Publication and failure behavior

Before the first write, the tool validates the authorization hash, root
ownership, all four old policy hashes, machine/lock identity, effective
`sudo -l -U servora-deploy` output, all other sudo policies and passwd/group,
the running service, current link, profile and historical inventory. It also
checks the supported positive-grant subset for every original file.

Apply then performs only these effects:

1. Exclusively publishes/fsyncs an operation reservation and all four original
   policy byte copies under the private state directory.
2. For each fixed policy, writes a same-directory exclusive 0440 candidate
   containing comments only; fsyncs; validates it with real `visudo -c -f`;
   compares the old inode/metadata/bytes; renames and fsyncs `/etc/sudoers.d`.
3. Verifies global sudo syntax and requires real sudo to report that
   `servora-deploy` is not allowed to run sudo. Any remaining grant is failure.
4. Rechecks preserved state and exclusively publishes a receipt with authority
   `SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE`.

Within that supported subset the replacements remove positive command grants;
they are not a global atomic transaction or a general safety proof for arbitrary
sudoers configurations. During a partial reduction some old management routes
may remain available, but this tool has not installed any new helper/module or
changed any profile. An incomplete reduction never authorizes bootstrap.
Unknown outcome, SIGKILL, reboot, EIO, ENOSPC, residue or any changed identity
requires STOP and a separately reviewed recovery plan. Originals, candidates and
reservations remain intact; there is no automatic rollback, deletion, retry or
second apply. Fresh invocations refuse the reserved directory.

Before any separately authorized production apply, independently reopen and
verify root/console access that does not depend on `servora-deploy` sudo. The
remaining root-only operations and a reviewed partial-operation recovery
procedure must be executable through that access. Do not apply quarantine
first and assume lost delegation can later be restored to continue bootstrap.

No application release, database, migration, service/unit, backup timer, Chrony
configuration, host profile, historical source, existing approval or adoption
is written. Scheduled backups run through their existing service account and
units. The deployment account loses its manual sudo backup-start path as part
of quarantine; that is not a change to the scheduled backup service.

## What this receipt does not prove

This component closes **sudo grants for one deployment account**. It does not
prove the absence of polkit/SSH/other-account routes, drain an already running
privileged process, issue CLOSED/RELEASED, install tools, change a profile,
perform historical disposition/staging or authorize deployment. Those B1-01
first-activation prerequisites remain mandatory. Deliberate root override is
outside the threat model. Never consume this receipt as all-route closure.

After the complete separately reviewed bootstrap/release, normal management
may regain only the guarded fixed-helper scope. The historical direct
systemctl/Caddy/backup grants are not automatically restored by this tool.

## Acceptance and remaining path to migration 061

Portable tests exercise real orchestration with synthetic ports: exact owner
authority, proposal rejection, CAS/drift, ENOSPC/EIO, partial publication,
remaining grants, service/history preservation and refusal of automatic retry.
The restrictive-rule regression was first RED on `ffcf442` (the second
publication's synthetic EIO was reached instead of an early refusal), then
GREEN with the pre-reservation check. A second RED on `5750617` proved numeric
UID rules could be mistaken for comments; comments now require whitespace or
end-of-line immediately after `#`. Unsupported constructs are tested in
each fixed file for both dry-run and apply; supported positive grants also run.
The dedicated Linux image uses real sudo/visudo, root ownership, modes and
flock. It binds source read-only and runs without network. Service metadata and
the 26 historical files are explicit synthetic fixtures; real systemd/Chrony
and kernel reboot acceptance are not claimed.

The Linux regression demonstrates with actual sudo that removing a synthetic
named-user or numeric-UID deny uncovers a shared allow, then verifies that both
CLI modes refuse the authorized restrictive policy without any reservation or
policy change. Its
execution result is recorded in the exact-head CI evidence, not inferred from
portable tests. The SIGKILL test terminates a lock holder, not the publisher
mid-rename. EIO/ENOSPC are synthetic-port injections, not physical disk failures.

The production database backup copied to the owner's Mac was an existing
scheduled dump. Its checksum and PostgreSQL 17 archive listing were verified;
it was not restored and is not the new host-side recovery baseline.

The finite remaining work is:

1. Review this component and close effective non-sudo/in-flight management
   routes before any separately authorized production quarantine.
2. Complete the reviewed CLOSED/tool-install and separate verification/release
   implementation and acceptance; preserve the running OLD and all history.
3. Use the existing disposition/staging/re-seal/baseline chain; resolve the
   previously identified approval/adoption interruption issue before issuance.
4. Obtain the exact target's independent release/attempt authorization; migrate
   to 061 through the approved deployment path, verify schema/health and the
   Admin Weekly Report removal flow, and retain the old report history.

This source PR does not mark any unexecuted item in that list complete.
