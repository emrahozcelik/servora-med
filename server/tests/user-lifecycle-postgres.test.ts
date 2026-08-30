import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresSessionRevocationPort } from '../src/modules/auth/admin-ports.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PeopleService } from '../src/modules/people/service.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const temporaryDirectories: string[] = [];
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => {
  await adminPool?.end();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createMigrationSubset(maxVersion: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-user-lifecycle-'));
  temporaryDirectories.push(directory);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql') && Number.parseInt(file.slice(0, 3), 10) <= maxVersion)
    .sort();
  for (const file of files) {
    await writeFile(path.join(directory, file), await readFile(path.join(migrationsDirectory, file)), 'utf8');
  }
  return directory;
}

async function withIsolatedDatabase(
  run: (pool: Pool, store: PostgresMigrationStore) => Promise<void>,
  migrationPath = migrationsDirectory,
) {
  const schema = `user_lifecycle_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  const store = new PostgresMigrationStore(pool);

  try {
    await run(pool, store);
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function createOrganization(pool: Pool, name: string) {
  return (await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id', [name],
  )).rows[0]!.id;
}

async function createUser(
  pool: Pool,
  organizationId: string,
  role: SafeUser['role'],
  options: { active?: boolean; dataClass?: 'BUSINESS' | 'DEMO'; name?: string } = {},
): Promise<SafeUser> {
  const row = (await pool.query<SafeUser>(
    `INSERT INTO users (
       organization_id, name, email, password_hash, role, is_active, data_class
     ) VALUES ($1, $2, $3, 'u3-test-hash', $4, $5, $6)
     RETURNING id, organization_id AS "organizationId", name, email, role,
       must_change_password AS "mustChangePassword", is_active AS "isActive", version`,
    [organizationId, options.name ?? `${role}-${randomUUID()}`, `${randomUUID()}@u3.test`, role,
      options.active ?? true, options.dataClass ?? 'BUSINESS'],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'U3 test staff')`,
      [organizationId, row.id],
    );
  }
  return row;
}

async function createService(pool: Pool) {
  const repository = new PostgresPeopleRepository(
    pool,
    { validatePassword() {}, hashPassword: async () => 'unused' },
    new PostgresSessionRevocationPort(),
  );
  return new PeopleService(
    repository,
    { validatePassword() {}, hashPassword: async () => 'unused' },
    {} as never,
    () => new Date('2026-08-30T10:00:00.000Z'),
  );
}

