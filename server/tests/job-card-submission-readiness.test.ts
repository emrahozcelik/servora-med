import { describe, expect, it } from 'vitest';

import type {
  SubmissionDeliveryItem,
  SubmissionReader,
  SubmissionCustomer,
} from '../src/modules/job-cards/repository.js';
import {
  assertSubmissionReady,
  evaluateSubmission,
} from '../src/modules/job-cards/submission-policy.js';
import type {
  JobCard,
  JobCardActor,
  JobCardAssignee,
  MeetingDetailsCandidate,
} from '../src/modules/job-cards/types.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const assignee: JobCardAssignee = {
  id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true,
};
const now = new Date('2026-07-17T12:00:00.000Z');

const deliveryJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
  version: 2, title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
};

const meetingJob: JobCard = {
  ...deliveryJob,
  type: 'SALES_MEETING',
  title: 'Kontrol görüşmesi',
  dueDate: '2026-07-15',
};

const defaultCustomer: SubmissionCustomer = {
  id: 'customer-1', organizationId: 'org-1', status: 'active',
};

const defaultMeetingDetails: MeetingDetailsCandidate = {
  meetingAt: '2026-07-13T12:00:00.000Z',
  outcome: 'POSITIVE',
  meetingSummary: 'Görüşme tamamlandı.',
  nextFollowUpAt: null,
};

const defaultItems: SubmissionDeliveryItem[] = [{
  id: 'item-1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'product-1',
  deliveryPurpose: 'SALE', deliveredAt: new Date(), quantity: 2, unit: 'adet',
  productNameSnapshot: 'Set', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
}];

function reader(overrides: {
  customer?: SubmissionCustomer | null;
  assignee?: JobCardAssignee | null;
  items?: SubmissionDeliveryItem[];
  meetingDetails?: MeetingDetailsCandidate | null;
} = {}): SubmissionReader {
  const customer = 'customer' in overrides ? overrides.customer! : defaultCustomer;
  const resolvedAssignee = 'assignee' in overrides ? overrides.assignee! : assignee;
  const items = overrides.items ?? defaultItems;
  const meetingDetails = 'meetingDetails' in overrides
    ? overrides.meetingDetails!
    : defaultMeetingDetails;

  return {
    getAssignee: async () => resolvedAssignee,
    getSubmissionCustomer: async () => customer,
    getSubmissionMeetingDetails: async () => meetingDetails,
    getSubmissionDeliveryItems: async () => items,
  };
}

describe('structured submission readiness', () => {
  it('evaluates product delivery requirements in stable order', async () => {
    const evaluation = await evaluateSubmission(reader({
      customer: null,
      assignee: { ...assignee, isActive: false },
      items: [],
    }), staff, deliveryJob, now);
    expect(evaluation.readiness).toEqual({
      evaluatedAt: now.toISOString(),
      ready: false,
      items: [
        { code: 'CUSTOMER_ELIGIBLE', state: 'invalid', field: 'customerId' },
        { code: 'ASSIGNEE_ELIGIBLE', state: 'invalid', field: 'assignedTo' },
        { code: 'DELIVERY_ITEM_PRESENT', state: 'missing', field: 'deliveryItems' },
        { code: 'DELIVERY_ITEMS_VALID', state: 'missing', field: 'deliveryItems' },
      ],
    });
  });

  it('uses one Sales Meeting evaluation for checklist and exact submit error', async () => {
    const evaluation = await evaluateSubmission(reader({
      meetingDetails: {
        meetingAt: null, outcome: null, meetingSummary: ' ', nextFollowUpAt: null,
      },
    }), staff, meetingJob, now);
    expect(evaluation.readiness.items).toEqual(expect.arrayContaining([
      { code: 'MEETING_TIME_VALID', state: 'missing', field: 'meetingAt' },
      { code: 'MEETING_OUTCOME_VALID', state: 'missing', field: 'outcome' },
      { code: 'MEETING_SUMMARY_PRESENT', state: 'missing', field: 'meetingSummary' },
      { code: 'FOLLOW_UP_TIME_VALID', state: 'met', field: 'nextFollowUpAt' },
    ]));
    expect(() => assertSubmissionReady(evaluation)).toThrowError(expect.objectContaining({
      code: 'MEETING_NOT_READY',
      details: { fieldErrors: {
        meetingAt: 'Gerçekleşen görüşme zamanı zorunludur.',
        outcome: 'Görüşme sonucu zorunludur.',
        meetingSummary: 'Görüşme özeti zorunludur.',
      } },
    }));
  });

  it('evaluates meeting time against the single supplied instant', async () => {
    const evaluation = await evaluateSubmission(reader({
      meetingDetails: {
        meetingAt: '2026-07-17T12:16:00.000Z', outcome: 'POSITIVE',
        meetingSummary: 'Tamamlandı', nextFollowUpAt: null,
      },
    }), staff, meetingJob, new Date('2026-07-17T12:00:00.000Z'));
    expect(evaluation.readiness.items).toContainEqual({
      code: 'MEETING_TIME_VALID', state: 'invalid', field: 'meetingAt',
    });
  });

  it('reports DELIVERY_ITEMS_VALID invalid when a planned item has null deliveredAt', async () => {
    const evaluation = await evaluateSubmission(reader({
      items: [{ ...defaultItems[0]!, deliveredAt: null }],
    }), staff, deliveryJob, now);

    expect(evaluation.readiness.ready).toBe(false);
    expect(evaluation.readiness.items).toContainEqual({
      code: 'DELIVERY_ITEM_PRESENT', state: 'met', field: 'deliveryItems',
    });
    expect(evaluation.readiness.items).toContainEqual({
      code: 'DELIVERY_ITEMS_VALID', state: 'invalid', field: 'deliveryItems',
    });
    expect(() => assertSubmissionReady(evaluation)).toThrowError(expect.objectContaining({
      code: 'DELIVERY_NOT_READY',
    }));
  });

  it('reports DELIVERY_ITEMS_VALID met only after every item has a real deliveredAt', async () => {
    const evaluation = await evaluateSubmission(reader({
      items: [{
        ...defaultItems[0]!,
        deliveredAt: new Date('2026-07-14T08:00:00.000Z'),
      }],
    }), staff, deliveryJob, now);

    expect(evaluation.readiness.ready).toBe(true);
    expect(evaluation.readiness.items).toContainEqual({
      code: 'DELIVERY_ITEMS_VALID', state: 'met', field: 'deliveryItems',
    });
  });
});
