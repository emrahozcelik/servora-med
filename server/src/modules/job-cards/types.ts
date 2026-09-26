import type { UserRole } from '../auth/types.js';
import type {
  OverdueAccountableRole,
  OverdueAccountableSource,
  OverdueIncidentDelayType,
  OverdueIncidentSource,
} from './overdue-incidents.js';

export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED',
] as const;
export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export const JOB_CARD_INVALIDATION_REASON_CODES = [
  'DUPLICATE', 'WRONG_CUSTOMER', 'CREATED_BY_MISTAKE', 'TRAINING_OR_TEST_RECORD', 'OTHER',
] as const;
export type JobCardInvalidationReasonCode = (typeof JOB_CARD_INVALIDATION_REASON_CODES)[number];
export const ACTIVE_JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const satisfies readonly JobCardStatus[];
export const TERMINAL_JOB_CARD_STATUSES = [
  'COMPLETED', 'CANCELLED', 'INVALIDATED',
] as const satisfies readonly JobCardStatus[];
export function isOperationallyValidJobCard(status: JobCardStatus): boolean {
  return status !== 'INVALIDATED';
}
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT'] as const;
export type JobCardType = (typeof JOB_CARD_TYPES)[number];

export const JOB_CARD_ENGAGEMENT_KINDS = [
  'SALES_MEETING',
  'CUSTOMER_VISIT',
  'PRODUCT_DEMO',
  'TRAINING',
  'FOLLOW_UP',
  'OTHER',
] as const;
export type JobCardEngagementKind = (typeof JOB_CARD_ENGAGEMENT_KINDS)[number];

export const MEETING_OUTCOMES = [
  'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

export const UNSUCCESSFUL_VISIT_REASON_CODES = [
  'CONTACT_NOT_AVAILABLE',
  'CONTACT_BUSY',
  'CUSTOMER_UNREACHABLE',
  'REQUESTED_LATER',
  'OTHER',
] as const;
export type UnsuccessfulVisitReasonCode = (typeof UNSUCCESSFUL_VISIT_REASON_CODES)[number];

export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];

export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];

export const JOB_CARD_ACTIVITY_EVENTS = [
  'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
  'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_INVALIDATED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
  // OVR-4: a manager explicitly asked an employee to submit. Append-only audit
  // fact; it is the durable, measurable counterpart of the automatic
  // reminder projection (which owns no activity row).
  'JOB_SUBMISSION_REMINDER_SENT',
] as const;
export type JobCardActivityEvent = (typeof JOB_CARD_ACTIVITY_EVENTS)[number];

export type JobCardActor = { id: string; organizationId: string; role: UserRole };
export type JobCardAssignee = JobCardActor & { isActive: boolean };

export type JobCard = {
  id: string;
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  version: number;
  title: string;
  description: string | null;
  customerId: string | null;
  contactId: string | null;
  assignedTo: string;
  createdBy: string;
  priority: JobCardPriority;
  dueDate: string | null;
  scheduledAt: string | null;
  scheduledEndsAt: string | null;
  engagementKind: JobCardEngagementKind | null;
  sourceJobCardId: string | null;
  followUpInstructions: string | null;
  followUpProposedAt: string | null;
  followUpProposedType: JobCardType | null;
  followUpProposedAssignee: string | null;
  followUpProposalInstructions: string | null;
  followUpProposalOrigin: FollowUpProposalOrigin | null;
  followUpProposedBy: string | null;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
  invalidationReasonCode: JobCardInvalidationReasonCode | null;
};

export type JobCardInvalidationInput = {
  clientActionId: string;
  expectedVersion: number;
  reasonCode: JobCardInvalidationReasonCode;
  note: string | null;
};

export type FollowUpProposalOrigin = 'SYSTEM' | 'STAFF_ADJUSTED';

export type FollowUpProposalInput = {
  scheduledAt?: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
};

export type ApproveFollowUpInput = FollowUpProposalInput & {
  priority?: JobCardPriority;
  dueDate?: string | null;
  overrideReason?: string | null;
};

export type FollowUpProposal = {
  scheduledAt: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  origin: FollowUpProposalOrigin;
  proposedBy: RelatedIdentity;
};

