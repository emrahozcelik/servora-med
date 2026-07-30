import { describe, expect, it } from 'vitest';

import {
  createJobCardNotificationDrafts,
  createNoteAddedNotificationDrafts,
} from '../src/modules/notifications/policy.js';

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

describe('createNoteAddedNotificationDrafts', () => {
  const activeMgmt = [
    { id: 'admin-1', role: 'ADMIN' as const, isActive: true },
    { id: 'manager-1', role: 'MANAGER' as const, isActive: true },
  ];
  const mixedMgmt = [
    { id: 'admin-1', role: 'ADMIN' as const, isActive: true },
    { id: 'manager-1', role: 'MANAGER' as const, isActive: true },
    { id: 'inactive-mgr', role: 'MANAGER' as const, isActive: false },
  ];

  it('includes active Admin and active Manager from management recipients', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'actor-1',
      assigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: mixedMgmt,
    });
    const ids = result.map((d) => d.recipientUserId).sort();
    expect(ids).toEqual(['admin-1', 'manager-1', 'staff-1'].sort());
    result.forEach((d) => {
      expect(d.kind).toBe('job.note_added');
      expect(d.entityType).toBe('job-card');
      expect(d.entityId).toBe('job-1');
    });
  });

  it('excludes the actor from notifications', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'manager-1',
      assigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: activeMgmt,
    });
    const ids = result.map((d) => d.recipientUserId);
    expect(ids).not.toContain('manager-1');
    expect(ids).toContain('staff-1');
    expect(ids).toContain('admin-1');
  });

  it('excludes actor when actor is the assignee', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'staff-1',
      assigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: activeMgmt,
    });
    const ids = result.map((d) => d.recipientUserId);
    expect(ids).not.toContain('staff-1');
    expect(ids).toContain('admin-1');
    expect(ids).toContain('manager-1');
    expect(result).toHaveLength(2);
  });

  it('excludes actor when actor is both management and assignee', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'manager-1',
      assigneeId: 'manager-1',
      jobCardId: 'job-1',
      managementRecipients: activeMgmt,
    });
    const ids = result.map((d) => d.recipientUserId);
    expect(ids).not.toContain('manager-1');
    expect(ids).toContain('admin-1');
    expect(result).toHaveLength(1);
  });

  it('deduplicates when a management recipient is also the assignee', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'other-actor',
      assigneeId: 'admin-1',
      jobCardId: 'job-1',
      managementRecipients: activeMgmt,
    });
    const ids = result.map((d) => d.recipientUserId);
    // admin-1 appears only once despite being both mgmt and assignee
    expect(ids.filter((id) => id === 'admin-1')).toHaveLength(1);
    expect(result).toHaveLength(2); // admin-1 + manager-1
  });

  it('excludes inactive management recipients', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'actor-1',
      assigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: [
        { id: 'inactive-1', role: 'ADMIN' as const, isActive: false },
        { id: 'inactive-2', role: 'MANAGER' as const, isActive: false },
      ],
    });
    const ids = result.map((d) => d.recipientUserId);
    expect(ids).not.toContain('inactive-1');
    expect(ids).not.toContain('inactive-2');
    expect(ids).toEqual(['staff-1']);
  });

  it('returns zero drafts when all eligible recipients are the actor', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'admin-1',
      assigneeId: 'admin-1',
      jobCardId: 'job-1',
      managementRecipients: [
        { id: 'admin-1', role: 'ADMIN' as const, isActive: true },
      ],
    });
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it('returns zero drafts when there are no active recipients at all', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'actor-1',
      assigneeId: 'actor-1',
      jobCardId: 'job-1',
      managementRecipients: [],
    });
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it('excludes unrelated Staff who are neither management nor assignee', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'actor-1',
      assigneeId: 'staff-1',
      jobCardId: 'job-1',
      managementRecipients: activeMgmt,
    });
    const ids = result.map((d) => d.recipientUserId);
    expect(ids).not.toContain('other-staff');
    expect(ids).not.toContain('unrelated-user');
  });

  it('all drafts use job.note_added kind with correct entity', () => {
    const result = createNoteAddedNotificationDrafts({
      actorUserId: 'actor-1',
      assigneeId: 'staff-1',
      jobCardId: 'target-job-id',
      managementRecipients: activeMgmt,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    result.forEach((draft) => {
      expect(draft.kind).toBe('job.note_added');
      expect(draft.entityType).toBe('job-card');
      expect(draft.entityId).toBe('target-job-id');
    });
  });
});
