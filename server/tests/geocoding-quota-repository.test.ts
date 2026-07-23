import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresReverseGeocodingQuotaGuard } from '../src/modules/geocoding/postgres-reverse-geocoding-quota.js';
import {
  istanbulDateString,
  utcMonthStartString,
} from '../src/modules/geocoding/quota-periods.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql',
  '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
  '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql',
  '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
] as const;

async function applyMigrations(pool: Pool) {
  for (const migration of migrations) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function withMigratedDatabase(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `geocoding_quota_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await applyMigrations(pool);
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL reverse-geocoding quota guard', () => {
  it('reserves three buckets atomically and enforces user/org/global limits', async () => {
    await withMigratedDatabase(async (pool) => {
      const orgA = randomUUID();
      const orgB = randomUUID();
      const user1 = randomUUID();
      const user2 = randomUUID();
      const now = new Date('2026-07-21T12:00:00.000Z');
      const guard = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: 2,
        organizationDailyLimit: 3,
        globalMonthlyLimit: 5,
      });

      const first = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: user1, now,
      });
      expect(first).toEqual({
        allowed: true, userUsed: 1, organizationUsed: 1, globalUsed: 1,
      });

      const second = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: user1, now,
      });
      expect(second).toMatchObject({ allowed: true, userUsed: 2 });

      const userLimited = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: user1, now,
      });
      expect(userLimited).toEqual({ allowed: false, reason: 'USER_DAILY_LIMIT' });

      const otherUser = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: user2, now,
      });
      expect(otherUser).toMatchObject({ allowed: true, organizationUsed: 3 });

      const orgLimited = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: user2, now,
      });
      expect(orgLimited).toEqual({ allowed: false, reason: 'ORGANIZATION_DAILY_LIMIT' });

      // Global accumulates across organizations.
      await guard.reserve({
        provider: 'GOOGLE', organizationId: orgB, actorUserId: randomUUID(), now,
      });
      const lastGlobal = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgB, actorUserId: randomUUID(), now,
      });
      expect(lastGlobal).toMatchObject({ allowed: true, globalUsed: 5 });

      const globalLimited = await guard.reserve({
        provider: 'GOOGLE', organizationId: orgB, actorUserId: randomUUID(), now,
      });
      expect(globalLimited).toEqual({ allowed: false, reason: 'GLOBAL_MONTHLY_LIMIT' });

      const rows = await pool.query<{
        scope_type: string;
        used_count: number;
        scope_key: string;
      }>(
        `SELECT scope_type, used_count, scope_key
           FROM reverse_geocoding_quota_buckets
          ORDER BY scope_type, scope_key`,
      );
      for (const row of rows.rows) {
        expect(row.used_count).toBeGreaterThan(0);
        expect(JSON.stringify(row)).not.toMatch(/latitude|longitude|address|39\.|32\./i);
      }

      // Denied reservation must not partially increment: re-check user1 still at 2.
      const userBuckets = await pool.query<{ used_count: number }>(
        `SELECT used_count FROM reverse_geocoding_quota_buckets
          WHERE scope_type = 'USER_DAY' AND scope_key = $1`,
        [`${orgA}:${user1}`],
      );
      expect(userBuckets.rows[0]?.used_count).toBe(2);
    });
  });

  it('never exceeds the limit under concurrent reservations', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = randomUUID();
      const actorUserId = randomUUID();
      const now = new Date('2026-07-21T15:00:00.000Z');
      const limit = 10;
      const guard = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: limit,
        organizationDailyLimit: 100,
        globalMonthlyLimit: 1000,
      });

      const results = await Promise.all(
        Array.from({ length: 40 }, () => guard.reserve({
          provider: 'GOOGLE', organizationId, actorUserId, now,
        })),
      );
      const allowed = results.filter((result) => result.allowed);
      const denied = results.filter((result) => !result.allowed);
      expect(allowed).toHaveLength(limit);
      expect(denied).toHaveLength(30);
      expect(denied.every((result) => !result.allowed && result.reason === 'USER_DAILY_LIMIT')).toBe(true);

      const count = await pool.query<{ used_count: number }>(
        `SELECT used_count FROM reverse_geocoding_quota_buckets
          WHERE scope_type = 'USER_DAY'`,
      );
      expect(count.rows[0]?.used_count).toBe(limit);
      expect(count.rows[0]!.used_count).toBeLessThanOrEqual(limit);
    });
  });

  it('uses Istanbul day and UTC month period boundaries', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = randomUUID();
      const actorUserId = randomUUID();
      // 2026-07-21 21:30 UTC is 2026-07-22 00:30 in Europe/Istanbul.
      const lateUtc = new Date('2026-07-21T21:30:00.000Z');
      const earlyUtc = new Date('2026-07-21T20:30:00.000Z');
      expect(istanbulDateString(earlyUtc)).toBe('2026-07-21');
      expect(istanbulDateString(lateUtc)).toBe('2026-07-22');
      expect(utcMonthStartString(new Date('2026-07-31T23:00:00.000Z'))).toBe('2026-07-01');
      expect(utcMonthStartString(new Date('2026-08-01T00:00:00.000Z'))).toBe('2026-08-01');

      const guard = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: 5,
        organizationDailyLimit: 50,
        globalMonthlyLimit: 500,
      });
      await guard.reserve({
        provider: 'GOOGLE', organizationId, actorUserId, now: earlyUtc,
      });
      await guard.reserve({
        provider: 'GOOGLE', organizationId, actorUserId, now: lateUtc,
      });

      const dayBuckets = await pool.query<{ period_start: string; used_count: number }>(
        `SELECT period_start::text AS period_start, used_count
           FROM reverse_geocoding_quota_buckets
          WHERE scope_type = 'USER_DAY'
          ORDER BY period_start`,
      );
      expect(dayBuckets.rows).toEqual([
        { period_start: '2026-07-21', used_count: 1 },
        { period_start: '2026-07-22', used_count: 1 },
      ]);
    });
  });

  it('cleans expired buckets and keeps the pool usable after rollbacks', async () => {
    await withMigratedDatabase(async (pool) => {
      await pool.query(
        `INSERT INTO reverse_geocoding_quota_buckets
           (provider, scope_type, scope_key, period_start, used_count, expires_at)
         VALUES
           ('GOOGLE', 'GLOBAL_MONTH', 'global', '2020-01-01', 3, '2020-02-01T00:00:00.000Z'),
           ('GOOGLE', 'USER_DAY', $1, '2026-07-21', 1, NOW() + INTERVAL '90 days')`,
        [`${randomUUID()}:${randomUUID()}`],
      );

      const guard = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: 15,
        organizationDailyLimit: 250,
        globalMonthlyLimit: 8000,
      });
      const decision = await guard.reserve({
        provider: 'GOOGLE',
        organizationId: randomUUID(),
        actorUserId: randomUUID(),
        now: new Date('2026-07-21T12:00:00.000Z'),
      });
      expect(decision.allowed).toBe(true);

      const expired = await pool.query(
        `SELECT 1 FROM reverse_geocoding_quota_buckets
          WHERE period_start = '2020-01-01'`,
      );
      expect(expired.rowCount).toBe(0);

      // Connection reusable after intentional failure path.
      const limited = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: 1,
        organizationDailyLimit: 1,
        globalMonthlyLimit: 1,
      });
      const org = randomUUID();
      const user = randomUUID();
      // Fresh Istanbul day / UTC month period relative to earlier reserves in this test.
      const now = new Date('2026-09-22T10:00:00.000Z');
      expect((await limited.reserve({
        provider: 'GOOGLE', organizationId: org, actorUserId: user, now,
      })).allowed).toBe(true);
      expect((await limited.reserve({
        provider: 'GOOGLE', organizationId: org, actorUserId: user, now,
      })).allowed).toBe(false);
      await expect(pool.query('SELECT 1 AS ok')).resolves.toMatchObject({
        rows: [{ ok: 1 }],
      });
    });
  });

  it('isolates organization buckets from each other', async () => {
    await withMigratedDatabase(async (pool) => {
      const now = new Date('2026-07-21T12:00:00.000Z');
      const guard = new PostgresReverseGeocodingQuotaGuard(pool, {
        userDailyLimit: 5,
        organizationDailyLimit: 1,
        globalMonthlyLimit: 100,
      });
      const orgA = randomUUID();
      const orgB = randomUUID();
      expect((await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: randomUUID(), now,
      })).allowed).toBe(true);
      expect((await guard.reserve({
        provider: 'GOOGLE', organizationId: orgA, actorUserId: randomUUID(), now,
      })).allowed).toBe(false);
      expect((await guard.reserve({
        provider: 'GOOGLE', organizationId: orgB, actorUserId: randomUUID(), now,
      })).allowed).toBe(true);
    });
  });
});
