import { AppError } from '../../errors/index.js';
import type { JobCard, JobCardActor, JobCardAssignee } from '../job-cards/types.js';
import type { WeeklyReportDraftPatchInput } from './create-input.js';
import { mapReport, type WeeklyDraftRowUpdate, type WeeklyReportRow } from './repository.js';
import { validateDraftAnswers, validateDraftBody } from './validation.js';

export interface WeeklyReportDraftTransaction {
  getNoteAuthorSnapshot(
    organizationId: string,
    userId: string,
  ): Promise<Pick<JobCardAssignee, 'isActive' | 'role'> | null>;
  getJobForUpdate(
    organizationId: string,
    jobCardId: string,
  ): Promise<Pick<JobCard, 'assignedTo' | 'status' | 'type'> | null>;
  getWeeklyReportByJobForUpdate(
    organizationId: string,
    jobCardId: string,
  ): Promise<WeeklyReportRow | null>;
  /** Draft replacement on this client after the user, JobCard and report are locked. */
  updateWeeklyReportDraftRow(input: WeeklyDraftRowUpdate): Promise<WeeklyReportRow | null>;
}

interface WeeklyReportDraftRepository {
  executeTransaction(work: (tx: WeeklyReportDraftTransaction) => Promise<void>): Promise<void>;
}

/** Replace the entire draft for its original owner while the JobCard is editable. */
export async function updateWeeklyReportDraft(
  repository: WeeklyReportDraftRepository,
  actor: JobCardActor,
  jobCardId: string,
  input: WeeklyReportDraftPatchInput,
): Promise<void> {
  if (actor.role !== 'STAFF') {
    throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
  }
  await repository.executeTransaction(async (tx) => {
    // User -> JobCard -> WeeklyReport. Reuse the FOR SHARE user snapshot:
    // it fences role/deactivation changes while remaining compatible with
    // SUBMIT's note-author SHARE lock under the JobCard lock.
    const currentActor = await tx.getNoteAuthorSnapshot(actor.organizationId, actor.id);
    if (!currentActor?.isActive || currentActor.role !== 'STAFF') {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
    if (!job || job.type !== 'WEEKLY_REPORT' || job.assignedTo !== actor.id) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    const row = await tx.getWeeklyReportByJobForUpdate(actor.organizationId, jobCardId);
    if (!row) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    const report = mapReport(row);
    if (report.staffUserId !== actor.id) {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    if (job.status !== 'ACCEPTED' && job.status !== 'IN_PROGRESS') {
      throw new AppError('WEEKLY_REPORT_DRAFT_LOCKED', 409, 'Rapor taslağı bu aşamada düzenlenemez.');
    }
    if (report.version !== input.expectedVersion) {
      throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
    }
    const draft = validateDraftBody(input.draft);
    const answers = validateDraftAnswers(report.questions, input.answers);
    const updated = await tx.updateWeeklyReportDraftRow({
      organizationId: actor.organizationId,
      reportId: report.id,
      expectedVersion: input.expectedVersion,
      draft,
      answers,
    });
    if (!updated) {
      throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
    }
  });
}
