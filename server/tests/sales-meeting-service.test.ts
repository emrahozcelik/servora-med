import { describe, expect, it } from 'vitest';

import type {
  CreateJobCardRecord,
  CriticalActionClaim,
  JobCardReadScope,
  JobCardRepository,
  JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCard,
  JobCardActor,
  JobCardAssignee,
  JobCardListQuery,
  MeetingDetailsCandidate,
  NormalizedJobCardCreateInput,
} from '../src/modules/job-cards/types.js';

type EmptyMeetingDetails = MeetingDetailsCandidate & { organizationId: string; jobCardId: string };

class SalesMeetingRepository implements JobCardRepository {
  assignees: JobCardAssignee[] = [
    { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true },
    { id: 'staff-2', organizationId: 'org-1', role: 'STAFF', isActive: true },
  ];
  customers = [
    { id: 'customer-1', organizationId: 'org-1', status: 'active' as const },
    { id: 'customer-inactive', organizationId: 'org-1', status: 'inactive' as const },
  ];
  contacts = [
    { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', isActive: true },
  ];
  jobs: JobCard[] = [];
  meetingDetails: EmptyMeetingDetails[] = [];
  activities: string[] = [];
  lockOrder: string[] = [];
  assigneeLookupCount = 0;
  failActivity = false;
  completed = new Map<string, unknown>();

  private detail(job: JobCard) {
    return {
      ...job,
      assignee: { id: job.assignedTo, name: `Staff ${job.assignedTo}` },
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: job.contactId ? { id: job.contactId, name: `Contact ${job.contactId}` } : null,
    };
  }

  async executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<T>,
  ) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) {
      return { kind: 'replay' as const, response: this.completed.get(key) as T };
    }
    const jobsBefore = this.jobs.map((job) => ({ ...job }));
    const detailsBefore = this.meetingDetails.map((details) => ({ ...details }));
    const activitiesBefore = [...this.activities];
    const transaction = {
      getAssigneeForUpdate: async (organizationId: string, userId: string) => {
        this.lockOrder.push('users');
        this.assigneeLookupCount += 1;
        return this.assignees.find(
          (assignee) => assignee.organizationId === organizationId && assignee.id === userId,
        ) ?? null;
      },
      getCustomerForUpdate: async (organizationId: string, customerId: string) => {
        this.lockOrder.push('customers');
        return this.customers.find(
          (customer) => customer.organizationId === organizationId && customer.id === customerId,
        ) ?? null;
      },
      getContactForUpdate: async (organizationId: string, contactId: string) => {
        this.lockOrder.push('contacts');
        return this.contacts.find(
          (contact) => contact.organizationId === organizationId && contact.id === contactId,
        ) ?? null;
      },
      createJobCard: async (input: CreateJobCardRecord) => {
        this.lockOrder.push('job_cards');
        const job: JobCard = {
          id: `job-${this.jobs.length + 1}`,
          status: 'NEW',
          version: 1,
          ...input,
        };
        this.jobs.push(job);
        return job;
      },
      createMeetingDetails: async (input: { organizationId: string; jobCardId: string }) => {
        this.lockOrder.push('meeting_details');
        this.meetingDetails.push({
          ...input,
          meetingAt: null,
          outcome: null,
          meetingSummary: null,
          nextFollowUpAt: null,
        });
      },
      appendActivity: async (input: { event: string }) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push(input.event);
      },
      getJobDetail: async (organizationId: string, jobCardId: string) => {
        const job = this.jobs.find(
          (candidate) => candidate.organizationId === organizationId && candidate.id === jobCardId,
        );
        return job ? this.detail(job) : null;
      },
    } as unknown as JobCardTransaction;

    try {
      const response = await work(transaction);
      this.completed.set(key, response);
      return { kind: 'completed' as const, response };
    } catch (error) {
      this.jobs = jobsBefore;
      this.meetingDetails = detailsBefore;
      this.activities = activitiesBefore;
      throw error;
    }
  }

  async listJobCards(_scope: JobCardReadScope, query: JobCardListQuery) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }
  async listBoard() { throw new Error('unused'); }
  async findJobCard() { return null; }
  async findJobCardDetail() { return null; }
  async executeTransaction<T>(_work: (transaction: JobCardTransaction) => Promise<T>) {
    throw new Error('unused');
  }
  async listDeliveryItems() { return []; }
  async listActivity(_organizationId: string, _jobCardId: string, page: { limit: number; offset: number }) {
    return { items: [], total: 0, limit: page.limit, offset: page.offset };
  }
  async listNotes(_organizationId: string, _jobCardId: string, page: { limit: number; offset: number }) {
    return { items: [], total: 0, limit: page.limit, offset: page.offset };
  }
  async listReferenceCustomers() { return []; }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const input: NormalizedJobCardCreateInput = {
  clientActionId: 'meeting-create-1',
  type: 'SALES_MEETING',
  title: ' Klinik görüşmesi ',
  description: null,
  customerId: 'customer-1',
  contactId: 'contact-1',
  assignedTo: 'staff-1',
  priority: 'normal',
  dueDate: '2026-07-20',
};

