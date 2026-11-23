import {
  ApiError, boolean, items, json, nullableString, number, object, request as apiRequest, string,
} from '../services/api';
import type { ActionLocationCapture, StartLocationCapture } from './start-location-capture.js';

// Sale-aware root/workflow readers and the operational subresources used by Sale detail opt in.
const request: typeof apiRequest = (path, options) => {
  const pathname = path.split('?')[0]!;
  const method = options?.method ?? 'GET';
  const root = /^\/api\/job-cards\/[^/]+$/.test(pathname)
    && !['board', 'product-deliveries', 'weekly-reports', 'available-slots', 'customer-schedule'].includes(pathname.split('/').at(-1)!);
  const gated = (pathname === '/api/job-cards' || pathname === '/api/job-cards/board') && method === 'GET'
    || root || /\/(activity|notes|submission-lateness|submission-reminder|overdue-incidents)$/.test(pathname)
    || /\/(accept|decline|release|start|submit-for-approval|approve|request-revision|withdraw-from-approval|resume|cancel|invalidate)$/.test(pathname);
  return apiRequest(gated ? path + (path.includes('?') ? '&' : '?') + 'includeSaleCapability=true' : path, options);
};

export const JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED', 'INVALIDATED',
] as const;
export const ACTIVE_JOB_CARD_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const;
export const JOB_CARD_INVALIDATION_REASON_CODES = [
  'DUPLICATE', 'WRONG_CUSTOMER', 'CREATED_BY_MISTAKE', 'TRAINING_OR_TEST_RECORD', 'OTHER',
] as const;
export type JobCardInvalidationReasonCode = (typeof JOB_CARD_INVALIDATION_REASON_CODES)[number];
/** Active statuses plus legacy PLANNED retained only for historical activity presentation. */
export const JOB_CARD_ACTIVITY_STATUSES = [...JOB_CARD_STATUSES, 'PLANNED'] as const;
export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
/**
 * Productive work types only. Server completion/performance/type-bucket
 * aggregates never contain weekly reports, so bucket parsers and bucket
 * displays must use this list (server parity) — never the full union below.
 */
export const PRODUCTIVE_JOB_CARD_TYPES = [
  'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'SALE',
] as const;
/**
 * Follow-up children can never be `SALE`: migration 057 requires
 * `source_job_card_id IS NULL` for every SALE, so a SALE child bucket would
 * always be a fabricated zero. Server parity for the follow-up report buckets.
 */
export const FOLLOW_UP_CHILD_JOB_CARD_TYPES = PRODUCTIVE_JOB_CARD_TYPES
  .filter((type) => type !== 'SALE');
/**
 * Every JobCard type the API can return, including administrative weekly
 * reports. Job-row parsers, filters and labels use this list so a
 * WEEKLY_REPORT row can never crash exact parsing.
 */
export const JOB_CARD_TYPES = [...PRODUCTIVE_JOB_CARD_TYPES, 'WEEKLY_REPORT'] as const;
export const JOB_CARD_ENGAGEMENT_KINDS = [
  'SALES_MEETING',
  'CUSTOMER_VISIT',
  'PRODUCT_DEMO',
  'TRAINING',
  'FOLLOW_UP',
  'OTHER',
] as const;
/** JOB-009: why a cancelled follow-up visit ends the customer's visit cycle. */
export const FOLLOW_UP_CYCLE_END_REASONS = [
  'NOT_INTERESTED',
  'WORKS_WITH_COMPETITOR',
  'CUSTOMER_INACTIVE',
  'DUPLICATE_RECORD',
  'OTHER',
] as const;
export type FollowUpCycleEndReason = (typeof FOLLOW_UP_CYCLE_END_REASONS)[number];
/** JOB-009 continuity decision sent with the cancel of a follow-up visit. */
export type FollowUpCancelContinuity =
  | { decision: 'RESCHEDULE'; scheduledAt: string }
  | { decision: 'END_CYCLE'; endReason: FollowUpCycleEndReason };
export const MEETING_OUTCOMES = [
  'POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED',
] as const;
export const UNSUCCESSFUL_VISIT_REASON_CODES = [
  'CONTACT_NOT_AVAILABLE',
  'CONTACT_BUSY',
  'CUSTOMER_UNREACHABLE',
  'REQUESTED_LATER',
  'OTHER',
] as const;
export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt', 'metContactId',
] as const;
export const JOB_CARD_STATUS_FILTERS = [
  'active', 'closed', 'all', ...JOB_CARD_STATUSES,
] as const;
export const LIFECYCLE_COMMANDS = [
  'ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT', 'RELEASE_ASSIGNMENT', 'START',
  'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
  'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
] as const;
export const USER_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;
export const JOB_CARD_OPERATIONAL_NOTE_CONTEXTS = [
  'GENERAL', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'CANCEL', 'INVALIDATE',
] as const;
export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];
export type JobCardOperationalNoteContext = (typeof JOB_CARD_OPERATIONAL_NOTE_CONTEXTS)[number];
export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
  'REQUEST_CHANGE', 'RESOLVE_CHANGE_REQUEST',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];
/**
 * JOB-010 release 2a: Staff reasons for asking management to correct or
 * terminate an assigned job. Codes and Turkish copy mirror the accepted
 * contract; the server re-validates every value and stays authoritative.
 */
export const CHANGE_REQUEST_REASON_CODES = [
  'CUSTOMER_CHANGED_MIND', 'CUSTOMER_POSTPONED', 'CUSTOMER_ABSENT', 'WRONG_PRODUCT',
  'MISSING_STOCK_OR_EQUIPMENT', 'VISIT_NOT_POSSIBLE', 'OTHER',
] as const;
export type ChangeRequestReasonCode = (typeof CHANGE_REQUEST_REASON_CODES)[number];
/** The management decisions release 2a lets a manager record right now. */
export const CHANGE_REQUEST_RESOLUTIONS = [
  'CORRECTED', 'RESCHEDULED', 'LINKED_JOB_CREATED', 'REJECTED',
] as const;
export type ChangeRequestResolution = (typeof CHANGE_REQUEST_RESOLUTIONS)[number];
/**
 * JOB-010 release 2b: the server-owned assignment offer of a job in the
 * acceptance window. The web renders this vocabulary; it never derives an
 * offer, a deadline or an urgency from its own clock.
 */
export const ASSIGNMENT_OFFER_STATES = [
  'OPEN', 'ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN',
] as const;
export type AssignmentOfferState = (typeof ASSIGNMENT_OFFER_STATES)[number];
export const ASSIGNMENT_OFFER_URGENT_REASONS = ['SHORT_NOTICE', 'START_PASSED'] as const;
export type AssignmentOfferUrgentReason = (typeof ASSIGNMENT_OFFER_URGENT_REASONS)[number];
/** Staff reasons for declining or releasing an assigned job. */
export const ASSIGNMENT_REASON_CODES = [
  'SCHEDULE_CONFLICT', 'ON_LEAVE', 'TOO_FAR', 'MISSING_STOCK_OR_EQUIPMENT', 'OTHER',
] as const;
export type AssignmentReasonCode = (typeof ASSIGNMENT_REASON_CODES)[number];
/** Every recorded offer close reason: Staff answers plus management closers. */
export const ASSIGNMENT_OFFER_CLOSE_REASONS = [
  ...ASSIGNMENT_REASON_CODES,
  'REASSIGNED', 'RESCHEDULED', 'CANCELLED', 'INVALIDATED', 'OFFBOARDING_TRANSFER',
  'PLANNED_WINDOW_PASSED',
] as const;
export type AssignmentOfferCloseReason = (typeof ASSIGNMENT_OFFER_CLOSE_REASONS)[number];
/** Explicit management acknowledgement when the planned start already passed. */
export const PAST_START_ACKNOWLEDGEMENT_CODES = [
  'CUSTOMER_CONFIRMED_LATER_TIME', 'CUSTOMER_WAITING', 'OTHER',
] as const;
export type PastStartAcknowledgementCode = (typeof PAST_START_ACKNOWLEDGEMENT_CODES)[number];
export type PastStartAcknowledgement = {
  code: PastStartAcknowledgementCode;
  text: string;
};

export const SUBMISSION_REQUIREMENT_CODES = [
  'CUSTOMER_ELIGIBLE', 'ASSIGNEE_ELIGIBLE', 'DELIVERY_ITEM_PRESENT',
  'DELIVERY_ITEMS_VALID', 'TASK_TITLE_VALID', 'MEETING_TIME_VALID',
  'MEETING_OUTCOME_VALID', 'MEETING_SUMMARY_PRESENT', 'UNSUCCESSFUL_REASON_PRESENT',
  'FOLLOW_UP_TIME_VALID',
  'WEEKLY_REPORT_FOUND', 'WEEKLY_DRAFT_VALID', 'WEEKLY_ANSWERS_COMPLETE',
  'WEEKLY_SOURCE_WORK_READY', 'SALE_ORIGIN_VALID', 'SALE_TIME_VALID', 'SALE_ITEM_PRESENT', 'SALE_ITEMS_VALID',
] as const;

export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export type JobCardActivityStatus = (typeof JOB_CARD_ACTIVITY_STATUSES)[number];
export type JobCardStatusFilter = (typeof JOB_CARD_STATUS_FILTERS)[number];
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];
export type JobCardType = (typeof JOB_CARD_TYPES)[number];
export type ProductiveJobCardType = (typeof PRODUCTIVE_JOB_CARD_TYPES)[number];
export type JobCardEngagementKind = (typeof JOB_CARD_ENGAGEMENT_KINDS)[number];
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];
export type UnsuccessfulVisitReasonCode = (typeof UNSUCCESSFUL_VISIT_REASON_CODES)[number];
export type MeetingDetailField = (typeof MEETING_DETAIL_FIELDS)[number];
export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };
export type RelatedName = { id: string; name: string };
export type SubmissionRequirement = {
  code: (typeof SUBMISSION_REQUIREMENT_CODES)[number];
  state: 'met' | 'missing' | 'invalid';
  field?: string;
};
export type SubmissionReadiness = {
  evaluatedAt: string;
  ready: boolean;
  items: SubmissionRequirement[];
};
export type JobLifecycleFacts = {
  createdAt: string;
  acceptedAt: string | null;
  acceptedBy: RelatedName | null;
  startedAt: string | null;
  submittedAt: string | null;
  submittedBy: RelatedName | null;
  submissionNote: string | null;
  approvedAt: string | null;
  approvedBy: RelatedName | null;
  approvalNote: string | null;
  revisionRequestedAt: string | null;
  revisionRequestedBy: RelatedName | null;
  revisionReason: string | null;
  cancelledAt: string | null;
  cancelledBy: RelatedName | null;
  cancelReason: string | null;
  cancelledFromStatus: JobCardStatus | null;
  followUpCycleEndReason?: FollowUpCycleEndReason | null;
  invalidatedAt?: string | null;
  invalidatedBy?: RelatedName | null;
  invalidationReasonCode?: JobCardInvalidationReasonCode | null;
  invalidatedFromStatus?: JobCardStatus | null;
};
export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  submitLocationCaptureEnabled: boolean;
  lifecycle: JobLifecycleFacts;
  submissionReadiness: SubmissionReadiness | null;
};
export type FollowUpSourceSummary = {
  sourceType: JobCardType;
  sourcePlannedAt: string | null;
  sourceOccurredAt: string | null;
  sourceCompletedAt: string;
  customer: RelatedName | null;
  contact: RelatedName | null;
  outcome: MeetingOutcome | null;
};
export type JobCardFollowUpContext = {
  sourceJobCardId: string;
  followUpInstructions: string;
  sourceAccess: 'FULL' | 'RESTRICTED';
  sourceJobPath: string | null;
  sourceSummary: FollowUpSourceSummary;
};
export type FollowUpProposalOrigin = 'SYSTEM' | 'STAFF_ADJUSTED';
export type FollowUpProposal = {
  scheduledAt: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  origin: FollowUpProposalOrigin;
  proposedBy: RelatedName;
};
/** Preview advisory only: the server never blocks on visit frequency and never
 * returns a same-day conflict level. Duplicates surface as 409 submit errors. */
