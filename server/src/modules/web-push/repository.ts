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

export interface WebPushRepository {
  findCurrentSession(identity: WebPushIdentity): Promise<WebPushSubscriptionRecord | null>;
  upsert(input: UpsertWebPushSubscriptionInput): Promise<WebPushSubscriptionRecord>;
  disable(
    identity: WebPushIdentity,
    subscriptionId: string,
    reason: WebPushDisabledReason,
    at: Date,
  ): Promise<WebPushSubscriptionRecord | null>;
  cleanupDueDeliveries(at: Date): Promise<number>;
  claimDueDeliveries(input: ClaimDueWebPushDeliveriesInput): Promise<readonly ClaimedWebPushDelivery[]>;
  recordDelivered(input: RecordDeliveredInput): Promise<boolean>;
  recordRetry(input: RecordRetryInput): Promise<boolean>;
  recordAbandoned(input: RecordAbandonedInput): Promise<boolean>;
  recordProviderStale(input: RecordProviderStaleInput): Promise<boolean>;
}

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

export class PostgresWebPushRepository implements WebPushRepository {
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

  // ── Dispatch port ──────────────────────────────────────────────────────

  async cleanupDueDeliveries(at: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `UPDATE web_push_deliveries delivery
            SET state = 'ABANDONED',
                lease_token = NULL,
                lease_until = NULL,
                abandoned_at = $1,
                updated_at = $1,
                last_error_code = CASE
                  WHEN notification.read_at IS NOT NULL THEN 'READ'
                  WHEN subscription.disabled_at IS NOT NULL THEN 'SUBSCRIPTION_DISABLED'
                  WHEN recipient.is_active = FALSE THEN 'SESSION_INACTIVE'
                  WHEN session_record.revoked_at IS NOT NULL OR session_record.expires_at <= $1 THEN 'SESSION_INACTIVE'
                  WHEN subscription.expiration_time IS NOT NULL AND subscription.expiration_time <= $1 THEN 'EXPIRED'
                  WHEN delivery.created_at <= $1 - INTERVAL '24 hours' THEN 'EXPIRED'
                  WHEN delivery.attempt_count >= 6 THEN 'MAX_ATTEMPTS'
                  ELSE 'UNKNOWN'
                END
           FROM in_app_notifications notification
           JOIN web_push_subscriptions subscription ON subscription.id = delivery.subscription_id
           JOIN users recipient ON recipient.id = subscription.recipient_user_id
           JOIN sessions session_record ON session_record.id = subscription.session_id
          WHERE delivery.state IN ('PENDING', 'CLAIMED')
            AND (
              (delivery.state = 'CLAIMED' AND delivery.lease_until > $1)
              OR delivery.id IS NOT NULL
            )
            AND (
              notification.read_at IS NOT NULL
              OR subscription.disabled_at IS NOT NULL
              OR recipient.is_active = FALSE
              OR session_record.revoked_at IS NOT NULL
              OR session_record.expires_at <= $1
              OR (subscription.expiration_time IS NOT NULL AND subscription.expiration_time <= $1)
              OR delivery.created_at <= $1 - INTERVAL '24 hours'
              OR delivery.attempt_count >= 6
            )
            AND delivery.id = delivery.id
          RETURNING delivery.id`,
        [at],
      );
      await client.query('COMMIT');
      return result.rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueDeliveries(
    input: ClaimDueWebPushDeliveriesInput,
  ): Promise<readonly ClaimedWebPushDelivery[]> {
    if (input.limit <= 0) return [];

    const client = await this.pool.connect();
    try {
      const result = await client.query<WebPushClaimedDeliveryRow>(
        `WITH eligible AS (
          SELECT delivery.id, delivery.notification_id, delivery.subscription_id
            FROM web_push_deliveries delivery
            JOIN in_app_notifications notification
              ON notification.id = delivery.notification_id
             AND notification.read_at IS NULL
            JOIN web_push_subscriptions subscription
              ON subscription.id = delivery.subscription_id
             AND subscription.disabled_at IS NULL
             AND (
               subscription.expiration_time IS NULL
               OR subscription.expiration_time > $1
             )
            JOIN users recipient
              ON recipient.id = subscription.recipient_user_id
             AND recipient.is_active = TRUE
            JOIN sessions session_record
              ON session_record.id = subscription.session_id
             AND session_record.revoked_at IS NULL
             AND session_record.expires_at > $1
           WHERE delivery.state IN ('PENDING', 'CLAIMED')
             AND (
               (delivery.state = 'PENDING' AND delivery.next_attempt_at <= $1)
               OR (delivery.state = 'CLAIMED' AND delivery.lease_until <= $1)
             )
             AND delivery.attempt_count < 6
             AND delivery.created_at > $1 - INTERVAL '24 hours'
           ORDER BY delivery.next_attempt_at ASC, delivery.id ASC
           LIMIT $2
           FOR UPDATE OF delivery SKIP LOCKED
        ),
        updated AS (
          UPDATE web_push_deliveries delivery
             SET state = 'CLAIMED',
                 attempt_count = delivery.attempt_count + 1,
                 lease_token = gen_random_uuid(),
                 lease_until = $1 + INTERVAL '30 seconds',
                 updated_at = $1
            FROM eligible
           WHERE delivery.id = eligible.id
          RETURNING delivery.id AS delivery_id,
                    delivery.lease_token,
                    delivery.attempt_count,
                    delivery.notification_id,
                    delivery.subscription_id
        )
        SELECT updated.delivery_id,
               updated.lease_token::text,
               updated.attempt_count,
               updated.notification_id,
               notification.id AS n_id,
               notification.organization_id,
               notification.recipient_user_id,
               notification.source_realtime_event_id,
               notification.kind,
               notification.entity_type,
               notification.entity_id,
               notification.created_at,
               notification.read_at,
               subscription.endpoint,
               subscription.p256dh,
               subscription.auth,
               subscription.id AS subscription_pk
          FROM updated
          JOIN in_app_notifications notification
            ON notification.id = updated.notification_id
          JOIN web_push_subscriptions subscription
            ON subscription.id = updated.subscription_id`,
        [input.at, input.limit],
      );
      return result.rows.map(mapClaimedDelivery);
    } finally {
      client.release();
    }
  }

