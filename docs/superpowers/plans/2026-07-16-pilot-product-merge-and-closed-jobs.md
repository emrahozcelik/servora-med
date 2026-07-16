# Pilot Product Merge and Closed Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import only the 33 new pilot products with atomic audit history and add a context-preserving `Biten işler` quick view for canonical closed JobCards.

**Architecture:** A pure parser/planner validates the tracked JSON and calculates exact matches versus inserts. A PostgreSQL adapter performs the plan under one organization-scoped advisory lock and transaction, while the CLI defaults to dry-run and requires `--apply` for mutation. The web uses the existing `closed` filter and a dedicated query helper that changes only status.

**Tech Stack:** TypeScript, PostgreSQL, Fastify repository conventions, React 19, React Router, Vitest, Vite, Node CLI.

## Global Constraints

- Existing 48 exact products are not updated, reactivated, or version-bumped.
- SKU-bearing products match by organization + exact SKU; SKU-null products match by organization + exact name with null SKU.
- Ambiguous matches, invalid source data, or audit failures abort the complete transaction.
- Every insert appends `PRODUCT_CREATED` with an explicit active Admin/Manager actor.
- Dry-run is the default; `--apply` is mandatory for writes.
- Repeat execution must insert zero duplicates.
- `Biten işler` maps to existing `status=closed`, meaning `COMPLETED` plus `CANCELLED`.
- The closed destination changes only `status`; it does not intentionally replace `view`, `offset`, or other valid filters.
- Do not add a migration, uniqueness constraint, dependency, JobCard status, endpoint, or Kanban terminal column.

## File Structure

- Track: `pilot-products.example.json`: reviewed version-1 import input.
- Create: `server/src/modules/products/pilot-import.ts`: parser, validation, matching, and import orchestration.
- Create: `server/src/db/import-pilot-products.ts`: explicit dry-run/apply CLI.
- Modify: `server/src/modules/products/service.ts`: export canonical create-field normalizer.
- Modify: `server/package.json`: `products:import:pilot` command.
- Create: `server/tests/pilot-product-import.test.ts`: pure parser/planner TDD.
- Create: `server/tests/pilot-product-import-postgres.test.ts`: atomic/repeat/rollback PostgreSQL proof.
- Modify: `web/src/jobs/job-search.ts`: status-only quick-view destination helper.
- Modify: `web/src/jobs/JobWorkspace.tsx`: `Biten işler` link.
- Modify: `web/tests/job-search.test.ts` and `web/tests/job-list.test.tsx`: URL and rendering contract.
- Modify durable operations/user documentation with the exact command and result.

---

### Task 1: Parse and plan the pilot catalog

**Files:**
- Create: `server/tests/pilot-product-import.test.ts`
- Create: `server/src/modules/products/pilot-import.ts`
- Modify: `server/src/modules/products/service.ts`

**Interfaces:**
- Produces: `parsePilotProductDocument(value)`, `planPilotProductMerge(source, existing)`, and exported `normalizeProductCreateInput(input)`.

- [ ] **Step 1: Write failing parser/planner tests**

Test the real JSON summary (`81` valid products and `39` unique non-null SKUs), exact SKU and
null-SKU/name matching, 48 matches/33 inserts against a fixture snapshot, invalid category,
duplicate source SKU, over-limit fields, unsupported document version, and ambiguous database
matches. Expected failures use `PILOT_PRODUCT_IMPORT_INVALID` with a safe specific message.

- [ ] **Step 2: Run and confirm RED**

Run: `cd server && npm test -- --run tests/pilot-product-import.test.ts`

Expected: module import fails because `pilot-import.ts` does not exist.

- [ ] **Step 3: Implement canonical parsing and planning**

Export the existing Product create normalizer as `normalizeProductCreateInput`. Parse exact
top-level/document/product keys, require version `1`, normalize all Product fields through that
function, validate `isActive` as true/default true, and require category membership. Build a
deterministic insert/match plan without database writes. Reject duplicate source keys and
multiple existing matches.

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd server && npm test -- --run tests/pilot-product-import.test.ts tests/product-service.test.ts`

Expected: all parser/planner and existing Product service tests pass.

- [ ] **Step 5: Commit**

```bash
git add pilot-products.example.json server/src/modules/products/pilot-import.ts \
  server/src/modules/products/service.ts server/tests/pilot-product-import.test.ts
git commit -m "feat: plan idempotent pilot product imports"
```

---

### Task 2: Add atomic PostgreSQL import and dry-run CLI

**Files:**
- Modify: `server/src/modules/products/pilot-import.ts`
- Create: `server/src/db/import-pilot-products.ts`
- Create: `server/tests/pilot-product-import-postgres.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Produces: `importPilotProducts(pool, { organizationId, actorUserId, document, apply })` returning `{ sourceCount, matchedCount, insertedCount, dryRun }`.

- [ ] **Step 1: Write failing PostgreSQL acceptance**

Against an isolated migrated schema, insert one organization, one active Admin actor, and a
small existing catalog. Assert dry-run writes nothing; apply inserts only planned Products and
one `PRODUCT_CREATED` audit each; repeat apply inserts zero; an injected audit constraint failure
rolls back every Product; inactive/cross-organization/non-management actors are rejected.

