import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  PostgresSetupRepository,
  seedDevelopment,
  type SetupRequest,
} from '../src/modules/auth/setup.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const organizationName = 'Seed Contract Organization';

afterAll(async () => { await pool?.end(); });
afterEach(async () => {
  if (!pool) return;
  const organization = await pool.query<{ id: string }>(
    'SELECT id FROM organizations WHERE name=$1', [organizationName],
  );
  const organizationId = organization.rows[0]?.id;
  if (!organizationId) return;
  await pool.query('DELETE FROM job_card_activity_logs WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM job_cards WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM products WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM contacts WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM customers WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM staff_profiles WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
  await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
});

describe.skipIf(!databaseUrl)('development seed PostgreSQL contract', () => {
  it('persists the representative CRM graph without management audit events', async () => {
    const repository = new PostgresSetupRepository(pool!);

    await seedDevelopment(repository, {
      organizationName,
      password: 'development-password',
    }, 'test');

    const result = await pool!.query<{
      user_count: string;
      staff_profile_count: string;
      customer_count: string;
      assigned_customer_count: string;
      primary_contact_count: string;
      product_count: string;
      demo_product_sku: string | null;
      demo_product_name: string | null;
      demo_product_unit: string | null;
      demo_product_version: number | null;
      linked_job_count: string;
      job_created_count: string;
      management_audit_count: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE organization_id=o.id)::text AS user_count,
        (SELECT COUNT(*) FROM staff_profiles WHERE organization_id=o.id)::text AS staff_profile_count,
        (SELECT COUNT(*) FROM customers WHERE organization_id=o.id)::text AS customer_count,
        (SELECT COUNT(*) FROM customers c
          JOIN users u ON u.id=c.assigned_staff_user_id
          WHERE c.organization_id=o.id AND u.role='STAFF' AND u.is_active=TRUE)::text AS assigned_customer_count,
        (SELECT COUNT(*) FROM contacts
          WHERE organization_id=o.id AND is_primary=TRUE AND is_active=TRUE
            AND name='Dr. Ayşe Yılmaz' AND title='Doktor')::text AS primary_contact_count,
        (SELECT COUNT(*) FROM products
          WHERE organization_id=o.id AND sku='DEMO-001')::text AS product_count,
        (SELECT sku FROM products
          WHERE organization_id=o.id AND sku='DEMO-001') AS demo_product_sku,
        (SELECT name FROM products
          WHERE organization_id=o.id AND sku='DEMO-001') AS demo_product_name,
        (SELECT unit FROM products
          WHERE organization_id=o.id AND sku='DEMO-001') AS demo_product_unit,
        (SELECT version FROM products
          WHERE organization_id=o.id AND sku='DEMO-001') AS demo_product_version,
        (SELECT COUNT(*) FROM job_cards j
          JOIN contacts c ON c.id=j.contact_id AND c.customer_id=j.customer_id
          WHERE j.organization_id=o.id AND j.status='NEW'
            AND j.assigned_to=(SELECT id FROM users WHERE organization_id=o.id AND role='STAFF'))::text AS linked_job_count,
        (SELECT COUNT(*) FROM job_card_activity_logs a
          JOIN job_cards j ON j.id=a.job_card_id
          WHERE a.organization_id=o.id AND a.event_type='JOB_CREATED'
            AND a.actor_id=j.assigned_to)::text AS job_created_count,
        (SELECT COUNT(*) FROM audit_events WHERE organization_id=o.id)::text AS management_audit_count
      FROM organizations o
      WHERE o.name=$1
    `, [organizationName]);

    expect(result.rows).toEqual([{
      user_count: '3',
      staff_profile_count: '1',
      customer_count: '1',
      assigned_customer_count: '1',
      primary_contact_count: '1',
      product_count: '1',
      demo_product_sku: 'DEMO-001',
      demo_product_name: 'Demo İmplant Seti',
      demo_product_unit: 'adet',
      demo_product_version: 1,
      linked_job_count: '1',
      job_created_count: '1',
      management_audit_count: '0',
    }]);

    const nameOnly = await pool!.query<{
      sku: string | null;
      brand: string | null;
      category: string | null;
      model: string | null;
      unit: string | null;
      default_price: string | null;
      version: number;
    }>(`
      INSERT INTO products (organization_id, name)
      SELECT id, 'Seed Contract Name Only Product'
      FROM organizations
      WHERE name=$1
      RETURNING sku, brand, category, model, unit, default_price, version
    `, [organizationName]);
    expect(nameOnly.rows).toEqual([{
      sku: null,
      brand: null,
      category: null,
      model: null,
      unit: null,
      default_price: null,
      version: 1,
    }]);
  });

  it('rolls back every seed record when a late reference insert fails', async () => {
    const repository = new PostgresSetupRepository(pool!);
    const invalidRequest = {
      organizationName,
      users: [
        { name: 'Admin', email: 'admin@rollback.local', passwordHash: 'hash', role: 'ADMIN', mustChangePassword: true },
        { name: 'Manager', email: 'manager@rollback.local', passwordHash: 'hash', role: 'MANAGER', mustChangePassword: true },
        { name: 'Staff', email: 'staff@rollback.local', passwordHash: 'hash', role: 'STAFF', mustChangePassword: true },
      ],
      staffProfile: { title: null, phone: null, region: null, managerRole: 'MANAGER' },
      referenceData: {
        customer: { name: 'Rollback Clinic', customerType: 'clinic', status: 'active' },
        contact: { name: 'Dr. Rollback', title: 'Doktor', isPrimary: true },
        product: { sku: 'ROLLBACK-001', name: 'Rollback Product', unit: 'adet' },
        jobCard: {
          type: 'PRODUCT_DELIVERY', title: 'Rollback Job', status: 'NEW',
          priority: 'not-a-valid-priority',
        },
      },
    } as unknown as SetupRequest;

    await expect(repository.createOrganizationWithUsers(invalidRequest)).rejects.toMatchObject({
      code: '23514',
    });

    const counts = await pool!.query<{ organizations: string; users: string }>(`
      SELECT
        (SELECT COUNT(*) FROM organizations WHERE name=$1)::text AS organizations,
        (SELECT COUNT(*) FROM users WHERE email LIKE '%@rollback.local')::text AS users
    `, [organizationName]);
    expect(counts.rows[0]).toEqual({ organizations: '0', users: '0' });
  });
});
