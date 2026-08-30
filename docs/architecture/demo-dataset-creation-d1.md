# D1 — Managed Demo Dataset Backend Creation

Status: implemented; backend creation contract from D1 with the D4 lifecycle
reconciliation. UI creation flow is deferred to D2.

## Endpoint

```
POST /api/admin/demo-datasets
```

Admin-only (MANAGER and STAFF receive `403 FORBIDDEN`). The organization is
taken from the authenticated Admin actor; the client never supplies an
`organizationId`.

Request body:

```json
{
  "clientActionId": "<UUID>"
}
```

Response (first successful creation):

- HTTP `201`-style result with `dataset` and `counts`
- `replayed: false`

Idempotent replay of the same `clientActionId` returns the original result with
`replayed: true`.

## Feature flag

Creation requires `config.demoDataCreationEnabled === true`. Default is
`FALSE` in all environments.

- `DEMO_DATA_CREATION_ENABLED=false` → create is unavailable (opaque 404).
- The flag does not disable `list`, `detail`, `preview`, or `purge`.

## D4 lifecycle contract

The disposable lifecycle is:

```text
create → use → purge completely → recreate
```

After a successful purge, all DEMO domain rows and the `demo_datasets` domain
row are absent. `PURGED` is not a product-facing dataset status and no
product-facing `PURGED` history row is retained. A minimal technical
`COMPLETED` purge-operation receipt may remain so an identical idempotent retry
can replay the completed response; list and detail do not return that receipt.

Purge is transactional, validates the exact planned roots, fails closed on
cross-dataset or BUSINESS references, and never deletes BUSINESS data. The D4
migration removes legacy `PURGED` registry rows only when their six required
roots are already empty; otherwise it fails closed.

## Dataset key / clientActionId

`dataset_key` is derived deterministically from `clientActionId`:

```
standard-v1-<clientActionId>
```

- same organization + same `clientActionId` → same `dataset_key`
- new `clientActionId` → new `dataset_key`

This is the durable idempotency identity. After a purge, the same
`clientActionId` replays the technical completed purge-operation response; it
does not create a new dataset. A genuinely new creation after purge uses a
new `clientActionId`.

## Cardinality

At most one `ACTIVE` demo dataset per organization. The domain registry has no
historical `PURGED` tombstones; minimal completed purge-operation receipts may
remain outside the domain registry. Creation is serialized per organization
with a single `SERIALIZABLE` transaction plus `SELECT ... FOR UPDATE` on the
organization row; PostgreSQL SSI covers the concurrent two-tab race.

## Seed version

`demo-standard-v1` identifies the fixture content version.

## Fixture content

- 3 demo users: 1 MANAGER, 2 STAFF (no demo ADMIN)
- 5 demo customers
- 5 demo products (`DEMO-...` SKUs)
- 8 demo jobs: 2 NEW, 1 ACCEPTED, 1 IN_PROGRESS, 1 WAITING_APPROVAL,
  2 COMPLETED, 1 CANCELLED
- small child set: delivery items on 2 jobs, notes on 4 jobs
- calendar, messaging, notifications, web push, realtime: none in D1

All demo rows are `data_class = DEMO` and `demo_dataset_id = <dataset>`.
Demo jobs reference only same-dataset demo users/customers/products; no
BUSINESS row is touched.

Demo user credentials are cryptographically random, hashed with the canonical
password hashing helper, never returned, and never logged.

## Atomicity

Dataset row + users + staff profiles + customers + products + jobs + job
children + one creation audit commit in a single transaction. Any failure
rolls back everything; no partially visible dataset.

## Creation audit

One `audit_events` row is written inside the transaction with the real Admin
actor and metadata carrying `datasetKey`, `seedVersion`, and `counts`. No
credentials, hashes, or connection details.

## Retry / error semantics

- same `clientActionId` → idempotent replay of the original result
- new `clientActionId` while an ACTIVE dataset exists → `409
  DEMO_DATASET_ALREADY_EXISTS`
- invalid `clientActionId` → `400`
- flag off → opaque `404`
- non-Admin → `403 FORBIDDEN`
- unexpected DB/schema error → internal error contract (no partial IDs or SQL)

## Purge round-trip

D1 creation is proven compatible with the D4 purge backend on a disposable
PostgreSQL schema: create → preview (`safeToPurge=true`) → purge completely
→ no `demo_datasets` domain row → create again with a new action. Replaying the
old action after purge returns the minimal technical `COMPLETED` receipt; it
does not expose a product-facing `PURGED` result.

## Production posture

`DEMO_DATA_CREATION_ENABLED` remains `FALSE` in production. No local acceptance
was performed against `servora_med`; all DB-backed D1 tests run on disposable
PostgreSQL schemas via `TEST_DATABASE_URL` only.