  async recordDelivered(input: RecordDeliveredInput): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE web_push_deliveries
          SET state = 'DELIVERED',
              lease_token = NULL,
              lease_until = NULL,
              delivered_at = $3,
              last_error_code = NULL,
              updated_at = $3
        WHERE id = $1
          AND state = 'CLAIMED'
          AND lease_token = $2`,
      [input.deliveryId, input.leaseToken, input.at],
    );
    if (result.rowCount === 0) return false;

    const subResult = await this.pool.query(
      `UPDATE web_push_subscriptions
          SET consecutive_failures = 0,
              last_success_at = $2,
              last_failure_at = NULL,
              updated_at = $2
        WHERE id = $1`,
      [input.subscriptionId, input.at],
    );
    return subResult.rowCount !== null && subResult.rowCount > 0;
  }

  async recordRetry(input: RecordRetryInput): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE web_push_deliveries
          SET state = 'PENDING',
              lease_token = NULL,
              lease_until = NULL,
              next_attempt_at = $4,
              last_error_code = $5,
              updated_at = $3
        WHERE id = $1
          AND state = 'CLAIMED'
          AND lease_token = $2`,
      [input.deliveryId, input.leaseToken, input.at, input.nextAttemptAt, input.errorCode],
    );
    if (result.rowCount === 0) return false;

    await this.pool.query(
      `UPDATE web_push_subscriptions
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_at = $2,
              updated_at = $2
        WHERE id = $1`,
      [input.subscriptionId, input.at],
    );
    return true;
  }

  async recordAbandoned(input: RecordAbandonedInput): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE web_push_deliveries
          SET state = 'ABANDONED',
              lease_token = NULL,
              lease_until = NULL,
              abandoned_at = $3,
              last_error_code = $4,
              updated_at = $3
        WHERE id = $1
          AND state = 'CLAIMED'
          AND lease_token = $2`,
      [input.deliveryId, input.leaseToken, input.at, input.errorCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordProviderStale(input: RecordProviderStaleInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deliveryResult = await client.query(
        `UPDATE web_push_deliveries
            SET state = 'ABANDONED',
                lease_token = NULL,
                lease_until = NULL,
                abandoned_at = $3,
                last_error_code = $4,
                updated_at = $3
          WHERE id = $1
            AND state = 'CLAIMED'
            AND lease_token = $2
        RETURNING subscription_id`,
        [input.deliveryId, input.leaseToken, input.at, input.errorCode],
      );

      if (deliveryResult.rowCount === 0 || !deliveryResult.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }

      const subscriptionId = deliveryResult.rows[0]!.subscription_id;
      await client.query(
        `UPDATE web_push_subscriptions
            SET disabled_at = $2,
                disabled_reason = 'PROVIDER_STALE',
                consecutive_failures = consecutive_failures + 1,
                last_failure_at = $2,
                updated_at = $2
          WHERE id = $1
            AND disabled_at IS NULL`,
        [subscriptionId, input.at],
      );

      await client.query(
        `UPDATE web_push_deliveries
            SET state = 'ABANDONED',
                lease_token = NULL,
                lease_until = NULL,
                abandoned_at = $2,
                updated_at = $2,
                last_error_code = 'SUBSCRIPTION_DISABLED'
          WHERE subscription_id = $1
            AND state IN ('PENDING', 'CLAIMED')
            AND (state != 'CLAIMED' OR lease_until <= $2)`,
        [subscriptionId, input.at],
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

// ── Dispatch types ──────────────────────────────────────────────────────

export type ClaimedWebPushDelivery = Readonly<{
  deliveryId: string;
  leaseToken: string;
  attemptCount: number;
  notification: Readonly<{
    id: string;
    organizationId: string;
    recipientUserId: string;
    kind: string;
    entityType: string;
    entityId: string;
    createdAt: Date;
    readAt: Date | null;
  }>;
  subscription: Readonly<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
}>;

export type ClaimDueWebPushDeliveriesInput = Readonly<{
  limit: number;
  at: Date;
}>;

export type RecordDeliveredInput = Readonly<{
  deliveryId: string;
  leaseToken: string;
  subscriptionId: string;
  at: Date;
}>;

export type RecordRetryInput = Readonly<{
  deliveryId: string;
  leaseToken: string;
  subscriptionId: string;
  at: Date;
  nextAttemptAt: Date;
  errorCode: string;
}>;

export type RecordAbandonedInput = Readonly<{
  deliveryId: string;
  leaseToken: string;
  at: Date;
  errorCode: string;
}>;

export type RecordProviderStaleInput = Readonly<{
  deliveryId: string;
  leaseToken: string;
  at: Date;
  errorCode: string;
}>;

type WebPushClaimedDeliveryRow = {
  delivery_id: string;
  lease_token: string;
  attempt_count: number;
  notification_id: string;
  n_id: string;
  organization_id: string;
  recipient_user_id: string;
  source_realtime_event_id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  created_at: Date;
  read_at: Date | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  subscription_pk: string;
};

function mapClaimedDelivery(row: WebPushClaimedDeliveryRow): ClaimedWebPushDelivery {
  return {
    deliveryId: row.delivery_id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    notification: {
      id: row.n_id,
      organizationId: row.organization_id,
      recipientUserId: row.recipient_user_id,
      kind: row.kind,
      entityType: row.entity_type,
      entityId: row.entity_id,
      createdAt: row.created_at,
      readAt: row.read_at,
    },
    subscription: {
      id: row.subscription_pk,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}