export type JobCardCreateInput =
  | {
    clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string;
    description?: string | null; customerId: string;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
    scheduledAt: string; scheduledEndsAt?: string;
  }
  | {
    clientActionId: string; type: 'GENERAL_TASK'; title: string;
    description?: string | null; customerId?: string | null; contactId?: string | null;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
    scheduledAt?: string | null;
  }
  | {
    clientActionId: string; type: 'SALES_MEETING'; title: string;
    description?: string | null; customerId: string; contactId?: string | null;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
    scheduledAt: string; scheduledEndsAt?: string; engagementKind?: JobCardEngagementKind;
  };

type NormalizedCommonCreateInput = {
  clientActionId: string; title: string; description: string | null; contactId: string | null;
  assignedTo: string; priority: JobCardPriority; dueDate: string | null;
  scheduledAt: string | null;
  scheduledEndsAt?: string | null;
};

export type NormalizedJobCardCreateInput =
  | NormalizedCommonCreateInput & {
      type: 'PRODUCT_DELIVERY'; customerId: string; contactId: null; scheduledAt: string;
      overrideReason?: string | null;
    }
  | NormalizedCommonCreateInput & { type: 'GENERAL_TASK'; customerId: string | null }
  | NormalizedCommonCreateInput & {
      type: 'SALES_MEETING'; customerId: string; scheduledAt: string;
      engagementKind: JobCardEngagementKind;
      overrideReason?: string | null;
    };

export type ProductDeliveryCreateInput = Extract<
  NormalizedJobCardCreateInput,
  { type: 'PRODUCT_DELIVERY' }
> & {
  deliveryPurpose: DeliveryPurpose;
  deliveryNote: string | null;
  items: Array<{ productId: string; quantity: number }>;
};

export type CustomerSchedulePreviewInput = {
  engagementKind?: JobCardEngagementKind | null;
  type: JobCardType;
  customerId: string | null;
  scheduledAt: string;
  jobCardId?: string | null;
};

export type AvailableSlotsInput = {
  type: 'SALES_MEETING' | 'PRODUCT_DELIVERY';
  customerId: string;
  assignedTo: string;
  scheduledAt: string;
  scheduledEndsAt?: string;
  jobCardId?: string | null;
};

export type AvailableSlot = {
  startsAt: string;
  endsAt: string;
};

export type AvailableSlotsResponse = {
  slots: AvailableSlot[];
};

export type MeetingDetails = {
  jobCardId: string;
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
  unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
  meetingSummary: string | null;
  nextFollowUpAt: string | null;
  jobCardVersion: number;
};

export type MeetingDetailsCandidate = {
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
  unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  meetingSummary: string | null;
  nextFollowUpAt: string | null;
};

export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt',
] as const;
export type MeetingDetailField = (typeof MEETING_DETAIL_FIELDS)[number];

export type PatchMeetingDetailsInput = {
  clientActionId: string;
  expectedVersion: number;
  meetingAt?: string | null;
  outcome?: MeetingOutcome | null;
  unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  meetingSummary?: string | null;
  nextFollowUpAt?: string | null;
};

export type RelatedIdentity = { id: string; name: string };

export type ReferenceCustomer = {
  id: string;
  name: string;
  customerType: string;
  status: string;
  assignedStaffUserId?: string | null;
};

export type ReferenceContact = {
  id: string;
  name: string;
  title: string | null;
};

export type JobLifecycleFacts = {
  createdAt: string;
  acceptedAt: string | null;
  acceptedBy: RelatedIdentity | null;
  startedAt: string | null;
  submittedAt: string | null;
  submittedBy: RelatedIdentity | null;
  submissionNote: string | null;
  approvedAt: string | null;
  approvedBy: RelatedIdentity | null;
  approvalNote: string | null;
  revisionRequestedAt: string | null;
  revisionRequestedBy: RelatedIdentity | null;
  revisionReason: string | null;
  cancelledAt: string | null;
  cancelledBy: RelatedIdentity | null;
  cancelReason: string | null;
  cancelledFromStatus: JobCardStatus | null;
  invalidatedAt: string | null;
  invalidatedBy: RelatedIdentity | null;
  invalidationReasonCode: JobCardInvalidationReasonCode | null;
  invalidatedFromStatus: JobCardStatus | null;
};

export type PersistedJobCardDetail = JobCard & {
  organizationTimezone: string;
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  lifecycle: JobLifecycleFacts;
  proposer: RelatedIdentity | null;
};

export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};

