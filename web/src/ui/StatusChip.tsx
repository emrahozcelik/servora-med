import type { JobCardStatus } from '../jobs/jobs-api';
import { jobStatusLabels } from '../jobs/job-labels';
import { StatusSignalIcon } from './signal-icons';

export function StatusChip({ status }: { status: JobCardStatus }) {
  const key = status.toLowerCase();
  return (
    <span className={`status-chip status-chip--${key}`} data-status={status}>
      <span className="status-chip-shape" aria-hidden="true">
        <StatusSignalIcon status={status} className="status-chip-icon" />
      </span>
      {jobStatusLabels[status]}
    </span>
  );
}
