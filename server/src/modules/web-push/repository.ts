import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

export type PushSubscriptionMaterial = Readonly<{
  endpoint: string;
  p256dh: string;
  auth: string;
}>;

export type WebPushIdentity = Readonly<{
  organizationId: string;
  userId: string;
  sessionId: string;
}>;

export type WebPushDisabledReason =
  | 'USER_DISABLED'
  | 'REPLACED'
  | 'SESSION_INACTIVE'
  | 'PROVIDER_STALE'
  | 'VAPID_ROTATED';

type WebPushSubscriptionRow = {
  id: string;
  organization_id: string;
  recipient_user_id: string;
  session_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  expiration_time: Date | null;
  vapid_public_key_fingerprint: string;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
  disabled_reason: WebPushDisabledReason | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: number;
};

export type WebPushSubscriptionRecord = Readonly<{
  id: string;
  organizationId: string;
  recipientUserId: string;
  sessionId: string;
  endpoint: string;
  endpointHash: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
  vapidPublicKeyFingerprint: string;
  subscriptionFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  disabledReason: WebPushDisabledReason | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
}>;

export type UpsertWebPushSubscriptionInput = WebPushIdentity
  & PushSubscriptionMaterial
  & Readonly<{
    expirationTime: Date | null;
    vapidPublicKeyFingerprint: string;
    now: Date;
  }>;

