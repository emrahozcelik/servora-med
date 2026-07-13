import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const applicationName = `servora_crm_concurrency_${process.pid}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, application_name: applicationName }) : null;

afterAll(async () => { await pool?.end(); });

async function waitForBlockedProductionQueries(minimum: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_stat_activity
       WHERE application_name=$1 AND wait_event_type='Lock'`, [applicationName],
    );
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} blocked production queries`);
}

async function bounded<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent production flows timed out')), 2_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

describe.skipIf(!databaseUrl)('CRM and JobCard PostgreSQL lock protocol', () => {
  it('preserves active-reference invariants under concurrent create and deactivation', async () => {
    const organizationId = randomUUID();
    const staffId = randomUUID();
    const managerId = randomUUID();
    const customerId = randomUUID();
    const contactId = randomUUID();
    const blocker: PoolClient = await pool!.connect();
    const crm = new CrmService(new PostgresCrmRepository(pool!));
    const jobs = new JobCardService(new PostgresJobCardRepository(pool!));
    const staff = { id: staffId, organizationId, role: 'STAFF' as const };
    const manager = { id: managerId, organizationId, role: 'MANAGER' as const };

    await pool!.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Concurrency Test')`, [organizationId]);
    await pool!.query(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES
       ($1,$3,'Staff',$4,'test-hash','STAFF'),
       ($2,$3,'Manager',$5,'test-hash','MANAGER')`,
      [staffId, managerId, organizationId, `${staffId}@test.local`, `${managerId}@test.local`],
    );
    await pool!.query(
      `INSERT INTO customers (id, organization_id, name, customer_type, status)
       VALUES ($1,$2,'Test Clinic','clinic','active')`, [customerId, organizationId],
    );
    await pool!.query(
      `INSERT INTO contacts (id, organization_id, customer_id, name, is_primary)
       VALUES ($1,$2,$3,'Dr. Test',TRUE)`, [contactId, organizationId, customerId],
    );

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
      const customerRace = Promise.allSettled([
        jobs.create(staff, {
          clientActionId: `customer-race-${randomUUID()}`, type: 'PRODUCT_DELIVERY',
          title: 'Customer race', customerId, assignedTo: staffId,
        }),
        crm.deactivateCustomer(manager, customerId, 1),
      ]);
      await waitForBlockedProductionQueries(2);
      await blocker.query('COMMIT');
      const customerResults = await bounded(customerRace);
      expect(customerResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const customerInvariant = await pool!.query<{ invalid: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM customers c JOIN job_cards j
             ON j.organization_id=c.organization_id AND j.customer_id=c.id
           WHERE c.id=$1 AND c.status='inactive'
             AND j.status IN ('NEW','PLANNED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')
         ) AS invalid`, [customerId],
      );
      expect(customerInvariant.rows[0]!.invalid).toBe(false);

      await pool!.query('DELETE FROM job_card_activity_logs WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM job_cards WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM processed_actions WHERE organization_id=$1', [organizationId]);
      await pool!.query(`UPDATE customers SET status='active', version=1 WHERE id=$1`, [customerId]);
      await pool!.query(`UPDATE contacts SET is_active=TRUE, is_primary=TRUE, version=1 WHERE id=$1`, [contactId]);

      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
      const contactRace = Promise.allSettled([
        jobs.create(staff, {
          clientActionId: `contact-race-${randomUUID()}`, type: 'PRODUCT_DELIVERY',
          title: 'Contact race', customerId, contactId, assignedTo: staffId,
        }),
        crm.deactivateContact(manager, customerId, contactId, 1),
      ]);
      await waitForBlockedProductionQueries(2);
      await blocker.query('COMMIT');
      const contactResults = await bounded(contactRace);
      expect(contactResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const contactInvariant = await pool!.query<{ invalid: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM contacts contact JOIN job_cards j
             ON j.organization_id=contact.organization_id AND j.contact_id=contact.id
           WHERE contact.id=$1 AND contact.is_active=FALSE
             AND j.status IN ('NEW','PLANNED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')
         ) AS invalid`, [contactId],
      );
      expect(contactInvariant.rows[0]!.invalid).toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await pool!.query('DELETE FROM job_card_activity_logs WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM job_cards WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM processed_actions WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM audit_events WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM contacts WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM customers WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    }
  });
});
