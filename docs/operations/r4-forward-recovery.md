# Attempt-bound host forward-recovery

This contract adds a separate forward-recovery phase to the existing reviewed
host helper. It does not authorize a production deployment, host bootstrap,
restore, database downgrade, or migration by itself.

## Authority and identities

The operator uses the existing local-first wrapper and exact-main CI evidence.
A separate trusted administrator provisions the reviewed host helper, its five
Node modules (`deployment-attempt`, `deployment-controller`,
`deployment-db-guard`, `migration-reconciliation`, `trusted-time`), `host-operation-lock.sh`, and
`servora-med.service`. The installed files are root-owned: helper 0755, modules
and lock library 0644, unit 0644. Ancestors must be physical root-owned
non-group/other-writable directories. Node 22 and PostgreSQL 17 remain required.

The administrator seals `/var/lib/servora-med/deploy/profile.json` and
`approvals/<UUID>.json` as canonical one-line JSON plus newline, root:root 0600,
regular non-symlink single-link files in protected root-owned directories.
Approval and journal directories are 0700. `host.lock` is root:root 0600 and is
never deleted, renamed, or stale-recovered. `artifacts`, `backups` and audit
`logs` directories are private root-owned 0700. The service/operator cannot
create an approval or change any of these resources.

The profile binds machine-id, public hostname, actual database cluster-id,
database name/OID, role, loopback address/port, the hash of **all** protected env
bytes except the two controlled identity pins, and nine contract hashes (the previous seven, the time module and the root-owned
`/etc/chrony/chrony.conf`). Profile format 2 is required.
`validateHostProfile()` is the field/type SSOT. The effective systemd User,
Group, WorkingDirectory, ExecStart, EnvironmentFiles, fragment, drop-ins and
restart policy must also match; a correct base unit hash is insufficient.

`validateApproval()` is the approval SSOT. A grant binds one UUIDv4, exact SHA
and tree, approved artifact digest, exact CI manifest digest, OLD release and
archive digest, full OLD/TARGET migration filenames **and SQL hashes**, profile
digest, issue/expiry UTC (maximum 24 hours), actual issue-time boot/namespace
evidence, and explicit operation scopes. Approval format 2 is required.
At most two TOTAL candidate starts (including normal activation) and one
pre-migration abort start may be authorized. Admission — the first durable
journal publication — requires the grant to still cover the mandatory
1,800-second acceptance interval plus an equal transition-phase budget: at
least 3,600 seconds must remain. That admission consumes the authority: the
already-authorized attempt may still be driven to its terminal state after the
wall-clock expiry, while structure, scopes, budgets and issuance ordering stay
enforced and no other attempt can start under it. There is no renewal/reset
operation.

The root administrator must independently verify these operator-attested inputs
against the reviewed source/artifact/evidence before writing a grant. A SHA
shape, commit message, caller-supplied catalog, or manifest head alone is not
approval. Preserve the original approved OLD archive and verify its full content
against the immutable OLD release before retaining it under `artifacts/<SHA>.tar.gz`.
The deploy identity only has digest-scoped sudo to the fixed host helper, never
sudo to Node, Bash, systemctl, a grant-writing command, or arbitrary env selectors.
An isolated VM's administrator channel is not proof that production bootstrap
has already happened; production bootstrap requires separate explicit approval.

Local CI provenance remains `local-operator-attested`: these digests prove file
integrity and bind the request, not cryptographic independent CI authenticity.

## Normal migration deployment

The existing wrapper additionally accepts `--attempt-id UUID`. A migration
requires an explicit grant **and** `--allow-migrations`. Attempt-bound mode
requires local CI and a prebuilt artifact; it cannot rebuild a Mac runtime.
Before transfer the fixed read-only host `attempt-preflight` phase checks the
OLD database/release and returns a non-secret approved SHA/tree/artifact/CI/host
projection. The operator compares every field against verified local inputs.
A working existing Playwright 1.55.1/Chromium launch remains an operator
prerequisite. No browser is installed on the VPS or recovery VM by this feature.

