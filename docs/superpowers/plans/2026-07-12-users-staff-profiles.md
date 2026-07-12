# Users and Staff Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Slice 04 from Admin user creation through forced password change, Staff profile counters, Manager profile maintenance, lifecycle guards, audit, and browser verification.

**Architecture:** A new `people` module owns user/profile policy and PostgreSQL transactions. Auth remains responsible for password validation/hashing and session revocation through narrow ports. Fastify exposes Admin-only user commands and Admin/Manager Staff routes; React adds role-specific screens without a router or state framework.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Fastify 5, PostgreSQL 16+, React 19, Vite 8, Vitest 4, Playwright MCP.

## Global Constraints

- Follow [the approved design](../specs/2026-07-12-users-staff-profiles-design.md) exactly.
- Use English identifiers, tests, commits, and acceptance criteria; Turkish user-facing copy.
- Use migration `003_people.sql`; never edit applied migrations `001` or `002`.
- Use integer `version` and `expectedVersion`; do not use timestamps for concurrency.
- Do not add dependencies, a router, global state framework, UI library, realtime transport, or `processed_actions` coverage.
- Never persist or audit raw passwords, password hashes, tokens, cookies, or session identifiers.
- Keep the Slice one product flow, implemented through checkpoints 04A–04D.
- Every production behavior starts with a failing focused test and ends with relevant regression tests.

---

## File Map

### Server

- Create `server/src/db/migrations/003_people.sql` — Staff profile, audit, and version schema.
- Create `server/src/modules/people/types.ts` — people DTOs, commands, counters, and event types.
- Create `server/src/modules/people/repository.ts` — PostgreSQL transaction implementation and query mapping.
- Create `server/src/modules/people/service.ts` — authorization and lifecycle invariants.
- Create `server/src/modules/people/handlers.ts` — exact HTTP payload/query validation.
- Create `server/src/modules/people/routes.ts` — named user and Staff routes.
- Create `server/src/modules/auth/admin-ports.ts` — auth-owned credential/session adapters used by People.
- Modify `server/src/modules/auth/types.ts` — expose user version and safe active state required by UI/guards.
- Modify `server/src/modules/auth/repository.ts` — map version and support transaction-bound session revocation.
- Modify `server/src/modules/auth/middleware.ts` — mandatory-password guard.
- Modify `server/src/app.ts` — wire People repository/service/routes and guard.
- Modify `server/src/modules/auth/setup.ts` — create the development Staff profile in the existing seed transaction.

### Web

- Create `web/src/services/people-api.ts` — runtime-validated People API client.
- Create `web/src/PasswordChange.tsx` — forced password-change screen.
- Create `web/src/UserManagement.tsx` — Admin list, create, detail, commands, and reset UI.
- Create `web/src/StaffProfiles.tsx` — Manager/Admin Staff list/detail/edit and Staff own profile.
- Modify `web/src/App.tsx` — role-aware navigation and forced-password interception.
- Modify `web/src/styles.css` — responsive People layouts using existing tokens.

### Tests and docs

- Create focused server tests: `people-schema.test.ts`, `people-service.test.ts`, `people-counters.test.ts`, `people-routes.test.ts`, `password-change-guard.test.ts`.
- Create focused web tests: `people-client.test.ts`, `password-change.test.tsx`, `user-management.test.tsx`, `staff-profiles.test.tsx`.
- Modify shared app/accessibility tests and canonical product/API/schema/slice docs during closeout.

---

## Checkpoint 04A — People Schema and Backend Domain

### Task 1: People migration and schema contract

**Files:**
- Create: `server/src/db/migrations/003_people.sql`
- Create: `server/tests/people-schema.test.ts`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`

**Interfaces:**
- Produces `users.version`, `staff_profiles`, and `audit_events` for all later tasks.
- Preserves migration checksum/history behavior in `server/src/db/migrate.ts`.

- [x] **Step 1: Write the failing schema test**

Read the migration text and assert all non-negotiable constraints:

```ts
it('adds versioned Staff profiles and safe People audit storage', async () => {
  const sql = await readFile(migrationPath('003_people.sql'), 'utf8');
  expect(sql).toMatch(/ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1/);
  expect(sql).toMatch(/CHECK \(version > 0\)/);
  expect(sql).toMatch(/user_id UUID NOT NULL UNIQUE REFERENCES users/);
  expect(sql).not.toMatch(/staff_profiles[\s\S]*\b(is_active|notes|monthly_target)\b/i);
  expect(sql).toContain('CREATE TABLE audit_events');
  expect(sql).toContain('old_value JSONB');
  expect(sql).toContain('new_value JSONB');
});
```

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/people-schema.test.ts`  
Expected: FAIL because `003_people.sql` does not exist.

