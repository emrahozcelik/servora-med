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
import {
  MAX_BULK_TARGETS,
  parseWeeklyReportBulkRequestInput,
  parseWeeklyReportCreateInput,
} from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-08-03';
const WEEK_A_END = '2026-08-09';
const WEEK_A_DUE = '2026-08-10';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr3b_${randomUUID().replaceAll('-', '')}`;
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
    [`WR3B ${randomUUID()}`],
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
    [organizationId, `WR3B ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
  )).rows[0]!.id;
}

function buildService(pool: Pool, published: unknown[] = []) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date('2026-08-03T09:00:00.000Z'),
    { publish: (event) => { published.push(event); } },
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

function bulkBody(overrides: Record<string, unknown>) {
  return {
    clientActionId: randomUUID(),
    periodStart: WEEK_A,
    staffUserIds: [],
    ...overrides,
  };
}

/** Row census used to prove all-or-nothing behaviour. */
async function census(pool: Pool) {
  const jobs = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM job_cards WHERE type = 'WEEKLY_REPORT'`,
  );
  const reports = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM weekly_reports`);
  const receipts = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM processed_actions`);
  return { jobs: jobs.rows[0]!.n, reports: reports.rows[0]!.n, receipts: receipts.rows[0]!.n };
}

describe.skipIf(!databaseUrl)('weekly report bulk request (PostgreSQL)', () => {
  describe('authorization', () => {
    it('rejects STAFF on the bulk endpoint and creates nothing', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const otherStaffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const error = await service.bulkRequestWeeklyReports(
          staffActor(organizationId, staffId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: [staffId, otherStaffId] }),
          ),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('lets MANAGER request the same week for many active staff in one command', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: targets, questions: QUESTIONS, instructions: 'Haftalık özet' }),
          ),
        );
        expect(result.periodStart).toBe(WEEK_A);
        expect(result.periodEnd).toBe(WEEK_A_END);
        expect(result.dueDate).toBe(WEEK_A_DUE);
        expect(result.items).toHaveLength(3);
        expect(result.items.every((item) => item.outcome === 'created')).toBe(true);
        expect(await census(pool)).toEqual({ jobs: 3, reports: 3, receipts: 1 });
      });
    });

    it('lets ADMIN request the same week for multiple staff', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const adminId = await insertUser(pool, organizationId, 'ADMIN');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          adminActor(organizationId, adminId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        expect(result.items.map((item) => item.outcome)).toEqual(['created', 'created']);
      });
    });

    it('rejects the whole command when one target is inactive, creating nothing', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const inactiveStaffId = await insertUser(pool, organizationId, 'STAFF', false);
        const service = buildService(pool);
        const error = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [inactiveStaffId] })),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('rejects MANAGER and ADMIN users as targets', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const secondManagerId = await insertUser(pool, organizationId, 'MANAGER');
        const adminId = await insertUser(pool, organizationId, 'ADMIN');
        const service = buildService(pool);
        for (const target of [secondManagerId, adminId]) {
          const error = await service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [target] })),
          ).catch((caught: unknown) => caught);
          expect(error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        }
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('conceals unknown and cross-tenant targets as not-found', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const otherOrganizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const foreignStaffId = await insertUser(pool, otherOrganizationId, 'STAFF');
        const service = buildService(pool);
        for (const target of [randomUUID(), foreignStaffId]) {
          const error = await service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [target] })),
          ).catch((caught: unknown) => caught);
          expect(error).toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
        }
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });
  });

  describe('request shape', () => {
    it('rejects an empty target list', () => {
      expect(() => parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [] })))
        .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it(`rejects more than ${MAX_BULK_TARGETS} targets`, () => {
      const tooMany = Array.from({ length: MAX_BULK_TARGETS + 1 }, () => randomUUID());
      expect(() => parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: tooMany })))
        .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
      const atLimit = Array.from({ length: MAX_BULK_TARGETS }, () => randomUUID());
      expect(parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: atLimit })).staffUserIds)
        .toHaveLength(MAX_BULK_TARGETS);
    });

    it('rejects repeated target ids instead of silently de-duplicating', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        // Same uuid written twice in two different letter cases: still one
        // logical target, so it must be rejected as malformed.
        expect(() => parseWeeklyReportBulkRequestInput(
          bulkBody({ staffUserIds: [staffId, staffId.toUpperCase()] }),
        )).toThrowError(expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: { fieldErrors: { staffUserIds: 'Tekrarlanan personel kimliği.' } },
        }));
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('rejects malformed target ids and unknown body keys', () => {
      expect(() => parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: ['not-a-uuid'] })))
        .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
      expect(() => parseWeeklyReportBulkRequestInput({
        ...bulkBody({ staffUserIds: [randomUUID()] }), assignedTo: randomUUID(),
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('gives every target the identical canonical next-Monday deadline (B1)', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: targets }),
          ),
        );
        // One canonical receipt deadline: the Monday after the period.
        expect(result.dueDate).toBe(WEEK_A_DUE);
        const jobs = await pool.query<{ id: string; due_date: string }>(
          `SELECT id, due_date::text AS due_date FROM job_cards WHERE type = 'WEEKLY_REPORT' ORDER BY id`,
        );
        expect(jobs.rows).toHaveLength(3);
        expect(jobs.rows.every((job) => job.due_date === WEEK_A_DUE)).toBe(true);
      });
    });

    it('rejects a caller-supplied dueDate with atomic zero mutation (B2)', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const otherStaffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        // The public bulk shape has no dueDate field: exact parsing rejects it
        // as an unknown field instead of silently ignoring the deadline.
        expect(() => parseWeeklyReportBulkRequestInput(bulkBody({
          staffUserIds: [staffId, otherStaffId], dueDate: '2026-08-12',
        }))).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('rejects a non-Monday period and more than the technical question ceiling', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        expect(() => parseWeeklyReportBulkRequestInput(
          bulkBody({ staffUserIds: [staffId], periodStart: '2026-08-04' }),
        )).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        // One question past the technical ceiling (50) rejected.
        const error = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({
            staffUserIds: [staffId],
            questions: Array.from({ length: 51 }, (_, index) => ({
              key: `q${index}`, prompt: `Soru ${index}`,
            })),
          })),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
        // Far more than five questions are accepted (presets + custom questions).
        await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({
            staffUserIds: [staffId],
            questions: Array.from({ length: 12 }, (_, index) => ({
              key: index < 5 ? `preset_${index + 1}` : `custom_${index + 1}`,
              prompt: `Soru ${index + 1}?`,
            })),
          })),
        );
        const rows = await pool.query<{ manager_questions: unknown }>(
          `SELECT manager_questions FROM weekly_reports`,
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].manager_questions).toHaveLength(12);
      });
    });
  });

  describe('atomicity', () => {
    it('validates every target before creating any, leaving earlier valid targets unwritten', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const first = await insertUser(pool, organizationId, 'STAFF');
        const second = await insertUser(pool, organizationId, 'STAFF');
        const inactive = await insertUser(pool, organizationId, 'STAFF', false);
        const service = buildService(pool);
        const error = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: [first, second, inactive] }),
          ),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'FORBIDDEN' });
        // The first two targets are valid, yet nothing was written for them:
        // validation completed for all targets before the first insert.
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('rolls back every created JobCard and report when creation fails mid-command', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const original = PostgresJobCardTransaction.prototype.insertWeeklyReportRow;
        let calls = 0;
        const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'insertWeeklyReportRow')
          .mockImplementation(async function (
            this: PostgresJobCardTransaction,
            input: Parameters<typeof original>[0],
          ) {
            calls += 1;
            if (calls === 3) throw new Error('boom');
            return original.call(this, input);
          });
        try {
          await expect(service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
          )).rejects.toThrow('boom');
        } finally {
          spy.mockRestore();
        }
        expect(calls).toBe(3);
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
      });
    });

    it('leaves no receipt on failure so the same action id can be retried', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const clientActionId = randomUUID();
        const original = PostgresJobCardTransaction.prototype.insertWeeklyReportRow;
        let calls = 0;
        const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'insertWeeklyReportRow')
          .mockImplementation(async function (
            this: PostgresJobCardTransaction,
            input: Parameters<typeof original>[0],
          ) {
            calls += 1;
            if (calls === 2) throw new Error('boom');
            return original.call(this, input);
          });
        try {
          await expect(service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: targets })),
          )).rejects.toThrow('boom');
        } finally {
          spy.mockRestore();
        }
        expect(await census(pool)).toEqual({ jobs: 0, reports: 0, receipts: 0 });
        const retry = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: targets })),
        );
        expect(retry.items.map((item) => item.outcome)).toEqual(['created', 'created']);
        expect(await census(pool)).toEqual({ jobs: 2, reports: 2, receipts: 1 });
      });
    });
  });

  describe('duplicate convergence', () => {
    it('converges existing targets while creating the missing ones in one command', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const first = await insertUser(pool, organizationId, 'STAFF');
        const second = await insertUser(pool, organizationId, 'STAFF');
        const third = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const existingA = await service.createWeeklyReport(
          managerActor(organizationId, managerId),
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: first,
          }),
        );
        const existingC = await service.createWeeklyReport(
          managerActor(organizationId, managerId),
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: third,
          }),
        );
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [first, second, third] })),
        );
        expect(result.items.map((item) => [item.staffUserId, item.outcome])).toEqual([
          [first, 'existing'], [second, 'created'], [third, 'existing'],
        ]);
        expect(result.items[0]).toMatchObject({
          reportId: existingA.reportId, jobCardId: existingA.jobCardId,
        });
        expect(result.items[2]).toMatchObject({
          reportId: existingC.reportId, jobCardId: existingC.jobCardId,
        });
        // Only the missing target was created: A and C kept their original
        // canonical report and no duplicate JobCard appeared.
        expect(await census(pool)).toEqual({ jobs: 3, reports: 3, receipts: 3 });
        const forFirst = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM job_cards WHERE assigned_to = $1`, [first],
        );
        expect(forFirst.rows[0]!.n).toBe(1);
      });
    });

    it('reports duplicates as a mixed result, never as an overall error', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const existing = await insertUser(pool, organizationId, 'STAFF');
        const fresh = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        await service.createWeeklyReport(
          managerActor(organizationId, managerId),
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: existing,
          }),
        );
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [existing, fresh] })),
        );
        expect(result.items).toHaveLength(2);
        expect(result.items.filter((item) => item.outcome === 'existing')).toHaveLength(1);
        expect(result.items.filter((item) => item.outcome === 'created')).toHaveLength(1);
      });
    });

    it('returns all-existing without creating any JobCard', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const first = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        const published: unknown[] = [];
        const replayService = buildService(pool, published);
        const second = await replayService.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        expect(second.items.map((item) => item.outcome)).toEqual(['existing', 'existing']);
        // Same report identities, only the outcome differs (created → existing).
        expect(second.items.map((item) => [item.staffUserId, item.jobCardId, item.reportId]))
          .toEqual(first.items.map((item) => [item.staffUserId, item.jobCardId, item.reportId]));
        expect(published).toEqual([]);
        expect(await census(pool)).toEqual({ jobs: 2, reports: 2, receipts: 2 });
      });
    });

    it('converges a bulk item to the report created by a manager single request', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const single = await service.createWeeklyReport(
          managerActor(organizationId, managerId),
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
          }),
        );
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [staffId] })),
        );
        expect(result.items).toEqual([{
          staffUserId: staffId,
          jobCardId: single.jobCardId,
          reportId: single.reportId,
          outcome: 'existing',
        }]);
        expect(await census(pool)).toEqual({ jobs: 1, reports: 1, receipts: 2 });
      });
    });

    it('keeps single-create semantics when bulk created the canonical report first', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const bulk = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const conflict = await service.createWeeklyReport(
          managerActor(organizationId, managerId),
          parseWeeklyReportCreateInput({
            clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
          }),
        ).catch((caught: unknown) => caught);
        expect(conflict).toMatchObject({
          code: 'WEEKLY_REPORT_ALREADY_EXISTS',
          statusCode: 409,
          details: {
            reportId: bulk.items[0]!.reportId,
            jobCardId: bulk.items[0]!.jobCardId,
            periodStart: WEEK_A,
          },
        });
        // The rejected single create rolled its receipt back with its
        // transaction: only the bulk's completed receipt remains.
        expect(await census(pool)).toEqual({ jobs: 1, reports: 1, receipts: 1 });
      });
    });

    it('resolves the staff/week identity through the database when the pre-check misses', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const first = await service.createWeeklyReport(
          staffActor(organizationId, staffId),
          parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
        );
        // Force the locked pre-check to miss so the unique constraint has to
        // arbitrate. The losing insert must not abort the transaction: the
        // caller still reads the winner and raises the domain conflict.
        const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'getWeeklyReportByStaffWeek')
          .mockResolvedValueOnce(null);
        const conflict = await service.createWeeklyReport(
          staffActor(organizationId, staffId),
          parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
        ).catch((caught: unknown) => caught);
        spy.mockRestore();
        expect(conflict).toMatchObject({
          code: 'WEEKLY_REPORT_ALREADY_EXISTS',
          details: { reportId: first.reportId, jobCardId: first.jobCardId },
        });
        // The losing attempt left no orphaned JobCard behind.
        expect(await census(pool)).toEqual({ jobs: 1, reports: 1, receipts: 1 });
      });
    });
  });

  describe('idempotency', () => {
    it('replays the exact same logical result for the same action id and normalized request', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const clientActionId = randomUUID();
        const first = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: targets })),
        );
        // Same logical command, different target order: the receipt replays
        // the stored result (including its item order and report identities).
        const reordered = [targets[2]!, targets[0]!, targets[1]!];
        const replay = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: reordered })),
        );
        expect(replay).toEqual(first);
        expect(await census(pool)).toEqual({ jobs: 3, reports: 3, receipts: 1 });
      });
    });

    it('rejects the same action id with a different target set', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const first = await insertUser(pool, organizationId, 'STAFF');
        const second = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const clientActionId = randomUUID();
        await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: [first] })),
        );
        const error = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: [second] })),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
        expect(await census(pool)).toEqual({ jobs: 1, reports: 1, receipts: 1 });
      });
    });

    it('emits no extra creation side effects on replay', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const clientActionId = randomUUID();
        await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: targets })),
        );
        const before = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'JOB_CREATED'`,
        );
        const published: unknown[] = [];
        const replayService = buildService(pool, published);
        await replayService.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ clientActionId, staffUserIds: targets })),
        );
        const after = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM job_card_activity_logs WHERE event_type = 'JOB_CREATED'`,
        );
        expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
        expect(published).toEqual([]);
      });
    });
  });

  describe('concurrency', () => {
    it('serializes two concurrent bulks to exactly one canonical report per staff/week', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const outcomes = await Promise.allSettled([
          service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
          ),
          service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [...targets].reverse() })),
          ),
        ]);
        const fulfilled = outcomes.filter(
          (outcome): outcome is PromiseFulfilledResult<Awaited<
            ReturnType<typeof service.bulkRequestWeeklyReports>
          >> => outcome.status === 'fulfilled',
        );
        expect(fulfilled).toHaveLength(2);
        const created = fulfilled.flatMap(
          (outcome) => outcome.value.items.filter((item) => item.outcome === 'created'),
        );
        expect(created).toHaveLength(2);
        const perStaff = await pool.query<{ assigned_to: string; n: number }>(
          `SELECT assigned_to, COUNT(*)::int AS n FROM job_cards
            WHERE type = 'WEEKLY_REPORT' GROUP BY assigned_to`,
        );
        expect(perStaff.rows).toHaveLength(2);
        expect(perStaff.rows.every((row) => row.n === 1)).toBe(true);
        expect(await census(pool)).toEqual({ jobs: 2, reports: 2, receipts: 2 });
      });
    });

    it('serializes a bulk against a concurrent manager single request', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const outcomes = await Promise.allSettled([
          service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [staffId] })),
          ),
          service.createWeeklyReport(
            managerActor(organizationId, managerId),
            parseWeeklyReportCreateInput({
              clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
            }),
          ),
        ]);
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        // Either side may win the user lock: the winner creates, the loser
        // either converges (bulk `existing`) or fails with the domain
        // conflict. Never a raw DB error, never two canonical reports.
        for (const outcome of rejected) {
          expect(outcome.reason).toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
        }
        // Exactly one canonical report and JobCard exist. The receipt count
        // depends on which side won: a bulk that lost commits its `existing`
        // receipt, a rejected single create rolls its receipt back.
        const state = await census(pool);
        expect(state.jobs).toBe(1);
        expect(state.reports).toBe(1);
        expect([1, 2]).toContain(state.receipts);
      });
    });

    it('serializes a bulk against a concurrent staff self-create', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const service = buildService(pool);
        const outcomes = await Promise.allSettled([
          service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: [staffId] })),
          ),
          service.createWeeklyReport(
            staffActor(organizationId, staffId),
            parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
          ),
        ]);
        expect(fulfilledCount(outcomes)).toBeGreaterThanOrEqual(1);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
          }
        }
        const reports = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM weekly_reports`,
        );
        expect(reports.rows[0]!.n).toBe(1);
        const jobs = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM job_cards WHERE type = 'WEEKLY_REPORT'`,
        );
        expect(jobs.rows[0]!.n).toBe(1);
      });
    });
  });

  describe('child independence', () => {
    it('creates one independent JobCard and report per target', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        const jobIds = result.items.map((item) => item.jobCardId);
        const reportIds = result.items.map((item) => item.reportId);
        expect(new Set(jobIds).size).toBe(3);
        expect(new Set(reportIds).size).toBe(3);
        const rows = await pool.query<{ job_card_id: string; staff_user_id: string }>(
          `SELECT job_card_id, staff_user_id FROM weekly_reports`,
        );
        expect(new Set(rows.rows.map((row) => row.job_card_id)).size).toBe(3);
        expect(new Set(rows.rows.map((row) => row.staff_user_id)).size).toBe(3);
      });
    });

    it('freezes an independent question copy per report row', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: targets, questions: QUESTIONS }),
          ),
        );
        const rows = await pool.query<{ id: string; manager_questions: unknown }>(
          `SELECT id, manager_questions FROM weekly_reports ORDER BY id`,
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows.every((row) => JSON.stringify(row.manager_questions) === JSON.stringify(QUESTIONS)))
          .toBe(true);
        // Physical independence: rewriting one row's frozen questions cannot
        // reach the other report (no shared JSON object or reference table).
        await pool.query(
          `UPDATE weekly_reports SET manager_questions = '[]'::jsonb WHERE id = $1`,
          [result.items[0]!.reportId],
        );
        const after = await pool.query<{ id: string; manager_questions: unknown }>(
          `SELECT id, manager_questions FROM weekly_reports ORDER BY id`,
        );
        const untouched = after.rows.find((row) => row.id === result.items[1]!.reportId);
        expect(JSON.stringify(untouched!.manager_questions)).toBe(JSON.stringify(QUESTIONS));
      });
    });

    it('keeps draft versions independent across children', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        const [firstJob, secondJob] = result.items.map((item) => item.jobCardId);
        await service.acceptAssignment(
          staffActor(organizationId, targets[0]!),
          firstJob!,
          { expectedVersion: 1, clientActionId: randomUUID() },
        );
        await service.updateWeeklyReportDraft(
          staffActor(organizationId, targets[0]!),
          firstJob!,
          { expectedVersion: 1, draft: { summary: 'Yalnız birinci rapor' }, answers: [] },
        );
        const versions = await pool.query<{ id: string; version: number }>(
          `SELECT id, version FROM weekly_reports`,
        );
        const byId = new Map(versions.rows.map((row) => [row.id, row.version]));
        expect(byId.get(result.items[0]!.reportId)).toBe(2);
        expect(byId.get(result.items[1]!.reportId)).toBe(1);
        // The second child is still editable at its own version.
        expect((await service.getWeeklyReport(
          managerActor(organizationId, managerId), secondJob!,
        )).draft.summary).toBeNull();
      });
    });

    it('writes one creation activity per child with its own assignee', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        const rows = await pool.query<{ assigned_to: string; n: number }>(
          `SELECT j.assigned_to, COUNT(a.id)::int AS n
             FROM job_cards j
             JOIN job_card_activity_logs a
               ON a.organization_id = j.organization_id AND a.job_card_id = j.id
              AND a.event_type = 'JOB_CREATED'
            WHERE j.type = 'WEEKLY_REPORT'
            GROUP BY j.assigned_to`,
        );
        expect(new Set(rows.rows.map((row) => row.assigned_to))).toEqual(new Set(targets));
        expect(rows.rows.every((row) => row.n === 1)).toBe(true);
      });
    });

    it('keeps lifecycle transitions independent across children', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: targets })),
        );
        await service.acceptAssignment(
          staffActor(organizationId, targets[0]!),
          result.items[0]!.jobCardId,
          { expectedVersion: 1, clientActionId: randomUUID() },
        );
        const statuses = await pool.query<{ status: string }>(
          `SELECT status FROM job_cards WHERE type = 'WEEKLY_REPORT' ORDER BY assigned_to`,
        );
        expect(statuses.rows.map((row) => row.status).sort()).toEqual(['ACCEPTED', 'NEW']);
      });
    });

    it('serves each child through the single-report read path without aliasing', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(
            bulkBody({ staffUserIds: targets, instructions: 'Haftalık özet' }),
          ),
        );
        for (const [index, item] of result.items.entries()) {
          const detail = await service.getWeeklyReport(
            managerActor(organizationId, managerId), item.jobCardId,
          );
          expect(detail.id).toBe(item.reportId);
          expect(detail.staffUserId).toBe(targets[index]);
          expect(detail.jobCardId).toBe(item.jobCardId);
          expect(detail.periodStart).toBe(WEEK_A);
          expect(detail.periodEnd).toBe(WEEK_A_END);
          expect(detail.dueDate).toBe(WEEK_A_DUE);
          expect(detail.instructions).toBe('Haftalık özet');
          expect(detail.version).toBe(1);
        }
      });
    });
  });

  describe('ordering', () => {
    it('returns one item per requested staff id in request order', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        // Deliberately neither sorted nor reverse-sorted.
        const requested = [targets[1]!, targets[2]!, targets[0]!];
        const result = await service.bulkRequestWeeklyReports(
          managerActor(organizationId, managerId),
          parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: requested })),
        );
        expect(result.items.map((item) => item.staffUserId)).toEqual(requested);
      });
    });

    it('locks targets in a deterministic order regardless of request order', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = [
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
          await insertUser(pool, organizationId, 'STAFF'),
        ];
        const service = buildService(pool);
        // A rotation of the SORTED ids: guaranteed to differ from the lock
        // order for three distinct uuids, without depending on how the
        // randomly generated ids happen to sort.
        const sortedTargets = [...targets].sort();
        const requested = [sortedTargets[2]!, sortedTargets[0]!, sortedTargets[1]!];
        const lockOrder: string[] = [];
        const original = PostgresJobCardTransaction.prototype.getAssigneeForUpdate;
        const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'getAssigneeForUpdate')
          .mockImplementation(function (
            this: PostgresJobCardTransaction,
            organizationIdArgument: string,
            userId: string,
          ) {
            lockOrder.push(userId);
            return original.call(this, organizationIdArgument, userId);
          });
        try {
          await service.bulkRequestWeeklyReports(
            managerActor(organizationId, managerId),
            parseWeeklyReportBulkRequestInput(bulkBody({ staffUserIds: requested })),
          );
        } finally {
          spy.mockRestore();
        }
        expect(lockOrder).toEqual(sortedTargets);
        expect(lockOrder).not.toEqual(requested);
      });
    });
  });
});

function fulfilledCount(outcomes: PromiseSettledResult<unknown>[]): number {
  return outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
}
