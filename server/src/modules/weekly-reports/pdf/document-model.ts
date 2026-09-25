import type { SourceWorkSnapshotItem, WeeklyReportSubmission } from '../types.js';

/** One frozen report section, already resolved to plain text. */
export type WeeklyReportPdfSection = {
  label: string;
  /** `null` when the staff left the optional section empty. */
  value: string | null;
};

export type WeeklyReportPdfAnswer = {
  prompt: string;
  answer: string;
};

/**
 * Frozen source-work lifecycle status, derived from the submission SSOT so the
 * PDF projection cannot drift from the persisted union. If
 * {@link SourceWorkSnapshotItem} ever widens, this type widens with it and the
 * exhaustive label map in the renderer stops compiling.
 */
export type WeeklyReportSourceWorkStatus = SourceWorkSnapshotItem['statusAtSnapshot'];

export type WeeklyReportPdfSourceWorkItem = {
  title: string;
  type: string;
  customerName: string | null;
  staffCompletedAt: string;
  /**
   * Copied verbatim from the frozen submission. It is never re-derived from the
   * live source JobCard: a later lifecycle transition must not rewrite what an
   * already submitted report recorded.
   */
  statusAtSnapshot: WeeklyReportSourceWorkStatus;
};

/**
 * Rendering input for one immutable Weekly Report submission.
 *
 * Every field except `staffName` is derived from the frozen
 * `weekly_report_submissions` row. The builder accepts a
 * {@link WeeklyReportSubmission} — never a live report, draft, source-work list
 * or JobCard — so the document model cannot accidentally capture mutable state.
 */
export type WeeklyReportPdfDocumentModel = {
  reportId: string;
  jobCardId: string;
  seqNo: number;
  periodStart: string;
  periodEnd: string;
  submittedAt: string;
  /**
   * Immutable submitter identity, frozen with the submission and never
   * rewritten. Rendered in the document as the stable traceability identifier.
   */
  submittedBy: string;
  /**
   * Presentation-only metadata (the current staff display name). Deliberately
   * not part of the frozen content: it is resolved live and may change on
   * rename, so it is never the report's identity. The stable identity is
   * {@link submittedBy}.
   */
  staffName: string;
  sections: WeeklyReportPdfSection[];
  answers: WeeklyReportPdfAnswer[];
  sourceWork: WeeklyReportPdfSourceWorkItem[];
};

/** Section order and wording mirror the report detail surface. */
const SECTION_LABELS: { key: keyof WeeklyReportSubmission['body']; label: string }[] = [
  { key: 'summary', label: 'Haftanın özeti' },
  { key: 'blockers', label: 'Sorunlar / engeller' },
  { key: 'nextWeekPlan', label: 'Gelecek hafta planı' },
  { key: 'highlights', label: 'Öne çıkan çalışmalar' },
  { key: 'fieldObservations', label: 'Müşteri / saha gözlemleri' },
  { key: 'supportNeeded', label: 'Yöneticiden destek beklenen konular' },
];

/**
 * Plain-text normalization for PDF output: normalize line endings, drop control
 * characters that have no text meaning, and collapse runs of blank lines. No
 * markup is interpreted anywhere in the pipeline, so this only guarantees the
 * renderer receives inert text.
 */
export function sanitizePdfText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function optionalSection(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = sanitizePdfText(value);
  return cleaned.length === 0 ? null : cleaned;
}

export function buildWeeklyReportPdfDocumentModel(input: {
  submission: WeeklyReportSubmission;
  staffName: string;
}): WeeklyReportPdfDocumentModel {
  const { submission, staffName } = input;
  const questions = new Map(submission.questions.map((question) => [question.key, question.prompt]));
  return {
    reportId: submission.weeklyReportId,
    jobCardId: submission.jobCardId,
    seqNo: submission.seqNo,
    periodStart: submission.periodStart,
    periodEnd: submission.periodEnd,
    submittedAt: submission.submittedAt,
    submittedBy: submission.submittedBy,
    staffName: sanitizePdfText(staffName),
    sections: SECTION_LABELS.map((section) => ({
      label: section.label,
      value: optionalSection(submission.body[section.key]),
    })),
    answers: submission.answers
      .map((answer) => ({
        prompt: questions.get(answer.questionKey) ?? answer.questionKey,
        answer: sanitizePdfText(answer.answer),
      }))
      .filter((answer) => answer.answer.length > 0),
    sourceWork: submission.sourceWork.map((item) => ({
      title: sanitizePdfText(item.title),
      type: item.type,
      customerName: item.customerName === null ? null : sanitizePdfText(item.customerName),
      staffCompletedAt: item.staffCompletedAt,
      // Straight from the frozen item. No lookup, no join, no live status.
      statusAtSnapshot: item.statusAtSnapshot,
    })),
  };
}
