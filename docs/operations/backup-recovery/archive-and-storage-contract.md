# Backup archive and storage contract — Servora-Med

```text
Date: 2026-08-22
Slice: BR0 — architecture and contracts only
Status: DOCUMENTATION_ONLY / IMPLEMENTATION_NOT_AUTHORIZED
Parent: architecture.md (decision register §2)
```

## 1. Archive format v1

The logical archive layout is the contract; the physical container is an
implementation choice made in BR2 (it must preserve these components
byte-exactly and support streaming).

After decryption, conceptually:

```text
backup/
  manifest.json        # self-describing metadata (§2)
  database.dump        # pg_dump custom format (-Fc), --no-owner --no-acl
  files.tar.zst        # ONLY when scope FULL_DATA and persistent files
                       # are configured; absent otherwise
  checksums.sha256     # component checksums (§3)
```

Contract rules:

- `formatVersion` starts at **1**. Any consumer that sees a version it
  does not support must fail closed (`RESTORE_FORMAT_UNSUPPORTED`); it
  must never attempt a best-effort restore.
- The archive is **self-describing and independently inspectable after
  decryption**: manifest + checksums live inside the encrypted payload,
  so a valid archive can be understood and validated without
  `backup_runs` or any Servora runtime.
- `database.dump` uses PostgreSQL-native logical backup
  (`pg_dump` custom format), matching the existing MVP script
  properties (`-Fc --no-owner --no-acl`).
- `files.tar.zst` covers only explicitly configured persistent Servora
  files. No such files exist today; the slot exists so FULL_DATA does not
  need a format change later. When absent, the manifest `contents.files`
  is `null` and the file must not be present.
- The encrypted remote artifact is named `<backup-id>.sbk.age`
  (single encrypted object; `.age` = age/X25519 recipient encryption,
  `.sbk` = Servora backup).

### 1.1 Physical local package — BR2 implementation decision

BR2 produces the pre-encryption plaintext package as a single
**uncompressed tar**:

```text
<temp-root>/<run-id>/package/<run-id>.sbk.tar
```

Why uncompressed tar (BR2 design decision, consumed by BR3 and BR7):

- The two large components are already compressed where it matters
  (`database.dump` is compressed inside the pg_dump custom format;
  `files.tar.zst` is zstd-compressed) — a compressed container would
  double-compress for no benefit and lose streamability.
- `tar` is present on every supported deployment/restore platform
  (GNU tar on the Ubuntu VPS reference, bsdtar on the macOS pilot),
  keeps component bytes exact, supports streaming into BR3 encryption,
  and is independently inspectable (`tar -t`, `tar -x`).
- Member list is fixed and explicit (`manifest.json`, `database.dump`,
  optional `files.tar.zst`, `checksums.sha256`) — no directory wildcards.
- `.sbk.age` stays reserved for the BR3 encrypted artifact; the plaintext
  package deliberately uses `.sbk.tar`.

## 2. Manifest v1 contract

TypeScript-style contract (camelCase, matching repository DTO style in
module `types.ts` files). Field set is normative for `formatVersion: 1`.

```ts
interface BackupManifestV1 {
  format: 'servora-backup';
  formatVersion: 1;                     // unknown versions must fail closed

  backupId: string;                     // UUID (backup_runs.id)
  createdAt: string;                    // ISO 8601 UTC

  application: {
    applicationVersion: string;         // server package version
    gitCommit: string | null;           // full commit SHA when available
  };

  backupScope: 'DATABASE' | 'FULL_DATA';
  origin: 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE';
  retentionClass: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'MANUAL' | 'PRE_RESTORE';

  database: {
    engine: 'postgresql';
    serverVersion: string;              // source SELECT version()
    dumpVersion: number;                // pg_dump PRODUCER version, see note
    schemaVersion: string;              // latest applied migration id,
                                        // e.g. '030_backup_domain_foundation'
                                        // (same value family as HEALTH_SCHEMA_VERSION)
  };

  contents: {
    database: {
      file: 'database.dump';
      bytes: number;
      sha256: string;                   // hex, 64 chars
    };
    files: {
      file: 'files.tar.zst';
      bytes: number;
      sha256: string;
    } | null;                           // null when not included
  };

  checksums: {
    file: 'checksums.sha256';           // format in §3
  };
}
```

### `dumpVersion` semantics — BR2 reconciliation of a BR0 ambiguity

The original BR0 wording called this field "pg_dump custom-format version".
That wording was ambiguous: PostgreSQL tooling does not expose the custom
archive container's internal format version through any stable CLI surface.
What `pg_dump --version` / `pg_restore --list` reliably expose is the
**producer tool version** (e.g. `pg_dump (PostgreSQL) 17.5`).

Reconciled semantics (BR2, recorded here instead of silently substituting):

