import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = fileURLToPath(new URL(
  '../src/db/migrations/022_job_card_follow_up_links.sql',
  import.meta.url,
));
const MIGRATIONS_BEFORE_022 = [
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
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '024_job_card_notes_invoice_number.sql',

];

let sql = '';

beforeAll(async () => {
  sql = await readFile(MIGRATION_PATH, 'utf8');
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

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

describe.skipIf(!databaseUrl)('022 linked follow-up JobCard PostgreSQL contract', () => {
  it('keeps legacy rows valid and enforces the present-iff instructions contract', async () => {
    const schema = `follow_up_links_${randomUUID().replaceAll('-', '')}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await applyMigrations(client, MIGRATIONS_BEFORE_022);

      const organization = await client.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Follow-up links') RETURNING id`,
      );
      const organizationId = organization.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Ayşe Personel', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      );
      const userId = user.rows[0]!.id;
      const otherOrganization = await client.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Other org') RETURNING id`,
      );
      const otherOrganizationId = otherOrganization.rows[0]!.id;
      const otherUser = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Başka org', $2, 'hash', 'STAFF') RETURNING id`,
        [otherOrganizationId, `${randomUUID()}@test.local`],
      );
      const otherUserId = otherUser.rows[0]!.id;

      // Legacy row inserted before 022: root card, both new columns NULL.
      const legacyRoot = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by
         ) VALUES (
           $1, 'GENERAL_TASK', 'COMPLETED', 'Kaynak iş', $2, $2,
           NOW(), NOW(), $2, NOW(), $2
         )
         RETURNING id`,
        [organizationId, userId],
      );
      const legacyRootId = legacyRoot.rows[0]!.id;

      await client.query(sql);

      // Legacy rows remain valid after the migration.
      await expect(client.query(
        `SELECT source_job_card_id, follow_up_instructions
           FROM job_cards WHERE id = $1`,
        [legacyRootId],
      )).resolves.toMatchObject({
        rows: [{ source_job_card_id: null, follow_up_instructions: null }],
      });

      // A follow-up may now link to the legacy root (same org).
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Eski köke takip', $2, $2, $3, 'Arayın.')`,
        [organizationId, userId, legacyRootId],
      )).resolves.toMatchObject({ rowCount: 1 });

      // Case: root + valid instructions -> rejected (present-iff check).
      // The row is otherwise a fully valid completed card, so the only
      // violated constraint is job_cards_follow_up_instructions_check.
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by, follow_up_instructions
         ) VALUES (
           $1, 'GENERAL_TASK', 'COMPLETED', 'Kök talimatlı', $2, $2,
           NOW(), NOW(), $2, NOW(), $2, $3
         )`,
        [organizationId, userId, 'Geçersiz talimat'],
      )).rejects.toMatchObject({ code: '23514' });

      // Case: follow-up + null instructions -> rejected (present-iff check).
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Talimatsız takip', $2, $2, $3, NULL)`,
        [organizationId, userId, legacyRootId],
      )).rejects.toMatchObject({ code: '23514' });

      // Case: root + null instructions -> accepted (both NULL).
      const root = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by,
           source_job_card_id, follow_up_instructions
         ) VALUES (
           $1, 'GENERAL_TASK', 'COMPLETED', 'Kök iş', $2, $2,
           NOW(), NOW(), $2, NOW(), $2, NULL, NULL
         )
         RETURNING id`,
        [organizationId, userId],
      );
      const rootId = root.rows[0]!.id;

      // Case: follow-up + valid instructions -> accepted (both NOT NULL).
      const followUp = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Geçerli takip', $2, $2, $3, $4)
         RETURNING id`,
        [organizationId, userId, rootId, 'Ziyaret sonrası tekrar arayın.'],
      );
      const followUpId = followUp.rows[0]!.id;

      // Length/whitespace check: whitespace-only instructions -> rejected.
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Boşluk talimat', $2, $2, $3, '   ')`,
        [organizationId, userId, rootId],
      )).rejects.toMatchObject({ code: '23514' });

      // Length/whitespace check: > 4000 characters -> rejected.
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Uzun talimat', $2, $2, $3, $4)`,
        [organizationId, userId, rootId, 'a'.repeat(4001)],
      )).rejects.toMatchObject({ code: '23514' });

      // Self-link check: a card cannot become its own source.
      await expect(client.query(
        `UPDATE job_cards SET source_job_card_id = id WHERE id = $1`,
        [followUpId],
      )).rejects.toMatchObject({ code: '23514' });

      // Foreign key: the source must live in the same organization.
      await expect(client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           source_job_card_id, follow_up_instructions
         ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Yabancı kaynak', $2, $2, $3, 'Talimat')`,
        [otherOrganizationId, otherUserId, rootId],
      )).rejects.toMatchObject({ code: '23503' });

      // ON DELETE RESTRICT: a source with follow-ups cannot be deleted.
      await expect(client.query(`DELETE FROM job_cards WHERE id = $1`, [rootId]))
        .rejects.toMatchObject({ code: '23503' });

      // The direct-child lookup index exists.
      await expect(client.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = $1 AND indexname = 'job_cards_follow_up_source_idx'`,
        [schema],
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
