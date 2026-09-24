import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresWeeklyReportRepository } from '../src/modules/weekly-reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// 2026-08-03 and 2026-08-10 are Mondays; 2026-08-04 is the in-between Tuesday.
const WEEK_A = '2026-08-03';
const WEEK_B = '2026-08-10';
const TUESDAY = '2026-08-04';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr1_${randomUUID().replaceAll('-', '')}`;
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
    [`WR1 ${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  active = true,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [organizationId, `WR1 ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
  )).rows[0]!.id;
}

async function insertJob(
  pool: Pool,
  organizationId: string,
  type: string,
  assignedTo: string,
  createdBy: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
     VALUES ($1, $2, 'NEW', 'WR1 fixture', $3, $4) RETURNING id`,
    [organizationId, type, assignedTo, createdBy],
  )).rows[0]!.id;
}

async function insertActivity(pool: Pool, organizationId: string, jobCardId: string, actorId: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
    [organizationId, jobCardId, actorId],
  )).rows[0]!.id;
}

const QUESTIONS = [
  { key: 'q1', prompt: 'Bu hafta hangi müşteride satış fırsatı gördün?' },
  { key: 'q2', prompt: 'En çok hangi ürün soruldu?' },
];

const FULL_DRAFT = {
  summary: 'Haftanın özeti.',
  blockers: 'Sorunlar ve engeller.',
  nextWeekPlan: 'Gelecek hafta planı.',
  highlights: 'Öne çıkan kazanım.',
  fieldObservations: null,
  supportNeeded: null,
};

const FULL_ANSWERS = [
  { questionKey: 'q1', answer: 'X kliniğinde fırsat.' },
  { questionKey: 'q2', answer: 'Y ürünü soruldu.' },
];

