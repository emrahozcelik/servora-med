import { paths } from '../paths';
import type { ReportNavSection } from './report-shell';

export type ReportRangeContext = {
  from: string | null;
  to: string | null;
};

/**
 * Build report section hrefs. Summary ↔ Staff ↔ deliveries preserve from/to.
 * Approvals is an instant queue and never carries date params.
 */
export function reportSectionHref(
  section: ReportNavSection,
  range: ReportRangeContext | null | undefined,
): string {
  if (section === 'approvals') return paths.approvalReports;

  const search = new URLSearchParams();
  if (range?.from && range?.to) {
    search.set('from', range.from);
    search.set('to', range.to);
  }
  const query = search.toString();
  const base = section === 'summary'
    ? paths.reports
    : section === 'staff'
      ? paths.staffPerformanceReports
      : section === 'customers'
        ? paths.customerReports
        : paths.deliveryReports;
  return query ? `${base}?${query}` : base;
}
