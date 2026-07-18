import type { CurrentUser } from '../services/api';
import type { JobCardBoard } from './jobs-api';

export type WorkflowLaneStatus = keyof JobCardBoard['columns'];

export type WorkflowLane = Readonly<{
  status: WorkflowLaneStatus;
  label: string;
}>;

export const activeWorkflowPresentation: Readonly<Record<WorkflowLaneStatus, WorkflowLane>> = {
  NEW: { status: 'NEW', label: 'Hazırlanıyor' },
  ACCEPTED: { status: 'ACCEPTED', label: 'Atandı' },
  IN_PROGRESS: { status: 'IN_PROGRESS', label: 'Uygulanıyor' },
  WAITING_APPROVAL: { status: 'WAITING_APPROVAL', label: 'Yönetici kontrolünde' },
  REVISION_REQUESTED: { status: 'REVISION_REQUESTED', label: 'Düzeltme istendi' },
};

const desktopOrder: readonly WorkflowLaneStatus[] = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
];

export const activeWorkflowStatusOptions = desktopOrder.map((status) => ({
  value: status,
  label: activeWorkflowPresentation[status].label,
}));

const staffCompactOrder: readonly WorkflowLaneStatus[] = [
  'REVISION_REQUESTED', 'IN_PROGRESS', 'ACCEPTED', 'NEW', 'WAITING_APPROVAL',
];

const managerCompactOrder: readonly WorkflowLaneStatus[] = [
  'WAITING_APPROVAL', 'REVISION_REQUESTED', 'IN_PROGRESS', 'NEW', 'ACCEPTED',
];

export function workflowLanesFor(role: CurrentUser['role'], compact: boolean): readonly WorkflowLane[] {
  const order = !compact ? desktopOrder : role === 'STAFF' ? staffCompactOrder : managerCompactOrder;
  return order.map((status) => activeWorkflowPresentation[status]);
}
