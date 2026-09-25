import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  parseWeeklyReportRecurrenceBulkCreateInput,
  parseWeeklyReportRecurrencePauseInput,
  parseWeeklyReportRecurrenceResumeInput,
  parseWeeklyReportRecurrenceTemplateUpdateInput,
} from '../src/modules/weekly-reports/recurrence-input.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

/** Monday of the current week used by the controllable clock below. */
const NOW = '2026-10-05T09:00:00.000Z'; // Monday 12:00 Europe/Istanbul
const WEEK_CURRENT = '2026-10-05';
const WEEK_NEXT = '2026-10-12';
const WEEK_PAST = '2026-09-28';

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5c_${randomUUID().replaceAll('-', '')}`;
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
    [`WR5C ${randomUUID()}`, timezone],
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
    [organizationId, `WR5C ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
  )).rows[0]!.id;
}

function buildHarness(pool: Pool, published: unknown[] = [], nowIso = NOW) {
  const jobCardService = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(nowIso),
    { publish: (event) => { published.push(event); } },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const repository = new PostgresWeeklyReportRecurrenceRepository(pool);
  const service = new WeeklyReportRecurrenceService(
    repository,
    pool,
    jobCardService,
    () => new Date(nowIso),
  );
  return { service, repository, jobCardService };
}

const actor = (
  organizationId: string,
  id: string,
  role: JobCardActor['role'],
): JobCardActor => ({ id, organizationId, role });

const QUESTIONS = [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }];

function bulkBody(overrides: Record<string, unknown> = {}) {
  return {
    clientActionId: randomUUID(),
    staffUserIds: [],
    startPeriodStart: WEEK_CURRENT,
    ...overrides,
  };
}

