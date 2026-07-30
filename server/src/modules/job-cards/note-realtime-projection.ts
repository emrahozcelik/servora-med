import type { JobCardTransaction, AppendedActivity } from './repository.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import { createNoteAddedNotificationDrafts } from '../notifications/policy.js';

type StandaloneNoteProjectionInput = Readonly<{
  organizationId: string;
  jobCardId: string;
  actorId: string;
  assigneeId: string;
  activity: AppendedActivity;
}>;

/**
 * Append a bodyless realtime event and in-app notifications for a standalone
 * GENERAL note within the current transaction. Web Push is explicitly NOT
 * created — this is a product policy, not an environment toggle.
 */
export async function appendStandaloneNoteProjection(
  tx: JobCardTransaction,
  input: StandaloneNoteProjectionInput,
): Promise<RealtimeEventRecord> {
  const audience = {
    roles: ['ADMIN', 'MANAGER'] as const,
    userIds: [input.assigneeId],
  };

  const resourceKeys = [
    `job-detail:${input.jobCardId}`,
    `job-notes:${input.jobCardId}`,
    'job-board',
    'job-list',
    'reports',
    'overview',
    `staff-profile:${input.assigneeId}`,
  ].sort();

  const realtimeEvent = await tx.appendRealtimeEvent({
    organizationId: input.organizationId,
    sourceActivityId: input.activity.id,
    type: 'job.updated',
    entityType: 'job-card',
    entityId: input.jobCardId,
    actorUserId: input.actorId,
    audience,
    resourceKeys,
    occurredAt: input.activity.createdAt,
  });

  const managementRecipients = await tx.listActiveManagementRecipients(
    input.organizationId,
  );

  const drafts = createNoteAddedNotificationDrafts({
    actorUserId: input.actorId,
    assigneeId: input.assigneeId,
    jobCardId: input.jobCardId,
    managementRecipients,
  });

  if (drafts.length > 0) {
    await tx.appendNotifications({
      organizationId: input.organizationId,
      sourceRealtimeEventId: realtimeEvent.id,
      createdAt: input.activity.createdAt,
      drafts,
    });
    // Web Push is explicitly NOT created for standalone notes.
  }

  return realtimeEvent;
}
