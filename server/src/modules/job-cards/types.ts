import type { UserRole } from '../auth/types.js';
import type { JobActionLocationComparison } from './location-types.js';
import type {
  OverdueAccountableRole,
  OverdueAccountableSource,
  OverdueIncidentDelayType,
  OverdueIncidentEndReason,
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
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT', 'SALE'] as const;
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

/** JOB-009: why a cancelled follow-up visit ends the customer's visit cycle. */
export const FOLLOW_UP_CYCLE_END_REASONS = [
  'NOT_INTERESTED',
  'WORKS_WITH_COMPETITOR',
  'CUSTOMER_INACTIVE',
  'DUPLICATE_RECORD',
  'OTHER',
] as const;
export type FollowUpCycleEndReason = (typeof FOLLOW_UP_CYCLE_END_REASONS)[number];

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

/**
 * JOB-010 release 2a (D1): a Staff change/termination request never changes
 * the JobCard. These codes carry the operational reason; the free text stays
 * mandatory so a code alone is never the whole story.
 */
export const JOB_CHANGE_REQUEST_REASON_CODES = [
  'CUSTOMER_CHANGED_MIND',
  'CUSTOMER_POSTPONED',
  'CUSTOMER_ABSENT',
  'WRONG_PRODUCT',
  'MISSING_STOCK_OR_EQUIPMENT',
  'VISIT_NOT_POSSIBLE',
  'OTHER',
] as const;
export type JobChangeRequestReasonCode = (typeof JOB_CHANGE_REQUEST_REASON_CODES)[number];

/** Every close fact a request can carry; CANCELLED/SUPERSEDED are not decisions. */
export const JOB_CHANGE_REQUEST_RESOLUTIONS = [
  'CANCELLED',
  'CORRECTED',
  'RESCHEDULED',
  'LINKED_JOB_CREATED',
  'REJECTED',
  'SUPERSEDED',
] as const;
export type JobChangeRequestResolution = (typeof JOB_CHANGE_REQUEST_RESOLUTIONS)[number];

/** The subset the management resolve command accepts (other paths own the rest). */
export const JOB_CHANGE_REQUEST_DECISIONS = [
  'CORRECTED',
  'RESCHEDULED',
  'LINKED_JOB_CREATED',
  'REJECTED',
] as const;
export type JobChangeRequestDecision = (typeof JOB_CHANGE_REQUEST_DECISIONS)[number];

/**
 * JOB-010 release 2b: one durable "please take this job by then" record.
 * A job may have many offers over time but only one is OPEN; closed offers
 * are append-only history.
 */
export const JOB_ASSIGNMENT_OFFER_OPENED_REASONS = [
  'CREATE',
  'REASSIGN',
  'RESCHEDULE',
  'FOLLOW_UP_CREATE',
  'APPROVE_FOLLOW_UP',
  'CANCEL_REPLACEMENT',
  'OFFBOARDING_TRANSFER',
  'REOFFER',
  // SALE-002 §5.4: the delivery the manager opens while approving a sale.
  'SALE_APPROVAL',
] as const;
export type JobAssignmentOfferOpenedReason =
  (typeof JOB_ASSIGNMENT_OFFER_OPENED_REASONS)[number];

export const JOB_ASSIGNMENT_OFFER_STATES = [
  'OPEN',
  'ACCEPTED',
  'DECLINED',
  'RELEASED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export type JobAssignmentOfferState = (typeof JOB_ASSIGNMENT_OFFER_STATES)[number];

/** Why an offer is shown to management as "customer time at risk". */
export const JOB_ASSIGNMENT_OFFER_URGENT_REASONS = [
  'SHORT_NOTICE',
  'START_PASSED',
] as const;
export type JobAssignmentOfferUrgentReason =
  (typeof JOB_ASSIGNMENT_OFFER_URGENT_REASONS)[number];

/** JOB-010 §3: a management acknowledgement for an already-started plan. */
export const JOB_ASSIGNMENT_OFFER_ACK_CODES = [
  'CUSTOMER_CONFIRMED_LATER_TIME',
  'CUSTOMER_WAITING',
  'OTHER',
] as const;
export type JobAssignmentOfferAckCode = (typeof JOB_ASSIGNMENT_OFFER_ACK_CODES)[number];

/** JOB-010 §5: Staff decline/release reason codes (Q5). */
export const JOB_ASSIGNMENT_OFFER_DECLINE_REASON_CODES = [
  'SCHEDULE_CONFLICT',
  'ON_LEAVE',
  'TOO_FAR',
  'MISSING_STOCK_OR_EQUIPMENT',
  'OTHER',
] as const;
export type JobAssignmentOfferDeclineReasonCode =
  (typeof JOB_ASSIGNMENT_OFFER_DECLINE_REASON_CODES)[number];

/** JOB-010 §3: every management/system producer that takes an offer back. */
export const JOB_ASSIGNMENT_OFFER_WITHDRAW_REASON_CODES = [
  'REASSIGNED',
  'RESCHEDULED',
  'CANCELLED',
  'INVALIDATED',
  'OFFBOARDING_TRANSFER',
  'PLANNED_WINDOW_PASSED',
] as const;
export type JobAssignmentOfferWithdrawReasonCode =
  (typeof JOB_ASSIGNMENT_OFFER_WITHDRAW_REASON_CODES)[number];

/** Latest offer projected on the job detail (management and assignee). */
export type JobAssignmentOfferView = {
  id: string;
  state: JobAssignmentOfferState;
  acceptanceDueAt: string;
  openedAt: string;
  urgentReason: JobAssignmentOfferUrgentReason | null;
  assignee: { id: string; name: string | null };
};

/** Latest offer fact carried by the list/board/follow-up projections. */
export type JobAssignmentOfferSummary = {
  state: JobAssignmentOfferState;
  acceptanceDueAt: string;
  /** JOB-010 §5: only the assignee the offer was addressed to may answer it. */
  assigneeUserId: string;
};

export type PastStartAcknowledgementInput = {
  code: JobAssignmentOfferAckCode;
  text: string;
};

/** JOB-010 §5: Staff decline / release body, hashed like a lifecycle command. */
export type AssignmentOfferDecisionInput = {
  clientActionId: string;
  expectedVersion: number;
  reasonCode: JobAssignmentOfferDeclineReasonCode;
  reasonText: string;
};

export type ReofferAssignmentInput = {
  clientActionId: string;
  expectedVersion: number;
  pastStartAcknowledgement?: PastStartAcknowledgementInput | null;
};

export type ReofferAssignmentReceipt = {
  jobCardId: string;
  offerId: string;
  acceptanceDueAt: string;
  urgentReason: JobAssignmentOfferUrgentReason | null;
};

/** One row of the management "needs action" assignment list, oldest first. */
export type NeedsActionAssignmentOfferItem = {
  jobCardId: string;
  jobTitle: string;
  jobType: JobCardType;
  offerId: string;
  state: JobAssignmentOfferState;
  closeReason: string | null;
  closeText: string | null;
  acceptanceDueAt: string;
  urgentReason: JobAssignmentOfferUrgentReason | null;
  scheduledAt: string | null;
  assignee: { id: string; name: string | null };
  customer: { id: string; name: string } | null;
  jobPath: string;
};

/**
 * OVR-6 §6.2: one management unaccepted past-start row. A job that JOB-010
 * does not own, listed at read time with its elapsed planned-start age.
 */
export type UnacceptedPastStartItem = {
  jobCardId: string;
  title: string;
  type: JobCardType;
  jobPath: string;
  /**
   * `active: false` means the assignee was deactivated after planning.
   * `users.name` is NOT NULL and the list inner-joins `users`, so the name is
   * always a string (matching the web parser).
   */
  assignee: { id: string; name: string; active: boolean };
  scheduledAt: string;
  elapsedSeconds: number;
  hasOpenChangeRequest: boolean;
};

export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];

export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];

