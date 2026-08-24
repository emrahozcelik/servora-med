import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const organizationName = `R1 Demo Preview ${randomUUID()}`;
let organizationId: string | null = null;

const admin: SafeUser = {
  id: '',
  organizationId: '',
  name: 'R1 Admin',
  email: 'r1-admin@example.com',
  role: 'ADMIN',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

afterAll(async () => { await pool?.end(); });

afterEach(async () => {
  if (!pool || !organizationId) return;
  await pool.query('DELETE FROM in_app_notifications WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM realtime_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_reminders WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_notes WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_delivery_items WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM messaging_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM messages WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM conversation_participants WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM conversations WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_event_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM staff_confidential_notes WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM products WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_cards WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM contacts WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM customers WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM staff_profiles WHERE organization_id = $1', [organizationId]);
  await pool.query("UPDATE users SET data_class = 'BUSINESS', demo_dataset_id = NULL WHERE organization_id = $1", [organizationId]);
  await pool.query('DELETE FROM demo_datasets WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM users WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
  organizationId = null;
});

describe.skipIf(!databaseUrl)('Demo data PostgreSQL preview', () => {
  it('detects a demo Staff assigned to a BUSINESS customer without mutating the graph', async () => {
    const organization = await pool!.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [organizationName],
    );
    organizationId = organization.rows[0]!.id;

    const users = await pool!.query<{ id: string; email: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES
         ($1, 'R1 Admin', 'r1-admin-' || $2 || '@example.com', 'test-hash', 'ADMIN'),
         ($1, 'R1 Demo Staff', 'r1-staff-' || $2 || '@example.com', 'test-hash', 'STAFF')
       RETURNING id, email`,
      [organizationId, randomUUID()],
    );
    const adminUser = users.rows.find((user) => user.email.startsWith('r1-admin-'))!;
    const staffUser = users.rows.find((user) => user.email.startsWith('r1-staff-'))!;

    await pool!.query(
      `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
       VALUES ($1, $2, 'r1-test', $3)`,
      [organizationId, `mixed-${randomUUID()}`, adminUser.id],
    );
    const dataset = await pool!.query<{ id: string }>(
      'SELECT id FROM demo_datasets WHERE organization_id = $1', [organizationId],
    );
    const datasetId = dataset.rows[0]!.id;
    await pool!.query(
      `UPDATE users
       SET data_class = 'DEMO', demo_dataset_id = $2
       WHERE organization_id = $1 AND id = $3`,
      [organizationId, datasetId, staffUser.id],
    );
    await pool!.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Demo Staff')`,
      [organizationId, staffUser.id],
    );

    const businessCustomer = await pool!.query<{ id: string }>(
      `INSERT INTO customers
         (organization_id, name, customer_type, assigned_staff_user_id, status)
       VALUES ($1, 'Business Clinic', 'clinic', $2, 'active')
       RETURNING id`,
      [organizationId, staffUser.id],
    );
    await pool!.query(
      `INSERT INTO job_cards
         (organization_id, type, status, title, customer_id, assigned_to, created_by, priority)
       VALUES ($1, 'GENERAL_TASK', 'NEW', 'Business Job', $2, $3, $4, 'normal')`,
      [organizationId, businessCustomer.rows[0]!.id, staffUser.id, adminUser.id],
    );

    const datasetRepository = new PostgresDemoDatasetRepository(pool!);
    const service = new DemoDatasetService(datasetRepository);
    const result = await service.preview({
      ...admin,
      id: adminUser.id,
      organizationId,
      email: adminUser.email,
    }, datasetId);

    expect(result.safeToPurge).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'DEMO_USER_TO_BUSINESS_CUSTOMER',
      'DEMO_USER_TO_BUSINESS_JOB',
    ]);
    expect(result.affectedCounts).toMatchObject({ users: 1, staffProfiles: 1 });

    const unchanged = await pool!.query<{ customer_count: string; job_count: string }>(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE organization_id = $1)::text AS customer_count,
         (SELECT COUNT(*) FROM job_cards WHERE organization_id = $1)::text AS job_count`,
      [organizationId],
    );
    expect(unchanged.rows[0]).toEqual({ customer_count: '1', job_count: '1' });
  });

  it('previews a demo JobCard derived graph on the real schema without mutation', async () => {
    const organization = await pool!.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`${organizationName} chain`],
    );
    organizationId = organization.rows[0]!.id;

    const users = await pool!.query<{ id: string; email: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES
         ($1, 'R1 Chain Admin', 'r1-chain-admin-' || $2 || '@example.com', 'test-hash', 'ADMIN'),
         ($1, 'R1 Chain Staff', 'r1-chain-staff-' || $2 || '@example.com', 'test-hash', 'STAFF')
       RETURNING id, email`,
      [organizationId, randomUUID()],
    );
    const adminUser = users.rows.find((user) => user.email.startsWith('r1-chain-admin-'))!;
    const staffUser = users.rows.find((user) => user.email.startsWith('r1-chain-staff-'))!;

    const dataset = await pool!.query<{ id: string }>(
      `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
       VALUES ($1, $2, 'r1-chain-test', $3)
       RETURNING id`,
      [organizationId, `chain-${randomUUID()}`, adminUser.id],
    );
    const datasetId = dataset.rows[0]!.id;
    await pool!.query(
      `UPDATE users
       SET data_class = 'DEMO', demo_dataset_id = $2
       WHERE organization_id = $1`,
      [organizationId, datasetId],
    );
    await pool!.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Chain Staff')`,
      [organizationId, staffUser.id],
    );

    const customer = await pool!.query<{ id: string }>(
      `INSERT INTO customers
         (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
       VALUES ($1, 'Chain Clinic', 'clinic', $2, 'active', 'DEMO', $3)
       RETURNING id`,
      [organizationId, staffUser.id, datasetId],
    );
    const product = await pool!.query<{ id: string }>(
      `INSERT INTO products
         (organization_id, sku, name, unit, data_class, demo_dataset_id)
       VALUES ($1, 'CHAIN-R1', 'Chain Product', 'adet', 'DEMO', $2)
       RETURNING id`,
      [organizationId, datasetId],
    );
    const job = await pool!.query<{ id: string }>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, customer_id, assigned_to, created_by, priority, data_class, demo_dataset_id)
       VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Chain Delivery', $2, $3, $4, 'normal', 'DEMO', $5)
       RETURNING id`,
      [organizationId, customer.rows[0]!.id, staffUser.id, adminUser.id, datasetId],
    );
    const jobId = job.rows[0]!.id;

    await pool!.query(
      `INSERT INTO job_card_delivery_items
         (organization_id, job_card_id, product_id, delivery_purpose, delivered_at, quantity, unit,
          product_name_snapshot, product_sku_snapshot)
       VALUES ($1, $2, $3, 'SALE', NOW(), 1, 'adet', 'Chain Product', 'CHAIN-R1')`,
      [organizationId, jobId, product.rows[0]!.id],
    );
    await pool!.query(
      `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
       VALUES ($1, $2, $3, 'Chain note')`,
      [organizationId, jobId, staffUser.id],
    );
    const activity = await pool!.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, metadata)
       VALUES ($1, $2, $3, 'JOB_CREATED', '{}'::jsonb)
       RETURNING id`,
      [organizationId, jobId, adminUser.id],
    );
    const realtime = await pool!.query<{ id: string }>(
      `INSERT INTO realtime_events
         (organization_id, source_activity_id, event_type, entity_type, entity_id, actor_user_id,
          audience_roles, resource_keys)
       VALUES ($1, $2, 'job.created', 'job-card', $3, $4, ARRAY['ADMIN']::VARCHAR(20)[], ARRAY['job-card:' || $3])
       RETURNING id`,
      [organizationId, activity.rows[0]!.id, jobId, adminUser.id],
    );
    await pool!.query(
      `INSERT INTO in_app_notifications
         (organization_id, recipient_user_id, source_realtime_event_id, kind, entity_type, entity_id)
       VALUES ($1, $2, $3, 'job.assigned', 'job-card', $4)`,
      [organizationId, staffUser.id, realtime.rows[0]!.id, jobId],
    );
    await pool!.query(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, dedupe_key, next_attempt_at)
       VALUES ($1, $2, $3, NOW(), $4, NOW())`,
      [organizationId, jobId, staffUser.id, `chain-reminder-${randomUUID()}`],
    );

    const datasetRepository = new PostgresDemoDatasetRepository(pool!);
    const service = new DemoDatasetService(datasetRepository);
    const result = await service.preview({
      ...admin,
      id: adminUser.id,
      organizationId,
      email: adminUser.email,
    }, datasetId);

    expect(result).toMatchObject({
      safeToPurge: true,
      blockers: [],
      affectedCounts: {
        users: 2,
        staffProfiles: 1,
        customers: 1,
        products: 1,
        jobCards: 1,
        deliveryItems: 1,
        notes: 1,
        activities: 1,
        notifications: 1,
        reminders: 1,
        realtimeEvents: 1,
      },
    });

    const unchanged = await pool!.query<{
      dataset_count: string;
      customer_count: string;
      product_count: string;
      job_count: string;
      activity_count: string;
      note_count: string;
      notification_count: string;
      reminder_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM demo_datasets WHERE organization_id = $1 AND id = $2)::text AS dataset_count,
         (SELECT COUNT(*) FROM customers WHERE organization_id = $1 AND id = $3 AND data_class = 'DEMO' AND demo_dataset_id = $2)::text AS customer_count,
         (SELECT COUNT(*) FROM products WHERE organization_id = $1 AND id = $4 AND data_class = 'DEMO' AND demo_dataset_id = $2)::text AS product_count,
         (SELECT COUNT(*) FROM job_cards WHERE organization_id = $1 AND id = $5 AND data_class = 'DEMO' AND demo_dataset_id = $2)::text AS job_count,
         (SELECT COUNT(*) FROM job_card_activity_logs WHERE organization_id = $1 AND job_card_id = $5)::text AS activity_count,
         (SELECT COUNT(*) FROM job_card_notes WHERE organization_id = $1 AND job_card_id = $5)::text AS note_count,
         (SELECT COUNT(*) FROM in_app_notifications WHERE organization_id = $1 AND entity_id = $5)::text AS notification_count,
         (SELECT COUNT(*) FROM calendar_reminders WHERE organization_id = $1 AND job_card_id = $5)::text AS reminder_count`,
      [organizationId, datasetId, customer.rows[0]!.id, product.rows[0]!.id, jobId],
    );
    expect(unchanged.rows[0]).toEqual({
      dataset_count: '1',
      customer_count: '1',
      product_count: '1',
      job_count: '1',
      activity_count: '1',
      note_count: '1',
      notification_count: '1',
      reminder_count: '1',
    });
  });
});
