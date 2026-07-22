import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresWebPushRepository } from '../src/modules/web-push/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
] as const;

type Fixture = Readonly<{
  pool: Pool;
  organizationId: string;
  userId: string;
  subscriptionId: string;
  deliveryId: string;
  at: Date;
}>;

function hexToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

const TEST_VAPID_FINGERPRINT = 'a'.repeat(64);

async function createOrg(pool: Pool): Promise<string> {
  const orgId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name) VALUES ($1, 'Test org')`,
    [orgId],
  );
  return orgId;
}

async function createUser(pool: Pool, orgId: string): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, organization_id, name, email, password_hash, role)
     VALUES ($1, $2, 'User', $3, 'hash', 'STAFF')`,
    [userId, orgId, `${randomUUID()}@test.local`],
  );
  return userId;
}

async function createSession(pool: Pool, userId: string): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, hexToken(), new Date('2026-07-23T10:00:00.000Z')],
  );
  return sessionId;
}

async function createSubscription(
  pool: Pool,
  orgId: string,
  userId: string,
  sessionId: string,
  at: Date,
): Promise<string> {
  const subId = (await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint, endpoint_hash,
        p256dh, auth, vapid_public_key_fingerprint, created_at, updated_at)
     VALUES ($1, $2, $3, 'https://fcm.googleapis.com/fcm/send/test', $4,
             'test-p256dh', 'test-auth', $5, $6, $6)
     RETURNING id`,
    [orgId, userId, sessionId, hexToken(), TEST_VAPID_FINGERPRINT, at],
  )).rows[0]!.id;
  return subId;
}

async function createRealtimeEvent(
  pool: Pool,
  orgId: string,
  userId: string,
): Promise<{ eventId: string; jobCardId: string }> {
  const jobCardId = randomUUID();
  await pool.query(
    `INSERT INTO job_cards (id, organization_id, type, title, assigned_to, created_by)
     VALUES ($1, $2, 'GENERAL_TASK', 'Test task', $3, $3)`,
    [jobCardId, orgId, userId],
  );
  const activityId = (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_ASSIGNED') RETURNING id`,
    [orgId, jobCardId, userId],
  )).rows[0]!.id;
  const eventId = (await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type,
        entity_id, actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'job.cancelled', 'job-card', $3, $4,
             ARRAY[]::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
     RETURNING id`,
    [orgId, activityId, jobCardId, userId],
  )).rows[0]!.id;
  return { eventId, jobCardId };
}

async function createNotification(
  pool: Pool,
  orgId: string,
  userId: string,
  eventId: string,
  jobCardId: string,
  at: Date,
): Promise<string> {
  const nId = randomUUID();
  await pool.query(
    `INSERT INTO in_app_notifications
       (id, organization_id, recipient_user_id, source_realtime_event_id,
        kind, entity_type, entity_id, created_at)
     VALUES ($1, $2, $3, CAST($4 AS BIGINT), 'job.assigned', 'job-card', $5, $6)`,
    [nId, orgId, userId, eventId, jobCardId, at],
  );
  return nId;
}

async function createDelivery(
  pool: Pool,
  orgId: string,
  notificationId: string,
  subscriptionId: string,
  at: Date,
): Promise<string> {
  const deliveryId = (await pool.query<{ id: string }>(
    `INSERT INTO web_push_deliveries
       (organization_id, notification_id, subscription_id, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id`,
    [orgId, notificationId, subscriptionId, at, at],
  )).rows[0]!.id;
  return deliveryId;
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const at = new Date('2026-07-22T10:00:00.000Z');
  const orgId = await createOrg(pool);
  const userId = await createUser(pool, orgId);
  const sessionId = await createSession(pool, userId);
  const subscriptionId = await createSubscription(pool, orgId, userId, sessionId, at);
  const { eventId, jobCardId } = await createRealtimeEvent(pool, orgId, userId);
  const notificationId = await createNotification(pool, orgId, userId, eventId, jobCardId, at);
  const deliveryId = await createDelivery(pool, orgId, notificationId, subscriptionId, at);

  return { pool, organizationId: orgId, userId, subscriptionId, deliveryId, at };
}

async function runWithFixture(test: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `push_dispatch_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
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
    const fixture = await createFixture(pool);
    await test(fixture);
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe('Web Push dispatch — PostgreSQL', () => {
  // P1 — due row claim
  it('claims a due PENDING delivery', async () => {
    await runWithFixture(async ({ pool, deliveryId, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.deliveryId).toBe(deliveryId);
      expect(claimed[0]!.leaseToken).toBeTruthy();
      expect(claimed[0]!.attemptCount).toBe(1);

      const rows = await pool.query<{ state: string; attempt_count: number; lease_token: string | null }>(
        `SELECT state, attempt_count, lease_token FROM web_push_deliveries WHERE id = $1`,
        [deliveryId],
      );
      expect(rows.rows[0]!.state).toBe('CLAIMED');
      expect(rows.rows[0]!.attempt_count).toBe(1);
      expect(rows.rows[0]!.lease_token).toBe(claimed[0]!.leaseToken);
    });
  });

  // P2 — future retry not claimed
  it('does not claim future-dated PENDING delivery', async () => {
    await runWithFixture(async ({ pool, at }) => {
      const repo = new PostgresWebPushRepository(pool);
      const earlier = new Date(at.getTime() - 5_000);
      const claimed = await repo.claimDueDeliveries({ limit: 4, at: earlier });
      expect(claimed).toHaveLength(0);
    });
  });

  // P3 — active lease not claimed
  it('does not claim an actively leased delivery', async () => {
    await runWithFixture(async ({ pool, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const first = await repo.claimDueDeliveries({ limit: 4, at });
      expect(first).toHaveLength(1);

      const second = await repo.claimDueDeliveries({ limit: 4, at });
      expect(second).toHaveLength(0);
    });
  });

  // P4 — expired lease reclaim
  it('reclaims an expired-lease CLAIMED delivery', async () => {
    await runWithFixture(async ({ pool, deliveryId, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const first = await repo.claimDueDeliveries({ limit: 4, at });
      expect(first).toHaveLength(1);
      expect(first[0]!.deliveryId).toBe(deliveryId);

      const later = new Date(at.getTime() + 31_000);
      const second = await repo.claimDueDeliveries({ limit: 4, at: later });
      expect(second).toHaveLength(1);
      expect(second[0]!.deliveryId).toBe(deliveryId);
      expect(second[0]!.attemptCount).toBe(2);
      expect(second[0]!.leaseToken).not.toBe(first[0]!.leaseToken);
    });
  });

  // P5 — concurrent claimers
  it('only one of two concurrent workers claims the same delivery', async () => {
    await runWithFixture(async ({ pool, at }) => {
      const repoA = new PostgresWebPushRepository(pool);
      const repoB = new PostgresWebPushRepository(pool);

      const [resultA, resultB] = await Promise.all([
        repoA.claimDueDeliveries({ limit: 4, at }),
        repoB.claimDueDeliveries({ limit: 4, at }),
      ]);

      const total = resultA.length + resultB.length;
      expect(total).toBe(1);
    });
  });

  // P6 — limit
  it('respects the claim limit', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at, organizationId, userId } = fixture;

      for (let i = 0; i < 9; i++) {
        const uId = await createUser(pool, organizationId);
        const sId = await createSession(pool, uId);
        const subId = await createSubscription(pool, organizationId, uId, sId, at);
        const { eventId, jobCardId } = await createRealtimeEvent(pool, organizationId, userId);
        const nId = await createNotification(pool, organizationId, uId, eventId, jobCardId, at);
        await createDelivery(pool, organizationId, nId, subId, at);
      }

      const repo = new PostgresWebPushRepository(pool);
      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed.length).toBeLessThanOrEqual(4);
      expect(claimed.length).toBe(4);
    });
  });

  // R1 — recordDelivered
  it('records successful delivery with matching lease token', async () => {
    await runWithFixture(async ({ pool, subscriptionId, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);

      const ok = await repo.recordDelivered({
        deliveryId: claimed[0]!.deliveryId,
        leaseToken: claimed[0]!.leaseToken,
        subscriptionId,
        at: new Date(at.getTime() + 1000),
      });
      expect(ok).toBe(true);

      const row = await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE id = $1`,
        [claimed[0]!.deliveryId],
      );
      expect(row.rows[0]!.state).toBe('DELIVERED');
    });
  });

  // R2 — stale token
  it('rejects stale lease token on recordDelivered', async () => {
    await runWithFixture(async ({ pool, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);

      const ok = await repo.recordDelivered({
        deliveryId: claimed[0]!.deliveryId,
        leaseToken: '00000000-0000-0000-0000-000000000000',
        subscriptionId: randomUUID(),
        at: new Date(at.getTime() + 1000),
      });
      expect(ok).toBe(false);

      const row = await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE id = $1`,
        [claimed[0]!.deliveryId],
      );
      expect(row.rows[0]!.state).toBe('CLAIMED');
    });
  });

  // R3 — max attempts (attempt 6 → recordAbandoned)
  it('abandons delivery at attempt 6', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, deliveryId, at } = fixture;
      const repo = new PostgresWebPushRepository(pool);

      await pool.query(
        `UPDATE web_push_deliveries SET attempt_count = 5, next_attempt_at = $2, updated_at = $2 WHERE id = $1`,
        [deliveryId, at],
      );

      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attemptCount).toBe(6);

      const ok = await repo.recordAbandoned({
        deliveryId: claimed[0]!.deliveryId,
        leaseToken: claimed[0]!.leaseToken,
        at: new Date(at.getTime() + 1000),
        errorCode: 'MAX_ATTEMPTS',
      });
      expect(ok).toBe(true);

      const row = await pool.query<{ state: string; abandoned_at: Date | null; last_error_code: string | null }>(
        `SELECT state, abandoned_at, last_error_code FROM web_push_deliveries WHERE id = $1`,
        [deliveryId],
      );
      expect(row.rows[0]!.state).toBe('ABANDONED');
      expect(row.rows[0]!.abandoned_at).toBeTruthy();
      expect(row.rows[0]!.last_error_code).toBe('MAX_ATTEMPTS');

      const reclaim = await repo.claimDueDeliveries({ limit: 4, at: new Date(at.getTime() + 24 * 60 * 60_000) });
      expect(reclaim).toHaveLength(0);
    });
  });

  // R4 — 404 recordProviderStale
  it('abandons and disables subscription on 404', async () => {
    await runWithFixture(async ({ pool, subscriptionId, at }) => {
      const repo = new PostgresWebPushRepository(pool);

      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);

      const ok = await repo.recordProviderStale({
        deliveryId: claimed[0]!.deliveryId,
        leaseToken: claimed[0]!.leaseToken,
        at: new Date(at.getTime() + 1000),
        errorCode: 'PROVIDER_404',
      });
      expect(ok).toBe(true);

      const sub = await pool.query<{ disabled_at: Date | null; disabled_reason: string | null }>(
        `SELECT disabled_at, disabled_reason FROM web_push_subscriptions WHERE id = $1`,
        [subscriptionId],
      );
      expect(sub.rows[0]!.disabled_at).toBeTruthy();
      expect(sub.rows[0]!.disabled_reason).toBe('PROVIDER_STALE');
    });
  });
});
