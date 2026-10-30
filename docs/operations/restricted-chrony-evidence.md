# Issue369 — restricted Chrony evidence reader

Production GO=false; Issue369 OPEN. Source/test/lab authorization only.

## Architecture comparison and decision

Chrony4.5 localhost UDP permits sources/tracking/sourcename but not authdata,
selectdata or ntpdata. cmdallow does not make these available. Full Unix socket
access also permits clock/config mutations. Never grant it to app/backup UIDs.

| Option | Assessment |
|---|---|
| Fixed root collector via sudo | No general sudo; even a fixed sudo helper cannot cross the existing NoNewPrivileges=true app/backup sandbox. Rejected. |
| Root oneshot/timer snapshot | Atomic ownership is possible, but cached proof needs a revocation/liveness path and permits stale authority between updates. Rejected for this change. |
| systemd socket activation, short-lived fixed collector | Chosen. Existing PID1 supervises an Accept=yes instance per connection. No new long-lived privileged daemon, polling timer or persisted evidence snapshot. |

Ubuntu24.04 package observation: /run/chrony is _chrony-owned0700. Instead of
adding CAP_DAC_OVERRIDE to a root worker, the fixed collector runs as _chrony
with **empty capabilities**, NoNewPrivileges=yes and AF_UNIX only. Because
chronyc creates its per-process client socket beside the daemon socket, the unit
grants only `ReadWritePaths=-/run/chrony`; ProtectSystem=strict and the rest of
the sandbox remain unchanged. It has Chrony control access intrinsically, but
its root-owned reviewed code exposes only a fixed read sequence. App/backup
remain servora-med, never _chrony group members.
Root-owned code does not imply a root-UID process is necessary. PrivateNetwork
is not needed: RestrictAddressFamilies=AF_UNIX forbids worker IP sockets while
allowing Chrony's local Unix transport. No Chrony command socket ACL is changed.

## Protocol and trust boundary

/run/servora-med-time is physical root:root0755. evidence.sock is a single-link
root:servora-med0660 Unix stream socket created by systemd. App can connect;
it cannot replace the socket/parent or modify installed code/units. The accepted
stream is a **read-only evidence request**, not a mutation/command RPC. The only
input is exactly64 lowercase random hex bytes plus newline and EOF. No command,
host/path/source/clock/UID/runtime flags are accepted. Bad/extra/partial/slow
input produces no proof and is bounded by the service3s lifetime. Two instances
maximum; trigger rate capped120/minute. Overload denies rather than caching.

Canonical sampleTrustedTime() remains synchronous for R4/backup callers, using
a bounded sanitized Node child. Child connects to the fixed socket, creates a
fresh256-bit nonce internally, and accepts <=16KiB. No caller can choose nonce,
clock, endpoint or credentials. Collector echoes only that nonce, its checked
identity and the sanitized persisted-format2 time proof. Wire wrapper version1
is **not legacy TimeEvidence1**. No key, NTS cookie, raw packet or secret is
published. No evidence files are written. No approval/issuer dispatch exists.

Identity binds actual boot-id/zero-offset namespace/BOOTTIME, active Chrony PID,
process start ticks, systemd InvocationID, fixed daemon argv, config SHA/dev/inode/
ctime, exact module hash, and public source-selection/tracking-reference hash.
Client and collector compare identities before/after collection/receive. Public
source/reference reads use localhost UDP for app; privileged worker always uses
Chrony's Unix socket. Selection fingerprint omits continuously increasing age
but includes mode/state/name/stratum/poll/reach and tracking reference ID/name/
stratum/epoch. Poll/restart/source/config/module/socket changes during a request
deny; no best-effort old response is returned. Root/kernel/Chrony and root-owned
systemd installation remain trusted, as in OPS-TT-003; this is not protection
against a compromised clock daemon/root/hypervisor.

Freshness bound is2.5s end-to-end BOOTTIME; proof interval must be contained in
the real reader interval. Socket wait2.2s, synchronous child2.8s, outer HTTP3s;
collector command sequence has2s budget and systemd process-group lifetime3s.
A fresh nonce and no persisted cache prevent replay across requests. BOOTTIME,
boot ID and InvocationID prevent stop/restart/reboot from authorizing old proof.
Finite sampling has a bounded observation window, not an instantaneous promise
about future network state. Source/poll races may conservatively yield UNKNOWN.

Parser, closed nts-quorum-v1 allowlist, config hash, minSelectable2/exactly1
selected, NTS packet authentication and768s/1000ms/100ms thresholds are reused.
The underlying TimeEvidence2 schema is unchanged. Legacy1 is still historical,
not current authority; no grant/journal/receipt is rewritten and no TTL/start
budget is reset. Same-attempt continuation and unconsumed reboot denial remain
canonical R4 responsibilities, tested separately from mere sampler success.

## Installation and acceptance boundary

New root-owned socket/template units and exact installed trusted-time module
are required; no installer or production operation runs in this task. Future
administrator review must compare hashes, effective units/drop-ins, actual app/
backup UID/group/sandbox, Chrony/config/module identity and task-specific authority.
Use only this task's fresh Ubuntu24.04/amd64 host and synthetic lab authority.
Same-agent signatures are USER_AUTHORIZED_LAB, never independent production
administrator approval. Existing artifact56d3b4f5 is historical and unchanged.
New source needs exact-head CI, host acceptance and a separately identified new
artifact before any production apply consideration.

## Rollback and fail-closed effect

Rollback is a separately authorized host operation, not a deploy phase. It
changes no Chrony configuration, grant, journal, receipt or budget.

1. `systemctl disable --now servora-med-time-evidence.socket`.
2. Remove the installed socket/template units and run `systemctl daemon-reload`.
3. Do not substitute another clock source and do not relax the binding gate.
   Reinstalling a reader requires the same independent review and a fresh host
   acceptance.

With the socket absent or disabled, `sampleTrustedTime()` fails with
`TRUSTED_TIME_UNKNOWN`. Backup observation then keeps `latestVerifiedProof=null`,
so predeploy/postdeploy proof binding fails closed with
`RECOVERY_BACKUP_UNTRUSTED` and the release stays blocked. Rollback removes the
privileged read path; it never restores authority on its own.

Sources: [Chrony4.5 command access](https://chrony-project.org/doc/4.5/chronyc.html),
[command permissions](https://github.com/mlichvar/chrony/blob/4.5/cmdmon.c),
[systemd255 socket activation](https://www.freedesktop.org/software/systemd/man/255/systemd.socket.html).