export const JOB_CARD_ACTIVITY_EVENTS = [
  'WEEKLY_REPORT_REMOVED',
  'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
  'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_INVALIDATED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
  'SALE_FROM_VISIT_CREATED', 'SALE_DETAILS_UPDATED', 'SALE_ITEM_ADDED', 'SALE_ITEM_UPDATED', 'SALE_ITEM_REMOVED',
  'JOB_SUBMISSION_REMINDER_SENT', 'JOB_SUBMISSION_AUTO_REMINDER_SENT',
  'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
  'JOB_EARLY_START_AUTHORIZED',
  'JOB_CHANGE_REQUESTED',
  'JOB_CHANGE_REQUEST_RESOLVED',
  'JOB_ASSIGNMENT_OFFER_OPENED',
  'JOB_ASSIGNMENT_REMINDER_SENT',
  'JOB_ASSIGNMENT_DECLINED',
  'JOB_ASSIGNMENT_RELEASED',
  'JOB_ASSIGNMENT_OFFER_EXPIRED',
  'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
  'JOB_OVERDUE_ENDED_BY_EXTENSION',
  // OVR-6: quiet-hours-gated automatic lateness alerts.
  'JOB_START_REMINDER_SENT',
  'JOB_APPROVAL_WAIT_ALERT_SENT',
  'JOB_PENDING_ACCEPTANCE_ALERT_SENT',
  // SALE-002 §5.5: the one delivery an approval opened, recorded on the sale.
  'SALE_DELIVERY_CREATED',
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
  /**
   * JOB-010 §1a permission fact. Server-computed, never stored on the row and
   * never serialized on the wire: a job whose current assignee and planned
   * interval still match a non-voided early-start authorization. Absent means
   * false, so every caller that cannot prove the fact fails closed.
   */
  earlyStartAuthorized?: boolean;
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
  /**
   * JOB-010 release 2b: accepted on every create path and ignored when the
   * resulting offer is not `START_PASSED`. Part of the request hash.
   */
  pastStartAcknowledgement?: PastStartAcknowledgementInput | null;
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
  metContactId: string | null;
  metContact: MeetingDetailsContact | null;
  jobCardVersion: number;
};