const SOURCE_WORK = [
  {
    jobCardId: '11111111-1111-4111-8111-111111111111',
    type: 'GENERAL_TASK',
    title: 'Klinik ziyareti',
    customerName: 'Örnek Klinik',
    staffCompletedAt: '2026-08-05T09:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  },
];

describe.skipIf(!databaseUrl)('weekly report repository (PostgreSQL)', () => {
  it('accepts the WEEKLY_REPORT literal while other type constraints hold', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      for (const type of ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT']) {
        const customerId = type === 'GENERAL_TASK' || type === 'WEEKLY_REPORT'
          ? null
          : (await pool.query<{ id: string }>(
            `INSERT INTO customers (organization_id, name, customer_type, status)
             VALUES ($1, 'WR1 Klinik', 'clinic', 'active') RETURNING id`,
            [organizationId],
          )).rows[0]!.id;
        const scheduledAt = type === 'GENERAL_TASK' || type === 'WEEKLY_REPORT' ? null : '2026-08-05T07:00:00.000Z';
        const scheduledEndsAt = type === 'PRODUCT_DELIVERY' ? '2026-08-05T07:30:00.000Z'
          : type === 'SALES_MEETING' ? '2026-08-05T08:00:00.000Z' : null;
        const engagementKind = type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
        await pool.query(
          `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by, scheduled_at, scheduled_ends_at, engagement_kind)
           VALUES ($1, $2, 'NEW', 'WR1 type probe', $3, $4, $5, $6, $7, $8)`,
          [organizationId, type, customerId, staffId, managerId, scheduledAt, scheduledEndsAt, engagementKind],
        );
      }
      await expect(pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'BOGUS_TYPE', 'NEW', 'WR1 bogus', $2, $3)`,
        [organizationId, staffId, managerId],
      )).rejects.toThrow();
    });
  });

  it('enforces one canonical report per organization, staff and week', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const jobA1 = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffA, managerId);
      const created = await repo.createReport({
        organizationId, jobCardId: jobA1, staffUserId: staffA, periodStart: WEEK_A, questions: QUESTIONS,
      });
      expect(created.periodStart).toBe(WEEK_A);
      expect(created.periodEnd).toBe('2026-08-09');
      expect(created.version).toBe(1);
      expect(created.questions).toEqual(QUESTIONS);

      // Same staff + same week on another job: deterministic conflict.
      const jobA2 = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffA, managerId);
      const conflict = await repo.createReport({
        organizationId, jobCardId: jobA2, staffUserId: staffA, periodStart: WEEK_A, questions: [],
      }).catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(AppError);
      expect((conflict as AppError).code).toBe('WEEKLY_REPORT_ALREADY_EXISTS');
      expect((conflict as AppError).message).toBe('Bu personel için bu haftaya ait rapor zaten mevcut.');

      // Same staff + different week: allowed. Different staff + same week: allowed.
      const jobA3 = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffA, managerId);
      await expect(repo.createReport({
        organizationId, jobCardId: jobA3, staffUserId: staffA, periodStart: WEEK_B, questions: [],
      })).resolves.toMatchObject({ periodStart: WEEK_B });
      const jobB1 = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffB, managerId);
      await expect(repo.createReport({
        organizationId, jobCardId: jobB1, staffUserId: staffB, periodStart: WEEK_A, questions: [],
      })).resolves.toMatchObject({ staffUserId: staffB });

      // One report per JobCard even across staff: separate invariant.
      const cross = await repo.createReport({
        organizationId, jobCardId: jobA1, staffUserId: staffB, periodStart: WEEK_B, questions: [],
      }).catch((error: unknown) => error);
      expect((cross as AppError).code).toBe('WEEKLY_REPORT_JOB_ATTACHED');

      // Cross-organization uniqueness is independent.
      const org2 = await insertOrg(pool);
      const manager2 = await insertUser(pool, org2, 'MANAGER');
      const staff2 = await insertUser(pool, org2, 'STAFF');
      const job2 = await insertJob(pool, org2, 'WEEKLY_REPORT', staff2, manager2);
      await expect(repo.createReport({
        organizationId: org2, jobCardId: job2, staffUserId: staff2, periodStart: WEEK_A, questions: [],
      })).resolves.toMatchObject({ periodStart: WEEK_A });
    });
  });

  it('rejects non-Monday periods in validation and at the DB boundary', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const jobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      await expect(repo.createReport({
        organizationId, jobCardId: jobId, staffUserId: staffId, periodStart: TUESDAY, questions: [],
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      // DB safety net independent of application validation.
      await expect(pool.query(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, $4, $4)`,
        [organizationId, jobId, staffId, TUESDAY],
      )).rejects.toThrow();
      await expect(pool.query(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, $4, $4)`,
        [organizationId, jobId, staffId, WEEK_A],
      )).rejects.toThrow();
    });
  });

  it('refuses report rows for non-weekly jobs, non-staff and inactive staff', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const plainJob = await insertJob(pool, organizationId, 'GENERAL_TASK', staffId, managerId);
      const weeklyJob = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      await expect(repo.createReport({
        organizationId, jobCardId: plainJob, staffUserId: staffId, periodStart: WEEK_A, questions: [],
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE' });
      await expect(repo.createReport({
        organizationId, jobCardId: weeklyJob, staffUserId: managerId, periodStart: WEEK_A, questions: [],
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const inactiveId = await insertUser(pool, organizationId, 'STAFF', false);
      const inactiveJob = await insertJob(pool, organizationId, 'WEEKLY_REPORT', inactiveId, managerId);
      await expect(repo.createReport({
        organizationId, jobCardId: inactiveJob, staffUserId: inactiveId, periodStart: WEEK_A, questions: [],
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('versions drafts optimistically and isolates tenants and owners', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const jobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffA, managerId);
      const created = await repo.createReport({
        organizationId, jobCardId: jobId, staffUserId: staffA, periodStart: WEEK_A, questions: QUESTIONS,
      });
      const updated = await repo.updateDraft({
        organizationId, reportId: created.id, staffUserId: staffA, expectedVersion: 1,
        draft: { summary: 'Taslak özet.' }, answers: [{ questionKey: 'q1', answer: 'Kısmi.' }],
      });
      expect(updated.version).toBe(2);
      expect(updated.draft.summary).toBe('Taslak özet.');
      expect(updated.answers).toEqual([{ questionKey: 'q1', answer: 'Kısmi.' }]);
      // Stale version, foreign owner and foreign tenant all fail deterministically.
      await expect(repo.updateDraft({
        organizationId, reportId: created.id, staffUserId: staffA, expectedVersion: 1,
        draft: {}, answers: [],
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(repo.updateDraft({
        organizationId, reportId: created.id, staffUserId: staffB, expectedVersion: 2,
        draft: {}, answers: [],
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(repo.updateDraft({
        organizationId: organizationId, reportId: created.id, staffUserId: staffA, expectedVersion: 2,
        draft: {}, answers: [{ questionKey: 'nope', answer: 'x' }],
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const org2 = await insertOrg(pool);
      await expect(repo.updateDraft({
        organizationId: org2, reportId: created.id, staffUserId: staffA, expectedVersion: 2,
        draft: {}, answers: [],
      })).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      expect(await repo.getReportByStaffWeek(organizationId, staffA, WEEK_A)).toMatchObject({ id: created.id });
      expect(await repo.getReportByStaffWeek(organizationId, staffA, WEEK_B)).toBeNull();
    });
  });

  it('appends immutable submissions that survive later draft edits', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const otherId = await insertUser(pool, organizationId, 'STAFF');
      const jobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      const activityId = await insertActivity(pool, organizationId, jobId, staffId);
      const created = await repo.createReport({
        organizationId, jobCardId: jobId, staffUserId: staffId, periodStart: WEEK_A, questions: QUESTIONS,
      });
      // Incomplete payloads fail closed before any row is written.
      await expect(repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: staffId,
        submittedAt: new Date('2026-08-09T12:00:00.000Z'),
        draft: FULL_DRAFT, answers: [{ questionKey: 'q1', answer: 'Kısmi.' }],
        sourceWork: SOURCE_WORK, jobVersion: 1, sourceActivityId: activityId,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(repo.listSubmissions(organizationId, created.id)).resolves.toEqual([]);
      await expect(repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: otherId,
        submittedAt: new Date('2026-08-09T12:00:00.000Z'),
        draft: FULL_DRAFT, answers: FULL_ANSWERS,
        sourceWork: SOURCE_WORK, jobVersion: 1, sourceActivityId: activityId,
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const first = await repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: staffId,
        submittedAt: new Date('2026-08-09T12:00:00.000Z'),
        draft: FULL_DRAFT, answers: FULL_ANSWERS,
        sourceWork: SOURCE_WORK, jobVersion: 1, sourceActivityId: activityId,
      });
      expect(first.seqNo).toBe(1);
      expect(first.body.summary).toBe('Haftanın özeti.');
      expect(first.periodStart).toBe(WEEK_A);
      expect(first.sourceWork).toEqual(SOURCE_WORK);

      // Later draft edits and a second submission leave seq 1 byte-identical.
      await repo.updateDraft({
        organizationId, reportId: created.id, staffUserId: staffId, expectedVersion: 1,
        draft: { ...FULL_DRAFT, summary: 'Revize özet.' }, answers: FULL_ANSWERS,
      });
      const second = await repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: staffId,
        submittedAt: new Date('2026-08-10T12:00:00.000Z'),
        draft: { ...FULL_DRAFT, summary: 'Revize özet.' }, answers: FULL_ANSWERS,
        sourceWork: SOURCE_WORK, jobVersion: 2, sourceActivityId: activityId,
      });
      expect(second.seqNo).toBe(2);
      const history = await repo.listSubmissions(organizationId, created.id);
      expect(history.map((entry) => entry.seqNo)).toEqual([1, 2]);
      expect(history[0]).toEqual(first);
      expect(history[1]!.body.summary).toBe('Revize özet.');

      // No repository path mutates submission content.
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
      for (const forbidden of ['updateSubmission', 'deleteSubmission', 'patchSubmission']) {
        expect(surface).not.toContain(forbidden);
      }
    });
  });

  it('maps cross-job source activities to a deterministic domain error (no raw 23503)', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const jobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      const otherJobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      const foreignActivityId = await insertActivity(pool, organizationId, otherJobId, staffId);
      const created = await repo.createReport({
        organizationId, jobCardId: jobId, staffUserId: staffId, periodStart: WEEK_A, questions: QUESTIONS,
      });
      await expect(repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: staffId,
        submittedAt: new Date('2026-08-09T12:00:00.000Z'),
        draft: FULL_DRAFT, answers: FULL_ANSWERS,
        sourceWork: SOURCE_WORK, jobVersion: 1, sourceActivityId: foreignActivityId,
      })).rejects.toMatchObject({ code: 'WEEKLY_REPORT_SOURCE_MISMATCH' });
      await expect(repo.listSubmissions(organizationId, created.id)).resolves.toEqual([]);
    });
  });

  it('rejects non-instant submittedAt before any row is written', async () => {
    await withSchema(async (pool) => {
      const repo = new PostgresWeeklyReportRepository(pool);
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const jobId = await insertJob(pool, organizationId, 'WEEKLY_REPORT', staffId, managerId);
      const activityId = await insertActivity(pool, organizationId, jobId, staffId);
      const created = await repo.createReport({
        organizationId, jobCardId: jobId, staffUserId: staffId, periodStart: WEEK_A, questions: QUESTIONS,
      });
      await expect(repo.appendSubmission({
        organizationId, reportId: created.id, submittedBy: staffId,
        submittedAt: new Date('invalid'),
        draft: FULL_DRAFT, answers: FULL_ANSWERS,
        sourceWork: SOURCE_WORK, jobVersion: 1, sourceActivityId: activityId,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(repo.listSubmissions(organizationId, created.id)).resolves.toEqual([]);
    });
  });
});