The host validates the upload, copies/seals/checksums it under root-owned
`artifacts/<SHA>.tar.gz`, and performs all extraction from that retained archive.
A later change to the operator-owned upload cannot change the staged release.
Staging retains its archive allowlist, full content marker, symlink, owner,
permission, helper and immutable-byte comparison contracts. Recovery rechecks
all payload contents, markers, retained archive hash, full catalog, and installed
helper/modules/lock library/unit against the approved TARGET payload.

Admission samples trusted time immediately before the root-private initialization
record, fsyncs that record and its directory, then samples again. Both samples
must prove the original remaining admission window. A root-private, canonical
`admission-proofs/<UUID>.json` binds the grant digest, exact initialization hash
and post-fsync time. It is file/directory-fsynced before active owner publication
or business effects. The owner and checkpoint zero still use the exact original
initial record; the checkpoint chain never admits proof-sidecar files. A matching interrupted initialization may finish only after
fresh OLD EXACT DB, artifact, identity and ordinary-service checks. It cannot
repair a missing marker, another owner, a corrupt or progressed journal, a used
start budget or any backup/migration side effect. The initialization marker and
checkpoint may temporarily share exactly one inode; ordinary records still
require one link. The shared maintenance fence also treats a marker-only initialization as a
pending attempt; legacy deploy/postdeploy/rollback and recovery cannot pass it.
Admission creates the active owner before starting backup. Every
checkpoint is exclusively published and fsynced in a complete hash chain.
Publication links a private temp name to the final name, so an interruption
between those two steps can leave exactly one same-inode temp link or an
unlinked pre-link temp. That provably-ours window is reconciled idempotently by
the next read or append — the record itself is already durable — while any
other stray artifact stays foreign and fails closed. Audit logs live in a
**separate** `logs/<UUID>` directory; checkpoint directories accept only
contiguous numbered JSON records. Unknown files, gaps, torn intent or
conflicting ownership otherwise fail closed. No automatic repair/reset is
provided.

The real candidate-bound predeploy backup must pass checksum/list validation;
its bytes are copied into a private root-owned dump and hash-bound receipt.
When the copy was already published but its receipt checkpoint was interrupted,
the resume re-validates that sealed archive (identity, permissions, digest and
`pg_restore --list`) and adopts it — a second backup is never forced and the
sealed name can never collide with a duplicate.
The persistent `activation.block` is then installed, `Restart=no` is loaded as
an owned recovery drop-in and the application is stopped. Only then does the
helper re-run the real SQL history/count reader. Before persisting that fresh
baseline, the service-UID guard independently rechecks OLD EXACT identity and
all seven counts under the migration advisory lock. It rejects other DB
sessions (including idle/redacted foreign-role sessions), prepared transactions,
an enabled/active backup worker, or any remaining service-UID process. A
changed snapshot fails closed. Migration intent is
fsynced **before** invoking the existing service-UID migrator. Migration logs,
UTC start/end and exit are retained privately. Migration failure or unknown
outcome leaves the host fenced; a retry delta of zero never permits OLD rollback.

This requires exclusive application writers during the maintenance window.
Independent schedulers, external integrations or operators capable of opening
new writable sessions must be quiesced through their approved procedure before
admission; a point-in-time session check cannot prove future external behavior.
If that prerequisite cannot be established, STOP before migration. R4 does not
terminate foreign sessions, rewrite DB permissions or disable workers.

## Database and activation boundary

The service-UID probe checks the complete canonical ledger with the existing
migration comparator and the exact database fingerprint. It holds the Migrator's
PostgreSQL advisory lock through the host transition and checks again before
mutations. While an operation runs under the guard, every journal acceptance
checkpoint asserts that the guard is still alive: after a lost connection or
lock, no new mutation may produce a checkpoint, and a completed transition
requires the guard to observe RELEASE and exit zero — an exited guard is never
a successful lifecycle. No candidate code or PostgreSQL package runs as root. The root
controller retains the common host kernel lock without passing that descriptor
to the service-UID probe/application.

`forward-recovery --attempt-id UUID` requires existing matching ownership,
sealed release, boot barrier and TARGET **EXACT** history. It never migrates,
restores or touches the migration ledger. It aligns BOTH HEALTH_SCHEMA_VERSION
and SERVORA_RELEASE_SHA, then atomically aligns `current`, recording intent and
completion around each operation. Both OLD/TARGET and mixed approved identity
pin pairs may be reconciled; third identities or other env drift are rejected.

