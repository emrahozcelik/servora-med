import type { ReportReaders } from '../../src/modules/reports/ports.js';

/**
 * Test double for the report read snapshot. It runs the composition against the
 * supplied port doubles, so service-level assertions still observe every read
 * while production would pin them to a single database snapshot.
 */
export function passThroughReportReadSnapshot(
  reports: unknown,
  approvalItems: unknown,
) {
  return {
    run: <T>(work: (readers: ReportReaders) => Promise<T>): Promise<T> =>
      work({ reports, approvalItems } as unknown as ReportReaders),
  };
}
