import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import { lockAssigneesInOrder } from '../job-cards/assignee-lock.js';
import {
  PostgresJobCardTransaction,
  runCriticalAction,
} from '../job-cards/repository.js';
import { assertCanCreateForAssignee, assertCreateAssignmentRequest } from '../job-cards/policy.js';
import type { JobCardActor } from '../job-cards/types.js';
import type { JobCardService } from '../job-cards/service.js';
import {
  recurrenceBulkCreateHash,
  recurrencePauseHash,
  recurrenceResumeHash,
  recurrenceTemplateUpdateHash,
  type WeeklyReportRecurrenceBulkCreateInput,
  type WeeklyReportRecurrencePauseInput,
  type WeeklyReportRecurrenceResumeInput,
  type WeeklyReportRecurrenceTemplateUpdateInput,
} from './recurrence-input.js';
import {
  PostgresWeeklyReportRecurrenceRepository,
  recurrenceNotFound,
  recurrenceVersionConflict,
} from './recurrence-repository.js';
import type {
  WeeklyReportRecurrenceBulkCreateResult,
  WeeklyReportRecurrenceDto,
  WeeklyReportRecurrencePauseResult,
  WeeklyReportRecurrenceResumeResult,
  WeeklyReportRecurrenceRow,
  WeeklyReportRecurrenceTemplateResult,
} from './recurrence-types.js';
import { currentWeeklyReportPeriod } from './reference.js';
import { validateManagerQuestions } from './validation.js';

/**
 * Weekly Report recurrence configuration (V1 Slice 5).
 *
 * MANAGER/ADMIN only — there is no STAFF surface at all, so the guard is a
 * role check rather than a target filter. Every command is idempotent through
 * `processed_actions`: the same action id with the same normalized intent
 * replays the stored response (including after an ambiguous failure), while a
 * changed intent under a reused action id is `CLIENT_ACTION_REUSED`.
 *
 * The service NEVER writes a WeeklyReport. It configures the rule; the worker
 * (`recurrence-worker.ts`) is the only component that produces reports, and it
 * does so by calling the canonical creation primitive exposed by
 * `JobCardService`.
 */