export type CustomerScheduleLevel = 'CLEAR' | 'WARNING';
export type CustomerScheduleConflictDetail = {
  jobCardId: string;
  title: string;
  scheduledAt: string;
  type: JobCardType;
  status: string;
  assignee: RelatedName;
  jobPath: string;
};
export type RecentVisitSummary = {
  occurredAt: string;
  jobType: JobCardType;
  title: string;
  staffName: string;
  resultSummary: string | null;
};
export type CustomerScheduleEvaluation = {
  level: CustomerScheduleLevel;
  safeMessage: string | null;
  conflicts: CustomerScheduleConflictDetail[];
  recentVisit: RecentVisitSummary | null;
  suggestedAlternativeAt: string | null;
};
export type AvailableSlotsInput = {
  type: 'SALES_MEETING' | 'PRODUCT_DELIVERY';
  customerId: string;
  assignedTo: string;
  scheduledAt: string;
  scheduledEndsAt?: string;
  jobCardId?: string | null;
};
export type AvailableSlot = { startsAt: string; endsAt: string };
export type AvailableSlotsResponse = { slots: AvailableSlot[] };
export type FollowUpSuggestion = {
  scheduledAt: string | null;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  evaluation: CustomerScheduleEvaluation;
};
export type JobCard = {
  id: string; organizationId: string; organizationTimezone?: string;
  type: JobCardType; status: JobCardStatus;
  version: number; title: string; description: string | null; customerId: string | null;
  contactId: string | null; assignedTo: string; createdBy: string; priority: JobCardPriority;
  dueDate: string | null; scheduledAt: string | null; scheduledEndsAt?: string | null;
  engagementKind: JobCardEngagementKind | null;
  invalidatedAt?: string | null;
  invalidatedBy?: string | null;
  invalidationReasonCode?: JobCardInvalidationReasonCode | null;
  assignee: RelatedName;
  customer: RelatedName | null; contact: RelatedName | null; workflowContext: JobWorkflowContext;
  followUpContext: JobCardFollowUpContext | null;
  followUpProposal: FollowUpProposal | null;
  /**
   * JOB-010 §1a: the currently valid early-start authorization, or null. Only
   * a row that still matches the job's assignee and planned interval is sent.
   */
  earlyStartAuthorization: EarlyStartAuthorization | null;
  /**
   * Slice 2 advisory SUBMIT comparison of the just-completed submission.
   * Reader-gated server-side; absent (null) on plain reads. No coordinates.
   */
  submitLocationComparison: JobCardSubmitLocationComparison | null;
  /**
   * JOB-010 release 2a: the OPEN Staff change/termination request, or null.
   * Visible to management and to the assigned Staff member.
   */
  changeRequest: JobChangeRequest | null;
  /**
   * JOB-010 release 2b: the latest assignment offer of a job in the acceptance
   * window, or null. Visible to management and to the assigned Staff member.
   */
  assignmentOffer: AssignmentOffer | null;
  /**
   * OVR-5: an open (`recovered_at IS NULL AND ended_at IS NULL`)
   * LATE_START / LATE_SUBMISSION incident exists. Server-computed; the web
   * only uses it to disable Staff deadline fields and to ask management for an
   * extension reason. The backend stays the authority.
   */
  hasOpenOverdueIncident: boolean;
  /**
   * OVR-5: effective correction deadline of the current submission episode
   * (`max(original deadline, stored correction)`) when that episode was armed
   * by REQUEST_REVISION and the job is REVISION_REQUESTED / IN_PROGRESS;
   * otherwise null.
   */
  correctionDueAt: string | null;
};
/**
 * JOB-010 release 2b: one assignment offer as the server presents it. An OPEN
 * offer past its deadline arrives with `state: 'EXPIRED'`; the web never
 * compares `acceptanceDueAt` with a local clock.
 */
export type AssignmentOffer = {
  id: string;
  state: AssignmentOfferState;
  openedAt: string;
  acceptanceDueAt: string;
  urgentReason: AssignmentOfferUrgentReason | null;
  assignee: RelatedName;
};
/** JOB-010 release 2a: one open Staff change/termination request of a job. */
export type JobChangeRequest = {
  id: string;
  reasonCode: ChangeRequestReasonCode;
  reasonText: string;
  requestedAt: string;
  requestedBy: RelatedName;
};
export type EarlyStartAuthorization = {
  grantedAt: string;
  grantedBy: { id: string; name: string | null };
};
/**
 * Slice 2 safe comparison projection. Reference activity identity stays
 * server-side; viewers receive only the classification and distance.
 */
export type JobCardSubmitLocationComparison = {
  outcome: 'MATCH' | 'DIFFERENT' | 'UNRELIABLE';
  distanceMeters: number;
};
type FollowUpCreateCommon = {
  clientActionId: string;
  title: string;
  followUpInstructions: string;
  scheduledAt: string | null;
  assignedTo: string;
  priority: JobCardPriority;
  dueDate: string | null;
  contactId: string | null;
  overrideReason?: string | null;
  /** JOB-010 release 2b: sent only when the planned start already passed. */
  pastStartAcknowledgement?: PastStartAcknowledgement;
};
export type FollowUpCreateInput = FollowUpCreateCommon & (
  | { type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' }
  | { type: 'SALES_MEETING'; engagementKind: JobCardEngagementKind }
);
export type JobCardCreateInput =
  | { clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
    description?: string | null;
    priority?: JobCardPriority; dueDate?: string | null; overrideReason?: string | null;
    pastStartAcknowledgement?: PastStartAcknowledgement }
  | { clientActionId: string; type: 'GENERAL_TASK'; title: string; assignedTo: string;
    description?: string | null; customerId?: string | null; contactId?: string | null;
    priority?: JobCardPriority; dueDate?: string | null; scheduledAt?: string | null }
  | { clientActionId: string; type: 'SALES_MEETING'; title: string; customerId: string;
    assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
    engagementKind: JobCardEngagementKind;
    dueDate?: string | null; description?: string | null;
    contactId?: string | null; priority?: JobCardPriority; overrideReason?: string | null;
    pastStartAcknowledgement?: PastStartAcknowledgement };
export type ProductDeliveryCreateInput = {
  clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string;
  assignedTo: string; scheduledAt: string; scheduledEndsAt?: string;
  description?: string | null; priority?: JobCardPriority; dueDate?: string | null;
  overrideReason?: string | null; deliveryPurpose: DeliveryPurpose;
  deliveryNote?: string | null;
  items: Array<{ productId: string; quantity: number }>;
  pastStartAcknowledgement?: PastStartAcknowledgement;
};
export type PersistedJobCardListItem = {
  id: string; type: JobCardType; status: JobCardStatus; version: number; title: string;
  priority: JobCardPriority; dueDate: string | null; scheduledAt: string | null;
  scheduledEndsAt?: string | null;
  engagementKind: JobCardEngagementKind | null;
  createdAt: string; updatedAt: string; staffCompletedAt: string | null;
  customer: RelatedName | null; contact: RelatedName | null; assignee: RelatedName;
  deliveryItemCount: number;
  /**
   * Derived current-overdue snapshot. The server sends these ONLY on the
   * server-owned overdue view (`overdue=true`); they are absent on every other
   * list surface, so a missing value means "this view does not evaluate
   * lateness", never "not late".
   */
  overdueSince?: string | null;
  latenessSeconds?: number | null;
};
export type JobCardListItem = PersistedJobCardListItem & {
  allowedCommands: LifecycleCommand[];
};
export type FollowUpListItem = JobCardListItem & {
  followUp: { sourceJobCardId: string } | null;
};
export type JobCardBoard = {
  columns: Record<'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED', {
    items: JobCardListItem[]; count: number;
  }>;
  closedCounts: { COMPLETED: number; CANCELLED: number };
};
type JobCardNoteBase = {
  id: string; jobCardId: string; note: string;
  invoiceNumber: string | null; createdAt: string;
};
export type JobCardNote = JobCardNoteBase & (
  | {
      recordVersion: 0;
      author: RelatedName & { role: null; source: 'LEGACY_CURRENT' };
      workflowStage: null;
      context: null;
      relatedActivityId: null;
    }
  | {
      recordVersion: 1;
      author: RelatedName & {
        role: (typeof USER_ROLES)[number];
        source: 'SNAPSHOT';
      };
      workflowStage: JobCardStatus;
      context: JobCardOperationalNoteContext;
      relatedActivityId: string;
    }
);
export type JobCardNoteCursor = { createdAt: string; id: string };
export type JobCardNotePage = {
  items: JobCardNote[];
  limit: number;
  nextCursor: JobCardNoteCursor | null;
};
export type JobCardActivityLocation =
  | {
      outcome: 'CAPTURED';
      approximateLabel: string | null;
      accuracyMeters: number;
      capturedAt: string;
      geocodingProvider: 'GOOGLE' | null;
    }
  | { outcome: 'UNAVAILABLE'; reason: 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' | 'UNKNOWN' };
export type JobCardActivityDetails =
  | { kind: 'SALE_RELATION' }
  | { kind: 'SALE_DETAILS'; changedFields: Array<'soldAt' | 'saleContact'> }
  | { kind: 'SALE_ITEM'; operation: 'ADDED' | 'UPDATED' | 'REMOVED'; itemId: string; productName: string; quantity: string; previousQuantity: string | null }
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardActivityStatus;
      toStatus: JobCardActivityStatus;
      reason: string | null;
      startLocation?: JobCardActivityLocation;
      submitLocation?: JobCardActivityLocation;
      submitComparison?: JobCardSubmitLocationComparison;
    }
  | { kind: 'FIELDS_UPDATED'; changedFields: Array<'title' | 'description' | 'customer' | 'contact' | 'assignee' | 'priority' | 'dueDate' | 'scheduledAt' | 'scheduledEndsAt' | 'engagementKind'> }
  | { kind: 'DELIVERY_ITEM'; operation: 'ADDED' | 'UPDATED' | 'REMOVED'; itemId: string; purpose: DeliveryPurpose | null; quantity: number | null }
  | { kind: 'NOTE'; noteId: string }
  | { kind: 'MEETING_DETAILS'; changedFields: MeetingDetailField[] }
  | { kind: 'NONE' };
export type JobCardActivity = {
  id: string; jobCardId: string; eventType: string; actor: RelatedName | null;
  details: JobCardActivityDetails; createdAt: string;
};
export type DeliveryItem = {
  id: string; organizationId: string; jobCardId: string; productId: string;
  deliveryPurpose: DeliveryPurpose; deliveredAt: string | null; quantity: number; unit: string | null;
  productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null;
  lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null;
};
export type MeetingDetailsContact = { id: string; name: string; title: string | null };
export type MeetingDetails = {
  jobCardId: string; meetingAt: string | null; outcome: MeetingOutcome | null;
  unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
  meetingSummary: string | null; nextFollowUpAt: string | null;
  metContactId: string | null; metContact: MeetingDetailsContact | null;
  jobCardVersion: number;
};
export type PatchMeetingDetailsInput = {
  clientActionId: string; expectedVersion: number; meetingAt?: string | null;
  outcome?: MeetingOutcome | null; unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  meetingSummary?: string | null;
  nextFollowUpAt?: string | null;
  metContactId?: string | null;
};
export type PatchJobCardInput = {
  expectedVersion: number;
  title?: string;
  description?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  assignedTo?: string;
  priority?: JobCardPriority;
  dueDate?: string | null;
  scheduledAt?: string | null;
  scheduledEndsAt?: string | null;
  engagementKind?: JobCardEngagementKind;
  overrideReason?: string | null;
  /** JOB-010 release 2b: sent only when the planned start already passed. */
  pastStartAcknowledgement?: PastStartAcknowledgement;
  /** OVR-5 §4.5: management reason for a deadline change that ends lateness. */
  deadlineExtensionReason?: string;
  /**
   * OVR-5 §4.11: resolve the job's open JOB-010 change request inside the same
   * management deadline patch. The server validates id/state and the appended
   * schedule revision.
   */
  changeRequestResolution?: {
    changeRequestId: string;
    resolution: 'RESCHEDULED';
    note?: string | null;
  };
};

export type JobCardListFilters = Partial<{
  q: string; status: JobCardStatusFilter; type: JobCardType; assignedTo: string;
  customerId: string; priority: JobCardPriority; dueBefore: string; dueAfter: string;
  overdue: true; followUp: 'only'; limit: number; offset: number;
}>;
export type JobCardBoardFilters = Omit<JobCardListFilters, 'status' | 'offset' | 'overdue'>;
type DeliveryInput = {
  expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose;
  deliveredAt: string | null;
  quantity: number; lotNo?: string | null; serialNo?: string | null; expiryDate?: string | null;
  deliveryNote?: string | null;
};
type LifecycleInput = { clientActionId: string; expectedVersion: number };
export type JobCardInvalidationInput = {
  clientActionId: string;
  expectedVersion: number;
  reasonCode: JobCardInvalidationReasonCode;
  note?: string | null;
};
export type StartJobCardInput = LifecycleInput & { locationCapture?: StartLocationCapture };
export type SubmitJobCardInput = LifecycleInput & {
  note: string;
  followUpProposal?: FollowUpProposalInput;
  locationCapture?: ActionLocationCapture;
};
export type FollowUpProposalInput = {
  scheduledAt?: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
};

export type ApproveFollowUpInput = FollowUpProposalInput & {
  priority?: JobCardPriority;
  dueDate?: string | null;
  overrideReason?: string;
};

/**
 * Follow-up types the backend automatic proposal path currently accepts when
 * scheduledAt is omitted. Mirrors the server auto-schedule capability for UI
 * branching only; the backend remains authoritative and revalidates every
 * request. Product Delivery has a canonical duration but is NOT accepted by
 * the automatic path, and General Task has no automatic duration.
 */
export const AUTO_SCHEDULABLE_FOLLOW_UP_TYPES = ['SALES_MEETING'] as const satisfies readonly JobCardType[];

export function isAutoSchedulableFollowUpType(type: JobCardType): boolean {
  return (AUTO_SCHEDULABLE_FOLLOW_UP_TYPES as readonly string[]).includes(type);
}

export type StaffFollowUpProposalDraft = Pick<FollowUpProposalInput, 'type' | 'assignedTo' | 'followUpInstructions'>
  & { scheduledAt: string };

/**
 * Builds the Staff submit request for a follow-up proposal draft. An empty
 * scheduledAt is omitted (never sent as "") so the backend selects the
 * earliest suitable slot for auto-supported types.
 */
export function buildStaffFollowUpProposalInput(draft: StaffFollowUpProposalDraft): FollowUpProposalInput {
  return {
    ...(draft.scheduledAt ? { scheduledAt: draft.scheduledAt } : {}),
    type: draft.type,
    assignedTo: draft.assignedTo,
    followUpInstructions: draft.followUpInstructions.trim(),
  };
}

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}
function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const parsed = string(value, field);
  if (!allowed.includes(parsed as T)) invalid(field);
  return parsed as T;
}
function array(value: unknown, field: string) {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function exactObject(value: unknown, field: string, keys: readonly string[]) {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !keys.includes(key))) invalid(field);
  return parsed;
}
function count(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) invalid(field);
  return parsed;
}
/** SALE-QTY-001 public count, shared by detail and safe activity readers. */
export function parseSaleQuantity(value: unknown): string {
  const quantity = string(value, 'quantity');
  if (!/^[1-9]\d{0,8}$/.test(quantity)) invalid('quantity');
  return quantity;
}

