# Staging database runbook — Servora-Med

Canonical procedures for the **disposable synthetic-only staging database**.
This document defines the procedures; executing them requires a later,
explicitly authorized batch. No command in this document has been executed by
this batch.

The canonical staging database name is:

```text
servora_med_staging
```

This is **not** the production database and **not** the local development
database (`servora_med`). The staging database is disposable by design:
dropping and recreating it is the intended reset path, never a recovery event.

## Synthetic data policy

```text
REAL CUSTOMER / PATIENT / STAFF DATA:
PROHIBITED

bootstrap-admin:
minimum synthetic administrative entry

seed-dev / f4-seed:
synthetic acceptance fixtures only

import-pilot-products:
explicit --apply operation with synthetic/approved catalog
```

`pilot-products.example.json` is a reviewed version-1 catalog input. The catalog
contains real-world product information (names, SKUs, brands). Before any
staging import, an operator review gate must confirm the catalog is approved for
staging use; no real customer, patient, or staff data may ever enter the staging
database.

## Bootstrap profiles (mutually exclusive)

Staging bootstrap has two profiles. **Exactly one** is selected per staging
database lifecycle; they are never chained:

```text
MINIMAL ADMIN PROFILE
- canonical migration
- bootstrap-admin (installed release)
- no other seed or fixture command

ACCEPTANCE FIXTURE PROFILE  ← canonical for the first staging acceptance
- canonical migration
- NO bootstrap-admin
- f4-seed from a separate exact-head tooling checkout
- synthetic Admin/Manager/Staff/multi-org fixtures
```

### Profile exclusivity is policy-enforced and fail-closed

The two profiles are **operationally mutually exclusive**. The enforcement is
not automatic in the tools, so the runbook requires an explicit fail-closed
precondition:

- `bootstrap-admin` applies an empty-database check
  (`BOOTSTRAP_NOT_ALLOWED` when users already exist).
- `f4-seed` does **not** verify that the `users` table is empty on its own; it
  inserts fixed synthetic organizations and users directly.

