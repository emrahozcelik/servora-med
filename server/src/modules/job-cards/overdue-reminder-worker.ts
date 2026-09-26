/**
 * OVR-4: age-based reminder/escalation projection for open LATE_SUBMISSION
 * incidents.
 *
 * Responsibility split (deliberately one-directional):
 *
 *   overdue producer / scanner  ->  breach truth (the immutable incident row)
 *   this worker                 ->  notification side-effect, purely a function
 *                                   of that incident's age
 *
 * This worker therefore:
 * - never discovers, re-derives, mutates, recovers or closes an incident;
 * - never writes recovery, never changes a deadline, never invents evidence;
 * - reads `breached_at` from the incident and asks the policy when each kind
 *   becomes due.
 *
 * Exactly-once delivery without a distributed lock:
 * - the UNIQUE identity `(organization_id, incident_id, reminder_kind)` is the
 *   delivery contract. `INSERT … ON CONFLICT DO NOTHING RETURNING` means two
 *   concurrent server instances racing on the same due incident produce one
 *   claim, not two;
 * - the lease (`lease_token` / `lease_until`) makes a crashed claim
 *   recoverable: an expired lease is reclaimable, a live one is not;
 * - the projection transaction re-reads the incident and the job under
 *   `FOR UPDATE` and *cancels* instead of delivering when the incident was
 *   recovered or the job left the submission phase between claim and delivery.
 *
 * Recovery is intentionally NOT handled here: when the employee submits, the
 * existing OVR-2 lifecycle path recovers the incident, and this worker simply
 * stops seeing it as due.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { PostgresNotificationTransaction } from '../notifications/repository.js';
import type { NotificationDraft, NotificationKind } from '../notifications/types.js';
import { acquireRealtimeOrderingLock } from '../realtime/ordering.js';
import type { RealtimeEventRecord, RealtimeEventType } from '../realtime/types.js';
import { PostgresWebPushTransaction } from '../web-push/repository.js';
import { listActiveManagementRecipients } from './repository.js';
import {
  OVERDUE_REMINDER_DELAY_TYPE,
  OVERDUE_REMINDER_NOTIFICATION_KIND,
  OVERDUE_REMINDER_REALTIME_TYPE,
  type OverdueReminderKind,
  type OverdueReminderPolicy,
} from './overdue-reminder-policy.js';

/** A reminder delivery claimed by this worker instance for one lease window. */
export type OverdueReminderClaim = Readonly<{
  id: string;
  organizationId: string;
  /** The breach that made this delivery due (traceability, not the key). */
  incidentId: string;
  jobCardId: string;
  episodeNo: number;
  reminderKind: OverdueReminderKind;
  attemptCount: number;
  leaseToken: string;
}>;

