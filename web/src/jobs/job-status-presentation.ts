import type { JobCardStatus } from './jobs-api';

export const activeWorkflowStatuses = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const satisfies readonly JobCardStatus[];

export type ActiveWorkflowStatus = (typeof activeWorkflowStatuses)[number];

export type ActiveWorkflowPresentation = Readonly<{
  status: ActiveWorkflowStatus;
  label: string;
}>;

export const activeWorkflowPresentation: Readonly<
  Record<ActiveWorkflowStatus, ActiveWorkflowPresentation>
> = {
  NEW: { status: 'NEW', label: 'Hazırlanıyor' },
  ACCEPTED: { status: 'ACCEPTED', label: 'Atandı' },
  IN_PROGRESS: { status: 'IN_PROGRESS', label: 'Uygulanıyor' },
  WAITING_APPROVAL: { status: 'WAITING_APPROVAL', label: 'Yönetici kontrolünde' },
  REVISION_REQUESTED: { status: 'REVISION_REQUESTED', label: 'Düzeltme istendi' },
};

export const activeWorkflowStatusOptions = activeWorkflowStatuses.map((status) => ({
  value: status,
  label: activeWorkflowPresentation[status].label,
}));