function positiveCount(value: unknown, field: string) {
  const parsed = count(value, field);
  if (parsed < 1) invalid(field);
  return parsed;
}
function positiveFiniteNumber(value: unknown, field: string) {
  const parsed = number(value, field);
  if (parsed <= 0) invalid(field);
  return parsed;
}
function related(value: unknown, field: string): RelatedName {
  const v = object(value);
  return { id: string(v.id, `${field}.id`), name: string(v.name, `${field}.name`) };
}
function nullableRelated(value: unknown, field: string) {
  return value === null ? null : related(value, field);
}
/** Strict identity shape for DTOs whose contract pins exactly `{ id, name }`. */
function exactRelated(value: unknown, field: string): RelatedName {
  const v = exactObject(value, field, ['id', 'name']);
  return { id: string(v.id, `${field}.id`), name: string(v.name, `${field}.name`) };
}
function canonicalInstant(value: unknown, field: string) {
  const parsed = string(value, field);
  const instant = new Date(parsed);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || Number.isNaN(instant.valueOf()) || instant.toISOString() !== parsed) invalid(field);
  return parsed;
}
function nullableCanonicalInstant(value: unknown, field: string) {
  return value === null ? null : canonicalInstant(value, field);
}
function nullableCount(value: unknown, field: string) {
  return value === null ? null : count(value, field);
}
function uniqueValues<T extends string>(values: T[], field: string) {
  if (new Set(values).size !== values.length) invalid(field);
  return values;
}
function parseCancelledFromStatus(value: unknown, field: string): JobCardStatus | null {
  if (value === null) return null;
  const status = oneOf(value, field, JOB_CARD_STATUSES);
  if (status === 'COMPLETED' || status === 'CANCELLED') invalid(field);
  return status;
}
function parseInvalidatedFromStatus(value: unknown, field: string): JobCardStatus | null {
  return value === null ? null : oneOf(value, field, JOB_CARD_STATUSES);
}
function parseLifecycleFacts(value: unknown): JobLifecycleFacts {
  const v = exactObject(value, 'lifecycle', [
    'createdAt', 'acceptedAt', 'acceptedBy', 'startedAt', 'submittedAt', 'submittedBy',
    'submissionNote', 'approvedAt', 'approvedBy', 'approvalNote', 'revisionRequestedAt',
    'revisionRequestedBy', 'revisionReason', 'cancelledAt', 'cancelledBy', 'cancelReason',
    'cancelledFromStatus', 'followUpCycleEndReason', 'invalidatedAt', 'invalidatedBy', 'invalidationReasonCode',
    'invalidatedFromStatus',
  ]);
  return {
    createdAt: canonicalInstant(v.createdAt, 'createdAt'),
    acceptedAt: nullableCanonicalInstant(v.acceptedAt, 'acceptedAt'),
    acceptedBy: nullableRelated(v.acceptedBy, 'acceptedBy'),
    startedAt: nullableCanonicalInstant(v.startedAt, 'startedAt'),
    submittedAt: nullableCanonicalInstant(v.submittedAt, 'submittedAt'),
    submittedBy: nullableRelated(v.submittedBy, 'submittedBy'),
    submissionNote: nullableString(v.submissionNote, 'submissionNote'),
    approvedAt: nullableCanonicalInstant(v.approvedAt, 'approvedAt'),
    approvedBy: nullableRelated(v.approvedBy, 'approvedBy'),
    approvalNote: nullableString(v.approvalNote, 'approvalNote'),
    revisionRequestedAt: nullableCanonicalInstant(v.revisionRequestedAt, 'revisionRequestedAt'),
    revisionRequestedBy: nullableRelated(v.revisionRequestedBy, 'revisionRequestedBy'),
    revisionReason: nullableString(v.revisionReason, 'revisionReason'),
    cancelledAt: nullableCanonicalInstant(v.cancelledAt, 'cancelledAt'),
    cancelledBy: nullableRelated(v.cancelledBy, 'cancelledBy'),
    cancelReason: nullableString(v.cancelReason, 'cancelReason'),
    cancelledFromStatus: parseCancelledFromStatus(v.cancelledFromStatus, 'cancelledFromStatus'),
    followUpCycleEndReason: v.followUpCycleEndReason === undefined || v.followUpCycleEndReason === null
      ? null : oneOf(v.followUpCycleEndReason, 'followUpCycleEndReason', FOLLOW_UP_CYCLE_END_REASONS),
    invalidatedAt: v.invalidatedAt === undefined ? null : nullableCanonicalInstant(v.invalidatedAt, 'invalidatedAt'),
    invalidatedBy: v.invalidatedBy === undefined ? null : nullableRelated(v.invalidatedBy, 'invalidatedBy'),
    invalidationReasonCode: v.invalidationReasonCode === undefined || v.invalidationReasonCode === null
      ? null : oneOf(v.invalidationReasonCode, 'invalidationReasonCode', JOB_CARD_INVALIDATION_REASON_CODES),
    invalidatedFromStatus: v.invalidatedFromStatus === undefined
      ? null : parseInvalidatedFromStatus(v.invalidatedFromStatus, 'invalidatedFromStatus'),
  };
}
function parseRequirement(value: unknown): SubmissionRequirement {
  const v = object(value);
  const keys = Object.keys(v);
  if (keys.some((key) => !['code', 'state', 'field'].includes(key))) invalid('items');
  const requirement: SubmissionRequirement = {
    code: oneOf(v.code, 'code', SUBMISSION_REQUIREMENT_CODES),
    state: oneOf(v.state, 'state', ['met', 'missing', 'invalid'] as const),
  };
  if ('field' in v) requirement.field = string(v.field, 'field');
  return requirement;
}
function parseReadiness(value: unknown): SubmissionReadiness {
  const v = exactObject(value, 'submissionReadiness', ['evaluatedAt', 'ready', 'items']);
  if (typeof v.ready !== 'boolean') invalid('ready');
  const items = array(v.items, 'items').map(parseRequirement);
  uniqueValues(items.map((item) => item.code), 'items');
  return {
    evaluatedAt: canonicalInstant(v.evaluatedAt, 'evaluatedAt'),
    ready: v.ready,
    items,
  };
}
function parseWorkflowContext(value: unknown): JobWorkflowContext {
  const v = exactObject(value, 'workflowContext', [
    'allowedCommands', 'allowedActions', 'startLocationCaptureEnabled',
    'submitLocationCaptureEnabled', 'lifecycle', 'submissionReadiness',
  ]);
  const allowedCommands = uniqueValues(
    array(v.allowedCommands, 'allowedCommands').map((entry) =>
      oneOf(entry, 'allowedCommands', LIFECYCLE_COMMANDS)),
    'allowedCommands',
  );
  const allowedActions = uniqueValues(
    array(v.allowedActions, 'allowedActions').map((entry) =>
      oneOf(entry, 'allowedActions', JOB_WORKFLOW_ACTIONS)),
    'allowedActions',
  );
  return {
    allowedCommands,
    allowedActions,
    startLocationCaptureEnabled: v.startLocationCaptureEnabled === undefined
      ? false
      : boolean(v.startLocationCaptureEnabled, 'startLocationCaptureEnabled'),
    submitLocationCaptureEnabled: v.submitLocationCaptureEnabled === undefined
      ? false
      : boolean(v.submitLocationCaptureEnabled, 'submitLocationCaptureEnabled'),
    lifecycle: parseLifecycleFacts(v.lifecycle),
    submissionReadiness: v.submissionReadiness === null
      ? null
      : parseReadiness(v.submissionReadiness),
  };
}
/**
 * JOB-010 §1a early-start authorization. Strictly shaped when present; absent
 * or null means "no valid authorization" (fail-closed for the UI).
 */
