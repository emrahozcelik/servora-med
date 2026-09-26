import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const RECURRENCE_URL = new URL('../src/db/migrations/052_weekly_report_recurrence.sql', import.meta.url);
const FOUNDATION_URL = new URL('../src/db/migrations/051_weekly_report_foundation.sql', import.meta.url);

/**
 * sha256 of the merged 051 foundation migration. Slice 5 is additive: this
 * constant is the tripwire that proves 051 was not edited, reordered or
 * reformatted while the recurrence table was added.
 */
const FOUNDATION_051_SHA256 =
  '8fcca9ea8486f730464586c98aa102ac18cf5c0d25f0cd03e462e13896f2bfc9';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5m_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

/** Run a statement and return the PostgreSQL error, or null on success. */
async function probe(pool: Pool, sql: string, values: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, values);
    return null;
  } catch (error) {
    return (error as { constraint?: string; message: string }).constraint
      ?? (error as { message: string }).message;
  }
}

describe('052 weekly report recurrence migration', () => {
  let sql = '';
  let foundationSql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(RECURRENCE_URL), 'utf8');
    foundationSql = await readFile(fileURLToPath(FOUNDATION_URL), 'utf8');
  });

  it('leaves the 051 foundation migration byte-identical', () => {
    expect(createHash('sha256').update(foundationSql).digest('hex'))
      .toBe(FOUNDATION_051_SHA256);
  });

  it('creates the recurrence table with the one-rule-per-staff invariant', () => {
    expect(sql).toContain('CREATE TABLE weekly_report_recurrences');
    expect(sql).toContain('UNIQUE (organization_id, staff_user_id)');
    expect(sql).toContain('UNIQUE (organization_id, id)');
    expect(sql).toContain('EXTRACT(ISODOW FROM next_period_start) = 1');
    expect(sql).toContain('CONSTRAINT weekly_report_recurrences_staff_user_fk');
    expect(sql).toContain('CONSTRAINT weekly_report_recurrences_requested_by_user_fk');
    expect(sql).toContain('REFERENCES users (organization_id, id)');
    expect(sql).toContain("disabled_reason IN ('MANUAL', 'STAFF_INELIGIBLE')");
    expect(sql).toContain("last_outcome IS NULL OR last_outcome IN ('created', 'existing')");
    expect(sql).toContain('(lease_token IS NULL) = (lease_until IS NULL)');
    expect(sql).toContain("jsonb_typeof(manager_questions) = 'array'");
  });

  it('is additive only: no backfill and no edit to existing WeeklyReport tables', () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
    expect(sql).not.toMatch(/ALTER TABLE (weekly_reports|weekly_report_submissions|job_cards)/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
  });

  it('adds exactly two migrations after 051', async () => {
    const files = (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => name.endsWith('.sql')).sort();
    const after051 = files.filter((name) => Number(name.slice(0, 3)) > 51);
    expect(after051).toEqual([
      '052_weekly_report_recurrence.sql',
      '053_overdue_submission_reminders.sql',
    ]);
    expect(files).not.toContain('053_weekly_report_recurrence_due.sql');
  });
});

