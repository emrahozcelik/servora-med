import type { JobCardStatus } from '../jobs/jobs-api';
import { jobStatusLabels } from '../jobs/job-labels';

export function StatusChip({ status }: { status: JobCardStatus }) {
  const key = status.toLowerCase();
  return (
    <span className={`status-chip status-chip--${key}`} data-status={status}>
      <span className="status-chip-shape" aria-hidden="true" />
      {jobStatusLabels[status]}
    </span>
  );
}
