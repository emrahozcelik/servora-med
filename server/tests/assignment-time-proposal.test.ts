import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/errors/index.js';
import { presentActivity } from '../src/modules/job-cards/activity-presenter.js';
import { assignmentProposedInterval } from '../src/modules/job-cards/assignment-offer-policy.js';
import {
  acceptAssignmentProposalRequestHash,
  lifecycleRequestHash,
} from '../src/modules/job-cards/critical-action-request-hash.js';
import type { AssignmentOfferRecord, JobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobAssignmentOfferRecord,
  JobCard,
  JobCardActor,
  PersistedJobCardDetail,
} from '../src/modules/job-cards/types.js';

/**
 * JOB-012: Staff time proposal on a declined/released assignment.
 *
 * Unit-level coverage of the pure rules (derived interval, request identity,
 * reader scope) and of the service's validation / command guards. The
 * PostgreSQL integration behaviour (persistence, transactions, realtime) is
 * covered by the assignment-offer PostgreSQL suites.
 */

const NOW = new Date('2026-11-24T10:00:00.000Z');
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_STAFF_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MANAGER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OFFER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111112';

const staff: JobCardActor = { id: STAFF_ID, organizationId: ORG, role: 'STAFF' };
const manager: JobCardActor = { id: MANAGER_ID, organizationId: ORG, role: 'MANAGER' };

function job(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: JOB_ID,
    organizationId: ORG,
    type: 'PRODUCT_DELIVERY',
    status: 'NEW',
    version: 3,
    title: 'İmplant seti teslimi',
    description: null,
    customerId: CUSTOMER_ID,
    contactId: null,
    assignedTo: STAFF_ID,
    createdBy: MANAGER_ID,
    priority: 'normal',
    dueDate: null,
    scheduledAt: '2026-11-24T12:00:00.000Z',
    scheduledEndsAt: '2026-11-24T13:00:00.000Z',
    engagementKind: null,
    sourceJobCardId: null,
    followUpInstructions: null,
    followUpProposedAt: null,
    followUpProposedType: null,
    followUpProposedAssignee: null,
    followUpProposalInstructions: null,
    followUpProposalOrigin: null,
    followUpProposedBy: null,
    invalidatedAt: null,
    invalidatedBy: null,
    invalidationReasonCode: null,
    ...overrides,
  };
}

function offer(overrides: Partial<AssignmentOfferRecord> = {}): AssignmentOfferRecord {
  return {
    id: OFFER_ID,
    organizationId: ORG,
    jobCardId: JOB_ID,
    assigneeUserId: STAFF_ID,
    openedAt: new Date('2026-11-24T09:00:00.000Z'),
    openedReason: 'CREATE',
    openedBy: MANAGER_ID,
    assignmentHistoryId: null,
    acceptanceDueAt: new Date('2026-11-24T10:00:00.000Z'),
    urgentReason: null,
    ackCode: null,
    ackText: null,
    state: 'DECLINED',
    closedAt: new Date('2026-11-24T09:30:00.000Z'),
    closedBy: STAFF_ID,
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: 'Aynı saatte başka bir klinik teslimi var.',
    proposedScheduledAt: new Date('2026-11-25T09:00:00.000Z'),
    suggestedSolution: null,
    proposalAcceptedAt: null,
    proposalAcceptedBy: null,
    ...overrides,
  };
}