/**
 * Slice 3 reader gate. Previously deployed web bundles parse meeting details
 * with a strict allowlist, so `metContactId`/`metContact` are only serialized
 * for readers that explicitly opt in (`includeMetContactCapability`). The
 * default (absent) keeps the pre-Slice-3 wire shape.
 */
export type MeetingDetailsLegacyResponse = Omit<MeetingDetails, 'metContactId' | 'metContact'>;
export type MeetingDetailsReaderResponse = MeetingDetails | MeetingDetailsLegacyResponse;

/** Contact identity projected with a meeting-result read (display only). */
export type MeetingDetailsContact = { id: string; name: string; title: string | null };

export type MeetingDetailsCandidate = {
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
  unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
  meetingSummary: string | null;
  nextFollowUpAt: string | null;
  metContactId?: string | null;
};

/** Candidate plus the locked/joined contact identity for response building. */
export type MeetingDetailsView = MeetingDetailsCandidate & {
  metContact?: MeetingDetailsContact | null;
};

export const MEETING_DETAIL_FIELDS = [
  'meetingAt', 'outcome', 'unsuccessfulReason', 'meetingSummary', 'nextFollowUpAt', 'metContactId',
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
  metContactId?: string | null;
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
  followUpCycleEndReason: FollowUpCycleEndReason | null;
  invalidatedAt: string | null;
  invalidatedBy: RelatedIdentity | null;
  invalidationReasonCode: JobCardInvalidationReasonCode | null;
  invalidatedFromStatus: JobCardStatus | null;
};

