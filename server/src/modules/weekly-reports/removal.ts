import type { CriticalActionClaim, CriticalActionResult, CriticalActionWorkResult } from '../../db/critical-action.js';
import { AppError } from '../../errors/index.js';
import { lockAssigneesInOrder, type AssigneeLockReader } from '../job-cards/assignee-lock.js';
import { assertCanInvalidate } from '../job-cards/policy.js';
import type { ActivityInput, AppendedActivity, JobCardAuditInput } from '../job-cards/repository.js';
import type {
  JobCard,
  JobCardActor,
  JobCardAssignee,
  JobCardMutationReceipt,
  PersistedJobCardDetail,
} from '../job-cards/types.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import type { WeeklyReportReadService } from './read.js';
import {
  parseWeeklyReportRemovalInput,
  weeklyReportRemovalRequestHash,
  type WeeklyReportRemovalInput,
} from './removal-input.js';
import { mapReport, type WeeklyReportRemovalUpdate, type WeeklyReportRow } from './repository.js';

export interface WeeklyReportRemovalTransaction extends AssigneeLockReader {
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getJob(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobForUpdate(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getWeeklyReportByJobForUpdate(organizationId: string, jobCardId: string): Promise<WeeklyReportRow | null>;
  listActiveFollowUpChildrenForUpdate(
    organizationId: string,
    jobCardId: string,
  ): Promise<readonly { id: string }[]>;
  removeWeeklyReportRow(input: WeeklyReportRemovalUpdate): Promise<WeeklyReportRow | null>;
  appendActivity(input: ActivityInput): Promise<AppendedActivity>;
  appendAudit(input: JobCardAuditInput): Promise<void>;
}

interface WeeklyReportRemovalRepository<Transaction> {
  findJobCardDetail(organizationId: string, jobCardId: string): Promise<Pick<PersistedJobCardDetail, 'assignee'> | null>;
  hasActiveFollowUpChildren(organizationId: string, jobCardId: string): Promise<boolean>;
  executeCriticalAction<Result>(
    claim: CriticalActionClaim,
    work: (transaction: Transaction) => Promise<CriticalActionWorkResult<Result>>,
  ): Promise<CriticalActionResult<Result>>;
}

export type WeeklyReportRemovalJobCardChange = {
  version: number;
  status: JobCard['status'];
  closedOverdueIncidents: number;
};

export type WeeklyReportRemovalContext = Readonly<{
  actor: JobCardActor;
  jobCardId: string;
  job: JobCard;
  reportId: string;
  clientActionId: string;
  at: Date;
}>;

interface WeeklyReportRemovalJobCards<Transaction> {
  invalidateForRemoval(
    tx: Transaction,
    removal: WeeklyReportRemovalContext,
  ): Promise<WeeklyReportRemovalJobCardChange>;
  recordInvalidation(
    tx: Transaction,
    removal: WeeklyReportRemovalContext,
    change: WeeklyReportRemovalJobCardChange,
  ): Promise<readonly RealtimeEventRecord[]>;
  finishRemoval(
    tx: Transaction,
    removal: WeeklyReportRemovalContext,
    version: number,
    activity: AppendedActivity,
  ): Promise<readonly RealtimeEventRecord[]>;
}

export class WeeklyReportRemovalService<Transaction extends WeeklyReportRemovalTransaction> {
  constructor(
    private readonly repository: WeeklyReportRemovalRepository<Transaction>,
    private readonly reads: Pick<WeeklyReportReadService, 'getWeeklyReport'>,
    private readonly jobCards: WeeklyReportRemovalJobCards<Transaction>,
    private readonly now: () => Date,
  ) {}

  async weeklyReportRemovalPreview(actor: JobCardActor, jobCardId: string) {
    assertCanInvalidate(actor);
    const report = await this.reads.getWeeklyReport(actor, jobCardId);
    const job = await this.repository.findJobCardDetail(actor.organizationId, jobCardId);
    if (!job) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    // Advisory read only; POST repeats this guard under transaction/child locks.
    const activeFollowUps = report.canRemove
      ? await this.repository.hasActiveFollowUpChildren(actor.organizationId, jobCardId)
      : false;
    return {
      jobCardId, reportId: report.id, staffUserId: report.staffUserId, staffName: job.assignee.name,
      periodStart: report.periodStart, periodEnd: report.periodEnd,
      status: report.jobStatus, expectedVersion: report.jobVersion, expectedReportVersion: report.version,
      submissionCount: report.submissionSummaries.length,
      canRemove: report.canRemove && !activeFollowUps,
      removalBlocker: activeFollowUps ? 'ACTIVE_FOLLOW_UPS' as const : null,
      removal: report.removal,
    };
  }

  async removeWeeklyReport(actor: JobCardActor, jobCardId: string, rawInput: WeeklyReportRemovalInput) {
    assertCanInvalidate(actor);
    const input = parseWeeklyReportRemovalInput(rawInput);
    return this.repository.executeCriticalAction<JobCardMutationReceipt>({
      organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId,
      operationKey: `WEEKLY_REPORT_REMOVE:${jobCardId}`,
      requestHash: weeklyReportRemovalRequestHash(jobCardId, input),
    }, async (tx) => {
      // Staff-user lock contract (assignee-lock.ts): the acting admin and the
      // report owner are locked FIRST, in ONE sorted de-duplicated call, before
      // the JobCard/WeeklyReport rows. The owner id comes from the unlocked
      // snapshot, so the authoritative checks are re-taken from the locked rows:
      // an actor demoted or deactivated meanwhile still gets 403 before anything
      // is written, and an owner that changed still fails the ownership check.
      const actorSnapshot = await tx.getAssignee(actor.organizationId, actor.id);
      if (!actorSnapshot?.isActive || actorSnapshot.role !== 'ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const snapshot = await tx.getJob(actor.organizationId, jobCardId);
      if (!snapshot || snapshot.type !== 'WEEKLY_REPORT') {
        throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      }
      const lockedUsers = await lockAssigneesInOrder(
        tx, actor.organizationId, [actor.id, snapshot.assignedTo],
      );
      const currentActor = lockedUsers.get(actor.id) ?? null;
      if (!currentActor?.isActive || currentActor.role !== 'ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const owner = lockedUsers.get(snapshot.assignedTo) ?? null;
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      const row = await tx.getWeeklyReportByJobForUpdate(actor.organizationId, jobCardId);
      if (!job || !row) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      if (!owner || owner.role !== 'STAFF' || job.type !== 'WEEKLY_REPORT'
        || row.staff_user_id !== job.assignedTo || job.assignedTo !== snapshot.assignedTo) {
        throw new AppError('WEEKLY_REPORT_OWNERSHIP_CONFLICT', 409, 'Rapor sahibi doğrulanamadığı için rapor kaldırılamaz.');
      }
      if (row.removed_at !== null) {
        throw new AppError('WEEKLY_REPORT_ALREADY_REMOVED', 409, 'Bu haftalık rapor zaten kaldırılmış.');
      }
      if (job.version !== input.expectedVersion || row.version !== input.expectedReportVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Rapor değişti. Güncel kaydı inceleyip yeniden deneyin.');
      }
      if ((await tx.listActiveFollowUpChildrenForUpdate(actor.organizationId, jobCardId)).length > 0) {
        throw new AppError('JOB_HAS_ACTIVE_FOLLOW_UPS', 409, 'Aktif takip işleri bulunan rapor kaldırılamaz.');
      }
      const at = this.now();
      const removal: WeeklyReportRemovalContext = {
        actor, jobCardId, job, reportId: row.id, clientActionId: input.clientActionId, at,
      };
      const change = await this.jobCards.invalidateForRemoval(tx, removal);
      const removed = await tx.removeWeeklyReportRow({ organizationId: actor.organizationId,
        reportId: row.id, expectedVersion: row.version, removedAt: at, removedBy: actor.id, reason: input.reason });
      if (!removed) throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
      const invalidationEvents = await this.jobCards.recordInvalidation(tx, removal, change);
      const activity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId,
        actorId: actor.id, event: 'WEEKLY_REPORT_REMOVED', clientActionId: input.clientActionId,
        oldValue: { reportVersion: row.version }, newValue: { reportVersion: removed.version },
        metadata: { reportId: row.id, reason: input.reason, closedOverdueIncidents: change.closedOverdueIncidents } });
      await tx.appendAudit({ organizationId: actor.organizationId, actorUserId: actor.id, subjectId: jobCardId,
        eventType: 'WEEKLY_REPORT_REMOVED', oldValue: { reportId: row.id, removedAt: null },
        newValue: { reportId: row.id, removedAt: at.toISOString() },
        metadata: { staffUserId: row.staff_user_id, periodStart: mapReport(row).periodStart,
          reason: input.reason, clientActionId: input.clientActionId } });
      const removalEvents = await this.jobCards.finishRemoval(tx, removal, change.version, activity);
      return { response: { jobCardId }, realtimeEvents: [...invalidationEvents, ...removalEvents] };
    });
  }
}
