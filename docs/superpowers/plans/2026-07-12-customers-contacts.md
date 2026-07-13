# Customers and Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Slice 05 as a versioned, audited, organization-scoped CRM flow from Manager customer creation through nested primary Contacts, responsible Staff assignment, Staff read-only access, JobCard Contact association, and responsive routed UI.

**Architecture:** A new `crm` module owns the Customer aggregate, nested Contact lifecycle, search, bounded JobCard summaries, audit, and PostgreSQL locking. Existing People and JobCard modules integrate through narrow ports and a shared `users → customers → contacts → job_cards` lock order. React Router 7 replaces top-level screen state and provides stable list/detail URLs without changing backend-owned permissions.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Fastify 5, PostgreSQL 16+, React 19.2, React Router DOM 7.18.1, Vite 8, Vitest 4, Playwright MCP.

## Global Constraints

- Follow [the approved revised design](../specs/2026-07-12-customers-contacts-design.md) exactly.
- Use English identifiers, tests, commits, and acceptance criteria; use Turkish user-facing copy.
- Create migration `004_crm_contacts.sql`; never edit applied migrations `001_auth_foundation.sql`, `002_delivery_tracer.sql`, or `003_people.sql`.
- Customer and Contact mutations use integer `version` plus `expectedVersion`; do not use timestamp concurrency.
- Customer status changes only through named commands; Contact activity and primary state change only through named commands.
- Do not create Customer or Contact free-form notes, multiple Customer Staff assignments, fuzzy search, bulk operations, offline queues, realtime transport, or a UI framework.
- Add only `react-router-dom@7.18.1`; update `web/package-lock.json` and justify it as URL/navigation infrastructure.
- Staff can read organization CRM records but cannot mutate them; Customer JobCard summaries retain existing assigned-Staff visibility.
- Keep audit payloads free of copied phone, email, address, password, token, cookie, and session values.
- Use the lock order `users → customers → contacts → job_cards`, with stable UUID order for multiple rows of the same type.
- CRM `POST` requests are not automatically retried and do not use `processed_actions` in this slice.
- Every production behavior begins with a focused failing test and ends with focused plus regression verification.
- Execute implementation in a dedicated worktree created with `superpowers:using-git-worktrees`.

---

## File Map

### Server

- Create `server/src/db/migrations/004_crm_contacts.sql` — Customer extension, Contacts, JobCard Contact FK, CRM indexes, and expanded audit constraints.
- Create `server/src/modules/crm/types.ts` — Customer, Contact, filters, commands, summaries, and CRM audit types.
- Create `server/src/modules/crm/repository.ts` — PostgreSQL reads, locks, versioned writes, summaries, and transaction runner.
- Create `server/src/modules/crm/service.ts` — role policy, lifecycle state machines, normalization, invariants, and audit coordination.
- Create `server/src/modules/crm/handlers.ts` — exact body/query parsing and unknown-field rejection.
- Create `server/src/modules/crm/routes.ts` — nested Customer and Contact HTTP routes.
- Create `server/src/modules/crm/people-adapter.ts` — CRM implementation of the People-owned Customer assignment cleanup port.
- Create `server/src/modules/people/customer-assignment-port.ts` — narrow transaction-bound interface consumed by People.
- Modify `server/src/modules/people/repository.ts` — delegate assignment cleanup with the active `PoolClient`.
- Modify `server/src/modules/people/service.ts` — invoke cleanup during eligible Staff deactivation.
- Modify `server/src/modules/job-cards/types.ts` — expose nullable `contactId`.
- Modify `server/src/modules/job-cards/repository.ts` — lock Customer/Contact references and persist Contact.
- Modify `server/src/modules/job-cards/service.ts` — validate Customer/Contact eligibility in shared lock order.
- Modify `server/src/modules/job-cards/handlers.ts` — parse nullable `contactId` in create/patch.
- Modify `server/src/errors/index.ts` — safely expose optional structured conflict details.
- Modify `server/src/app.ts` — construct and register CRM plus cross-module adapters.
- Modify `server/src/index.ts` — construct production CRM, cleanup adapter, People, and JobCard dependencies over the shared database pool.
- Modify `server/src/modules/auth/setup.ts` — seed representative CRM references after migration 004.

### Web

- Modify `web/package.json` and `web/package-lock.json` — add `react-router-dom@7.18.1`.
- Create `web/src/AppRouter.tsx` — authenticated route tree, route guards, and stable route constants.
- Modify `web/src/main.tsx` — mount `BrowserRouter` once.
- Modify `web/src/App.tsx` — retain identity/session ownership while removing local screen navigation.
- Create `web/src/services/crm-api.ts` — runtime-validated CRM API client.
- Create `web/src/CustomerList.tsx` — searchable/filterable responsive list and creation flow.
- Create `web/src/CustomerDetail.tsx` — Customer detail, bounded JobCard summaries, edit/status commands.
- Create `web/src/ContactManagement.tsx` — nested Contact list/detail/edit and primary/lifecycle commands.
- Modify `web/src/DeliveryCreate.tsx` — Customer assignee/primary Contact defaults and active-selector behavior.
- Modify `web/src/services/api.ts` — JobCard `contactId` and shared parser exports.
- Modify `web/src/styles.css` — routed shell and accessible CRM responsive styles.

### Tests and documentation

- Create server tests `crm-schema.test.ts`, `crm-repository.test.ts`, `crm-service.test.ts`, `crm-concurrency.test.ts`, and `crm-routes.test.ts`.
- Modify server tests `job-card-crud-service.test.ts`, `job-card-routes.test.ts`, `people-service.test.ts`, `people-repository.test.ts`, `auth-setup.test.ts`, and `app.test.ts`.
- Create web tests `router.test.tsx`, `crm-client.test.ts`, `customer-list.test.tsx`, `customer-detail.test.tsx`, and `contact-management.test.tsx`.
- Modify web tests `App.test.tsx`, `delivery-create.test.tsx`, `tracer-client.test.ts`, and `accessibility-contract.test.ts`.
- Update `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, `DECISIONS.md`, and `README.md` only when the corresponding implementation is verified.

---

## Checkpoint 05A — Schema and CRM Domain

### Task 1: Migration 004 and database invariants

**Files:**
- Create: `server/src/db/migrations/004_crm_contacts.sql`
- Create: `server/tests/crm-schema.test.ts`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`