async function createTechnicalRows(pool: Pool, organizationId: string, userId: string) {
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
     VALUES ($1, repeat('a', 64), '2099-01-01T00:00:00Z', '2026-08-30T09:00:00Z')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO processed_actions (
       organization_id, user_id, client_action_id, operation_key, status
     ) VALUES ($1, $2, 'u3-action', 'u3-delete-test', 'processing')`,
    [organizationId, userId],
  );
  await pool.query(
    `INSERT INTO audit_events (
       organization_id, actor_user_id, subject_type, subject_id, event_type,
       old_value, new_value, metadata
     ) VALUES ($1, $2, 'USER', $2, 'USER_CREATED', NULL, $3, '{}'::jsonb)`,
    [organizationId, userId, { role: 'STAFF' }],
  );
}

describe.skipIf(!databaseUrl)('User/Staff lifecycle PostgreSQL acceptance', () => {
  it('runs 0→041 and permanently deletes a pristine Staff atomically', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const migrationResult = await runMigrations({
        migrationsDirectory,
        store,
        logger: { info() {}, error() {} },
      });
      expect(migrationResult.appliedVersions).toHaveLength(41);
      expect(migrationResult.appliedVersions.at(-1)).toBe('041_user_lifecycle_reconciliation');

      const organizationId = await createOrganization(pool, 'U3 deletion organization');
      const otherOrganizationId = await createOrganization(pool, 'U3 other organization');
      const admin = await createUser(pool, organizationId, 'ADMIN', { name: 'U3 Admin' });
      const target = await createUser(pool, organizationId, 'STAFF', { name: 'U3 Disposable Staff' });
      const raceTarget = await createUser(pool, organizationId, 'STAFF', { name: 'U3 Race Staff' });
      const pristineManager = await createUser(pool, organizationId, 'MANAGER', { name: 'U3 Disposable Manager' });
      const secondAdmin = await createUser(pool, organizationId, 'ADMIN', { name: 'U3 Disposable Admin' });
      const otherTenantTarget = await createUser(pool, otherOrganizationId, 'STAFF');
      await createTechnicalRows(pool, organizationId, target.id);

      const preservedCustomer = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Preserved clinic', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;

      const service = await createService(pool);
      await expect(service.getUser(admin, target.id)).resolves.toMatchObject({
        canPermanentlyDelete: true,
        permanentDeleteBlockers: [],
      });

      // The detail response is informational. A new responsibility appearing
      // after that response must be caught by the execution-time recheck.
      await expect(service.getUser(admin, raceTarget.id)).resolves.toMatchObject({
        canPermanentlyDelete: true,
        permanentDeleteBlockers: [],
      });
      const raceCustomer = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
         VALUES ($1, 'Race clinic', 'clinic', 'active', $2) RETURNING id`,
        [organizationId, raceTarget.id],
      )).rows[0]!.id;
      await expect(service.deleteUser(admin, raceTarget.id, raceTarget.version)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
      });
      await expect(pool.query('SELECT id FROM users WHERE id = $1', [raceTarget.id]))
        .resolves.toMatchObject({ rows: [{ id: raceTarget.id }] });
      await expect(pool.query('SELECT id FROM customers WHERE id = $1', [raceCustomer]))
        .resolves.toMatchObject({ rows: [{ id: raceCustomer }] });

      await service.deleteUser(admin, pristineManager.id, pristineManager.version);
      await service.deleteUser(admin, secondAdmin.id, secondAdmin.version);

      await service.deleteUser(admin, target.id, target.version);

      await expect(pool.query('SELECT id FROM users WHERE id = $1', [target.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query('SELECT id FROM users WHERE id = $1', [pristineManager.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query('SELECT id FROM users WHERE id = $1', [secondAdmin.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query('SELECT id FROM staff_profiles WHERE user_id = $1', [target.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query('SELECT id FROM sessions WHERE user_id = $1', [target.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query('SELECT id FROM processed_actions WHERE user_id = $1', [target.id]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query(
        `SELECT actor_user_id, actor_user_id_snapshot
           FROM audit_events
          WHERE subject_id = $1 AND event_type = 'USER_CREATED'`,
        [target.id],
      )).resolves.toMatchObject({ rows: [{ actor_user_id: null, actor_user_id_snapshot: target.id }] });
      await expect(pool.query(
        `SELECT event_type, actor_user_id, old_value, new_value, metadata
           FROM audit_events
          WHERE subject_id = $1 AND event_type = 'USER_DELETED'`,
        [target.id],
      )).resolves.toMatchObject({
        rows: [{
          event_type: 'USER_DELETED', actor_user_id: admin.id, new_value: null,
          metadata: { deletionMode: 'PERMANENT' },
        }],
      });
      await expect(pool.query('SELECT id FROM customers WHERE id = $1', [preservedCustomer]))
        .resolves.toMatchObject({ rows: [{ id: preservedCustomer }] });

      await expect(service.deleteUser(admin, otherTenantTarget.id)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
      });
      await expect(pool.query('SELECT id FROM users WHERE id = $1', [otherTenantTarget.id]))
        .resolves.toMatchObject({ rows: [{ id: otherTenantTarget.id }] });
    });
  });

  it('blocks business history, active responsibility, and manager-report deletion', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      await runMigrations({ migrationsDirectory, store, logger: { info() {}, error() {} } });
      const organizationId = await createOrganization(pool, 'U3 blocker organization');
      const admin = await createUser(pool, organizationId, 'ADMIN');
      const historyTarget = await createUser(pool, organizationId, 'STAFF');
      const assignedTarget = await createUser(pool, organizationId, 'STAFF');
      const managerTarget = await createUser(pool, organizationId, 'MANAGER');
      const report = await createUser(pool, organizationId, 'STAFF');
      const jobHistoryTarget = await createUser(pool, organizationId, 'STAFF');
      const messageHistoryTarget = await createUser(pool, organizationId, 'STAFF');
      const calendarHistoryTarget = await createUser(pool, organizationId, 'STAFF');

      await pool.query(
        `INSERT INTO audit_events (
           organization_id, actor_user_id, subject_type, subject_id, event_type, metadata
         ) VALUES ($1, $2, 'USER', $2, 'USER_OFFBOARDED', '{}'::jsonb)`,
        [organizationId, historyTarget.id],
      );
      await pool.query(
        `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
         VALUES ($1, 'Assigned clinic', 'clinic', 'active', $2)`,
        [organizationId, assignedTarget.id],
      );
      await pool.query(
        `UPDATE staff_profiles SET manager_user_id = $2
         WHERE organization_id = $1 AND user_id = $3`,
        [organizationId, managerTarget.id, report.id],
      );
      await pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Historical creator job', $2, $3)`,
        [organizationId, admin.id, jobHistoryTarget.id],
      );
      const conversation = (await pool.query<{ id: string }>(
        `INSERT INTO conversations (organization_id, direct_key, context_type)
         VALUES ($1, $2, 'GENERAL') RETURNING id`,
        [organizationId, `u3-history-${randomUUID()}`],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO messages (
           conversation_id, organization_id, sender_user_id, client_action_id, body
         ) VALUES ($1, $2, $3, 'u3-history-message', 'Historical message')`,
        [conversation, organizationId, messageHistoryTarget.id],
      );
      await pool.query(
        `INSERT INTO calendar_events (
           organization_id, assigned_user_id, title, starts_at, ends_at,
           timezone, created_by, updated_by
         ) VALUES ($1, $2, 'Historical calendar event', $3, $4, 'Europe/Istanbul', $5, $2)`,
        [organizationId, admin.id, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', calendarHistoryTarget.id],
      );

      const service = await createService(pool);
      await expect(service.getUser(admin, historyTarget.id)).resolves.toMatchObject({
        canPermanentlyDelete: false,
        permanentDeleteBlockers: ['HAS_BUSINESS_HISTORY'],
      });
      await expect(service.deleteUser(admin, historyTarget.id)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        details: { blockers: ['HAS_BUSINESS_HISTORY'] },
      });
      await expect(service.getUser(admin, assignedTarget.id)).resolves.toMatchObject({
        canPermanentlyDelete: false,
        permanentDeleteBlockers: ['HAS_ACTIVE_RESPONSIBILITIES'],
      });
      await expect(service.deleteUser(admin, assignedTarget.id)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        details: { blockers: ['HAS_ACTIVE_RESPONSIBILITIES'] },
      });
      await expect(service.getUser(admin, managerTarget.id)).resolves.toMatchObject({
        canPermanentlyDelete: false,
        permanentDeleteBlockers: ['HAS_ACTIVE_RESPONSIBILITIES'],
      });
      await expect(service.deleteUser(admin, managerTarget.id)).rejects.toMatchObject({
        code: 'USER_PERMANENT_DELETE_BLOCKED',
        details: { blockers: ['HAS_ACTIVE_RESPONSIBILITIES'] },
      });
      for (const target of [jobHistoryTarget, messageHistoryTarget, calendarHistoryTarget]) {
        await expect(service.getUser(admin, target.id)).resolves.toMatchObject({
          canPermanentlyDelete: false,
          permanentDeleteBlockers: ['HAS_BUSINESS_HISTORY'],
        });
        await expect(service.deleteUser(admin, target.id)).rejects.toMatchObject({
          code: 'USER_PERMANENT_DELETE_BLOCKED',
          details: { blockers: ['HAS_BUSINESS_HISTORY'] },
        });
      }
      await expect(pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
        [historyTarget.id, assignedTarget.id, managerTarget.id,
          jobHistoryTarget.id, messageHistoryTarget.id, calendarHistoryTarget.id],
      ])).resolves.toMatchObject({ rows: expect.arrayContaining([
        { id: historyTarget.id }, { id: assignedTarget.id }, { id: managerTarget.id },
        { id: jobHistoryTarget.id }, { id: messageHistoryTarget.id }, { id: calendarHistoryTarget.id },
      ]) });
    });
  });

  it('serializes concurrent Admin deletes so one active Admin always remains', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      await runMigrations({ migrationsDirectory, store, logger: { info() {}, error() {} } });
      const organizationId = await createOrganization(pool, 'U3 Admin race organization');
      const adminA = await createUser(pool, organizationId, 'ADMIN', { name: 'U3 Admin A' });
      const adminB = await createUser(pool, organizationId, 'ADMIN', { name: 'U3 Admin B' });
      const service = await createService(pool);

      const results = await Promise.allSettled([
        service.deleteUser(adminA, adminB.id, adminB.version),
        service.deleteUser(adminB, adminA.id, adminA.version),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'LAST_ACTIVE_ADMIN_REQUIRED' });

      await expect(pool.query(
        `SELECT COUNT(*)::int AS count FROM users
          WHERE organization_id = $1 AND role = 'ADMIN' AND is_active = TRUE`,
        [organizationId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_events
          WHERE organization_id = $1 AND event_type = 'USER_DELETED'`,
        [organizationId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    });
  });

  it('upgrades 040→041 without changing existing business rows', async () => {
    const baselineDirectory = await createMigrationSubset(40);
    await withIsolatedDatabase(async (pool, store) => {
      const baseline = await runMigrations({
        migrationsDirectory: baselineDirectory,
        store,
        logger: { info() {}, error() {} },
      });
      expect(baseline.appliedVersions.at(-1)).toBe('040_demo_lifecycle_simplification');

      const organizationId = await createOrganization(pool, 'U3 upgrade organization');
      const admin = await createUser(pool, organizationId, 'ADMIN');
      const customer = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Existing clinic', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;

      const upgrade = await runMigrations({
        migrationsDirectory,
        store,
        logger: { info() {}, error() {} },
      });
      expect(upgrade.appliedVersions).toEqual(['041_user_lifecycle_reconciliation']);
      await expect(pool.query('SELECT id, name FROM customers WHERE id = $1', [customer]))
        .resolves.toMatchObject({ rows: [{ id: customer, name: 'Existing clinic' }] });
      await expect(pool.query(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'audit_events_event_type_check'
            AND connamespace = current_schema()::regnamespace`,
      )).resolves.toMatchObject({ rows: [{ definition: expect.stringContaining('USER_DELETED') }] });
      expect(admin.id).toBeTruthy();
    });
  });
});