export type FollowUpSourceSummary = {
  sourceType: JobCardType;
  sourcePlannedAt: string | null;
  sourceOccurredAt: string | null;
  sourceCompletedAt: string;
  customer: ReferenceCustomer | null;
  contact: ReferenceContact | null;
  outcome: MeetingOutcome | null;
};

export type FollowUpSourceAccess = 'FULL' | 'RESTRICTED';

export type JobCardFollowUpContext = {
  sourceJobCardId: string;
  followUpInstructions: string;
  sourceAccess: FollowUpSourceAccess;
  sourceJobPath: string | null;
  sourceSummary: FollowUpSourceSummary;
};

export type JobCardDetail = Omit<
  PersistedJobCardDetail,
  'lifecycle' | 'sourceJobCardId' | 'followUpInstructions' | 'proposer'
> & {
  workflowContext: JobWorkflowContext;
  followUpContext: JobCardFollowUpContext | null;
  followUpProposal: FollowUpProposal | null;
};

export type DeliveryItem = {
  id?: string;
  organizationId?: string;
  jobCardId?: string;
  productId: string;
  deliveryPurpose: DeliveryPurpose;
  deliveredAt: Date | null;
  quantity: number;
  unit?: string | null;
  productNameSnapshot?: string;
  productSkuSnapshot?: string | null;
  productModelSnapshot?: string | null;
  lotNo?: string | null;
  serialNo?: string | null;
  expiryDate?: string | null;
  deliveryNote?: string | null;
};

export type LifecycleCommand =
  | 'ACCEPT_ASSIGNMENT'
  | 'START'
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'WITHDRAW_FROM_APPROVAL'
  | 'RESUME'
  | 'CANCEL';

/** Active statuses plus legacy PLANNED retained only for historical activity presentation. */
export type JobCardActivityStatus = JobCardStatus | 'PLANNED';

export type JobPermissionSubject = Pick<
  JobCard,
  'organizationId' | 'type' | 'status' | 'assignedTo'
> & Partial<Pick<JobCard, 'scheduledAt'>>;

export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];

