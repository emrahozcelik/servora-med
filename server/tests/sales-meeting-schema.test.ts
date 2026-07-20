import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATIONS_001_TO_006 = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
] as const;
const EXPECTED_JOB_CARD_TYPES = [
  'PRODUCT_DELIVERY',
  'GENERAL_TASK',
  'SALES_MEETING',
] as const;
const EXPECTED_ACTIVITY_EVENTS = [
  'JOB_CREATED',
  'JOB_ASSIGNED',
  'JOB_PLANNED',
  'JOB_ACCEPTED',
  'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL',
  'JOB_APPROVED',
  'JOB_REVISION_REQUESTED',
  'JOB_RESUMED',
  'JOB_CANCELLED',
  'JOB_FIELDS_UPDATED',
  'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED',
  'DELIVERY_ITEM_REMOVED',
  'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED',
  'JOB_APPROVAL_WITHDRAWN',
] as const;

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await adminPool?.end();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createMigrationSubset(
  files: readonly string[],
  override007?: string,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-sales-meeting-'));
  temporaryDirectories.push(directory);

  for (const file of files) {
    const sql = file === '007_sales_meeting.sql' && override007 !== undefined
      ? override007
      : await readFile(path.join(MIGRATIONS_DIRECTORY, file), 'utf8');
    await writeFile(path.join(directory, file), sql, 'utf8');
  }

  return directory;
}

async function withIsolatedDatabase(
  run: (pool: Pool, store: PostgresMigrationStore) => Promise<void>,
) {
  const schema = `sales_meeting_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });

  try {
    await run(pool, new PostgresMigrationStore(pool));
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

function extractQuotedValues(definition: string) {
  return [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

async function readCheckValues(pool: Pool, constraintName: string) {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = $1
        AND connamespace = current_schema()::regnamespace`,
    [constraintName],
  );
  expect(result.rows).toHaveLength(1);
  return extractQuotedValues(result.rows[0]!.definition);
}

async function createOrganizationAndStaff(pool: Pool, label: string) {
  const organization = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [label],
  );
  const organizationId = organization.rows[0]!.id;
  const staff = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${label} Staff`, `${randomUUID()}@test.local`],
  );
  return { organizationId, staffUserId: staff.rows[0]!.id };
}

async function createSalesMeeting(pool: Pool, organizationId: string, staffUserId: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'SALES_MEETING', 'Structured sales meeting', $2, $2)
     RETURNING id`,
    [organizationId, staffUserId],
  );
  return result.rows[0]!.id;
}

async function expectConstraintViolation(
  pool: Pool,
  _caseName: string,
  sql: string,
  values: unknown[],
  code = '23514',
) {
  await expect(pool.query(sql, values)).rejects.toMatchObject({ code });
}