function forbidden(): AppError {
  return new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

function assigneeNotFound(): AppError {
  return new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
}

function startPeriodInPast(): AppError {
  const message = 'Başlangıç haftası geçmişte olamaz.';
  return new AppError('VALIDATION_ERROR', 400, message, { fieldErrors: { startPeriodStart: message } });
}

function resumePeriodInPast(): AppError {
  const message = 'Devam haftası geçmişte olamaz.';
  return new AppError('VALIDATION_ERROR', 400, message, { fieldErrors: { periodStart: message } });
}

export class WeeklyReportRecurrenceService {
  constructor(
    private readonly repository: PostgresWeeklyReportRecurrenceRepository,
    private readonly pool: Pool,
    private readonly jobCardService: JobCardService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertManager(actor: JobCardActor): void {
    if (actor.role === 'STAFF') throw forbidden();
  }

  /**
   * Organization-local "current week" — the SSOT for start/resume checks.
   * Runs on the caller's transaction client: commands inside
   * `runCriticalAction` already own a PoolClient, and a nested `pool.query()`
   * here would self-deadlock the pool under contention.
   */
  private async currentPeriod(client: PoolClient, organizationId: string): Promise<string> {
    const timezone = await this.repository.getOrganizationTimezone(client, organizationId);
    return currentWeeklyReportPeriod(this.now(), timezone).periodStart;
  }

  async list(actor: JobCardActor): Promise<{ items: WeeklyReportRecurrenceDto[] }> {
    this.assertManager(actor);
    return { items: await this.repository.listRecurrences(actor.organizationId) };
  }

  /**
   * Bulk create: one INDEPENDENT rule per selected staff member, in one
   * logical command. Existing rules converge to `existing` (never overwritten,
   * never a failure); a real validation or authorization failure for ANY
   * target rolls the whole command back, so no partial set can commit.
   *
   * Creation does NOT synchronously create a WeeklyReport: if the start week
   * is the current week the worker will produce it on its next iteration, and
   * the UI must not also send a one-time bulk request (two competing writers).
   */
  async bulkCreate(
    actor: JobCardActor,
    input: WeeklyReportRecurrenceBulkCreateInput,
  ): Promise<WeeklyReportRecurrenceBulkCreateResult> {
    this.assertManager(actor);
    const questions = input.questions === undefined || input.questions === null
      ? []
      : validateManagerQuestions(input.questions);
    const requestTime = this.now();
    const result = await runCriticalAction<WeeklyReportRecurrenceBulkCreateResult>(
      this.pool,
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: 'WEEKLY_REPORT_RECURRENCE_BULK_CREATE',
        requestHash: recurrenceBulkCreateHash({
          staffUserIds: input.staffUserIds,
          startPeriodStart: input.startPeriodStart,
          questions,
          instructions: input.instructions,
        }),
      },
      async (client) => {
        const transaction = new PostgresJobCardTransaction(client);
        // 1. Lock EVERY target in one deterministic order (the universal
        //    staff-user contract), so a concurrent create/bulk/worker touching
        //    the same staff serializes here.
        const locked = await lockAssigneesInOrder(
          transaction,
          actor.organizationId,
          input.staffUserIds,
        );
        // 2. The start week must be the current or a future organization-local
        //    week — never a backfill.
        const currentWeek = await this.currentPeriod(client, actor.organizationId);
        if (input.startPeriodStart < currentWeek) throw startPeriodInPast();
        // 3. Validate ALL targets before writing ANY.
        for (const staffUserId of input.staffUserIds) {
          const assignee = locked.get(staffUserId);
          if (!assignee) throw assigneeNotFound();
          assertCreateAssignmentRequest(actor, staffUserId);
          assertCanCreateForAssignee(actor, assignee);
        }
        // 4. Insert-or-converge in request order.
        const items: WeeklyReportRecurrenceBulkCreateResult['items'] = [];
        for (const staffUserId of input.staffUserIds) {
          const inserted = await this.repository.insertIfAbsent(client, {
            organizationId: actor.organizationId,
            staffUserId,
            requestedByUserId: actor.id,
            nextPeriodStart: input.startPeriodStart,
            questions,
            instructions: input.instructions,
          });
          const row = inserted
            ?? await this.repository.findByStaff(client, actor.organizationId, staffUserId);
          if (!row) throw assigneeNotFound();
          items.push({
            recurrenceId: row.id,
            staffUserId,
            outcome: inserted ? 'created' : 'existing',
            enabled: row.enabled,
            nextPeriodStart: row.next_period_start,
            version: row.version,
          });
        }
        return { response: { startPeriodStart: input.startPeriodStart, items }, realtimeEvents: [] };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  /**
   * Future-only template replacement. An already-created report is never
   * touched: the worker reads the rule's committed template under its row lock
   * at processing time, and nothing here rewrites an existing WeeklyReport,
   * JobCard description, frozen submission or prior questions.
   */
  async updateTemplate(
    actor: JobCardActor,
    recurrenceId: string,
    input: WeeklyReportRecurrenceTemplateUpdateInput,
  ): Promise<WeeklyReportRecurrenceTemplateResult> {
    this.assertManager(actor);
    const questions = validateManagerQuestions(input.questions);
    const result = await runCriticalAction<WeeklyReportRecurrenceTemplateResult>(
      this.pool,
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: 'WEEKLY_REPORT_RECURRENCE_TEMPLATE_UPDATE',
        requestHash: recurrenceTemplateUpdateHash({
          recurrenceId,
          questions,
          instructions: input.instructions,
        }),
      },
      async (client) => {
        const updated = await this.repository.updateTemplate(client, {
          organizationId: actor.organizationId,
          id: recurrenceId,
          expectedVersion: input.expectedVersion,
          questions,
          instructions: input.instructions,
          requestedByUserId: actor.id,
        });
        if (!updated) {
          const current = await this.repository.getForResume(
            client,
            actor.organizationId,
            recurrenceId,
          );
          if (!current) throw recurrenceNotFound();
          throw recurrenceVersionConflict();
        }
        return {
          response: {
            recurrenceId: updated.id,
            version: updated.version,
            questions: updated.manager_questions,
            instructions: updated.instructions,
            nextPeriodStart: updated.next_period_start,
          },
          realtimeEvents: [],
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  /**
   * Pause. A claimed-but-uncommitted occurrence must not later create a
   * report: the worker re-reads and locks the rule inside its occurrence
   * transaction, so once this commits the in-flight claim is void.
   */
  async pause(
    actor: JobCardActor,
    recurrenceId: string,
    input: WeeklyReportRecurrencePauseInput,
  ): Promise<WeeklyReportRecurrencePauseResult> {
    this.assertManager(actor);
    const result = await runCriticalAction<WeeklyReportRecurrencePauseResult>(
      this.pool,
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: 'WEEKLY_REPORT_RECURRENCE_PAUSE',
        requestHash: recurrencePauseHash({ recurrenceId }),
      },
      async (client) => {
        const paused = await this.repository.pause(client, {
          organizationId: actor.organizationId,
          id: recurrenceId,
          expectedVersion: input.expectedVersion,
        });
        if (paused) return { response: pauseResult(paused), realtimeEvents: [] };
        const current = await this.repository.getForResume(
          client,
          actor.organizationId,
          recurrenceId,
        );
        if (!current) throw recurrenceNotFound();
        // An enabled rule with a moved version is a genuine conflict.
        if (current.enabled) throw recurrenceVersionConflict();
        // Already paused: only the same version is an idempotent no-op (resume
        // parity). A NEW command carrying a stale expectedVersion conflicts,
        // so a stale UI cannot silently "succeed" past intervening changes.
        // Exact lost-response replays never reach this branch: `processed_actions`
        // replays the stored response before business validation.
        if (current.version !== input.expectedVersion) throw recurrenceVersionConflict();
        return { response: pauseResult(current), realtimeEvents: [] };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  /**
   * Resume. The default resume week is the CURRENT organization-local week, and
   * `next_period_start` becomes `max(stored, requested)` — so weeks that were
   * deliberately skipped while paused are never backfilled. The target must
   * again be an active STAFF member.
   */
  async resume(
    actor: JobCardActor,
    recurrenceId: string,
    input: WeeklyReportRecurrenceResumeInput,
  ): Promise<WeeklyReportRecurrenceResumeResult> {
    this.assertManager(actor);
    const result = await runCriticalAction<WeeklyReportRecurrenceResumeResult>(
      this.pool,
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: 'WEEKLY_REPORT_RECURRENCE_RESUME',
        requestHash: recurrenceResumeHash({ recurrenceId, periodStart: input.periodStart }),
      },
      async (client) => {
        const current = await this.repository.getForResume(
          client,
          actor.organizationId,
          recurrenceId,
        );
        if (!current) throw recurrenceNotFound();
        // Lock the target user FIRST (the universal contract), then the rule.
        const transaction = new PostgresJobCardTransaction(client);
        const assignee = await transaction.getAssigneeForUpdate(
          actor.organizationId,
          current.staff_user_id,
        );
        if (!assignee || !assignee.isActive || assignee.role !== 'STAFF') throw assigneeNotFound();
        const currentWeek = await this.currentPeriod(client, actor.organizationId);
        const requested = input.periodStart ?? currentWeek;
        if (requested < currentWeek) throw resumePeriodInPast();
        const resumed = await this.repository.resume(client, {
          organizationId: actor.organizationId,
          id: recurrenceId,
          expectedVersion: input.expectedVersion,
          requestedPeriodStart: requested,
          requestedByUserId: actor.id,
        });
        if (resumed) {
          return {
            response: {
              recurrenceId: resumed.id,
              enabled: true,
              nextPeriodStart: resumed.next_period_start,
              version: resumed.version,
            },
            realtimeEvents: [],
          };
        }
        const latest = await this.repository.getForResume(client, actor.organizationId, recurrenceId);
        if (!latest) throw recurrenceNotFound();
        // Already enabled at the expected version → idempotent no-op.
        if (latest.enabled && latest.version === input.expectedVersion) {
          return {
            response: {
              recurrenceId: latest.id,
              enabled: true,
              nextPeriodStart: latest.next_period_start,
              version: latest.version,
            },
            realtimeEvents: [],
          };
        }
        throw recurrenceVersionConflict();
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  /**
   * Worker occurrence creation. The worker owns the transaction and the staff
   * lock; this simply forwards to the canonical primitive, which is the same
   * code path the single create and bulk request use.
   */
  createOccurrence: Parameters<
    PostgresWeeklyReportRecurrenceRepository['processOccurrence']
  >[2] = (transaction, actor, input) =>
    this.jobCardService.createOrResolveWeeklyReportForStaff(transaction, actor, input);
}

function pauseResult(row: WeeklyReportRecurrenceRow): WeeklyReportRecurrencePauseResult {
  return {
    recurrenceId: row.id,
    enabled: false,
    disabledReason: (row.disabled_reason as WeeklyReportRecurrencePauseResult['disabledReason']) ?? 'MANUAL',
    nextPeriodStart: row.next_period_start,
    version: row.version,
  };
}