- `dumpVersion` = the **pg_dump producer version**, encoded as
  `major * 100 + minor` (e.g. `17.5` → `1705`, `16.13` → `1613`).
- The custom archive container's internal format version is intentionally
  NOT recorded: it is an internal PostgreSQL detail with no CLI exposure and
  no restore-time decision depends on it (pg_restore of a supported
  PostgreSQL line reads the container itself).
- Restore-time compatibility reasoning therefore uses `serverVersion` (what
  to restore into) plus `dumpVersion` (which producer line created the dump).

### Forbidden manifest content

The manifest travels inside the encrypted archive, but it is treated as
inspectable metadata and must **never** contain:

- customer/organization/staff names, emails, or other personal data
- secrets, credentials, raw DB connection strings
- decryption key material of any kind

### Compatibility expectations

- `formatVersion: 1` readers: additive optional fields are tolerated
  (unknown JSON keys are ignored); a **higher** `formatVersion` is a hard
  failure.
- Future format versions may change layout, but must keep the
  `format`/`formatVersion` discriminator pair so old tooling fails
  closed deterministically instead of misreading content.

## 3. Checksum contract

Three distinct integrity artifacts; do not merge them:

| Layer | Covers | Producer | Verifier |
|-------|--------|----------|----------|
| Component checksums (`checksums.sha256` inside the archive) | plaintext components (`database.dump`, `files.tar.zst`) | worker, before encryption | restore CLI after decrypt (steps 5–7 of the restore flow) |
| Canonical encrypted-object checksum (`backup_runs.sha256`) | the whole encrypted `.sbk.age` object | worker, at REMOTE_VERIFY | worker (remote stream), reverify requests, restore CLI step 3 |
| Expected-checksum metadata (R2 object custom metadata, §3.1) | DB-independent record of the canonical encrypted SHA-256 (+ backup id, format version) | worker, at upload | worker REMOTE_VERIFY, reverify, restore CLI step 3 — works without `backup_runs` |

`checksums.sha256` uses the portable sidecar format already established
by `ops/scripts/backup-postgres.sh` (exactly two spaces, newline-terminated):

```text
<hex64-sha256>  database.dump
<hex64-sha256>  files.tar.zst        # only when present
```

The R2/S3 ETag is **not** a checksum contract input (see §7).

### 3.1 DB-independent checksum discovery (R2 object custom metadata)

Disaster recovery must satisfy pre-decrypt ciphertext verification even
when `backup_runs` is lost, and the manifest cannot help (reading it
requires decryption). The expected ciphertext checksum therefore also
travels on the R2 object itself as custom metadata, written at upload:

```text
<backup-id>.sbk.age
  x-amz-meta-servora-backup-id: <uuid>
  x-amz-meta-servora-format:   1
  x-amz-meta-servora-sha256:   <hex64 ciphertext sha256>
```

Contract rules:

- Metadata keys/values are opaque, ASCII, non-sensitive (no
  customer/organization/user data), and small — R2's total object
  metadata budget is on the order of 8 KiB (§7); the three keys above
  use a tiny fraction.
- Verification composition: normal case requires
  `backup_runs.sha256 == x-amz-meta-servora-sha256 == streamed hash`;
  DR case requires `x-amz-meta-servora-sha256 == streamed hash` before
  decrypt. Any divergence is a fail-closed integrity event.
- **This metadata is not a cryptographic signature.** It provides
  DR-time expected-checksum discovery and corruption detection. Age
  authenticated encryption provides ciphertext
  integrity/non-malleability, component checksums detect decrypted
  corruption, and Bucket Lock blocks delete/overwrite of **existing**
  objects during retention. These controls do **not** provide producer
  authenticity: V1 does not attest that an archive was produced by a
  trusted Servora worker (guarantee matrix and threat model:
  architecture §11). Note the nuance: object metadata is **not
  immutable by itself** (a same-key copy/replace can rewrite it), but
  rewriting the object is exactly what Bucket Lock blocks while
  retention is active (§6, §7) — the controls compose.
- A remote sidecar object (`<id>.sbk.age.sha256`) was considered and
  **rejected**: a second object doubles lifecycle/upload-completeness
  and orphan-handling surface for no additional guarantee.
- Writing this metadata needs only the same object-level `PutObject`
  permission the uploader already holds (§6.2) — no extra scope.

## 4. Retention contract

### 4.1 Logical restore-point policy (approved)

| Retention class | Restore points kept | Notes |
|-----------------|---------------------|-------|
| DAILY | 7 | |
| WEEKLY | 4 | |
| MONTHLY | 6 | |
| MANUAL | 30 days | by age |
| PRE_RESTORE | 30 days | by age |

### 4.2 No redundant uploads

