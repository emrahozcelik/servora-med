import { describe, expect, it } from 'vitest';

import type {
  ActivityInput,
  CriticalActionClaim,
  JobCardRepository,
  JobCardTransaction,
  SubmissionDeliveryItem,
  TransitionInput,
} from '../src/modules/job-cards/repository.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCard,
  JobCardActor,
  JobCardStatus,
  MeetingDetailsCandidate,
} from '../src/modules/job-cards/types.js';

class LifecycleRepository implements JobCardRepository {
  job: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
    version: 2, title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
  };
  assignee = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: true };
  customerExistsValue = true;
  submissionCustomer: {
    id: string;
    organizationId: string;
    status: 'prospect' | 'active' | 'inactive';
  } | null = { id: 'customer-1', organizationId: 'org-1', status: 'active' };
  meetingDetails: MeetingDetailsCandidate | null = {
    meetingAt: '2026-07-13T12:00:00.000Z',
    outcome: 'POSITIVE',
    meetingSummary: 'Görüşme tamamlandı.',
    nextFollowUpAt: null,
  };
  submissionReads: string[] = [];
  items: SubmissionDeliveryItem[] = [{
    id: 'item-1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'product-1',
    deliveryPurpose: 'SALE', deliveredAt: new Date(), quantity: 2, unit: 'adet',
    productNameSnapshot: 'Set', productSkuSnapshot: 'S1', productModelSnapshot: null,
    lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
  }];
  events: ActivityInput[] = [];
  transitions: TransitionInput[] = [];
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  claims: CriticalActionClaim[] = [];
  failTransition = false;
  failActivity = false;
  plannedAt: Date | null = null;
  startedAt: Date | null = null;
  revision = { at: null as Date | null, by: null as string | null, reason: null as string | null };
  cancellation = { at: null as Date | null, by: null as string | null, reason: null as string | null };

  private tx(): JobCardTransaction {
    return {
      getJobForUpdate: async (org, id) =>
        org === this.job.organizationId && id === this.job.id ? { ...this.job } : null,
      getJobDetail: async (org, id) => org === this.job.organizationId && id === this.job.id
        ? {
            ...this.job,
            assignee: { id: this.job.assignedTo, name: 'Staff One' },
            customer: this.job.customerId ? { id: this.job.customerId, name: 'Demo Klinik' } : null,
            contact: null,
          }
        : null,
      transitionWithVersion: async (input) => {
        this.transitions.push(input);
        if (this.failTransition || input.expectedVersion !== this.job.version) return null;
        this.job = { ...this.job, status: input.status, version: this.job.version + 1 };
        if (input.command === 'PLAN') this.plannedAt = input.occurredAt;
        if (input.command === 'START') this.startedAt ??= input.occurredAt;
        if (input.command === 'REQUEST_REVISION') {
          this.revision = { at: input.occurredAt, by: input.actorId ?? null, reason: input.revisionReason ?? null };
        }
        if (input.command === 'CANCEL') {
          this.cancellation = { at: input.occurredAt, by: input.actorId ?? null, reason: input.cancelReason ?? null };
        }
        return { ...this.job };
      },
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.events.push(input);
      },
      getAssignee: async () => {
        this.submissionReads.push('assignee');
        return this.assignee;
      },
      customerExists: async () => this.customerExistsValue,
      getSubmissionCustomer: async () => {
        this.submissionReads.push('customer');
        return this.submissionCustomer;
      },
      getMeetingDetailsForUpdate: async () => {
        this.submissionReads.push('meeting_details');
        return this.meetingDetails;
      },
      getSubmissionDeliveryItems: async () => this.items,
    } as JobCardTransaction;
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    this.claims.push(claim);
    const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    const before = {
      job: { ...this.job }, events: [...this.events], transitions: [...this.transitions],
      plannedAt: this.plannedAt, startedAt: this.startedAt,
      revision: { ...this.revision }, cancellation: { ...this.cancellation },
    };
    try {
      const response = await work(this.tx());
      this.completed.set(key, response);
      return { kind: 'completed' as const, response };
    } catch (error) {
      this.job = before.job; this.events = before.events; this.transitions = before.transitions;
      this.plannedAt = before.plannedAt; this.startedAt = before.startedAt;
      this.revision = before.revision; this.cancellation = before.cancellation;
      throw error;
    }
  }

  async executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) { return work(this.tx()); }
  async listJobCards() { return { items: [], total: 0, limit: 25, offset: 0 }; }
  async listBoard() { throw new Error('unused'); }
  async findJobCard() { return this.job; }
  async findJobCardDetail() {
    return {
      ...this.job, assignee: { id: this.job.assignedTo, name: 'Staff One' },
      customer: this.job.customerId ? { id: this.job.customerId, name: 'Demo Klinik' } : null,
      contact: null,
    };
  }
  async listDeliveryItems() { return this.items; }
  async listActivity() { return this.events as never; }
  async listReferenceCustomers() { return []; }
}

