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
  PatchMeetingDetailsInput,
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
  activityMetadata: unknown[] = [];
  lockOrder: string[] = [];
  assigneeLookupCount = 0;
  failActivity = false;
  completed = new Map<string, unknown>();
  processing = new Set<string>();

  private detail(job: JobCard) {
    return {
      ...job,
      assignee: { id: job.assignedTo, name: `Staff ${job.assignedTo}` },
      customer: job.customerId ? { id: job.customerId, name: `Customer ${job.customerId}` } : null,
      contact: job.contactId ? { id: job.contactId, name: `Contact ${job.contactId}` } : null,
    };
  }

  private meetingCandidate(details: EmptyMeetingDetails): MeetingDetailsCandidate {
    return {
      meetingAt: details.meetingAt,
      outcome: details.outcome,
      meetingSummary: details.meetingSummary,
      nextFollowUpAt: details.nextFollowUpAt,
    };
  }

  async executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<T>,
  ) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) {
      return { kind: 'replay' as const, response: this.completed.get(key) as T, realtimeEvents: [] as const };
    }
    if (this.processing.has(key)) return { kind: 'processing' as const };
    this.processing.add(key);
    const jobsBefore = this.jobs.map((job) => ({ ...job }));
    const detailsBefore = this.meetingDetails.map((details) => ({ ...details }));
    const activitiesBefore = [...this.activities];
    const activityMetadataBefore = [...this.activityMetadata];
    const transaction = {
      getJobForUpdate: async (organizationId: string, jobCardId: string) => {
        this.lockOrder.push('job_cards');
        return this.jobs.find(
          (job) => job.organizationId === organizationId && job.id === jobCardId,
        ) ?? null;
      },
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
      getSubmissionMeetingDetails: async (organizationId: string, jobCardId: string) => {
        this.lockOrder.push('meeting_details');
        const details = this.meetingDetails.find(
          (details) => details.organizationId === organizationId && details.jobCardId === jobCardId,
        );
        return details ? this.meetingCandidate(details) : null;
      },
      updateMeetingDetails: async (update: EmptyMeetingDetails) => {
        const index = this.meetingDetails.findIndex(
          (details) => details.organizationId === update.organizationId
            && details.jobCardId === update.jobCardId,
        );
        if (index < 0) throw new Error('missing detail');
        this.meetingDetails[index] = { ...update };
      },
      bumpVersion: async (organizationId: string, jobCardId: string, expectedVersion: number) => {
        const index = this.jobs.findIndex(
          (job) => job.organizationId === organizationId && job.id === jobCardId
            && job.version === expectedVersion,
        );
        if (index < 0) return null;
        this.jobs[index] = { ...this.jobs[index]!, version: expectedVersion + 1 };
        return this.jobs[index]!;
      },
      appendActivity: async (input: { event: string; metadata?: unknown }) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push(input.event);
        this.activityMetadata.push(input.metadata ?? null);
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendRealtimeEvent: async (input) => ({ ...input, id: 1n }),
      listActiveManagementRecipients: async () => [],
      appendNotifications: async () => [],
      appendWebPushDeliveries: async () => [],
      getJobDetail: async (organizationId: string, jobCardId: string) => {
        const job = this.jobs.find(
          (candidate) => candidate.organizationId === organizationId && candidate.id === jobCardId,
        );
        return job ? this.detail(job) : null;
      },
    } as unknown as JobCardTransaction;

    try {
      const completed = await work(transaction);
      this.completed.set(key, completed.response);
      return { kind: 'completed' as const, response: completed.response, realtimeEvents: completed.realtimeEvents };
    } catch (error) {
      this.jobs = jobsBefore;
      this.meetingDetails = detailsBefore;
      this.activities = activitiesBefore;
      this.activityMetadata = activityMetadataBefore;
      throw error;
    } finally {
      this.processing.delete(key);
    }
  }

  async listJobCards(_scope: JobCardReadScope, query: JobCardListQuery) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }
  async listBoard() { throw new Error('unused'); }
  async findJobCard(organizationId: string, jobCardId: string) {
    return this.jobs.find(
      (job) => job.organizationId === organizationId && job.id === jobCardId,
    ) ?? null;
  }
  async findJobCardDetail() { return null; }
  async findMeetingDetails(organizationId: string, jobCardId: string) {
    const details = this.meetingDetails.find(
      (details) => details.organizationId === organizationId && details.jobCardId === jobCardId,
    );
    return details ? this.meetingCandidate(details) : null;
  }
  async getAssignee(organizationId: string, userId: string) {
    return this.assignees.find((item) => item.organizationId === organizationId && item.id === userId) ?? null;
  }
  async getSubmissionCustomer() { return null; }
  async getSubmissionMeetingDetails(organizationId: string, jobCardId: string) {
    return this.findMeetingDetails(organizationId, jobCardId);
  }
  async getSubmissionDeliveryItems() { return []; }
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

  seedMeeting(input: {
    status?: JobCard['status'];
    type?: JobCard['type'];
    assignedTo?: string;
    version?: number;
    details?: Partial<MeetingDetailsCandidate>;
  } = {}) {
    const job: JobCard = {
      id: 'job-meeting-1', organizationId: 'org-1', type: input.type ?? 'SALES_MEETING',
      status: input.status ?? 'IN_PROGRESS', version: input.version ?? 2,
      title: 'Klinik görüşmesi', description: null, customerId: 'customer-1', contactId: null,
      assignedTo: input.assignedTo ?? 'staff-1', createdBy: 'staff-1', priority: 'normal',
      dueDate: '2026-07-20', scheduledAt: '2026-07-20T10:00:00.000Z',
      engagementKind: 'SALES_MEETING',
    };
    this.jobs.push(job);
    this.meetingDetails.push({
      organizationId: 'org-1', jobCardId: job.id,
      meetingAt: '2026-07-15T10:00:00.000Z', outcome: 'NO_DECISION',
      meetingSummary: 'İlk görüşme yapıldı.', nextFollowUpAt: null,
      ...input.details,
    });
    return job;
  }
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
  scheduledAt: '2026-07-20T10:00:00.000Z',
  engagementKind: 'SALES_MEETING',
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

