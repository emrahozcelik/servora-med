import type { CurrentUser } from '../services/api';
import {
  activeWorkflowPresentation,
  activeWorkflowStatuses,
  type ActiveWorkflowStatus,
} from './job-status-presentation';

export type WorkflowLaneStatus = ActiveWorkflowStatus;

export type WorkflowLane = Readonly<{
  status: WorkflowLaneStatus;
  label: string;
}>;

const desktopOrder: readonly WorkflowLaneStatus[] = activeWorkflowStatuses;

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
