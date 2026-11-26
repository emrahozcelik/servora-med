import { AppError } from '../../errors/index.js';
import type { JobCard, JobCardActor } from '../job-cards/types.js';
import { buildWeeklyReportPdfDocumentModel } from './pdf/document-model.js';
import { weeklyReportPdfFileName } from './pdf/file-name.js';
import { renderWeeklyReportPdf } from './pdf/renderer.js';
import { mapReport, mapSubmission, type WeeklyReportSubmissionRow } from './repository.js';
import { mapSourceWorkRow, readWeeklySourceWork } from './source-work.js';
import type { WeeklyReportSubmissionReader } from './submission.js';
import type { WeeklyReportDetail, WeeklyReportSubmission } from './types.js';

export interface WeeklyReportReadRepository extends WeeklyReportSubmissionReader {
  findJobCard(
    organizationId: string,
    jobCardId: string,
  ): Promise<Pick<JobCard, 'type' | 'assignedTo' | 'status' | 'version' | 'dueDate' | 'description'> | null>;
  listWeeklyReportSubmissionRows(
    organizationId: string,
    reportId: string,
  ): Promise<WeeklyReportSubmissionRow[]>;
  getWeeklyReportSubmissionBySeq(
    organizationId: string,
    reportId: string,
    seqNo: number,
  ): Promise<WeeklyReportSubmissionRow | null>;
  /** Live display metadata, separately scoped from the frozen submission. */
  getUserDisplayName(organizationId: string, userId: string): Promise<string | null>;
}

export class WeeklyReportReadService {
  constructor(private readonly repository: WeeklyReportReadRepository) {}

  /**
   * Weekly report read context: owning JobCard plus its report row. Same
   * visibility as the generic detail — cross-tenant and non-owner STAFF
   * reads are concealed as not-found; managers read their organization.
   */
  private async loadWeeklyReportContext(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || job.type !== 'WEEKLY_REPORT'
      || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    const row = await this.repository.getWeeklyReportByJobId(actor.organizationId, jobCardId);
    if (!row) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    return { job, report: mapReport(row) };
  }

  async getWeeklyReport(actor: JobCardActor, jobCardId: string, includeSaleCapability = true): Promise<WeeklyReportDetail> {
    const { job, report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const submissionRows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    let liveSourceWork: WeeklyReportDetail['liveSourceWork'] = [];
    if (job.status === 'ACCEPTED' || job.status === 'IN_PROGRESS') {
      const rows = await readWeeklySourceWork(
        this.repository, actor.organizationId, report.staffUserId, report,
      );
      liveSourceWork = rows.map(mapSourceWorkRow);
    }
    return {
      ...report,
      canRemove: actor.role === 'ADMIN' && report.removal === null && report.staffUserId === job.assignedTo,
      jobStatus: job.status,
      jobVersion: job.version,
      dueDate: job.dueDate,
      assignedTo: job.assignedTo,
      instructions: job.description,
      liveSourceWork: includeSaleCapability ? liveSourceWork : liveSourceWork.filter((item) => item.type !== 'SALE'),
      submissionSummaries: submissionRows.map((row) => ({
        seqNo: row.seq_no,
        submittedAt: row.submitted_at.toISOString(),
        submittedBy: row.submitted_by,
      })),
    };
  }

  async listWeeklyReportSubmissions(
    actor: JobCardActor,
    jobCardId: string,
    includeSaleCapability = true,
  ): Promise<WeeklyReportSubmission[]> {
    const { report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const rows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    return rows.map(mapSubmission).map((submission) => includeSaleCapability ? submission : {
      ...submission, sourceWork: submission.sourceWork.filter((item) => item.type !== 'SALE'),
    });
  }

  /**
   * Downloadable PDF for one immutable submission, selected by its explicit
   * frozen `seqNo`.
   *
   * The projection is built from that `weekly_report_submissions` row alone —
   * never the live draft, the live source-work list, the current JobCard body
   * or the current answers — so a later edit cannot change an already
   * downloaded version. The read is strictly read-only: no activity is
   * appended, the report version does not move, and no download record or
   * idempotency receipt is written.
   */
  async weeklyReportSubmissionPdf(
    actor: JobCardActor,
    jobCardId: string,
    seqNo: number,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const { report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const row = await this.repository.getWeeklyReportSubmissionBySeq(
      actor.organizationId, report.id, seqNo,
    );
    if (!row) {
      throw new AppError('WEEKLY_REPORT_SUBMISSION_NOT_FOUND', 404, 'Gönderim bulunamadı.');
    }
    const submission = mapSubmission(row);
    // The display name is presentation metadata, resolved live on purpose: it
    // is not frozen report content and must not force a schema change.
    const staffName = await this.repository.getUserDisplayName(
      actor.organizationId, submission.submittedBy,
    );
    const model = buildWeeklyReportPdfDocumentModel({
      submission,
      staffName: staffName ?? submission.submittedBy,
    });
    const buffer = await renderWeeklyReportPdf(model);
    return { fileName: weeklyReportPdfFileName(model.periodStart, model.seqNo), buffer };
  }
}
