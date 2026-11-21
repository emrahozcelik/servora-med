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
  sourceJobCardId?: string | null;
  customerId?: string | null;
}>;

const TYPES: Partial<Record<JobCardActivityEvent, RealtimeEventType>> = {
  WEEKLY_REPORT_REMOVED: 'job.updated',
  SALE_FROM_VISIT_CREATED: 'job.updated',
  SALE_DETAILS_UPDATED: 'job.updated',
  SALE_ITEM_ADDED: 'job.updated',
  SALE_ITEM_UPDATED: 'job.updated',
  SALE_ITEM_REMOVED: 'job.updated',
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
  JOB_INVALIDATED: 'job.invalidated',
  JOB_FIELDS_UPDATED: 'job.updated',
  JOB_APPROVAL_WITHDRAWN: 'job.updated',
  NOTE_ADDED: 'job.updated',
  MEETING_DETAILS_UPDATED: 'job.updated',
  // OVR-4 reminder facts are not lifecycle transitions: they invalidate the
  // job views through the established 'job.updated' transport while the
  // notification kinds carry the reminder semantics.
  JOB_SUBMISSION_REMINDER_SENT: 'job.updated',
  JOB_SUBMISSION_AUTO_REMINDER_SENT: 'job.updated',
  JOB_SUBMISSION_AUTO_ESCALATION_SENT: 'job.updated',
  // JOB-010 §1a: the grant is not a lifecycle transition. It invalidates the
  // job detail/list views through the established 'job.updated' transport so
  // the assigned Staff member's next START reads the widened rule.
  JOB_EARLY_START_AUTHORIZED: 'job.updated',
  // JOB-010 release 2a: raising or deciding a change/termination request is
  // not a lifecycle transition. Both facts invalidate the job views (detail,
  // list) and the management overview through the established transport.
  JOB_CHANGE_REQUESTED: 'job.updated',
  JOB_CHANGE_REQUEST_RESOLVED: 'job.updated',
  // JOB-010 release 2b: offer facts are not lifecycle transitions either.
  // They invalidate the job views, the management needs-action list and the
  // overview through the same transport; the notification kinds carry the
  // acceptance semantics.
  JOB_ASSIGNMENT_OFFER_OPENED: 'job.updated',
  JOB_ASSIGNMENT_REMINDER_SENT: 'job.updated',
  JOB_ASSIGNMENT_DECLINED: 'job.updated',
  JOB_ASSIGNMENT_RELEASED: 'job.updated',
  JOB_ASSIGNMENT_OFFER_EXPIRED: 'job.updated',
  JOB_ASSIGNMENT_OFFER_WITHDRAWN: 'job.updated',
  // OVR-5: ending an obligation by an authorized deadline extension is not a
  // lifecycle transition either. It invalidates the job views and the
  // management open-late list through the same transport.
  JOB_OVERDUE_ENDED_BY_EXTENSION: 'job.updated',
};

const APPROVAL_EVENTS = new Set<JobCardActivityEvent>([
  'JOB_SUBMITTED_FOR_APPROVAL',
  'JOB_APPROVED',
  'JOB_REVISION_REQUESTED',
  'JOB_CANCELLED',
  'JOB_INVALIDATED',
  'JOB_APPROVAL_WITHDRAWN',
]);

export function mapJobCardActivityToRealtime(
  input: MappingInput,
): RealtimeEventInput | null {
  const type = TYPES[input.event];
  if (!type) return null;

  const keys = new Set<string>([
    'calendar',
    'job-board',
    `job-detail:${input.jobCardId}`,
    'job-list',
    'reports',
    'overview',
    `staff-profile:${input.afterAssigneeId}`,
  ]);
  if (input.beforeAssigneeId) {
    keys.add(`staff-profile:${input.beforeAssigneeId}`);
  }
  if (APPROVAL_EVENTS.has(input.event)) {
    keys.add('approval-queue');
  }
  if (input.event === 'JOB_CREATED' && input.sourceJobCardId) {
    keys.add(`job-detail:${input.sourceJobCardId}`);
  }
  if (input.customerId) keys.add(`customer-detail:${input.customerId}`);

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
