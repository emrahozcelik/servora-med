import { AppError } from '../../errors/index.js';
import { assertDeliveryReadyForSubmission } from './policy.js';
import type { JobCardTransaction } from './repository.js';
import {
  MEETING_OUTCOMES,
  type JobCard,
  type JobCardActor,
  type JobCardType,
  type MeetingDetailField,
} from './types.js';

export type SubmissionPolicy = (
  transaction: JobCardTransaction,
  actor: JobCardActor,
  jobCard: JobCard,
  requestTime: Date,
) => Promise<void>;

async function assertEligibleAssignee(
  transaction: JobCardTransaction,
  actor: JobCardActor,
  jobCard: JobCard,
) {
  const assignee = await transaction.getAssignee(actor.organizationId, jobCard.assignedTo);
  if (
    !assignee ||
    assignee.organizationId !== actor.organizationId ||
    !assignee.isActive ||
    assignee.role !== 'STAFF'
  ) {
    throw new AppError(
      'ASSIGNEE_NOT_ELIGIBLE',
      400,
      'Atanan personel aktif ve uygun olmalıdır.',
    );
  }
}

const validateProductDeliverySubmission: SubmissionPolicy = async (
  transaction,
  actor,
  jobCard,
) => {
  if (
    !jobCard.customerId ||
    !(await transaction.customerExists(actor.organizationId, jobCard.customerId))
  ) {
    throw new AppError(
      'DELIVERY_NOT_READY',
      400,
      'Ürün teslimi için geçerli müşteri zorunludur.',
    );
  }
  await assertEligibleAssignee(transaction, actor, jobCard);
  assertDeliveryReadyForSubmission(
    jobCard,
    await transaction.getSubmissionDeliveryItems(actor.organizationId, jobCard.id),
  );
};

const validateGeneralTaskSubmission: SubmissionPolicy = async (transaction, actor, jobCard) => {
  const titleLength = Array.from(jobCard.title.trim()).length;
  if (titleLength < 1 || titleLength > 255) {
    throw new AppError('VALIDATION_ERROR', 400, 'JobCard başlığı geçersiz.');
  }
  await assertEligibleAssignee(transaction, actor, jobCard);
};

const validateSalesMeetingSubmission: SubmissionPolicy = async (
  transaction,
  actor,
  jobCard,
  requestTime,
) => {
  if (!jobCard.customerId) {
    throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
  }
  const customer = await transaction.getSubmissionCustomer(
    actor.organizationId,
    jobCard.customerId,
  );
  if (!customer || customer.organizationId !== actor.organizationId) {
    throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
  }
  if (customer.status === 'inactive') {
    throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteri onaya gönderilemez.');
  }
  await assertEligibleAssignee(transaction, actor, jobCard);
  const details = await transaction.getMeetingDetailsForUpdate(
    actor.organizationId,
    jobCard.id,
  );
  if (!details) {
    throw new AppError(
      'INVARIANT_VIOLATION',
      500,
      'İş kaydının yapılandırılmış görüşme bilgileri bulunamadı.',
    );
  }

  const fieldErrors: Partial<Record<MeetingDetailField, string>> = {};
  const meetingAt = details.meetingAt === null ? null : new Date(details.meetingAt);
  if (meetingAt === null || Number.isNaN(meetingAt.valueOf())) {
    fieldErrors.meetingAt = 'Gerçekleşen görüşme zamanı zorunludur.';
  } else if (meetingAt.valueOf() > requestTime.valueOf() + 15 * 60 * 1_000) {
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
    throw new AppError(
      'MEETING_NOT_READY',
      400,
      'Satış görüşmesi yapılandırılmış sonuç bilgileri tamamlanmalıdır.',
      { fieldErrors },
    );
  }
};

const submissionPolicies: Record<JobCardType, SubmissionPolicy> = {
  PRODUCT_DELIVERY: validateProductDeliverySubmission,
  GENERAL_TASK: validateGeneralTaskSubmission,
  SALES_MEETING: validateSalesMeetingSubmission,
};

export function validateSubmission(
  transaction: JobCardTransaction,
  actor: JobCardActor,
  jobCard: JobCard,
  requestTime: Date,
) {
  return submissionPolicies[jobCard.type](transaction, actor, jobCard, requestTime);
}
