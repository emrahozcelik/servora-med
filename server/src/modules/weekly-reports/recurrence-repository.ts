import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import { addCalendarDaysToDateKey } from '../job-cards/local-calendar.js';
import {
  PostgresJobCardTransaction,
  type JobCardTransaction,
} from '../job-cards/repository.js';
import type { JobCardActor } from '../job-cards/types.js';
import type { WeeklyReportCreationOutcome } from '../job-cards/service.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import type { ManagerQuestion } from './types.js';
import type {
  WeeklyReportRecurrenceClaim,
  WeeklyReportRecurrenceDto,
  WeeklyReportRecurrenceOccurrenceResult,
  WeeklyReportRecurrenceRow,
} from './recurrence-types.js';

/**
 * Persistence for Weekly Report recurrence (V1 Slice 5).
 *
 * Two distinct concerns share one table and one connection pool:
 *
 * 1. CONFIGURATION (`listRecurrences`, `*` methods taking a `PoolClient`).
 *    These run inside the caller's `processed_actions` transaction, so a
 *    command's receipt and its recurrence write commit together.
 * 2. WORKER OPERATIONS (`claimDue`, `processOccurrence`, `retry`, `release`).
 *    These own their transactions and never run under an HTTP actor.
 *
 * Lock discipline (deadlock-free by construction): every transaction that
 * needs both a `users` row and a recurrence row acquires the USER lock FIRST.
 * `bulkCreate` locks the target users (sorted, the universal contract) and
 * only then touches recurrence rows; `processOccurrence` locks the claimed
 * staff user and only then the recurrence row. Two transactions can therefore
 * never hold the two lock families in opposite order.
 */

/**
 * Columns read back from the table. The two DATE columns are cast to text so
 * the organization-local Monday is never reinterpreted through a JS `Date`
 * (server timezone) — the domain identity of a period is the calendar date.
 */
const RECURRENCE_COLUMNS = `id, organization_id, staff_user_id, requested_by_user_id,
  enabled, disabled_reason,
  next_period_start::text AS next_period_start,
  manager_questions, instructions, version,
  lease_token, lease_until, next_attempt_at, failure_count, last_error_code,
  last_processed_period_start::text AS last_processed_period_start,
  last_outcome, created_at, updated_at`;

type RecurrenceRow = Omit<WeeklyReportRecurrenceRow, 'manager_questions'> & {
  manager_questions: ManagerQuestion[];
};

function mapRow(row: RecurrenceRow): WeeklyReportRecurrenceRow {
  return {
    ...row,
    // JSONB arrives already parsed; normalize to an array shape defensively so
    // a hand-edited row can never leak a non-array into the domain.
    manager_questions: Array.isArray(row.manager_questions) ? row.manager_questions : [],
  };
}

function notFound(): AppError {
  return new AppError('WEEKLY_REPORT_RECURRENCE_NOT_FOUND', 404, 'Otomatik rapor kuralı bulunamadı.');
}

function versionConflict(): AppError {
  return new AppError(
    'VERSION_CONFLICT',
    409,
    'Kural başka bir işlem tarafından güncellendi.',
  );
}

/** Creator port: the canonical WeeklyReport creation primitive, injected. */
export type RecurrenceOccurrenceCreator = (
  transaction: JobCardTransaction,
  actor: JobCardActor,
  input: {
    staffUserId: string;
    periodStart: string;
    periodEnd: string;
    dueDate: string;
    questions: ManagerQuestion[];
    instructions: string | null;
    clientActionId: string;
    requestTime: Date;
  },
) => Promise<WeeklyReportCreationOutcome>;

export type RecurrenceOccurrenceOutcome = Readonly<{
  result: WeeklyReportRecurrenceOccurrenceResult;
  realtimeEvents: readonly RealtimeEventRecord[];
}>;

