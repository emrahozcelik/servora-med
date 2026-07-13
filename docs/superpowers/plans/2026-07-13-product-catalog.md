# Product Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Slice 06 as an informational, organization-scoped Product catalog that Admin and Manager can maintain, Staff can read, and Product Delivery can search without adding inventory, warehouse, accounting, or ERP behavior.

**Architecture:** A focused `products` module owns Product reads, writes, lifecycle, optimistic concurrency, and management audit events. PostgreSQL migration 005 relaxes the legacy seeded Product constraints and preserves historical delivery snapshots. JobCard keeps transaction-local Product validation and snapshot creation; web clients use the canonical paginated `/api/products` contract for both catalog screens and active Product selection.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Fastify 5, PostgreSQL 16+, React 19.2, React Router DOM 7.18.1, Vite 8, Vitest 4, Playwright MCP.

## Global Constraints

- Follow [the approved Product Catalog design](../specs/2026-07-13-product-catalog-design.md) exactly.
- Use English identifiers, tests, commits, and acceptance criteria; use Turkish user-facing copy.
- Create migration `005_product_catalog.sql`; never edit applied migrations 001–004.
- Treat Product data as informational catalog data. Do not add stock, warehouse, barcode, costing, currency, price history, invoice, accounting, lot-policy, serial-policy, or expiry-policy behavior.
- Require only Product `name` from the user. Preserve optional `sku`, `brand`, `category`, `model`, `unit`, and `referencePrice` as nullable values.
- Preserve SKU casing and punctuation, allow duplicate SKU/name values, and never invent the unit `adet` when unit is absent.
- Admin and Manager can mutate Products. Staff can list and read Products but cannot mutate them. Enforce this in the service layer.
- Scope every Product query and mutation by authenticated `organizationId`; cross-organization and missing reads use `404 PRODUCT_NOT_FOUND`.
- Product create starts active at version 1. Patch and lifecycle commands require positive integer `expectedVersion`; every successful mutation increments version exactly once.
- Product lifecycle changes only through named `/activate` and `/deactivate` commands. There is no Product DELETE route.
- Successful Product mutations append exactly one Product audit event in the same transaction. Failed writes append none.
- Audit metadata may contain safe IDs, status values, and changed field names only; never copy full request bodies or reference-price values into audit history.
- JobCard backend integration stays transaction-local and never calls the Product HTTP API.
- Product deactivation blocks new selection/replacement only. Existing delivery snapshots and permitted quantity/note edits remain valid.
- Remove `/api/reference/products` only after every web consumer uses `/api/products`; retain `/api/reference/customers`.
- Do not add a UI framework or autocomplete dependency. Use existing React, CSS, and request helpers.
- Every production behavior begins with a focused failing test and ends with focused plus regression verification.
- Keep implementation in the existing `feature/slice-06-product-catalog` worktree and create small English commits at each task boundary.

---

## File Map

### Server

- Create `server/src/db/migrations/005_product_catalog.sql` — Product versioning, nullable informational fields, relaxed SKU uniqueness, nullable delivery unit, price check, and Product audit values.
- Create `server/src/modules/products/types.ts` — Product, filters, records, mapping, and audit types.
- Create `server/src/modules/products/repository.ts` — organization-scoped list/detail queries, versioned writes, lifecycle writes, audit append, and transaction runner.
- Create `server/src/modules/products/service.ts` — writer policy, normalization, lifecycle, concurrency, changed-field audit, and canonical errors.
- Create `server/src/modules/products/handlers.ts` — exact body/query parsing and validation.
- Create `server/src/modules/products/routes.ts` — canonical Product HTTP surface.
- Modify `server/src/app.ts` and `server/src/index.ts` — inject and register Product repository/service/routes.
- Modify `server/src/modules/job-cards/types.ts` — make delivery unit and Product snapshot fields accurately nullable.
- Modify `server/src/modules/job-cards/repository.ts` — use nullable Product fields and transaction-scoped Product reads; remove Product reference listing.
- Modify `server/src/modules/job-cards/service.ts` — preserve historical snapshots when Product is unchanged and require active Product only for add/replacement.
- Modify `server/src/modules/job-cards/reference-routes.ts` — keep Customer reference route and remove Product reference route.
- Modify `server/src/modules/auth/setup.ts` only if seed typing/assertions must reflect the relaxed Product contract; keep the representative populated seed valid.

### Web

- Create `web/src/services/products-api.ts` — runtime-validated paginated Product client and mutation commands.
- Create `web/src/ProductList.tsx` — searchable/status-filtered responsive catalog list and explicit states.
- Create `web/src/ProductForm.tsx` — create/edit form with only name required and accessible validation/conflict handling.
- Create `web/src/ProductDetail.tsx` — read-only Staff detail plus Manager/Admin edit/lifecycle controls.
- Create `web/src/ProductSelect.tsx` — active, searchable, paginated Product selector for delivery creation.
- Modify `web/src/paths.ts` and `web/src/AppRouter.tsx` — stable Product routes and navigation.
- Modify `web/src/App.tsx` — stop globally loading legacy Product references.
- Modify `web/src/DeliveryCreate.tsx` — consume `ProductSelect` instead of a preloaded fixed Product array.
- Modify `web/src/services/api.ts` — nullable delivery snapshot contract and remove legacy Product reference client/types.
- Modify `web/src/JobDetail.tsx` — display quantity without a fabricated unit.
- Modify `web/src/styles.css` — accessible responsive Product list, form, detail, selector, and confirmation dialog styles.

