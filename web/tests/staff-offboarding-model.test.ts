import { describe, expect, it } from 'vitest';

import {
  buildOffboardingRequest,
  createOffboardingDraft,
  missingOffboardingDecisions,
} from '../src/people/staff-offboarding-model';
import type { StaffOffboardingPlan } from '../src/services/people-api';

const plan: StaffOffboardingPlan = {
  target: { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true, version: 3 },
  jobs: [{ id: 'job-1', status: 'IN_PROGRESS', version: 2, assignedTo: 'staff-1' }],
  customers: [{ id: 'customer-1', assignedStaffUserId: 'staff-1', version: 4 }],
  calendar: [{ id: 'event-1', assignedUserId: 'staff-1', status: 'ACTIVE', version: 1,
    startsAt: '2026-09-01T08:00:00.000Z', endsAt: '2026-09-01T09:00:00.000Z' }],
  followUps: [{ jobCardId: 'job-2', proposedAssignee: 'staff-1', proposedAt: '2026-09-03T08:00:00.000Z', version: 5 }],
  reminders: [{ id: 'reminder-1', recipientUserId: 'staff-1', state: 'PENDING',
    remindAt: '2026-09-01T07:45:00.000Z', nextAttemptAt: '2026-09-01T07:45:00.000Z' }],
  jobConversations: [{ jobCardId: 'job-1', conversationId: 'conversation-1' }],
  sessions: { activeCount: 2 },
  planHash: 'a'.repeat(64),
};

describe('Staff offboarding decision model', () => {
  it('requires a reason and one explicit decision for every active responsibility', () => {
    const draft = createOffboardingDraft(plan);
    expect(missingOffboardingDecisions(plan, draft)).toEqual([
      'reason', 'job:job-1', 'customer:customer-1', 'calendar:event-1',
      'follow-up:job-2', 'reminder:reminder-1',
    ]);
  });

  it('builds only the exact approved plan decisions and preserves safe non-transfer actions', () => {
    const draft = createOffboardingDraft(plan);
    draft.reasonCode = 'ACCESS_ENDED';
    draft.jobs['job-1'] = 'staff-2';
    draft.customers['customer-1'] = { action: 'UNASSIGN' };
    draft.calendar['event-1'] = 'staff-2';
    draft.followUps['job-2'] = 'staff-3';
    draft.reminders['reminder-1'] = { action: 'CANCEL' };

    expect(buildOffboardingRequest(plan, draft, 'r4b-action-1')).toEqual({
      clientActionId: 'r4b-action-1', planHash: plan.planHash, reasonCode: 'ACCESS_ENDED',
      jobDecisions: [{ jobCardId: 'job-1', replacementUserId: 'staff-2' }],
      customerDecisions: [{ customerId: 'customer-1', action: 'UNASSIGN' }],
      calendarDecisions: [{ calendarEventId: 'event-1', replacementUserId: 'staff-2' }],
      followUpDecisions: [{ jobCardId: 'job-2', replacementUserId: 'staff-3' }],
      reminderDecisions: [{ reminderId: 'reminder-1', action: 'CANCEL' }],
    });
  });

  it('fails closed when draft keys or replacement values do not match the preview', () => {
    const draft = createOffboardingDraft(plan);
    draft.reasonCode = 'ROLE_CHANGED';
    draft.jobs['job-1'] = 'staff-2';
    draft.jobs['unapproved-job'] = 'staff-2';
    draft.customers['customer-1'] = { action: 'REASSIGN', replacementUserId: '' };
    draft.calendar['event-1'] = 'staff-2';
    draft.followUps['job-2'] = 'staff-2';
    draft.reminders['reminder-1'] = { action: 'TRANSFER', replacementUserId: 'staff-2' };

    expect(() => buildOffboardingRequest(plan, draft, 'r4b-action-2')).toThrow(/güncel önizlemeyle eşleşmiyor/i);
  });
});