Therefore a separately enforced precondition is mandatory before F4 runs
(read-only gate in [Bootstrap 6b](#6b-acceptance-fixture-profile--f4-seed-from-a-tooling-checkout)).

### `db:seed:dev` is a local-development tool

`db:seed:dev` (`seedDevelopment`) is **not** part of the staging bootstrap:

- it refuses to run when users already exist (`BOOTSTRAP_NOT_ALLOWED`);
- it refuses `NODE_ENV=production` outright (`DEV_SEED_FORBIDDEN`), and the
  staging environment runs with production semantics.

It remains available for local development only.

## Bootstrap runbook

Canonical order:

```text
1. Target identity verification
2. Confirm staging DB is absent or explicitly owned
3. Create the named staging database
4. Apply canonical migrations explicitly
5. Verify migration set = 23/23
6. Apply the selected fixture profile (MINIMAL ADMIN or ACCEPTANCE FIXTURE)
7. Optionally import the approved synthetic pilot product catalog
8. Verify health schema exact match
9. Run authenticated staging smoke acceptance
```

### 1. Target identity verification

Confirm the staging environment file points `DATABASE_URL` at
`servora_med_staging` (database name only; never print credentials). Refuse to
continue if the target is `servora_med`, `servora_med_test`, or any
production-like name.

### 2. Ownership

The staging DB must be absent, or explicitly recorded as an owned disposable
staging database created by this procedure.

### 3. Create

`createdb` for the exact name `servora_med_staging` (no wildcard patterns).

### 4. Canonical migration

From the **deployed release directory**, with the built migration runner (no
`tsx`, no devDependencies):

```bash
cd "$RELEASE_DIR/server"
node dist/db/migrate.js
```

A builder checkout may use `npm run migrate` (`tsx`); a builder checkout is
**not** an installed release. Never migrate on application start.

### 5. Verify migration set

Read-only check that `schema_migrations` contains exactly the 23 canonical
migrations (`001_auth_foundation` .. `023_staff_confidential_notes`).

### 6a. MINIMAL ADMIN PROFILE — bootstrap-admin

Installed release (no `tsx`):

```bash
cd "$RELEASE_DIR/server"
node dist/db/bootstrap-admin.js
# env: BOOTSTRAP_ORGANIZATION_NAME, BOOTSTRAP_ADMIN_NAME,
#      BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
```

Stop after this step; run no other seed or fixture command in this profile.

### 6b. ACCEPTANCE FIXTURE PROFILE — f4-seed from a tooling checkout

`f4-seed` is **not** part of the installed release: the source lives in
`server/scripts/f4-seed.ts` (outside the TypeScript build) and its execution
requires `tsx`, a devDependency absent from the immutable release. It must be
run as a **separate exact-head tooling checkout**, never from inside the
installed runtime release.

**Fail-closed precondition (read-only, mandatory before F4 runs):**

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT current_database();

SELECT COUNT(*) AS existing_users
FROM users;

SELECT COUNT(*) AS migration_count,
       MAX(version) AS latest_migration
FROM schema_migrations;
SQL
```

Required:

```text
current_database:
servora_med_staging

existing_users:
0

migration_count:
23

latest_migration:
023_staff_confidential_notes
```

If any value differs:

```text
STOP
DO NOT RUN F4-SEED
DO NOT RESET AUTOMATICALLY
REQUIRE A SEPARATELY AUTHORIZED STAGING RESET
```

Execution with the checkout-local deterministic binary (never `npx`, which can
fall back to network resolution; fail if the local binary is missing):

```bash
cd "$TOOLING_CHECKOUT/server"
npm ci

test -x ./node_modules/.bin/tsx

./node_modules/.bin/tsx scripts/f4-seed.ts
```

`DATABASE_URL` and `F4_SEED_PASSWORD` come only from the private environment.

**Target identity proof.** The `database` field in the f4-seed output JSON is
currently a fixed, test-oriented label (`servora_med_f4_test`); it is **not**
staging target proof. Canonical target proof is always:

```bash
psql "$DATABASE_URL" -X -tAc "SELECT current_database();"
```

**Post-F4 verification (read-only).** After f4-seed, re-verify target identity
and synthetic actor counts:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT current_database();

SELECT COUNT(*) AS synthetic_users
FROM users;

SELECT COUNT(*) AS synthetic_orgs
FROM organizations;
SQL
```

Expected: `current_database` = `servora_med_staging`; `synthetic_users` and
`synthetic_orgs` match the f4 fixture plan (multi-org Admin/Manager/Staff).

### 7. Optional pilot catalog import (operator-reviewed)

The catalog file lives in the repository root (`pilot-products.example.json`);
it is **not** copied into the release. Use an explicit operator-reviewed
absolute input path — never a release-relative guess:

```bash
cd "$RELEASE_DIR/server"
node dist/db/import-pilot-products.js \
  --file /absolute/path/to/approved-catalog.json \
  --organization-id <staging-org-id> \
  --actor-user-id <admin-user-id> \
  --apply
```

### 8. Health schema exact match

The staging environment `HEALTH_SCHEMA_VERSION` must equal the exact latest
migration in the release (currently `023_staff_confidential_notes`); verify
against `server/dist/db/migrations` (see
[staging-contract.md](./staging-contract.md)); `GET /api/health` must return
`200 {"status":"ok"}`.

### 9. Authenticated smoke acceptance

See [staging-acceptance.md](./staging-acceptance.md).

## Disposable reset runbook

Reset is a planned, fail-closed operation on the **staging database only**.
This procedure is not invoked automatically and never during deployment.

```text
1. Confirm exact environment = staging
2. Confirm exact DB allowlist name
3. Refuse production-like database names
4. Confirm no pilot session or active consumer
5. Take and verify a pre-reset backup
6. Require explicit destructive acknowledgement
7. Drop only the exact staging DB
8. Recreate the exact staging DB
9. Apply all canonical migrations
10. Recreate synthetic fixtures via the selected bootstrap profile
11. Verify health and authenticated smoke
12. Record reset timestamp, commit and operator
```

Fail-closed rules, mirroring the restore rehearsal approach in
[backup-restore.md](./backup-restore.md) (`restore-rehearsal.sh` refuses
production database names, requires a portable checksum, and requires an
explicit destructive acknowledgement):

```text
wildcard DB deletion:
PROHIBITED

production DB reset:
PROHIBITED

servora_med reset:
PROHIBITED

servora_med_test reset:
PROHIBITED

shared development DB reuse:
PROHIBITED

automatic reset during deploy:
PROHIBITED

migration failure followed by implicit reset:
PROHIBITED
```

A migration failure never implies a reset; the failure is reported and the
deployment is treated as not ready.

Related documents: [staging-contract.md](./staging-contract.md),
[staging-acceptance.md](./staging-acceptance.md),
[backup-restore.md](./backup-restore.md),
[production-deployment.md](./production-deployment.md).