function twoJobRepository() {
  const base: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW',
    version: 1, title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
  };
  const jobs = new Map([
    ['job-1', { ...base }],
    ['job-2', { ...base, id: 'job-2', title: 'İkinci teslim' }],
  ]);
  const completed = new Map<string, unknown>();
  const events: ActivityInput[] = [];
  const repository = {
    async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
      const key = `${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
      if (completed.has(key)) return { kind: 'replay' as const, response: completed.get(key) as T };
      const tx = {
        getJobForUpdate: async (organizationId: string, id: string) => {
          const job = jobs.get(id);
          return job?.organizationId === organizationId ? { ...job } : null;
        },
        getJobDetail: async (organizationId: string, id: string) => {
          const job = jobs.get(id);
          return job?.organizationId === organizationId
            ? {
                ...job,
                assignee: { id: job.assignedTo, name: 'Staff One' },
                customer: job.customerId ? { id: job.customerId, name: 'Demo Klinik' } : null,
                contact: null,
              }
            : null;
        },
        transitionWithVersion: async (input: TransitionInput) => {
          const job = jobs.get(input.jobCardId);
          if (!job || job.version !== input.expectedVersion) return null;
          const updated = { ...job, status: input.status, version: job.version + 1 };
          jobs.set(job.id, updated);
          return { ...updated };
        },
        appendActivity: async (input: ActivityInput) => { events.push(input); },
      } as JobCardTransaction;
      const response = await work(tx);
      completed.set(key, response);
      return { kind: 'completed' as const, response };
    },
  } as JobCardRepository;
  return { repository, jobs, events };
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const time = new Date('2026-07-13T12:00:00.000Z');
const input = (clientActionId: string, expectedVersion = 2) => ({ clientActionId, expectedVersion });

function salesMeetingRepository() {
  const repository = new LifecycleRepository();
  repository.job = {
    ...repository.job,
    type: 'SALES_MEETING',
    title: 'Kontrol görüşmesi',
    customerId: 'customer-1',
    contactId: null,
    dueDate: '2026-07-15',
  };
  repository.items = [];
  return repository;
}

describe('JobCard lifecycle commands', () => {
  it.each([
    ['plan', 'NEW', 'PLANNED', 'JOB_PLANNED', 'JOB_PLAN'],
    ['start', 'PLANNED', 'IN_PROGRESS', 'JOB_STARTED', 'JOB_START'],
    ['submitForApproval', 'IN_PROGRESS', 'WAITING_APPROVAL', 'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_SUBMIT_FOR_APPROVAL'],
    ['approve', 'WAITING_APPROVAL', 'COMPLETED', 'JOB_APPROVED', 'JOB_APPROVE'],
    ['requestRevision', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'JOB_REVISION_REQUESTED', 'JOB_REQUEST_REVISION'],
    ['resume', 'REVISION_REQUESTED', 'IN_PROGRESS', 'JOB_RESUMED', 'JOB_RESUME'],
    ['cancel', 'IN_PROGRESS', 'CANCELLED', 'JOB_CANCELLED', 'JOB_CANCEL'],
  ] as const)('executes %s with one version increment and one named event', async (
    method, source, target, event, operationKey,
  ) => {
    const repo = new LifecycleRepository(); repo.job.status = source as JobCardStatus;
    const service = new JobCardService(repo, () => time);
    const commandInput = method === 'requestRevision'
      ? { ...input(method), revisionReason: ' Düzeltin ' }
      : method === 'cancel' ? { ...input(method), cancelReason: ' İptal edildi ' }
        : { ...input(method), note: method === 'approve' || method === 'submitForApproval' ? ' Not ' : undefined };

    const result = await service[method](method === 'approve' || method === 'requestRevision' || method === 'cancel' ? manager : staff, 'job-1', commandInput as never);

    expect(result).toMatchObject({ status: target, version: 3 });
    expect(repo.events.map((item) => item.event)).toEqual([event]);
    expect(repo.events[0]).toMatchObject({ clientActionId: method });
    expect(repo.claims[0]).toMatchObject({ operationKey: `${operationKey}:job-1`, clientActionId: method });
    expect(repo.transitions).toHaveLength(1);
  });

  it.each([
    ['plan', 'NEW', 'PLANNED', 'JOB_PLANNED'],
    ['start', 'PLANNED', 'IN_PROGRESS', 'JOB_STARTED'],
    ['submitForApproval', 'IN_PROGRESS', 'WAITING_APPROVAL', 'JOB_SUBMITTED_FOR_APPROVAL'],
    ['approve', 'WAITING_APPROVAL', 'COMPLETED', 'JOB_APPROVED'],
    ['requestRevision', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'JOB_REVISION_REQUESTED'],
    ['resume', 'REVISION_REQUESTED', 'IN_PROGRESS', 'JOB_RESUMED'],
    ['cancel', 'IN_PROGRESS', 'CANCELLED', 'JOB_CANCELLED'],
  ] as const)('runs General Task %s through the shared lifecycle engine', async (
    method, source, target, event,
  ) => {
    const repo = new LifecycleRepository();
    repo.job = {
      ...repo.job, type: 'GENERAL_TASK', status: source, customerId: null,
      contactId: null, title: 'Doktoru ara',
    };
    repo.items = [];
    const commandInput = method === 'requestRevision'
      ? { ...input(`task-${method}`), revisionReason: ' Düzeltin ' }
      : method === 'cancel'
        ? { ...input(`task-${method}`), cancelReason: ' İptal edildi ' }
        : input(`task-${method}`);
    const commandActor = method === 'approve' || method === 'requestRevision' || method === 'cancel'
      ? manager : staff;

    const result = await new JobCardService(repo, () => time)[method](
      commandActor, 'job-1', commandInput as never,
    );

    expect(result).toMatchObject({ type: 'GENERAL_TASK', status: target, version: 3 });
    expect(result).toMatchObject({ assignee: { id: 'staff-1', name: 'Staff One' } });
    expect(repo.events.map((item) => item.event)).toEqual([event]);
    expect(repo.transitions).toHaveLength(1);
  });

  it('sets plannedAt and preserves the first startedAt across start and resume', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo, () => time);
    repo.job.status = 'NEW';
    await service.plan(staff, 'job-1', input('plan'));
    expect(repo.plannedAt).toEqual(time);

    repo.job.status = 'PLANNED'; repo.job.version = 3;
    await service.start(staff, 'job-1', input('start', 3));
    expect(repo.startedAt).toEqual(time);
    const firstStartedAt = repo.startedAt;

    repo.job.status = 'REVISION_REQUESTED'; repo.job.version = 4;
    await service.resume(staff, 'job-1', input('resume', 4));
    expect(repo.startedAt).toBe(firstStartedAt);
    expect(repo.transitions.at(-1)).toMatchObject({ command: 'RESUME' });
  });

  it('preserves latest revision fields on resume and replaces them on the next revision request', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo, () => time);
    repo.job.status = 'WAITING_APPROVAL'; repo.job.version = 3;
    await service.requestRevision(manager, 'job-1', {
      clientActionId: 'revision-1', expectedVersion: 3, revisionReason: ' İlk neden ',
    });
    expect(repo.revision).toEqual({ at: time, by: 'manager-1', reason: 'İlk neden' });

    repo.job.status = 'REVISION_REQUESTED'; repo.job.version = 4;
    await service.resume(staff, 'job-1', input('resume-after-revision', 4));
    expect(repo.revision.reason).toBe('İlk neden');

    repo.job.status = 'WAITING_APPROVAL'; repo.job.version = 5;
    await service.requestRevision(manager, 'job-1', {
      clientActionId: 'revision-2', expectedVersion: 5, revisionReason: ' İkinci neden ',
    });
    expect(repo.revision).toEqual({ at: time, by: 'manager-1', reason: 'İkinci neden' });
  });

  it('writes cancellation fields only for cancel', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo, () => time);
    await service.submitForApproval(staff, 'job-1', { ...input('submit'), note: ' Bitti ' });
    expect(repo.cancellation).toEqual({ at: null, by: null, reason: null });

    repo.job.status = 'IN_PROGRESS'; repo.job.version = 3;
    await service.cancel(manager, 'job-1', { ...input('cancel', 3), cancelReason: ' Müşteri iptal etti ' });
    expect(repo.cancellation).toEqual({ at: time, by: 'manager-1', reason: 'Müşteri iptal etti' });
  });

  it.each([1, 255] as const)('accepts a %i-code-point action ID', async (length) => {
    const repo = new LifecycleRepository(); repo.job.status = 'NEW';
    await expect(new JobCardService(repo).plan(staff, 'job-1', input('😀'.repeat(length))))
      .resolves.toMatchObject({ status: 'PLANNED' });
    expect(repo.claims[0]!.clientActionId).toBe('😀'.repeat(length));
  });

  it('rejects invalid action IDs, versions, and lifecycle text before claiming an action', async () => {
    const cases: Array<() => Promise<unknown>> = [];
    for (const clientActionId of ['', '😀'.repeat(256)]) {
      cases.push(() => new JobCardService(new LifecycleRepository()).plan(staff, 'job-1', input(clientActionId)));
    }
    cases.push(() => new JobCardService(new LifecycleRepository()).plan(staff, 'job-1', input('bad-version', 0)));
    cases.push(() => new JobCardService(new LifecycleRepository()).submitForApproval(staff, 'job-1', {
      ...input('long-note'), note: '😀'.repeat(2_001),
    }));
    cases.push(() => new JobCardService(new LifecycleRepository()).cancel(manager, 'job-1', {
      ...input('long-cancel'), cancelReason: '😀'.repeat(2_001),
    }));
    for (const run of cases) await expect(run()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['requestRevision', 'revisionReason', 'REVISION_REASON_REQUIRED'],
    ['cancel', 'cancelReason', 'CANCEL_REASON_REQUIRED'],
  ] as const)('rejects an empty %s reason before claiming an action', async (method, field, code) => {
    const repo = new LifecycleRepository(); repo.job.status = 'WAITING_APPROVAL'; repo.job.version = 3;
    await expect(new JobCardService(repo)[method](manager, 'job-1', {
      clientActionId: `empty-${field}`, expectedVersion: 3, [field]: ' ',
    } as never)).rejects.toMatchObject({ code });
    expect(repo.claims).toHaveLength(0);
  });

  it('trims optional notes and accepts their 0/2,000 code-point bounds', async () => {
    const empty = new LifecycleRepository();
    await new JobCardService(empty).submitForApproval(staff, 'job-1', { ...input('empty-note'), note: '  ' });
    expect(empty.transitions[0]!.note).toBeNull();

    const max = new LifecycleRepository();
    await new JobCardService(max).submitForApproval(staff, 'job-1', {
      ...input('max-note'), note: ` ${'😀'.repeat(2_000)} `,
    });
    expect(max.transitions[0]!.note).toBe('😀'.repeat(2_000));
  });

  it('returns version conflict and action-in-progress without mutation or activity', async () => {
    const stale = new LifecycleRepository();
    await expect(new JobCardService(stale).submitForApproval(staff, 'job-1', input('stale', 9)))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(stale.job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(stale.events).toHaveLength(0);

    const processing = new LifecycleRepository();
    processing.processing.add('staff-1:busy:JOB_SUBMIT_FOR_APPROVAL:job-1');
    await expect(new JobCardService(processing).submitForApproval(staff, 'job-1', input('busy')))
      .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    expect(processing.transitions).toHaveLength(0);
  });

  it('replays the completed response without a second transition or event', async () => {
    const repo = new LifecycleRepository(); const service = new JobCardService(repo);
    const first = await service.submitForApproval(staff, 'job-1', input('replay'));
    await expect(service.submitForApproval(staff, 'job-1', input('replay'))).resolves.toEqual(first);
    expect(repo.job.version).toBe(3); expect(repo.transitions).toHaveLength(1);
    expect(repo.events).toHaveLength(1);
  });

  it('isolates same-command action replay by target JobCard', async () => {
    const { repository, jobs, events } = twoJobRepository();
    const service = new JobCardService(repository);
    const command = { clientActionId: 'shared-plan-action', expectedVersion: 1 };

    const first = await service.plan(staff, 'job-1', command);
    const second = await service.plan(staff, 'job-2', command);

    expect(first).toMatchObject({ id: 'job-1', status: 'PLANNED', version: 2 });
    expect(second).toMatchObject({ id: 'job-2', status: 'PLANNED', version: 2 });
    expect(second.id).not.toBe(first.id);
    expect(jobs.get('job-2')).toMatchObject({ status: 'PLANNED', version: 2 });
    expect(events.map((event) => event.jobCardId)).toEqual(['job-1', 'job-2']);

    await expect(service.plan(staff, 'job-1', command)).resolves.toEqual(first);
    await expect(service.plan(staff, 'job-2', command)).resolves.toEqual(second);
    expect(events).toHaveLength(2);
  });

  it('rolls back transition and claim effects after policy or repository failure', async () => {
    const denied = new LifecycleRepository(); denied.job.status = 'WAITING_APPROVAL'; denied.job.version = 3;
    await expect(new JobCardService(denied).approve(staff, 'job-1', input('denied', 3)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(denied.job).toMatchObject({ status: 'WAITING_APPROVAL', version: 3 });
    expect(denied.events).toHaveLength(0);

    const failed = new LifecycleRepository(); failed.failActivity = true;
    await expect(new JobCardService(failed).submitForApproval(staff, 'job-1', input('activity-fails')))
      .rejects.toThrow('activity failed');
    expect(failed.job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(failed.events).toHaveLength(0); expect(failed.transitions).toHaveLength(0);
  });

  it('keeps product-delivery readiness checks on submission', async () => {
    const repo = new LifecycleRepository(); repo.items = [];
    await expect(new JobCardService(repo).submitForApproval(staff, 'job-1', input('missing-items')))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_READY' });
    repo.items = new LifecycleRepository().items; repo.assignee.isActive = false;
    await expect(new JobCardService(repo).submitForApproval(staff, 'job-1', input('inactive-assignee')))
      .rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE' });
  });

  it('submits a title-only General Task without Customer or delivery items', async () => {
    const repo = new LifecycleRepository();
    repo.job = {
      ...repo.job, type: 'GENERAL_TASK', title: 'Doktoru ara', customerId: null, contactId: null,
    };
    repo.items = [];

    await expect(new JobCardService(repo).submitForApproval(staff, 'job-1', input('task-submit')))
      .resolves.toMatchObject({ type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 3 });
    expect(repo.events.map((item) => item.event)).toEqual(['JOB_SUBMITTED_FOR_APPROVAL']);
  });

  it.each([
    'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
  ] as const)('submits a ready Sales Meeting with %s outcome', async (outcome) => {
    const repo = salesMeetingRepository();
    repo.meetingDetails = { ...repo.meetingDetails!, outcome };

    await expect(new JobCardService(repo, () => time).submitForApproval(
      staff, 'job-1', input(`meeting-submit-${outcome}`),
    )).resolves.toMatchObject({
      type: 'SALES_MEETING', status: 'WAITING_APPROVAL', version: 3,
    });
    expect(repo.submissionReads).toEqual(['customer', 'assignee', 'meeting_details']);
  });

  it('keeps FOLLOW_UP_REQUIRED follow-up optional and accepts valid chronology', async () => {
    const withoutFollowUp = salesMeetingRepository();
    withoutFollowUp.meetingDetails = {
      ...withoutFollowUp.meetingDetails!, outcome: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: null,
    };
    await expect(new JobCardService(withoutFollowUp, () => time).submitForApproval(
      staff, 'job-1', input('follow-up-without-date'),
    )).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });

    const withFollowUp = salesMeetingRepository();
    withFollowUp.meetingDetails = {
      ...withFollowUp.meetingDetails!, outcome: 'FOLLOW_UP_REQUIRED',
      nextFollowUpAt: '2026-07-14T12:00:00.000Z',
    };
    await expect(new JobCardService(withFollowUp, () => time).submitForApproval(
      staff, 'job-1', input('follow-up-with-date'),
    )).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });

    const historical = salesMeetingRepository();
    historical.meetingDetails = {
      ...historical.meetingDetails!, meetingAt: '2020-01-01T09:00:00.000Z',
    };
    await expect(new JobCardService(historical, () => time).submitForApproval(
      staff, 'job-1', input('historical-meeting'),
    )).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });
  });

  it.each([
    ['meetingAt', { meetingAt: null }],
    ['outcome', { outcome: null }],
    ['meetingSummary', { meetingSummary: null }],
    ['meetingSummary', { meetingSummary: '   ' }],
    ['nextFollowUpAt', {
      meetingAt: '2026-07-13T12:00:00.000Z',
      nextFollowUpAt: '2026-07-13T12:00:00.000Z',
    }],
  ] as const)('returns a safe MEETING_NOT_READY error for %s', async (field, detailPatch) => {
    const repo = salesMeetingRepository();
    repo.meetingDetails = { ...repo.meetingDetails!, ...detailPatch } as MeetingDetailsCandidate;

    await expect(new JobCardService(repo, () => time).submitForApproval(
      staff, 'job-1', input(`invalid-${field}-${JSON.stringify(detailPatch)}`),
    )).rejects.toMatchObject({
      code: 'MEETING_NOT_READY', statusCode: 400,
      details: { fieldErrors: { [field]: expect.any(String) } },
    });
    expect(repo.transitions).toHaveLength(0);
    expect(repo.events).toHaveLength(0);
  });

  it('accepts the exact +15 minute meeting boundary and rejects one millisecond later', async () => {
    const boundary = salesMeetingRepository();
    boundary.meetingDetails = {
      ...boundary.meetingDetails!, meetingAt: '2026-07-13T12:15:00.000Z',
    };
    await expect(new JobCardService(boundary, () => time).submitForApproval(
      staff, 'job-1', input('meeting-boundary'),
    )).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });

    const future = salesMeetingRepository();
    future.meetingDetails = {
      ...future.meetingDetails!, meetingAt: '2026-07-13T12:15:00.001Z',
    };
    await expect(new JobCardService(future, () => time).submitForApproval(
      staff, 'job-1', input('meeting-too-far-future'),
    )).rejects.toMatchObject({
      code: 'MEETING_NOT_READY',
      details: { fieldErrors: { meetingAt: expect.any(String) } },
    });
  });

  it('uses deterministic Customer, assignee, then detail error priority', async () => {
    const missingCustomer = salesMeetingRepository();
    missingCustomer.submissionCustomer = null;
    missingCustomer.assignee.isActive = false;
    missingCustomer.meetingDetails = null;
    await expect(new JobCardService(missingCustomer, () => time).submitForApproval(
      staff, 'job-1', input('missing-customer-priority'),
    )).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
    expect(missingCustomer.submissionReads).toEqual(['customer']);

    const inactiveCustomer = salesMeetingRepository();
    inactiveCustomer.submissionCustomer = {
      id: 'customer-1', organizationId: 'org-1', status: 'inactive',
    };
    await expect(new JobCardService(inactiveCustomer, () => time).submitForApproval(
      staff, 'job-1', input('inactive-customer-priority'),
    )).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
    expect(inactiveCustomer.submissionReads).toEqual(['customer']);

    const crossOrganizationCustomer = salesMeetingRepository();
    crossOrganizationCustomer.submissionCustomer = {
      id: 'customer-1', organizationId: 'org-2', status: 'active',
    };
    await expect(new JobCardService(crossOrganizationCustomer, () => time).submitForApproval(
      staff, 'job-1', input('cross-organization-customer'),
    )).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
    expect(crossOrganizationCustomer.submissionReads).toEqual(['customer']);

    const inactiveAssignee = salesMeetingRepository();
    inactiveAssignee.assignee.isActive = false;
    inactiveAssignee.meetingDetails = null;
    await expect(new JobCardService(inactiveAssignee, () => time).submitForApproval(
      staff, 'job-1', input('inactive-assignee-priority'),
    )).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE', statusCode: 400 });
    expect(inactiveAssignee.submissionReads).toEqual(['customer', 'assignee']);
  });

  it('reports a missing structured detail row as a safe invariant failure', async () => {
    const repo = salesMeetingRepository();
    repo.meetingDetails = null;
    await expect(new JobCardService(repo, () => time).submitForApproval(
      staff, 'job-1', input('missing-meeting-detail'),
    )).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION', statusCode: 500 });
  });

  it('resubmits a revised Sales Meeting through the shared lifecycle', async () => {
    const repo = salesMeetingRepository();
    repo.job.status = 'REVISION_REQUESTED';

    await new JobCardService(repo, () => time).resume(
      staff, 'job-1', input('resume-meeting'),
    );
    await expect(new JobCardService(repo, () => time).submitForApproval(
      staff, 'job-1', input('resubmit-meeting', 3),
    )).resolves.toMatchObject({ status: 'WAITING_APPROVAL', version: 4 });
    expect(repo.events.map((event) => event.event)).toEqual([
      'JOB_RESUMED', 'JOB_SUBMITTED_FOR_APPROVAL',
    ]);
  });

  it('rejects a General Task with an invalid persisted title or ineligible assignee', async () => {
    const invalidTitle = new LifecycleRepository();
    invalidTitle.job = {
      ...invalidTitle.job, type: 'GENERAL_TASK', title: '   ', customerId: null, contactId: null,
    };
    invalidTitle.items = [];
    await expect(new JobCardService(invalidTitle).submitForApproval(
      staff, 'job-1', input('invalid-task-title'),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(invalidTitle.transitions).toHaveLength(0);

    const inactiveAssignee = new LifecycleRepository();
    inactiveAssignee.job = {
      ...inactiveAssignee.job, type: 'GENERAL_TASK', customerId: null, contactId: null,
    };
    inactiveAssignee.items = [];
    inactiveAssignee.assignee.isActive = false;
    await expect(new JobCardService(inactiveAssignee).submitForApproval(
      staff, 'job-1', input('inactive-task-assignee'),
    )).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE', statusCode: 400 });
    expect(inactiveAssignee.transitions).toHaveLength(0);
  });
});

describe('Postgres lifecycle transition persistence', () => {
  it('uses command-specific timestamp and reason assignments in one versioned update', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (text.includes('UPDATE job_cards')) {
          return { rows: [{
            id: 'job-1', organization_id: 'org-1', type: 'PRODUCT_DELIVERY',
            status: 'IN_PROGRESS', version: 3, title: 'Teslim', description: null,
            customer_id: 'customer-1', contact_id: null, assigned_to: 'staff-1',
            created_by: 'staff-1', priority: 'normal', due_date: null,
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PostgresJobCardRepository({ connect: async () => client } as never);

    await repository.executeTransaction((tx) => tx.transitionWithVersion({
      organizationId: 'org-1', jobCardId: 'job-1', expectedVersion: 2,
      command: 'START', status: 'IN_PROGRESS', occurredAt: time, actorId: 'staff-1',
      note: null, revisionReason: null, cancelReason: null,
    }));

    const update = calls.find((call) => call.text.includes('UPDATE job_cards'))!;
    expect(update.text).toContain("planned_at = CASE WHEN $4 = 'PLANNED' THEN $5 ELSE planned_at END");
    expect(update.text).toContain("started_at = CASE WHEN $10 = 'START' THEN COALESCE(started_at, $5) ELSE started_at END");
    expect(update.text).toContain("revision_requested_at = CASE WHEN $10 = 'REQUEST_REVISION'");
    expect(update.text).toContain("cancelled_at = CASE WHEN $10 = 'CANCEL'");
    expect(update.text).toContain("cancel_reason = CASE WHEN $10 = 'CANCEL' THEN $9 ELSE cancel_reason END");
    expect(update.text.match(/\bWHERE\b/g)).toHaveLength(1);
    expect(update.values).toEqual([
      'org-1', 'job-1', 2, 'IN_PROGRESS', time, 'staff-1', null, null, null, 'START',
    ]);
  });
});