export interface OverdueReminderWorkerRepository {
  /**
   * Claim at most `limit` due deliveries for one kind.
   *
   * Two disjoint sources, both resolved with one statement:
   *  - an incident whose threshold has passed and which has no delivery row yet
   *    is claimed by inserting one (the UNIQUE identity arbitrates races);
   *  - an existing row whose lease expired (crashed worker) is reclaimed.
   */
  claimDue(input: {
    reminderKind: OverdueReminderKind;
    thresholdMinutes: number;
    now: Date;
    leaseToken: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<readonly OverdueReminderClaim[]>;
  /** Re-validate under lock, deliver, and mark PROJECTED (or CANCELLED). */
  project(
    claim: OverdueReminderClaim,
    now: Date,
    webPushEnabled: boolean,
  ): Promise<RealtimeEventRecord | null>;
  retry(claim: OverdueReminderClaim, now: Date, nextAttemptAt: Date, errorCode: string): Promise<void>;
  abandon(claim: OverdueReminderClaim, now: Date, errorCode: string): Promise<void>;
  release(leaseToken: string, now: Date): Promise<void>;
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

/** Statuses in which the submission obligation is still open to the employee. */
const OPEN_SUBMISSION_STATUSES = ['IN_PROGRESS', 'REVISION_REQUESTED'] as const;

type ReminderRow = {
  id: string;
  organization_id: string;
  incident_id: string;
  job_card_id: string;
  episode_no: number;
  reminder_kind: OverdueReminderKind;
  attempt_count: number;
};

export class PostgresOverdueReminderWorkerRepository
implements OverdueReminderWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async claimDue(input: {
    reminderKind: OverdueReminderKind;
    thresholdMinutes: number;
    now: Date;
    leaseToken: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<readonly OverdueReminderClaim[]> {
    const result = await this.pool.query<ReminderRow>(
      // `open_episodes` collapses every open incident of one submission episode
      // to its earliest breach: a retroactive schedule revision can create a
      // second immutable incident for the same episode, and the employee must
      // still be reminded once. The earliest breach is the conservative
      // (earliest-due) representative.
      `WITH open_episodes AS (
         SELECT DISTINCT ON (i.organization_id, i.job_card_id, i.episode_no)
                i.organization_id, i.job_card_id, i.episode_no,
                i.id AS incident_id, i.breached_at
           FROM job_card_overdue_incidents i
           JOIN job_cards j
             ON j.organization_id = i.organization_id AND j.id = i.job_card_id
          WHERE i.delay_type = $7
            AND i.recovered_at IS NULL
            AND j.status IN ('IN_PROGRESS', 'REVISION_REQUESTED')
          ORDER BY i.organization_id, i.job_card_id, i.episode_no,
                   i.breached_at ASC, i.id ASC
       ), due AS (
         SELECT e.organization_id, e.job_card_id, e.episode_no, e.incident_id,
                e.breached_at + ($5::int * interval '1 minute') AS due_at
           FROM open_episodes e
          WHERE e.breached_at + ($5::int * interval '1 minute') <= $1
            AND NOT EXISTS (
              SELECT 1 FROM job_card_overdue_incident_reminders r
               WHERE r.organization_id = e.organization_id
                 AND r.job_card_id = e.job_card_id
                 AND r.delay_type = $7
                 AND r.episode_no = e.episode_no
                 AND r.reminder_kind = $6)
          ORDER BY e.breached_at ASC, e.incident_id ASC
          LIMIT $4
       ), claimed AS (
         INSERT INTO job_card_overdue_incident_reminders
           (organization_id, incident_id, job_card_id, delay_type, episode_no,
            reminder_kind, state, due_at, next_attempt_at, lease_token,
            lease_until, attempt_count)
         SELECT d.organization_id, d.incident_id, d.job_card_id, $7, d.episode_no,
                $6, 'CLAIMED', d.due_at, $1, $2, $3, 1
           FROM due d
         ON CONFLICT (organization_id, job_card_id, delay_type, episode_no, reminder_kind)
           DO NOTHING
         RETURNING id, organization_id, incident_id, job_card_id, episode_no,
                   reminder_kind, attempt_count
       ), reclaimed AS (
         UPDATE job_card_overdue_incident_reminders r
            SET state = 'CLAIMED', lease_token = $2, lease_until = $3,
                attempt_count = r.attempt_count + 1, updated_at = $1
          WHERE r.id IN (
            SELECT r2.id FROM job_card_overdue_incident_reminders r2
             WHERE r2.reminder_kind = $6
               AND r2.delay_type = $7
               AND (
                 (r2.state = 'PENDING' AND r2.next_attempt_at <= $1)
                 OR (r2.state = 'CLAIMED' AND r2.lease_until <= $1)
               )
             ORDER BY r2.next_attempt_at ASC, r2.id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $4)
         RETURNING r.id, r.organization_id, r.incident_id, r.job_card_id,
                   r.episode_no, r.reminder_kind, r.attempt_count
       )
       SELECT * FROM claimed
       UNION ALL
       SELECT * FROM reclaimed`,
      [
        input.now, input.leaseToken, input.leaseUntil, input.limit,
        input.thresholdMinutes, input.reminderKind, OVERDUE_REMINDER_DELAY_TYPE,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      incidentId: row.incident_id,
      jobCardId: row.job_card_id,
      episodeNo: Number(row.episode_no),
      reminderKind: row.reminder_kind,
      attemptCount: Number(row.attempt_count),
      leaseToken: input.leaseToken,
    }));
  }

  project(
    claim: OverdueReminderClaim,
    now: Date,
    webPushEnabled: boolean,
  ): Promise<RealtimeEventRecord | null> {
    return this.transaction(async (client) => {
      const reminder = await client.query<{
        organization_id: string;
        incident_id: string;
        job_card_id: string;
        reminder_kind: OverdueReminderKind;
        recovered_at: Date | null;
        accountable_user_id: string | null;
        status: string;
      }>(
        `SELECT r.organization_id, r.incident_id, r.job_card_id, r.reminder_kind,
                i.recovered_at, i.accountable_user_id, j.status
           FROM job_card_overdue_incident_reminders r
           JOIN job_card_overdue_incidents i
             ON i.organization_id = r.organization_id AND i.id = r.incident_id
           JOIN job_cards j
             ON j.organization_id = r.organization_id AND j.id = r.job_card_id
          WHERE r.id = $1 AND r.lease_token = $2 AND r.state = 'CLAIMED'
          FOR UPDATE OF r`,
        [claim.id, claim.leaseToken],
      );
      const row = reminder.rows[0];
      if (!row) return null;

      const cancel = async (): Promise<null> => {
        await client.query(
          `UPDATE job_card_overdue_incident_reminders
              SET state = 'CANCELLED', cancelled_at = $3, lease_token = NULL,
                  lease_until = NULL, updated_at = $3
            WHERE id = $1 AND lease_token = $2`,
          [claim.id, claim.leaseToken, now],
        );
        return null;
      };

      // The incident was recovered (the employee submitted) or the job left the
      // submission phase between claim and delivery: there is nothing to
      // remind. Never deliver a stale nudge.
      if (row.recovered_at !== null) return cancel();
      if (!(OPEN_SUBMISSION_STATUSES as readonly string[]).includes(row.status)) {
        return cancel();
      }

      const recipients = await this.resolveRecipients(client, row);
      // Unprovable accountability (no accountable user on the incident) or no
      // active manager to escalate to: fail closed. A reminder is never
      // addressed to a fabricated recipient.
      if (recipients.length === 0) return cancel();

      await acquireRealtimeOrderingLock(client, row.organization_id);
      const realtime = await client.query<{ id: string; resource_keys: string[]; created_at: Date }>(
        `INSERT INTO realtime_events
           (organization_id, overdue_reminder_id, event_type, entity_type, entity_id,
            actor_user_id, audience_roles, audience_user_ids, resource_keys, created_at)
         VALUES ($1,$2,$3,'job-card',$4,NULL,'{}',$5::uuid[],$6,$7)
         RETURNING id, resource_keys, created_at`,
        [
          row.organization_id,
          claim.id,
          OVERDUE_REMINDER_REALTIME_TYPE[row.reminder_kind],
          row.job_card_id,
          recipients,
          ['job-detail:' + row.job_card_id, 'notifications'],
          now,
        ],
      );
      const drafts: NotificationDraft[] = recipients.map((recipientUserId) => ({
        recipientUserId,
        kind: OVERDUE_REMINDER_NOTIFICATION_KIND[row.reminder_kind] as NotificationKind,
        entityType: 'job-card' as const,
        entityId: row.job_card_id,
      }));
      const notifications = await new PostgresNotificationTransaction(client).append({
        organizationId: row.organization_id,
        sourceRealtimeEventId: BigInt(realtime.rows[0]!.id),
        createdAt: now,
        drafts,
      });
      if (webPushEnabled && notifications.length > 0) {
        await new PostgresWebPushTransaction(client).appendDeliveries({
          organizationId: row.organization_id,
          notificationIds: notifications.map((notification) => notification.id),
          at: now,
        });
      }
      await client.query(
        `UPDATE job_card_overdue_incident_reminders
            SET state = 'PROJECTED', projected_at = $3, lease_token = NULL,
                lease_until = NULL, last_error_code = NULL, updated_at = $3
          WHERE id = $1 AND lease_token = $2`,
        [claim.id, claim.leaseToken, now],
      );
      return {
        id: BigInt(realtime.rows[0]!.id),
        organizationId: row.organization_id,
        sourceActivityId: null,
        messagingActivityId: null,
        type: OVERDUE_REMINDER_REALTIME_TYPE[row.reminder_kind] as RealtimeEventType,
        entityType: 'job-card',
        entityId: row.job_card_id,
        actorUserId: null,
        audience: { roles: [], userIds: [...recipients] },
        resourceKeys: realtime.rows[0]!.resource_keys,
        occurredAt: realtime.rows[0]!.created_at,
      };
    });
  }

  /**
   * Resolve the audience for one reminder kind, restricted to users that are
   * still active in the organization.
   *
   * STAFF_SUBMISSION_REMINDER targets the incident's immutable accountable
   * user — the person accountable at the breach instant — not the current
   * assignee. A reassignment after the breach must not redirect a reminder
   * about a delay someone else was accountable for.
   */
  private async resolveRecipients(
    client: PoolClient,
    row: { organization_id: string; reminder_kind: OverdueReminderKind; accountable_user_id: string | null },
  ): Promise<readonly string[]> {
    const candidates = row.reminder_kind === 'STAFF_SUBMISSION_REMINDER'
      ? (row.accountable_user_id === null ? [] : [row.accountable_user_id])
      : (await listActiveManagementRecipients(client, row.organization_id)).map((r) => r.id);
    if (candidates.length === 0) return [];
    const active = await client.query<{ id: string }>(
      `SELECT id FROM users
        WHERE organization_id = $1 AND is_active = TRUE AND id = ANY($2::uuid[])
        ORDER BY id ASC`,
      [row.organization_id, candidates],
    );
    return active.rows.map((user) => user.id);
  }

  async retry(claim: OverdueReminderClaim, now: Date, nextAttemptAt: Date, errorCode: string) {
    await this.pool.query(
      `UPDATE job_card_overdue_incident_reminders
          SET state = 'PENDING', next_attempt_at = $3, lease_token = NULL,
              lease_until = NULL, last_error_code = $4, updated_at = $5
        WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.leaseToken, nextAttemptAt, errorCode, now],
    );
  }

  async abandon(claim: OverdueReminderClaim, now: Date, errorCode: string) {
    await this.pool.query(
      `UPDATE job_card_overdue_incident_reminders
          SET state = 'ABANDONED', abandoned_at = $3, lease_token = NULL,
              lease_until = NULL, last_error_code = $4, updated_at = $3
        WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.leaseToken, errorCode, now],
    );
  }

  async release(leaseToken: string, now: Date) {
    await this.pool.query(
      `UPDATE job_card_overdue_incident_reminders
          SET state = 'PENDING', lease_token = NULL, lease_until = NULL,
              next_attempt_at = LEAST(next_attempt_at, $2), updated_at = $2
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

export type OverdueReminderWorkerReport = Readonly<{
  runAt: string;
  claimed: number;
  projected: number;
  cancelled: number;
  failed: number;
  byKind: Readonly<Record<OverdueReminderKind, number>>;
}>;

export type OverdueReminderWorker = Readonly<{
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<OverdueReminderWorkerReport>;
}>;

/**
 * Bounded, non-overlapping worker loop following the calendar reminder worker
 * conventions. No distributed lease/claim layer beyond the delivery identity
 * and the per-row lease: those already make two concurrent instances converge
 * on one delivery.
 */
export function createOverdueReminderWorker(
  repository: OverdueReminderWorkerRepository,
  policy: OverdueReminderPolicy,
  options: Readonly<{
    now?: () => Date;
    publisher?: { publish(event: RealtimeEventRecord): void };
    webPushEnabled?: boolean;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    onReport?: (report: OverdueReminderWorkerReport) => void;
    onError?: (error: unknown) => void;
  }> = {},
): OverdueReminderWorker {
  const now = options.now ?? (() => new Date());
  const publisher = options.publisher;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 60_000;
  const batchSize = options.batchSize ?? 20;
  const leaseToken = randomUUID();
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<OverdueReminderWorkerReport> | null = null;

  // Reporting must never crash the worker: a throwing reporter is contained.
  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // best-effort reporting only
    }
  };

  const runOnce = async (): Promise<OverdueReminderWorkerReport> => {
    const byKind: Record<OverdueReminderKind, number> = {
      STAFF_SUBMISSION_REMINDER: 0,
      MANAGEMENT_ESCALATION: 0,
    };
    const counts = { claimed: 0, projected: 0, cancelled: 0, failed: 0 };
    for (const reminderKind of Object.keys(byKind) as OverdueReminderKind[]) {
      const claimedAt = now();
      let claims: readonly OverdueReminderClaim[];
      try {
        claims = await repository.claimDue({
          reminderKind,
          thresholdMinutes: policy.thresholdMinutes(reminderKind),
          now: claimedAt,
          leaseToken,
          leaseUntil: new Date(claimedAt.valueOf() + leaseMs),
          limit: batchSize,
        });
      } catch (error) {
        reportError(error);
        continue;
      }
      counts.claimed += claims.length;
      byKind[reminderKind] += claims.length;
      for (const claim of claims) {
        try {
          const realtime = await repository.project(claim, now(), options.webPushEnabled ?? false);
          if (realtime) {
            counts.projected += 1;
            publisher?.publish(realtime);
          } else {
            counts.cancelled += 1;
          }
        } catch (error) {
          counts.failed += 1;
          reportError(error);
          const failedAt = now();
          try {
            if (claim.attemptCount >= RETRY_DELAYS_MS.length + 1) {
              await repository.abandon(claim, failedAt, 'PROJECTION_FAILED');
            } else {
              const delay = RETRY_DELAYS_MS[Math.max(0, claim.attemptCount - 1)]!;
              await repository.retry(
                claim, failedAt, new Date(failedAt.valueOf() + delay), 'PROJECTION_FAILED',
              );
            }
          } catch (bookkeepingError) {
            // The claim stays CLAIMED under its lease, so the expiry pass
            // reclaims it. Report and continue with the remaining claims
            // instead of rejecting runOnce and aborting the whole batch.
            reportError(bookkeepingError);
          }
        }
      }
    }
    return { runAt: now().toISOString(), ...counts, byKind };
  };

  return {
    start() {
      if (timer) return;
      const tick = () => {
        // Contain poll-level failures (e.g. claimDue): report and keep the loop
        // alive instead of escaping as an unhandled rejection.
        active = runOnce().catch((error: unknown) => {
          reportError(error);
          return {
            runAt: now().toISOString(),
            claimed: 0, projected: 0, cancelled: 0, failed: 1,
            byKind: { STAFF_SUBMISSION_REMINDER: 0, MANAGEMENT_ESCALATION: 0 },
          };
        }).finally(() => {
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
