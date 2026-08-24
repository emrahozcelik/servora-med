# Backup worker production cutover readiness and runbook

This runbook prepares a later, separately authorized transition from the
legacy script/timer/offsite-hook path to the verified BR5 worker. It is not an
authorization to run any state-changing command. This slice performs no host
access, production R2 call, worker enablement, monitoring switch, legacy
retirement, restore, or cutover.

## Current decision

```text
REAL_R2_DR_ACCEPTANCE = NOT EXECUTED
HOST_CONFIGURATION = NOT VERIFIED
PRODUCTION_CUTOVER_READINESS = BLOCKED
PRODUCTION_CUTOVER_AUTHORIZATION = NOT GRANTED
PRODUCTION CUTOVER = NOT EXECUTED
PRODUCTION WORKER ENABLEMENT = NOT EXECUTED
```

If real R2 acceptance later passes while host inspection remains unavailable,
the strongest truthful status is `PARTIAL / HOST_VERIFICATION_PENDING`.
`READY_FOR_AUTHORIZATION` is allowed only after real R2 DR PASS and every
mandatory production configuration check is PASS. It still does not authorize
cutover.

## Read-only readiness matrix

Repository evidence and production-host evidence are distinct. Unknown host
state is never inferred from examples.

| Production check | Current status | Required evidence |
|---|---|---|
| R2 bucket configured | NOT VERIFIED | Presence-only check on the production host; no value output |
| Runtime credentials present | NOT VERIFIED | All runtime R2 credential names PRESENT |
| Runtime credential scope appropriate | NOT VERIFIED | Operator evidence of bucket-scoped Object Read & Write only |
| `BACKUP_INSTANCE_ID` stable and opaque | NOT VERIFIED | Presence, approved opaque value, and durable operator record |
| Public age recipient configured | NOT VERIFIED | Presence and native hybrid recipient validation |
| Private identity absent from runtime | NOT VERIFIED | Host scan of supported and known identity variables/paths |
| Worker service definition ready | PASS | Checked-in systemd and launchd examples use the separate worker entrypoint |
| Worker disabled | NOT VERIFIED | Host service state plus `BACKUP_WORKER_ENABLED=false` |
| Backup temp storage ready | NOT VERIFIED | Absolute path, ownership, mode, free space, no repository/web overlap |
| Schedule policy ready | NOT VERIFIED | Approved timezone, local time, RPO, and first-run plan |
| Monitoring transition ready | PASS | Existing single monitor supports explicit `legacy` → `verified-runs` switch |
| Legacy rollback ready | PASS | Legacy script/timer/hook/rehearsal assets are preserved in the repository |
| Bucket Lock configured | NOT VERIFIED | Operator/cloud control-plane evidence; runtime token must not manage it |
| Lifecycle configured | NOT VERIFIED | Operator/cloud control-plane evidence and retention reconciliation |
| Operator private-key custody verified | NOT VERIFIED | Offline custody/recovery exercise; private identity absent from app host |
| Restore CLI available | PASS | BR7 CLI and compiled wrapper are in the repository |
| Restore runbook available | PASS | BR7 restore guide plus this gated transition runbook |

The repository examples retain `BACKUP_WORKER_ENABLED=false` and
`SERVORA_ALERT_BACKUP_SOURCE=legacy`, but those examples do not prove current
host state.

## G0–G10 authorization sequence

Do not skip gates or collapse them into one deployment.

| Gate | Required action/evidence | State-changing authority |
|---|---|---|
| G0 | Real disposable R2 FULL_DATA DR acceptance PASS on the exact reviewed source | Acceptance opt-in only |
| G1 | Read-only production configuration/host preflight; every mandatory row PASS | Read-only host authorization |
| G2 | Worker unit and env installed/configured while disabled; legacy remains active | Separate deployment authorization |
| G3 | Reviewer grants explicit production worker cutover authorization | Human decision |
| G4 | Set `BACKUP_WORKER_ENABLED=true` and enable/start the separate worker | Explicit cutover authorization |
| G5 | Request one controlled manual production backup | Explicit production backup authorization |
| G6 | Prove real remote metadata, streamed checksum, `SUCCESS`, and `verified_at` | No broader mutation |
| G7 | Confirm API/admin evidence and worker heartbeat; prepare, but do not infer, monitoring health | Approved observation |
| G8 | Observe at least one scheduled verified success through the agreed window; legacy still active | Approved observation |
| G9 | Switch the existing monitor to `verified-runs`, then retire legacy timer/hook only after explicit approval | Separate retirement authorization |
| G10 | Record final production acceptance, ownership, rollback state, and next restore rehearsal date | Human acceptance |

G1 must not jump to G9. A BR4 connection test is only a capability probe and
does not satisfy G0 or G6.

## G1 production preflight (read-only)

Run only with explicit permission to inspect the production host. Never print
environment values or source the env under tracing.

1. Record deployed Git SHA, OS, Node, PostgreSQL client/server versions,
   official age version, and latest migration (`033_backup_worker_runtime`).