describe('Sales Meeting create transaction', () => {
  it('creates one empty detail row in canonical lock order and only JOB_CREATED', async () => {
    const repository = new SalesMeetingRepository();

    const result = await new JobCardService(repository).create(staff, input);

    expect(result).toMatchObject({
      type: 'SALES_MEETING',
      title: 'Klinik görüşmesi',
      customerId: 'customer-1',
      contactId: 'contact-1',
      assignedTo: 'staff-1',
      dueDate: '2026-07-20',
    });
    expect(repository.meetingDetails).toEqual([{
      organizationId: 'org-1',
      jobCardId: result.id,
      meetingAt: null,
      outcome: null,
      meetingSummary: null,
      nextFollowUpAt: null,
    }]);
    expect(repository.activities).toEqual(['JOB_CREATED']);
    expect(repository.lockOrder).toEqual([
      'users', 'customers', 'contacts', 'job_cards', 'meeting_details',
    ]);
  });

  it('replays JOB_CREATE without another JobCard, detail row or activity', async () => {
    const repository = new SalesMeetingRepository();
    const service = new JobCardService(repository);

    const first = await service.create(staff, input);
    await expect(service.create(staff, input)).resolves.toEqual(first);

    expect(repository.jobs).toHaveLength(1);
    expect(repository.meetingDetails).toHaveLength(1);
    expect(repository.activities).toEqual(['JOB_CREATED']);
  });

  it('rolls back JobCard and detail when JOB_CREATED append fails', async () => {
    const repository = new SalesMeetingRepository();
    repository.failActivity = true;

    await expect(new JobCardService(repository).create(staff, input)).rejects.toThrow(
      'activity failed',
    );
    expect(repository.jobs).toHaveLength(0);
    expect(repository.meetingDetails).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('keeps Staff mismatch pre-lookup and allows management assignment', async () => {
    const repository = new SalesMeetingRepository();
    const service = new JobCardService(repository);

    await expect(service.create(staff, { ...input, assignedTo: 'staff-2' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(repository.assigneeLookupCount).toBe(0);
    await expect(service.create(manager, {
      ...input,
      clientActionId: 'manager-meeting-create',
      assignedTo: 'staff-2',
    })).resolves.toMatchObject({ assignedTo: 'staff-2' });
  });

  it('requires an active Customer and accepts an optional active Contact', async () => {
    const repository = new SalesMeetingRepository();
    const service = new JobCardService(repository);

    await expect(service.create(staff, {
      ...input,
      clientActionId: 'inactive-customer',
      customerId: 'customer-inactive',
      contactId: null,
    })).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
    await expect(service.create(staff, {
      ...input,
      clientActionId: 'meeting-without-contact',
      contactId: null,
    })).resolves.toMatchObject({ customerId: 'customer-1', contactId: null });
  });
});