/** Row census used to prove all-or-nothing behaviour. */
async function census(pool: Pool) {
  const rules = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`,
  );
  const jobs = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM job_cards WHERE type = 'WEEKLY_REPORT'`,
  );
  const reports = await pool.query<{ n: number }>(`SELECT COUNT(*)::int FROM weekly_reports`);
  const receipts = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM processed_actions`,
  );
  return {
    rules: rules.rows[0]!.n,
    jobs: jobs.rows[0]!.n,
    reports: reports.rows[0]!.n,
    receipts: receipts.rows[0]!.n,
  };
}

async function ruleRow(pool: Pool, id: string) {
  return (await pool.query<{
    enabled: boolean; disabled_reason: string | null; next_period_start: string;
    manager_questions: unknown; instructions: string | null; version: number;
    requested_by_user_id: string; staff_user_id: string; last_outcome: string | null;
    last_processed_period_start: string | null;
  }>(
    `SELECT enabled, disabled_reason, next_period_start::text AS next_period_start,
            manager_questions, instructions, version, requested_by_user_id, staff_user_id,
            last_outcome, last_processed_period_start::text AS last_processed_period_start
       FROM weekly_report_recurrences WHERE id = $1`,
    [id],
  )).rows[0]!;
}

describe.skipIf(!databaseUrl)('weekly report recurrence configuration (PostgreSQL)', () => {
  describe('authorization', () => {
    it('rejects STAFF on bulk create and writes nothing', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const error = await service.bulkCreate(
          actor(organizationId, staffId, 'STAFF'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        ).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(await census(pool)).toMatchObject({ rules: 0, receipts: 0 });
      });
    });

    it('rejects STAFF on list, template, pause and resume', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const staff = actor(organizationId, staffId, 'STAFF');
        const id = randomUUID();
        for (const run of [
          () => service.list(staff),
          () => service.updateTemplate(staff, id, parseWeeklyReportRecurrenceTemplateUpdateInput({
            clientActionId: randomUUID(), expectedVersion: 1, questions: [], instructions: null,
          })),
          () => service.pause(staff, id, parseWeeklyReportRecurrencePauseInput({
            clientActionId: randomUUID(), expectedVersion: 1,
          })),
          () => service.resume(staff, id, parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 1, periodStart: null,
          })),
        ]) {
          await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        }
      });
    });

    it('lets MANAGER and ADMIN create rules for active STAFF', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const adminId = await insertUser(pool, organizationId, 'ADMIN');
        const staffA = await insertUser(pool, organizationId, 'STAFF');
        const staffB = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const byManager = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffA] })),
        );
        expect(byManager.items).toEqual([expect.objectContaining({ outcome: 'created', enabled: true })]);
        const byAdmin = await service.bulkCreate(
          actor(organizationId, adminId, 'ADMIN'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffB] })),
        );
        expect(byAdmin.items).toEqual([expect.objectContaining({ outcome: 'created' })]);
        const { items } = await service.list(actor(organizationId, managerId, 'MANAGER'));
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({
          enabled: true, disabledReason: null, nextPeriodStart: WEEK_CURRENT,
          questions: [], instructions: null, version: 1, lastProcessedPeriodStart: null,
        });
      });
    });

    it('rejects an inactive target and writes nothing', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const inactive = await insertUser(pool, organizationId, 'STAFF', false);
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [inactive] })),
        )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(await census(pool)).toMatchObject({ rules: 0 });
      });
    });

    it('rejects a non-STAFF target', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const otherManager = await insertUser(pool, organizationId, 'MANAGER');
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [otherManager] })),
        )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(await census(pool)).toMatchObject({ rules: 0 });
      });
    });

    it('conceals a cross-tenant target as not found', async () => {
      await withSchema(async (pool) => {
        const organizationA = await insertOrg(pool);
        const organizationB = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationA, 'MANAGER');
        const foreignStaff = await insertUser(pool, organizationB, 'STAFF');
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationA, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [foreignStaff] })),
        )).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
        expect(await census(pool)).toMatchObject({ rules: 0 });
      });
    });

    it('accepts exactly 50 targets and rejects 51', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const targets = await Promise.all(Array.from({ length: 51 }, () =>
          insertUser(pool, organizationId, 'STAFF')));
        const { service } = buildHarness(pool);
        const fifty = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: targets.slice(0, 50) }),
          ),
        );
        expect(fifty.items).toHaveLength(50);
        expect(fifty.items.every((item) => item.outcome === 'created')).toBe(true);
        expect((await census(pool)).rules).toBe(50);
        expect(() => parseWeeklyReportRecurrenceBulkCreateInput(
          bulkBody({ staffUserIds: targets.slice(0, 51) }),
        )).toThrowError(/en fazla 50/i);
        expect((await census(pool)).rules).toBe(50);
      });
    });

    it('rejects duplicate target ids as malformed', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        expect(() => parseWeeklyReportRecurrenceBulkCreateInput(
          bulkBody({ staffUserIds: [staffId, staffId] }),
        )).toThrowError(/birden fazla/i);
        expect(await census(pool)).toMatchObject({ rules: 0 });
        void managerId;
      });
    });

    it('validates every target before mutating any', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const good = await insertUser(pool, organizationId, 'STAFF');
        const inactive = await insertUser(pool, organizationId, 'STAFF', false);
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [good, inactive] }),
          ),
        )).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await census(pool)).toMatchObject({ rules: 0 });
      });
    });

    it('rejects a start week earlier than the current organization week', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffId], startPeriodStart: WEEK_PAST }),
          ),
        )).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        expect(await census(pool)).toMatchObject({ rules: 0 });
      });
    });

    it('accepts a future start week', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const result = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffId], startPeriodStart: WEEK_NEXT }),
          ),
        );
        expect(result.items[0]).toMatchObject({ nextPeriodStart: WEEK_NEXT, outcome: 'created' });
      });
    });
  });

  describe('bulk idempotency', () => {
    it('replays an exact action id and intent without creating a second rule', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const body = parseWeeklyReportRecurrenceBulkCreateInput(
          bulkBody({ staffUserIds: [staffId], questions: QUESTIONS }),
        );
        const first = await service.bulkCreate(actor(organizationId, managerId, 'MANAGER'), body);
        const replay = await service.bulkCreate(actor(organizationId, managerId, 'MANAGER'), body);
        expect(replay).toEqual(first);
        expect(await census(pool)).toMatchObject({ rules: 1, receipts: 1 });
      });
    });

    it('rejects a reused action id with changed intent', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const otherStaff = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const clientActionId = randomUUID();
        await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ clientActionId, staffUserIds: [staffId] }),
          ),
        );
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ clientActionId, staffUserIds: [otherStaff] }),
          ),
        )).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
        expect(await census(pool)).toMatchObject({ rules: 1 });
      });
    });

    it('converges an already-configured staff member to existing without overwriting', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const first = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffId], questions: QUESTIONS, instructions: 'İlk şablon' }),
          ),
        );
        const existingId = first.items[0]!.recurrenceId;
        const second = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({
              staffUserIds: [staffId],
              startPeriodStart: WEEK_NEXT,
              questions: [{ key: 'q9', prompt: 'Farklı soru' }],
              instructions: 'Yeni şablon',
            }),
          ),
        );
        expect(second.items[0]).toMatchObject({
          recurrenceId: existingId, outcome: 'existing', nextPeriodStart: WEEK_CURRENT, version: 1,
        });
        const row = await ruleRow(pool, existingId);
        expect(row.manager_questions).toEqual(QUESTIONS);
        expect(row.instructions).toBe('İlk şablon');
        expect(row.next_period_start).toBe(WEEK_CURRENT);
        expect(await census(pool)).toMatchObject({ rules: 1 });
      });
    });

    it('reports a mixed batch with created and existing items', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffA = await insertUser(pool, organizationId, 'STAFF');
        const staffB = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffA] })),
        );
        const mixed = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffA, staffB] })),
        );
        expect(mixed.items.map((item) => item.outcome)).toEqual(['existing', 'created']);
        expect(await census(pool)).toMatchObject({ rules: 2 });
      });
    });

    it('rolls the whole batch back when a later target is invalid', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffA = await insertUser(pool, organizationId, 'STAFF');
        const staffB = await insertUser(pool, organizationId, 'STAFF');
        const foreignOrg = await insertOrg(pool);
        const foreignStaff = await insertUser(pool, foreignOrg, 'STAFF');
        const { service } = buildHarness(pool);
        await expect(service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffA, staffB, foreignStaff] }),
          ),
        )).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND' });
        expect(await census(pool)).toMatchObject({ rules: 0, receipts: 0 });
      });
    });
  });

  describe('template update', () => {
    it('replaces questions and instructions under optimistic versioning', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        const updated = await service.updateTemplate(
          actor(organizationId, managerId, 'MANAGER'),
          id,
          parseWeeklyReportRecurrenceTemplateUpdateInput({
            clientActionId: randomUUID(),
            expectedVersion: 1,
            questions: QUESTIONS,
            instructions: 'Haftalık özet',
          }),
        );
        expect(updated).toMatchObject({ version: 2, questions: QUESTIONS, instructions: 'Haftalık özet' });
        const row = await ruleRow(pool, id);
        expect(row.version).toBe(2);
        expect(row.manager_questions).toEqual(QUESTIONS);
        expect(row.next_period_start).toBe(WEEK_CURRENT);
      });
    });

    it('rejects a stale expectedVersion', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        await expect(service.updateTemplate(
          actor(organizationId, managerId, 'MANAGER'),
          id,
          parseWeeklyReportRecurrenceTemplateUpdateInput({
            clientActionId: randomUUID(), expectedVersion: 99, questions: QUESTIONS, instructions: null,
          }),
        )).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      });
    });

    it('replays a completed template update before version validation', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        const body = parseWeeklyReportRecurrenceTemplateUpdateInput({
          clientActionId: randomUUID(), expectedVersion: 1, questions: QUESTIONS, instructions: 'X',
        });
        const first = await service.updateTemplate(actor(organizationId, managerId, 'MANAGER'), id, body);
        // The version has advanced to 2, yet an exact replay must still return
        // the original response instead of a VERSION_CONFLICT.
        const replay = await service.updateTemplate(actor(organizationId, managerId, 'MANAGER'), id, body);
        expect(replay).toEqual(first);
        expect((await ruleRow(pool, id)).version).toBe(2);
      });
    });

    it('conceals a cross-tenant rule id as not found', async () => {
      await withSchema(async (pool) => {
        const organizationA = await insertOrg(pool);
        const organizationB = await insertOrg(pool);
        const managerA = await insertUser(pool, organizationA, 'MANAGER');
        const managerB = await insertUser(pool, organizationB, 'MANAGER');
        const staffB = await insertUser(pool, organizationB, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationB, managerB, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffB] })),
        );
        await expect(service.updateTemplate(
          actor(organizationA, managerA, 'MANAGER'),
          created.items[0]!.recurrenceId,
          parseWeeklyReportRecurrenceTemplateUpdateInput({
            clientActionId: randomUUID(), expectedVersion: 1, questions: [], instructions: null,
          }),
        )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_RECURRENCE_NOT_FOUND', statusCode: 404 });
      });
    });
  });

  describe('pause and resume', () => {
    it('pauses a rule, replays exactly, and hides lease internals', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        const body = parseWeeklyReportRecurrencePauseInput({
          clientActionId: randomUUID(), expectedVersion: 1,
        });
        const paused = await service.pause(actor(organizationId, managerId, 'MANAGER'), id, body);
        expect(paused).toMatchObject({ enabled: false, disabledReason: 'MANUAL', version: 2 });
        const replay = await service.pause(actor(organizationId, managerId, 'MANAGER'), id, body);
        expect(replay).toEqual(paused);
        const { items } = await service.list(actor(organizationId, managerId, 'MANAGER'));
        expect(items[0]).toMatchObject({ enabled: false, disabledReason: 'MANUAL', version: 2 });
        expect(Object.keys(items[0]!)).not.toContain('leaseToken');
        expect(Object.keys(items[0]!)).not.toContain('failureCount');
      });
    });

    it('resumes to the current organization week by default', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffId], startPeriodStart: WEEK_CURRENT }),
          ),
        );
        const id = created.items[0]!.recurrenceId;
        await service.pause(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrencePauseInput({ clientActionId: randomUUID(), expectedVersion: 1 }));
        const resumed = await service.resume(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 2, periodStart: null,
          }));
        expect(resumed).toMatchObject({ enabled: true, nextPeriodStart: WEEK_CURRENT, version: 3 });
        const row = await ruleRow(pool, id);
        expect(row.enabled).toBe(true);
        expect(row.disabled_reason).toBeNull();
      });
    });

    it('never backfills paused weeks: resume keeps the later stored week', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        // Rule paused while its stored week is in the future.
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(
            bulkBody({ staffUserIds: [staffId], startPeriodStart: '2026-10-26' }),
          ),
        );
        const id = created.items[0]!.recurrenceId;
        await service.pause(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrencePauseInput({ clientActionId: randomUUID(), expectedVersion: 1 }));
        const resumed = await service.resume(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 2, periodStart: null,
          }));
        // Stored 2026-10-26 > current 2026-10-05, so it is preserved.
        expect(resumed.nextPeriodStart).toBe('2026-10-26');
      });
    });

    it('accepts an explicit future resume week and rejects a past one', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        await service.pause(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrencePauseInput({ clientActionId: randomUUID(), expectedVersion: 1 }));
        await expect(service.resume(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 2, periodStart: WEEK_PAST,
          }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        const resumed = await service.resume(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 2, periodStart: '2026-11-02',
          }));
        expect(resumed.nextPeriodStart).toBe('2026-11-02');
      });
    });

    it('refuses to resume when the target is no longer an active STAFF member', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerId = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerId, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        await service.pause(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrencePauseInput({ clientActionId: randomUUID(), expectedVersion: 1 }));
        await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [staffId]);
        await expect(service.resume(actor(organizationId, managerId, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 2, periodStart: null,
          }))).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_FOUND', statusCode: 404 });
        expect((await ruleRow(pool, id)).enabled).toBe(false);
      });
    });

    it('records the last authorizing manager on template, pause and resume', async () => {
      await withSchema(async (pool) => {
        const organizationId = await insertOrg(pool);
        const managerA = await insertUser(pool, organizationId, 'MANAGER');
        const managerB = await insertUser(pool, organizationId, 'MANAGER');
        const staffId = await insertUser(pool, organizationId, 'STAFF');
        const { service } = buildHarness(pool);
        const created = await service.bulkCreate(
          actor(organizationId, managerA, 'MANAGER'),
          parseWeeklyReportRecurrenceBulkCreateInput(bulkBody({ staffUserIds: [staffId] })),
        );
        const id = created.items[0]!.recurrenceId;
        await service.updateTemplate(actor(organizationId, managerB, 'MANAGER'), id,
          parseWeeklyReportRecurrenceTemplateUpdateInput({
            clientActionId: randomUUID(), expectedVersion: 1, questions: [], instructions: null,
          }));
        await service.pause(actor(organizationId, managerB, 'MANAGER'), id,
          parseWeeklyReportRecurrencePauseInput({ clientActionId: randomUUID(), expectedVersion: 2 }));
        await service.resume(actor(organizationId, managerA, 'MANAGER'), id,
          parseWeeklyReportRecurrenceResumeInput({
            clientActionId: randomUUID(), expectedVersion: 3, periodStart: null,
          }));
        expect((await ruleRow(pool, id)).requested_by_user_id).toBe(managerA);
      });
    });
  });
});