function parseEarlyStartAuthorization(value: unknown): EarlyStartAuthorization | null {
  if (value === undefined || value === null) return null;
  const v = exactObject(value, 'earlyStartAuthorization', ['grantedAt', 'grantedBy']);
  const grantedBy = exactObject(v.grantedBy, 'earlyStartAuthorization.grantedBy', ['id', 'name']);
  return {
    grantedAt: canonicalInstant(v.grantedAt, 'earlyStartAuthorization.grantedAt'),
    grantedBy: {
      id: string(grantedBy.id, 'earlyStartAuthorization.grantedBy.id'),
      name: grantedBy.name === null
        ? null
        : string(grantedBy.name, 'earlyStartAuthorization.grantedBy.name'),
    },
  };
}
/**
 * Slice 2 advisory comparison. Tolerantly absent (null) on plain reads and
 * for previous backends; strictly validated when present. Distance may be
 * exactly 0 (identical snapshots), so non-negativity — not positivity — is
 * the bound. No coordinates travel here.
 */
function parseSubmitLocationComparison(value: unknown): JobCardSubmitLocationComparison | null {
  if (value === undefined || value === null) return null;
  const v = object(value);
  const outcome = oneOf(v.outcome, 'submitLocationComparison.outcome', ['MATCH', 'DIFFERENT', 'UNRELIABLE'] as const);
  const distanceMeters = v.distanceMeters;
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
    invalid('submitLocationComparison.distanceMeters');
  }
  return { outcome, distanceMeters };
}
/**
 * JOB-010 release 2a change/termination request. Tolerant of an absent field
 * (previous backends keep their old shape) but strictly shaped when present;
 * null means "no open request".
 */
function parseChangeRequest(value: unknown): JobChangeRequest | null {
  if (value === undefined || value === null) return null;
  const v = exactObject(value, 'changeRequest', [
    'id', 'reasonCode', 'reasonText', 'requestedAt', 'requestedBy',
  ]);
  return {
    id: string(v.id, 'changeRequest.id'),
    reasonCode: oneOf(v.reasonCode, 'changeRequest.reasonCode', CHANGE_REQUEST_REASON_CODES),
    reasonText: string(v.reasonText, 'changeRequest.reasonText'),
    requestedAt: canonicalInstant(v.requestedAt, 'changeRequest.requestedAt'),
    requestedBy: exactRelated(v.requestedBy, 'changeRequest.requestedBy'),
  };
}
/**
 * JOB-010 release 2b assignment offer. Tolerant of an absent field (previous
 * backends keep their old shape) but strictly shaped when present; null means
 * "this job has no offer", i.e. it is outside the acceptance window.
 */
function parseAssignmentOffer(value: unknown): AssignmentOffer | null {
  if (value === undefined || value === null) return null;
  const v = exactObject(value, 'assignmentOffer', [
    'id', 'state', 'openedAt', 'acceptanceDueAt', 'urgentReason', 'assignee',
  ]);
  return {
    id: string(v.id, 'assignmentOffer.id'),
    state: oneOf(v.state, 'assignmentOffer.state', ASSIGNMENT_OFFER_STATES),
    openedAt: canonicalInstant(v.openedAt, 'assignmentOffer.openedAt'),
    acceptanceDueAt: canonicalInstant(v.acceptanceDueAt, 'assignmentOffer.acceptanceDueAt'),
    urgentReason: v.urgentReason === null
      ? null
      : oneOf(v.urgentReason, 'assignmentOffer.urgentReason', ASSIGNMENT_OFFER_URGENT_REASONS),
    assignee: exactRelated(v.assignee, 'assignmentOffer.assignee'),
  };
}
/**
 * Only sends the past-start acknowledgement when the user actually filled it.
 * An empty acknowledgement leaves the field out of the payload so the server
 * keeps its own rule and answers 409 when it is genuinely required.
 */
export function pastStartAcknowledgementPayload(
  acknowledgement: PastStartAcknowledgement | null | undefined,
): { pastStartAcknowledgement?: PastStartAcknowledgement } {
  if (!acknowledgement) return {};
  const text = acknowledgement.text.trim();
  if (text.length === 0) return {};
  return { pastStartAcknowledgement: { code: acknowledgement.code, text } };
}
/**
 * OVR-5 detail DTO. Tolerant of an absent field (a previous backend keeps its
 * old shape) but strictly typed when present; the server sends both.
 */
