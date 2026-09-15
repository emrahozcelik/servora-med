import type { UserRole } from '../auth/types.js';

export const REALTIME_EVENT_TYPES = [
  'job.created',
  'job.assignment_changed',
  'job.accepted',
  'job.started',
  'job.submitted_for_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
  'job.invalidated',
  'job.updated',
  'calendar.created',
  'calendar.updated',
  'calendar.cancelled',
  'calendar.reminder_due',
  'conversation.created',
  'message.sent',
  'conversation.participants_changed',
  'confidential-note.created',
  'notification.state_changed',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];
export type RealtimeAudienceRole = Extract<UserRole, 'ADMIN' | 'MANAGER'>;

export const REALTIME_ENTITY_TYPES = [
  'job-card',
  'calendar-event',
  'conversation',
  'confidential-note',
  'notification-center',
] as const;

export type RealtimeEntityType = (typeof REALTIME_ENTITY_TYPES)[number];

export type RealtimeAudience = Readonly<{
  roles: readonly RealtimeAudienceRole[];
  userIds: readonly string[];
}>;

export type RealtimeEventInput = Readonly<{
  organizationId: string;
  sourceActivityId?: string;
  messagingActivityId?: string;
  type: RealtimeEventType;
  entityType: RealtimeEntityType;
  entityId: string;
  actorUserId: string | null;
  audience: RealtimeAudience;
  resourceKeys: readonly string[];
  occurredAt: Date;
}>;

export type RealtimeEventRecord = Omit<RealtimeEventInput, 'sourceActivityId' | 'messagingActivityId'> & Readonly<{
  id: bigint;
  sourceActivityId: string | null;
  messagingActivityId: string | null;
}>;

export type RealtimeViewer = Readonly<{
  organizationId: string;
  userId: string;
  role: UserRole;
}>;

export type RealtimeChangeEnvelope = Readonly<{
  id: string;
  type: RealtimeEventType;
  entity: Readonly<{ type: RealtimeEntityType; id: string }>;
  resourceKeys: readonly string[];
  occurredAt: string;
}>;

export type RealtimeSyncRequiredEnvelope = Readonly<{
  id: string;
  type: 'sync.required';
  resourceKeys: readonly ['workspace'];
  occurredAt: string;
}>;

export type RealtimeEventEnvelope =
  | RealtimeChangeEnvelope
  | RealtimeSyncRequiredEnvelope;

export function presentRealtimeEvent(
  event: RealtimeEventRecord,
): RealtimeChangeEnvelope {
  return {
    id: event.id.toString(),
    type: event.type,
    entity: { type: event.entityType, id: event.entityId },
    resourceKeys: event.resourceKeys,
    occurredAt: event.occurredAt.toISOString(),
  };
}
