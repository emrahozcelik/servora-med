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

/**
 * The profile Weekly Report history read model against real PostgreSQL.
 *
 * This is the isolation gate for `PostgresJobCardRepository.listForStaff`. The
 * statement it runs carries both the tenant predicate and the owner predicate,
 * folds the submission aggregate in with a LATERAL subquery, and paginates — all
 * of which a port double cannot exercise. The dataset below is deliberately
 * adversarial: two organisations, a second staff member inside the first
 * organisation, and one report carrying two immutable submissions.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

/** Older week for Staff A1 (two submissions, then approved). */
const WEEK_A = '2026-08-03';
/** Newer week for Staff A1 (zero submissions, no due date). */
const WEEK_B = '2026-08-10';
/** Staff A2's week, inside the same organisation as A1. */
const WEEK_A2 = '2026-08-03';
/** Org B's week. */
const WEEK_B1 = '2026-08-03';

const NOW = new Date('2026-08-03T09:00:00.000Z');

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2h_${randomUUID().replaceAll('-', '')}`;
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
    [`WR2H ${randomUUID()}`],
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
    [organizationId, `WR2H ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function buildService(pool: Pool) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => NOW,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

const actor = (organizationId: string, id: string, role: JobCardActor['role']): JobCardActor => ({
  id, organizationId, role,
});

const DRAFT_V1 = {
  summary: 'Haftanın özeti.',
  blockers: null,
  nextWeekPlan: 'Gelecek hafta planı.',
  highlights: null,
  fieldObservations: null,
  supportNeeded: null,
};

/** Self-created report driven to IN_PROGRESS with a submittable draft. */
async function prepareSubmittable(
  service: JobCardService,
  organizationId: string,
  staffId: string,
  periodStart: string,
) {
  const created = await service.createWeeklyReport(
    actor(organizationId, staffId, 'STAFF'),
    parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }),
  );
  await service.start(
    actor(organizationId, staffId, 'STAFF'),
    created.jobCardId,
    { clientActionId: randomUUID(), expectedVersion: 1 },
  );
  await service.updateWeeklyReportDraft(
    actor(organizationId, staffId, 'STAFF'),
    created.jobCardId,
    { expectedVersion: 1, draft: DRAFT_V1, answers: [] },
  );
  return created;
}

async function submit(
  service: JobCardService,
  organizationId: string,
  staffId: string,
  jobCardId: string,
  expectedVersion: number,
) {
  return service.submitForApproval(
    actor(organizationId, staffId, 'STAFF'),
    jobCardId,
    { clientActionId: randomUUID(), expectedVersion, note: 'Onaya gönderildi.' },
  );
}

/** Drives a report through revision → resume → resubmit so it holds two submissions. */
async function driveTwoSubmissions(
  service: JobCardService,
  organizationId: string,
  managerId: string,
  staffId: string,
  jobCardId: string,
) {
  await submit(service, organizationId, staffId, jobCardId, 2);
  await service.requestRevision(
    actor(organizationId, managerId, 'MANAGER'),
    jobCardId,
    { clientActionId: randomUUID(), expectedVersion: 3, revisionReason: 'Özeti genişlet.' },
  );
  await service.resume(
    actor(organizationId, staffId, 'STAFF'),
    jobCardId,
    { clientActionId: randomUUID(), expectedVersion: 4 },
  );
  await service.updateWeeklyReportDraft(
    actor(organizationId, staffId, 'STAFF'),
    jobCardId,
    { expectedVersion: 3, draft: { ...DRAFT_V1, summary: 'Revize özet.' }, answers: [] },
  );
  await submit(service, organizationId, staffId, jobCardId, 5);
}

type Seed = {
  orgA: string;
  orgB: string;
  managerA: string;
  managerB: string;
  staffA1: string;
  staffA2: string;
  staffB1: string;
  /** A1's older report: two submissions, approved, real due date. */
  a1Old: { reportId: string; jobCardId: string };
  /** A1's newer report: zero submissions, no due date. */
  a1New: { reportId: string; jobCardId: string };
  /** A2's report inside org A. */
  a2: { reportId: string; jobCardId: string };
  /** B1's report inside org B. */
  b1: { reportId: string; jobCardId: string };
  seq1SubmittedAt: string;
  seq2SubmittedAt: string;
  a1OldApprovedAt: string;
};

