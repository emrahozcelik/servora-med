# Production customer/contact onboarding importer

`server/src/db/import-customers.ts` is a narrow, operator-controlled importer for
an approved local customer manifest. It is dry-run by default; production
mutation requires `--apply` and an explicit source-staff to production-staff
mapping file.

## Inputs

The manifest is a local/operator-controlled JSON file and must not be committed
to Git. It contains version `1`, customer source IDs, the customer fields used by
the CRM create contract, and associated contact fields. It must not contain
passwords, password hashes, session data, or the source organization as a target
identity.

The staff mapping is an array of `{ sourceUserId, productionUserId }` objects.
Every source staff ID referenced by a customer must map to an active production
`STAFF` user. Unresolved mappings block `--apply`.

## Matching and safety

- Non-null normalized tax number is the strong identity key.
- Taxless records use the importer fingerprint written by a prior successful
  import. When no fingerprint exists, the importer uses normalized name plus
  every non-null secondary identity field supplied by the source; multiple
  candidates or a field mismatch are conflicts.
- Contacts use their importer fingerprint and otherwise an exact normalized
  field match. Ambiguous matches never merge automatically.
- The destination organization is always the CLI `--organization-id`; source
  IDs are never written into `organization_id` or staff foreign keys.
- Each customer and all of its contacts are inserted in one transaction. A
  contact or audit failure rolls back that customer together with its contacts.
- The approved source graph may contain an existing active primary contact under
  an inactive customer. The importer preserves that historical graph atomically;
  the normal CRM rule that blocks adding contacts to inactive customers remains
  in force for subsequent UI/API mutations.
- Customer and contact creation emits the same `CUSTOMER_CREATED` and
  `CONTACT_CREATED` audit event types as the normal CRM flow. Metadata contains
  only importer provenance and a one-way source fingerprint.

## Invocation

```bash
cd server
npm run customers:import:onboarding -- \
  --manifest /absolute/path/customer-manifest.json \
  --staff-map /absolute/path/staff-map.json \
  --organization-id <production-organization-uuid> \
  --actor-user-id <active-admin-or-manager-uuid>
```

Review the counts first. Add `--apply` only after the staff mapping and dry-run
are explicitly approved:

```bash
npm run customers:import:onboarding -- \
  --manifest /absolute/path/customer-manifest.json \
  --staff-map /absolute/path/staff-map.json \
  --organization-id <production-organization-uuid> \
  --actor-user-id <active-admin-or-manager-uuid> \
  --apply
```

This importer does not create users, generate credentials, bootstrap an admin,
create jobs, seed demo data, or modify the production environment.
