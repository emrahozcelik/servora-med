import type {
  CriticalActionClaim,
  CriticalActionResult,
  CriticalActionWorkResult,
} from '../../db/critical-action.js';
import { AppError } from '../../errors/index.js';
import { localDateKey } from '../job-cards/local-calendar.js';
import type { JobCard, JobCardActor, JobCardStatus } from '../job-cards/types.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import {
  weeklyReportAlreadyExists,
  weeklyReportBulkRequestHash,
  weeklyReportCreateRequestHash,
  weeklyReportTitle,
  type WeeklyReportBulkRequestInput,
  type WeeklyReportCreateInput,
} from './create-input.js';
import { weeklyReportDueDate } from './reference.js';
import type { WeeklyReportInsert, WeeklyReportRow } from './repository.js';
import type { ManagerQuestion } from './types.js';
import { validateManagerQuestions } from './validation.js';

export interface WeeklyReportCreationTransaction {
  getWeeklyReportByStaffWeek(
    organizationId: string,
    staffUserId: string,
    periodStart: string,
  ): Promise<WeeklyReportRow | null>;
  insertWeeklyReportRow(input: WeeklyReportInsert): Promise<WeeklyReportRow | null>;
}

interface WeeklyReportCreationRepository<Transaction> {
  getOrganizationTimezone(organizationId: string): Promise<string>;
  executeCriticalAction<Result>(
    claim: CriticalActionClaim,
    work: (transaction: Transaction) => Promise<CriticalActionWorkResult<Result>>,
  ): Promise<CriticalActionResult<Result>>;
}

export type WeeklyReportJobCardInput = {
  staffUserId: string;
  title: string;
  instructions: string | null;
  dueDate: string;
  selfCreate: boolean;
  requestTime: Date;
};

export type WeeklyReportJobCreatedInput = {
  periodStart: string;
  periodEnd: string;
  clientActionId: string;
  selfCreate: boolean;
  requestTime: Date;
};

export type WeeklyReportJobCard = Pick<JobCard, 'id' | 'status' | 'assignedTo' | 'version'>;

interface WeeklyReportJobCards<Transaction> {
  lockAndAuthorizeTargets(
    transaction: Transaction,
    actor: JobCardActor,
    staffUserIds: readonly string[],
  ): Promise<void>;
  create(
    transaction: Transaction,
    actor: JobCardActor,
    input: WeeklyReportJobCardInput,
  ): Promise<WeeklyReportJobCard>;
  recordCreated(
    transaction: Transaction,
    actor: JobCardActor,
    job: WeeklyReportJobCard,
    input: WeeklyReportJobCreatedInput,
  ): Promise<readonly RealtimeEventRecord[]>;
}

export type WeeklyReportCreateResult = {
  jobCardId: string;
  reportId: string;
  staffUserId: string;
  periodStart: string;
  periodEnd: string;
  status: JobCardStatus;
  dueDate: string | null;
};

/**
 * Internal result of the shared creation core. `existing` means an already
 * canonical report for that staff/week won the identity; the JobCard and
 * report ids point at that winner and no new row was written.
 */