A single scheduled backup is assigned the **longest applicable retention
class** rather than uploading identical daily/weekly/monthly copies.
Example: the first successful Sunday run satisfies DAILY + WEEKLY and is
stored once as `weekly`. Class assignment is recorded on the run and in
the manifest; it does not duplicate objects.

### 4.3 Logical policy vs physical duration

```text
logical restore-point policy  ≠  physical R2 object lifetime
```

- Logical policy (table above) is enforced by Servora: which restore
  points remain listed/valid.
- Physical object duration is set by **operator-managed** lifecycle
  rules and Bucket Lock retention, and **may include an operational
  safety margin** beyond the logical policy (e.g. physical expiry later
  than logical expiry, so verification/recovery of edge cases stays
  possible).
- Servora never deletes objects that Bucket Lock still protects, and
  never relies on physical deletion for logical correctness. When Bucket
  Lock retention exceeds lifecycle expiry, Cloudflare keeps the object
  until retention ends (verified behavior, §7).

## 5. R2 object key contract

Privacy-preserving hierarchy keyed by an **installation identifier** —
never by customer, organization, user, or medical/business entity names:

```text
production/
  <instance-id>/          # opaque, operator-chosen stable identifier
    v1/                   # archive format major version
      daily/
      weekly/
      monthly/
      manual/
      pre-restore/
        <backup-id>.sbk.age
```

Naming rules:

- Object name = `<backup-id>.sbk.age`, where `backupId` is a UUID
  (repository `gen_random_uuid()` convention). UUIDs give uniqueness
  without leaking timing or identity; creation time and retention class
  travel in the manifest and metadata, not as human-sensitive key parts.
- Retention class selects the prefix directory; a run has exactly one
  stored class (§4.2), so exactly one key per successful verified run.
- `<instance-id>` is stable across reinstalls (it must survive DB loss,
  so it is **operator-provided configuration**, e.g.
  `BACKUP_INSTANCE_ID`, not a DB-generated value) and must not contain
  customer/organization names.
- Keys must not expose: customer names, organization names, usernames,
  medical/business entity names.

## 6. R2 infrastructure and credential contract

### 6.1 Topology

- **Dedicated backup bucket** (preferred) or a dedicated safe prefix in a
  bucket whose other content is operator-approved for mixed use.
- The bucket is single-tenant to the Servora installation's backups
  (`production/<instance-id>/…` allows one bucket to serve multiple
  installations of the same operator without cross-installation keys).

### 6.2 Least-privilege runtime credential

```text
Runtime (worker) token scope:
  Object Read & Write, scoped to the backup bucket ONLY

Explicitly NOT granted to the runtime token:
  - Bucket Lock configuration (Cloudflare dashboard / REST API only)
  - lifecycle configuration (bucket-level configuration permission)
  - account-wide R2 administration
```

- The credential is an R2 token (Access Key ID + Secret) used over the
  S3-compatible API with AWS SigV4. Long-lived R2 tokens scope at
  **bucket** level; finer (prefix/object) scoping exists only via
  short-lived temporary credentials, which V1 does not require
  (verified, §7).
- No real credentials live in the repository or docs. Environment
  variable **names** (values supplied via `/etc/servora-med/servora-med.env`
  style env files, following existing app naming — app vars are
  feature-prefixed without a global prefix, e.g. `WEB_PUSH_*`):

| Env name | Purpose |
|----------|---------|
| `BACKUP_ENABLED` | feature/capability gate for the whole domain |
| `BACKUP_INSTANCE_ID` | stable opaque installation identifier (object keys) |
| `BACKUP_ENCRYPTION_RECIPIENT` | age public recipient (never the private identity) |
| `BACKUP_R2_ACCOUNT_ID` | S3 endpoint account id |
| `BACKUP_R2_BUCKET` | dedicated backup bucket |
| `BACKUP_R2_ACCESS_KEY_ID` | runtime token access key |
| `BACKUP_R2_SECRET_ACCESS_KEY` | runtime token secret |
| `BACKUP_R2_PREFIX` | optional sub-prefix (default `production/`) |

Exact validation rules are fixed in BR1's `config.ts` extension, which
must follow the strict hand-rolled validator conventions (no new
dependency).

### 6.3 Operator-managed controls

- **Bucket Lock** (anti-ransomware control: blocks delete/overwrite of
  existing objects during retention; does not establish provenance of
  newly created objects — architecture §11) and **lifecycle**
  (physical expiry, incomplete-multipart cleanup) are configured by the
  operator in Cloudflare, not by Servora.
- Bucket Lock is Cloudflare-native configuration — it is **not** AWS S3
  Object Lock API compatibility and must not be documented or
  implemented as such (decision 17; verified in §7).