describe.skipIf(!databaseUrl)('052 schema behaviour (PostgreSQL)', () => {
  it('applies after 051 and records the migration head', async () => {
    await withSchema(async (pool) => {
      const applied = await pool.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version`,
      );
      const versions = applied.rows.map((row) => row.version);
      expect(versions).toContain('051_weekly_report_foundation');
      expect(versions).toContain('052_weekly_report_recurrence');
      expect(versions[versions.length - 1]).toBe('053_overdue_submission_reminders');
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'weekly_report_recurrences'
          ORDER BY ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'id', 'organization_id', 'staff_user_id', 'requested_by_user_id', 'enabled',
        'disabled_reason', 'next_period_start', 'manager_questions', 'instructions',
        'version', 'lease_token', 'lease_until', 'next_attempt_at', 'failure_count',
        'last_error_code', 'last_processed_period_start', 'last_outcome',
        'created_at', 'updated_at',
      ]);
    });
  });

  it('enforces the Monday, state, lease, range and FK contracts', async () => {
    await withSchema(async (pool) => {
      const organizationA = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('Org A', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const organizationB = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('Org B', 'America/New_York') RETURNING id`,
      )).rows[0]!.id;
      const insert = async (organizationId: string, role: string) =>
        (await pool.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'h', $4) RETURNING id`,
          [organizationId, `${role} ${randomUUID()}`, `${randomUUID()}@t.local`, role],
        )).rows[0]!.id;
      const manager = await insert(organizationA, 'MANAGER');
      const staff = await insert(organizationA, 'STAFF');
      const otherStaff = await insert(organizationA, 'STAFF');
      const foreignStaff = await insert(organizationB, 'STAFF');

      const base = `INSERT INTO weekly_report_recurrences
        (organization_id, staff_user_id, requested_by_user_id, next_period_start`;
      const values = (extra: string, dates: string) =>
        `${base}${extra}) VALUES ('${organizationA}', '${staff}', '${manager}', ${dates})`;

      // Valid Monday rule inserts.
      expect(await probe(pool, values('', `'2026-10-05'`))).toBeNull();
      // Non-Monday rejected.
      expect(await probe(pool, values('', `'2026-10-06'`)))
        .toBe('weekly_report_recurrences_next_period_monday_check');
      // Duplicate rule for the same staff rejected.
      expect(await probe(pool, values('', `'2026-10-12'`)))
        .toBe('weekly_report_recurrences_organization_id_staff_user_id_key');
      // Paused without a reason / enabled with a reason.
      expect(await probe(pool, `${base}, enabled, disabled_reason)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', FALSE, NULL)`))
        .toBe('weekly_report_recurrences_state_check');
      expect(await probe(pool, `${base}, enabled, disabled_reason)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', TRUE, 'MANUAL')`))
        .toBe('weekly_report_recurrences_state_check');
      // Unknown disabled reason and outcome literals.
      expect(await probe(pool, `${base}, enabled, disabled_reason)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', FALSE, 'BOGUS')`))
        .toBe('weekly_report_recurrences_disabled_reason_check');
      expect(await probe(pool, `${base}, last_outcome)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', 'bogus')`))
        .toBe('weekly_report_recurrences_last_outcome_check');
      // version / failure_count ranges.
      expect(await probe(pool, `${base}, version)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', 0)`))
        .toBe('weekly_report_recurrences_version_check');
      expect(await probe(pool, `${base}, failure_count)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', -1)`))
        .toBe('weekly_report_recurrences_failure_count_check');
      // Questions must be array-shaped.
      expect(await probe(pool, `${base}, manager_questions)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05', '{"a":1}')`))
        .toBe('weekly_report_recurrences_questions_check');
      // Lease token without an expiry.
      expect(await probe(pool, `${base}, lease_token, lease_until)
        VALUES ('${organizationA}', '${otherStaff}', '${manager}', '2026-10-05',
                '${randomUUID()}', NULL)`))
        .toBe('weekly_report_recurrences_lease_check');
      // Tenant-scoped FK: a cross-tenant staff member cannot be targeted.
      expect(await probe(pool, `${base})
        VALUES ('${organizationA}', '${foreignStaff}', '${manager}', '2026-10-05')`))
        .toBe('weekly_report_recurrences_staff_user_fk');
      // Tenant-scoped FK: a cross-tenant requester is rejected too.
      expect(await probe(pool, `${base})
        VALUES ('${organizationA}', '${otherStaff}', '${foreignStaff}', '2026-10-05')`))
        .toBe('weekly_report_recurrences_requested_by_user_fk');
      // An unknown user is rejected.
      expect(await probe(pool, `${base})
        VALUES ('${organizationA}', '${randomUUID()}', '${manager}', '2026-10-05')`))
        .toBe('weekly_report_recurrences_staff_user_fk');
    });
  });

  it('creates the partial due-discovery index used by the worker claim', async () => {
    await withSchema(async (pool) => {
      const index = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'weekly_report_recurrences_due_idx'`,
      );
      expect(index.rows[0]?.indexdef).toContain('(next_period_start, id)');
      expect(index.rows[0]?.indexdef).toContain('WHERE enabled');
    });
  });
});
