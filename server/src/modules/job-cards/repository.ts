import {
  ACTIVE_JOB_CARD_STATUSES,
  JOB_CARD_STATUSES,
  type DeliveryItem,
  type JobCard,
  type JobCardActivityEvent,
  type JobCardAssignee,
  type JobCardBaseFilters,
  type JobCardBoard,
  type JobCardBoardQuery,
  type JobCardListQuery,
  type JobCardInvalidationReasonCode,
  type JobCardOperationalNoteContext,
  type JobCardPriority,
  type JobCardStatus,
  type JobCardStatusFilter,
  type JobCardType,
  type JobLifecycleFacts,
  type LifecycleCommand,
  type Paginated,
  type PersistedJobCardDetail,
  type PersistedJobCardListItem,
  type JobCardNoteDto,
  type JobCardNoteCursor,
  type PaginatedJobCardNotes,
  type MeetingDetailsCandidate,
  type MeetingOutcome,
  type ReferenceContact,
  type ReferenceCustomer,
  type RelatedIdentity,
} from './types.js';
import type { Pool, PoolClient } from 'pg';
import type { ApprovalQueueItemPort } from '../reports/ports.js';
import type { ApprovalItem } from '../reports/types.js';
import type {
  RealtimeEventInput,
  RealtimeEventRecord,
} from '../realtime/types.js';
import type {
  CustomerJobHistoryQuery,
  JobHistoryItem,
  JobHistoryReadPort,
  PaginatedJobHistory,
  StaffJobHistoryQuery,
} from './history-port.js';
import {
  PostgresRealtimeEventTransaction,
} from '../realtime/repository.js';
import {
  PostgresNotificationTransaction,
} from '../notifications/repository.js';
import {
  PostgresWebPushTransaction,
} from '../web-push/repository.js';
import type {
  NotificationAppendInput,
  NotificationRecord,
} from '../notifications/types.js';
import type {
  AppendJobActionLocationInput,
  JobActionLocationRecord,
  LocationFailureReason,
  LocationGeocodingStatus,
} from './location-types.js';
import type { AppendWebPushDeliveriesInput } from '../web-push/repository.js';
import { AppError } from '../../errors/index.js';
import type {
  ActiveOnSiteJobRecord,
  RecentOnSiteVisitRecord,
} from './customer-schedule.js';

export type AppendedActivity = {
  id: string;
  createdAt: Date;
};

export type CriticalActionClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
  requestHash?: string;
};

export type JobCardInvalidationUpdateInput = {
  organizationId: string;
  jobCardId: string;
  expectedVersion: number;
  invalidatedAt: Date;
  invalidatedBy: string;
  reasonCode: JobCardInvalidationReasonCode;
};

export type JobCardAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectId: string;
  oldValue: unknown;
  newValue: unknown;
  metadata?: Record<string, unknown>;
};

export type TransitionInput = {
  organizationId: string;
  jobCardId: string;
  expectedVersion: number;
  command: LifecycleCommand;
  status: JobCardStatus;
  occurredAt: Date;
  actorId?: string;
  note?: string | null;
  revisionReason?: string | null;
  cancelReason?: string | null;
  followUpProposal?: {
    scheduledAt: Date;
    type: JobCardType;
    assignedTo: string;
    instructions: string;
    origin: JobCard['followUpProposalOrigin'];
    proposedBy: string | null;
  } | null;
};

export type ActivityInput = {
  organizationId: string;
  jobCardId: string;
  actorId: string;
  event: JobCardActivityEvent;
  clientActionId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: unknown;
};

export type CreateNoteRecord = {
  id: string;
  organizationId: string;
  jobCardId: string;
  authorId: string;
  authorNameSnapshot: string;
  authorRoleSnapshot: JobCardAssignee['role'];
  workflowStage: JobCardStatus;
  context: JobCardOperationalNoteContext;
  relatedActivityId: string;
  note: string;
  invoiceNumber: string | null;
};
export type NoteAuthorSnapshot = Pick<JobCardAssignee, 'id' | 'role' | 'isActive'> & {
  name: string;
};

export type CreateJobCardRecord = {
  organizationId: string; type: JobCard['type']; status: JobCard['status'];
  title: string; description: string | null;
  customerId: string | null; contactId: string | null; assignedTo: string; createdBy: string;
  priority: JobCardPriority; dueDate: string | null; scheduledAt: string | null;
  scheduledEndsAt: string | null;
  engagementKind: JobCard['engagementKind'];
  acceptedAt: Date | null; acceptedBy: string | null;
  sourceJobCardId: string | null; followUpInstructions: string | null;
};
export type MeetingDetailsRecord = MeetingDetailsCandidate & {
  organizationId: string;
  jobCardId: string;
};

export type JobCardReadScope = { organizationId: string; assignedTo: string | null };
export type UpdateJobCardFields = Partial<Pick<
  JobCard,
  'title' | 'description' | 'customerId' | 'contactId' | 'assignedTo' | 'priority' | 'dueDate'
  | 'scheduledAt' | 'scheduledEndsAt' | 'status' | 'engagementKind'
>> & {
  clearAcceptance?: boolean;
};
export type UpdateJobCardInput = {
  organizationId: string; jobCardId: string; expectedVersion: number; fields: UpdateJobCardFields;
};
export type JobCalendarSchedule = Readonly<{
  organizationId: string;
  /** null on create-time availability checks (no job row exists yet). */
  jobCardId: string | null;
  assignedUserId: string;
  startsAt: string | null;
  endsAt: string | null;
  version: number;
  active: boolean;
  now: Date;
  reminderLeadMinutes: number;
}>;
export type AssigneeCalendarInterval = Readonly<{
  startsAt: string;
  endsAt: string;
}>;
export type ProductReference = {
  id: string; organizationId: string; name: string; sku: string | null; model: string | null;
  unit: string | null; isActive: boolean;
};
export type DeliveryItemRecord = DeliveryItem & {
  id: string; organizationId: string; jobCardId: string; unit: string | null;
  productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null;
  lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null;
};
export type SubmissionDeliveryItem = DeliveryItemRecord;
export type ActivityRecord = {
  id: string; jobCardId: string; actorId: string | null; actorName: string | null;
  eventType: JobCardActivityEvent;
  oldValue: unknown; newValue: unknown; metadata: unknown; clientActionId: string | null; createdAt: Date;
  startLocation: null | {
    outcome: 'CAPTURED'; approximateLabel: string | null;
    accuracyMeters: number; capturedAt: Date;
    geocodingProvider: 'GOOGLE' | null;
  } | {
    outcome: 'UNAVAILABLE'; reason: LocationFailureReason;
  };
};
export type PageQuery = { limit: number; offset: number };
export type NotePageQuery = {
  limit: number;
  before: JobCardNoteCursor | null;
};
export type JobCustomerReference = { id: string; status: 'prospect' | 'active' | 'inactive' };
export type ActiveManagementRecipient = {
  id: string;
  role: 'ADMIN' | 'MANAGER';
  isActive: boolean;
};
export type SubmissionCustomer = JobCustomerReference & { organizationId: string };
export type JobContactReference = { id: string; customerId: string; isActive: boolean };

/**
 * Read-only snapshot of the direct follow-up source card plus the minimal
 * customer/contact references and meeting outcome needed for eligibility
 * checks and the restricted source summary (design §6.2, §7).
 */
export type FollowUpSourceReference = {
  id: string;
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  customerId: string | null;
  contactId: string | null;
  sourceJobCardId: string | null;
  assignedTo: string;
  scheduledAt: string | null;
  startedAt: string | null;
  staffCompletedAt: string | null;
  managerApprovedAt: string | null;
  customer: ReferenceCustomer | null;
  contact: ReferenceContact | null;
  meetingAt: string | null;
  outcome: MeetingOutcome | null;
};

/** Persisted children-list row: every child carries its direct source link. */
export type PersistedFollowUpListItem = PersistedJobCardListItem & {
  sourceJobCardId: string;
};

export interface SubmissionReader {
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getSubmissionCustomer(
    organizationId: string,
    customerId: string,
  ): Promise<SubmissionCustomer | null>;
  getSubmissionMeetingDetails(
    organizationId: string,
    jobCardId: string,
  ): Promise<MeetingDetailsCandidate | null>;
  getSubmissionDeliveryItems(
    organizationId: string,
    jobCardId: string,
  ): Promise<SubmissionDeliveryItem[]>;
}

