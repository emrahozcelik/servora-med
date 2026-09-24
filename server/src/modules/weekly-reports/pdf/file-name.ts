/**
 * Deterministic, ASCII-safe attachment filename for one immutable submission.
 *
 * The period is validated rather than interpolated blindly: a filename must
 * never be able to carry a path separator, a quote or a header-breaking
 * character into `Content-Disposition`.
 */
export function weeklyReportPdfFileName(periodStart: string, seqNo: number): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(periodStart) ? periodStart : 'tarihsiz';
  const seq = Number.isSafeInteger(seqNo) && seqNo >= 1 ? seqNo : 1;
  return `haftalik-rapor-${date}-seq-${seq}.pdf`;
}