- The application may **observe/report expected configuration state**
  where feasible (e.g. surface "lock policy present: yes/no" evidence in
  the Storage UI as configuration status, not as administration).
- The application **must fail safely** when required storage access is
  unavailable: runs fail closed with stable codes; the UI reports
  degraded/critical health (platform-contracts §6); nothing silently
  degrades to "backup ok".

## 7. Verified Cloudflare facts (2026-08-22)

Facts verified against official Cloudflare documentation on 2026-08-22.
BR slices must re-verify anything time-sensitive before relying on it.

1. **S3-compatible API**: R2 implements the S3 API (SigV4) including
   GetObject/HeadObject/PutObject/DeleteObject(s)/ListObjectsV2, full
   multipart set, conditional requests. Endpoint
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; region is always
   `auto`.
   <https://developers.cloudflare.com/r2/api/s3/api/>
2. **Token scoping**: R2 tokens support `Object Read & Write` /
   `Object Read only` scoped to specific buckets; these object-level
   permissions work only via the S3-compatible API, not the Cloudflare
   REST API. Long-lived tokens have **no prefix-level** scoping; prefix
   scoping exists only for short-lived temporary credentials and
   presigned URLs.
   <https://developers.cloudflare.com/r2/api/tokens/>
3. **Bucket Lock**: announced 2025-03-06. Prefix-based rules (≤1000 per
   bucket), conditions `Age` / `Date` / `Indefinite`; strictest rule
   wins; applies to existing and new objects; locked objects cannot be
   deleted or overwritten (error `10069 ObjectLockedByBucketPolicy`).
   Configurable **only** via Cloudflare dashboard, Wrangler
   (`wrangler r2 bucket lock …`), or Cloudflare REST API. The S3 Object
   Lock API (`PutObjectLockConfiguration`, `x-amz-object-lock-*`
   headers) is **not** implemented; there is no per-object retention
   API, legal hold, or governance/compliance-mode distinction.
   <https://developers.cloudflare.com/r2/buckets/bucket-locks/>
   <https://developers.cloudflare.com/changelog/post/2025-03-06-r2-bucket-locks/>
4. **Lifecycle**: expiration, Standard→IA transition, and abort of
   incomplete multipart uploads (default: 7 days after initiation),
   prefix-filtered. Manageable via dashboard, Wrangler, Cloudflare API,
   **and** the S3 API (`PutBucketLifecycleConfiguration`). Bucket Lock
   retention **takes precedence** over lifecycle expiry.
   <https://developers.cloudflare.com/r2/buckets/object-lifecycles/>
5. **ETag/checksum behavior**: multipart ETag is a hash of the parts'
   MD5 digests plus part count — **not** the object content MD5. R2 S3
   API accepts additional checksums (`Content-MD5`;
   `x-amz-checksum-sha256` with COMPOSITE type); `GetObjectAttributes`
   is not listed in the compatibility tables and must not be relied on.
   This is why the canonical integrity contract is Servora's own SHA-256
   of the encrypted object with remote stream verification
   (architecture §11).
   <https://developers.cloudflare.com/r2/objects/upload-objects/#etags>
   <https://developers.cloudflare.com/r2/api/s3/api/>
6. **Size limits relevant to multi-GB backups**: max object 5 TiB; max
   single PUT/part ~5 GiB; multipart: min part 5 MiB (except last), max
   10,000 parts; ~1 concurrent write per second per key; incomplete
   multipart uploads aborted after 7 days by default. BR4's uploader
   must use multipart with consistent part sizes for large dumps and
   abort incomplete uploads on failure.
   <https://developers.cloudflare.com/r2/platform/limits/>
7. **Plan availability of Bucket Lock**: no plan restriction is
   documented; do not assume a paid-tier requirement. Activation of R2
   itself is the prerequisite.
   <https://developers.cloudflare.com/r2/pricing/>
8. **Custom object metadata**: R2 supports `x-amz-meta-*` custom
   metadata on `PutObject` through the S3-compatible API (Workers API
   `customMetadata` maps to the same headers). `CopyObject` supports
   `x-amz-metadata-directive` values `COPY`/`REPLACE` plus the R2
   extension `MERGE` — i.e. metadata is rewritable only by rewriting
   (copying) the object, which Bucket Lock blocks during retention.
   Total object metadata budget is on the order of 8 KiB (key + value).
   <https://developers.cloudflare.com/r2/api/s3/extensions/>
   <https://developers.cloudflare.com/r2/platform/limits/>

### Explicitly unverified (do not build on)

- Whether single-PUT ETag is exactly the content MD5 (strongly implied,
  not stated verbatim).
- `GetObjectAttributes` availability on R2.
- Any Bucket Lock governance/compliance-mode semantics beyond rule-based
  retention (not part of the Cloudflare model).
