import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL(
  '../src/db/migrations/019_job_card_operational_note_context.sql',
  import.meta.url,
));
let sql = '';

beforeAll(async () => {
  sql = await readFile(path, 'utf8');
});

describe('019 JobCard operational note context migration', () => {
  it('keeps legacy rows valid and requires complete immutable context for version 1 rows', () => {
    expect(sql).toContain('author_name_snapshot');
    expect(sql).toContain('author_role_snapshot');
    expect(sql).toContain('workflow_stage');
    expect(sql).toContain('context');
    expect(sql).toContain('related_activity_id');
    expect(sql).toContain('record_version');
    expect(sql).toMatch(/record_version\s*=\s*0[\s\S]*record_version\s*=\s*1/i);
    expect(sql).toMatch(/author_role_snapshot\s+IN\s*\('ADMIN',\s*'MANAGER',\s*'STAFF'\)/i);
    expect(sql).toMatch(/context\s*=\s*'GENERAL'/i);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const migrationsBefore019 = [
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
  '013_create_job_action_locations.sql',
  '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
  '017_calendar.sql',
  '018_messaging.sql',
];

afterAll(async () => {
  await pool?.end();
});

async function applyMigrations(client: PoolClient, names: readonly string[]) {
  for (const name of names) {
    const migrationPath = fileURLToPath(new URL(
      `../src/db/migrations/${name}`,
      import.meta.url,
    ));
    await client.query(await readFile(migrationPath, 'utf8'));
  }
}

describe.skipIf(!databaseUrl)('019 operational note PostgreSQL contract', () => {
  it('preserves legacy rows and enforces complete same-JobCard version 1 context', async () => {
    const schema = `operational_notes_${randomUUID().replaceAll('-', '')}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await applyMigrations(client, migrationsBefore019);

      const organization = await client.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Operational notes') RETURNING id`,
      );
      const organizationId = organization.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Ayşe Personel', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      );
      const userId = user.rows[0]!.id;
      const jobs = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           accepted_at, accepted_by
         ) VALUES
           ($1, 'GENERAL_TASK', 'ACCEPTED', 'Birinci iş', $2, $2, NOW(), $2),
           ($1, 'GENERAL_TASK', 'ACCEPTED', 'İkinci iş', $2, $2, NOW(), $2)
         RETURNING id`,
        [organizationId, userId],
      );
      const firstJobId = jobs.rows[0]!.id;
      const secondJobId = jobs.rows[1]!.id;
      const legacy = await client.query<{ id: string }>(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, 'Legacy not') RETURNING id`,
        [organizationId, firstJobId, userId],
      );

      await client.query(sql);
      await expect(client.query(
        `SELECT record_version, workflow_stage, author_role_snapshot
           FROM job_card_notes WHERE id = $1`,
        [legacy.rows[0]!.id],
      )).resolves.toMatchObject({
        rows: [{
          record_version: 0,
          workflow_stage: null,
          author_role_snapshot: null,
        }],
      });

      const activity = await client.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (
           organization_id, job_card_id, actor_id, event_type, metadata
         ) VALUES ($1, $2, $3, 'NOTE_ADDED', '{}'::jsonb) RETURNING id`,
        [organizationId, firstJobId, userId],
      );
      const activityId = activity.rows[0]!.id;
      const insertV1 = (
        note: string,
        authorName: string | null,
        authorRole: string | null,
        workflowStage: string | null,
        context: string | null,
        relatedActivityId: string | null,
      ) => client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
        [
          organizationId, firstJobId, userId, note, authorName, authorRole,
          workflowStage, context, relatedActivityId,
        ],
      );

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Null ad snapshot',
           NULL, 'STAFF', 'ACCEPTED',
           'GENERAL', $4, 1
         )`,
        [organizationId, firstJobId, userId, activityId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(insertV1(
        'Null activity ilişkisi',
        'Ayşe Personel',
        'STAFF',
        'ACCEPTED',
        'GENERAL',
        null,
      )).rejects.toMatchObject({ code: '23514' });

      await expect(insertV1(
        'Boş author snapshot',
        '   ',
        'STAFF',
        'ACCEPTED',
        'GENERAL',
        activityId,
      )).rejects.toMatchObject({ code: '23514' });

      await expect(insertV1(
        'Geçersiz rol',
        'Ayşe Personel',
        'OWNER',
        'ACCEPTED',
        'GENERAL',
        activityId,
      )).rejects.toMatchObject({ code: '23514' });

      await expect(insertV1(
        'Geçersiz aşama',
        'Ayşe Personel',
        'STAFF',
        'PLANNED',
        'GENERAL',
        activityId,
      )).rejects.toMatchObject({ code: '23514' });

      await expect(insertV1(
        'Geçersiz context',
        'Ayşe Personel',
        'STAFF',
        'ACCEPTED',
        'TRANSITION',
        activityId,
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Null context',
           'Ayşe Personel', 'STAFF', 'ACCEPTED',
           NULL, $4, 1
         )`,
        [organizationId, firstJobId, userId, activityId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Null aşama snapshot',
           'Ayşe Personel', 'STAFF', NULL,
           'GENERAL', $4, 1
         )`,
        [organizationId, firstJobId, userId, activityId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Null rol snapshot',
           'Ayşe Personel', NULL, 'ACCEPTED',
           'GENERAL', $4, 1
         )`,
        [organizationId, firstJobId, userId, activityId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note, record_version
         ) VALUES ($1, $2, $3, 'Eksik v1', 1)`,
        [organizationId, firstJobId, userId],
      )).rejects.toMatchObject({ code: '23514' });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Geçerli v1',
           'Ayşe Personel', 'STAFF', 'ACCEPTED',
           'GENERAL', $4, 1
         )`,
        [organizationId, firstJobId, userId, activityId],
      )).resolves.toMatchObject({ rowCount: 1 });

      await expect(client.query(
        `INSERT INTO job_card_notes (
           organization_id, job_card_id, author_id, note,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         ) VALUES (
           $1, $2, $3, 'Yanlış iş ilişkisi',
           'Ayşe Personel', 'STAFF', 'ACCEPTED',
           'GENERAL', $4, 1
         )`,
        [organizationId, secondJobId, userId, activityId],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
