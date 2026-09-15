import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresNotificationRepository,
} from '../src/modules/notifications/repository.js';
import { PostgresWebPushTransaction } from '../src/modules/web-push/repository.js';
import { PostgresNotificationTransaction } from '../src/modules/notifications/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

type Fixture = {
  pool: Pool;
  organizationId: string;
  viewerId: string;
  otherUserId: string;
  otherOrganizationId: string;
};

function hexToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

async function createUser(pool: Pool, organizationId: string, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
}

async function createNotification(
  pool: Pool,
  organizationId: string,
  recipientId: string,
  kind = 'job.approved',
): Promise<string> {
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'Dismiss matrix job', $2, $2) RETURNING id`,
    [organizationId, recipientId],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, organization_timezone, source, created_by)
     VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE', $3)`,
    [organizationId, jobCardId, recipientId],
  );
  const activityId = (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_APPROVED') RETURNING id`,
    [organizationId, jobCardId, recipientId],
  )).rows[0]!.id;
  const eventId = (await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type,
        entity_id, actor_user_id, audience_roles, audience_user_ids, resource_keys)
     VALUES ($1, $2, 'job.approved', 'job-card', $3, $4,
             ARRAY[]::VARCHAR(20)[], ARRAY[$4]::UUID[], ARRAY['notifications'])
     RETURNING id::text AS id`,
    [organizationId, activityId, jobCardId, recipientId],
  )).rows[0]!.id;
  const tx = new PostgresNotificationTransaction(pool as never);
  const appended = await tx.append({
    organizationId,
    sourceRealtimeEventId: BigInt(eventId),
    createdAt: new Date('2026-07-22T10:00:00.000Z'),
    drafts: [{ recipientUserId: recipientId, kind: kind as 'job.approved', entityType: 'job-card', entityId: jobCardId }],
  });
  return appended[0]!.id;
}

async function createPendingDelivery(pool: Pool, organizationId: string, userId: string, notificationId: string) {
  const sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
    [userId, hexToken()],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint,
        endpoint_hash, p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'p256dh', 'auth', $6)`,
    [organizationId, userId, sessionId, `https://push.example/${hexToken().slice(0, 16)}`, hexToken(), 'a'.repeat(64)],
  );
  const tx = new PostgresWebPushTransaction(pool as never);
  await tx.appendDeliveries({
    organizationId,
    notificationIds: [notificationId],
    at: new Date('2026-07-22T10:00:00.000Z'),
  });
}

async function deliveryState(pool: Pool, notificationId: string) {
  return pool.query<{ state: string; lease_token: string | null; lease_until: Date | null; last_error_code: string | null; abandoned_at: Date | null }>(
    `SELECT state, lease_token, lease_until, last_error_code, abandoned_at
       FROM web_push_deliveries WHERE notification_id = $1`,
    [notificationId],
  );
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const schema = `dismiss_matrix_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  try {
    await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store: new PostgresMigrationStore(pool) });
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Dismiss matrix') RETURNING id`,
    )).rows[0]!.id;
    const viewerId = await createUser(pool, organizationId, 'Viewer');
    const otherUserId = await createUser(pool, organizationId, 'Other');
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Dismiss matrix other') RETURNING id`,
    )).rows[0]!.id;
    await run({ pool, organizationId, viewerId, otherUserId, otherOrganizationId });
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

