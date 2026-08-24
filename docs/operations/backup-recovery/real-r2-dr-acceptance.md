# Real Cloudflare R2 DR acceptance

This is the operator contract for the one intentional, paid/persistent
Cloudflare R2 acceptance path. It proves the existing BR2→BR5 producer and BR7
restore path with synthetic data. It does not authorize or perform production
worker enablement, a production restore, monitoring cutover, or legacy backup
retirement.

## Current result

```text
REAL_R2_DR_ACCEPTANCE = NOT EXECUTED
reason: dedicated disposable Cloudflare R2 acceptance credentials unavailable

HOST_CONFIGURATION = NOT VERIFIED
PRODUCTION_CUTOVER_READINESS = BLOCKED
PRODUCTION CUTOVER = NOT EXECUTED
PRODUCTION WORKER ENABLEMENT = NOT EXECUTED
```

The repository contains a runnable harness and a safe `NOT_EXECUTED` record,
not fabricated real-R2 PASS evidence. See
[`docs/evidence/backup-recovery-real-r2/`](../../evidence/backup-recovery-real-r2/).

## Current Cloudflare contract

The V1 adapter deliberately implements the default-jurisdiction endpoint only:

```text
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
region = auto
```

Cloudflare currently documents `PutObject`, `HeadObject`, `GetObject`, and
`ListObjectsV2` on the S3-compatible API. Conditional `PutObject` and S3 custom
metadata (`x-amz-meta-*`) remain supported. Servora sends explicit
`ContentLength`; its canonical remote proof is metadata SHA-256 plus streamed
bytes and streamed SHA-256. ETag is diagnostic only.

References:

- [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [S3 API extensions and conditional operations](https://developers.cloudflare.com/r2/api/s3/extensions/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)
- [Temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
- [Bucket Lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [Object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

Cloudflare also documents jurisdiction-specific endpoint families. Supporting
those endpoints would change the current validated endpoint boundary and is
not part of this acceptance slice. Do not supply an alternate endpoint.

The existing effective single-PUT ceiling remains 5 GiB minus 5 MiB
(5,363,466,240 bytes). The acceptance dataset is intentionally tiny and does
not exercise load, RTO at production volume, or a multipart completion path.

## Infrastructure and credential boundary

Use a disposable acceptance bucket where possible and a dedicated,
bucket-scoped Object Read & Write credential. Never reuse normal
`BACKUP_R2_*` runtime credentials. The harness accepts only these dedicated
names:

```text
SERVORA_ACCEPTANCE_R2_ACCOUNT_ID
SERVORA_ACCEPTANCE_R2_BUCKET
SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID
SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY
```

The secret values belong only in a private local/operator environment. Do not
put them in shell history, chat, Git, a PR, a test fixture, or evidence. The
harness compares a configured production bucket and exact production
credential pair without printing values, and refuses collisions.

Cloudflare temporary credentials require a session token. The current Servora
V1 S3 credential contract does not accept a session token, and this slice does
not redesign the production credential model. An operator with only temporary
credentials must stop at `NOT EXECUTED`; a separate reviewed adapter change is
required. A dedicated bucket-scoped key pair is the supported acceptance path.

The runtime token must not receive account administration, Bucket Lock,
lifecycle, custom-domain, or bucket-configuration permissions.

## Prerequisites

- A disposable PostgreSQL control installation exposed only through
  `TEST_DATABASE_URL`. It must not be production.
- Official `age` >= 1.3.0 and `age-keygen`; set their executable paths in
  `AGE_BIN` and `AGE_KEYGEN_BIN`.
- The four dedicated acceptance R2 variables above.
- A small, disposable acceptance bucket whose name differs from any configured
  production bucket.
- The repository dependencies installed and the focused deterministic tests
  passing.

The harness generates its own opaque instance ID, two random database names,
an ephemeral native hybrid age identity, synthetic organization/user/customer
rows, and a small synthetic persistent-file payload. It never reads customer
data or a production age private identity.

## Intentional command

Load the variables through the operator's private secret mechanism, then run
from the repository root:

```bash
npm --prefix server run backup:real-r2-acceptance
```

The package script supplies the required `--i-accept-real-r2-test` flag. The
credentials alone cannot activate external I/O. The real test is not included
in ordinary build, test, or CI execution.

Before the first R2 request, the harness prints values for only these gates:

```text
acceptance bucket configured? YES/NO
acceptance credentials configured? YES/NO
explicit opt-in supplied? YES/NO
ephemeral age identity generated? YES/NO
source DB synthetic? YES/NO
acceptance instance ID production-distinct? YES/NO
```

It never prints identifiers or credential values. Any required `NO` stops
external execution. Exit/result classification is unambiguous:

```text
REAL_R2_DR_ACCEPTANCE = PASS
REAL_R2_DR_ACCEPTANCE = FAIL
REAL_R2_DR_ACCEPTANCE = NOT EXECUTED
```

`NOT EXECUTED` uses exit code 3. A real test failure returns the underlying
non-zero test exit after printing `FAIL`.

## Authoritative acceptance sequence

1. Create a synthetic source database and run canonical migrations through
   `033_backup_worker_runtime`.
2. Seed one synthetic admin, organization, customer, and a small files root.
3. Generate a new ephemeral native hybrid age identity and use only its public
   recipient for the backup.
4. Request a `FULL_DATA` manual run and execute the real BR5 worker/pipeline.
5. Use the real BR4 adapter for conditional single `PutObject`, then real
   `HeadObject` and streamed `GetObject` remote verification. Wait for
   `SUCCESS` with `verified_at` before destructive simulation.
6. Drop the source acceptance database, prove it is unavailable, and remove
   the source files root.
7. Build the server and start separate actual compiled BR7 CLI wrapper
   processes for real `list --remote`, `verify`, `inspect`, and
   `restore --mode disaster-recovery`.
8. Restore into a fresh, random target database and separate new files root.
9. Validate schema, representative domain rows, and the restored file.
10. Listen with an isolated Fastify instance on loopback/ephemeral port,
    validate real `/api/health`, login, and authenticated `/api/auth/me`.
11. Persist safe evidence before cleanup. Cleanup may target only the exact
    object key, databases, identity, and temporary roots created by this run.

The actual object layout remains production-shaped without using the
production namespace identity:

```text
production/<opaque-acceptance-instance-id>/v1/manual/<backup-uuid>.sbk.age
```

The source database is not dropped until real remote verification has passed.
The target never becomes the canonical application `DATABASE_URL`.

## PASS contract

`REAL_R2_DR_ACCEPTANCE = PASS` requires every item below:

- real R2 endpoint, `PutObject`, `HeadObject`, `GetObject`, and
  `ListObjectsV2`
- custom metadata round trip
- exact remote byte count and streamed ciphertext SHA-256
- age decryption
- manifest and component checksum validation
- unavailable source metadata database
- new-target `pg_restore`
- schema, domain, and `FULL_DATA` file validation
- isolated API health, authentication, and authenticated read
- BR7 `READY_FOR_CUTOVER` outcome for the isolated target

Missing any mandatory item is not PASS. `READY_FOR_CUTOVER` here describes
only the disposable restored target; it is not production cutover readiness
or authorization.

## Evidence and cleanup

Real execution writes a mode-0600 JSON file atomically under:

```text
docs/evidence/backup-recovery-real-r2/
```

The safe manifest records the Git commit, opaque test identifiers, synthetic
database names, backup scope, schema version, ciphertext size, each mandatory
gate boolean, safe timings, cleanup result, `realR2=true`,
`producerSignaturePresent=false`, and `productionCutoverPerformed=false`.

It never records credentials, a session token, private age identity,
connection string, signed URL, request headers, raw SDK errors, or raw domain
data. A failure preserves the furthest safe gate reached without exposing the
underlying secret-bearing request context.

R2 cleanup first checks whether this run's exact key exists. It then attempts
one bounded delete and verifies absence. Evidence classifies the result as
`DELETED`, `RETAINED_OR_LOCKED`, `NOT_CREATED`, or `CLEANUP_UNVERIFIED` when a
safe distinction is impossible. A retention rule may make deletion impossible;
never weaken Bucket Lock to make cleanup pass, and never delete a broader
prefix.

## Bucket Lock, lifecycle, and authenticity

Bucket Lock is operator-managed infrastructure. It can prevent overwrite or
deletion of an existing object for the configured retention period. It does
not identify a trusted producer, replace SHA/age integrity, or prevent a
malicious writer from creating a different new key. The harness never changes
Bucket Lock.

Servora logical retention, R2 lifecycle deletion, and Bucket Lock retention
enforcement are separate policies and may intentionally use different
durations. Bucket Lock takes precedence where policies overlap. The runtime
token neither manages nor claims to observe either Cloudflare policy.

V1 has no producer signature. A passing result proves artifact integrity and
recoverability, not that the producer was cryptographically authenticated.
