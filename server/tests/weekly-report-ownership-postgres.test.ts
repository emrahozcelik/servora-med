import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardStatus } from '../src/modules/job-cards/types.js';
import { PostgresStaffOffboardingService, computeStaffOffboardingPlanHash, type StaffOffboardingPlan } from '../src/modules/people/offboarding.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const at = new Date('2026-08-03T09:00:00Z');
const draft = { summary: 'Haftanın özeti.', nextWeekPlan: 'Gelecek hafta planı.', blockers: null,
  highlights: null, fieldObservations: null, supportNeeded: null };

type Fixture = {
  pool: Pool; org: string; foreignOrg: string;
  admin: SafeUser; manager: SafeUser; a: SafeUser; b: SafeUser; foreign: SafeUser;
  jobs: JobCardService; offboarding: PostgresStaffOffboardingService;
};

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `sof2a_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    const org = (await pool.query<{ id: string }>(
      `INSERT INTO organizations(name, timezone) VALUES ('SOF2A', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const foreignOrg = (await pool.query<{ id: string }>(
      `INSERT INTO organizations(name) VALUES ('SOF2A foreign') RETURNING id`,
    )).rows[0]!.id;
    async function user(role: SafeUser['role'], organizationId = org): Promise<SafeUser> {
      const email = `${randomUUID()}@example.test`;
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users(organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, 'test-hash', $2) RETURNING id`, [organizationId, role, email],
      )).rows[0]!;
      return { id: row.id, organizationId, role, name: role, email,
        isActive: true, mustChangePassword: false, version: 1 };
    }
    const admin = await user('ADMIN'); const manager = await user('MANAGER');
    const a = await user('STAFF'); const b = await user('STAFF'); const foreign = await user('ADMIN', foreignOrg);
    const jobs = new JobCardService(new PostgresJobCardRepository(pool), () => at,
      { publish: () => undefined }, { enabled: false }, { enabled: false },
      { enabled: false, reminderLeadMinutes: 30 });
    await pool.query(`INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES ($1, $2, '2099-01-01')`, [a.id, randomUUID().replaceAll('-', '').padEnd(64, '0')]);
    await run({ pool, org, foreignOrg, admin, manager, a, b, foreign, jobs,
      offboarding: new PostgresStaffOffboardingService(pool, undefined, () => at) });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function weekly(f: Fixture, status: JobCardStatus = 'NEW', periodStart = '2026-08-03') {
  const created = await f.jobs.createWeeklyReport(f.manager, parseWeeklyReportCreateInput({
    clientActionId: randomUUID(), periodStart, assignedTo: f.a.id,
  }));
  const id = created.jobCardId;
  const intent = async () => ({ clientActionId: randomUUID(), expectedVersion: (await f.jobs.detail(f.manager, id)).version });
  if (status !== 'NEW') await f.jobs.acceptAssignment(f.a, id, await intent());
  if (!['NEW', 'ACCEPTED'].includes(status)) {
    await f.jobs.start(f.a, id, await intent());
    await f.jobs.updateWeeklyReportDraft(f.a, id, { expectedVersion: 1, draft, answers: [] });
  }
  if (['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED'].includes(status)) {
    await f.jobs.submitForApproval(f.a, id, { ...await intent(), note: 'Rapor gönderildi.' });
  }
  if (status === 'REVISION_REQUESTED') await f.jobs.requestRevision(f.manager, id,
    { ...await intent(), revisionReason: 'Açıklama gerekiyor.' });
  if (status === 'COMPLETED' || status === 'INVALIDATED') await f.jobs.approve(f.manager, id, await intent());
  if (status === 'CANCELLED') await f.jobs.cancel(f.manager, id,
    { ...await intent(), cancelReason: 'Yönetici incelemesi.' });
  if (status === 'INVALIDATED') await f.jobs.invalidate(f.admin, id,
    { ...await intent(), reasonCode: 'CREATED_BY_MISTAKE', note: null });
  return id;
}

async function snapshot(f: Fixture) {
  const tables = ['users', 'job_cards', 'weekly_reports', 'weekly_report_submissions',
    'job_card_activity_logs', 'job_card_notes', 'job_card_assignment_history',
    'job_card_schedule_revisions', 'job_card_accountability_facts', 'audit_events',
    'processed_actions', 'customers', 'calendar_events', 'calendar_reminders',
    'conversations', 'conversation_participants'];
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await f.pool.query(
    `SELECT to_jsonb(t) AS row FROM ${table} t WHERE organization_id = $1 ORDER BY to_jsonb(t)::text`, [f.org],
  )).rows;
  rows.sessions = (await f.pool.query(`SELECT to_jsonb(s) AS row FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE u.organization_id = $1 ORDER BY s.id`, [f.org])).rows;
  return rows;
}

function decisions(f: Fixture, plan: StaffOffboardingPlan) {
  return { clientActionId: randomUUID(), planHash: plan.planHash, reasonCode: 'ACCESS_ENDED' as const,
    jobDecisions: plan.jobs.map((j) => ({ jobCardId: j.id, replacementUserId: f.b.id })),
    customerDecisions: plan.customers.map((c) => ({ customerId: c.id, action: 'REASSIGN' as const, replacementUserId: f.b.id })),
    calendarDecisions: plan.calendar.map((c) => ({ calendarEventId: c.id, replacementUserId: f.b.id })),
    followUpDecisions: plan.followUps.map((c) => ({ jobCardId: c.jobCardId, replacementUserId: f.b.id })),
    reminderDecisions: plan.reminders.map((r) => ({ reminderId: r.id, action: 'TRANSFER' as const, replacementUserId: f.b.id })) };
}

async function ordinary(f: Fixture) {
  return (await f.pool.query<{ id: string }>(`INSERT INTO job_cards
    (organization_id, type, status, title, assigned_to, created_by)
    VALUES ($1, 'GENERAL_TASK', 'NEW', 'Klinik arama planı', $2, $3) RETURNING id`,
  [f.org, f.a.id, f.admin.id])).rows[0]!.id;
}

async function waitForLocks(f: Fixture, minimum: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = await f.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (rows.rowCount! >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} actual PostgreSQL lock waiters`);
}

