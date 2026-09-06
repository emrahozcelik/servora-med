import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

/** Apply migrations 001..042 only (symlink copies), leaving 043 pending. */
async function applyUpTo042(pool: Pool): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'f1-migrations-'));
  const entries = await readdir(migrationsDirectory);
  for (const entry of entries) {
    if (!/^\d{3}_[A-Za-z0-9_]+\.sql$/.test(entry)) continue;
    const number = Number(entry.slice(0, 3));
    if (number <= 42) {
      await symlink(path.join(migrationsDirectory, entry), path.join(dir, entry));
    }
  }
  await runMigrations({ migrationsDirectory: dir, store: new PostgresMigrationStore(pool) });
  await rm(dir, { recursive: true, force: true });
}
describe.skipIf(!databaseUrl)('FOUNDATION-1 migration 043 legacy baseline backfill', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  afterAll(async () => { await cleanup?.(); });

  it('backfills exactly one BASELINE revision and assignment row per legacy JobCard', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const schema = `f1mig_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
    cleanup = async () => {
      await pool!.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    };

    await applyUpTo042(pool);

    const organizationId = randomUUID();
    const otherOrgId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, timezone) VALUES
         ($1, 'Legacy Org', 'America/New_York'),
         ($2, 'Legacy Other', 'Europe/Istanbul')`,
      [organizationId, otherOrgId],
    );
    const managerRow = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Legacy Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
      [organizationId, `${randomUUID()}@legacy.test`],
    );
    const staffRow = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Legacy Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@legacy.test`],
    );
    const otherAdminRow = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Legacy Other Admin', $2, 'test-hash', 'ADMIN') RETURNING id`,
      [otherOrgId, `${randomUUID()}@legacy.test`],
    );

    const insertLegacyJob = async (
      orgId: string,
      title: string,
      assignedTo: string,
      createdBy: string,
    ): Promise<{ id: string }> => {
      const row = await pool!.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, priority)
         VALUES ($1, 'GENERAL_TASK', 'NEW', $2, $3, $4, 'normal')
         RETURNING id`,
        [orgId, title, assignedTo, createdBy],
      );
      return row.rows[0]!;
    };
    const legacy = await insertLegacyJob(
      organizationId, 'Legacy scheduled', staffRow.rows[0]!.id, managerRow.rows[0]!.id,
    );
    await pool.query(
      `UPDATE job_cards
          SET scheduled_at = '2026-08-01T10:00:00.000Z',
              scheduled_ends_at = '2026-08-01T11:00:00.000Z',
              due_date = '2026-08-15'
        WHERE id = $1`,
      [legacy.id],
    );
    const legacyOtherOrg = await insertLegacyJob(
      otherOrgId, 'Legacy other', otherAdminRow.rows[0]!.id, otherAdminRow.rows[0]!.id,
    );
    await pool.query(
      `UPDATE job_cards
          SET scheduled_at = '2026-08-02T10:00:00.000Z',
              scheduled_ends_at = '2026-08-02T11:00:00.000Z',
              due_date = '2026-08-16'
        WHERE id = $1`,
      [legacyOtherOrg.id],
    );

    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });

    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(catalog.head?.filename).toBe('043_job_card_schedule_and_assignment_history.sql');

    const baseline = await pool.query<{
      job_id: string; scheduled_at: Date | null; scheduled_ends_at: Date | null;
      due_date: string | null; timezone: string; source: string; revision_no: number; created_by: string | null;
    }>(
      `SELECT r.job_card_id AS job_id, r.scheduled_at, r.scheduled_ends_at,
              to_char(r.due_date, 'YYYY-MM-DD') AS due_date,
              r.organization_timezone AS timezone, r.source, r.revision_no, r.created_by
         FROM job_card_schedule_revisions r
        ORDER BY r.job_card_id`,
    );
    expect(baseline.rows).toHaveLength(2);
    const primary = baseline.rows.find((row) => row.job_id === legacy.id)!;
    expect(primary).toMatchObject({
      revision_no: 1, source: 'BASELINE', timezone: 'America/New_York', created_by: null,
      due_date: '2026-08-15',
    });
    expect(primary.scheduled_at).toEqual(new Date('2026-08-01T10:00:00.000Z'));
    const other = baseline.rows.find((row) => row.job_id === legacyOtherOrg.id)!;
    expect(other).toMatchObject({ source: 'BASELINE', timezone: 'Europe/Istanbul', due_date: '2026-08-16' });

    const assignments = await pool.query<{
      job_id: string; from_user_id: string | null; to_user_id: string; source: string;
    }>(
      `SELECT job_card_id AS job_id, from_user_id, to_user_id, source
         FROM job_card_assignment_history
        ORDER BY job_card_id`,
    );
    expect(assignments.rows).toHaveLength(2);
    const primaryAssignment = assignments.rows.find((row) => row.job_id === legacy.id)!;
    expect(primaryAssignment).toMatchObject({
      from_user_id: null, to_user_id: staffRow.rows[0]!.id, source: 'BASELINE',
    });

    const sources = await pool.query<{ source: string }>(
      `SELECT source FROM job_card_schedule_revisions GROUP BY source`,
    );
    expect(sources.rows.map((row) => row.source).sort()).toEqual(['BASELINE']);
  });
});