export type PersistedJobCardDetail = JobCard & {
  organizationTimezone: string;
  /**
   * SALE-002 §5.5: the delivery <-> sale link, read unscoped and only for a
   * PRODUCT_DELIVERY (`deliverySourceSale`) or a SALE (`linkedDelivery`);
   * absent otherwise. The presenter applies the viewer rule and exposes
   * `deliverySourceSaleId` / `linkedDelivery` without the assignees.
   */
  deliverySourceSale?: { id: string; assignedTo: string } | null;
  linkedDelivery?: { id: string; status: JobCardStatus; assignedTo: string } | null;
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
  lifecycle: JobLifecycleFacts;
  proposer: RelatedIdentity | null;
  /**
   * JOB-010 §1a: the currently valid early-start authorization, or null. Only
   * a row that still matches the job's assignee and planned interval is read,
   * so an absent value means "no authorization", never "unknown".
   */
  earlyStartAuthorization: EarlyStartAuthorizationView | null;
  /**
   * JOB-010 release 2a: the request that is OPEN right now, or null. Closed
   * requests stay in the append-only table and never surface here.
   */
  changeRequest: ChangeRequestView | null;
  /**
   * JOB-010 release 2b: the latest assignment offer, or null when the job was
   * never offered (pre-rollout jobs and jobs outside the window). Internal
   * projection: the detail presenter turns it into `JobAssignmentOfferView`.
   */
  assignmentOffer: JobAssignmentOfferRecord | null;
  /**
   * OVR-5b §5.3: an open (neither recovered nor ended) LATE_START or
   * LATE_SUBMISSION incident exists right now. The Staff deadline rule and the
   * management reason field read this server-computed fact.
   */
  hasOpenOverdueIncident: boolean;
  /**
   * OVR-5b §3.7: the effective submission deadline of the current submission
   * episode — `max(original, stored correction)` — when that episode was armed
   * by REQUEST_REVISION with a stored value and the job is REVISION_REQUESTED
   * or IN_PROGRESS; otherwise null.
   */
  correctionDueAt: string | null;
};

/** JOB-010 release 2b: persisted latest offer, server-internal shape. */
export type JobAssignmentOfferRecord = {
  id: string;
  state: JobAssignmentOfferState;
  openedAt: Date;
  openedReason: JobAssignmentOfferOpenedReason;
  acceptanceDueAt: Date;
  urgentReason: JobAssignmentOfferUrgentReason | null;
  /** The Staff member the offer is addressed to (permission fact). */
  assigneeUserId: string;
  assigneeId: string;
  assigneeName: string | null;
  closedAt: Date | null;
  closeReason: string | null;
  closeText: string | null;
};

/** JOB-010 release 2a: the open request a job detail exposes. */
export type ChangeRequestView = {
  id: string;
  reasonCode: JobChangeRequestReasonCode;
  reasonText: string;
  requestedAt: string;
  requestedBy: { id: string; name: string | null };
};

export type CreateChangeRequestInput = {
  clientActionId: string;
  reasonCode: JobChangeRequestReasonCode;
  reasonText: string;
};

export type CreateChangeRequestReceipt = {
  jobCardId: string;
  changeRequestId: string;
  requestedAt: string;
};

export type ResolveChangeRequestInput = {
  clientActionId: string;
  resolution: JobChangeRequestDecision;
  note?: string | null;
  linkedJobCardId?: string | null;
};

export type ResolveChangeRequestReceipt = {
  jobCardId: string;
  changeRequestId: string;
  resolution: JobChangeRequestDecision;
  resolvedAt: string;
};

/** One row of the management open-request list, oldest first. */
export type OpenChangeRequestItem = {
  changeRequestId: string;
  jobCardId: string;
  jobTitle: string;
  jobType: JobCardType;
  jobStatus: JobCardStatus;
  reasonCode: JobChangeRequestReasonCode;
  reasonText: string;
  requestedAt: string;
  requestedBy: { id: string; name: string | null };
  customer: { id: string; name: string } | null;
  jobPath: string;
};

