# Pilot Product Merge and Closed Jobs Design

Date: 2026-07-16
Status: Product-approved design
Scope: idempotent pilot catalog merge and a closed-work quick view

## 1. Objective

Merge the 81-product pilot catalog into the existing `Servora Med Demo` organization without
overwriting matching records or creating duplicates. Add `Biten işler` beside the existing Job
workspace quick views and show the canonical closed-job result (`COMPLETED` plus `CANCELLED`).

## 2. Product Merge Contract

The importer consumes `pilot-products.example.json` version 1 and requires an explicit
organization and audit actor. It validates the complete document before opening a write
transaction:

- `products` is an array and every product has a valid required name;
- optional fields respect the canonical Product field bounds and types;
- category values belong to the document's category guide;
- SKU values are unique inside the source document;
- SKU-bearing records match existing records by organization + exact SKU;
- records without SKU match existing records by organization + exact name where SKU is null;
- more than one database match is a hard failure.

The current evidence is 81 source products, 48 exact matches, 33 new products, zero source SKU
duplicates, zero ambiguous database matches, and zero differing matched records.

The importer is insert-only. Exact matches are skipped and never updated, reactivated, or
version-bumped. Every new Product receives `PRODUCT_CREATED` with the selected actor. One
organization-scoped transaction and advisory lock cover planning, insertion, and audit writes;
any error rolls back the complete batch. Dry-run is the default. `--apply` is required for writes.
Running the same import again returns 81 matches and zero inserts.

`pilot-products.example.json` becomes a tracked operational input so the applied dataset is
reviewable and repeatable. It contains no credentials.

## 3. Closed Jobs Quick View

The Job workspace quick-view order becomes:

1. `Aktif işler`
2. `Onay kuyruğu` for Manager/Admin
3. `Düzeltme istenenler`
4. `Biten işler`

`Biten işler` uses the existing canonical `closed` status filter. The backend already defines
`closed` as `COMPLETED` plus `CANCELLED`, so no new status, endpoint, or query is introduced.
Staff continues to receive only assigned records; Manager/Admin retains organization scope.

Per the approved revision, constructing the `Biten işler` destination does not intentionally
change the caller's `view` or `offset` query values. It replaces only `status` with `closed` and
preserves the remaining valid filter context. The resulting list uses the existing pagination
and ordering contract. The active Kanban endpoint remains active-only and is not expanded with
terminal columns in this slice.

The new link uses the same markup, focus treatment, responsive wrapping, and active-state
styling as the neighboring quick views. `aria-current="page"` is set only when the canonical
status is `closed`.

## 4. Testing and Verification

TDD coverage includes:

- document validation, duplicate/ambiguous rejection, and exact merge planning;
- dry-run does not write;
- one transaction inserts exactly the 33 new records and 33 audit events;
- injected failure rolls back products and audits;
- second apply inserts zero records;
- `closed` repository query includes `COMPLETED` and `CANCELLED` and excludes active states;
- quick-view order, role visibility, `aria-current`, and exact closed destination;
- closed destination preserves current valid `view`, `offset`, and non-status filters;
- full server/web build, tests, audit, real PostgreSQL import verification, and remote CI.

After the importer tests and dry-run pass, the apply command targets the single local
`Servora Med Demo` organization and an active Admin audit actor. Post-apply verification checks
81 total matched catalog records, 33 new `PRODUCT_CREATED` events for that run, no duplicates,
and a zero-insert repeat dry-run.

## 5. Out of Scope

- updating the 48 exact existing products;
- deleting or deactivating products absent from the JSON file;
- adding a new product uniqueness constraint or migration;
- adding terminal columns to Kanban;
- changing JobCard status semantics, authorization, sort order, or page size.
