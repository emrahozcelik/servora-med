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
  // Resolve notification recipients before creating the realtime event so
  // we can conditionally include the "notifications" resource key.
  const managementRecipients = await tx.listActiveManagementRecipients(
    input.organizationId,
  );
  const assignee = await tx.getAssignee(input.organizationId, input.assigneeId);
  const assigneeActive = assignee?.isActive === true;

  const drafts = createNoteAddedNotificationDrafts({
    actorUserId: input.actorId,
    assigneeId: assigneeActive ? input.assigneeId : input.actorId,
    jobCardId: input.jobCardId,
    managementRecipients,
  });

  // Build resource keys. The keys are a deterministic set for every
  // standalone-note event so consumers can rely on them; the "notifications"
  // key is included even when actor exclusion leaves no eligible draft (a
  // client refetch is harmless and returns the unchanged canonical state).
  const resourceKeys = [
    `job-notes:${input.jobCardId}`,
    'notifications',
    `staff-profile:${input.assigneeId}`,
  ];

  // Build audience. Admin/Manager roles always see job-card events.
  // Include the assignee user ID only when the assignee is active.
  const audienceUserIds = assigneeActive ? [input.assigneeId] : ([] as string[]);

  const realtimeEvent = await tx.appendRealtimeEvent({
    organizationId: input.organizationId,
    sourceActivityId: input.activity.id,
    type: 'job.updated',
    entityType: 'job-card',
    entityId: input.jobCardId,
    actorUserId: input.actorId,
    audience: {
      roles: ['ADMIN', 'MANAGER'] as const,
      userIds: audienceUserIds,
    },
    resourceKeys: [...resourceKeys].sort(),
    occurredAt: input.activity.createdAt,
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
