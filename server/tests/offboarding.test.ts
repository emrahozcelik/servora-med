import { describe, expect, it } from 'vitest';

import {
  computeStaffOffboardingPlanHash,
  computeStaffOffboardingRequestHash,
  type OffboardingDecisionInput,
  type StaffOffboardingPlan,
} from '../src/modules/people/offboarding.js';

const basePlan = (): Omit<StaffOffboardingPlan, 'planHash'> => ({
  target: {
    id: 'staff-a', organizationId: 'org-1', role: 'STAFF', isActive: true, version: 3,
  },
  jobs: [{ id: 'job-a', status: 'ACCEPTED', version: 4, assignedTo: 'staff-a' }],
  customers: [{ id: 'customer-a', assignedStaffUserId: 'staff-a', version: 2 }],
  calendar: [{
    id: 'event-a', assignedUserId: 'staff-a', status: 'ACTIVE', version: 2,
    startsAt: '2026-08-26T09:00:00.000Z', endsAt: '2026-08-26T10:00:00.000Z',
  }],
  followUps: [{
    jobCardId: 'job-a', proposedAssignee: 'staff-a', proposedAt: '2026-08-25T09:00:00.000Z', version: 4,
  }],
  reminders: [{
    id: 'reminder-a', recipientUserId: 'staff-a', state: 'PENDING',
    remindAt: '2026-08-26T08:30:00.000Z', nextAttemptAt: '2026-08-26T08:30:00.000Z',
  }],
  jobConversations: [{ jobCardId: 'job-a', conversationId: 'conversation-a' }],
  sessions: { activeCount: 2 },
});

const request = (overrides: Partial<OffboardingDecisionInput> = {}): OffboardingDecisionInput => ({
  clientActionId: 'action-a', planHash: 'a'.repeat(64), reasonCode: 'ACCESS_ENDED',
  jobDecisions: [{ jobCardId: 'job-a', replacementUserId: 'staff-b' }],
  calendarDecisions: [{ calendarEventId: 'event-a', replacementUserId: 'staff-c' }],
  followUpDecisions: [{ jobCardId: 'job-a', replacementUserId: 'staff-b' }],
  customerDecisions: [{ customerId: 'customer-a', action: 'REASSIGN', replacementUserId: 'staff-b' }],
  reminderDecisions: [{ reminderId: 'reminder-a', action: 'TRANSFER', replacementUserId: 'staff-c' }],
  ...overrides,
});

describe('Staff offboarding hash contracts', () => {
  it('is deterministic and canonicalizes semantically unordered collections', () => {
    const first = basePlan();
    const reordered = {
      ...first,
      jobs: [...first.jobs].reverse(),
      customers: [...first.customers].reverse(),
      jobConversations: [...first.jobConversations].reverse(),
    };
    expect(computeStaffOffboardingPlanHash(first)).toBe(computeStaffOffboardingPlanHash(reordered));
  });

  it('changes when responsibility identity or semantic version/state changes, not presentation text', () => {
    const first = basePlan();
    expect(computeStaffOffboardingPlanHash(first)).not.toBe(computeStaffOffboardingPlanHash({
      ...first,
      jobs: [{ ...first.jobs[0]!, id: 'job-b' }],
    }));
    expect(computeStaffOffboardingPlanHash(first)).not.toBe(computeStaffOffboardingPlanHash({
      ...first,
      jobs: [{ ...first.jobs[0]!, version: 5 }],
    }));
    expect(computeStaffOffboardingPlanHash(first)).toBe(computeStaffOffboardingPlanHash({
      ...first,
      target: { ...first.target },
    }));
  });

  it('includes the target and every explicit business decision in the request hash', () => {
    const first = computeStaffOffboardingRequestHash({ ...request(), targetUserId: 'staff-a' });
    expect(computeStaffOffboardingRequestHash({ ...request(), targetUserId: 'staff-b' })).not.toBe(first);
    expect(computeStaffOffboardingRequestHash({ ...request(), targetUserId: 'staff-a', reasonCode: 'ROLE_CHANGED' })).not.toBe(first);
    expect(computeStaffOffboardingRequestHash({
      ...request(), targetUserId: 'staff-a',
      jobDecisions: [{ jobCardId: 'job-a', replacementUserId: 'staff-c' }],
    })).not.toBe(first);
  });
});
