import { FREQUENCY_ENGAGEMENT_KINDS, type CustomerVisitDuplicateInput, type CustomerVisitDuplicate } from './customer-schedule.js';
import { canonicalScheduledDurationMs } from './job-card-duration.js';
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
  type UnsuccessfulVisitReasonCode,
  type ReferenceContact,
  type ReferenceCustomer,
  type RelatedIdentity,
} from './types.js';
import {
  currentOverduePredicateSql,
  latenessSecondsSql,
  overdueSinceSql,
} from './overdue-contract.js';
import type { Pool, PoolClient } from 'pg';
import type { SqlExecutor } from '../../db/executor.js';
import type {
  ManagerAnswer,
  ManagerQuestion,
  SourceWorkSnapshotItem,
  WeeklyReportSubmittedBody,
  WeeklySourceWorkRow,
} from '../weekly-reports/types.js';
import type {
  WeeklyReportRow,
  WeeklyReportSubmissionRow,
} from '../weekly-reports/repository.js';
import {
  listWeeklyReportSubmissionRows as selectWeeklySubmissions,
  updateWeeklyReportDraftRow as applyWeeklyDraftRow,
  type WeeklyDraftRowUpdate,
} from '../weekly-reports/repository.js';
import type { ApprovalQueueItemPort } from '../reports/ports.js';
import type { ApprovalItem } from '../reports/types.js';
import type {
  RealtimeEventInput,
  RealtimeEventRecord,
} from '../realtime/types.js';
import type {
  CustomerJobHistoryQuery,
  CustomerOperationalSummary,
  CustomerOperationalSummaryQuery,
  JobHistoryItem,
  JobHistoryReadPort,
  PaginatedJobHistory,
  StaffJobHistoryQuery,
} from './history-port.js';
import type {
  PaginatedWeeklyReportHistory,
  StaffWeeklyReportHistoryQuery,
  WeeklyReportHistoryItem,
  WeeklyReportHistoryReadPort,
} from '../weekly-reports/history-port.js';
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
import type {
  OverdueAccountableRole,
  OverdueAccountableSource,
  OverdueIncidentDelayType,
  OverdueIncidentIdentity,
  OverdueIncidentSource,
} from './overdue-incidents.js';
import {
  APPROVAL_WAIT_BREACH_HOURS,
  approvalWaitBoundarySql,
  effectiveSubmissionDeadlineSql,
  lateStartBoundarySql,
  submissionBreachInstantSql,
} from './overdue-incidents.js';
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

/**
 * 049: lifecycle intent claim. The semantic identity is the same
 * (organization_id, user_id, client_action_id, operation_key) contract as
 * critical actions; `command` and `expectedVersion` participate in the
 * request hash, never in the identity.
 */
export type LifecycleIntentClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
  command: LifecycleCommand;
  requestHash?: string;
  expectedVersion: number;
};

export type LifecycleIntentReservationInput = {
  jobCardId: string;
  ttlMs: number;
  preflight?: (tx: JobCardTransaction, job: JobCard, reservedAt: Date) => Promise<void>;
};

function lifecycleIntentError(code: string): AppError {
  return new AppError(code, 409, code === 'LIFECYCLE_INTENT_EXPIRED'
    ? 'İşlem rezervasyon süresi doldu. Yeni bir işlem anahtarıyla tekrar deneyin.'
    : 'Bu işlem tamamlanamadı. Yeni bir işlem anahtarıyla tekrar deneyin.');
}

export type LifecycleIntentReservation = {
  intentId: string;
  reservedAt: Date;
};

export type LifecycleIntentReservationResult<T> =
  | { kind: 'reserved'; reservation: LifecycleIntentReservation }
  | { kind: 'replay'; response: T; reservedAt: Date };