**Interfaces:**
- Produces versioned `customers`, nested `contacts`, nullable `job_cards.contact_id`, CRM audit values, composite foreign keys, and supporting indexes.
- Preserves every applied migration and existing People audit row.

- [ ] **Step 1: Write the failing schema contract test**

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/004_crm_contacts.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('004 CRM migration contract', () => {
  it('versions Customers and removes ambiguous notes', () => {
    expect(sql).toMatch(/ALTER TABLE customers[\s\S]*DROP COLUMN notes/i);
    expect(sql).toMatch(/ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i);
    expect(sql).toMatch(/UNIQUE[\s\S]*organization_id[\s\S]*tax_number|CREATE UNIQUE INDEX[\s\S]*tax_number/i);
  });

  it('protects Contact and JobCard ownership', () => {
    expect(sql).toContain('CREATE TABLE contacts');
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, customer_id\)[\s\S]*REFERENCES customers \(organization_id, id\)/i);
    expect(sql).toMatch(/ADD COLUMN contact_id UUID/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, contact_id\)[\s\S]*REFERENCES contacts \(organization_id, id\)/i);
    expect(sql).toMatch(/WHERE is_primary = TRUE AND is_active = TRUE/i);
  });

  it('expands audit checks without credential fields', () => {
    expect(sql).toContain("'CUSTOMER'");
    expect(sql).toContain("'CONTACT'");
    expect(sql).toContain("'CUSTOMER_ASSIGNEE_CHANGED'");
    expect(sql).not.toMatch(/ADD COLUMN (password|token|cookie|session)/i);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd server && npm test -- --run tests/crm-schema.test.ts`  
Expected: FAIL because `004_crm_contacts.sql` does not exist.

- [ ] **Step 3: Add the exact migration**

Use additive/altering SQL in migration 004:

```sql
ALTER TABLE customers
  DROP COLUMN notes,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE customers
  ADD CONSTRAINT customers_tax_number_normalized_check CHECK (
    tax_number IS NULL OR (
      length(tax_number) > 0
      AND tax_number = upper(regexp_replace(trim(tax_number), '[[:space:]./-]+', '', 'g'))
    )
  );

CREATE UNIQUE INDEX customers_organization_tax_number_unique
  ON customers (organization_id, tax_number)
  WHERE tax_number IS NOT NULL;

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
  title VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(255),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id)
);

CREATE UNIQUE INDEX contacts_one_active_primary_per_customer
  ON contacts (organization_id, customer_id)
  WHERE is_primary = TRUE AND is_active = TRUE;