export class PostgresWeeklyReportRecurrenceRepository {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Configuration (runs inside the caller's command transaction)
  // -------------------------------------------------------------------------

  async listRecurrences(organizationId: string): Promise<WeeklyReportRecurrenceDto[]> {
    const result = await this.pool.query<{
      id: string; staff_user_id: string; staff_name: string; enabled: boolean;
      disabled_reason: string | null; next_period_start: string; manager_questions: ManagerQuestion[];
      instructions: string | null; version: number; last_processed_period_start: string | null;
      last_outcome: string | null; last_error_code: string | null; updated_at: Date;
    }>(
      `SELECT r.id, r.staff_user_id, u.name AS staff_name, r.enabled, r.disabled_reason,
              r.next_period_start::text AS next_period_start, r.manager_questions, r.instructions,
              r.version, r.last_processed_period_start::text AS last_processed_period_start,
              r.last_outcome, r.last_error_code, r.updated_at
         FROM weekly_report_recurrences r
         JOIN users u ON u.organization_id = r.organization_id AND u.id = r.staff_user_id
        WHERE r.organization_id = $1
        ORDER BY u.name ASC, r.id ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      staffUserId: row.staff_user_id,
      staffName: row.staff_name,
      enabled: row.enabled,
      disabledReason: (row.disabled_reason as WeeklyReportRecurrenceDto['disabledReason']) ?? null,
      nextPeriodStart: row.next_period_start,
      questions: Array.isArray(row.manager_questions) ? row.manager_questions : [],
      instructions: row.instructions,
      version: row.version,
      lastProcessedPeriodStart: row.last_processed_period_start,
      lastOutcome: (row.last_outcome as WeeklyReportRecurrenceDto['lastOutcome']) ?? null,
      lastErrorCode: row.last_error_code,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  /** Existing rule for a staff member (used to report `existing`, never to overwrite). */
  async findByStaff(
    client: PoolClient,
    organizationId: string,
    staffUserId: string,
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `SELECT ${RECURRENCE_COLUMNS} FROM weekly_report_recurrences
        WHERE organization_id = $1 AND staff_user_id = $2`,
      [organizationId, staffUserId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Unlocked read of the fields a resume command needs BEFORE it can take the
   * user lock (staff identity is immutable in V1, so this cannot race a
   * reassignment; the version-guarded UPDATE remains the authority).
   */
  async getForResume(
    client: PoolClient,
    organizationId: string,
    id: string,
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `SELECT ${RECURRENCE_COLUMNS} FROM weekly_report_recurrences
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Create the rule, or return `null` when one already exists for the staff
   * member. `ON CONFLICT DO NOTHING` makes an already-configured staff member
   * a non-failure: the caller re-reads the existing row and reports `existing`
   * without overwriting the manager's earlier template.
   */
  async insertIfAbsent(
    client: PoolClient,
    input: {
      organizationId: string;
      staffUserId: string;
      requestedByUserId: string;
      nextPeriodStart: string;
      questions: ManagerQuestion[];
      instructions: string | null;
    },
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `INSERT INTO weekly_report_recurrences
         (organization_id, staff_user_id, requested_by_user_id, next_period_start,
          manager_questions, instructions)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, staff_user_id) DO NOTHING
       RETURNING ${RECURRENCE_COLUMNS}`,
      [
        input.organizationId,
        input.staffUserId,
        input.requestedByUserId,
        input.nextPeriodStart,
        JSON.stringify(input.questions),
        input.instructions,
      ],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Future-only template replacement, guarded by the optimistic version. */
  async updateTemplate(
    client: PoolClient,
    input: {
      organizationId: string;
      id: string;
      expectedVersion: number;
      questions: ManagerQuestion[];
      instructions: string | null;
      requestedByUserId: string;
    },
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `UPDATE weekly_report_recurrences
          SET manager_questions = $3, instructions = $4, requested_by_user_id = $5,
              version = version + 1, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND version = $6
        RETURNING ${RECURRENCE_COLUMNS}`,
      [
        input.organizationId,
        input.id,
        JSON.stringify(input.questions),
        input.instructions,
        input.requestedByUserId,
        input.expectedVersion,
      ],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Pause. An already-paused rule is left untouched (no version bump, no
   * reason rewrite) so a retry or a double-click cannot corrupt the reason a
   * previous pause recorded.
   */
  async pause(
    client: PoolClient,
    input: { organizationId: string; id: string; expectedVersion: number },
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `UPDATE weekly_report_recurrences
          SET enabled = FALSE, disabled_reason = 'MANUAL',
              version = version + 1, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND version = $3 AND enabled = TRUE
        RETURNING ${RECURRENCE_COLUMNS}`,
      [input.organizationId, input.id, input.expectedVersion],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Resume. `next_period_start` becomes `max(stored, requested)` so resuming
   * never backfills weeks that were deliberately skipped while paused, and
   * never rewinds a rule that had already advanced past the requested week.
   * Only a paused rule is transitioned; an already-enabled rule is a no-op.
   */
  async resume(
    client: PoolClient,
    input: {
      organizationId: string;
      id: string;
      expectedVersion: number;
      requestedPeriodStart: string;
      requestedByUserId: string;
    },
  ): Promise<WeeklyReportRecurrenceRow | null> {
    const result = await client.query<RecurrenceRow>(
      `UPDATE weekly_report_recurrences
          SET enabled = TRUE, disabled_reason = NULL,
              next_period_start = GREATEST(next_period_start, $3::date),
              requested_by_user_id = $4,
              failure_count = 0, last_error_code = NULL, next_attempt_at = NOW(),
              version = version + 1, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND version = $5 AND enabled = FALSE
        RETURNING ${RECURRENCE_COLUMNS}`,
      [
        input.organizationId,
        input.id,
        input.requestedPeriodStart,
        input.requestedByUserId,
        input.expectedVersion,
      ],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Current organization timezone (resume default period + start-week checks). */
  async getOrganizationTimezone(organizationId: string): Promise<string> {
    const result = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM organizations WHERE id = $1`,
      [organizationId],
    );
    const timezone = result.rows[0]?.timezone;
    if (!timezone) throw notFound();
    return timezone;
  }

  // -------------------------------------------------------------------------
  // Worker operations (own their transactions)
  // -------------------------------------------------------------------------

  /**
   * Due discovery is authoritative in PostgreSQL and organization-local:
   * a rule is due when its stored Monday is <= the CURRENT CALENDAR DATE in
   * the ORGANIZATION's timezone, its retry time has arrived and no live lease
   * holds it. The worker never decides "what week is it" from a server or UTC
   * date, so two organizations in different timezones see different Mondays
   * for the same instant.
   */
  async claimDue(
    now: Date,
    leaseToken: string,
    leaseUntil: Date,
    limit: number,
  ): Promise<WeeklyReportRecurrenceClaim[]> {
    const result = await this.pool.query<{
      id: string; organization_id: string; staff_user_id: string; requested_by_user_id: string;
      next_period_start: string; manager_questions: ManagerQuestion[]; instructions: string | null;
      failure_count: number;
    }>(
      `WITH due AS (
         SELECT r.id
           FROM weekly_report_recurrences r
           JOIN organizations o ON o.id = r.organization_id
          WHERE r.enabled
             AND r.next_attempt_at <= $1
             AND (r.lease_until IS NULL OR r.lease_until <= $1)
             AND r.next_period_start <= (($1::timestamptz AT TIME ZONE o.timezone)::date)
           ORDER BY r.next_period_start ASC, r.id ASC
           FOR UPDATE OF r SKIP LOCKED
           LIMIT $4
       )
       UPDATE weekly_report_recurrences r
          SET lease_token = $2, lease_until = $3, updated_at = $1
         FROM due WHERE r.id = due.id
       RETURNING r.id, r.organization_id, r.staff_user_id, r.requested_by_user_id,
         r.next_period_start::text AS next_period_start,
         r.manager_questions, r.instructions, r.failure_count`,
      [now, leaseToken, leaseUntil, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      staffUserId: row.staff_user_id,
      requestedByUserId: row.requested_by_user_id,
      nextPeriodStart: row.next_period_start,
      managerQuestions: Array.isArray(row.manager_questions) ? row.manager_questions : [],
      instructions: row.instructions,
      failureCount: row.failure_count,
      leaseToken,
    }));
  }

  /**
   * ONE occurrence, ONE transaction. Either the whole thing commits — target
   * eligibility, the canonical WeeklyReport resolve/create, the JOB_CREATED
   * projection, `last_processed_period_start`, `last_outcome` and the +7 day
   * schedule advance — or nothing does. There is no compensating write and no
   * second period per claim, so a crash at any point leaves the rule exactly
   * one step behind and safely re-claimable.
   */
  async processOccurrence(
    claim: WeeklyReportRecurrenceClaim,
    now: Date,
    create: RecurrenceOccurrenceCreator,
  ): Promise<RecurrenceOccurrenceOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the target user FIRST (the universal contract), then the rule.
      const transaction = new PostgresJobCardTransaction(client);
      const assignee = await transaction.getAssigneeForUpdate(
        claim.organizationId,
        claim.staffUserId,
      );

      const locked = await client.query<RecurrenceRow>(
        `SELECT ${RECURRENCE_COLUMNS} FROM weekly_report_recurrences
          WHERE organization_id = $1 AND id = $2 AND lease_token = $3
          FOR UPDATE`,
        [claim.organizationId, claim.id, claim.leaseToken],
      );
      const recurrence = locked.rows[0] ? mapRow(locked.rows[0]) : null;
      if (!recurrence || !recurrence.enabled) {
        // Void claim: a manager paused the rule (or the lease was reclaimed)
        // between the claim and this transaction. A stale claim must never
        // override a human pause, so no report is created.
        await client.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = NULL, lease_until = NULL, updated_at = $3
            WHERE id = $1 AND lease_token = $2`,
          [claim.id, claim.leaseToken, now],
        );
        await client.query('COMMIT');
        return {
          result: { outcome: 'skipped', recurrenceId: claim.id, processedPeriodStart: null },
          realtimeEvents: [],
        };
      }
      if (recurrence.staff_user_id !== claim.staffUserId) {
        // Defensive: the staff identity is immutable, but never create a report
        // for a user we did not lock.
        await client.query(
          `UPDATE weekly_report_recurrences
              SET lease_token = NULL, lease_until = NULL, updated_at = $3
            WHERE id = $1 AND lease_token = $2`,
          [claim.id, claim.leaseToken, now],
        );
        await client.query('COMMIT');
        return {
          result: { outcome: 'skipped', recurrenceId: claim.id, processedPeriodStart: null },
          realtimeEvents: [],
        };
      }

      if (!assignee || !assignee.isActive || assignee.role !== 'STAFF') {
        // Target no longer an active STAFF member: auto-pause instead of
        // retrying forever. No report, no fake occurrence, and the reason is
        // surfaced in the management list.
        await client.query(
          `UPDATE weekly_report_recurrences
              SET enabled = FALSE, disabled_reason = 'STAFF_INELIGIBLE',
                  lease_token = NULL, lease_until = NULL,
                  last_error_code = 'STAFF_INELIGIBLE', version = version + 1, updated_at = $3
            WHERE id = $1 AND lease_token = $2`,
          [claim.id, claim.leaseToken, now],
        );
        await client.query('COMMIT');
        return {
          result: { outcome: 'autoPaused', recurrenceId: claim.id, processedPeriodStart: null },
          realtimeEvents: [],
        };
      }

      // The period identity is the stored organization-local Monday. The
      // due date is the canonical next Monday (+7), never an absolute
      // repeating date persisted on the rule.
      const periodStart = recurrence.next_period_start;
      const periodEnd = addCalendarDaysToDateKey(periodStart, 6);
      const dueDate = addCalendarDaysToDateKey(periodStart, 7);

      const outcome = await create(
        transaction,
        // The durable authorization retained on the rule. `role` is nominal:
        // the creation primitive never re-checks it, which is exactly why a
        // manager's later role change cannot corrupt the rule.
        { id: recurrence.requested_by_user_id, organizationId: claim.organizationId, role: 'MANAGER' },
        {
          staffUserId: recurrence.staff_user_id,
          periodStart,
          periodEnd,
          dueDate,
          questions: recurrence.manager_questions,
          instructions: recurrence.instructions,
          // Deterministic per (rule, period): a retry after a rolled-back
          // attempt reuses it, and a committed attempt never runs again.
          clientActionId: `recurrence:${recurrence.id}:${periodStart}`,
          requestTime: now,
        },
      );

      await client.query(
        `UPDATE weekly_report_recurrences
            SET next_period_start = next_period_start + 7,
                last_processed_period_start = $3,
                last_outcome = $4,
                lease_token = NULL, lease_until = NULL,
                failure_count = 0, last_error_code = NULL,
                next_attempt_at = $5, updated_at = $5
          WHERE id = $1 AND lease_token = $2`,
        [claim.id, claim.leaseToken, periodStart, outcome.outcome, now],
      );
      await client.query('COMMIT');
      return {
        result: { outcome: outcome.outcome, recurrenceId: claim.id, processedPeriodStart: periodStart },
        realtimeEvents: outcome.outcome === 'created' ? outcome.realtimeEvents : [],
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Transient failure: release the lease, DO NOT advance the period, and
   * schedule a bounded retry for the SAME period.
   */
  async retry(
    claim: WeeklyReportRecurrenceClaim,
    now: Date,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE weekly_report_recurrences
          SET lease_token = NULL, lease_until = NULL, next_attempt_at = $3,
              failure_count = failure_count + 1, last_error_code = $4, updated_at = $5
        WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.leaseToken, nextAttemptAt, errorCode, now],
    );
  }

  /** Safe shutdown: drop only the leases this worker instance still holds. */
  async release(leaseToken: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE weekly_report_recurrences
          SET lease_token = NULL, lease_until = NULL, updated_at = $2
        WHERE lease_token = $1`,
      [leaseToken, now],
    );
  }
}

export { notFound as recurrenceNotFound, versionConflict as recurrenceVersionConflict };
