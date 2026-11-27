import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptAssignmentProposal,
  createFollowUp,
  createJobCard,
  createProductDelivery,
  declineAssignment,
  getJobCard,
  listActivity,
  listAssignmentOffersNeedingAction,
  pastStartAcknowledgementPayload,
  patchJobCard,
  reofferAssignment,
  releaseAssignment,
  type AssignmentOfferNeedingActionItem,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

afterEach(() => vi.unstubAllGlobals());

const related = (id: string, name: string) => ({ id, name });

const assignmentOffer = {
  id: 'offer-1',
  state: 'OPEN',
  openedAt: '2026-11-21T11:00:00.000Z',
  acceptanceDueAt: '2026-11-21T12:00:00.000Z',
  urgentReason: 'SHORT_NOTICE',
  assignee: related('s1', 'Ayşe Personel'),
  closedAt: null,
  closeReason: null,
  closeText: null,
  proposedScheduledAt: null,
  proposedScheduledEndsAt: null,
  proposalAcceptedAt: null,
};

function jobCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'PRODUCT_DELIVERY', status: 'NEW', version: 3,
    engagementKind: null,
    title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-21T11:00:00.000Z',
    scheduledEndsAt: '2026-11-21T12:00:00.000Z',
    assignee: related('s1', 'Ayşe Personel'), customer: related('c1', 'ABC Klinik'),
    contact: null,
    workflowContext,
    followUpContext: null,
    followUpProposal: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer,
    ...overrides,
  };
}

const listItem: AssignmentOfferNeedingActionItem = {
  jobCardId: 'job-1',
  jobTitle: 'Klinik teslimi',
  jobType: 'PRODUCT_DELIVERY',
  offerId: 'offer-1',
  state: 'DECLINED',
  closeReason: 'SCHEDULE_CONFLICT',
  closeText: 'Aynı saatte başka teslim var.',
  acceptanceDueAt: '2026-11-21T12:00:00.000Z',
  urgentReason: null,
  scheduledAt: '2026-11-21T13:00:00.000Z',
  proposedScheduledAt: null,
  assignee: related('s1', 'Ayşe Personel'),
  customer: related('c1', 'ABC Klinik'),
  jobPath: '/jobs/job-1',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bodyOf(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('job detail assignment offer DTO', () => {
  it('parses the offer and its null/absent form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard())));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ assignmentOffer });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: null }))));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ assignmentOffer: null });

    // A previous backend keeps its old shape until the release is deployed.
    const { assignmentOffer: _omitted, ...withoutOffer } = jobCard();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(withoutOffer)));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ assignmentOffer: null });
  });

  it('parses every state and every urgent reason', async () => {
    for (const state of ['OPEN', 'ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({
        assignmentOffer: { ...assignmentOffer, state },
      }))));
      await expect(getJobCard('job-1')).resolves.toMatchObject({ assignmentOffer: { state } });
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({
      assignmentOffer: { ...assignmentOffer, urgentReason: 'START_PASSED' },
    }))));
    await expect(getJobCard('job-1')).resolves.toMatchObject({
      assignmentOffer: { urgentReason: 'START_PASSED' },
    });
  });

  it.each([
    ['unknown state', { ...assignmentOffer, state: 'ANSWERED' }],
    ['unknown urgent reason', { ...assignmentOffer, urgentReason: 'VERY_LATE' }],
    ['missing urgent reason key', (() => {
      const { urgentReason: _omitted, ...rest } = assignmentOffer;
      return rest;
    })()],
    ['unknown close reason', { ...assignmentOffer, closeReason: 'CUSTOMER_CHANGED_MIND' }],
    ['missing close reason key', (() => {
      const { closeReason: _omitted, ...rest } = assignmentOffer;
      return rest;
    })()],
    ['non-canonical closed instant', { ...assignmentOffer, closedAt: '2026-11-21T12:00:00Z' }],
    ['non-canonical instant', { ...assignmentOffer, acceptanceDueAt: '2026-11-21T12:00:00Z' }],
    ['loose assignee shape', { ...assignmentOffer, assignee: { id: 's1', name: 'Ayşe', role: 'STAFF' } }],
    ['empty id', { ...assignmentOffer, id: '' }],
  ])('rejects an assignment offer with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: candidate }))));
    await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 });
  });

  it('parses the closed offer fields a declined offer carries', async () => {
    const closed = {
      ...assignmentOffer,
      state: 'DECLINED',
      urgentReason: null,
      closedAt: '2026-11-21T11:20:00.000Z',
      closeReason: 'SCHEDULE_CONFLICT',
      closeText: 'Önümüzdeki haftaya ziyaret sağlanacak',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: closed }))));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ assignmentOffer: closed });
  });

  it('parses the JOB-012 proposed interval and its acceptance mark', async () => {
    const proposed = {
      ...assignmentOffer,
      state: 'DECLINED',
      urgentReason: null,
      closedAt: '2026-11-21T11:20:00.000Z',
      closeReason: 'SCHEDULE_CONFLICT',
      closeText: null,
      proposedScheduledAt: '2026-11-23T09:00:00.000Z',
      proposedScheduledEndsAt: '2026-11-23T09:30:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: proposed }))));
    await expect(getJobCard('job-1')).resolves.toMatchObject({
      assignmentOffer: {
        proposedScheduledAt: '2026-11-23T09:00:00.000Z',
        proposedScheduledEndsAt: '2026-11-23T09:30:00.000Z',
        proposalAcceptedAt: null,
      },
    });

    const accepted = { ...proposed, proposalAcceptedAt: '2026-11-22T08:00:00.000Z' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: accepted }))));
    await expect(getJobCard('job-1')).resolves.toMatchObject({
      assignmentOffer: { proposalAcceptedAt: '2026-11-22T08:00:00.000Z' },
    });
  });

  it.each([
    ['missing proposed start key', (() => {
      const { proposedScheduledAt: _omitted, ...rest } = assignmentOffer;
      return rest;
    })()],
    ['missing proposed end key', (() => {
      const { proposedScheduledEndsAt: _omitted, ...rest } = assignmentOffer;
      return rest;
    })()],
    ['missing proposal acceptance key', (() => {
      const { proposalAcceptedAt: _omitted, ...rest } = assignmentOffer;
      return rest;
    })()],
    ['non-canonical proposed start', {
      ...assignmentOffer, proposedScheduledAt: '2026-11-23T09:00:00Z',
    }],
    ['loose proposed end', {
      ...assignmentOffer, proposedScheduledEndsAt: '2026-11-23',
    }],
    ['non-canonical acceptance mark', {
      ...assignmentOffer, proposalAcceptedAt: '2026-11-22T08:00:00+03:00',
    }],
  ])('rejects a JOB-012 proposal with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(jobCard({ assignmentOffer: candidate }))));
    await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 });
  });
});

