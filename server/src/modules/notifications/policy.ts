import type { JobCardActivityEvent } from '../job-cards/types.js';

import type { NotificationDraft } from './types.js';

type ManagementRecipient = Readonly<{
  id: string;
  role: 'ADMIN' | 'MANAGER';
  isActive: boolean;
}>;

type JobCardNotificationPolicyInput = Readonly<{
  event: JobCardActivityEvent;
  actorUserId: string | null;
  afterAssigneeId: string;
  jobCardId: string;
  managementRecipients: readonly ManagementRecipient[];
}>;

function draft(
  recipientUserId: string,
  kind: NotificationDraft['kind'],
  jobCardId: string,
): NotificationDraft {
  return { recipientUserId, kind, entityType: 'job-card', entityId: jobCardId };
}

function excludingActor(
  recipientUserIds: readonly string[],
  actorUserId: string | null,
): readonly string[] {
  return [...new Set(recipientUserIds)].filter((userId) => userId !== actorUserId);
}

export function createJobCardNotificationDrafts(
  input: JobCardNotificationPolicyInput,
): readonly NotificationDraft[] {
  const assignedKinds: Partial<Record<JobCardActivityEvent, NotificationDraft['kind']>> = {
    JOB_CREATED: 'job.assigned',
    JOB_ASSIGNED: 'job.reassigned',
    JOB_APPROVED: 'job.approved',
    JOB_REVISION_REQUESTED: 'job.revision_requested',
    JOB_CANCELLED: 'job.cancelled',
  };
  const kind = assignedKinds[input.event];
  if (kind) {
    return excludingActor([input.afterAssigneeId], input.actorUserId)
      .map((recipientUserId) => draft(recipientUserId, kind, input.jobCardId));
  }

  if (input.event !== 'JOB_SUBMITTED_FOR_APPROVAL') return [];
  return excludingActor(
    input.managementRecipients.filter((recipient) => recipient.isActive).map((recipient) => recipient.id),
    input.actorUserId,
  ).map((recipientUserId) => draft(recipientUserId, 'job.awaiting_approval', input.jobCardId));
}
