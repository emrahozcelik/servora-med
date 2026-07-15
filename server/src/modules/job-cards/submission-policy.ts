import { AppError } from '../../errors/index.js';
import { assertDeliveryReadyForSubmission } from './policy.js';
import type { JobCardTransaction } from './repository.js';
import type { JobCard, JobCardActor, JobCardType } from './types.js';

export type SubmissionPolicy = (
  transaction: JobCardTransaction,
  actor: JobCardActor,
  jobCard: JobCard,
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

const validateSalesMeetingSubmission: SubmissionPolicy = async () => {
  throw new AppError(
    'MEETING_NOT_READY',
    400,
    'Satış görüşmesi yapılandırılmış sonuç bilgileri tamamlanmalıdır.',
  );
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
) {
  return submissionPolicies[jobCard.type](transaction, actor, jobCard);
}
