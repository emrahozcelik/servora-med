import { describe, expect, it } from 'vitest';

import {
  buildJobCardAudience,
  canViewRealtimeEvent,
} from '../src/modules/realtime/audience.js';
import {
  mapJobCardActivityToRealtime,
} from '../src/modules/realtime/event-mapper.js';

const base = {
  activityId: 'activity-1',
  organizationId: 'org-1',
  jobCardId: 'job-1',
  actorUserId: 'manager-1',
  occurredAt: new Date('2026-07-19T14:30:00.000Z'),
  beforeAssigneeId: 'staff-old',
  afterAssigneeId: 'staff-new',
};

describe('realtime JobCard contract', () => {
  it('addresses management and both assignees on reassignment', () => {
    expect(buildJobCardAudience({
      event: 'JOB_ASSIGNED',
      beforeAssigneeId: 'staff-old',
      afterAssigneeId: 'staff-new',
    })).toEqual({
      roles: ['ADMIN', 'MANAGER'],
      userIds: ['staff-new', 'staff-old'],
    });
  });

  it('never grants an unrelated staff user visibility', () => {
    const event = mapJobCardActivityToRealtime({
      ...base,
      event: 'JOB_ASSIGNED',
    });

    expect(canViewRealtimeEvent(
      { organizationId: 'org-1', userId: 'staff-other', role: 'STAFF' },
      event!,
    )).toBe(false);
  });

  it.each([
    ['JOB_CREATED', 'job.created'],
    ['JOB_ASSIGNED', 'job.assignment_changed'],
    ['JOB_ACCEPTED', 'job.accepted'],
    ['JOB_STARTED', 'job.started'],
    ['JOB_SUBMITTED_FOR_APPROVAL', 'job.submitted_for_approval'],
    ['JOB_APPROVED', 'job.approved'],
    ['JOB_REVISION_REQUESTED', 'job.revision_requested'],
    ['JOB_CANCELLED', 'job.cancelled'],
    ['JOB_FIELDS_UPDATED', 'job.updated'],
    ['JOB_PLANNED', 'job.updated'],
    ['JOB_RESUMED', 'job.updated'],
    ['JOB_APPROVAL_WITHDRAWN', 'job.updated'],
  ] as const)('maps %s to %s', (activity, expected) => {
    expect(mapJobCardActivityToRealtime({
      ...base,
      event: activity,
    })!.type).toBe(expected);
  });

  it.each([
    'NOTE_ADDED',
    'DELIVERY_ITEM_ADDED',
    'DELIVERY_ITEM_UPDATED',
    'DELIVERY_ITEM_REMOVED',
    'MEETING_DETAILS_UPDATED',
  ] as const)('excludes %s from phase N', (activity) => {
    expect(mapJobCardActivityToRealtime({
      ...base,
      event: activity,
    })).toBeNull();
  });

  it('adds approval, staff profile, and report invalidations for submission', () => {
    const event = mapJobCardActivityToRealtime({
      ...base,
      beforeAssigneeId: 'staff-new',
      event: 'JOB_SUBMITTED_FOR_APPROVAL',
    });

    expect(event?.resourceKeys).toEqual([
      'approval-queue',
      'job-board',
      'job-detail:job-1',
      'job-list',
      'reports',
      'staff-profile:staff-new',
    ]);
  });
});