A durable START_INTENT consumes a slot before the sole explicit start. A
volatile root-owned `/run/servora-med-recovery/start.permit` allows that start
while the permanent barrier remains. Automatic restarts stay suppressed until
acceptance. Reboot removes the permit, not ownership or the barrier. Unknown
START_INTENT is ambiguous and never gets another start automatically. A known
failure may use only the remaining slot; health loss before smoke may also use
that slot. Later acceptance-stage health failure requires manual review.

Health requires the approved process executable/cwd, PID stability, coherent
pins/current, internal and strict HTTPS status, and exact release identity.
Health is not a substitute for catalog, smoke, backup, or observation acceptance.
A healthy repeat only revalidates; it does not stop or start the service again.

## Pre-migration abort

`pre-migration-abort --attempt-id UUID` is a distinct operation. It requires
explicit abort scope, a never-committed migration boundary, and a fresh full
OLD **EXACT** probe under the database lock before any mutation. OLD archive,
content/catalog, pointers and protected env must also be trusted. Only then may
one budgeted OLD start occur. Verified OLD health is required before handing the
normal restart policy and boot behavior back to systemd. OLD cannot run on a
TARGET database, even when the retry says `migrations_applied=0`.

## Smoke, backup and observation

The wrapper's non-mutating anonymous Mac browser smoke remains mandatory.
For an active attempt, a failed smoke never requests generic OLD rollback.
After successful smoke the attempt-scoped postdeploy phase attests that
operator result, validates TARGET DB/process/backup-health, persists backup
intent, runs the distinct postdeploy unit, validates dump/checksum **and** host
observation, then seals its separate receipt. Scheduled heartbeat freshness
continues to use the existing host-observation SSOT; postdeploy cannot replace it.
A failed/ambiguous backup is not repeated automatically.

Postdeploy then measures an uninterrupted 1,800-second interval with a monotonic
clock and actual UTC/sample logs. It checks database, health, PID, boot-id,
restart suppression and backup projection at approximately 30-second intervals.
SIGTERM/INT produces partial observation; it cannot create OBSERVATION_PASS.
A later permitted observation repeats the full interval without repeating an
already receipted backup or start. Root-owned observation logs survive failures.

Only full acceptance restores ordinary `Restart=on-failure`, removes the owned
barrier and retires active ownership. An interrupted accepted hand-off may be
revalidated and finished even after the owned barrier has been removed. Only
ACCEPTED/ABORTED records with complete durable direction-specific evidence may
resume that boundary: exact DB/artifact/current/pins, process/health, a fresh
schema-check and effective ordinary restart policy remain mandatory. TARGET
also requires sealed PRE/POST backups, smoke and full observation evidence.
Completing handoff never allocates another start, backup, migration or observation.
A terminal checkpoint with a leftover matching claim
may retire only that completed claim after fresh checks; it does not activate
anything. A completed repeat with no owner is read-only. Changed current,
unknown owner, corrupt state, expired approval or inconsistent policy requires
operator review; another active attempt is never reclaimed.

## Interruption matrix

Every durable publication below is exclusive and fsynced; each interruption
window leaves an observable state that only the same attempt may reconcile.
Foreign or corrupt states are never repaired.

| Publication | Interrupted window | Durable state after crash | Recovery |
| --- | --- | --- | --- |
| Active owner + checkpoint 0 | marker fsynced; link/claim/cleanup pending | sealed initialization marker, optionally linked to `0000.json` | same-owner initialization finishes only after fresh OLD EXACT DB, artifact, identity and service proofs |
| Checkpoint N | temp linked; temp unlink pending | `000N.json` plus one same-inode `.tmp` link (or an unlinked pre-link temp) | next read/append completes the unlink idempotently; chain stays valid |
| Sealed backup dump | dump linked; receipt checkpoint pending | `<attempt>-<kind>.dump` with the journal still in its intent phase | plain retry or `adopt-backup` re-validates the sealed archive and journals the receipt; no second backup |
| Restart-policy drop-in, install | drop-in renamed; daemon-reload pending | drop-in present, loaded `Restart=on-failure`, `NeedDaemonReload=yes` | same-attempt pending install resumes; reload only after fresh DB/payload proofs; unknown drift stays rejected |
| Restart-policy drop-in, handoff | drop-in unlinked; daemon-reload pending | loaded policy `Restart=no`, file absent, `NeedDaemonReload=yes` | same-acceptance pending-handoff reload (existing contract) |
| Terminal handoff / owner retirement | policy, barrier, COMPLETED journal and claim between fsyncs | matching partial terminal state | terminal read-only confirmation or same-owner claim retirement; never re-activates, starts, backs up or observes again |

