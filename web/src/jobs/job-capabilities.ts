import type { CurrentUser } from '../services/api';
import type { JobCard, JobCardListItem } from './jobs-api';

type CapabilityJob = Pick<JobCard, 'type' | 'status' | 'assignedTo'>
  | Pick<JobCardListItem, 'type' | 'status' | 'assignee'>;

function assignedTo(job: CapabilityJob) {
  return 'assignedTo' in job ? job.assignedTo : job.assignee.id;
}

export function jobCapabilities(user: CurrentUser, job: CapabilityJob) {
  const assignedStaff = user.role === 'STAFF' && user.id === assignedTo(job);
  const authorized = user.role !== 'STAFF' || assignedStaff;
  const active = !['COMPLETED', 'CANCELLED'].includes(job.status);
  const meetingVisible = job.type === 'SALES_MEETING'
    && !['NEW', 'PLANNED'].includes(job.status);
  const meetingEditable = job.type === 'SALES_MEETING'
    && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
    && (user.role !== 'STAFF' || assignedStaff);
  const canEditJob = job.type === 'SALES_MEETING' && active && authorized;
  const requiresWithdrawalBeforeEdit = canEditJob && job.status === 'WAITING_APPROVAL';
  const canWithdrawFromApproval = authorized && job.status === 'WAITING_APPROVAL';
  const canCancel = active && authorized;

  return {
    canViewMeetingResult: meetingVisible,
    canEditMeetingResult: meetingEditable,
    canViewMeetingNotes: meetingVisible,
    canAddMeetingNote: meetingEditable,
    canEditJob,
    requiresWithdrawalBeforeEdit,
    canWithdrawFromApproval,
    canCancel,
  };
}
