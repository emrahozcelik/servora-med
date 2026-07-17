import { AppError } from '../../errors/index.js';
import type { SubmissionReader } from './repository.js';
import {
  DELIVERY_PURPOSES,
  MEETING_OUTCOMES,
  type JobCard,
  type JobCardActor,
  type MeetingDetailField,
  type SubmissionReadiness,
  type SubmissionRequirement,
} from './types.js';

export type SubmissionEvaluation = {
  readiness: SubmissionReadiness;
  failure: AppError | null;
};

function readiness(
  evaluatedAt: Date,
  items: SubmissionRequirement[],
  failure: AppError | null,
): SubmissionEvaluation {
  return {
    readiness: {
      evaluatedAt: evaluatedAt.toISOString(),
      ready: items.every((item) => item.state === 'met'),
      items,
    },
    failure,
  };
}

function assigneeFailure(assigneeRequirement: SubmissionRequirement): AppError | null {
  if (assigneeRequirement.state === 'met') return null;
  return new AppError(
    'ASSIGNEE_NOT_ELIGIBLE',
    400,
    'Atanan personel aktif ve uygun olmalıdır.',
  );
}

async function evaluateDelivery(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  evaluatedAt: Date,
  assigneeRequirement: SubmissionRequirement,
): Promise<SubmissionEvaluation> {
  const customer = jobCard.customerId === null ? null
    : await reader.getSubmissionCustomer(actor.organizationId, jobCard.customerId);
  const customerState = jobCard.customerId === null ? 'missing'
    : !customer || customer.organizationId !== actor.organizationId
      || customer.status === 'inactive' ? 'invalid' : 'met';
  const deliveryItems = await reader.getSubmissionDeliveryItems(
    actor.organizationId,
    jobCard.id,
  );
  const deliveryItemsValid = deliveryItems.length > 0 && deliveryItems.every((item) =>
    Boolean(item.productId)
    && DELIVERY_PURPOSES.includes(item.deliveryPurpose)
    && item.deliveredAt instanceof Date
    && !Number.isNaN(item.deliveredAt.valueOf())
    && Number.isFinite(item.quantity)
    && item.quantity > 0);
  const items: SubmissionRequirement[] = [
    { code: 'CUSTOMER_ELIGIBLE', state: customerState, field: 'customerId' },
    assigneeRequirement,
    { code: 'DELIVERY_ITEM_PRESENT', state: deliveryItems.length ? 'met' : 'missing',
      field: 'deliveryItems' },
    { code: 'DELIVERY_ITEMS_VALID', state: deliveryItems.length === 0 ? 'missing'
      : deliveryItemsValid ? 'met' : 'invalid', field: 'deliveryItems' },
  ];
  const failure = customerState !== 'met'
    ? new AppError('DELIVERY_NOT_READY', 400,
      'Ürün teslimi için geçerli müşteri zorunludur.')
    : assigneeFailure(assigneeRequirement)
      ?? (!deliveryItemsValid
        ? new AppError('DELIVERY_NOT_READY', 400,
          'Ürün teslimi onaya gönderilmek için gerekli bilgileri içermiyor.')
        : null);
  return readiness(evaluatedAt, items, failure);
}