describe.skipIf(!databaseUrl)('Sales Meeting PostgreSQL migrations', () => {
  it('runs clean 001-011, preserves exact vocabularies and does not reapply', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const firstRun = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      });
      expect(firstRun.appliedVersions).toHaveLength(11);
      expect(firstRun.appliedVersions.at(-1)).toBe('011_create_realtime_events');

      const jobCardTypes = await readCheckValues(pool, 'job_cards_type_check');
      const activityEvents = await readCheckValues(
        pool,
        'job_card_activity_logs_event_type_check',
      );
      expect(jobCardTypes).toHaveLength(3);
      expect(new Set(jobCardTypes)).toEqual(new Set(EXPECTED_JOB_CARD_TYPES));
      expect(activityEvents).toHaveLength(17);
      expect(new Set(activityEvents)).toEqual(new Set(EXPECTED_ACTIVITY_EVENTS));

      const secondRun = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      });
      expect(secondRun).toEqual({ appliedVersions: [] });
    });
  });

  it('upgrades an applied 001-006 database with migrations 007 through 010', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const legacyDirectory = await createMigrationSubset(MIGRATIONS_001_TO_006);
      const baseline = await runMigrations({ migrationsDirectory: legacyDirectory, store });
      expect(baseline.appliedVersions).toHaveLength(6);

      const upgrade = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      });
      expect(upgrade).toEqual({
        appliedVersions: [
          '007_sales_meeting',
          '008_meeting_approval_withdrawal',
          '009_job_acceptance_and_scheduling',
          '010_entity_delete_audit',
          '011_create_realtime_events',
        ],
      });
      await expect(pool.query('SELECT 1 FROM job_card_meeting_details')).resolves.toBeDefined();
    });
  });

  it('rolls back a failed 007 without recording or leaving partial schema', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      const legacyDirectory = await createMigrationSubset(MIGRATIONS_001_TO_006);
      await runMigrations({ migrationsDirectory: legacyDirectory, store });
      const migration007 = await readFile(
        path.join(MIGRATIONS_DIRECTORY, '007_sales_meeting.sql'),
        'utf8',
      );
      const brokenDirectory = await createMigrationSubset(
        ['007_sales_meeting.sql'],
        `${migration007}\nSELECT * FROM deliberately_missing_sales_meeting_relation;`,
      );

      await expect(runMigrations({ migrationsDirectory: brokenDirectory, store })).rejects.toThrow();
      const table = await pool.query<{ name: string | null }>(
        "SELECT to_regclass(current_schema() || '.job_card_meeting_details')::text AS name",
      );
      expect(table.rows[0]!.name).toBeNull();
      const migration = await pool.query(
        "SELECT version FROM schema_migrations WHERE version = '007_sales_meeting'",
      );
      expect(migration.rows).toHaveLength(0);
    });
  });

  it('enforces draft, outcome, summary, ownership and chronology constraints', async () => {
    await withIsolatedDatabase(async (pool, store) => {
      await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
      const first = await createOrganizationAndStaff(pool, 'Meeting One');
      const second = await createOrganizationAndStaff(pool, 'Meeting Two');
      const firstJobCardId = await createSalesMeeting(
        pool,
        first.organizationId,
        first.staffUserId,
      );
      const secondJobCardId = await createSalesMeeting(
        pool,
        second.organizationId,
        second.staffUserId,
      );

      await expect(pool.query(
        `INSERT INTO job_card_meeting_details (job_card_id, organization_id)
         VALUES ($1, $2)`,
        [firstJobCardId, first.organizationId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query(
        `UPDATE job_card_meeting_details
            SET meeting_at = '2026-07-15T10:00:00Z',
                outcome = 'POSITIVE',
                meeting_summary = 'A visible summary',
                next_follow_up_at = '2026-07-16T10:00:00Z'
          WHERE job_card_id = $1`,
        [firstJobCardId],
      )).resolves.toMatchObject({ rowCount: 1 });

      await expectConstraintViolation(
        pool,
        'invalid_outcome',
        `UPDATE job_card_meeting_details SET outcome = $2 WHERE job_card_id = $1`,
        [firstJobCardId, 'MAYBE'],
      );
      for (const [index, summary] of [' ', '\t', '\n', '\t\n '].entries()) {
        await expectConstraintViolation(
          pool,
          `blank_summary_${index}`,
          `UPDATE job_card_meeting_details SET meeting_summary = $2 WHERE job_card_id = $1`,
          [firstJobCardId, summary],
        );
      }
      await expectConstraintViolation(
        pool,
        'long_summary',
        `UPDATE job_card_meeting_details SET meeting_summary = $2 WHERE job_card_id = $1`,
        [firstJobCardId, 'a'.repeat(4001)],
      );
      await expectConstraintViolation(
        pool,
        'missing_meeting_time',
        `UPDATE job_card_meeting_details
            SET meeting_at = NULL, next_follow_up_at = '2026-07-16T10:00:00Z'
          WHERE job_card_id = $1`,
        [firstJobCardId],
      );
      await expectConstraintViolation(
        pool,
        'follow_up_not_later',
        `UPDATE job_card_meeting_details
            SET meeting_at = '2026-07-15T10:00:00Z',
                next_follow_up_at = '2026-07-15T10:00:00Z'
          WHERE job_card_id = $1`,
        [firstJobCardId],
      );
      await expectConstraintViolation(
        pool,
        'cross_organization',
        `INSERT INTO job_card_meeting_details (job_card_id, organization_id)
         VALUES ($1, $2)`,
        [secondJobCardId, first.organizationId],
        '23503',
      );

      const uniqueConstraints = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_constraint
          WHERE conrelid = 'job_card_meeting_details'::regclass
            AND contype IN ('p', 'u')`,
      );
      expect(uniqueConstraints.rows[0]!.count).toBe('1');
      const index = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'meeting_details_org_time_job_idx'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]!.indexdef).toContain('(organization_id, meeting_at, job_card_id)');
      expect(index.rows[0]!.indexdef).toContain('WHERE (meeting_at IS NOT NULL)');
    });
  });
});