function detail(overrides: Partial<PersistedJobCardDetail> = {}): PersistedJobCardDetail {
  return {
    id: JOB_ID, organizationId: ORG, type: 'PRODUCT_DELIVERY', status: 'NEW', version: 3,
    title: 'İmplant seti teslimi', description: null,
    customerId: CUSTOMER_ID, contactId: null,
    assignedTo: STAFF_ID, createdBy: MANAGER_ID, priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-24T12:00:00.000Z',
    scheduledEndsAt: '2026-11-24T13:00:00.000Z',
    engagementKind: null,
    sourceJobCardId: null,
    followUpInstructions: null,
    followUpProposedAt: null,
    followUpProposedType: null,
    followUpProposedAssignee: null,
    followUpProposalInstructions: null,
    followUpProposalOrigin: null,
    followUpProposedBy: null,
    invalidatedAt: null,
    invalidatedBy: null,
    invalidationReasonCode: null,
    organizationTimezone: 'Europe/Istanbul',
    assignee: { id: STAFF_ID, name: 'Saha Personeli' },
    customer: { id: CUSTOMER_ID, name: 'Demo Dental Klinik' },
    contact: null,
    lifecycle: {
      createdAt: '2026-11-24T08:00:00.000Z',
      acceptedAt: null, acceptedBy: null,
      startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
      approvedAt: null, approvedBy: null, approvalNote: null,
      revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
      cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      followUpCycleEndReason: null,
      invalidatedAt: null, invalidatedBy: null,
      invalidationReasonCode: null, invalidatedFromStatus: null,
    },
    proposer: null,
    earlyStartAuthorization: null,
    changeRequest: null,
    assignmentOffer: null,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    ...overrides,
  };
}

function offerView(overrides: Partial<JobAssignmentOfferRecord> = {}): JobAssignmentOfferRecord {
  return {
    id: OFFER_ID,
    state: 'DECLINED',
    openedAt: new Date('2026-11-24T09:00:00.000Z'),
    openedReason: 'CREATE',
    acceptanceDueAt: new Date('2026-11-24T10:00:00.000Z'),
    urgentReason: null,
    assigneeUserId: STAFF_ID,
    assigneeId: STAFF_ID,
    assigneeName: 'Saha Personeli',
    closedAt: new Date('2026-11-24T09:30:00.000Z'),
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: 'Aynı saatte başka bir klinik teslimi var.',
    proposedScheduledAt: new Date('2026-11-25T09:00:00.000Z'),
    suggestedSolution: null,
    proposalAcceptedAt: null,
    ...overrides,
  };
}

function buildService(input: {
  repository?: Record<string, unknown>;
  calendarEnabled?: boolean;
  windowEnabled?: boolean;
} = {}): JobCardService {
  return new JobCardService(
    input.repository as unknown as JobCardRepository,
    () => NOW,
    undefined,
    undefined,
    undefined,
    { enabled: input.calendarEnabled ?? false, reminderLeadMinutes: 30 },
    undefined,
    { enabled: input.windowEnabled ?? true },
  );
}

