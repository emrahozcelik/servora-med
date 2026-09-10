import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import type { Pool as PoolType } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { PostgresMessagingTransaction } from '../src/modules/messaging/repository.js';
import { acquireRealtimeOrderingLock } from '../src/modules/realtime/ordering.js';
import {
  PostgresRealtimeEventRepository,
  PostgresRealtimeEventTransaction,
} from '../src/modules/realtime/repository.js';
import { PostgresStaffConfidentialNotesRepository } from '../src/modules/staff-confidential-notes/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(
  new URL('../src/db/migrations', import.meta.url),
);

describe('realtime ordering lock contract', () => {
  it('acquires the canonical organization-scoped transaction lock', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await acquireRealtimeOrderingLock({ query } as never, 'org-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(1, hashtext($1::text))',
      ['org-1'],
    );
  });
});

describe.skipIf(!databaseUrl)('realtime commit-order (B3) PostgreSQL', () => {
  let adminPool: PoolType | null = null;
  let pool: PoolType | null = null;
  const schema = `realtime_commit_order_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  async function makeOrganization(name: string): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      [name],
    )).rows[0]!.id;
  }

  async function makeUser(
    organizationId: string,
    role: 'ADMIN' | 'MANAGER' | 'STAFF',
    name: string,
  ): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
      [organizationId, name, `${randomUUID()}@test.local`, role],
    )).rows[0]!.id;
  }

  async function makeJobCard(
    organizationId: string,
    assigneeId: string,
  ): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
       VALUES ($1, 'GENERAL_TASK', 'B3 iş', $2, $2) RETURNING id`,
      [organizationId, assigneeId],
    )).rows[0]!.id;
  }

  async function insertJobActivity(
    organizationId: string,
    jobCardId: string,
    actorId: string,
  ): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type)
       VALUES ($1, $2, $3, 'JOB_STARTED') RETURNING id`,
      [organizationId, jobCardId, actorId],
    )).rows[0]!.id;
  }

  async function makeConversation(organizationId: string): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO conversations (organization_id, direct_key)
       VALUES ($1, $2) RETURNING id`,
      [organizationId, `b3:${randomUUID()}`],
    )).rows[0]!.id;
  }

  async function insertMessagingActivity(
    organizationId: string,
    conversationId: string,
    actorId: string,
  ): Promise<string> {
    return (await pool!.query<{ id: string }>(
      `INSERT INTO messaging_activity_logs
         (organization_id, conversation_id, actor_user_id, action, client_action_id)
       VALUES ($1, $2, $3, 'MESSAGE_SENT', $4) RETURNING id`,
      [organizationId, conversationId, actorId, randomUUID()],
    )).rows[0]!.id;
  }

  async function lockWaitObserved(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await adminPool!.query<{
        wait_event_type: string | null;
      }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (activity.rows[0]?.wait_event_type === 'Lock') return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  it('serializes same-organization commit order across job-card and messaging producers', async () => {
    const organizationId = await makeOrganization('B3 same-org');
    const actorId = await makeUser(organizationId, 'STAFF', 'B3 Staff');
    const jobCardId = await makeJobCard(organizationId, actorId);
    const jobActivityId = await insertJobActivity(
      organizationId,
      jobCardId,
      actorId,
    );
    const conversationId = await makeConversation(organizationId);
    const messagingActivityId = await insertMessagingActivity(
      organizationId,
      conversationId,
      actorId,
    );

    const holder = await pool!.connect();
    const contender = await pool!.connect();
    let contenderPromise: Promise<bigint> | null = null;
    try {
      const contenderPid = (await contender.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid;
      await holder.query('BEGIN');
      await contender.query('BEGIN');

      const jobTx = new PostgresRealtimeEventTransaction(holder);
      const first = await jobTx.append({
        organizationId,
        sourceActivityId: jobActivityId,
        type: 'job.started',
        entityType: 'job-card',
        entityId: jobCardId,
        actorUserId: actorId,
        audience: { roles: ['ADMIN', 'MANAGER'], userIds: [actorId] },
        resourceKeys: ['job-board'],
        occurredAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      let contenderSettled = false;
      contenderPromise = new PostgresMessagingTransaction(contender)
        .appendRealtimeEvent({
          organizationId,
          messagingActivityId,
          type: 'message.sent',
          entityType: 'conversation',
          entityId: conversationId,
          actorUserId: actorId,
          audienceRoles: ['ADMIN', 'MANAGER'],
          audienceUserIds: [actorId],
          resourceKeys: ['conversations'],
          occurredAt: new Date('2026-09-01T10:00:01.000Z'),
        })
        .finally(() => {
          contenderSettled = true;
        });

      expect(await lockWaitObserved(contenderPid)).toBe(true);
      expect(contenderSettled).toBe(false);

      await holder.query('COMMIT');
      const second = await contenderPromise!;
      await contender.query('COMMIT');

      expect(second).toBeGreaterThan(first.id);

      const repository = new PostgresRealtimeEventRepository(pool!);
      const replay = await repository.replayVisible(
        { organizationId, userId: actorId, role: 'ADMIN' },
        0n,
        10,
      );
      expect(replay.map((event) => event.id)).toEqual([first.id, second]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await contender.query('ROLLBACK').catch(() => undefined);
      holder.release();
      contender.release();
      await contenderPromise?.catch(() => undefined);
    }
  });

  it('does not serialize different organizations', async () => {
    const organizationA = await makeOrganization('B3 org A');
    const organizationB = await makeOrganization('B3 org B');
    const actorA = await makeUser(organizationA, 'STAFF', 'B3 Staff A');
    const actorB = await makeUser(organizationB, 'STAFF', 'B3 Staff B');
    const jobCardA = await makeJobCard(organizationA, actorA);
    const jobActivityA = await insertJobActivity(
      organizationA,
      jobCardA,
      actorA,
    );
    const conversationB = await makeConversation(organizationB);
    const messagingActivityB = await insertMessagingActivity(
      organizationB,
      conversationB,
      actorB,
    );

    const holder = await pool!.connect();
    const contender = await pool!.connect();
    try {
      await holder.query('BEGIN');
      await contender.query('BEGIN');

      const first = await new PostgresRealtimeEventTransaction(holder).append({
        organizationId: organizationA,
        sourceActivityId: jobActivityA,
        type: 'job.started',
        entityType: 'job-card',
        entityId: jobCardA,
        actorUserId: actorA,
        audience: { roles: ['ADMIN', 'MANAGER'], userIds: [actorA] },
        resourceKeys: ['job-board'],
        occurredAt: new Date('2026-09-01T11:00:00.000Z'),
      });

      const contenderPromise = new PostgresMessagingTransaction(contender)
        .appendRealtimeEvent({
          organizationId: organizationB,
          messagingActivityId: messagingActivityB,
          type: 'message.sent',
          entityType: 'conversation',
          entityId: conversationB,
          actorUserId: actorB,
          audienceRoles: ['ADMIN', 'MANAGER'],
          audienceUserIds: [actorB],
          resourceKeys: ['conversations'],
          occurredAt: new Date('2026-09-01T11:00:01.000Z'),
        });
      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), 5000);
      });
      const outcome = await Promise.race([
        contenderPromise.then(() => 'completed'),
        timeout,
      ]);
      expect(outcome).toBe('completed');

      await holder.query('COMMIT');
      await contender.query('COMMIT');

      const repository = new PostgresRealtimeEventRepository(pool!);
      const replayA = await repository.replayVisible(
        { organizationId: organizationA, userId: actorA, role: 'ADMIN' },
        0n,
        10,
      );
      expect(replayA.map((event) => event.id)).toEqual([first.id]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await contender.query('ROLLBACK').catch(() => undefined);
      holder.release();
      contender.release();
    }
  });

  it('tolerates a rolled-back producer without corrupting cursor progression', async () => {
    const organizationId = await makeOrganization('B3 rollback');
    const actorId = await makeUser(organizationId, 'STAFF', 'B3 Staff');
    const jobCardId = await makeJobCard(organizationId, actorId);
    const rolledBackActivityId = await insertJobActivity(
      organizationId,
      jobCardId,
      actorId,
    );
    const committedActivityId = await insertJobActivity(
      organizationId,
      jobCardId,
      actorId,
    );

    const rolledBack = await pool!.connect();
    try {
      await rolledBack.query('BEGIN');
      const discarded = await new PostgresRealtimeEventTransaction(
        rolledBack,
      ).append({
        organizationId,
        sourceActivityId: rolledBackActivityId,
        type: 'job.started',
        entityType: 'job-card',
        entityId: jobCardId,
        actorUserId: actorId,
        audience: { roles: ['ADMIN', 'MANAGER'], userIds: [actorId] },
        resourceKeys: ['job-board'],
        occurredAt: new Date('2026-09-01T12:00:00.000Z'),
      });
      await rolledBack.query('ROLLBACK');

      const committed = await pool!.connect();
      try {
        await committed.query('BEGIN');
        const kept = await new PostgresRealtimeEventTransaction(committed).append({
          organizationId,
          sourceActivityId: committedActivityId,
          type: 'job.started',
          entityType: 'job-card',
          entityId: jobCardId,
          actorUserId: actorId,
          audience: { roles: ['ADMIN', 'MANAGER'], userIds: [actorId] },
          resourceKeys: ['job-board'],
          occurredAt: new Date('2026-09-01T12:00:01.000Z'),
        });
        await committed.query('COMMIT');

        expect(kept.id).toBeGreaterThan(discarded.id);

        const repository = new PostgresRealtimeEventRepository(pool!);
        const replay = await repository.replayVisible(
          { organizationId, userId: actorId, role: 'ADMIN' },
          0n,
          10,
        );
        expect(replay.map((event) => event.id)).toEqual([kept.id]);
        const replayAfter = await repository.replayVisible(
          { organizationId, userId: actorId, role: 'ADMIN' },
          kept.id,
          10,
        );
        expect(replayAfter).toEqual([]);
      } finally {
        await committed.query('ROLLBACK').catch(() => undefined);
        committed.release();
      }
    } finally {
      await rolledBack.query('ROLLBACK').catch(() => undefined);
      rolledBack.release();
    }
  });

  it('replays every durable producer in cursor order', async () => {
    const organizationId = await makeOrganization('B3 replay');
    const managerId = await makeUser(organizationId, 'MANAGER', 'B3 Manager');
    const staffId = await makeUser(organizationId, 'STAFF', 'B3 Staff');
    await pool!.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Satış Temsilcisi')`,
      [organizationId, staffId],
    );
    const jobCardId = await makeJobCard(organizationId, staffId);
    const jobActivityId = await insertJobActivity(
      organizationId,
      jobCardId,
      staffId,
    );
    const conversationId = await makeConversation(organizationId);
    const messagingActivityId = await insertMessagingActivity(
      organizationId,
      conversationId,
      managerId,
    );

    const jobClient = await pool!.connect();
    let jobEventId: bigint;
    try {
      await jobClient.query('BEGIN');
      jobEventId = (
        await new PostgresRealtimeEventTransaction(jobClient).append({
          organizationId,
          sourceActivityId: jobActivityId,
          type: 'job.started',
          entityType: 'job-card',
          entityId: jobCardId,
          actorUserId: staffId,
          audience: { roles: ['ADMIN', 'MANAGER'], userIds: [staffId] },
          resourceKeys: ['job-board'],
          occurredAt: new Date('2026-09-01T13:00:00.000Z'),
        })
      ).id;
      await jobClient.query('COMMIT');
    } finally {
      await jobClient.query('ROLLBACK').catch(() => undefined);
      jobClient.release();
    }

    const messagingClient = await pool!.connect();
    let messagingEventId: bigint;
    try {
      await messagingClient.query('BEGIN');
      messagingEventId = await new PostgresMessagingTransaction(
        messagingClient,
      ).appendRealtimeEvent({
        organizationId,
        messagingActivityId,
        type: 'message.sent',
        entityType: 'conversation',
        entityId: conversationId,
        actorUserId: managerId,
        audienceRoles: ['ADMIN', 'MANAGER'],
        audienceUserIds: [managerId, staffId],
        resourceKeys: ['conversations'],
        occurredAt: new Date('2026-09-01T13:00:01.000Z'),
      });
      await messagingClient.query('COMMIT');
    } finally {
      await messagingClient.query('ROLLBACK').catch(() => undefined);
      messagingClient.release();
    }

    const notesRepository = new PostgresStaffConfidentialNotesRepository(pool!);
    const noteId = randomUUID();
    await notesRepository.execute(async (tx) => {
      await tx.createNote({
        id: noteId,
        organizationId,
        staffUserId: staffId,
        authorUserId: managerId,
        body: 'B3 gizli not',
      });
      await tx.appendRealtimeEvent({
        organizationId,
        type: 'confidential-note.created',
        entityType: 'confidential-note',
        entityId: noteId,
        actorUserId: managerId,
        audience: { roles: ['ADMIN', 'MANAGER'], userIds: [] },
        resourceKeys: [`staff-confidential-notes:${staffId}`],
        occurredAt: new Date('2026-09-01T13:00:02.000Z'),
      });
    });

    const calendarRepository = new PostgresCalendarRepository(pool!, 30, false);
    await calendarRepository.createManual(
      { id: managerId, organizationId, role: 'MANAGER' },
      {
        clientActionId: randomUUID(),
        assignedUserId: staffId,
        title: 'B3 takvim',
        description: null,
        startsAt: '2026-09-10T10:00:00.000Z',
        endsAt: '2026-09-10T11:00:00.000Z',
        timezone: 'Europe/Istanbul',
      },
      new Date('2026-09-01T13:00:03.000Z'),
    );

    const repository = new PostgresRealtimeEventRepository(pool!);
    const viewer = {
      organizationId,
      userId: managerId,
      role: 'MANAGER' as const,
    };
    const replay = await repository.replayVisible(viewer, 0n, 10);
    expect(replay).toHaveLength(4);
    const ids = replay.map((event) => event.id);
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
    expect(ids).toContain(jobEventId);
    expect(ids).toContain(messagingEventId);

    const tail = await repository.replayVisible(viewer, ids[0]!, 10);
    expect(tail.map((event) => event.id)).toEqual(ids.slice(1));
    expect(
      await repository.visibleHighWater(viewer),
    ).toBe(ids[ids.length - 1]);
  });
});
