import { describe, expect, it } from 'vitest';

import type {
  CriticalActionClaim,
  JobCardRepository,
  JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActivityEvent, JobCardActor } from '../src/modules/job-cards/types.js';

type Activity = { event: JobCardActivityEvent; jobCardId: string; actorId: string; clientActionId: string };

class MemoryJobCardRepository implements JobCardRepository {
  job: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
    version: 1, title: 'Klinik teslimi', customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
    description: null, scheduledAt: '2026-07-16T11:30:00.000Z',
  };
  activities: Activity[] = [];
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  failActivity = false;

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    this.processing.add(key);
    const jobBefore = { ...this.job };
    const activityCount = this.activities.length;
    const tx: JobCardTransaction = {
      getJobForUpdate: async (organizationId, id) =>
        this.job.organizationId === organizationId && this.job.id === id ? { ...this.job } : null,
      getJobDetail: async (organizationId, id) =>
        this.job.organizationId === organizationId && this.job.id === id
          ? {
              ...this.job,
              assignee: { id: this.job.assignedTo, name: 'Staff One' },
              customer: this.job.customerId ? { id: this.job.customerId, name: 'Demo Klinik' } : null,
              contact: null,
              lifecycle: {
                createdAt: '2026-07-13T10:00:00.000Z',
                acceptedAt: '2026-07-13T10:05:00.000Z',
                acceptedBy: { id: 'staff-1', name: 'Staff One' },
                startedAt: null, submittedAt: null, submittedBy: null,
                submissionNote: null, approvedAt: null, approvedBy: null, approvalNote: null,
                revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
                cancelledAt: null, cancelledBy: null, cancelReason: null,
                cancelledFromStatus: null,
              },
            }
          : null,
      transitionWithVersion: async (input) => {
        if (this.job.id !== input.jobCardId || this.job.version !== input.expectedVersion) return null;
        this.job = { ...this.job, status: input.status, version: this.job.version + 1 };
        return { ...this.job };
      },
      createMeetingDetails: async () => { throw new Error('unused'); },
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push({ event: input.event, jobCardId: input.jobCardId, actorId: input.actorId, clientActionId: input.clientActionId });
      },
      getAssignee: async () => ({
        id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: true,
      }),
      getSubmissionCustomer: async () => ({
        id: 'customer-1', organizationId: 'org-1', status: 'active' as const,
      }),
      getSubmissionMeetingDetails: async () => null,
      getSubmissionDeliveryItems: async () => [],
    };
    try {
      const response = await work(tx);
      this.completed.set(key, response);
      return { kind: 'completed' as const, response };
    } catch (error) {
      this.job = jobBefore;
      this.activities.splice(activityCount);
      throw error;
    } finally { this.processing.delete(key); }
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const input = { expectedVersion: 1, clientActionId: 'action-1' };

describe('JobCardService critical command foundation', () => {
  it('starts a JobCard, increments version, and appends one canonical activity', async () => {
    const repository = new MemoryJobCardRepository();
    const result = await new JobCardService(repository).start(staff, 'job-1', input);
    expect(result).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(repository.activities).toEqual([{ event: 'JOB_STARTED', jobCardId: 'job-1', actorId: 'staff-1', clientActionId: 'action-1' }]);
  });

  it('replays the original response without another mutation or event', async () => {
    const repository = new MemoryJobCardRepository();
    const service = new JobCardService(repository);
    const first = await service.start(staff, 'job-1', input);
    const duplicate = await service.start(staff, 'job-1', input);
    expect(duplicate).toEqual(first);
    expect(repository.job.version).toBe(2);
    expect(repository.activities).toHaveLength(1);
  });

  it('returns ACTION_IN_PROGRESS for a live duplicate claim', async () => {
    const repository = new MemoryJobCardRepository();
    repository.processing.add('org-1:staff-1:action-1:JOB_START:job-1');
    await expect(new JobCardService(repository).start(staff, 'job-1', input)).rejects.toMatchObject({
      code: 'ACTION_IN_PROGRESS', statusCode: 409,
    });
  });

  it('returns VERSION_CONFLICT without mutation or activity for stale input', async () => {
    const repository = new MemoryJobCardRepository();
    await expect(new JobCardService(repository).start(staff, 'job-1', { ...input, expectedVersion: 9 }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(repository.job).toMatchObject({ status: 'ACCEPTED', version: 1 });
    expect(repository.activities).toHaveLength(0);
  });

  it('rolls back the mutation if activity append fails', async () => {
    const repository = new MemoryJobCardRepository(); repository.failActivity = true;
    await expect(new JobCardService(repository).start(staff, 'job-1', input)).rejects.toThrow('activity failed');
    expect(repository.job).toMatchObject({ status: 'ACCEPTED', version: 1 });
    expect(repository.activities).toHaveLength(0);
  });

  it('rejects cross-organization access without revealing the JobCard', async () => {
    const repository = new MemoryJobCardRepository();
    await expect(new JobCardService(repository).start({ ...staff, organizationId: 'org-2' }, 'job-1', input))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
  });
});
