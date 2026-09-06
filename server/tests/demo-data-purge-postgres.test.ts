import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
let organizationId: string | null = null;

afterAll(async () => { await pool?.end(); });

afterEach(async () => {
  if (!pool || !organizationId) return;
  await pool.query('DELETE FROM demo_dataset_purge_operations WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM audit_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM processed_actions WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)', [organizationId]);
  await pool.query('DELETE FROM job_card_schedule_revisions WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_assignment_history WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_delivery_items WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_cards WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM contacts WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM customers WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM products WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM staff_profiles WHERE organization_id = $1', [organizationId]);
  await pool.query("UPDATE users SET data_class = 'BUSINESS', demo_dataset_id = NULL WHERE organization_id = $1", [organizationId]);
  await pool.query('DELETE FROM demo_datasets WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM users WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
  organizationId = null;
});

describe.skipIf(!databaseUrl)('Demo data PostgreSQL purge', () => {
  it('deletes the typed demo graph, retains only a technical receipt/audit, and replays exactly', async () => {
    const organization = await pool!.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`R2 purge ${randomUUID()}`],
    );
    organizationId = organization.rows[0]!.id;

    const users = await pool!.query<{ id: string; email: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES
         ($1, 'Business Purge Admin', $2, 'test-hash', 'ADMIN'),
         ($1, 'Demo Purge Staff', $3, 'test-hash', 'STAFF')
       RETURNING id, email`,
      [organizationId, `r2-admin-${randomUUID()}@example.com`, `r2-staff-${randomUUID()}@example.com`],
    );
    const businessAdmin = users.rows.find((row) => row.email.includes('-admin-'))!;
    const demoStaff = users.rows.find((row) => row.email.includes('-staff-'))!;

    const dataset = await pool!.query<{ id: string }>(
      `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
       VALUES ($1, $2, 'r2-test', $3) RETURNING id`,
      [organizationId, `r2-${randomUUID()}`, demoStaff.id],
    );
    const datasetId = dataset.rows[0]!.id;
    await pool!.query(
      `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
       WHERE organization_id = $1 AND id = $3`,
      [organizationId, datasetId, demoStaff.id],
    );
    await pool!.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'R2 Demo Staff')`,
      [organizationId, demoStaff.id],
    );
    const customer = await pool!.query<{ id: string }>(
      `INSERT INTO customers
         (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
       VALUES ($1, 'R2 Demo Clinic', 'clinic', $2, 'active', 'DEMO', $3) RETURNING id`,
      [organizationId, demoStaff.id, datasetId],
    );
    const contact = await pool!.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
       VALUES ($1, $2, 'R2 Contact', TRUE) RETURNING id`,
      [organizationId, customer.rows[0]!.id],
    );
    const product = await pool!.query<{ id: string }>(
      `INSERT INTO products (organization_id, sku, name, unit, data_class, demo_dataset_id)
       VALUES ($1, $2, 'R2 Demo Product', 'adet', 'DEMO', $3) RETURNING id`,
      [organizationId, `R2-${randomUUID()}`, datasetId],
    );
    const job = await pool!.query<{ id: string }>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, customer_id, contact_id,
          assigned_to, created_by, priority, data_class, demo_dataset_id)
       VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'R2 Demo Job', $2, $3, $4, $4,
          'normal', 'DEMO', $5) RETURNING id`,
      [organizationId, customer.rows[0]!.id, contact.rows[0]!.id, demoStaff.id, datasetId],
    );
    await pool!.query(
      `INSERT INTO job_card_delivery_items
         (organization_id, job_card_id, product_id, delivery_purpose, delivered_at,
          quantity, unit, product_name_snapshot)
       VALUES ($1, $2, $3, 'SALE', NOW(), 1, 'adet', 'R2 Demo Product')`,
      [organizationId, job.rows[0]!.id, product.rows[0]!.id],
    );
    await pool!.query(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, new_value)
       VALUES ($1, $2, $3, 'JOB_CREATED', '{}'::jsonb)`,
      [organizationId, job.rows[0]!.id, demoStaff.id],
    );
    await pool!.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [demoStaff.id, 'a'.repeat(64)],
    );
    await pool!.query(
      `INSERT INTO processed_actions
         (organization_id, user_id, client_action_id, operation_key)
       VALUES ($1, $2, $3, 'r2-test')`,
      [organizationId, demoStaff.id, randomUUID()],
    );
    await pool!.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type)
       VALUES ($1, $2, 'USER', $2, 'USER_CREATED')`,
      [organizationId, demoStaff.id],
    );

    const admin: SafeUser = {
      id: businessAdmin.id,
      organizationId,
      name: 'Business Purge Admin',
      email: businessAdmin.email,
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    };
    const service = new DemoDatasetService(new PostgresDemoDatasetRepository(pool!));
    const preview = await service.preview(admin, datasetId);
    expect(preview.safeToPurge).toBe(true);

    const request = { clientActionId: randomUUID(), planHash: preview.planHash };
    const first = await service.purge(admin, datasetId, request);
    expect(first).toMatchObject({
      status: 'COMPLETED',
      datasetId,
      retained: { auditActorDetaches: 1 },
    });

    const persisted = await pool!.query<{
      dataset_status: string | null;
      created_by: string | null;
      creator_snapshot: string | null;
      user_count: string;
      audit_actor: string | null;
      audit_snapshot: string | null;
      operation_count: string;
      purge_audit_count: string;
    }>(
      `SELECT
         (SELECT status FROM demo_datasets WHERE organization_id = $1 AND id = $3) AS dataset_status,
         (SELECT created_by FROM demo_datasets WHERE organization_id = $1 AND id = $3) AS created_by,
         (SELECT created_by_user_id_snapshot FROM demo_datasets WHERE organization_id = $1 AND id = $3) AS creator_snapshot,
         (SELECT COUNT(*) FROM users WHERE organization_id = $1 AND id = $2)::text AS user_count,
         (SELECT actor_user_id FROM audit_events WHERE organization_id = $1 AND subject_id = $2 LIMIT 1) AS audit_actor,
         (SELECT actor_user_id_snapshot FROM audit_events WHERE organization_id = $1 AND subject_id = $2 LIMIT 1) AS audit_snapshot,
         (SELECT COUNT(*) FROM demo_dataset_purge_operations WHERE organization_id = $1 AND dataset_id = $3)::text AS operation_count,
         (SELECT COUNT(*) FROM audit_events WHERE organization_id = $1 AND subject_id = $3 AND event_type = 'DEMO_DATASET_PURGED')::text AS purge_audit_count`,
      [organizationId, demoStaff.id, datasetId],
    );
    expect(persisted.rows[0]).toEqual({
      dataset_status: null,
      created_by: null,
      creator_snapshot: null,
      user_count: '0',
      audit_actor: null,
      audit_snapshot: demoStaff.id,
      operation_count: '1',
      purge_audit_count: '1',
    });

    await expect(pool!.query(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)`,
      [organizationId, job.rows[0]!.id, demoStaff.id, `stale-worker-${randomUUID()}`],
    )).rejects.toMatchObject({ code: '23503' });

    await expect(service.purge(admin, datasetId, request)).resolves.toEqual(first);
    await expect(service.purge(admin, datasetId, {
      clientActionId: randomUUID(), planHash: preview.planHash,
    })).rejects.toMatchObject({ code: 'DEMO_DATASET_NOT_FOUND' });
  });
});
