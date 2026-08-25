import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const now = new Date('2026-08-25T07:00:00.000Z');

type Fixture = {
  pool: Pool;
  organizationId: string;
  manager: CalendarActor;
  staffId: string;
  staffBId: string;
  repository: PostgresCalendarRepository;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `r4p2_calendar_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
      logger: { info: () => undefined, error: () => undefined },
    });

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('R4P2 Calendar', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'R4P2 Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
      [organizationId, `${randomUUID()}@r4p2.test`],
    )).rows[0]!.id;
    const staffId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'R4P2 Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@r4p2.test`],
    )).rows[0]!.id;
    const staffBId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'R4P2 Staff B', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@r4p2.test`],
    )).rows[0]!.id;

    await run({
      pool,
      organizationId,
      manager: { id: managerId, organizationId, role: 'MANAGER' },
      staffId,
      staffBId,
      repository: new PostgresCalendarRepository(pool, 30, false),
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function input(assignedUserId: string) {
  return {
    clientActionId: randomUUID(),
    assignedUserId,
    title: 'R4P2 lifecycle test',
    description: null,
    startsAt: '2026-08-26T09:00:00.000Z',
    endsAt: '2026-08-26T10:00:00.000Z',
    timezone: 'Europe/Istanbul',
  } as const;
}

function withUserLockAttempt(pool: Pool, targetUserId: string) {
  let attempted!: () => void;
  const attempt = new Promise<void>((resolve) => { attempted = resolve; });
  const originalConnect = pool.connect.bind(pool);
  const wrapClient = (client: any) => {
    const originalQuery = client.query.bind(client);
    client.query = (...qargs: any[]) => {
      const text = typeof qargs[0] === 'string'
        ? qargs[0]
        : qargs[0]?.text;
      const values = Array.isArray(qargs[1]) ? qargs[1] : qargs[0]?.values;
      if (text?.includes('SELECT id, organization_id, role, is_active')
        && text.includes('FOR UPDATE') && values?.[1] === targetUserId) {
        attempted();
      }
      return originalQuery(...qargs);
    };
    return client;
  };
  pool.connect = ((...args: any[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop();
      return originalConnect(...args, (error: Error | null, client: any, release: () => void) => {
        callback(error, client ? wrapClient(client) : client, release);
      });
    }
    return originalConnect(...args).then(wrapClient);
  }) as typeof pool.connect;
  return { waitForAttempt: () => attempt };
}

function withUserLockBarrier(pool: Pool, targetUserId: string) {
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const originalConnect = pool.connect.bind(pool);
  const wrapClient = (client: any) => {
    const originalQuery = client.query.bind(client);
    client.query = (...qargs: any[]) => {
      const text = typeof qargs[0] === 'string'
        ? qargs[0]
        : qargs[0]?.text;
      const values = Array.isArray(qargs[1]) ? qargs[1] : qargs[0]?.values;
      if (text?.includes('SELECT id, organization_id, role, is_active')
        && text.includes('FOR UPDATE') && values?.[1] === targetUserId) {
        return Promise.resolve(originalQuery(...qargs)).then((result) => {
          acquired();
          return released.then(() => result);
        });
      }
      return originalQuery(...qargs);
    };
    return client;
  };
  pool.connect = ((...args: any[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop();
      return originalConnect(...args, (error: Error | null, client: any, releaseClient: () => void) => {
        callback(error, client ? wrapClient(client) : client, releaseClient);
      });
    }
    return originalConnect(...args).then(wrapClient);
  }) as typeof pool.connect;
  return {
    waitForAcquired: () => acquiredPromise,
    release: () => release(),
  };
}

async function bounded<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('R4P2 concurrent flow timed out')), 2_500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!databaseUrl)('R4P2 Calendar Staff lifecycle PostgreSQL contract', () => {
  it('rejects an inactive assignee after the repository lock with no mutation or effects', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
        [organizationId, staffId],
      );

      await expect(repository.createManual(manager, input(staffId), now))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

      const counts = await pool.query<{ events: string; activities: string; reminders: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM calendar_events WHERE organization_id = $1) AS events,
           (SELECT COUNT(*)::text FROM calendar_event_activity_logs WHERE organization_id = $1) AS activities,
           (SELECT COUNT(*)::text FROM calendar_reminders WHERE organization_id = $1) AS reminders`,
        [organizationId],
      );
      expect(counts.rows[0]).toEqual({ events: '0', activities: '0', reminders: '0' });
    });
  });

  it('conceals wrong-role and cross-organization assignment targets', async () => {
    await withFixture(async ({ manager, repository }) => {
      await expect(repository.createManual(manager, input(manager.id), now))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(repository.createManual(manager, input(randomUUID()), now))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });

  it('keeps an inactive assignee readable in historical detail while hiding it from the picker', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      const service = new CalendarService(true, repository, () => now);
      const created = await service.create(manager, input(staffId));

      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
        [organizationId, staffId],
      );

      await expect(service.detail(manager, created.id)).resolves.toMatchObject({
        id: created.id,
        assignedUser: { id: staffId, name: 'R4P2 Staff' },
      });
      const assignees = await service.assignees(manager);
      expect(assignees.items.map((user) => user.id)).not.toContain(staffId);
    });
  });

  it('keeps inactive historical events visible through an assignee-filtered list', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      const service = new CalendarService(true, repository, () => now);
      const created = await service.create(manager, input(staffId));

      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
        [organizationId, staffId],
      );

      const listed = await service.list(manager, {
        from: '2026-08-26T00:00:00.000Z',
        to: '2026-08-27T00:00:00.000Z',
        assignedTo: staffId,
      });
      expect(listed.items.map((item) => item.id)).toContain(created.id);
    });
  });

  it('rejects a stale create when deactivation commits before the authoritative user lock', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      await expect(repository.getAssignableUser(manager, staffId)).resolves.toMatchObject({
        id: staffId,
        isActive: true,
      });

      const deactivationClient = await pool.connect();
      try {
        await deactivationClient.query('BEGIN');
        await deactivationClient.query(
          `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, staffId],
        );
        await deactivationClient.query(
          `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
          [organizationId, staffId],
        );

        const lockAttempt = withUserLockAttempt(pool, staffId);
        const create = repository.createManual(manager, input(staffId), now);
        await lockAttempt.waitForAttempt();
        await deactivationClient.query('COMMIT');
        await expect(create).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      } finally {
        await deactivationClient.query('ROLLBACK').catch(() => undefined);
        deactivationClient.release();
      }

      const counts = await pool.query<{ events: string; activities: string; reminders: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM calendar_events WHERE organization_id = $1) AS events,
           (SELECT COUNT(*)::text FROM calendar_event_activity_logs WHERE organization_id = $1) AS activities,
           (SELECT COUNT(*)::text FROM calendar_reminders WHERE organization_id = $1) AS reminders`,
        [organizationId],
      );
      expect(counts.rows[0]).toEqual({ events: '0', activities: '0', reminders: '0' });
    });
  });

  it('serializes a Calendar-winning create before a competing deactivation', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      const lockBarrier = withUserLockBarrier(pool, staffId);
      const create = repository.createManual(manager, input(staffId), now);
      await lockBarrier.waitForAcquired();

      const deactivationClient = await pool.connect();
      let deactivationLockAttempted!: () => void;
      const deactivationLock = new Promise<void>((resolve) => {
        deactivationLockAttempted = resolve;
      });
      const originalQuery = deactivationClient.query.bind(deactivationClient);
      deactivationClient.query = (...qargs: any[]) => {
        const text = typeof qargs[0] === 'string' ? qargs[0] : qargs[0]?.text;
        if (text?.includes('SELECT id FROM users') && text.includes('FOR UPDATE')) {
          deactivationLockAttempted();
        }
        return originalQuery(...qargs);
      };

      const deactivation = (async () => {
        try {
          await deactivationClient.query('BEGIN');
          const locked = await deactivationClient.query<{ id: string }>(
            `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
            [organizationId, staffId],
          );
          const responsibility = await deactivationClient.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM calendar_events
             WHERE organization_id = $1 AND assigned_user_id = $2`,
            [organizationId, staffId],
          );
          await deactivationClient.query(
            `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
            [organizationId, staffId],
          );
          await deactivationClient.query('COMMIT');
          return { locked: locked.rows[0]?.id, responsibility: responsibility.rows[0]?.total };
        } catch (error) {
          await deactivationClient.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          deactivationClient.release();
        }
      })();
      await deactivationLock;
      lockBarrier.release();

      const [created, deactivated] = await bounded(Promise.allSettled([create, deactivation]));
      expect(created).toMatchObject({ status: 'fulfilled', value: { assignedUser: { id: staffId } } });
      expect(deactivated).toMatchObject({
        status: 'fulfilled',
        value: { locked: staffId, responsibility: '1' },
      });
    });
  });

  it('keeps inactive historical creator and updater identities on a cancelled event', async () => {
    await withFixture(async ({ pool, manager, staffId, repository, organizationId }) => {
      const service = new CalendarService(true, repository, () => now);
      const created = await service.create(manager, input(staffId));
      const updated = await service.patch(manager, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
        title: 'R4P2 historical update',
      });
      const cancelled = await service.cancel(manager, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: updated.version,
        cancelReason: 'R4P2 historical cancellation',
      });
      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
        [organizationId, manager.id],
      );

      await expect(service.detail(manager, cancelled.id)).resolves.toMatchObject({
        id: cancelled.id,
        status: 'CANCELLED',
        createdBy: { id: manager.id, name: 'R4P2 Manager' },
        updatedBy: { id: manager.id, name: 'R4P2 Manager' },
      });
      const cancelledActor = await pool.query<{ cancelled_by: string }>(
        `SELECT cancelled_by FROM calendar_events WHERE organization_id = $1 AND id = $2`,
        [organizationId, cancelled.id],
      );
      expect(cancelledActor.rows[0]?.cancelled_by).toBe(manager.id);
    });
  });

  it('uses user-before-event lock order when patching to a concurrently deactivated Staff', async () => {
    await withFixture(async ({ pool, manager, staffId, staffBId, repository, organizationId }) => {
      const created = await repository.createManual(manager, input(staffBId), now);
      const lockAttempt = withUserLockAttempt(pool, staffId);
      const offboardingClient = await pool.connect();
      await offboardingClient.query('BEGIN');
      await offboardingClient.query(
        `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, staffId],
      );

      const patch = repository.patchManual(manager, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
        assignedUserId: staffId,
        title: 'R4P2 reassignment',
      });
      await lockAttempt.waitForAttempt();

      const offboarding = (async () => {
        try {
          await offboardingClient.query(
            `SELECT id FROM calendar_events WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
            [organizationId, created.id],
          );
          await offboardingClient.query(
            `UPDATE users SET is_active = FALSE WHERE organization_id = $1 AND id = $2`,
            [organizationId, staffId],
          );
          await offboardingClient.query('COMMIT');
        } catch (error) {
          await offboardingClient.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          offboardingClient.release();
        }
      })();

      const [patchResult, offboardingResult] = await bounded(Promise.allSettled([
        patch,
        offboarding,
      ]));
      expect(offboardingResult.status).toBe('fulfilled');
      expect(patchResult).toMatchObject({
        status: 'rejected',
        reason: { code: 'FORBIDDEN', statusCode: 403 },
      });

      const persisted = await pool.query<{ assigned_user_id: string; title: string }>(
        `SELECT assigned_user_id, title FROM calendar_events
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, created.id],
      );
      expect(persisted.rows[0]).toEqual({ assigned_user_id: staffBId, title: 'R4P2 lifecycle test' });

      const effects = await pool.query<{
        activities: string;
        realtime: string;
        notifications: string;
        reminders: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM calendar_event_activity_logs WHERE organization_id = $1) AS activities,
           (SELECT COUNT(*)::text FROM realtime_events WHERE organization_id = $1) AS realtime,
           (SELECT COUNT(*)::text FROM in_app_notifications WHERE organization_id = $1) AS notifications,
           (SELECT COUNT(*)::text FROM calendar_reminders WHERE organization_id = $1) AS reminders`,
        [organizationId],
      );
      expect(effects.rows[0]).toEqual({
        activities: '1',
        realtime: '1',
        notifications: '1',
        reminders: '1',
      });
    });
  });
});
