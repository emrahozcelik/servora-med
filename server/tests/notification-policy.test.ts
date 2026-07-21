import { describe, expect, it } from 'vitest';

import { createJobCardNotificationDrafts } from '../src/modules/notifications/policy.js';

describe('JobCard notification policy', () => {
  it('creates an assignment notification for a newly assigned staff member', () => {
    expect(createJobCardNotificationDrafts({
      event: 'JOB_CREATED',
      actorUserId: 'manager-1',
      afterAssigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    })).toEqual([
      {
        recipientUserId: 'staff-1',
        kind: 'job.assigned',
        entityType: 'job-card',
        entityId: 'job-1',
      },
    ]);
  });

  it('notifies active management recipients when a job is submitted for approval', () => {
    expect(createJobCardNotificationDrafts({
      event: 'JOB_SUBMITTED_FOR_APPROVAL',
      actorUserId: 'manager-1',
      afterAssigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [
        { id: 'manager-1', role: 'MANAGER', isActive: true },
        { id: 'admin-1', role: 'ADMIN', isActive: true },
        { id: 'inactive-manager', role: 'MANAGER', isActive: false },
      ],
    })).toEqual([
      {
        recipientUserId: 'admin-1',
        kind: 'job.awaiting_approval',
        entityType: 'job-card',
        entityId: 'job-1',
      },
    ]);
  });

  it('notifies only the new assignee when a job is reassigned', () => {
    expect(createJobCardNotificationDrafts({
      event: 'JOB_ASSIGNED',
      actorUserId: 'manager-1',
      afterAssigneeId: 'new-staff-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    })).toEqual([
      {
        recipientUserId: 'new-staff-1',
        kind: 'job.reassigned',
        entityType: 'job-card',
        entityId: 'job-1',
      },
    ]);
  });

  it.each([
    ['JOB_APPROVED', 'job.approved'],
    ['JOB_REVISION_REQUESTED', 'job.revision_requested'],
    ['JOB_CANCELLED', 'job.cancelled'],
  ] as const)('notifies the current assignee for %s', (event, kind) => {
    expect(createJobCardNotificationDrafts({
      event,
      actorUserId: 'manager-1',
      afterAssigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    })).toEqual([
      {
        recipientUserId: 'staff-1',
        kind,
        entityType: 'job-card',
        entityId: 'job-1',
      },
    ]);
  });

  it('does not create a notification for the actor or unsupported activity', () => {
    expect(createJobCardNotificationDrafts({
      event: 'JOB_CREATED',
      actorUserId: 'staff-1',
      afterAssigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    })).toEqual([]);
    expect(createJobCardNotificationDrafts({
      event: 'JOB_STARTED',
      actorUserId: 'staff-1',
      afterAssigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    })).toEqual([]);
  });
});
