import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  PostgresWebPushRepository,
  PostgresWebPushTransaction,
  WebPushOwnershipConflictError,
} from '../src/modules/web-push/repository.js';

const migrationUrl = new URL(
  '../src/db/migrations/014_create_web_push.sql',
  import.meta.url,
);

describe('014 Web Push migration', () => {
  it('defines tenant-safe, session-safe subscription storage', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toMatch(
      /ALTER TABLE sessions[\s\S]*UNIQUE \(user_id, id\)/i,
    );
    expect(sql).toContain('CREATE TABLE web_push_subscriptions');
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, recipient_user_id\)[\s\S]*REFERENCES users \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(recipient_user_id, session_id\)[\s\S]*REFERENCES sessions \(user_id, id\)/i,
    );
    expect(sql).toMatch(/endpoint_hash CHAR\(64\) NOT NULL UNIQUE/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX web_push_subscriptions_active_session_idx[\s\S]*WHERE disabled_at IS NULL/i,
    );
    expect(sql).toMatch(/consecutive_failures[\s\S]*BETWEEN 0 AND 6/i);
    expect(sql).toMatch(/disabled_reason[\s\S]*'PROVIDER_STALE'[\s\S]*'VAPID_ROTATED'/i);
  });

  it('defines a constrained tenant-safe delivery outbox', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain('CREATE TABLE web_push_deliveries');
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, notification_id\)[\s\S]*REFERENCES in_app_notifications \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, subscription_id\)[\s\S]*REFERENCES web_push_subscriptions \(organization_id, id\)/i,
    );
    expect(sql).toMatch(/UNIQUE \(notification_id, subscription_id\)/i);
    expect(sql).toMatch(/state IN \('PENDING', 'CLAIMED', 'DELIVERED', 'ABANDONED'\)/i);
    expect(sql).toMatch(/attempt_count BETWEEN 0 AND 6/i);
    expect(sql).toContain('web_push_deliveries_due_idx');
    expect(sql).toContain('web_push_deliveries_subscription_idx');
  });
});

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
] as const;