function parseHasOpenOverdueIncident(value: unknown): boolean {
  return value === undefined ? false : boolean(value, 'hasOpenOverdueIncident');
}
function parseCorrectionDueAt(value: unknown): string | null {
  return value === undefined ? null : nullableCanonicalInstant(value, 'correctionDueAt');
}
function parseEngagementKind(value: unknown, type: JobCardType): JobCardEngagementKind | null {
  if (type === 'SALES_MEETING') {
    return oneOf(value, 'engagementKind', JOB_CARD_ENGAGEMENT_KINDS);
  }
  if (value !== null && value !== undefined) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Yanıtta engagementKind alanı geçersiz.');
  }
  return null;
}
function parseFollowUpSourceSummary(value: unknown): FollowUpSourceSummary {
  const v = exactObject(value, 'sourceSummary', [
    'sourceType', 'sourcePlannedAt', 'sourceOccurredAt', 'sourceCompletedAt',
    'customer', 'contact', 'outcome',
  ]);
  return {
    sourceType: oneOf(v.sourceType, 'sourceType', JOB_CARD_TYPES),
    sourcePlannedAt: nullableCanonicalInstant(v.sourcePlannedAt, 'sourcePlannedAt'),
    sourceOccurredAt: nullableCanonicalInstant(v.sourceOccurredAt, 'sourceOccurredAt'),
    sourceCompletedAt: canonicalInstant(v.sourceCompletedAt, 'sourceCompletedAt'),
    customer: nullableRelated(v.customer, 'customer'),
    contact: nullableRelated(v.contact, 'contact'),
    outcome: v.outcome === null ? null : oneOf(v.outcome, 'outcome', MEETING_OUTCOMES),
  };
}
function parseFollowUpContext(value: unknown): JobCardFollowUpContext | null {
  if (value === null) return null;
  const v = exactObject(value, 'followUpContext', [
    'sourceJobCardId', 'followUpInstructions', 'sourceAccess', 'sourceJobPath',
    'sourceSummary',
  ]);
  const sourceAccess = oneOf(v.sourceAccess, 'sourceAccess', ['FULL', 'RESTRICTED'] as const);
  const sourceJobPath = nullableString(v.sourceJobPath, 'sourceJobPath');
  if (sourceAccess === 'FULL') {
    if (!sourceJobPath || !/^\/jobs\/[^/?#]+$/.test(sourceJobPath)) invalid('sourceJobPath');
  } else if (sourceJobPath !== null) invalid('sourceJobPath');
  return {
    sourceJobCardId: string(v.sourceJobCardId, 'sourceJobCardId'),
    followUpInstructions: string(v.followUpInstructions, 'followUpInstructions'),
    sourceAccess,
    sourceJobPath,
    sourceSummary: parseFollowUpSourceSummary(v.sourceSummary),
  };
}
function parseFollowUpProposal(value: unknown): FollowUpProposal | null {
  if (value === null) return null;
  const v = exactObject(value, 'followUpProposal', [
    'scheduledAt', 'type', 'assignedTo', 'followUpInstructions', 'origin', 'proposedBy',
  ]);
  return {
    scheduledAt: canonicalInstant(v.scheduledAt, 'followUpProposal.scheduledAt'),
    type: oneOf(v.type, 'followUpProposal.type', JOB_CARD_TYPES),
    assignedTo: string(v.assignedTo, 'followUpProposal.assignedTo'),
    followUpInstructions: string(v.followUpInstructions, 'followUpProposal.followUpInstructions'),
    origin: oneOf(v.origin, 'followUpProposal.origin', ['SYSTEM', 'STAFF_ADJUSTED'] as const),
    proposedBy: related(v.proposedBy, 'followUpProposal.proposedBy'),
  };
}
function parseCustomerScheduleEvaluation(value: unknown): CustomerScheduleEvaluation {
  const v = exactObject(value, 'evaluation', [
    'level', 'safeMessage', 'conflicts', 'recentVisit', 'suggestedAlternativeAt',
  ]);
  return {
    level: oneOf(v.level, 'evaluation.level', ['CLEAR', 'WARNING'] as const),
    safeMessage: nullableString(v.safeMessage, 'evaluation.safeMessage'),
    conflicts: array(v.conflicts, 'evaluation.conflicts').map((entry) => {
      const c = exactObject(entry, 'conflict', [
        'jobCardId', 'title', 'scheduledAt', 'type', 'status', 'assignee', 'jobPath',
      ]);
      return {
        jobCardId: string(c.jobCardId, 'conflict.jobCardId'),
        title: string(c.title, 'conflict.title'),
        scheduledAt: canonicalInstant(c.scheduledAt, 'conflict.scheduledAt'),
        type: oneOf(c.type, 'conflict.type', JOB_CARD_TYPES),
        status: string(c.status, 'conflict.status'),
        assignee: related(c.assignee, 'conflict.assignee'),
        jobPath: string(c.jobPath, 'conflict.jobPath'),
      };
    }),
    recentVisit: v.recentVisit === null ? null : (() => {
      const r = exactObject(v.recentVisit, 'recentVisit', [
        'occurredAt', 'jobType', 'title', 'staffName', 'resultSummary',
      ]);
      return {
        occurredAt: canonicalInstant(r.occurredAt, 'recentVisit.occurredAt'),
        jobType: oneOf(r.jobType, 'recentVisit.jobType', JOB_CARD_TYPES),
        title: string(r.title, 'recentVisit.title'),
        staffName: string(r.staffName, 'recentVisit.staffName'),
        resultSummary: nullableString(r.resultSummary, 'recentVisit.resultSummary'),
      };
    })(),
    suggestedAlternativeAt: nullableCanonicalInstant(
      v.suggestedAlternativeAt,
      'evaluation.suggestedAlternativeAt',
    ),
  };
}

function parseAvailableSlotsResponse(value: unknown): AvailableSlotsResponse {
  const root = exactObject(value, 'availableSlots', ['slots']);
  if (!Array.isArray(root.slots)) invalid('slots');
  return {
    slots: root.slots.map((raw, index) => {
      const slot = exactObject(raw, `slots[${index}]`, ['startsAt', 'endsAt']);
      const startsAt = canonicalInstant(slot.startsAt, `slots[${index}].startsAt`);
      const endsAt = canonicalInstant(slot.endsAt, `slots[${index}].endsAt`);
      if (Date.parse(endsAt) <= Date.parse(startsAt)) invalid(`slots[${index}]`);
      return { startsAt, endsAt };
    }),
  };
}
export function parseFollowUpSuggestion(value: unknown): FollowUpSuggestion {
  const v = exactObject(value, 'followUpSuggestion', [
    'scheduledAt', 'type', 'assignedTo', 'followUpInstructions', 'evaluation',
  ]);
  return {
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    type: oneOf(v.type, 'type', JOB_CARD_TYPES),
    assignedTo: string(v.assignedTo, 'assignedTo'),
    followUpInstructions: string(v.followUpInstructions, 'followUpInstructions'),
    evaluation: parseCustomerScheduleEvaluation(v.evaluation),
  };
}
function parseJobCard(value: unknown): JobCard {
  const v = object(value);
  if ('sourceJobCardId' in v || 'followUpInstructions' in v) invalid('jobCard');
  if (!('followUpContext' in v)) invalid('followUpContext');
  const type = oneOf(v.type, 'type', JOB_CARD_TYPES);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    ...(v.organizationTimezone === undefined ? {} : {
      organizationTimezone: string(v.organizationTimezone, 'organizationTimezone'),
    }),
    type,
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), version: positiveCount(v.version, 'version'),
    title: string(v.title, 'title'), description: nullableString(v.description, 'description'),
    customerId: nullableString(v.customerId, 'customerId'), contactId: nullableString(v.contactId, 'contactId'),
    assignedTo: string(v.assignedTo, 'assignedTo'), createdBy: string(v.createdBy, 'createdBy'),
    priority: oneOf(v.priority, 'priority', JOB_CARD_PRIORITIES), dueDate: nullableString(v.dueDate, 'dueDate'),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    ...(v.scheduledEndsAt === undefined ? {} : {
      scheduledEndsAt: nullableCanonicalInstant(v.scheduledEndsAt, 'scheduledEndsAt'),
    }),
    engagementKind: parseEngagementKind(v.engagementKind, type),
    invalidatedAt: v.invalidatedAt === undefined ? null : nullableCanonicalInstant(v.invalidatedAt, 'invalidatedAt'),
    invalidatedBy: v.invalidatedBy === undefined || v.invalidatedBy === null ? null : string(v.invalidatedBy, 'invalidatedBy'),
    invalidationReasonCode: v.invalidationReasonCode === undefined || v.invalidationReasonCode === null
      ? null : oneOf(v.invalidationReasonCode, 'invalidationReasonCode', JOB_CARD_INVALIDATION_REASON_CODES),
    assignee: related(v.assignee, 'assignee'), customer: nullableRelated(v.customer, 'customer'),
    contact: nullableRelated(v.contact, 'contact'),
    workflowContext: parseWorkflowContext(v.workflowContext),
    followUpContext: parseFollowUpContext(v.followUpContext),
    followUpProposal: 'followUpProposal' in v
      ? parseFollowUpProposal(v.followUpProposal)
      : null,
    earlyStartAuthorization: parseEarlyStartAuthorization(v.earlyStartAuthorization),
    submitLocationComparison: parseSubmitLocationComparison(v.submitLocationComparison),
    changeRequest: parseChangeRequest(v.changeRequest),
    assignmentOffer: parseAssignmentOffer(v.assignmentOffer),
    hasOpenOverdueIncident: parseHasOpenOverdueIncident(v.hasOpenOverdueIncident),
    correctionDueAt: parseCorrectionDueAt(v.correctionDueAt),
  };
}
export function parsePersistedJobCardListItem(value: unknown): PersistedJobCardListItem {
  const v = object(value);
  const type = oneOf(v.type, 'type', JOB_CARD_TYPES);
  return {
    id: string(v.id, 'id'), type,
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), version: positiveCount(v.version, 'version'),
    title: string(v.title, 'title'), priority: oneOf(v.priority, 'priority', JOB_CARD_PRIORITIES),
    dueDate: nullableString(v.dueDate, 'dueDate'),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    ...(v.scheduledEndsAt === undefined ? {} : {
      scheduledEndsAt: nullableCanonicalInstant(v.scheduledEndsAt, 'scheduledEndsAt'),
    }),
    engagementKind: parseEngagementKind(v.engagementKind, type),
    createdAt: string(v.createdAt, 'createdAt'),
    updatedAt: string(v.updatedAt, 'updatedAt'), staffCompletedAt: nullableString(v.staffCompletedAt, 'staffCompletedAt'),
    customer: nullableRelated(v.customer, 'customer'), contact: nullableRelated(v.contact, 'contact'),
    assignee: related(v.assignee, 'assignee'), deliveryItemCount: count(v.deliveryItemCount, 'deliveryItemCount'),
    ...(v.overdueSince === undefined ? {} : {
      overdueSince: nullableCanonicalInstant(v.overdueSince, 'overdueSince'),
    }),
    ...(v.latenessSeconds === undefined ? {} : {
      latenessSeconds: nullableCount(v.latenessSeconds, 'latenessSeconds'),
    }),
  };
}
export function parseJobCardListItem(value: unknown): JobCardListItem {
  const v = object(value);
  return {
    ...parsePersistedJobCardListItem(value),
    allowedCommands: uniqueValues(
      array(v.allowedCommands, 'allowedCommands').map((entry) =>
        oneOf(entry, 'allowedCommands', LIFECYCLE_COMMANDS)),
      'allowedCommands',
    ),
  };
}
export function parseFollowUpListItem(value: unknown): FollowUpListItem {
  const v = object(value);
  const followUp = v.followUp === null ? null : exactObject(v.followUp, 'followUp', ['sourceJobCardId']);
  return {
    ...parseJobCardListItem(value),
    followUp: followUp === null
      ? null
      : { sourceJobCardId: string(followUp.sourceJobCardId, 'sourceJobCardId') },
  };
}
function parsePage<T>(value: unknown, parser: (entry: unknown) => T): Paginated<T> {
  const v = object(value);
  return {
    items: items(v).map(parser), total: count(v.total, 'total'),
    limit: positiveCount(v.limit, 'limit'), offset: count(v.offset, 'offset'),
  };
}
function parseColumn(value: unknown) {
  const v = object(value);
  return { items: array(v.items, 'items').map(parseJobCardListItem), count: count(v.count, 'count') };
}
function parseBoard(value: unknown): JobCardBoard {
  const v = object(value); const columns = object(v.columns); const closed = object(v.closedCounts);
  return {
    columns: {
      NEW: parseColumn(columns.NEW), ACCEPTED: parseColumn(columns.ACCEPTED),
      IN_PROGRESS: parseColumn(columns.IN_PROGRESS), WAITING_APPROVAL: parseColumn(columns.WAITING_APPROVAL),
      REVISION_REQUESTED: parseColumn(columns.REVISION_REQUESTED),
    },
    closedCounts: { COMPLETED: count(closed.COMPLETED, 'COMPLETED'), CANCELLED: count(closed.CANCELLED, 'CANCELLED') },
  };
}
function parseNote(value: unknown): JobCardNote {
  const v = object(value);
  const base = {
    id: string(v.id, 'id'),
    jobCardId: string(v.jobCardId, 'jobCardId'),
    note: string(v.note, 'note'),
    invoiceNumber: v.invoiceNumber === null || v.invoiceNumber === undefined
      ? null : string(v.invoiceNumber, 'invoiceNumber'),
    createdAt: string(v.createdAt, 'createdAt'),
  };
  const author = object(v.author);
  const identity = {
    id: string(author.id, 'author.id'),
    name: string(author.name, 'author.name'),
  };
  if (v.recordVersion === undefined || v.recordVersion === 0) {
    return {
      ...base,
      recordVersion: 0,
      author: { ...identity, role: null, source: 'LEGACY_CURRENT' },
      workflowStage: null,
      context: null,
      relatedActivityId: null,
    };
  }
  if (v.recordVersion !== 1) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Not kayıt sürümü geçersiz.');
  }
  return {
    ...base,
    recordVersion: 1,
    author: {
      ...identity,
      role: oneOf(author.role, 'author.role', USER_ROLES),
      source: oneOf(author.source, 'author.source', ['SNAPSHOT'] as const),
    },
    workflowStage: oneOf(v.workflowStage, 'workflowStage', JOB_CARD_STATUSES),
    context: oneOf(v.context, 'context', JOB_CARD_OPERATIONAL_NOTE_CONTEXTS),
    relatedActivityId: string(v.relatedActivityId, 'relatedActivityId'),
  };
}