export class WebPushOwnershipConflictError extends Error {
  constructor() {
    super('Web Push subscription ownership conflict');
    this.name = 'WebPushOwnershipConflictError';
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintPushEndpoint(endpoint: string): string {
  return sha256(endpoint);
}

export function fingerprintPushSubscription(
  material: PushSubscriptionMaterial,
): string {
  return sha256(`${material.endpoint}\n${material.p256dh}\n${material.auth}`);
}

export function fingerprintVapidPublicKey(publicKey: string): string {
  return sha256(Buffer.from(publicKey, 'base64url'));
}

const SUBSCRIPTION_COLUMNS = `id, organization_id, recipient_user_id, session_id,
  endpoint, endpoint_hash, p256dh, auth, expiration_time,
  vapid_public_key_fingerprint, created_at, updated_at, disabled_at,
  disabled_reason, last_success_at, last_failure_at, consecutive_failures`;

function mapSubscription(row: WebPushSubscriptionRow): WebPushSubscriptionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    recipientUserId: row.recipient_user_id,
    sessionId: row.session_id,
    endpoint: row.endpoint,
    endpointHash: row.endpoint_hash,
    p256dh: row.p256dh,
    auth: row.auth,
    expirationTime: row.expiration_time,
    vapidPublicKeyFingerprint: row.vapid_public_key_fingerprint,
    subscriptionFingerprint: fingerprintPushSubscription({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    consecutiveFailures: row.consecutive_failures,
  };
}

type WebPushPool = Pick<Pool, 'query' | 'connect'>;

export type AppendWebPushDeliveriesInput = Readonly<{
  organizationId: string;
  notificationIds: readonly string[];
  at: Date;
}>;

export class PostgresWebPushTransaction {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async appendDeliveries(input: AppendWebPushDeliveriesInput): Promise<readonly string[]> {
    if (input.notificationIds.length === 0) return [];

    const result = await this.client.query<{ id: string }>(
      `INSERT INTO web_push_deliveries
         (organization_id, notification_id, subscription_id,
          next_attempt_at, created_at, updated_at)
       SELECT notification.organization_id,
              notification.id,
              subscription.id,
              $3,
              $3,
              $3
         FROM in_app_notifications notification
         JOIN web_push_subscriptions subscription
           ON subscription.organization_id = notification.organization_id
          AND subscription.recipient_user_id = notification.recipient_user_id
          AND subscription.disabled_at IS NULL
          AND (
            subscription.expiration_time IS NULL
            OR subscription.expiration_time > $3
          )
         JOIN users recipient
           ON recipient.organization_id = subscription.organization_id
          AND recipient.id = subscription.recipient_user_id
          AND recipient.is_active = TRUE
         JOIN sessions session_record
           ON session_record.user_id = subscription.recipient_user_id
          AND session_record.id = subscription.session_id
          AND session_record.revoked_at IS NULL
          AND session_record.expires_at > $3
        WHERE notification.organization_id = $1
          AND notification.id = ANY($2::uuid[])
          AND notification.read_at IS NULL
       ON CONFLICT (notification_id, subscription_id) DO NOTHING
       RETURNING id`,
      [input.organizationId, input.notificationIds, input.at],
    );
    return result.rows.map((row) => row.id);
  }
}

export class PostgresWebPushRepository {
  constructor(private readonly pool: WebPushPool) {}

  async findCurrentSession(
    identity: WebPushIdentity,
  ): Promise<WebPushSubscriptionRecord | null> {
    const result = await this.pool.query<WebPushSubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM web_push_subscriptions
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND session_id = $3
        ORDER BY (disabled_at IS NULL) DESC, updated_at DESC
        LIMIT 1`,
      [identity.organizationId, identity.userId, identity.sessionId],
    );
    const row = result.rows[0];
    return row ? mapSubscription(row) : null;
  }

  async disable(
    identity: WebPushIdentity,
    subscriptionId: string,
    reason: WebPushDisabledReason,
    at: Date,
  ): Promise<WebPushSubscriptionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<WebPushSubscriptionRow>(
        `UPDATE web_push_subscriptions
            SET disabled_at = COALESCE(disabled_at, $5),
                disabled_reason = COALESCE(disabled_reason, $6),
                updated_at = CASE WHEN disabled_at IS NULL THEN $5 ELSE updated_at END
          WHERE organization_id = $1
            AND recipient_user_id = $2
            AND session_id = $3
            AND id = $4
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [
          identity.organizationId,
          identity.userId,
          identity.sessionId,
          subscriptionId,
          at,
          reason,
        ],
      );
      const row = result.rows[0];
      if (row) {
        await this.abandonDeliveries(client, [row.id], reason, at);
      }
      await client.query('COMMIT');
      return row ? mapSubscription(row) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsert(
    input: UpsertWebPushSubscriptionInput,
  ): Promise<WebPushSubscriptionRecord> {
    const client = await this.pool.connect();
    const endpointHash = fingerprintPushEndpoint(input.endpoint);
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [endpointHash],
      );
      const endpointOwnerResult = await client.query<WebPushSubscriptionRow>(
        `SELECT ${SUBSCRIPTION_COLUMNS}
           FROM web_push_subscriptions
          WHERE endpoint_hash = $1
          FOR UPDATE`,
        [endpointHash],
      );
      const endpointOwner = endpointOwnerResult.rows[0] ?? null;
      if (
        endpointOwner
        && (
          endpointOwner.organization_id !== input.organizationId
          || endpointOwner.recipient_user_id !== input.userId
        )
      ) {
        throw new WebPushOwnershipConflictError();
      }

      const currentResult = await client.query<WebPushSubscriptionRow>(
        `SELECT ${SUBSCRIPTION_COLUMNS}
           FROM web_push_subscriptions
          WHERE organization_id = $1
            AND recipient_user_id = $2
            AND session_id = $3
            AND disabled_at IS NULL
          FOR UPDATE`,
        [input.organizationId, input.userId, input.sessionId],
      );
      const current = currentResult.rows[0] ?? null;

      if (current && current.id !== endpointOwner?.id) {
        await this.disableSubscriptions(client, [current.id], 'REPLACED', input.now);
      }

      let saved: WebPushSubscriptionRow;
      if (endpointOwner) {
        if (endpointOwner.session_id !== input.sessionId) {
          await this.abandonDeliveries(
            client,
            [endpointOwner.id],
            'REPLACED',
            input.now,
          );
        }
        const updated = await client.query<WebPushSubscriptionRow>(
          `UPDATE web_push_subscriptions
              SET session_id = $2,
                  endpoint = $3,
                  p256dh = $4,
                  auth = $5,
                  expiration_time = $6,
                  vapid_public_key_fingerprint = $7,
                  updated_at = $8,
                  disabled_at = NULL,
                  disabled_reason = NULL,
                  last_failure_at = NULL,
                  consecutive_failures = 0
            WHERE id = $1
          RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [
            endpointOwner.id,
            input.sessionId,
            input.endpoint,
            input.p256dh,
            input.auth,
            input.expirationTime,
            input.vapidPublicKeyFingerprint,
            input.now,
          ],
        );
        saved = updated.rows[0]!;
      } else {
        const inserted = await client.query<WebPushSubscriptionRow>(
          `INSERT INTO web_push_subscriptions
             (organization_id, recipient_user_id, session_id, endpoint,
              endpoint_hash, p256dh, auth, expiration_time,
              vapid_public_key_fingerprint, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [
            input.organizationId,
            input.userId,
            input.sessionId,
            input.endpoint,
            endpointHash,
            input.p256dh,
            input.auth,
            input.expirationTime,
            input.vapidPublicKeyFingerprint,
            input.now,
          ],
        );
        saved = inserted.rows[0]!;
      }

      await client.query('COMMIT');
      return mapSubscription(saved);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupInactiveSessions(at: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const disabled = await client.query<{ id: string }>(
        `UPDATE web_push_subscriptions subscription
            SET disabled_at = $1,
                disabled_reason = 'SESSION_INACTIVE',
                updated_at = $1
           FROM sessions session_record
           JOIN users recipient ON recipient.id = session_record.user_id
          WHERE subscription.session_id = session_record.id
            AND subscription.recipient_user_id = recipient.id
            AND subscription.organization_id = recipient.organization_id
            AND subscription.disabled_at IS NULL
            AND (
              session_record.revoked_at IS NOT NULL
              OR session_record.expires_at <= $1
              OR recipient.is_active = FALSE
            )
        RETURNING subscription.id`,
        [at],
      );
      const subscriptionIds = disabled.rows.map((row) => row.id);
      if (subscriptionIds.length > 0) {
        await this.abandonDeliveries(client, subscriptionIds, 'SESSION_INACTIVE', at);
      }
      await client.query('COMMIT');
      return subscriptionIds.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async abandonDeliveries(
    client: Pick<PoolClient, 'query'>,
    subscriptionIds: readonly string[],
    errorCode: WebPushDisabledReason,
    at: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE web_push_deliveries
          SET state = 'ABANDONED',
              lease_token = NULL,
              lease_until = NULL,
              last_error_code = $2,
              abandoned_at = $3,
              updated_at = $3
        WHERE subscription_id = ANY($1::uuid[])
          AND state IN ('PENDING', 'CLAIMED')`,
      [subscriptionIds, errorCode, at],
    );
  }

  private async disableSubscriptions(
    client: Pick<PoolClient, 'query'>,
    subscriptionIds: readonly string[],
    reason: WebPushDisabledReason,
    at: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE web_push_subscriptions
          SET disabled_at = $2,
              disabled_reason = $3,
              updated_at = $2
        WHERE id = ANY($1::uuid[])
          AND disabled_at IS NULL`,
      [subscriptionIds, at, reason],
    );
    await this.abandonDeliveries(client, subscriptionIds, reason, at);
  }
}