async function blocker(work: () => Promise<unknown>) {
  try { await work(); } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (error instanceof AppError) {
      expect(error.code).toBe('OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION');
      expect(error.statusCode).toBe(409);
      const page = error.details?.weeklyReports;
      if (!page || typeof page !== 'object' || !('items' in page) || !Array.isArray(page.items)) {
        throw new Error('Expected bounded weeklyReports metadata');
      }
      expect(Object.keys(page).sort()).toEqual(['total', 'limit', 'hasMore', 'items'].sort());
      for (const item of page.items) expect(Object.keys(item).sort()).toEqual([
        'jobCardId', 'reportId', 'staffUserId', 'assignedTo', 'periodStart',
        'status', 'jobVersion', 'reportVersion', 'reason',
      ].sort());
      return error;
    }
  }
  throw new Error('Expected WeeklyReport offboarding blocker');
}

describe.skipIf(!databaseUrl)('SOF-2A WeeklyReport ownership (PostgreSQL)', () => {
  it('rejects management reassignment without changing report identity or history', async () => {
    await withFixture(async (f) => {
      const id = await weekly(f);
      const before = await snapshot(f);
      await expect(f.jobs.patch(f.manager, id, { expectedVersion: 1, assignedTo: f.b.id }))
        .rejects.toMatchObject({ code: 'WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE', statusCode: 409 });
      expect(await snapshot(f)).toEqual(before);
    });
  });

  it('blocks preview and a fresh execute when an unfinished weekly report exists', async () => {
    await withFixture(async (f) => {
      const oldPlan = await f.offboarding.preview(f.admin, f.a.id);
      await weekly(f);
      const before = await snapshot(f);
      await blocker(() => f.offboarding.preview(f.admin, f.a.id));
      await blocker(() => f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan)));
      expect(await snapshot(f)).toEqual(before);
    });
  });

  for (const status of ['NEW', 'ACCEPTED'] as const) {
    for (const actor of ['admin', 'manager', 'a'] as const) {
      if (status === 'NEW' && actor === 'manager') continue;
      it(`rejects ${actor} reassignment of ${status} without side effects`, async () => withFixture(async (f) => {
        const id = await weekly(f, status); const version = (await f.jobs.detail(f.manager, id)).version;
        const before = await snapshot(f);
        await expect(f.jobs.patch(f[actor], id, { expectedVersion: version, assignedTo: f.b.id }))
          .rejects.toMatchObject({ code: 'WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE', statusCode: 409 });
        expect(await snapshot(f)).toEqual(before);
      }));
    }
    it(`preserves same-value ${status} PATCH for all authorized actors`, async () => withFixture(async (f) => {
      const id = await weekly(f, status);
      const before = await snapshot(f);
      const persisted = async () => (await f.pool.query(`SELECT to_jsonb(j) - 'version' - 'updated_at' AS row
        FROM job_cards j WHERE id = $1`, [id])).rows;
      const original = await persisted();
      for (const actor of [f.admin, f.manager, f.a]) {
        const version = (await f.jobs.detail(f.manager, id)).version;
        const result = await f.jobs.patch(actor, id, { expectedVersion: version, assignedTo: f.a.id });
        // Preserve existing PATCH version bumps, without assignment events or acceptance reset.
        expect(result.version).toBe(version + 1);
        expect(await persisted()).toEqual(original);
        const after = await snapshot(f);
        for (const table of Object.keys(before).filter((key) => key !== 'job_cards')) {
          expect(after[table]).toEqual(before[table]);
        }
      }
    }));
  }

  for (const status of ['ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
    it(`blocks ${status} preview/execute while preserving draft, frozen history and sessions`, async () => withFixture(async (f) => {
      const oldPlan = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f, status);
      const before = await snapshot(f);
      const error = await blocker(() => f.offboarding.preview(f.admin, f.a.id));
      expect(error.details).toMatchObject({ weeklyReports: { total: 1, limit: 50, hasMore: false,
        items: [{ jobCardId: id, staffUserId: f.a.id, assignedTo: f.a.id, status, reason: 'UNFINISHED' }] } });
      expect(JSON.stringify(error.details)).not.toContain(draft.summary);
      await blocker(() => f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan)));
      expect(await snapshot(f)).toEqual(before);
    }));
  }

  for (const target of ['a', 'b'] as const) {
    it(`detects legacy owner=A/assignee=B when offboarding ${target}`, async () => withFixture(async (f) => {
      const oldPlan = await f.offboarding.preview(f.admin, f[target].id); const id = await weekly(f);
      // Seed a pre-fix mismatch without reopening the now-protected PATCH producer.
      await f.pool.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [id, f.b.id]);
      const before = await snapshot(f);
      const error = await blocker(() => f.offboarding.preview(f.admin, f[target].id));
      expect(error.details).toMatchObject({ weeklyReports: { total: 1,
        items: [{ jobCardId: id, staffUserId: f.a.id, assignedTo: f.b.id, reason: 'OWNER_ASSIGNEE_MISMATCH' }] } });
      await blocker(() => f.offboarding.execute(f.admin, f[target].id, decisions(f, oldPlan)));
      expect(await snapshot(f)).toEqual(before);
    }));
  }

  for (const corruption of ['MISSING_REPORT', 'ROOT_TYPE_MISMATCH'] as const) {
    it(`fails closed on ${corruption}`, async () => withFixture(async (f) => {
      const oldPlan = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f);
      if (corruption === 'MISSING_REPORT') await f.pool.query('DELETE FROM weekly_reports WHERE job_card_id = $1', [id]);
      else await f.pool.query("UPDATE job_cards SET type = 'GENERAL_TASK' WHERE id = $1", [id]);
      const before = await snapshot(f); const error = await blocker(() => f.offboarding.preview(f.admin, f.a.id));
      expect(error.details).toMatchObject({ weeklyReports: { total: 1, items: [{ jobCardId: id, reason: corruption }] } });
      await blocker(() => f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan)));
      expect(await snapshot(f)).toEqual(before);
    }));
  }

  for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
    it(`preserves terminal ${status} report identity, content and historical attribution`, async () => withFixture(async (f) => {
      await weekly(f, status); const before = await snapshot(f);
      const plan = await f.offboarding.preview(f.admin, f.a.id); expect(plan.jobs).toHaveLength(0);
      const intent = decisions(f, plan); const response = await f.offboarding.execute(f.admin, f.a.id, intent);
      const after = await snapshot(f);
      for (const table of ['job_cards', 'weekly_reports', 'weekly_report_submissions', 'job_card_activity_logs',
        'job_card_assignment_history', 'job_card_accountability_facts']) expect(after[table]).toEqual(before[table]);
      expect(await f.offboarding.execute(f.admin, f.a.id, intent)).toEqual(response);
      expect(await snapshot(f)).toEqual(after);
    }));

    it(`preserves SOF-1 ${status} future-proposal priority over unfinished weekly blockers`, async () => withFixture(async (f) => {
      const oldPlan = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f, status);
      await weekly(f, 'NEW', '2026-08-10');
      await f.pool.query(`UPDATE job_cards SET follow_up_proposed_at = '2099-01-01',
        follow_up_proposed_type = 'GENERAL_TASK', follow_up_proposed_assignee = $2,
        follow_up_proposal_instructions = 'İncelenecek tarihsel öneri',
        follow_up_proposal_origin = 'SYSTEM', follow_up_proposed_by = $2 WHERE id = $1`, [id, f.a.id]);
      const before = await snapshot(f);
      for (const run of [() => f.offboarding.preview(f.admin, f.a.id),
        () => f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan))]) {
        await expect(run()).rejects.toMatchObject({ code: 'OFFBOARDING_TERMINAL_FOLLOW_UP_REQUIRES_REVIEW' });
      }
      expect(await snapshot(f)).toEqual(before);
    }));
  }

  it('rolls back mixed responsibilities and rejects forged weekly transfer decisions', async () => withFixture(async (f) => {
    const jobId = await ordinary(f);
    await f.pool.query(`INSERT INTO customers(organization_id, name, customer_type, assigned_staff_user_id)
      VALUES ($1, 'Klinik', 'clinic', $2)`, [f.org, f.a.id]);
    await new PostgresCalendarRepository(f.pool, 30, true).createManual(f.manager, {
      clientActionId: randomUUID(), assignedUserId: f.a.id, title: 'Bağımsız görüşme', description: null,
      startsAt: '2026-08-04T09:00:00Z', endsAt: '2026-08-04T10:00:00Z', timezone: 'Europe/Istanbul',
    }, at);
    const conversation = (await f.pool.query<{ id: string }>(`INSERT INTO conversations
      (organization_id, direct_key, context_type, job_id) VALUES ($1, $2, 'JOB', $3) RETURNING id`,
    [f.org, randomUUID(), jobId])).rows[0]!.id;
    await f.pool.query(`INSERT INTO conversation_participants(organization_id, conversation_id, user_id)
      VALUES ($1, $2, $3)`, [f.org, conversation, f.a.id]);
    const oldPlan = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f);
    const intent = decisions(f, oldPlan); intent.jobDecisions.push({ jobCardId: id, replacementUserId: f.b.id });
    const before = await snapshot(f);
    await blocker(() => f.offboarding.execute(f.admin, f.a.id, intent));
    expect(await snapshot(f)).toEqual(before);
  }));

  it('retains normal non-weekly transfers, stale-plan rejection and completed replay before new validation', async () => withFixture(async (f) => {
    const id = await ordinary(f); const oldPlan = await f.offboarding.preview(f.admin, f.a.id);
    await f.jobs.patch(f.manager, id, { expectedVersion: 1, title: 'Yeni klinik arama planı' });
    const before = await snapshot(f);
    await expect(f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan))).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect(await snapshot(f)).toEqual(before);
    const plan = await f.offboarding.preview(f.admin, f.a.id); const intent = decisions(f, plan);
    const response = await f.offboarding.execute(f.admin, f.a.id, intent);
    expect((await f.jobs.detail(f.manager, id)).assignedTo).toBe(f.b.id);
    // A completed original intent must not be re-evaluated against new legacy rows.
    await f.pool.query(`INSERT INTO job_cards(organization_id, type, status, title, assigned_to, created_by)
      VALUES ($1, 'WEEKLY_REPORT', 'NEW', 'Geçmiş tutarsız kayıt', $2, $3)`, [f.org, f.a.id, f.admin.id]);
    const completed = await snapshot(f);
    expect(await f.offboarding.execute(f.admin, f.a.id, intent)).toEqual(response);
    expect(await snapshot(f)).toEqual(completed);
    await expect(f.offboarding.execute(f.admin, f.a.id, { ...intent, reasonCode: 'ROLE_CHANGED' }))
      .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
  }));

  it('requires a fresh plan after resolution of a legacy reviewed weekly assignment', async () => withFixture(async (f) => {
    const empty = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f);
    const legacy = { ...empty, jobs: [{ id, status: 'NEW', version: 1, assignedTo: f.a.id }] };
    const oldPlan = { ...legacy, planHash: computeStaffOffboardingPlanHash(legacy) };
    await f.jobs.cancel(f.manager, id, { clientActionId: randomUUID(), expectedVersion: 1, cancelReason: 'Yönetici kararı.' });
    const before = await snapshot(f);
    await expect(f.offboarding.execute(f.admin, f.a.id, decisions(f, oldPlan))).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect(await snapshot(f)).toEqual(before);
    const fresh = await f.offboarding.preview(f.admin, f.a.id); expect(fresh.jobs).toHaveLength(0);
    await f.offboarding.execute(f.admin, f.a.id, decisions(f, fresh));
  }));

  it('keeps role/tenant authorization ahead of blocker metadata and forged foreign decisions', async () => withFixture(async (f) => {
    const empty = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f);
    const before = await snapshot(f);
    for (const actor of [f.manager, f.a]) {
      await expect(f.offboarding.preview(actor, f.a.id)).rejects.toMatchObject({ code: 'FORBIDDEN', details: null });
      await expect(f.offboarding.execute(actor, f.a.id, decisions(f, empty))).rejects.toMatchObject({ code: 'FORBIDDEN', details: null });
    }
    await expect(f.offboarding.preview(f.foreign, f.a.id)).rejects.toMatchObject({ code: 'USER_NOT_FOUND', details: null });
    await expect(f.offboarding.execute(f.foreign, f.a.id, decisions(f, empty))).rejects.toMatchObject({ code: 'USER_NOT_FOUND', details: null });
    await expect(f.jobs.patch(f.foreign, id, { expectedVersion: 1, assignedTo: f.b.id })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
    const foreignStaff = (await f.pool.query<{ id: string }>(`INSERT INTO users
      (organization_id, name, email, password_hash, role)
      VALUES ($1, 'Foreign Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
    [f.foreignOrg, `${randomUUID()}@example.test`])).rows[0]!.id;
    const foreignPlan = await f.offboarding.preview(f.foreign, foreignStaff);
    expect(foreignPlan.jobs).toHaveLength(0);
    const forged = { ...decisions(f, foreignPlan), jobDecisions: [{ jobCardId: id, replacementUserId: f.b.id }] };
    await expect(f.offboarding.execute(f.foreign, foreignStaff, forged))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: null });
    expect((await f.pool.query(`SELECT count(*)::int AS n FROM processed_actions WHERE organization_id = $1`,
      [f.foreignOrg])).rows[0]!.n).toBe(0);
    expect(await snapshot(f)).toEqual(before);
  }));

  for (const count of [1, 50, 201]) {
    it(`counts every one of ${count} blockers with bounded deterministic metadata`, async () => withFixture(async (f) => {
      const empty = await f.offboarding.preview(f.admin, f.a.id);
      const expected: { id: string; period: string }[] = [];
      for (let n = 0; n < count; n += 1) {
        const row = (await f.pool.query<{ id: string }>(`INSERT INTO job_cards
          (organization_id, type, status, title, assigned_to, created_by)
          VALUES ($1, 'WEEKLY_REPORT', 'NEW', 'Klinik hafta raporu', $2, $3) RETURNING id`, [f.org, f.a.id, f.admin.id])).rows[0]!;
        const report = (await f.pool.query<{ period: string }>(`INSERT INTO weekly_reports
          (organization_id, job_card_id, staff_user_id, period_start, period_end)
          VALUES ($1, $2, $3, '2020-01-06'::date + $4::int * 7, '2020-01-12'::date + $4::int * 7)
          RETURNING period_start::text AS period`, [f.org, row.id, f.a.id, count - n])).rows[0]!;
        expected.push({ id: row.id, period: report.period });
      }
      const before = await snapshot(f);
      const error = await blocker(() => f.offboarding.preview(f.admin, f.a.id));
      expect(error.details).toMatchObject({ weeklyReports: { total: count, limit: 50, hasMore: count > 50,
        items: expected.sort((a, b) => a.period.localeCompare(b.period)).slice(0, 50).map((row) => ({ jobCardId: row.id, periodStart: row.period })) } });
      expect((await blocker(() => f.offboarding.preview(f.admin, f.a.id))).details).toEqual(error.details);
      expect((await blocker(() => f.offboarding.execute(f.admin, f.a.id, decisions(f, empty)))).details).toEqual(error.details);
      expect(await snapshot(f)).toEqual(before);
    }));
  }

  for (const lock of ['root', 'user'] as const) {
    it(`serializes competing PATCH/offboarding behind the actual ${lock} row lock`, async () => withFixture(async (f) => {
      const empty = await f.offboarding.preview(f.admin, f.a.id); const id = await weekly(f); const before = await snapshot(f);
      const holder = await f.pool.connect();
      let patch: Promise<void> | undefined; let execute: Promise<void> | undefined;
      try {
        await holder.query('BEGIN');
        if (lock === 'root') await holder.query('SELECT id FROM job_cards WHERE id = $1 FOR UPDATE', [id]);
        else await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.a.id]);
        const startPatch = () => expect(f.jobs.patch(f.manager, id, { expectedVersion: 1, assignedTo: f.b.id }))
          .rejects.toMatchObject({ code: 'WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE' });
        const startExecute = async () => { await blocker(() => f.offboarding.execute(f.admin, f.a.id, decisions(f, empty))); };
        if (lock === 'root') { patch = startPatch(); await waitForLocks(f, 1); execute = startExecute(); }
        else { execute = startExecute(); await waitForLocks(f, 1); patch = startPatch(); }
        await waitForLocks(f, 2);
        await holder.query('COMMIT');
        await Promise.all([patch, execute]);
        expect(await snapshot(f)).toEqual(before);
      } finally {
        await holder.query('ROLLBACK'); holder.release();
        await Promise.allSettled([patch, execute]);
      }
    }));
  }
});
