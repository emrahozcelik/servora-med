import type { JobCardStatusFilter } from '../jobs/jobs-api';
import { paths } from '../paths';

/** Canonical İşler filters used by decision-panel attention cards. */
export function jobsStatusHref(status: JobCardStatusFilter) {
  const search = new URLSearchParams();
  if (status !== 'active') search.set('status', status);
  const query = search.toString();
  return query ? `${paths.jobs}?${query}` : paths.jobs;
}


export function approvalQueueHref() {
  return paths.approvalReports;
}