async function seed(pool: Pool): Promise<Seed> {
  const service = buildService(pool);
  const orgA = await insertOrg(pool);
  const orgB = await insertOrg(pool);
  const managerA = await insertUser(pool, orgA, 'MANAGER');
  const managerB = await insertUser(pool, orgB, 'MANAGER');
  const staffA1 = await insertUser(pool, orgA, 'STAFF');
  const staffA2 = await insertUser(pool, orgA, 'STAFF');
  const staffB1 = await insertUser(pool, orgB, 'STAFF');

  // A1 older: two submissions then manager approval.
  const a1Old = await prepareSubmittable(service, orgA, staffA1, WEEK_A);
  await driveTwoSubmissions(service, orgA, managerA, staffA1, a1Old.jobCardId);
  const history = await service.listWeeklyReportSubmissions(
    actor(orgA, staffA1, 'STAFF'), a1Old.jobCardId,
  );
  if (history.length !== 2) throw new Error(`expected 2 submissions, got ${history.length}`);
  const approved = await service.approve(
    actor(orgA, managerA, 'MANAGER'),
    a1Old.jobCardId,
    { clientActionId: randomUUID(), expectedVersion: 6 },
  );
  if (approved.status !== 'COMPLETED') throw new Error('approval did not complete the report');

  // A1 newer: never submitted, and deliberately without a due date.
  const a1New = await prepareSubmittable(service, orgA, staffA1, WEEK_B);
  await pool.query(`UPDATE job_cards SET due_date = NULL WHERE id = $1`, [a1New.jobCardId]);

  // A2 and B1: a single never-submitted report each.
  const a2 = await prepareSubmittable(service, orgA, staffA2, WEEK_A2);
  const b1 = await prepareSubmittable(service, orgB, staffB1, WEEK_B1);

  const approvalRow = (await pool.query<{ manager_approved_at: Date }>(
    `SELECT manager_approved_at FROM job_cards WHERE id = $1`, [a1Old.jobCardId],
  )).rows[0]!;
  if (approvalRow.manager_approved_at === null) throw new Error('approval instant not persisted');

  return {
    orgA, orgB, managerA, managerB, staffA1, staffA2, staffB1, a1Old, a1New, a2, b1,
    seq1SubmittedAt: history[0]!.submittedAt,
    seq2SubmittedAt: history[1]!.submittedAt,
    a1OldApprovedAt: approvalRow.manager_approved_at.toISOString(),
  };
}

const repository = (pool: Pool) => new PostgresJobCardRepository(pool);

