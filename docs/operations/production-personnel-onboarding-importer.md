# Production Personnel Onboarding Importer

This runbook describes the controlled import of approved Manager and Staff
accounts into an existing Servora-Med organization. It is intentionally
separate from customer onboarding and never imports the source Admin account.

## Inputs and privacy

The non-secret manifest is operator-controlled and must remain outside Git. It
contains only the source user ID, name, normalized email, role, and Staff
profile fields (title, phone, region, and source Manager ID). It must not
contain a password, password hash, session, reset token, or other auth secret.

The approved source in the current onboarding slice is the local `servora_med`
database. The source organization identity is metadata only; every destination
write uses the explicit `--organization-id` argument. The local Admin is
excluded and the existing production Admin is preserved.

The credential file is a separate operator-controlled JSON file outside Git:

```json
{
  "version": 1,
  "credentials": [
    { "email": "manager@example.test", "temporaryPassword": "..." }
  ]
}
```

It must be a regular, non-symlink file with mode `0600` or stricter, owned by
the executing operator (or root). Coverage must exactly match accounts that
will be created. Passwords use the existing production policy (12–128
characters) and are hashed through the existing scrypt implementation. Never
print or log the file or its passwords.

## Manifest shape

```json
{
  "version": 1,
  "sourceOrganizationId": "source-uuid",
  "sourceOrganizationName": "Source organization",
  "personnel": [
    {
      "sourceUserId": "source-uuid",
      "name": "Example Manager",
      "email": "manager@example.test",
      "role": "MANAGER",
      "staffProfile": null
    },
    {
      "sourceUserId": "source-uuid",
      "name": "Example Staff",
      "email": "staff@example.test",
      "role": "STAFF",
      "staffProfile": {
        "title": null,
        "phone": null,
        "region": null,
        "sourceManagerUserId": "source-manager-uuid"
      }
    }
  ]
}
```

Only `MANAGER` and `STAFF` rows are accepted. An `ADMIN` row is rejected.
Every non-null Staff Manager ID must refer to an approved Manager row. Source
Manager UUIDs are resolved to destination user UUIDs in memory; source UUIDs
are never written to `manager_user_id`.

## Dry-run (default)

From the `server` directory:

```bash
npm run personnel:import:onboarding -- \
  --file /private/tmp/servora-med-personnel-onboarding-manifest.json \
  --organization-id <destination-organization-uuid> \
  --actor-user-id <active-production-admin-uuid>
```

Without `--apply`, the command uses a read-only transaction and persists no
users, profiles, audit events, or password changes. The JSON report contains
safe counts (`CREATE`, `EXISTING`, `CONFLICT`, `INVALID`), Manager mapping
counts, credential requirements, and source-to-production mappings. Newly
created rows have a null destination ID until apply.

## Apply

Apply is fail-closed and requires the credential file. It validates the full
plan before any mutation, acquires an organization-scoped advisory lock, then
creates all Managers before Staff in one transaction:

```bash
npm run personnel:import:onboarding -- \
  --file /private/tmp/servora-med-personnel-onboarding-manifest.json \
  --organization-id <destination-organization-uuid> \
  --actor-user-id <active-production-admin-uuid> \
  --credentials-file /private/tmp/servora-med-personnel-credentials.json \
  --mapping-output /private/tmp/servora-med-personnel-production-mapping.json \
  --apply
```

The optional mapping output is created exclusively with mode `0600`; it is
never overwritten. The command also returns a password-free mapping report.
The mapping has `sourceUserId`, `productionUserId`, and role, so a later
customer importer can resolve staff assignments without source credentials.

New users are active, have `mustChangePassword=true`, and receive a
`USER_CREATED` audit event attributed to the explicit active production Admin.
Existing matching users are classified as `EXISTING` and are not updated.
Role/profile differences, inactive matches, unresolved Managers, missing or
extra credentials, and cross-organization email ownership block the entire
batch. No partial success is accepted.

Each imported user must use the first-login password-change flow at
`/api/change-password`. Credential delivery and first-login communication are
operator responsibilities; do not put temporary passwords in Git, manifests,
logs, audit metadata, or tickets.

## Failure and recovery

Errors are emitted as safe categories without PostgreSQL details, stack traces,
passwords, hashes, or source file contents. A failed apply transaction rolls
back entirely. If an optional mapping output cannot be written after a
successful commit, do not rerun apply blindly: preserve the committed state,
run a dry-run to recover the stable source-to-destination IDs, and create a
new output path.

This slice does not run against production. Production deployment, migrations,
bootstrap, customer import, Demo Data, and service restarts require separate
authorization and a new immutable release.
