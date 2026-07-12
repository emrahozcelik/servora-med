import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => { await pool?.end(); });

describe.skipIf(!databaseUrl)('CRM and JobCard PostgreSQL lock protocol', () => {
  it('serializes Customer and Contact deactivation behind reference locks without deadlock', async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const customerId = randomUUID();
    const contactId = randomUUID();
    await pool!.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Concurrency Test')`, [organizationId]);
    await pool!.query(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role)
       VALUES ($1,$2,'Staff',$3,'test-hash','STAFF')`,
      [userId, organizationId, `${userId}@test.local`],
    );
    await pool!.query(
      `INSERT INTO customers (id, organization_id, name, customer_type, status)
       VALUES ($1,$2,'Test Clinic','clinic','active')`, [customerId, organizationId],
    );
    await pool!.query(
      `INSERT INTO contacts (id, organization_id, customer_id, name, is_primary)
       VALUES ($1,$2,$3,'Dr. Test',TRUE)`, [contactId, organizationId, customerId],
    );

    const first = await pool!.connect();
    const second = await pool!.connect();
    try {
      await first.query('BEGIN');
      await first.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      await first.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
      await first.query('SELECT id FROM contacts WHERE id=$1 FOR UPDATE', [contactId]);

      await second.query('BEGIN');
      await second.query(`SET LOCAL lock_timeout = '2s'`);
      let customerSettled = false;
      const customerUpdate = second.query(
        `UPDATE customers SET status='inactive' WHERE id=$1`, [customerId],
      ).then(() => { customerSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(customerSettled).toBe(false);
      await first.query('COMMIT');
      await customerUpdate;
      await second.query('ROLLBACK');

      await first.query('BEGIN');
      await first.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
      await first.query('SELECT id FROM contacts WHERE id=$1 FOR UPDATE', [contactId]);
      await second.query('BEGIN');
      await second.query(`SET LOCAL lock_timeout = '2s'`);
      let contactSettled = false;
      const contactUpdate = second.query(
        `UPDATE contacts SET is_active=FALSE WHERE id=$1`, [contactId],
      ).then(() => { contactSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(contactSettled).toBe(false);
      await first.query('COMMIT');
      await contactUpdate;
      await second.query('COMMIT');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release(); second.release();
      await pool!.query('DELETE FROM contacts WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM customers WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
      await pool!.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    }
  });
});
