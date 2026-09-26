import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { createOverdueReminderPolicy } from '../src/modules/job-cards/overdue-reminder-policy.js';
import {
  PostgresOverdueReminderWorkerRepository,
  createOverdueReminderWorker,
  type OverdueReminderClaim,
} from '../src/modules/job-cards/overdue-reminder-worker.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// A fixed breach instant. All thresholds are derived from it, never from now.
const BREACH = new Date('2026-08-03T07:30:00.000Z');
const MINUTE = 60_000;

const POLICY = createOverdueReminderPolicy();

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr4w_${randomUUID().replaceAll('-', '')}`;
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

type Fixture = {
  organizationId: string;
  managerId: string;
  staffId: string;
  jobCardId: string;
};

async function seedFixture(
  pool: Pool,
  options: { accountable?: boolean } = {},
): Promise<Fixture> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ('OVR4 Worker Org', 'Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
  const managerId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, 'Yönetici', $2, 'h', 'MANAGER', TRUE) RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
  const staffId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, 'Ayşe Personel', $2, 'h', 'STAFF', TRUE) RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
  // IN_PROGRESS requires a started_at (job_cards_started_status_timestamp_check).
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by, status, started_at)
     VALUES ($1, 'GENERAL_TASK', 'Onaya gönderilmeyen iş', $2, $2, 'IN_PROGRESS', $3)
     RETURNING id`,
    [organizationId, staffId, BREACH],
  )).rows[0]!.id;
  // An incident references its governing schedule revision (composite FK).
  await seedScheduleRevision(pool, {
    organizationId, jobCardId, revisionNo: 1, scheduledAt: BREACH,
  });
  await seedIncident(pool, {
    organizationId,
    jobCardId,
    breachedAt: BREACH,
    accountableUserId: options.accountable === false ? null : staffId,
  });
  return { organizationId, managerId, staffId, jobCardId };
}

async function seedScheduleRevision(
  pool: Pool,
  input: { organizationId: string; jobCardId: string; revisionNo: number; scheduledAt: Date | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, organization_timezone, source)
     VALUES ($1,$2,$3,$4,'Europe/Istanbul','BASELINE')`,
    [input.organizationId, input.jobCardId, input.revisionNo, input.scheduledAt],
  );
}

async function seedIncident(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    breachedAt: Date;
    accountableUserId: string | null;
    episodeNo?: number;
    scheduleRevisionNo?: number;
    recoveredAt?: Date | null;
    recoveryActorUserId?: string | null;
  },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_user_id, accountable_role,
        accountable_source, source, recovered_at, recovery_actor_user_id)
     VALUES ($1,$2,'LATE_SUBMISSION',$3,$4,$5,$5,$6,'STAFF','ASSIGNMENT_AT_BREACH',
             'SCANNER',$7,$8)
     RETURNING id`,
    [
      input.organizationId,
      input.jobCardId,
      input.episodeNo ?? 1,
      input.scheduleRevisionNo ?? 1,
      input.breachedAt,
      input.accountableUserId,
      input.recoveredAt ?? null,
      input.recoveryActorUserId ?? null,
    ],
  )).rows[0]!.id;
}

function repositoryFor(pool: Pool) {
  return new PostgresOverdueReminderWorkerRepository(pool);
}

function workerFor(
  pool: Pool,
  options: { now: () => Date; webPushEnabled?: boolean; batchSize?: number } = { now: () => BREACH },
) {
  const published: RealtimeEventRecord[] = [];
  const repository = repositoryFor(pool);
  const worker = createOverdueReminderWorker(repository, POLICY, {
    now: options.now,
    publisher: { publish: (event) => published.push(event) },
    webPushEnabled: options.webPushEnabled ?? false,
    batchSize: options.batchSize ?? 20,
  });
  return { worker, repository, published };
}

async function reminderRows(pool: Pool, organizationId: string, jobCardId: string) {
  return (await pool.query<{
    reminder_kind: string; state: string; episode_no: number; attempt_count: number;
  }>(
    `SELECT reminder_kind, state, episode_no, attempt_count
       FROM job_card_overdue_incident_reminders
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY reminder_kind`,
    [organizationId, jobCardId],
  )).rows;
}

async function realtimeRows(pool: Pool, organizationId: string) {
  return (await pool.query<{ event_type: string; entity_id: string }>(
    `SELECT event_type, entity_id FROM realtime_events
      WHERE organization_id = $1 AND overdue_reminder_id IS NOT NULL
      ORDER BY id`,
    [organizationId],
  )).rows;
}

async function notificationRows(pool: Pool, organizationId: string) {
  return (await pool.query<{ kind: string; recipient_user_id: string }>(
    `SELECT kind, recipient_user_id FROM in_app_notifications
      WHERE organization_id = $1 AND kind IN ('job.submission_reminder', 'job.submission_escalation')
      ORDER BY recipient_user_id`,
    [organizationId],
  )).rows;
}

