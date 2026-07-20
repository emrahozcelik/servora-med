import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { mapJobCardActivityToRealtime } from '../src/modules/realtime/event-mapper.js';
import {
  InMemoryRealtimeEventBus,
  type RealtimeEventPublisher,
} from '../src/modules/realtime/event-bus.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import { RealtimeService } from '../src/modules/realtime/service.js';
import type {
  RealtimeEventEnvelope,
  RealtimeEventRecord,
  RealtimeViewer,
} from '../src/modules/realtime/types.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
] as const;

type Fixture = {
  pool: Pool;
  organizationId: string;
  managerUserId: string;
  assignedStaffUserId: string;
  unrelatedStaffUserId: string;
  jobCardId: string;
  jobVersion: number;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `realtime_jobcard_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    for (const migration of MIGRATIONS) {
      const path = fileURLToPath(
        new URL(`../src/db/migrations/${migration}`, import.meta.url),
      );
      await pool.query(await readFile(path, 'utf8'));
    }

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Realtime jobcard') RETURNING id`,
    )).rows[0]!.id;
    const managerUserId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Manager', $2, 'unused-test-hash', 'MANAGER') RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`],
    )).rows[0]!.id;
    const assignedStaffUserId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Staff', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`],
    )).rows[0]!.id;
    const unrelatedStaffUserId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Other staff', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`],
    )).rows[0]!.id;
    const job = (await pool.query<{ id: string; version: number }>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, assigned_to, created_by,
          accepted_at, accepted_by)
       VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'İş kaydı', $2, $2, NOW(), $2)
       RETURNING id, version`,
      [organizationId, assignedStaffUserId],
    )).rows[0]!;

    await run({
      pool,
      organizationId,
      managerUserId,
      assignedStaffUserId,
      unrelatedStaffUserId,
      jobCardId: job.id,
      jobVersion: job.version,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function capturingPublisher() {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = {
    publish(event) {
      published.push(event);
    },
  };
  return { published, publisher };
}

function viewer(
  organizationId: string,
  userId: string,
  role: RealtimeViewer['role'],
): RealtimeViewer {
  return { organizationId, userId, role };
}

function jobCardActor(
  organizationId: string,
  id: string,
  role: JobCardActor['role'],
): JobCardActor {
  return { organizationId, id, role };
}

describe.skipIf(!databaseUrl)('Realtime JobCard integration (PostgreSQL)', () => {
  it('commits activity and realtime event together', async () => {
    await withFixture(async ({ pool, organizationId, assignedStaffUserId, jobCardId, jobVersion }) => {
      const { published, publisher } = capturingPublisher();
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-07-19T14:30:00.000Z'),
        publisher,
      );
      const actor: JobCardActor = { id: assignedStaffUserId, organizationId, role: 'STAFF' };

      await service.start(actor, jobCardId, {
        expectedVersion: jobVersion,
        clientActionId: randomUUID(),
      });

      const activity = await pool.query<{ id: string }>(
        `SELECT id FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_STARTED'`,
        [jobCardId],
      );
      expect(activity.rows).toHaveLength(1);

      const events = await pool.query<{
        id: string; event_type: string; source_activity_id: string; entity_id: string;
      }>(
        `SELECT id, event_type, source_activity_id, entity_id
           FROM realtime_events WHERE entity_id = $1`,
        [jobCardId],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        event_type: 'job.started',
        source_activity_id: activity.rows[0]!.id,
        entity_id: jobCardId,
      });

      expect(published).toHaveLength(1);
      expect(published[0]!.sourceActivityId).toBe(activity.rows[0]!.id);
      expect(published[0]!.id).toBe(BigInt(events.rows[0]!.id));
    });
  });

  it('rolls back both rows when event insertion fails', async () => {
    await withFixture(async ({ pool, organizationId, assignedStaffUserId, jobCardId, jobVersion }) => {
      const repository = new PostgresJobCardRepository(pool);
      const actor: JobCardActor = { id: assignedStaffUserId, organizationId, role: 'STAFF' };

      const attempt = repository.executeCriticalAction(
        {
          organizationId, userId: assignedStaffUserId,
          clientActionId: randomUUID(), operationKey: `JOB_START:${jobCardId}`,
        },
        async (tx) => {
          const job = await tx.getJobForUpdate(organizationId, jobCardId);
          const updated = await tx.transitionWithVersion({
            organizationId, jobCardId, expectedVersion: jobVersion,
            command: 'START', status: 'IN_PROGRESS',
            occurredAt: new Date('2026-07-19T14:30:00.000Z'), actorId: actor.id,
          });
          const activity = await tx.appendActivity({
            organizationId, jobCardId, actorId: actor.id, event: 'JOB_STARTED',
            clientActionId: 'rollback-action',
            oldValue: { status: job!.status, version: job!.version },
            newValue: { status: updated!.status, version: updated!.version },
          });
          const mapped = mapJobCardActivityToRealtime({
            activityId: activity.id, organizationId, jobCardId,
            actorUserId: actor.id, event: 'JOB_STARTED', occurredAt: activity.createdAt,
            beforeAssigneeId: null, afterAssigneeId: assignedStaffUserId,
          });
          const first = await tx.appendRealtimeEvent(mapped!);
          await tx.appendRealtimeEvent(mapped!);
          return { response: null, realtimeEvents: [first] };
        },
      );

      await expect(attempt).rejects.toMatchObject({ code: '23505' });

      const job = await pool.query<{ status: string; version: number }>(
        'SELECT status, version FROM job_cards WHERE id = $1',
        [jobCardId],
      );
      expect(job.rows[0]).toMatchObject({ status: 'ACCEPTED', version: jobVersion });

      const activityCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_activity_logs WHERE job_card_id = $1`,
        [jobCardId],
      );
      expect(activityCount.rows[0]!.count).toBe(0);

      const eventCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM realtime_events WHERE entity_id = $1`,
        [jobCardId],
      );
      expect(eventCount.rows[0]!.count).toBe(0);
    });
  });

  it('does not create a second event on idempotent replay', async () => {
    await withFixture(async ({ pool, organizationId, assignedStaffUserId, jobCardId, jobVersion }) => {
      const { published, publisher } = capturingPublisher();
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-07-19T14:30:00.000Z'),
        publisher,
      );
      const actor: JobCardActor = { id: assignedStaffUserId, organizationId, role: 'STAFF' };
      const clientActionId = randomUUID();

      const first = await service.start(actor, jobCardId, {
        expectedVersion: jobVersion, clientActionId,
      });
      const replay = await service.start(actor, jobCardId, {
        expectedVersion: jobVersion, clientActionId,
      });
      expect(replay).toEqual(first);

      const activityCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_STARTED'`,
        [jobCardId],
      );
      expect(activityCount.rows[0]!.count).toBe(1);

      const eventCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM realtime_events WHERE entity_id = $1`,
        [jobCardId],
      );
      expect(eventCount.rows[0]!.count).toBe(1);

      expect(published).toHaveLength(1);
    });
  });

  it('delivers submission to manager and assignee but not unrelated staff', async () => {
    await withFixture(async ({
      pool, organizationId, managerUserId, assignedStaffUserId,
      unrelatedStaffUserId, jobCardId, jobVersion,
    }) => {
      const bus = new InMemoryRealtimeEventBus();
      const jobCards = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-07-20T10:00:00.000Z'),
        bus,
      );
      const realtimeRepository = new PostgresRealtimeEventRepository(pool);
      const realtime = new RealtimeService(realtimeRepository, bus);
      const assignedStaff = viewer(organizationId, assignedStaffUserId, 'STAFF');
      const assignedStaffActor = jobCardActor(
        organizationId,
        assignedStaffUserId,
        'STAFF',
      );
      const manager = viewer(organizationId, managerUserId, 'MANAGER');
      const unrelatedStaff = viewer(organizationId, unrelatedStaffUserId, 'STAFF');

      await jobCards.start(assignedStaffActor, jobCardId, {
        expectedVersion: jobVersion,
        clientActionId: randomUUID(),
      });

      const managerEvents: RealtimeEventEnvelope[] = [];
      const assignedEvents: RealtimeEventEnvelope[] = [];
      const unrelatedEvents: RealtimeEventEnvelope[] = [];
      const managerSub = await realtime.open(
        manager,
        await realtimeRepository.visibleHighWater(manager),
        { send: async (event) => { managerEvents.push(event); } },
      );
      const assignedSub = await realtime.open(
        assignedStaff,
        await realtimeRepository.visibleHighWater(assignedStaff),
        { send: async (event) => { assignedEvents.push(event); } },
      );
      const unrelatedSub = await realtime.open(
        unrelatedStaff,
        await realtimeRepository.visibleHighWater(unrelatedStaff),
        { send: async (event) => { unrelatedEvents.push(event); } },
      );

      try {
        await jobCards.submitForApproval(assignedStaffActor, jobCardId, {
          expectedVersion: jobVersion + 1,
          clientActionId: randomUUID(),
          note: 'Teslim tamamlandı.',
        });
        await expect.poll(() => managerEvents, {
          interval: 5,
          timeout: 1_000,
        }).toContainEqual(expect.objectContaining({
          type: 'job.submitted_for_approval',
        }));
        await expect.poll(() => assignedEvents, {
          interval: 5,
          timeout: 1_000,
        }).toContainEqual(expect.objectContaining({
          type: 'job.submitted_for_approval',
        }));
        expect(unrelatedEvents).toEqual([]);
      } finally {
        managerSub.close();
        assignedSub.close();
        unrelatedSub.close();
      }
    });
  });

  it('replays a missed visible event exactly once after its cursor', async () => {
    await withFixture(async ({
      pool, organizationId, managerUserId, assignedStaffUserId, jobCardId, jobVersion,
    }) => {
      const bus = new InMemoryRealtimeEventBus();
      const jobCards = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-07-20T10:00:00.000Z'),
        bus,
      );
      const realtimeRepository = new PostgresRealtimeEventRepository(pool);
      const realtime = new RealtimeService(realtimeRepository, bus);
      const assignedStaff = viewer(organizationId, assignedStaffUserId, 'STAFF');
      const assignedStaffActor = jobCardActor(
        organizationId,
        assignedStaffUserId,
        'STAFF',
      );
      const manager = viewer(organizationId, managerUserId, 'MANAGER');

      await jobCards.start(assignedStaffActor, jobCardId, {
        expectedVersion: jobVersion,
        clientActionId: randomUUID(),
      });
      const before = await realtimeRepository.visibleHighWater(manager);

      await jobCards.submitForApproval(assignedStaffActor, jobCardId, {
        expectedVersion: jobVersion + 1,
        clientActionId: randomUUID(),
        note: 'Teslim tamamlandı.',
      });

      const replayed: RealtimeEventEnvelope[] = [];
      const subscription = await realtime.open(manager, before, {
        send: async (event) => { replayed.push(event); },
      });
      try {
        expect(replayed.filter(
          (event) => event.type === 'job.submitted_for_approval',
        )).toHaveLength(1);
      } finally {
        subscription.close();
      }
    });
  });
});
