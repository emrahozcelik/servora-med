import type { JobCardStatusFilter } from '../jobs/jobs-api';
import { paths } from '../paths';
import { yesterdayYmd } from './report-range';

/** Canonical İşler filters used by decision-panel attention cards. */
export function jobsStatusHref(status: JobCardStatusFilter) {
  const search = new URLSearchParams();
  if (status !== 'active') search.set('status', status);
  const query = search.toString();
  return query ? `${paths.jobs}?${query}` : paths.jobs;
}

export function jobsOverdueHref(timeZone: string, now: Date = new Date()) {
  const search = new URLSearchParams();
  search.set('status', 'active');
  search.set('dueBefore', yesterdayYmd(timeZone, now));
  return `${paths.jobs}?${search.toString()}`;
}

export function approvalQueueHref() {
  return paths.approvalReports;
}
