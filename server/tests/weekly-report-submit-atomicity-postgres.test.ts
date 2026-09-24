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
const NOW = new Date('2026-08-05T12:00:00.000Z');

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr2s_${randomUUID().replaceAll('-', '')}`;
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
    [`WR2S ${randomUUID()}`],
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
    [organizationId, `WR2S ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
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
  pool: Pool,
  service: JobCardService,
  organizationId: string,
  staffId: string,
  periodStart = WEEK_A,
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

describe.skipIf(!databaseUrl)('weekly report atomic submission (PostgreSQL)', () => {
  it('commits transition, activity and immutable seq-1 submission together', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await prepareSubmittable(pool, service, organizationId, staffId);
      const submitted = await submit(service, organizationId, staffId, created.jobCardId, 2);
      expect(submitted.status).toBe('WAITING_APPROVAL');

      const job = (await pool.query(
        `SELECT status, staff_completed_at, staff_completed_by FROM job_cards WHERE id = $1`,
        [created.jobCardId],
      )).rows[0];
      expect(job.status).toBe('WAITING_APPROVAL');
      const completedAt = new Date(job.staff_completed_at).toISOString();
      expect(job.staff_completed_by).toBe(staffId);

      const activities = (await pool.query(
        `SELECT id, event_type FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2 AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`,
        [organizationId, created.jobCardId],
      )).rows;
      expect(activities).toHaveLength(1);

      const history = await service.listWeeklyReportSubmissions(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      expect(history).toHaveLength(1);
      const first = history[0]!;
      expect(first.seqNo).toBe(1);
      // Authoritative server clock: the submission shares the exact request
      // clock written as staff_completed_at evidence (DB clock_timestamp).
      expect(first.submittedAt).toBe(completedAt);
      expect(first.submittedBy).toBe(staffId);
      expect(first.jobVersion).toBe(3);
      // Exact linkage to the transition's own activity (never client-supplied).
      expect(first.sourceActivityId).toBe(activities[0]!.id);
      expect(first.body).toMatchObject({ summary: 'Haftanın özeti.', nextWeekPlan: 'Gelecek hafta planı.' });
      expect(first.periodStart).toBe(WEEK_A);
      // Draft locked once awaiting approval.
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 2, draft: DRAFT_V1, answers: [] },
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_DRAFT_LOCKED' });
    });
  });

  it('rolls back everything when the submission insert fails', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await prepareSubmittable(pool, service, organizationId, staffId);
      const spy = vi.spyOn(
        PostgresJobCardTransaction.prototype, 'insertWeeklyReportSubmissionRow',
      ).mockRejectedValueOnce(new Error('snapshot boom'));
      try {
        await expect(
          submit(service, organizationId, staffId, created.jobCardId, 2),
        ).rejects.toThrow('snapshot boom');
      } finally {
        spy.mockRestore();
      }
      const job = (await pool.query(
        `SELECT status FROM job_cards WHERE id = $1`, [created.jobCardId],
      )).rows[0];
      expect(job.status).toBe('IN_PROGRESS');
      const activities = await pool.query(
        `SELECT COUNT(*)::int AS n FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2 AND event_type = 'JOB_SUBMITTED_FOR_APPROVAL'`,
        [organizationId, created.jobCardId],
      );
      expect(activities.rows[0].n).toBe(0);
      const submissions = await pool.query(
        `SELECT COUNT(*)::int AS n FROM weekly_report_submissions WHERE organization_id = $1`,
        [organizationId],
      );
      expect(submissions.rows[0].n).toBe(0);
    });
  });

  it('writes no submission when the JobCard transition itself fails', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await prepareSubmittable(pool, service, organizationId, staffId);
      const spy = vi.spyOn(
        PostgresJobCardTransaction.prototype, 'transitionWithVersion',
      ).mockResolvedValueOnce(null);
      try {
        await expect(
          submit(service, organizationId, staffId, created.jobCardId, 2),
        ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      } finally {
        spy.mockRestore();
      }
      const submissions = await pool.query(
        `SELECT COUNT(*)::int AS n FROM weekly_report_submissions WHERE organization_id = $1`,
        [organizationId],
      );
      expect(submissions.rows[0].n).toBe(0);
    });
  });

  it('runs revision, resume, resubmit and approval with seq-1 frozen', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const managerId = await insertUser(pool, organizationId, 'MANAGER');
      const staffId = await insertUser(pool, organizationId, 'STAFF');
      const service = buildService(pool);
      const created = await prepareSubmittable(pool, service, organizationId, staffId);
      await submit(service, organizationId, staffId, created.jobCardId, 2);
      const before = await service.listWeeklyReportSubmissions(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      // Manager requests revision; no re-accept needed afterwards.
      await service.requestRevision(
        actor(organizationId, managerId, 'MANAGER'),
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 3, revisionReason: 'Özeti genişlet.' },
      );
      await service.resume(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 4 },
      );
      await service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 3, draft: { ...DRAFT_V1, summary: 'Revize özet.' }, answers: [] },
      );
      await submit(service, organizationId, staffId, created.jobCardId, 5);
      const history = await service.listWeeklyReportSubmissions(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      expect(history.map((entry) => entry.seqNo)).toEqual([1, 2]);
      expect(history[0]).toEqual(before[0]);
      expect(history[1]!.body.summary).toBe('Revize özet.');
      expect(history[1]!.jobVersion).toBe(6);
      // Staff cannot approve; manager approval completes without touching history.
      await expect(service.approve(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 6 },
      )).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const approved = await service.approve(
        actor(organizationId, managerId, 'MANAGER'),
        created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 6 },
      );
      expect(approved.status).toBe('COMPLETED');
      const after = await service.listWeeklyReportSubmissions(
        actor(organizationId, staffId, 'STAFF'), created.jobCardId,
      );
      expect(after).toEqual(history);
      await expect(service.updateWeeklyReportDraft(
        actor(organizationId, staffId, 'STAFF'),
        created.jobCardId,
        { expectedVersion: 3, draft: DRAFT_V1, answers: [] },
      )).rejects.toMatchObject({ code: 'WEEKLY_REPORT_DRAFT_LOCKED' });
    });
  });
});