async function evaluateMeeting(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  evaluatedAt: Date,
  assigneeRequirement: SubmissionRequirement,
): Promise<SubmissionEvaluation> {
  const customer = jobCard.customerId === null ? null
    : await reader.getSubmissionCustomer(actor.organizationId, jobCard.customerId);
  const customerRequirement: SubmissionRequirement = {
    code: 'CUSTOMER_ELIGIBLE',
    state: jobCard.customerId === null ? 'missing'
      : !customer || customer.organizationId !== actor.organizationId
        || customer.status === 'inactive' ? 'invalid' : 'met',
    field: 'customerId',
  };
  const details = await reader.getSubmissionMeetingDetails(
    actor.organizationId,
    jobCard.id,
  );
  const meetingAt = details?.meetingAt ? new Date(details.meetingAt) : null;
  const meetingAtValid = meetingAt !== null && !Number.isNaN(meetingAt.valueOf())
    && meetingAt.valueOf() <= evaluatedAt.valueOf() + 15 * 60_000;
  const outcomeValid = details?.outcome !== null
    && details?.outcome !== undefined
    && MEETING_OUTCOMES.includes(details.outcome);
  const summaryPresent = Boolean(details?.meetingSummary?.trim());
  const followUpValid = details?.nextFollowUpAt === null
    || (meetingAt !== null
      && !Number.isNaN(new Date(details!.nextFollowUpAt!).valueOf())
      && new Date(details!.nextFollowUpAt!).valueOf() > meetingAt.valueOf());

  const items: SubmissionRequirement[] = [
    customerRequirement,
    assigneeRequirement,
    { code: 'MEETING_TIME_VALID', state: details?.meetingAt === null || !details
      ? 'missing' : meetingAtValid ? 'met' : 'invalid', field: 'meetingAt' },
    { code: 'MEETING_OUTCOME_VALID', state: details?.outcome === null || !details
      ? 'missing' : outcomeValid ? 'met' : 'invalid', field: 'outcome' },
    { code: 'MEETING_SUMMARY_PRESENT', state: summaryPresent ? 'met' : 'missing',
      field: 'meetingSummary' },
    { code: 'FOLLOW_UP_TIME_VALID', state: followUpValid ? 'met' : 'invalid',
      field: 'nextFollowUpAt' },
  ];

  let failure: AppError | null = null;
  if (
    jobCard.customerId === null
    || !customer
    || customer.organizationId !== actor.organizationId
  ) {
    failure = new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
  } else if (customer.status === 'inactive') {
    failure = new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteri onaya gönderilemez.');
  } else if (assigneeRequirement.state !== 'met') {
    failure = assigneeFailure(assigneeRequirement);
  } else if (!details) {
    failure = new AppError(
      'INVARIANT_VIOLATION',
      500,
      'İş kaydının yapılandırılmış görüşme bilgileri bulunamadı.',
    );
  } else {
    const fieldErrors: Partial<Record<MeetingDetailField, string>> = {};
    if (meetingAt === null || Number.isNaN(meetingAt.valueOf())) {
      fieldErrors.meetingAt = 'Gerçekleşen görüşme zamanı zorunludur.';
    } else if (meetingAt.valueOf() > evaluatedAt.valueOf() + 15 * 60_000) {
      fieldErrors.meetingAt = 'Görüşme zamanı izin verilen gelecek toleransını aşıyor.';
    }
    if (details.outcome === null || !MEETING_OUTCOMES.includes(details.outcome)) {
      fieldErrors.outcome = 'Görüşme sonucu zorunludur.';
    }
    if (details.meetingSummary === null || !details.meetingSummary.trim()) {
      fieldErrors.meetingSummary = 'Görüşme özeti zorunludur.';
    }
    if (details.nextFollowUpAt !== null) {
      const followUp = new Date(details.nextFollowUpAt);
      if (meetingAt === null || Number.isNaN(followUp.valueOf())
        || followUp.valueOf() <= meetingAt.valueOf()) {
        fieldErrors.nextFollowUpAt = 'Takip zamanı görüşme zamanından sonra olmalıdır.';
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      failure = new AppError(
        'MEETING_NOT_READY',
        400,
        'Satış görüşmesi yapılandırılmış sonuç bilgileri tamamlanmalıdır.',
        { fieldErrors },
      );
    }
  }

  return readiness(evaluatedAt, items, failure);
}

export async function evaluateSubmission(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  evaluatedAt: Date,
): Promise<SubmissionEvaluation> {
  const assignee = await reader.getAssignee(actor.organizationId, jobCard.assignedTo);
  const assigneeRequirement: SubmissionRequirement = {
    code: 'ASSIGNEE_ELIGIBLE',
    state: assignee && assignee.organizationId === actor.organizationId
      && assignee.isActive && assignee.role === 'STAFF' ? 'met' : 'invalid',
    field: 'assignedTo',
  };
  if (jobCard.type === 'GENERAL_TASK') {
    const titleLength = Array.from(jobCard.title.trim()).length;
    const items: SubmissionRequirement[] = [
      { code: 'TASK_TITLE_VALID', state: titleLength < 1 ? 'missing'
        : titleLength > 255 ? 'invalid' : 'met', field: 'title' },
      assigneeRequirement,
    ];
    const failure = items[0]!.state !== 'met'
      ? new AppError('VALIDATION_ERROR', 400, 'JobCard başlığı geçersiz.')
      : assigneeRequirement.state !== 'met'
        ? new AppError('ASSIGNEE_NOT_ELIGIBLE', 400, 'Atanan personel aktif ve uygun olmalıdır.')
        : null;
    return readiness(evaluatedAt, items, failure);
  }
  return jobCard.type === 'PRODUCT_DELIVERY'
    ? evaluateDelivery(reader, actor, jobCard, evaluatedAt, assigneeRequirement)
    : evaluateMeeting(reader, actor, jobCard, evaluatedAt, assigneeRequirement);
}

export function assertSubmissionReady(evaluation: SubmissionEvaluation) {
  if (evaluation.failure) throw evaluation.failure;
}

export async function validateSubmission(
  reader: SubmissionReader,
  actor: JobCardActor,
  jobCard: JobCard,
  requestTime: Date,
) {
  const evaluation = await evaluateSubmission(reader, actor, jobCard, requestTime);
  assertSubmissionReady(evaluation);
  return evaluation;
}