export interface JobCardTransaction extends SubmissionReader {
  getJob(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobForUpdate(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobDetail(organizationId: string, jobCardId: string): Promise<PersistedJobCardDetail | null>;
  getFollowUpSource(
    organizationId: string,
    sourceJobCardId: string,
  ): Promise<FollowUpSourceReference | null>;
  listActiveFollowUpChildrenForUpdate(
    organizationId: string,
    sourceJobCardId: string,
  ): Promise<Array<{ id: string; status: JobCardStatus }>>;
  transitionWithVersion(input: TransitionInput): Promise<JobCard | null>;
  invalidateWithVersion(input: JobCardInvalidationUpdateInput): Promise<JobCard | null>;
  appendActivity(input: ActivityInput): Promise<AppendedActivity>;
  appendAudit(input: JobCardAuditInput): Promise<void>;
  appendJobActionLocation(
    input: AppendJobActionLocationInput,
  ): Promise<JobActionLocationRecord>;
  appendRealtimeEvent(
    input: RealtimeEventInput,
  ): Promise<RealtimeEventRecord>;
  listActiveManagementRecipients(
    organizationId: string,
  ): Promise<readonly ActiveManagementRecipient[]>;
  appendNotifications(
    input: NotificationAppendInput,
  ): Promise<readonly NotificationRecord[]>;
  appendWebPushDeliveries(
    input: AppendWebPushDeliveriesInput,
  ): Promise<readonly string[]>;
  getNoteAuthorSnapshot(
    organizationId: string,
    authorId: string,
  ): Promise<NoteAuthorSnapshot | null>;
  createNote(input: CreateNoteRecord): Promise<JobCardNoteDto>;
  getAssigneeForUpdate(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getCustomerForUpdate(organizationId: string, customerId: string): Promise<JobCustomerReference | null>;
  customerExists(organizationId: string, customerId: string): Promise<boolean>;
  getOrganizationTimezone(organizationId: string): Promise<string>;
  listActiveOnSiteJobs(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<ActiveOnSiteJobRecord[]>;
  listRecentOnSiteVisits(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<RecentOnSiteVisitRecord[]>;
  listAssigneeCalendarIntervals(
    organizationId: string,
    assignedUserId: string,
    from: Date,
    to: Date,
    excludeJobId: string | null,
  ): Promise<AssigneeCalendarInterval[]>;
  getContactForUpdate(organizationId: string, contactId: string): Promise<JobContactReference | null>;
  createJobCard(input: CreateJobCardRecord): Promise<JobCard>;
  createMeetingDetails(input: { organizationId: string; jobCardId: string }): Promise<void>;
  updateMeetingDetails(input: MeetingDetailsRecord): Promise<void>;
  updateFieldsWithVersion(input: UpdateJobCardInput): Promise<JobCard | null>;
  assertCalendarAvailability(input: Omit<JobCalendarSchedule, 'version' | 'active' | 'now' | 'reminderLeadMinutes'>): Promise<void>;
  synchronizeCalendarReminder(input: JobCalendarSchedule): Promise<void>;
  getProduct(organizationId: string, productId: string): Promise<ProductReference | null>;
  getDeliveryItemForUpdate(organizationId: string, jobCardId: string, itemId: string): Promise<DeliveryItemRecord | null>;
  createDeliveryItem(input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  updateDeliveryItem(itemId: string, input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  deleteDeliveryItem(itemId: string): Promise<void>;
  bumpVersion(organizationId: string, jobCardId: string, expectedVersion: number): Promise<JobCard | null>;
}

export type CriticalActionWorkResult<T> = Readonly<{
  response: T;
  realtimeEvents: readonly RealtimeEventRecord[];
}>;

export type CriticalActionResult<T> =
  | {
      kind: 'completed';
      response: T;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | {
      kind: 'replay';
      response: T;
      realtimeEvents: readonly [];
    }
  | { kind: 'processing' };

function assertCriticalActionRequestHash(
  expected: string | undefined,
  stored: string | null | undefined,
) {
  if (expected !== undefined && stored !== expected) {
    throw new AppError(
      'CLIENT_ACTION_REUSED',
      409,
      'clientActionId farklı bir işlem içeriğiyle yeniden kullanılamaz.',
    );
  }
}

export interface JobCardRepository extends SubmissionReader {
  findCompletedCriticalAction<T>(
    claim: CriticalActionClaim,
  ): Promise<T | null>;
  executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (
      transaction: JobCardTransaction,
    ) => Promise<CriticalActionWorkResult<T>>,
  ): Promise<CriticalActionResult<T>>;
  listJobCards(
    scope: JobCardReadScope,
    query: JobCardListQuery,
    requestTime: Date,
  ): Promise<Paginated<PersistedJobCardListItem>>;
  listBoard(
    scope: JobCardReadScope,
    query: JobCardBoardQuery,
  ): Promise<{
    columns: {
      NEW: { items: PersistedJobCardListItem[]; count: number };
      ACCEPTED: { items: PersistedJobCardListItem[]; count: number };
      IN_PROGRESS: { items: PersistedJobCardListItem[]; count: number };
      WAITING_APPROVAL: { items: PersistedJobCardListItem[]; count: number };
      REVISION_REQUESTED: { items: PersistedJobCardListItem[]; count: number };
    };
    closedCounts: JobCardBoard['closedCounts'];
  }>;
  findJobCard(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  findJobCardDetail(organizationId: string, jobCardId: string): Promise<PersistedJobCardDetail | null>;
  getOrganizationTimezone(organizationId: string): Promise<string>;
  listActiveOnSiteJobs(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<ActiveOnSiteJobRecord[]>;
  listRecentOnSiteVisits(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<RecentOnSiteVisitRecord[]>;
  getFollowUpSource(
    organizationId: string,
    sourceJobCardId: string,
  ): Promise<FollowUpSourceReference | null>;
  listFollowUps(
    organizationId: string,
    sourceJobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<PersistedFollowUpListItem>>;
  findMeetingDetails(
    organizationId: string,
    jobCardId: string,
  ): Promise<MeetingDetailsCandidate | null>;
  executeTransaction<T>(work: (transaction: JobCardTransaction) => Promise<T>): Promise<T>;
  listDeliveryItems(organizationId: string, jobCardId: string): Promise<DeliveryItemRecord[]>;
  listActivity(
    organizationId: string,
    jobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<ActivityRecord>>;
  listNotes(
    organizationId: string,
    jobCardId: string,
    page: NotePageQuery,
  ): Promise<PaginatedJobCardNotes>;
  listReferenceCustomers(organizationId: string): Promise<ReferenceCustomer[]>;
}

type JobCardRow = {
  id: string; organization_id: string; type: JobCard['type']; status: JobCardStatus;
  version: number; title: string; description: string | null; customer_id: string | null; contact_id: string | null;
  assigned_to: string; created_by: string; priority: JobCardPriority;
  due_date: string | Date | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  engagement_kind: JobCard['engagementKind'];
  source_job_card_id: string | null;
  follow_up_instructions: string | null;
  follow_up_proposed_at: Date | null;
  follow_up_proposed_type: JobCard['type'] | null;
  follow_up_proposed_assignee: string | null;
  follow_up_proposal_instructions: string | null;
  follow_up_proposal_origin: JobCard['followUpProposalOrigin'];
  follow_up_proposed_by: string | null;
  invalidated_at: Date | null;
  invalidated_by: string | null;
  invalidation_reason_code: JobCardInvalidationReasonCode | null;
};
type JobCardDetailRow = JobCardRow & {
  organization_timezone: string;
  assignee_id: string; assignee_name: string;
  customer_id_join: string | null; customer_name: string | null;
  contact_id_join: string | null; contact_name: string | null;
  created_at: Date;
  accepted_at: Date | null;
  accepter_id: string | null;
  accepter_name: string | null;
  started_at: Date | null;
  staff_completed_at: Date | null;
  staff_completion_note: string | null;
  submitter_id: string | null;
  submitter_name: string | null;
  manager_approved_at: Date | null;
  manager_approval_note: string | null;
  approver_id: string | null;
  approver_name: string | null;
  revision_requested_at: Date | null;
  revision_reason: string | null;
  revision_actor_id: string | null;
  revision_actor_name: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  cancellation_actor_id: string | null;
  cancellation_actor_name: string | null;
  cancelled_from_status: string | null;
  invalidated_actor_id: string | null;
  invalidated_actor_name: string | null;
  invalidated_from_status: string | null;
  proposer_id: string | null;
  proposer_name: string | null;
};
type JobCardListRow = {
  id: string;
  type: JobCard['type'];
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  due_date: string | Date | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  engagement_kind: JobCard['engagementKind'];
  created_at: Date;
  updated_at: Date;
  staff_completed_at: Date | null;
  customer_id: string | null;
  customer_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  assignee_id: string;
  assignee_name: string;
  delivery_item_count: number;
  source_job_card_id: string | null;
};
type DeliveryRow = {
  id: string; organization_id: string; job_card_id: string; product_id: string;
  delivery_purpose: DeliveryItem['deliveryPurpose']; delivered_at: Date | null; quantity: string;
  unit: string | null; product_name_snapshot: string; product_sku_snapshot: string | null;
  product_model_snapshot: string | null; lot_no: string | null; serial_no: string | null;
  expiry_date: string | null; delivery_note: string | null;
};
type NoteRow = {
  id: string; job_card_id: string; note: string; author_id: string;
  invoice_number: string | null; author_name: string; author_name_snapshot: string | null;
  author_role_snapshot: JobCardAssignee['role'] | null;
  workflow_stage: JobCardStatus | null;
  context: JobCardOperationalNoteContext | null;
  related_activity_id: string | null;
  record_version: 0 | 1;
  created_at: Date;
};
type NoteListRow = NoteRow & { cursor_created_at: string };
type MeetingDetailsRow = {
  job_card_id: string;
  meeting_at: Date | null;
  outcome: MeetingOutcome | null;
  meeting_summary: string | null;
  next_follow_up_at: Date | null;
};
type JobActionLocationRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  activity_id: string;
  actor_user_id: string;
  action: 'JOB_STARTED';
  capture_outcome: JobActionLocationRecord['capture']['outcome'];
  failure_reason: LocationFailureReason | null;
  latitude: string | null;
  longitude: string | null;
  accuracy_meters: string | null;
  captured_at: Date | null;
  geocoding_status: LocationGeocodingStatus;
  geocoding_provider: 'GOOGLE' | null;
  neighborhood: string | null;
  district: string | null;
  city: string | null;
  approximate_label: string | null;
  created_at: Date;
};

function mapMeetingDetails(row: MeetingDetailsRow): MeetingDetailsCandidate {
  return {
    meetingAt: row.meeting_at?.toISOString() ?? null,
    outcome: row.outcome,
    meetingSummary: row.meeting_summary,
    nextFollowUpAt: row.next_follow_up_at?.toISOString() ?? null,
  };
}
function mapJobActionLocation(row: JobActionLocationRow): JobActionLocationRecord {
  const capture: JobActionLocationRecord['capture'] = row.capture_outcome === 'UNAVAILABLE'
    ? {
        outcome: 'UNAVAILABLE',
        reason: row.failure_reason!,
      }
    : {
        outcome: 'CAPTURED',
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracyMeters: Number(row.accuracy_meters),
        capturedAt: row.captured_at!,
        geocodingStatus: row.geocoding_status,
        geocodingProvider: row.geocoding_provider,
        neighborhood: row.neighborhood,
        district: row.district,
        city: row.city,
        approximateLabel: row.approximate_label,
      };
  return {
    id: row.id,
    organizationId: row.organization_id,
    jobCardId: row.job_card_id,
    activityId: row.activity_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    capture,
    createdAt: row.created_at,
  };
}
function mapNote(row: NoteRow): JobCardNoteDto {
  if (row.record_version === 1) {
    return {
      id: row.id,
      jobCardId: row.job_card_id,
      note: row.note,
      invoiceNumber: row.invoice_number,
      author: {
        id: row.author_id,
        name: row.author_name_snapshot!,
        role: row.author_role_snapshot!,
        source: 'SNAPSHOT',
      },
      workflowStage: row.workflow_stage!,
      context: row.context!,
      relatedActivityId: row.related_activity_id!,
      recordVersion: 1,
      createdAt: row.created_at.toISOString(),
    };
  }
  return {
    id: row.id,
    jobCardId: row.job_card_id,
    note: row.note,
    invoiceNumber: row.invoice_number,
    author: {
      id: row.author_id,
      name: row.author_name,
      role: null,
      source: 'LEGACY_CURRENT',
    },
    workflowStage: null,
    context: null,
    relatedActivityId: null,
    recordVersion: 0,
    createdAt: row.created_at.toISOString(),
  };
}
const DELIVERY_COLUMNS = `id, organization_id, job_card_id, product_id, delivery_purpose,
  delivered_at, quantity, unit, product_name_snapshot, product_sku_snapshot,
  product_model_snapshot, lot_no, serial_no, expiry_date, delivery_note`;
function mapDelivery(row: DeliveryRow): DeliveryItemRecord {
  return { id: row.id, organizationId: row.organization_id, jobCardId: row.job_card_id,
    productId: row.product_id, deliveryPurpose: row.delivery_purpose, deliveredAt: row.delivered_at,
    quantity: Number(row.quantity), unit: row.unit, productNameSnapshot: row.product_name_snapshot,
    productSkuSnapshot: row.product_sku_snapshot, productModelSnapshot: row.product_model_snapshot,
    lotNo: row.lot_no, serialNo: row.serial_no, expiryDate: row.expiry_date, deliveryNote: row.delivery_note };
}

function mapJobCard(row: JobCardRow): JobCard {
  return {
    id: row.id, organizationId: row.organization_id, type: row.type, status: row.status,
    version: row.version, title: row.title, description: row.description,
    customerId: row.customer_id, contactId: row.contact_id, assignedTo: row.assigned_to, createdBy: row.created_by,
    priority: row.priority, dueDate: mapCalendarDate(row.due_date),
    scheduledAt: mapInstant(row.scheduled_at),
    scheduledEndsAt: mapInstant(row.scheduled_ends_at),
    engagementKind: row.engagement_kind,
    sourceJobCardId: row.source_job_card_id,
    followUpInstructions: row.follow_up_instructions,
    followUpProposedAt: mapInstant(row.follow_up_proposed_at),
    followUpProposedType: row.follow_up_proposed_type,
    followUpProposedAssignee: row.follow_up_proposed_assignee,
    followUpProposalInstructions: row.follow_up_proposal_instructions,
    followUpProposalOrigin: row.follow_up_proposal_origin,
    followUpProposedBy: row.follow_up_proposed_by,
    invalidatedAt: mapInstant(row.invalidated_at),
    invalidatedBy: row.invalidated_by,
    invalidationReasonCode: row.invalidation_reason_code,
  };
}

const JOB_CARD_BASE_COLUMNS = `id, organization_id, type, status, version, title, description,
  customer_id, contact_id, assigned_to, created_by, priority, due_date, scheduled_at,
  scheduled_ends_at, engagement_kind, source_job_card_id, follow_up_instructions,
  follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
  follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by,
  invalidated_at, invalidated_by, invalidation_reason_code`;

const FOLLOW_UP_SOURCE_QUERY = `SELECT j.id, j.organization_id, j.type, j.status,
       j.customer_id, j.contact_id, j.assigned_to, j.source_job_card_id,
       j.scheduled_at, j.started_at, j.staff_completed_at, j.manager_approved_at,
       c.id AS customer_id_join, c.name AS customer_name, c.customer_type, c.status AS customer_status,
       ct.id AS contact_id_join, ct.name AS contact_name, ct.title AS contact_title,
       md.meeting_at, md.outcome
  FROM job_cards j
  LEFT JOIN customers c
    ON c.organization_id = j.organization_id AND c.id = j.customer_id
  LEFT JOIN contacts ct
    ON ct.organization_id = j.organization_id AND ct.id = j.contact_id
  LEFT JOIN job_card_meeting_details md
    ON md.organization_id = j.organization_id AND md.job_card_id = j.id
 WHERE j.organization_id = $1 AND j.id = $2`;

type FollowUpSourceRow = {
  id: string; organization_id: string; type: JobCard['type']; status: JobCardStatus;
  customer_id: string | null; contact_id: string | null; assigned_to: string;
  source_job_card_id: string | null;
  scheduled_at: Date | null; started_at: Date | null;
  staff_completed_at: Date | null; manager_approved_at: Date | null;
  customer_id_join: string | null; customer_name: string | null;
  customer_type: string | null; customer_status: string | null;
  contact_id_join: string | null; contact_name: string | null; contact_title: string | null;
  meeting_at: Date | null; outcome: MeetingOutcome | null;
};

function mapFollowUpSource(row: FollowUpSourceRow): FollowUpSourceReference {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    status: row.status,
    customerId: row.customer_id,
    contactId: row.contact_id,
    sourceJobCardId: row.source_job_card_id,
    assignedTo: row.assigned_to,
    scheduledAt: mapInstant(row.scheduled_at),
    startedAt: mapInstant(row.started_at),
    staffCompletedAt: mapInstant(row.staff_completed_at),
    managerApprovedAt: mapInstant(row.manager_approved_at),
    customer: row.customer_id_join === null
      ? null
      : {
          id: row.customer_id_join,
          name: row.customer_name ?? '',
          customerType: row.customer_type ?? '',
          status: row.customer_status ?? '',
        },
    contact: row.contact_id_join === null
      ? null
      : { id: row.contact_id_join, name: row.contact_name ?? '', title: row.contact_title },
    meetingAt: mapInstant(row.meeting_at),
    outcome: row.outcome,
  };
}

function mapCalendarDate(value: string | Date | null) {
  if (value === null || typeof value === 'string') return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const JOB_CARD_DETAIL_QUERY = `SELECT j.id, j.organization_id, j.type, j.status, j.version,
       org.timezone AS organization_timezone,
       j.title, j.description, j.customer_id, j.contact_id, j.assigned_to, j.created_by,
       j.priority, j.due_date, j.scheduled_at, j.scheduled_ends_at, j.engagement_kind,
        j.source_job_card_id, j.follow_up_instructions,
        j.follow_up_proposed_at, j.follow_up_proposed_type,
        j.follow_up_proposed_assignee, j.follow_up_proposal_instructions,
        j.follow_up_proposal_origin, j.follow_up_proposed_by,
        j.created_at, j.accepted_at, j.started_at,
        j.staff_completed_at, j.staff_completion_note,
       j.manager_approved_at, j.manager_approval_note,
       j.revision_requested_at, j.revision_reason,
       j.cancelled_at, j.cancel_reason,
       j.invalidated_at, j.invalidated_by, j.invalidation_reason_code,
       assignee.id AS assignee_id, assignee.name AS assignee_name,
       customer.id AS customer_id_join, customer.name AS customer_name,
       contact.id AS contact_id_join, contact.name AS contact_name,
       accepter.id AS accepter_id, accepter.name AS accepter_name,
       submitter.id AS submitter_id, submitter.name AS submitter_name,
       approver.id AS approver_id, approver.name AS approver_name,
       revision_actor.id AS revision_actor_id, revision_actor.name AS revision_actor_name,
       cancellation_actor.id AS cancellation_actor_id,
       cancellation_actor.name AS cancellation_actor_name,
       invalidated_actor.id AS invalidated_actor_id,
       invalidated_actor.name AS invalidated_actor_name,
       proposer.id AS proposer_id, proposer.name AS proposer_name,
       cancellation.cancelled_from_status,
       invalidation.invalidated_from_status
FROM job_cards j
JOIN organizations org
  ON org.id = j.organization_id
JOIN users assignee
  ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
LEFT JOIN customers customer
  ON customer.organization_id = j.organization_id AND customer.id = j.customer_id
LEFT JOIN contacts contact
  ON contact.organization_id = j.organization_id AND contact.id = j.contact_id
LEFT JOIN users accepter
  ON accepter.organization_id = j.organization_id AND accepter.id = j.accepted_by
LEFT JOIN users submitter
  ON submitter.organization_id = j.organization_id AND submitter.id = j.staff_completed_by
LEFT JOIN users approver
  ON approver.organization_id = j.organization_id AND approver.id = j.manager_approved_by
LEFT JOIN users revision_actor
  ON revision_actor.organization_id = j.organization_id
  AND revision_actor.id = j.revision_requested_by
LEFT JOIN users cancellation_actor
  ON cancellation_actor.organization_id = j.organization_id
  AND cancellation_actor.id = j.cancelled_by
LEFT JOIN users invalidated_actor
  ON invalidated_actor.organization_id = j.organization_id
  AND invalidated_actor.id = j.invalidated_by
LEFT JOIN users proposer
  ON proposer.organization_id = j.organization_id
  AND proposer.id = j.follow_up_proposed_by
LEFT JOIN LATERAL (
  SELECT a.old_value->>'status' AS cancelled_from_status
  FROM job_card_activity_logs a
  WHERE a.organization_id = j.organization_id
    AND a.job_card_id = j.id
    AND a.event_type = 'JOB_CANCELLED'
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
) cancellation ON TRUE
LEFT JOIN LATERAL (
  SELECT a.old_value->>'status' AS invalidated_from_status
  FROM job_card_activity_logs a
  WHERE a.organization_id = j.organization_id
    AND a.job_card_id = j.id
    AND a.event_type = 'JOB_INVALIDATED'
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
) invalidation ON TRUE
WHERE j.organization_id = $1 AND j.id = $2`;

function mapInstant(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapRelatedIdentity(id: string | null | undefined, name: string | null | undefined): RelatedIdentity | null {
  if (id == null || name == null) return null;
  return { id, name };
}

function mapCancelledFromStatus(value: string | null): JobCardStatus | null {
  const status = mapActivityStatus(value);
  if (status === null) return null;
  if (status === 'COMPLETED' || status === 'CANCELLED') return null;
  return status;
}

function mapActivityStatus(value: string | null): JobCardStatus | null {
  if (value === null || !(JOB_CARD_STATUSES as readonly string[]).includes(value)) return null;
  return value as JobCardStatus;
}

function mapLifecycleFacts(row: JobCardDetailRow): JobLifecycleFacts {
  return {
    createdAt: row.created_at.toISOString(),
    acceptedAt: mapInstant(row.accepted_at),
    acceptedBy: mapRelatedIdentity(row.accepter_id, row.accepter_name),
    startedAt: mapInstant(row.started_at),
    submittedAt: mapInstant(row.staff_completed_at),
    submittedBy: mapRelatedIdentity(row.submitter_id, row.submitter_name),
    submissionNote: row.staff_completion_note,
    approvedAt: mapInstant(row.manager_approved_at),
    approvedBy: mapRelatedIdentity(row.approver_id, row.approver_name),
    approvalNote: row.manager_approval_note,
    revisionRequestedAt: mapInstant(row.revision_requested_at),
    revisionRequestedBy: mapRelatedIdentity(row.revision_actor_id, row.revision_actor_name),
    revisionReason: row.revision_reason,
    cancelledAt: mapInstant(row.cancelled_at),
    cancelledBy: mapRelatedIdentity(row.cancellation_actor_id, row.cancellation_actor_name),
    cancelReason: row.cancel_reason,
    cancelledFromStatus: mapCancelledFromStatus(row.cancelled_from_status),
    invalidatedAt: mapInstant(row.invalidated_at),
    invalidatedBy: mapRelatedIdentity(row.invalidated_actor_id, row.invalidated_actor_name),
    invalidationReasonCode: row.invalidation_reason_code,
    invalidatedFromStatus: mapActivityStatus(row.invalidated_from_status),
  };
}

function mapJobCardDetail(row: JobCardDetailRow): PersistedJobCardDetail {
  return {
    ...mapJobCard(row),
    organizationTimezone: row.organization_timezone,
    assignee: { id: row.assignee_id, name: row.assignee_name },
    customer: row.customer_id_join === null
      ? null
      : { id: row.customer_id_join, name: row.customer_name! },
    contact: row.contact_id_join === null
      ? null
      : { id: row.contact_id_join, name: row.contact_name! },
    lifecycle: mapLifecycleFacts(row),
    proposer: mapRelatedIdentity(row.proposer_id, row.proposer_name),
  };
}

function mapJobCardListItem(row: JobCardListRow): PersistedJobCardListItem {
  return {
    id: row.id,
    type: row.type,
    engagementKind: row.engagement_kind,
    status: row.status,
    version: row.version,
    title: row.title,
    priority: row.priority,
    dueDate: mapCalendarDate(row.due_date),
    scheduledAt: mapInstant(row.scheduled_at),
    scheduledEndsAt: mapInstant(row.scheduled_ends_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    staffCompletedAt: row.staff_completed_at?.toISOString() ?? null,
    customer: row.customer_id === null
      ? null
      : { id: row.customer_id, name: row.customer_name! },
    contact: row.contact_id === null
      ? null
      : { id: row.contact_id, name: row.contact_name! },
    assignee: { id: row.assignee_id, name: row.assignee_name },
    deliveryItemCount: Number(row.delivery_item_count),
  };
}

type SqlFilter = { clause: string; values: unknown[] };

const WORKSPACE_JOINS = `FROM job_cards j
  LEFT JOIN customers c
    ON c.organization_id = j.organization_id AND c.id = j.customer_id
  LEFT JOIN contacts ct
    ON ct.organization_id = j.organization_id AND ct.id = j.contact_id`;

const JOB_CARD_LIST_COLUMNS = `j.id, j.type, j.status, j.version, j.title, j.priority, j.due_date,
  j.scheduled_at, j.scheduled_ends_at, j.engagement_kind, j.created_at, j.updated_at, j.staff_completed_at,
  j.source_job_card_id,
  c.id AS customer_id, c.name AS customer_name,
  ct.id AS contact_id, ct.name AS contact_name,
  u.id AS assignee_id, u.name AS assignee_name,
  COALESCE(delivery.delivery_item_count, 0)::int AS delivery_item_count`;

const WORKSPACE_ITEM_JOINS = `${WORKSPACE_JOINS}
  JOIN users u
    ON u.organization_id = j.organization_id AND u.id = j.assigned_to
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS delivery_item_count
    FROM job_card_delivery_items di
    WHERE di.organization_id = j.organization_id AND di.job_card_id = j.id
  ) delivery ON TRUE`;

function statusValues(status: JobCardStatusFilter) {
  if (status === 'all') return null;
  if (status === 'active') {
    return [...ACTIVE_JOB_CARD_STATUSES];
  }
  if (status === 'closed') return ['COMPLETED', 'CANCELLED'];
  return [status];
}

function workspaceWhere(
  scope: JobCardReadScope,
  filters: JobCardBaseFilters & { status?: JobCardStatusFilter },
): SqlFilter {
  const predicates = ['j.organization_id = $1'];
  const values: unknown[] = [scope.organizationId];
  const add = (sql: (position: number) => string, value: unknown) => {
    values.push(value);
    predicates.push(sql(values.length));
  };
  if (scope.assignedTo) add((position) => `j.assigned_to = $${position}`, scope.assignedTo);
  if (filters.assignedTo) add((position) => `j.assigned_to = $${position}`, filters.assignedTo);
  if (filters.type) add((position) => `j.type = $${position}`, filters.type);
  if (filters.customerId) add((position) => `j.customer_id = $${position}`, filters.customerId);
  if (filters.priority) add((position) => `j.priority = $${position}`, filters.priority);
  if (filters.dueAfter) add((position) => `j.due_date >= $${position}::date`, filters.dueAfter);
  if (filters.dueBefore) add((position) => `j.due_date <= $${position}::date`, filters.dueBefore);
  const statuses = statusValues(filters.status ?? 'all');
  if (statuses) add((position) => `j.status = ANY($${position}::varchar[])`, statuses);
  if (filters.q) {
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&');
    add(
      (position) => `(j.title ILIKE $${position} ESCAPE '\\' OR c.name ILIKE $${position} ESCAPE '\\' OR ct.name ILIKE $${position} ESCAPE '\\')`,
      `%${escaped}%`,
    );
  }
  return { clause: predicates.join(' AND '), values };
}

type HistoryRow = {
  id: string;
  title: string;
  type: JobCardType;
  status: JobCardStatus;
  priority: JobCardPriority;
  scheduled_at: Date | null;
  due_date: string | Date | null;
  created_at: Date;
  updated_at: Date;
  manager_approved_at: Date | null;
  source_job_card_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  assignee_id: string;
  assignee_name: string;
  child_count: number | null;
};

const HISTORY_ITEM_COLUMNS = `j.id, j.title, j.type, j.status, j.priority,
  j.scheduled_at, j.due_date, j.created_at, j.updated_at, j.manager_approved_at,
  j.source_job_card_id,
  c.id AS customer_id, c.name AS customer_name,
  ct.id AS contact_id, ct.name AS contact_name,
  u.id AS assignee_id, u.name AS assignee_name`;

const HISTORY_JOINS = `
  LEFT JOIN customers c
    ON c.organization_id = j.organization_id AND c.id = j.customer_id
  LEFT JOIN contacts ct
    ON ct.organization_id = j.organization_id AND ct.id = j.contact_id
  JOIN users u
    ON u.organization_id = j.organization_id AND u.id = j.assigned_to`;

const HISTORY_OPEN_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const;

type HistoryQuery = CustomerJobHistoryQuery | StaffJobHistoryQuery;

function historyWhere(input: HistoryQuery): SqlFilter {
  const predicates = ['j.organization_id = $1'];
  const values: unknown[] = [input.actor.organizationId];
  const add = (sql: (position: number) => string, value: unknown) => {
    values.push(value);
    predicates.push(sql(values.length));
  };

  if ('customerId' in input) {
    add((position) => `j.customer_id = $${position}`, input.customerId);
  }
  if ('targetUserId' in input) {
    const targetUserId = input.actor.role === 'STAFF' ? input.actor.id : input.targetUserId;
    add((position) => `j.assigned_to = $${position}`, targetUserId);
  } else if (input.actor.role === 'STAFF') {
    add((position) => `j.assigned_to = $${position}`, input.actor.id);
  }

  if (input.status === 'open') {
    add((position) => `j.status = ANY($${position}::varchar[])`, [...HISTORY_OPEN_STATUSES]);
  } else if (input.status === 'completed') {
    predicates.push("j.status = 'COMPLETED'");
  } else if (input.status && input.status !== 'all') {
    const statuses: readonly JobCardStatus[] = Array.isArray(input.status)
      ? input.status
      : [input.status as JobCardStatus];
    add((position) => statuses.length === 1
      ? `j.status = $${position}`
      : `j.status = ANY($${position}::varchar[])`, statuses.length === 1 ? statuses[0] : [...statuses]);
  }
  if (input.type) add((position) => `j.type = $${position}`, input.type);
  return { clause: predicates.join(' AND '), values };
}

function mapHistoryItem(row: HistoryRow): JobHistoryItem {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    priority: row.priority,
    scheduledAt: mapInstant(row.scheduled_at),
    dueDate: mapCalendarDate(row.due_date),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.manager_approved_at?.toISOString() ?? null,
    assignee: { id: row.assignee_id, name: row.assignee_name },
    customer: row.customer_id === null ? null : { id: row.customer_id, name: row.customer_name ?? '' },
    contact: row.contact_id === null ? null : { id: row.contact_id, name: row.contact_name ?? '' },
    followUp: row.source_job_card_id === null ? null : { sourceJobCardId: row.source_job_card_id },
    childCount: row.child_count === null ? null : Number(row.child_count),
  };
}

class PostgresJobCardTransaction implements JobCardTransaction {
  private readonly realtime: PostgresRealtimeEventTransaction;
  private readonly notifications: PostgresNotificationTransaction;
  private readonly webPush: PostgresWebPushTransaction;

  constructor(private readonly client: PoolClient) {
    this.realtime = new PostgresRealtimeEventTransaction(client);
    this.notifications = new PostgresNotificationTransaction(client);
    this.webPush = new PostgresWebPushTransaction(client);
  }

  async getJob(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardRow>(
      `SELECT ${JOB_CARD_BASE_COLUMNS}
       FROM job_cards WHERE organization_id = $1 AND id = $2`, [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getJobForUpdate(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardRow>(
      `SELECT ${JOB_CARD_BASE_COLUMNS}
       FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getJobDetail(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardDetailRow>(
      JOB_CARD_DETAIL_QUERY,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCardDetail(result.rows[0]) : null;
  }

  async getFollowUpSource(organizationId: string, sourceJobCardId: string) {
    const result = await this.client.query<FollowUpSourceRow>(
      `${FOLLOW_UP_SOURCE_QUERY} FOR UPDATE OF j`,
      [organizationId, sourceJobCardId],
    );
    return result.rows[0] ? mapFollowUpSource(result.rows[0]) : null;
  }

  async listActiveFollowUpChildrenForUpdate(
    organizationId: string,
    sourceJobCardId: string,
  ) {
    const result = await this.client.query<{ id: string; status: JobCardStatus }>(
      `SELECT id, status
         FROM job_cards
        WHERE organization_id = $1
          AND source_job_card_id = $2
          AND status = ANY($3::varchar[])
        ORDER BY id ASC
        FOR UPDATE`,
      [organizationId, sourceJobCardId, [...ACTIVE_JOB_CARD_STATUSES]],
    );
    return result.rows;
  }

  async transitionWithVersion(input: TransitionInput) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards
       SET status = $4::varchar(30),
           version = version + 1,
           accepted_at = CASE WHEN $10 = 'ACCEPT_ASSIGNMENT' THEN $5 ELSE accepted_at END,
           accepted_by = CASE WHEN $10 = 'ACCEPT_ASSIGNMENT' THEN $6 ELSE accepted_by END,
           started_at = CASE WHEN $10 = 'START' THEN COALESCE(started_at, $5) ELSE started_at END,
           staff_completed_at = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $5 ELSE staff_completed_at END,
           staff_completed_by = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $6 ELSE staff_completed_by END,
           staff_completion_note = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $7 ELSE staff_completion_note END,
           manager_approved_at = CASE WHEN $10 = 'APPROVE' THEN $5 ELSE manager_approved_at END,
           manager_approved_by = CASE WHEN $10 = 'APPROVE' THEN $6 ELSE manager_approved_by END,
           manager_approval_note = CASE WHEN $10 = 'APPROVE' THEN $7 ELSE manager_approval_note END,
           revision_requested_at = CASE WHEN $10 = 'REQUEST_REVISION' THEN $5 ELSE revision_requested_at END,
           revision_requested_by = CASE WHEN $10 = 'REQUEST_REVISION' THEN $6 ELSE revision_requested_by END,
           revision_reason = CASE WHEN $10 = 'REQUEST_REVISION' THEN $8 ELSE revision_reason END,
            cancelled_at = CASE WHEN $10 = 'CANCEL' THEN $5 ELSE cancelled_at END,
            cancelled_by = CASE WHEN $10 = 'CANCEL' THEN $6 ELSE cancelled_by END,
            cancel_reason = CASE WHEN $10 = 'CANCEL' THEN $9 ELSE cancel_reason END,
            follow_up_proposed_at = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $11::timestamptz ELSE follow_up_proposed_at END,
            follow_up_proposed_type = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $12::varchar(40) ELSE follow_up_proposed_type END,
            follow_up_proposed_assignee = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $13::uuid ELSE follow_up_proposed_assignee END,
            follow_up_proposal_instructions = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $14 ELSE follow_up_proposal_instructions END,
            follow_up_proposal_origin = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $15::varchar(20) ELSE follow_up_proposal_origin END,
            follow_up_proposed_by = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $16::uuid ELSE follow_up_proposed_by END,
            updated_at = $5
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING ${JOB_CARD_BASE_COLUMNS}`,
      [input.organizationId, input.jobCardId, input.expectedVersion, input.status, input.occurredAt,
        input.actorId ?? null, input.note ?? null, input.revisionReason ?? null,
        input.cancelReason ?? null, input.command,
        input.followUpProposal?.scheduledAt ?? null,
        input.followUpProposal?.type ?? null,
        input.followUpProposal?.assignedTo ?? null,
        input.followUpProposal?.instructions ?? null,
        input.followUpProposal?.origin ?? null,
        input.followUpProposal?.proposedBy ?? null],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async invalidateWithVersion(input: JobCardInvalidationUpdateInput) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards
          SET status = 'INVALIDATED',
              version = version + 1,
              invalidated_at = $4,
              invalidated_by = $5,
              invalidation_reason_code = $6,
              updated_at = $4
        WHERE organization_id = $1
          AND id = $2
          AND version = $3
          AND status <> 'INVALIDATED'
       RETURNING ${JOB_CARD_BASE_COLUMNS}`,
      [
        input.organizationId,
        input.jobCardId,
        input.expectedVersion,
        input.invalidatedAt,
        input.invalidatedBy,
        input.reasonCode,
      ],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async appendActivity(input: ActivityInput): Promise<AppendedActivity> {
    const result = await this.client.query<{ id: string; created_at: Date }>(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, old_value, new_value, metadata, client_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [input.organizationId, input.jobCardId, input.actorId, input.event,
        input.oldValue ?? null, input.newValue ?? null, input.metadata ?? null,
        input.clientActionId ?? null],
    );
    return { id: result.rows[0]!.id, createdAt: result.rows[0]!.created_at };
  }

  async appendAudit(input: JobCardAuditInput): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id,
          event_type, old_value, new_value, metadata)
       VALUES ($1, $2, 'JOB_CARD', $3, 'JOB_CARD_INVALIDATED', $4, $5, $6)`,
      [
        input.organizationId,
        input.actorUserId,
        input.subjectId,
        input.oldValue,
        input.newValue,
        input.metadata ?? {},
      ],
    );
  }

  async appendJobActionLocation(
    input: AppendJobActionLocationInput,
  ): Promise<JobActionLocationRecord> {
    const capture = input.capture;
    const captured = capture.outcome === 'CAPTURED' ? capture : null;
    const result = await this.client.query<JobActionLocationRow>(
      `INSERT INTO job_action_locations
         (organization_id, job_card_id, activity_id, actor_user_id, action,
          capture_outcome, failure_reason, latitude, longitude, accuracy_meters,
          captured_at, geocoding_status, geocoding_provider, neighborhood,
          district, city, approximate_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17)
       RETURNING id, organization_id, job_card_id, activity_id, actor_user_id,
                 action, capture_outcome, failure_reason, latitude, longitude,
                 accuracy_meters, captured_at, geocoding_status,
                 geocoding_provider, neighborhood, district, city,
                 approximate_label, created_at`,
      [
        input.organizationId,
        input.jobCardId,
        input.activityId,
        input.actorUserId,
        input.action,
        capture.outcome,
        capture.outcome === 'UNAVAILABLE' ? capture.reason : null,
        captured?.latitude ?? null,
        captured?.longitude ?? null,
        captured?.accuracyMeters ?? null,
        captured?.capturedAt ?? null,
        captured?.geocodingStatus ?? 'NOT_REQUESTED',
        captured?.geocodingProvider ?? null,
        captured?.neighborhood ?? null,
        captured?.district ?? null,
        captured?.city ?? null,
        captured?.approximateLabel ?? null,
      ],
    );
    return mapJobActionLocation(result.rows[0]!);
  }

  appendRealtimeEvent(input: RealtimeEventInput) {
    return this.realtime.append(input);
  }

  async listActiveManagementRecipients(organizationId: string) {
    const result = await this.client.query<ActiveManagementRecipient>(
      `SELECT id, role, is_active AS "isActive"
         FROM users
        WHERE organization_id = $1
          AND is_active = TRUE
          AND role IN ('ADMIN', 'MANAGER')
        ORDER BY id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  appendNotifications(input: NotificationAppendInput) {
    return this.notifications.append(input);
  }

  appendWebPushDeliveries(input: AppendWebPushDeliveriesInput) {
    return this.webPush.appendDeliveries(input);
  }

  async getNoteAuthorSnapshot(organizationId: string, authorId: string) {
    const result = await this.client.query<{
      id: string;
      name: string;
      role: JobCardAssignee['role'];
      is_active: boolean;
    }>(
      `SELECT id, name, role, is_active
         FROM users
        WHERE organization_id = $1 AND id = $2
        FOR SHARE`,
      [organizationId, authorId],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, name: row.name, role: row.role, isActive: row.is_active }
      : null;
  }

  async createNote(input: CreateNoteRecord) {
    const result = await this.client.query<NoteRow>(
      `WITH inserted AS (
         INSERT INTO job_card_notes (
           id, organization_id, job_card_id, author_id, note, invoice_number,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
         RETURNING id, organization_id, job_card_id, author_id, note, invoice_number,
           author_name_snapshot, author_role_snapshot, workflow_stage,
           context, related_activity_id, record_version, created_at
       )
       SELECT n.id, n.job_card_id, n.note, n.author_id, n.invoice_number,
         u.name AS author_name,
         n.author_name_snapshot, n.author_role_snapshot, n.workflow_stage,
         n.context, n.related_activity_id, n.record_version, n.created_at
       FROM inserted n
       JOIN users u ON u.organization_id = n.organization_id AND u.id = n.author_id`,
      [
        input.id,
        input.organizationId,
        input.jobCardId,
        input.authorId,
        input.note,
        input.invoiceNumber,
        input.authorNameSnapshot,
        input.authorRoleSnapshot,
        input.workflowStage,
        input.context,
        input.relatedActivityId,
      ],
    );
    return mapNote(result.rows[0]!);
  }

  async getAssigneeForUpdate(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(
      `SELECT id, organization_id, role, is_active FROM users
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getAssignee(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(`SELECT id, organization_id, role, is_active FROM users
        WHERE organization_id = $1 AND id = $2`, [organizationId, userId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getCustomerForUpdate(organizationId: string, customerId: string) {
    const result = await this.client.query<{ id: string; status: JobCustomerReference['status'] }>(
      `SELECT id, status FROM customers WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, customerId],
    );
    return result.rows[0] ?? null;
  }

  async getOrganizationTimezone(organizationId: string) {
    const result = await this.client.query<{ timezone: string }>(
      `SELECT timezone FROM organizations WHERE id = $1`,
      [organizationId],
    );
    return result.rows[0]?.timezone ?? 'Europe/Istanbul';
  }

  async listActiveOnSiteJobs(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<ActiveOnSiteJobRecord[]> {
    const result = await this.client.query<{
      id: string; title: string; scheduled_at: Date; type: JobCardType;
      status: JobCardStatus; assigned_to: string; assignee_name: string;
    }>(
      `SELECT j.id, j.title, j.scheduled_at, j.type, j.status,
              j.assigned_to, u.name AS assignee_name
         FROM job_cards j
         JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
        WHERE j.organization_id = $1 AND j.customer_id = $2
          AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
          AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
          AND j.scheduled_at IS NOT NULL
          AND j.scheduled_at >= $3 AND j.scheduled_at <= $4
        ORDER BY j.scheduled_at ASC, j.id ASC`,
      [organizationId, customerId, from, to],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      scheduledAt: row.scheduled_at.toISOString(),
      type: row.type,
      status: row.status,
      assignedTo: row.assigned_to,
      assigneeName: row.assignee_name,
    }));
  }

  async listRecentOnSiteVisits(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<RecentOnSiteVisitRecord[]> {
    const result = await this.client.query<{
      id: string; type: JobCardType; title: string;
      meeting_at: Date | null; latest_delivered_at: Date | null;
      staff_completed_at: Date | null; scheduled_at: Date | null;
      staff_completion_note: string | null; staff_name: string;
    }>(
      `SELECT j.id, j.type, j.title, j.staff_completion_note,
              md.meeting_at, di.latest_delivered_at,
              j.staff_completed_at, j.scheduled_at, u.name AS staff_name
         FROM job_cards j
         JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
         LEFT JOIN job_card_meeting_details md
           ON md.organization_id = j.organization_id AND md.job_card_id = j.id
         LEFT JOIN LATERAL (
           SELECT MAX(delivered_at) AS latest_delivered_at
             FROM job_card_delivery_items d
            WHERE d.organization_id = j.organization_id AND d.job_card_id = j.id
         ) di ON TRUE
        WHERE j.organization_id = $1 AND j.customer_id = $2
          AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
          AND j.status = 'COMPLETED'
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) >= $3
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) <= $4
        ORDER BY 5 ASC`,
      [organizationId, customerId, from, to],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      occurredAt: (
        row.meeting_at ?? row.latest_delivered_at ?? row.staff_completed_at ?? row.scheduled_at
      )!.toISOString(),
      staffName: row.staff_name,
      resultSummary: row.staff_completion_note,
    }));
  }

  async listAssigneeCalendarIntervals(
    organizationId: string,
    assignedUserId: string,
    from: Date,
    to: Date,
    excludeJobId: string | null,
  ): Promise<AssigneeCalendarInterval[]> {
    const result = await this.client.query<{ starts_at: Date; ends_at: Date }>(
      `SELECT e.starts_at, e.ends_at
         FROM calendar_events e
        WHERE e.organization_id = $1 AND e.assigned_user_id = $2
          AND e.status = 'ACTIVE'
          AND e.starts_at < $4 AND $3 < e.ends_at
       UNION ALL
       SELECT j.scheduled_at, j.scheduled_ends_at
         FROM job_cards j
        WHERE j.organization_id = $1 AND j.assigned_to = $2
          AND ($5::uuid IS NULL OR j.id <> $5)
          AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
        AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
          AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
          AND j.scheduled_at < $4 AND $3 < j.scheduled_ends_at
        ORDER BY starts_at ASC, ends_at ASC`,
      [organizationId, assignedUserId, from, to, excludeJobId],
    );
    return result.rows.map((row) => ({
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
    }));
  }

  async customerExists(organizationId: string, customerId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM customers WHERE organization_id=$1 AND id=$2 LIMIT 1`, [organizationId, customerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSubmissionCustomer(organizationId: string, customerId: string) {
    const result = await this.client.query<{
      id: string;
      organization_id: string;
      status: SubmissionCustomer['status'];
    }>(
      `SELECT id, organization_id, status
         FROM customers
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, customerId],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, organizationId: row.organization_id, status: row.status }
      : null;
  }

  async getContactForUpdate(organizationId: string, contactId: string) {
    const result = await this.client.query<{ id: string; customer_id: string; is_active: boolean }>(
      `SELECT id, customer_id, is_active FROM contacts
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, contactId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, customerId: row.customer_id, isActive: row.is_active } : null;
  }

  async createJobCard(input: CreateJobCardRecord) {
    const result = await this.client.query<JobCardRow>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, description, customer_id, contact_id,
          assigned_to, created_by, priority, due_date, scheduled_at, scheduled_ends_at,
          engagement_kind, accepted_at, accepted_by, source_job_card_id, follow_up_instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING ${JOB_CARD_BASE_COLUMNS}`,
      [input.organizationId, input.type, input.status, input.title, input.description,
        input.customerId, input.contactId, input.assignedTo, input.createdBy, input.priority,
        input.dueDate, input.scheduledAt, input.scheduledEndsAt, input.engagementKind,
        input.acceptedAt, input.acceptedBy, input.sourceJobCardId, input.followUpInstructions],
    );
    return mapJobCard(result.rows[0]!);
  }

  async createMeetingDetails(input: { organizationId: string; jobCardId: string }) {
    await this.client.query(
      `INSERT INTO job_card_meeting_details (organization_id, job_card_id)
       VALUES ($1, $2)`,
      [input.organizationId, input.jobCardId],
    );
  }

  async getSubmissionMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.client.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2
        FOR UPDATE`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async updateMeetingDetails(input: MeetingDetailsRecord) {
    await this.client.query(
      `UPDATE job_card_meeting_details
          SET meeting_at = $3, outcome = $4, meeting_summary = $5,
              next_follow_up_at = $6, updated_at = NOW()
        WHERE organization_id = $1 AND job_card_id = $2`,
      [input.organizationId, input.jobCardId, input.meetingAt, input.outcome,
        input.meetingSummary, input.nextFollowUpAt],
    );
  }

  async updateFieldsWithVersion(input: UpdateJobCardInput) {
    const columns: Record<string, string> = {
      title: 'title', description: 'description', customerId: 'customer_id', contactId: 'contact_id',
      assignedTo: 'assigned_to', priority: 'priority', dueDate: 'due_date',
      scheduledAt: 'scheduled_at', scheduledEndsAt: 'scheduled_ends_at',
      status: 'status', engagementKind: 'engagement_kind',
    };
    const values: unknown[] = [input.organizationId, input.jobCardId, input.expectedVersion];
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(input.fields)) {
      if (key === 'clearAcceptance') continue;
      const column = columns[key];
      if (!column) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (input.fields.clearAcceptance) {
      assignments.push('accepted_at = NULL', 'accepted_by = NULL');
    }
    if (assignments.length === 0) return null;
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards SET ${assignments.join(', ')}, version = version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING ${JOB_CARD_BASE_COLUMNS}`, values,
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async assertCalendarAvailability(
    input: Omit<JobCalendarSchedule, 'version' | 'active' | 'now' | 'reminderLeadMinutes'>,
  ) {
    if (!input.startsAt || !input.endsAt) return;
    const result = await this.client.query<{
      source: 'JOB' | 'MANUAL';
      id: string;
      title: string;
      starts_at: Date;
      ends_at: Date;
      assigned_user_name: string;
      related_job_path: string | null;
    }>(
      `SELECT 'MANUAL'::text AS source, e.id, e.title, e.starts_at, e.ends_at,
         u.name AS assigned_user_name, NULL::text AS related_job_path
       FROM calendar_events e
       JOIN users u ON u.organization_id = e.organization_id AND u.id = e.assigned_user_id
       WHERE e.organization_id = $1 AND e.assigned_user_id = $2
         AND e.status = 'ACTIVE' AND e.starts_at < $4 AND $3 < e.ends_at
       UNION ALL
       SELECT 'JOB', j.id, j.title, j.scheduled_at, j.scheduled_ends_at,
         u.name, '/jobs/' || j.id::text
       FROM job_cards j
       JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
       WHERE j.organization_id = $1 AND j.assigned_to = $2
         AND ($5::uuid IS NULL OR j.id <> $5)
         AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
         AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
         AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
         AND j.scheduled_at < $4 AND $3 < j.scheduled_ends_at
       ORDER BY starts_at ASC, id ASC LIMIT 10`,
      [
        input.organizationId,
        input.assignedUserId,
        input.startsAt,
        input.endsAt,
        input.jobCardId,
      ],
    );
    if (result.rows.length === 0) return;
    throw new AppError(
      'CALENDAR_CONFLICT',
      409,
      'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.',
      {
        conflicts: result.rows.map((row) => ({
          source: row.source,
          id: row.id,
          title: row.title,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          assignedUser: {
            id: input.assignedUserId,
            name: row.assigned_user_name,
          },
          relatedJobPath: row.related_job_path,
        })),
      },
    );
  }

  async synchronizeCalendarReminder(input: JobCalendarSchedule) {
    await this.client.query(
      `UPDATE calendar_reminders
       SET state = 'CANCELLED', cancelled_at = $3, lease_token = NULL,
         lease_until = NULL, updated_at = $3
       WHERE organization_id = $1 AND job_card_id = $2
         AND state IN ('PENDING', 'CLAIMED')`,
      [input.organizationId, input.jobCardId, input.now],
    );
    if (!input.active || !input.startsAt || Date.parse(input.startsAt) <= input.now.valueOf()) {
      return;
    }
    const remindAt = new Date(Math.max(
      input.now.valueOf(),
      Date.parse(input.startsAt) - input.reminderLeadMinutes * 60_000,
    ));
    await this.client.query(
      `INSERT INTO calendar_reminders
        (organization_id, job_card_id, recipient_user_id, remind_at,
         next_attempt_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$4,$5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.organizationId,
        input.jobCardId,
        input.assignedUserId,
        remindAt,
        `JOB:${input.jobCardId}:${input.assignedUserId}:${input.startsAt}:v${input.version}:lead${input.reminderLeadMinutes}`,
      ],
    );
  }

  async getProduct(organizationId: string, productId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; name: string; sku: string | null;
      model: string | null; unit: string | null; is_active: boolean;
    }>(
      `SELECT id, organization_id, name, sku, model, unit, is_active FROM products
       WHERE organization_id = $1 AND id = $2`, [organizationId, productId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, name: row.name, sku: row.sku,
      model: row.model, unit: row.unit, isActive: row.is_active } : null;
  }

  async getDeliveryItemForUpdate(organizationId: string, jobCardId: string, itemId: string) {
    const result = await this.client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id = $1 AND job_card_id = $2 AND id = $3 FOR UPDATE`,
      [organizationId, jobCardId, itemId]);
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async createDeliveryItem(input: Omit<DeliveryItemRecord, 'id'>) {
    const result = await this.client.query<DeliveryRow>(
      `INSERT INTO job_card_delivery_items
       (organization_id, job_card_id, product_id, delivery_purpose, delivered_at, quantity, unit,
        product_name_snapshot, product_sku_snapshot, product_model_snapshot, lot_no, serial_no, expiry_date, delivery_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${DELIVERY_COLUMNS}`,
      [input.organizationId, input.jobCardId, input.productId, input.deliveryPurpose, input.deliveredAt,
        input.quantity, input.unit, input.productNameSnapshot, input.productSkuSnapshot,
        input.productModelSnapshot, input.lotNo, input.serialNo, input.expiryDate, input.deliveryNote]);
    return mapDelivery(result.rows[0]!);
  }

  async updateDeliveryItem(itemId: string, input: Omit<DeliveryItemRecord, 'id'>) {
    const result = await this.client.query<DeliveryRow>(
      `UPDATE job_card_delivery_items SET product_id=$2, delivery_purpose=$3, delivered_at=$4,
       quantity=$5, unit=$6, product_name_snapshot=$7, product_sku_snapshot=$8,
       product_model_snapshot=$9, lot_no=$10, serial_no=$11, expiry_date=$12,
       delivery_note=$13, updated_at=NOW() WHERE id=$1 RETURNING ${DELIVERY_COLUMNS}`,
      [itemId, input.productId, input.deliveryPurpose, input.deliveredAt, input.quantity, input.unit,
        input.productNameSnapshot, input.productSkuSnapshot, input.productModelSnapshot, input.lotNo,
        input.serialNo, input.expiryDate, input.deliveryNote]);
    return mapDelivery(result.rows[0]!);
  }

  async deleteDeliveryItem(itemId: string) { await this.client.query('DELETE FROM job_card_delivery_items WHERE id = $1', [itemId]); }

  async bumpVersion(organizationId: string, jobCardId: string, expectedVersion: number) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards SET version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND version=$3
       RETURNING ${JOB_CARD_BASE_COLUMNS}`, [organizationId, jobCardId, expectedVersion]);
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getSubmissionDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2
       ORDER BY sort_order, created_at, id FOR UPDATE`, [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
  }
}

export class PostgresJobCardRepository
implements JobCardRepository, ApprovalQueueItemPort, JobHistoryReadPort {
  constructor(private readonly pool: Pool) {}

  async findCompletedCriticalAction<T>(claim: CriticalActionClaim): Promise<T | null> {
    const result = await this.pool.query<{ response_body: T; request_hash: string | null }>(
      `SELECT response_body, request_hash
       FROM processed_actions
       WHERE organization_id = $1 AND user_id = $2
         AND client_action_id = $3 AND operation_key = $4
         AND status = 'completed' AND response_body IS NOT NULL`,
      [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
    );
    if (result.rows[0]) {
      assertCriticalActionRequestHash(claim.requestHash, result.rows[0].request_hash);
    }
    return result.rows[0]?.response_body ?? null;
  }

  async executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (
      transaction: JobCardTransaction,
    ) => Promise<CriticalActionWorkResult<T>>,
  ): Promise<CriticalActionResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status)
         VALUES ($1, $2, $3, $4, $5, 'processing')
         ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING
         RETURNING id`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey, claim.requestHash ?? null],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<{
          status: string;
          response_body: T | null;
          request_hash: string | null;
        }>(
          `SELECT status, response_body, request_hash FROM processed_actions
           WHERE organization_id = $1 AND user_id = $2
             AND client_action_id = $3 AND operation_key = $4`,
          [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
        );
        const action = existing.rows[0];
        assertCriticalActionRequestHash(claim.requestHash, action?.request_hash);
        await client.query('COMMIT');
        if (action?.status === 'completed' && action.response_body !== null) {
          return { kind: 'replay', response: action.response_body, realtimeEvents: [] };
        }
        return { kind: 'processing' };
      }

      const workResult = await work(new PostgresJobCardTransaction(client));
      await client.query(
        `UPDATE processed_actions
         SET status = 'completed', status_code = 200, response_body = $2, completed_at = NOW()
         WHERE id = $1`,
        [claimed.rows[0]!.id, workResult.response],
      );
      await client.query('COMMIT');
      return {
        kind: 'completed',
        response: workResult.response,
        realtimeEvents: workResult.realtimeEvents,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]> {
    const rows = await this.pool.query<JobCardListRow & { waiting_minutes: number }>(
      `SELECT ${JOB_CARD_LIST_COLUMNS},
       FLOOR(EXTRACT(EPOCH FROM GREATEST(
         $2::timestamptz - j.staff_completed_at,
         interval '0 seconds')) / 60)::int AS waiting_minutes
       ${WORKSPACE_ITEM_JOINS}
       WHERE j.organization_id = $1 AND j.status = 'WAITING_APPROVAL'
       ORDER BY j.staff_completed_at ASC, j.id ASC
       LIMIT $3 OFFSET $4`,
      [input.organizationId, input.requestTime, input.limit, input.offset],
    );
    return rows.rows.map((row) => ({
      ...mapJobCardListItem(row),
      waitingMinutes: Number(row.waiting_minutes),
    }));
  }

  async listJobCards(scope: JobCardReadScope, query: JobCardListQuery, requestTime: Date) {
    const filter = workspaceWhere(scope, query);
    let countJoins = WORKSPACE_JOINS;
    let itemJoins = WORKSPACE_ITEM_JOINS;
    let clause = filter.clause;
    let values = filter.values;
    if (query.overdue) {
      countJoins = `${WORKSPACE_JOINS}
  JOIN organizations o ON o.id = j.organization_id`;
      itemJoins = `${WORKSPACE_ITEM_JOINS}
  JOIN organizations o ON o.id = j.organization_id`;
      const datePosition = values.length + 1;
      values = [...values, requestTime];
      // Parse guarantees status is omitted or 'active'; workspaceWhere already
      // restricts to the five actionable statuses in that case.
      clause = `${filter.clause}
    AND j.due_date IS NOT NULL
    AND j.due_date < ($${datePosition}::timestamptz AT TIME ZONE o.timezone)::date`;
    }
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       ${countJoins}
       WHERE ${clause}`,
      values,
    );
    const limitPosition = values.length + 1;
    const offsetPosition = values.length + 2;
    const order = query.status === 'WAITING_APPROVAL'
      ? 'j.staff_completed_at ASC, j.id ASC'
      : 'j.updated_at DESC, j.id DESC';
    const items = await this.pool.query<JobCardListRow>(
      `SELECT ${JOB_CARD_LIST_COLUMNS}
       ${itemJoins}
       WHERE ${clause}
       ORDER BY ${order}
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      [...values, query.limit, query.offset],
    );
    return {
      items: items.rows.map(mapJobCardListItem),
      total: Number(count.rows[0]?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async listBoard(scope: JobCardReadScope, query: JobCardBoardQuery) {
    const countFilter = workspaceWhere(scope, query);
    const counts = await this.pool.query<{ status: JobCardStatus; count: number }>(
      `SELECT j.status, COUNT(*)::int AS count
       ${WORKSPACE_JOINS}
       WHERE ${countFilter.clause}
       GROUP BY j.status`,
      countFilter.values,
    );
    const itemFilter = workspaceWhere(scope, { ...query, status: 'active' });
    const limitPosition = itemFilter.values.length + 1;
    const items = await this.pool.query<JobCardListRow>(
      `WITH ranked AS (
         SELECT ${JOB_CARD_LIST_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY j.status ORDER BY j.updated_at DESC, j.id DESC) AS row_number
         ${WORKSPACE_ITEM_JOINS}
         WHERE ${itemFilter.clause}
       )
       SELECT * FROM ranked
       WHERE row_number <= $${limitPosition}
       ORDER BY status, updated_at DESC, id DESC`,
      [...itemFilter.values, query.limit],
    );

    const columns: {
      NEW: { items: PersistedJobCardListItem[]; count: number };
      ACCEPTED: { items: PersistedJobCardListItem[]; count: number };
      IN_PROGRESS: { items: PersistedJobCardListItem[]; count: number };
      WAITING_APPROVAL: { items: PersistedJobCardListItem[]; count: number };
      REVISION_REQUESTED: { items: PersistedJobCardListItem[]; count: number };
    } = {
      NEW: { items: [], count: 0 },
      ACCEPTED: { items: [], count: 0 },
      IN_PROGRESS: { items: [], count: 0 },
      WAITING_APPROVAL: { items: [], count: 0 },
      REVISION_REQUESTED: { items: [], count: 0 },
    };
    const closedCounts = { COMPLETED: 0, CANCELLED: 0 };
    for (const row of counts.rows) {
      if (row.status === 'COMPLETED' || row.status === 'CANCELLED') {
        closedCounts[row.status] = Number(row.count);
      } else if (row.status in columns) {
        columns[row.status as keyof typeof columns].count = Number(row.count);
      }
    }
    for (const row of items.rows) {
      if (row.status in columns) {
        columns[row.status as keyof typeof columns].items.push(mapJobCardListItem(row));
      }
    }
    return { columns, closedCounts };
  }

  async findJobCard(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<JobCardRow>(
      `SELECT ${JOB_CARD_BASE_COLUMNS}
       FROM job_cards WHERE organization_id = $1 AND id = $2`, [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async findJobCardDetail(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<JobCardDetailRow>(
      JOB_CARD_DETAIL_QUERY,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCardDetail(result.rows[0]) : null;
  }

  async getOrganizationTimezone(organizationId: string) {
    const result = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM organizations WHERE id = $1`,
      [organizationId],
    );
    return result.rows[0]?.timezone ?? 'Europe/Istanbul';
  }

  async listActiveOnSiteJobs(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<ActiveOnSiteJobRecord[]> {
    const result = await this.pool.query<{
      id: string; title: string; scheduled_at: Date; type: JobCardType;
      status: JobCardStatus; assigned_to: string; assignee_name: string;
    }>(
      `SELECT j.id, j.title, j.scheduled_at, j.type, j.status,
              j.assigned_to, u.name AS assignee_name
         FROM job_cards j
         JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
        WHERE j.organization_id = $1 AND j.customer_id = $2
          AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
          AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
          AND j.scheduled_at IS NOT NULL
          AND j.scheduled_at >= $3 AND j.scheduled_at <= $4
        ORDER BY j.scheduled_at ASC, j.id ASC`,
      [organizationId, customerId, from, to],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      scheduledAt: row.scheduled_at.toISOString(),
      type: row.type,
      status: row.status,
      assignedTo: row.assigned_to,
      assigneeName: row.assignee_name,
    }));
  }

  async listRecentOnSiteVisits(
    organizationId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<RecentOnSiteVisitRecord[]> {
    const result = await this.pool.query<{
      id: string; type: JobCardType; title: string;
      meeting_at: Date | null; latest_delivered_at: Date | null;
      staff_completed_at: Date | null; scheduled_at: Date | null;
      staff_completion_note: string | null; staff_name: string;
    }>(
      `SELECT j.id, j.type, j.title, j.staff_completion_note,
              md.meeting_at, di.latest_delivered_at,
              j.staff_completed_at, j.scheduled_at, u.name AS staff_name
         FROM job_cards j
         JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
         LEFT JOIN job_card_meeting_details md
           ON md.organization_id = j.organization_id AND md.job_card_id = j.id
         LEFT JOIN LATERAL (
           SELECT MAX(delivered_at) AS latest_delivered_at
             FROM job_card_delivery_items d
            WHERE d.organization_id = j.organization_id AND d.job_card_id = j.id
         ) di ON TRUE
        WHERE j.organization_id = $1 AND j.customer_id = $2
          AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
          AND j.status = 'COMPLETED'
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) >= $3
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) <= $4
        ORDER BY 5 ASC`,
      [organizationId, customerId, from, to],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      occurredAt: (
        row.meeting_at ?? row.latest_delivered_at ?? row.staff_completed_at ?? row.scheduled_at
      )!.toISOString(),
      staffName: row.staff_name,
      resultSummary: row.staff_completion_note,
    }));
  }

  async getFollowUpSource(organizationId: string, sourceJobCardId: string) {
    const result = await this.pool.query<FollowUpSourceRow>(
      FOLLOW_UP_SOURCE_QUERY,
      [organizationId, sourceJobCardId],
    );
    return result.rows[0] ? mapFollowUpSource(result.rows[0]) : null;
  }

  async listFollowUps(
    organizationId: string,
    sourceJobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<PersistedFollowUpListItem>> {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM job_cards
       WHERE organization_id = $1 AND source_job_card_id = $2`,
      [organizationId, sourceJobCardId],
    );
    const items = await this.pool.query<JobCardListRow>(
      `SELECT ${JOB_CARD_LIST_COLUMNS}
       ${WORKSPACE_ITEM_JOINS}
       WHERE j.organization_id = $1 AND j.source_job_card_id = $2
       ORDER BY j.created_at DESC, j.id
       LIMIT $3 OFFSET $4`,
      [organizationId, sourceJobCardId, page.limit, page.offset],
    );
    return {
      items: items.rows.map((row) => ({
        ...mapJobCardListItem(row),
        sourceJobCardId: row.source_job_card_id!,
      })),
      total: Number(count.rows[0]?.total ?? 0),
      limit: page.limit,
      offset: page.offset,
    };
  }

  async listCustomerJobHistory(input: CustomerJobHistoryQuery): Promise<PaginatedJobHistory> {
    return this.listJobHistory({ ...input, customerId: input.customerId });
  }

  async listStaffJobHistory(input: StaffJobHistoryQuery): Promise<PaginatedJobHistory> {
    return this.listJobHistory({ ...input, targetUserId: input.targetUserId });
  }

  private async listJobHistory(
    input: (CustomerJobHistoryQuery & { customerId: string })
      | (StaffJobHistoryQuery & { targetUserId: string }),
  ): Promise<PaginatedJobHistory> {
    const filter = historyWhere(input);
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM job_cards j ${HISTORY_JOINS}
       WHERE ${filter.clause}`,
      filter.values,
    );

    const limitPosition = filter.values.length + 1;
    const offsetPosition = filter.values.length + 2;
    const childCount = input.actor.role === 'STAFF'
      ? 'NULL::int AS child_count'
      : `(SELECT COUNT(*)::int FROM job_cards child
           WHERE child.organization_id = j.organization_id
             AND child.source_job_card_id = j.id) AS child_count`;
    const result = await this.pool.query<HistoryRow>(
      `SELECT ${HISTORY_ITEM_COLUMNS}, ${childCount}
       FROM job_cards j ${HISTORY_JOINS}
       WHERE ${filter.clause}
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      [...filter.values, input.limit, input.offset],
    );
    return {
      items: result.rows.map(mapHistoryItem),
      total: Number(count.rows[0]?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }

  async findMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async getAssignee(organizationId: string, userId: string) {
    const result = await this.pool.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(`SELECT id, organization_id, role, is_active FROM users
        WHERE organization_id = $1 AND id = $2`, [organizationId, userId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getSubmissionCustomer(organizationId: string, customerId: string) {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      status: SubmissionCustomer['status'];
    }>(
      `SELECT id, organization_id, status
         FROM customers
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, customerId],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, organizationId: row.organization_id, status: row.status }
      : null;
  }

  async getSubmissionMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async getSubmissionDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2 ORDER BY sort_order, created_at, id`,
      [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
  }

  async executeTransaction<T>(work: (transaction: JobCardTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresJobCardTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2 ORDER BY sort_order, created_at, id`,
      [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
  }

  async listActivity(organizationId: string, jobCardId: string, page: PageQuery) {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM job_card_activity_logs
       WHERE organization_id=$1 AND job_card_id=$2`,
      [organizationId, jobCardId],
    );
    const result = await this.pool.query<{
      id: string; job_card_id: string; actor_id: string | null; actor_name: string | null;
      event_type: JobCardActivityEvent; old_value: unknown; new_value: unknown; metadata: unknown;
      client_action_id: string | null; created_at: Date;
      location_outcome: 'CAPTURED' | 'UNAVAILABLE' | null;
      location_failure_reason: LocationFailureReason | null;
      location_accuracy_meters: string | null;
      location_captured_at: Date | null;
      location_approximate_label: string | null;
      location_geocoding_provider: 'GOOGLE' | null;
    }>(`SELECT a.id, a.job_card_id, a.actor_id, u.name AS actor_name, a.event_type,
              a.old_value, a.new_value, a.metadata, a.client_action_id, a.created_at,
              l.capture_outcome AS location_outcome,
              l.failure_reason AS location_failure_reason,
              l.accuracy_meters AS location_accuracy_meters,
              l.captured_at AS location_captured_at,
              l.approximate_label AS location_approximate_label,
              l.geocoding_provider AS location_geocoding_provider
       FROM job_card_activity_logs a
       LEFT JOIN users u
         ON u.organization_id = a.organization_id AND u.id = a.actor_id
       LEFT JOIN job_action_locations l
         ON l.organization_id = a.organization_id AND l.activity_id = a.id
       WHERE a.organization_id=$1 AND a.job_card_id=$2
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $3 OFFSET $4`, [organizationId, jobCardId, page.limit, page.offset]);
    return {
      items: result.rows.map((row) => ({
        id: row.id, jobCardId: row.job_card_id, actorId: row.actor_id, actorName: row.actor_name,
        eventType: row.event_type, oldValue: row.old_value, newValue: row.new_value,
        metadata: row.metadata, clientActionId: row.client_action_id, createdAt: row.created_at,
        startLocation: row.location_outcome === 'CAPTURED'
          && row.location_accuracy_meters !== null && row.location_captured_at !== null
          ? {
              outcome: 'CAPTURED' as const,
              approximateLabel: row.location_approximate_label,
              accuracyMeters: Number(row.location_accuracy_meters),
              capturedAt: row.location_captured_at,
              geocodingProvider: row.location_geocoding_provider === 'GOOGLE'
                ? 'GOOGLE' as const
                : null,
            }
          : row.location_outcome === 'UNAVAILABLE' && row.location_failure_reason !== null
            ? { outcome: 'UNAVAILABLE' as const, reason: row.location_failure_reason }
            : null,
      })),
      total: Number(count.rows[0]?.total ?? 0),
      limit: page.limit,
      offset: page.offset,
    };
  }

  async listNotes(organizationId: string, jobCardId: string, page: NotePageQuery) {
    const cursorPredicate = page.before
      ? 'AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)'
      : '';
    const limitPosition = page.before ? '$5' : '$3';
    const values = page.before
      ? [
          organizationId,
          jobCardId,
          page.before.createdAt,
          page.before.id,
          page.limit + 1,
        ]
      : [organizationId, jobCardId, page.limit + 1];
    const result = await this.pool.query<NoteListRow>(
      `SELECT n.id, n.job_card_id, n.note, n.author_id, n.invoice_number,
         u.name AS author_name,
         n.author_name_snapshot, n.author_role_snapshot, n.workflow_stage,
         n.context, n.related_activity_id, n.record_version, n.created_at,
         to_char(
           n.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cursor_created_at
       FROM job_card_notes n
       JOIN users u
         ON u.organization_id = n.organization_id AND u.id = n.author_id
       WHERE n.organization_id=$1 AND n.job_card_id=$2
       ${cursorPredicate}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ${limitPosition}`,
      values,
    );
    const hasMore = result.rows.length > page.limit;
    const pageRows = result.rows.slice(0, page.limit);
    const oldest = pageRows.at(-1);
    return {
      items: pageRows.map(mapNote).reverse(),
      limit: page.limit,
      nextCursor: hasMore && oldest
        ? { createdAt: oldest.cursor_created_at, id: oldest.id }
        : null,
    };
  }

  async listReferenceCustomers(organizationId: string) {
    const result = await this.pool.query<{
      id: string;
      name: string;
      customer_type: string;
      status: string;
      assigned_staff_user_id: string | null;
    }>(
      `SELECT id, name, customer_type, status, assigned_staff_user_id FROM customers
       WHERE organization_id=$1 AND status <> 'inactive' ORDER BY name, id`, [organizationId]);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      customerType: row.customer_type,
      status: row.status,
      assignedStaffUserId: row.assigned_staff_user_id,
    }));
  }

}
