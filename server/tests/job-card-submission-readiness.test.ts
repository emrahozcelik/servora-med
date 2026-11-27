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
  JobCardStatus,
  JobCardType,
  MeetingDetailsCandidate,
  SubmissionRequirement,
} from '../src/modules/job-cards/types.js';
import { JOB_CARD_TYPES } from '../src/modules/job-cards/types.js';

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
  unsuccessfulReason: null,
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
    getSubmissionSale: async () => null,
    getOrganizationTimezone: async () => 'Europe/Istanbul',
    getWeeklyReportByJobId: async () => null,
    listWeeklySourceWorkSnapshot: async () => [],
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

  it('requires a structured unsuccessful reason when follow-up is required', async () => {
    const missing = await evaluateSubmission(reader({
      meetingDetails: {
        ...defaultMeetingDetails,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: null,
      },
    }), staff, meetingJob, now);
    expect(missing.readiness.items).toContainEqual({
      code: 'UNSUCCESSFUL_REASON_PRESENT', state: 'missing', field: 'unsuccessfulReason',
    });
    expect(() => assertSubmissionReady(missing)).toThrowError(expect.objectContaining({
      code: 'MEETING_NOT_READY',
      details: { fieldErrors: { unsuccessfulReason: expect.any(String) } },
    }));

    const valid = await evaluateSubmission(reader({
      meetingDetails: {
        ...defaultMeetingDetails,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'CONTACT_BUSY',
      },
    }), staff, meetingJob, now);
    expect(valid.readiness.items).toContainEqual({
      code: 'UNSUCCESSFUL_REASON_PRESENT', state: 'met', field: 'unsuccessfulReason',
    });
    expect(valid.failure).toBeNull();
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

  it('accepts a not-held visit with FOLLOW_UP_REQUIRED, a reason and no meeting time', async () => {
    // JOB-010 release 2a (D1 §4): a visit that did not take place is submitted
    // truthfully; no meeting time is ever fabricated.
    const notHeld = await evaluateSubmission(reader({
      meetingDetails: {
        meetingAt: null,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
        meetingSummary: 'Klinikte ilgili kişi yoktu, yeniden ziyaret gerekiyor.',
        nextFollowUpAt: null,
      },
    }), staff, meetingJob, now);
    expect(notHeld.readiness.items).toContainEqual({
      code: 'MEETING_TIME_VALID', state: 'met', field: 'meetingAt',
    });
    expect(notHeld.readiness.items).toContainEqual({
      code: 'UNSUCCESSFUL_REASON_PRESENT', state: 'met', field: 'unsuccessfulReason',
    });
    expect(notHeld.readiness.ready).toBe(true);
    expect(notHeld.failure).toBeNull();

    // Without the structured reason the empty time stays unprovable.
    const noReason = await evaluateSubmission(reader({
      meetingDetails: {
        meetingAt: null,
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: null,
        meetingSummary: 'Klinikte kimse yoktu.',
        nextFollowUpAt: null,
      },
    }), staff, meetingJob, now);
    expect(noReason.readiness.items).toContainEqual({
      code: 'MEETING_TIME_VALID', state: 'missing', field: 'meetingAt',
    });
    expect(() => assertSubmissionReady(noReason)).toThrowError(expect.objectContaining({
      code: 'MEETING_NOT_READY',
      details: { fieldErrors: {
        meetingAt: 'Gerçekleşen görüşme zamanı zorunludur.',
        unsuccessfulReason: 'Takip gereken başarısız görüşme nedeni zorunludur.',
      } },
    }));

    // Every other outcome still requires the real meeting time.
    const otherOutcome = await evaluateSubmission(reader({
      meetingDetails: {
        meetingAt: null,
        outcome: 'POSITIVE',
        unsuccessfulReason: null,
        meetingSummary: 'Görüşme olumlu geçti.',
        nextFollowUpAt: null,
      },
    }), staff, meetingJob, now);
    expect(otherOutcome.readiness.items).toContainEqual({
      code: 'MEETING_TIME_VALID', state: 'missing', field: 'meetingAt',
    });
  });

  /**
   * Exhaustiveness characterization: every JobCard type has its own
   * evaluation. Pinning the whole per-type table proves the refactor is
   * behaviour-neutral and that a new type can never silently be evaluated as
   * a sales meeting.
   */
  it('pins the per-type submission evaluation for every type and non-terminal status', async () => {
    const nonTerminalStatuses = [
      'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
    ] as const satisfies readonly JobCardStatus[];
    const expected: Record<JobCardType, {
      ready: boolean;
      failureCode: string | null;
      items: SubmissionRequirement[];
    }> = {
      PRODUCT_DELIVERY: {
        ready: true,
        failureCode: null,
        items: [
          { code: 'CUSTOMER_ELIGIBLE', state: 'met', field: 'customerId' },
          { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
          { code: 'DELIVERY_ITEM_PRESENT', state: 'met', field: 'deliveryItems' },
          { code: 'DELIVERY_ITEMS_VALID', state: 'met', field: 'deliveryItems' },
        ],
      },
      GENERAL_TASK: {
        ready: true,
        failureCode: null,
        items: [
          { code: 'TASK_TITLE_VALID', state: 'met', field: 'title' },
          { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
        ],
      },
      SALES_MEETING: {
        ready: true,
        failureCode: null,
        items: [
          { code: 'CUSTOMER_ELIGIBLE', state: 'met', field: 'customerId' },
          { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
          { code: 'MEETING_TIME_VALID', state: 'met', field: 'meetingAt' },
          { code: 'MEETING_OUTCOME_VALID', state: 'met', field: 'outcome' },
          { code: 'MEETING_SUMMARY_PRESENT', state: 'met', field: 'meetingSummary' },
          { code: 'FOLLOW_UP_TIME_VALID', state: 'met', field: 'nextFollowUpAt' },
        ],
      },
      WEEKLY_REPORT: {
        ready: false,
        failureCode: 'WEEKLY_REPORT_NOT_FOUND',
        items: [
          { code: 'WEEKLY_REPORT_FOUND', state: 'missing', field: 'weeklyReport' },
          { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
          { code: 'WEEKLY_DRAFT_VALID', state: 'missing', field: 'draft' },
          { code: 'WEEKLY_ANSWERS_COMPLETE', state: 'missing', field: 'managerAnswers' },
          { code: 'WEEKLY_SOURCE_WORK_READY', state: 'missing', field: 'sourceWork' },
        ],
      },
      SALE: {
        ready: false,
        failureCode: 'SALE_NOT_READY',
        items: [
          { code: 'CUSTOMER_ELIGIBLE', state: 'met', field: 'customerId' },
          { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
          { code: 'SALE_ORIGIN_VALID', state: 'invalid', field: 'saleOrigin' },
          { code: 'SALE_TIME_VALID', state: 'invalid', field: 'soldAt' },
          { code: 'SALE_ITEM_PRESENT', state: 'missing', field: 'saleItems' },
          { code: 'SALE_ITEMS_VALID', state: 'missing', field: 'saleItems' },
        ],
      },
    };

    expect(Object.keys(expected).sort()).toEqual([...JOB_CARD_TYPES].sort());

    for (const type of JOB_CARD_TYPES) {
      for (const status of nonTerminalStatuses) {
        const evaluation = await evaluateSubmission(
          reader(),
          staff,
          { ...deliveryJob, type, status },
          now,
        );
        expect(evaluation.readiness).toEqual({
          evaluatedAt: now.toISOString(),
          ready: expected[type].ready,
          items: expected[type].items,
        });
        expect(evaluation.failure?.code ?? null).toBe(expected[type].failureCode);
      }
    }
  });
});
