import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import {
  PostgresNotificationRepository,
  PostgresNotificationTransaction,
} from '../src/modules/notifications/repository.js';
import { PostgresWebPushTransaction } from '../src/modules/web-push/repository.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
] as const;

type DeliveryFixture = {
  pool: Pool;
  organizationId: string;
  userId: string;
  sessionId: string;
  subscriptionId: string;
  jobCardId: string;
  jobVersion: number;
  eventId: string;
  notificationId: string;
};

function hexToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

async function createSourceEvent(pool: Pool, organizationId: string, userId: string) {
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'Projeksiyon testi', $2, $2) RETURNING id`,
    [organizationId, userId],
  )).rows[0]!.id;
  const activityId = (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_APPROVED') RETURNING id`,
    [organizationId, jobCardId, userId],
  )).rows[0]!.id;
  const eventId = (await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type,
        entity_id, actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'job.approved', 'job-card', $3, $4,
             ARRAY[]::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
     RETURNING id::text AS id`,
    [organizationId, activityId, jobCardId, userId],
  )).rows[0]!.id;
  return { eventId, jobCardId };
}

async function createSubscription(
  pool: Pool,
  organizationId: string,
  userId: string,
): Promise<{ subscriptionId: string; sessionId: string }> {
  const sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
    [userId, hexToken()],
  )).rows[0]!.id;
  const subscriptionId = (await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint,
        endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'p256dh', 'auth', $6)
     RETURNING id`,
    [
      organizationId,
      userId,
      sessionId,
      `https://fcm.googleapis.com/push/${hexToken().slice(0, 16)}`,
      hexToken(),
      'a'.repeat(64),
    ],
  )).rows[0]!.id;
  return { subscriptionId, sessionId };
}

async function appendNotification(
  pool: Pool,
  organizationId: string,
  userId: string,
  eventId: string,
  jobCardId: string,
) {
  const tx = new PostgresNotificationTransaction(pool as never);
  return tx.append({
    organizationId,
    sourceRealtimeEventId: BigInt(eventId),
    createdAt: new Date('2026-07-22T10:00:00.000Z'),
    drafts: [{
      recipientUserId: userId,
      kind: 'job.approved',
      entityType: 'job-card',
      entityId: jobCardId,
    }],
  });
}

