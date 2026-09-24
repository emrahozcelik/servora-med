import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-08-03';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2d_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR2D ${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, `WR2D ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function buildService(pool: Pool) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date('2026-08-03T09:00:00.000Z'),
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

const actor = (organizationId: string, id: string, role: JobCardActor['role']): JobCardActor => ({
  id, organizationId, role,
});

const QUESTIONS = [{ key: 'q1', prompt: 'Soru?' }];

describe.skipIf(!databaseUrl)('weekly report draft read/write (PostgreSQL)', () => {
  it('exposes identity, draft, questions, version and live source work to the owner', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        actor(organizationId, staffId, 'STAFF'),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      );
      const detail = await service.getWeeklyReport(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      expect(detail).toMatchObject({
        id: created.reportId,
        staffUserId: staffId,
        periodStart: WEEK_A,
        periodEnd: '2026-08-09',
        jobStatus: 'ACCEPTED',
        jobVersion: 1,
        dueDate: '2026-08-10',
        assignedTo: staffId,
        version: 1,
        questions: [],
        answers: [],
        submissionSummaries: [],
      });
      expect(detail.draft).toEqual({
        summary: null, blockers: null, nextWeekPlan: null,
        highlights: null, fieldObservations: null, supportNeeded: null,
      });
      expect(detail.liveSourceWork).toEqual([]);
    });
  });

  it('replaces the draft atomically with optimistic versioning', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        actor(organizationId, managerId, 'MANAGER'),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A,
          assignedTo: staffId, questions: QUESTIONS,
        }),
      );
      // Manager-requested reports start NEW: staff accepts before editing.
      await service.acceptAssignment(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 1 },
      );
      const updated = await service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        {
          expectedVersion: 1,
          draft: { summary: 'Özet.' },
          answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
        },
      );
      expect(updated.version).toBe(2);
      expect(updated.draft.summary).toBe('Özet.');
      // Complete replacement: omitted sections stay null, never merged.
      expect(updated.draft.nextWeekPlan).toBeNull();
      expect(updated.answers).toEqual([{ questionKey: 'q1', answer: 'Yanıt.' }]);
      // Stale version conflicts deterministically.
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 1, draft: {}, answers: [] },
      )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      // Unknown answer keys and malformed patches fail closed.
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 2, draft: {}, answers: [{ questionKey: 'nope', answer: 'x' }] },
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('lets managers read but never write; conceals from other staff and tenants', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const otherOrg = await insertOrg(pool);
      const foreignStaff = await insertUser(pool, otherOrg, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        actor(organizationId, staffA, 'STAFF'),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      );
      await expect(service.getWeeklyReport(
        actor(organizationId, managerId, 'MANAGER'), created.jobCardId,
      )).resolves.toMatchObject({ id: created.reportId });
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, managerId, 'MANAGER'),
        created.jobCardId,
        { expectedVersion: 1, draft: {}, answers: [] },
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.getWeeklyReport(
        actor(organizationId, staffB, 'STAFF'), created.jobCardId,
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, staffB, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 1, draft: {}, answers: [] },
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      await expect(service.getWeeklyReport(
        actor(otherOrg, foreignStaff, 'STAFF'), created.jobCardId,
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      await expect(service.listWeeklyReportSubmissions(
        actor(organizationId, staffB, 'STAFF'), created.jobCardId,
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      // Non-weekly jobs have no report surface.
      const plainId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Düz iş', $2, $3) RETURNING id`,
        [organizationId, staffA, managerId],
      )).rows[0]!.id;
      await expect(service.getWeeklyReport(
        actor(organizationId, staffA, 'STAFF'), plainId,
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
    });
  });

  it('includes live source work while editable', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        actor(organizationId, staffId, 'STAFF'),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      );
      await pool.query(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            accepted_at, accepted_by, started_at,
            staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by)
         VALUES ($1, 'GENERAL_TASK', 'COMPLETED', 'Tamamlanan iş', $2, $3,
            '2026-08-04T09:00:00.000Z', $2, '2026-08-05T08:00:00.000Z',
            '2026-08-05T09:00:00.000Z', $2, '2026-08-05T10:00:00.000Z', $3)`,
        [organizationId, staffId, managerId],
      );
      const detail = await service.getWeeklyReport(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      expect(detail.liveSourceWork).toHaveLength(1);
      expect(detail.liveSourceWork[0]).toMatchObject({
        type: 'GENERAL_TASK', title: 'Tamamlanan iş', statusAtSnapshot: 'COMPLETED',
      });
    });
  });
});
