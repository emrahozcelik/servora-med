import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresWebPushRepository } from '../src/modules/web-push/repository.js';
import { createDispatcher } from '../src/modules/web-push/dispatcher.js';
import { buildPushPayload } from '../src/modules/web-push/payload.js';
import { presentNotification } from '../src/modules/notifications/presenter.js';
import type { NotificationRecord } from '../src/modules/notifications/types.js';

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
  '017_calendar.sql',
  '018_messaging.sql',
  '024_job_card_notes_invoice_number.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '023_staff_confidential_notes.sql',
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
  '027_follow_up_proposals.sql',
  '028_notification_center_dismissal.sql',
  '029_messaging_conversation_archive.sql',
  '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql',
  '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql',
  '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql',
  '042_unsuccessful_visit_reason.sql',
  '043_job_card_schedule_and_assignment_history.sql',

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
  // Fixed created/expiry satisfy sessions_check and stay independent of CI wall clock.
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      sessionId,
      userId,
      hexToken(),
      new Date('2099-01-01T00:00:00.000Z'),
      new Date('2026-07-22T08:00:00.000Z'),
    ],
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

  it('suppresses a claimed delivery when offboarding wins the user lifecycle lock', async () => {
    await runWithFixture(async ({ pool, userId, deliveryId, at }) => {
      const repo = new PostgresWebPushRepository(pool);
      const claimed = (await repo.claimDueDeliveries({ limit: 4, at }))[0]!;
      const offboarding = await pool.connect();
      try {
        await offboarding.query('BEGIN');
        await offboarding.query(
          `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
          [userId],
        );
        await offboarding.query(
          `UPDATE users SET is_active = FALSE, version = version + 1 WHERE id = $1`,
          [userId],
        );

        let providerCalls = 0;
        const worker = repo.withDeliveryLifecycleLock(claimed, new Date(at.getTime() + 1_000), async (guard) => {
          if (guard.eligible) providerCalls++;
          return guard.eligible;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(providerCalls).toBe(0);
        await offboarding.query('COMMIT');
        await expect(worker).resolves.toBe(false);
        expect(providerCalls).toBe(0);
        const row = await pool.query<{ state: string; last_error_code: string | null }>(
          `SELECT state, last_error_code FROM web_push_deliveries WHERE id = $1`,
          [deliveryId],
        );
        expect(row.rows[0]).toMatchObject({ state: 'ABANDONED', last_error_code: 'SESSION_INACTIVE' });
      } finally {
        offboarding.release();
      }
    });
  });

  it('holds the user lifecycle lock through provider bookkeeping when dispatcher wins', async () => {
    await runWithFixture(async ({ pool, userId, subscriptionId, at }) => {
      const repo = new PostgresWebPushRepository(pool);
      const claimed = (await repo.claimDueDeliveries({ limit: 4, at }))[0]!;
      let providerStarted!: () => void;
      const providerReady = new Promise<void>((resolve) => { providerStarted = resolve; });
      let releaseProvider!: () => void;
      const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const worker = repo.withDeliveryLifecycleLock(claimed, new Date(at.getTime() + 1_000), async (guard) => {
        expect(guard.eligible).toBe(true);
        providerStarted();
        await providerRelease;
        await guard.recordDelivered({
          deliveryId: claimed.deliveryId,
          leaseToken: claimed.leaseToken,
          subscriptionId,
          at: new Date(at.getTime() + 2_000),
        });
        return 'delivered';
      });
      await providerReady;

      const offboarding = await pool.connect();
      let offboardingCommitted = false;
      try {
        await offboarding.query('BEGIN');
        const offboardingUpdate = offboarding.query(
          `UPDATE users SET is_active = FALSE, version = version + 1 WHERE id = $1`,
          [userId],
        ).then(async () => {
          await offboarding.query('COMMIT');
          offboardingCommitted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(offboardingCommitted).toBe(false);
        releaseProvider();
        await expect(worker).resolves.toBe('delivered');
        await offboardingUpdate;
        expect(offboardingCommitted).toBe(true);
      } finally {
        if (!offboardingCommitted) await offboarding.query('ROLLBACK').catch(() => undefined);
        offboarding.release();
      }
    });
  });

  it('uses the protected lifecycle phase on the real dispatcher-to-provider path', async () => {
    await runWithFixture(async ({ pool, at }) => {
      const repository = new PostgresWebPushRepository(pool);
      let providerCalls = 0;
      const dispatcher = createDispatcher({ pollIntervalMs: 10, gracePeriodMs: 500 }, {
        repository,
        sender: {
          send: async () => {
            providerCalls++;
            return { type: 'response' as const, statusCode: 201 };
          },
        },
        buildPayload: () => ({
          version: 1 as const,
          notificationId: 'notification-1',
          title: 'Test', body: 'Test', url: '/notifications',
        }),
        topicBuilder: () => 'topic-1',
        clock: () => at,
      });
      dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await dispatcher.stop();
      expect(providerCalls).toBe(1);
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

  // M1 — conversation entity round-trip: persisted entity type must survive claim
  it('claims conversation notifications with the real persisted entity type', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, organizationId, userId, at } = fixture;

      const { eventId } = await createRealtimeEvent(pool, organizationId, userId);
      const conversationId = randomUUID();
      const nId = randomUUID();
      await pool.query(
        `INSERT INTO in_app_notifications
           (id, organization_id, recipient_user_id, source_realtime_event_id,
            kind, entity_type, entity_id, created_at)
         VALUES ($1, $2, $3, CAST($4 AS BIGINT), 'message.received', 'conversation', $5, $6)`,
        [nId, organizationId, userId, eventId, conversationId, at],
      );
      const sub = (await pool.query<{ id: string }>(
        `SELECT subscription.id FROM web_push_subscriptions subscription
          WHERE subscription.organization_id = $1 AND subscription.recipient_user_id = $2`,
        [organizationId, userId],
      )).rows[0]!;
      await pool.query(
        `INSERT INTO web_push_deliveries
           (organization_id, notification_id, subscription_id, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, $4)`,
        [organizationId, nId, sub.id, at],
      );

      const repo = new PostgresWebPushRepository(pool);
      const claimed = await repo.claimDueDeliveries({ limit: 4, at });
      const delivery = claimed.find((d) => d.notification.id === nId);
      expect(delivery).toBeTruthy();
      expect(delivery!.notification.entityType).toBe('conversation');
      expect(delivery!.notification.entityId).toBe(conversationId);

      const record: NotificationRecord = {
        id: delivery!.notification.id,
        organizationId: delivery!.notification.organizationId,
        recipientUserId: delivery!.notification.recipientUserId,
        sourceRealtimeEventId: 0n,
        kind: delivery!.notification.kind as NotificationRecord['kind'],
        entityType: delivery!.notification.entityType as NotificationRecord['entityType'],
        entityId: delivery!.notification.entityId,
        createdAt: delivery!.notification.createdAt,
        readAt: delivery!.notification.readAt,
      };
      const payload = buildPushPayload(presentNotification(record));
      expect(payload.url).toBe(`/messages?conversation=${conversationId}`);
      expect(JSON.stringify(payload)).not.toContain('content');
    });
  });

  it('excludes conversation deliveries when requested and abandons pending/expired-lease conversation deliveries without touching live leases or job-card deliveries', async () => {
    await runWithFixture(async ({ pool, organizationId, userId, deliveryId: jobDeliveryId, at }) => {
      const repo = new PostgresWebPushRepository(pool);
      const subId = (await pool.query<{ id: string }>(
        `SELECT id FROM web_push_subscriptions WHERE organization_id = $1`, [organizationId],
      )).rows[0]!.id;

      const makeConvDelivery = async (state: 'PENDING' | 'CLAIMED', leaseUntil?: Date) => {
        const { eventId } = await createRealtimeEvent(pool, organizationId, userId);
        const nId = randomUUID();
        await pool.query(
          `INSERT INTO in_app_notifications
             (id, organization_id, recipient_user_id, source_realtime_event_id,
              kind, entity_type, entity_id, created_at)
           VALUES ($1, $2, $3, CAST($4 AS BIGINT), 'message.received', 'conversation', $5, $6)`,
          [nId, organizationId, userId, eventId, randomUUID(), at],
        );
        return (await pool.query<{ id: string }>(
          `INSERT INTO web_push_deliveries
             (organization_id, notification_id, subscription_id, state, lease_token, lease_until,
              next_attempt_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7) RETURNING id`,
          [
            organizationId, nId, subId, state,
            state === 'CLAIMED' ? randomUUID() : null,
            state === 'CLAIMED' ? leaseUntil : null,
            at,
          ],
        )).rows[0]!.id;
      };

      const pendingConvId = await makeConvDelivery('PENDING');
      const expiredConvId = await makeConvDelivery('CLAIMED', new Date(at.getTime() - 1_000));
      const liveConvId = await makeConvDelivery('CLAIMED', new Date(at.getTime() + 20_000));

      // Exclusion skips conversation deliveries while still claiming job-card deliveries.
      const excludedClaim = await repo.claimDueDeliveries({
        limit: 10, at, excludedEntityTypes: ['conversation'],
      });
      expect(excludedClaim.map((d) => d.deliveryId)).toEqual([jobDeliveryId]);

      // Reset job-card delivery back to PENDING so abandonModuleDisabledDeliveries proves it leaves job-card untouched.
      await pool.query(
        `UPDATE web_push_deliveries SET state = 'PENDING', lease_token = NULL, lease_until = NULL WHERE id = $1`,
        [jobDeliveryId],
      );

      const abandoned = await repo.abandonModuleDisabledDeliveries({
        entityTypes: ['conversation'], at, errorCode: 'MODULE_DISABLED',
      });
      expect(abandoned).toBe(2);

      const states = await pool.query<{ id: string; state: string; last_error_code: string | null; lease_token: string | null }>(
        `SELECT id, state, last_error_code, lease_token FROM web_push_deliveries`,
      );
      const byId = new Map(states.rows.map((r) => [r.id, r]));
      expect(byId.get(pendingConvId)).toMatchObject({ state: 'ABANDONED', last_error_code: 'MODULE_DISABLED', lease_token: null });
      expect(byId.get(expiredConvId)).toMatchObject({ state: 'ABANDONED', last_error_code: 'MODULE_DISABLED', lease_token: null });
      expect(byId.get(liveConvId)).toMatchObject({ state: 'CLAIMED' });
      expect(byId.get(jobDeliveryId)).toMatchObject({ state: 'PENDING' });
    });
  });
});

describe('Web Push cleanupDueDeliveries — PostgreSQL', () => {
  type DeliveryRow = {
    state: string;
    last_error_code: string | null;
    lease_token: string | null;
    abandoned_at: Date | null;
  };

  async function addDelivery(fixture: Fixture, subscriptionId = fixture.subscriptionId) {
    const { pool, organizationId, userId, at } = fixture;
    const { eventId, jobCardId } = await createRealtimeEvent(pool, organizationId, userId);
    const notificationId = await createNotification(
      pool, organizationId, userId, eventId, jobCardId, at,
    );
    const deliveryId = await createDelivery(pool, organizationId, notificationId, subscriptionId, at);
    return { notificationId, deliveryId };
  }

  async function markRead(pool: Pool, notificationId: string, at: Date) {
    await pool.query(`UPDATE in_app_notifications SET read_at = $2 WHERE id = $1`, [notificationId, at]);
  }

  async function claim(pool: Pool, deliveryId: string, leaseUntil: Date): Promise<string> {
    const leaseToken = randomUUID();
    await pool.query(
      `UPDATE web_push_deliveries
          SET state = 'CLAIMED', lease_token = $2, lease_until = $3, attempt_count = 1
        WHERE id = $1`,
      [deliveryId, leaseToken, leaseUntil],
    );
    return leaseToken;
  }

  async function readDelivery(pool: Pool, deliveryId: string): Promise<DeliveryRow> {
    return (await pool.query<DeliveryRow>(
      `SELECT state, last_error_code, lease_token, abandoned_at
         FROM web_push_deliveries WHERE id = $1`,
      [deliveryId],
    )).rows[0]!;
  }

  // A separate user/session/subscription so a subscription-level condition can be varied alone.
  async function addOtherSubscription(fixture: Fixture) {
    const { pool, organizationId, at } = fixture;
    const userId = await createUser(pool, organizationId);
    const sessionId = await createSession(pool, userId);
    const subscriptionId = await createSubscription(pool, organizationId, userId, sessionId, at);
    const { eventId, jobCardId } = await createRealtimeEvent(pool, organizationId, userId);
    const notificationId = await createNotification(
      pool, organizationId, userId, eventId, jobCardId, at,
    );
    const deliveryId = await createDelivery(pool, organizationId, notificationId, subscriptionId, at);
    return { userId, sessionId, subscriptionId, deliveryId };
  }

  it('abandons a PENDING delivery whose notification is read', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at } = fixture;
      const { notificationId, deliveryId } = await addDelivery(fixture);
      await markRead(pool, notificationId, at);

      const repo = new PostgresWebPushRepository(pool);
      // The fixture's own delivery is healthy and must stay untouched.
      expect(await repo.cleanupDueDeliveries(at)).toBe(1);

      const row = await readDelivery(pool, deliveryId);
      expect(row.state).toBe('ABANDONED');
      expect(row.last_error_code).toBe('READ');
      expect(row.lease_token).toBeNull();
      expect(row.abandoned_at?.toISOString()).toBe(at.toISOString());
    });
  });

  it('joins each delivery to its own notification', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at, deliveryId: unreadDeliveryId } = fixture;
      const { notificationId, deliveryId: readDeliveryId } = await addDelivery(fixture);
      await markRead(pool, notificationId, at);

      const repo = new PostgresWebPushRepository(pool);
      expect(await repo.cleanupDueDeliveries(at)).toBe(1);

      expect((await readDelivery(pool, readDeliveryId)).state).toBe('ABANDONED');
      expect((await readDelivery(pool, unreadDeliveryId)).state).toBe('PENDING');
    });
  });

  it('leaves a CLAIMED delivery with an active lease untouched', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at, deliveryId } = fixture;
      const leaseToken = await claim(pool, deliveryId, new Date(at.getTime() + 30_000));
      await pool.query(
        `UPDATE in_app_notifications SET read_at = $2
          WHERE id = (SELECT notification_id FROM web_push_deliveries WHERE id = $1)`,
        [deliveryId, at],
      );

      const repo = new PostgresWebPushRepository(pool);
      expect(await repo.cleanupDueDeliveries(at)).toBe(0);

      const row = await readDelivery(pool, deliveryId);
      expect(row.state).toBe('CLAIMED');
      expect(row.lease_token).toBe(leaseToken);
      expect(row.last_error_code).toBeNull();
    });
  });

  it('abandons a CLAIMED delivery with an expired lease and a terminal condition', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at } = fixture;
      const stale = await addDelivery(fixture);
      await pool.query(
        `UPDATE web_push_deliveries SET created_at = $2 WHERE id = $1`,
        [stale.deliveryId, new Date(at.getTime() - 25 * 3_600_000)],
      );
      await claim(pool, stale.deliveryId, new Date(at.getTime() - 1_000));

      const exhausted = await addDelivery(fixture);
      await claim(pool, exhausted.deliveryId, at);
      await pool.query(
        `UPDATE web_push_deliveries SET attempt_count = 6 WHERE id = $1`,
        [exhausted.deliveryId],
      );

      const repo = new PostgresWebPushRepository(pool);
      expect(await repo.cleanupDueDeliveries(at)).toBe(2);

      const staleRow = await readDelivery(pool, stale.deliveryId);
      expect(staleRow.state).toBe('ABANDONED');
      expect(staleRow.last_error_code).toBe('EXPIRED');
      expect(staleRow.lease_token).toBeNull();
      const exhaustedRow = await readDelivery(pool, exhausted.deliveryId);
      expect(exhaustedRow.state).toBe('ABANDONED');
      expect(exhaustedRow.last_error_code).toBe('MAX_ATTEMPTS');
    });
  });

  it('leaves a healthy PENDING delivery untouched', async () => {
    await runWithFixture(async ({ pool, at, deliveryId }) => {
      const repo = new PostgresWebPushRepository(pool);
      expect(await repo.cleanupDueDeliveries(at)).toBe(0);

      const row = await readDelivery(pool, deliveryId);
      expect(row.state).toBe('PENDING');
      expect(row.last_error_code).toBeNull();
    });
  });

  it('abandons deliveries of a disabled subscription, inactive recipient and revoked session', async () => {
    await runWithFixture(async (fixture) => {
      const { pool, at } = fixture;

      const disabled = await addOtherSubscription(fixture);
      await pool.query(
        `UPDATE web_push_subscriptions
            SET disabled_at = $2, disabled_reason = 'USER_DISABLED'
          WHERE id = $1`,
        [disabled.subscriptionId, at],
      );
      const inactive = await addOtherSubscription(fixture);
      await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [inactive.userId]);
      const revoked = await addOtherSubscription(fixture);
      await pool.query(`UPDATE sessions SET revoked_at = $2 WHERE id = $1`, [revoked.sessionId, at]);

      const repo = new PostgresWebPushRepository(pool);
      expect(await repo.cleanupDueDeliveries(at)).toBe(3);

      const disabledRow = await readDelivery(pool, disabled.deliveryId);
      expect(disabledRow.state).toBe('ABANDONED');
      expect(disabledRow.last_error_code).toBe('SUBSCRIPTION_DISABLED');
      const inactiveRow = await readDelivery(pool, inactive.deliveryId);
      expect(inactiveRow.state).toBe('ABANDONED');
      expect(inactiveRow.last_error_code).toBe('SESSION_INACTIVE');
      const revokedRow = await readDelivery(pool, revoked.deliveryId);
      expect(revokedRow.state).toBe('ABANDONED');
      expect(revokedRow.last_error_code).toBe('SESSION_INACTIVE');
      expect((await readDelivery(pool, fixture.deliveryId)).state).toBe('PENDING');
    });
  });
});