- [x] **Step 3: Add the migration**

Implement the exact columns from the approved spec. Include:

```sql
ALTER TABLE users
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE staff_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  title VARCHAR(255), phone VARCHAR(50), region VARCHAR(100),
  manager_user_id UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id UUID REFERENCES users(id),
  subject_type VARCHAR(40) NOT NULL,
  subject_id UUID NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Add indexes for organization/role user lookup, active Staff lookup, manager assignment, subject audit history, and organization audit chronology. Update the schema draft with `version`, removed `notes`, and `audit_events`.

- [x] **Step 4: Verify GREEN and migration runner regression**

Run: `cd server && npm test -- --run tests/people-schema.test.ts tests/migrate-runner.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/db/migrations/003_people.sql server/tests/people-schema.test.ts SERVORA_MED_SCHEMA_DRAFT.md
git commit -m "feat: add people schema"
```

### Task 2: People contracts, repository, counters, and audit transaction

**Files:**
- Create: `server/src/modules/people/types.ts`
- Create: `server/src/modules/people/repository.ts`
- Create: `server/tests/people-repository.test.ts`
- Create: `server/tests/people-counters.test.ts`

**Interfaces:**
- Produces `PeopleRepository.execute<T>(work)`, `PeopleTransaction`, `SafeManagedUser`, `StaffProfileSummary`, `StaffCounters`, and `AuditEventType`.
- Consumes a `pg.Pool` and never commits outside `execute`.

- [x] **Step 1: Define tests against the required repository interface**

Use a recording transaction for unit behavior and disposable PostgreSQL for SQL integration. The public contract must be:

```ts
export type StaffCounters = {
  open: number;
  waitingApproval: number;
  revisionRequested: number;
  completedThisMonth: number;
  overdue: number;
};

export type AuditEventType =
  | 'USER_CREATED' | 'USER_ROLE_CHANGED' | 'USER_ACTIVATED'
  | 'USER_DEACTIVATED' | 'USER_PASSWORD_RESET'
  | 'STAFF_PROFILE_UPDATED' | 'STAFF_MANAGER_CHANGED';

export interface PeopleRepository {
  execute<T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T>;
  listUsers(organizationId: string): Promise<SafeManagedUser[]>;
  getStaffSummary(organizationId: string, userId: string, now: Date): Promise<StaffProfileSummary | null>;
  listStaff(organizationId: string, status: 'active' | 'inactive' | 'all', now: Date): Promise<StaffProfileSummary[]>;
}
```

Tests must prove versioned updates use `WHERE ... version = ...`, counter overlap is intentional, `COMPLETED` uses `manager_approved_at`, overdue compares organization-local date, and audit insert accepts only caller-provided safe values.

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/people-repository.test.ts tests/people-counters.test.ts`  
Expected: FAIL because the People contracts/repository do not exist.

- [x] **Step 3: Implement minimal mapping and SQL**

Keep transaction methods explicit:

```ts
export interface PeopleTransaction {
  lockUser(organizationId: string, userId: string): Promise<ManagedUserRecord | null>;
  createUser(input: CreateUserRecord): Promise<ManagedUserRecord>;
  createStaffProfile(input: CreateStaffProfileRecord): Promise<StaffProfileRecord>;
  updateUserName(userId: string, expectedVersion: number, name: string): Promise<ManagedUserRecord | null>;
  changeRole(userId: string, expectedVersion: number, role: 'ADMIN' | 'MANAGER'): Promise<ManagedUserRecord | null>;
  setActive(userId: string, expectedVersion: number, active: boolean): Promise<ManagedUserRecord | null>;
  updateStaffProfile(input: UpdateStaffProfileRecord): Promise<StaffProfileRecord | null>;
  countActiveAdmins(organizationId: string): Promise<number>;
  hasActiveJobCards(userId: string): Promise<boolean>;
  hasAssignedActiveStaff(managerUserId: string): Promise<boolean>;
  resetTemporaryPassword(userId: string, expectedVersion: number, temporaryPassword: string, revokedAt: Date): Promise<ManagedUserRecord | null>;
  revokeAllSessions(userId: string, revokedAt: Date): Promise<void>;
  appendAudit(input: AppendAuditInput): Promise<void>;
}
```

