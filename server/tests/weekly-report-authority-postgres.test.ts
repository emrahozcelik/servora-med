import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseJobCardCreateInput } from '../src/modules/job-cards/create-input.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const WEEK_A = '2026-08-03';
const WEEK_A_END = '2026-08-09';
const WEEK_A_DUE = '2026-08-10';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2a_${randomUUID().replaceAll('-', '')}`;
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
    [`WR2A ${randomUUID()}`],
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
    [organizationId, `WR2A ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
  )).rows[0]!.id;
}

function buildServiceAt(pool: Pool, iso: string) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(iso),
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

function buildService(pool: Pool) {
  return buildServiceAt(pool, '2026-08-03T09:00:00.000Z');
}

function staffActor(organizationId: string, id: string): JobCardActor {
  return { id, organizationId, role: 'STAFF' };
}

function managerActor(organizationId: string, id: string): JobCardActor {
  return { id, organizationId, role: 'MANAGER' };
}

const QUESTIONS = [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }];

const DRAFT = {
  summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
  highlights: null, fieldObservations: null, supportNeeded: null,
};

describe.skipIf(!databaseUrl)('weekly report authority (PostgreSQL)', () => {
  it('rejects a caller-supplied dueDate at parsing with zero mutation', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      // The deadline is server-canonical (periodEnd + 1): the public request
      // shape has no dueDate field, so the exact parser rejects it before any
      // service logic or idempotency state is touched — for every role.
      expect(() => parseWeeklyReportCreateInput({
        clientActionId: randomUUID(), periodStart: WEEK_A, dueDate: '2026-09-01',
      })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
      const jobs = await pool.query(`SELECT COUNT(*)::int AS n FROM job_cards`);
      expect(jobs.rows[0].n).toBe(0);
    });
  });

  it('derives the canonical organization-local reporting week for the create screen', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      // 22:30Z is already the next local day (Monday) in Europe/Istanbul, so a
      // device/UTC-derived default would answer 2026-07-27 instead.
      const service = buildServiceAt(pool, '2026-08-02T22:30:00.000Z');
      const expected = {
        timezone: 'Europe/Istanbul',
        periodStart: WEEK_A,
        periodEnd: WEEK_A_END,
        dueDate: WEEK_A_DUE,
      };
      expect(await service.weeklyReportReference(staffActor(organizationId, staffId)))
        .toEqual(expected);
      expect(await service.weeklyReportReference(managerActor(organizationId, managerId)))
        .toEqual(expected);
    });
  });

  it('blocks STAFF generic edits to weekly report title, description, due date and assignee', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const otherStaffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        staffActor(organizationId, staffId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, instructions: 'Yönetici talimatı.',
        }),
      );
      const detail = await service.detail(staffActor(organizationId, staffId), created.jobCardId);
      const actor = staffActor(organizationId, staffId);
      for (const fields of [
        { title: 'Ele geçirilmiş başlık' },
        { description: 'Personelin yazdığı talimat' },
        { dueDate: '2026-12-31' },
        { assignedTo: otherStaffId },
      ]) {
        await expect(service.patch(actor, created.jobCardId, {
          expectedVersion: detail.version, ...fields,
        })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      const row = (await pool.query(
        `SELECT title, description, due_date::text AS due_date, assigned_to
           FROM job_cards WHERE id = $1`,
        [created.jobCardId],
      )).rows[0];
      expect(row.title).toBe(`Haftalık Rapor (${WEEK_A} – ${WEEK_A_END})`);
      expect(row.description).toBe('Yönetici talimatı.');
      expect(row.due_date).toBe(WEEK_A_DUE);
      expect(row.assigned_to).toBe(staffId);
      // A no-op patch that does not change the guarded values stays allowed:
      // the restriction is change-scoped, not a blanket field ban.
      await expect(service.patch(actor, created.jobCardId, {
        expectedVersion: detail.version, title: detail.title,
      })).resolves.toBeDefined();
    });
  });

  it('derives the canonical deadline on manager create and keeps patch reschedule authority', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      // CREATION deadline is server-canonical (periodEnd + 1): no caller
      // override exists at request time any more.
      const created = await service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
          questions: QUESTIONS,
        }),
      );
      expect(created.dueDate).toBe(WEEK_A_DUE);
      // Rescheduling an EXISTING JobCard via the generic patch remains a
      // manager authority: only the request authority changed, not JobCard
      // due-date semantics.
      const detail = await service.detail(managerActor(organizationId, managerId), created.jobCardId);
      await service.patch(managerActor(organizationId, managerId), created.jobCardId, {
        expectedVersion: detail.version, dueDate: '2026-08-14',
      });
      const row = (await pool.query(
        `SELECT due_date::text AS due_date FROM job_cards WHERE id = $1`,
        [created.jobCardId],
      )).rows[0];
      expect(row.due_date).toBe('2026-08-14');
    });
  });

  it('leaves generic General Task editing unchanged', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const task = await service.create(
        managerActor(organizationId, managerId),
        parseJobCardCreateInput({
          clientActionId: randomUUID(), type: 'GENERAL_TASK',
          title: 'Doktoru ara', assignedTo: staffId,
        }),
      );
      await service.patch(managerActor(organizationId, managerId), task.id, {
        expectedVersion: task.version, title: 'Doktoru tekrar ara',
      });
      const managerEdited = (await pool.query(
        `SELECT title FROM job_cards WHERE id = $1`, [task.id],
      )).rows[0];
      expect(managerEdited.title).toBe('Doktoru tekrar ara');
      // The assigned STAFF keeps their pre-existing generic edit authority.
      const staffDetail = await service.detail(staffActor(organizationId, staffId), task.id);
      await service.patch(staffActor(organizationId, staffId), task.id, {
        expectedVersion: staffDetail.version, title: 'Kendi görevim',
      });
      const staffEdited = (await pool.query(
        `SELECT title FROM job_cards WHERE id = $1`, [task.id],
      )).rows[0];
      expect(staffEdited.title).toBe('Kendi görevim');
    });
  });

  it('keeps manager request instructions readable after staff draft edits', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await service.createWeeklyReport(
        managerActor(organizationId, managerId),
        parseWeeklyReportCreateInput({
          clientActionId: randomUUID(), periodStart: WEEK_A, assignedTo: staffId,
          questions: QUESTIONS, instructions: 'Haftalık hedefleri yazın.',
        }),
      );
      const staff = staffActor(organizationId, staffId);
      const before = await service.getWeeklyReport(staff, created.jobCardId);
      expect(before.instructions).toBe('Haftalık hedefleri yazın.');
      await service.acceptAssignment(staff, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: before.jobVersion,
      });
      await service.updateWeeklyReportDraft(staff, created.jobCardId, {
        expectedVersion: before.version, draft: DRAFT, answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
      });
      const after = await service.getWeeklyReport(staff, created.jobCardId);
      expect(after.instructions).toBe('Haftalık hedefleri yazın.');
      expect(after.draft.summary).toBe('Özet.');
      const managerView = await service.getWeeklyReport(managerActor(organizationId, managerId), created.jobCardId);
      expect(managerView.instructions).toBe('Haftalık hedefleri yazın.');
    });
  });

  it('freezes the canonical staff due date so lateness cannot be rescheduled away', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const staff = staffActor(organizationId, staffId);
      const created = await service.createWeeklyReport(
        staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart: WEEK_A }),
      );
      expect(created.dueDate).toBe(WEEK_A_DUE);
      const detail = await service.detail(staff, created.jobCardId);
      expect(detail.dueDate).toBe(WEEK_A_DUE);
      await expect(service.patch(staff, created.jobCardId, {
        expectedVersion: detail.version, dueDate: '2026-12-31',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const row = (await pool.query(
        `SELECT due_date::text AS due_date FROM job_cards WHERE id = $1`,
        [created.jobCardId],
      )).rows[0];
      expect(row.due_date).toBe(WEEK_A_DUE);
    });
  });
});