async function withDeliveryFixture(run: (fixture: DeliveryFixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `delivery_projection_${randomUUID().replaceAll('-', '')}`;
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
      `INSERT INTO organizations (name) VALUES ('Delivery projection') RETURNING id`,
    )).rows[0]!.id;
    const userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Recipient', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`],
    )).rows[0]!.id;

    const { subscriptionId, sessionId } = await createSubscription(pool, organizationId, userId);
    const { eventId, jobCardId } = await createSourceEvent(pool, organizationId, userId);
    const notifications = await appendNotification(pool, organizationId, userId, eventId, jobCardId);
    const notificationId = notifications[0]!.id;

    await run({
      pool, organizationId, userId, sessionId, subscriptionId, jobCardId, eventId, notificationId,
      jobVersion: 1,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe.skipIf(!databaseUrl)('Notification-to-outbox projection (PostgreSQL)', () => {
  it('delivery outbox append creates one delivery per notification-subscription match', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, notificationId } = fixture;
      const tx = new PostgresWebPushTransaction(pool as never);

      const deliveries = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(deliveries).toHaveLength(1);

      const row = await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE id = $1`,
        [deliveries[0]],
      );
      expect(row.rows[0]!.state).toBe('PENDING');
    });
  });

  it('JobCardService with webPush enabled creates delivery for manager subscription on submitForApproval', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, jobCardId } = fixture;

      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Manager', $2, 'unused-test-hash', 'MANAGER') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      await createSubscription(pool, organizationId, managerId);

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(
        repository,
        () => new Date('2026-07-22T10:00:00.000Z'),
        undefined,
        undefined,
        { enabled: true },
      );
      const actor: JobCardActor = { id: userId, organizationId, role: 'STAFF' };

      await service.acceptAssignment(actor, jobCardId, {
        expectedVersion: 1,
        clientActionId: randomUUID(),
      });

      await service.start(actor, jobCardId, {
        expectedVersion: 2,
        clientActionId: randomUUID(),
      });

      await service.submitForApproval(actor, jobCardId, {
        expectedVersion: 3,
        clientActionId: randomUUID(),
        note: 'Test for push projection.',
      });

      const deliveries = await pool.query<{ id: string; state: string }>(
        `SELECT d.id, d.state
           FROM web_push_deliveries d
           JOIN in_app_notifications n ON n.id = d.notification_id
          WHERE n.organization_id = $1 AND n.recipient_user_id = $2`,
        [organizationId, managerId],
      );
      expect(deliveries.rows.length).toBeGreaterThanOrEqual(1);
      expect(deliveries.rows[0]!.state).toBe('PENDING');
    });
  });

  it('JobCardService with webPush disabled creates no delivery for manager subscription', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, jobCardId } = fixture;

      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Manager', $2, 'unused-test-hash', 'MANAGER') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      await createSubscription(pool, organizationId, managerId);

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(
        repository,
        () => new Date('2026-07-22T10:00:00.000Z'),
        undefined,
        undefined,
        { enabled: false },
      );
      const actor: JobCardActor = { id: userId, organizationId, role: 'STAFF' };

      await service.acceptAssignment(actor, jobCardId, {
        expectedVersion: 1,
        clientActionId: randomUUID(),
      });

      await service.start(actor, jobCardId, {
        expectedVersion: 2,
        clientActionId: randomUUID(),
      });

      await service.submitForApproval(actor, jobCardId, {
        expectedVersion: 3,
        clientActionId: randomUUID(),
        note: 'Test disabled push.',
      });

      const deliveryCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries d
           JOIN in_app_notifications n ON n.id = d.notification_id
          WHERE n.organization_id = $1 AND n.recipient_user_id = $2`,
        [organizationId, managerId],
      );
      expect(deliveryCount.rows[0]!.count).toBe(0);

      const notificationCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM in_app_notifications
          WHERE organization_id = $1 AND recipient_user_id = $2`,
        [organizationId, managerId],
      );
      expect(notificationCount.rows[0]!.count).toBeGreaterThanOrEqual(1);
    });
  });

  it('multiple active subscriptions create one unique delivery each', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, notificationId } = fixture;
      await createSubscription(pool, organizationId, userId);

      const tx = new PostgresWebPushTransaction(pool as never);
      const deliveries = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      const deduplicated = new Set(deliveries);
      expect(deliveries).toHaveLength(2);
      expect(deduplicated.size).toBe(2);
    });
  });

  it('disabled subscription creates no delivery', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, notificationId, subscriptionId } = fixture;

      await pool.query(
        `UPDATE web_push_subscriptions
            SET disabled_at = NOW(), disabled_reason = 'USER_DISABLED'
          WHERE id = $1`,
        [subscriptionId],
      );

      const tx = new PostgresWebPushTransaction(pool as never);
      const deliveries = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(deliveries).toHaveLength(0);
    });
  });

  it('expired session subscription creates no delivery', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, notificationId, sessionId } = fixture;

      await pool.query(
        `UPDATE sessions
            SET expires_at = '2026-07-22T09:00:00.000Z'::timestamptz,
                created_at = '2026-07-21T09:00:00.000Z'::timestamptz
          WHERE id = $1`,
        [sessionId],
      );

      const tx = new PostgresWebPushTransaction(pool as never);
      const deliveries = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:05:00.000Z'),
      });
      expect(deliveries).toHaveLength(0);
    });
  });

  it('inactive user subscription creates no delivery', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, notificationId, userId } = fixture;

      await pool.query(
        `UPDATE users SET is_active = FALSE WHERE id = $1`,
        [userId],
      );

      const tx = new PostgresWebPushTransaction(pool as never);
      const deliveries = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(deliveries).toHaveLength(0);
    });
  });

  it('cross-tenant notification does not match subscriptions from another organization', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId } = fixture;

      await createSubscription(pool, organizationId, userId);

      const otherOrg = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Other org') RETURNING id`,
      )).rows[0]!.id;
      const otherUser = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Other', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [otherOrg, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const otherEvent = await createSourceEvent(pool, otherOrg, otherUser);
      const otherNotifications = await appendNotification(pool, otherOrg, otherUser, otherEvent.eventId, otherEvent.jobCardId);

      const tx = new PostgresWebPushTransaction(pool as never);
      const deliveries = await tx.appendDeliveries({
        organizationId: otherOrg,
        notificationIds: [otherNotifications[0]!.id],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(deliveries).toHaveLength(0);
    });
  });

  it('notification transaction rollback produces no delivery', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId } = fixture;
      const freshEvent = await createSourceEvent(pool, organizationId, userId);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const tx = new PostgresNotificationTransaction(client as never);
        const notifications = await tx.append({
          organizationId,
          sourceRealtimeEventId: BigInt(freshEvent.eventId),
          createdAt: new Date('2026-07-22T10:00:00.000Z'),
          drafts: [{
            recipientUserId: userId,
            kind: 'job.approved',
            entityType: 'job-card',
            entityId: freshEvent.jobCardId,
          }],
        });
        expect(notifications).toHaveLength(1);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const counts = await pool.query<{ notifications: number; deliveries: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM in_app_notifications
             WHERE organization_id = $1 AND source_realtime_event_id = $2) AS notifications,
           (SELECT COUNT(*)::int FROM web_push_deliveries d
              JOIN in_app_notifications n ON n.id = d.notification_id
             WHERE n.organization_id = $1 AND n.source_realtime_event_id = $2) AS deliveries`,
        [organizationId, BigInt(freshEvent.eventId)],
      );
      expect(counts.rows[0]!.notifications).toBe(0);
      expect(counts.rows[0]!.deliveries).toBe(0);
    });
  });

  it('idempotent notification append followed by delivery append produces no duplicate', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, notificationId } = fixture;

      await pool.query(`DELETE FROM web_push_deliveries`);

      const tx = new PostgresWebPushTransaction(pool as never);

      const first = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(first).toHaveLength(1);

      const second = await tx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });
      expect(second).toHaveLength(0);

      const count = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries WHERE notification_id = $1`,
        [notificationId],
      );
      expect(count.rows[0]!.count).toBe(1);
    });
  });

  it('subscribing after notification commit does not backfill old notification deliveries', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, subscriptionId } = fixture;

      await pool.query(
        `UPDATE web_push_subscriptions
            SET disabled_at = NOW(), disabled_reason = 'USER_DISABLED'
          WHERE id = $1`,
        [subscriptionId],
      );

      const { subscriptionId: newId } = await createSubscription(pool, organizationId, userId);

      const deliveries = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE subscription_id = $1`,
        [newId],
      );
      expect(deliveries.rows[0]!.count).toBe(0);
    });
  });

  it('mark-read abandons PENDING deliveries', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, notificationId } = fixture;
      const wpTx = new PostgresWebPushTransaction(pool as never);
      const repository = new PostgresNotificationRepository(pool);

      await wpTx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });

      const before = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'PENDING'`,
        [notificationId],
      );
      expect(before.rows[0]!.count).toBe(1);

      const record = await repository.markRead({ organizationId, userId }, notificationId);
      expect(record).not.toBeNull();
      expect(record?.readAt).toBeInstanceOf(Date);

      const after = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'ABANDONED'
            AND last_error_code = 'READ'`,
        [notificationId],
      );
      expect(after.rows[0]!.count).toBe(1);

      const pending = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'PENDING'`,
        [notificationId],
      );
      expect(pending.rows[0]!.count).toBe(0);
    });
  });

  it('mark-read on already-read notification does not double-abandon', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, notificationId } = fixture;
      const wpTx = new PostgresWebPushTransaction(pool as never);
      const repository = new PostgresNotificationRepository(pool);

      await wpTx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });

      const first = await repository.markRead({ organizationId, userId }, notificationId);
      expect(first).not.toBeNull();
      const second = await repository.markRead({ organizationId, userId }, notificationId);
      expect(second?.readAt).toEqual(first!.readAt);

      const count = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'ABANDONED'`,
        [notificationId],
      );
      expect(count.rows[0]!.count).toBe(1);
    });
  });

  it('mark-read does not affect non-PENDING deliveries (CLAIMED, DELIVERED, ABANDONED)', async () => {
    await withDeliveryFixture(async (fixture) => {
      const { pool, organizationId, userId, notificationId } = fixture;
      const wpTx = new PostgresWebPushTransaction(pool as never);
      const repository = new PostgresNotificationRepository(pool);

      await wpTx.appendDeliveries({
        organizationId,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T10:00:00.000Z'),
      });

      await pool.query(
        `UPDATE web_push_deliveries
            SET state = 'CLAIMED',
                lease_token = gen_random_uuid(),
                lease_until = NOW() + INTERVAL '30 seconds'
          WHERE notification_id = $1`,
        [notificationId],
      );

      await repository.markRead({ organizationId, userId }, notificationId);

      const claimed = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'CLAIMED'`,
        [notificationId],
      );
      expect(claimed.rows[0]!.count).toBe(1);

      const abandoned = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_deliveries
          WHERE notification_id = $1 AND state = 'ABANDONED'`,
        [notificationId],
      );
      expect(abandoned.rows[0]!.count).toBe(0);
    });
  });
});