2. Report presence only for `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`,
   `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`,
   `BACKUP_INSTANCE_ID`, and `BACKUP_ENCRYPTION_RECIPIENT`.
3. Confirm `BACKUP_WORKER_ENABLED=false` and the worker service is disabled and
   inactive. Do not start it as a preflight probe.
4. Confirm the worker unit uses the required private environment file and the
   separate `dist/backup-worker.js` entrypoint.
5. Validate backup temp-root ownership/mode/free space and confirm it is
   outside release, repository, public web, and persistent source-file roots.
6. Confirm only the public hybrid age recipient is on the application host.
   Check `SERVORA_BACKUP_AGE_IDENTITY` and `AGE_IDENTITY_FILE`; any unexpected
   private identity is a readiness blocker and security incident.
7. Review the runtime token out of band: bucket-scoped Object Read & Write,
   with no account-admin, Bucket Lock, lifecycle, domain, or bucket-management
   authority.
8. Verify the intended Bucket Lock and lifecycle rules in the Cloudflare
   control plane without changing them. Record logical retention, physical
   lifecycle, and lock retention separately.
9. Confirm the legacy backup service/timer, `OFFSITE_COPY_HOOK`,
   `restore-rehearsal.sh`, and `SERVORA_ALERT_BACKUP_SOURCE=legacy` remain
   available.
10. Verify operator private-key custody, recovery ownership, emergency access,
    and the next non-production restore rehearsal date.

Any unexpected private identity, missing public recipient, unstable instance
ID, broad token, missing rollback path, or unverified G0 blocks the transition.

## Later controlled worker transition

The following commands are examples for a future authorized systemd host. Do
not run them in this readiness slice.

```bash
# G2: install/configure while still disabled; verify only.
sudo systemctl daemon-reload
sudo systemctl is-enabled servora-med-backup-worker.service
sudo systemctl is-active servora-med-backup-worker.service

# G4: only after explicit production worker authorization and env approval.
sudo systemctl enable --now servora-med-backup-worker.service

# Observe without exposing environment values.
sudo systemctl status --no-pager servora-med-backup-worker.service
sudo journalctl -u servora-med-backup-worker.service --since today --no-pager
```

G4 is valid only when the private env already contains
`BACKUP_WORKER_ENABLED=true`. Enabling a unit while the application gate is
false does not constitute a useful acceptance test.

At G5, request exactly one manual backup through the existing ADMIN workflow.
Do not generate load or repeat on an ambiguous failure. G6 requires the
canonical BR5 result: `SUCCESS`, non-null `verified_at`, exact remote key,
bytes and SHA, and no unresolved conflict/auth/checksum failure. A cleanup
warning does not invalidate remote verification but must be resolved or
accepted explicitly.

Keep the legacy timer and offsite path active through G8. The first scheduled
verified run—not a manual run—must satisfy scheduled freshness before the
monitor can move to `verified-runs`.

## Monitoring transition

Servora has one operator monitor: `ops/scripts/operator-alerting.mjs`.
`SERVORA_ALERT_BACKUP_SOURCE=legacy` is the current safe default.

Only at authorized G9:

1. Change the existing monitor to `verified-runs`.
2. Execute its normal read-only check and confirm it sees a fresh scheduled
   verified run plus worker/scheduler heartbeat.
3. Observe the approved window.
4. Obtain separate approval before disabling the legacy timer or hook.

Do not run two competing canonical monitors or treat a manual backup as
scheduled freshness.

## Rollback plan

Rollback remains available until G10:

- Before G4, make no production change; leave legacy as canonical.
- If the worker cannot start, produces auth/conflict/checksum failures, loses
  heartbeat, or misses schedule, set `BACKUP_WORKER_ENABLED=false`, stop and
  disable only the worker service, and keep/re-enable the legacy timer and
  legacy monitor source.
- Do not delete failed rows, workspaces, or R2 objects while investigating.
  Bucket Lock may intentionally retain objects.
- Do not roll back migration 033 destructively. Application release rollback
  is allowed only when schema compatibility was separately verified.
- If monitoring was switched, return the same monitor to `legacy`; do not
  create a second alerting implementation.
- `OFFSITE_COPY_HOOK`, `backup-postgres.sh`, and `restore-rehearsal.sh` remain
  preserved until a separately reviewed cleanup decision.

Rollback of the backup worker never authorizes a production restore. A
production restore requires its own incident authorization, target plan,
private identity access, BR7 inspection/verification, application cutover,
and rollback gate.

## Retention and security boundary

Servora logical retention is application policy. R2 lifecycle is the physical
cloud deletion policy. Bucket Lock enforces retention against overwrite/delete
on protected objects and takes precedence when applicable. The runtime token
does not manage either Cloudflare policy.

Bucket Lock, metadata SHA, and age integrity do not authenticate the producer.
V1 has no producer signature. State the result as integrity-verified and
recoverable, never “trusted producer cryptographically authenticated.”

A tiny synthetic DR acceptance does not prove the four-hour production RTO at
production volume. RPO remains 24 hours; production schedule and observed
duration need separate host evidence.