describe('assignment offer needs-action list', () => {
  it('requests the management list with pagination and parses every item field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [listItem], total: 7, limit: 25, offset: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAssignmentOffersNeedingAction({ limit: 25, offset: 0 })).resolves.toEqual({
      items: [listItem], total: 7, limit: 25, offset: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/assignment-offers/needs-action?limit=25&offset=0',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('accepts a null close reason and a null customer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [{ ...listItem, state: 'EXPIRED', closeReason: null, closeText: null, customer: null }],
      total: 1, limit: 25, offset: 0,
    })));
    await expect(listAssignmentOffersNeedingAction()).resolves.toMatchObject({
      items: [{ closeReason: null, closeText: null, customer: null }],
    });
  });

  it('parses the JOB-012 proposal on a needs-action row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [{ ...listItem, proposedScheduledAt: '2026-11-23T09:00:00.000Z' }],
      total: 1, limit: 25, offset: 0,
    })));
    await expect(listAssignmentOffersNeedingAction()).resolves.toMatchObject({
      items: [{ proposedScheduledAt: '2026-11-23T09:00:00.000Z' }],
    });
  });

  it.each([
    ['unknown job type', { ...listItem, jobType: 'SURVEY' }],
    ['unknown state', { ...listItem, state: 'ANSWERED' }],
    ['unknown close reason', { ...listItem, closeReason: 'CUSTOMER_CHANGED_MIND' }],
    ['unknown urgent reason', { ...listItem, urgentReason: 'VERY_LATE' }],
    ['extra key', { ...listItem, jobStatus: 'NEW' }],
    ['broken instant', { ...listItem, acceptanceDueAt: '2026-11-21' }],
    ['non-canonical scheduled instant', { ...listItem, scheduledAt: '2026-11-21T13:00:00Z' }],
    ['non-canonical proposed instant', { ...listItem, proposedScheduledAt: '2026-11-23T09:00:00Z' }],
    ['missing proposed key', (() => {
      const { proposedScheduledAt: _omitted, ...rest } = listItem;
      return rest;
    })()],
    ['extra assignee field', { ...listItem, assignee: { id: 's1', name: 'Ayşe', email: 'a@x' } }],
    ['missing customer key', (() => {
      const { customer: _omitted, ...rest } = listItem;
      return rest;
    })()],
  ])('rejects a list item with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [candidate], total: 1, limit: 25, offset: 0,
    })));
    await expect(listAssignmentOffersNeedingAction()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('assignment decision activity details', () => {
  const activity = (details: unknown) => ({
    id: 'a1', jobCardId: 'job-1', eventType: 'JOB_ASSIGNMENT_DECLINED',
    actor: related('s1', 'Ayşe Personel'), details,
    createdAt: '2026-11-21T11:20:00.000Z',
  });

  it('parses the decision, the decline reason code and the Staff text', async () => {
    const decision = {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED',
      reasonCode: 'SCHEDULE_CONFLICT', reasonText: 'Önümüzdeki haftaya ziyaret sağlanacak',
      proposedScheduledAt: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [activity(decision)], total: 1, limit: 50, offset: 0,
    })));
    await expect(listActivity('job-1')).resolves.toMatchObject({ items: [{ details: decision }] });
  });

  it('parses the JOB-012 proposed time inside the decision', async () => {
    const decision = {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED',
      reasonCode: 'SCHEDULE_CONFLICT', reasonText: null,
      proposedScheduledAt: '2026-11-23T09:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [activity(decision)], total: 1, limit: 50, offset: 0,
    })));
    await expect(listActivity('job-1')).resolves.toMatchObject({
      items: [{ details: { proposedScheduledAt: '2026-11-23T09:00:00.000Z' } }],
    });
  });

  it('accepts a missing reason and a missing text as null', async () => {
    const decision = {
      kind: 'ASSIGNMENT_DECISION', decision: 'RELEASED', reasonCode: null, reasonText: null,
      proposedScheduledAt: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [activity(decision)], total: 1, limit: 50, offset: 0,
    })));
    await expect(listActivity('job-1')).resolves.toMatchObject({ items: [{ details: decision }] });
  });

  it.each([
    ['unknown decision', {
      kind: 'ASSIGNMENT_DECISION', decision: 'ACCEPTED', reasonCode: null, reasonText: null,
      proposedScheduledAt: null,
    }],
    ['unknown reason code', {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED',
      reasonCode: 'CUSTOMER_CHANGED_MIND', reasonText: null, proposedScheduledAt: null,
    }],
    ['extra key', {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED', reasonCode: null,
      reasonText: null, proposedScheduledAt: null, offerId: 'offer-1',
    }],
    ['missing reason text key', {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED', reasonCode: null,
      proposedScheduledAt: null,
    }],
    ['missing proposed time key', {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED', reasonCode: null, reasonText: null,
    }],
    ['non-canonical proposed time', {
      kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED', reasonCode: null, reasonText: null,
      proposedScheduledAt: '2026-11-23T09:00:00Z',
    }],
  ])('rejects a decision detail with %s', async (_name, details) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [activity(details)], total: 1, limit: 50, offset: 0,
    })));
    await expect(listActivity('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('decline and release transport', () => {
  it('posts the exact decline body to the job decline path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(jobCard({ status: 'NEW', version: 4 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(declineAssignment('job-1', {
      clientActionId: 'action-1',
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
    })).resolves.toMatchObject({ id: 'job-1' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/job-cards/job-1/decline?includeSaleCapability=true',
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-1',
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
    });
  });

  it('carries the JOB-012 proposed time only when one is supplied', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(jobCard({ status: 'NEW', version: 4 })))
      .mockResolvedValueOnce(json(jobCard({ status: 'NEW', version: 5 })));
    vi.stubGlobal('fetch', fetchMock);

    await declineAssignment('job-1', {
      clientActionId: 'action-1',
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
      proposedScheduledAt: '2026-11-23T09:00:00.000Z',
    });
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-1',
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
      proposedScheduledAt: '2026-11-23T09:00:00.000Z',
    });

    await releaseAssignment('job-1', {
      clientActionId: 'action-2',
      expectedVersion: 4,
      reasonCode: 'ON_LEAVE',
      reasonText: 'İzinliyim.',
    });
    expect(bodyOf(fetchMock.mock.calls[1]!)).not.toHaveProperty('proposedScheduledAt');
  });

  it('posts the exact release body to the job release path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(jobCard({ status: 'NEW', version: 5 })));
    vi.stubGlobal('fetch', fetchMock);

    await releaseAssignment('job-1', {
      clientActionId: 'action-2',
      expectedVersion: 4,
      reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
      reasonText: 'Eldiven stoğu kalmadı.',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/job-cards/job-1/release?includeSaleCapability=true',
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-2',
      expectedVersion: 4,
      reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
      reasonText: 'Eldiven stoğu kalmadı.',
    });
  });
});

