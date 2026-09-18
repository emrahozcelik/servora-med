import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

const SOURCE_CHECK = 'realtime_events_activity_source_check';

type Fixture = {
  pool: Pool;
  organizationId: string;
  viewerId: string;
  jobCardId: string;
  activityId: string;
  reminderId: string;
};

async function withMigratedDatabase(run: (fixture: Fixture) => Promise<void>) {
  const schema = `nstate_check_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  try {
    await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store: new PostgresMigrationStore(pool) });

    const organizationId = (await pool.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      ['Notification state CHECK matrix'],
    )).rows[0]!.id;
    const viewerId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Viewer', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`],
    )).rows[0]!.id;
    const jobCardId = (await pool.query<{ id: string }>(
      `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by, engagement_kind)
       VALUES ($1, 'SALES_MEETING', 'Matrix job', $2, $2, 'SALES_MEETING') RETURNING id`,
      [organizationId, viewerId],
    )).rows[0]!.id;
    const activityId = (await pool.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
       VALUES ($1, $2, $3, 'JOB_CREATED') RETURNING id`,
      [organizationId, jobCardId, viewerId],
    )).rows[0]!.id;
    const reminderId = (await pool.query<{ id: string }>(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, dedupe_key, next_attempt_at)
       VALUES ($1, $2, $3, '2026-09-01T10:00:00Z', $4, '2026-09-01T09:00:00Z') RETURNING id`,
      [organizationId, jobCardId, viewerId, `matrix-${randomUUID()}`],
    )).rows[0]!.id;

    await run({ pool, organizationId, viewerId, jobCardId, activityId, reminderId });
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function insertEvent(pool: Pool, fixture: {
  organizationId: string;
  sourceActivityId: string | null;
  calendarActivityId: string | null;
  calendarReminderId: string | null;
  messagingActivityId: string | null;
  staffNoteId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  viewerId: string;
}) {
  return pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, calendar_activity_id, calendar_reminder_id,
        messaging_activity_id, staff_note_id, event_type, entity_type, entity_id,
        actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             ARRAY[]::VARCHAR(20)[], ARRAY[$10]::UUID[], ARRAY['notifications'])
     RETURNING id::text AS id`,
    [
      fixture.organizationId,
      fixture.sourceActivityId,
      fixture.calendarActivityId,
      fixture.calendarReminderId,
      fixture.messagingActivityId,
      fixture.staffNoteId,
      fixture.eventType,
      fixture.entityType,
      fixture.entityId,
      fixture.viewerId,
    ],
  );
}

function nullSources() {
  return {
    sourceActivityId: null,
    calendarActivityId: null,
    calendarReminderId: null,
    messagingActivityId: null,
    staffNoteId: null,
  };
}

describe.skipIf(!databaseUrl)('046 notification state CHECK matrix (live PostgreSQL)', () => {
  it('migrates through 050_overdue_incident_scanner_source', async () => {
    await withMigratedDatabase(async ({ pool }) => {
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(applied.rows[0]!.version).toBe('050_overdue_incident_scanner_source');
      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.head?.version).toBe('050_overdue_incident_scanner_source');
    });
  });

  it('case 1: source-less notification.state_changed is ACCEPTED', async () => {
    await withMigratedDatabase(async ({ pool, organizationId, viewerId }) => {
      const result = await insertEvent(pool, {
        organizationId,
        ...nullSources(),
        eventType: 'notification.state_changed',
        entityType: 'notification-center',
        entityId: viewerId,
        viewerId,
      });
      expect(result.rows).toHaveLength(1);
      const stored = await pool.query(
        `SELECT source_activity_id, calendar_activity_id, calendar_reminder_id,
                messaging_activity_id, staff_note_id
           FROM realtime_events WHERE id = $1`,
        [result.rows[0]!.id],
      );
      expect(stored.rows[0]).toEqual({
        source_activity_id: null,
        calendar_activity_id: null,
        calendar_reminder_id: null,
        messaging_activity_id: null,
        staff_note_id: null,
      });
    });
  });

  it('case 2: normal event with exactly one source is ACCEPTED', async () => {
    await withMigratedDatabase(async ({ pool, organizationId, viewerId, jobCardId, activityId }) => {
      const result = await insertEvent(pool, {
        organizationId,
        ...nullSources(),
        sourceActivityId: activityId,
        eventType: 'job.created',
        entityType: 'job-card',
        entityId: jobCardId,
        viewerId,
      });
      expect(result.rows).toHaveLength(1);
    });
  });

  it('case 3: normal event with zero sources is REJECTED', async () => {
    await withMigratedDatabase(async ({ pool, organizationId, viewerId, jobCardId }) => {
      await expect(insertEvent(pool, {
        organizationId,
        ...nullSources(),
        eventType: 'job.created',
        entityType: 'job-card',
        entityId: jobCardId,
        viewerId,
      })).rejects.toMatchObject({ code: '23514', constraint: SOURCE_CHECK });
    });
  });

  it('case 4: normal event with two sources is REJECTED', async () => {
    await withMigratedDatabase(async ({ pool, organizationId, viewerId, jobCardId, activityId, reminderId }) => {
      await expect(insertEvent(pool, {
        organizationId,
        ...nullSources(),
        sourceActivityId: activityId,
        calendarReminderId: reminderId,
        eventType: 'job.created',
        entityType: 'job-card',
        entityId: jobCardId,
        viewerId,
      })).rejects.toMatchObject({ code: '23514', constraint: SOURCE_CHECK });
    });
  });

  it('case 5: notification.state_changed with a source is REJECTED', async () => {
    await withMigratedDatabase(async ({ pool, organizationId, viewerId, activityId }) => {
      await expect(insertEvent(pool, {
        organizationId,
        ...nullSources(),
        sourceActivityId: activityId,
        eventType: 'notification.state_changed',
        entityType: 'notification-center',
        entityId: viewerId,
        viewerId,
      })).rejects.toMatchObject({ code: '23514', constraint: SOURCE_CHECK });
    });
  });
});