### Tests and documentation

- Create server tests `product-schema.test.ts`, `product-repository.test.ts`, `product-service.test.ts`, `product-concurrency.test.ts`, and `product-routes.test.ts`.
- Modify server tests `delivery-item-service.test.ts`, `job-card-routes.test.ts`, `reference-routes.test.ts`, `reference-service.test.ts`, `app.test.ts`, and setup tests affected by Product typing.
- Create web tests `products-client.test.ts`, `product-list.test.tsx`, `product-form.test.tsx`, `product-detail.test.tsx`, and `product-select.test.tsx`.
- Modify web tests `router.test.tsx`, `delivery-create.test.tsx`, `delivery-create-screen.test.tsx`, `job-detail.test.tsx`, `tracer-client.test.ts`, `App.test.tsx`, and `accessibility-contract.test.ts`.
- Update `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, `DECISIONS.md`, and `README.md` only after the corresponding implementation is verified.

---

## Checkpoint 06A — Schema and Product Domain

### Task 1: Migration 005 and schema invariants

**Files:**
- Create: `server/src/db/migrations/005_product_catalog.sql`
- Create: `server/tests/product-schema.test.ts`

**Interfaces:**
- Existing Product rows receive `version = 1`.
- SKU and unit become nullable; the organization/SKU unique constraint is removed.
- Delivery snapshots may retain `unit = null`.
- `default_price` is null or non-negative.
- Product management audit values become legal.

- [ ] **Step 1: Write the failing migration contract test**

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/005_product_catalog.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('005 Product catalog migration contract', () => {
  it('versions Products and relaxes informational fields', () => {
    expect(sql).toMatch(/ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i);
    expect(sql).toMatch(/DROP CONSTRAINT products_organization_id_sku_key/i);
    expect(sql).toMatch(/ALTER COLUMN sku DROP NOT NULL/i);
    expect(sql).toMatch(/ALTER COLUMN unit DROP DEFAULT/i);
    expect(sql).toMatch(/ALTER COLUMN unit DROP NOT NULL/i);
  });

  it('allows unknown delivery units and rejects negative reference prices', () => {
    expect(sql).toMatch(/job_card_delivery_items[\s\S]*ALTER COLUMN unit DROP NOT NULL/i);
    expect(sql).toMatch(/default_price IS NULL OR default_price >= 0/i);
  });

  it('extends management audit values without ERP fields', () => {
    expect(sql).toContain("'PRODUCT'");
    expect(sql).toContain("'PRODUCT_CREATED'");
    expect(sql).toContain("'PRODUCT_FIELDS_UPDATED'");
    expect(sql).toContain("'PRODUCT_ACTIVATED'");
    expect(sql).toContain("'PRODUCT_DEACTIVATED'");
    expect(sql).not.toMatch(/stock|warehouse|cost|currency|barcode/i);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/product-schema.test.ts`  
Expected: FAIL because `005_product_catalog.sql` does not exist.

- [ ] **Step 3: Inspect installed constraint names and add the migration**

Use the actual names established by migrations 002 and 004:

```sql
ALTER TABLE products
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  DROP CONSTRAINT products_organization_id_sku_key,
  ALTER COLUMN sku DROP NOT NULL,
  ALTER COLUMN unit DROP DEFAULT,
  ALTER COLUMN unit DROP NOT NULL;

ALTER TABLE products
  ADD CONSTRAINT products_default_price_nonnegative_check
  CHECK (default_price IS NULL OR default_price >= 0);

ALTER TABLE job_card_delivery_items
  ALTER COLUMN unit DROP NOT NULL;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_subject_type_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;
```

Recreate both audit checks with every existing value from migration 004 plus `PRODUCT` and the four Product events. Do not omit any prior User, Staff Profile, Customer, or Contact value.

- [ ] **Step 4: Add a live migration integration test**

In `product-schema.test.ts`, guard a PostgreSQL test with `TEST_DATABASE_URL`. Run migrations 001–005, insert two same-organization Products with the same SKU, insert a name-only Product, reject a negative `default_price`, and verify existing delivery rows survive with their original snapshot values.

- [ ] **Step 5: Verify GREEN**

Run: `cd server && npm test -- --run tests/product-schema.test.ts tests/delivery-schema.test.ts tests/crm-schema.test.ts tests/people-schema.test.ts`  
Expected: all file-contract tests pass; live test skips cleanly without `TEST_DATABASE_URL`.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations/005_product_catalog.sql server/tests/product-schema.test.ts
git commit -m "feat: add Product catalog schema"
```

### Task 2: Product types and PostgreSQL repository

**Files:**
- Create: `server/src/modules/products/types.ts`
- Create: `server/src/modules/products/repository.ts`
- Create: `server/tests/product-repository.test.ts`

**Interfaces:**

```ts
export type Product = {
  id: string; organizationId: string; name: string; sku: string | null;
  brand: string | null; category: string | null; model: string | null;
  unit: string | null; referencePrice: number | null; isActive: boolean;
  version: number; createdAt: Date; updatedAt: Date;
};