async function applyMigrations(pool: Pool) {
  for (const migration of migrations) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

describe.skipIf(!databaseUrl)('014 Web Push PostgreSQL migration', () => {
  it('enforces subscription ownership, delivery identity, and outbox indexes', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `web_push_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationOne = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Push one') RETURNING id`,
      )).rows[0]!.id;
      const organizationTwo = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Push two') RETURNING id`,
      )).rows[0]!.id;
      const userOne = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Push one', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationOne, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const userTwo = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Push two', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationTwo, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const userThree = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Push three', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationOne, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const sessionOne = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userOne, '1'.repeat(64)],
      )).rows[0]!.id;
      const sessionTwo = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userTwo, '2'.repeat(64)],
      )).rows[0]!.id;
      const sessionThree = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userThree, '3'.repeat(64)],
      )).rows[0]!.id;

      const subscriptionOne = (await pool.query<{ id: string }>(
        `INSERT INTO web_push_subscriptions
           (organization_id, recipient_user_id, session_id, endpoint,
            endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'p256dh', 'auth', $6)
         RETURNING id`,
        [
          organizationOne,
          userOne,
          sessionOne,
          'https://fcm.googleapis.com/push/one',
          'a'.repeat(64),
          'b'.repeat(64),
        ],
      )).rows[0]!.id;

      await expect(pool.query(
        `INSERT INTO web_push_subscriptions
           (organization_id, recipient_user_id, session_id, endpoint,
            endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
         VALUES ($1, $2, $3, 'https://fcm.googleapis.com/push/cross-org',
                 $4, 'p256dh', 'auth', $5)`,
        [organizationOne, userTwo, sessionTwo, 'c'.repeat(64), 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23503' });

      await expect(pool.query(
        `INSERT INTO web_push_subscriptions
           (organization_id, recipient_user_id, session_id, endpoint,
            endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
         VALUES ($1, $2, $3, 'https://fcm.googleapis.com/push/wrong-session',
                 $4, 'p256dh', 'auth', $5)`,
        [organizationOne, userOne, sessionThree, 'd'.repeat(64), 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23503' });

      await expect(pool.query(
        `INSERT INTO web_push_subscriptions
           (organization_id, recipient_user_id, session_id, endpoint,
            endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
         VALUES ($1, $2, $3, 'https://fcm.googleapis.com/push/duplicate',
                 $4, 'p256dh', 'auth', $5)`,
        [organizationOne, userThree, sessionThree, 'a'.repeat(64), 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23505' });

      await expect(pool.query(
        `INSERT INTO web_push_subscriptions
           (organization_id, recipient_user_id, session_id, endpoint,
            endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
         VALUES ($1, $2, $3, 'https://fcm.googleapis.com/push/same-session',
                 $4, 'p256dh', 'auth', $5)`,
        [organizationOne, userOne, sessionOne, 'e'.repeat(64), 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23505' });

      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Push delivery', $2, $2) RETURNING id`,
        [organizationOne, userOne],
      )).rows[0]!.id;
      const activityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_APPROVED') RETURNING id`,
        [organizationOne, jobCardId, userOne],
      )).rows[0]!.id;
      const eventId = (await pool.query<{ id: string }>(
        `INSERT INTO realtime_events
           (organization_id, source_activity_id, event_type, entity_type,
            entity_id, actor_user_id, audience_roles, audience_user_ids, resource_keys)
         VALUES ($1, $2, 'job.approved', 'job-card', $3, $4,
                 ARRAY[]::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
         RETURNING id::text AS id`,
        [organizationOne, activityId, jobCardId, userOne],
      )).rows[0]!.id;
      const notificationId = (await pool.query<{ id: string }>(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id,
            kind, entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.approved', 'job-card', $4) RETURNING id`,
        [organizationOne, userOne, eventId, jobCardId],
      )).rows[0]!.id;

      await pool.query(
        `INSERT INTO web_push_deliveries
           (organization_id, notification_id, subscription_id)
         VALUES ($1, $2, $3)`,
        [organizationOne, notificationId, subscriptionOne],
      );
      await expect(pool.query(
        `INSERT INTO web_push_deliveries
           (organization_id, notification_id, subscription_id)
         VALUES ($1, $2, $3)`,
        [organizationOne, notificationId, subscriptionOne],
      )).rejects.toMatchObject({ code: '23505' });
      await expect(pool.query(
        `INSERT INTO web_push_deliveries
           (organization_id, notification_id, subscription_id, state)
         VALUES ($1, $2, $3, 'CLAIMED')`,
        [organizationOne, notificationId, subscriptionOne],
      )).rejects.toMatchObject({ code: '23514' });

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = $1
            AND tablename IN ('web_push_subscriptions', 'web_push_deliveries')`,
        [schema],
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
        'web_push_subscriptions_active_session_idx',
        'web_push_subscriptions_recipient_idx',
        'web_push_subscriptions_session_cleanup_idx',
        'web_push_deliveries_due_idx',
        'web_push_deliveries_subscription_idx',
      ]));
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('executes idempotent create, same-user rebind, opaque conflict, replacement, and cleanup', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `web_push_repository_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;

    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await applyMigrations(pool);

      const organizationOne = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Repository one') RETURNING id`,
      )).rows[0]!.id;
      const organizationTwo = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Repository two') RETURNING id`,
      )).rows[0]!.id;
      const userOne = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Owner', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationOne, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const userTwo = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Other owner', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationTwo, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const sessionOne = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userOne, '4'.repeat(64)],
      )).rows[0]!.id;
      const sessionTwo = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userOne, '5'.repeat(64)],
      )).rows[0]!.id;
      const otherSession = (await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
        [userTwo, '6'.repeat(64)],
      )).rows[0]!.id;
      const repository = new PostgresWebPushRepository(pool);
      const endpoint = 'https://fcm.googleapis.com/push/rebind';
      const baseInput = {
        organizationId: organizationOne,
        userId: userOne,
        sessionId: sessionOne,
        endpoint,
        p256dh: 'first-p256dh',
        auth: 'first-auth',
        expirationTime: null,
        vapidPublicKeyFingerprint: 'b'.repeat(64),
        now: new Date('2026-07-22T08:00:00.000Z'),
      };

      const [first, retried] = await Promise.all([
        repository.upsert(baseInput),
        repository.upsert(baseInput),
      ]);
      expect(retried.id).toBe(first.id);
      expect((await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM web_push_subscriptions`,
      )).rows[0]!.count).toBe(1);

      const rebound = await repository.upsert({
        ...baseInput,
        sessionId: sessionTwo,
        p256dh: 'refreshed-p256dh',
        auth: 'refreshed-auth',
        now: new Date('2026-07-22T08:05:00.000Z'),
      });
      expect(rebound).toMatchObject({ id: first.id, sessionId: sessionTwo });

      await expect(repository.upsert({
        ...baseInput,
        organizationId: organizationTwo,
        userId: userTwo,
        sessionId: otherSession,
      })).rejects.toBeInstanceOf(WebPushOwnershipConflictError);
      expect((await pool.query<{
        organization_id: string;
        recipient_user_id: string;
        session_id: string;
      }>(
        `SELECT organization_id, recipient_user_id, session_id
           FROM web_push_subscriptions WHERE id = $1`,
        [first.id],
      )).rows[0]).toEqual({
        organization_id: organizationOne,
        recipient_user_id: userOne,
        session_id: sessionTwo,
      });

      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Repository delivery', $2, $2) RETURNING id`,
        [organizationOne, userOne],
      )).rows[0]!.id;
      const activityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_APPROVED') RETURNING id`,
        [organizationOne, jobCardId, userOne],
      )).rows[0]!.id;
      const eventId = (await pool.query<{ id: string }>(
        `INSERT INTO realtime_events
           (organization_id, source_activity_id, event_type, entity_type,
            entity_id, actor_user_id, audience_roles, audience_user_ids, resource_keys)
         VALUES ($1, $2, 'job.approved', 'job-card', $3, $4,
                 ARRAY[]::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
         RETURNING id::text AS id`,
        [organizationOne, activityId, jobCardId, userOne],
      )).rows[0]!.id;
      const notificationId = (await pool.query<{ id: string }>(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id,
            kind, entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.approved', 'job-card', $4) RETURNING id`,
        [organizationOne, userOne, eventId, jobCardId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO web_push_deliveries
           (organization_id, notification_id, subscription_id)
         VALUES ($1, $2, $3)`,
        [organizationOne, notificationId, first.id],
      );

      const replacement = await repository.upsert({
        ...baseInput,
        sessionId: sessionTwo,
        endpoint: 'https://fcm.googleapis.com/push/replacement',
        now: new Date('2026-07-22T08:10:00.000Z'),
      });
      expect(replacement.id).not.toBe(first.id);
      expect((await pool.query<{ disabled_reason: string }>(
        `SELECT disabled_reason FROM web_push_subscriptions WHERE id = $1`,
        [first.id],
      )).rows[0]!.disabled_reason).toBe('REPLACED');
      expect((await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE subscription_id = $1`,
        [first.id],
      )).rows[0]!.state).toBe('ABANDONED');

      const transaction = new PostgresWebPushTransaction(pool);
      const appended = await transaction.appendDeliveries({
        organizationId: organizationOne,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T08:12:00.000Z'),
      });
      expect(appended).toHaveLength(1);
      await expect(transaction.appendDeliveries({
        organizationId: organizationOne,
        notificationIds: [notificationId],
        at: new Date('2026-07-22T08:12:00.000Z'),
      })).resolves.toEqual([]);

      await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [sessionTwo]);
      await expect(repository.cleanupInactiveSessions(
        new Date('2026-07-22T08:15:00.000Z'),
      )).resolves.toBe(1);
      expect((await repository.findCurrentSession({
        organizationId: organizationOne,
        userId: userOne,
        sessionId: sessionTwo,
      }))).toMatchObject({
        id: replacement.id,
        disabledReason: 'SESSION_INACTIVE',
      });
      expect((await pool.query<{ state: string }>(
        `SELECT state FROM web_push_deliveries WHERE id = $1`,
        [appended[0]],
      )).rows[0]!.state).toBe('ABANDONED');
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