Use `BEGIN/COMMIT/ROLLBACK`, `SELECT ... FOR UPDATE` for command targets, and conditional version updates. `PostgresPeopleRepository` receives the auth-owned administration ports and delegates the two auth transaction methods with its active `PoolClient`; People repository code must not duplicate password or session SQL. Calculate month start/end with `Intl.DateTimeFormat`-based organization date helpers in `types.ts`; do not add a date dependency.

- [x] **Step 4: Verify GREEN**

Run: `cd server && npm test -- --run tests/people-repository.test.ts tests/people-counters.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/people server/tests/people-repository.test.ts server/tests/people-counters.test.ts
git commit -m "feat: add people persistence"
```

### Task 3: People service policy

**Files:**
- Create: `server/src/modules/people/service.ts`
- Create: `server/tests/people-service.test.ts`

**Interfaces:**
- Produces `PeopleService` methods used verbatim by handlers.
- Consumes `PeopleRepository`, `CredentialAdministrationPort` for new-user password preparation, and `now`; transaction-bound reset/revocation is exposed through `PeopleTransaction` and implemented by auth ports.

- [x] **Step 1: Write failing policy tests**

Cover one behavior per test: Admin-only create; Staff profile required/forbidden; duplicate email; eligible manager; Admin/Manager-only role matrix; self guards; last Admin; active JobCards; assigned Staff; version conflict; atomic audit; Staff self read; Manager active-only filter.

The service surface is:

```ts
class PeopleService {
  listUsers(actor: SafeUser): Promise<SafeManagedUser[]>;
  getUser(actor: SafeUser, userId: string): Promise<SafeManagedUser>;
  createUser(actor: SafeUser, input: CreateUserInput): Promise<SafeManagedUser>;
  updateUser(actor: SafeUser, userId: string, input: { expectedVersion: number; name: string }): Promise<SafeManagedUser>;
  changeRole(actor: SafeUser, userId: string, input: { expectedVersion: number; role: 'ADMIN' | 'MANAGER' }): Promise<SafeManagedUser>;
  activate(actor: SafeUser, userId: string, expectedVersion: number): Promise<SafeManagedUser>;
  deactivate(actor: SafeUser, userId: string, expectedVersion: number): Promise<SafeManagedUser>;
  resetPassword(actor: SafeUser, userId: string, input: { expectedVersion: number; temporaryPassword: string }): Promise<SafeManagedUser>;
  listStaff(actor: SafeUser, status: StaffStatusFilter): Promise<StaffProfileSummary[]>;
  getOwnStaffProfile(actor: SafeUser): Promise<StaffProfileSummary>;
  getStaffProfile(actor: SafeUser, userId: string): Promise<StaffProfileSummary>;
  updateStaffProfile(actor: SafeUser, userId: string, input: UpdateStaffProfileInput): Promise<StaffProfileSummary>;
}
```

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/people-service.test.ts`  
Expected: FAIL because `PeopleService` is missing.

- [x] **Step 3: Implement minimal policy and stable errors**

Centralize only repeated checks (`requireAdmin`, `requireAdminOrManager`, organization concealment, version conflict). Insert canonical audit events in the same transaction. For profile updates, insert `STAFF_PROFILE_UPDATED` for title/phone/region changes and `STAFF_MANAGER_CHANGED` for manager changes; insert both when both categories change.

- [x] **Step 4: Verify GREEN and backend regression**

Run: `cd server && npm test -- --run tests/people-service.test.ts tests/job-card-service.test.ts tests/auth-service.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/people/service.ts server/tests/people-service.test.ts
git commit -m "feat: enforce people lifecycle policy"
```

---

## Checkpoint 04B — Auth Lifecycle Integration

### Task 4: Auth administration ports and mandatory-password guard

**Files:**
- Create: `server/src/modules/auth/admin-ports.ts`
- Modify: `server/src/modules/auth/types.ts`
- Modify: `server/src/modules/auth/repository.ts`
- Modify: `server/src/modules/auth/middleware.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `server/src/types/fastify.d.ts`
- Create: `server/tests/password-change-guard.test.ts`
- Modify: `server/tests/auth-service.test.ts`
- Modify: `server/tests/auth-routes.test.ts`

