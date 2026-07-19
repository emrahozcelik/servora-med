import type { JobCardActivityEvent } from '../job-cards/types.js';
import { buildJobCardAudience } from './audience.js';
import type {
  RealtimeEventInput,
  RealtimeEventType,
} from './types.js';

type MappingInput = Readonly<{
  activityId: string;
  organizationId: string;
  jobCardId: string;
  actorUserId: string | null;
  event: JobCardActivityEvent;
  occurredAt: Date;
  beforeAssigneeId: string | null;
  afterAssigneeId: string;
}>;

const TYPES: Partial<Record<JobCardActivityEvent, RealtimeEventType>> = {
  JOB_CREATED: 'job.created',
  JOB_ASSIGNED: 'job.assignment_changed',
  JOB_PLANNED: 'job.updated',
  JOB_ACCEPTED: 'job.accepted',
  JOB_STARTED: 'job.started',
  JOB_SUBMITTED_FOR_APPROVAL: 'job.submitted_for_approval',
  JOB_APPROVED: 'job.approved',
  JOB_REVISION_REQUESTED: 'job.revision_requested',
  JOB_RESUMED: 'job.updated',
  JOB_CANCELLED: 'job.cancelled',
  JOB_FIELDS_UPDATED: 'job.updated',
  JOB_APPROVAL_WITHDRAWN: 'job.updated',
};

const APPROVAL_EVENTS = new Set<JobCardActivityEvent>([
  'JOB_SUBMITTED_FOR_APPROVAL',
  'JOB_APPROVED',
  'JOB_REVISION_REQUESTED',
  'JOB_CANCELLED',
  'JOB_APPROVAL_WITHDRAWN',
]);

export function mapJobCardActivityToRealtime(
  input: MappingInput,
): RealtimeEventInput | null {
  const type = TYPES[input.event];
  if (!type) return null;

  const keys = new Set<string>([
    'job-board',
    `job-detail:${input.jobCardId}`,
    'job-list',
    'reports',
    `staff-profile:${input.afterAssigneeId}`,
  ]);
  if (input.beforeAssigneeId) {
    keys.add(`staff-profile:${input.beforeAssigneeId}`);
  }
  if (APPROVAL_EVENTS.has(input.event)) {
    keys.add('approval-queue');
  }

  return {
    organizationId: input.organizationId,
    sourceActivityId: input.activityId,
    type,
    entityType: 'job-card',
    entityId: input.jobCardId,
    actorUserId: input.actorUserId,
    audience: buildJobCardAudience({
      event: input.event,
      beforeAssigneeId: input.beforeAssigneeId,
      afterAssigneeId: input.afterAssigneeId,
    }),
    resourceKeys: [...keys].sort(),
    occurredAt: input.occurredAt,
  };
}
