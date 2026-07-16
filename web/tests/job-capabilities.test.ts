import { describe, expect, it } from 'vitest';

import { jobCapabilities } from '../src/jobs/job-capabilities';
import type { JobCard, JobCardStatus } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Staff', email: 'staff@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = { ...staff, id: 'manager-1', role: 'MANAGER' };
const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'NEW', version: 1,
  title: 'Görüşme', description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: '2026-07-20',
  assignee: { id: 'staff-1', name: 'Staff' }, customer: { id: 'customer-1', name: 'Klinik' },
  contact: null,
};

describe('canonical JobCard UI capabilities', () => {
  it.each([
    ['NEW', false, false, false, false], ['PLANNED', false, false, false, false],
    ['IN_PROGRESS', true, true, true, true], ['REVISION_REQUESTED', true, true, true, true],
    ['WAITING_APPROVAL', true, false, true, false], ['COMPLETED', true, false, true, false],
    ['CANCELLED', true, false, true, false],
  ] as const)('projects Sales Meeting %s result and note visibility', (
    status, canViewMeetingResult, canEditMeetingResult, canViewMeetingNotes, canAddMeetingNote,
  ) => {
    expect(jobCapabilities(staff, { ...job, status })).toMatchObject({
      canViewMeetingResult, canEditMeetingResult, canViewMeetingNotes, canAddMeetingNote,
    });
  });

  it('offers waiting withdrawal and cancellation only to assigned Staff', () => {
    const waiting = { ...job, status: 'WAITING_APPROVAL' as JobCardStatus };
    expect(jobCapabilities(staff, waiting)).toMatchObject({
      canWithdrawFromApproval: true, canCancel: true,
    });
    expect(jobCapabilities({ ...staff, id: 'staff-2' }, waiting)).toMatchObject({
      canWithdrawFromApproval: false, canCancel: false,
    });
    expect(jobCapabilities(manager, waiting)).toMatchObject({ canWithdrawFromApproval: false });
  });

  it('does not apply meeting sections to other JobCard types', () => {
    expect(jobCapabilities(staff, { ...job, type: 'GENERAL_TASK', status: 'IN_PROGRESS' }))
      .toMatchObject({
        canViewMeetingResult: false, canEditMeetingResult: false,
        canViewMeetingNotes: false, canAddMeetingNote: false,
      });
  });
});
