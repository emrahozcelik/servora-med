import type { CurrentUser } from '../services/api';
import type { JobCard, JobCardListItem } from './jobs-api';

type CapabilityJob = Pick<JobCard, 'type' | 'status' | 'assignedTo'>
  | Pick<JobCardListItem, 'type' | 'status' | 'assignee'>;

function assignedTo(job: CapabilityJob) {
  return 'assignedTo' in job ? job.assignedTo : job.assignee.id;
}

export function jobCapabilities(user: CurrentUser, job: CapabilityJob) {
  const assignedStaff = user.role === 'STAFF' && user.id === assignedTo(job);
  const meetingVisible = job.type === 'SALES_MEETING'
    && !['NEW', 'PLANNED'].includes(job.status);
  const meetingEditable = job.type === 'SALES_MEETING'
    && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
    && (user.role !== 'STAFF' || assignedStaff);
  const canWithdrawFromApproval = assignedStaff && job.status === 'WAITING_APPROVAL';
  const canCancel = user.role === 'STAFF'
    ? assignedStaff && job.status === 'WAITING_APPROVAL'
    : ['NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED']
        .includes(job.status);

  return {
    canViewMeetingResult: meetingVisible,
    canEditMeetingResult: meetingEditable,
    canViewMeetingNotes: meetingVisible,
    canAddMeetingNote: meetingEditable,
    canWithdrawFromApproval,
    canCancel,
  };
}