describe('Sales Meeting detail reads and mutations', () => {
  const patch: PatchMeetingDetailsInput = {
    clientActionId: 'meeting-save-1', expectedVersion: 2,
    outcome: 'FOLLOW_UP_REQUIRED', meetingSummary: 'Kontrol ziyareti yapıldı.',
  };

  it('reads an owned Sales Meeting without a lock or version mutation', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting();

    await expect(new JobCardService(repository).getMeetingDetails(staff, job.id))
      .resolves.toEqual({
        jobCardId: job.id, meetingAt: '2026-07-15T10:00:00.000Z',
        outcome: 'NO_DECISION', meetingSummary: 'İlk görüşme yapıldı.',
        nextFollowUpAt: null, jobCardVersion: 2,
      });
    expect(repository.lockOrder).toEqual([]);
    expect(repository.jobs[0]!.version).toBe(2);
  });

  it.each(['NEW', 'ACCEPTED'] as const)(
    'rejects meeting result reads before start in %s with the exact edit contract',
    async (status) => {
      const repository = new SalesMeetingRepository();
      const job = repository.seedMeeting({ status });
      await expect(new JobCardService(repository).getMeetingDetails(staff, job.id))
        .rejects.toMatchObject({
          code: 'JOB_NOT_EDITABLE', statusCode: 409,
          message: 'JobCard bu durumda düzenlenemez.',
        });
      expect(repository.lockOrder).toEqual([]);
      expect(repository.jobs[0]!.version).toBe(2);
    },
  );

  it.each(['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
    'allows meeting result reads in review/terminal %s',
    async (status) => {
      const repository = new SalesMeetingRepository();
      const job = repository.seedMeeting({ status });
      await expect(new JobCardService(repository).getMeetingDetails(manager, job.id))
        .resolves.toMatchObject({ jobCardId: job.id, jobCardVersion: 2 });
    },
  );

  it('conceals inaccessible parents before type guard and reports invariant failure safely', async () => {
    const inaccessible = new SalesMeetingRepository();
    const inaccessibleJob = inaccessible.seedMeeting({ assignedTo: 'staff-2', type: 'GENERAL_TASK' });
    await expect(new JobCardService(inaccessible).getMeetingDetails(staff, inaccessibleJob.id))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

    const wrongType = new SalesMeetingRepository();
    const wrongTypeJob = wrongType.seedMeeting({ type: 'GENERAL_TASK' });
    await expect(new JobCardService(wrongType).getMeetingDetails(manager, wrongTypeJob.id))
      .rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 409 });

    const missingDetails = new SalesMeetingRepository();
    const missingDetailsJob = missingDetails.seedMeeting();
    missingDetails.meetingDetails = [];
    await expect(new JobCardService(missingDetails).getMeetingDetails(manager, missingDetailsJob.id))
      .rejects.toMatchObject({ code: 'INVARIANT_VIOLATION', statusCode: 500 });
  });

  it('patches a merged candidate, bumps once and records only canonical changed fields', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting();

    const result = await new JobCardService(repository).patchMeetingDetails(staff, job.id, patch);

    expect(result).toEqual({
      jobCardId: job.id, meetingAt: '2026-07-15T10:00:00.000Z',
      outcome: 'FOLLOW_UP_REQUIRED', meetingSummary: 'Kontrol ziyareti yapıldı.',
      nextFollowUpAt: null, jobCardVersion: 3,
    });
    expect(repository.jobs[0]!.version).toBe(3);
    expect(repository.activities).toEqual(['MEETING_DETAILS_UPDATED']);
    expect(repository.activityMetadata).toEqual([{
      changedFields: ['outcome', 'meetingSummary'],
    }]);
    expect(repository.lockOrder).toEqual(['job_cards', 'meeting_details']);
  });

  it('validates chronology against merged persisted details', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting({
      details: { nextFollowUpAt: '2026-07-16T10:00:00.000Z' },
    });

    await expect(new JobCardService(repository).patchMeetingDetails(staff, job.id, {
      clientActionId: 'clear-meeting-time', expectedVersion: 2, meetingAt: null,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(repository.jobs[0]!.version).toBe(2);
    expect(repository.activities).toHaveLength(0);
  });

  it('rejects normalized no-op and version conflict without mutation', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting();
    const service = new JobCardService(repository);

    await expect(service.patchMeetingDetails(staff, job.id, {
      clientActionId: 'no-op', expectedVersion: 2, outcome: 'NO_DECISION',
    })).rejects.toMatchObject({
      code: 'MEETING_DETAILS_UNCHANGED', statusCode: 400,
      message: 'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
    });
    await expect(service.patchMeetingDetails(staff, job.id, {
      clientActionId: 'stale', expectedVersion: 9, outcome: 'POSITIVE',
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(repository.jobs[0]!.version).toBe(2);
    expect(repository.activities).toHaveLength(0);
  });

  it.each(['IN_PROGRESS', 'REVISION_REQUESTED'] as const)(
    'allows authorized edits in %s',
    async (status) => {
      const repository = new SalesMeetingRepository();
      const job = repository.seedMeeting({ status });
      await expect(new JobCardService(repository).patchMeetingDetails(manager, job.id, patch))
        .resolves.toMatchObject({ jobCardVersion: 3 });
    },
  );

  it.each(['NEW', 'ACCEPTED'] as const)(
    'rejects result edits before start in %s with the exact edit contract',
    async (status) => {
      const repository = new SalesMeetingRepository();
      const job = repository.seedMeeting({ status });
      await expect(new JobCardService(repository).patchMeetingDetails(manager, job.id, patch))
        .rejects.toMatchObject({
          code: 'JOB_NOT_EDITABLE', statusCode: 409,
          message: 'JobCard bu durumda düzenlenemez.',
        });
      expect(repository.jobs[0]!.version).toBe(2);
      expect(repository.activities).toHaveLength(0);
    },
  );

  it.each(['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
    'reuses JOB_NOT_EDITABLE in %s',
    async (status) => {
      const repository = new SalesMeetingRepository();
      const job = repository.seedMeeting({ status });
      await expect(new JobCardService(repository).patchMeetingDetails(manager, job.id, patch))
        .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    },
  );

  it('conceals Staff ownership before mutation', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting({ assignedTo: 'staff-2' });
    await expect(new JobCardService(repository).patchMeetingDetails(staff, job.id, patch))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(repository.lockOrder).toEqual(['job_cards']);
  });

  it('replays a completed action and maps an active claim to ACTION_IN_PROGRESS', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting();
    const service = new JobCardService(repository);
    const first = await service.patchMeetingDetails(staff, job.id, patch);
    await expect(service.patchMeetingDetails(staff, job.id, {
      ...patch, outcome: 'NOT_INTERESTED', meetingSummary: 'Başka payload',
    })).resolves.toEqual(first);
    expect(repository.jobs[0]!.version).toBe(3);
    expect(repository.activities).toHaveLength(1);

    const busy = new SalesMeetingRepository();
    const busyJob = busy.seedMeeting();
    busy.processing.add(`org-1:staff-1:${patch.clientActionId}:MEETING_DETAILS_UPDATE:${busyJob.id}`);
    await expect(new JobCardService(busy).patchMeetingDetails(staff, busyJob.id, patch))
      .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });
  });

  it('rolls back detail and version when activity append fails', async () => {
    const repository = new SalesMeetingRepository();
    const job = repository.seedMeeting();
    repository.failActivity = true;

    await expect(new JobCardService(repository).patchMeetingDetails(staff, job.id, patch))
      .rejects.toThrow('activity failed');
    expect(repository.jobs[0]!.version).toBe(2);
    expect(repository.meetingDetails[0]).toMatchObject({
      outcome: 'NO_DECISION', meetingSummary: 'İlk görüşme yapıldı.',
    });
    expect(repository.activities).toHaveLength(0);
  });
});