export type EarlyStartAuthorizationView = {
  grantedAt: string;
  grantedBy: { id: string; name: string | null };
};

export type EarlyStartVoidReason = 'REASSIGNED' | 'RESCHEDULED' | 'OFFBOARDING_TRANSFER';

export type EarlyStartAuthorizationRecord = {
  id: string;
  assigneeUserId: string;
  scheduledAt: Date;
  scheduledEndsAt: Date | null;
  grantedAt: Date;
  grantedBy: string;
};

export type EarlyStartAuthorizationInput = {
  clientActionId: string;
  expectedVersion: number;
};

export type EarlyStartAuthorizationReceipt = {
  jobCardId: string;
  authorizationId: string;
  grantedAt: string;
};

export type JobWorkflowContext = {
  allowedCommands: LifecycleCommand[];
  allowedActions: JobWorkflowAction[];
  startLocationCaptureEnabled: boolean;
  /**
   * Slice 1 SUBMIT capability. Reader-gated on the wire: the detail presenter
   * only serializes this key when the reader explicitly opts in
   * (`includeSubmitLocationCapability`). Previously deployed web bundles parse
   * workflowContext with a strict allowlist, so an unconditional new key
   * would turn every JobCard read into INVALID_RESPONSE on already-open tabs
   * until reload. The default (absent) keeps the pre-Slice-1 response shape.
   */
  submitLocationCaptureEnabled?: boolean;
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
  'lifecycle' | 'sourceJobCardId' | 'followUpInstructions' | 'proposer' | 'assignmentOffer'
  | 'deliverySourceSale' | 'linkedDelivery'
> & {
  /**
   * SALE-002 §5.5 (sale detail): the delivery opened from this sale, only when
   * the viewer can read it (management, or the delivery's own assignee);
   * null when there is none or it is not readable.
   */
  linkedDelivery: { id: string; status: JobCardStatus } | null;
  /**
   * SALE-002 §5.5: the sale a delivery was opened from, only when the viewer
   * can read that sale (management, or the sale's own assignee); otherwise
   * null, so a staff member never learns an id they cannot open.
   */
  deliverySourceSaleId: string | null;
  workflowContext: JobWorkflowContext;
  followUpContext: JobCardFollowUpContext | null;
  followUpProposal: FollowUpProposal | null;
  /** JOB-010 release 2b: latest offer, an OPEN offer past its deadline is EXPIRED. */
  assignmentOffer: JobAssignmentOfferView | null;
  /**
   * Slice 2 advisory comparison of the just-completed SUBMIT, present only
   * for explicitly opted-in readers (same reader gate as the SUBMIT
   * capability flag). Absent (undefined) on plain reads and for previous
   * bundles; no comparison means no key (never serialized null).
   */
  submitLocationComparison?: JobCardSubmitLocationComparison;
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
  | 'DECLINE_ASSIGNMENT'
  | 'RELEASE_ASSIGNMENT'
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
> & Partial<Pick<
  JobCard,
  'scheduledAt' | 'earlyStartAuthorized'
>> & {
  /**
   * JOB-010 release 2a: true only when a request is OPEN right now. Absent
   * means "no open request", so every caller that cannot prove it keeps the
   * pre-2a action set.
   */
  hasOpenChangeRequest?: boolean;
  /**
   * JOB-010 release 2b: the latest assignment offer. Absent/null means the job
   * is outside the acceptance window, so the pre-2b rules apply. Only read when
   * `assignmentWindowEnabled` is passed to the policy.
   */
  assignmentOffer?: JobAssignmentOfferSummary | null;
};

export const JOB_WORKFLOW_ACTIONS = [
  'EDIT_JOB_FIELDS', 'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT',
  'EDIT_MEETING_RESULT', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE',
  'REQUEST_CHANGE', 'RESOLVE_CHANGE_REQUEST',
] as const;
export type JobWorkflowAction = (typeof JOB_WORKFLOW_ACTIONS)[number];

export const SUBMISSION_REQUIREMENT_CODES = [
  'SALE_ORIGIN_VALID', 'SALE_TIME_VALID', 'SALE_ITEM_PRESENT', 'SALE_ITEMS_VALID',
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
  includeSaleCapability?: boolean;
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
   * JOB-010 §1a permission fact for `allowedCommands`. Present on the list,
   * board and follow-up projections and stripped by the presenter before the
   * item is serialized; absent means false.
   */
  earlyStartAuthorized?: boolean;
  /**
   * JOB-010 release 2b permission fact for `allowedCommands`. Present on the
   * list, board and follow-up projections and stripped by the presenter before
   * serialization; absent means the job is outside the acceptance window.
   */
  assignmentOffer?: JobAssignmentOfferSummary | null;
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
 *
 * OVR-4 measurement appendix (server-computed, never client-derived):
 * - `totalDelaySeconds` = recoveredAt - breachedAt for recovered incidents,
 *   null while open and null for an ended incident (an ending is never a
 *   recovery or an on-time result);
 * - `manualReminderSentAt` = latest manual manager reminder for the episode
 *   at or before the closing instant (recovery or ending; the latest overall
 *   while open), null when the episode was never manually nudged — never
 *   guessed for legacy history;
 * - `postReminderDelaySeconds` = recoveredAt - manualReminderSentAt, null
 *   unless both endpoints are proven and the incident was not ended.
 *
 * OVR-5 ending appendix: an authorized deadline extension ends an open
 * obligation without erasing its evidence. Every ending field is null on a
 * non-ended row and all of them are set on an ended row:
 * - `endedAt` / `endedBy` / `endedByScheduleRevisionNo` = the ending instant,
 *   actor and the schedule revision that proved the new boundary;
 * - `endReason` = 'DEADLINE_EXTENDED'; `endNote` = the mandatory reason;
 * - `endedDurationSeconds` = endedAt - breachedAt (same rounding as above).
 *
 * OVR-2 invalidation appendix (owner decision 2026-11-20): an authorized
 * `INVALIDATE` ends every open obligation of the card with `endReason` =
 * 'CARD_INVALIDATED'. It is neither completion nor recovery: `recoveredAt` /
 * `recoveryActor` stay null, `totalDelaySeconds` stays null, no schedule
 * revision is claimed (`endedByScheduleRevisionNo` null) and
 * `endedDurationSeconds` is the actual delay the card carried until it was
 * invalidated. Cards invalidated before this rule keep their open rows.
 */
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
  endedAt: string | null;
  endedBy: { id: string; name: string | null } | null;
  endReason: OverdueIncidentEndReason | null;
  endNote: string | null;
  endedByScheduleRevisionNo: number | null;
  endedDurationSeconds: number | null;
  totalDelaySeconds: number | null;
  manualReminderSentAt: string | null;
  manualReminderCount: number;
  postReminderDelaySeconds: number | null;
};

/**
 * OVR-4 server-owned open LATE_SUBMISSION snapshot for one job.
 *
 * `open` is null when no submission episode is currently late; otherwise it
 * carries the canonical operational signal derived from the immutable
 * incident contract (earliest open breach of the current episode) with the
 * request-clock elapsed duration. Clients render this snapshot verbatim and
 * never recompute domain time from their own clock.
 */
export type SubmissionLatenessSnapshot = {
  open: null | {
    incidentId: string;
    delayType: 'LATE_SUBMISSION';
    episodeNo: number;
    scheduleRevisionNo: number;
    deadlineAt: string;
    breachedAt: string;
    /** Whole seconds from breachedAt to the request clock, clamped at zero. */
    elapsedSeconds: number;
    accountableUser: { id: string; name: string | null } | null;
    accountableRole: OverdueAccountableRole;
    staffReminderSentAt: string | null;
    escalationSentAt: string | null;
    manualReminderSentAt: string | null;
    manualReminderCount: number;
    /**
     * JOB-010 release 2a (D1 §5): while a change/termination request is open,
     * automatic OVR-4 Staff reminders stop and the wait until the management
     * decision is management time. Null means no open request; the incident
     * itself is never closed or rewritten by a request.
     */
    changeRequestOpenSince: string | null;
  };
};

/**
 * OVR-4 manager open-submission-late list item: one row per currently open
 * LATE_SUBMISSION episode with the navigation and accountability context an
 * escalation needs. Bounded, longest-waiting first.
 */
export type OpenSubmissionLateItem = {
  jobCardId: string;
  jobTitle: string;
  episodeNo: number;
  deadlineAt: string;
  breachedAt: string;
  elapsedSeconds: number;
  staff: { id: string; name: string | null };
  customer: { id: string; name: string } | null;
  jobPath: string;
};

export type PaginatedOverdueIncidentHistory = Paginated<OverdueIncidentHistoryItem>;

export type JobCardMutationReceipt = {
  jobCardId: string;
  evaluatedAt?: string;
  followUpJobCardId?: string;
  /**
   * SALE-002 §5.1 (R22): the linked sale that this coordinated pair command
   * actually moved. Present only when the sale moved; the anchor card remains
   * the visit.
   */
  linkedSaleJobCardId?: string;
  /**
   * SALE-002 §5.1: the delivery card created atomically with the approval.
   * Reserved for S3; never present before the delivery payload ships.
   */
  deliveryJobCardId?: string;
  /**
   * Slice 2 advisory SUBMIT comparison, present only when the finalized
   * SUBMIT classified one. Persisted verbatim on the intent response so
   * replays return the identical durable result. Server-computed; never
   * client-supplied.
   */
  submitLocationComparison?: JobActionLocationComparison;
};

/**
 * Slice 2 safe SUBMIT comparison projection. Reference activity identity
 * stays server-side; authorized viewers receive only the classification and
 * the server-computed distance. No raw coordinates.
 */
export type JobCardSubmitLocationComparison = Readonly<{
  outcome: 'MATCH' | 'DIFFERENT' | 'UNRELIABLE';
  distanceMeters: number;
}>;

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
  /** JOB-010 release 2b: see NormalizedJobCardCreateInput. */
  pastStartAcknowledgement?: PastStartAcknowledgementInput | null;
  /**
   * PRODUCT_DELIVERY only; the parser requires the purpose and at least one
   * item, with the note optional. A follow-up delivery JobCard is created
   * together with its initial delivery lines because no accepted browser
   * surface adds lines to an existing card yet.
   */
  deliveryPurpose?: DeliveryPurpose | null;
  deliveryNote?: string | null;
  items?: Array<{ productId: string; quantity: number }>;
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

export type JobCardActivityLocation =
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

export type JobCardActivityDetails =
  | { kind: 'SALE_RELATION' }
  | {
      kind: 'SALE_DELIVERY';
      deliveryJobCardId: string;
      assignedTo: string;
      scheduledAt: string;
      itemCount: number;
      items: Array<{ productId: string; quantity: number }>;
    }
  | { kind: 'SALE_DETAILS'; changedFields: Array<'soldAt' | 'saleContact'> }
  | { kind: 'SALE_ITEM'; operation: 'ADDED' | 'UPDATED' | 'REMOVED'; itemId: string;
      productName: string; quantity: string; previousQuantity: string | null }
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardActivityStatus;
      toStatus: JobCardActivityStatus;
      reason: string | null;
      startLocation?: JobCardActivityLocation;
      submitLocation?: JobCardActivityLocation;
      /**
       * Slice 2 advisory comparison of this SUBMIT against its START
       * reference. Reader-gated like the SUBMIT capability flag: omitted
       * (not null) without opt-in or classification. No raw coordinates.
       */
      submitComparison?: JobCardSubmitLocationComparison;
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