type WeeklyReportCreationOutcome =
  | {
      outcome: 'created';
      jobCardId: string;
      reportId: string;
      jobStatus: JobCardStatus;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | { outcome: 'existing'; jobCardId: string; reportId: string };

/**
 * Bulk request result. One item per normalized requested staff id, in request
 * order; `existing` items carry the already-canonical report so the client can
 * navigate to it instead of treating the duplicate as an error.
 */
export type WeeklyReportBulkRequestResult = {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  items: Array<{
    staffUserId: string;
    jobCardId: string;
    reportId: string;
    outcome: 'created' | 'existing';
  }>;
};

export class WeeklyReportCreationService<Transaction extends WeeklyReportCreationTransaction> {
  constructor(
    private readonly repository: WeeklyReportCreationRepository<Transaction>,
    private readonly jobCards: WeeklyReportJobCards<Transaction>,
    private readonly now: () => Date,
    private readonly publishRealtime: (events: readonly RealtimeEventRecord[]) => void,
  ) {}

  /**
   * Single-target Weekly Report creation (V1 Slice 2). One transaction
   * atomically produces the JobCard and its WeeklyReport row — never one
   * without the other. STAFF self-creates (ACCEPTED with canonical accepted
   * evidence, mirroring generic self-create); MANAGER/ADMIN requests for
   * exactly one active STAFF (NEW). Idempotent via processed_actions with a
   * normalized-intent request hash.
   */
  async createWeeklyReport(
    actor: JobCardActor,
    input: WeeklyReportCreateInput,
  ): Promise<WeeklyReportCreateResult> {
    const selfCreate = actor.role === 'STAFF';
    let staffUserId: string;
    let questions: ManagerQuestion[];
    if (selfCreate) {
      if (input.assignedTo !== null && input.assignedTo !== actor.id) {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      if (input.questions !== undefined && input.questions !== null) {
        throw new AppError(
          'VALIDATION_ERROR', 400, 'Yönetici soruları personel kaydında yer alamaz.',
        );
      }
      staffUserId = actor.id;
      questions = [];
    } else {
      if (input.assignedTo === null) {
        throw new AppError(
          'VALIDATION_ERROR', 400, 'Haftalık rapor için sorumlu personel zorunludur.',
        );
      }
      staffUserId = input.assignedTo;
      questions = input.questions === undefined || input.questions === null
        ? []
        : validateManagerQuestions(input.questions);
    }
    // Deadline authority is SERVER-ONLY (field-test product decision, WR-WEEK):
    // the submission deadline is the Monday after the Monday–Saturday period
    // (`periodEnd + 2`), or the organization-local creation date if requested
    // later so a late request is never born overdue. The public request shape
    // carries no dueDate field at all (the parser rejects one as an unknown
    // field), so no caller, staff or manager, can move their own or anyone's
    // accountability deadline.
    const { requestTime, dueDate } = await this.creationTiming(actor.organizationId, input.periodEnd);
    const result = await this.repository.executeCriticalAction<WeeklyReportCreateResult>(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'WEEKLY_REPORT_CREATE',
        requestHash: weeklyReportCreateRequestHash({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          assignedTo: staffUserId,
          questions,
          instructions: input.instructions,
        }),
      },
      async (transaction) => {
        await this.jobCards.lockAndAuthorizeTargets(transaction, actor, [staffUserId]);
        const outcome = await this.createOrResolveForStaff(transaction, actor, {
          staffUserId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueDate,
          questions,
          instructions: input.instructions,
          selfCreate,
          clientActionId: input.clientActionId,
          requestTime,
        });
        // Single-create semantics are preserved: an existing canonical report
        // is a deterministic conflict with navigation metadata, never a
        // silent convergence (bulk owns the `existing` outcome).
        if (outcome.outcome === 'existing') {
          throw weeklyReportAlreadyExists(
            outcome.reportId, outcome.jobCardId, input.periodStart,
          );
        }
        return {
          response: {
            jobCardId: outcome.jobCardId,
            reportId: outcome.reportId,
            staffUserId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            status: outcome.jobStatus,
            dueDate,
          },
          realtimeEvents: outcome.realtimeEvents,
        };
      },
    );
    return this.complete(result);
  }

  /**
   * Manager/ADMIN bulk request (V1 Slice 3): the same reporting week requested
   * for many staff in ONE logical command, producing N INDEPENDENT WeeklyReport
   * JobCards — never a shared multi-assignee report. Each report therefore has
   * its own JobCard id, report id, lifecycle, acceptance, due date, overdue
   * accountability, draft, submissions, revision history and approval.
   *
   * Atomicity: one transaction and one receipt. For valid targets the command
   * is all-or-nothing — a real validation, authorization or infrastructure
   * failure rolls back every JobCard and report created so far, so no partial
   * result can commit.
   *
   * Duplicate convergence is NOT a command failure: an already canonical
   * report for (staff, period) is reported as `existing` with its own ids, and
   * the remaining targets still commit.
   */
  async bulkRequestWeeklyReports(
    actor: JobCardActor,
    input: WeeklyReportBulkRequestInput,
  ): Promise<WeeklyReportBulkRequestResult> {
    // STAFF has no bulk surface at all: there is no self-create path on this
    // endpoint, so the guard is a role check, not a target filter.
    if (actor.role === 'STAFF') {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    const staffUserIds = input.staffUserIds;
    const questions = input.questions === undefined || input.questions === null
      ? []
      : validateManagerQuestions(input.questions);
    // Same server-only deadline authority as the single create: the Monday
    // after the Monday–Saturday period (`periodEnd + 2`), or the
    // organization-local creation date if later.
    const { requestTime, dueDate } = await this.creationTiming(actor.organizationId, input.periodEnd);
    const result = await this.repository.executeCriticalAction<WeeklyReportBulkRequestResult>(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'WEEKLY_REPORT_BULK_REQUEST',
        requestHash: weeklyReportBulkRequestHash({
          staffUserIds,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          questions,
          instructions: input.instructions,
        }),
      },
      async (transaction) => {
        // Lock and validate every target before creating any report.
        await this.jobCards.lockAndAuthorizeTargets(transaction, actor, staffUserIds);
        // Resolve or create in request order. Existing reports emit no creation event.
        const items: WeeklyReportBulkRequestResult['items'] = [];
        const realtimeEvents: RealtimeEventRecord[] = [];
        for (const staffUserId of staffUserIds) {
          const outcome = await this.createOrResolveForStaff(transaction, actor, {
            staffUserId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            dueDate,
            questions,
            instructions: input.instructions,
            selfCreate: false,
            clientActionId: input.clientActionId,
            requestTime,
          });
          items.push({
            staffUserId,
            jobCardId: outcome.jobCardId,
            reportId: outcome.reportId,
            outcome: outcome.outcome,
          });
          if (outcome.outcome === 'created') realtimeEvents.push(...outcome.realtimeEvents);
        }
        return {
          response: {
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            dueDate,
            items,
          },
          realtimeEvents,
        };
      },
    );
    return this.complete(result);
  }

  /**
   * Both commands hold the target's user lock and have checked assignability.
   * All production report creates share that lock. A staff/week match can
   * return the existing identity before a JobCard is written. The unique
   * constraint still arbitrates any collision at insert time.
   */
  private async createOrResolveForStaff(
    transaction: Transaction,
    actor: JobCardActor,
    input: {
      staffUserId: string;
      periodStart: string;
      periodEnd: string;
      dueDate: string;
      questions: ManagerQuestion[];
      instructions: string | null;
      selfCreate: boolean;
      clientActionId: string;
      requestTime: Date;
    },
  ): Promise<WeeklyReportCreationOutcome> {
    const existing = await transaction.getWeeklyReportByStaffWeek(
      actor.organizationId, input.staffUserId, input.periodStart,
    );
    if (existing) {
      return {
        outcome: 'existing',
        jobCardId: existing.job_card_id,
        reportId: existing.id,
      };
    }
    const job = await this.jobCards.create(transaction, actor, {
      staffUserId: input.staffUserId,
      title: weeklyReportTitle(input.periodStart, input.periodEnd),
      instructions: input.instructions,
      dueDate: input.dueDate,
      selfCreate: input.selfCreate,
      requestTime: input.requestTime,
    });
    const report = await transaction.insertWeeklyReportRow({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      staffUserId: input.staffUserId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      questions: input.questions,
    });
    if (!report) {
      // A collision after the pre-check must abort the whole transaction.
      // The new JobCard is already present on this connection.
      const winner = await transaction.getWeeklyReportByStaffWeek(
        actor.organizationId, input.staffUserId, input.periodStart,
      );
      if (winner) {
        throw weeklyReportAlreadyExists(winner.id, winner.job_card_id, input.periodStart);
      }
      throw new AppError(
        'WEEKLY_REPORT_CREATION_CONFLICT',
        409,
        'Haftalık rapor oluşturulamadı; eşzamanlı bir işlem aynı raporu oluşturdu.',
      );
    }
    const realtimeEvents = await this.jobCards.recordCreated(transaction, actor, job, {
      clientActionId: input.clientActionId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      selfCreate: input.selfCreate,
      requestTime: input.requestTime,
    });
    return {
      outcome: 'created',
      jobCardId: job.id,
      reportId: report.id,
      jobStatus: job.status,
      realtimeEvents,
    };
  }

  private async creationTiming(organizationId: string, periodEnd: string) {
    const requestTime = this.now();
    const timezone = await this.repository.getOrganizationTimezone(organizationId);
    const dueDate = weeklyReportDueDate(periodEnd, localDateKey(requestTime, timezone));
    return { requestTime, dueDate };
  }

  private complete<Result>(result: CriticalActionResult<Result>): Result {
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return result.response;
  }
}