describe('JOB-012 derived proposal interval', () => {
  it('keeps the persisted planned duration', () => {
    const interval = assignmentProposedInterval(
      { type: 'PRODUCT_DELIVERY', scheduledAt: '2026-11-24T12:00:00.000Z', scheduledEndsAt: '2026-11-24T13:00:00.000Z' },
      '2026-11-25T09:00:00.000Z',
    );
    // PRODUCT_DELIVERY canonical is 30 min; the persisted 60 min wins.
    expect(interval?.startsAt.toISOString()).toBe('2026-11-25T09:00:00.000Z');
    expect(interval?.endsAt.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });

  it('falls back to the canonical duration when the plan has no interval', () => {
    expect(assignmentProposedInterval(
      { type: 'PRODUCT_DELIVERY', scheduledAt: null, scheduledEndsAt: null },
      '2026-11-25T09:00:00.000Z',
    )?.endsAt.toISOString()).toBe('2026-11-25T09:30:00.000Z');
    expect(assignmentProposedInterval(
      { type: 'SALES_MEETING', scheduledAt: null, scheduledEndsAt: null },
      '2026-11-25T09:00:00.000Z',
    )?.endsAt.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });
});

describe('JOB-012 request identity', () => {
  const base = {
    command: 'DECLINE_ASSIGNMENT' as const,
    jobCardId: JOB_ID,
    expectedVersion: 3,
    note: null,
    revisionReason: null,
    cancelReason: null,
    assignmentReason: { code: 'SCHEDULE_CONFLICT', text: '  Çakışma var.  ' },
  };

  it('keeps the pre-JOB-012 hash byte-identical when no time is proposed', () => {
    const withoutField = lifecycleRequestHash(base);
    const explicitNull = lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, proposedScheduledAt: null },
    });
    expect(explicitNull).toBe(withoutField);
  });

  it('binds the proposed instant into the command identity', () => {
    const withoutProposal = lifecycleRequestHash(base);
    const withProposal = lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, proposedScheduledAt: '2026-11-25T09:00:00.000Z' },
    });
    const otherInstant = lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, proposedScheduledAt: '2026-11-25T10:00:00.000Z' },
    });
    expect(withProposal).not.toBe(withoutProposal);
    expect(otherInstant).not.toBe(withProposal);
    // The same instant written with an offset is the same request.
    expect(lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, proposedScheduledAt: '2026-11-25T12:00:00+03:00' },
    })).toBe(withProposal);
  });

  it('RESCUE-002: binds a typed suggestion only when it is present', () => {
    const legacy = lifecycleRequestHash(base);
    // Absent and explicit null are both the legacy body.
    expect(lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, suggestedSolution: null },
    })).toBe(legacy);
    const suggested = lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, suggestedSolution: 'MANAGEMENT_DECIDES' },
    });
    const otherSuggestion = lifecycleRequestHash({
      ...base,
      assignmentReason: { ...base.assignmentReason, suggestedSolution: 'REASSIGN' },
    });
    expect(suggested).not.toBe(legacy);
    expect(otherSuggestion).not.toBe(suggested);
  });

  it('identifies the confirmation by job, version and proposal offer', () => {
    const hash = acceptAssignmentProposalRequestHash(JOB_ID, 3, OFFER_ID);
    expect(hash).toBe(acceptAssignmentProposalRequestHash(JOB_ID, 3, OFFER_ID));
    expect(acceptAssignmentProposalRequestHash(JOB_ID, 4, OFFER_ID)).not.toBe(hash);
    expect(acceptAssignmentProposalRequestHash(JOB_ID, 3, STAFF_ID)).not.toBe(hash);
  });
});