## Serialization and unsupported operations

The host helper phases share one stable flock inode. On R4-bootstrap hosts,
legacy deploy-release and production-recovery maintenance paths share it and
refuse a pending owner/barrier, including when TEST_DATABASE_URL is present.
Disposable restore regressions run on separate hosts without an R4 claim;
a database selector cannot exempt an operation from the physical host lock.
Pre-R4 hosts retain
their previous maintenance contract until explicit root bootstrap; R4 cannot be
used without that bootstrap. R1–R3 exact same-catalog/atomic restore protections
remain intact. Restore, new-target DR and production cutover are separate
operations, not forward-recovery substitutes.

Never delete a lock, edit history, downgrade DB, clear an unknown barrier,
modify a sealed grant, reset a budget, add a bypass flag, or start OLD on TARGET.
If exact database/catalog/artifact/profile/authority cannot be proven, stop.
If the bounded candidate starts fail, leave the attempt fenced and obtain a
new operator decision. Do not infer overall success from live health while
postdeploy backup or observation is incomplete.

## Evidence and platform limits

Root-only tests under `ops/tests` refuse hosts other than the authorized
`lima-servora-r4-20261012` fixture and use synthetic isolated databases. All-8
SHA/grants are deliberate WIP fixtures, not production or exact-Git approvals.
Exact-head acceptance uses a separate sealed `r4-test-source.json` identity and
actual Git artifact/CI hashes. Host logs and failed attempts are retained outside
Git. Pure state/operator tests run within the existing server-tests gate; the
27 mandatory gates are unchanged. Real host/systemd acceptance is additional.

The Lima/VZ Ubuntu 24.04 host is ARM64, not native AMD64 parity. Linux/amd64
compatibility remains a separate mandatory CI gate and a future production
artifact requirement. Local host recovery evidence is not production acceptance,
restore acceptance, or offsite R2/DR proof. Production bootstrap/preflight,
exact-main Linux/amd64 artifact and migration/deployment approval remain separate.

**Fixture retirement (owner authorization, 2026-10-27):** the named
`lima-servora-r4-20261012` disposable host and its VM disk were removed
during local resource cleanup. The named-guest prerequisite of existing
`ops/tests/r4-*-host.sh` scripts therefore no longer exists; these
host-gated tests cannot run until a new isolated fixture is explicitly
provisioned/authorized. Earlier results remain historical only; deletion of
raw evidence cannot be repaired from a manifest/hash list. This retirement
does not permit deletion of any other protected guest, production resource,
active recovery state, or future sealed host fixture. See the separate
post-merge checklist in `local-ci-resource-recovery.md`.

## Review reconciliation: fence, consumption and shell state

A durable `FENCED` record with no migration intent can resume normal deployment
only for the same sealed owner with OLD EXACT history/fingerprint, immutable
OLD/TARGET payloads, OLD env/current identity, retained PRE receipt, stopped
service, loaded `Restart=no`, owned barrier and proven writer quiescence.
This narrow resume skips a second PRE backup, stop/start and owner admission;
it re-reads real SQL and persists fresh MIGRATION_INTENT before the migrator.
TARGET/ambiguous histories never enter this path. Other deployment admissions
still require the ordinary healthy OLD service.

Authority consumption starts with the root-sealed initialization record. Both
marker-only and checkpoint-zero states must prove the original exact initial
record, approval digest, issue/admission/expiry timeline and sufficient original
admission window. A filename, expired grant or changed hash is insufficient.
No approval renewal or budget reset is introduced.