describe.skipIf(!databaseUrl)('weekly report profile history (PostgreSQL)', () => {
  it('scopes a manager page to the target owner and never leaks another staff or tenant', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const page = await repository(pool).listForStaff({
        organizationId: s.orgA,
        targetUserId: s.staffA1,
        actor: actor(s.orgA, s.managerA, 'MANAGER'),
        limit: 20,
        offset: 0,
      });

      expect(page.total).toBe(2);
      expect(page.items.map((item) => item.reportId)).toEqual([s.a1New.reportId, s.a1Old.reportId]);
      for (const item of page.items) expect(item.staffUserId).toBe(s.staffA1);
      // A2 is in the same organisation; B1 is in another. Neither may appear.
      expect(page.items.some((item) => item.reportId === s.a2.reportId)).toBe(false);
      expect(page.items.some((item) => item.reportId === s.b1.reportId)).toBe(false);
    });
  });

  it('orders by period_start DESC deterministically and paginates without drifting', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const repo = repository(pool);
      const query = (offset: number, limit = 1) => repo.listForStaff({
        organizationId: s.orgA,
        targetUserId: s.staffA1,
        actor: actor(s.orgA, s.managerA, 'MANAGER'),
        limit,
        offset,
      });

      const first = await query(0);
      const second = await query(1);
      const third = await query(2);

      expect(first.items.map((item) => item.reportId)).toEqual([s.a1New.reportId]);
      expect(second.items.map((item) => item.reportId)).toEqual([s.a1Old.reportId]);
      expect(third.items).toEqual([]);
      // The count statement is independent of the page window.
      expect([first.total, second.total, third.total]).toEqual([2, 2, 2]);

      // Repeated identical queries must return an identical order (stable tie-break).
      const repeat = await query(0, 20);
      const again = await query(0, 20);
      expect(repeat.items.map((item) => item.reportId))
        .toEqual(again.items.map((item) => item.reportId));
      expect(repeat.items.map((item) => item.periodStart)).toEqual([WEEK_B, WEEK_A]);
    });
  });

  it('folds the submission aggregate without multiplying rows', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const page = await repository(pool).listForStaff({
        organizationId: s.orgA,
        targetUserId: s.staffA1,
        actor: actor(s.orgA, s.managerA, 'MANAGER'),
        limit: 20,
        offset: 0,
      });

      // Two reports, one of which has two submissions: a LATERAL that multiplied
      // rows would return three.
      expect(page.items).toHaveLength(2);
      const byId = new Map(page.items.map((item) => [item.reportId, item]));

      const never = byId.get(s.a1New.reportId)!;
      expect(never.submissionCount).toBe(0);
      expect(never.latestSubmissionSeqNo).toBeNull();
      expect(never.latestSubmittedAt).toBeNull();

      const twice = byId.get(s.a1Old.reportId)!;
      expect(twice.submissionCount).toBe(2);
      // The latest is the highest frozen seq, and its submittedAt comes from
      // that same seq — not from seq 1.
      expect(twice.latestSubmissionSeqNo).toBe(2);
      expect(twice.latestSubmittedAt).toBe(s.seq2SubmittedAt);
      expect(twice.latestSubmittedAt).not.toBe(s.seq1SubmittedAt);
    });
  });

  it('maps the calendar due date and the approval instant without shifting either', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const page = await repository(pool).listForStaff({
        organizationId: s.orgA,
        targetUserId: s.staffA1,
        actor: actor(s.orgA, s.managerA, 'MANAGER'),
        limit: 20,
        offset: 0,
      });
      const byId = new Map(page.items.map((item) => [item.reportId, item]));

      // A report created for the week of 2026-08-03 is due the next Monday.
      // The value is the server's calendar date, so it must not shift a day.
      expect(byId.get(s.a1Old.reportId)!.dueDate).toBe('2026-08-10');
      expect(byId.get(s.a1Old.reportId)!.periodStart).toBe(WEEK_A);
      expect(byId.get(s.a1Old.reportId)!.periodEnd).toBe('2026-08-09');
      // A missing deadline stays missing rather than becoming an invented date.
      expect(byId.get(s.a1New.reportId)!.dueDate).toBeNull();

      // completedAt is the JobCard approval instant, null until then.
      expect(byId.get(s.a1Old.reportId)!.completedAt).toBe(s.a1OldApprovedAt);
      expect(byId.get(s.a1New.reportId)!.completedAt).toBeNull();
      expect(byId.get(s.a1Old.reportId)!.status).toBe('COMPLETED');
    });
  });

  it('re-scopes a STAFF actor to its own reports even for a foreign target id', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const page = await repository(pool).listForStaff({
        organizationId: s.orgA,
        // A caller that resolves the wrong target must not widen a STAFF actor.
        targetUserId: s.staffA2,
        actor: actor(s.orgA, s.staffA1, 'STAFF'),
        limit: 20,
        offset: 0,
      });

      expect(page.total).toBe(2);
      expect(page.items.map((item) => item.reportId)).toEqual([s.a1New.reportId, s.a1Old.reportId]);
      expect(page.items.some((item) => item.reportId === s.a2.reportId)).toBe(false);

      // A2 asking for its own history sees exactly its own single report.
      const own = await repository(pool).listForStaff({
        organizationId: s.orgA,
        targetUserId: s.staffA1,
        actor: actor(s.orgA, s.staffA2, 'STAFF'),
        limit: 20,
        offset: 0,
      });
      expect(own.items.map((item) => item.reportId)).toEqual([s.a2.reportId]);
    });
  });

  it('never crosses the tenant boundary', async () => {
    await withSchema(async (pool) => {
      const s = await seed(pool);
      const repo = repository(pool);

      // An Org B manager explicitly asking for an Org A staff member: the tenant
      // predicate is the only thing standing between them.
      const foreign = await repo.listForStaff({
        organizationId: s.orgB,
        targetUserId: s.staffA1,
        actor: actor(s.orgB, s.managerB, 'MANAGER'),
        limit: 20,
        offset: 0,
      });
      expect(foreign.total).toBe(0);
      expect(foreign.items).toEqual([]);

      // A STAFF actor cannot be pointed at a foreign target either: it is
      // re-scoped to itself, so the result is its own report and never A1's.
      const staffForeign = await repo.listForStaff({
        organizationId: s.orgB,
        targetUserId: s.staffA1,
        actor: actor(s.orgB, s.staffB1, 'STAFF'),
        limit: 20,
        offset: 0,
      });
      expect(staffForeign.items.map((item) => item.reportId)).toEqual([s.b1.reportId]);
      expect(staffForeign.items.every((item) => item.staffUserId === s.staffB1)).toBe(true);

      const own = await repo.listForStaff({
        organizationId: s.orgB,
        targetUserId: s.staffB1,
        actor: actor(s.orgB, s.staffB1, 'STAFF'),
        limit: 20,
        offset: 0,
      });
      expect(own.items.map((item) => item.reportId)).toEqual([s.b1.reportId]);
      expect(own.items[0]!.staffUserId).toBe(s.staffB1);
    });
  });
});