describe('JOB-012 Staff answer validation', () => {
  const untouchedRepository = () => ({
    findCompletedCriticalAction: vi.fn(),
    reserveLifecycleIntent: vi.fn(),
    executeCriticalAction: vi.fn(),
  });

  const decision = {
    clientActionId: 'action-1',
    expectedVersion: 3,
    reasonText: 'Aynı saatte başka bir klinik teslimi var.',
  };

  it('requires the proposed time with SCHEDULE_CONFLICT', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'SCHEDULE_CONFLICT',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { fieldErrors: { proposedScheduledAt: 'Önerilen zaman zorunludur.' } },
    });
    await expect(buildService({ repository }).releaseAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'SCHEDULE_CONFLICT', proposedScheduledAt: null,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: 'Önerilen zaman zorunludur.' } },
    });
    expect(repository.findCompletedCriticalAction).not.toHaveBeenCalled();
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('checks the future bound only after the replay lookup, against the reservation', async () => {
    // A completed answer must still replay once its proposal has passed, so the
    // time-dependent bound never runs before the 049 replay lookup. The past
    // and boundary rejections themselves are proven against PostgreSQL.
    const repository = untouchedRepository();
    const stop = new Error('reservation reached');
    repository.reserveLifecycleIntent.mockRejectedValue(stop);
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'SCHEDULE_CONFLICT',
      proposedScheduledAt: '2026-11-24T09:00:00.000Z',
    })).rejects.toBe(stop);
    expect(repository.findCompletedCriticalAction).toHaveBeenCalledTimes(1);
    expect(repository.reserveLifecycleIntent).toHaveBeenCalledTimes(1);
  });

  it('accepts only a canonical instant', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'SCHEDULE_CONFLICT', proposedScheduledAt: '2026-11-25 09:00',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: 'proposedScheduledAt geçersizdir.' } },
    });
  });

  it('rejects a time attached to any other reason', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'ON_LEAVE',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: expect.any(String) } },
    });
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('stores the proposal on the offer the answer closes, after the calendar check', async () => {
    const openOffer = offer({
      state: 'OPEN',
      acceptanceDueAt: new Date('2026-11-24T11:00:00.000Z'),
      closedAt: null,
      closedBy: null,
      closeReason: null,
      closeText: null,
      proposedScheduledAt: null,
    });
    const tx = {
      getJobForUpdate: async () => job(),
      getLatestAssignmentOffer: async () => openOffer,
      transitionWithVersion: async () => job({ version: 4 }),
      closeAssignmentOffer: vi.fn(async () => true),
      appendActivity: vi.fn(async () => ({ id: 'activity-1', createdAt: NOW })),
      appendRealtimeEvent: vi.fn(async () => ({ id: 'event-1' })),
      appendNotifications: vi.fn(async () => []),
      listActiveManagementRecipients: vi.fn(async () => []),
      assertCalendarAvailability: vi.fn(async () => undefined),
    };
    const repository = {
      findCompletedCriticalAction: async () => null,
      reserveLifecycleIntent: async (
        _claim: unknown,
        reserve: { preflight?: (tx: unknown, jobs: Map<string, JobCard>, at: Date) => Promise<void> },
      ) => {
        await reserve.preflight?.(tx, new Map([[JOB_ID, job()]]), NOW);
        return { kind: 'reserved' as const, reservation: { intentId: 'intent-1', reservedAt: NOW } };
      },
      finalizeLifecycleIntent: async (
        _claim: unknown,
        _reservation: unknown,
        work: (tx: unknown) => Promise<{ response: unknown; realtimeEvents: unknown[] }>,
      ) => {
        const result = await work(tx);
        return { kind: 'completed' as const, response: result.response, realtimeEvents: result.realtimeEvents };
      },
      findJobCardDetail: async () => detail(),
    };

    await buildService({ repository, calendarEnabled: true }).declineAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'SCHEDULE_CONFLICT',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    });

    expect(tx.assertCalendarAvailability).toHaveBeenCalledWith({
      organizationId: ORG,
      jobCardId: JOB_ID,
      assignedUserId: STAFF_ID,
      startsAt: '2026-11-25T09:00:00.000Z',
      // The persisted 60-minute plan, not the PRODUCT_DELIVERY canonical 30.
      endsAt: '2026-11-25T10:00:00.000Z',
      includeCalendarEvents: true,
    });
    expect(tx.closeAssignmentOffer).toHaveBeenCalledWith(expect.objectContaining({
      offerId: OFFER_ID,
      state: 'DECLINED',
      closeReason: 'SCHEDULE_CONFLICT',
      proposedScheduledAt: new Date('2026-11-25T09:00:00.000Z'),
    }));
    const declineActivity = tx.appendActivity.mock.calls.find(
      ([input]) => (input as { event: string }).event === 'JOB_ASSIGNMENT_DECLINED',
    )![0] as { metadata: Record<string, unknown> };
    expect(declineActivity.metadata).toEqual({
      offerId: OFFER_ID,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka bir klinik teslimi var.',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    });
  });
});