describe('re-offer transport', () => {
  const receipt = {
    jobCardId: 'job-1',
    offerId: 'offer-2',
    acceptanceDueAt: '2026-11-21T12:10:00.000Z',
    urgentReason: null,
  };

  it('posts without the acknowledgement when it was not filled in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(receipt, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reofferAssignment('job-1', {
      clientActionId: 'action-3',
      expectedVersion: 3,
    })).resolves.toEqual(receipt);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/job-cards/job-1/assignment-offers/reoffer');
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-3',
      expectedVersion: 3,
    });
  });

  it('posts the acknowledgement only when the user filled it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ...receipt, urgentReason: 'START_PASSED' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await reofferAssignment('job-1', {
      clientActionId: 'action-4',
      expectedVersion: 3,
      ...pastStartAcknowledgementPayload({ code: 'CUSTOMER_WAITING', text: '  Müşteri bekliyor.  ' }),
    });

    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-4',
      expectedVersion: 3,
      pastStartAcknowledgement: { code: 'CUSTOMER_WAITING', text: 'Müşteri bekliyor.' },
    });
  });

  it('rejects a receipt outside the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...receipt, urgentReason: 'VERY_LATE',
    }, 201)));
    await expect(reofferAssignment('job-1', {
      clientActionId: 'action-5', expectedVersion: 3,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...receipt, jobCardId: 'job-2',
    }, 201)));
    await expect(reofferAssignment('job-1', {
      clientActionId: 'action-6', expectedVersion: 3,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...receipt, state: 'OPEN',
    }, 201)));
    await expect(reofferAssignment('job-1', {
      clientActionId: 'action-7', expectedVersion: 3,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('accept-proposal transport', () => {
  const receipt = {
    jobCardId: 'job-1',
    offerId: 'offer-1',
    scheduledAt: '2026-11-23T09:00:00.000Z',
    scheduledEndsAt: '2026-11-23T09:30:00.000Z',
  };

  it('posts the exact body to the accept-proposal path and parses the receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(receipt));
    vi.stubGlobal('fetch', fetchMock);

    await expect(acceptAssignmentProposal('job-1', {
      clientActionId: 'action-8',
      expectedVersion: 3,
      offerId: 'offer-1',
    })).resolves.toEqual(receipt);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/job-cards/job-1/assignment-offers/accept-proposal',
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      clientActionId: 'action-8',
      expectedVersion: 3,
      offerId: 'offer-1',
    });
  });

  it.each([
    ['a foreign job card', { ...receipt, jobCardId: 'job-2' }],
    ['a missing moved start', (() => {
      const { scheduledAt: _omitted, ...rest } = receipt;
      return rest;
    })()],
    ['a non-canonical interval end', { ...receipt, scheduledEndsAt: '2026-11-23T09:30:00Z' }],
    ['an extra key', { ...receipt, urgentReason: null }],
  ])('rejects a receipt with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(candidate)));
    await expect(acceptAssignmentProposal('job-1', {
      clientActionId: 'action-9', expectedVersion: 3, offerId: 'offer-1',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('past-start acknowledgement payload builder', () => {
  it('leaves the field out until the user actually fills it', () => {
    expect(pastStartAcknowledgementPayload(undefined)).toEqual({});
    expect(pastStartAcknowledgementPayload(null)).toEqual({});
    expect(pastStartAcknowledgementPayload({ code: 'OTHER', text: '   ' })).toEqual({});
  });

  it('trims and sends the filled acknowledgement', () => {
    expect(pastStartAcknowledgementPayload({ code: 'OTHER', text: '  Klinik 14:30 dedi. ' }))
      .toEqual({ pastStartAcknowledgement: { code: 'OTHER', text: 'Klinik 14:30 dedi.' } });
  });
});

describe('create and patch payloads carry the acknowledgement only when filled', () => {
  const acknowledgement = { code: 'CUSTOMER_CONFIRMED_LATER_TIME' as const, text: 'Klinik 15:30 dedi.' };

  it('adds the field to the product delivery create payload on request', async () => {
    const fetchMock = vi.fn(async () => json({ jobCardId: 'job-1', version: 1 }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await createProductDelivery({
      clientActionId: 'delivery-1',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      customerId: 'c1',
      assignedTo: 's1',
      scheduledAt: '2026-11-21T11:00:00.000Z',
      deliveryPurpose: 'SALE',
      items: [{ productId: 'p1', quantity: 2 }],
      ...pastStartAcknowledgementPayload(acknowledgement),
    });
    expect(bodyOf(fetchMock.mock.calls[0]!)).toMatchObject({
      pastStartAcknowledgement: acknowledgement,
    });

    await createProductDelivery({
      clientActionId: 'delivery-2',
      type: 'PRODUCT_DELIVERY',
      title: 'Klinik teslimi',
      customerId: 'c1',
      assignedTo: 's1',
      scheduledAt: '2026-11-21T11:00:00.000Z',
      deliveryPurpose: 'SALE',
      items: [{ productId: 'p1', quantity: 2 }],
      ...pastStartAcknowledgementPayload(undefined),
    });
    expect(bodyOf(fetchMock.mock.calls[1]!)).not.toHaveProperty('pastStartAcknowledgement');
  });

  it('adds the field to the meeting create, follow-up create and patch payloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(jobCard({ status: 'WAITING_APPROVAL' })))
      .mockResolvedValueOnce(json(jobCard()))
      .mockResolvedValueOnce(json(jobCard({ version: 4 })));
    vi.stubGlobal('fetch', fetchMock);

    await createJobCard({
      clientActionId: 'meeting-1',
      type: 'SALES_MEETING',
      title: 'Klinik görüşmesi',
      customerId: 'c1',
      assignedTo: 's1',
      scheduledAt: '2026-11-21T11:00:00.000Z',
      engagementKind: 'SALES_MEETING',
      ...pastStartAcknowledgementPayload(acknowledgement),
    });
    expect(bodyOf(fetchMock.mock.calls[0]!)).toMatchObject({ pastStartAcknowledgement: acknowledgement });

    await createFollowUp('job-1', {
      clientActionId: 'follow-up-1',
      type: 'PRODUCT_DELIVERY',
      title: 'Takip teslimi',
      followUpInstructions: 'Eldivenleri teslim et.',
      scheduledAt: '2026-11-21T11:00:00.000Z',
      assignedTo: 's1',
      priority: 'normal',
      dueDate: null,
      contactId: null,
      deliveryPurpose: 'SALE',
      items: [{ productId: 'product-1', quantity: 1 }],
      ...pastStartAcknowledgementPayload(acknowledgement),
    });
    expect(bodyOf(fetchMock.mock.calls[1]!)).toMatchObject({ pastStartAcknowledgement: acknowledgement });

    await patchJobCard('job-1', {
      expectedVersion: 3,
      assignedTo: 's2',
      ...pastStartAcknowledgementPayload(undefined),
    });
    expect(bodyOf(fetchMock.mock.calls[2]!)).not.toHaveProperty('pastStartAcknowledgement');
  });
});