**Interfaces:**
- Produces `CredentialAdministrationPort`, `SessionRevocationPort`, `requirePasswordChanged`, version-aware `SafeUser`.
- Consumes existing `validatePassword`, `hashPassword`, and PostgreSQL transaction clients.

- [x] **Step 1: Write failing auth integration tests**

Prove: forced-change login succeeds; `/me`, `/change-password`, `/logout` remain allowed; domain routes return `403 PASSWORD_CHANGE_REQUIRED`; successful change clears the flag, increments user version, revokes every session, clears cookie, and requires fresh login.

Required middleware signature:

```ts
export function requirePasswordChanged() {
  return async function passwordChanged(request: FastifyRequest) {
    if (request.currentUser?.mustChangePassword) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 403, 'Devam etmek için parolanızı değiştirin.');
    }
  };
}
```

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/password-change-guard.test.ts tests/auth-service.test.ts tests/auth-routes.test.ts`  
Expected: FAIL on missing guard/ports/version behavior.

- [x] **Step 3: Implement the auth-owned ports**

```ts
export interface CredentialAdministrationPort {
  validatePassword(password: string): void;
  hashPassword(password: string): Promise<string>;
  resetTemporaryPassword(client: PoolClient, userId: string, expectedVersion: number, password: string): Promise<number | null>;
}

export interface SessionRevocationPort {
  revokeAllSessions(client: PoolClient, userId: string, revokedAt: Date): Promise<void>;
}
```

Add `version` and `isActive` to the safe authenticated user mapping needed by guards/UI. Ensure `LOGGER_REDACT_PATHS` later includes `req.body.temporaryPassword`. Keep auth change-password transaction-owned by auth and increment user version.

- [x] **Step 4: Verify GREEN**

Run: `cd server && npm test -- --run tests/password-change-guard.test.ts tests/auth-service.test.ts tests/auth-routes.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/auth server/src/types/fastify.d.ts server/tests/password-change-guard.test.ts server/tests/auth-service.test.ts server/tests/auth-routes.test.ts
git commit -m "feat: enforce mandatory password change"
```

---

## Checkpoint 04C — HTTP API

### Task 5: Exact People handlers and routes

**Files:**
- Create: `server/src/modules/people/handlers.ts`
- Create: `server/src/modules/people/routes.ts`
- Modify: `server/src/app.ts`
- Create: `server/tests/people-routes.test.ts`
- Modify: `server/tests/app.test.ts`
- Modify: `SERVORA_MED_API_DRAFT.md`

**Interfaces:**
- Produces the exact routes in the approved spec.
- Consumes `PeopleService`, `requireAuthentication`, `requirePasswordChanged`.

- [x] **Step 1: Write failing route acceptance tests**

Test safe DTOs, unknown-field rejection, integer `expectedVersion > 0`, Admin-only `/users`, Manager-only active Staff filtering, Staff-only `/staff/me`, cross-organization 404 concealment, each named command, and stable errors. Verify `temporaryPassword` never appears in response/log serialization.

Register exactly:

```ts
app.get('/users', ...);
app.post('/users', ...);
app.get('/users/:userId', ...);
app.patch('/users/:userId', ...);
app.post('/users/:userId/change-role', ...);
app.post('/users/:userId/activate', ...);
app.post('/users/:userId/deactivate', ...);
app.post('/users/:userId/reset-password', ...);
app.get('/staff', ...);
app.get('/staff/me', ...);
app.get('/staff/:userId', ...);
app.patch('/staff/:userId', ...);
```

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/people-routes.test.ts tests/app.test.ts`  
Expected: FAIL with 404/missing People dependencies.

