import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresJobCardRepository,
  PostgresJobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-08-03';
const WEEK_A_END = '2026-08-09';
const WEEK_A_DUE = '2026-08-10';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2c_${randomUUID().replaceAll('-', '')}`;
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
    [`WR2C ${randomUUID()}`],
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
    [organizationId, `WR2C ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
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

function staffActor(organizationId: string, id: string): JobCardActor {
  return { id, organizationId, role: 'STAFF' };
}

function managerActor(organizationId: string, id: string): JobCardActor {
  return { id, organizationId, role: 'MANAGER' };
}

function adminActor(organizationId: string, id: string): JobCardActor {
  return { id, organizationId, role: 'ADMIN' };
}

const QUESTIONS = [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }];

describe.skipIf(!databaseUrl)('weekly report creation (PostgreSQL)', () => {
  it('lets STAFF self-create an ACCEPTED report with canonical accepted evidence', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, instructions: 'Talimat.',
        }),
      );
      expect(created).toMatchObject({
        staffUserId: staffId, periodStart: WEEK_A, periodEnd: WEEK_A_END,
        status: 'ACCEPTED', dueDate: WEEK_A_DUE,
      });
      const job = (await pool.query(
        `SELECT status, customer_id, due_date::text AS due_date, title, description,
                accepted_at, accepted_by, scheduled_at
           FROM job_cards WHERE id = $1`,
        [created.jobCardId],
      )).rows[0];
      expect(job.status).toBe('ACCEPTED');
      expect(job.customer_id).toBeNull();
      expect(job.due_date).toBe(WEEK_A_DUE);
      expect(job.title).toBe(`Haftalık Rapor (${WEEK_A} – ${WEEK_A_END})`);
      expect(job.description).toBe('Talimat.');
      expect(job.accepted_at).not.toBeNull();
      expect(job.accepted_by).toBe(staffId);
      expect(job.scheduled_at).toBeNull();
      const report = (await pool.query(
        `SELECT staff_user_id, period_start::text AS period_start, manager_questions, version
           FROM weekly_reports WHERE id = $1`,
        [created.reportId],
      )).rows[0];
      expect(report.staff_user_id).toBe(staffId);
      expect(report.period_start).toBe(WEEK_A);
      expect(report.manager_questions).toEqual([]);
      expect(report.version).toBe(1);
      const activity = (await pool.query(
        `SELECT event_type, new_value FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, created.jobCardId],
      )).rows;
      expect(activity).toHaveLength(1);
      expect(activity[0].event_type).toBe('JOB_CREATED');
      expect(activity[0].new_value).toMatchObject({ status: 'ACCEPTED', acceptedBy: staffId });
    });
  });

  it('rejects STAFF creating for another user or smuggling questions', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      await expect(service.createWeeklyReport(
        staffActor(organizationId, staffA),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffB,
        }),
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.createWeeklyReport(
        staffActor(organizationId, staffA),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, questions: QUESTIONS,
        }),
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('lets MANAGER and ADMIN request one NEW report for active STAFF with frozen questions', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const adminId = await insertUser(pool, organizationId, 'ADMIN');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const requested = await service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffA,
          questions: QUESTIONS, dueDate: '2026-08-12',
        }),
      );
      expect(requested).toMatchObject({ staffUserId: staffA, status: 'NEW', dueDate: '2026-08-12' });
      const job = (await pool.query(
        `SELECT status, accepted_at, accepted_by FROM job_cards WHERE id = $1`,
        [requested.jobCardId],
      )).rows[0];
      expect(job.status).toBe('NEW');
      expect(job.accepted_at).toBeNull();
      expect(job.accepted_by).toBeNull();
      const report = (await pool.query(
        `SELECT manager_questions FROM weekly_reports WHERE id = $1`,
        [requested.reportId],
      )).rows[0];
      expect(report.manager_questions).toEqual(QUESTIONS);
      const adminCreated = await service.createWeeklyReport(
        adminActor(organizationId, adminId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffB,
        }),
      );
      expect(adminCreated.status).toBe('NEW');
      // Manager without target, inactive/non-staff/cross-tenant targets rejected.
      await expect(service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const inactiveId = await insertUser(pool, organizationId, 'STAFF', false);
      await expect(service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: inactiveId,
        }),
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: managerId,
        }),
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const otherOrg = await insertOrg(pool);
      const foreignStaff = await insertUser(pool, otherOrg, 'STAFF');
      await expect(service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: foreignStaff,
        }),
      )).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND' });
      // Sixth question rejected.
      await expect(service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: '2026-08-10', assignedTo: staffA,
          questions: [1, 2, 3, 4, 5, 6].map((n) => ({ key: `q${n}`, prompt: 'Soru?' })),
        }),
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('converges idempotent retries and rejects reused keys with different payloads', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const actionId = randomUUID();
      const first = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({ clientActionId: actionId, periodStart: WEEK_A }),
      );
      const replay = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({ clientActionId: actionId, periodStart: WEEK_A }),
      );
      expect(replay).toEqual(first);
      await expect(service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({
          clientActionId: actionId, periodStart: '2026-08-10',
        }),
      )).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
    });
  });

  it('reports deterministic conflicts across self/manager paths with navigation metadata', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const first = await service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
        }),
      );
      // Self-create after manager request for the same week → existing conflict.
      const selfConflict = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      ).catch((error: unknown) => error);
      expect(selfConflict).toMatchObject({
        code: 'WEEKLY_REPORT_ALREADY_EXISTS',
        details: { reportId: first.reportId, jobCardId: first.jobCardId, periodStart: WEEK_A },
      });
      // Manager request after self-create for another week, then duplicate request.
      const otherWeek = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: '2026-08-10' }),
      );
      const managerConflict = await service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: '2026-08-10', assignedTo: staffId,
        }),
      ).catch((error: unknown) => error);
      expect(managerConflict).toMatchObject({
        code: 'WEEKLY_REPORT_ALREADY_EXISTS',
        details: { reportId: otherWeek.reportId, jobCardId: otherWeek.jobCardId },
      });
    });
  });

  it('serializes transaction races to exactly one canonical report', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const outcomes = await Promise.allSettled([randomUUID(), randomUUID()].map((clientActionId) =>
        service.createWeeklyReport(
          staffActor(organizationId, staffId),
          parseWeeklyReportCreateInput({ clientActionId, periodStart: WEEK_A }),
        ),
      ));
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof service.createWeeklyReport>>> =>
          outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
      const jobs = await pool.query(`SELECT COUNT(*)::int AS n FROM job_cards`);
      const reports = await pool.query(`SELECT COUNT(*)::int AS n FROM weekly_reports`);
      expect(jobs.rows[0].n).toBe(1);
      expect(reports.rows[0].n).toBe(1);
    });
  });

  it('rolls back the JobCard when report insertion fails', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'insertWeeklyReportRow')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        await expect(service.createWeeklyReport(
          staffActor(organizationId, staffId),
          parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
        )).rejects.toThrow('boom');
      } finally {
        spy.mockRestore();
      }
      const jobs = await pool.query(`SELECT COUNT(*)::int AS n FROM job_cards`);
      const reports = await pool.query(`SELECT COUNT(*)::int AS n FROM weekly_reports`);
      const actions = await pool.query(
        `SELECT COUNT(*)::int AS n FROM processed_actions WHERE operation_key = 'WEEKLY_REPORT_CREATE'`,
      );
      expect(jobs.rows[0].n).toBe(0);
      expect(reports.rows[0].n).toBe(0);
      // Failed attempts leave no completed idempotency receipt behind.
      expect(actions.rows[0].n).toBe(0);
    });
  });

  it('rejects malformed periods and past claims stay untouched', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      expect(() => parseWeeklyReportCreateInput({
        clientActionId: randomUUID(), periodStart: '2026-08-04',
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
      expect(() => parseWeeklyReportCreateInput({
        clientActionId: randomUUID(), periodStart: WEEK_A, bogus: 1,
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
      expect(() => parseWeeklyReportCreateInput({
        clientActionId: randomUUID(), periodStart: WEEK_A, dueDate: 'not-a-date',
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });
  });
});