export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'UNSUCCESSFUL_REASON_PRESENT',
  'FOLLOW_UP_TIME_VALID',
  'WEEKLY_REPORT_FOUND', 'WEEKLY_DRAFT_VALID', 'WEEKLY_ANSWERS_COMPLETE',
  'WEEKLY_SOURCE_WORK_READY',
] as const;
export type SubmissionRequirementCode = (typeof SUBMISSION_REQUIREMENT_CODES)[number];
export type SubmissionRequirement = {
  code: SubmissionRequirementCode;
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
export type SubmissionReadiness = {
  evaluatedAt: string;
  ready: boolean;
  items: SubmissionRequirement[];
};

export type JobCardStatusFilter = JobCardStatus | 'active' | 'closed' | 'all';

export type JobCardFollowUpFilter = 'only' | null;

export type JobCardBaseFilters = {
  q: string | null;
  type: JobCardType | null;
  assignedTo: string | null;
  customerId: string | null;
  priority: JobCardPriority | null;
  dueBefore: string | null;
  dueAfter: string | null;
  followUp: JobCardFollowUpFilter;
};

export type JobCardWorkspaceFilters = JobCardBaseFilters & { status: JobCardStatusFilter };
export type JobCardListQuery = JobCardWorkspaceFilters & {
  limit: number;
  offset: number;
  /** Server-owned overdue filter: active statuses + due_date before org-local today. */
  overdue: boolean;
};
export type JobCardBoardQuery = JobCardBaseFilters & { limit: number };

export type PersistedJobCardListItem = {
  id: string;
  type: JobCardType;
  engagementKind: JobCardEngagementKind | null;
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  dueDate: string | null;
  scheduledAt: string | null;
  scheduledEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  staffCompletedAt: string | null;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  assignee: RelatedIdentity;
  deliveryItemCount: number;
  /**
   * Derived current-overdue snapshot. Both fields are present ONLY on the
   * server-owned overdue list view (`overdue=true`), which is the single
   * surface that evaluates lateness; they are absent everywhere else.
   *
   * `overdueSince` is the first instant of lateness — the organization-local
   * midnight immediately after `due_date` — and `latenessSeconds` is the whole
   * number of seconds elapsed since then, measured from the request clock.
   * Neither is stored: overdue stays a derived condition, never a status.
   */
  overdueSince?: string | null;
  latenessSeconds?: number | null;
  /**
   * OVR-4 derived *current* LATE_SUBMISSION delay snapshot. Present ONLY on the
   * job list surface, the single list that resolves it; absent everywhere else
   * (the same absent-vs-null contract as the overdue snapshot above).
   *
   * It is deliberately orthogonal to `latenessSeconds`: that field measures the
   * due-date clock, this one measures an open submission obligation. Neither
   * replaces the other, so the meaning of the existing `Geciken` view is
   * unchanged.
   *
   * `elapsedSeconds` is computed server-side from the request clock against the
   * incident's immutable `breached_at`; the client never derives the duration
   * from its own clock.
   */
  submissionDelay?: { breachedAt: string; elapsedSeconds: number } | null;
};

export type JobCardListItem = PersistedJobCardListItem & {
  allowedCommands: LifecycleCommand[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type PaginatedJobCardList = Paginated<JobCardListItem>;

export type FollowUpListItem = JobCardListItem & {
  followUp: { sourceJobCardId: string } | null;
};

export type PaginatedFollowUpList = Paginated<FollowUpListItem>;

/**
 * OVR-2 management history item: immutable breach/accountability facts plus
 * the one-way recovery pair. Identity fields never change after creation.
 */
export type OverdueIncidentManagerReminder = {
  sentAt: string;
  actor: { id: string; name: string | null } | null;
  target: { id: string; name: string | null } | null;
};

export type OverdueIncidentHistoryItem = {
  id: string;
  delayType: OverdueIncidentDelayType;
  episodeNo: number;
  scheduleRevisionNo: number;
  deadlineAt: string;
  breachedAt: string;
  accountableRole: OverdueAccountableRole;
  accountableSource: OverdueAccountableSource;
  accountableUser: { id: string; name: string | null } | null;
  source: OverdueIncidentSource;
  recordedAt: string;
  recoveredAt: string | null;
  recoveryActor: { id: string; name: string | null } | null;
  /**
   * OVR-4 measurement. Server-computed whole seconds, never derived from the
   * client clock and never backfilled:
   * - `totalDelaySeconds` = recoveredAt - breachedAt; null while the incident
   *   is still open (an ongoing delay has no total yet).
   * - `managerReminder` = the LATEST manual management reminder bound to this
   *   incident, or null when no manager ever reminded. Pre-OVR-4 history has
   *   none, so it stays null instead of being guessed.
   * - `postReminderDelaySeconds` = recoveredAt - managerReminder.sentAt; null
   *   when either side is absent.
   */
  totalDelaySeconds: number | null;
  managerReminder: OverdueIncidentManagerReminder | null;
  postReminderDelaySeconds: number | null;
};

export type PaginatedOverdueIncidentHistory = Paginated<OverdueIncidentHistoryItem>;

/**
 * OVR-4 current-delay signal. This is NOT the immutable history contract: it
 * carries only the delay that is happening right now, for the person who has to
 * act on it. It is readable by anyone who can already reach the JobCard (STAFF
 * included, self-scoped), while the breach/accountability history above stays
 * management-only.
 */
export type JobCardSubmissionDelaySignal = {
  delayType: 'LATE_SUBMISSION';
  episodeNo: number;
  deadlineAt: string;
  breachedAt: string;
  /** Whole seconds since `breachedAt`, measured from the request clock. */
  elapsedSeconds: number;
  accountableStaff: { id: string; name: string | null } | null;
};

export type JobCardSubmissionReminderInput = {
  clientActionId: string;
};

export type JobCardSubmissionReminderReceipt = {
  jobCardId: string;
  incidentId: string;
  reminderId: string;
  sentAt: string;
  targetUserId: string;
};

export type JobCardMutationReceipt = {
  jobCardId: string;
  evaluatedAt?: string;
  followUpJobCardId?: string;
};

export type FollowUpCreateReceipt = JobCardMutationReceipt;

export type FollowUpCreateInput = {
  clientActionId: string;
  type: JobCardType;
  title: string;
  followUpInstructions: string;
  scheduledAt: string | null;
  assignedTo: string;
  priority: JobCardPriority;
  dueDate: string | null;
  contactId: string | null;
  engagementKind: JobCardEngagementKind | null;
  overrideReason?: string | null;
};

export type JobCardBoardColumn = { items: JobCardListItem[]; count: number };
export type JobCardBoard = {
  columns: {
    NEW: JobCardBoardColumn;
    ACCEPTED: JobCardBoardColumn;
    IN_PROGRESS: JobCardBoardColumn;
    WAITING_APPROVAL: JobCardBoardColumn;
    REVISION_REQUESTED: JobCardBoardColumn;
  };
  closedCounts: { COMPLETED: number; CANCELLED: number };
};

type JobCardNoteBase = {
  id: string;
  jobCardId: string;
  note: string;
  invoiceNumber: string | null;
  createdAt: string;
};

export type JobCardOperationalNoteContext =
  | 'GENERAL'
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'CANCEL'
  | 'INVALIDATE';

export type JobCardNoteDto = JobCardNoteBase & (
  | {
      recordVersion: 0;
      author: {
        id: string;
        name: string;
        role: null;
        source: 'LEGACY_CURRENT';
      };
      workflowStage: null;
      context: null;
      relatedActivityId: null;
    }
  | {
      recordVersion: 1;
      author: {
        id: string;
        name: string;
        role: UserRole;
        source: 'SNAPSHOT';
      };
      workflowStage: JobCardStatus;
      context: JobCardOperationalNoteContext;
      relatedActivityId: string;
    }
);

export type JobCardNoteCursor = {
  createdAt: string;
  id: string;
};

export type PaginatedJobCardNotes = {
  items: JobCardNoteDto[];
  limit: number;
  nextCursor: JobCardNoteCursor | null;
};

export type ActivityRecord = {
  id: string;
  jobCardId: string;
  actorId: string | null;
  actorName: string | null;
  eventType: JobCardActivityEvent;
  oldValue: unknown;
  newValue: unknown;
  metadata: unknown;
  clientActionId: string | null;
  createdAt: Date;
};

export type JobCardActivityDetails =
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardActivityStatus;
      toStatus: JobCardActivityStatus;
      reason: string | null;
      startLocation?:
        | {
            outcome: 'CAPTURED';
            approximateLabel: string | null;
            accuracyMeters: number;
            capturedAt: string;
            geocodingProvider: 'GOOGLE' | null;
          }
        | {
            outcome: 'UNAVAILABLE';
            reason: 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT'
              | 'UNSUPPORTED' | 'UNKNOWN';
          };
    }
  | {
      kind: 'FIELDS_UPDATED';
      changedFields: Array<
        'title' | 'description' | 'customer' | 'contact' |
        'assignee' | 'priority' | 'dueDate' | 'scheduledAt'
        | 'scheduledEndsAt' | 'engagementKind'
      >;
    }
  | {
      kind: 'DELIVERY_ITEM';
      operation: 'ADDED' | 'UPDATED' | 'REMOVED';
      itemId: string;
      purpose: DeliveryPurpose | null;
      quantity: number | null;
    }
  | { kind: 'NOTE'; noteId: string }
  | { kind: 'MEETING_DETAILS'; changedFields: MeetingDetailField[] }
  | { kind: 'NONE' };

export type JobCardActivityDto = {
  id: string;
  jobCardId: string;
  eventType: JobCardActivityEvent;
  actor: { id: string; name: string } | null;
  details: JobCardActivityDetails;
  createdAt: string;
};

export type PaginatedJobCardActivity = Paginated<JobCardActivityDto>;

import type {
  CustomerScheduleConflictDetail,
  CustomerScheduleLevel,
  RecentVisitSummary,
} from './customer-schedule.js';

export type RoleProjectedCustomerScheduleEvaluation = {
  level: CustomerScheduleLevel;
  safeMessage: string | null;
  conflicts: CustomerScheduleConflictDetail[];
  recentVisit: RecentVisitSummary | null;
  suggestedAlternativeAt: string | null;
};

export type FollowUpSuggestion = {
  scheduledAt: string | null;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  evaluation: RoleProjectedCustomerScheduleEvaluation;
};

/**
 * 049: lifecycle intent processing budget. A PENDING intent reserves
 * exactly this long (expires_at = reserved_at + TTL, no renewal); an
 * expired/FAILED identity cannot renew and requires a new client action key.
 * Owned here (domain constant); config.ts only mirrors it as the env
 * default for JOB_CARD_LIFECYCLE_INTENT_TTL_MS.
 */
export const LIFECYCLE_INTENT_TTL_MS_DEFAULT = 60_000;
