import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import type { RealtimeEventRecord } from '../realtime/types.js';

export type CalendarReminderClaim = Readonly<{
  id: string;
  organizationId: string;
  recipientUserId: string;
  jobCardId: string | null;
  calendarEventId: string | null;
  attemptCount: number;
  leaseToken: string;
}>;

export interface CalendarReminderWorkerRepository {
  claimDue(now: Date, leaseToken: string, leaseUntil: Date, limit: number): Promise<CalendarReminderClaim[]>;
  project(claim: CalendarReminderClaim, now: Date, webPushEnabled: boolean): Promise<RealtimeEventRecord | null>;
  retry(claim: CalendarReminderClaim, now: Date, nextAttemptAt: Date, errorCode: string): Promise<void>;
  abandon(claim: CalendarReminderClaim, now: Date, errorCode: string): Promise<void>;
  release(leaseToken: string, now: Date): Promise<void>;
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

export class PostgresCalendarReminderWorkerRepository
implements CalendarReminderWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async claimDue(now: Date, leaseToken: string, leaseUntil: Date, limit: number) {
    const result = await this.pool.query<{
      id: string; organization_id: string; recipient_user_id: string;
      job_card_id: string | null; calendar_event_id: string | null; attempt_count: number;
    }>(
      `WITH due AS (
         SELECT id FROM calendar_reminders
         WHERE (
           state = 'PENDING' AND next_attempt_at <= $1
           OR state = 'CLAIMED' AND lease_until <= $1
         )
         ORDER BY next_attempt_at ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT $4
       )
       UPDATE calendar_reminders r SET state = 'CLAIMED', lease_token = $2,
         lease_until = $3, attempt_count = attempt_count + 1, updated_at = $1
       FROM due WHERE r.id = due.id
       RETURNING r.id, r.organization_id, r.recipient_user_id,
         r.job_card_id, r.calendar_event_id, r.attempt_count`,
      [now, leaseToken, leaseUntil, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      recipientUserId: row.recipient_user_id,
      jobCardId: row.job_card_id,
      calendarEventId: row.calendar_event_id,
      attemptCount: row.attempt_count,
      leaseToken,
    }));
  }

  project(
    claim: CalendarReminderClaim,
    now: Date,
    webPushEnabled: boolean,
  ): Promise<RealtimeEventRecord | null> {
    return this.transaction(async (client) => {
      const source = await client.query<{
        entity_type: 'job-card' | 'calendar-event'; entity_id: string;
      }>(
        `SELECT 'job-card'::text AS entity_type, j.id AS entity_id
         FROM calendar_reminders r
         JOIN job_cards j ON j.organization_id = r.organization_id AND j.id = r.job_card_id
         JOIN users u ON u.organization_id = r.organization_id AND u.id = r.recipient_user_id
         WHERE r.id = $1 AND r.lease_token = $2 AND r.state = 'CLAIMED'
           AND j.assigned_to = r.recipient_user_id AND u.is_active = TRUE
           AND j.status NOT IN ('COMPLETED','CANCELLED') AND j.scheduled_at > $3
         UNION ALL
         SELECT 'calendar-event', e.id
         FROM calendar_reminders r
         JOIN calendar_events e ON e.organization_id = r.organization_id AND e.id = r.calendar_event_id
         JOIN users u ON u.organization_id = r.organization_id AND u.id = r.recipient_user_id
         WHERE r.id = $1 AND r.lease_token = $2 AND r.state = 'CLAIMED'
           AND e.assigned_user_id = r.recipient_user_id AND u.is_active = TRUE
           AND e.status = 'ACTIVE' AND e.starts_at > $3
         LIMIT 1`,
        [claim.id, claim.leaseToken, now],
      );
      const current = source.rows[0];
      if (!current) {
        await client.query(
          `UPDATE calendar_reminders SET state = 'CANCELLED', cancelled_at = $3,
            lease_token = NULL, lease_until = NULL, updated_at = $3
           WHERE id = $1 AND lease_token = $2`,
          [claim.id, claim.leaseToken, now],
        );
        return null;
      }
      const realtime = await client.query<{
        id: string; resource_keys: string[]; created_at: Date;
      }>(
        `INSERT INTO realtime_events
          (organization_id, source_activity_id, calendar_activity_id,
           calendar_reminder_id, event_type, entity_type, entity_id,
           actor_user_id, audience_roles, audience_user_ids, resource_keys, created_at)
         VALUES ($1,NULL,NULL,$2,'calendar.reminder_due',$3,$4,NULL,
           '{}',ARRAY[$5]::uuid[],ARRAY['calendar','calendar:' || $5::text,'overview','notifications'],$6)
         RETURNING id, resource_keys, created_at`,
        [claim.organizationId, claim.id, current.entity_type, current.entity_id,
          claim.recipientUserId, now],
      );
      const notification = await client.query<{ id: string }>(
        `INSERT INTO in_app_notifications
          (organization_id, recipient_user_id, source_realtime_event_id, kind,
           entity_type, entity_id, created_at)
         VALUES ($1,$2,$3,'calendar.reminder',$4,$5,$6)
         ON CONFLICT (recipient_user_id, source_realtime_event_id) DO NOTHING
         RETURNING id`,
        [claim.organizationId, claim.recipientUserId, realtime.rows[0]!.id,
          current.entity_type, current.entity_id, now],
      );
      if (webPushEnabled && notification.rows[0]) {
        await client.query(
          `INSERT INTO web_push_deliveries
            (organization_id, notification_id, subscription_id, next_attempt_at)
           SELECT s.organization_id, $1, s.id, $2 FROM web_push_subscriptions s
           WHERE s.organization_id = $3 AND s.recipient_user_id = $4
             AND s.disabled_at IS NULL
           ON CONFLICT (notification_id, subscription_id) DO NOTHING`,
          [notification.rows[0].id, now, claim.organizationId, claim.recipientUserId],
        );
      }
      await client.query(
        `UPDATE calendar_reminders SET state = 'PROJECTED', projected_at = $3,
          lease_token = NULL, lease_until = NULL, last_error_code = NULL, updated_at = $3
         WHERE id = $1 AND lease_token = $2`,
        [claim.id, claim.leaseToken, now],
      );
      return {
        id: BigInt(realtime.rows[0]!.id),
        organizationId: claim.organizationId,
        sourceActivityId: null,
        type: 'calendar.reminder_due' as const,
        entityType: current.entity_type,
        entityId: current.entity_id,
        actorUserId: null,
        audience: { roles: [], userIds: [claim.recipientUserId] },
        resourceKeys: realtime.rows[0]!.resource_keys,
        occurredAt: realtime.rows[0]!.created_at,
      };
    });
  }

  async retry(claim: CalendarReminderClaim, now: Date, nextAttemptAt: Date, errorCode: string) {
    await this.pool.query(
      `UPDATE calendar_reminders SET state = 'PENDING', next_attempt_at = $3,
        lease_token = NULL, lease_until = NULL, last_error_code = $4, updated_at = $5
       WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.leaseToken, nextAttemptAt, errorCode, now],
    );
  }

  async abandon(claim: CalendarReminderClaim, now: Date, errorCode: string) {
    await this.pool.query(
      `UPDATE calendar_reminders SET state = 'ABANDONED', abandoned_at = $3,
        lease_token = NULL, lease_until = NULL, last_error_code = $4, updated_at = $3
       WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.leaseToken, now, errorCode],
    );
  }

  async release(leaseToken: string, now: Date) {
    await this.pool.query(
      `UPDATE calendar_reminders SET state = 'PENDING', lease_token = NULL,
        lease_until = NULL, next_attempt_at = LEAST(next_attempt_at, $2), updated_at = $2
       WHERE state = 'CLAIMED' AND lease_token = $1`,
      [leaseToken, now],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export type CalendarReminderWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
}>;

export function createCalendarReminderWorker(
  repository: CalendarReminderWorkerRepository,
  options: Readonly<{
    now?: () => Date;
    publisher?: RealtimeEventPublisher;
    webPushEnabled?: boolean;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
  }> = {},
): CalendarReminderWorker {
  const now = options.now ?? (() => new Date());
  const publisher = options.publisher ?? NOOP_REALTIME_EVENT_PUBLISHER;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const leaseMs = options.leaseMs ?? 60_000;
  const batchSize = options.batchSize ?? 20;
  const leaseToken = randomUUID();
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<number> | null = null;

  const runOnce = async () => {
    const claimedAt = now();
    const claims = await repository.claimDue(
      claimedAt,
      leaseToken,
      new Date(claimedAt.valueOf() + leaseMs),
      batchSize,
    );
    for (const claim of claims) {
      try {
        const realtime = await repository.project(
          claim,
          now(),
          options.webPushEnabled ?? false,
        );
        if (realtime) publisher.publish(realtime);
      } catch {
        const failedAt = now();
        if (claim.attemptCount >= RETRY_DELAYS_MS.length + 1) {
          await repository.abandon(claim, failedAt, 'PROJECTION_FAILED');
        } else {
          const delay = RETRY_DELAYS_MS[Math.max(0, claim.attemptCount - 1)]!;
          await repository.retry(
            claim,
            failedAt,
            new Date(failedAt.valueOf() + delay),
            'PROJECTION_FAILED',
          );
        }
      }
    }
    return claims.length;
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        active = runOnce().finally(() => {
          active = null;
          if (timer) timer = setTimeout(tick, pollIntervalMs);
        });
      };
      timer = setTimeout(tick, 0);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
      await repository.release(leaseToken, now());
    },
    runOnce,
  };
}