ALTER TABLE job_cards ADD COLUMN contact_id UUID;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_organization_contact_fk
  FOREIGN KEY (organization_id, contact_id)
  REFERENCES contacts (organization_id, id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_subject_type_check;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_type_check;
```

Re-add both audit CHECK constraints with every existing People value plus every approved CRM value. Add Contact search/status/customer indexes and a JobCard `(organization_id, contact_id)` index. Update the schema SSOT to remove Customer/Contact notes and document versions, composite FKs, partial unique primary, and `job_cards.contact_id`.

- [ ] **Step 4: Verify migration contract and runner regression**

Run: `cd server && npm test -- --run tests/crm-schema.test.ts tests/migrate-runner.test.ts tests/people-schema.test.ts tests/delivery-schema.test.ts`  
Expected: PASS with applied migration files unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations/004_crm_contacts.sql server/tests/crm-schema.test.ts SERVORA_MED_SCHEMA_DRAFT.md
git commit -m "feat: add CRM schema"
```

### Task 2: CRM types, normalization, queries, and transaction repository

**Files:**
- Create: `server/src/modules/crm/types.ts`
- Create: `server/src/modules/crm/repository.ts`
- Create: `server/tests/crm-repository.test.ts`

**Interfaces:**
- Produces `Customer`, `Contact`, `CustomerDetail`, `CustomerFilters`, `ContactFilters`, `CrmTransaction`, and `CrmRepository`.
- Consumes `pg.Pool`; all mutation methods run through a caller-visible transaction.

- [ ] **Step 1: Write failing repository and normalization tests**

Define the required public contracts in the test fixtures:

```ts
export type CustomerStatus = 'prospect' | 'active' | 'inactive';
export type CustomerType = 'clinic' | 'hospital' | 'dealer' | 'company' | 'other';
export type ContactStatusFilter = 'active' | 'inactive' | 'all';

export interface CrmRepository {
  execute<T>(work: (tx: CrmTransaction) => Promise<T>): Promise<T>;
  listCustomers(organizationId: string, filters: CustomerFilters): Promise<Paginated<CustomerSummary>>;
  getCustomerDetail(actor: CrmActor, customerId: string): Promise<CustomerDetail | null>;
  listContacts(organizationId: string, customerId: string, filters: ContactFilters): Promise<Paginated<Contact>>;
  getContact(organizationId: string, customerId: string, contactId: string): Promise<Contact | null>;
}

expect(normalizeTaxNumber(' ab 12.3-4/ ')).toBe('AB1234');
expect(normalizeTaxNumber(' . - / ')).toBeNull();
```

Repository tests must inspect SQL parameters/recorded calls for default inactive exclusion, `EXISTS` Contact search, organization predicates, bounded five-open/five-completed summaries, and Staff `assigned_to` scoping.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd server && npm test -- --run tests/crm-repository.test.ts`  
Expected: FAIL because the CRM module does not exist.

- [ ] **Step 3: Implement focused types and repository methods**

The transaction interface must be explicit:

```ts
export interface CrmTransaction {
  lockUser(organizationId: string, userId: string): Promise<CrmUserRecord | null>;
  lockCustomer(organizationId: string, customerId: string): Promise<Customer | null>;
  createCustomer(input: CreateCustomerRecord): Promise<Customer>;
  updateCustomer(input: UpdateCustomerRecord): Promise<Customer | null>;
  setCustomerStatus(input: SetCustomerStatusRecord): Promise<Customer | null>;
  customerHasActiveJobs(organizationId: string, customerId: string): Promise<boolean>;
  lockContact(organizationId: string, customerId: string, contactId: string): Promise<Contact | null>;
  lockActiveContacts(organizationId: string, customerId: string): Promise<Contact[]>;
  createContact(input: CreateContactRecord): Promise<Contact>;
  updateContact(input: UpdateContactRecord): Promise<Contact | null>;
  setContactActive(input: SetContactActiveRecord): Promise<Contact | null>;
  clearPrimary(contactId: string): Promise<Contact>;
  setPrimary(contactId: string, expectedVersion: number): Promise<Contact | null>;
  contactHasActiveJobs(organizationId: string, contactId: string): Promise<boolean>;
  appendAudit(input: AppendCrmAuditInput): Promise<void>;
}
```

Implement `BEGIN`, `COMMIT`, and `ROLLBACK`; map database snake_case once in `types.ts`; use `limit <= 200`; use stable ordering `(name, id)` and deterministic JobCard summary ordering. Do not expose raw SQL rows outside the repository.

- [ ] **Step 4: Verify GREEN**

Run: `cd server && npm test -- --run tests/crm-repository.test.ts tests/people-repository.test.ts tests/job-card-service.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/crm/types.ts server/src/modules/crm/repository.ts server/tests/crm-repository.test.ts
git commit -m "feat: add CRM persistence"
```

### Task 3: Customer and Contact service policy

**Files:**
- Create: `server/src/modules/crm/service.ts`
- Create: `server/tests/crm-service.test.ts`
- Modify: `server/src/errors/index.ts`
- Modify: `server/tests/errors.test.ts`

**Interfaces:**
- Produces `CrmService` methods consumed verbatim by HTTP handlers.
- Consumes `CrmRepository`; backend policy remains the source of truth.

- [ ] **Step 1: Write failing service policy tests**

Use an in-memory recording repository and cover each rule independently. The service surface is:

```ts
export class CrmService {
  listCustomers(actor: CrmActor, filters: CustomerFilters): Promise<Paginated<CustomerSummary>>;
  getCustomer(actor: CrmActor, customerId: string): Promise<CustomerDetail>;
  createCustomer(actor: CrmActor, input: CreateCustomerInput): Promise<Customer>;
  updateCustomer(actor: CrmActor, customerId: string, input: UpdateCustomerInput): Promise<Customer>;
  activateCustomer(actor: CrmActor, customerId: string, expectedVersion: number): Promise<Customer>;
  deactivateCustomer(actor: CrmActor, customerId: string, expectedVersion: number): Promise<Customer>;
  listContacts(actor: CrmActor, customerId: string, filters: ContactFilters): Promise<Paginated<Contact>>;
  getContact(actor: CrmActor, customerId: string, contactId: string): Promise<Contact>;
  createContact(actor: CrmActor, customerId: string, input: CreateContactInput): Promise<Contact>;
  updateContact(actor: CrmActor, customerId: string, contactId: string, input: UpdateContactInput): Promise<Contact>;
  activateContact(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number): Promise<Contact>;
  deactivateContact(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number): Promise<Contact>;
  makePrimary(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number): Promise<PrimaryContactResult>;
}
```

Tests must prove Admin/Manager write and Staff read-only; same-organization concealment; initial prospect/active only; exact status transitions; lifecycle-field rejection at handler boundary; normalized tax conflict; active Staff assignee requirement; first active Contact primary; reactivation not primary; active-JobCard guards; primary replacement versions; and safe canonical audit payloads.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd server && npm test -- --run tests/crm-service.test.ts`  
Expected: FAIL because `CrmService` is missing.

- [ ] **Step 3: Implement the smallest policy helpers and transaction flows**

Use stable error constructors:

```ts
const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const customerNotFound = () => new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
const contactNotFound = () => new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
const versionConflict = (currentVersion?: number) => new AppError(
  'VERSION_CONFLICT', 409, 'Kayıt başka bir kullanıcı tarafından güncellendi.',
  currentVersion === undefined ? null : { currentVersion },
);
```

Extend the existing error contract without leaking internals:

```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details: Record<string, unknown> | null = null,
  ) { super(message); this.name = 'AppError'; }
}
```

`toErrorResponse` includes `details` only from an `AppError`; unknown errors still return the existing generic body. Add an error regression proving `{ currentVersion: 3 }` is serialized and arbitrary thrown-object properties are not.

For `makePrimary`, lock the Customer, lock active Contacts in UUID order, validate target version/activity, increment the previous primary version, increment the target version, and write one `CONTACT_MADE_PRIMARY` audit event containing only old/new Contact IDs. Map unique-tax SQLSTATE `23505` for the named index to `CUSTOMER_TAX_NUMBER_EXISTS`.

- [ ] **Step 4: Verify GREEN and domain regressions**

Run: `cd server && npm test -- --run tests/crm-service.test.ts tests/errors.test.ts tests/people-service.test.ts tests/job-card-service.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/crm/service.ts server/src/errors/index.ts server/tests/crm-service.test.ts server/tests/errors.test.ts
git commit -m "feat: enforce CRM lifecycle policy"
```

---

## Checkpoint 05B — Cross-Module Concurrency and HTTP API

### Task 4: JobCard Contact association and shared locking

**Files:**
- Modify: `server/src/modules/job-cards/types.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/handlers.ts`
- Modify: `server/tests/job-card-crud-service.test.ts`
- Modify: `server/tests/job-card-routes.test.ts`
- Create: `server/tests/crm-concurrency.test.ts`

**Interfaces:**
- Adds `contactId: string | null` to `JobCard`, create, patch, repository rows, and HTTP DTOs.
- Produces transaction methods that CRM guards and JobCard creation share without importing CRM service policy.

- [ ] **Step 1: Write failing JobCard association and concurrency tests**

Add focused cases:

```ts
it('rejects a Contact from another Customer', async () => {
  await expect(service.create(staff, {
    clientActionId: 'create-contact-mismatch', type: 'PRODUCT_DELIVERY',
    title: 'Teslim', customerId: 'customer-a', contactId: 'contact-b',
    assignedTo: staff.id,
  })).rejects.toMatchObject({ code: 'CONTACT_NOT_IN_CUSTOMER' });
});

it('persists a valid Contact on the JobCard response', async () => {
  const job = await service.create(staff, validCreate({ contactId: 'contact-a' }));
  expect(job.contactId).toBe('contact-a');
});
```

The PostgreSQL concurrency test must open two clients and prove customer deactivation cannot interleave after JobCard Customer validation, Contact deactivation cannot interleave after Contact validation, and both transactions finish without deadlock under the documented order.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd server && npm test -- --run tests/job-card-crud-service.test.ts tests/job-card-routes.test.ts tests/crm-concurrency.test.ts`  
Expected: FAIL because JobCards do not expose or persist `contactId` and Customer validation uses an unlocked existence query.

- [ ] **Step 3: Implement lock-aware reference validation**

Replace `customerExists` with records that lock and expose eligibility:

```ts
type JobCustomerReference = { id: string; status: 'prospect' | 'active' | 'inactive' };
type JobContactReference = { id: string; customerId: string; isActive: boolean };

interface JobCardTransaction {
  getAssigneeForUpdate(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getCustomerForUpdate(organizationId: string, customerId: string): Promise<JobCustomerReference | null>;
  getContactForUpdate(organizationId: string, contactId: string): Promise<JobContactReference | null>;
}
```

JobCard create locks assignee User, Customer, and optional Contact in that order. A relationship patch locks the proposed Customer and optional Contact before locking the JobCard. Reject inactive Customers, inactive Contacts, and mismatched parents. If Customer changes and no compatible Contact is supplied, persist `contact_id = NULL`. Keep critical action claim, activity insertion, and JobCard insert/update in one existing transaction.

- [ ] **Step 4: Verify GREEN and full JobCard regression**

Run: `cd server && npm test -- --run tests/job-card-crud-service.test.ts tests/job-card-routes.test.ts tests/crm-concurrency.test.ts tests/job-card-lifecycle-service.test.ts tests/delivery-item-service.test.ts`  
Expected: PASS with no duplicate activities or version regressions.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/job-cards server/tests/job-card-crud-service.test.ts server/tests/job-card-routes.test.ts server/tests/crm-concurrency.test.ts
git commit -m "feat: link Contacts to JobCards"
```

### Task 5: Staff deactivation Customer cleanup port

**Files:**
- Create: `server/src/modules/people/customer-assignment-port.ts`
- Create: `server/src/modules/crm/people-adapter.ts`
- Modify: `server/src/modules/people/repository.ts`
- Modify: `server/src/modules/people/service.ts`
- Modify: `server/tests/people-repository.test.ts`
- Modify: `server/tests/people-service.test.ts`

**Interfaces:**
- People owns `CustomerAssignmentCleanupPort`; CRM implements it with a caller-owned `PoolClient`.
- `PeopleTransaction.clearCustomerAssignments(...)` is available only inside the existing deactivation transaction.

- [ ] **Step 1: Write failing cleanup and rollback tests**

Use this exact port:

```ts
export type ClearCustomerAssignmentsInput = {
  organizationId: string;
  staffUserId: string;
  actorUserId: string;
};

export interface CustomerAssignmentCleanupPort {
  clearAssignmentsForDeactivatedStaff(
    client: PoolClient,
    input: ClearCustomerAssignmentsInput,
  ): Promise<Array<{ customerId: string; nextVersion: number }>>;
}
```

Tests prove all matching active and inactive Customers are cleared, each Customer version increments, each audit event has `reason: STAFF_DEACTIVATED`, People never imports `crm/repository.ts`, and an injected audit failure rolls back user deactivation, session revocation, and every assignment change.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd server && npm test -- --run tests/people-repository.test.ts tests/people-service.test.ts`  
Expected: FAIL because the cleanup port is not available.

- [ ] **Step 3: Implement the transaction-bound adapter**

`PostgresPeopleRepository` receives the cleanup port next to auth ports. During eligible Staff deactivation, after locking the User and checking active JobCards, invoke cleanup before the versioned user update. The CRM adapter executes:

```sql
SELECT id, version
FROM customers
WHERE organization_id = $1 AND assigned_staff_user_id = $2
ORDER BY id
FOR UPDATE;
```

For each locked Customer, set `assigned_staff_user_id = NULL`, increment version, and insert `CUSTOMER_ASSIGNEE_CHANGED` with ID-only values and the approved reason. Reuse the active `PoolClient`; do not open or commit a nested transaction.

- [ ] **Step 4: Verify GREEN and deactivation regressions**

Run: `cd server && npm test -- --run tests/people-repository.test.ts tests/people-service.test.ts tests/people-routes.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/people server/src/modules/crm/people-adapter.ts server/tests/people-repository.test.ts server/tests/people-service.test.ts
git commit -m "feat: clear CRM ownership on Staff deactivation"
```

### Task 6: Exact CRM handlers, nested routes, and app wiring

**Files:**
- Create: `server/src/modules/crm/handlers.ts`
- Create: `server/src/modules/crm/routes.ts`
- Create: `server/tests/crm-routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/app.test.ts`
- Modify: `SERVORA_MED_API_DRAFT.md`

**Interfaces:**
- Produces every approved `/api/customers` and nested Contact route.
- Consumes `CrmService`, authentication, and the mandatory-password guard.

- [ ] **Step 1: Write failing route acceptance tests**

Register and test exactly:

```ts
app.get('/customers', handlers.listCustomers);
app.post('/customers', handlers.createCustomer);
app.get('/customers/:customerId', handlers.getCustomer);
app.patch('/customers/:customerId', handlers.updateCustomer);
app.post('/customers/:customerId/activate', handlers.activateCustomer);
app.post('/customers/:customerId/deactivate', handlers.deactivateCustomer);
app.get('/customers/:customerId/contacts', handlers.listContacts);
app.post('/customers/:customerId/contacts', handlers.createContact);
app.get('/customers/:customerId/contacts/:contactId', handlers.getContact);
app.patch('/customers/:customerId/contacts/:contactId', handlers.updateContact);
app.post('/customers/:customerId/contacts/:contactId/activate', handlers.activateContact);
app.post('/customers/:customerId/contacts/:contactId/deactivate', handlers.deactivateContact);
app.post('/customers/:customerId/contacts/:contactId/make-primary', handlers.makePrimary);
```

Acceptance tests cover exact filters, pagination bounds, unknown fields, positive integer `expectedVersion`, named lifecycle commands, Staff `403` mutations, Staff read success, cross-organization 404 concealment, stable conflict codes, and absence of `notes` fields.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd server && npm test -- --run tests/crm-routes.test.ts tests/app.test.ts`  
Expected: FAIL with missing routes or 404.

- [ ] **Step 3: Implement handlers, routes, and dependency wiring**

Handlers use allowlists rather than spreading request bodies:

```ts
const CUSTOMER_PATCH_FIELDS = [
  'expectedVersion', 'name', 'customerType', 'taxNumber', 'phone', 'email',
  'city', 'district', 'address', 'assignedStaffUserId',
] as const;
const CONTACT_PATCH_FIELDS = ['expectedVersion', 'name', 'title', 'phone', 'email'] as const;
```

Apply authentication and mandatory-password guards before handlers. Extend `AppDependencies` with optional `crmRepository`. In `server/src/index.ts`, construct one `PostgresCustomerAssignmentCleanup`, pass it into `PostgresPeopleRepository`, construct `PostgresCrmRepository`, and keep CRM, People, and JobCard repositories on `database.pool`. Update the API SSOT with nested paths, state machines, `contactId`, filters, errors, and version behavior.

- [ ] **Step 4: Verify GREEN and complete backend unit gate**

Run:

```bash
cd server && npm test -- --run tests/crm-routes.test.ts tests/app.test.ts
cd server && npm test -- --run
cd server && npm run build
```

Expected: all server tests and TypeScript build PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/crm server/src/app.ts server/src/index.ts server/tests/crm-routes.test.ts server/tests/app.test.ts SERVORA_MED_API_DRAFT.md
git commit -m "feat: expose nested CRM API"
```

### Task 7: Development seed and live PostgreSQL backend tracer

**Files:**
- Modify: `server/src/modules/auth/setup.ts`
- Modify: `server/tests/auth-setup.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-12-customers-contacts.md`

**Interfaces:**
- Produces representative development Customer/Contact references after migrations 001–004.
- Uses the existing production refusal and never inserts demo credentials through a migration.

- [x] **Step 1: Write failing development-seed tests**

Assert the development seed creates a clinic Customer, one active primary doctor Contact, an optional responsible Staff assignment, and no Customer/Contact notes. Assert production still refuses development seeding.

- [x] **Step 2: Run seed tests and verify RED**

Run: `cd server && npm test -- --run tests/auth-setup.test.ts`  
Expected: FAIL because no Contact is seeded.

- [x] **Step 3: Extend the seed in its existing transaction**

Insert `Demo Dental Klinik`, assign the demo Staff, insert `Dr. Ayşe Yılmaz` as active primary Contact, and attach that Contact to the representative seeded JobCard when the JobCard is created. Do not emit actor audit events for environment bootstrap records.

- [x] **Step 4: Execute the disposable PostgreSQL tracer**

Create a disposable database, run migrations 001–004 and the development seed, then exercise authenticated HTTP:

```text
Admin forced password change and fresh login
→ Manager login
→ create prospect Customer with normalized tax number
→ assign active Staff
→ add first Contact and verify automatic primary
→ add second Contact and make it primary
→ create JobCard with that Contact
→ verify Contact and Customer deactivation conflicts
→ complete/cancel the active JobCard as allowed
→ deactivate Contact and Customer
→ reactivate Customer to active without cascading Contact
→ verify audit events and organization isolation
```

Also execute two-client race tests from `crm-concurrency.test.ts`. Record exact pass counts and tracer results in this plan, stop the server, and drop the disposable database.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/auth/setup.ts server/tests/auth-setup.test.ts README.md docs/superpowers/plans/2026-07-12-customers-contacts.md
git commit -m "test: verify CRM backend tracer"
```

**05B live backend verification (2026-07-12):**

- Disposable database `servora_med_slice05` applied migrations `001`–`004` and the development seed successfully.
- Focused PostgreSQL seed contract tests passed 2/2: they verified 3 users, 1 Staff profile, the Customer → active Staff assignment, 1 active primary doctor Contact with defaults, product `DEMO-001`, a Contact-linked `NEW` JobCard assigned to Staff, exactly 1 actor-linked `JOB_CREATED` activity, zero management `audit_events`, and full rollback after a late reference insert failure.
- Production-protocol concurrency test ran with `TEST_DATABASE_URL`: 1/1 passed for concurrent JobCard create versus Customer/Contact deactivation, bounded completion, and persisted invariants.
- Live HTTP verified Admin, Manager, and Staff mandatory password change plus fresh login. The focused Admin rerun returned `mustChangePassword=true` on the seeded-password login, `204` with session revocation on password change, then `mustChangePassword=false` and version 2 on fresh login. The tracer also verified normalized tax number `AB1234`, first-primary and primary replacement behavior, and cross-organization `404 CUSTOMER_NOT_FOUND` concealment.
- Contact and Customer deactivation returned `409 CONTACT_HAS_ACTIVE_JOB_CARDS` and `409 CUSTOMER_HAS_ACTIVE_JOB_CARDS` while the JobCard was active.
- Staff completed `IN_PROGRESS → WAITING_APPROVAL`; Manager approved `COMPLETED`; subsequent Contact/Customer deactivation succeeded and Customer reactivation returned `active`.
- Admin Staff deactivation changed the Staff record to inactive/version 3, cleared both active and inactive Customer assignments, and wrote 2 `CUSTOMER_ASSIGNEE_CHANGED` events with `STAFF_DEACTIVATED` reason. CRM audit PII scan returned zero rows.
- Login rate limiting returned `429 RATE_LIMIT_EXCEEDED` during repeated tracer logins; the local server was restarted before the remaining authorized checks.
- Final server gate after review fixes passed: 27 files/175 tests, 2 conditional PostgreSQL files/3 tests skipped without `TEST_DATABASE_URL`, TypeScript build passed, and npm audit reported zero vulnerabilities. Against disposable PostgreSQL, the concurrency test passed 1/1 and the seed contract passed 2/2.
- Test servers were stopped and the disposable database was dropped after final automated verification.

---

## Checkpoint 05C — Routed CRM Web Experience

### Task 8: React Router foundation and existing-screen migration

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/AppRouter.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/App.tsx`
- Create: `web/tests/router.test.tsx`
- Modify: `web/tests/App.test.tsx`

**Interfaces:**
- Produces stable paths and route helpers consumed by CRM screens.
- Keeps `App` responsible for identity, forced password change, and logout; `BrowserRouter` is mounted exactly once in `main.tsx`.

- [x] **Step 1: Write failing route behavior tests**

Wrap route tests with `MemoryRouter`:

```tsx
const html = renderToStaticMarkup(
  <MemoryRouter initialEntries={['/customers?status=inactive']}>
    <App initialUser={manager} />
  </MemoryRouter>,
);
expect(html).toContain('Müşteriler');
```

Test `/jobs`, `/jobs/new-delivery`, `/jobs/:jobCardId`, `/users`, `/staff`, `/staff/:staffUserId`, `/customers`, `/customers/new`, `/customers/:customerId`, and nested Contact detail. Prove forbidden direct routes render the established forbidden state and unknown routes return a safe not-found view.

- [x] **Step 2: Install the approved dependency and verify RED**

Run:

```bash
cd web && npm install react-router-dom@7.18.1
cd web && npm test -- --run tests/router.test.tsx tests/App.test.tsx
```

Expected: dependency installation succeeds and tests FAIL because `AppRouter.tsx` and stable routes do not exist.

- [x] **Step 3: Add the route tree and remove local screen navigation**

Export a single path map:

```ts
export const paths = {
  jobs: '/jobs', users: '/users', staff: '/staff', customers: '/customers',
  job: (id: string) => `/jobs/${id}`,
  staffProfile: (id: string) => `/staff/${id}`,
  customer: (id: string) => `/customers/${id}`,
  contact: (customerId: string, contactId: string) =>
    `/customers/${customerId}/contacts/${contactId}`,
} as const;
```

Mount `<BrowserRouter><App /></BrowserRouter>` in `main.tsx`. Replace `screen`/`selectedJobId` state with `<Routes>`, `<Route>`, `<Outlet>`, `<Link>`, and `useNavigate`. Preserve login and forced-password interception before protected data requests. Keep route guards as UI affordances only; APIs remain authoritative.

- [x] **Step 4: Verify GREEN and existing-screen regressions**

Run: `cd web && npm test -- --run tests/router.test.tsx tests/App.test.tsx tests/workspace-view.test.tsx tests/user-management.test.tsx tests/staff-profiles.test.tsx tests/job-detail.test.tsx`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/AppRouter.tsx web/src/main.tsx web/src/App.tsx web/tests/router.test.tsx web/tests/App.test.tsx
git commit -m "feat: add routed application navigation"
```

**Task 8 verification (2026-07-12):** route/App and existing-screen regression suite passed, the routed Staff identity regression passed, the full web suite passed 13 files/59 tests, and the TypeScript/Vite production build passed. React Router DOM is pinned to approved version 7.18.1.

### Task 9: Runtime-validated CRM web client

**Files:**
- Create: `web/src/services/crm-api.ts`
- Modify: `web/src/services/api.ts`
- Create: `web/tests/crm-client.test.ts`
- Modify: `web/tests/tracer-client.test.ts`

**Interfaces:**
- Produces typed Customer/Contact list, detail, mutation, and command functions.
- Adds nullable `contactId` to JobCard clients without duplicating shared request/parser helpers.

- [x] **Step 1: Write failing client contract tests**

Define runtime-validated DTOs:

```ts
export type Customer = {
  id: string; organizationId: string; name: string; customerType: CustomerType;
  taxNumber: string | null; phone: string | null; email: string | null;
  city: string | null; district: string | null; address: string | null;
  assignedStaffUserId: string | null; status: CustomerStatus; version: number;
};

export type Contact = {
  id: string; organizationId: string; customerId: string; name: string;
  title: string | null; phone: string | null; email: string | null;
  isPrimary: boolean; isActive: boolean; version: number;
};
```

Test credentials inclusion, URL encoding for every filter, nested route URLs, exact command bodies, malformed response rejection, `VERSION_CONFLICT` propagation, and JobCard `contactId` parsing.

- [x] **Step 2: Run client tests and verify RED**

Run: `cd web && npm test -- --run tests/crm-client.test.ts tests/tracer-client.test.ts`  
Expected: FAIL because `crm-api.ts` and JobCard `contactId` parsing do not exist.

- [x] **Step 3: Implement minimal parsers and calls**

Export `listCustomers`, `getCustomer`, `createCustomer`, `updateCustomer`, `activateCustomer`, `deactivateCustomer`, `listContacts`, `getContact`, `createContact`, `updateContact`, `activateContact`, `deactivateContact`, and `makePrimaryContact`. Build filters with `URLSearchParams`; omit empty optional values; never automatically retry mutations.

- [x] **Step 4: Verify GREEN**

Run: `cd web && npm test -- --run tests/crm-client.test.ts tests/tracer-client.test.ts tests/auth-client.test.ts tests/people-client.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/services/api.ts web/src/services/crm-api.ts web/tests/crm-client.test.ts web/tests/tracer-client.test.ts
git commit -m "feat: add CRM web client"
```

**Task 9 verification (2026-07-12):** the focused CRM/JobCard/auth/People client suite passed 4 files/22 tests, the full web suite passed 14 files/68 tests, the TypeScript/Vite production build passed, and `npm audit --audit-level=high` reported zero vulnerabilities. Runtime parsers reject malformed CRM responses and non-canonical JobCard summary statuses; mutation conflicts remain non-retryable while safe `details.currentVersion` data is preserved; malformed error details are ignored; all list filters and Customer/Contact identifiers are URL-encoded; and JobCard responses preserve nullable `contactId`.

### Task 10: Customer list, URL filters, and creation

**Files:**
- Create: `web/src/CustomerList.tsx`
- Create: `web/tests/customer-list.test.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/accessibility-contract.test.ts`

**Interfaces:**
- Produces `/customers` and `/customers/new` screens.
- Consumes CRM client, People Staff list, `paths.customer`, and URL search parameters.

- [x] **Step 1: Write failing list/create view tests**

Tests cover loading, empty, no-results, retry, inactive default, status/type/city/Staff/unassigned filters, copied URL restoration, Staff read-only view, Manager/Admin create action, field-linked errors, similar-name warning, pending submit disablement, and unknown network-result refetch behavior.

Static markup must contain semantic list and labeled form controls:

```tsx
expect(html).toContain('<ul');
expect(html).toContain('<label for="customer-search">Müşteri ara</label>');
expect(html).toContain('Sorumlu personel');
expect(html).toContain('Birincil kişi');
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/customer-list.test.tsx tests/accessibility-contract.test.ts`  
Expected: FAIL because Customer screens do not exist.

- [x] **Step 3: Implement routed list and create states**

Use `useSearchParams` as the single filter state. Debounce only text search with an existing React effect/timer; do not add a dependency. Render status/type with text labels, use a structured list rather than a table, and link each result to `paths.customer(id)`. Before create, query normal case-insensitive name search and display matches without blocking submit. Disable submit while pending and refetch after an unknown result before allowing resubmission.

- [x] **Step 4: Verify GREEN and responsive contract**

Run: `cd web && npm test -- --run tests/customer-list.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/CustomerList.tsx web/src/AppRouter.tsx web/src/styles.css web/tests/customer-list.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: add Customer list and creation"
```

**Task 10 verification (2026-07-12):** focused Customer/router/accessibility tests passed 3 files/28 tests; the full web suite passed 15 files/77 tests; TypeScript/Vite build passed; npm audit reported zero vulnerabilities. Filters are URL-owned, the parameterless default delegates to the backend's prospect-plus-active scope, and only text search is debounced. Similar-name searches reject stale generations. Ambiguous create results refetch but never claim identity from a non-unique name, and responsive CSS reflows filters, list rows, and form pairs to one column.

### Task 11: Customer detail and nested Contact management

**Files:**
- Create: `web/src/CustomerDetail.tsx`
- Create: `web/src/ContactManagement.tsx`
- Create: `web/src/services/request-gate.ts`
- Create: `web/tests/customer-detail.test.tsx`
- Create: `web/tests/contact-management.test.tsx`
- Create: `web/tests/crm-detail-screen.test.tsx`
- Modify: `web/src/AppRouter.tsx`
- Modify: `web/src/CustomerList.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/tests/accessibility-contract.test.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- Produces Customer detail/edit/status and nested Contact detail/edit/lifecycle routes.
- Consumes role-scoped bounded JobCard summaries returned by Customer detail.

- [x] **Step 1: Write failing Customer/Contact view tests**

Cover general information, responsible Staff, active/inactive status, up to five open and five completed summaries, Staff-scoped summaries, no generic notes editor, no CRM audit timeline, Contact loading/empty/error states, automatic first-primary display, make-primary command, lifecycle confirmations, active-JobCard conflict copy, version-conflict input preservation, and focus restoration after dialogs.

Prove primary meaning is not color-only:

```tsx
expect(primaryMarkup).toContain('Birincil kişi');
expect(primaryMarkup).toMatch(/aria-label="Birincil kişi"|>Birincil kişi</);
expect(primaryMarkup).not.toContain('customer-notes');
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/customer-detail.test.tsx tests/contact-management.test.tsx`  
Expected: FAIL because detail and Contact screens do not exist.

- [x] **Step 3: Implement bounded detail and explicit commands**

Keep Customer fields, status commands, Contact fields, and Contact commands in separate forms. Do not place `status`, `isActive`, or `isPrimary` in general PATCH payloads. Confirmation dialogs name the affected record and explain irreversible operational impact; successful commands replace local versions with server-returned versions. Do not render `Tümünü gör` until Slice 07 supplies the filtered JobCard destination.

- [x] **Step 4: Verify GREEN and accessibility regression**

Run: `cd web && npm test -- --run tests/customer-detail.test.tsx tests/contact-management.test.tsx tests/router.test.tsx tests/accessibility-contract.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/CustomerDetail.tsx web/src/ContactManagement.tsx web/src/AppRouter.tsx web/src/styles.css web/tests/customer-detail.test.tsx web/tests/contact-management.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: add Customer and Contact detail flows"
```

**Task 11 verification (2026-07-13):** focused Customer/Contact/screen/router/accessibility tests passed 5 files/36 tests; the full web suite passed 18 files/94 tests; TypeScript/Vite build passed; npm audit reported zero vulnerabilities. Customer fields, Customer lifecycle, Contact fields, Contact lifecycle, and make-primary remain separate commands. Staff receives read-only CRM detail and JobCard summaries are capped at five per group. Route-keyed screens plus a shared request-generation gate prevent transient old-record renders and reject stale route or mutation results. Version conflicts preserve the user's uncontrolled form values, block stale resubmission, and require an explicit current-values reload before editing continues. Form reset revisions change only after a field save or deliberate reload, so lifecycle and make-primary version changes preserve unsaved fields. Customer assignee labels are reconciled from trusted Staff data, make-primary restores focus to a permanent command region, inline Contact creation restores focus in both directions, and jsdom-backed component tests exercise the asynchronous race, conflict, preservation, and focus behaviors.

### Task 12: JobCard Customer defaults and Contact selector

**Files:**
- Modify: `web/src/DeliveryCreate.tsx`
- Modify: `web/tests/delivery-create.test.tsx`
- Modify: `web/src/services/api.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Management may receive Customer responsible Staff as a suggested assignee; Staff creation remains assigned to self.
- Active primary Contact is a suggestion and the submitted `contactId` remains backend-validated.

- [ ] **Step 1: Write failing delivery-default tests**

Test that selecting a Customer loads active Contacts, selects active primary Contact when available, excludes inactive Customer/Contact options, clears incompatible Contact when Customer changes, submits `contactId`, keeps Staff `assignedTo` equal to the signed-in Staff user, and allows management to replace a suggested assignee.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd web && npm test -- --run tests/delivery-create.test.tsx tests/tracer-client.test.ts`  
Expected: FAIL because Delivery creation has no Contact input or CRM defaults.

- [ ] **Step 3: Implement explicit selector/default behavior**

Use CRM list/detail data already available through services. Defaults update only when Customer changes and do not overwrite a user-modified compatible selection. The Contact field has a visible label, empty option, loading state, and error message; selecting no Contact sends `null`. Do not encode eligibility rules beyond filtering server-returned active references.

- [ ] **Step 4: Verify GREEN and delivery-flow regression**

Run: `cd web && npm test -- --run tests/delivery-create.test.tsx tests/tracer-client.test.ts tests/job-detail.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/DeliveryCreate.tsx web/src/services/api.ts web/src/styles.css web/tests/delivery-create.test.tsx
git commit -m "feat: add Contact to delivery creation"
```

---

## Checkpoint 05D — Full Verification and Closeout

### Task 13: Full automated, live database, browser, docs, and memory verification

**Files:**
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `DECISIONS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-12-customers-contacts.md`
- Modify if required by a proven defect: only files touched by Tasks 1–12 and their focused tests.

**Interfaces:**
- Produces the verified Slice 05 handoff and updated SSOT/codebase memory.
- Must not introduce new product behavior during closeout.

- [ ] **Step 1: Run full automated verification**

```bash
cd server && npm test -- --run
cd server && npm run build
cd server && npm audit --audit-level=high
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --audit-level=high
```

Expected: every command exits 0; audits report zero high/critical vulnerabilities. If a command fails, use `superpowers:systematic-debugging`, add a regression test, and rerun the focused test before the full command.

- [ ] **Step 2: Repeat the disposable PostgreSQL end-to-end tracer**

Run migrations 001–004, development seed, login, Customer create/search/update, Contact create/primary change, JobCard Contact create, guard conflicts, Staff deactivation cleanup, activation/deactivation, audit inspection, and cross-organization rejection through live HTTP. Confirm rollback and concurrency with two database clients. Record exact database name, commands, counts, and cleanup result in this plan.

- [ ] **Step 3: Run browser acceptance with Playwright MCP**

At 390×844 and desktop width, verify Manager Customer create/edit, responsible Staff, nested Contacts, primary change, JobCard summaries, deactivate conflicts, and router Back/Forward/refresh/direct URLs. Verify Staff read-only CRM, own-only JobCard summaries, and absence of mutation/audit/private-note UI.

Manually verify keyboard-only completion, logical focus, dialog focus restoration, visible focus, 44×44 targets, 200% text size, effective 400% zoom/reflow, reduced motion, semantic headings/landmarks, labels, live feedback, and absence of horizontal page scrolling. Remove generated Playwright artifacts after inspection.

- [ ] **Step 4: Update SSOT, decision log, plan results, and codebase memory**

Mark only verified Slice 05 acceptance boxes complete. Ensure docs contain implemented route names, Contact relationship, lock protocol, migration filename, React Router decision, exact verification results, and remaining Slice 07 note/follow-up deferrals. Re-index both `server` and `web` codebase-memory projects with persistence after the final code state.

- [ ] **Step 5: Commit the verified closeout**

```bash
git status --short
git diff --check
git add SERVORA_MED_MVP_SLICES.md SERVORA_MED_API_DRAFT.md SERVORA_MED_SCHEMA_DRAFT.md DECISIONS.md README.md docs/superpowers/plans/2026-07-12-customers-contacts.md
git add server web
git commit -m "docs: close Slice 05 CRM"
```

Expected: commit succeeds, `git status --short` is empty, and the final implementation branch is ready for `superpowers:requesting-code-review` followed by `superpowers:finishing-a-development-branch`.

---

## Execution Checkpoints

- **05A review gate:** migration, repository, normalization, and CRM policy pass focused tests.
- **05B review gate:** cross-module locks, JobCard Contact, Staff cleanup, routes, full server suite/build, and live PostgreSQL tracer pass.
- **05C review gate:** router, CRM client, Customer/Contact UI, delivery defaults, focused web tests, and accessibility contracts pass.
- **05D review gate:** full server/web tests, builds, audits, live PostgreSQL, Playwright acceptance, SSOT, and codebase memory are complete.

Do not start Slice 06, JobCard notes, Staff confidential notes, related follow-up cards, or full Kanban work before this plan closes.