describe('RESCUE-002 Staff suggestion validation', () => {
  const untouchedRepository = () => ({
    findCompletedCriticalAction: vi.fn(),
    reserveLifecycleIntent: vi.fn(),
    executeCriticalAction: vi.fn(),
  });

  const decision = {
    clientActionId: 'action-suggestion',
    expectedVersion: 3,
    reasonText: 'Planım bu iş için uygun değil.',
  };

  it('requires a suggestion for a new reason code', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'OUT_OF_TOWN',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { fieldErrors: { suggestedSolution: 'Çözüm önerisi zorunludur.' } },
    });
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('rejects an unknown suggestion', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).releaseAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'ON_LEAVE',
      suggestedSolution: 'NOT_A_SOLUTION' as never,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { suggestedSolution: expect.any(String) } },
    });
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('requires a time with RESCHEDULE_SELF whatever the reason', async () => {
    const repository = untouchedRepository();
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'ON_LEAVE', suggestedSolution: 'RESCHEDULE_SELF',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: 'Önerilen zaman zorunludur.' } },
    });
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('rejects a time with any other suggestion using the contract copy', async () => {
    const repository = untouchedRepository();
    const copy = 'Önerilen zaman yalnızca "Başka bir zamanda kendim yapabilirim" seçildiğinde verilebilir.';
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'SCHEDULE_CONFLICT',
      suggestedSolution: 'REASSIGN',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: copy } },
    });
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('accepts SCHEDULE_CONFLICT + REASSIGN without a time and any reason + RESCHEDULE_SELF with one', async () => {
    const repository = untouchedRepository();
    const stop = new Error('reservation reached');
    repository.reserveLifecycleIntent.mockRejectedValue(stop);
    await expect(buildService({ repository }).declineAssignment(staff, JOB_ID, {
      ...decision, reasonCode: 'SCHEDULE_CONFLICT', suggestedSolution: 'REASSIGN',
    })).rejects.toBe(stop);
    await expect(buildService({ repository }).releaseAssignment(staff, JOB_ID, {
      ...decision,
      reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
      suggestedSolution: 'RESCHEDULE_SELF',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    })).rejects.toBe(stop);
    expect(repository.reserveLifecycleIntent).toHaveBeenCalledTimes(2);
  });
});

