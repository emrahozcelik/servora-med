/**
 * Task 9 normal path over real PostgreSQL projection + claim + payload + worker.
 *
 * Flow under test:
 * JobCard lifecycle (submitForApproval with webPush enabled)
 * → persistent in_app_notification
 * → web_push_delivery PENDING
 * → PostgresWebPushRepository.claimDueDeliveries
 * → presentNotification + buildPushPayload
 * → fake sender capture (no network)
 * → recordDelivered with matching lease
 * → real service-worker.js harness showNotification + notificationclick
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { presentNotification } from '../src/modules/notifications/presenter.js';
import type { NotificationRecord } from '../src/modules/notifications/types.js';
import { buildPushPayload, buildPushTopic } from '../src/modules/web-push/payload.js';
import { PostgresWebPushRepository } from '../src/modules/web-push/repository.js';
import { createServiceWorkerHarness } from '../../web/tests/helpers/service-worker-harness.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
] as const;

function hexToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

async function createSubscription(
  pool: Pool,
  organizationId: string,
  userId: string,
): Promise<{ subscriptionId: string; sessionId: string; endpoint: string }> {
  const sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
    [userId, hexToken()],
  )).rows[0]!.id;
  const endpoint = `https://fcm.googleapis.com/fcm/send/${hexToken().slice(0, 16)}`;
  const subscriptionId = (await pool.query<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint,
        endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'test-p256dh', 'test-auth', $6)
     RETURNING id`,
    [
      organizationId,
      userId,
      sessionId,
      endpoint,
      hexToken(),
      'a'.repeat(64),
    ],
  )).rows[0]!.id;
  return { subscriptionId, sessionId, endpoint };
}

describe.skipIf(!databaseUrl)('Web Push integrated normal path (PostgreSQL → worker)', () => {
  it('projects from JobCard lifecycle, claims once, delivers once, and focuses job URL without mark-read', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `push_integrated_${randomUUID().replaceAll('-', '')}`;
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
        `INSERT INTO organizations (name) VALUES ('Integrated push org') RETURNING id`,
      )).rows[0]!.id;

      const staffId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Staff', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;

      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Manager', $2, 'unused-test-hash', 'MANAGER') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;

      const { subscriptionId, endpoint } = await createSubscription(
        pool, organizationId, managerId,
      );

      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Integrated path task', $2, $2) RETURNING id`,
        [organizationId, staffId],
      )).rows[0]!.id;

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(
        repository,
        () => new Date('2026-07-22T10:00:00.000Z'),
        undefined,
        undefined,
        { enabled: true },
      );
      const actor: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };

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
        note: 'Ready for manager review.',
      });

      const notificationRows = await pool.query<{
        id: string;
        kind: string;
        entity_id: string;
        recipient_user_id: string;
        created_at: Date;
      }>(
        `SELECT id, kind, entity_id, recipient_user_id, created_at
           FROM in_app_notifications
          WHERE organization_id = $1 AND recipient_user_id = $2
          ORDER BY created_at DESC`,
        [organizationId, managerId],
      );
      expect(notificationRows.rows.length).toBeGreaterThanOrEqual(1);
      const notification = notificationRows.rows[0]!;

      const deliveryRows = await pool.query<{
        id: string;
        state: string;
        notification_id: string;
        subscription_id: string;
      }>(
        `SELECT id, state, notification_id, subscription_id
           FROM web_push_deliveries
          WHERE organization_id = $1 AND notification_id = $2`,
        [organizationId, notification.id],
      );
      expect(deliveryRows.rows).toHaveLength(1);
      expect(deliveryRows.rows[0]!.state).toBe('PENDING');
      expect(deliveryRows.rows[0]!.notification_id).toBe(notification.id);
      expect(deliveryRows.rows[0]!.subscription_id).toBe(subscriptionId);

      const webPushRepo = new PostgresWebPushRepository(pool);
      // Claim must be after next_attempt_at and within session validity.
      const timing = await pool.query<{ next_attempt_at: Date; expires_at: Date }>(
        `SELECT delivery.next_attempt_at, session_record.expires_at
           FROM web_push_deliveries delivery
           JOIN web_push_subscriptions subscription ON subscription.id = delivery.subscription_id
           JOIN sessions session_record ON session_record.id = subscription.session_id
          WHERE delivery.id = $1`,
        [deliveryRows.rows[0]!.id],
      );
      const at = new Date(timing.rows[0]!.next_attempt_at.getTime() + 1_000);
      expect(at.getTime()).toBeLessThan(timing.rows[0]!.expires_at.getTime());
      const claimed = await webPushRepo.claimDueDeliveries({ limit: 4, at });
      expect(claimed).toHaveLength(1);
      const delivery = claimed[0]!;
      expect(delivery.deliveryId).toBe(deliveryRows.rows[0]!.id);
      expect(delivery.leaseToken).toBeTruthy();
      expect(delivery.attemptCount).toBe(1);
      expect(delivery.notification.id).toBe(notification.id);
      expect(delivery.subscription.id).toBe(subscriptionId);

      const claimedState = await pool.query<{ state: string; attempt_count: number }>(
        `SELECT state, attempt_count FROM web_push_deliveries WHERE id = $1`,
        [delivery.deliveryId],
      );
      expect(claimedState.rows[0]!.state).toBe('CLAIMED');
      expect(claimedState.rows[0]!.attempt_count).toBe(1);

      const record: NotificationRecord = {
        id: delivery.notification.id,
        organizationId: delivery.notification.organizationId,
        recipientUserId: delivery.notification.recipientUserId,
        sourceRealtimeEventId: 0n,
        kind: delivery.notification.kind as NotificationRecord['kind'],
        entityType: 'job-card',
        entityId: delivery.notification.entityId,
        createdAt: delivery.notification.createdAt,
        readAt: delivery.notification.readAt,
      };
      const publicNotification = presentNotification(record);
      const payload = buildPushPayload(publicNotification);
      const topic = buildPushTopic(record.id);

      expect(Object.keys(payload).sort()).toEqual([
        'body', 'notificationId', 'title', 'url', 'version',
      ]);
      expect(payload.version).toBe(1);
      expect(payload.notificationId).toBe(notification.id);
      expect(payload.url).toBe(`/jobs/${jobCardId}`);
      expect(payload.url).toMatch(
        /^\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Fake sender boundary — capture only structure, never log secrets.
      const senderCapture = {
        endpoint: delivery.subscription.endpoint,
        hasP256dh: Boolean(delivery.subscription.p256dh),
        hasAuth: Boolean(delivery.subscription.auth),
        payload,
        topic,
      };
      expect(senderCapture.endpoint).toBe(endpoint);
      expect(senderCapture.hasP256dh).toBe(true);
      expect(senderCapture.hasAuth).toBe(true);
      expect(senderCapture.payload).toEqual(payload);
      expect(senderCapture.topic).toBe(topic);

      const deliveredAt = new Date('2026-07-22T10:00:06.000Z');
      const delivered = await webPushRepo.recordDelivered({
        deliveryId: delivery.deliveryId,
        leaseToken: delivery.leaseToken,
        subscriptionId: delivery.subscription.id,
        at: deliveredAt,
      });
      expect(delivered).toBe(true);

      const finalState = await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE id = $1`,
        [delivery.deliveryId],
      );
      expect(finalState.rows[0]!.state).toBe('DELIVERED');

      // Re-claim must not yield the delivered row.
      const reclaim = await webPushRepo.claimDueDeliveries({
        limit: 4,
        at: new Date('2026-07-22T11:00:00.000Z'),
      });
      expect(reclaim.filter((d) => d.deliveryId === delivery.deliveryId)).toHaveLength(0);

      const harness = createServiceWorkerHarness();
      const client = {
        id: 'client-1',
        url: payload.url,
        focus: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn(),
        postMessage: vi.fn(),
      };
      harness.clients.matchAll.mockResolvedValue([client]);

      await harness.fireEvent('push', harness.makePushEvent(payload));
      await harness.settleWaitUntil();

      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]).toMatchObject({
        title: payload.title,
        options: {
          body: payload.body,
          tag: payload.notificationId,
          data: {
            notificationId: payload.notificationId,
            url: payload.url,
          },
        },
      });
      expect(Object.keys(harness.notifications[0]!.options.data as object).sort()).toEqual([
        'notificationId', 'url',
      ]);

      const clickEvent = harness.makeNotificationClickEvent({
        data: {
          notificationId: payload.notificationId,
          url: payload.url,
        },
      });
      await harness.fireEvent('notificationclick', clickEvent);
      await harness.settleWaitUntil();

      expect(clickEvent.notification.close).toHaveBeenCalledTimes(1);
      expect(client.focus).toHaveBeenCalledTimes(1);
      expect(client.navigate).not.toHaveBeenCalled();
      expect(client.postMessage).not.toHaveBeenCalled();
      expect(harness.clients.openWindow).not.toHaveBeenCalled();
      expect(harness.notifications).toHaveLength(1);
    } finally {
      if (pool) await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