describe.skipIf(!databaseUrl)('N2 dismiss / clear PostgreSQL behavior', () => {
  it('dismisses an unread notification without marking it read', async () => {
    await withFixture(async ({ pool, organizationId, viewerId }) => {
      const repository = new PostgresNotificationRepository(pool);
      const id = await createNotification(pool, organizationId, viewerId);

      await expect(repository.dismiss(
        { organizationId, userId: viewerId }, id,
      )).resolves.toBe(true);

      const row = await pool.query<{ read_at: Date | null; dismissed_at: Date | null }>(
        'SELECT read_at, dismissed_at FROM in_app_notifications WHERE id = $1', [id],
      );
      expect(row.rows[0]!.read_at).toBeNull();
      expect(row.rows[0]!.dismissed_at).toBeInstanceOf(Date);
      await expect(repository.unreadCount({ organizationId, userId: viewerId })).resolves.toBe(0);
    });
  });

  it('unread dismiss abandons its PENDING delivery with DISMISSED', async () => {
    await withFixture(async ({ pool, organizationId, viewerId }) => {
      const repository = new PostgresNotificationRepository(pool);
      const id = await createNotification(pool, organizationId, viewerId);
      await createPendingDelivery(pool, organizationId, viewerId, id);
      const otherId = await createNotification(pool, organizationId, viewerId, 'job.cancelled');
      await createPendingDelivery(pool, organizationId, viewerId, otherId);

      await repository.dismiss({ organizationId, userId: viewerId }, id);

      const touched = (await deliveryState(pool, id)).rows[0]!;
      expect(touched.state).toBe('ABANDONED');
      expect(touched.lease_token).toBeNull();
      expect(touched.lease_until).toBeNull();
      expect(touched.last_error_code).toBe('DISMISSED');
      expect(touched.abandoned_at).toBeInstanceOf(Date);
      const untouched = (await deliveryState(pool, otherId)).rows[0]!;
      expect(untouched.state).toBe('PENDING');
    });
  });

  it('dismiss of another recipient or organization reports absence', async () => {
    await withFixture(async ({ pool, organizationId, viewerId, otherUserId, otherOrganizationId }) => {
      const repository = new PostgresNotificationRepository(pool);
      const id = await createNotification(pool, organizationId, viewerId);

      await expect(repository.dismiss(
        { organizationId, userId: otherUserId }, id,
      )).resolves.toBe(false);
      await expect(repository.dismiss(
        { organizationId: otherOrganizationId, userId: viewerId }, id,
      )).resolves.toBe(false);
    });
  });

  it('clear-all dismisses read and unread rows, preserves read_at, and is repeatable', async () => {
    await withFixture(async ({ pool, organizationId, viewerId }) => {
      const repository = new PostgresNotificationRepository(pool);
      const unreadId = await createNotification(pool, organizationId, viewerId);
      const readId = await createNotification(pool, organizationId, viewerId, 'job.cancelled');
      await repository.markRead({ organizationId, userId: viewerId }, readId);
      await createPendingDelivery(pool, organizationId, viewerId, unreadId);

      await expect(repository.clearAll({ organizationId, userId: viewerId })).resolves.toBe(2);

      const rows = await pool.query<{ id: string; read_at: Date | null; dismissed_at: Date | null }>(
        'SELECT id, read_at, dismissed_at FROM in_app_notifications ORDER BY id',
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) expect(row.dismissed_at).toBeInstanceOf(Date);
      expect(rows.rows.find((row) => row.id === unreadId)!.read_at).toBeNull();
      expect(rows.rows.find((row) => row.id === readId)!.read_at).toBeInstanceOf(Date);
      await expect(repository.unreadCount({ organizationId, userId: viewerId })).resolves.toBe(0);
      const touched = (await deliveryState(pool, unreadId)).rows[0]!;
      expect(touched.state).toBe('ABANDONED');
      expect(touched.last_error_code).toBe('DISMISSED');

      await expect(repository.clearAll({ organizationId, userId: viewerId })).resolves.toBe(0);
    });
  });

  it('clear-all is viewer and organization scoped', async () => {
    await withFixture(async ({ pool, organizationId, viewerId, otherUserId, otherOrganizationId }) => {
      const repository = new PostgresNotificationRepository(pool);
      await createNotification(pool, organizationId, viewerId);
      const otherViewerId = await createUser(pool, otherOrganizationId, 'Foreign');
      await createNotification(pool, otherOrganizationId, otherViewerId);

      await expect(repository.clearAll({ organizationId, userId: otherUserId })).resolves.toBe(0);
      await expect(repository.unreadCount({ organizationId, userId: viewerId })).resolves.toBe(1);
      await expect(repository.unreadCount(
        { organizationId: otherOrganizationId, userId: otherViewerId },
      )).resolves.toBe(1);
    });
  });

  it('clear-read leaves unread rows active', async () => {
    await withFixture(async ({ pool, organizationId, viewerId }) => {
      const repository = new PostgresNotificationRepository(pool);
      const unreadId = await createNotification(pool, organizationId, viewerId);
      const readId = await createNotification(pool, organizationId, viewerId, 'job.cancelled');
      await repository.markRead({ organizationId, userId: viewerId }, readId);

      await expect(repository.clearRead({ organizationId, userId: viewerId })).resolves.toBe(1);

      const rows = await pool.query<{ id: string; dismissed_at: Date | null }>(
        'SELECT id, dismissed_at FROM in_app_notifications',
      );
      expect(rows.rows.find((row) => row.id === unreadId)!.dismissed_at).toBeNull();
      expect(rows.rows.find((row) => row.id === readId)!.dismissed_at).toBeInstanceOf(Date);
      await expect(repository.unreadCount({ organizationId, userId: viewerId })).resolves.toBe(1);
    });
  });
});
