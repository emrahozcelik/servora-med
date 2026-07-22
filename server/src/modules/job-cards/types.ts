import type { UserRole } from '../auth/types.js';

export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
] as const;
export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const;
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

export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];

export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];

export const JOB_CARD_ACTIVITY_EVENTS = [
  'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
  'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
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
  engagementKind: JobCardEngagementKind | null;
};

export type JobCardCreateInput =
  | {
    clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string;
    description?: string | null; customerId: string; contactId?: string | null;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
    scheduledAt: string;
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
    scheduledAt: string; engagementKind?: JobCardEngagementKind;
  };

type NormalizedCommonCreateInput = {
  clientActionId: string; title: string; description: string | null; contactId: string | null;
  assignedTo: string; priority: JobCardPriority; dueDate: string | null;
  scheduledAt: string | null;
};

export type NormalizedJobCardCreateInput =
  | NormalizedCommonCreateInput & { type: 'PRODUCT_DELIVERY'; customerId: string; scheduledAt: string }
  | NormalizedCommonCreateInput & { type: 'GENERAL_TASK'; customerId: string | null }
  | NormalizedCommonCreateInput & {
      type: 'SALES_MEETING'; customerId: string; scheduledAt: string;
      engagementKind: JobCardEngagementKind;
    };

export type MeetingDetails = {
  jobCardId: string;
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
  meetingSummary: string | null;
  nextFollowUpAt: string | null;
  jobCardVersion: number;
};

export type MeetingDetailsCandidate = Pick<
  MeetingDetails,
  'meetingAt' | 'outcome' | 'meetingSummary' | 'nextFollowUpAt'
>;

export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
] as const;
export type MeetingDetailField = (typeof MEETING_DETAIL_FIELDS)[number];

export type PatchMeetingDetailsInput = {
  clientActionId: string;
  expectedVersion: number;
  meetingAt?: string | null;
  outcome?: MeetingOutcome | null;
  meetingSummary?: string | null;
  nextFollowUpAt?: string | null;
};

export type RelatedIdentity = { id: string; name: string };

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
};

export type PersistedJobCardDetail = JobCard & {
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  lifecycle: JobLifecycleFacts;
};

export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};

export type JobCardDetail = Omit<PersistedJobCardDetail, 'lifecycle'> & {
  workflowContext: JobWorkflowContext;
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
>;

export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];

export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'FOLLOW_UP_TIME_VALID',
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

export type JobCardBaseFilters = {
  q: string | null;
  type: JobCardType | null;
  assignedTo: string | null;
  customerId: string | null;
  priority: JobCardPriority | null;
  dueBefore: string | null;
  dueAfter: string | null;
};

export type JobCardWorkspaceFilters = JobCardBaseFilters & { status: JobCardStatusFilter };
export type JobCardListQuery = JobCardWorkspaceFilters & { limit: number; offset: number };
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
  createdAt: string;
  updatedAt: string;
  staffCompletedAt: string | null;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  assignee: RelatedIdentity;
  deliveryItemCount: number;
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

export type JobCardNoteDto = {
  id: string;
  jobCardId: string;
  note: string;
  author: { id: string; name: string };
  createdAt: string;
};

export type PaginatedJobCardNotes = Paginated<JobCardNoteDto>;

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
        'assignee' | 'priority' | 'dueDate' | 'engagementKind'
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
