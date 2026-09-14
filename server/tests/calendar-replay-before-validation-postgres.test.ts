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
const now = new Date('2026-09-09T07:00:00.000Z');

type Fixture = {
  pool: Pool;
  organizationId: string;
  manager: CalendarActor;
  staffId: string;
  service: CalendarService;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `calreplay_${randomUUID().replaceAll('-', '')}`;
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
       VALUES ('CAL-REPLAY Calendar', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'CAL-REPLAY Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
      [organizationId, `${randomUUID()}@calreplay.test`],
    )).rows[0]!.id;
    const staffId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'CAL-REPLAY Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@calreplay.test`],
    )).rows[0]!.id;

    const repository = new PostgresCalendarRepository(pool, 30, false);
    await run({
      pool,
      organizationId,
      manager: { id: managerId, organizationId, role: 'MANAGER' },
      staffId,
      service: new CalendarService(true, repository, () => now),
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function counts(pool: Pool, organizationId: string) {
  const result = await pool.query<{
    events: string; activities: string; realtime: string; notifications: string; reminders: string;
  }>(
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

describe.skipIf(!databaseUrl)('CAL-REPLAY-BEFORE-STATE-VALIDATION exact PATCH replay precedes mutable validation', () => {
  it('returns the current persisted event for an exact completed PATCH after an independent duration change without revalidation', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      // Monday 12:00-13:00 local (Europe/Istanbul, UTC+3): 1-hour interval.
      const created = await service.create(manager, {
        clientActionId: 'cal-replay-seed',
        assignedUserId: staffId,
        title: 'CAL-REPLAY target',
        description: null,
        startsAt: '2026-09-14T09:00:00.000Z',
        endsAt: '2026-09-14T10:00:00.000Z',
        timezone: 'Europe/Istanbul',
      });

      // A: startsAt-only PATCH to Saturday 23:00 local. The 1-hour preserved
      // duration derives exactly Sunday 00:00 local, which is valid under
      // half-open working-day semantics (Sunday itself is not occupied).
      const actionA = 'cal-replay-a';
      const patchA = {
        clientActionId: actionA,
        expectedVersion: created.version,
        startsAt: '2026-09-12T20:00:00.000Z',
      } as const;
      const persistedA = await service.patch(manager, created.id, { ...patchA });
      expect(persistedA.startsAt).toBe('2026-09-12T20:00:00.000Z');
      expect(persistedA.endsAt).toBe('2026-09-12T21:00:00.000Z');
      expect(persistedA.version).toBe(created.version + 1);

      // B: independent action moves the same record to a weekday and stretches
      // the persisted duration to 2 hours.
      const persistedB = await service.patch(manager, created.id, {
        clientActionId: 'cal-replay-b',
        expectedVersion: persistedA.version,
        startsAt: '2026-09-14T09:00:00.000Z',
        endsAt: '2026-09-14T11:00:00.000Z',
      });
      expect(persistedB.version).toBe(persistedA.version + 1);
      const afterB = await counts(pool, organizationId);

      // Exact completed replay of A: same key, byte-identical original input.
      // Against the CURRENT 2-hour duration the merged interval would be
      // Saturday 23:00 -> Sunday 01:00 local and must NOT be revalidated.
      // The replay does not reapply the historical mutation and returns the
      // current persisted event (no response snapshot is stored).
      const replayed = await service.patch(manager, created.id, { ...patchA });

      // No new business mutation: the persisted record still reflects B, the
      // version did not advance, and no action/audit side-effect was added.
      expect(replayed).toEqual(persistedB);
      expect(replayed.version).toBe(persistedB.version);
      expect(await counts(pool, organizationId)).toEqual(afterB);
      const persisted = await pool.query<{ starts_at: Date; ends_at: Date; version: number }>(
        `SELECT starts_at, ends_at, version FROM calendar_events
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, created.id],
      );
      expect(persisted.rows[0]!.starts_at.toISOString()).toBe(persistedB.startsAt);
      expect(persisted.rows[0]!.ends_at!.toISOString()).toBe(persistedB.endsAt);
      expect(persisted.rows[0]!.version).toBe(persistedB.version);
    });
  });

  it('still rejects the same key with a changed semantic payload', async () => {
    await withFixture(async ({ pool, organizationId, manager, staffId, service }) => {
      const created = await service.create(manager, {
        clientActionId: 'cal-replay-neg-seed',
        assignedUserId: staffId,
        title: 'CAL-REPLAY negative target',
        description: null,
        startsAt: '2026-09-14T09:00:00.000Z',
        endsAt: '2026-09-14T10:00:00.000Z',
        timezone: 'Europe/Istanbul',
      });
      const actionA = 'cal-replay-neg-a';
      await service.patch(manager, created.id, {
        clientActionId: actionA,
        expectedVersion: created.version,
        startsAt: '2026-09-12T20:00:00.000Z',
      });
      const afterA = await counts(pool, organizationId);

      // Same key, semantically different payload: must fail closed, never replay.
      await expect(service.patch(manager, created.id, {
        clientActionId: actionA,
        expectedVersion: created.version,
        startsAt: '2026-09-12T21:00:00.000Z',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await counts(pool, organizationId)).toEqual(afterA);
    });
  });
});