export type ProductFilters = {
  q: string | null; status: 'active' | 'inactive' | 'all';
  limit: number; offset: number;
};

export interface ProductTransaction {
  lockProduct(organizationId: string, productId: string): Promise<Product | null>;
  createProduct(input: CreateProductRecord): Promise<Product>;
  updateProduct(input: UpdateProductRecord): Promise<Product | null>;
  setProductActive(input: SetProductActiveRecord): Promise<Product | null>;
  appendAudit(input: AppendProductAuditInput): Promise<void>;
}

export interface ProductRepository {
  listProducts(organizationId: string, filters: ProductFilters): Promise<Paginated<Product>>;
  getProduct(organizationId: string, productId: string): Promise<Product | null>;
  execute<T>(work: (tx: ProductTransaction) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 1: Write failing repository tests**

Cover row mapping, nullable SKU/unit/price, case-insensitive escaped search over name/SKU/brand/category/model, `active|inactive|all`, deterministic `name,id` ordering, total independent of pagination, organization scoping, `limit/offset`, versioned update/lifecycle SQL, transaction commit, and rollback.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && npm test -- --run tests/product-repository.test.ts`  
Expected: FAIL because Product types/repository do not exist.

- [ ] **Step 3: Implement types and mapping**

Map PostgreSQL `default_price` to API `referencePrice` and numeric strings safely:

```ts
export function mapProduct(row: ProductRow): Product {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    sku: row.sku, brand: row.brand, category: row.category, model: row.model,
    unit: row.unit, referencePrice: row.default_price === null ? null : Number(row.default_price),
    isActive: row.is_active, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Implement bounded list/detail and atomic writes**

Use positional parameters. Build search as one escaped value with `ILIKE ... ESCAPE '\\'` across the five approved columns. Use `COUNT(*) OVER()` or a matching count query so `{ total }` describes the full filtered result. Every update uses both organization and expected version:

```sql
UPDATE products
SET name=$4, sku=$5, brand=$6, category=$7, model=$8, unit=$9,
    default_price=$10, version=version+1, updated_at=NOW()
WHERE organization_id=$1 AND id=$2 AND version=$3
RETURNING id, organization_id, name, sku, brand, category, model, unit,
          default_price, is_active, version, created_at, updated_at;
```

- [ ] **Step 5: Verify focused tests and build**

Run: `cd server && npm test -- --run tests/product-repository.test.ts && npm run build`  
Expected: repository tests and TypeScript build pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/products/types.ts server/src/modules/products/repository.ts server/tests/product-repository.test.ts
git commit -m "feat: add Product repository"
```

### Task 3: Product service policy, normalization, concurrency, and audit

**Files:**
- Create: `server/src/modules/products/service.ts`
- Create: `server/tests/product-service.test.ts`
- Create: `server/tests/product-concurrency.test.ts`

**Inputs:**

```ts
export type CreateProductInput = {
  name: string; sku?: string | null; brand?: string | null; category?: string | null;
  model?: string | null; unit?: string | null; referencePrice?: number | null;
};
export type UpdateProductInput = {
  expectedVersion: number; name?: string; sku?: string | null; brand?: string | null;
  category?: string | null; model?: string | null; unit?: string | null;
  referencePrice?: number | null;
};
```

- [ ] **Step 1: Write failing service policy tests**

Cover:

- Staff list/detail succeeds; Staff create/update/activate/deactivate returns `403 FORBIDDEN`.
- Name is trimmed and required.
- Optional text trims to null; SKU case and punctuation remain unchanged.
- Reference price accepts null/zero/positive and rejects negative/non-finite values.
- Create writes active version 1 and exactly one `PRODUCT_CREATED` audit.
- Patch requires at least one mutable field, changes only supplied fields, and does not clear omitted fields.
- No-op patch returns the current Product without version increment or audit.
- Changed patch writes only approved fields, increments once, and audits only `changedFields`.
- Missing/cross-organization Product returns `404 PRODUCT_NOT_FOUND`.
- Stale patch/lifecycle returns `409 VERSION_CONFLICT` with safe `currentVersion` and no write/audit.
- Repeated lifecycle command returns `409 INVALID_PRODUCT_STATUS_TRANSITION`.
- Repository failure rolls back Product and audit together.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && npm test -- --run tests/product-service.test.ts`  
Expected: FAIL because `ProductService` does not exist.

- [ ] **Step 3: Implement normalization and writer policy**

```ts
function requireWriter(actor: ProductActor) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

function optionalText(value: string | null) {
  return value?.trim() || null;
}

function normalizeCreate(input: CreateProductInput): ProductFields {
  const name = input.name.trim();
  if (!name) throw validation('name alanı zorunludur.');
  const referencePrice = input.referencePrice ?? null;
  if (referencePrice !== null &&
      (!Number.isFinite(referencePrice) || referencePrice < 0)) {
    throw validation('referencePrice sıfır veya pozitif olmalıdır.');
  }
  return { name, sku: optionalText(input.sku ?? null), brand: optionalText(input.brand ?? null),
    category: optionalText(input.category ?? null), model: optionalText(input.model ?? null),
    unit: optionalText(input.unit ?? null), referencePrice };
}
```

For patch, normalize only keys present in the request, merge them with the locked current
Product, and calculate `changedFields` from supplied keys only. Reject a body containing
only `expectedVersion`.

- [ ] **Step 4: Implement transaction-owned audit and lifecycle**

Use exactly these events: `PRODUCT_CREATED`, `PRODUCT_FIELDS_UPDATED`, `PRODUCT_ACTIVATED`, `PRODUCT_DEACTIVATED`. For field updates, metadata is `{ changedFields }`; do not persist field values. Lifecycle audit may store only `{ isActive: boolean }` old/new values.

- [ ] **Step 5: Add the two-client PostgreSQL concurrency test**

With `TEST_DATABASE_URL`, create one Product, open two clients with the same version, commit one patch, assert the second returns no row/`VERSION_CONFLICT`, and verify exactly one version increment and one update audit event.

- [ ] **Step 6: Verify GREEN**

Run: `cd server && npm test -- --run tests/product-service.test.ts tests/product-concurrency.test.ts`  
Expected: unit tests pass; PostgreSQL race skips cleanly without `TEST_DATABASE_URL`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/products/service.ts server/tests/product-service.test.ts server/tests/product-concurrency.test.ts
git commit -m "feat: add Product catalog policy"
```

### Task 4: Product HTTP routes and composition root

**Files:**
- Create: `server/src/modules/products/handlers.ts`
- Create: `server/src/modules/products/routes.ts`
- Create: `server/tests/product-routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/app.test.ts`

**Route surface:**

```text
GET   /api/products
POST  /api/products
GET   /api/products/:productId
PATCH /api/products/:productId
POST  /api/products/:productId/activate
POST  /api/products/:productId/deactivate
```

- [ ] **Step 1: Write failing route acceptance tests**

Assert authentication/password-change guards, exact route surface, 201 create, actor propagation, list defaults, `q/status/limit/offset`, unknown query rejection, `limit` 1–200, non-negative offset, exact create/patch allowlists, positive integer versions, lifecycle body allowlist, Staff reads, Staff mutation 403, and safe 404/409 serialization.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && npm test -- --run tests/product-routes.test.ts tests/app.test.ts`  
Expected: FAIL because Product routes and dependency are not registered.

- [ ] **Step 3: Implement exact handlers**

Create fields:

```ts
const CREATE_FIELDS = ['name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice'] as const;
const PATCH_FIELDS = ['expectedVersion', ...CREATE_FIELDS] as const;
const LIST_FIELDS = ['q', 'status', 'limit', 'offset'] as const;
```

Reject `isActive`, `version`, `organizationId`, `stockQuantity`, `cost`, `currency`, tracking flags, and every other unknown key through the generic exact-field check. Create must not accept `expectedVersion`.
Create requires `name` and permits every optional field to be omitted. Patch requires
`expectedVersion` plus at least one supplied mutable field; it must not treat omitted fields
as null.

- [ ] **Step 4: Register Product dependencies**

Add optional `productRepository?: ProductRepository` to `AppDependencies`, construct `ProductService`, register `productRoutes` under `/api`, and instantiate `PostgresProductRepository(database.pool)` in `index.ts`. Keep the same `authenticateDomain` guard used by People/CRM/JobCard.

- [ ] **Step 5: Verify Product routes and regressions**

Run: `cd server && npm test -- --run tests/product-routes.test.ts tests/app.test.ts tests/crm-routes.test.ts tests/job-card-routes.test.ts && npm run build`  
Expected: focused route tests, neighboring route tests, and build pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/products/handlers.ts server/src/modules/products/routes.ts server/tests/product-routes.test.ts server/src/app.ts server/src/index.ts server/tests/app.test.ts
git commit -m "feat: expose Product catalog API"
```

---

## Checkpoint 06B — Delivery Snapshot Integration

### Task 5: Nullable Product references and immutable delivery snapshots

**Files:**
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/tests/delivery-item-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`
- Modify: `server/tests/reference-service.test.ts`

**Contract changes:**

```ts
export type ProductReference = {
  id: string; organizationId: string; name: string; sku: string | null;
  model: string | null; unit: string | null; isActive: boolean;
};

export type DeliveryItemRecord = DeliveryItem & {
  id: string; organizationId: string; jobCardId: string; unit: string | null;
  productNameSnapshot: string; productSkuSnapshot: string | null;
  productModelSnapshot: string | null;
};
```

- [ ] **Step 1: Add failing delivery behavior tests**

Cover name-only active Product add with null SKU/model/unit; correct snapshot creation; inactive Product add rejection; inactive Product replacement rejection; existing inactive Product quantity/purpose/date/note edit success without Product lookup; unchanged product ID preserving every snapshot even if catalog fields changed; active replacement refreshing all snapshots; and null-unit route serialization.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && npm test -- --run tests/delivery-item-service.test.ts tests/job-card-routes.test.ts`  
Expected: FAIL because current delivery types fabricate non-null unit/SKU behavior.

- [ ] **Step 3: Correct the transaction-local Product and snapshot logic**

When `productId` is absent or equals `current.productId`, build the update record from the current delivery snapshots and do not call `getProduct`. When the Product changes, read it inside the active JobCard transaction, require `isActive`, and snapshot its current nullable fields. Never use `current.productSkuSnapshot ?? ''`.

- [ ] **Step 4: Keep submission semantics stable**

Do not newly reject submission only because a Product later became inactive; the historical delivery remains a valid record. Keep existing structural requirements: Product ID, positive quantity, purpose, delivered date, and note rules. Update tests if the current `productActive` submission join contradicts this approved history-preservation rule.

- [ ] **Step 5: Verify focused and regression tests**

Run: `cd server && npm test -- --run tests/delivery-item-service.test.ts tests/job-card-service.test.ts tests/job-card-lifecycle-service.test.ts tests/job-card-routes.test.ts tests/reference-service.test.ts && npm run build`  
Expected: delivery and lifecycle tests pass with nullable snapshots.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/job-cards server/tests/delivery-item-service.test.ts server/tests/job-card-routes.test.ts server/tests/reference-service.test.ts
git commit -m "fix: preserve informational Product snapshots"
```

---

## Checkpoint 06C — Canonical Web Client and Product UI

### Task 6: Runtime-validated Product web client

**Files:**
- Create: `web/src/services/products-api.ts`
- Create: `web/tests/products-client.test.ts`

**Public client types:**

```ts
export type Product = {
  id: string; organizationId: string; name: string; sku: string | null;
  brand: string | null; category: string | null; model: string | null;
  unit: string | null; referencePrice: number | null; isActive: boolean;
  version: number; createdAt: string; updatedAt: string;
};
export type ProductFilters = {
  q?: string; status?: 'active' | 'inactive' | 'all'; limit?: number; offset?: number;
};
```

- [ ] **Step 1: Write failing client tests**

Test encoded queries, empty omission, default credential inclusion, paginated parsing, nullable fields, create without `expectedVersion`, exact patch body, lifecycle commands, encoded IDs, malformed response rejection, safe `VERSION_CONFLICT` details, and no mutation retry.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && npm test -- --run tests/products-client.test.ts`  
Expected: FAIL because `products-api.ts` does not exist.

- [ ] **Step 3: Implement the client using existing shared request parsers**

Export `listProducts`, `getProduct`, `createProduct`, `updateProduct`, `activateProduct`, and `deactivateProduct`. Reuse `request`, `json`, `object`, `string`, `nullableString`, `number`, and `boolean` from `services/api.ts`; do not duplicate cookie/error handling.

- [ ] **Step 4: Verify GREEN and build**

Run: `cd web && npm test -- --run tests/products-client.test.ts tests/crm-client.test.ts && npm run build`  
Expected: Product/CRM clients and build pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/products-api.ts web/tests/products-client.test.ts
git commit -m "feat: add Product catalog client"
```

### Task 7: Routed Product list and create flow

**Files:**
- Create: `web/src/ProductList.tsx`
- Create: `web/src/ProductForm.tsx`
- Create: `web/tests/product-list.test.tsx`
- Create: `web/tests/product-form.test.tsx`
- Modify: `web/src/paths.ts`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/tests/router.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/accessibility-contract.test.ts`

- [ ] **Step 1: Write failing routed UI tests**

Test `/products`, `/products/new`, “Ürünler” navigation, URL-preserved `q/status/offset`, loading, empty, no-results, error/retry, forbidden handling, mobile card/row semantics, Staff read-only list, Admin/Manager new Product control, and create success navigation to `/products/:id`.

- [ ] **Step 2: Write failing accessible form tests**

Assert only name is marked required; optional labels are visible; reference-price helper explicitly says informational/not sale/accounting/stock valuation; empty optional text becomes null; negative price gives associated field error; server validation focuses an error summary/first invalid field; pending controls disable; and success is not announced before the request resolves.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/product-list.test.tsx tests/product-form.test.tsx tests/router.test.tsx`  
Expected: FAIL because Product routes/screens do not exist.

- [ ] **Step 4: Add stable paths and role-aware routes**

```ts
products: '/products',
newProduct: '/products/new',
product: (id: string) => `/products/${encodeURIComponent(id)}`,
```

Register static `/products/new` before dynamic `/products/:productId`. Staff receives `ForbiddenView` for create but sees list/detail. Add “Ürünler” for all roles.

- [ ] **Step 5: Implement list URL state and create form**

Use semantic `<main>`, `<form role="search">`, `<ul>`, `<article>`, labeled controls, `aria-live` feedback, existing button classes, and URL search parameters. Reset offset to zero when search/status changes. Use explicit Previous/Next controls based on `{ total, limit, offset }`.

- [ ] **Step 6: Add responsive styles and accessibility contracts**

Use existing design tokens. Ensure controls have approximately 44×44 CSS px targets, visible focus, reflow without page-level horizontal scrolling, no color-only status, and reduced-motion compliance.

- [ ] **Step 7: Verify GREEN**

Run: `cd web && npm test -- --run tests/product-list.test.tsx tests/product-form.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts && npm run build`  
Expected: Product list/create/router/accessibility tests and build pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/ProductList.tsx web/src/ProductForm.tsx web/tests/product-list.test.tsx web/tests/product-form.test.tsx web/src/paths.ts web/src/AppRouter.tsx web/tests/router.test.tsx web/src/styles.css web/tests/accessibility-contract.test.ts
git commit -m "feat: add Product list and creation UI"
```

### Task 8: Product detail, edit, lifecycle, and conflict recovery

**Files:**
- Create: `web/src/ProductDetail.tsx`
- Create: `web/tests/product-detail.test.tsx`
- Modify: `web/src/ProductForm.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing detail and edit tests**

Cover loading/not-found/forbidden/error/retry; every nullable value rendered as absent rather than fabricated; Staff no mutation controls; Manager/Admin edit; exact `expectedVersion`; successful version refresh; dirty form persistence after conflict; explicit “current values reload” action; lifecycle status feedback; and failed lifecycle preserving/refetching backend truth.

- [ ] **Step 2: Write failing deactivation dialog tests**

Assert the dialog names the Product, explains new selection is blocked while history remains unchanged, uses a non-destructive initial focus, traps/restores focus correctly, closes on Escape, and requires the explicit deactivate action. Activation has no confirmation but announces its result.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/product-detail.test.tsx tests/product-form.test.tsx`  
Expected: FAIL because Product detail/lifecycle UI does not exist.

- [ ] **Step 4: Implement read/edit modes and conflict recovery**

On `VERSION_CONFLICT`, retain the local form state, show the safe message/current version, and offer a button that calls `getProduct` and explicitly replaces the form only after the user chooses reload. Do not auto-merge or auto-retry.

- [ ] **Step 5: Implement accessible lifecycle actions**

Use native `<dialog>` only if the existing test/runtime support is reliable; otherwise use the project’s explicit dialog pattern with `role="dialog"`, `aria-modal="true"`, labeled title/description, documented focus capture, Escape handling, and trigger focus restoration. No dependency is added.

- [ ] **Step 6: Verify GREEN**

Run: `cd web && npm test -- --run tests/product-detail.test.tsx tests/product-form.test.tsx tests/router.test.tsx && npm run build`  
Expected: detail/edit/lifecycle/conflict tests and build pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/ProductDetail.tsx web/tests/product-detail.test.tsx web/src/ProductForm.tsx web/src/AppRouter.tsx web/src/styles.css
git commit -m "feat: add Product detail lifecycle UI"
```

### Task 9: Searchable delivery selector and legacy Product reference removal

**Files:**
- Create: `web/src/ProductSelect.tsx`
- Create: `web/tests/product-select.test.tsx`
- Modify: `web/src/DeliveryCreate.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/services/api.ts`
- Modify: `web/src/JobDetail.tsx`
- Modify: `web/tests/delivery-create.test.tsx`
- Modify: `web/tests/delivery-create-screen.test.tsx`
- Modify: `web/tests/job-detail.test.tsx`
- Modify: `web/tests/tracer-client.test.ts`
- Modify: `web/tests/App.test.tsx`
- Modify: `server/src/modules/job-cards/reference-routes.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/tests/reference-routes.test.ts`
- Modify: `server/tests/reference-service.test.ts`

- [ ] **Step 1: Write failing Product selector tests**

Cover active-only `listProducts` calls, debounced or explicitly submitted accessible search, pagination beyond 200 records, loading, empty, no-results, error/retry, selected Product persistence, nullable SKU/model/unit display, keyboard selection, and stale response suppression. Use existing request-gate utilities where applicable; do not add a library.

- [ ] **Step 2: Update failing delivery screen/client tests**

Remove the `products` prop and legacy `ReferenceProduct` assumptions. Assert delivery create loads Product choices on demand from `/api/products?status=active`, submits the selected ID, and displays quantity alone when unit is null. Assert Job detail follows the same quantity rule.

- [ ] **Step 3: Run and verify RED**

Run: `cd web && npm test -- --run tests/product-select.test.tsx tests/delivery-create.test.tsx tests/delivery-create-screen.test.tsx tests/job-detail.test.tsx tests/tracer-client.test.ts tests/App.test.tsx`  
Expected: FAIL until the delivery flow uses the canonical Product client.

- [ ] **Step 4: Implement ProductSelect and remove global Product preload**

Keep Customer reference loading in `App.tsx`, but remove `listReferenceProducts`, `ReferenceProduct`, and `products` state/props. `DeliveryCreateView` owns Product selection through `ProductSelect` and receives the selected canonical Product. Use the unit only for display; the mutation remains Product ID plus delivery fields.

- [ ] **Step 5: Remove the legacy Product reference HTTP path**

Delete only `GET /products` from `referenceRoutes`, `JobCardService.listReferenceProducts`, `JobCardRepository.listReferenceProducts`, and their tests/types. Preserve `GET /api/reference/customers` unchanged. Add a route test that `/api/reference/products` is now 404 and `/api/products` remains the only Product catalog route.

- [ ] **Step 6: Verify both applications**

Run: `cd web && npm test -- --run tests/product-select.test.tsx tests/delivery-create.test.tsx tests/delivery-create-screen.test.tsx tests/job-detail.test.tsx tests/tracer-client.test.ts tests/App.test.tsx && npm run build`  
Run: `cd server && npm test -- --run tests/reference-routes.test.ts tests/reference-service.test.ts tests/product-routes.test.ts tests/delivery-item-service.test.ts && npm run build`  
Expected: canonical Product selector and reference-removal regressions pass in both applications.

- [ ] **Step 7: Commit**

```bash
git add web/src/ProductSelect.tsx web/tests/product-select.test.tsx web/src/DeliveryCreate.tsx web/src/App.tsx web/src/services/api.ts web/src/JobDetail.tsx web/tests server/src/modules/job-cards server/tests/reference-routes.test.ts server/tests/reference-service.test.ts
git commit -m "feat: use canonical Product catalog in deliveries"
```

---

## Checkpoint 06D — Live Verification and Closeout

### Task 10: Seed compatibility and disposable PostgreSQL tracer

**Files:**
- Modify if required: `server/src/modules/auth/setup.ts`
- Modify if required: `server/tests/auth-setup.test.ts`
- Modify if required: `server/tests/auth-setup-postgres.test.ts`
- Update: `docs/superpowers/plans/2026-07-13-product-catalog.md` with exact results

- [x] **Step 1: Add/adjust seed assertions before implementation changes**

Keep the representative demo Product populated (`DEMO-001`, name, `adet`) because populated optional data is useful. Assert migration 005 gives it version 1 and does not make optional fields mandatory for later Product creation. Do not add stock or accounting seed values.

- [x] **Step 2: Run seed tests**

Run: `cd server && npm test -- --run tests/auth-setup.test.ts tests/auth-setup-postgres.test.ts`  
Expected: unit tests pass; PostgreSQL test skips without `TEST_DATABASE_URL`.

- [x] **Step 3: Create a disposable PostgreSQL database and run migrations/seed**

```bash
createdb servora_med_slice06_closeout
cd server
DATABASE_URL=postgresql://emrah@localhost/servora_med_slice06_closeout NODE_ENV=development npx tsx src/db/migrate.ts
TEST_DATABASE_URL=postgresql://emrah@localhost/servora_med_slice06_closeout npm test -- --run tests/product-schema.test.ts tests/product-concurrency.test.ts tests/auth-setup-postgres.test.ts
DATABASE_URL=postgresql://emrah@localhost/servora_med_slice06_closeout NODE_ENV=development DEV_SEED_PASSWORD='<ephemeral>' npx tsx src/db/seed-dev.ts
```

Use a newly generated ephemeral password and never place it in the plan, shell history excerpts, commits, logs, or memory.

- [x] **Step 4: Run the authenticated live tracer**

Start the server on an unused local port. Verify through HTTP and direct safe SQL assertions:

1. Manager login and mandatory password change.
2. Create a name-only Product and verify null SKU/unit/reference price, active status, and version 1.
3. Create two Products with the same SKU and verify both succeed unchanged.
4. Search across name/SKU/brand/category/model and verify pagination total.
5. Staff login/read succeeds and Staff mutation returns 403.
6. Manager patch increments version and stale patch returns 409 with no audit.
7. Deactivate blocks new delivery selection/replacement.
8. Existing delivery quantity/note edit still succeeds and historical snapshots remain unchanged.
9. Reactivate succeeds; repeated activate returns the canonical 409.
10. Product audit count/events match successful mutations exactly.

- [x] **Step 5: Stop processes and remove the database**

Stop the server, terminate remaining database sessions if needed, run `dropdb servora_med_slice06_closeout`, and confirm no matching disposable database remains.

- [x] **Step 6: Commit any necessary seed compatibility change**

```bash
git add server/src/modules/auth/setup.ts server/tests/auth-setup.test.ts server/tests/auth-setup-postgres.test.ts docs/superpowers/plans/2026-07-13-product-catalog.md
git commit -m "test: verify Product catalog on PostgreSQL"
```

If no source/test change was necessary, commit only the recorded verification result during Task 11.

**Task 10 verification (2026-07-13):** `auth-setup.test.ts` passed 6 tests while
the 2 PostgreSQL-gated seed tests skipped cleanly without `TEST_DATABASE_URL`.
Disposable local PostgreSQL database `servora_med_slice06_closeout` applied migrations
001–005 and the development seed. Against that database, `product-schema.test.ts`,
`product-concurrency.test.ts`, and `auth-setup-postgres.test.ts` passed 3 files/12 tests.
The expanded seed contract proved the populated demo Product remains
`DEMO-001 / Demo İmplant Seti / adet`, receives version 1, and coexists with a later
name-only Product whose SKU, brand, category, model, unit, and reference price are null.

The authenticated HTTP/SQL tracer completed mandatory password changes for Manager and
Staff, created one name-only Product, accepted two Products with the identical unchanged
SKU, searched independently across name/SKU/brand/category/model, and verified a
four-record result across two pages. Staff reads succeeded and Staff mutation returned
403. A Manager patch incremented the Product version; its stale retry returned 409 and
created no audit event. Deactivation blocked both a new delivery item and replacement of
an existing item's Product. Quantity/note editing of the historical delivery still
succeeded while its name/SKU/unit snapshots remained unchanged. Reactivation succeeded,
repeated activation returned the canonical 409, and the four Product creates plus one
field update, deactivation, and activation produced exactly seven Product audit events.
The temporary server stopped, the ephemeral credential file was removed, the database
was dropped, and a catalog query confirmed zero matching databases remained.

### Task 11: Full suites, Playwright acceptance, SSOT, and memory closeout

**Files:**
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `DECISIONS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-13-product-catalog.md`

- [ ] **Step 1: Run the full automated gate**

```bash
cd server && npm test -- --run
cd server && npm run build
cd server && npm audit --audit-level=high
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --audit-level=high
```

Expected: every suite/build passes and both high-severity audits report zero actionable vulnerabilities. Record exact file/test totals and any intentional PostgreSQL skips.

- [ ] **Step 2: Run Playwright MCP acceptance against a fresh disposable database**

Verify Manager create/search/edit/deactivate/activate/conflict recovery, Staff read-only Product list/detail, and Staff Product Delivery search/select/create. Exercise at 1200×800 desktop, 390×844 mobile, and 320 CSS px effective reflow. Confirm Back/Forward/refresh/direct URLs preserve Product list/detail state.

- [ ] **Step 3: Perform manual accessibility acceptance**

Verify keyboard-only operation, logical tab order, visible focus, dialog focus containment/restoration, Escape close, approximately 44×44 targets, visible labels, associated validation, live feedback, color-independent status, 200% text enlargement, effective 400% reflow, reduced motion, semantic headings/landmarks/lists/forms, and no horizontal page overflow. Remove generated browser artifacts after inspection.

- [ ] **Step 4: Update SSOT documents with verified truth only**

Document migration 005, nullable Product fields, informational `referencePrice`, duplicate SKU allowance, Product API/list contract, role/lifecycle/version/audit rules, canonical delivery selector, legacy reference removal, exact verification results, and Slice 06 completion. Do not claim inventory/accounting behavior.

- [ ] **Step 5: Refresh persistent and codebase memory**

Reindex both `server` and `web` projects with persistence enabled. Store only stable Slice 06 architecture/product decisions and verified completion state in persistent memory. Do not store disposable credentials, temporary ports, or test logs.

- [ ] **Step 6: Review the final diff and scan for scope violations**

```bash
git diff --check
git status --short
rg -n "stock|warehouse|barcode|cost|currency|price history|lotTracking|serialTracking|expiryTracking|/api/reference/products" server/src web/src SERVORA_MED_*.md PRODUCT_REQUIREMENTS.md DECISIONS.md README.md
```

Every match must either be an explicit non-goal/legacy schema explanation or be removed. Confirm there are no placeholders (`TODO`, `TBD`, `FIXME`) introduced by this slice.

- [ ] **Step 7: Commit closeout**

```bash
git add SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md DECISIONS.md README.md docs/superpowers/plans/2026-07-13-product-catalog.md
git commit -m "docs: close Product catalog slice"
```

---

## Coverage Matrix

| Approved requirement | Implementation task |
| --- | --- |
| Informational Product scope and nullable optional fields | Tasks 1–3, 7–8 |
| Duplicate, casing-preserving SKU | Tasks 1–3, 10 |
| Null/non-negative reference price with no financial behavior | Tasks 1–3, 7, 10 |
| Organization and role boundaries | Tasks 2–4, 7–8, 10 |
| Exact canonical HTTP contract and pagination | Tasks 4, 6–7 |
| Version conflicts and lifecycle state machine | Tasks 2–4, 8, 10 |
| Transactional safe Product audit events | Tasks 1–3, 10 |
| Inactive Product selection rules and immutable snapshots | Tasks 5, 9–10 |
| Searchable delivery selection beyond fixed 200 rows | Task 9 |
| Removal of `/api/reference/products` | Task 9 |
| Responsive accessible Product UI | Tasks 7–9, 11 |
| PostgreSQL, browser, SSOT, and memory closeout | Tasks 10–11 |

## Definition of Done

- [ ] All eleven tasks and four checkpoints are complete.
- [ ] Migration 005 applies after migrations 001–004 without editing history.
- [ ] Product catalog remains informational and contains no stock/accounting/ERP behavior.
- [ ] Server and web full tests/builds/audits pass.
- [ ] Live PostgreSQL and Playwright acceptance results are recorded.
- [ ] SSOT documents, persistent memory, and codebase memory reflect verified implementation.
- [ ] Worktree is clean and the branch contains only intentional Slice 06 commits.

Do not begin Slice 07, JobCard notes, Staff confidential notes, related follow-up cards, Kanban expansion, warehouse, or accounting work before this plan closes.
