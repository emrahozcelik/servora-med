import type { JobCardStatus } from '../jobs/jobs-api';

export const statusChipLabels: Record<JobCardStatus, string> = {
  NEW: 'Yeni',
  PLANNED: 'Planlandı',
  IN_PROGRESS: 'Devam ediyor',
  WAITING_APPROVAL: 'Onay bekliyor',
  REVISION_REQUESTED: 'Düzeltme istendi',
  COMPLETED: 'Tamamlandı',
  CANCELLED: 'İptal edildi',
};

export function StatusChip({ status }: { status: JobCardStatus }) {
  const key = status.toLowerCase();
  return (
    <span className={`status-chip status-chip--${key}`} data-status={status}>
      <span className="status-chip-shape" aria-hidden="true" />
      {statusChipLabels[status]}
    </span>
  );
}