describe.skipIf(!databaseUrl)('OVR-4 overdue reminder worker', () => {
  it('claims nothing before the staff threshold is reached', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const { worker } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 14 * MINUTE),
      });
      const report = await worker.runOnce();
      expect(report.claimed).toBe(0);
      expect(report.projected).toBe(0);
      expect(await reminderRows(pool, fixture.organizationId, fixture.jobCardId)).toEqual([]);
    });
  });

  it('delivers exactly one staff reminder at +15 and projects realtime + notification', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const { worker, published } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 15 * MINUTE),
      });
      const report = await worker.runOnce();
      expect(report.byKind.STAFF_SUBMISSION_REMINDER).toBe(1);
      expect(report.byKind.MANAGEMENT_ESCALATION).toBe(0);
      expect(report.projected).toBe(1);

      const rows = await reminderRows(pool, fixture.organizationId, fixture.jobCardId);
      expect(rows).toEqual([
        { reminder_kind: 'STAFF_SUBMISSION_REMINDER', state: 'PROJECTED', episode_no: 1, attempt_count: 1 },
      ]);
      expect(await realtimeRows(pool, fixture.organizationId)).toEqual([
        { event_type: 'job.submission_reminder_due', entity_id: fixture.jobCardId },
      ]);
      // The reminder is addressed to the accountable employee, not the manager.
      expect(await notificationRows(pool, fixture.organizationId)).toEqual([
        { kind: 'job.submission_reminder', recipient_user_id: fixture.staffId },
      ]);
      expect(published.map((event) => event.type)).toEqual(['job.submission_reminder_due']);
    });
  });

  it('never delivers the same kind twice across repeated ticks (restart / scanner repeat)', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const { worker } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 20 * MINUTE),
      });
      const first = await worker.runOnce();
      const second = await worker.runOnce();
      expect(first.projected).toBe(1);
      expect(second.claimed).toBe(0);
      expect(second.projected).toBe(0);
      expect(await reminderRows(pool, fixture.organizationId, fixture.jobCardId)).toHaveLength(1);
      expect(await notificationRows(pool, fixture.organizationId)).toHaveLength(1);
    });
  });

  it('escalates to active management at +60 in addition to the staff nudge', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const { worker } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 60 * MINUTE),
      });
      const report = await worker.runOnce();
      expect(report.byKind.STAFF_SUBMISSION_REMINDER).toBe(1);
      expect(report.byKind.MANAGEMENT_ESCALATION).toBe(1);

      const rows = await reminderRows(pool, fixture.organizationId, fixture.jobCardId);
      expect(rows.map((row) => row.reminder_kind)).toEqual([
        'MANAGEMENT_ESCALATION',
        'STAFF_SUBMISSION_REMINDER',
      ]);
      expect(rows.every((row) => row.state === 'PROJECTED')).toBe(true);

      const notifications = await notificationRows(pool, fixture.organizationId);
      expect(notifications.map((row) => `${row.kind}:${row.recipient_user_id}`).sort()).toEqual([
        `job.submission_escalation:${fixture.managerId}`,
        `job.submission_reminder:${fixture.staffId}`,
      ].sort());
      const realtime = await realtimeRows(pool, fixture.organizationId);
      expect(realtime.map((row) => row.event_type).sort()).toEqual([
        'job.submission_escalation_due',
        'job.submission_reminder_due',
      ]);
    });
  });

  it('converges two concurrent instances on a single claim', async () => {
    await withSchema(async (pool) => {
      await seedFixture(pool);
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      const claim = (leaseToken: string) => repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: POLICY.thresholdMinutes('STAFF_SUBMISSION_REMINDER'),
        now,
        leaseToken,
        leaseUntil: new Date(now.getTime() + MINUTE),
        limit: 20,
      });
      const [a, b] = await Promise.all([claim(randomUUID()), claim(randomUUID())]);
      expect(a.length + b.length).toBe(1);
    });
  });

  it('ignores an incident that is already recovered', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $3, recovery_actor_user_id = $4
          WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, fixture.jobCardId, new Date(BREACH.getTime() + 5 * MINUTE), fixture.staffId],
      );
      const { worker } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 60 * MINUTE),
      });
      const report = await worker.runOnce();
      expect(report.claimed).toBe(0);
      expect(await reminderRows(pool, fixture.organizationId, fixture.jobCardId)).toEqual([]);
    });
  });

  it('cancels a claimed reminder when the employee submits before delivery', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      const [claim] = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + MINUTE),
        limit: 1,
      });
      expect(claim).toBeDefined();
      // The employee submits between claim and delivery: the incident recovers.
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $3, recovery_actor_user_id = $4
          WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, fixture.jobCardId, now, fixture.staffId],
      );
      const realtime = await repository.project(claim as OverdueReminderClaim, now, false);
      expect(realtime).toBeNull();
      const rows = await reminderRows(pool, fixture.organizationId, fixture.jobCardId);
      expect(rows).toEqual([
        { reminder_kind: 'STAFF_SUBMISSION_REMINDER', state: 'CANCELLED', episode_no: 1, attempt_count: 1 },
      ]);
      expect(await realtimeRows(pool, fixture.organizationId)).toEqual([]);
      expect(await notificationRows(pool, fixture.organizationId)).toEqual([]);
    });
  });

  it('cancels a claimed reminder when the job leaves the submission phase', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      const [claim] = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + MINUTE),
        limit: 1,
      });
      await pool.query(
        `UPDATE job_cards
            SET status = 'WAITING_APPROVAL', staff_completed_at = $2, staff_completed_by = $3
          WHERE organization_id = $1 AND id = $4`,
        [fixture.organizationId, now, fixture.staffId, fixture.jobCardId],
      );
      const realtime = await repository.project(claim as OverdueReminderClaim, now, false);
      expect(realtime).toBeNull();
      expect(await reminderRows(pool, fixture.organizationId, fixture.jobCardId)).toEqual([
        { reminder_kind: 'STAFF_SUBMISSION_REMINDER', state: 'CANCELLED', episode_no: 1, attempt_count: 1 },
      ]);
    });
  });

  it('fails closed (cancels, no recipient) when accountability is unprovable', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool, { accountable: false });
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      const [claim] = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + MINUTE),
        limit: 1,
      });
      expect(claim).toBeDefined();
      const realtime = await repository.project(claim as OverdueReminderClaim, now, false);
      expect(realtime).toBeNull();
      expect(await reminderRows(pool, fixture.organizationId, fixture.jobCardId)).toEqual([
        { reminder_kind: 'STAFF_SUBMISSION_REMINDER', state: 'CANCELLED', episode_no: 1, attempt_count: 1 },
      ]);
      expect(await notificationRows(pool, fixture.organizationId)).toEqual([]);
    });
  });

  it('collapses a second incident of the same episode to one delivery', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      // A retroactive schedule revision creates a sibling incident for the same
      // submission episode (different revision number, same episode).
      await seedScheduleRevision(pool, {
        organizationId: fixture.organizationId,
        jobCardId: fixture.jobCardId,
        revisionNo: 2,
        scheduledAt: BREACH,
      });
      await seedIncident(pool, {
        organizationId: fixture.organizationId,
        jobCardId: fixture.jobCardId,
        breachedAt: new Date(BREACH.getTime() + MINUTE),
        accountableUserId: fixture.staffId,
        episodeNo: 1,
        scheduleRevisionNo: 2,
      });
      const { worker } = workerFor(pool, {
        now: () => new Date(BREACH.getTime() + 30 * MINUTE),
      });
      const report = await worker.runOnce();
      expect(report.byKind.STAFF_SUBMISSION_REMINDER).toBe(1);
      const rows = await reminderRows(pool, fixture.organizationId, fixture.jobCardId);
      expect(rows).toEqual([
        { reminder_kind: 'STAFF_SUBMISSION_REMINDER', state: 'PROJECTED', episode_no: 1, attempt_count: 1 },
      ]);
    });
  });

  it('reclaims a crashed claim after its lease expires', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      const firstLease = randomUUID();
      const [first] = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now,
        leaseToken: firstLease,
        leaseUntil: new Date(now.getTime() + MINUTE),
        limit: 1,
      });
      expect(first).toBeDefined();
      // The worker that held the lease "crashes": nothing is projected and the
      // lease is allowed to expire.
      const later = new Date(now.getTime() + 5 * MINUTE);
      const reclaimed = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now: later,
        leaseToken: randomUUID(),
        leaseUntil: new Date(later.getTime() + MINUTE),
        limit: 1,
      });
      expect(reclaimed).toHaveLength(1);
      const rows = await reminderRows(pool, fixture.organizationId, fixture.jobCardId);
      expect(rows[0]?.state).toBe('CLAIMED');
      expect(rows[0]?.attempt_count).toBe(2);
    });
  });

  it('does not reclaim a live lease', async () => {
    await withSchema(async (pool) => {
      await seedFixture(pool);
      const repository = repositoryFor(pool);
      const now = new Date(BREACH.getTime() + 15 * MINUTE);
      await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now,
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 10 * MINUTE),
        limit: 1,
      });
      const contended = await repository.claimDue({
        reminderKind: 'STAFF_SUBMISSION_REMINDER',
        thresholdMinutes: 15,
        now: new Date(now.getTime() + MINUTE),
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 11 * MINUTE),
        limit: 1,
      });
      expect(contended).toEqual([]);
    });
  });
});