describe('JOB-012 accept-proposal command', () => {
  const proposalInput = {
    clientActionId: 'action-confirm',
    expectedVersion: 3,
    offerId: OFFER_ID,
  };

  function runWith(tx: Record<string, unknown>, input: { windowEnabled?: boolean; calendarEnabled?: boolean } = {}) {
    const executeCriticalAction = vi.fn(async (
      _identity: unknown,
      work: (transaction: unknown) => Promise<unknown>,
    ) => {
      const result = await work(tx) as { response: unknown; realtimeEvents: unknown[] };
      return { kind: 'completed', response: result.response, realtimeEvents: result.realtimeEvents };
    });
    const repository = { executeCriticalAction };
    return {
      executeCriticalAction,
      service: buildService({ repository, ...input }),
    };
  }

  function acceptingTx(overrides: Record<string, unknown> = {}) {
    const accepted = job({ status: 'ACCEPTED', version: 4, scheduledAt: '2026-11-25T09:00:00.000Z', scheduledEndsAt: '2026-11-25T10:00:00.000Z' });
    const tx = {
      getJob: vi.fn(async () => job()),
      getAssigneeForUpdate: vi.fn(async () => ({ id: STAFF_ID, organizationId: ORG, role: 'STAFF', isActive: true })),
      getJobForUpdate: vi.fn(async () => job()),
      getLatestAssignmentOffer: vi.fn(async () => offer()),
      assertCalendarAvailability: vi.fn(async () => undefined),
      transitionWithVersion: vi.fn(async () => accepted),
      appendScheduleRevision: vi.fn(async () => ({ revisionNo: 2 })),
      voidEarlyStartAuthorizations: vi.fn(async () => undefined),
      synchronizeCalendarReminder: vi.fn(async () => undefined),
      appendActivity: vi.fn(async () => ({ id: 'activity-1', createdAt: NOW })),
      markAssignmentOfferProposalAccepted: vi.fn(async () => true),
      insertAssignmentOffer: vi.fn(async () => offer({
        id: 'offer-confirmed',
        state: 'ACCEPTED',
        openedReason: 'PROPOSAL_ACCEPTED',
        closedAt: NOW,
        closedBy: STAFF_ID,
        closeReason: null,
        closeText: null,
        proposedScheduledAt: null,
      })),
      appendRealtimeEvent: vi.fn(async () => ({ id: 'event-1' })),
      appendNotifications: vi.fn(async () => []),
      ...overrides,
    };
    return tx;
  }

  it('rejects STAFF before any lookup', async () => {
    const { service, executeCriticalAction } = runWith(acceptingTx());
    await expect(service.acceptAssignmentProposal(staff, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(executeCriticalAction).not.toHaveBeenCalled();
  });

  it('fails closed while the assignment window is disabled', async () => {
    const { service, executeCriticalAction } = runWith(acceptingTx(), { windowEnabled: false });
    await expect(service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_WINDOW_DISABLED', statusCode: 409 });
    expect(executeCriticalAction).not.toHaveBeenCalled();
  });

  it('validates the body before touching the job', async () => {
    const { service, executeCriticalAction } = runWith(acceptingTx());
    await expect(service.acceptAssignmentProposal(manager, JOB_ID, {
      ...proposalInput, offerId: 'not-a-uuid',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.acceptAssignmentProposal(manager, JOB_ID, {
      ...proposalInput, expectedVersion: 0,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(executeCriticalAction).not.toHaveBeenCalled();
  });

  it('requires the job latest offer to be the named unconfirmed proposal', async () => {
    const otherOffer = acceptingTx({
      getLatestAssignmentOffer: vi.fn(async () => offer({ id: 'another-offer' })),
    });
    await expect(runWith(otherOffer).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE', statusCode: 409 });
    expect(otherOffer.transitionWithVersion).not.toHaveBeenCalled();

    const confirmed = acceptingTx({
      getLatestAssignmentOffer: vi.fn(async () => offer({ proposalAcceptedAt: NOW, proposalAcceptedBy: MANAGER_ID })),
    });
    await expect(runWith(confirmed).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE' });

    const openOffer = acceptingTx({
      getLatestAssignmentOffer: vi.fn(async () => offer({ state: 'OPEN', proposedScheduledAt: null })),
    });
    await expect(runWith(openOffer).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE' });

    const reassigned = acceptingTx({
      getJobForUpdate: vi.fn(async () => job({ assignedTo: OTHER_STAFF_ID })),
      getLatestAssignmentOffer: vi.fn(async () => offer({ assigneeUserId: OTHER_STAFF_ID })),
      getAssigneeForUpdate: vi.fn(async () => ({ id: OTHER_STAFF_ID, organizationId: ORG, role: 'STAFF', isActive: false })),
    });
    await expect(runWith(reassigned).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE' });
  });

  it('rejects a proposal whose start already passed', async () => {
    const tx = acceptingTx({
      getLatestAssignmentOffer: vi.fn(async () => offer({
        proposedScheduledAt: new Date('2026-11-24T09:00:00.000Z'),
      })),
    });
    await expect(runWith(tx).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_PROPOSAL_EXPIRED', statusCode: 409 });
    expect(tx.transitionWithVersion).not.toHaveBeenCalled();
    expect(tx.markAssignmentOfferProposalAccepted).not.toHaveBeenCalled();
  });

  it('rejects a Staff calendar conflict without writing', async () => {
    const tx = acceptingTx({
      assertCalendarAvailability: vi.fn(async () => {
        throw new AppError('CALENDAR_CONFLICT', 409, 'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.', {
          conflicts: [],
        });
      }),
    });
    await expect(runWith(tx, { calendarEnabled: true }).service.acceptAssignmentProposal(manager, JOB_ID, proposalInput))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT', statusCode: 409 });
    // The derived interval is the persisted 60-minute plan, starting at the
    // proposed instant.
    expect(tx.assertCalendarAvailability).toHaveBeenCalledWith({
      organizationId: ORG,
      jobCardId: JOB_ID,
      assignedUserId: STAFF_ID,
      startsAt: '2026-11-25T09:00:00.000Z',
      endsAt: '2026-11-25T10:00:00.000Z',
      includeCalendarEvents: true,
    });
    expect(tx.transitionWithVersion).not.toHaveBeenCalled();
  });

  it('moves the interval, records the confirmation and accepts for the proposer in one transaction', async () => {
    const tx = acceptingTx();
    const result = await runWith(tx, { calendarEnabled: true })
      .service.acceptAssignmentProposal(manager, JOB_ID, proposalInput);

    // Effect 1: the reschedule and the acceptance are one statement, accepted
    // by the proposing Staff member (the actor owns the activity).
    expect(tx.transitionWithVersion).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ACCEPT_ASSIGNMENT',
      status: 'ACCEPTED',
      expectedVersion: 3,
      actorId: MANAGER_ID,
      acceptedBy: STAFF_ID,
      occurredAt: NOW,
      schedule: {
        scheduledAt: new Date('2026-11-25T09:00:00.000Z'),
        scheduledEndsAt: new Date('2026-11-25T10:00:00.000Z'),
      },
    }));
    expect(tx.appendScheduleRevision).toHaveBeenCalledWith(expect.objectContaining({
      source: 'RESCHEDULE',
      scheduledAt: '2026-11-25T09:00:00.000Z',
      scheduledEndsAt: '2026-11-25T10:00:00.000Z',
      createdAt: NOW,
    }));
    expect(tx.voidEarlyStartAuthorizations).toHaveBeenCalledWith(expect.objectContaining({
      voidReason: 'RESCHEDULED',
    }));
    const fieldActivity = tx.appendActivity.mock.calls.find(
      ([input]) => (input as { event: string }).event === 'JOB_FIELDS_UPDATED',
    )![0] as { oldValue: unknown; newValue: unknown };
    expect(fieldActivity.oldValue).toEqual({
      scheduledAt: '2026-11-24T12:00:00.000Z',
      scheduledEndsAt: '2026-11-24T13:00:00.000Z',
    });
    expect(fieldActivity.newValue).toEqual({
      scheduledAt: '2026-11-25T09:00:00.000Z',
      scheduledEndsAt: '2026-11-25T10:00:00.000Z',
    });

    // Effect 2: the answered offer records the one-way confirmation.
    expect(tx.markAssignmentOfferProposalAccepted).toHaveBeenCalledWith({
      organizationId: ORG,
      jobCardId: JOB_ID,
      offerId: OFFER_ID,
      proposalAcceptedAt: NOW,
      proposalAcceptedBy: MANAGER_ID,
    });

    // Effect 3: the confirmation's own offer, created ACCEPTED for the
    // proposer, with no open activity.
    expect(tx.insertAssignmentOffer).toHaveBeenCalledWith(expect.objectContaining({
      openedReason: 'PROPOSAL_ACCEPTED',
      openedBy: MANAGER_ID,
      assigneeUserId: STAFF_ID,
      closeImmediately: {
        state: 'ACCEPTED',
        closedAt: NOW,
        closedBy: STAFF_ID,
        closeReason: null,
      },
    }));
    expect(tx.appendActivity.mock.calls.some(
      ([input]) => (input as { event: string }).event === 'JOB_ASSIGNMENT_OFFER_OPENED',
    )).toBe(false);

    // Effect 4: the acceptance, attributed to management, naming both offers.
    const acceptedActivity = tx.appendActivity.mock.calls.find(
      ([input]) => (input as { event: string }).event === 'JOB_ACCEPTED',
    )![0] as { actorId: string; metadata: Record<string, unknown> };
    expect(acceptedActivity.actorId).toBe(MANAGER_ID);
    expect(acceptedActivity.metadata).toEqual({
      via: 'TIME_PROPOSAL',
      offerId: 'offer-confirmed',
      proposalOfferId: OFFER_ID,
      proposerId: STAFF_ID,
    });

    expect(result).toEqual({
      jobCardId: JOB_ID,
      offerId: 'offer-confirmed',
      scheduledAt: '2026-11-25T09:00:00.000Z',
      scheduledEndsAt: '2026-11-25T10:00:00.000Z',
    });
  });
});

describe('JOB-012 reads', () => {
  it('derives the proposed end on the job detail offer view', async () => {
    const service = buildService({
      repository: { findJobCardDetail: async () => detail({ assignmentOffer: offerView() }) },
      windowEnabled: true,
    });
    const result = await service.detail(manager, JOB_ID);
    expect(result.assignmentOffer).toMatchObject({
      state: 'DECLINED',
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
      proposedScheduledEndsAt: '2026-11-25T10:00:00.000Z',
      proposalAcceptedAt: null,
    });
  });

  it('carries the confirmation instant once management confirmed', async () => {
    const service = buildService({
      repository: {
        findJobCardDetail: async () => detail({
          // A shape the 073 CHECKs allow: the answered offer, confirmed.
          assignmentOffer: offerView({ proposalAcceptedAt: NOW }),
        }),
      },
    });
    const result = await service.detail(manager, JOB_ID);
    expect(result.assignmentOffer?.proposalAcceptedAt).toBe('2026-11-24T10:00:00.000Z');
  });

  it('projects the proposal only to management and the answering Staff member', () => {
    const record = {
      id: 'activity-1',
      jobCardId: JOB_ID,
      actorId: STAFF_ID,
      actorName: 'Saha Personeli',
      eventType: 'JOB_ASSIGNMENT_DECLINED' as const,
      oldValue: null,
      newValue: null,
      metadata: {
        offerId: OFFER_ID,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Aynı saatte başka bir klinik teslimi var.',
        proposedScheduledAt: '2026-11-25T09:00:00.000Z',
      },
      clientActionId: null,
      createdAt: NOW,
    };
    expect(presentActivity(record, { viewer: { id: MANAGER_ID, role: 'MANAGER' } }).details).toEqual({
      kind: 'ASSIGNMENT_DECISION',
      decision: 'DECLINED',
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka bir klinik teslimi var.',
      suggestedSolution: null,
      proposedScheduledAt: '2026-11-25T09:00:00.000Z',
    });
    expect(presentActivity(record, { viewer: { id: STAFF_ID, role: 'STAFF' } }).details)
      .toMatchObject({ proposedScheduledAt: '2026-11-25T09:00:00.000Z' });
    // A later Staff assignee sees none of the personal answer.
    expect(presentActivity(record, { viewer: { id: OTHER_STAFF_ID, role: 'STAFF' } }).details).toEqual({
      kind: 'ASSIGNMENT_DECISION',
      decision: 'DECLINED',
      reasonCode: null,
      reasonText: null,
      suggestedSolution: null,
      proposedScheduledAt: null,
    });
    expect(presentActivity(record).details).toMatchObject({ proposedScheduledAt: null });
  });

  it('presents the RESCUE-002 suggestion only to management and the answering Staff member', () => {
    const record = {
      id: 'activity-2',
      jobCardId: JOB_ID,
      actorId: STAFF_ID,
      actorName: 'Saha Personeli',
      eventType: 'JOB_ASSIGNMENT_RELEASED' as const,
      oldValue: null,
      newValue: null,
      metadata: {
        offerId: OFFER_ID,
        reasonCode: 'OUT_OF_TOWN',
        reasonText: 'Şehir dışındayım.',
        suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: '2026-11-25T09:00:00.000Z',
      },
      clientActionId: null,
      createdAt: NOW,
    };
    expect(presentActivity(record, { viewer: { id: MANAGER_ID, role: 'MANAGER' } }).details)
      .toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'RELEASED',
        reasonCode: 'OUT_OF_TOWN',
        suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: '2026-11-25T09:00:00.000Z',
      });
    expect(presentActivity(record, { viewer: { id: STAFF_ID, role: 'STAFF' } }).details)
      .toMatchObject({ suggestedSolution: 'RESCHEDULE_SELF' });
    expect(presentActivity(record, { viewer: { id: OTHER_STAFF_ID, role: 'STAFF' } }).details)
      .toMatchObject({ suggestedSolution: null, proposedScheduledAt: null });
    // An unknown stored value degrades to null instead of a raw string.
    expect(presentActivity({
      ...record,
      metadata: { ...record.metadata, suggestedSolution: 'NOT_A_SOLUTION' },
    }, { viewer: { id: MANAGER_ID, role: 'MANAGER' } }).details)
      .toMatchObject({ suggestedSolution: null });
  });
});
