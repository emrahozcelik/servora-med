import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { toErrorResponse } from '../src/errors/index.js';
import {
  createOverdueBreachScanner,
  PostgresOverdueBreachScannerRepository,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  parseWeeklyReportBulkRequestInput,
  parseWeeklyReportCreateInput,
} from '../src/modules/weekly-reports/create-input.js';
import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { weekInstants } from '../src/modules/weekly-reports/source-work.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr_week_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, timezone = 'Europe/Istanbul'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [`WR-WEEK ${randomUUID()}`, timezone],
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
    [organizationId, `WR-WEEK ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function buildServiceAt(pool: Pool, iso: string | (() => Date)): JobCardService {
  const clock = typeof iso === 'function' ? iso : () => new Date(iso);
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    clock,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

function actor(organizationId: string, id: string, role: JobCardActor['role']): JobCardActor {
  return { id, organizationId, role };
}

async function insertCompletedSourceJob(
  pool: Pool,
  input: {
    organizationId: string;
    staffId: string;
    managerId: string;
    title: string;
    staffCompletedAt: string;
  },
): Promise<string> {
  const completed = new Date(input.staffCompletedAt);
  const accepted = new Date(completed.getTime() - 7_200_000).toISOString();
  const started = new Date(completed.getTime() - 3_600_000).toISOString();
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at,
        staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by)
     VALUES ($1, 'GENERAL_TASK', 'COMPLETED', $2, $3, $4,
             $5, $3, $6, $7, $3, $7, $4)
     RETURNING id`,
    [
      input.organizationId,
      input.title,
      input.staffId,
      input.managerId,
      accepted,
      started,
      input.staffCompletedAt,
    ],
  )).rows[0]!.id;
}

const VALID_BODY = {
  summary: 'Haftalık saha çalışmaları tamamlandı.',
  blockers: null,
  nextWeekPlan: 'Gelecek hafta klinik ziyaretleri.',
  highlights: null,
  fieldObservations: null,
  supportNeeded: null,
};