- [x] **Step 3: Implement validation, handlers, routes, and wiring**

Extend dependencies without constructing hidden global state:

```ts
export type AppDependencies = {
  authRepository?: AuthRepository;
  jobCardRepository?: JobCardRepository;
  peopleRepository?: PeopleRepository;
};
```

Apply pre-handlers in this order: authentication, mandatory-password guard, handler-owned role policy. Add `req.body.temporaryPassword` to log redaction. Update API documentation and remove Manager `/users`, Staff ID-self access, timestamp concurrency, and generic activation PATCH language.

- [x] **Step 4: Verify GREEN and complete server checkpoint**

Run:

```bash
cd server && npm test -- --run tests/people-routes.test.ts tests/app.test.ts
cd server && npm test -- --run
cd server && npm run build
```

Expected: all server tests and build PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/modules/people server/tests/people-routes.test.ts server/tests/app.test.ts SERVORA_MED_API_DRAFT.md
git commit -m "feat: expose people API"
```

### Task 6: Development seed and live backend tracer

**Files:**
- Modify: `server/src/modules/auth/setup.ts`
- Modify: `server/tests/auth-setup.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces Staff profiles for development Admin/Manager/Staff users after migration `003`.
- Uses no production migration seed and refuses production as before.

- [x] **Step 1: Write failing setup tests**

Assert the development seed creates one Staff profile, assigns the demo Manager, and remains atomic; bootstrap Admin creates no Staff profile.

- [x] **Step 2: Verify RED**

Run: `cd server && npm test -- --run tests/auth-setup.test.ts`  
Expected: FAIL because seed does not create `staff_profiles`.

- [x] **Step 3: Extend the development seed minimally**

Insert the demo Staff profile in the existing organization/users transaction after user IDs are known. Do not insert People audit for development seed bootstrap data; document it as environment setup rather than an actor command.

- [x] **Step 4: Verify GREEN and disposable PostgreSQL**

Create `servora_med_slice04`, run migration and dev seed, then use HTTP requests to verify Admin creates a second Staff, forced-change guard, Staff `/me`, Manager Staff update, audit rows, and guarded deactivation. Record exact commands/results in the plan verification record and drop the database.

- [x] **Step 5: Commit**

```bash
git add server/src/modules/auth/setup.ts server/tests/auth-setup.test.ts README.md docs/superpowers/plans/2026-07-12-users-staff-profiles.md
git commit -m "test: verify people backend tracer"
```

**04C backend verification (2026-07-12):**

- Server regression: 23 files, 128 tests passed; TypeScript build passed.
- Disposable PostgreSQL: migrations `001`–`003` and development seed passed.
- Seed produced Admin, Manager, and Staff users plus one Staff profile assigned to the demo Manager.
- Real HTTP verified forced-password guard, Admin password change and fresh login, Staff creation, Staff forced password change, five zero-value counters, Manager Staff read/update, `MANAGER_HAS_ASSIGNED_STAFF`, eligible Staff deactivation, session revocation, and inactive login rejection.
- Audit inspection returned `USER_CREATED`, `STAFF_PROFILE_UPDATED`, and `USER_DEACTIVATED` for the tracer subject; credential material was absent.
- Local test server was stopped and `servora_med_slice04` was dropped.

---

## Checkpoint 04D — Frontend and Live Tracer

### Task 7: Runtime-validated People web client

**Files:**
- Create: `web/src/services/people-api.ts`
- Modify: `web/src/services/api.ts`
- Create: `web/tests/people-client.test.ts`

**Interfaces:**
- Produces typed list/detail/create/update/command functions and `changePassword`.
- Reuses exported `request`, `object`, `string`, `number`, `nullableString`, `items`, and `json`; make these exports without changing behavior.

- [x] **Step 1: Write failing client contract tests**

Define and validate:

```ts
export type ManagedUser = {
  id: string; organizationId: string; name: string; email: string;
  role: UserRole; mustChangePassword: boolean; isActive: boolean;
  version: number; lastLoginAt: string | null;
};
export type StaffCounters = {
  open: number; waitingApproval: number; revisionRequested: number;
  completedThisMonth: number; overdue: number;
};
export type StaffProfile = {
  id: string; user: ManagedUser; title: string | null; phone: string | null;
  region: string | null; managerUserId: string | null;
  managerName: string | null; version: number; counters: StaffCounters;
};
```

