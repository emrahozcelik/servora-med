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

## Bootstrap runbook

Canonical order:

```text
1. Target identity verification
2. Confirm staging DB is absent or explicitly owned
3. Create the named staging database
4. Apply canonical migrations explicitly
5. Verify migration set = 23/23
6. Bootstrap synthetic administrator
7. Seed synthetic Admin/Manager/Staff test actors
8. Optionally import the approved synthetic pilot product catalog
9. Verify health schema exact match
10. Run authenticated staging smoke acceptance
```

Step details (canonical commands; do not substitute ad-hoc SQL for these steps):

1. **Target identity verification** — confirm the staging environment file
   points `DATABASE_URL` at `servora_med_staging` (database name only; never
   print credentials). Refuse to continue if the target is `servora_med`,
   `servora_med_test`, or any production-like name.
2. **Ownership** — the staging DB must be absent, or explicitly recorded as an
   owned disposable staging database created by this procedure.
3. **Create** — `createdb` for the exact name `servora_med_staging` (no wildcard
   patterns).
4. **Migrate** — from the deployed release directory, using the canonical
   migration runner only:

   ```bash
   cd server
   npm run migrate          # development-style run
   npm run migrate:prod     # built release run (dist/db/migrate.js)
   ```

   Never migrate on application start.
5. **Verify migration set** — read-only check that
   `schema_migrations` contains exactly the 23 canonical migrations
   (`001_auth_foundation` .. `023_staff_confidential_notes`).
6. **Bootstrap synthetic administrator**:

   ```bash
   npm run bootstrap:admin
   # env: BOOTSTRAP_ORGANIZATION_NAME, BOOTSTRAP_ADMIN_NAME,
   #      BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
   ```

7. **Seed synthetic test actors** (Admin/Manager/Staff per the staging
   acceptance fixtures):

   ```bash
   npm run db:seed:dev
   # env: DEV_SEED_ORGANIZATION_NAME, DEV_SEED_PASSWORD
   ```

   The `f4-seed` script (`F4_SEED_PASSWORD`) is the synthetic acceptance
   alternative when multi-organization fixtures are required.
8. **Optional pilot catalog import** (operator-reviewed catalog only):

   ```bash
   npm run products:import:pilot -- \
     --file ../pilot-products.example.json \
     --organization-id <staging-org-id> \
     --actor-user-id <admin-user-id> \
     --apply
   ```

9. **Health schema exact match** — the staging environment
   `HEALTH_SCHEMA_VERSION` must equal the exact latest migration in the release
   (currently `023_staff_confidential_notes`); `GET /api/health` must return
   `200 {"status":"ok"}`.
10. **Authenticated smoke acceptance** — see
    [staging-acceptance.md](./staging-acceptance.md).

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
10. Recreate synthetic fixtures
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