function parseNotePage(value: unknown): JobCardNotePage {
  const v = object(value);
  const cursor = v.nextCursor === null ? null : object(v.nextCursor);
  return {
    items: items(v).map(parseNote),
    limit: positiveCount(v.limit, 'limit'),
    nextCursor: cursor === null
      ? null
      : {
          createdAt: string(cursor.createdAt, 'nextCursor.createdAt'),
          id: string(cursor.id, 'nextCursor.id'),
        },
  };
}
function parseDetails(value: unknown): JobCardActivityDetails {
  const v = object(value); const kind = string(v.kind, 'details.kind');
  if (kind === 'NONE' || kind === 'SALE_RELATION') return { kind };
  if (kind === 'SALE_DETAILS') return { kind, changedFields: array(v.changedFields, 'changedFields').map((field) => oneOf(field, 'changedFields', ['soldAt', 'saleContact'] as const)) };
  if (kind === 'SALE_ITEM') return { kind, operation: oneOf(v.operation, 'operation', ['ADDED', 'UPDATED', 'REMOVED'] as const), itemId: string(v.itemId, 'itemId'), productName: string(v.productName, 'productName'), quantity: parseSaleQuantity(v.quantity), previousQuantity: v.previousQuantity === null ? null : parseSaleQuantity(v.previousQuantity) };
  if (kind === 'STATUS_TRANSITION') {
    const detail = exactObject(v, 'details', [
      'kind', 'fromStatus', 'toStatus', 'reason', 'startLocation', 'submitLocation',
      'submitComparison',
    ]);
    const parseActionLocation = (field: 'startLocation' | 'submitLocation') => {
      const raw = detail[field];
      if (raw === undefined) return undefined;
      const location = object(raw);
      const outcome = oneOf(location.outcome, `${field}.outcome`, ['CAPTURED', 'UNAVAILABLE'] as const);
      if (outcome === 'CAPTURED') {
        const captured = exactObject(location, field, [
          'outcome', 'approximateLabel', 'accuracyMeters', 'capturedAt', 'geocodingProvider',
        ]);
        const provider = captured.geocodingProvider === null
          ? null
          : oneOf(captured.geocodingProvider, 'geocodingProvider', ['GOOGLE'] as const);
        return {
          outcome,
          approximateLabel: nullableString(captured.approximateLabel, 'approximateLabel'),
          accuracyMeters: positiveFiniteNumber(captured.accuracyMeters, 'accuracyMeters'),
          capturedAt: canonicalInstant(captured.capturedAt, 'capturedAt'),
          geocodingProvider: provider,
        } as const;
      }
      const unavailable = exactObject(location, field, ['outcome', 'reason']);
      return {
        outcome,
        reason: oneOf(unavailable.reason, 'reason', [
          'PERMISSION_DENIED', 'POSITION_UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED', 'UNKNOWN',
        ] as const),
      } as const;
    };
    const startLocation = parseActionLocation('startLocation');
    const submitLocation = parseActionLocation('submitLocation');
    // Slice 2: tolerantly absent on plain reads and previous backends.
    const submitComparison = parseSubmitLocationComparison(detail.submitComparison);
    return {
      kind,
      fromStatus: oneOf(detail.fromStatus, 'fromStatus', JOB_CARD_ACTIVITY_STATUSES),
      toStatus: oneOf(detail.toStatus, 'toStatus', JOB_CARD_ACTIVITY_STATUSES),
      reason: nullableString(detail.reason, 'reason'),
      ...(startLocation ? { startLocation } : {}),
      ...(submitLocation ? { submitLocation } : {}),
      ...(submitComparison ? { submitComparison } : {}),
    };
  }
  if (kind === 'FIELDS_UPDATED') return { kind, changedFields: array(v.changedFields, 'changedFields').map((field) =>
    oneOf(field, 'changedFields', ['title', 'description', 'customer', 'contact', 'assignee', 'priority', 'dueDate', 'scheduledAt', 'scheduledEndsAt', 'engagementKind'] as const)) };
  if (kind === 'DELIVERY_ITEM') return { kind,
    operation: oneOf(v.operation, 'operation', ['ADDED', 'UPDATED', 'REMOVED'] as const),
    itemId: string(v.itemId, 'itemId'),
    purpose: v.purpose === null ? null : oneOf(v.purpose, 'purpose', DELIVERY_PURPOSES),
    quantity: v.quantity === null ? null : positiveFiniteNumber(v.quantity, 'quantity') };
  if (kind === 'NOTE') return { kind, noteId: string(v.noteId, 'noteId') };
  if (kind === 'MEETING_DETAILS') {
    const detail = exactObject(v, 'details', ['kind', 'changedFields']);
    const changedFields = array(detail.changedFields, 'changedFields').map((field) =>
      oneOf(field, 'changedFields', MEETING_DETAIL_FIELDS));
    if (changedFields.length === 0 || changedFields.some((field, index) =>
      MEETING_DETAIL_FIELDS.indexOf(field) <= (index === 0
        ? -1 : MEETING_DETAIL_FIELDS.indexOf(changedFields[index - 1]!)))) invalid('changedFields');
    return { kind, changedFields };
  }
  return invalid('details.kind');
}
const RAW_ACTIVITY_KEYS = ['oldValue', 'newValue', 'metadata', 'clientActionId', 'actorId'];
function parseActivity(value: unknown): JobCardActivity {
  const v = object(value);
  if (RAW_ACTIVITY_KEYS.some((key) => key in v)) invalid('activity');
  return { id: string(v.id, 'id'), jobCardId: string(v.jobCardId, 'jobCardId'),
    eventType: string(v.eventType, 'eventType'), actor: nullableRelated(v.actor, 'actor'),
    details: parseDetails(v.details), createdAt: string(v.createdAt, 'createdAt') };
}
function parseDelivery(value: unknown): DeliveryItem {
  const v = object(value);
  return { id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    jobCardId: string(v.jobCardId, 'jobCardId'), productId: string(v.productId, 'productId'),
    deliveryPurpose: oneOf(v.deliveryPurpose, 'deliveryPurpose', DELIVERY_PURPOSES),
    deliveredAt: v.deliveredAt === null ? null : string(v.deliveredAt, 'deliveredAt'),
    quantity: positiveFiniteNumber(v.quantity, 'quantity'),
    unit: nullableString(v.unit, 'unit'), productNameSnapshot: string(v.productNameSnapshot, 'productNameSnapshot'),
    productSkuSnapshot: nullableString(v.productSkuSnapshot, 'productSkuSnapshot'),
    productModelSnapshot: nullableString(v.productModelSnapshot, 'productModelSnapshot'),
    lotNo: nullableString(v.lotNo, 'lotNo'), serialNo: nullableString(v.serialNo, 'serialNo'),
    expiryDate: nullableString(v.expiryDate, 'expiryDate'), deliveryNote: nullableString(v.deliveryNote, 'deliveryNote') };
}
function parseDeliveryMutation(value: unknown) {
  const v = object(value);
  return { item: parseDelivery(v.item), jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion') };
}
function parseProductDeliveryCreate(value: unknown) {
  const v = exactObject(value, 'productDeliveryCreate', ['jobCardId', 'version']);
  return { jobCardId: string(v.jobCardId, 'jobCardId'), version: positiveCount(v.version, 'version') };
}
function parseMeetingContact(value: unknown): MeetingDetailsContact | null {
  if (value === null) return null;
  const v = exactObject(value, 'meetingDetails.metContact', ['id', 'name', 'title']);
  return {
    id: string(v.id, 'meetingDetails.metContact.id'),
    name: string(v.name, 'meetingDetails.metContact.name'),
    title: nullableString(v.title, 'meetingDetails.metContact.title'),
  };
}
export function parseMeetingDetails(value: unknown): MeetingDetails {
  const v = exactObject(value, 'meetingDetails', [
    'jobCardId', 'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt',
    'metContactId', 'metContact', 'jobCardVersion',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    meetingAt: nullableCanonicalInstant(v.meetingAt, 'meetingAt'),
    outcome: v.outcome === null ? null : oneOf(v.outcome, 'outcome', MEETING_OUTCOMES),
    unsuccessfulReason: v.unsuccessfulReason === undefined || v.unsuccessfulReason === null
      ? null
      : oneOf(v.unsuccessfulReason, 'unsuccessfulReason', UNSUCCESSFUL_VISIT_REASON_CODES),
    meetingSummary: nullableString(v.meetingSummary, 'meetingSummary'),
    nextFollowUpAt: nullableCanonicalInstant(v.nextFollowUpAt, 'nextFollowUpAt'),
    metContactId: nullableString(v.metContactId, 'metContactId'),
    metContact: parseMeetingContact(v.metContact),
    jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion'),
  };
}
function query(filters: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
  const encoded = params.toString(); return encoded ? `?${encoded}` : '';
}
const segment = (value: string) => encodeURIComponent(value);
const jobPath = (id: string) => `/api/job-cards/${segment(id)}`;

export const listJobCards = async (filters: JobCardListFilters = {}) => parsePage(
  await request(`/api/job-cards${query(filters)}`), parseJobCardListItem,
);
export const getJobCardBoard = async (filters: JobCardBoardFilters = {}) =>
  parseBoard(await request(`/api/job-cards/board${query(filters)}`));
export const listJobCardBoard = getJobCardBoard;
/**
 * Slice 1 reader gate: the backend only serializes the SUBMIT capability flag
 * for readers that explicitly opt in, so previous bundles (strict response
 * parsers) keep receiving the shape they understand. This bundle always opts
 * in on the detail screens that can submit.
 */
export const getJobCard = async (id: string, options: { includeSubmitLocationCapability?: boolean } = {}) =>
  parseJobCard(await request(`${jobPath(id)}${query({
    includeSubmitLocationCapability: options.includeSubmitLocationCapability === true ? 'true' : undefined,
  })}`));
export const createJobCard = async (input: JobCardCreateInput) =>
  parseJobCard(await request('/api/job-cards', json('POST', input)));
export const createProductDelivery = async (input: ProductDeliveryCreateInput) =>
  parseProductDeliveryCreate(await request('/api/job-cards/product-deliveries', json('POST', input)));
export const createFollowUp = async (sourceId: string, input: FollowUpCreateInput) =>
  parseJobCard(await request(`${jobPath(sourceId)}/follow-ups`, json('POST', input)));
export const listFollowUps = async (
  sourceId: string,
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`${jobPath(sourceId)}/follow-ups${query(page)}`),
  parseFollowUpListItem,
);
export const patchJobCard = async (id: string, input: PatchJobCardInput): Promise<JobCard & { assignmentTransitionId: string | null }> => {
  const raw = await request(jobPath(id), json('PATCH', input));
  const parsed = parseJobCard(raw);
  const v = raw as Record<string, unknown>;
  return {
    ...parsed,
    assignmentTransitionId: typeof v.assignmentTransitionId === 'string'
      ? v.assignmentTransitionId
      : null,
  };
};
/**
 * Slice 3 reader gate: the backend only serializes `metContactId`/`metContact`
 * for readers that explicitly opt in, so previous bundles (strict response
 * parsers) keep receiving the shape they understand. This bundle always opts
 * in on both meeting-details reads and writes.
 */
export const getMeetingDetails = async (id: string) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details${query({
    includeMetContactCapability: 'true',
  })}`));
export const patchMeetingDetails = async (id: string, input: PatchMeetingDetailsInput) =>
  parseMeetingDetails(await request(`${jobPath(id)}/meeting-details${query({
    includeMetContactCapability: 'true',
  })}`, json('PATCH', input)));

export const listJobCardNotes = async (
  id: string,
  page: Partial<{ limit: number; before: JobCardNoteCursor | null }> = {},
) => parseNotePage(await request(`${jobPath(id)}/notes${query({
  limit: page.limit,
  beforeCreatedAt: page.before?.createdAt,
  beforeId: page.before?.id,
})}`));
export const addJobCardNote = async (id: string, input: {
  clientActionId: string; note: string; invoiceNumber?: string;
}) =>
  parseNote(await request(`${jobPath(id)}/notes`, json('POST', input)));
export const listActivity = async (id: string, page: Partial<{ limit: number; offset: number }> = {}) =>
  parsePage(await request(`${jobPath(id)}/activity${query({
    ...page,
    // Slice 2/3 reader gates: only opted-in readers receive the advisory
    // SUBMIT comparison evidence and the Slice 3 met-contact chip; previous
    // bundles keep the old shape.
    includeSubmitLocationCapability: 'true',
    includeMetContactCapability: 'true',
  })}`), parseActivity);
export const listJobCardActivity = listActivity;

/**
 * OVR-4 server-owned open LATE_SUBMISSION snapshot. `elapsedSeconds` is a
 * server-computed request-clock value: the client renders it verbatim and
 * never derives domain time from its own clock.
 */
export type SubmissionLatenessSnapshot = {
  open: null | {
    incidentId: string;
    delayType: 'LATE_SUBMISSION';
    episodeNo: number;
    scheduleRevisionNo: number;
    deadlineAt: string;
    breachedAt: string;
    elapsedSeconds: number;
    accountableUser: RelatedName | null;
    accountableRole: 'STAFF' | 'MANAGEMENT';
    staffReminderSentAt: string | null;
    escalationSentAt: string | null;
    manualReminderSentAt: string | null;
    manualReminderCount: number;
    /**
     * JOB-010 release 2a: when the job's OPEN change request started, so the
     * management wait is visible on the lateness snapshot. Null when none.
     */
    changeRequestOpenSince: string | null;
  };
};

function parseSubmissionLateness(value: unknown): SubmissionLatenessSnapshot {
  const v = exactObject(value, 'submissionLateness', ['open']);
  if (v.open === null) return { open: null };
  const item = exactObject(v.open, 'open', [
    'incidentId', 'delayType', 'episodeNo', 'scheduleRevisionNo', 'deadlineAt',
    'breachedAt', 'elapsedSeconds', 'accountableUser', 'accountableRole',
    'staffReminderSentAt', 'escalationSentAt', 'manualReminderSentAt',
    'manualReminderCount', 'changeRequestOpenSince',
  ]);
  return {
    open: {
      incidentId: string(item.incidentId, 'open.incidentId'),
      delayType: oneOf(item.delayType, 'open.delayType', ['LATE_SUBMISSION'] as const),
      episodeNo: positiveCount(item.episodeNo, 'open.episodeNo'),
      scheduleRevisionNo: positiveCount(item.scheduleRevisionNo, 'open.scheduleRevisionNo'),
      deadlineAt: canonicalInstant(item.deadlineAt, 'open.deadlineAt'),
      breachedAt: canonicalInstant(item.breachedAt, 'open.breachedAt'),
      elapsedSeconds: count(item.elapsedSeconds, 'open.elapsedSeconds'),
      accountableUser: nullableRelated(item.accountableUser, 'open.accountableUser'),
      accountableRole: oneOf(item.accountableRole, 'open.accountableRole', ['STAFF', 'MANAGEMENT'] as const),
      staffReminderSentAt: nullableCanonicalInstant(item.staffReminderSentAt, 'open.staffReminderSentAt'),
      escalationSentAt: nullableCanonicalInstant(item.escalationSentAt, 'open.escalationSentAt'),
      manualReminderSentAt: nullableCanonicalInstant(item.manualReminderSentAt, 'open.manualReminderSentAt'),
      manualReminderCount: count(item.manualReminderCount, 'open.manualReminderCount'),
      changeRequestOpenSince: item.changeRequestOpenSince === undefined
        ? null
        : nullableCanonicalInstant(item.changeRequestOpenSince, 'open.changeRequestOpenSince'),
    },
  };
}

export const getSubmissionLateness = async (id: string) =>
  parseSubmissionLateness(await request(`${jobPath(id)}/submission-lateness`));

export type SubmissionReminderReceipt = {
  jobCardId: string;
  reminderId: string;
  sentAt: string;
};

export const sendSubmissionReminder = async (
  id: string,
  input: { clientActionId: string; expectedVersion: number },
) => {
  const v = exactObject(
    await request(`${jobPath(id)}/submission-reminder`, json('POST', input)),
    'reminder',
    ['jobCardId', 'reminderId', 'sentAt'],
  );
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    reminderId: string(v.reminderId, 'reminderId'),
    sentAt: canonicalInstant(v.sentAt, 'sentAt'),
  } satisfies SubmissionReminderReceipt;
};

export type EarlyStartAuthorizationReceipt = {
  jobCardId: string;
  authorizationId: string;
  grantedAt: string;
};

/**
 * JOB-010 §1a manager-only early-start authorization. Version-checked and
 * idempotent server-side; the caller refreshes the detail afterwards.
 */
export const grantEarlyStartAuthorization = async (
  id: string,
  input: { clientActionId: string; expectedVersion: number },
) => {
  const v = exactObject(
    await request(`${jobPath(id)}/early-start-authorization`, json('POST', input)),
    'earlyStartAuthorization',
    ['jobCardId', 'authorizationId', 'grantedAt'],
  );
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    authorizationId: string(v.authorizationId, 'authorizationId'),
    grantedAt: canonicalInstant(v.grantedAt, 'grantedAt'),
  } satisfies EarlyStartAuthorizationReceipt;
};

/**
 * JOB-010 release 2a: Staff change/termination request lifecycle on a job.
 * The server owns authorization, idempotency and every state rule; these
 * functions only shape the transport and reject non-contract responses.
 */
export type CreateChangeRequestInput = {
  clientActionId: string;
  reasonCode: ChangeRequestReasonCode;
  reasonText: string;
};
export type CreateChangeRequestReceipt = {
  jobCardId: string;
  changeRequestId: string;
  requestedAt: string;
};
export const createChangeRequest = async (id: string, input: CreateChangeRequestInput) => {
  const v = exactObject(
    await request(`${jobPath(id)}/change-requests`, json('POST', input)),
    'changeRequest',
    ['jobCardId', 'changeRequestId', 'requestedAt'],
  );
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    changeRequestId: string(v.changeRequestId, 'changeRequestId'),
    requestedAt: canonicalInstant(v.requestedAt, 'requestedAt'),
  } satisfies CreateChangeRequestReceipt;
};

export type ResolveChangeRequestInput = {
  clientActionId: string;
  resolution: ChangeRequestResolution;
  /** Required by the server for REJECTED. */
  note?: string | null;
  /** Required by the server for LINKED_JOB_CREATED. */
  linkedJobCardId?: string | null;
};
export type ResolveChangeRequestReceipt = {
  jobCardId: string;
  changeRequestId: string;
  resolution: ChangeRequestResolution;
  resolvedAt: string;
};
export const resolveChangeRequest = async (
  id: string,
  requestId: string,
  input: ResolveChangeRequestInput,
) => {
  const v = exactObject(
    await request(
      `${jobPath(id)}/change-requests/${segment(requestId)}/resolve`,
      json('POST', input),
    ),
    'changeRequest',
    ['jobCardId', 'changeRequestId', 'resolution', 'resolvedAt'],
  );
  const receipt = {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    changeRequestId: string(v.changeRequestId, 'changeRequestId'),
    resolution: oneOf(v.resolution, 'resolution', CHANGE_REQUEST_RESOLUTIONS),
    resolvedAt: canonicalInstant(v.resolvedAt, 'resolvedAt'),
  } satisfies ResolveChangeRequestReceipt;
  if (receipt.jobCardId !== id
    || receipt.changeRequestId !== requestId
    || receipt.resolution !== input.resolution) invalid('changeRequest');
  return receipt;
};

/** Management list item: one OPEN Staff request, oldest first. */
export type OpenChangeRequestItem = {
  changeRequestId: string;
  jobCardId: string;
  jobTitle: string;
  jobType: JobCardType;
  jobStatus: JobCardStatus;
  reasonCode: ChangeRequestReasonCode;
  reasonText: string;
  requestedAt: string;
  requestedBy: RelatedName;
  customer: RelatedName | null;
  jobPath: string;
};
function parseOpenChangeRequestItem(value: unknown): OpenChangeRequestItem {
  const v = exactObject(value, 'changeRequest', [
    'changeRequestId', 'jobCardId', 'jobTitle', 'jobType', 'jobStatus', 'reasonCode',
    'reasonText', 'requestedAt', 'requestedBy', 'customer', 'jobPath',
  ]);
  return {
    changeRequestId: string(v.changeRequestId, 'changeRequestId'),
    jobCardId: string(v.jobCardId, 'jobCardId'),
    jobTitle: string(v.jobTitle, 'jobTitle'),
    jobType: oneOf(v.jobType, 'jobType', JOB_CARD_TYPES),
    jobStatus: oneOf(v.jobStatus, 'jobStatus', JOB_CARD_STATUSES),
    reasonCode: oneOf(v.reasonCode, 'reasonCode', CHANGE_REQUEST_REASON_CODES),
    reasonText: string(v.reasonText, 'reasonText'),
    requestedAt: canonicalInstant(v.requestedAt, 'requestedAt'),
    requestedBy: exactRelated(v.requestedBy, 'requestedBy'),
    customer: nullableRelated(v.customer, 'customer'),
    jobPath: string(v.jobPath, 'jobPath'),
  };
}
export const listOpenChangeRequests = async (
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`/api/job-cards/change-requests/open${query(page)}`),
  parseOpenChangeRequestItem,
);

/**
 * JOB-010 release 2b management list item: a `NEW` job whose latest assignment
 * offer needs a management answer, oldest deadline first.
 */
export type AssignmentOfferNeedingActionItem = {
  jobCardId: string;
  jobTitle: string;
  jobType: JobCardType;
  offerId: string;
  state: AssignmentOfferState;
  closeReason: AssignmentOfferCloseReason | null;
  closeText: string | null;
  acceptanceDueAt: string;
  urgentReason: AssignmentOfferUrgentReason | null;
  scheduledAt: string | null;
  assignee: RelatedName;
  customer: RelatedName | null;
  jobPath: string;
};
function parseAssignmentOfferNeedingActionItem(value: unknown): AssignmentOfferNeedingActionItem {
  const v = exactObject(value, 'assignmentOffer', [
    'jobCardId', 'jobTitle', 'jobType', 'offerId', 'state', 'closeReason', 'closeText',
    'acceptanceDueAt', 'urgentReason', 'scheduledAt', 'assignee', 'customer', 'jobPath',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    jobTitle: string(v.jobTitle, 'jobTitle'),
    jobType: oneOf(v.jobType, 'jobType', JOB_CARD_TYPES),
    offerId: string(v.offerId, 'offerId'),
    state: oneOf(v.state, 'state', ASSIGNMENT_OFFER_STATES),
    closeReason: v.closeReason === null
      ? null
      : oneOf(v.closeReason, 'closeReason', ASSIGNMENT_OFFER_CLOSE_REASONS),
    closeText: nullableString(v.closeText, 'closeText'),
    acceptanceDueAt: canonicalInstant(v.acceptanceDueAt, 'acceptanceDueAt'),
    urgentReason: v.urgentReason === null
      ? null
      : oneOf(v.urgentReason, 'urgentReason', ASSIGNMENT_OFFER_URGENT_REASONS),
    scheduledAt: nullableCanonicalInstant(v.scheduledAt, 'scheduledAt'),
    assignee: exactRelated(v.assignee, 'assignee'),
    customer: nullableRelated(v.customer, 'customer'),
    jobPath: string(v.jobPath, 'jobPath'),
  };
}
export const listAssignmentOffersNeedingAction = async (
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`/api/job-cards/assignment-offers/needs-action${query(page)}`),
  parseAssignmentOfferNeedingActionItem,
);

/**
 * OVR-6 §6 management list item: a `NEW` job whose planned start has passed
 * and whose latest JOB-010 offer does not place it with the offer flow. The
 * ownership matrix is decided by the server; this shape only carries the read.
 */
export type UnacceptedPastStartItem = {
  jobCardId: string;
  title: string;
  type: JobCardType;
  jobPath: string;
  assignee: { id: string; name: string; active: boolean };
  scheduledAt: string;
  elapsedSeconds: number;
  hasOpenChangeRequest: boolean;
};

function parseUnacceptedPastStartAssignee(value: unknown) {
  const v = exactObject(value, 'assignee', ['id', 'name', 'active']);
  return {
    id: string(v.id, 'assignee.id'),
    name: string(v.name, 'assignee.name'),
    active: boolean(v.active, 'assignee.active'),
  };
}

function parseUnacceptedPastStartItem(value: unknown): UnacceptedPastStartItem {
  const v = exactObject(value, 'unacceptedPastStart', [
    'jobCardId', 'title', 'type', 'jobPath', 'assignee', 'scheduledAt',
    'elapsedSeconds', 'hasOpenChangeRequest',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    title: string(v.title, 'title'),
    type: oneOf(v.type, 'type', JOB_CARD_TYPES),
    jobPath: string(v.jobPath, 'jobPath'),
    assignee: parseUnacceptedPastStartAssignee(v.assignee),
    scheduledAt: canonicalInstant(v.scheduledAt, 'scheduledAt'),
    elapsedSeconds: count(v.elapsedSeconds, 'elapsedSeconds'),
    hasOpenChangeRequest: boolean(v.hasOpenChangeRequest, 'hasOpenChangeRequest'),
  };
}

export const listUnacceptedPastStart = async (
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`/api/job-cards/pending-acceptance/past-start${query(page)}`),
  parseUnacceptedPastStartItem,
);

export type OpenSubmissionLateItem = {
  jobCardId: string;
  jobTitle: string;
  episodeNo: number;
  deadlineAt: string;
  breachedAt: string;
  elapsedSeconds: number;
  staff: RelatedName;
  customer: RelatedName | null;
  jobPath: string;
};

function parseOpenSubmissionLateItem(value: unknown): OpenSubmissionLateItem {
  const v = exactObject(value, 'item', [
    'jobCardId', 'jobTitle', 'episodeNo', 'deadlineAt', 'breachedAt',
    'elapsedSeconds', 'staff', 'customer', 'jobPath',
  ]);
  return {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    jobTitle: string(v.jobTitle, 'jobTitle'),
    episodeNo: positiveCount(v.episodeNo, 'episodeNo'),
    deadlineAt: canonicalInstant(v.deadlineAt, 'deadlineAt'),
    breachedAt: canonicalInstant(v.breachedAt, 'breachedAt'),
    elapsedSeconds: count(v.elapsedSeconds, 'elapsedSeconds'),
    staff: related(v.staff, 'staff'),
    customer: nullableRelated(v.customer, 'customer'),
    jobPath: string(v.jobPath, 'jobPath'),
  };
}

export const listOpenSubmissionLate = async (
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`/api/job-cards/submission-late/open${query(page)}`),
  parseOpenSubmissionLateItem,
);

/**
 * OVR-2 history item with the OVR-4 measurement appendix. Reminder fields
 * are proven domain facts; legacy episodes without reminders keep nulls.
 */
export type OverdueIncidentHistoryItem = {
  id: string;
  delayType: 'LATE_START' | 'LATE_SUBMISSION' | 'APPROVAL_WAIT';
  episodeNo: number;
  scheduleRevisionNo: number;
  deadlineAt: string;
  breachedAt: string;
  accountableRole: 'STAFF' | 'MANAGEMENT';
  accountableSource: 'ASSIGNMENT_AT_BREACH' | 'ROLE_POLICY' | 'UNKNOWN';
  accountableUser: RelatedName | null;
  source: 'TRANSITION' | 'MUTATION' | 'SCANNER';
  recordedAt: string;
  recoveredAt: string | null;
  recoveryActor: RelatedName | null;
  /**
   * OVR-5a: an authorized deadline extension ends the obligation without
   * touching the breach evidence. Ended rows keep the ending facts and never
   * become recovered or on-time rows.
   */
  endedAt: string | null;
  endedBy: { id: string; name: string | null } | null;
  endReason: 'DEADLINE_EXTENDED' | null;
  endNote: string | null;
  endedByScheduleRevisionNo: number | null;
  endedDurationSeconds: number | null;
  totalDelaySeconds: number | null;
  manualReminderSentAt: string | null;
  manualReminderCount: number;
  postReminderDelaySeconds: number | null;
};

function nullableActor(value: unknown, field: string): { id: string; name: string | null } | null {
  if (value === null) return null;
  const v = exactObject(value, field, ['id', 'name']);
  return {
    id: string(v.id, `${field}.id`),
    name: v.name === null ? null : string(v.name, `${field}.name`),
  };
}

function parseOverdueIncidentHistoryItem(value: unknown): OverdueIncidentHistoryItem {
  const v = exactObject(value, 'incident', [
    'id', 'delayType', 'episodeNo', 'scheduleRevisionNo', 'deadlineAt',
    'breachedAt', 'accountableRole', 'accountableSource', 'accountableUser',
    'source', 'recordedAt', 'recoveredAt', 'recoveryActor',
    'endedAt', 'endedBy', 'endReason', 'endNote', 'endedByScheduleRevisionNo',
    'endedDurationSeconds',
    'totalDelaySeconds', 'manualReminderSentAt', 'manualReminderCount',
    'postReminderDelaySeconds',
  ]);
  return {
    id: string(v.id, 'id'),
    delayType: oneOf(v.delayType, 'delayType', ['LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT'] as const),
    episodeNo: positiveCount(v.episodeNo, 'episodeNo'),
    scheduleRevisionNo: positiveCount(v.scheduleRevisionNo, 'scheduleRevisionNo'),
    deadlineAt: canonicalInstant(v.deadlineAt, 'deadlineAt'),
    breachedAt: canonicalInstant(v.breachedAt, 'breachedAt'),
    accountableRole: oneOf(v.accountableRole, 'accountableRole', ['STAFF', 'MANAGEMENT'] as const),
    accountableSource: oneOf(
      v.accountableSource,
      'accountableSource',
      ['ASSIGNMENT_AT_BREACH', 'ROLE_POLICY', 'UNKNOWN'] as const,
    ),
    accountableUser: nullableRelated(v.accountableUser, 'accountableUser'),
    source: oneOf(v.source, 'source', ['TRANSITION', 'MUTATION', 'SCANNER'] as const),
    recordedAt: canonicalInstant(v.recordedAt, 'recordedAt'),
    recoveredAt: nullableCanonicalInstant(v.recoveredAt, 'recoveredAt'),
    recoveryActor: nullableRelated(v.recoveryActor, 'recoveryActor'),
    endedAt: nullableCanonicalInstant(v.endedAt, 'endedAt'),
    endedBy: nullableActor(v.endedBy, 'endedBy'),
    endReason: v.endReason === null
      ? null
      : oneOf(v.endReason, 'endReason', ['DEADLINE_EXTENDED'] as const),
    endNote: nullableString(v.endNote, 'endNote'),
    endedByScheduleRevisionNo: v.endedByScheduleRevisionNo === null
      ? null
      : positiveCount(v.endedByScheduleRevisionNo, 'endedByScheduleRevisionNo'),
    endedDurationSeconds: nullableCount(v.endedDurationSeconds, 'endedDurationSeconds'),
    totalDelaySeconds: nullableCount(v.totalDelaySeconds, 'totalDelaySeconds'),
    manualReminderSentAt: nullableCanonicalInstant(v.manualReminderSentAt, 'manualReminderSentAt'),
    manualReminderCount: count(v.manualReminderCount, 'manualReminderCount'),
    postReminderDelaySeconds: nullableCount(v.postReminderDelaySeconds, 'postReminderDelaySeconds'),
  };
}

export const listOverdueIncidents = async (
  id: string,
  page: Partial<{ limit: number; offset: number }> = {},
) => parsePage(
  await request(`${jobPath(id)}/overdue-incidents${query(page)}`),
  parseOverdueIncidentHistoryItem,
);

export const listDeliveryItems = async (id: string) =>
  items(await request(`${jobPath(id)}/delivery-items`)).map(parseDelivery);
export const addDeliveryItem = async (id: string, input: DeliveryInput & { clientActionId: string }) =>
  parseDeliveryMutation(await request(`${jobPath(id)}/delivery-items`, json('POST', input)));
export const patchDeliveryItem = async (id: string, itemId: string, input: { expectedVersion: number } & Partial<Omit<DeliveryInput, 'expectedVersion'>>) =>
  parseDeliveryMutation(await request(`${jobPath(id)}/delivery-items/${segment(itemId)}`, json('PATCH', input)));
export async function removeDeliveryItem(id: string, itemId: string, expectedVersion: number) {
  const v = object(await request(`${jobPath(id)}/delivery-items/${segment(itemId)}`, json('DELETE', { expectedVersion })));
  return { id: string(v.id, 'id'), jobCardVersion: positiveCount(v.jobCardVersion, 'jobCardVersion') };
}

const lifecycle = async (id: string, command: string, input: object, options: { includeSubmitLocationCapability?: boolean } = {}) =>
  parseJobCard(await request(`${jobPath(id)}/${command}${query({
    includeSubmitLocationCapability: options.includeSubmitLocationCapability === true ? 'true' : undefined,
  })}`, json('POST', input)));
export const acceptJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'accept', input);
/**
 * JOB-010 release 2b: the assigned Staff member declines (from `NEW`) or
 * releases (from `ACCEPTED`) a job in the acceptance window. The server owns
 * the deadline, the offer state and the audit trail; these functions only
 * shape the transport.
 */
export type AssignmentReasonInput = {
  clientActionId: string;
  expectedVersion: number;
  reasonCode: AssignmentReasonCode;
  reasonText: string;
};
export const declineAssignment = (id: string, input: AssignmentReasonInput) =>
  lifecycle(id, 'decline', input);
export const releaseAssignment = (id: string, input: AssignmentReasonInput) =>
  lifecycle(id, 'release', input);
export type ReofferAssignmentInput = {
  clientActionId: string;
  expectedVersion: number;
  pastStartAcknowledgement?: PastStartAcknowledgement;
};
export type ReofferAssignmentReceipt = {
  jobCardId: string;
  offerId: string;
  acceptanceDueAt: string;
  urgentReason: AssignmentOfferUrgentReason | null;
};
/** Management re-offer to the same Staff member; opens a fresh offer. */
export const reofferAssignment = async (id: string, input: ReofferAssignmentInput) => {
  const v = exactObject(
    await request(`${jobPath(id)}/assignment-offers/reoffer`, json('POST', input)),
    'assignmentOffer',
    ['jobCardId', 'offerId', 'acceptanceDueAt', 'urgentReason'],
  );
  const receipt = {
    jobCardId: string(v.jobCardId, 'jobCardId'),
    offerId: string(v.offerId, 'offerId'),
    acceptanceDueAt: canonicalInstant(v.acceptanceDueAt, 'acceptanceDueAt'),
    urgentReason: v.urgentReason === null
      ? null
      : oneOf(v.urgentReason, 'urgentReason', ASSIGNMENT_OFFER_URGENT_REASONS),
  } satisfies ReofferAssignmentReceipt;
  if (receipt.jobCardId !== id) invalid('assignmentOffer');
  return receipt;
};
export const startJobCard = (id: string, input: StartJobCardInput) =>
  // #347/P2: the START response replaces local state, so it must also carry
  // the reader-gated SUBMIT capability; otherwise a same-screen SUBMIT would
  // parse the flag as absent (false) and skip its location capture.
  lifecycle(id, 'start', input, { includeSubmitLocationCapability: true });
export const submitJobCardForApproval = (id: string, input: SubmitJobCardInput) =>
  lifecycle(id, 'submit-for-approval', input, { includeSubmitLocationCapability: true });
export const approveJobCard = async (id: string, input: LifecycleInput & { note?: string; followUp?: ApproveFollowUpInput }) => {
  const raw = await request(`${jobPath(id)}/approve`, json('POST', input));
  const parsed = parseJobCard(raw);
  const v = raw as Record<string, unknown>;
  return {
    ...parsed,
    followUpJobCardId: typeof v.followUpJobCardId === 'string' ? v.followUpJobCardId : null,
  };
};
export const getFollowUpSuggestion = async (id: string, at?: string) =>
  parseFollowUpSuggestion(await request(`${jobPath(id)}/follow-up-suggestion${at === undefined ? '' : query({ at })}`));

export type CustomerSchedulePreviewInput = {
  engagementKind?: JobCardEngagementKind | null;
  type: JobCardType;
  customerId: string | null;
  scheduledAt: string;
  jobCardId?: string | null;
};
export const previewCustomerSchedule = async (input: CustomerSchedulePreviewInput) =>
  parseCustomerScheduleEvaluation(
    await request('/api/job-cards/customer-schedule/evaluate', json('POST', input)),
  );
export const findAvailableSlots = async (input: AvailableSlotsInput) =>
  parseAvailableSlotsResponse(
    await request('/api/job-cards/available-slots', json('POST', input)),
  );
export const requestJobCardRevision = (
  id: string,
  input: LifecycleInput & {
    revisionReason: string;
    /**
     * OVR-5 §3: optional correction deadline (ISO instant). Omitted → the
     * server materializes reserved_at + 24 h. Never sent for a job without an
     * original submission deadline.
     */
    correctionDueAt?: string;
  },
) => lifecycle(id, 'request-revision', input);
export const withdrawJobCardFromApproval = (id: string, input: LifecycleInput) => lifecycle(id, 'withdraw-from-approval', input);
export const resumeJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'resume', input);
export const cancelJobCard = async (
  id: string,
  input: LifecycleInput & { cancelReason: string; followUpContinuity?: FollowUpCancelContinuity },
) => {
  const raw = await request(`${jobPath(id)}/cancel`, json('POST', input));
  const parsed = parseJobCard(raw);
  const v = raw as Record<string, unknown>;
  // JOB-009: a rescheduled follow-up visit returns its replacement.
  return {
    ...parsed,
    followUpJobCardId: typeof v.followUpJobCardId === 'string' ? v.followUpJobCardId : null,
  };
};

export const invalidateJobCard = async (
  id: string,
  input: JobCardInvalidationInput,
  expectedSourceStatus: JobCardStatus,
) => {
  const raw = await request(`${jobPath(id)}/invalidate`, json('POST', input));
  const parsed = parseJobCard(raw);
  if (parsed.id !== id
    || parsed.status !== 'INVALIDATED'
    || parsed.version !== input.expectedVersion + 1
    || parsed.invalidationReasonCode !== input.reasonCode
    || parsed.invalidatedAt === undefined
    || parsed.invalidatedAt === null
    || parsed.invalidatedBy === undefined
    || parsed.invalidatedBy === null
    || parsed.workflowContext.lifecycle.invalidatedFromStatus !== expectedSourceStatus
    || parsed.workflowContext.lifecycle.invalidationReasonCode !== input.reasonCode
    || parsed.workflowContext.lifecycle.invalidatedBy === null) {
    invalid('invalidation');
  }
  return parsed;
};