Test credentials included, malformed response rejection, named command URLs, and error propagation.

- [x] **Step 2: Verify RED**

Run: `cd web && npm test -- --run tests/people-client.test.ts`  
Expected: FAIL because `people-api.ts` is missing.

- [x] **Step 3: Implement minimal parsers and calls**

Include `listUsers`, `createUser`, `getUser`, `updateUser`, `changeUserRole`, `activateUser`, `deactivateUser`, `resetUserPassword`, `listStaff`, `getOwnStaffProfile`, `getStaffProfile`, `updateStaffProfile`, and `changePassword`.

- [x] **Step 4: Verify GREEN**

Run: `cd web && npm test -- --run tests/people-client.test.ts tests/auth-client.test.ts tests/tracer-client.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/services/api.ts web/src/services/people-api.ts web/tests/people-client.test.ts
git commit -m "feat: add people web client"
```

### Task 8: Forced password-change screen

**Files:**
- Create: `web/src/PasswordChange.tsx`
- Modify: `web/src/App.tsx`
- Create: `web/tests/password-change.test.tsx`
- Modify: `web/tests/App.test.tsx`

**Interfaces:**
- Produces `PasswordChangeScreen({ user, onChanged, onSignedOut })`.
- Consumes `changePassword` and never renders the protected workspace while forced change is active.

- [x] **Step 1: Write failing rendering and behavior tests**

Assert visible labels for current/new/confirm password, `autocomplete` values, mismatch validation before API call, alert focus target, pending state, successful cookie-clearing result, and no workspace data for `mustChangePassword: true`.

- [x] **Step 2: Verify RED**

Run: `cd web && npm test -- --run tests/password-change.test.tsx tests/App.test.tsx`  
Expected: FAIL because forced users currently render `ProtectedShell`.

- [x] **Step 3: Implement the isolated screen and App interception**

```tsx
if (user.mustChangePassword) {
  return <PasswordChangeScreen user={user} onChanged={() => setUser(null)} onSignedOut={() => setUser(null)} />;
}
```

Use existing field/error/button classes, focus the error summary, and require fresh login after success.

- [x] **Step 4: Verify GREEN**

Run: `cd web && npm test -- --run tests/password-change.test.tsx tests/App.test.tsx`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/PasswordChange.tsx web/src/App.tsx web/tests/password-change.test.tsx web/tests/App.test.tsx
git commit -m "feat: add mandatory password screen"
```

### Task 9: Admin user management

**Files:**
- Create: `web/src/UserManagement.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Create: `web/tests/user-management.test.tsx`

**Interfaces:**
- Produces `UserManagementScreen({ currentUser, onBack })` for Admin only.
- Consumes People client functions and exposes no Manager entry point.

- [x] **Step 1: Write failing Admin UI tests**

Cover loading/empty/retry, structured list, Staff-conditioned profile fields, explicit confirmation for deactivate/reset, allowed Admin↔Manager roles only, stable conflict messages, field-linked validation, and success announcements. Assert temporary password is absent after successful submit.

- [x] **Step 2: Verify RED**

Run: `cd web && npm test -- --run tests/user-management.test.tsx`  
Expected: FAIL because the screen is missing.

- [x] **Step 3: Implement list/create/detail command states**

Keep page state local:

```ts
type UserScreen =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; userId: string }
  | { kind: 'confirm'; action: 'deactivate' | 'reset-password'; userId: string };
```

Do not combine security commands in the general edit form. Preserve `expectedVersion` from the last backend response after every mutation.

- [x] **Step 4: Verify GREEN and responsive CSS contract**

Run: `cd web && npm test -- --run tests/user-management.test.tsx tests/accessibility-contract.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/UserManagement.tsx web/src/App.tsx web/src/styles.css web/tests/user-management.test.tsx web/tests/accessibility-contract.test.ts
git commit -m "feat: add admin user management"
```

### Task 10: Staff profile experiences

