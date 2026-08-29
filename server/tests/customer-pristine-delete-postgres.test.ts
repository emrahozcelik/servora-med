import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const HISTORICAL_STATUSES = ['NEW', 'COMPLETED', 'CANCELLED', 'INVALIDATED'] as const;

afterAll(async () => { await adminPool?.end(); });

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>) {
  const schema = `customer_pristine_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
      logger: { info() {}, error() {} },
    });
    await run(pool);
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function createFixture(pool: Pool) {
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('Customer pristine test') RETURNING id`,
  );
  const organizationId = organization.rows[0]!.id;
  const users = await Promise.all([
    ['Admin', 'ADMIN'], ['Manager', 'MANAGER'], ['Staff', 'STAFF'],
  ].map(async ([name, role]) => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
      [organizationId, `${name}-${randomUUID()}@test.local`, `${name}-${randomUUID()}@test.local`, role],
    );
    return { name, id: result.rows[0]!.id };
  }));
  return {
    organizationId,
    adminId: users.find((user) => user.name === 'Admin')!.id,
    managerId: users.find((user) => user.name === 'Manager')!.id,
    staffId: users.find((user) => user.name === 'Staff')!.id,
  };
}

async function createCustomer(pool: Pool, organizationId: string, name: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  );
  return result.rows[0]!.id;
}

async function createContact(pool: Pool, organizationId: string, customerId: string, name: string, isPrimary: boolean) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, customerId, name, isPrimary],
  );
  return result.rows[0]!.id;
}

async function createJobCard(
  pool: Pool,
  organizationId: string,
  customerId: string,
  assignedTo: string,
  createdBy: string,
  status: 'NEW' | 'COMPLETED' | 'CANCELLED' | 'INVALIDATED',
) {
  const timestamp = new Date('2026-08-29T10:00:00Z');
  const completed = status === 'COMPLETED';
  const cancelled = status === 'CANCELLED';
  const invalidated = status === 'INVALIDATED';
  await pool.query(
    `INSERT INTO job_cards (
       organization_id, type, status, title, customer_id, assigned_to, created_by,
       started_at, staff_completed_at, staff_completed_by,
       manager_approved_at, manager_approved_by,
       cancelled_at, cancelled_by, cancel_reason,
       invalidated_at, invalidated_by, invalidation_reason_code
     ) VALUES (
       $1, 'GENERAL_TASK', $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
     )`,
    [
      organizationId, status, `${status} customer history`, customerId, assignedTo, createdBy,
      completed ? timestamp : null, completed ? timestamp : null, completed ? assignedTo : null,
      completed ? timestamp : null, completed ? createdBy : null,
      cancelled ? timestamp : null, cancelled ? createdBy : null, cancelled ? 'test history' : null,
      invalidated ? timestamp : null, invalidated ? createdBy : null, invalidated ? 'CREATED_BY_MISTAKE' : null,
    ],
  );
}

