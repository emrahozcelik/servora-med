import { describe, expect, it } from 'vitest';

import type {
  ActivityInput,
  CriticalActionClaim,
  JobCardRepository,
  JobCardTransaction,
  JobCardAuditInput,
  JobCardInvalidationUpdateInput,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };

function makeRepository() {
  let job: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'COMPLETED',
    version: 4, title: 'Klinik teslimi', description: null, customerId: 'customer-1',
    contactId: null, assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal',
    dueDate: null, scheduledAt: '2030-01-01T10:00:00.000Z', scheduledEndsAt: '2030-01-01T10:30:00.000Z',
    engagementKind: null, sourceJobCardId: null, followUpInstructions: null,
    followUpProposedAt: null, followUpProposedType: null, followUpProposedAssignee: null,
    followUpProposalInstructions: null, followUpProposalOrigin: null, followUpProposedBy: null,
    invalidatedAt: null, invalidatedBy: null, invalidationReasonCode: null,
  };
  const activities: ActivityInput[] = [];
  const audits: JobCardAuditInput[] = [];
  const reminders: unknown[] = [];
  const realtime: unknown[] = [];
  const claims: CriticalActionClaim[] = [];
  const detail = () => ({
    ...job,
    organizationTimezone: 'Europe/Istanbul',
    assignee: { id: 'staff-1', name: 'Staff One' },
    customer: { id: 'customer-1', name: 'Demo Klinik' },
    contact: null,
    proposer: null,
    lifecycle: {
      createdAt: '2026-01-01T10:00:00.000Z', acceptedAt: null, acceptedBy: null,
      startedAt: '2026-01-01T10:05:00.000Z', submittedAt: '2026-01-01T10:10:00.000Z',
      submittedBy: { id: 'staff-1', name: 'Staff One' }, submissionNote: null,
      approvedAt: '2026-01-01T10:20:00.000Z', approvedBy: { id: 'manager-1', name: 'Manager One' },
      approvalNote: null, revisionRequestedAt: null, revisionRequestedBy: null,
      revisionReason: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
      cancelledFromStatus: null,
      invalidatedAt: job.invalidatedAt,
      invalidatedBy: job.invalidatedBy ? { id: job.invalidatedBy, name: 'Admin One' } : null,
      invalidationReasonCode: job.invalidationReasonCode,
      invalidatedFromStatus: job.invalidatedAt ? 'COMPLETED' : null,
    },
  });
  const tx = {
    getJobForUpdate: async () => ({ ...job }),
    listActiveFollowUpChildrenForUpdate: async () => [],
    invalidateWithVersion: async (input: JobCardInvalidationUpdateInput) => {
      job = {
        ...job,
        status: 'INVALIDATED', version: job.version + 1,
        invalidatedAt: input.invalidatedAt.toISOString(), invalidatedBy: input.invalidatedBy,
        invalidationReasonCode: input.reasonCode,
      };
      return { ...job };
    },
    appendActivity: async (input: ActivityInput) => {
      activities.push(input);
      return { id: 'activity-1', createdAt: new Date('2026-08-24T10:00:00.000Z') };
    },
    appendAudit: async (input: JobCardAuditInput) => { audits.push(input); },
    synchronizeCalendarReminder: async (input: unknown) => { reminders.push(input); },
    appendRealtimeEvent: async (input: unknown) => {
      realtime.push(input);
      return { ...(input as object), id: 1n };
    },
    listActiveManagementRecipients: async () => [],
    appendNotifications: async () => [],
    appendWebPushDeliveries: async () => [],
    getNoteAuthorSnapshot: async () => ({ id: 'admin-1', name: 'Admin One', role: 'ADMIN' as const, isActive: true }),
    createNote: async (input: { id: string; jobCardId: string; note: string }) => ({
      ...input, invoiceNumber: null, createdAt: '2026-08-24T10:00:00.000Z', recordVersion: 1 as const,
      author: { id: 'admin-1', name: 'Admin One', role: 'ADMIN' as const, source: 'SNAPSHOT' as const },
      workflowStage: 'COMPLETED' as const, context: 'INVALIDATE' as const,
      relatedActivityId: 'activity-1',
    }),
  } as unknown as JobCardTransaction;
  const repository = {
    executeCriticalAction: async <T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<unknown>) => {
      claims.push(claim);
      const result = await work(tx);
      return { kind: 'completed' as const, ...(result as object) } as { kind: 'completed'; response: T; realtimeEvents: readonly never[] };
    },
    findJobCardDetail: async () => detail(),
  } as unknown as JobCardRepository;
  return { repository, job: () => job, activities, audits, reminders, realtime, claims };
}

describe('JobCardService invalidation', () => {
  it('atomically invalidates a completed JobCard and emits safe durable effects', async () => {
    const state = makeRepository();
    const result = await new JobCardService(state.repository).invalidate(admin, 'job-1', {
      clientActionId: 'action-1', expectedVersion: 4, reasonCode: 'DUPLICATE', note: 'duplicate note',
    });

    expect(result).toMatchObject({ status: 'INVALIDATED', version: 5, invalidationReasonCode: 'DUPLICATE' });
    expect(state.activities[0]).toMatchObject({
      event: 'JOB_INVALIDATED', oldValue: { status: 'COMPLETED', version: 4 },
      newValue: { status: 'INVALIDATED', version: 5 },
    });
    expect(state.audits[0]).toMatchObject({
      subjectId: 'job-1', oldValue: { status: 'COMPLETED', version: 4 },
      newValue: { status: 'INVALIDATED', version: 5 },
      metadata: { reasonCode: 'DUPLICATE', clientActionId: 'action-1' },
    });
    expect(JSON.stringify(state.audits[0])).not.toContain('duplicate note');
    expect(state.reminders).toHaveLength(1);
    expect(state.reminders[0]).toMatchObject({ active: false, jobCardId: 'job-1' });
    expect(state.realtime[0]).toMatchObject({ type: 'job.invalidated', entityId: 'job-1' });
    expect(state.claims[0]).toMatchObject({
      operationKey: 'JOB_INVALIDATE:job-1',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
