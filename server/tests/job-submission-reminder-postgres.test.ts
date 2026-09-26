import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const BREACH = new Date('2026-08-03T07:30:00.000Z');

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr4m_${randomUUID().replaceAll('-', '')}`;
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

function buildService(pool: Pool, clock: { now: Date }, published: RealtimeEventRecord[]): JobCardService {
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

type Fixture = {
  organizationId: string;
  otherOrganizationId: string;
  managerId: string;
  staffId: string;
  foreignManagerId: string;
  jobCardId: string;
};

async function seedFixture(
  pool: Pool,
  options: { accountable?: boolean; jobStatus?: 'IN_PROGRESS' | 'WAITING_APPROVAL'; staffActive?: boolean } = {},
): Promise<Fixture> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ('OVR4 Reminder Org', 'Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
  const otherOrganizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ('OVR4 Other Org', 'Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
  const insertUser = async (orgId: string, role: 'MANAGER' | 'STAFF', active = true) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'h', $4, $5) RETURNING id`,
      [orgId, `${role}-${randomUUID()}`, `${randomUUID()}@test.local`, role, active],
    )).rows[0]!.id;
  const managerId = await insertUser(organizationId, 'MANAGER');
  const staffId = await insertUser(organizationId, 'STAFF', options.staffActive ?? true);
  const foreignManagerId = await insertUser(otherOrganizationId, 'MANAGER');

  const status = options.jobStatus ?? 'IN_PROGRESS';
  const completedAt = status === 'WAITING_APPROVAL' ? BREACH : null;
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, title, assigned_to, created_by, status, started_at, staff_completed_at, staff_completed_by)
     VALUES ($1, 'GENERAL_TASK', 'Onaya gönderilmeyen iş', $2, $2, $3, $4, $5, $6)
     RETURNING id`,
    [organizationId, staffId, status, BREACH, completedAt, completedAt === null ? null : staffId],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, organization_timezone, source)
     VALUES ($1,$2,1,$3,'Europe/Istanbul','BASELINE')`,
    [organizationId, jobCardId, BREACH],
  );
  await pool.query(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_user_id, accountable_role,
        accountable_source, source)
     VALUES ($1,$2,'LATE_SUBMISSION',1,1,$3,$3,$4,'STAFF','ASSIGNMENT_AT_BREACH','SCANNER')`,
    [organizationId, jobCardId, BREACH, options.accountable === false ? null : staffId],
  );
  return { organizationId, otherOrganizationId, managerId, staffId, foreignManagerId, jobCardId };
}

function actor(organizationId: string, id: string, role: 'MANAGER' | 'STAFF'): JobCardActor {
  return { id, organizationId, role } as JobCardActor;
}

async function reminderFacts(pool: Pool, organizationId: string, jobCardId: string) {
  return (await pool.query<{
    actor_user_id: string; target_user_id: string; sent_at: Date; episode_no: number; client_action_id: string;
  }>(
    `SELECT actor_user_id, target_user_id, sent_at, episode_no, client_action_id
       FROM job_card_submission_reminders
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at, id`,
    [organizationId, jobCardId],
  )).rows;
}

describe.skipIf(!databaseUrl)('OVR-4 manual submission reminder', () => {
  it('rejects a STAFF actor with 403 before any lookup', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const published: RealtimeEventRecord[] = [];
      const clock = { now: new Date('2026-08-03T09:00:00.000Z') };
      const service = buildService(pool, clock, published);
      await expect(service.remindSubmission(
        actor(fixture.organizationId, fixture.staffId, 'STAFF'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      expect(await reminderFacts(pool, fixture.organizationId, fixture.jobCardId)).toEqual([]);
    });
  });

  it('records one immutable fact, an audit activity, a realtime event and a staff notification', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const published: RealtimeEventRecord[] = [];
      const sentAt = new Date('2026-08-03T09:00:00.000Z');
      const service = buildService(pool, { now: sentAt }, published);

      const receipt = await service.remindSubmission(
        actor(fixture.organizationId, fixture.managerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      );
      expect(receipt).toMatchObject({
        jobCardId: fixture.jobCardId,
        targetUserId: fixture.staffId,
        sentAt: sentAt.toISOString(),
      });
      expect(receipt.reminderId).toEqual(expect.any(String));
      expect(receipt.incidentId).toEqual(expect.any(String));

      const facts = await reminderFacts(pool, fixture.organizationId, fixture.jobCardId);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        actor_user_id: fixture.managerId,
        target_user_id: fixture.staffId,
        episode_no: 1,
      });
      expect(facts[0]!.sent_at.toISOString()).toBe(sentAt.toISOString());

      const activity = await pool.query<{ event_type: string; actor_id: string }>(
        `SELECT event_type, actor_id FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2 AND event_type = 'JOB_SUBMISSION_REMINDER_SENT'`,
        [fixture.organizationId, fixture.jobCardId],
      );
      expect(activity.rows).toEqual([
        { event_type: 'JOB_SUBMISSION_REMINDER_SENT', actor_id: fixture.managerId },
      ]);

      const notifications = await pool.query<{ kind: string; recipient_user_id: string }>(
        `SELECT kind, recipient_user_id FROM in_app_notifications
          WHERE organization_id = $1 AND kind = 'job.submission_reminder'`,
        [fixture.organizationId],
      );
      expect(notifications.rows).toEqual([
        { kind: 'job.submission_reminder', recipient_user_id: fixture.staffId },
      ]);
      expect(published.some((event) => event.entityId === fixture.jobCardId)).toBe(true);
    });
  });

  it('deduplicates a double-click with the same clientActionId', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const published: RealtimeEventRecord[] = [];
      const clock = { now: new Date('2026-08-03T09:00:00.000Z') };
      const service = buildService(pool, clock, published);
      const manager = actor(fixture.organizationId, fixture.managerId, 'MANAGER');
      const clientActionId = randomUUID();

      const first = await service.remindSubmission(manager, fixture.jobCardId, { clientActionId });
      const second = await service.remindSubmission(manager, fixture.jobCardId, { clientActionId });
      expect(second).toEqual(first);
      expect(await reminderFacts(pool, fixture.organizationId, fixture.jobCardId)).toHaveLength(1);
      // A replayed action publishes no second realtime event.
      const reminderEvents = published.filter((event) => event.entityId === fixture.jobCardId);
      expect(reminderEvents).toHaveLength(1);
    });
  });

  it('appends a second fact for a genuinely new clientActionId', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const published: RealtimeEventRecord[] = [];
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, published);
      const manager = actor(fixture.organizationId, fixture.managerId, 'MANAGER');
      await service.remindSubmission(manager, fixture.jobCardId, { clientActionId: randomUUID() });
      await service.remindSubmission(manager, fixture.jobCardId, { clientActionId: randomUUID() });
      expect(await reminderFacts(pool, fixture.organizationId, fixture.jobCardId)).toHaveLength(2);
    });
  });

  it('fails closed on a recovered delay (no open incident)', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $3, recovery_actor_user_id = $4
          WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, fixture.jobCardId, new Date('2026-08-03T08:00:00.000Z'), fixture.staffId],
      );
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, []);
      await expect(service.remindSubmission(
        actor(fixture.organizationId, fixture.managerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ code: 'NO_OPEN_SUBMISSION_DELAY', statusCode: 409 });
      expect(await reminderFacts(pool, fixture.organizationId, fixture.jobCardId)).toEqual([]);
    });
  });

  it('fails closed on a job that left the submission phase', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool, { jobStatus: 'WAITING_APPROVAL' });
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, []);
      await expect(service.remindSubmission(
        actor(fixture.organizationId, fixture.managerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ code: 'NO_OPEN_SUBMISSION_DELAY', statusCode: 409 });
    });
  });

  it('refuses a reminder when accountability is unprovable', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool, { accountable: false });
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, []);
      await expect(service.remindSubmission(
        actor(fixture.organizationId, fixture.managerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ code: 'SUBMISSION_DELAY_NOT_ATTRIBUTABLE', statusCode: 409 });
    });
  });

  it('refuses a reminder when the accountable staff is no longer active', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool, { staffActive: false });
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, []);
      await expect(service.remindSubmission(
        actor(fixture.organizationId, fixture.managerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ code: 'SUBMISSION_REMINDER_TARGET_UNAVAILABLE', statusCode: 409 });
    });
  });

  it('conceals a cross-tenant job from a foreign manager (404, no fact)', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const service = buildService(pool, { now: new Date('2026-08-03T09:00:00.000Z') }, []);
      await expect(service.remindSubmission(
        actor(fixture.otherOrganizationId, fixture.foreignManagerId, 'MANAGER'),
        fixture.jobCardId,
        { clientActionId: randomUUID() },
      )).rejects.toMatchObject({ statusCode: 404 });
      expect(await reminderFacts(pool, fixture.organizationId, fixture.jobCardId)).toEqual([]);
    });
  });

  it('measures postReminderDelay from the immutable sent_at and total delay from the breach', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const sentAt = new Date('2026-08-03T09:00:00.000Z');
      const recoveredAt = new Date('2026-08-03T09:30:00.000Z');
      const service = buildService(pool, { now: sentAt }, []);
      const manager = actor(fixture.organizationId, fixture.managerId, 'MANAGER');
      await service.remindSubmission(manager, fixture.jobCardId, { clientActionId: randomUUID() });

      // The employee submits: the lifecycle recovers the incident.
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $3, recovery_actor_user_id = $4
          WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, fixture.jobCardId, recoveredAt, fixture.staffId],
      );

      const page = await service.listOverdueIncidents(manager, fixture.jobCardId, { limit: 25, offset: 0 });
      const item = page.items.find((row) => row.delayType === 'LATE_SUBMISSION')!;
      // recoveredAt - breachedAt = 2h; recoveredAt - sentAt = 30m.
      expect(item.totalDelaySeconds).toBe(7200);
      expect(item.postReminderDelaySeconds).toBe(1800);
      expect(item.managerReminder).toMatchObject({
        sentAt: sentAt.toISOString(),
        actor: { id: fixture.managerId },
        target: { id: fixture.staffId },
      });
    });
  });

  it('leaves postReminderDelay null when no manual reminder ever existed', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const service = buildService(pool, { now: new Date('2026-08-03T09:30:00.000Z') }, []);
      const manager = actor(fixture.organizationId, fixture.managerId, 'MANAGER');
      await pool.query(
        `UPDATE job_card_overdue_incidents
            SET recovered_at = $3, recovery_actor_user_id = $4
          WHERE organization_id = $1 AND job_card_id = $2`,
        [fixture.organizationId, fixture.jobCardId, new Date('2026-08-03T09:30:00.000Z'), fixture.staffId],
      );
      const page = await service.listOverdueIncidents(manager, fixture.jobCardId, { limit: 25, offset: 0 });
      const item = page.items.find((row) => row.delayType === 'LATE_SUBMISSION')!;
      expect(item.totalDelaySeconds).toBe(7200);
      expect(item.managerReminder).toBeNull();
      expect(item.postReminderDelaySeconds).toBeNull();
    });
  });

  it('exposes the current delay signal with server-computed elapsed time', async () => {
    await withSchema(async (pool) => {
      const fixture = await seedFixture(pool);
      const service = buildService(pool, { now: new Date('2026-08-03T09:30:00.000Z') }, []);
      const signal = await service.getSubmissionDelay(
        actor(fixture.organizationId, fixture.staffId, 'STAFF'),
        fixture.jobCardId,
      );
      expect(signal.open).toMatchObject({
        delayType: 'LATE_SUBMISSION',
        episodeNo: 1,
        deadlineAt: BREACH.toISOString(),
        breachedAt: BREACH.toISOString(),
        elapsedSeconds: 7200,
        accountableStaff: { id: fixture.staffId },
      });
    });
  });
});