describe.skipIf(!databaseUrl)('Customer pristine delete PostgreSQL contract', () => {
  it('rejects Manager and Staff hard-delete before touching a pristine Customer', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, 'Protected Clinic');
      await createContact(pool, fixture.organizationId, customerId, 'Protected Contact', true);
      const crm = new CrmService(new PostgresCrmRepository(pool));

      for (const actor of [
        { id: fixture.managerId, organizationId: fixture.organizationId, role: 'MANAGER' as const },
        { id: fixture.staffId, organizationId: fixture.organizationId, role: 'STAFF' as const },
      ]) {
        await expect(crm.deleteCustomer(actor, customerId, 1)).rejects.toMatchObject({
          code: 'FORBIDDEN', statusCode: 403,
        });
      }

      const customerStillExists = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, customerId],
      );
      const contactsStillExist = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND customer_id=$2`,
        [fixture.organizationId, customerId],
      );
      const deleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CUSTOMER' AND subject_id=$2 AND event_type='CUSTOMER_DELETED'`,
        [fixture.organizationId, customerId],
      );
      expect(customerStillExists.rows[0]!.count).toBe('1');
      expect(contactsStillExist.rows[0]!.count).toBe('1');
      expect(deleteAudits.rows[0]!.count).toBe('0');
    });
  });

  it('hard-deletes a pristine Customer with Contacts as one audited cascade', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, 'Pristine Clinic');
      const contactIds = await Promise.all([
        createContact(pool, fixture.organizationId, customerId, 'Dr. Primary', true),
        createContact(pool, fixture.organizationId, customerId, 'Dr. Secondary', false),
      ]);
      await pool.query(
        `INSERT INTO audit_events (organization_id, actor_user_id, subject_type, subject_id, event_type)
         VALUES ($1, $2, 'CUSTOMER', $3, 'CUSTOMER_CREATED')`,
        [fixture.organizationId, fixture.adminId, customerId],
      );
      const unrelatedCustomerId = await createCustomer(pool, fixture.organizationId, 'Unrelated Clinic');
      const unrelatedContactId = await createContact(pool, fixture.organizationId, unrelatedCustomerId, 'Unrelated Contact', true);
      for (const contactId of contactIds) {
        await pool.query(
          `INSERT INTO audit_events (organization_id, actor_user_id, subject_type, subject_id, event_type)
           VALUES ($1, $2, 'CONTACT', $3, 'CONTACT_CREATED')`,
          [fixture.organizationId, fixture.adminId, contactId],
        );
      }

      const crm = new CrmService(new PostgresCrmRepository(pool));
      await expect(crm.deleteCustomer(
        { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' },
        customerId,
        1,
      )).resolves.toBeUndefined();

      const remainingCustomer = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, customerId],
      );
      const remainingContacts = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND customer_id=$2`,
        [fixture.organizationId, customerId],
      );
      const customerDeleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CUSTOMER' AND subject_id=$2 AND event_type='CUSTOMER_DELETED'`,
        [fixture.organizationId, customerId],
      );
      const cascadeContactDeleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CONTACT' AND subject_id=ANY($2::uuid[]) AND event_type='CONTACT_DELETED'`,
        [fixture.organizationId, contactIds],
      );
      const priorContactAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CONTACT' AND subject_id=ANY($2::uuid[]) AND event_type='CONTACT_CREATED'`,
        [fixture.organizationId, contactIds],
      );
      const unrelatedContact = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, unrelatedContactId],
      );

      expect(remainingCustomer.rows[0]!.count).toBe('0');
      expect(remainingContacts.rows[0]!.count).toBe('0');
      expect(customerDeleteAudits.rows[0]!.count).toBe('1');
      expect(cascadeContactDeleteAudits.rows[0]!.count).toBe('0');
      expect(priorContactAudits.rows[0]!.count).toBe('2');
      expect(unrelatedContact.rows[0]!.count).toBe('1');
    });
  });

  it.each(HISTORICAL_STATUSES)('blocks Admin hard-delete for %s Customer history', async (status) => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, `${status} History Clinic`);
      await createContact(pool, fixture.organizationId, customerId, 'Historical Contact', true);
      await createJobCard(pool, fixture.organizationId, customerId, fixture.staffId, fixture.adminId, status);
      const crm = new CrmService(new PostgresCrmRepository(pool));

      await expect(crm.deleteCustomer(
        { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' },
        customerId,
        1,
      )).rejects.toMatchObject({
        code: 'CUSTOMER_HAS_OPERATION_HISTORY', statusCode: 409,
      });

      const customerStillExists = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, customerId],
      );
      const contactsStillExist = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND customer_id=$2`,
        [fixture.organizationId, customerId],
      );
      const deleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CUSTOMER' AND subject_id=$2 AND event_type='CUSTOMER_DELETED'`,
        [fixture.organizationId, customerId],
      );
      expect(customerStillExists.rows[0]!.count).toBe('1');
      expect(contactsStillExist.rows[0]!.count).toBe('1');
      expect(deleteAudits.rows[0]!.count).toBe('0');
    });
  });

  it('keeps Customer and Contacts intact and emits no audit on a stale delete version', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, 'Stale Version Clinic');
      await createContact(pool, fixture.organizationId, customerId, 'Stale Contact', true);
      const crm = new CrmService(new PostgresCrmRepository(pool));

      await expect(crm.deleteCustomer(
        { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' },
        customerId,
        99,
      )).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });

      const customerStillExists = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, customerId],
      );
      const contactsStillExist = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND customer_id=$2`,
        [fixture.organizationId, customerId],
      );
      const deleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CUSTOMER' AND subject_id=$2 AND event_type='CUSTOMER_DELETED'`,
        [fixture.organizationId, customerId],
      );
      expect(customerStillExists.rows[0]!.count).toBe('1');
      expect(contactsStillExist.rows[0]!.count).toBe('1');
      expect(deleteAudits.rows[0]!.count).toBe('0');
    });
  });

  it('rolls back the Contact cascade when CUSTOMER_DELETED audit insertion fails', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, 'Audit Failure Clinic');
      await createContact(pool, fixture.organizationId, customerId, 'Rollback Contact', true);
      await pool.query(`
        CREATE FUNCTION fail_customer_delete_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'CUSTOMER_DELETED' THEN
            RAISE EXCEPTION 'customer deletion audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER fail_customer_delete_audit_trigger
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fail_customer_delete_audit();
      `);
      const crm = new CrmService(new PostgresCrmRepository(pool));

      await expect(crm.deleteCustomer(
        { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' },
        customerId,
        1,
      )).rejects.toThrow('customer deletion audit failure');

      const customerStillExists = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [fixture.organizationId, customerId],
      );
      const contactsStillExist = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE organization_id=$1 AND customer_id=$2`,
        [fixture.organizationId, customerId],
      );
      const deleteAudits = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_type='CUSTOMER' AND subject_id=$2 AND event_type='CUSTOMER_DELETED'`,
        [fixture.organizationId, customerId],
      );
      expect(customerStillExists.rows[0]!.count).toBe('1');
      expect(contactsStillExist.rows[0]!.count).toBe('1');
      expect(deleteAudits.rows[0]!.count).toBe('0');
    });
  });

  it('keeps cross-organization Customer detail and delete opaque', async () => {
    await withIsolatedDatabase(async (pool) => {
      const first = await createFixture(pool);
      const second = await createFixture(pool);
      const customerId = await createCustomer(pool, second.organizationId, 'Other Organization Clinic');
      const crm = new CrmService(new PostgresCrmRepository(pool));
      const actor = { id: first.adminId, organizationId: first.organizationId, role: 'ADMIN' as const };

      await expect(crm.getCustomer(actor, customerId)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
      await expect(crm.deleteCustomer(actor, customerId, 1)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });

      const targetStillExists = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id=$1 AND id=$2`,
        [second.organizationId, customerId],
      );
      expect(targetStillExists.rows[0]!.count).toBe('1');
    });
  });

  it('rechecks Customer dependencies after a stale pristine detail read', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const customerId = await createCustomer(pool, fixture.organizationId, 'Dependency Race Clinic');
      await createContact(pool, fixture.organizationId, customerId, 'Race Contact', true);
      const crm = new CrmService(new PostgresCrmRepository(pool));
      const actor = { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' as const };

      const detail = await crm.getCustomer(actor, customerId);
      expect(detail.hasOperationHistory).toBe(false);
      await createJobCard(pool, fixture.organizationId, customerId, fixture.staffId, fixture.adminId, 'NEW');

      await expect(crm.deleteCustomer(actor, customerId, detail.version)).rejects.toMatchObject({
        code: 'CUSTOMER_HAS_OPERATION_HISTORY', statusCode: 409,
      });
      const retained = await pool.query<{ customer_count: string; contact_count: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM customers WHERE organization_id=$1 AND id=$2) AS customer_count,
           (SELECT COUNT(*)::text FROM contacts WHERE organization_id=$1 AND customer_id=$2) AS contact_count`,
        [fixture.organizationId, customerId],
      );
      expect(retained.rows[0]).toEqual({ customer_count: '1', contact_count: '1' });
    });
  });

  it('derives Customer operation history independently from open and completed counts', async () => {
    await withIsolatedDatabase(async (pool) => {
      const fixture = await createFixture(pool);
      const crm = new CrmService(new PostgresCrmRepository(pool), new PostgresJobCardRepository(pool));
      const actor = { id: fixture.adminId, organizationId: fixture.organizationId, role: 'ADMIN' as const };
      const cases = [
        { status: null, open: 0, completed: 0 },
        { status: 'NEW' as const, open: 1, completed: 0 },
        { status: 'COMPLETED' as const, open: 0, completed: 1 },
        { status: 'CANCELLED' as const, open: 0, completed: 0 },
        { status: 'INVALIDATED' as const, open: 0, completed: 0 },
      ];

      for (const testCase of cases) {
        const customerId = await createCustomer(pool, fixture.organizationId, `Signal ${testCase.status ?? 'EMPTY'}`);
        if (testCase.status) {
          await createJobCard(pool, fixture.organizationId, customerId, fixture.staffId, fixture.adminId, testCase.status);
        }
        const detail = await crm.getCustomer(actor, customerId);
        expect(detail.hasOperationHistory).toBe(testCase.status !== null);
        expect(detail.openJobCount).toBe(testCase.open);
        expect(detail.completedJobCount).toBe(testCase.completed);
      }
    });
  });
});