**Files:**
- Create: `web/src/StaffProfiles.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Create: `web/tests/staff-profiles.test.tsx`
- Modify: `web/tests/workspace-view.test.tsx`

**Interfaces:**
- Produces Manager/Admin `StaffDirectoryScreen` and Staff `OwnStaffProfileScreen`.
- Consumes only `/staff` APIs; Manager never calls `/users`.

- [x] **Step 1: Write failing role-specific tests**

Assert Staff sees five backend counters and no edit/navigation to others; Manager sees active Staff only and editable title/phone/region/manager; Admin can request inactive/all; notes are absent; conflict/retry/empty states are explicit.

- [x] **Step 2: Verify RED**

Run: `cd web && npm test -- --run tests/staff-profiles.test.tsx tests/workspace-view.test.tsx`  
Expected: FAIL because Staff profile screens are missing.

- [x] **Step 3: Implement role-aware People navigation**

Add compact shell navigation: `İşler`, Admin-only `Kullanıcılar`, Admin/Manager `Personel`, Staff-only `Profilim`. Keep current JobCard screen behavior intact and use buttons/landmarks, not drag/drop.

- [x] **Step 4: Verify GREEN and full web regression**

Run:

```bash
cd web && npm test -- --run tests/staff-profiles.test.tsx tests/workspace-view.test.tsx
cd web && npm test -- --run
cd web && npm run build
```

Expected: all web tests and build PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/StaffProfiles.tsx web/src/App.tsx web/src/styles.css web/tests/staff-profiles.test.tsx web/tests/workspace-view.test.tsx
git commit -m "feat: add staff profile workspaces"
```

### Task 11: Live browser tracer, documentation, and closeout

**Files:**
- Modify: `README.md`
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Modify: `SERVORA_MED_API_DRAFT.md`
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Modify: `docs/superpowers/plans/2026-07-12-users-staff-profiles.md`

**Interfaces:**
- Completes Slice 04 only; does not begin Slice 05.

- [ ] **Step 1: Run full automated verification**

```bash
cd server && npm test -- --run
cd server && npm run build
cd server && npm audit --omit=dev
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --omit=dev
```

Expected: every command exits 0 and both audits report 0 vulnerabilities.

- [ ] **Step 2: Run disposable PostgreSQL tracer**

Verify migration → seed → Admin create Staff → forced login/change/fresh login → five counters → Manager profile update → lifecycle guards → eligible deactivate → revoked session/login rejection → audit inspection. Drop the database afterward.

- [ ] **Step 3: Run Playwright MCP acceptance**

At 390×844 CSS px verify Admin create/detail/commands, forced password screen, Staff own profile, Manager profile update, keyboard-only activation, visible focus, ≥44 CSS px primary targets, no horizontal overflow, 200% text size, 320 CSS px effective 400% reflow, reduced motion, and semantic accessibility snapshots.

- [ ] **Step 4: Security and scope scans**

```bash
rg -n -i 'restaurant|menu_item|sessionStorage|localStorage|Bearer ' server/src web/src
rg -n 'temporaryPassword|passwordHash|tokenHash|sessionToken' server/src/modules/people
rg -n 'notes|monthly_target|expectedUpdatedAt' server/src/modules/people web/src/UserManagement.tsx web/src/StaffProfiles.tsx
git diff --check
```

Expected: no forbidden domain/storage/concurrency terms; credential identifiers occur only in typed credential-port calls and redaction tests, never audit payload construction.

- [ ] **Step 5: Update canonical docs and verification record**

Mark only proven acceptance criteria complete. Record exact test totals, builds, audits, PostgreSQL flow, Playwright checks, and any residual risk. Ensure API/schema drafts match named commands, version fields, audit, filters, five counters, and removed notes.

- [ ] **Step 6: Refresh Codebase Memory and commit**

Reindex `server/` and `web/`, confirm clean generated artifacts, then:

```bash
git add README.md SERVORA_MED_MVP_SLICES.md SERVORA_MED_API_DRAFT.md SERVORA_MED_SCHEMA_DRAFT.md docs/superpowers/plans/2026-07-12-users-staff-profiles.md
git commit -m "docs: close users and staff profiles slice"
git status --short --branch
```

Expected: clean worktree. Do not push without explicit authorization.