describe.skipIf(!databaseUrl)('WR-WEEK working-week period, Monday deadline & legacy compatibility (PostgreSQL)', () => {
  it('A1–A3: derives Monday–Saturday reference period, today, and Monday due date in Europe/Istanbul', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const manager = actor(organizationId, managerId, 'MANAGER');
      const staff = actor(organizationId, staffId, 'STAFF');

      // A1: Friday 2026-11-20 10:00 Europe/Istanbul (07:00Z).
      const friService = buildServiceAt(pool, '2026-11-20T07:00:00.000Z');
      const a1Expected = {
        timezone: 'Europe/Istanbul',
        today: '2026-11-20',
        periodStart: '2026-11-16',
        periodEnd: '2026-11-21',
        dueDate: '2026-11-23',
      };
      expect(await friService.weeklyReportReference(manager)).toEqual(a1Expected);
      expect(await friService.weeklyReportReference(staff)).toEqual(a1Expected);

      // A2: Sunday 2026-11-22 Europe/Istanbul still references the just-ended working week,
      // with dueDate = 2026-11-23 (Monday).
      const sunService = buildServiceAt(pool, '2026-11-22T10:00:00.000Z');
      expect(await sunService.weeklyReportReference(manager)).toEqual({
        timezone: 'Europe/Istanbul',
        today: '2026-11-22',
        periodStart: '2026-11-16',
        periodEnd: '2026-11-21',
        dueDate: '2026-11-23',
      });

      // A3: Monday 2026-11-23 00:30 Europe/Istanbul (Sunday 21:30Z) advances to the new working week.
      const monService = buildServiceAt(pool, '2026-11-22T21:30:00.000Z');
      expect(await monService.weeklyReportReference(manager)).toEqual({
        timezone: 'Europe/Istanbul',
        today: '2026-11-23',
        periodStart: '2026-11-23',
        periodEnd: '2026-11-28',
        dueDate: '2026-11-30',
      });
    });
  });

  it('A4: single create and bulk request persist 6-day period, Monday due date and 6-day title', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const staffC = await insertUser(pool, organizationId, 'STAFF');
      const service = buildServiceAt(pool, '2026-11-20T07:00:00.000Z');
      const manager = actor(organizationId, managerId, 'MANAGER');

      const bulk = await service.bulkRequestWeeklyReports(
        manager,
        parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          staffUserIds: [staffA, staffB],
        }),
      );
      expect(bulk.periodStart).toBe('2026-11-16');
      expect(bulk.periodEnd).toBe('2026-11-21');
      expect(bulk.dueDate).toBe('2026-11-23');
      expect(bulk.items.map((item) => item.outcome)).toEqual(['created', 'created']);

      const single = await service.createWeeklyReport(
        manager,
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          assignedTo: staffC,
        }),
      );
      expect(single).toMatchObject({
        periodStart: '2026-11-16',
        periodEnd: '2026-11-21',
        dueDate: '2026-11-23',
      });

      const jobs = (await pool.query<{ title: string; due_date: string }>(
        `SELECT title, due_date::text AS due_date FROM job_cards
          WHERE organization_id = $1 AND type = 'WEEKLY_REPORT'`,
        [organizationId],
      )).rows;
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.due_date).toBe('2026-11-23');
        expect(job.title).toBe('Haftalık Rapor (2026-11-16 – 2026-11-21)');
      }

      const reports = (await pool.query<{ period_start: string; period_end: string }>(
        `SELECT period_start::text AS period_start, period_end::text AS period_end
           FROM weekly_reports WHERE organization_id = $1`,
        [organizationId],
      )).rows;
      expect(reports).toHaveLength(3);
      for (const report of reports) {
        expect(report.period_start).toBe('2026-11-16');
        expect(report.period_end).toBe('2026-11-21');
      }
    });
  });

  it('A5: rejects caller-supplied periodEnd or dueDate fields at parser and HTTP boundaries', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildServiceAt(pool, '2026-11-20T07:00:00.000Z');
      const manager = actor(organizationId, managerId, 'MANAGER');

      for (const extra of [{ periodEnd: '2026-11-21' }, { dueDate: '2026-11-23' }]) {
        expect(() => parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          assignedTo: staffId,
          ...extra,
        })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));

        expect(() => parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          staffUserIds: [staffId],
          ...extra,
        })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
      }

      const app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const res = toErrorResponse(error);
        reply.code(res.statusCode).send(res.body);
      });
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards',
        service,
        authenticate: async (request) => {
          request.currentUser = {
            ...manager,
            name: 'Manager',
            email: 'manager@test.local',
            isActive: true,
            mustChangePassword: false,
            version: 1,
          };
        },
      });
      try {
        for (const extra of [{ periodEnd: '2026-11-21' }, { dueDate: '2026-11-24' }]) {
          const singleRes = await app.inject({
            method: 'POST',
            url: '/api/job-cards/weekly-reports',
            payload: {
              clientActionId: randomUUID(),
              periodStart: '2026-11-16',
              assignedTo: staffId,
              ...extra,
            },
          });
          expect(singleRes.statusCode).toBe(400);

          const bulkRes = await app.inject({
            method: 'POST',
            url: '/api/job-cards/weekly-reports/bulk-request',
            payload: {
              clientActionId: randomUUID(),
              periodStart: '2026-11-16',
              staffUserIds: [staffId],
              ...extra,
            },
          });
          expect(bulkRes.statusCode).toBe(400);
        }
      } finally {
        await app.close();
      }

      const counts = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM weekly_reports`);
      expect(counts.rows[0]!.n).toBe(0);
    });
  });

  it('A6: report is not overdue on Monday 23:59 and becomes overdue at Tuesday 00:00 (Europe/Istanbul)', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const manager = actor(organizationId, managerId, 'MANAGER');
      const staff = actor(organizationId, staffId, 'STAFF');

      const created = await buildServiceAt(pool, '2026-11-16T07:00:00.000Z').createWeeklyReport(
        staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: '2026-11-16' }),
      );
      await buildServiceAt(pool, '2026-11-16T08:00:00.000Z').start(
        staff,
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 1 },
      );
      // Pin started_at to the test's simulated Monday start (reserveLifecycleIntent
      // stamps clock_timestamp(), which would otherwise exceed past scan times).
      await pool.query(
        `UPDATE job_cards SET started_at = '2026-11-16T08:00:00.000Z' WHERE id = $1`,
        [created.jobCardId],
      );

      // Monday 2026-11-23 23:59 Europe/Istanbul = 2026-11-23T20:59:00.000Z.
      const beforeMidnight = await buildServiceAt(pool, '2026-11-23T20:59:00.000Z').list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      expect(beforeMidnight.items.some((item) => item.id === created.jobCardId)).toBe(false);

      // Tuesday 2026-11-24 00:00 Europe/Istanbul = 2026-11-23T21:00:00.000Z.
      const atMidnight = await buildServiceAt(pool, '2026-11-23T21:00:00.000Z').list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      expect(atMidnight.items.some((item) => item.id === created.jobCardId)).toBe(true);

      // LATE_SUBMISSION scanner boundary: effective midnight is on time, +1ms is late.
      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
      );
      expect((await scanner.runOnce(new Date('2026-11-23T20:59:59.999Z'))).inserted).toBe(0);
      expect((await scanner.runOnce(new Date('2026-11-23T21:00:00.000Z'))).inserted).toBe(0);
      const late = await scanner.runOnce(new Date('2026-11-23T21:00:00.001Z'));
      expect(late.inserted).toBe(1);
      expect(late.byDelayType.LATE_SUBMISSION).toBe(1);
    });
  });

  it('A7: live work list and submission snapshot include Sat 23:59 and exclude Sun 10:00 & Mon 00:00', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const staff = actor(organizationId, staffId, 'STAFF');

      const saturdayId = await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Cumartesi 23:59 işi',
        // Saturday 2026-11-21 23:59:00 Europe/Istanbul
        staffCompletedAt: '2026-11-21T20:59:00.000Z',
      });
      // Sunday 2026-11-22 10:00:00 Europe/Istanbul -> excluded
      await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Pazar 10:00 işi',
        staffCompletedAt: '2026-11-22T07:00:00.000Z',
      });
      // Next Monday 2026-11-23 00:00:00 Europe/Istanbul -> excluded
      await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Gelecek Pazartesi 00:00 işi',
        staffCompletedAt: '2026-11-22T21:00:00.000Z',
      });

      const service = buildServiceAt(pool, '2026-11-21T20:59:30.000Z');
      const created = await service.createWeeklyReport(
        staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: '2026-11-16' }),
      );
      await service.start(staff, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });

      const detail = await service.getWeeklyReport(staff, created.jobCardId);
      expect(detail.liveSourceWork.map((item) => item.jobCardId)).toEqual([saturdayId]);

      await service.updateWeeklyReportDraft(staff, created.jobCardId, {
        expectedVersion: 1,
        draft: VALID_BODY,
        answers: [],
      });
      await service.submitForApproval(staff, created.jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
        note: 'Haftalık rapor gönderildi.',
      });
      const submissions = await service.listWeeklyReportSubmissions(staff, created.jobCardId);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.sourceWork.map((item) => item.jobCardId)).toEqual([saturdayId]);
    });
  });

  it('A8: legacy 7-day report preserves period/due/title and Sat/Sun source work across draft, submit, PDF, approve and remove', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const adminId = await insertUser(pool, organizationId, 'ADMIN');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const admin = actor(organizationId, adminId, 'ADMIN');
      const manager = actor(organizationId, managerId, 'MANAGER');
      const staff = actor(organizationId, staffId, 'STAFF');

      const legacyTitle = 'Haftalık Rapor (2026-11-09 – 2026-11-15)';
      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, due_date,
            accepted_at, accepted_by, started_at)
         VALUES ($1, 'WEEKLY_REPORT', 'IN_PROGRESS', $2, $3, $4, '2026-11-16',
                 '2026-11-09T09:00:00.000Z', $3, '2026-11-09T09:05:00.000Z')
         RETURNING id`,
        [organizationId, legacyTitle, staffId, managerId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            due_date, organization_timezone, source, created_by, created_at)
         VALUES ($1, $2, 1, NULL, NULL, '2026-11-16', 'Europe/Istanbul', 'BASELINE', $3, '2026-11-09T09:00:00.000Z')`,
        [organizationId, jobCardId, managerId],
      );
      await pool.query(
        `INSERT INTO job_card_assignment_history
           (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
         VALUES ($1, $2, NULL, $3, $4, 'CREATE', '2026-11-09T09:00:00.000Z')`,
        [organizationId, jobCardId, staffId, managerId],
      );
      const legacyQuestions = [{ key: 'preset_1', prompt: 'Öne çıkan işler?' }];
      const reportId = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_reports
           (organization_id, job_card_id, staff_user_id, period_start, period_end,
            draft_highlights, manager_questions, manager_answers)
         VALUES ($1, $2, $3, '2026-11-09', '2026-11-15', 'Önceki öne çıkan çalışma.', $4::jsonb, '[]'::jsonb)
         RETURNING id`,
        [organizationId, jobCardId, staffId, JSON.stringify(legacyQuestions)],
      )).rows[0]!.id;

      // Saturday 2026-11-14 10:00 Istanbul & Sunday 2026-11-15 15:00 Istanbul -> both included for 7-day report.
      const satJobId = await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Cumartesi tamamlanan iş',
        staffCompletedAt: '2026-11-14T07:00:00.000Z',
      });
      const sunJobId = await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Pazar tamamlanan iş',
        staffCompletedAt: '2026-11-15T12:00:00.000Z',
      });
      // Next Monday 2026-11-16 00:00 Istanbul -> excluded even for 7-day report.
      await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Pazartesi 00:00 işi',
        staffCompletedAt: '2026-11-15T21:00:00.000Z',
      });

      const service = buildServiceAt(pool, '2026-11-16T08:00:00.000Z');
      const initial = await service.getWeeklyReport(staff, jobCardId);
      expect(initial).toMatchObject({
        id: reportId,
        periodStart: '2026-11-09',
        periodEnd: '2026-11-15',
        dueDate: '2026-11-16',
      });
      expect(initial.liveSourceWork.map((item) => item.jobCardId)).toEqual([satJobId, sunJobId]);

      const updated = await service.updateWeeklyReportDraft(staff, jobCardId, {
        expectedVersion: 1,
        draft: { ...VALID_BODY, highlights: 'Güncellenmiş öne çıkan çalışma.' },
        answers: [{ questionKey: 'preset_1', answer: 'Klinik görüşmeleri.' }],
      });
      expect(updated.periodStart).toBe('2026-11-09');
      expect(updated.periodEnd).toBe('2026-11-15');
      expect(updated.dueDate).toBe('2026-11-16');
      expect(updated.draft.highlights).toBe('Güncellenmiş öne çıkan çalışma.');

      const submitted = await service.submitForApproval(staff, jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: 1,
        note: '7 günlük rapor gönderildi.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');

      const submissions = await service.listWeeklyReportSubmissions(manager, jobCardId);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({
        seqNo: 1,
        periodStart: '2026-11-09',
        periodEnd: '2026-11-15',
      });
      expect(submissions[0]!.body.highlights).toBe('Güncellenmiş öne çıkan çalışma.');
      expect(submissions[0]!.sourceWork.map((item) => item.jobCardId)).toEqual([satJobId, sunJobId]);

      const pdf = await service.weeklyReportSubmissionPdf(manager, jobCardId, 1);
      expect(pdf.fileName).toContain('2026-11-09');
      expect(pdf.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');

      const approved = await service.approve(manager, jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      });
      expect(approved.status).toBe('COMPLETED');

      const beforeRemove = await service.getWeeklyReport(admin, jobCardId);
      const removed = await service.removeWeeklyReport(admin, jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: beforeRemove.jobVersion,
        expectedReportVersion: beforeRemove.version,
        reason: 'Tarihsel kayıt arşiv testi.',
      });
      expect(removed.jobStatus).toBe('INVALIDATED');
      expect(removed.periodStart).toBe('2026-11-09');
      expect(removed.periodEnd).toBe('2026-11-15');
      expect(removed.dueDate).toBe('2026-11-16');

      const persisted = (await pool.query<{
        title: string; due_date: string; period_start: string; period_end: string;
      }>(
        `SELECT j.title, j.due_date::text AS due_date,
                r.period_start::text AS period_start, r.period_end::text AS period_end
           FROM job_cards j
           JOIN weekly_reports r ON r.organization_id = j.organization_id AND r.job_card_id = j.id
          WHERE j.id = $1`,
        [jobCardId],
      )).rows[0]!;
      expect(persisted).toEqual({
        title: legacyTitle,
        due_date: '2026-11-16',
        period_start: '2026-11-09',
        period_end: '2026-11-15',
      });
    });
  });

  it('A15: two parallel creates for the same staff and working week produce exactly one report', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildServiceAt(pool, '2026-11-20T07:00:00.000Z');
      const staff = actor(organizationId, staffId, 'STAFF');

      const outcomes = await Promise.allSettled([randomUUID(), randomUUID()].map((clientActionId) =>
        service.createWeeklyReport(
          staff,
          parseWeeklyReportCreateInput({ clientActionId, periodStart: '2026-11-16' }),
        ),
      ));
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (fulfilled[0]?.status === 'fulfilled') {
        expect(fulfilled[0].value).toMatchObject({
          periodStart: '2026-11-16',
          periodEnd: '2026-11-21',
          dueDate: '2026-11-23',
        });
      }
      if (rejected[0]?.status === 'rejected') {
        expect(rejected[0].reason).toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
      }
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM job_cards`)).rows[0]!.n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM weekly_reports`)).rows[0]!.n).toBe(1);
    });
  });

  it('A16: handles America/New_York DST week 2026-03-09 (Monday 00:00 EDT to Sunday 00:00 EDT)', async () => {
    const window = weekInstants('2026-03-09', '2026-03-14', 'America/New_York');
    expect(window.weekStart.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(window.weekEnd.toISOString()).toBe('2026-03-15T04:00:00.000Z');

    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'America/New_York');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const staff = actor(organizationId, staffId, 'STAFF');

      // Sunday 2026-03-08 23:59:59 EDT -> excluded
      await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Before Monday EDT',
        staffCompletedAt: '2026-03-09T03:59:59.000Z',
      });
      // Monday 2026-03-09 00:00:00 EDT -> included
      const monStartId = await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Monday 00:00 EDT',
        staffCompletedAt: '2026-03-09T04:00:00.000Z',
      });
      // Saturday 2026-03-14 23:59:59 EDT -> included
      const satEndId = await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Saturday 23:59:59 EDT',
        staffCompletedAt: '2026-03-15T03:59:59.000Z',
      });
      // Sunday 2026-03-15 00:00:00 EDT -> excluded
      await insertCompletedSourceJob(pool, {
        organizationId, staffId, managerId, title: 'Sunday 00:00 EDT',
        staffCompletedAt: '2026-03-15T04:00:00.000Z',
      });

      const service = buildServiceAt(pool, '2026-03-13T16:00:00.000Z');
      const created = await service.createWeeklyReport(
        staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: '2026-03-09' }),
      );
      expect(created).toMatchObject({
        periodStart: '2026-03-09',
        periodEnd: '2026-03-14',
        dueDate: '2026-03-16',
      });

      await service.start(staff, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });
      const detail = await service.getWeeklyReport(staff, created.jobCardId);
      expect(detail.liveSourceWork.map((item) => item.jobCardId)).toEqual([monStartId, satEndId]);

      await service.updateWeeklyReportDraft(staff, created.jobCardId, {
        expectedVersion: 1, draft: VALID_BODY, answers: [],
      });
      await service.submitForApproval(staff, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 2, note: 'DST week submitted.',
      });
      const submissions = await service.listWeeklyReportSubmissions(staff, created.jobCardId);
      expect(submissions[0]!.sourceWork.map((item) => item.jobCardId)).toEqual([monStartId, satEndId]);
    });
  });

  it('A17: enforces +5 or +6 period CHECKs (rejects +4 and +7) and rejects submission period mismatch via composite FK', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');

      const makeJob = async () => (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'WEEKLY_REPORT', 'NEW', 'A17 fixture', $2, $3) RETURNING id`,
        [organizationId, staffId, managerId],
      )).rows[0]!.id;

      // Both +5 (Monday–Saturday working week) and +6 (legacy 7-day) are valid on weekly_reports.
      const job6 = await makeJob();
      const report6Id = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, '2026-11-16', '2026-11-21') RETURNING id`,
        [organizationId, job6, staffId],
      )).rows[0]!.id;

      const job7 = await makeJob();
      const report7Id = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, '2026-11-09', '2026-11-15') RETURNING id`,
        [organizationId, job7, staffId],
      )).rows[0]!.id;

      // +4, +7 and non-Monday start are rejected by weekly_reports CHECKs.
      for (const [start, end] of [
        ['2026-11-02', '2026-11-06'], // +4
        ['2026-10-26', '2026-11-02'], // +7
        ['2026-11-17', '2026-11-22'], // Tuesday
      ]) {
        const badJob = await makeJob();
        await expect(pool.query(
          `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
           VALUES ($1, $2, $3, $4, $5)`,
          [organizationId, badJob, staffId, start, end],
        )).rejects.toMatchObject({ code: '23514' });
      }

      const activity6Id = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
        [organizationId, job6, staffId],
      )).rows[0]!.id;
      const activity7Id = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
        [organizationId, job7, staffId],
      )).rows[0]!.id;

      // Submission CHECK rejects +4 and +7 even with matching report id.
      for (const [start, end] of [
        ['2026-11-16', '2026-11-20'], // +4
        ['2026-11-16', '2026-11-23'], // +7
      ]) {
        await expect(pool.query(
          `INSERT INTO weekly_report_submissions
             (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
              period_start, period_end, frozen_body, frozen_questions, frozen_answers,
              frozen_source_work, job_version, source_activity_id)
           VALUES ($1, $2, $3, 1, $4, NOW(), $5, $6, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $7)`,
          [organizationId, report6Id, job6, staffId, start, end, activity6Id],
        )).rejects.toMatchObject({ code: '23514' });
      }

      // Composite FK rejects a valid 7-day submission under a 6-day working-week report (23503).
      await expect(pool.query(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
            period_start, period_end, frozen_body, frozen_questions, frozen_answers,
            frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, 1, $4, NOW(), '2026-11-16', '2026-11-22',
                 '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $5)`,
        [organizationId, report6Id, job6, staffId, activity6Id],
      )).rejects.toMatchObject({ code: '23503' });

      // Composite FK rejects a valid 6-day submission under a 7-day report (23503).
      await expect(pool.query(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
            period_start, period_end, frozen_body, frozen_questions, frozen_answers,
            frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, 1, $4, NOW(), '2026-11-09', '2026-11-14',
                 '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $5)`,
        [organizationId, report7Id, job7, staffId, activity7Id],
      )).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('A18: Monday request for week 2026-11-16 is due Monday 2026-11-23; Tuesday late request is due 2026-11-24 and not born overdue', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const staffC = await insertUser(pool, organizationId, 'STAFF');
      const manager = actor(organizationId, managerId, 'MANAGER');

      // Part 1: Monday 2026-11-23 10:00 Europe/Istanbul (07:00Z) requesting previous week 2026-11-16 ("Geçen hafta").
      const monService = buildServiceAt(pool, '2026-11-23T07:00:00.000Z');
      const monRef = await monService.weeklyReportReference(manager);
      expect(monRef).toEqual({
        timezone: 'Europe/Istanbul',
        today: '2026-11-23',
        periodStart: '2026-11-23',
        periodEnd: '2026-11-28',
        dueDate: '2026-11-30',
      });

      const monSingle = await monService.createWeeklyReport(
        manager,
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          assignedTo: staffA,
        }),
      );
      expect(monSingle.periodEnd).toBe('2026-11-21');
      expect(monSingle.dueDate).toBe('2026-11-23');

      const monBulk = await monService.bulkRequestWeeklyReports(
        manager,
        parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          staffUserIds: [staffB],
        }),
      );
      expect(monBulk.periodEnd).toBe('2026-11-21');
      expect(monBulk.dueDate).toBe('2026-11-23');

      // Not overdue on Monday.
      const overdueOnMon = await monService.list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      expect(overdueOnMon.items.some((item) => item.id === monSingle.jobCardId)).toBe(false);
      expect(overdueOnMon.items.some((item) => item.id === monBulk.items[0]!.jobCardId)).toBe(false);

      // Accept and start on Monday -> no immediate LATE_SUBMISSION incident during Monday.
      await buildServiceAt(pool, '2026-11-23T07:05:00.000Z').acceptAssignment(
        actor(organizationId, staffA, 'STAFF'),
        monSingle.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 1 },
      );
      await buildServiceAt(pool, '2026-11-23T07:06:00.000Z').start(
        actor(organizationId, staffA, 'STAFF'),
        monSingle.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 2 },
      );
      await pool.query(
        `UPDATE job_cards SET started_at = '2026-11-23T07:06:00.000Z' WHERE id = $1`,
        [monSingle.jobCardId],
      );
      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
      );
      expect((await scanner.runOnce(new Date('2026-11-23T07:10:00.000Z'))).inserted).toBe(0);
      expect((await scanner.runOnce(new Date('2026-11-23T20:59:59.999Z'))).inserted).toBe(0);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_overdue_incidents WHERE job_card_id = $1`,
        [monSingle.jobCardId],
      )).rows[0]!.n).toBe(0);

      // Part 2: Tuesday 2026-11-24 10:00 Europe/Istanbul (07:00Z) requesting past week 2026-11-16 (late, D9).
      const tueService = buildServiceAt(pool, '2026-11-24T07:00:00.000Z');
      const tueRef = await tueService.weeklyReportReference(manager);
      expect(tueRef.today).toBe('2026-11-24');

      const tueSingle = await tueService.createWeeklyReport(
        manager,
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          assignedTo: staffC,
        }),
      );
      expect(tueSingle.periodEnd).toBe('2026-11-21');
      expect(tueSingle.dueDate).toBe('2026-11-24');

      const overdueOnTue = await tueService.list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      expect(overdueOnTue.items.some((item) => item.id === tueSingle.jobCardId)).toBe(false);

      await buildServiceAt(pool, '2026-11-24T07:05:00.000Z').acceptAssignment(
        actor(organizationId, staffC, 'STAFF'),
        tueSingle.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 1 },
      );
      await buildServiceAt(pool, '2026-11-24T07:06:00.000Z').start(
        actor(organizationId, staffC, 'STAFF'),
        tueSingle.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 2 },
      );
      await pool.query(
        `UPDATE job_cards SET started_at = '2026-11-24T07:06:00.000Z' WHERE id = $1`,
        [tueSingle.jobCardId],
      );
      // The Monday report (due 2026-11-23, still IN_PROGRESS) is legitimately
      // late by Tuesday, so the global scan may insert its incident; only the
      // Tuesday request itself must not be born late.
      await scanner.runOnce(new Date('2026-11-24T07:10:00.000Z'));
      expect((await pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_overdue_incidents WHERE job_card_id = $1`,
        [monSingle.jobCardId],
      )).rows[0]!.n).toBe(1);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_overdue_incidents WHERE job_card_id = $1`,
        [tueSingle.jobCardId],
      )).rows[0]!.n).toBe(0);
    });
  });

  it('A18b: Wednesday 2026-11-18 request for future week 2026-11-23 is due Monday 2026-11-30', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const service = buildServiceAt(pool, '2026-11-18T09:00:00.000Z');
      const manager = actor(organizationId, managerId, 'MANAGER');

      const single = await service.createWeeklyReport(
        manager,
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-23',
          assignedTo: staffA,
        }),
      );
      expect(single).toMatchObject({
        periodStart: '2026-11-23',
        periodEnd: '2026-11-28',
        dueDate: '2026-11-30',
      });

      const bulk = await service.bulkRequestWeeklyReports(
        manager,
        parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-23',
          staffUserIds: [staffB],
        }),
      );
      expect(bulk).toMatchObject({
        periodStart: '2026-11-23',
        periodEnd: '2026-11-28',
        dueDate: '2026-11-30',
      });
    });
  });

  it('A18 (near-midnight UTC vs org-local): 2026-11-23T21:30:00Z (= 2026-11-24 00:30 Istanbul) derives due 2026-11-24 for both create and bulk', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffA = await insertUser(pool, organizationId, 'STAFF');
      const staffB = await insertUser(pool, organizationId, 'STAFF');
      const staffC = await insertUser(pool, organizationId, 'STAFF');
      const manager = actor(organizationId, managerId, 'MANAGER');

      // 2026-11-23T21:30:00.000Z is still Monday 2026-11-23 in UTC,
      // but already Tuesday 2026-11-24 00:30 in Europe/Istanbul.
      const midnightService = buildServiceAt(pool, '2026-11-23T21:30:00.000Z');
      const ref = await midnightService.weeklyReportReference(manager);
      expect(ref.today).toBe('2026-11-24');

      const single = await midnightService.createWeeklyReport(
        manager,
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          assignedTo: staffA,
        }),
      );
      expect(single.periodEnd).toBe('2026-11-21');
      expect(single.dueDate).toBe('2026-11-24');

      const bulk = await midnightService.bulkRequestWeeklyReports(
        manager,
        parseWeeklyReportBulkRequestInput({
          clientActionId: randomUUID(),
          periodStart: '2026-11-16',
          staffUserIds: [staffB, staffC],
        }),
      );
      expect(bulk.periodEnd).toBe('2026-11-21');
      expect(bulk.dueDate).toBe('2026-11-24');

      const stored = (await pool.query<{ due_date: string }>(
        `SELECT due_date::text AS due_date FROM job_cards
          WHERE organization_id = $1 AND type = 'WEEKLY_REPORT'`,
        [organizationId],
      )).rows;
      expect(stored).toHaveLength(3);
      expect(stored.every((row) => row.due_date === '2026-11-24')).toBe(true);

      // Neither single nor bulk is born overdue on 2026-11-24 00:30 Istanbul.
      const overdue = await midnightService.list(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: null,
        status: 'active', limit: 20, offset: 0, overdue: true,
      });
      expect(overdue.items).toEqual([]);
    });
  });

  it('A19: working-week (+5) submission preserves supportNeeded in frozen body and PDF V1 fallback label', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const staff = actor(organizationId, staffId, 'STAFF');
      const service = buildServiceAt(pool, '2026-11-20T07:00:00.000Z');

      const created = await service.createWeeklyReport(
        staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: '2026-11-16' }),
      );
      expect(created.periodEnd).toBe('2026-11-21');

      await service.start(staff, created.jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: 1,
      });

      const supportText = 'Stok ve teslimat onayı için yönetici desteği gerekiyor.';
      await service.updateWeeklyReportDraft(staff, created.jobCardId, {
        expectedVersion: 1,
        draft: {
          ...VALID_BODY,
          supportNeeded: supportText,
        },
        answers: [],
      });

      await service.submitForApproval(staff, created.jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
        note: 'A19 gönderimi.',
      });

      const submissions = await service.listWeeklyReportSubmissions(staff, created.jobCardId);
      expect(submissions).toHaveLength(1);
      const sub = submissions[0]!;
      expect(sub.periodStart).toBe('2026-11-16');
      expect(sub.periodEnd).toBe('2026-11-21');
      expect(sub.body.supportNeeded).toBe(supportText);

      const model = buildWeeklyReportPdfDocumentModel({
        submission: sub,
        staffName: 'A19 Personel',
      });
      expect(model.sections).toEqual([
        { label: 'Bu hafta', value: VALID_BODY.summary },
        { label: 'Sorunlar ve destek ihtiyacı', value: null },
        { label: 'Gelecek hafta planı', value: VALID_BODY.nextWeekPlan },
        { label: 'Yöneticiden destek beklenen konular', value: supportText },
      ]);

      const pdf = await service.weeklyReportSubmissionPdf(staff, created.jobCardId, 1);
      expect(pdf.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    });
  });

  it('068 migration upgrade: preserves pre-068 +6 report/submission and enforces composite FK afterwards', async () => {
    const prevDir = await mkdtemp(path.join(tmpdir(), 'wr-week-head067-'));
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `wr_week_mig_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      const files = (await readdir(MIGRATIONS_DIRECTORY))
        .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 67);
      for (const filename of files) {
        await copyFile(path.join(MIGRATIONS_DIRECTORY, filename), path.join(prevDir, filename));
      }

      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: prevDir, store });

      const organizationId = await insertOrg(pool, 'Europe/Istanbul');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');

      // At 067: +5 is rejected by the old weekly_reports_period_end_check (+6 only).
      const preJob5 = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'WEEKLY_REPORT', 'NEW', 'Pre-068 +5 probe', $2, $3) RETURNING id`,
        [organizationId, staffId, managerId],
      )).rows[0]!.id;
      await expect(pool.query(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, '2026-11-16', '2026-11-21')`,
        [organizationId, preJob5, staffId],
      )).rejects.toMatchObject({ code: '23514' });

      // Seed an existing pre-068 legacy +6 report and matching +6 submission.
      const legacyJobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, due_date,
            accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by)
         VALUES ($1, 'WEEKLY_REPORT', 'WAITING_APPROVAL', 'Haftalık Rapor (2026-11-09 – 2026-11-15)', $2, $3, '2026-11-16',
                 '2026-11-09T09:00:00.000Z', $2, '2026-11-09T09:05:00.000Z', '2026-11-15T12:00:00.000Z', $2)
         RETURNING id`,
        [organizationId, staffId, managerId],
      )).rows[0]!.id;
      const legacyReportId = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, '2026-11-09', '2026-11-15') RETURNING id`,
        [organizationId, legacyJobId, staffId],
      )).rows[0]!.id;
      const legacyActivityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
        [organizationId, legacyJobId, staffId],
      )).rows[0]!.id;
      const legacySubId = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
            period_start, period_end, frozen_body, frozen_questions, frozen_answers,
            frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, 1, $4, NOW(), '2026-11-09', '2026-11-15',
                 '{"summary":"Eski"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $5)
         RETURNING id`,
        [organizationId, legacyReportId, legacyJobId, staffId, legacyActivityId],
      )).rows[0]!.id;

      // Apply 068 on top of the 067 schema with legacy +6 data present.
      const upgrade = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
      expect(upgrade).toEqual({ appliedVersions: ['068_weekly_report_workweek'] });

      // Legacy +6 rows remain untouched and valid.
      const legacyReport = (await pool.query<{ period_start: string; period_end: string }>(
        `SELECT period_start::text AS period_start, period_end::text AS period_end
           FROM weekly_reports WHERE id = $1`,
        [legacyReportId],
      )).rows[0]!;
      expect(legacyReport).toEqual({ period_start: '2026-11-09', period_end: '2026-11-15' });
      const legacySub = (await pool.query<{ period_start: string; period_end: string }>(
        `SELECT period_start::text AS period_start, period_end::text AS period_end
           FROM weekly_report_submissions WHERE id = $1`,
        [legacySubId],
      )).rows[0]!;
      expect(legacySub).toEqual({ period_start: '2026-11-09', period_end: '2026-11-15' });

      // After 068: +5 report is accepted, and a mismatched submission under either report is rejected by composite FK.
      const postReportId = (await pool.query<{ id: string }>(
        `INSERT INTO weekly_reports (organization_id, job_card_id, staff_user_id, period_start, period_end)
         VALUES ($1, $2, $3, '2026-11-16', '2026-11-21') RETURNING id`,
        [organizationId, preJob5, staffId],
      )).rows[0]!.id;
      const postActivityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_SUBMITTED_FOR_APPROVAL') RETURNING id`,
        [organizationId, preJob5, staffId],
      )).rows[0]!.id;

      // Mismatched +6 submission under +5 report -> rejected by composite FK (23503).
      await expect(pool.query(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
            period_start, period_end, frozen_body, frozen_questions, frozen_answers,
            frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, 1, $4, NOW(), '2026-11-16', '2026-11-22',
                 '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $5)`,
        [organizationId, postReportId, preJob5, staffId, postActivityId],
      )).rejects.toMatchObject({ code: '23503' });

      // Mismatched +5 submission under legacy +6 report -> rejected by composite FK (23503).
      await expect(pool.query(
        `INSERT INTO weekly_report_submissions
           (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by, submitted_at,
            period_start, period_end, frozen_body, frozen_questions, frozen_answers,
            frozen_source_work, job_version, source_activity_id)
         VALUES ($1, $2, $3, 2, $4, NOW(), '2026-11-09', '2026-11-14',
                 '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, $5)`,
        [organizationId, legacyReportId, legacyJobId, staffId, legacyActivityId],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
      await rm(prevDir, { recursive: true, force: true });
    }
  });
});
