import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  manualEventCancelRequestHash,
  manualEventCreateRequestHash,
  manualEventPatchRequestHash,
} from '../src/modules/calendar/request-hash.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const now = new Date('2026-09-09T07:00:00.000Z');

type Fixture = {
  pool: Pool;
  organizationId: string;
  manager: CalendarActor;
  staffId: string;
  staffBId: string;
  service: CalendarService;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `b2cal_${randomUUID().replaceAll('-', '')}`;
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
       VALUES ('B2CAL Calendar', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2CAL Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
      [organizationId, `${randomUUID()}@b2cal.test`],
    )).rows[0]!.id;
    const staffId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2CAL Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@b2cal.test`],
    )).rows[0]!.id;
    const staffBId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2CAL Staff B', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@b2cal.test`],
    )).rows[0]!.id;

    const repository = new PostgresCalendarRepository(pool, 30, false);
    await run({
      pool,
      organizationId,
      manager: { id: managerId, organizationId, role: 'MANAGER' },
      staffId,
      staffBId,
      service: new CalendarService(true, repository, () => now),
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function createInput(assignedUserId: string, startsAt: string, title = 'B2CAL event') {
  return {
    clientActionId: randomUUID(),
    assignedUserId,
    title,
    description: null,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Istanbul',
  } as const;
}

type Snapshot = {
  events: string;
  activities: string;
  realtime: string;
  notifications: string;
  reminders: string;
};

async function snapshot(pool: Pool, organizationId: string): Promise<Snapshot> {
  const result = await pool.query<Snapshot>(
    `SELECT
       (SELECT COUNT(*)::text FROM calendar_events WHERE organization_id = $1) AS events,
       (SELECT COUNT(*)::text FROM calendar_event_activity_logs WHERE organization_id = $1) AS activities,
       (SELECT COUNT(*)::text FROM realtime_events WHERE organization_id = $1) AS realtime,
       (SELECT COUNT(*)::text FROM in_app_notifications WHERE organization_id = $1) AS notifications,
       (SELECT COUNT(*)::text FROM calendar_reminders WHERE organization_id = $1) AS reminders`,
    [organizationId],
  );
  return result.rows[0]!;
}

async function storedHashes(pool: Pool, organizationId: string) {
  const result = await pool.query<{ request_hash: string | null }>(
    `SELECT request_hash FROM calendar_event_activity_logs WHERE organization_id = $1`,
    [organizationId],
  );
  return result.rows.map((row) => row.request_hash);
}

describe.skipIf(!databaseUrl)('B2-CAL calendar manual-event request identity', () => {
  it('replays an exact CREATE and rejects the same key with changed title, time, or assignee', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, staffBId, service }) => {
      const created = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T09:00:00.000Z', 'B2CAL first'),
        clientActionId: 'b2cal-create-exact',
      });
      const afterCreate = await snapshot(pool, organizationId);

      const replayed = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T09:00:00.000Z', 'B2CAL first'),
        clientActionId: 'b2cal-create-exact',
      });
      expect(replayed.id).toBe(created.id);
      expect(replayed.version).toBe(created.version);
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);

      await expect(service.create(manager, {
        ...createInput(staffId, '2026-09-10T09:00:00.000Z', 'B2CAL changed title'),
        clientActionId: 'b2cal-create-exact',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);

      const timed = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T13:00:00.000Z', 'B2CAL timed'),
        clientActionId: 'b2cal-create-timed',
      });
      const afterTimed = await snapshot(pool, organizationId);
      await expect(service.create(manager, {
        ...createInput(staffId, '2026-09-10T15:00:00.000Z', 'B2CAL timed'),
        clientActionId: 'b2cal-create-timed',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterTimed);
      expect(timed.title).toBe('B2CAL timed');

      const assigned = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T16:00:00.000Z', 'B2CAL assigned'),
        clientActionId: 'b2cal-create-assigned',
      });
      const afterAssigned = await snapshot(pool, organizationId);
      await expect(service.create(manager, {
        ...createInput(staffBId, '2026-09-10T16:00:00.000Z', 'B2CAL assigned'),
        clientActionId: 'b2cal-create-assigned',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterAssigned);
      expect(assigned.assignedUser.id).toBe(staffId);

      for (const hash of await storedHashes(pool, organizationId)) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('replays an exact PATCH and rejects the same key with changed target, version, or payload', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const first = await service.create(
        manager, createInput(staffId, '2026-09-10T17:00:00.000Z', 'B2CAL patch target'),
      );
      const second = await service.create(
        manager, createInput(staffId, '2026-09-10T18:00:00.000Z', 'B2CAL other target'),
      );

      const patched = await service.patch(manager, first.id, {
        clientActionId: 'b2cal-patch-exact',
        expectedVersion: first.version,
        title: 'B2CAL patched',
      });
      expect(patched.version).toBe(first.version + 1);
      const afterPatch = await snapshot(pool, organizationId);

      const replayed = await service.patch(manager, first.id, {
        clientActionId: 'b2cal-patch-exact',
        expectedVersion: first.version,
        title: 'B2CAL patched',
      });
      expect(replayed.id).toBe(first.id);
      expect(replayed.version).toBe(patched.version);
      expect(await snapshot(pool, organizationId)).toEqual(afterPatch);

      await expect(service.patch(manager, second.id, {
        clientActionId: 'b2cal-patch-exact',
        expectedVersion: second.version,
        title: 'B2CAL patched',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      await expect(service.patch(manager, first.id, {
        clientActionId: 'b2cal-patch-exact',
        expectedVersion: patched.version,
        title: 'B2CAL patched',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      await expect(service.patch(manager, first.id, {
        clientActionId: 'b2cal-patch-exact',
        expectedVersion: first.version,
        title: 'B2CAL different payload',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      expect(await snapshot(pool, organizationId)).toEqual(afterPatch);
      const persisted = await pool.query<{ title: string; version: number }>(
        `SELECT title, version FROM calendar_events WHERE organization_id = $1 AND id = $2`,
        [organizationId, first.id],
      );
      expect(persisted.rows[0]).toEqual({ title: 'B2CAL patched', version: patched.version });
      const untouched = await pool.query<{ title: string; version: number }>(
        `SELECT title, version FROM calendar_events WHERE organization_id = $1 AND id = $2`,
        [organizationId, second.id],
      );
      expect(untouched.rows[0]).toEqual({ title: 'B2CAL other target', version: second.version });
    });
  });

  it('treats PATCH field presence as identity and never hashes duration-derived state', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const target = await service.create(
        manager, createInput(staffId, '2026-09-10T19:00:00.000Z', 'B2CAL presence'),
      );
      const shifted = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T20:00:00.000Z', 'B2CAL shift'),
        endsAt: '2026-09-10T21:00:00.000Z',
      });

      const patched = await service.patch(manager, target.id, {
        clientActionId: 'b2cal-presence',
        expectedVersion: target.version,
        title: 'B2CAL presence patched',
      });
      const afterPatch = await snapshot(pool, organizationId);

      await expect(service.patch(manager, target.id, {
        clientActionId: 'b2cal-presence',
        expectedVersion: target.version,
        title: 'B2CAL presence patched',
        description: null,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterPatch);

      const explicitNull = await service.patch(manager, target.id, {
        clientActionId: 'b2cal-presence-null',
        expectedVersion: patched.version,
        title: 'B2CAL explicit null',
        description: null,
      });
      const replayedNull = await service.patch(manager, target.id, {
        clientActionId: 'b2cal-presence-null',
        expectedVersion: patched.version,
        title: 'B2CAL explicit null',
        description: null,
      });
      expect(replayedNull.id).toBe(target.id);
      expect(replayedNull.version).toBe(explicitNull.version);

      const moved = await service.patch(manager, shifted.id, {
        clientActionId: 'b2cal-shift',
        expectedVersion: shifted.version,
        startsAt: '2026-09-11T09:00:00.000Z',
      });
      expect(moved.startsAt).toBe('2026-09-11T09:00:00.000Z');
      expect(moved.endsAt).toBe('2026-09-11T10:00:00.000Z');
      const afterMove = await snapshot(pool, organizationId);

      await expect(service.patch(manager, shifted.id, {
        clientActionId: 'b2cal-shift',
        expectedVersion: shifted.version,
        startsAt: '2026-09-11T09:00:00.000Z',
        endsAt: '2026-09-11T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterMove);
    });
  });

  it('replays an exact CANCEL and rejects the same key with changed target, version, or reason', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const first = await service.create(
        manager, createInput(staffId, '2026-09-10T21:00:00.000Z', 'B2CAL cancel target'),
      );
      const other = await service.create(
        manager, createInput(staffId, '2026-09-10T22:00:00.000Z', 'B2CAL cancel other'),
      );

      const cancelled = await service.cancel(manager, first.id, {
        clientActionId: 'b2cal-cancel-exact',
        expectedVersion: first.version,
        cancelReason: 'B2CAL reason',
      });
      expect(cancelled.status).toBe('CANCELLED');
      const afterCancel = await snapshot(pool, organizationId);

      const replayed = await service.cancel(manager, first.id, {
        clientActionId: 'b2cal-cancel-exact',
        expectedVersion: first.version,
        cancelReason: 'B2CAL reason',
      });
      expect(replayed.id).toBe(first.id);
      expect(replayed.version).toBe(cancelled.version);
      expect(await snapshot(pool, organizationId)).toEqual(afterCancel);

      await expect(service.cancel(manager, other.id, {
        clientActionId: 'b2cal-cancel-exact',
        expectedVersion: other.version,
        cancelReason: 'B2CAL reason',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      await expect(service.cancel(manager, first.id, {
        clientActionId: 'b2cal-cancel-exact',
        expectedVersion: first.version,
        cancelReason: 'B2CAL different reason',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      await expect(service.cancel(manager, first.id, {
        clientActionId: 'b2cal-cancel-exact',
        expectedVersion: cancelled.version,
        cancelReason: 'B2CAL reason',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      expect(await snapshot(pool, organizationId)).toEqual(afterCancel);
      const persisted = await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM calendar_events WHERE organization_id = $1 AND id = $2`,
        [organizationId, other.id],
      );
      expect(persisted.rows[0]).toEqual({ status: 'ACTIVE', version: other.version });
    });
  });

  it('fails closed on legacy rows with a NULL request hash', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const event = await service.create(
        manager, createInput(staffId, '2026-09-11T11:00:00.000Z', 'B2CAL legacy'),
      );
      await pool.query(
        `INSERT INTO calendar_event_activity_logs
          (organization_id, calendar_event_id, actor_user_id, action,
           changed_fields, reason, client_action_id, request_hash, created_at)
         VALUES ($1, $2, $3, 'CREATED', ARRAY['title'], NULL, 'b2cal-legacy-create', NULL, $4),
                ($1, $2, $3, 'UPDATED', ARRAY['title'], NULL, 'b2cal-legacy-patch', NULL, $4)`,
        [organizationId, event.id, manager.id, now],
      );
      const afterLegacy = await snapshot(pool, organizationId);

      await expect(service.create(manager, {
        ...createInput(staffId, '2026-09-11T12:00:00.000Z', 'B2CAL legacy attempt'),
        clientActionId: 'b2cal-legacy-create',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      await expect(service.patch(manager, event.id, {
        clientActionId: 'b2cal-legacy-patch',
        expectedVersion: event.version,
        title: 'B2CAL legacy patch attempt',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      expect(await snapshot(pool, organizationId)).toEqual(afterLegacy);
    });
  });

  it('keeps the idempotency namespace per action and stores verifiable request hashes', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const created = await service.create(manager, {
        ...createInput(staffId, '2026-09-10T09:00:00.000Z', 'B2CAL namespaced'),
        clientActionId: 'b2cal-shared-key',
      });
      const patched = await service.patch(manager, created.id, {
        clientActionId: 'b2cal-shared-key',
        expectedVersion: created.version,
        title: 'B2CAL namespaced patched',
      });
      expect(patched.version).toBe(created.version + 1);

      const hashes = await pool.query<{ action: string; request_hash: string | null }>(
        `SELECT action, request_hash FROM calendar_event_activity_logs
          WHERE organization_id = $1 AND client_action_id = 'b2cal-shared-key'
          ORDER BY created_at ASC, action ASC`,
        [organizationId],
      );
      expect(hashes.rows).toHaveLength(2);
      const [first, second] = hashes.rows;
      expect(first!.request_hash).toBe(
        manualEventCreateRequestHash({
          clientActionId: 'b2cal-shared-key',
          assignedUserId: staffId,
          title: 'B2CAL namespaced',
          description: null,
          startsAt: '2026-09-10T09:00:00.000Z',
          endsAt: '2026-09-10T10:00:00.000Z',
          timezone: 'Europe/Istanbul',
        }),
      );
      expect(second!.request_hash).toBe(
        manualEventPatchRequestHash(created.id, {
          clientActionId: 'b2cal-shared-key',
          expectedVersion: created.version,
          title: 'B2CAL namespaced patched',
        }),
      );

      const input = createInput(staffId, '2026-09-10T11:00:00.000Z', 'B2CAL cancel hash');
      const cancellable = await service.create(manager, input);
      const cancelled = await service.cancel(manager, cancellable.id, {
        clientActionId: 'b2cal-cancel-hash',
        expectedVersion: cancellable.version,
        cancelReason: 'B2CAL cancel reason',
      });
      expect(cancelled.status).toBe('CANCELLED');
      const cancelHash = await pool.query<{ request_hash: string | null }>(
        `SELECT request_hash FROM calendar_event_activity_logs
          WHERE organization_id = $1 AND client_action_id = 'b2cal-cancel-hash'`,
        [organizationId],
      );
      expect(cancelHash.rows[0]!.request_hash).toBe(
        manualEventCancelRequestHash(cancellable.id, {
          clientActionId: 'b2cal-cancel-hash',
          expectedVersion: cancellable.version,
          cancelReason: 'B2CAL cancel reason',
        }),
      );
      expect(manualEventCreateRequestHash(input)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
