import type { JobCardPriority } from '../jobs/jobs-api';
import { PrioritySignalIcon } from './signal-icons';

export const priorityChipLabels: Record<JobCardPriority, string> = {
  low: 'Düşük',
  normal: 'Normal',
  high: 'Yüksek',
  urgent: 'Acil',
};

/** Longer labels used where space allows (list rows). */
export const priorityChipLabelsLong: Record<JobCardPriority, string> = {
  low: 'Düşük öncelik',
  normal: 'Normal öncelik',
  high: 'Yüksek öncelik',
  urgent: 'Acil öncelik',
};

export function PriorityChip({
  priority,
  longLabel = false,
}: {
  priority: JobCardPriority;
  longLabel?: boolean;
}) {
  const label = longLabel ? priorityChipLabelsLong[priority] : priorityChipLabels[priority];
  return (
    <span className={`priority-chip priority-chip--${priority}`} data-priority={priority}>
      <span className="priority-chip-icon" aria-hidden="true">
        <PrioritySignalIcon priority={priority} className="signal-icon" />
      </span>
      {label}
    </span>
  );
}
