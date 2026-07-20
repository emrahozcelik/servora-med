import type { JobCardActivityEvent } from '../job-cards/types.js';
import type {
  RealtimeAudience,
  RealtimeEventRecord,
  RealtimeViewer,
} from './types.js';

type AudienceInput = Readonly<{
  event: JobCardActivityEvent;
  beforeAssigneeId: string | null;
  afterAssigneeId: string;
}>;

export function buildJobCardAudience(
  input: AudienceInput,
): RealtimeAudience {
  const userIds = new Set<string>([input.afterAssigneeId]);
  if (input.event === 'JOB_ASSIGNED' && input.beforeAssigneeId) {
    userIds.add(input.beforeAssigneeId);
  }
  return {
    roles: ['ADMIN', 'MANAGER'],
    userIds: [...userIds].sort(),
  };
}

export function canViewRealtimeEvent(
  viewer: RealtimeViewer,
  event: Pick<
    RealtimeEventRecord,
    'organizationId' | 'audience'
  >,
): boolean {
  if (viewer.organizationId !== event.organizationId) return false;
  return event.audience.roles.includes(
    viewer.role as 'ADMIN' | 'MANAGER',
  ) || event.audience.userIds.includes(viewer.userId);
}
