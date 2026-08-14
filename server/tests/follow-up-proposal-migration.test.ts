import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = fileURLToPath(new URL(
  '../src/db/migrations/027_follow_up_proposals.sql',
  import.meta.url,
));
const MIGRATIONS_BEFORE_027 = [
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
  '022_job_card_follow_up_links.sql',
  '023_staff_confidential_notes.sql',
  '024_job_card_notes_invoice_number.sql',
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
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

describe.skipIf(!databaseUrl)('027 follow-up proposal PostgreSQL contract', () => {
  it('keeps historical WAITING_APPROVAL rows valid and enforces the present-iff proposal contract', async () => {
    const schema = `follow_up_proposals_${randomUUID().replaceAll('-', '')}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await applyMigrations(client, MIGRATIONS_BEFORE_027);

      const organization = await client.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Proposal contract') RETURNING id`,
      );
      const organizationId = organization.rows[0]!.id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Ayşe Personel', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      );
      const userId = user.rows[0]!.id;

      // Historical WAITING_APPROVAL row predating the feature: proposal NULL.
      const legacy = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by
         ) VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 'Eski iş', $2, $2, NOW(), NOW(), $2)
         RETURNING id`,
        [organizationId, userId],
      );
      const legacyId = legacy.rows[0]!.id;

      await client.query(sql);

      // Legacy row remains valid after the migration.
      await expect(client.query(
        `SELECT follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
                follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
           FROM job_cards WHERE id = $1`,
        [legacyId],
      )).resolves.toMatchObject({
        rows: [{
          follow_up_proposed_at: null,
          follow_up_proposed_type: null,
          follow_up_proposed_assignee: null,
          follow_up_proposal_instructions: null,
          follow_up_proposal_origin: null,
          follow_up_proposed_by: null,
        }],
      });

      // Partial proposal (only date) -> rejected by the present-iff check.
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposed_at = NOW() WHERE id = $1`,
        [legacyId],
      )).rejects.toMatchObject({ code: '23514' });

      // Invalid origin -> rejected.
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposed_at = NOW(),
           follow_up_proposed_type = 'GENERAL_TASK', follow_up_proposed_assignee = $2,
           follow_up_proposal_instructions = 'Takip', follow_up_proposal_origin = 'LEGACY',
           follow_up_proposed_by = $2
         WHERE id = $1`,
        [legacyId, userId],
      )).rejects.toMatchObject({ code: '23514' });

      // Complete valid proposal -> accepted.
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposed_at = NOW(),
           follow_up_proposed_type = 'GENERAL_TASK', follow_up_proposed_assignee = $2,
           follow_up_proposal_instructions = 'Takip: Kontrol', follow_up_proposal_origin = 'SYSTEM',
           follow_up_proposed_by = $2
         WHERE id = $1`,
        [legacyId, userId],
      )).resolves.toMatchObject({ rowCount: 1 });

      // Complete proposal but proposed_by NULL -> rejected (present-iff requires proposer).
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposed_by = NULL WHERE id = $1`,
        [legacyId],
      )).rejects.toMatchObject({ code: '23514' });

      // Whitespace-only instructions -> rejected.
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposal_instructions = '   ' WHERE id = $1`,
        [legacyId],
      )).rejects.toMatchObject({ code: '23514' });

      // Cross-org assignee FK -> rejected.
      const otherOrg = await client.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Other') RETURNING id`,
      );
      const otherUser = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'X', $2, 'hash', 'STAFF') RETURNING id`,
        [otherOrg.rows[0]!.id, `${randomUUID()}@test.local`],
      );
      await expect(client.query(
        `UPDATE job_cards SET follow_up_proposed_assignee = $2 WHERE id = $1`,
        [legacyId, otherUser.rows[0]!.id],
      )).rejects.toMatchObject({ code: '23503' });

      // The customer scheduling lookup indexes exist.
      for (const indexName of ['job_cards_customer_scheduled_idx', 'job_cards_customer_completed_idx']) {
        await expect(client.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = $1 AND indexname = $2`,
          [schema, indexName],
        )).resolves.toMatchObject({ rowCount: 1 });
      }
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