type LifecycleIntentRow = {
  id: string;
  request_hash: string | null;
  expected_version: number;
  state: string;
  reserved_at: Date;
  expires_at: Date;
  live: boolean;
  failure_code: string | null;
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

export type JobCardScheduleRevisionSource =
  | 'CREATE'
  | 'RESCHEDULE'
  | 'FOLLOW_UP_CREATE'
  | 'BASELINE';
export type JobCardAssignmentHistorySource =
  | 'CREATE'
  | 'PATCH_REASSIGN'
  | 'OFFBOARDING'
  | 'FOLLOW_UP_CREATE'
  | 'BASELINE';
/** Creation-time history source; distinguishes ordinary creates from linked follow-up children. */
export type JobCardCreationHistorySource = Extract<
  JobCardScheduleRevisionSource,
  'CREATE' | 'FOLLOW_UP_CREATE'
>;

export type CreateJobCardRecord = {
  organizationId: string; type: JobCard['type']; status: JobCard['status'];
  title: string; description: string | null;
  customerId: string | null; contactId: string | null; assignedTo: string; createdBy: string;
  priority: JobCardPriority; dueDate: string | null; scheduledAt: string | null;
  scheduledEndsAt: string | null;
  engagementKind: JobCard['engagementKind'];
  acceptedAt: Date | null; acceptedBy: string | null;
  sourceJobCardId: string | null; followUpInstructions: string | null;
  dataClass?: 'BUSINESS' | 'DEMO';
  demoDatasetId?: string | null;
  historySource: JobCardCreationHistorySource;
  historyRecordedAt: Date;
};
export type ScheduleRevisionRecord = {
  id: string;
  organizationId: string;
  jobCardId: string;
  revisionNo: number;
  scheduledAt: Date | null;
  scheduledEndsAt: Date | null;
  dueDate: string | null;
  organizationTimezone: string;
  source: JobCardScheduleRevisionSource;
  createdBy: string | null;
  createdAt: Date;
};
export type AssignmentHistoryRecord = {
  id: string;
  organizationId: string;
  jobCardId: string;
  fromUserId: string | null;
  toUserId: string;
  changedBy: string | null;
  source: JobCardAssignmentHistorySource;
  changedAt: Date;
  activityId: string | null;
};
export type AppendScheduleRevisionInput = {
  organizationId: string;
  jobCardId: string;
  scheduledAt: string | null;
  scheduledEndsAt: string | null;
  dueDate: string | null;
  source: JobCardScheduleRevisionSource;
  createdBy: string | null;
  /**
   * Domain-effective instant of the revision (the appending request's
   * requestTime). OVR-2 breach derivation uses this as the revision's
   * activation lower bound, so history stays on the injected request clock
   * instead of the DB statement clock.
   */
  createdAt: Date;
};

/** OVR-2: requestTime-stamped lifecycle instants read from the locked job row. */
export type JobLifecycleInstants = {
  acceptedAt: Date | null;
  startedAt: Date | null;
  revisionRequestedAt: Date | null;
};
export type AppendAssignmentHistoryInput = {
  organizationId: string;
  jobCardId: string;
  fromUserId: string | null;
  toUserId: string;
  changedBy: string | null;
  source: JobCardAssignmentHistorySource;
  changedAt: Date;
  activityId: string | null;
};
/** FOUNDATION-2 accountability fact type. Scanner types belong to OVR. */
export type JobCardAccountabilityFactType = 'STARTED' | 'SUBMITTED';
export type AppendAccountabilityFactInput = {
  organizationId: string;
  jobCardId: string;
  factType: JobCardAccountabilityFactType;
  seqNo: number;
  occurredAt: Date;
  scheduleRevisionNo: number;
  responsibleUserId: string;
  actorUserId: string;
  sourceActivityId: string;
};
/** OVR-2 immutable overdue incident write model. No generic update path. */
export type InsertOverdueIncidentInput = {
  organizationId: string;
  jobCardId: string;
  delayType: OverdueIncidentDelayType;
  episodeNo: number;
  scheduleRevisionNo: number;
  deadlineAt: Date;
  breachedAt: Date;
  accountableUserId: string | null;
  accountableRole: OverdueAccountableRole;
  accountableSource: OverdueAccountableSource;
  source: OverdueIncidentSource;
};
/**
 * OVR-3 discovery candidate: organization + job identity only. Discovery must
 * never derive eligibility, so it carries no breach or evidence decision.
 */
export type OverdueScanCandidate = {
  organizationId: string;
  jobCardId: string;
};

/**
 * OVR-3 ordering evidence: a persisted lifecycle reservation that was accepted
 * (reserved) before the shared producer's eligible breach instant and whose
 * processing budget has not run out yet. Its existence proves a valid
 * lifecycle request is still in flight with business time before the breach.
 */
export type LiveLifecycleIntent = {
  intentId: string;
  command: LifecycleCommand;
  reservedAt: Date;
};

export type LatestSubmittedFact = {
  seqNo: number;
  occurredAt: Date;
  scheduleRevisionNo: number;
};
export type PersistedOverdueIncident = {
  id: string;
  organizationId: string;
  jobCardId: string;
  delayType: OverdueIncidentDelayType;
  episodeNo: number;
  scheduleRevisionNo: number;
  deadlineAt: Date;
  breachedAt: Date;
  accountableUserId: string | null;
  accountableUserName: string | null;
  accountableRole: OverdueAccountableRole;
  accountableSource: OverdueAccountableSource;
  source: OverdueIncidentSource;
  recordedAt: Date;
  recoveredAt: Date | null;
  recoveryActorUserId: string | null;
  recoveryActorUserName: string | null;
  /** OVR-4 measurement: recoveredAt - breachedAt, whole seconds, SQL-derived. */
  totalDelaySeconds: number | null;
  /** OVR-4: latest manual management reminder bound to this incident's episode. */
  managerReminder: {
    sentAt: Date;
    actorUserId: string | null;
    actorName: string | null;
    targetUserId: string | null;
    targetName: string | null;
  } | null;
  /** OVR-4: recoveredAt - managerReminder.sentAt, whole seconds. */
  postReminderDelaySeconds: number | null;
};

/**
 * OVR-4: the LATE_SUBMISSION delay that is happening right now for one job.
 * Deliberately narrower than `PersistedOverdueIncident`: it carries no
 * revision, recovery or accountability-history detail, so it can be exposed to
 * the employee who has to act on it without widening the management-only
 * breach history surface.
 */
export type OpenSubmissionDelay = {
  incidentId: string;
  episodeNo: number;
  deadlineAt: Date;
  breachedAt: Date;
  elapsedSeconds: number;
  accountableUserId: string | null;
  accountableUserName: string | null;
};

/** OVR-4 immutable manual-reminder write model. Append-only, no update path. */
export type InsertSubmissionReminderInput = {
  organizationId: string;
  jobCardId: string;
  incidentId: string;
  delayType: OverdueIncidentDelayType;
  episodeNo: number;
  actorUserId: string;
  targetUserId: string;
  sentAt: Date;
  clientActionId: string;
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

/**
 * Who counts as "management" for a notification fan-out: every active
 * ADMIN/MANAGER in the organization, ordered deterministically.
 *
 * Single owner: the job-card notification projection and the OVR-4 reminder
 * worker must never disagree about the escalation audience, so both call this.
 */
export async function listActiveManagementRecipients(
  client: Pick<PoolClient, 'query'>,
  organizationId: string,
): Promise<ActiveManagementRecipient[]> {
  const result = await client.query<ActiveManagementRecipient>(
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
  dataClass: 'BUSINESS' | 'DEMO';
  demoDatasetId: string | null;
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
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;  getSubmissionCustomer(
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
  getOrganizationTimezone(organizationId: string): Promise<string>;
  /**
   * Weekly Report backing row for a JobCard submission check, or null when
   * the job has no report. Implemented by the request transaction so the
   * submit path observes the same row it later freezes.
   */
  getWeeklyReportByJobId(
    organizationId: string,
    jobCardId: string,
  ): Promise<WeeklyReportRow | null>;
  /**
   * Bounded one-week source-work candidate rows for a Weekly Report
   * (org-local [weekStart, weekEnd), assigned staff, non-weekly types,
   * submittable statuses). Single query, deterministic order, no N+1.
   */
  listWeeklySourceWorkSnapshot(input: {
    organizationId: string;
    staffUserId: string;
    weekStart: Date;
    weekEnd: Date;
  }): Promise<WeeklySourceWorkRow[]>;
}

export interface JobCardTransaction extends SubmissionReader {
  getJob(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobForUpdate(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobDetail(organizationId: string, jobCardId: string): Promise<PersistedJobCardDetail | null>;
  getFollowUpSource(
    organizationId: string,
    sourceJobCardId: string,
    forUpdate?: boolean,
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
  findCustomerVisitDuplicate(input: CustomerVisitDuplicateInput): Promise<CustomerVisitDuplicate | null>;
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
  appendScheduleRevision(
    input: AppendScheduleRevisionInput,
  ): Promise<{ id: string; revisionNo: number }>;
  appendAssignmentHistory(input: AppendAssignmentHistoryInput): Promise<void>;
  /** Current governing schedule revision number, or null when none exists. */
  getCurrentScheduleRevisionNo(organizationId: string, jobCardId: string): Promise<number | null>;
  /** OVR-2: a governing schedule revision row, or null when it does not exist. */
  getScheduleRevision(
    organizationId: string,
    jobCardId: string,
    revisionNo: number,
  ): Promise<ScheduleRevisionRecord | null>;
  /**
   * OVR-2: requestTime-stamped lifecycle instants (accepted/started/
   * revision-requested) from the locked job row. Null fields mean the
   * transition never happened — never fall back to another clock.
   */
  getJobLifecycleInstants(
    organizationId: string,
    jobCardId: string,
  ): Promise<JobLifecycleInstants>;
  /** Next SUBMITTED seq_no for the JobCard, serialized under the caller's job lock. */
  getNextSubmittedSeqNo(organizationId: string, jobCardId: string): Promise<number>;
  appendAccountabilityFact(input: AppendAccountabilityFactInput): Promise<{ id: string }>;
  /**
   * OVR-2: idempotent breach materialization. The UNIQUE incident identity
   * absorbs replays and competing request paths; no generic update path.
   */
  insertOverdueIncident(input: InsertOverdueIncidentInput): Promise<{ id: string; created: boolean }>;
  /**
   * OVR-4: the open LATE_SUBMISSION incident that is currently delaying this
   * job (latest `breached_at`), or null when nothing is open. Read under the
   * caller's JobCard lock so the manager's manual reminder cannot race a
   * concurrent submission.
   */
  findOpenSubmissionIncident(
    organizationId: string,
    jobCardId: string,
    requestTime: Date,
  ): Promise<OpenSubmissionDelay | null>;
  /**
   * OVR-4: append the immutable manual-reminder fact. The
   * (organization, actor, clientActionId) UNIQUE makes a double-click a no-op;
   * a collision on a *different* operation is reported, never silently merged.
   */
  insertSubmissionReminder(input: InsertSubmissionReminderInput): Promise<{ id: string }>;
  /**
   * OVR-2: recover every open revision-bound incident for one real delay
   * episode. A schedule revision may have created more than one immutable
   * LATE_START/LATE_SUBMISSION row; the lifecycle recovery closes the
   * episode, not just whichever revision is current.
   */
  recoverOverdueIncidentEpisode(input: {
    organizationId: string;
    jobCardId: string;
    delayType: OverdueIncidentDelayType;
    episodeNo: number;
    recoveredAt: Date;
    recoveryActorUserId: string;
  }): Promise<void>;
  /** OVR-2: latest immutable SUBMITTED fact, or null for legacy uncertainty. */
  getLatestSubmittedFact(
    organizationId: string,
    jobCardId: string,
  ): Promise<LatestSubmittedFact | null>;
  /**
   * OVR-2: durable submission-episode activation. Idempotent: replays and
   * competing paths converge on the UNIQUE (job, episode) identity and
   * report created=false instead of duplicating history.
   */
  insertSubmissionEpisodeActivation(input: {
    organizationId: string;
    jobCardId: string;
    episodeNo: number;
    activatedAt: Date;
    activatedByCommand: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL';
  }): Promise<{ id: string; created: boolean }>;
  /** OVR-2: activation row for a submission episode, or null when never armed. */
  getSubmissionEpisodeActivation(
    organizationId: string,
    jobCardId: string,
    episodeNo: number,
  ): Promise<{ episodeNo: number; activatedAt: Date; activatedByCommand: string } | null>;
  /**
   * OVR-2: staff assignee exactly at an instant from immutable assignment
   * history. Null when unprovable — never the current assignee.
   */
  getAssigneeAtInstant(
    organizationId: string,
    jobCardId: string,
    instant: Date,
  ): Promise<string | null>;
  /**
   * OVR-3: live lifecycle reservations for the job whose business time is
   * strictly before `reservedBefore` (the shared producer's eligible breach
   * instant) and whose reservation budget is unexpired at `atTime`. Read under
   * the JobCard lock; never falls back to the DB statement clock for the
   * boundary.
   */
  listLiveLifecycleIntents(
    organizationId: string,
    jobCardId: string,
    input: { reservedBefore: Date; atTime: Date },
  ): Promise<readonly LiveLifecycleIntent[]>;
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
  /**
   * Weekly Report row locked for a submit freeze. The caller holds the JobCard
   * lock; this adds the report-row lock so draft edits serialize against the
   * submission freeze.
   */
  getWeeklyReportByJobForUpdate(
    organizationId: string,
    jobCardId: string,
  ): Promise<WeeklyReportRow | null>;
  /** Best-effort duplicate pre-check; the UNIQUE constraint stays authoritative. */
  getWeeklyReportByStaffWeek(
    organizationId: string,
    staffUserId: string,
    periodStart: string,
  ): Promise<WeeklyReportRow | null>;
  /**
   * Next submission seq, serialized under the caller's report-row lock
   * (getWeeklyReportByJobForUpdate first).
   */
  getNextWeeklyReportSubmissionSeqNo(
    organizationId: string,
    weeklyReportId: string,
  ): Promise<number>;
  /**
   * Insert the WeeklyReport row as part of an atomic job+report creation.
   *
   * Duplicate identity is resolved by the database, not by an application
   * pre-check: the (organization, staff, period_start) unique constraint
   * arbitrates and `DO NOTHING` reports the loss as `null` WITHOUT aborting
   * the caller's transaction, so the caller can still read the winner row.
   * Callers own the semantics — single create raises
   * WEEKLY_REPORT_ALREADY_EXISTS, bulk converges the item to `existing`.
   */
  insertWeeklyReportRow(input: {
    organizationId: string;
    jobCardId: string;
    staffUserId: string;
    periodStart: string;
    periodEnd: string;
    questions: ManagerQuestion[];
  }): Promise<WeeklyReportRow | null>;
  /**
   * Append one immutable submission row and bump the report draft version in
   * the same statement pair, so a concurrent draft PATCH with a stale
   * expectedVersion deterministically conflicts after a submit freeze.
   */
  insertWeeklyReportSubmissionRow(input: {
    organizationId: string;
    weeklyReportId: string;
    jobCardId: string;
    seqNo: number;
    submittedBy: string;
    submittedAt: Date;
    periodStart: string;
    periodEnd: string;
    body: WeeklyReportSubmittedBody;
    questions: ManagerQuestion[];
    answers: ManagerAnswer[];
    sourceWork: SourceWorkSnapshotItem[];
    jobVersion: number;
    sourceActivityId: string;
  }): Promise<{ submission: WeeklyReportSubmissionRow; reportVersion: number }>;
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

/**
 * The `processed_actions` idempotency contract as a standalone function: claim
 * a `(organization, user, clientActionId, operationKey)` action, run the work
 * in ONE transaction, persist the response, and replay the stored response on
 * an exact re-submission (a changed intent is `CLIENT_ACTION_REUSED`).
 *
 * Extracted verbatim from `PostgresJobCardRepository.executeCriticalAction`
 * so that a command whose writes do not belong to the JobCard transaction
 * family (the WeeklyReport recurrence configuration) reuses the SAME
 * receipt mechanism instead of re-implementing it. The `work` callback gets
 * the raw `PoolClient`; JobCard-backed commands wrap it in a
 * `PostgresJobCardTransaction` themselves.
 */
export async function runCriticalAction<T>(
  pool: Pool,
  claim: CriticalActionClaim,
  work: (client: PoolClient) => Promise<CriticalActionWorkResult<T>>,
): Promise<CriticalActionResult<T>> {
  const client = await pool.connect();
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

    const workResult = await work(client);
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

export interface JobCardRepository extends SubmissionReader {
  getCurrentScheduleRevision(
    organizationId: string,
    jobCardId: string,
  ): Promise<ScheduleRevisionRecord | null>;
  listScheduleRevisions(
    organizationId: string,
    jobCardId: string,
  ): Promise<readonly ScheduleRevisionRecord[]>;
  listAssignmentHistory(
    organizationId: string,
    jobCardId: string,
  ): Promise<readonly AssignmentHistoryRecord[]>;
  /**
   * Version-guarded weekly draft replacement (shared helper; null on stale
   * version). Used by the WeeklyReport service draft path.
   */
  updateWeeklyReportDraftRow(
    input: WeeklyDraftRowUpdate,
  ): Promise<WeeklyReportRow | null>;
  /** Weekly submission rows in seq order (service history read). */
  listWeeklyReportSubmissionRows(
    organizationId: string,
    reportId: string,
  ): Promise<WeeklyReportSubmissionRow[]>;
  /**
   * One immutable submission by its frozen seq for a report. Tenant-scoped;
   * `null` when the report has no such seq.
   */
  getWeeklyReportSubmissionBySeq(
    organizationId: string,
    reportId: string,
    seqNo: number,
  ): Promise<WeeklyReportSubmissionRow | null>;
  /** Display name for presentation metadata only (never report content). */
  getUserDisplayName(organizationId: string, userId: string): Promise<string | null>;
  findCompletedCriticalAction<T>(
    claim: CriticalActionClaim,
  ): Promise<T | null>;
  executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (
      transaction: JobCardTransaction,
    ) => Promise<CriticalActionWorkResult<T>>,
  ): Promise<CriticalActionResult<T>>;
  /**
   * 049: lock-free fast path for exact completed lifecycle-intent replays.
   * Optimization only; correctness comes from reserveLifecycleIntent.
   */
  findCompletedLifecycleIntent<T>(
    claim: LifecycleIntentClaim,
  ): Promise<T | null>;
  /**
   * 049: reserve a lifecycle intent under the authoritative JobCard lock.
   * Completed recheck first, version fence only for new attempts,
   * reserved_at sampled after the lock wait.
   */
  reserveLifecycleIntent<T>(
    claim: LifecycleIntentClaim,
    input: LifecycleIntentReservationInput,
  ): Promise<LifecycleIntentReservationResult<T>>;
  /**
   * 049: finalize a reserved intent. Business mutation and COMPLETED
   * marking commit atomically; definitive failures mark FAILED on the
   * same pooled connection and the original domain error wins.
   */
  finalizeLifecycleIntent<T>(
    claim: LifecycleIntentClaim,
    reservation: LifecycleIntentReservation,
    work: (
      transaction: JobCardTransaction,
    ) => Promise<CriticalActionWorkResult<T>>,
    options: {
      jobCardId: string;
      lockUsers?: (transaction: JobCardTransaction) => Promise<void>;
    },
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
  /** OVR-2 management history read: deterministic breached_at DESC, id DESC. */
  listOverdueIncidents(
    organizationId: string,
    jobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<PersistedOverdueIncident>>;
  /**
   * OVR-4: the current open LATE_SUBMISSION delay for one job, or null. Narrow
   * by design — it carries no revision or breach-history detail — so the
   * employee who must act on the delay can read it without the
   * management-only history surface being widened.
   */
  getOpenSubmissionDelay(
    organizationId: string,
    jobCardId: string,
    requestTime: Date,
  ): Promise<OpenSubmissionDelay | null>;
  /**
   * OVR-3 bounded candidate discovery per delay type. Prefilter only: the
   * clock-only scanner re-evaluates eligibility transactionally through the
   * shared breach producer under the JobCard lock.
   */
  listOverdueBreachCandidates(input: {
    delayType: OverdueIncidentDelayType;
    scanTime: Date;
    limit: number;
  }): Promise<readonly OverdueScanCandidate[]>;
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
  /** Selected only by the overdue list projection (see `listJobCards`). */
  overdue_since?: Date | null;
  lateness_seconds?: number | null;
  /** Selected only by the OVR-4 submission-delay projection (see `listJobCards`). */
  submission_delay_breached_at?: Date | null;
  submission_delay_seconds?: number | null;
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
  unsuccessful_reason_code: UnsuccessfulVisitReasonCode | null;
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
    unsuccessfulReason: row.unsuccessful_reason_code,
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
  product_model_snapshot, lot_no, serial_no, expiry_date::text AS expiry_date, delivery_note`;
const WEEKLY_REPORT_COLUMNS = `id, organization_id, job_card_id, staff_user_id,
  period_start, period_end, draft_summary, draft_blockers, draft_next_week_plan,
  draft_highlights, draft_field_observations, draft_support_needed,
  manager_questions, manager_answers, version, created_at, updated_at`;
const WEEKLY_REPORT_SUBMISSION_COLUMNS = `id, organization_id, weekly_report_id,
  job_card_id, seq_no, submitted_by, submitted_at, period_start, period_end,
  frozen_body, frozen_questions, frozen_answers, frozen_source_work,
  job_version, source_activity_id, created_at`;

/**
 * Shared weekly-report read helpers: the same SQL runs on the pool
 * (standalone reads) and on a request transaction client (submit path
 * observes one MVCC snapshot). FOR UPDATE only inside a transaction.
 */
async function selectWeeklyReportByJob(
  executor: SqlExecutor,
  organizationId: string,
  jobCardId: string,
  forUpdate: boolean,
): Promise<WeeklyReportRow | null> {
  const result = await executor.query<WeeklyReportRow>(
    `SELECT ${WEEKLY_REPORT_COLUMNS} FROM weekly_reports
     WHERE organization_id = $1 AND job_card_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [organizationId, jobCardId],
  );
  return result.rows[0] ?? null;
}

async function selectWeeklySourceWork(
  executor: SqlExecutor,
  input: {
    organizationId: string;
    staffUserId: string;
    weekStart: Date;
    weekEnd: Date;
  },
): Promise<WeeklySourceWorkRow[]> {
  const result = await executor.query<WeeklySourceWorkRow>(
    `SELECT jc.id AS "jobCardId", jc.type AS type, jc.title AS title,
            c.name AS "customerName",
            jc.staff_completed_at AS "staffCompletedAt", jc.status AS status
       FROM job_cards jc
       LEFT JOIN customers c
         ON c.organization_id = jc.organization_id AND c.id = jc.customer_id
      WHERE jc.organization_id = $1
        AND jc.assigned_to = $2
        AND jc.type <> 'WEEKLY_REPORT'
        AND jc.staff_completed_at >= $3
        AND jc.staff_completed_at < $4
        AND jc.status IN ('WAITING_APPROVAL', 'COMPLETED')
      ORDER BY jc.staff_completed_at ASC, jc.id ASC`,
    [input.organizationId, input.staffUserId, input.weekStart, input.weekEnd],
  );
  return result.rows;
}

type WeeklyReportHistoryRow = {
  report_id: string;
  job_card_id: string;
  staff_user_id: string;
  period_start: Date;
  period_end: Date;
  created_at: Date;
  status: JobCardStatus;
  due_date: Date | null;
  manager_approved_at: Date | null;
  submission_count: number;
  latest_seq_no: number | null;
  latest_submitted_at: Date | null;
};

function requiredCalendarDate(value: Date): string {
  const mapped = mapCalendarDate(value);
  if (typeof mapped !== 'string') {
    throw new Error('Expected a non-null DATE column');
  }
  return mapped;
}

function mapWeeklyReportHistoryItem(row: WeeklyReportHistoryRow): WeeklyReportHistoryItem {
  return {
    reportId: row.report_id,
    jobCardId: row.job_card_id,
    staffUserId: row.staff_user_id,
    periodStart: requiredCalendarDate(row.period_start),
    periodEnd: requiredCalendarDate(row.period_end),
    status: row.status,
    dueDate: mapCalendarDate(row.due_date),
    submissionCount: Number(row.submission_count),
    latestSubmissionSeqNo: row.latest_seq_no === null ? null : Number(row.latest_seq_no),
    latestSubmittedAt: mapInstant(row.latest_submitted_at),
    createdAt: row.created_at.toISOString(),
    completedAt: mapInstant(row.manager_approved_at),
  };
}

/**
 * One bounded page of profile Weekly Report history. The submission aggregate
 * is folded in with a LATERAL subquery, so the page costs one row-producing
 * statement no matter how many reports exist — never a query per report.
 * Tenant and owner scope are both enforced in SQL.
 */
const WEEKLY_REPORT_HISTORY_PAGE_SQL = `SELECT r.id AS report_id, r.job_card_id, r.staff_user_id,
    r.period_start, r.period_end, r.created_at,
    j.status, j.due_date, j.manager_approved_at,
    COALESCE(agg.submission_count, 0)::int AS submission_count,
    agg.latest_seq_no, agg.latest_submitted_at
  FROM weekly_reports r
  JOIN job_cards j
    ON j.organization_id = r.organization_id AND j.id = r.job_card_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS submission_count,
           MAX(ws.seq_no) AS latest_seq_no,
           (ARRAY_AGG(ws.submitted_at ORDER BY ws.seq_no DESC))[1] AS latest_submitted_at
      FROM weekly_report_submissions ws
     WHERE ws.organization_id = r.organization_id AND ws.weekly_report_id = r.id
  ) agg ON TRUE
  WHERE r.organization_id = $1 AND r.staff_user_id = $2
  ORDER BY r.period_start DESC, r.id
  LIMIT $3 OFFSET $4`;

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
       j.data_class, j.demo_dataset_id,
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
  data_class: 'BUSINESS' | 'DEMO'; demo_dataset_id: string | null;
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
    dataClass: row.data_class,
    demoDatasetId: row.demo_dataset_id,
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

type ScheduleRevisionRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  revision_no: number;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
  due_date: string | Date | null;
  organization_timezone: string;
  source: ScheduleRevisionRecord['source'];
  created_by: string | null;
  created_at: Date;
};

type AssignmentHistoryRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  from_user_id: string | null;
  to_user_id: string;
  changed_by: string | null;
  source: AssignmentHistoryRecord['source'];
  changed_at: Date;
  activity_id: string | null;
};

const SCHEDULE_REVISION_COLUMNS = `id, organization_id, job_card_id, revision_no,
  scheduled_at, scheduled_ends_at, due_date, organization_timezone, source,
  created_by, created_at`;

const ASSIGNMENT_HISTORY_COLUMNS = `id, organization_id, job_card_id,
  from_user_id, to_user_id, changed_by, source, changed_at, activity_id`;

function mapScheduleRevision(row: ScheduleRevisionRow): ScheduleRevisionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    jobCardId: row.job_card_id,
    revisionNo: Number(row.revision_no),
    scheduledAt: row.scheduled_at,
    scheduledEndsAt: row.scheduled_ends_at,
    dueDate: mapCalendarDate(row.due_date),
    organizationTimezone: row.organization_timezone,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapAssignmentHistory(row: AssignmentHistoryRow): AssignmentHistoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    jobCardId: row.job_card_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    changedBy: row.changed_by,
    source: row.source,
    changedAt: row.changed_at,
    activityId: row.activity_id,
  };
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

function mapSubmittedFact(
  row: { seq_no: number; occurred_at: Date; schedule_revision_no: number } | null | undefined,
): LatestSubmittedFact | null {
  if (!row) return null;
  return {
    seqNo: Number(row.seq_no),
    occurredAt: row.occurred_at,
    scheduleRevisionNo: Number(row.schedule_revision_no),
  };
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

/**
 * OVR-4 job-list signal: the open LATE_SUBMISSION incident of the row, if any.
 *
 * A LEFT JOIN LATERAL, so a job without an open delay keeps exactly the row
 * shape it had before this slice. At most one indexed lookup per returned row,
 * bounded by the page limit — never an N+1 from the application layer.
 */
const OPEN_SUBMISSION_DELAY_JOIN = `LEFT JOIN LATERAL (
  SELECT i.breached_at
    FROM job_card_overdue_incidents i
   WHERE i.organization_id = j.organization_id AND i.job_card_id = j.id
     AND i.delay_type = 'LATE_SUBMISSION' AND i.recovered_at IS NULL
   ORDER BY i.breached_at DESC, i.id DESC
   LIMIT 1) submission_delay ON TRUE`;

/**
 * The derived OVR-4 columns for that join. `requestPosition` is the bind
 * parameter holding the request instant, so the elapsed duration is measured
 * from the server clock — the client never computes it.
 */
function openSubmissionDelayColumns(requestPosition: number): string {
  return `submission_delay.breached_at AS submission_delay_breached_at,
  CASE WHEN submission_delay.breached_at IS NULL THEN NULL
       ELSE GREATEST(FLOOR(EXTRACT(EPOCH FROM ($${requestPosition}::timestamptz
            - submission_delay.breached_at)))::int, 0)
  END AS submission_delay_seconds`;
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
    // Present ONLY where `listJobCards` joins the OVR-4 signal (see
    // `OPEN_SUBMISSION_DELAY_JOIN`); absent — not null — on every other surface
    // that reuses this mapper, exactly like the overdue snapshot below.
    ...(row.submission_delay_breached_at === undefined ? {} : {
      submissionDelay: row.submission_delay_breached_at === null ? null : {
        breachedAt: row.submission_delay_breached_at.toISOString(),
        elapsedSeconds: Number(row.submission_delay_seconds ?? 0),
      },
    }),
  };
}

/**
 * The overdue list projection is the only surface that evaluates current
 * lateness, so the derived snapshot is attached here and nowhere else. Both
 * fields are absent (not null) on every other list surface.
 */
function mapOverdueJobCardListItem(row: JobCardListRow): PersistedJobCardListItem {
  return {
    ...mapJobCardListItem(row),
    overdueSince: row.overdue_since ? row.overdue_since.toISOString() : null,
    latenessSeconds: row.lateness_seconds === null || row.lateness_seconds === undefined
      ? null
      : Number(row.lateness_seconds),
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
  if (filters.followUp === 'only') predicates.push('j.source_job_card_id IS NOT NULL');
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

const OPERATIONAL_SUMMARY_ACTIVE_STATUSES = [
  'NEW', 'ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED',
] as const satisfies readonly JobCardStatus[];

type OperationalSummaryRow = {
  latest_interaction: {
    jobCardId: string; title: string; type: JobCardType; completedAt: string;
    assigneeId: string; assigneeName: string;
  } | null;
  next_planned_work: {
    jobCardId: string; title: string; type: JobCardType; status: JobCardStatus;
    scheduledAt: string; assigneeId: string; assigneeName: string;
  } | null;
  waiting_approval_count: number;
  revision_requested_count: number;
  latest_meeting_outcome: {
    jobCardId: string; meetingAt: string | null; outcome: MeetingOutcome;
    unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
    meetingSummary: string | null; nextFollowUpAt: string | null;
  } | null;
  follow_up_child: { jobCardId: string } | null;
  source_follow_up: { jobCardId: string } | null;
};

function normalizeSummaryInstant(value: string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function mapOperationalSummary(row: OperationalSummaryRow | undefined): CustomerOperationalSummary {
  const latest = row?.latest_interaction ?? null;
  const next = row?.next_planned_work ?? null;
  const meeting = row?.latest_meeting_outcome ?? null;
  const child = row?.follow_up_child ?? null;
  const source = row?.source_follow_up ?? null;
  return {
    latestInteraction: latest === null ? null : {
      jobCardId: latest.jobCardId, title: latest.title, type: latest.type,
      completedAt: new Date(latest.completedAt).toISOString(),
      assignee: { id: latest.assigneeId, name: latest.assigneeName },
    },
    nextPlannedWork: next === null ? null : {
      jobCardId: next.jobCardId, title: next.title, type: next.type, status: next.status,
      scheduledAt: new Date(next.scheduledAt).toISOString(),
      assignee: { id: next.assigneeId, name: next.assigneeName },
    },
    pendingReview: {
      waitingApprovalCount: row?.waiting_approval_count ?? 0,
      revisionRequestedCount: row?.revision_requested_count ?? 0,
    },
    latestMeetingOutcome: meeting === null ? null : {
      jobCardId: meeting.jobCardId,
      meetingAt: normalizeSummaryInstant(meeting.meetingAt),
      outcome: meeting.outcome,
      unsuccessfulReason: meeting.unsuccessfulReason,
      meetingSummary: meeting.meetingSummary,
      nextFollowUpAt: normalizeSummaryInstant(meeting.nextFollowUpAt),
    },
    followUp: child !== null
      ? { jobCardId: child.jobCardId, kind: 'FOLLOW_UP_JOB' }
      : source !== null
        ? { jobCardId: source.jobCardId, kind: 'SOURCE_JOB' }
        : null,
  };
}

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

export class PostgresJobCardTransaction implements JobCardTransaction {
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

  async getFollowUpSource(
    organizationId: string,
    sourceJobCardId: string,
    forUpdate = true,
  ) {
    const result = await this.client.query<FollowUpSourceRow>(
      `${FOLLOW_UP_SOURCE_QUERY}${forUpdate ? ' FOR UPDATE OF j' : ''}`,
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

  listActiveManagementRecipients(organizationId: string) {
    return listActiveManagementRecipients(this.client, organizationId);
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
    // Critical-action foreign keys hold KEY SHARE on the actor. NO KEY UPDATE
    // still serializes scheduling and blocks role/deactivation changes without
    // deadlocking two self-assigned Staff action claims.
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(
      `SELECT id, organization_id, role, is_active FROM users
       WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`, [organizationId, userId],
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

  async findCustomerVisitDuplicate(input: CustomerVisitDuplicateInput): Promise<CustomerVisitDuplicate | null> {
    // Caller holds the Customer lock. READ COMMITTED sees the preceding
    // writer's commit; no extra JobCard locks (and no inverted lock order).
    // Legacy rows may lack scheduled_ends_at: their effective end is derived
    // from the single canonical duration owner (job-card-duration.ts), passed
    // as a bind value so SQL carries no independent duration semantics.
    const legacyFallbackMs = canonicalScheduledDurationMs('SALES_MEETING');
    const result = await this.client.query<{ id: string }>(
      `SELECT id FROM job_cards
       WHERE organization_id = $1 AND customer_id = $2
         AND assigned_to = $3 AND engagement_kind = $4 AND type = 'SALES_MEETING'
         AND status NOT IN ('CANCELLED', 'INVALIDATED')
         AND scheduled_at < $6
         AND $5 < COALESCE(scheduled_ends_at, scheduled_at + ($8 * INTERVAL '1 millisecond'))
         AND ($7::uuid IS NULL OR id <> $7)
       ORDER BY scheduled_at, id LIMIT 1`,
      [input.organizationId, input.customerId, input.assignedTo, input.engagementKind,
        input.startsAt, input.endsAt, input.excludeJobId ?? null, legacyFallbackMs],
    );
    const row = result.rows[0];
    return row ? { jobCardId: row.id, jobPath: `/jobs/${row.id}` } : null;
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
          AND j.type = 'SALES_MEETING' AND j.engagement_kind = ANY($5::text[])
          AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
          AND j.scheduled_at IS NOT NULL
          AND j.scheduled_at >= $3 AND j.scheduled_at <= $4
        ORDER BY j.scheduled_at ASC, j.id ASC`,
      [organizationId, customerId, from, to, FREQUENCY_ENGAGEMENT_KINDS],
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
          AND j.type = 'SALES_MEETING' AND j.engagement_kind = ANY($5::text[])
          AND j.status = 'COMPLETED'
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) >= $3
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) <= $4
        ORDER BY 5 ASC`,
      [organizationId, customerId, from, to, FREQUENCY_ENGAGEMENT_KINDS],
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
    const jobCard = await this.insertJobCardRow(input);
    // FOUNDATION-1 invariant: every newly created JobCard commits with
    // schedule revision #1 and its initial assignment history row in the
    // same transaction. A history failure rolls back the whole creation.
    await this.appendCreationHistory(input, jobCard);
    return jobCard;
  }

  private async insertJobCardRow(input: CreateJobCardRecord): Promise<JobCard> {
    if (input.dataClass === 'DEMO' && input.demoDatasetId) {
      // Server-authoritative DEMO provenance for linked children: a follow-up of a
      // DEMO source inherits the source dataset directly at creation.
      const demoResult = await this.client.query<JobCardRow>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, description, customer_id, contact_id,
            assigned_to, created_by, priority, due_date, scheduled_at, scheduled_ends_at,
            engagement_kind, accepted_at, accepted_by, source_job_card_id, follow_up_instructions,
            data_class, demo_dataset_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING ${JOB_CARD_BASE_COLUMNS}`,
        [input.organizationId, input.type, input.status, input.title, input.description,
          input.customerId, input.contactId, input.assignedTo, input.createdBy, input.priority,
          input.dueDate, input.scheduledAt, input.scheduledEndsAt, input.engagementKind,
          input.acceptedAt, input.acceptedBy, input.sourceJobCardId, input.followUpInstructions,
          input.dataClass, input.demoDatasetId],
      );
      return mapJobCard(demoResult.rows[0]!);
    }
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

  private async appendCreationHistory(input: CreateJobCardRecord, job: JobCard) {
    const timezone = await this.getOrganizationTimezone(input.organizationId);
    await this.client.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          due_date, organization_timezone, source, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
      [input.organizationId, job.id, input.scheduledAt, input.scheduledEndsAt,
        input.dueDate, timezone, input.historySource, input.createdBy, input.historyRecordedAt],
    );
    await this.client.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [input.organizationId, job.id, input.assignedTo, input.createdBy,
        input.historySource, input.historyRecordedAt],
    );
  }

  async appendScheduleRevision(input: AppendScheduleRevisionInput) {
    const timezone = await this.getOrganizationTimezone(input.organizationId);
    // Callers hold the JobCard row lock (FOR UPDATE) or create the JobCard in
    // the same transaction, so MAX+1 is concurrency-safe per JobCard.
    const result = await this.client.query<{ id: string; revision_no: number }>(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          due_date, organization_timezone, source, created_by, created_at)
       SELECT $1, $2, COALESCE(MAX(revision_no), 0) + 1, $3, $4, $5, $6, $7, $8, $9
       FROM job_card_schedule_revisions
       WHERE organization_id = $1 AND job_card_id = $2
       RETURNING id, revision_no`,
      [input.organizationId, input.jobCardId, input.scheduledAt, input.scheduledEndsAt,
        input.dueDate, timezone, input.source, input.createdBy, input.createdAt],
    );
    const row = result.rows[0]!;
    return { id: row.id, revisionNo: Number(row.revision_no) };
  }

  async getScheduleRevision(organizationId: string, jobCardId: string, revisionNo: number) {
    const result = await this.client.query<ScheduleRevisionRow>(
      `SELECT ${SCHEDULE_REVISION_COLUMNS}
         FROM job_card_schedule_revisions
        WHERE organization_id = $1 AND job_card_id = $2 AND revision_no = $3`,
      [organizationId, jobCardId, revisionNo],
    );
    const row = result.rows[0];
    return row ? mapScheduleRevision(row) : null;
  }

  async getJobLifecycleInstants(organizationId: string, jobCardId: string) {
    const result = await this.client.query<{
      accepted_at: Date | null; started_at: Date | null; revision_requested_at: Date | null;
    }>(
      `SELECT accepted_at, started_at, revision_requested_at
         FROM job_cards
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobCardId],
    );
    const row = result.rows[0];
    return {
      acceptedAt: row?.accepted_at ?? null,
      startedAt: row?.started_at ?? null,
      revisionRequestedAt: row?.revision_requested_at ?? null,
    };
  }

  async appendAssignmentHistory(input: AppendAssignmentHistoryInput) {
    await this.client.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at, activity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.organizationId, input.jobCardId, input.fromUserId, input.toUserId,
        input.changedBy, input.source, input.changedAt, input.activityId],
    );
  }

  async getCurrentScheduleRevisionNo(organizationId: string, jobCardId: string) {
    // Callers hold the JobCard row lock (FOR UPDATE), so the returned MAX is
    // the stable governing revision for the enclosing mutation.
    const result = await this.client.query<{ revision_no: number | null }>(
      `SELECT MAX(revision_no) AS revision_no FROM job_card_schedule_revisions
        WHERE organization_id = $1 AND job_card_id = $2`,
      [organizationId, jobCardId],
    );
    const revisionNo = result.rows[0]?.revision_no;
    return revisionNo === null || revisionNo === undefined ? null : Number(revisionNo);
  }

  async getNextSubmittedSeqNo(organizationId: string, jobCardId: string) {
    // Same job-lock discipline as schedule revision MAX+1: no sequence table.
    const result = await this.client.query<{ seq_no: number | null }>(
      `SELECT COALESCE(MAX(seq_no), 0) + 1 AS seq_no FROM job_card_accountability_facts
        WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'`,
      [organizationId, jobCardId],
    );
    return Number(result.rows[0]?.seq_no ?? 1);
  }

  async appendAccountabilityFact(input: AppendAccountabilityFactInput) {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO job_card_accountability_facts
         (organization_id, job_card_id, fact_type, seq_no, occurred_at,
          schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.organizationId, input.jobCardId, input.factType, input.seqNo,
        input.occurredAt, input.scheduleRevisionNo, input.responsibleUserId,
        input.actorUserId, input.sourceActivityId],
    );
    return { id: result.rows[0]!.id };
  }

  async insertOverdueIncident(input: InsertOverdueIncidentInput) {
    // Callers hold the JobCard row lock (FOR UPDATE); the UNIQUE incident
    // identity additionally absorbs replays and competing request paths, so
    // the same semantic breach can never produce duplicate history.
    const inserted = await this.client.query<{ id: string }>(
      `INSERT INTO job_card_overdue_incidents
         (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
          deadline_at, breached_at, accountable_user_id, accountable_role,
          accountable_source, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (organization_id, job_card_id, delay_type, schedule_revision_no, episode_no)
       DO NOTHING
       RETURNING id`,
      [input.organizationId, input.jobCardId, input.delayType, input.episodeNo,
        input.scheduleRevisionNo, input.deadlineAt, input.breachedAt,
        input.accountableUserId, input.accountableRole, input.accountableSource,
        input.source],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM job_card_overdue_incidents
        WHERE organization_id = $1 AND job_card_id = $2 AND delay_type = $3
          AND schedule_revision_no = $4 AND episode_no = $5`,
      [input.organizationId, input.jobCardId, input.delayType,
        input.scheduleRevisionNo, input.episodeNo],
    );
    return { id: existing.rows[0]!.id, created: false };
  }

  async recoverOverdueIncidentEpisode(input: {
    organizationId: string;
    jobCardId: string;
    delayType: OverdueIncidentDelayType;
    episodeNo: number;
    recoveredAt: Date;
    recoveryActorUserId: string;
  }) {
    await this.client.query(
      `UPDATE job_card_overdue_incidents
          SET recovered_at = $5, recovery_actor_user_id = $6
        WHERE organization_id = $1 AND job_card_id = $2 AND delay_type = $3
          AND episode_no = $4 AND recovered_at IS NULL`,
      [input.organizationId, input.jobCardId, input.delayType, input.episodeNo,
        input.recoveredAt, input.recoveryActorUserId],
    );
  }

  async findOpenSubmissionIncident(
    organizationId: string,
    jobCardId: string,
    requestTime: Date,
  ): Promise<OpenSubmissionDelay | null> {
    const result = await this.client.query<{
      id: string; episode_no: number; deadline_at: Date; breached_at: Date;
      elapsed_seconds: number; accountable_user_id: string | null;
      accountable_user_name: string | null;
    }>(
      `SELECT i.id, i.episode_no, i.deadline_at, i.breached_at,
              GREATEST(FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - i.breached_at)))::int, 0)
                AS elapsed_seconds,
              i.accountable_user_id, au.name AS accountable_user_name
         FROM job_card_overdue_incidents i
         LEFT JOIN users au
           ON au.organization_id = i.organization_id AND au.id = i.accountable_user_id
        WHERE i.organization_id = $1 AND i.job_card_id = $2
          AND i.delay_type = 'LATE_SUBMISSION' AND i.recovered_at IS NULL
        ORDER BY i.breached_at DESC, i.id DESC
        LIMIT 1`,
      [organizationId, jobCardId, requestTime],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      incidentId: row.id,
      episodeNo: Number(row.episode_no),
      deadlineAt: row.deadline_at,
      breachedAt: row.breached_at,
      elapsedSeconds: Number(row.elapsed_seconds),
      accountableUserId: row.accountable_user_id,
      accountableUserName: row.accountable_user_name,
    };
  }

  async insertSubmissionReminder(input: InsertSubmissionReminderInput) {
    const inserted = await this.client.query<{ id: string }>(
      `INSERT INTO job_card_submission_reminders
         (organization_id, job_card_id, incident_id, delay_type, episode_no,
          actor_user_id, target_user_id, sent_at, client_action_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, actor_user_id, client_action_id) DO NOTHING
       RETURNING id`,
      [input.organizationId, input.jobCardId, input.incidentId, input.delayType,
        input.episodeNo, input.actorUserId, input.targetUserId, input.sentAt,
        input.clientActionId],
    );
    const row = inserted.rows[0];
    if (row) return { id: row.id };
    // The (org, actor, clientActionId) identity already exists. An exact replay
    // never reaches here — the critical-action receipt replays first — so this
    // is a clientActionId reused for a different action. Fail loudly instead of
    // returning somebody else's fact.
    throw new AppError(
      'CLIENT_ACTION_REUSED',
      409,
      'clientActionId farklı bir işlem içeriğiyle yeniden kullanılamaz.',
    );
  }

  async getLatestSubmittedFact(organizationId: string, jobCardId: string) {
    const result = await this.client.query<{
      seq_no: number; occurred_at: Date; schedule_revision_no: number;
    }>(
      `SELECT seq_no, occurred_at, schedule_revision_no
         FROM job_card_accountability_facts
        WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
        ORDER BY seq_no DESC
        LIMIT 1`,
      [organizationId, jobCardId],
    );
    return mapSubmittedFact(result.rows[0] ?? null);
  }

  async insertSubmissionEpisodeActivation(input: {
    organizationId: string;
    jobCardId: string;
    episodeNo: number;
    activatedAt: Date;
    activatedByCommand: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL';
  }) {
    // Callers hold the JobCard row lock (FOR UPDATE); the UNIQUE identity
    // additionally absorbs replays, so the same arming can never duplicate.
    const inserted = await this.client.query<{ id: string }>(
      `INSERT INTO job_card_submission_episode_activations
         (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, job_card_id, episode_no) DO NOTHING
       RETURNING id`,
      [input.organizationId, input.jobCardId, input.episodeNo,
        input.activatedAt, input.activatedByCommand],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await this.client.query<{ id: string }>(
      `SELECT id FROM job_card_submission_episode_activations
        WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = $3`,
      [input.organizationId, input.jobCardId, input.episodeNo],
    );
    return { id: existing.rows[0]!.id, created: false };
  }

  async getSubmissionEpisodeActivation(
    organizationId: string,
    jobCardId: string,
    episodeNo: number,
  ) {
    const result = await this.client.query<{
      episode_no: number; activated_at: Date; activated_by_command: string;
    }>(
      `SELECT episode_no, activated_at, activated_by_command
         FROM job_card_submission_episode_activations
        WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = $3`,
      [organizationId, jobCardId, episodeNo],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      episodeNo: Number(row.episode_no),
      activatedAt: row.activated_at,
      activatedByCommand: row.activated_by_command,
    };
  }

  async getAssigneeAtInstant(organizationId: string, jobCardId: string, instant: Date) {
    // Immutable assignment history is the only source of historical
    // accountability. The current assignee is never consulted: whoever owns
    // the job when the incident is read (or recovered) must not leak into
    // who was accountable at the breach instant.
    const result = await this.client.query<{ to_user_id: string }>(
      `SELECT to_user_id FROM job_card_assignment_history
        WHERE organization_id = $1 AND job_card_id = $2 AND changed_at <= $3
        ORDER BY changed_at DESC, id DESC
        LIMIT 1`,
      [organizationId, jobCardId, instant],
    );
    return result.rows[0]?.to_user_id ?? null;
  }

  async listLiveLifecycleIntents(
    organizationId: string,
    jobCardId: string,
    input: { reservedBefore: Date; atTime: Date },
  ): Promise<readonly LiveLifecycleIntent[]> {
    // Callers already hold the JobCard row lock. The identity contract is
    // 049's: business time is `reserved_at` (sampled under the lock) and the
    // reservation is live while `expires_at` has not been reached, because
    // finalize can never commit once the budget expired.
    const result = await this.client.query<{
      id: string; command: LifecycleCommand; reserved_at: Date;
    }>(
      `SELECT id, command, reserved_at
         FROM job_card_lifecycle_intents
        WHERE organization_id = $1 AND job_card_id = $2
          AND state = 'PENDING'
          AND reserved_at < $3
          AND expires_at > $4
        ORDER BY reserved_at ASC, id ASC`,
      [organizationId, jobCardId, input.reservedBefore, input.atTime],
    );
    return result.rows.map((row) => ({
      intentId: row.id,
      command: row.command,
      reservedAt: row.reserved_at,
    }));
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
      `SELECT job_card_id, meeting_at, outcome, unsuccessful_reason_code,
              meeting_summary, next_follow_up_at
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
          SET meeting_at = $3, outcome = $4, unsuccessful_reason_code = $5,
              meeting_summary = $6, next_follow_up_at = $7, updated_at = NOW()
        WHERE organization_id = $1 AND job_card_id = $2`,
      [input.organizationId, input.jobCardId, input.meetingAt, input.outcome,
        input.unsuccessfulReason ?? null, input.meetingSummary, input.nextFollowUpAt],
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

  async getWeeklyReportByJobId(organizationId: string, jobCardId: string) {
    return selectWeeklyReportByJob(this.client, organizationId, jobCardId, false);
  }

  async listWeeklySourceWorkSnapshot(input: {
    organizationId: string;
    staffUserId: string;
    weekStart: Date;
    weekEnd: Date;
  }) {
    return selectWeeklySourceWork(this.client, input);
  }

  async getWeeklyReportByJobForUpdate(organizationId: string, jobCardId: string) {
    return selectWeeklyReportByJob(this.client, organizationId, jobCardId, true);
  }

  async getWeeklyReportByStaffWeek(
    organizationId: string,
    staffUserId: string,
    periodStart: string,
  ) {
    const result = await this.client.query<WeeklyReportRow>(
      `SELECT ${WEEKLY_REPORT_COLUMNS} FROM weekly_reports
       WHERE organization_id = $1 AND staff_user_id = $2 AND period_start = $3`,
      [organizationId, staffUserId, periodStart],
    );
    return result.rows[0] ?? null;
  }

  async getNextWeeklyReportSubmissionSeqNo(organizationId: string, weeklyReportId: string) {
    const result = await this.client.query<{ seq_no: number }>(
      `SELECT COALESCE(MAX(seq_no), 0) + 1 AS seq_no FROM weekly_report_submissions
       WHERE organization_id = $1 AND weekly_report_id = $2`,
      [organizationId, weeklyReportId],
    );
    return result.rows[0]!.seq_no;
  }

  async insertWeeklyReportRow(input: {
    organizationId: string;
    jobCardId: string;
    staffUserId: string;
    periodStart: string;
    periodEnd: string;
    questions: ManagerQuestion[];
  }): Promise<WeeklyReportRow | null> {
    const result = await this.client.query<WeeklyReportRow>(
      `INSERT INTO weekly_reports
         (organization_id, job_card_id, staff_user_id, period_start, period_end,
          manager_questions, manager_answers)
       VALUES ($1, $2, $3, $4, $5, $6, '[]')
       ON CONFLICT (organization_id, staff_user_id, period_start) DO NOTHING
       RETURNING ${WEEKLY_REPORT_COLUMNS}`,
      [
        input.organizationId,
        input.jobCardId,
        input.staffUserId,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.questions),
      ],
    );
    // null = an existing canonical report won the staff/week identity. The
    // transaction stays usable, so the caller re-reads the winner row.
    return result.rows[0] ?? null;
  }

  async insertWeeklyReportSubmissionRow(input: {
    organizationId: string;
    weeklyReportId: string;
    jobCardId: string;
    seqNo: number;
    submittedBy: string;
    submittedAt: Date;
    periodStart: string;
    periodEnd: string;
    body: WeeklyReportSubmittedBody;
    questions: ManagerQuestion[];
    answers: ManagerAnswer[];
    sourceWork: SourceWorkSnapshotItem[];
    jobVersion: number;
    sourceActivityId: string;
  }) {
    const inserted = await this.client.query<WeeklyReportSubmissionRow>(
      `INSERT INTO weekly_report_submissions
         (organization_id, weekly_report_id, job_card_id, seq_no, submitted_by,
          submitted_at, period_start, period_end, frozen_body, frozen_questions,
          frozen_answers, frozen_source_work, job_version, source_activity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${WEEKLY_REPORT_SUBMISSION_COLUMNS}`,
      [
        input.organizationId,
        input.weeklyReportId,
        input.jobCardId,
        input.seqNo,
        input.submittedBy,
        input.submittedAt,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.body),
        JSON.stringify(input.questions),
        JSON.stringify(input.answers),
        JSON.stringify(input.sourceWork),
        input.jobVersion,
        input.sourceActivityId,
      ],
    );
    const submission = inserted.rows[0];
    if (!submission) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    const bumped = await this.client.query<{ version: number }>(
      `UPDATE weekly_reports SET version = version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING version`,
      [input.organizationId, input.weeklyReportId],
    );
    const reportVersion = bumped.rows[0]?.version;
    if (reportVersion === undefined) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    return { submission, reportVersion };
  }
}

export class PostgresJobCardRepository
implements JobCardRepository, ApprovalQueueItemPort, JobHistoryReadPort, WeeklyReportHistoryReadPort {
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
    return runCriticalAction(this.pool, claim, (client) =>
      work(new PostgresJobCardTransaction(client)));
  }

  /** Completed receipts retain the existing processed_actions authority. */
  async findCompletedLifecycleIntent<T>(claim: LifecycleIntentClaim): Promise<T | null> {
    return this.findCompletedCriticalAction<T>(claim);
  }

  private async lifecycleReceipt<T>(client: PoolClient, claim: LifecycleIntentClaim) {
    const result = await client.query<{
      status: string; request_hash: string | null; response_body: T | null; reserved_at: Date;
    }>(
      `SELECT p.status, p.request_hash, p.response_body,
              COALESCE(i.reserved_at, p.created_at) AS reserved_at
         FROM processed_actions p
         LEFT JOIN job_card_lifecycle_intents i
           ON i.organization_id=p.organization_id AND i.user_id=p.user_id
          AND i.client_action_id=p.client_action_id AND i.operation_key=p.operation_key
        WHERE p.organization_id=$1 AND p.user_id=$2
          AND p.client_action_id=$3 AND p.operation_key=$4`,
      [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    assertCriticalActionRequestHash(claim.requestHash, row.request_hash);
    if (row.status !== 'completed' || row.response_body === null) {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return { kind: 'replay' as const, response: row.response_body, reservedAt: row.reserved_at };
  }

  /** Short transaction: JobCard -> receipt recheck -> intent -> preflight -> reservation. */
  async reserveLifecycleIntent<T>(
    claim: LifecycleIntentClaim,
    input: LifecycleIntentReservationInput,
  ): Promise<LifecycleIntentReservationResult<T>> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new AppError('LIFECYCLE_INTENT_TTL_INVALID', 500, 'Lifecycle intent TTL geçersiz.');
    }
    const client = await this.pool.connect();
    let active = false;
    let released = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      active = true;
      const tx = new PostgresJobCardTransaction(client);
      const job = await tx.getJobForUpdate(claim.organizationId, input.jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      // Recheck after the lock wait, before the NEW-attempt version fence.
      const replay = await this.lifecycleReceipt<T>(client, claim);
      if (replay) {
        await client.query('COMMIT'); active = false;
        return replay;
      }
      const existing = await client.query<LifecycleIntentRow>(
        `SELECT id, request_hash, expected_version, state, reserved_at, expires_at,
                expires_at > clock_timestamp() AS live, failure_code
           FROM job_card_lifecycle_intents
          WHERE organization_id=$1 AND user_id=$2 AND client_action_id=$3 AND operation_key=$4
          FOR UPDATE`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
      );
      const row = existing.rows[0];
      if (row) {
        assertCriticalActionRequestHash(claim.requestHash, row.request_hash);
        if (row.state === 'COMPLETED') throw new AppError('INVARIANT_VIOLATION', 500, 'Lifecycle receipt eksik.');
        if (row.state === 'FAILED') throw lifecycleIntentError(row.failure_code ?? 'LIFECYCLE_INTENT_FAILED');
        if (!row.live) {
          await client.query(`UPDATE job_card_lifecycle_intents SET state='FAILED',
            failed_at=date_trunc('milliseconds',clock_timestamp()), failure_code='LIFECYCLE_INTENT_EXPIRED'
            WHERE id=$1`, [row.id]);
          await client.query('COMMIT'); active = false;
          throw lifecycleIntentError('LIFECYCLE_INTENT_EXPIRED');
        }
        throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
      }
      if (job.version !== claim.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      const sampled = await client.query<{ reserved_at: Date }>(
        "SELECT date_trunc('milliseconds', clock_timestamp()) AS reserved_at",
      );
      const reservedAt = sampled.rows[0]!.reserved_at;
      if (input.preflight) await input.preflight(tx, job, reservedAt);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO job_card_lifecycle_intents
          (organization_id,job_card_id,user_id,client_action_id,operation_key,command,
           request_hash,expected_version,state,reserved_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10) RETURNING id`,
        [claim.organizationId,input.jobCardId,claim.userId,claim.clientActionId,claim.operationKey,
          claim.command,claim.requestHash ?? null,claim.expectedVersion,reservedAt,
          new Date(reservedAt.valueOf()+input.ttlMs)],
      );
      await client.query('COMMIT'); active = false;
      return { kind: 'reserved', reservation: { intentId: inserted.rows[0]!.id, reservedAt } };
    } catch (error) {
      if (active) {
        try { await client.query('ROLLBACK'); }
        catch { client.release(true); released = true; throw error; }
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  /** Claim -> User -> JobCard -> intent; business, receipt and completion are atomic. */
  async finalizeLifecycleIntent<T>(
    claim: LifecycleIntentClaim,
    reservation: LifecycleIntentReservation,
    work: (transaction: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>,
    options: { jobCardId: string; lockUsers?: (transaction: JobCardTransaction) => Promise<void> },
  ): Promise<CriticalActionResult<T>> {
    const client = await this.pool.connect();
    let active = false;
    let released = false;
    let committing = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); active = true;
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO processed_actions (organization_id,user_id,client_action_id,operation_key,request_hash,status)
         VALUES ($1,$2,$3,$4,$5,'processing')
         ON CONFLICT (organization_id,user_id,client_action_id,operation_key) DO NOTHING RETURNING id`,
        [claim.organizationId,claim.userId,claim.clientActionId,claim.operationKey,claim.requestHash ?? null],
      );
      if (claimed.rowCount === 0) {
        const replay = await this.lifecycleReceipt<T>(client, claim);
        if (!replay) throw new AppError('INVARIANT_VIOLATION',500,'Critical-action receipt eksik.');
        await client.query('COMMIT'); active = false;
        return { kind:'replay', response:replay.response, realtimeEvents:[] };
      }
      const tx = new PostgresJobCardTransaction(client);
      if (options.lockUsers) await options.lockUsers(tx);
      const job = await tx.getJobForUpdate(claim.organizationId, options.jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND',404,'JobCard bulunamadı.');
      const locked = await client.query<LifecycleIntentRow>(
        `SELECT id,request_hash,expected_version,state,reserved_at,expires_at,failure_code
           FROM job_card_lifecycle_intents
          WHERE id = $1 AND organization_id=$2 AND user_id=$3
            AND client_action_id=$4 AND operation_key=$5 AND job_card_id=$6 FOR UPDATE`,
        [reservation.intentId,claim.organizationId,claim.userId,claim.clientActionId,claim.operationKey,options.jobCardId],
      );
      const row = locked.rows[0];
      if (!row) throw new AppError('INVARIANT_VIOLATION',500,'Lifecycle intent bulunamadı.');
      assertCriticalActionRequestHash(claim.requestHash,row.request_hash);
      if (row.state === 'FAILED') throw lifecycleIntentError(row.failure_code ?? 'LIFECYCLE_INTENT_FAILED');
      if (row.state !== 'PENDING' || row.reserved_at.valueOf() !== reservation.reservedAt.valueOf()) {
        throw new AppError('ACTION_IN_PROGRESS',409,'Aynı işlem halen devam ediyor.');
      }
      if (job.version !== claim.expectedVersion) throw new AppError('VERSION_CONFLICT',409,'JobCard başka bir işlem tarafından güncellendi.');
      const assertUnexpired = async () => {
        const fence = await client.query<{ expired:boolean }>('SELECT clock_timestamp() >= $1::timestamptz AS expired',[row.expires_at]);
        if (fence.rows[0]!.expired) throw lifecycleIntentError('LIFECYCLE_INTENT_EXPIRED');
      };
      await assertUnexpired();
      const result = await work(tx);
      await assertUnexpired();
      await client.query(`UPDATE job_card_lifecycle_intents SET state='COMPLETED',
        completed_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1`,[reservation.intentId]);
      await client.query(`UPDATE processed_actions SET status='completed',status_code=200,
        response_body=$2,completed_at=NOW() WHERE id=$1`,[claimed.rows[0]!.id,result.response]);
      committing = true;
      await client.query('COMMIT'); active = false;
      return { kind:'completed',response:result.response,realtimeEvents:result.realtimeEvents };
    } catch (error) {
      if (committing) {
        client.release(true); released=true; active=false;
        // An uncertain COMMIT may already have persisted both the mutation and receipt.
        try {
          const completed = await this.findCompletedCriticalAction<T>(claim);
          if (completed !== null) return { kind:'replay',response:completed,realtimeEvents:[] };
        } catch { /* Preserve the original uncertain outcome for exact retry. */ }
        throw error;
      }
      if (active) {
        try { await client.query('ROLLBACK'); active=false; }
        catch { client.release(true); released=true; throw error; }
      }
      if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
          && !['CLIENT_ACTION_REUSED','ACTION_IN_PROGRESS'].includes(error.code)) {
        try {
          await client.query('BEGIN'); active=true;
          await new PostgresJobCardTransaction(client).getJobForUpdate(claim.organizationId, options.jobCardId);
          await client.query(`UPDATE job_card_lifecycle_intents SET state='FAILED',
            failed_at=date_trunc('milliseconds',clock_timestamp()),failure_code=$3
            WHERE id=$1 AND reserved_at=$2 AND state='PENDING'`,
            [reservation.intentId,reservation.reservedAt,error.code]);
          await client.query('COMMIT'); active=false;
        } catch {
          try { await client.query('ROLLBACK'); active=false; }
          catch { client.release(true); released=true; }
        }
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }, executor: SqlExecutor = this.pool): Promise<ApprovalItem[]> {
    const rows = await executor.query<JobCardListRow & { waiting_minutes: number }>(
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

  bindTo(executor: SqlExecutor): ApprovalQueueItemPort {
    return {
      getApprovalItems: (input) => this.getApprovalItems(input, executor),
      bindTo: (next) => this.bindTo(next),
    };
  }

  async listJobCards(scope: JobCardReadScope, query: JobCardListQuery, requestTime: Date) {
    const filter = workspaceWhere(scope, query);
    let countJoins = WORKSPACE_JOINS;
    let itemJoins = `${WORKSPACE_ITEM_JOINS}
  ${OPEN_SUBMISSION_DELAY_JOIN}`;
    let clause = filter.clause;
    // `values` binds the count query; `itemValues` additionally carries the
    // request instant the items-only OVR-4 signal needs, so the count query is
    // never handed a parameter it does not reference.
    let values = filter.values;
    let itemValues = values;
    let itemColumns = `${JOB_CARD_LIST_COLUMNS},
  ${openSubmissionDelayColumns(values.length + 1)}`;
    let order = query.status === 'WAITING_APPROVAL'
      ? 'j.staff_completed_at ASC, j.id ASC'
      : 'j.updated_at DESC, j.id DESC';
    if (query.overdue) {
      countJoins = `${WORKSPACE_JOINS}
  JOIN organizations o ON o.id = j.organization_id`;
      itemJoins = `${WORKSPACE_ITEM_JOINS}
  JOIN organizations o ON o.id = j.organization_id
  ${OPEN_SUBMISSION_DELAY_JOIN}`;
      const datePosition = values.length + 1;
      values = [...values, requestTime];
      itemValues = values;
      const refs = {
        dueDate: 'j.due_date',
        timezone: 'o.timezone',
        requestTime: `$${datePosition}::timestamptz`,
        status: 'j.status',
        jobType: 'j.type',
      };
      // Parse guarantees status is omitted or 'active'; workspaceWhere already
      // restricts to the five actionable statuses in that case.
      clause = `${filter.clause}
    AND ${currentOverduePredicateSql(refs)}`;
      // The overdue view is the only list surface that evaluates current
      // lateness, so the derived columns are selected here and nowhere else.
      // The OVR-4 signal is orthogonal to that clock and is added alongside it.
      itemColumns = `${JOB_CARD_LIST_COLUMNS},
  ${overdueSinceSql(refs)} AS overdue_since,
  ${latenessSecondsSql(refs)} AS lateness_seconds,
  ${openSubmissionDelayColumns(datePosition)}`;
      // Every row in the view is late and shares one request instant, so the
      // earliest `overdue_since` is also the largest lateness.
      order = 'overdue_since ASC, j.id ASC';
    } else {
      itemValues = [...values, requestTime];
    }
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       ${countJoins}
       WHERE ${clause}`,
      values,
    );
    const limitPosition = itemValues.length + 1;
    const offsetPosition = itemValues.length + 2;
    const items = await this.pool.query<JobCardListRow>(
      `SELECT ${itemColumns}
       ${itemJoins}
       WHERE ${clause}
       ORDER BY ${order}
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      [...itemValues, query.limit, query.offset],
    );
    return {
      items: query.overdue
        ? items.rows.map(mapOverdueJobCardListItem)
        : items.rows.map(mapJobCardListItem),
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

  async getCurrentScheduleRevision(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<ScheduleRevisionRow>(
      `SELECT ${SCHEDULE_REVISION_COLUMNS}
         FROM job_card_schedule_revisions
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY revision_no DESC
        LIMIT 1`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapScheduleRevision(result.rows[0]) : null;
  }

  async listScheduleRevisions(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<ScheduleRevisionRow>(
      `SELECT ${SCHEDULE_REVISION_COLUMNS}
         FROM job_card_schedule_revisions
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY revision_no ASC`,
      [organizationId, jobCardId],
    );
    return result.rows.map(mapScheduleRevision);
  }

  async listAssignmentHistory(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<AssignmentHistoryRow>(
      `SELECT ${ASSIGNMENT_HISTORY_COLUMNS}
         FROM job_card_assignment_history
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY changed_at DESC, id DESC`,
      [organizationId, jobCardId],
    );
    return result.rows.map(mapAssignmentHistory);
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
          AND j.type = 'SALES_MEETING' AND j.engagement_kind = ANY($5::text[])
          AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
          AND j.scheduled_at IS NOT NULL
          AND j.scheduled_at >= $3 AND j.scheduled_at <= $4
        ORDER BY j.scheduled_at ASC, j.id ASC`,
      [organizationId, customerId, from, to, FREQUENCY_ENGAGEMENT_KINDS],
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
          AND j.type = 'SALES_MEETING' AND j.engagement_kind = ANY($5::text[])
          AND j.status = 'COMPLETED'
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) >= $3
          AND COALESCE(md.meeting_at, di.latest_delivered_at, j.staff_completed_at, j.scheduled_at) <= $4
        ORDER BY 5 ASC`,
      [organizationId, customerId, from, to, FREQUENCY_ENGAGEMENT_KINDS],
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

  async getCustomerOperationalSummary(
    input: CustomerOperationalSummaryQuery,
  ): Promise<CustomerOperationalSummary> {
    const values: unknown[] = [input.actor.organizationId, input.customerId];
    const scope = ['j.organization_id = $1', 'j.customer_id = $2'];
    if (input.actor.role === 'STAFF') {
      values.push(input.actor.id);
      scope.push(`j.assigned_to = $${values.length}`);
    }
    values.push(input.now);
    const nowPosition = values.length;
    values.push([...OPERATIONAL_SUMMARY_ACTIVE_STATUSES]);
    const activePosition = values.length;
    // STAFF must never observe hidden follow-up children through the
    // source fallback: child_count is already suppressed for STAFF in
    // listJobHistory, and the summary follows the same rule here.
    const sourceFallback = input.actor.role === 'STAFF'
      ? 'NULL::json AS source_follow_up'
      : `(SELECT row_to_json(source) FROM (
            SELECT j2.id AS "jobCardId"
            FROM job_cards j2
            WHERE j2.organization_id = $1 AND j2.customer_id = $2
              AND j2.status = 'COMPLETED'
              AND EXISTS (
                SELECT 1 FROM job_cards child
                WHERE child.organization_id = j2.organization_id
                  AND child.source_job_card_id = j2.id)
            ORDER BY j2.manager_approved_at DESC NULLS LAST, j2.id DESC
            LIMIT 1) source) AS source_follow_up`;
    const result = await this.pool.query<OperationalSummaryRow>(
      `WITH visible AS (
         SELECT j.id, j.title, j.type, j.status,
                j.scheduled_at, j.created_at, j.manager_approved_at, j.source_job_card_id,
                j.assigned_to, u.name AS assignee_name,
                md.meeting_at, md.outcome, md.unsuccessful_reason_code,
                md.meeting_summary, md.next_follow_up_at
         FROM job_cards j
         JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
         LEFT JOIN job_card_meeting_details md
           ON md.organization_id = j.organization_id AND md.job_card_id = j.id
         WHERE ${scope.join(' AND ')}
       )
       SELECT
         (SELECT row_to_json(latest) FROM (
           SELECT id AS "jobCardId", title, type,
                  manager_approved_at AS "completedAt",
                  assigned_to AS "assigneeId", assignee_name AS "assigneeName"
           FROM visible
           WHERE status = 'COMPLETED' AND manager_approved_at IS NOT NULL
           ORDER BY manager_approved_at DESC, id DESC
           LIMIT 1) latest) AS latest_interaction,
         (SELECT row_to_json(next) FROM (
           SELECT id AS "jobCardId", title, type, status,
                  scheduled_at AS "scheduledAt",
                  assigned_to AS "assigneeId", assignee_name AS "assigneeName"
           FROM visible
           WHERE status = ANY($${activePosition}::varchar[])
             AND scheduled_at IS NOT NULL AND scheduled_at >= $${nowPosition}
           ORDER BY scheduled_at ASC, created_at ASC, id ASC
           LIMIT 1) next) AS next_planned_work,
         (SELECT COUNT(*)::int FROM visible WHERE status = 'WAITING_APPROVAL') AS waiting_approval_count,
         (SELECT COUNT(*)::int FROM visible WHERE status = 'REVISION_REQUESTED') AS revision_requested_count,
         (SELECT row_to_json(meeting) FROM (
           SELECT id AS "jobCardId", meeting_at AS "meetingAt", outcome,
                  unsuccessful_reason_code AS "unsuccessfulReason",
                  meeting_summary AS "meetingSummary", next_follow_up_at AS "nextFollowUpAt"
           FROM visible
           WHERE type = 'SALES_MEETING' AND status = 'COMPLETED' AND outcome IS NOT NULL
           ORDER BY meeting_at DESC NULLS LAST,
                    manager_approved_at DESC NULLS LAST, id DESC
           LIMIT 1) meeting) AS latest_meeting_outcome,
         (SELECT row_to_json(child) FROM (
           SELECT id AS "jobCardId" FROM visible
           WHERE source_job_card_id IS NOT NULL
           ORDER BY created_at DESC, id DESC
           LIMIT 1) child) AS follow_up_child,
         ${sourceFallback}`,
      values,
    );
    return mapOperationalSummary(result.rows[0]);
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
      `SELECT job_card_id, meeting_at, outcome, unsuccessful_reason_code,
              meeting_summary, next_follow_up_at
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
      `SELECT job_card_id, meeting_at, outcome, unsuccessful_reason_code,
              meeting_summary, next_follow_up_at
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

  async getWeeklyReportByJobId(organizationId: string, jobCardId: string) {
    return selectWeeklyReportByJob(this.pool, organizationId, jobCardId, false);
  }

  async listWeeklySourceWorkSnapshot(input: {
    organizationId: string;
    staffUserId: string;
    weekStart: Date;
    weekEnd: Date;
  }) {
    return selectWeeklySourceWork(this.pool, input);
  }

  async updateWeeklyReportDraftRow(input: WeeklyDraftRowUpdate) {
    return applyWeeklyDraftRow(this.pool, input);
  }

  async listWeeklyReportSubmissionRows(organizationId: string, reportId: string) {
    return selectWeeklySubmissions(this.pool, organizationId, reportId);
  }

  async getWeeklyReportSubmissionBySeq(
    organizationId: string,
    reportId: string,
    seqNo: number,
  ): Promise<WeeklyReportSubmissionRow | null> {
    const result = await this.pool.query<WeeklyReportSubmissionRow>(
      `SELECT ${WEEKLY_REPORT_SUBMISSION_COLUMNS} FROM weekly_report_submissions
        WHERE organization_id = $1 AND weekly_report_id = $2 AND seq_no = $3`,
      [organizationId, reportId, seqNo],
    );
    return result.rows[0] ?? null;
  }

  async getUserDisplayName(organizationId: string, userId: string): Promise<string | null> {
    const result = await this.pool.query<{ name: string }>(
      `SELECT name FROM users WHERE organization_id = $1 AND id = $2`,
      [organizationId, userId],
    );
    return result.rows[0]?.name ?? null;
  }

  /**
   * Profile history read model (WeeklyReportHistoryReadPort). Bounded: a count
   * statement plus one page statement, independent of the number of reports.
   *
   * The two statements are deliberately NOT wrapped in a transaction. They are
   * therefore not snapshot-consistent with each other: if a report is created
   * between them, `total` and the rows in `items` can disagree for a moment (and
   * `offset + items.length < total` can be true on the last page). That is
   * acceptable here because this is an informational, low-stakes read model that
   * is refreshed by realtime invalidation and re-read by the user; it is not a
   * lifecycle authority and nothing is written from it. Do not add a transaction
   * or a repeatable-read wrapper to close this window — it would hold a
   * connection open for a list view without changing any user-visible guarantee.
   */
  async listForStaff(
    input: StaffWeeklyReportHistoryQuery,
  ): Promise<PaginatedWeeklyReportHistory> {
    // Defense in depth: a STAFF actor is scoped to its own reports in SQL even
    // if a caller resolves a different target id.
    const staffUserId = input.actor.role === 'STAFF' ? input.actor.id : input.targetUserId;
    const total = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM weekly_reports r
        WHERE r.organization_id = $1 AND r.staff_user_id = $2`,
      [input.organizationId, staffUserId],
    );
    const page = await this.pool.query<WeeklyReportHistoryRow>(
      WEEKLY_REPORT_HISTORY_PAGE_SQL,
      [input.organizationId, staffUserId, input.limit, input.offset],
    );
    return {
      items: page.rows.map(mapWeeklyReportHistoryItem),
      total: Number(total.rows[0]?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
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

  async listOverdueIncidents(
    organizationId: string,
    jobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<PersistedOverdueIncident>> {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM job_card_overdue_incidents
       WHERE organization_id=$1 AND job_card_id=$2`,
      [organizationId, jobCardId],
    );
    const result = await this.pool.query<{
      id: string; organization_id: string; job_card_id: string;
      delay_type: OverdueIncidentDelayType; episode_no: number; schedule_revision_no: number;
      deadline_at: Date; breached_at: Date;
      accountable_user_id: string | null; accountable_user_name: string | null;
      accountable_role: OverdueAccountableRole; accountable_source: OverdueAccountableSource;
      source: OverdueIncidentSource; recorded_at: Date;
      recovered_at: Date | null; recovery_actor_user_id: string | null;
      recovery_actor_user_name: string | null;
      total_delay_seconds: number | null;
      reminder_sent_at: Date | null; reminder_actor_user_id: string | null;
      reminder_actor_name: string | null; reminder_target_user_id: string | null;
      reminder_target_name: string | null;
      post_reminder_delay_seconds: number | null;
    }>(`SELECT i.id, i.organization_id, i.job_card_id, i.delay_type, i.episode_no,
              i.schedule_revision_no, i.deadline_at, i.breached_at,
              i.accountable_user_id, au.name AS accountable_user_name,
              i.accountable_role, i.accountable_source, i.source, i.recorded_at,
              i.recovered_at, i.recovery_actor_user_id, ru.name AS recovery_actor_user_name,
              CASE WHEN i.recovered_at IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM (i.recovered_at - i.breached_at)))::int
              END AS total_delay_seconds,
              mr.sent_at AS reminder_sent_at,
              mr.actor_user_id AS reminder_actor_user_id,
              mr.actor_name AS reminder_actor_name,
              mr.target_user_id AS reminder_target_user_id,
              mr.target_name AS reminder_target_name,
              CASE WHEN i.recovered_at IS NULL OR mr.sent_at IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM (i.recovered_at - mr.sent_at)))::int
              END AS post_reminder_delay_seconds
         FROM job_card_overdue_incidents i
         LEFT JOIN users au
           ON au.organization_id = i.organization_id AND au.id = i.accountable_user_id
         LEFT JOIN users ru
           ON ru.organization_id = i.organization_id AND ru.id = i.recovery_actor_user_id
         -- OVR-4: the LATEST manual reminder for the same submission episode.
         -- Matched on the episode, not the incident id: a retroactive revision
         -- can put the reminder on a sibling incident of the same episode.
         LEFT JOIN LATERAL (
           SELECT r.sent_at, r.actor_user_id, r.target_user_id,
                  mau.name AS actor_name, mtu.name AS target_name
             FROM job_card_submission_reminders r
             LEFT JOIN users mau
               ON mau.organization_id = r.organization_id AND mau.id = r.actor_user_id
             LEFT JOIN users mtu
               ON mtu.organization_id = r.organization_id AND mtu.id = r.target_user_id
            WHERE r.organization_id = i.organization_id
              AND r.job_card_id = i.job_card_id
              AND r.delay_type = i.delay_type
              AND r.episode_no = i.episode_no
            ORDER BY r.sent_at DESC, r.id DESC
            LIMIT 1) mr ON TRUE
        WHERE i.organization_id=$1 AND i.job_card_id=$2
        ORDER BY i.breached_at DESC, i.id DESC
        LIMIT $3 OFFSET $4`, [organizationId, jobCardId, page.limit, page.offset]);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        jobCardId: row.job_card_id,
        delayType: row.delay_type,
        episodeNo: Number(row.episode_no),
        scheduleRevisionNo: Number(row.schedule_revision_no),
        deadlineAt: row.deadline_at,
        breachedAt: row.breached_at,
        accountableUserId: row.accountable_user_id,
        accountableUserName: row.accountable_user_name,
        accountableRole: row.accountable_role,
        accountableSource: row.accountable_source,
        source: row.source,
        recordedAt: row.recorded_at,
        recoveredAt: row.recovered_at,
        recoveryActorUserId: row.recovery_actor_user_id,
        recoveryActorUserName: row.recovery_actor_user_name,
        totalDelaySeconds: row.total_delay_seconds === null
          ? null
          : Number(row.total_delay_seconds),
        managerReminder: row.reminder_sent_at === null ? null : {
          sentAt: row.reminder_sent_at,
          actorUserId: row.reminder_actor_user_id,
          actorName: row.reminder_actor_name,
          targetUserId: row.reminder_target_user_id,
          targetName: row.reminder_target_name,
        },
        postReminderDelaySeconds: row.post_reminder_delay_seconds === null
          ? null
          : Number(row.post_reminder_delay_seconds),
      })),
      total: Number(count.rows[0]?.total ?? 0),
      limit: page.limit,
      offset: page.offset,
    };
  }

  async getOpenSubmissionDelay(
    organizationId: string,
    jobCardId: string,
    requestTime: Date,
  ): Promise<OpenSubmissionDelay | null> {
    const result = await this.pool.query<{
      id: string; episode_no: number; deadline_at: Date; breached_at: Date;
      elapsed_seconds: number; accountable_user_id: string | null;
      accountable_user_name: string | null;
    }>(
      `SELECT i.id, i.episode_no, i.deadline_at, i.breached_at,
              GREATEST(FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - i.breached_at)))::int, 0)
                AS elapsed_seconds,
              i.accountable_user_id, au.name AS accountable_user_name
         FROM job_card_overdue_incidents i
         LEFT JOIN users au
           ON au.organization_id = i.organization_id AND au.id = i.accountable_user_id
        WHERE i.organization_id = $1 AND i.job_card_id = $2
          AND i.delay_type = 'LATE_SUBMISSION' AND i.recovered_at IS NULL
        ORDER BY i.breached_at DESC, i.id DESC
        LIMIT 1`,
      [organizationId, jobCardId, requestTime],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      incidentId: row.id,
      episodeNo: Number(row.episode_no),
      deadlineAt: row.deadline_at,
      breachedAt: row.breached_at,
      elapsedSeconds: Number(row.elapsed_seconds),
      accountableUserId: row.accountable_user_id,
      accountableUserName: row.accountable_user_name,
    };
  }

  /**
   * OVR-3 candidate discovery prefilter for one delay type.
   *
   * This is deliberately *only* a prefilter. It returns bounded,
   * deterministically ordered rows that could carry a clock-only breach and
   * excludes rows whose incident — for the revision/episode identity the
   * shared producer would resolve — already exists. Final eligibility is
   * always re-evaluated under the JobCard lock through that producer.
   *
   * The boundary expressions come from the domain renderers so the +1ms
   * submission step, the due-date local-midnight fallback and the 24h approval
   * threshold keep exactly one owner (see `overdue-incidents.ts`).
   *
   * Evidence prefilters (acceptance present and a revision exists, activation
   * provable, SUBMITTED fact present) keep the candidate set productive: a row
   * whose required evidence can never be proven is never returned, so it
   * cannot starve later candidates out of the bounded batch.
   */
  async listOverdueBreachCandidates(input: {
    delayType: OverdueIncidentDelayType;
    scanTime: Date;
    limit: number;
  }): Promise<readonly OverdueScanCandidate[]> {
    const currentRevisionSql = `(
      SELECT MAX(r2.revision_no) FROM job_card_schedule_revisions r2
       WHERE r2.organization_id = j.organization_id AND r2.job_card_id = j.id)`;
    const nextEpisodeSql = `(
      SELECT COALESCE(MAX(f.seq_no), 0) + 1 FROM job_card_accountability_facts f
       WHERE f.organization_id = j.organization_id AND f.job_card_id = j.id
         AND f.fact_type = 'SUBMITTED')`;
    let sql: string;
    let values: unknown[];
    switch (input.delayType) {
      case 'LATE_START': {
        sql = `SELECT j.organization_id, j.id AS job_card_id
          FROM job_cards j
         WHERE j.status = 'ACCEPTED'
           AND j.accepted_at IS NOT NULL
           AND j.scheduled_ends_at IS NOT NULL
           AND ${lateStartBoundarySql({ scheduledEndsAt: 'j.scheduled_ends_at' })} <= $2
           AND EXISTS (
             SELECT 1 FROM job_card_schedule_revisions r
              WHERE r.organization_id = j.organization_id AND r.job_card_id = j.id)
           AND NOT EXISTS (
             SELECT 1 FROM job_card_overdue_incidents i
              WHERE i.organization_id = j.organization_id AND i.job_card_id = j.id
                AND i.delay_type = 'LATE_START' AND i.episode_no = 1
                AND i.schedule_revision_no = ${currentRevisionSql})
         ORDER BY j.scheduled_ends_at ASC, j.id ASC
         LIMIT $1`;
        values = [input.limit, input.scanTime];
        break;
      }
      case 'LATE_SUBMISSION': {
        const firstLateSql = submissionBreachInstantSql(effectiveSubmissionDeadlineSql({
          scheduledEndsAt: 'j.scheduled_ends_at',
          scheduledAt: 'j.scheduled_at',
          type: 'j.type',
          dueDate: 'j.due_date',
          timezone: 'o.timezone',
          requestTime: '$2',
        }));
        sql = `SELECT j.organization_id, j.id AS job_card_id
          FROM job_cards j
          JOIN organizations o ON o.id = j.organization_id
         WHERE j.status IN ('IN_PROGRESS', 'REVISION_REQUESTED')
           AND ${firstLateSql} <= $2
           AND EXISTS (
             SELECT 1 FROM job_card_schedule_revisions r
              WHERE r.organization_id = j.organization_id AND r.job_card_id = j.id)
           AND (
             EXISTS (
               SELECT 1 FROM job_card_submission_episode_activations a
                WHERE a.organization_id = j.organization_id AND a.job_card_id = j.id
                  AND a.episode_no = ${nextEpisodeSql}
                  AND a.activated_at <= $2)
             OR (${nextEpisodeSql} = 1 AND j.started_at IS NOT NULL AND j.started_at <= $2))
           AND NOT EXISTS (
             SELECT 1 FROM job_card_overdue_incidents i
              WHERE i.organization_id = j.organization_id AND i.job_card_id = j.id
                AND i.delay_type = 'LATE_SUBMISSION'
                AND i.episode_no = ${nextEpisodeSql}
                AND i.schedule_revision_no = ${currentRevisionSql})
         ORDER BY ${firstLateSql} ASC, j.id ASC
         LIMIT $1`;
        values = [input.limit, input.scanTime];
        break;
      }
      case 'APPROVAL_WAIT': {
        sql = `SELECT j.organization_id, j.id AS job_card_id
          FROM job_cards j
         CROSS JOIN LATERAL (
           SELECT f.seq_no, f.occurred_at, f.schedule_revision_no
             FROM job_card_accountability_facts f
            WHERE f.organization_id = j.organization_id AND f.job_card_id = j.id
              AND f.fact_type = 'SUBMITTED'
            ORDER BY f.seq_no DESC
            LIMIT 1) fact
         WHERE j.status = 'WAITING_APPROVAL'
           AND ${approvalWaitBoundarySql({
             submittedAt: 'fact.occurred_at',
             hoursParameter: '$3',
           })} <= $2
           AND EXISTS (
             SELECT 1 FROM job_card_schedule_revisions r
              WHERE r.organization_id = j.organization_id AND r.job_card_id = j.id
                AND r.revision_no = fact.schedule_revision_no)
           AND NOT EXISTS (
             SELECT 1 FROM job_card_overdue_incidents i
              WHERE i.organization_id = j.organization_id AND i.job_card_id = j.id
                AND i.delay_type = 'APPROVAL_WAIT'
                AND i.schedule_revision_no = fact.schedule_revision_no
                AND i.episode_no = fact.seq_no)
         ORDER BY fact.occurred_at ASC, j.id ASC
         LIMIT $1`;
        values = [input.limit, input.scanTime, APPROVAL_WAIT_BREACH_HOURS];
        break;
      }
    }
    const result = await this.pool.query<{ organization_id: string; job_card_id: string }>(
      sql, values,
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      jobCardId: row.job_card_id,
    }));
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