- [ ] **Step 2: Run with disposable PostgreSQL and confirm RED**

Run: `TEST_DATABASE_URL=postgresql:///servora_med_pilot_import_test npm test -- --run tests/pilot-product-import-postgres.test.ts`

Expected: import function/CLI behavior is missing.

- [ ] **Step 3: Implement one-lock, one-transaction apply**

Connect one Pool client, `BEGIN`, acquire `pg_advisory_xact_lock(hashtextextended(...))`, verify
the organization and active Admin/Manager actor, select organization Products under lock, plan,
and when `apply` insert each planned Product plus its audit event. Commit only after all inserts
and audits. Roll back on any error. Dry-run performs validation/planning and rolls back/no writes.

The CLI requires `--file`, `--organization-id`, and `--actor-user-id`; accepts optional `--apply`;
prints only counts and mode; exits non-zero on validation/database failure; closes the pool.

- [ ] **Step 4: Run PostgreSQL tests and confirm GREEN**

Run: `TEST_DATABASE_URL=postgresql:///servora_med_pilot_import_test npm test -- --run tests/pilot-product-import-postgres.test.ts`

Expected: dry-run, insert/audit, repeat, actor, and rollback tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/pilot-import.ts server/src/db/import-pilot-products.ts \
  server/tests/pilot-product-import-postgres.test.ts server/package.json
git commit -m "feat: import pilot products atomically"
```

---

### Task 3: Add the context-preserving closed quick view

**Files:**
- Modify: `web/tests/job-search.test.ts`
- Modify: `web/tests/job-list.test.tsx`
- Modify: `web/src/jobs/job-search.ts`
- Modify: `web/src/jobs/JobWorkspace.tsx`

**Interfaces:**
- Produces: `selectQuickStatusPreservingContext(current, status)` and `Biten işler` using `closed`.

- [ ] **Step 1: Write failing URL and rendering tests**

Assert:

```ts
selectQuickStatusPreservingContext(
  new URLSearchParams('status=active&view=list&offset=50&q=klinik&priority=high'),
  'closed',
).toString() === 'q=klinik&status=closed&priority=high&offset=50'
```

Render the workspace and assert quick-view order, Manager/Admin-only approval link, universal
`Biten işler`, exact closed href with preserved valid context, and `aria-current="page"` only
for closed status. Assert the load call receives `status: 'closed'`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd web && npm test -- --run tests/job-search.test.ts tests/job-list.test.tsx`

Expected: helper and `Biten işler` link are absent.

- [ ] **Step 3: Implement the smallest navigation change**

Create a helper from canonical current params that changes only `status`, retaining valid
`view`, `offset`, and other filters. Use it only for the new closed quick view; do not alter
existing quick-view behavior or Job list loading. Render the new link after
`Düzeltme istenenler` with canonical active styling.

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd web && npm test -- --run tests/job-search.test.ts tests/job-list.test.tsx`

Expected: all URL, link, role, active-state, and list-loading tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/jobs/job-search.ts web/src/jobs/JobWorkspace.tsx \
  web/tests/job-search.test.ts web/tests/job-list.test.tsx
git commit -m "feat: add closed jobs quick view"
```

---

### Task 4: Verify and apply the local catalog merge

**Files:**
- Modify: `README.md`
- Modify: `docs/user-manual/servora-med-user-manual.md`
- Modify: `docs/superpowers/plans/2026-07-16-pilot-product-merge-and-closed-jobs.md`

- [ ] **Step 1: Run full verification before mutation**

```bash
cd server && npm run build && npm test -- --run && npm audit --audit-level=high
cd web && npm run build && npm test -- --run && npm audit --audit-level=high
git diff --check
```

- [ ] **Step 2: Run local dry-run and verify exact plan**

Use the local organization UUID and an active Admin UUID. Expected JSON/text counts:
`source=81 matched=48 inserted=33 dryRun=true`. Query Product/audit counts before apply.

- [ ] **Step 3: Apply once and verify database state**

Run the same command with `--apply`. Verify total Products increased from 48 to 81, all source
keys match exactly once, the run created 33 `PRODUCT_CREATED` audit rows, and no existing Product
version or fields changed.

- [ ] **Step 4: Prove idempotency after apply**

Run dry-run again. Expected: `source=81 matched=81 inserted=0 dryRun=true`.

- [ ] **Step 5: Update operational documentation and commit**

Document dry-run/apply commands, explicit IDs, matching rules, rollback/idempotency guarantees,
the applied local counts, and `Biten işler = COMPLETED + CANCELLED`.

```bash
git add README.md docs/user-manual/servora-med-user-manual.md \
  docs/superpowers/plans/2026-07-16-pilot-product-merge-and-closed-jobs.md
git commit -m "docs: record pilot catalog merge"
```

---

### Task 5: Push main and verify remote CI

- [ ] **Step 1: Confirm clean state and local/remote diff**

Run: `git status --short && git diff --check && git log --oneline origin/main..main`

- [ ] **Step 2: Push main**

Run: `git push origin main`

- [ ] **Step 3: Wait for the exact main CI run**

Run: `gh run watch <run-id> --interval 10 --exit-status`

Expected: server and web jobs pass. Do not stop or restart the local database; Vite/backend watch
processes continue serving current `main`.