A separate postdeploy helper process derives OLD identity and migration delta
from the sealed catalog/journal under a fresh TARGET EXACT guard. Existing state
must match all five canonical fields; contradictory state is rejected. Missing
state can be reconstructed only after committed migration, durable schema check,
retained PRE backup and process/health proof. Writes fsync the file and directory.
The migration count cannot become zero merely because a new shell started.
Postdeploy repeats preserve those fields and still prohibit OLD rollback after
a nonzero approved catalog delta.

The same proof also reconciles a `BACKED_UP` journal interrupted after the app
stop but before FENCED publication. Only actual MainPID=0 / inactive, the owned
barrier, effective `Restart=no`, verified PRE receipt/archive and fresh OLD EXACT
quiescence may durably publish FENCED under the database guard. A running healthy
BACKED_UP attempt uses its original deployment path. Missing/foreign barriers,
failed/transitional service states, untrusted policy or incompatible DB histories
never receive a stopped-service exception. The fresh SQL baseline is still
captured only after this reconciliation, before MIGRATION_INTENT and migration.


## TT-A format and infrastructure boundary (Issue #369 A2)

OPS-TT-001 assigns continuous UTC synchronization to chrony, with UME and the
independent Cloudflare NTS source. The application only reads bounded health and
Linux BOOTTIME evidence. There is no application clock daemon, periodic database
clock writer, caller time override or Date.now-only admission fallback.

Unconsumed grants require the same actual boot and time namespace as issuance.
Process restart preserves elapsed age; reboot refuses unconsumed authority even
if the wall clock looks valid. UTC consistency is a veto, never extra lifetime.
The 24-hour maximum TTL, 3,600-second admission window, 1,800-second observation
and all scopes/start/backup/migration/rollback budgets remain unchanged.

Initialization and journals use format 2, preserving the original admission
evidence and each checkpoint's time evidence. A valid confirmation proves the
first durable consumption occurred in the original window. Historical replay
checks those persisted samples; it never passes an old wall timestamp as a
trusted current clock. A corrected UTC label cannot renew or revoke proven
consumption: only the same authorized phases and budgets survive, with fresh
infrastructure evidence for new mutations. Observation separately requires
uninterrupted boot/UTC/elapsed consistency and restarts its full interval after
an anomaly. Backup writer/reader semantics are not changed by TT-A; A3 remains open.

An unconfirmed marker burns reuse but does not establish consumed authority. A
fresh same-boot, zero-progress retry may complete confirmation only while the
original window still holds and existing OLD EXACT/payload/service checks pass.
Expired, rebooted, torn or foreign proof states stay denied. V1 grants/journals
are preserved, never promoted. An active legacy attempt requires separate review;
there is no automatic schema conversion, approval renewal or budget reset.

Proof directories are root:root 0700; files are root:root 0600, canonical, regular,
non-symlink single-link records. Publication file-fsyncs an exclusive private
`.admission-<UUID>.tmp`, links the final name, fsyncs the directory, then unlinks
the temp and fsyncs again. Exactly one same-inode final/temp pair is recognized
read-only and may be finalized after validation. An unlinked temp, foreign
artifact, wrong owner/mode/link count or malformed record is denied, not repaired.
A directory-fsync failure cannot publish the active owner. A retry of an already
complete proof re-fsyncs it without changing its timestamp or authority.

Administrator issuance uses the reviewed module's `issueRootApproval(fields,
ttlMs)` on the target host. It captures actual evidence and exclusively seals
the record; caller-provided format/issue/expiry/time-evidence fields are refused.
The administrator independently verifies all identity/artifact/catalog/CI inputs
and profile digest first. This API is absent from the deploy CLI and must never
be granted to the deploy identity through sudo to Node, a shell or an issuer.

TT-A changes privileged helper/profile bytes and requires a separately approved
bootstrap before production use. Production NO-GO, A3, BR5 enablement, restore
acceptance and deployment authorization remain separate. Root tests on the new
`lima-servora-tt-a-amd64-20261026` fixture are a bounded authority/filesystem/reboot
acceptance, not full database/artifact/smoke/observation R4 release acceptance.
