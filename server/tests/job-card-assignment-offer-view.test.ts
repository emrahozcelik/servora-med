import { describe, expect, it } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobAssignmentOfferRecord,
  JobCardActor,
  PersistedJobCardDetail,
} from '../src/modules/job-cards/types.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };

function detailWithOffer(offer: JobAssignmentOfferRecord | null): PersistedJobCardDetail {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
    title: 'İmplant seti teslimi', description: null,
    customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
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
    assignee: { id: 'staff-1', name: 'Saha Personeli' },
    customer: { id: 'customer-1', name: 'Demo Dental Klinik' },
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
    assignmentOffer: offer,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
  };
}

const offerBase: JobAssignmentOfferRecord = {
  id: 'offer-1',
  state: 'OPEN',
  openedAt: new Date('2026-11-24T09:00:00.000Z'),
  openedReason: 'DIRECT',
  acceptanceDueAt: new Date('2026-11-24T10:10:00.000Z'),
  urgentReason: null,
  assigneeUserId: 'staff-1',
  assigneeId: 'staff-1',
  assigneeName: 'Saha Personeli',
  closedAt: null,
  closeReason: null,
  closeText: null,
};

const declinedOffer: JobAssignmentOfferRecord = {
  ...offerBase,
  state: 'DECLINED',
  acceptanceDueAt: new Date('2026-11-24T09:10:00.000Z'),
  closedAt: new Date('2026-11-24T09:05:00.000Z'),
  closeReason: 'SCHEDULE_CONFLICT',
  closeText: 'Aynı saatte başka bir klinik teslimi var.',
};

function serviceWith(job: PersistedJobCardDetail): JobCardService {
  return new JobCardService(
    { findJobCardDetail: async () => job } as never,
    () => NOW,
    undefined,
    { enabled: false },
    undefined,
    undefined,
    undefined,
    { enabled: true },
  );
}

describe('JobCard detail assignment offer projection', () => {
  it('carries the persisted close reason and text of a declined offer', async () => {
    const result = await serviceWith(detailWithOffer(declinedOffer)).detail(staff, 'job-1');

    expect(result.assignmentOffer).toEqual({
      id: 'offer-1',
      state: 'DECLINED',
      acceptanceDueAt: '2026-11-24T09:10:00.000Z',
      openedAt: '2026-11-24T09:00:00.000Z',
      urgentReason: null,
      assignee: { id: 'staff-1', name: 'Saha Personeli' },
      closedAt: '2026-11-24T09:05:00.000Z',
      closeReason: 'SCHEDULE_CONFLICT',
      closeText: 'Aynı saatte başka bir klinik teslimi var.',
    });
  });

  it('presents an overdue OPEN offer as EXPIRED without a close fact', async () => {
    const result = await serviceWith(detailWithOffer({
      ...offerBase,
      acceptanceDueAt: new Date('2026-11-24T09:59:59.000Z'),
    })).detail(staff, 'job-1');

    expect(result.assignmentOffer).toEqual({
      id: 'offer-1',
      state: 'EXPIRED',
      acceptanceDueAt: '2026-11-24T09:59:59.000Z',
      openedAt: '2026-11-24T09:00:00.000Z',
      urgentReason: null,
      assignee: { id: 'staff-1', name: 'Saha Personeli' },
      closedAt: null,
      closeReason: null,
      closeText: null,
    });
  });

  it('leaves the close fact null on a live OPEN offer', async () => {
    const result = await serviceWith(detailWithOffer(offerBase)).detail(staff, 'job-1');

    expect(result.assignmentOffer).toEqual({
      id: 'offer-1',
      state: 'OPEN',
      acceptanceDueAt: '2026-11-24T10:10:00.000Z',
      openedAt: '2026-11-24T09:00:00.000Z',
      urgentReason: null,
      assignee: { id: 'staff-1', name: 'Saha Personeli' },
      closedAt: null,
      closeReason: null,
      closeText: null,
    });
  });
});
