import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/012_create_in_app_notifications.sql',
  import.meta.url,
);

describe('012 in-app notifications migration', () => {
  it('creates a tenant-safe recipient notification read model', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain('CREATE TABLE in_app_notifications');
    expect(sql).toMatch(
      /ALTER TABLE realtime_events[\s\S]*UNIQUE \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, recipient_user_id\)[\s\S]*REFERENCES users \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, source_realtime_event_id\)[\s\S]*REFERENCES realtime_events \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /UNIQUE \(recipient_user_id, source_realtime_event_id\)/i,
    );
    expect(sql).toMatch(
      /CHECK \(kind IN \([\s\S]*'job\.assigned'[\s\S]*'job\.reassigned'[\s\S]*'job\.awaiting_approval'[\s\S]*'job\.approved'[\s\S]*'job\.revision_requested'[\s\S]*'job\.cancelled'[\s\S]*\)\)/i,
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql',
  '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
  '012_create_in_app_notifications.sql',
] as const;

async function applyMigrations(pool: Pool) {
  for (const migration of migrations) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function createSourceEvent(
  pool: Pool,
  organizationId: string,
  userId: string,
) {
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'Bildirim testi', $2, $2)
     RETURNING id`,
    [organizationId, userId],
  )).rows[0]!.id;
  const activityId = (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_APPROVED')
     RETURNING id`,
    [organizationId, jobCardId, userId],
  )).rows[0]!.id;
  const eventId = (await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type, entity_id,
        actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'job.approved', 'job-card', $3, $4,
             ARRAY['MANAGER']::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
     RETURNING id::text AS id`,
    [organizationId, activityId, jobCardId, userId],
  )).rows[0]!.id;
  return { eventId, jobCardId };
}

describe.skipIf(!databaseUrl)('012 in-app notifications PostgreSQL migration', () => {
  it('rejects cross-organization source events and unsupported kinds', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `notifications_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationOne = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Notification one') RETURNING id`,
      )).rows[0]!.id;
      const organizationTwo = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Notification two') RETURNING id`,
      )).rows[0]!.id;
      const userOne = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'One', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationOne, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const userTwo = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Two', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationTwo, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const sourceOne = await createSourceEvent(pool, organizationOne, userOne);
      const sourceTwo = await createSourceEvent(pool, organizationTwo, userTwo);

      await pool.query(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id, kind,
            entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.approved', 'job-card', $4)`,
        [organizationOne, userOne, sourceOne.eventId, sourceOne.jobCardId],
      );

      await expect(pool.query(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id, kind,
            entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.approved', 'job-card', $4)`,
        [organizationOne, userOne, sourceTwo.eventId, sourceTwo.jobCardId],
      )).rejects.toMatchObject({ code: '23503' });
      await expect(pool.query(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id, kind,
            entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.unknown', 'job-card', $4)`,
        [organizationOne, userOne, sourceOne.eventId, sourceOne.jobCardId],
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      if (pool) await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
