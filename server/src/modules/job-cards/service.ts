import { AppError } from '../../errors/index.js';
import { randomUUID } from 'node:crypto';
import { presentActivity } from './activity-presenter.js';
import {
  assertCanCreateForAssignee,
  assertCanCreateFollowUp,
  assertCanListFollowUps,
  assertCanInvalidate,
  assertCanReadOverdueIncidentHistory,
  assertCanEdit, assertCanEditDeliveryActualTime,
  assertCanEditMeetingResult,
  assertCanTransition,
  assertCanViewMeetingResult,
  assertCreateAssignmentRequest,
  assertProductDeliveryJob,
  assertFollowUpSourceEligible,
  assertSalesMeetingJob,
  isTerminalJobStatus,
  getAllowedJobActions,
  getAllowedLifecycleCommands,
  resolveSourceAccess,
} from './policy.js';
import type {
  CriticalActionResult,
  DeliveryItemRecord,
  FollowUpSourceReference,
  JobCardRepository,
  JobCardTransaction,
  JobLifecycleInstants,
  LifecycleIntentClaim,
  LifecycleIntentReservation,
  NotePageQuery,
  PageQuery,
  ProductReference,
  PersistedFollowUpListItem,
  SubmissionReader,
} from './repository.js';
import {
  deliveryItemCreateRequestHash,
  followUpCreateRequestHash,
  jobCardCreateRequestHash,
  lifecycleRequestHash,
  meetingDetailsUpdateRequestHash,
  productDeliveryCreateRequestHash,
  type LifecycleLocationCapture,
} from './critical-action-request-hash.js';
import {
  ACTIVE_JOB_CARD_STATUSES,
  DELIVERY_PURPOSES,
  JOB_CARD_ENGAGEMENT_KINDS,
  JOB_CARD_INVALIDATION_REASON_CODES,
  JOB_CARD_PRIORITIES,
  JOB_CARD_TYPES,
  type DeliveryPurpose,
  type JobCard,
  type JobCardActor,
  type JobCardAssignee,
  type JobCardBoard,
  type JobCardBoardQuery,
  type JobCardActivityEvent,
  type JobCardDetail,
  type JobCardEngagementKind,
  type FollowUpCreateInput,
  type FollowUpCreateReceipt,
  type FollowUpSourceSummary,
  type JobCardListItem,
  type JobCardListQuery,
  type JobCardMutationReceipt,
  type PaginatedFollowUpList,
  type JobCardOperationalNoteContext,
  type JobCardStatus,
  type JobPermissionSubject,
  type LifecycleCommand,
  type NormalizedJobCardCreateInput,
  type ProductDeliveryCreateInput,
  type JobCardPriority,
  type PersistedJobCardDetail,
  type PersistedJobCardListItem,
  type PaginatedOverdueIncidentHistory,
  LIFECYCLE_INTENT_TTL_MS_DEFAULT,
  MEETING_DETAIL_FIELDS,
  type MeetingDetails,
  type MeetingDetailsCandidate,
  type PatchMeetingDetailsInput,
  type ApproveFollowUpInput,
  type FollowUpProposal,
  type FollowUpProposalInput,
  type FollowUpProposalOrigin,
  type FollowUpSuggestion,
  type JobCardType,
  type RoleProjectedCustomerScheduleEvaluation,
  type CustomerSchedulePreviewInput,
  type AvailableSlotsInput,
  type AvailableSlotsResponse,
  type JobCardInvalidationInput,
} from './types.js';
import {
  jobCardInvalidationRequestHash,
} from './invalidation-input.js';
import {
  isoInstant,
  optionalLifecycleNote,
  requireActionId,
  requireLifecycleReason,
  requireSubmissionNote,
  validation,
  boundedTrimmedString,
} from './validation.js';
import {
  normalizeFollowUpDueDate,
  priority as normalizePriority,
} from './create-input.js';
import { addCalendarDaysToDateKey } from './local-calendar.js';
import type { ManagerQuestion } from '../weekly-reports/types.js';
import type {
  WeeklyReportDetail,
  WeeklyReportSubmission,
} from '../weekly-reports/types.js';
import {
  mapReport,
  mapSubmission,
} from '../weekly-reports/repository.js';
import { buildWeeklyReportPdfDocumentModel } from '../weekly-reports/pdf/document-model.js';
import { weeklyReportPdfFileName } from '../weekly-reports/pdf/file-name.js';
import { renderWeeklyReportPdf } from '../weekly-reports/pdf/renderer.js';
import {
  currentWeeklyReportPeriod,
  type WeeklyReportReference,
} from '../weekly-reports/reference.js';
import {
  mapSourceWorkRow,
  weekInstants,
} from '../weekly-reports/source-work.js';
import {
  validateDraftAnswers,
  validateDraftBody,
  validateSubmissionAnswers,
  validateSubmissionBody,
  validateSourceWorkSnapshot,
} from '../weekly-reports/validation.js';
import {
  weeklyReportAlreadyExists,
  weeklyReportBulkRequestHash,
  weeklyReportCreateRequestHash,
  weeklyReportTitle,
  type WeeklyReportBulkRequestInput,
  type WeeklyReportCreateInput,
} from '../weekly-reports/create-input.js';
import { validateManagerQuestions } from '../weekly-reports/validation.js';
import { JobCardNotesService, type CreateNoteInput } from './notes-service.js';
import {
  evaluateSubmission,
  validateSubmission,
  type SubmissionEvaluation,
} from './submission-policy.js';
import { validateMeetingDetailsCandidate } from './meeting-details-input.js';
import {
  filterAvailableSlotCandidates,
  generateAvailableSlotCandidates,
} from './available-slots.js';
import type { AvailableSlotCandidate } from './available-slots.js';
import {
  isFollowUpSlotBlocked,
  iterateFollowUpSlotCandidates,
  resolveFollowUpSearchHorizonAt,
} from './follow-up-auto-scheduler.js';
import {
  evaluateCustomerSchedule,
  isOnSiteJobType,
  MAX_TZ_OFFSET_MS,
  type CustomerScheduleEvaluation,
  type CustomerFrequencyAdvisory,
} from './customer-schedule.js';
import {
  FREQUENT_VISIT_WINDOW_DAYS,
  FREQUENT_VISIT_ADVISORY_THRESHOLD,
  FOLLOW_UP_SEARCH_HORIZON_DAYS,
  defaultFollowUpInstructions,
  defaultFollowUpType,
  earliestFollowUpAllowedAt,
  requiresMandatoryFollowUpProposal,
  suggestedFollowUpInstant,
  type FollowUpProposalFields,
} from './follow-up-policy.js';
import {
  canonicalScheduledDurationMs,
  canonicalScheduledEnd,
  hasValidPlannedInterval,
  persistedScheduledDurationMs,
} from './job-card-duration.js';
import {
  mapJobCardActivityToRealtime,
} from '../realtime/event-mapper.js';
import {
  createJobCardNotificationDrafts,
} from '../notifications/policy.js';
import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import type {
  RealtimeEventRecord,
} from '../realtime/types.js';
import type { AppendedActivity } from './repository.js';
import { lockAssigneesInOrder } from './assignee-lock.js';
import type { AppendWebPushDeliveriesInput } from '../web-push/repository.js';
import type { ReverseGeocoder } from './reverse-geocoder.js';
import {
  parseStartLocationCapture,
  type StartLocationCapture,
} from './start-location-input.js';
import type { JobActionLocationCapture } from './location-types.js';
import type { ReverseGeocodingQuotaGuard } from '../geocoding/reverse-geocoding-quota.js';
import type { NotificationDraft } from '../notifications/types.js';
import { normalizeExpiryDate } from './delivery-input.js';
import {
  type OverdueIncidentIdentity,
  type OverdueIncidentSource,
} from './overdue-incidents.js';
import {
  materializeApprovalWaitIfBreached as produceApprovalWaitBreach,
  materializeLateStartIfBreached as produceLateStartBreach,
  materializeLateSubmissionIfBreached as produceLateSubmissionBreach,
  overdueRevisionMissingError,
  type OverdueBreachEvaluation,
} from './overdue-breach-producer.js';

/**
 * OVR-2 fail mode for the shared breach producer: a request-driven producer
 * treats a missing governing revision (or any other unprovable evidence) as an
 * invariant violation, while the OVR-3 scanner skips it. Only the mode lives
 * here; the eligibility decision itself is shared.
 */
function unwrapBreach(evaluation: OverdueBreachEvaluation): OverdueIncidentIdentity | null {
  if (evaluation.kind === 'unprovable' && evaluation.reason === 'REVISION_MISSING') {
    throw overdueRevisionMissingError();
  }
  return evaluation.kind === 'breached' ? evaluation.identity : null;
}

type PatchInput = {
  expectedVersion: number; title?: string; description?: string | null;
  customerId?: string; contactId?: string | null; assignedTo?: string; priority?: JobCardPriority;
  dueDate?: string | null; scheduledAt?: string | null;
  scheduledEndsAt?: string | null;
  engagementKind?: JobCardEngagementKind;
  overrideReason?: string | null;
};
type DeliveryInput = {
  expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose;
  deliveredAt: string | null; quantity: number; lotNo?: string | null; serialNo?: string | null;
  expiryDate?: string | null; deliveryNote?: string | null;
};
type AddDeliveryInput = DeliveryInput & { clientActionId: string };
type PatchDeliveryInput = { expectedVersion: number } & Partial<Omit<DeliveryInput, 'expectedVersion'>>;
type LifecycleInput = {
  expectedVersion: number;
  clientActionId: string;
  note?: string | null;
};
type SubmitInput = LifecycleInput & { followUpProposal?: FollowUpProposalInput };
type ApproveInput = LifecycleInput & { followUp?: ApproveFollowUpInput };
type StartInput = LifecycleInput & { locationCapture?: unknown };
type RevisionInput = LifecycleInput & { revisionReason: string };
type CancelInput = LifecycleInput & { cancelReason: string };

function assertFollowUpMinimumLead(input: {
  meetingAt: string | null;
  requestTime: Date;
  scheduledAt: Date;
}) {
  const earliestAllowedAt = earliestFollowUpAllowedAt({
    meetingAt: input.meetingAt === null ? null : new Date(input.meetingAt),
    requestAt: input.requestTime,
  });
  if (input.scheduledAt.valueOf() < earliestAllowedAt.valueOf()) {
    throw new AppError(
      'FOLLOW_UP_PROPOSAL_INVALID',
      400,
      'Takip işi planı için görüşme/işlem zamanından en az 15 dakika sonrası seçilmelidir.',
    );
  }
}

const JOB_CARD_PATCH_FIELDS = [
  'expectedVersion', 'title', 'description', 'customerId', 'contactId',
  'assignedTo', 'priority', 'dueDate', 'scheduledAt', 'scheduledEndsAt',
  'engagementKind', 'overrideReason',
] as const;
type LifecycleDefinition = {
  command: LifecycleCommand;
  operationKey: string;
  target: JobCardStatus;
  event: JobCardActivityEvent;
  note: string | null;
  revisionReason: string | null;
  cancelReason: string | null;
  noteContext: JobCardOperationalNoteContext | null;
  followUpProposal?: FollowUpProposalInput;
  approveFollowUp?: ApproveFollowUpInput;
};

type OverdueRecoveryTarget = Pick<
  OverdueIncidentIdentity,
  'organizationId' | 'jobCardId' | 'delayType' | 'episodeNo'
>;

type ValidatedFollowUpProposal = FollowUpProposalFields & {
  assignee: JobCardAssignee;
};

function parseDeliveredAt(value: string | null): Date | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  const deliveredAt = new Date(value);
  if (Number.isNaN(deliveredAt.getTime())) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  return deliveredAt;
}

function deliveryRecord(organizationId: string, jobCardId: string, input: DeliveryInput, product: ProductReference): Omit<DeliveryItemRecord, 'id'> {
  const deliveredAt = parseDeliveredAt(input.deliveredAt);
  if (!DELIVERY_PURPOSES.includes(input.deliveryPurpose) || !Number.isFinite(input.quantity) || input.quantity <= 0
    || !input.productId) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  return { organizationId, jobCardId, productId: product.id, deliveryPurpose: input.deliveryPurpose,
    deliveredAt, quantity: input.quantity, unit: product.unit, productNameSnapshot: product.name,
    productSkuSnapshot: product.sku, productModelSnapshot: product.model, lotNo: input.lotNo?.trim() || null,
    serialNo: input.serialNo?.trim() || null, expiryDate: normalizeExpiryDate(input.expiryDate),
    deliveryNote: input.deliveryNote?.trim() || null };
}

const MAX_INITIAL_DELIVERY_ITEMS = 25;

function assertInitialProductDeliveryItems(input: ProductDeliveryCreateInput) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_INITIAL_DELIVERY_ITEMS) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünleri geçersiz.');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.productId !== 'string' || !item.productId.trim()
      || seen.has(item.productId) || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünleri geçersiz.');
    }
    seen.add(item.productId);
  }
}

function assertKnownFields(input: object, allowed: readonly string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new AppError('VALIDATION_ERROR', 400, 'İstek desteklenmeyen alan içeriyor.');
  }
}

function invariantViolation(): never {
  throw new AppError(
    'INVARIANT_VIOLATION',
    500,
    'İş kaydının yapılandırılmış görüşme bilgileri bulunamadı.',
  );
}

function followUpInvariantViolation(): never {
  throw new AppError(
    'INVARIANT_VIOLATION',
    500,
    'Takip işinin kaynak bağlantısı geçersizdir.',
  );
}

/**
 * Role projection for assignee calendar conflicts on calendar mutations: STAFF actors get
 * the same code/status/message but never the conflict details (which may
 * expose other staff members' plans). MANAGER/ADMIN keep the rich details.
 */
function projectCalendarConflict(actor: JobCardActor, error: AppError): AppError {
  if (actor.role === 'STAFF' && error.code === 'CALENDAR_CONFLICT') {
    return new AppError(error.code, error.statusCode, error.message, { conflicts: [] });
  }
  return error;
}

type DecodedLifecycleReceipt = {
  jobCardId: string;
  evaluatedAt: Date | null;
  followUpJobCardId: string | null;
};

function decodeJobCardMutationReceipt(value: unknown): DecodedLifecycleReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVARIANT_VIOLATION', 500, 'JobCard işlem sonucu geçersizdir.');
  }
  const record = value as Record<string, unknown>;
  const jobCardId = Object.hasOwn(record, 'jobCardId') ? record.jobCardId : record.id;
  if (typeof jobCardId !== 'string' || !jobCardId) {
    throw new AppError('INVARIANT_VIOLATION', 500, 'JobCard işlem sonucu geçersizdir.');
  }
  let evaluatedAt: Date | null = null;
  if (typeof record.evaluatedAt === 'string') {
    const parsed = new Date(record.evaluatedAt);
    if (!Number.isNaN(parsed.valueOf())) evaluatedAt = parsed;
  }
  const followUpJobCardId = typeof record.followUpJobCardId === 'string'
    ? record.followUpJobCardId
    : null;
  return { jobCardId, evaluatedAt, followUpJobCardId };
}

function assertStaffStartActor(actor: JobCardActor) {
  if (actor.role !== 'STAFF') {
    throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
  }
}

function assertPlannedIntervalForStart(job: Pick<JobCard, 'type' | 'scheduledAt' | 'scheduledEndsAt'>) {
  if (!hasValidPlannedInterval(job.type, job.scheduledAt, job.scheduledEndsAt)) {
    throw new AppError(
      'SCHEDULED_INTERVAL_REQUIRED',
      400,
      'Bu iş türü başlatılmadan önce geçerli bir planlanan zaman aralığı gereklidir.',
    );
  }
}

function locationUnavailableMessage(reason: string): string {
  switch (reason) {
    case 'PERMISSION_DENIED':
      return 'Konum izni reddedildi. Lütfen cihaz ayarlarından konum iznini verin ve tekrar deneyin.';
    case 'POSITION_UNAVAILABLE':
      return 'Konum alınamadı. Cihaz konumu şu anda kullanılamıyor.';
    case 'TIMEOUT':
      return 'Konum alınamadı. Konum isteği zaman aşımına uğradı, lütfen tekrar deneyin.';
    case 'UNSUPPORTED':
      return 'Bu tarayıcı konum özelliğini desteklemiyor.';
    case 'UNKNOWN':
    default:
      return 'Konum alınamadı. Lütfen tekrar deneyin.';
  }
}

function meetingDetailsResponse(
  jobCardId: string,
  jobCardVersion: number,
  details: MeetingDetailsCandidate,
): MeetingDetails {
  return {
    jobCardId,
    ...details,
    unsuccessfulReason: details.unsuccessfulReason ?? null,
    jobCardVersion,
  };
}

const DELIVERY_FIELDS = [
  'expectedVersion', 'productId', 'deliveryPurpose', 'deliveredAt', 'quantity',
  'lotNo', 'serialNo', 'expiryDate', 'deliveryNote',
] as const;

function lifecycleReason(value: unknown, field: 'revisionReason' | 'cancelReason') {
  if (typeof value !== 'string' || !value.trim()) {
    const revision = field === 'revisionReason';
    throw new AppError(
      revision ? 'REVISION_REASON_REQUIRED' : 'CANCEL_REASON_REQUIRED',
      400,
      revision ? 'Düzeltme nedeni zorunludur.' : 'İptal nedeni zorunludur.',
    );
  }
  return requireLifecycleReason(value, field);
}

export type WeeklyReportCreateResult = {
  jobCardId: string;
  reportId: string;
  staffUserId: string;
  periodStart: string;
  periodEnd: string;
  status: JobCardStatus;
  dueDate: string | null;
};

/**
 * Internal result of the shared creation core. `existing` means an already
 * canonical report for that staff/week won the identity; the JobCard and
 * report ids point at that winner and no new row was written.
 *
 * Exported for the Slice 5 recurrence worker, which drives the same core
 * through {@link JobCardService.createOrResolveWeeklyReportForStaff} below.
 */
export type WeeklyReportCreationOutcome =
  | {
      outcome: 'created';
      jobCardId: string;
      reportId: string;
      jobStatus: JobCardStatus;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | { outcome: 'existing'; jobCardId: string; reportId: string };

/**
 * Bulk request result. One item per normalized requested staff id, in request
 * order; `existing` items carry the already-canonical report so the client can
 * navigate to it instead of treating the duplicate as an error.
 */
export type WeeklyReportBulkRequestResult = {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  items: Array<{
    staffUserId: string;
    jobCardId: string;
    reportId: string;
    outcome: 'created' | 'existing';
  }>;
};

export class JobCardService {
  private readonly notesService: JobCardNotesService;

  constructor(
    private readonly repository: JobCardRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly realtimePublisher: RealtimeEventPublisher =
      NOOP_REALTIME_EVENT_PUBLISHER,
    private readonly geolocation: Readonly<{
      enabled: boolean;
      reverseGeocoder?: ReverseGeocoder;
      reverseGeocoderTimeoutMs?: number;
      quotaGuard?: ReverseGeocodingQuotaGuard;
    }> = { enabled: false },
    private readonly webPush: Readonly<{
      enabled: boolean;
    }> = { enabled: false },
    private readonly calendar: Readonly<{
      enabled: boolean;
      reminderLeadMinutes: number;
    }> = { enabled: false, reminderLeadMinutes: 30 },
    private readonly lifecycle: Readonly<{
      intentTtlMs?: number;
    }> = {},
  ) { this.notesService = new JobCardNotesService(repository); }

  private publishRealtime(events: readonly RealtimeEventRecord[]) {
    for (const event of events) {
      this.realtimePublisher.publish(event);
    }
  }

  /**
   * 049: lifecycle intent processing budget. Configured via
   * JOB_CARD_LIFECYCLE_INTENT_TTL_MS, defaulting to the domain constant.
   */
  private intentTtlMs(): number {
    return this.lifecycle.intentTtlMs ?? LIFECYCLE_INTENT_TTL_MS_DEFAULT;
  }

  /**
   * Every scheduling writer acquires User rows before JobCard, Customer, or
   * Calendar rows. Sorting and de-duplicating the ids makes multi-assignee
   * operations use one deterministic User lock order as well.
   */
  private async lockUsersInOrder(
    transaction: JobCardTransaction,
    organizationId: string,
    userIds: readonly (string | null | undefined)[],
  ) {
    return lockAssigneesInOrder(transaction, organizationId, userIds);
  }

  private requiredLockedAssignee(
    assignees: ReadonlyMap<string, JobCardAssignee>,
    userId: string,
  ) {
    const assignee = assignees.get(userId);
    if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    return assignee;
  }

  private async appendRealtimeForActivity(
    transaction: JobCardTransaction,
    input: {
      activity: AppendedActivity;
      organizationId: string;
      jobCardId: string;
      actorUserId: string;
      event: JobCardActivityEvent;
      beforeAssigneeId: string | null;
      afterAssigneeId: string;
      calendarAffected?: boolean;
      notifyCalendarRescheduled?: boolean;
      sourceJobCardId?: string | null;
      customerId?: string | null;
    },
  ): Promise<RealtimeEventRecord[]> {
    const mapped = mapJobCardActivityToRealtime({
      activityId: input.activity.id,
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      actorUserId: input.actorUserId,
      event: input.event,
      occurredAt: input.activity.createdAt,
      beforeAssigneeId: input.beforeAssigneeId,
      afterAssigneeId: input.afterAssigneeId,
      sourceJobCardId: input.sourceJobCardId,
      customerId: input.customerId,
    });
    if (!mapped) return [];

    const managementRecipients = input.event === 'JOB_SUBMITTED_FOR_APPROVAL'
      ? await transaction.listActiveManagementRecipients(input.organizationId)
      : [];
    const drafts: NotificationDraft[] = [...createJobCardNotificationDrafts({
      event: input.event,
      actorUserId: input.actorUserId,
      afterAssigneeId: input.afterAssigneeId,
      jobCardId: input.jobCardId,
      managementRecipients,
    })];
    if (
      input.notifyCalendarRescheduled
      && !drafts.some((draft) => draft.recipientUserId === input.afterAssigneeId)
    ) {
      drafts.push({
        recipientUserId: input.afterAssigneeId,
        kind: 'calendar.rescheduled',
        entityType: 'job-card',
        entityId: input.jobCardId,
      });
    }
    const resourceKeys = new Set(mapped.resourceKeys);
    if (input.calendarAffected) {
      resourceKeys.add('calendar');
      resourceKeys.add(`calendar:${input.afterAssigneeId}`);
      if (input.beforeAssigneeId) {
        resourceKeys.add(`calendar:${input.beforeAssigneeId}`);
      }
    }
    const realtimeEvent = await transaction.appendRealtimeEvent({
      ...mapped,
      resourceKeys: drafts.length > 0
        ? [...new Set([...resourceKeys, 'notifications'])].sort()
        : [...resourceKeys].sort(),
    });
    if (drafts.length > 0) {
      const notifications = await transaction.appendNotifications({
        organizationId: input.organizationId,
        sourceRealtimeEventId: realtimeEvent.id,
        createdAt: input.activity.createdAt,
        drafts,
      });
      if (this.webPush.enabled && notifications.length > 0) {
        await transaction.appendWebPushDeliveries({
          organizationId: input.organizationId,
          notificationIds: notifications.map((n) => n.id),
          at: input.activity.createdAt,
        });
      }
    }
    return [realtimeEvent];
  }

  async listNotes(actor: JobCardActor, jobCardId: string, page: NotePageQuery) {
    return this.notesService.listNotes(actor, jobCardId, page);
  }

  async addNote(actor: JobCardActor, jobCardId: string, input: CreateNoteInput) {
    const result = await this.notesService.addNote(actor, jobCardId, input);
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return result.response;
  }

  async invalidate(
    actor: JobCardActor,
    jobCardId: string,
    input: JobCardInvalidationInput,
  ) {
    assertCanInvalidate(actor);
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    if (!(JOB_CARD_INVALIDATION_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw validation('reasonCode');
    }
    const note = input.note === null ? null : optionalLifecycleNote(input.note);
    if (input.reasonCode === 'OTHER' && note === null) {
      throw new AppError(
        'INVALIDATION_NOTE_REQUIRED',
        400,
        'OTHER nedeni için açıklama zorunludur.',
      );
    }
    const normalizedInput: JobCardInvalidationInput = {
      clientActionId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode,
      note,
    };
    const requestTime = this.now();
    const operationKey = `JOB_INVALIDATE:${jobCardId}`;
    const result = await this.repository.executeCriticalAction<JobCardMutationReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
        requestHash: jobCardInvalidationRequestHash(jobCardId, normalizedInput),
      },
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.status === 'INVALIDATED') {
          throw new AppError('JOB_ALREADY_INVALIDATED', 409, 'JobCard zaten geçersiz kılınmış.');
        }
        if (job.version !== normalizedInput.expectedVersion) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        const activeChildren = await tx.listActiveFollowUpChildrenForUpdate(
          actor.organizationId,
          jobCardId,
        );
        if (activeChildren.length > 0) {
          throw new AppError(
            'JOB_HAS_ACTIVE_FOLLOW_UPS',
            409,
            'Aktif takip işleri bulunan JobCard geçersiz kılınamaz.',
          );
        }
        const updated = await tx.invalidateWithVersion({
          organizationId: actor.organizationId,
          jobCardId,
          expectedVersion: normalizedInput.expectedVersion,
          invalidatedAt: requestTime,
          invalidatedBy: actor.id,
          reasonCode: normalizedInput.reasonCode,
        });
        if (!updated) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }

        const noteId = note === null ? null : randomUUID();
        const author = noteId === null
          ? null
          : await tx.getNoteAuthorSnapshot(actor.organizationId, actor.id);
        if (noteId !== null && !author?.isActive) {
          throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
        }
        const activity = await tx.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'JOB_INVALIDATED',
          clientActionId,
          oldValue: { status: job.status, version: job.version },
          newValue: { status: updated.status, version: updated.version },
          metadata: {
            reasonCode: normalizedInput.reasonCode,
            ...(noteId ? { noteId } : {}),
          },
        });
        await tx.appendAudit({
          organizationId: actor.organizationId,
          actorUserId: actor.id,
          subjectId: jobCardId,
          oldValue: { status: job.status, version: job.version },
          newValue: { status: updated.status, version: updated.version },
          metadata: {
            reasonCode: normalizedInput.reasonCode,
            clientActionId,
            operationKey,
          },
        });
        if (note !== null && noteId !== null && author) {
          await tx.createNote({
            id: noteId,
            organizationId: actor.organizationId,
            jobCardId,
            authorId: actor.id,
            authorNameSnapshot: author.name,
            authorRoleSnapshot: author.role,
            workflowStage: job.status,
            context: 'INVALIDATE',
            relatedActivityId: activity.id,
            note,
            invoiceNumber: null,
          });
        }
        await tx.synchronizeCalendarReminder({
          organizationId: actor.organizationId,
          jobCardId,
          assignedUserId: updated.assignedTo,
          startsAt: updated.scheduledAt,
          endsAt: updated.scheduledEndsAt,
          version: updated.version,
          active: false,
          now: requestTime,
          reminderLeadMinutes: this.calendar.reminderLeadMinutes,
        });
        const realtimeEvents = await this.appendRealtimeForActivity(tx, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'JOB_INVALIDATED',
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: updated.assignedTo,
          calendarAffected: true,
          customerId: updated.customerId,
        });
        return {
          response: {
            jobCardId,
            evaluatedAt: requestTime.toISOString(),
          },
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    const receipt = decodeJobCardMutationReceipt(result.response);
    return this.detailAt(actor, receipt.jobCardId, receipt.evaluatedAt ?? this.now());
  }

  async create(actor: JobCardActor, input: NormalizedJobCardCreateInput) {
    const title = input.title.trim();
    const priority = input.priority;
    if (input.type === 'PRODUCT_DELIVERY'
      && (input as { contactId: string | null }).contactId !== null) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Ürün teslimi oluştururken ilgili kişi seçilemez.',
      );
    }
    if (!input.clientActionId.trim() || !title ||
      (input.type === 'PRODUCT_DELIVERY' && !input.customerId) ||
      !input.assignedTo || !JOB_CARD_PRIORITIES.includes(priority)) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard oluşturma bilgileri geçersiz.');
    }
    const intervalJob = input.type === 'PRODUCT_DELIVERY' || input.type === 'SALES_MEETING';
    const canonicalEnd = intervalJob && input.scheduledAt
      ? canonicalScheduledEnd(input.type, input.scheduledAt)
      : null;
    if (intervalJob && (!input.scheduledAt || canonicalEnd === null
      || (input.scheduledEndsAt !== undefined && input.scheduledEndsAt !== canonicalEnd))) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'JobCard oluşturma bilgileri geçersiz.',
      );
    }
    assertCreateAssignmentRequest(actor, input.assignedTo);
    const requestTime = this.now();
    let result: CriticalActionResult<JobCardMutationReceipt>;
    try {
      result = await this.repository.executeCriticalAction<JobCardMutationReceipt>(
        {
          organizationId: actor.organizationId, userId: actor.id,
          clientActionId: input.clientActionId, operationKey: 'JOB_CREATE',
          // JobCard critical-action request identity (AUDIT-0 remediation):
          // full normalized create intent binds this key to its content.
          requestHash: jobCardCreateRequestHash(input),
        },
        async (transaction) => {
        const lockedAssignees = await this.lockUsersInOrder(
          transaction,
          actor.organizationId,
          [input.assignedTo],
        );
        const assignee = this.requiredLockedAssignee(lockedAssignees, input.assignedTo);
        assertCanCreateForAssignee(actor, assignee);
        await this.validateJobReferences(transaction, actor.organizationId, input.customerId, input.contactId);
        // WORKING-DAY contract reconciliation: the organization-local Sunday is
        // a SYSTEM / AUTOMATIC scheduling constraint only. A human explicitly
        // choosing a Sunday time is honoured verbatim and never silently moved,
        // so no working-day guard runs on this write path.
        const frequencyAdvisory = await this.assessCustomerSchedule(transaction, actor, {
          customerId: input.customerId,
          proposedAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          jobType: input.type,
          assignedTo: input.assignedTo,
          engagementKind: input.type === 'SALES_MEETING' ? input.engagementKind : null,
        });
        if (this.calendar.enabled
          && (input.type === 'SALES_MEETING' || input.type === 'PRODUCT_DELIVERY')
          && input.scheduledAt && canonicalEnd) {
          await transaction.assertCalendarAvailability({
            organizationId: actor.organizationId,
            jobCardId: null,
            assignedUserId: input.assignedTo,
            startsAt: input.scheduledAt,
            endsAt: canonicalEnd,
          });
        }
        const selfAccepted = actor.role === 'STAFF' && actor.id === input.assignedTo;
        const engagementKind = input.type === 'SALES_MEETING' ? input.engagementKind : null;
        const job = await transaction.createJobCard({
          organizationId: actor.organizationId, type: input.type,
          status: selfAccepted ? 'ACCEPTED' : 'NEW',
          title,
          description: input.description?.trim() || null, customerId: input.customerId,
          contactId: input.contactId,
          assignedTo: input.assignedTo, createdBy: actor.id, priority,
          dueDate: input.dueDate,
          scheduledAt: input.scheduledAt,
          scheduledEndsAt: canonicalEnd,
          engagementKind,
          acceptedAt: selfAccepted ? requestTime : null,
          acceptedBy: selfAccepted ? actor.id : null,
          sourceJobCardId: null,
          followUpInstructions: null,
          historySource: 'CREATE',
          historyRecordedAt: requestTime,
        });
        if (this.calendar.enabled) {
          await transaction.synchronizeCalendarReminder({
            organizationId: actor.organizationId,
            jobCardId: job.id,
            assignedUserId: job.assignedTo,
            startsAt: job.scheduledAt,
            endsAt: job.scheduledEndsAt,
            version: job.version,
            active: true,
            now: requestTime,
            reminderLeadMinutes: this.calendar.reminderLeadMinutes,
          });
        }
        if (input.type === 'SALES_MEETING') {
          await transaction.createMeetingDetails({
            organizationId: actor.organizationId,
            jobCardId: job.id,
          });
        }
        const createdValue: Record<string, unknown> = {
          status: job.status, assignedTo: job.assignedTo, version: job.version,
        };
        if (selfAccepted) {
          createdValue.acceptedAt = requestTime.toISOString();
          createdValue.acceptedBy = actor.id;
        }
        if (job.scheduledAt !== null) createdValue.scheduledAt = job.scheduledAt;
        if (job.engagementKind !== null) createdValue.engagementKind = job.engagementKind;
        const activity = await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
          event: 'JOB_CREATED', clientActionId: input.clientActionId,
          newValue: createdValue,
          metadata: frequencyAdvisory !== null
            ? { customerFrequencyAdvisory: frequencyAdvisory }
            : undefined,
        });
        const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
          activity,
          organizationId: actor.organizationId,
          jobCardId: job.id,
          actorUserId: actor.id,
          event: 'JOB_CREATED',
          beforeAssigneeId: null,
          afterAssigneeId: job.assignedTo,
          calendarAffected: this.calendar.enabled && job.scheduledAt !== null,
          customerId: job.customerId,
        });
        return {
          response: { jobCardId: job.id },
          realtimeEvents,
        };
        },
      );
    } catch (caught) {
      if (caught instanceof AppError) throw projectCalendarConflict(actor, caught);
      throw caught;
    }
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return this.detail(actor, decodeJobCardMutationReceipt(result.response).jobCardId);
  }

  /**
   * Canonical create-screen reference: the organization-local current
   * reporting week and its default due date. The date is derived from the
   * organization timezone, never from the browser's device clock, so a
   * staff member in a different zone still sees the organization's week.
   */
  async weeklyReportReference(actor: JobCardActor): Promise<WeeklyReportReference> {
    const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
    return currentWeeklyReportPeriod(this.now(), timezone);
  }

  /**
   * Single-target Weekly Report creation (V1 Slice 2). One transaction
   * atomically produces the JobCard and its WeeklyReport row — never one
   * without the other. STAFF self-creates (ACCEPTED with canonical accepted
   * evidence, mirroring generic self-create); MANAGER/ADMIN requests for
   * exactly one active STAFF (NEW). Idempotent via processed_actions with a
   * normalized-intent request hash.
   */
  async createWeeklyReport(
    actor: JobCardActor,
    input: WeeklyReportCreateInput,
  ): Promise<WeeklyReportCreateResult> {
    const selfCreate = actor.role === 'STAFF';
    let staffUserId: string;
    let questions: ManagerQuestion[];
    if (selfCreate) {
      if (input.assignedTo !== null && input.assignedTo !== actor.id) {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      if (input.questions !== undefined && input.questions !== null) {
        throw new AppError(
          'VALIDATION_ERROR', 400, 'Yönetici soruları personel kaydında yer alamaz.',
        );
      }
      staffUserId = actor.id;
      questions = [];
    } else {
      if (input.assignedTo === null) {
        throw new AppError(
          'VALIDATION_ERROR', 400, 'Haftalık rapor için sorumlu personel zorunludur.',
        );
      }
      staffUserId = input.assignedTo;
      questions = input.questions === undefined || input.questions === null
        ? []
        : validateManagerQuestions(input.questions);
    }
    // Deadline authority is SERVER-ONLY (field-test product decision): the
    // submission deadline is always the day after the report period ends — the
    // Monday following the Monday–Sunday period — via calendar-day arithmetic.
    // The public request shape carries no dueDate field at all (the parser
    // rejects one as an unknown field), so no caller, staff or manager, can
    // move their own or anyone's accountability deadline.
    const dueDate = addCalendarDaysToDateKey(input.periodEnd, 1);
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction<WeeklyReportCreateResult>(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'WEEKLY_REPORT_CREATE',
        requestHash: weeklyReportCreateRequestHash({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          assignedTo: staffUserId,
          questions,
          instructions: input.instructions,
        }),
      },
      async (transaction) => {
        const lockedAssignees = await this.lockUsersInOrder(
          transaction,
          actor.organizationId,
          [staffUserId],
        );
        const assignee = this.requiredLockedAssignee(lockedAssignees, staffUserId);
        assertCreateAssignmentRequest(actor, staffUserId);
        assertCanCreateForAssignee(actor, assignee);
        const outcome = await this.createOrResolveWeeklyReportForStaffCore(transaction, actor, {
          staffUserId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueDate,
          questions,
          instructions: input.instructions,
          selfCreate,
          clientActionId: input.clientActionId,
          requestTime,
        });
        // Single-create semantics are preserved: an existing canonical report
        // is a deterministic conflict with navigation metadata, never a
        // silent convergence (bulk owns the `existing` outcome).
        if (outcome.outcome === 'existing') {
          throw weeklyReportAlreadyExists(
            outcome.reportId, outcome.jobCardId, input.periodStart,
          );
        }
        return {
          response: {
            jobCardId: outcome.jobCardId,
            reportId: outcome.reportId,
            staffUserId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            status: outcome.jobStatus,
            dueDate,
          },
          realtimeEvents: outcome.realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return result.response;
  }

  /**
   * Transaction-level WeeklyReport creation core shared by single create and
   * bulk request. One call produces the JobCard AND its WeeklyReport row
   * atomically — never one without the other.
   *
   * Preconditions owned by the caller (identical for every command that uses
   * this primitive): the target user lock is already held via
   * `lockUsersInOrder` and assignability has been asserted. Under that lock
   * the staff/week pre-check is authoritative, because every writer of
   * `weekly_reports` acquires the same user row first. A hit therefore
   * returns `existing` WITHOUT creating a JobCard, so a losing create can
   * never leave an orphaned JobCard behind.
   *
   * The report insert defers duplicate identity to the database unique
   * constraint (`DO NOTHING`), so no raw 23505 ever escapes and the caller
   * decides the meaning of a lost identity race.
   */
  private async createOrResolveWeeklyReportForStaffCore(
    transaction: JobCardTransaction,
    actor: JobCardActor,
    input: {
      staffUserId: string;
      periodStart: string;
      periodEnd: string;
      dueDate: string;
      questions: ManagerQuestion[];
      instructions: string | null;
      selfCreate: boolean;
      clientActionId: string;
      requestTime: Date;
    },
  ): Promise<WeeklyReportCreationOutcome> {
    const existing = await transaction.getWeeklyReportByStaffWeek(
      actor.organizationId, input.staffUserId, input.periodStart,
    );
    if (existing) {
      return {
        outcome: 'existing',
        jobCardId: existing.job_card_id,
        reportId: existing.id,
      };
    }
    const job = await transaction.createJobCard({
      organizationId: actor.organizationId, type: 'WEEKLY_REPORT',
      status: input.selfCreate ? 'ACCEPTED' : 'NEW',
      title: weeklyReportTitle(input.periodStart, input.periodEnd),
      description: input.instructions, customerId: null,
      contactId: null,
      assignedTo: input.staffUserId, createdBy: actor.id, priority: 'normal',
      dueDate: input.dueDate,
      scheduledAt: null,
      scheduledEndsAt: null,
      engagementKind: null,
      acceptedAt: input.selfCreate ? input.requestTime : null,
      acceptedBy: input.selfCreate ? actor.id : null,
      sourceJobCardId: null,
      followUpInstructions: null,
      historySource: 'CREATE',
      historyRecordedAt: input.requestTime,
    });
    const report = await transaction.insertWeeklyReportRow({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      staffUserId: input.staffUserId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      questions: input.questions,
    });
    if (!report) {
      // The staff/week identity was taken after the locked pre-check. Every
      // production writer takes the same user lock first, so this is
      // unreachable; fail closed as a domain conflict so the whole
      // transaction rolls back (no partial commit, no orphaned JobCard, no
      // raw constraint name in the response).
      const winner = await transaction.getWeeklyReportByStaffWeek(
        actor.organizationId, input.staffUserId, input.periodStart,
      );
      if (winner) {
        throw weeklyReportAlreadyExists(winner.id, winner.job_card_id, input.periodStart);
      }
      throw new AppError(
        'WEEKLY_REPORT_CREATION_CONFLICT',
        409,
        'Haftalık rapor oluşturulamadı; eşzamanlı bir işlem aynı raporu oluşturdu.',
      );
    }
    const createdValue: Record<string, unknown> = {
      status: job.status, assignedTo: job.assignedTo, version: job.version,
    };
    if (input.selfCreate) {
      createdValue.acceptedAt = input.requestTime.toISOString();
      createdValue.acceptedBy = actor.id;
    }
    const activity = await transaction.appendActivity({
      organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
      event: 'JOB_CREATED', clientActionId: input.clientActionId,
      newValue: createdValue,
      metadata: { periodStart: input.periodStart, periodEnd: input.periodEnd },
    });
    const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
      activity,
      organizationId: actor.organizationId,
      jobCardId: job.id,
      actorUserId: actor.id,
      event: 'JOB_CREATED',
      beforeAssigneeId: null,
      afterAssigneeId: job.assignedTo,
      calendarAffected: false,
      customerId: null,
    });
    return {
      outcome: 'created',
      jobCardId: job.id,
      reportId: report.id,
      jobStatus: job.status,
      realtimeEvents,
    };
  }

  /**
   * Slice 5 recurrence occurrence creation. This is a deliberate, minimal
   * exposure of the canonical primitive above — NOT a second implementation.
   *
   * The recurrence worker owns its own transaction (the recurrence row, the
   * staff lock, the report and the schedule advance must commit together), so
   * it supplies the transaction and the already-held staff lock exactly like
   * the single-create and bulk-request callers do. Behaviour is identical:
   * a locked pre-check hit returns `existing` without creating a JobCard, the
   * report insert defers duplicate identity to the database unique constraint,
   * and a newly created report is a manager-requested JobCard (`NEW`,
   * `createdBy` = the supplied actor id, JOB_CREATED activity + realtime).
   *
   * `selfCreate` is always false: a recurrence is a manager-authorized request,
   * so the generated report must never be pre-accepted on the staff's behalf.
   */
  async createOrResolveWeeklyReportForStaff(
    transaction: JobCardTransaction,
    actor: JobCardActor,
    input: {
      staffUserId: string;
      periodStart: string;
      periodEnd: string;
      dueDate: string;
      questions: ManagerQuestion[];
      instructions: string | null;
      clientActionId: string;
      requestTime: Date;
    },
  ): Promise<WeeklyReportCreationOutcome> {
    return this.createOrResolveWeeklyReportForStaffCore(transaction, actor, {
      ...input,
      selfCreate: false,
    });
  }

  /**
   * Manager/ADMIN bulk request (V1 Slice 3): the same reporting week requested
   * for many staff in ONE logical command, producing N INDEPENDENT WeeklyReport
   * JobCards — never a shared multi-assignee report. Each report therefore has
   * its own JobCard id, report id, lifecycle, acceptance, due date, overdue
   * accountability, draft, submissions, revision history and approval.
   *
   * Atomicity: one transaction and one receipt. For valid targets the command
   * is all-or-nothing — a real validation, authorization or infrastructure
   * failure rolls back every JobCard and report created so far, so no partial
   * result can commit.
   *
   * Duplicate convergence is NOT a command failure: an already canonical
   * report for (staff, period) is reported as `existing` with its own ids, and
   * the remaining targets still commit.
   */
  async bulkRequestWeeklyReports(
    actor: JobCardActor,
    input: WeeklyReportBulkRequestInput,
  ): Promise<WeeklyReportBulkRequestResult> {
    // STAFF has no bulk surface at all: there is no self-create path on this
    // endpoint, so the guard is a role check, not a target filter.
    if (actor.role === 'STAFF') {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    const staffUserIds = input.staffUserIds;
    const questions = input.questions === undefined || input.questions === null
      ? []
      : validateManagerQuestions(input.questions);
    // Same server-only deadline authority as the single create: the canonical
    // Monday after the period, derived from calendar-day arithmetic.
    const dueDate = addCalendarDaysToDateKey(input.periodEnd, 1);
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction<WeeklyReportBulkRequestResult>(
      {
        organizationId: actor.organizationId, userId: actor.id,
        clientActionId: input.clientActionId, operationKey: 'WEEKLY_REPORT_BULK_REQUEST',
        requestHash: weeklyReportBulkRequestHash({
          staffUserIds,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          questions,
          instructions: input.instructions,
        }),
      },
      async (transaction) => {
        // 1. Lock EVERY target in one deterministic order (`lockUsersInOrder`
        //    sorts, and the parser lowercased the ids so text order equals
        //    uuid byte order). Concurrent bulks, single creates and staff
        //    self-creates all serialize here, so exactly one canonical report
        //    per staff/week can ever be created.
        const lockedAssignees = await this.lockUsersInOrder(
          transaction,
          actor.organizationId,
          staffUserIds,
        );
        // 2. Validate ALL targets before creating ANY: an invalid target 40
        //    must be reported without target 1 having been written.
        for (const staffUserId of staffUserIds) {
          const assignee = this.requiredLockedAssignee(lockedAssignees, staffUserId);
          assertCreateAssignmentRequest(actor, staffUserId);
          assertCanCreateForAssignee(actor, assignee);
        }
        // 3. Resolve-or-create in request order. A target whose report already
        //    exists converges to `existing` without emitting a fake creation.
        const items: WeeklyReportBulkRequestResult['items'] = [];
        const realtimeEvents: RealtimeEventRecord[] = [];
        for (const staffUserId of staffUserIds) {
          const outcome = await this.createOrResolveWeeklyReportForStaffCore(transaction, actor, {
            staffUserId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            dueDate,
            questions,
            instructions: input.instructions,
            selfCreate: false,
            clientActionId: input.clientActionId,
            requestTime,
          });
          items.push({
            staffUserId,
            jobCardId: outcome.jobCardId,
            reportId: outcome.reportId,
            outcome: outcome.outcome,
          });
          if (outcome.outcome === 'created') realtimeEvents.push(...outcome.realtimeEvents);
        }
        return {
          response: {
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            dueDate,
            items,
          },
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return result.response;
  }

  /**
   * Weekly report read context: owning JobCard plus its report row. Same
   * visibility as the generic detail — cross-tenant and non-owner STAFF
   * reads are concealed as not-found; managers read their organization.
   */
  private async loadWeeklyReportContext(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || job.type !== 'WEEKLY_REPORT'
      || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    const row = await this.repository.getWeeklyReportByJobId(actor.organizationId, jobCardId);
    if (!row) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    return { job, report: mapReport(row) };
  }

  async getWeeklyReport(actor: JobCardActor, jobCardId: string): Promise<WeeklyReportDetail> {
    const { job, report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const submissionRows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    let liveSourceWork: WeeklyReportDetail['liveSourceWork'] = [];
    if (job.status === 'ACCEPTED' || job.status === 'IN_PROGRESS') {
      const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
      const { weekStart, weekEnd } = weekInstants(report.periodStart, timezone);
      const rows = await this.repository.listWeeklySourceWorkSnapshot({
        organizationId: actor.organizationId,
        staffUserId: report.staffUserId,
        weekStart,
        weekEnd,
      });
      liveSourceWork = rows.map(mapSourceWorkRow);
    }
    return {
      ...report,
      jobStatus: job.status,
      jobVersion: job.version,
      dueDate: job.dueDate,
      assignedTo: job.assignedTo,
      instructions: job.description,
      liveSourceWork,
      submissionSummaries: submissionRows.map((row) => ({
        seqNo: row.seq_no,
        submittedAt: row.submitted_at.toISOString(),
        submittedBy: row.submitted_by,
      })),
    };
  }

  /**
   * Weekly draft write: owner STAFF only (managers read but never author),
   * editable in ACCEPTED/IN_PROGRESS, locked once awaiting approval or
   * beyond. Complete replacement semantics — the validated draft body
   * replaces all sections atomically, never sparse-merged.
   */
  async updateWeeklyReportDraft(
    actor: JobCardActor,
    jobCardId: string,
    input: { expectedVersion: number; draft: unknown; answers: unknown },
  ): Promise<WeeklyReportDetail> {
    const { job, report } = await this.loadWeeklyReportContext(actor, jobCardId);
    if (actor.role !== 'STAFF' || actor.id !== report.staffUserId) {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    if (job.status !== 'ACCEPTED' && job.status !== 'IN_PROGRESS') {
      throw new AppError(
        'WEEKLY_REPORT_DRAFT_LOCKED',
        409,
        'Rapor taslağı bu aşamada düzenlenemez.',
      );
    }
    const draft = validateDraftBody(input.draft);
    const answers = validateDraftAnswers(report.questions, input.answers);
    const updated = await this.repository.updateWeeklyReportDraftRow({
      organizationId: actor.organizationId,
      reportId: report.id,
      expectedVersion: input.expectedVersion,
      draft,
      answers,
    });
    if (!updated) {
      throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
    }
    return this.getWeeklyReport(actor, jobCardId);
  }

  async listWeeklyReportSubmissions(
    actor: JobCardActor,
    jobCardId: string,
  ): Promise<WeeklyReportSubmission[]> {
    const { report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const rows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    return rows.map(mapSubmission);
  }

  /**
   * Downloadable PDF for one immutable submission, selected by its explicit
   * frozen `seqNo`.
   *
   * The projection is built from that `weekly_report_submissions` row alone —
   * never the live draft, the live source-work list, the current JobCard body
   * or the current answers — so a later edit cannot change an already
   * downloaded version. The read is strictly read-only: no activity is
   * appended, the report version does not move, and no download record or
   * idempotency receipt is written.
   */
  async weeklyReportSubmissionPdf(
    actor: JobCardActor,
    jobCardId: string,
    seqNo: number,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const { report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const row = await this.repository.getWeeklyReportSubmissionBySeq(
      actor.organizationId, report.id, seqNo,
    );
    if (!row) {
      throw new AppError('WEEKLY_REPORT_SUBMISSION_NOT_FOUND', 404, 'Gönderim bulunamadı.');
    }
    const submission = mapSubmission(row);
    // The display name is presentation metadata, resolved live on purpose: it
    // is not frozen report content and must not force a schema change.
    const staffName = await this.repository.getUserDisplayName(
      actor.organizationId, submission.submittedBy,
    );
    const model = buildWeeklyReportPdfDocumentModel({
      submission,
      staffName: staffName ?? submission.submittedBy,
    });
    const buffer = await renderWeeklyReportPdf(model);
    return { fileName: weeklyReportPdfFileName(model.periodStart, model.seqNo), buffer };
  }

  /**
   * Freeze the persisted draft into an immutable submission row inside the
   * caller's SUBMIT_FOR_APPROVAL transaction. The caller holds the JobCard
   * lock and just appended the canonical submit activity; this method locks
   * the report row, re-validates the frozen payload, snapshots live
   * source-work and links the row to that exact activity id (F2: the id
   * comes from our own transition result — clients never supply it).
   * submittedAt is the shared request clock (F4), identical to the
   * staff_completed_at evidence written by the same transition.
   */
  private async appendWeeklyReportSubmission(
    tx: JobCardTransaction,
    input: {
      actor: JobCardActor;
      job: JobCard;
      activityId: string;
      occurredAt: Date;
      jobVersion: number;
    },
  ): Promise<void> {
    const { actor, job, activityId, occurredAt, jobVersion } = input;
    const row = await tx.getWeeklyReportByJobForUpdate(actor.organizationId, job.id);
    if (!row || row.staff_user_id !== actor.id) {
      throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    }
    const report = mapReport(row);
    const body = validateSubmissionBody(report.draft);
    const answers = validateSubmissionAnswers(report.questions, report.answers);
    const timezone = await tx.getOrganizationTimezone(actor.organizationId);
    const { weekStart, weekEnd } = weekInstants(report.periodStart, timezone);
    const sourceRows = await tx.listWeeklySourceWorkSnapshot({
      organizationId: actor.organizationId,
      staffUserId: actor.id,
      weekStart,
      weekEnd,
    });
    const sourceWork = validateSourceWorkSnapshot(sourceRows.map(mapSourceWorkRow));
    const seqNo = await tx.getNextWeeklyReportSubmissionSeqNo(actor.organizationId, report.id);
    await tx.insertWeeklyReportSubmissionRow({
      organizationId: actor.organizationId,
      weeklyReportId: report.id,
      jobCardId: job.id,
      seqNo,
      submittedBy: actor.id,
      submittedAt: occurredAt,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      body,
      questions: report.questions,
      answers,
      sourceWork,
      jobVersion,
      sourceActivityId: activityId,
    });
  }

  async createProductDelivery(actor: JobCardActor, input: ProductDeliveryCreateInput) {    const title = input.title.trim();
    if (input.type !== 'PRODUCT_DELIVERY'
      || !input.clientActionId.trim() || !title || !input.customerId
      || !input.assignedTo || !JOB_CARD_PRIORITIES.includes(input.priority)) {
      throw new AppError('VALIDATION_ERROR', 400, 'Ürün teslimi oluşturma bilgileri geçersiz.');
    }
    const canonicalEnd = input.scheduledAt
      ? canonicalScheduledEnd('PRODUCT_DELIVERY', input.scheduledAt)
      : null;
    if (!input.scheduledAt || canonicalEnd === null || input.scheduledEndsAt !== canonicalEnd) {
      throw new AppError('VALIDATION_ERROR', 400, 'Ürün teslimi oluşturma bilgileri geçersiz.');
    }
    assertInitialProductDeliveryItems(input);
    assertCreateAssignmentRequest(actor, input.assignedTo);
    const requestTime = this.now();
    let result: CriticalActionResult<{ jobCardId: string; version: number }>;
    try {
      result = await this.repository.executeCriticalAction(
        {
          organizationId: actor.organizationId, userId: actor.id,
          clientActionId: input.clientActionId, operationKey: 'PRODUCT_DELIVERY_CREATE',
          requestHash: productDeliveryCreateRequestHash(input),
        },
        async (transaction) => {
          const lockedAssignees = await this.lockUsersInOrder(
            transaction,
            actor.organizationId,
            [input.assignedTo],
          );
          const assignee = this.requiredLockedAssignee(lockedAssignees, input.assignedTo);
          assertCanCreateForAssignee(actor, assignee);
          await this.validateJobReferences(transaction, actor.organizationId, input.customerId, null);
          // WORKING-DAY contract reconciliation: a human PRODUCT_DELIVERY write
          // may land on the organization-local Sunday; no working-day guard.
          if (this.calendar.enabled) {
            await transaction.assertCalendarAvailability({
              organizationId: actor.organizationId,
              jobCardId: null,
              assignedUserId: input.assignedTo,
              startsAt: input.scheduledAt,
              endsAt: canonicalEnd,
            });
          }

          const products = [] as Array<{
            productId: string;
            quantity: number;
            product: ProductReference;
          }>;
          for (const item of input.items) {
            const product = await transaction.getProduct(actor.organizationId, item.productId);
            if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
            products.push({ ...item, product });
          }

          const selfAccepted = actor.role === 'STAFF' && actor.id === input.assignedTo;
          const job = await transaction.createJobCard({
            organizationId: actor.organizationId, type: 'PRODUCT_DELIVERY',
            status: selfAccepted ? 'ACCEPTED' : 'NEW', title,
            description: input.description?.trim() || null, customerId: input.customerId,
            contactId: null, assignedTo: input.assignedTo, createdBy: actor.id,
            priority: input.priority, dueDate: input.dueDate, scheduledAt: input.scheduledAt,
            scheduledEndsAt: canonicalEnd, engagementKind: null,
            acceptedAt: selfAccepted ? requestTime : null,
            acceptedBy: selfAccepted ? actor.id : null,
            sourceJobCardId: null, followUpInstructions: null,
            historySource: 'CREATE',
            historyRecordedAt: requestTime,
          });
          if (this.calendar.enabled) {
            await transaction.synchronizeCalendarReminder({
              organizationId: actor.organizationId, jobCardId: job.id,
              assignedUserId: job.assignedTo, startsAt: job.scheduledAt,
              endsAt: job.scheduledEndsAt, version: job.version, active: true,
              now: requestTime, reminderLeadMinutes: this.calendar.reminderLeadMinutes,
            });
          }
          const createdValue: Record<string, unknown> = {
            status: job.status, assignedTo: job.assignedTo, version: job.version,
          };
          if (selfAccepted) {
            createdValue.acceptedAt = requestTime.toISOString();
            createdValue.acceptedBy = actor.id;
          }
          if (job.scheduledAt !== null) createdValue.scheduledAt = job.scheduledAt;
          const activity = await transaction.appendActivity({
            organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
            event: 'JOB_CREATED', clientActionId: input.clientActionId,
            newValue: createdValue,
          });
          const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
            activity, organizationId: actor.organizationId, jobCardId: job.id,
            actorUserId: actor.id, event: 'JOB_CREATED', beforeAssigneeId: null,
            afterAssigneeId: job.assignedTo,
            calendarAffected: this.calendar.enabled && job.scheduledAt !== null,
            customerId: job.customerId,
          });

          let version = job.version;
          for (const entry of products) {
            const item = await transaction.createDeliveryItem(deliveryRecord(
              actor.organizationId,
              job.id,
              {
                expectedVersion: version,
                productId: entry.productId,
                deliveryPurpose: input.deliveryPurpose,
                deliveredAt: null,
                quantity: entry.quantity,
                deliveryNote: input.deliveryNote,
              },
              entry.product,
            ));
            const updated = await transaction.bumpVersion(actor.organizationId, job.id, version);
            if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
            version = updated.version;
            await transaction.appendActivity({
              organizationId: actor.organizationId, jobCardId: job.id, actorId: actor.id,
              event: 'DELIVERY_ITEM_ADDED', clientActionId: input.clientActionId,
              newValue: {
                itemId: item.id, productId: item.productId,
                deliveryPurpose: item.deliveryPurpose, quantity: item.quantity,
                deliveredAt: null,
              },
            });
          }
          return { response: { jobCardId: job.id, version }, realtimeEvents };
        },
      );
    } catch (caught) {
      if (caught instanceof AppError) throw projectCalendarConflict(actor, caught);
      throw caught;
    }
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  async createFollowUp(
    actor: JobCardActor,
    sourceJobCardId: string,
    input: FollowUpCreateInput,
  ) {
    if (input.type === 'PRODUCT_DELIVERY' && input.contactId !== null) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Ürün teslimi oluştururken ilgili kişi seçilemez.',
      );
    }
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction<FollowUpCreateReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: `JOB_FOLLOW_UP_CREATE:${sourceJobCardId}`,
        requestHash: followUpCreateRequestHash(sourceJobCardId, input),
      },
      async (transaction) => {
        assertCanCreateFollowUp(actor);
        const sourceSnapshot = await transaction.getFollowUpSource(
          actor.organizationId,
          sourceJobCardId,
          false,
        );
        if (!sourceSnapshot) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        const lockedAssignees = await this.lockUsersInOrder(
          transaction,
          actor.organizationId,
          [sourceSnapshot.assignedTo, input.assignedTo],
        );
        const source = await transaction.getFollowUpSource(
          actor.organizationId,
          sourceJobCardId,
          true,
        );
        if (!source) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertFollowUpSourceEligible(source);
        if (input.scheduledAt !== null) {
          assertFollowUpMinimumLead({
            meetingAt: source.meetingAt,
            requestTime,
            scheduledAt: new Date(input.scheduledAt),
          });
        }
        // Server-authoritative DEMO provenance: a follow-up created from a DEMO
        // source inherits the source dataset directly (never from client input).
        await this.assertFollowUpDepth(transaction, source);

        const lockedAssignee = lockedAssignees.get(input.assignedTo) ?? null;
        if (source.customerId === null) {
          if (input.contactId !== null) {
            throw new AppError(
              'FOLLOW_UP_CONTACT_REQUIRES_CUSTOMER',
              409,
              'Müşterisiz takip işinde ilgili kişi seçilemez.',
            );
          }
          if (input.type !== 'GENERAL_TASK') {
            throw new AppError(
              'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED',
              409,
              'Bu takip işi türü için kaynak JobCard müşteriye bağlı olmalıdır.',
            );
          }
        } else {
          // The source User and child User were locked before the source
          // JobCard; Customer validation therefore follows User -> JobCard ->
          // Customer without changing the existing validation contract.
          await this.validateJobReferences(
            transaction,
            actor.organizationId,
            source.customerId,
            input.contactId,
          );
        }

        const childDataClass: 'BUSINESS' | 'DEMO' =
          source.dataClass === 'DEMO' && source.demoDatasetId ? 'DEMO' : 'BUSINESS';
        const childDemoDatasetId: string | null =
          childDataClass === 'DEMO' ? source.demoDatasetId : null;
        const { job, realtimeEvents } = await this.createFollowUpChild(transaction, actor, {
          sourceJobCardId,
          customerId: source.customerId,
          type: input.type,
          title: input.title,
          followUpInstructions: input.followUpInstructions,
          scheduledAt: input.scheduledAt,
          assignedTo: input.assignedTo,
          priority: input.priority,
          dueDate: input.dueDate,
          contactId: input.contactId,
          assignee: lockedAssignee,
          engagementKind: input.type === 'SALES_MEETING' ? input.engagementKind : null,
          clientActionId: input.clientActionId,
          requestTime,
          dataClass: childDataClass,
          demoDatasetId: childDemoDatasetId,
          activityMetadata: {
            sourceJobCardId,
          },
        });
        return { response: { jobCardId: job.id }, realtimeEvents };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return this.detail(actor, result.response.jobCardId);
  }

  /**
   * Shared linked-child creation used by both the post-hoc follow-up flow and
   * the unified approval flow. Runs fully inside the caller's transaction and
   * emits exactly one JOB_CREATED activity + realtime event for the child.
   */
  private async createFollowUpChild(
    transaction: JobCardTransaction,
    actor: JobCardActor,
    input: {
      sourceJobCardId: string;
      customerId: string | null;
      type: JobCardType;
      title: string;
      followUpInstructions: string;
      scheduledAt: string | null;
      assignedTo: string;
      priority: JobCardPriority;
      dueDate: string | null;
      contactId: string | null;
      assignee: JobCardAssignee | null;
      engagementKind: JobCardEngagementKind | null;
      clientActionId: string;
      requestTime: Date;
      dataClass?: 'BUSINESS' | 'DEMO';
      demoDatasetId?: string | null;
      acceptance?: {
        acceptedAt: Date;
        acceptedBy: string;
      };
      activityMetadata?: Record<string, unknown>;
    },
  ): Promise<{ job: JobCard; realtimeEvents: RealtimeEventRecord[] }> {
    const assignee = input.assignee;
    if (!assignee) {
      throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    }
    assertCanCreateForAssignee(actor, assignee);

    const scheduledEndsAt = input.scheduledAt === null
      ? null
      : canonicalScheduledEnd(input.type, input.scheduledAt);
    if (input.type !== 'GENERAL_TASK' && (input.scheduledAt === null || scheduledEndsAt === null)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Planlanan başlangıç zamanı bu iş türü için zorunludur.',
      );
    }
    // WORKING-DAY contract reconciliation: both manual follow-up creation and
    // the approved-proposal child creation flow through here. A human-supplied
    // organization-local Sunday schedule is honoured verbatim rather than
    // rejected or silently moved. The automatic scheduler still yields only
    // working-day slots, so an approved SYSTEM proposal arrives here already
    // valid — the automatic guarantee lives in the candidate generation, not in
    // this human write path.
    const frequencyAdvisory = await this.assessCustomerSchedule(transaction, actor, {
      customerId: input.customerId, jobType: input.type,
      proposedAt: input.scheduledAt === null ? null : new Date(input.scheduledAt),
      scheduledEndsAt, assignedTo: input.assignedTo, engagementKind: input.engagementKind,
    });
    if (this.calendar.enabled && input.scheduledAt !== null && scheduledEndsAt !== null) {
      try {
        await transaction.assertCalendarAvailability({
          organizationId: actor.organizationId,
          jobCardId: null,
          assignedUserId: input.assignedTo,
          startsAt: input.scheduledAt,
          endsAt: scheduledEndsAt,
        });
      } catch (caught) {
        if (caught instanceof AppError) throw projectCalendarConflict(actor, caught);
        throw caught;
      }
    }

    const job = await transaction.createJobCard({
      organizationId: actor.organizationId,
      type: input.type,
      status: input.acceptance ? 'ACCEPTED' : 'NEW',
      title: input.title,
      description: null,
      customerId: input.customerId,
      contactId: input.contactId,
      assignedTo: input.assignedTo,
      createdBy: actor.id,
      priority: input.priority,
      dueDate: input.dueDate,
      scheduledAt: input.scheduledAt,
      scheduledEndsAt,
      engagementKind: input.engagementKind,
      acceptedAt: input.acceptance?.acceptedAt ?? null,
      acceptedBy: input.acceptance?.acceptedBy ?? null,
      sourceJobCardId: input.sourceJobCardId,
      followUpInstructions: input.followUpInstructions,
      historySource: 'FOLLOW_UP_CREATE',
      historyRecordedAt: input.requestTime,
      ...(input.dataClass ? { dataClass: input.dataClass, demoDatasetId: input.demoDatasetId ?? null } : {}),
    });
    if (this.calendar.enabled) {
      await transaction.synchronizeCalendarReminder({
        organizationId: actor.organizationId,
        jobCardId: job.id,
        assignedUserId: job.assignedTo,
        startsAt: job.scheduledAt,
        endsAt: job.scheduledEndsAt,
        version: job.version,
        active: true,
        now: input.requestTime,
        reminderLeadMinutes: this.calendar.reminderLeadMinutes,
      });
    }
    if (input.type === 'SALES_MEETING') {
      await transaction.createMeetingDetails({
        organizationId: actor.organizationId,
        jobCardId: job.id,
      });
    }
    const createdValue: Record<string, unknown> = {
      status: job.status,
      assignedTo: job.assignedTo,
      version: job.version,
    };
    if (input.acceptance) {
      createdValue.acceptedAt = input.acceptance.acceptedAt.toISOString();
      createdValue.acceptedBy = input.acceptance.acceptedBy;
    }
    if (job.scheduledAt !== null) createdValue.scheduledAt = job.scheduledAt;
    if (job.engagementKind !== null) createdValue.engagementKind = job.engagementKind;
    const activity = await transaction.appendActivity({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      actorId: actor.id,
      event: 'JOB_CREATED',
      clientActionId: input.clientActionId,
      newValue: createdValue,
      metadata: {
        sourceJobCardId: input.sourceJobCardId, ...input.activityMetadata,
        ...(frequencyAdvisory ? { customerFrequencyAdvisory: frequencyAdvisory } : {}),
      },
    });
    const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
      activity,
      organizationId: actor.organizationId,
      jobCardId: job.id,
      actorUserId: actor.id,
      event: 'JOB_CREATED',
      beforeAssigneeId: null,
      afterAssigneeId: job.assignedTo,
      calendarAffected: this.calendar.enabled && job.scheduledAt !== null,
      sourceJobCardId: input.sourceJobCardId,
      customerId: input.customerId,
    });
    return { job, realtimeEvents };
  }

  async listFollowUps(
    actor: JobCardActor,
    sourceJobCardId: string,
    page: PageQuery,
  ): Promise<PaginatedFollowUpList> {
    assertCanListFollowUps(actor);
    const source = await this.repository.findJobCard(actor.organizationId, sourceJobCardId);
    if (!source) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    const evaluatedAt = this.now();
    const result = await this.repository.listFollowUps(
      actor.organizationId,
      sourceJobCardId,
      page,
    );
    return {
      ...result,
      items: result.items.map((item) => this.presentFollowUpListItem(actor, item, evaluatedAt)),
    };
  }

  async list(actor: JobCardActor, query: JobCardListQuery) {
    if (actor.role === 'STAFF' && query.assignedTo !== null && query.assignedTo !== actor.id) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset };
    }
    const evaluatedAt = this.now();
    const page = await this.repository.listJobCards(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
      evaluatedAt,
    );
    return {
      ...page,
      items: page.items.map((item) => this.presentListItem(actor, item, evaluatedAt)),
    };
  }

  async board(actor: JobCardActor, query: JobCardBoardQuery): Promise<JobCardBoard> {
    if (actor.role === 'STAFF' && query.assignedTo !== null && query.assignedTo !== actor.id) {
      return {
        columns: {
          NEW: { items: [], count: 0 },
          ACCEPTED: { items: [], count: 0 },
          IN_PROGRESS: { items: [], count: 0 },
          WAITING_APPROVAL: { items: [], count: 0 },
          REVISION_REQUESTED: { items: [], count: 0 },
        },
        closedCounts: { COMPLETED: 0, CANCELLED: 0 },
      };
    }
    const evaluatedAt = this.now();
    const board = await this.repository.listBoard(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
    );
    const presentColumn = (column: { items: PersistedJobCardListItem[]; count: number }) => ({
      count: column.count,
      items: column.items.map((item) => this.presentListItem(actor, item, evaluatedAt)),
    });
    return {
      columns: {
        NEW: presentColumn(board.columns.NEW),
        ACCEPTED: presentColumn(board.columns.ACCEPTED),
        IN_PROGRESS: presentColumn(board.columns.IN_PROGRESS),
        WAITING_APPROVAL: presentColumn(board.columns.WAITING_APPROVAL),
        REVISION_REQUESTED: presentColumn(board.columns.REVISION_REQUESTED),
      },
      closedCounts: board.closedCounts,
    };
  }

  async detail(actor: JobCardActor, jobCardId: string) {
    return this.detailAt(actor, jobCardId, this.now());
  }

  private async detailAt(actor: JobCardActor, jobCardId: string, evaluatedAt: Date) {
    const job = await this.repository.findJobCardDetail(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    return this.presentDetail(this.repository, actor, job, evaluatedAt);
  }

  async getMeetingDetails(actor: JobCardActor, jobCardId: string) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    assertSalesMeetingJob(job);
    assertCanViewMeetingResult(actor, job);
    const details = await this.repository.findMeetingDetails(actor.organizationId, jobCardId);
    if (!details) invariantViolation();
    return meetingDetailsResponse(jobCardId, job.version, details);
  }

  async patchMeetingDetails(
    actor: JobCardActor,
    jobCardId: string,
    input: PatchMeetingDetailsInput,
  ) {
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    if (!MEETING_DETAIL_FIELDS.some((field) => Object.hasOwn(input, field))) {
      throw validation('body');
    }
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey: `MEETING_DETAILS_UPDATE:${jobCardId}`,
        requestHash: meetingDetailsUpdateRequestHash(jobCardId, input),
      },
      async (transaction) => {
        const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertSalesMeetingJob(job);
        if (job.version !== input.expectedVersion) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        assertCanEditMeetingResult(actor, job);
        const current = await transaction.getSubmissionMeetingDetails(
          actor.organizationId,
          jobCardId,
        );
        if (!current) invariantViolation();
        const outcome = input.outcome === undefined ? current.outcome : input.outcome;
        const candidate: MeetingDetailsCandidate = {
          meetingAt: input.meetingAt === undefined ? current.meetingAt : input.meetingAt,
          outcome,
          unsuccessfulReason: input.unsuccessfulReason === undefined
            ? input.outcome !== undefined && input.outcome !== 'FOLLOW_UP_REQUIRED'
              ? null
              : current.unsuccessfulReason ?? null
            : input.unsuccessfulReason,
          meetingSummary: input.meetingSummary === undefined
            ? current.meetingSummary
            : input.meetingSummary,
          nextFollowUpAt: input.nextFollowUpAt === undefined
            ? current.nextFollowUpAt
            : input.nextFollowUpAt,
        };
        // Validate the merged post-patch state so a partial update cannot
        // persist FOLLOW_UP_REQUIRED without its structured unsuccessful reason.
        validateMeetingDetailsCandidate(candidate, { requireUnsuccessfulReason: true });
        const changedFields = MEETING_DETAIL_FIELDS.filter((field) => (
          Object.hasOwn(input, field)
          || (field === 'unsuccessfulReason' && Object.hasOwn(input, 'outcome'))
        ) && candidate[field] !== current[field]);
        if (changedFields.length === 0) {
          throw new AppError(
            'MEETING_DETAILS_UNCHANGED',
            400,
            'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
          );
        }
        await transaction.updateMeetingDetails({
          organizationId: actor.organizationId,
          jobCardId,
          ...candidate,
        });
        const updated = await transaction.bumpVersion(
          actor.organizationId,
          jobCardId,
          input.expectedVersion,
        );
        if (!updated) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        const activity = await transaction.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'MEETING_DETAILS_UPDATED',
          clientActionId,
          metadata: { changedFields },
        });
        const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'MEETING_DETAILS_UPDATED',
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: job.assignedTo,
        });
        return {
          response: meetingDetailsResponse(jobCardId, updated.version, candidate),
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') {
      this.publishRealtime(result.realtimeEvents);
    }
    return result.response;
  }

  async patch(actor: JobCardActor, jobCardId: string, input: PatchInput) {
    assertKnownFields(input, JOB_CARD_PATCH_FIELDS);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError('VALIDATION_ERROR', 400, 'expectedVersion pozitif bir tam sayı olmalıdır.');
    }
    const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedVersion')) as Omit<PatchInput, 'expectedVersion'> & {
      status?: JobCardStatus;
      clearAcceptance?: boolean;
    };
    delete fields.overrideReason;
    if (Object.keys(fields).length === 0 || (fields.title !== undefined && !fields.title.trim()) ||
      (fields.priority !== undefined && !JOB_CARD_PRIORITIES.includes(fields.priority))) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard güncelleme bilgileri geçersiz.');
    }
    if (fields.title !== undefined) fields.title = fields.title.trim();
    if (fields.description !== undefined) fields.description = fields.description?.trim() || null;
    if (fields.scheduledAt !== undefined && fields.scheduledAt !== null) {
      fields.scheduledAt = isoInstant(fields.scheduledAt, 'scheduledAt');
    }
    if (fields.scheduledEndsAt !== undefined && fields.scheduledEndsAt !== null) {
      fields.scheduledEndsAt = isoInstant(fields.scheduledEndsAt, 'scheduledEndsAt');
    }
    if (fields.engagementKind !== undefined
      && !JOB_CARD_ENGAGEMENT_KINDS.includes(fields.engagementKind)) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard güncelleme bilgileri geçersiz.');
    }

    const requestTime = this.now();
    return this.repository.executeTransaction(async (transaction) => {
      const snapshot = await transaction.getJob(actor.organizationId, jobCardId);
      if (!snapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (snapshot.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      if (snapshot.sourceJobCardId != null && fields.customerId !== undefined) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'Takip işinin kaynak müşterisi değiştirilemez.',
        );
      }
      if (fields.engagementKind !== undefined && snapshot.type !== 'SALES_MEETING') {
        throw new AppError('VALIDATION_ERROR', 400, 'JobCard güncelleme bilgileri geçersiz.');
      }
      assertCanEdit(actor, snapshot);
      const snapshotIsCalendarIntervalJob = snapshot.type === 'SALES_MEETING'
        || snapshot.type === 'PRODUCT_DELIVERY';
      const snapshotScheduleChanged = fields.scheduledAt !== undefined
        && fields.scheduledAt !== snapshot.scheduledAt
        || fields.scheduledEndsAt !== undefined
        && fields.scheduledEndsAt !== (snapshot.scheduledEndsAt ?? null);
      const snapshotAssigneeChanged = fields.assignedTo !== undefined
        && fields.assignedTo !== snapshot.assignedTo;
      // R1 compatibility prediction (lock planning only): a start-only patch
      // on an interval job without a persisted end will derive a canonical end
      // after the row lock, producing an effective schedule mutation even when
      // the raw request start equals the persisted start (same-start Save).
      // Predict that repair here so the assignee lock covers the effective
      // mutation. The authoritative end is still derived from the locked row.
      const snapshotNeedsIntervalRepair = snapshotIsCalendarIntervalJob
        && fields.scheduledAt !== undefined
        && fields.scheduledAt !== null
        && fields.scheduledEndsAt === undefined
        && (snapshot.scheduledEndsAt ?? null) === null;
      const snapshotEffectiveScheduleMutation = snapshotScheduleChanged
        || snapshotNeedsIntervalRepair;
      const snapshotNeedsAssigneeLock = snapshotAssigneeChanged
        || (this.calendar.enabled && snapshotIsCalendarIntervalJob && snapshotEffectiveScheduleMutation);
      const lockedAssignees = snapshotNeedsAssigneeLock
        ? await this.lockUsersInOrder(
          transaction,
          actor.organizationId,
          [snapshot.assignedTo, fields.assignedTo],
        )
        : new Map<string, JobCardAssignee>();
      const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (job.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      assertCanEdit(actor, job);

      if (job.type === 'PRODUCT_DELIVERY'
        && fields.contactId !== undefined
        && fields.contactId !== null) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'Ürün teslimine yeni ilgili kişi eklenemez.',
        );
      }

      // Weekly Report authority (V1 Slice 2 remediation): the report's
      // identity and deadline belong to the manager request (or the
      // canonical server default); the assigned STAFF authors only the
      // report draft through the dedicated weekly endpoints. The
      // customerless / unscheduled contract is enforced for every actor so
      // a weekly report can never be attached to a customer or a calendar
      // interval.
      if (job.type === 'WEEKLY_REPORT') {
        const customerScoped = fields.customerId !== undefined && fields.customerId !== job.customerId
          || fields.contactId !== undefined && fields.contactId !== job.contactId
          || fields.scheduledAt !== undefined && fields.scheduledAt !== (job.scheduledAt ?? null)
          || fields.scheduledEndsAt !== undefined
            && fields.scheduledEndsAt !== (job.scheduledEndsAt ?? null);
        if (customerScoped) {
          throw new AppError(
            'VALIDATION_ERROR',
            400,
            'Haftalık rapor müşteriye veya zaman planına bağlanamaz.',
          );
        }
        if (actor.role === 'STAFF') {
          const staffOwned = fields.title !== undefined && fields.title !== job.title
            || fields.description !== undefined && fields.description !== job.description
            || fields.assignedTo !== undefined && fields.assignedTo !== job.assignedTo
            || fields.dueDate !== undefined && fields.dueDate !== (job.dueDate ?? null);
          if (staffOwned) {
            throw new AppError(
              'FORBIDDEN',
              403,
              'Haftalık raporun talep alanları personel tarafından düzenlenemez.',
            );
          }
        }
        // Deadline immutability (field-test product authority, extended to
        // every actor): the submission deadline is server-canonical
        // (periodEnd + 1) at creation AND stays tied to the immutable report
        // period afterwards — a MANAGER/ADMIN can no longer reschedule it
        // through the generic patch either. Same-value patches fall through
        // to the ordinary change-scoped machinery (a no-op); a CHANGED
        // dueDate is rejected for every role (STAFF already hit the stricter
        // ownership check above).
        if (fields.dueDate !== undefined
          && fields.dueDate !== (job.dueDate ?? null)) {
          throw new AppError(
            'VALIDATION_ERROR',
            400,
            'Haftalık raporun teslim son tarihi değiştirilemez.',
            { fieldErrors: { dueDate: 'Haftalık raporun teslim son tarihi değiştirilemez.' } },
          );
        }
      }

      const isCalendarIntervalJob = job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY';
      // Preliminary request-level signal for lock-map validation below; the
      // authoritative scheduleChanged is recomputed after schedule
      // normalization/fallback injection (Phase B).
      let scheduleChanged = fields.scheduledAt !== undefined
        && fields.scheduledAt !== job.scheduledAt
        || fields.scheduledEndsAt !== undefined
        && fields.scheduledEndsAt !== (job.scheduledEndsAt ?? null);
      // FOUNDATION-1: a dueDate change is an authoritative schedule revision
      // even though it is not a calendar interval change; it must not alter
      // the existing calendar/acceptance-reset semantics of `scheduleChanged`.
      const dueDateChanged = fields.dueDate !== undefined
        && fields.dueDate !== (job.dueDate ?? null);
      let scheduleRevisionChanged = scheduleChanged || dueDateChanged;
      const assigneeChanged = fields.assignedTo !== undefined
        && fields.assignedTo !== job.assignedTo;
      const needsCalendarAssigneeLock = this.calendar.enabled
        && isCalendarIntervalJob
        && (scheduleChanged || assigneeChanged);
      if (fields.assignedTo !== undefined && assigneeChanged) {
        const assignee = lockedAssignees.get(fields.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
      } else if (needsCalendarAssigneeLock) {
        if (!lockedAssignees.has(job.assignedTo)) {
          throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        }
      }
      const nextCustomerId = fields.customerId !== undefined ? fields.customerId : job.customerId;
      const nextContactId = fields.contactId !== undefined ? fields.contactId
        : fields.customerId !== undefined && fields.customerId !== job.customerId ? null : job.contactId;
      if (nextCustomerId) await this.validateJobReferences(transaction, actor.organizationId, nextCustomerId, nextContactId);
      else if (nextContactId) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
      if (fields.customerId !== undefined && fields.contactId === undefined && fields.customerId !== job.customerId) {
        fields.contactId = null;
      }

      if (fields.scheduledAt === null
        && (job.type === 'PRODUCT_DELIVERY' || job.type === 'SALES_MEETING')) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'Planlanan zaman bu iş türü için zorunludur.',
        );
      }
      const nextScheduledAt = fields.scheduledAt === undefined
        ? job.scheduledAt
        : fields.scheduledAt;
      let nextScheduledEndsAt = fields.scheduledEndsAt === undefined
        ? job.scheduledEndsAt ?? null
        : fields.scheduledEndsAt;
      const scheduleFieldProvided = fields.scheduledAt !== undefined
        || fields.scheduledEndsAt !== undefined;
      if (job.type === 'GENERAL_TASK' && fields.scheduledEndsAt !== undefined
        && fields.scheduledEndsAt !== null) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'General Task için planlanan bitiş zamanı desteklenmiyor.',
        );
      }
      if (job.type === 'GENERAL_TASK' && scheduleFieldProvided) {
        nextScheduledEndsAt = null;
        fields.scheduledEndsAt = null;
      }
      // When only the start moves, preserve the existing interval length so a
      // scheduledAt-only reschedule keeps a valid calendar interval.
      if (isCalendarIntervalJob
        && fields.scheduledEndsAt === undefined
        && fields.scheduledAt !== undefined
        && job.scheduledAt !== null
        && job.scheduledEndsAt !== null
        && nextScheduledAt !== null) {
        const delta = Date.parse(nextScheduledAt) - Date.parse(job.scheduledAt);
        nextScheduledEndsAt = new Date(Date.parse(job.scheduledEndsAt) + delta).toISOString();
        fields.scheduledEndsAt = nextScheduledEndsAt;
      }
      // Compatibility repair for interval jobs without a valid persisted
      // duration (NULL/NULL or START_ONLY legacy/demo rows): a start-only
      // patch derives the canonical domain end instead of failing. Requires
      // an explicitly supplied start so unrelated patches (e.g. assignee-only)
      // never synthesize a schedule.
      if (isCalendarIntervalJob
        && fields.scheduledEndsAt === undefined
        && fields.scheduledAt !== undefined
        && nextScheduledAt !== null
        && nextScheduledEndsAt === null) {
        const canonicalEnd = canonicalScheduledEnd(job.type, nextScheduledAt);
        if (canonicalEnd !== null) {
          nextScheduledEndsAt = canonicalEnd;
          fields.scheduledEndsAt = nextScheduledEndsAt;
        }
      }
      // Phase B: authoritative change signals describe the effective persisted
      // mutation, not only the raw request. A START_ONLY same-start repair
      // (10:30/null → 10:30/11:00) must traverse the full scheduling chain
      // even though the supplied start did not differ.
      scheduleChanged = nextScheduledAt !== (job.scheduledAt ?? null)
        || nextScheduledEndsAt !== (job.scheduledEndsAt ?? null);
      scheduleRevisionChanged = scheduleChanged || dueDateChanged;
      if (isCalendarIntervalJob && scheduleFieldProvided
        && (nextScheduledAt === null || nextScheduledEndsAt === null)) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'Planlanan zaman bu iş türü için zorunludur.',
        );
      }
      if (isCalendarIntervalJob && fields.scheduledEndsAt !== undefined
        && fields.scheduledEndsAt !== null
        && nextScheduledAt !== null
        && nextScheduledEndsAt !== null) {
        const existingDurationMs = persistedScheduledDurationMs(job.scheduledAt, job.scheduledEndsAt);
        const nextDurationMs = Date.parse(nextScheduledEndsAt) - Date.parse(nextScheduledAt);
        if (existingDurationMs !== null && nextDurationMs !== existingDurationMs) {
          throw new AppError(
            'VALIDATION_ERROR',
            400,
            'Mevcut planın süresi değiştirilemez.',
          );
        }
      }
      if (
        nextScheduledEndsAt !== null
        && (
          nextScheduledAt === null
          || Date.parse(nextScheduledEndsAt) <= Date.parse(nextScheduledAt)
        )
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          400,
          'Planlanan bitiş zamanı başlangıç zamanından sonra olmalıdır.',
        );
      }

      // WORKING-DAY contract reconciliation: a human reschedule onto the
      // organization-local Sunday is honoured verbatim — no rejection, no
      // silent advance to Monday — so no working-day guard runs here.
      if ((scheduleChanged || assigneeChanged)
        && job.status !== 'NEW' && job.status !== 'ACCEPTED') {
        throw new AppError('JOB_NOT_EDITABLE', 409, 'JobCard bu durumda düzenlenemez.');
      }
      const management = actor.role === 'MANAGER' || actor.role === 'ADMIN';
      if (management && job.status === 'ACCEPTED' && (scheduleChanged || assigneeChanged)) {
        fields.status = 'NEW';
        fields.clearAcceptance = true;
      }
      const customerChanged = fields.customerId !== undefined
        && fields.customerId !== job.customerId;
      const engagementChanged = fields.engagementKind !== undefined && fields.engagementKind !== job.engagementKind;
      const frequencyAdvisory = (scheduleChanged || customerChanged || assigneeChanged || engagementChanged)
        ? await this.assessCustomerSchedule(transaction, actor, {
            customerId: nextCustomerId,
            proposedAt: nextScheduledAt !== null ? new Date(nextScheduledAt) : null,
            jobType: job.type,
            excludeJobId: job.id,
            assignedTo: fields.assignedTo ?? job.assignedTo,
            engagementKind: fields.engagementKind ?? job.engagementKind,
            scheduledEndsAt: nextScheduledEndsAt,
          })
        : null;
      if (this.calendar.enabled && isCalendarIntervalJob && (scheduleChanged || assigneeChanged)) {
        await transaction.assertCalendarAvailability({
          organizationId: actor.organizationId,
          jobCardId,
          assignedUserId: fields.assignedTo ?? job.assignedTo,
          startsAt: nextScheduledAt,
          endsAt: nextScheduledEndsAt,
        });
      }

      // OVR-2: read eligibility BEFORE the row update below: the update
      // itself may void the acceptance (management edit returns NEW), while
      // assignment history and schedule revisions still resolve pre-move
      // afterwards. The pre-image commitment belongs to the breach.
      const preMutationInstants: JobLifecycleInstants | null =
        (assigneeChanged || scheduleRevisionChanged) && job.status === 'ACCEPTED'
          ? await transaction.getJobLifecycleInstants(actor.organizationId, jobCardId)
          : null;
      // A dueDate-only revision is legal in IN_PROGRESS and
      // REVISION_REQUESTED. Resolve that pending submission episode before
      // the row/revision mutation so a breach of the old deadline is
      // preserved under the old governing revision.
      const pendingSubmissionEpisodeNo: number | null = dueDateChanged
        && (job.status === 'IN_PROGRESS' || job.status === 'REVISION_REQUESTED')
        ? await transaction.getNextSubmittedSeqNo(actor.organizationId, jobCardId)
        : null;
      if (pendingSubmissionEpisodeNo !== null) {
        await this.materializeLateSubmissionIfBreached(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          scheduledEndsAt: job.scheduledEndsAt,
          scheduledAt: job.scheduledAt,
          type: job.type,
          dueDate: job.dueDate,
          episodeNo: pendingSubmissionEpisodeNo,
          allowStartedAtFallback: job.status === 'IN_PROGRESS',
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          source: 'MUTATION',
          requestTime,
        });
      }
      const updated = await transaction.updateFieldsWithVersion({
        organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion, fields,
      });
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      // OVR-2: a reassignment or deadline revision after a breach must not
      // erase it. Materialize against PRE-mutation history: the row above is
      // already updated, but assignment history and schedule revisions are
      // still untouched at this point, so attribution and the governing
      // revision resolve exactly as before the mutation. Eligibility
      // (preMutationInstants, read before the update) belongs to the
      // pre-image commitment: the update itself may void the acceptance.
      // Never recovered here: changing who owns the job or where its
      // deadline sits does not resolve the breach. The accepted-job path
      // below preserves LATE_START; the active-submission dueDate path above
      // preserves LATE_SUBMISSION before the mutation.
      if ((assigneeChanged || scheduleRevisionChanged) && job.status === 'ACCEPTED') {
        // Revision/history resolution stays inside the materializer, AFTER
        // its deadline and eligibility early-returns: jobs without a
        // breachable deadline must never fail here (e.g. fixtures without
        // schedule history rows).
        await this.materializeLateStartIfBreached(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          scheduledEndsAt: job.scheduledEndsAt,
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          instants: preMutationInstants ?? undefined,
          source: 'MUTATION',
          requestTime,
        });
      }
      if (this.calendar.enabled && (scheduleChanged || assigneeChanged)) {
        await transaction.synchronizeCalendarReminder({
          organizationId: actor.organizationId,
          jobCardId,
          assignedUserId: updated.assignedTo,
          startsAt: updated.scheduledAt,
          endsAt: updated.scheduledEndsAt,
          version: updated.version,
          active: (ACTIVE_JOB_CARD_STATUSES as readonly string[]).includes(updated.status),
          now: requestTime,
          reminderLeadMinutes: this.calendar.reminderLeadMinutes,
        });
      }
      const realtimeEvents: RealtimeEventRecord[] = [];
      let assignmentTransitionId: string | null = null;
      if (fields.assignedTo !== undefined && fields.assignedTo !== job.assignedTo) {
        const activity = await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'JOB_ASSIGNED',
          oldValue: { assignedTo: job.assignedTo }, newValue: { assignedTo: updated.assignedTo },
        });
        assignmentTransitionId = activity.id;
        realtimeEvents.push(...await this.appendRealtimeForActivity(transaction, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'JOB_ASSIGNED',
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: updated.assignedTo,
          calendarAffected: this.calendar.enabled,
          customerId: updated.customerId,
        }));
      }
      const nonAssignmentFields = Object.keys(fields).filter(
        (key) => key !== 'assignedTo' && key !== 'clearAcceptance',
      );
      if (nonAssignmentFields.length > 0) {
        const activity = await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'JOB_FIELDS_UPDATED',
          oldValue: Object.fromEntries(nonAssignmentFields.map((key) => [key, job[key as keyof typeof job]])),
          newValue: Object.fromEntries(nonAssignmentFields.map((key) => [key, updated[key as keyof typeof updated]])),
          metadata: frequencyAdvisory !== null
            ? { customerFrequencyAdvisory: frequencyAdvisory }
            : undefined,
        });
        realtimeEvents.push(...await this.appendRealtimeForActivity(transaction, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'JOB_FIELDS_UPDATED',
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: updated.assignedTo,
          calendarAffected: this.calendar.enabled && scheduleChanged,
          notifyCalendarRescheduled: this.calendar.enabled && scheduleChanged,
          customerId: updated.customerId,
        }));
      }
      // FOUNDATION-1: authoritative history rides the same critical-action
      // transaction. Schedule revision uses the locked pre-state numbering
      // (MAX+1 under the job row lock) and snapshots the final schedule.
      let appendedScheduleRevisionNo: number | null = null;
      if (scheduleRevisionChanged) {
        const appended = await transaction.appendScheduleRevision({
          organizationId: actor.organizationId, jobCardId,
          scheduledAt: updated.scheduledAt, scheduledEndsAt: updated.scheduledEndsAt,
          dueDate: updated.dueDate, source: 'RESCHEDULE', createdBy: actor.id,
          // Domain-effective instant: OVR-2 derives revision activation
          // from the request clock, not the DB statement clock.
          createdAt: requestTime,
        });
        appendedScheduleRevisionNo = appended.revisionNo;
      }
      // OVR-2: a revision that moves the first-late boundary into the past
      // breaches under the NEW governing revision, but never before the revision
      // itself took effect: breached_at = max(new deadline, acceptance,
      // this requestTime). The pre-write materialization above already
      // preserved any breach of the OLD deadline; this binds the newly
      // introduced breach to the new revision. Only ACCEPTED jobs are
      // eligible (a management edit voids acceptance and returns NEW).
      if (scheduleChanged
        && appendedScheduleRevisionNo !== null
        && updated.status === 'ACCEPTED') {
        await this.materializeLateStartIfBreached(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          scheduledEndsAt: updated.scheduledEndsAt,
          scheduleRevisionNo: appendedScheduleRevisionNo,
          revisionEffectiveAt: requestTime,
          instants: preMutationInstants ?? undefined,
          source: 'MUTATION',
          requestTime,
        });
      }
      // A dueDate revision in an active submission state is evaluated under
      // the NEW governing revision after the revision row exists. This can
      // introduce a new already-breached incident, but it can never rewrite
      // or recover the old revision-bound row materialized above.
      if (dueDateChanged
        && pendingSubmissionEpisodeNo !== null
        && appendedScheduleRevisionNo !== null) {
        await this.materializeLateSubmissionIfBreached(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          scheduledEndsAt: updated.scheduledEndsAt,
          scheduledAt: updated.scheduledAt,
          type: updated.type,
          dueDate: updated.dueDate,
          episodeNo: pendingSubmissionEpisodeNo,
          allowStartedAtFallback: job.status === 'IN_PROGRESS',
          scheduleRevisionNo: appendedScheduleRevisionNo,
          revisionEffectiveAt: requestTime,
          source: 'MUTATION',
          requestTime,
        });
      }
      if (assignmentTransitionId !== null) {
        await transaction.appendAssignmentHistory({
          organizationId: actor.organizationId, jobCardId,
          fromUserId: job.assignedTo, toUserId: updated.assignedTo,
          changedBy: actor.id, source: 'PATCH_REASSIGN', changedAt: requestTime,
          activityId: assignmentTransitionId,
        });
      }
      const detail = await transaction.getJobDetail(actor.organizationId, jobCardId);
      if (!detail) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      return {
        response: {
          ...(await this.presentDetail(transaction, actor, detail, requestTime)),
          assignmentTransitionId,
        },
        realtimeEvents,
      };
    }).then((committed) => {
      this.publishRealtime(committed.realtimeEvents);
      return committed.response;
    }).catch((caught) => {
      if (caught instanceof AppError) throw projectCalendarConflict(actor, caught);
      throw caught;
    });
  }

  private async assertFollowUpDepth(
    transaction: JobCardTransaction,
    source: FollowUpSourceReference,
  ) {
    let ancestorId = source.sourceJobCardId;
    let sourceDepth = 0;
    const visited = new Set([source.id]);
    while (ancestorId !== null) {
      sourceDepth += 1;
      if (sourceDepth >= 10) {
        throw new AppError(
          'FOLLOW_UP_MAX_DEPTH_REACHED',
          409,
          'Takip işi zinciri izin verilen azami derinliğe ulaştı.',
        );
      }
      if (visited.has(ancestorId)) followUpInvariantViolation();
      visited.add(ancestorId);
      const ancestor = await transaction.getJob(source.organizationId, ancestorId);
      if (!ancestor) followUpInvariantViolation();
      ancestorId = ancestor.sourceJobCardId;
    }
  }

  private async validateJobReferences(tx: JobCardTransaction, organizationId: string, customerId: string | null, contactId: string | null) {
    if (!customerId) {
      if (contactId) {
        throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
      }
      return;
    }
    const customer = await tx.getCustomerForUpdate(organizationId, customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    if (customer.status === 'inactive') throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteri için iş oluşturulamaz.');
    if (!contactId) return;
    const contact = await tx.getContactForUpdate(organizationId, contactId);
    if (!contact) throw new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
    if (contact.customerId !== customerId) throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
    if (!contact.isActive) throw new AppError('CONTACT_INACTIVE', 409, 'Pasif ilgili kişi iş kartında kullanılamaz.');
  }

  async addDeliveryItem(actor: JobCardActor, jobCardId: string, input: AddDeliveryInput) {
    assertKnownFields(input, ['clientActionId', ...DELIVERY_FIELDS]);
    if (!input.clientActionId.trim()) throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
    const result = await this.repository.executeCriticalAction(
      { organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId, operationKey: 'DELIVERY_ITEM_CREATE',
        requestHash: deliveryItemCreateRequestHash(jobCardId, input) },
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertProductDeliveryJob(job);
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        assertCanEdit(actor, job);
        const plannedDeliveredAt = parseDeliveredAt(input.deliveredAt);
        if (plannedDeliveredAt !== null) {
          assertCanEditDeliveryActualTime(actor, job);
        }
        const product = await tx.getProduct(actor.organizationId, input.productId);
        if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
        const item = await tx.createDeliveryItem(deliveryRecord(actor.organizationId, jobCardId, input, product));
        const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'DELIVERY_ITEM_ADDED', clientActionId: input.clientActionId,
          newValue: {
            itemId: item.id, productId: item.productId, deliveryPurpose: item.deliveryPurpose,
            quantity: item.quantity,
            deliveredAt: item.deliveredAt === null ? null : item.deliveredAt.toISOString(),
          } });
        return { response: { item, jobCardVersion: updated.version }, realtimeEvents: [] };
      });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  async patchDeliveryItem(actor: JobCardActor, jobCardId: string, itemId: string, input: PatchDeliveryInput) {
    assertKnownFields(input, DELIVERY_FIELDS);
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      assertProductDeliveryJob(job);
      if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      assertCanEdit(actor, job);
      const current = await tx.getDeliveryItemForUpdate(actor.organizationId, jobCardId, itemId);
      if (!current) throw new AppError('DELIVERY_ITEM_NOT_FOUND', 404, 'Teslim ürünü bulunamadı.');
      if (input.deliveredAt !== undefined) {
        const nextDeliveredAt = parseDeliveredAt(input.deliveredAt);
        const previousIso = current.deliveredAt === null ? null : current.deliveredAt.toISOString();
        const nextIso = nextDeliveredAt === null ? null : nextDeliveredAt.toISOString();
        if (nextIso !== previousIso) {
          // Actual delivery time is execution-stage only (backend capability gate).
          assertCanEditDeliveryActualTime(actor, job);
        }
      }
      const product = input.productId && input.productId !== current.productId
        ? await tx.getProduct(actor.organizationId, input.productId) : {
          id: current.productId, organizationId: current.organizationId, name: current.productNameSnapshot,
          sku: current.productSkuSnapshot, model: current.productModelSnapshot, unit: current.unit, isActive: true };
      if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
      const merged: DeliveryInput = { expectedVersion: input.expectedVersion, productId: input.productId ?? current.productId,
        deliveryPurpose: input.deliveryPurpose ?? current.deliveryPurpose,
        deliveredAt: input.deliveredAt !== undefined
          ? input.deliveredAt
          : current.deliveredAt === null ? null : current.deliveredAt.toISOString(),
        quantity: input.quantity ?? current.quantity,
        lotNo: input.lotNo === undefined ? current.lotNo : input.lotNo, serialNo: input.serialNo === undefined ? current.serialNo : input.serialNo,
        expiryDate: input.expiryDate === undefined ? current.expiryDate : input.expiryDate,
        deliveryNote: input.deliveryNote === undefined ? current.deliveryNote : input.deliveryNote };
      const item = await tx.updateDeliveryItem(itemId, deliveryRecord(actor.organizationId, jobCardId, merged, product));
      const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
        event: 'DELIVERY_ITEM_UPDATED',
        oldValue: {
          itemId, quantity: current.quantity, deliveryPurpose: current.deliveryPurpose,
          deliveredAt: current.deliveredAt === null ? null : current.deliveredAt.toISOString(),
        },
        newValue: {
          itemId, quantity: item.quantity, deliveryPurpose: item.deliveryPurpose,
          deliveredAt: item.deliveredAt === null ? null : item.deliveredAt.toISOString(),
        } });
      return { item, jobCardVersion: updated.version };
    });
  }

  async removeDeliveryItem(actor: JobCardActor, jobCardId: string, itemId: string, input: { expectedVersion: number }) {
    return this.repository.executeTransaction(async (tx) => {
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (actor.role === 'STAFF' && actor.id !== job.assignedTo) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      assertProductDeliveryJob(job);
      if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      assertCanEdit(actor, job);
      const item = await tx.getDeliveryItemForUpdate(actor.organizationId, jobCardId, itemId);
      if (!item) throw new AppError('DELIVERY_ITEM_NOT_FOUND', 404, 'Teslim ürünü bulunamadı.');
      await tx.deleteDeliveryItem(itemId);
      const updated = await tx.bumpVersion(actor.organizationId, jobCardId, input.expectedVersion);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      await tx.appendActivity({ organizationId: actor.organizationId, jobCardId, actorId: actor.id,
        event: 'DELIVERY_ITEM_REMOVED', oldValue: { itemId, productId: item.productId, quantity: item.quantity } });
      return { id: itemId, jobCardVersion: updated.version };
    });
  }

  async listDeliveryItems(actor: JobCardActor, jobCardId: string) {
    const job = await this.detail(actor, jobCardId);
    assertProductDeliveryJob(job);
    return this.repository.listDeliveryItems(actor.organizationId, jobCardId);
  }

  async listActivity(actor: JobCardActor, jobCardId: string, page: PageQuery) {
    await this.detail(actor, jobCardId);
    const result = await this.repository.listActivity(actor.organizationId, jobCardId, page);
    return {
      items: result.items.map(presentActivity),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * OVR-2 management-only breach history. STAFF is rejected before any
   * lookup; the detail read below keeps the existing 404 concealment for
   * missing/cross-org jobs without widening STAFF visibility anywhere.
   */
  async listOverdueIncidents(
    actor: JobCardActor,
    jobCardId: string,
    page: PageQuery,
  ): Promise<PaginatedOverdueIncidentHistory> {
    assertCanReadOverdueIncidentHistory(actor);
    await this.detail(actor, jobCardId);
    const result = await this.repository.listOverdueIncidents(
      actor.organizationId, jobCardId, page,
    );
    return {
      items: result.items.map((item) => ({
        id: item.id,
        delayType: item.delayType,
        episodeNo: item.episodeNo,
        scheduleRevisionNo: item.scheduleRevisionNo,
        deadlineAt: item.deadlineAt.toISOString(),
        breachedAt: item.breachedAt.toISOString(),
        accountableRole: item.accountableRole,
        accountableSource: item.accountableSource,
        accountableUser: item.accountableUserId === null
          ? null
          : { id: item.accountableUserId, name: item.accountableUserName },
        source: item.source,
        recordedAt: item.recordedAt.toISOString(),
        recoveredAt: item.recoveredAt === null ? null : item.recoveredAt.toISOString(),
        recoveryActor: item.recoveryActorUserId === null
          ? null
          : { id: item.recoveryActorUserId, name: item.recoveryActorUserName },
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  async listReferenceCustomers(actor: JobCardActor) {
    const customers = await this.repository.listReferenceCustomers(actor.organizationId);
    if (actor.role !== 'STAFF') return customers;
    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      customerType: customer.customerType,
      status: customer.status,
    }));
  }

  async acceptAssignment(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'ACCEPT_ASSIGNMENT', operationKey: 'JOB_ACCEPT_ASSIGNMENT',
      target: 'ACCEPTED', event: 'JOB_ACCEPTED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    });
  }

  async start(actor: JobCardActor, jobCardId: string, input: StartInput) {
    const lifecycleInput = this.lifecycleInput(input);
    const definition: LifecycleDefinition = {
      command: 'START', operationKey: 'JOB_START', target: 'IN_PROGRESS', event: 'JOB_STARTED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    };
    assertStaffStartActor(actor);
    if (!this.geolocation.enabled) {
      return this.runLifecycle(actor, jobCardId, lifecycleInput, definition);
    }

    const capture = parseStartLocationCapture(input.locationCapture);
    const claim = this.intentClaim(actor, jobCardId, lifecycleInput.clientActionId, definition, lifecycleInput, capture);
    const completed = await this.repository.findCompletedLifecycleIntent<unknown>(claim);
    if (completed) {
      const receipt = decodeJobCardMutationReceipt(completed);
      return this.presentLifecycleReceipt(actor, receipt);
    }

    if (capture.outcome === 'UNAVAILABLE') {
      throw new AppError(
        'LOCATION_REQUIRED',
        400,
        locationUnavailableMessage(capture.reason),
        { reason: capture.reason },
      );
    }
    // 049: reserve BEFORE the provider call. The reservation commits and
    // releases the JobCard lock, so geocoder latency never holds it; the
    // claim hash covers only the pre-provider capture core, which the
    // normalizer keeps stable across provider resolution, so the same
    // claim finalizes below.
    const reserved = await this.repository.reserveLifecycleIntent<JobCardMutationReceipt>(
      claim,
      { jobCardId, ttlMs: this.intentTtlMs(),
        preflight: async (_tx, job, reservedAt) => this.assertLifecycleReservation(actor, job, definition, reservedAt),
      },
    );
    if (reserved.kind === 'replay') {
      const receipt = decodeJobCardMutationReceipt(reserved.response);
      return this.presentLifecycleReceipt(actor, receipt);
    }
    const resolvedCapture = await this.resolveStartLocation({
      organizationId: actor.organizationId,
      actorUserId: actor.id,
      capture,
      correlationId: lifecycleInput.clientActionId,
    });
    return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, resolvedCapture, {
      claim,
      reservation: reserved.reservation,
    });
  }

  async submitForApproval(actor: JobCardActor, jobCardId: string, input: SubmitInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'SUBMIT_FOR_APPROVAL', operationKey: 'JOB_SUBMIT_FOR_APPROVAL',
      target: 'WAITING_APPROVAL', event: 'JOB_SUBMITTED_FOR_APPROVAL',
      note: requireSubmissionNote(input.note), revisionReason: null, cancelReason: null,
      noteContext: 'SUBMIT_FOR_APPROVAL',
      followUpProposal: input.followUpProposal,
    });
  }

  async approve(actor: JobCardActor, jobCardId: string, input: ApproveInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'APPROVE', operationKey: 'JOB_APPROVE', target: 'COMPLETED', event: 'JOB_APPROVED',
      note: optionalLifecycleNote(input.note), revisionReason: null, cancelReason: null,
      noteContext: 'APPROVE',
      approveFollowUp: input.followUp,
    });
  }

  async requestRevision(actor: JobCardActor, jobCardId: string, input: RevisionInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'REQUEST_REVISION', operationKey: 'JOB_REQUEST_REVISION', target: 'REVISION_REQUESTED',
      event: 'JOB_REVISION_REQUESTED', note: null,
      revisionReason: lifecycleReason(input.revisionReason, 'revisionReason'), cancelReason: null,
      noteContext: 'REQUEST_REVISION',
    });
  }

  async withdrawFromApproval(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'WITHDRAW_FROM_APPROVAL', operationKey: 'JOB_WITHDRAW_FROM_APPROVAL',
      target: 'IN_PROGRESS', event: 'JOB_APPROVAL_WITHDRAWN',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    });
  }

  async resume(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'RESUME', operationKey: 'JOB_RESUME', target: 'IN_PROGRESS', event: 'JOB_RESUMED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    });
  }

  async cancel(actor: JobCardActor, jobCardId: string, input: CancelInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'CANCEL', operationKey: 'JOB_CANCEL', target: 'CANCELLED', event: 'JOB_CANCELLED',
      note: null, revisionReason: null,
      cancelReason: lifecycleReason(input.cancelReason, 'cancelReason'),
      noteContext: 'CANCEL',
    });
  }

  private lifecycleInput(input: LifecycleInput) {
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    return { clientActionId, expectedVersion: input.expectedVersion };
  }

  private assertLifecycleReservation(
    actor: JobCardActor, job: JobCard, definition: LifecycleDefinition, reservedAt: Date,
  ): void {
    if (definition.command === 'START') assertStaffStartActor(actor);
    assertCanTransition(actor, job, definition.command,
      definition.revisionReason ?? definition.cancelReason ?? undefined, reservedAt);
    if (definition.command === 'START') assertPlannedIntervalForStart(job);
  }

  private async runLifecycle(
    actor: JobCardActor,
    jobCardId: string,
    input: { clientActionId: string; expectedVersion: number },
    definition: LifecycleDefinition,
    startLocation?: JobActionLocationCapture,
    preReserved?: { claim: LifecycleIntentClaim; reservation: LifecycleIntentReservation },
  ) {
    const claim = preReserved?.claim
      ?? this.intentClaim(actor, jobCardId, input.clientActionId, definition, input, startLocation);
    // Pre-049 compatibility: a completed processed_actions receipt for the
    // same identity still replays through the same hash gate, and legacy
    // NULL-hash rows stay fail-closed via CLIENT_ACTION_REUSED.
    const legacyCompleted = await this.repository.findCompletedCriticalAction<unknown>({
      organizationId: claim.organizationId,
      userId: claim.userId,
      clientActionId: claim.clientActionId,
      operationKey: claim.operationKey,
      requestHash: claim.requestHash,
    });
    if (legacyCompleted) {
      const receipt = decodeJobCardMutationReceipt(legacyCompleted);
      return this.presentLifecycleReceipt(actor, receipt);
    }
    const reserved = preReserved
      ? { kind: 'reserved' as const, reservation: preReserved.reservation }
      : await this.repository.reserveLifecycleIntent<JobCardMutationReceipt>(
        claim,
        { jobCardId, ttlMs: this.intentTtlMs(),
        preflight: async (_tx, job, reservedAt) => this.assertLifecycleReservation(actor, job, definition, reservedAt),
      },
      );
    if (reserved.kind === 'replay') {
      const receipt = decodeJobCardMutationReceipt(reserved.response);
      return this.presentLifecycleReceipt(actor, receipt);
    }
    // 049: business time is the reservation instant sampled under the
    // JobCard lock — never service-entry time.
    const requestTime = reserved.reservation.reservedAt;
    let lockedAssignees = new Map<string, JobCardAssignee>();
    const result = await this.repository.finalizeLifecycleIntent<JobCardMutationReceipt>(
      claim,
      reserved.reservation,
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        if (startLocation) assertStaffStartActor(actor);
        assertCanTransition(
          actor, job, definition.command,
          definition.revisionReason ?? definition.cancelReason ?? undefined,
          requestTime,
        );
        if (definition.command === 'START') {
          assertPlannedIntervalForStart(job);
        }
        // OVR-2: derive the semantic obligation resolved by this command
        // independently from breach discovery. A current revision may be on
        // time while an older revision-bound incident is still open.
        const overdueRecoveryTarget = await this.resolveOverdueRecoveryTarget(
          tx, actor, jobCardId, job, definition.command,
        );
        // Materialize a breach BEFORE the transition runs. The same
        // transaction later recovers the semantic target, so late
        // START/SUBMIT (or an approval/cancel past its threshold) can never
        // slip through without immutable history.
        await this.materializeOverdueBreachForCommand(
          tx, actor, jobCardId, job, definition.command, requestTime,
        );
        let persistedProposal: {
          scheduledAt: Date;
          type: JobCardType;
          assignedTo: string;
          instructions: string;
          origin: FollowUpProposalOrigin;
          proposedBy: string | null;
        } | null = null;
        let submissionMeetingDetails: MeetingDetailsCandidate | null = null;
        let approval: {
          proposal: ValidatedFollowUpProposal;
          priority: JobCardPriority;
          dueDate: string | null;
        } | null = null;
        if (definition.command === 'SUBMIT_FOR_APPROVAL') {
          const submission = await validateSubmission(tx, actor, job, requestTime);
          submissionMeetingDetails = submission.meetingDetails ?? null;
          const followUpRequired = requiresMandatoryFollowUpProposal({
            ...job,
            ...submissionMeetingDetails,
          });
          if (!followUpRequired
            && definition.followUpProposal !== undefined) {
            throw new AppError(
              'FOLLOW_UP_PROPOSAL_INVALID',
              400,
              'Bu iş türü için takip işi planı desteklenmiyor.',
            );
          }
          if (followUpRequired) {
            const autoScheduled = definition.followUpProposal?.scheduledAt === undefined;
            const proposal = autoScheduled
              ? await this.autoScheduleFollowUpProposal(
                tx,
                actor,
                job,
                requestTime,
                submissionMeetingDetails?.meetingAt ?? null,
                false,
                definition.followUpProposal,
                undefined,
                lockedAssignees,
              )
              : await this.validateFollowUpProposal(
                actor,
                job,
                definition.followUpProposal,
                requestTime,
                lockedAssignees,
                {
                  followUpRequired,
                  meetingAt: submissionMeetingDetails?.meetingAt ?? null,
                },
              );
            if (!autoScheduled) {
            }
            persistedProposal = {
              scheduledAt: new Date(proposal.scheduledAt),
              type: proposal.type,
              assignedTo: proposal.assignedTo,
              instructions: proposal.followUpInstructions,
              origin: autoScheduled ? 'SYSTEM' : 'STAFF_ADJUSTED',
              proposedBy: actor.id,
            };
          }
        }
        if (definition.command === 'APPROVE') {
          approval = await this.resolveApproveFollowUp(
            tx, actor, job, definition.approveFollowUp, requestTime, lockedAssignees,
          );
        }
        const occurredAt = requestTime;
        const updated = await tx.transitionWithVersion({
          organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion,
          command: definition.command, status: definition.target, occurredAt, actorId: actor.id,
          note: definition.note, revisionReason: definition.revisionReason,
          cancelReason: definition.cancelReason,
          followUpProposal: persistedProposal,
        });
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        const calendarTerminal = definition.target === 'CANCELLED'
          || definition.target === 'COMPLETED';
        if (this.calendar.enabled && calendarTerminal) {
          await tx.synchronizeCalendarReminder({
            organizationId: actor.organizationId,
            jobCardId,
            assignedUserId: updated.assignedTo,
            startsAt: updated.scheduledAt,
            endsAt: updated.scheduledEndsAt,
            version: updated.version,
            active: false,
            now: requestTime,
            reminderLeadMinutes: this.calendar.reminderLeadMinutes,
          });
        }
        const reason = definition.revisionReason ?? definition.cancelReason;
        const transitionNoteBody = definition.note ?? reason;
        let noteId: string | null = null;
        let authorNameSnapshot: string | null = null;
        let authorRoleSnapshot: JobCardAssignee['role'] | null = null;
        let metadata: Record<string, unknown> | undefined;

        if (definition.noteContext && transitionNoteBody) {
          const author = await tx.getNoteAuthorSnapshot(
            actor.organizationId,
            actor.id,
          );
          if (!author?.isActive) {
            throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
          }
          authorNameSnapshot = author.name;
          authorRoleSnapshot = author.role;
          noteId = randomUUID();
          metadata = { noteId };
        }
        if (approval) {
          metadata = {
            ...(metadata ?? {}),
            followUpProposal: {
              scheduledAt: approval.proposal.scheduledAt.toISOString(),
              type: approval.proposal.type,
              assignedTo: approval.proposal.assignedTo,
              followUpInstructions: approval.proposal.followUpInstructions,
            },
          };
        }

        const activity = await tx.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: definition.event,
          clientActionId: input.clientActionId,
          oldValue: { status: job.status, version: job.version },
          newValue: { status: updated.status, version: updated.version },
          metadata,
        });

        // Weekly Report atomic submit (V1 Slice 2): the immutable submission
        // snapshot is appended in this SAME transaction, linked to the exact
        // JOB_SUBMITTED_FOR_APPROVAL activity created above. Any failure
        // rolls back the transition, the activity and the submission
        // together — no partial state is committable.
        if (definition.command === 'SUBMIT_FOR_APPROVAL' && job.type === 'WEEKLY_REPORT') {
          await this.appendWeeklyReportSubmission(tx, {
            actor,
            job,
            activityId: activity.id,
            occurredAt,
            jobVersion: updated.version,
          });
        }

        if (noteId && definition.noteContext && transitionNoteBody
          && authorNameSnapshot && authorRoleSnapshot) {
          await tx.createNote({
            id: noteId,
            organizationId: actor.organizationId,
            jobCardId,
            authorId: actor.id,
            authorNameSnapshot,
            authorRoleSnapshot,
            workflowStage: job.status,
            context: definition.noteContext,
            relatedActivityId: activity.id,
            note: transitionNoteBody,
            invoiceNumber: null,
          });
        }
        if (startLocation) {
          await tx.appendJobActionLocation({
            organizationId: actor.organizationId,
            jobCardId,
            activityId: activity.id,
            actorUserId: actor.id,
            action: 'JOB_STARTED',
            capture: startLocation,
          });
        }
        if (definition.command === 'START' || definition.command === 'SUBMIT_FOR_APPROVAL') {
          await this.appendLifecycleAccountabilityFact(tx, {
            actor,
            jobCardId,
            job,
            occurredAt,
            activityId: activity.id,
            command: definition.command,
          });
        }
        // OVR-2: REQUEST_REVISION and WITHDRAW_FROM_APPROVAL re-open the
        // submission obligation. Arm the next episode at exact requestTime
        // in this same transaction (durable activation row); a later SUBMIT
        // or CANCEL proves the episode from that row, never from the
        // previous SUBMITTED fact.
        if (definition.command === 'REQUEST_REVISION'
          || definition.command === 'WITHDRAW_FROM_APPROVAL') {
          const armedEpisodeNo = await this.activateNextSubmissionEpisode(
            tx, actor.organizationId, jobCardId, definition.command, requestTime,
          );
          // WITHDRAW creates the staff obligation; it does not satisfy it.
          // When the newly activated episode is already late, lock it OPEN
          // immediately (breached_at = activation when activation is later
          // than the first-late boundary). Deliberately not recovered here.
          if (definition.command === 'WITHDRAW_FROM_APPROVAL') {
            await this.materializeLateSubmissionIfBreached(tx, {
              organizationId: actor.organizationId,
              jobCardId,
              scheduledEndsAt: job.scheduledEndsAt,
              scheduledAt: job.scheduledAt,
              type: job.type,
              dueDate: job.dueDate,
              episodeNo: armedEpisodeNo,
              allowStartedAtFallback: false,
              scheduleRevisionNo: null,
              revisionEffectiveAt: null,
              source: 'TRANSITION',
              requestTime,
            });
          }
        }
        // OVR-2: recovery is driven by the command's resolved obligation, not
        // by whether this request happened to materialize a NEW incident.
        if (overdueRecoveryTarget) {
          await this.recoverOverdueIncident(tx, overdueRecoveryTarget, actor, requestTime);
        }
        let childRealtimeEvents: RealtimeEventRecord[] = [];
        let followUpJobCardId: string | null = null;
        if (approval) {
          const source = await tx.getFollowUpSource(actor.organizationId, jobCardId);
          if (!source) followUpInvariantViolation();
          await this.assertFollowUpDepth(tx, source);
          const childTitle = Array.from(`Takip: ${updated.title.trim()}`).slice(0, 250).join('');
          const child = await this.createFollowUpChild(tx, actor, {
            sourceJobCardId: jobCardId,
            customerId: updated.customerId,
            type: approval.proposal.type,
            title: childTitle,
            followUpInstructions: approval.proposal.followUpInstructions,
            scheduledAt: approval.proposal.scheduledAt.toISOString(),
            assignedTo: approval.proposal.assignedTo,
            priority: approval.priority,
            dueDate: approval.dueDate,
            contactId: null,
            engagementKind: approval.proposal.type === 'SALES_MEETING' ? 'FOLLOW_UP' : null,
            clientActionId: input.clientActionId,
            requestTime,
            assignee: approval.proposal.assignee,
            ...(job.followUpProposedBy !== null
              && job.followUpProposedBy === approval.proposal.assignedTo
              ? {
                acceptance: {
                  acceptedAt: requestTime,
                  acceptedBy: job.followUpProposedBy,
                },
              }
              : {}),
            activityMetadata: {
              sourceJobCardId: jobCardId,
            },
          });
          followUpJobCardId = child.job.id;
          childRealtimeEvents = child.realtimeEvents;
        }
        const realtimeEvents = await this.appendRealtimeForActivity(tx, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: definition.event,
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: updated.assignedTo,
          calendarAffected: this.calendar.enabled && calendarTerminal,
          customerId: updated.customerId,
        });
        return {
          response: {
            jobCardId,
            evaluatedAt: requestTime.toISOString(),
            ...(followUpJobCardId ? { followUpJobCardId } : {}),
          },
          realtimeEvents: [...realtimeEvents, ...childRealtimeEvents],
        };
      },
      {
        jobCardId,
        // 049: scheduling user locks stay ahead of the JobCard/intent
        // locks (users -> job_cards -> intents), exactly as before.
        lockUsers: async (tx) => {
          lockedAssignees = new Map<string, JobCardAssignee>();
          const mayScheduleFollowUp = definition.command === 'SUBMIT_FOR_APPROVAL'
            || definition.command === 'APPROVE';
          if (mayScheduleFollowUp) {
            const jobSnapshot = await tx.getJob(actor.organizationId, jobCardId);
            if (!jobSnapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
            const needsSchedulingUserLocks = jobSnapshot.type === 'SALES_MEETING'
              || jobSnapshot.followUpProposedAssignee !== null
              || definition.followUpProposal?.assignedTo !== undefined
              || definition.approveFollowUp?.assignedTo !== undefined;
            if (needsSchedulingUserLocks) {
              lockedAssignees = await this.lockUsersInOrder(
                tx,
                actor.organizationId,
                [
                  jobSnapshot.assignedTo,
                  jobSnapshot.followUpProposedAssignee,
                  definition.followUpProposal?.assignedTo,
                  definition.approveFollowUp?.assignedTo,
                ],
              );
            }
          }
        },
      },
    );
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    const receipt = decodeJobCardMutationReceipt(result.response);
    return this.presentLifecycleReceipt(actor, receipt);
  }

  private async presentLifecycleReceipt(actor: JobCardActor, receipt: ReturnType<typeof decodeJobCardMutationReceipt>) {
    const detail = await this.detailAt(actor, receipt.jobCardId, receipt.evaluatedAt ?? this.now());
    return receipt.followUpJobCardId
      ? { ...detail, followUpJobCardId: receipt.followUpJobCardId }
      : detail;
  }

  /**
   * FOUNDATION-2: freeze the STARTED/SUBMITTED accountability fact in the same
   * critical-action transaction. The JobCard row is already locked FOR UPDATE
   * and the lifecycle activity already inserted; any failure here rolls back
   * the whole business mutation.
   *
   * occurredAt is the same instant persisted by the transition into
   * started_at / staff_completed_at (runLifecycle passes requestTime as the
   * transition occurredAt), so the fact carries the exact persisted instant
   * without re-reading the row.
   */
  private async appendLifecycleAccountabilityFact(
    tx: JobCardTransaction,
    input: {
      actor: JobCardActor;
      jobCardId: string;
      job: JobCard;
      occurredAt: Date;
      activityId: string;
      command: 'START' | 'SUBMIT_FOR_APPROVAL';
    },
  ) {
    const factType = input.command === 'START' ? 'STARTED' : 'SUBMITTED';
    const revisionNo = await tx.getCurrentScheduleRevisionNo(
      input.actor.organizationId, input.jobCardId,
    );
    if (revisionNo === null) {
      throw new AppError(
        'ACCOUNTABILITY_REVISION_MISSING', 500, 'İş zaman planı kaydı bulunamadı.');
    }
    const seqNo = factType === 'STARTED'
      ? 1
      : await tx.getNextSubmittedSeqNo(input.actor.organizationId, input.jobCardId);
    await tx.appendAccountabilityFact({
      organizationId: input.actor.organizationId,
      jobCardId: input.jobCardId,
      factType,
      seqNo,
      occurredAt: input.occurredAt,
      scheduleRevisionNo: revisionNo,
      responsibleUserId: input.job.assignedTo,
      actorUserId: input.actor.id,
      sourceActivityId: input.activityId,
    });
  }

  /**
   * OVR-2: request-driven breach materialization. Delegates to the single
   * shared producer in `overdue-breach-producer.ts`, which the OVR-3 clock-only
   * scanner also evaluates through — there is deliberately no second copy of
   * the boundary, revision, activation, accountability or timezone rules.
   *
   * A mutation that is about to move (or has just observed) the historical
   * inputs of a deterministically provable breach must lock that breach as
   * an immutable incident in the SAME transaction first. Later
   * reassignment, deadline revision, recovery, completion or cancellation
   * can then no longer erase it. Returns the incident identity when a
   * breach was locked (or already existed), null when nothing is provable.
   *
   * Deliberately untouched: RESUME starts no episode and recovers nothing
   * by itself; INVALIDATE must never create one (§17) and is handled on
   * its own path without incident calls.
   */
  private async materializeLateStartIfBreached(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      scheduledEndsAt: string | null;
      /**
       * The acceptance about to be written by the enclosing ACCEPT_ASSIGNMENT
       * (not yet persisted, so it cannot be read back). Omitted everywhere
       * else: eligibility is read from the locked job row.
       */
      acceptedAtOverride?: Date;
      scheduleRevisionNo: number | null;
      revisionEffectiveAt: Date | null;
      /**
       * Pre-mutation lifecycle instants. The patch path updates the job row
       * BEFORE materializing (so assignment/schedule history still resolves
       * pre-move), which would void a management-cleared acceptance before
       * it is read — pass the pre-write read there. Lifecycle paths omit
       * this: they materialize before their transition runs.
       */
      instants?: JobLifecycleInstants;
      source: OverdueIncidentSource;
      requestTime: Date;
    },
  ): Promise<OverdueIncidentIdentity | null> {
    return unwrapBreach(await produceLateStartBreach(tx, input));
  }

  private async materializeLateSubmissionIfBreached(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      scheduledEndsAt: string | null;
      scheduledAt: string | null;
      type: JobCard['type'];
      dueDate: string | null;
      episodeNo: number;
      allowStartedAtFallback: boolean;
      scheduleRevisionNo: number | null;
      revisionEffectiveAt: Date | null;
      source: OverdueIncidentSource;
      requestTime: Date;
    },
  ): Promise<OverdueIncidentIdentity | null> {
    return unwrapBreach(await produceLateSubmissionBreach(tx, input));
  }

  private async materializeApprovalWaitIfBreached(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      source: OverdueIncidentSource;
      requestTime: Date;
    },
  ): Promise<OverdueIncidentIdentity | null> {
    return unwrapBreach(await produceApprovalWaitBreach(tx, input));
  }

  /**
   * CANCEL backstop for REVISION_REQUESTED: REQUEST_REVISION has already
   * armed the current pending episode in the same critical transaction, so
   * CANCEL evaluates that next SUBMITTED sequence, not the previous fact.
   * A missing activation row means a legacy episode whose exact start is
   * not provable; it remains unattributable rather than being backdated.
   */
  private async materializeCurrentSubmissionIfBreached(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      job: JobCard;
      source: OverdueIncidentSource;
      requestTime: Date;
    },
  ): Promise<OverdueIncidentIdentity | null> {
    const episodeNo = await tx.getNextSubmittedSeqNo(
      input.organizationId, input.jobCardId,
    );
    return this.materializeLateSubmissionIfBreached(tx, {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      scheduledEndsAt: input.job.scheduledEndsAt,
      scheduledAt: input.job.scheduledAt,
      type: input.job.type,
      dueDate: input.job.dueDate,
      episodeNo,
      allowStartedAtFallback: input.job.status === 'IN_PROGRESS',
      scheduleRevisionNo: null,
      revisionEffectiveAt: null,
      source: input.source,
      requestTime: input.requestTime,
    });
  }

  /**
   * Arm the next submission episode at exact requestTime. The episode
   * number is the next SUBMITTED sequence (no new fact exists yet in this
   * transaction), so the row deterministically aligns with the next
   * SUBMITTED fact and its incident. Replays converge via UNIQUE.
   * Legacy WAITING without any SUBMITTED fact arms tracked episode 1 here;
   * this is not a claim about an historical submission count.
   */
  private async activateNextSubmissionEpisode(
    tx: JobCardTransaction,
    organizationId: string,
    jobCardId: string,
    command: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL',
    requestTime: Date,
  ): Promise<number> {
    const episodeNo = await tx.getNextSubmittedSeqNo(organizationId, jobCardId);
    await tx.insertSubmissionEpisodeActivation({
      organizationId,
      jobCardId,
      episodeNo,
      activatedAt: requestTime,
      activatedByCommand: command,
    });
    return episodeNo;
  }

  /**
   * Resolve the semantic delay episode closed by a lifecycle command.
   * Materialization is intentionally separate: an on-time current revision
   * must not prevent recovery of an older open revision-bound incident.
   */
  private async resolveOverdueRecoveryTarget(
    tx: JobCardTransaction,
    actor: JobCardActor,
    jobCardId: string,
    job: JobCard,
    command: LifecycleCommand,
  ): Promise<OverdueRecoveryTarget | null> {
    const scope = { organizationId: actor.organizationId, jobCardId };
    const pendingSubmissionTarget = async (): Promise<OverdueRecoveryTarget> => ({
      ...scope,
      delayType: 'LATE_SUBMISSION',
      episodeNo: await tx.getNextSubmittedSeqNo(actor.organizationId, jobCardId),
    });
    const approvalWaitTarget = async (): Promise<OverdueRecoveryTarget | null> => {
      const fact = await tx.getLatestSubmittedFact(actor.organizationId, jobCardId);
      if (fact === null) return null;
      return {
        ...scope,
        delayType: 'APPROVAL_WAIT',
        episodeNo: fact.seqNo,
      };
    };

    switch (command) {
      case 'START':
        return job.status === 'ACCEPTED'
          ? { ...scope, delayType: 'LATE_START', episodeNo: 1 }
          : null;
      case 'SUBMIT_FOR_APPROVAL':
        return job.status === 'IN_PROGRESS' ? pendingSubmissionTarget() : null;
      case 'APPROVE':
      case 'REQUEST_REVISION':
      case 'WITHDRAW_FROM_APPROVAL':
        return job.status === 'WAITING_APPROVAL' ? approvalWaitTarget() : null;
      case 'CANCEL':
        if (job.status === 'NEW' || job.status === 'ACCEPTED') {
          // A management schedule edit can return an accepted job to NEW
          // while leaving its already-open LATE_START history unresolved.
          return { ...scope, delayType: 'LATE_START', episodeNo: 1 };
        }
        if (job.status === 'IN_PROGRESS' || job.status === 'REVISION_REQUESTED') {
          return pendingSubmissionTarget();
        }
        if (job.status === 'WAITING_APPROVAL') return approvalWaitTarget();
        return null;
      default:
        return null;
    }
  }

  private async recoverOverdueIncident(
    tx: JobCardTransaction,
    identity: OverdueRecoveryTarget,
    actor: JobCardActor,
    requestTime: Date,
  ): Promise<void> {
    await tx.recoverOverdueIncidentEpisode({
      organizationId: identity.organizationId,
      jobCardId: identity.jobCardId,
      delayType: identity.delayType,
      episodeNo: identity.episodeNo,
      recoveredAt: requestTime,
      recoveryActorUserId: actor.id,
    });
  }

  private async materializeOverdueBreachForCommand(
    tx: JobCardTransaction,
    actor: JobCardActor,
    jobCardId: string,
    job: JobCard,
    command: LifecycleCommand,
    requestTime: Date,
  ): Promise<OverdueIncidentIdentity | null> {
    const scope = { organizationId: actor.organizationId, jobCardId };
    switch (command) {
      case 'ACCEPT_ASSIGNMENT': {
        // The commitment starts here: accepting an already-past end opens
        // a LATE_START incident at acceptance (never backdated before it).
        // runLifecycle deliberately does NOT recover it (see below).
        if (job.status !== 'NEW') return null;
        return this.materializeLateStartIfBreached(tx, {
          ...scope,
          scheduledEndsAt: job.scheduledEndsAt,
          acceptedAtOverride: requestTime,
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          source: 'TRANSITION',
          requestTime,
        });
      }
      case 'START': {
        if (job.status !== 'ACCEPTED') return null;
        return this.materializeLateStartIfBreached(tx, {
          ...scope,
          scheduledEndsAt: job.scheduledEndsAt,
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          source: 'TRANSITION',
          requestTime,
        });
      }
      case 'SUBMIT_FOR_APPROVAL': {
        if (job.status !== 'IN_PROGRESS') return null;
        // Same job-lock discipline as the accountability fact below: the
        // sequence read here and the fact insert later in this transaction
        // observe the same MAX, so incident and fact share the episode.
        const episodeNo = await tx.getNextSubmittedSeqNo(
          actor.organizationId, jobCardId,
        );
        return this.materializeLateSubmissionIfBreached(tx, {
          ...scope,
          scheduledEndsAt: job.scheduledEndsAt,
          scheduledAt: job.scheduledAt,
          type: job.type,
          dueDate: job.dueDate,
          episodeNo,
          allowStartedAtFallback: true,
          scheduleRevisionNo: null,
          revisionEffectiveAt: null,
          source: 'TRANSITION',
          requestTime,
        });
      }
      case 'APPROVE':
      case 'REQUEST_REVISION':
      case 'WITHDRAW_FROM_APPROVAL': {
        if (job.status !== 'WAITING_APPROVAL') return null;
        return this.materializeApprovalWaitIfBreached(tx, {
          ...scope, source: 'TRANSITION', requestTime,
        });
      }
      case 'CANCEL': {
        // Cancel exits exactly the delay its current state represents; no
        // unbounded sweep. NEW has no commitment and proves no breach.
        if (job.status === 'WAITING_APPROVAL') {
          return this.materializeApprovalWaitIfBreached(tx, {
            ...scope, source: 'TRANSITION', requestTime,
          });
        }
        if (job.status === 'ACCEPTED') {
          return this.materializeLateStartIfBreached(tx, {
            ...scope,
            scheduledEndsAt: job.scheduledEndsAt,
            scheduleRevisionNo: null,
            revisionEffectiveAt: null,
            source: 'TRANSITION',
            requestTime,
          });
        }
        if (job.status === 'IN_PROGRESS') {
          const episodeNo = await tx.getNextSubmittedSeqNo(
            actor.organizationId, jobCardId,
          );
          return this.materializeLateSubmissionIfBreached(tx, {
            ...scope,
            scheduledEndsAt: job.scheduledEndsAt,
            scheduledAt: job.scheduledAt,
            type: job.type,
            dueDate: job.dueDate,
            episodeNo,
            allowStartedAtFallback: true,
            scheduleRevisionNo: null,
            revisionEffectiveAt: null,
            source: 'TRANSITION',
            requestTime,
          });
        }
        if (job.status === 'REVISION_REQUESTED') {
          return this.materializeCurrentSubmissionIfBreached(tx, {
            ...scope,
            job,
            source: 'TRANSITION',
            requestTime,
          });
        }
        return null;
      }
      default:
        return null;
    }
  }

  private intentClaim(
    actor: JobCardActor,
    jobCardId: string,
    clientActionId: string,
    definition: LifecycleDefinition,
    input: { expectedVersion: number },
    startLocation?: LifecycleLocationCapture,
  ): LifecycleIntentClaim {
    return {
      organizationId: actor.organizationId,
      userId: actor.id,
      clientActionId,
      operationKey: `${definition.operationKey}:${jobCardId}`,
      command: definition.command,
      expectedVersion: input.expectedVersion,
      // JobCard critical-action request identity (AUDIT-0 remediation, F5):
      // expectedVersion is a concurrency precondition and part of the
      // semantic request.
      requestHash: lifecycleRequestHash({
        command: definition.command,
        jobCardId,
        expectedVersion: input.expectedVersion,
        note: definition.note,
        revisionReason: definition.revisionReason,
        cancelReason: definition.cancelReason,
        followUpProposal: definition.followUpProposal ?? null,
        approveFollowUp: definition.approveFollowUp ?? null,
        locationCapture: startLocation ?? null,
      }),
    };
  }

  /**
   * Normalize + validate a follow-up proposal against the source Job and the
   * acting role. Shared by Staff submission and Manager approval so the
   * mandatory invariant has one server-side truth.
   */
  private async validateFollowUpProposal(
    actor: JobCardActor,
    job: JobCard,
    input: FollowUpProposalInput | undefined,
    requestTime: Date,
    lockedAssignees: ReadonlyMap<string, JobCardAssignee>,
    context: {
      followUpRequired: boolean;
      meetingAt: string | null;
      enforceMinimumLead?: boolean;
    } = { followUpRequired: false, meetingAt: null },
  ): Promise<ValidatedFollowUpProposal> {
    if (!input || typeof input !== 'object') {
      throw new AppError('FOLLOW_UP_PROPOSAL_REQUIRED', 400, 'Takip işi planı zorunludur.');
    }
    const scheduled = isoInstant(input.scheduledAt, 'followUpProposal.scheduledAt');
    const scheduledAt = new Date(scheduled);
    if (scheduledAt.valueOf() <= requestTime.valueOf()) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        400,
        'Takip işi planı için gelecek bir tarih zorunludur.',
      );
    }
    if (context.enforceMinimumLead !== false) {
      assertFollowUpMinimumLead({
        meetingAt: context.meetingAt,
        requestTime,
        scheduledAt,
      });
    }
    // WEEKLY_REPORT stays closed: no public creation path exists yet, so it
    // must never be proposed (or built) as a follow-up child.
    if (input.type === 'WEEKLY_REPORT'
      || !(JOB_CARD_TYPES as readonly string[]).includes(input.type)) {
      throw new AppError('FOLLOW_UP_PROPOSAL_INVALID', 400, 'Takip işi türü geçersizdir.');
    }
    if (context.followUpRequired && input.type !== 'SALES_MEETING') {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        400,
        'Müşteri ziyareti takip işi Sales Meeting olmalıdır.',
      );
    }
    if (actor.role === 'STAFF' && input.type !== defaultFollowUpType(job.type)) {
      throw new AppError('FORBIDDEN', 403, 'Personel takip işi türünü değiştiremez.');
    }
    if (job.customerId === null && input.type !== 'GENERAL_TASK') {
      throw new AppError(
        'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED',
        409,
        'Bu takip işi türü için kaynak JobCard müşteriye bağlı olmalıdır.',
      );
    }
    const assignee = lockedAssignees.get(input.assignedTo);
    if (!assignee) {
      throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    }
    assertCanCreateForAssignee(actor, assignee);
    const followUpInstructions = boundedTrimmedString(
      input.followUpInstructions,
      'followUpProposal.followUpInstructions',
      1,
      4_000,
    );
    // WORKING-DAY contract reconciliation: this is the shared seam for Staff
    // submission and Manager approval, i.e. an explicit human choice. A
    // human-supplied organization-local Sunday is accepted and persisted
    // verbatim — including approving a persisted human-origin (STAFF_ADJUSTED)
    // Sunday proposal. The automatic candidate generator still never proposes
    // Sunday, so a SYSTEM proposal arrives here already working-day valid.
    return {
      scheduledAt,
      type: input.type,
      assignedTo: input.assignedTo,
      followUpInstructions,
      assignee,
    };
  }

  /** Caller holds the Customer row lock, after User/JobCard locks. */
  private async assertCustomerVisitUnique(
    tx: JobCardTransaction,
    actor: JobCardActor,
    input: {
      customerId: string | null; jobType: JobCardType; proposedAt: Date | null;
      scheduledEndsAt?: string | null; assignedTo: string;
      engagementKind: JobCardEngagementKind | null; excludeJobId?: string;
    },
  ): Promise<void> {
    if (input.jobType !== 'SALES_MEETING' || input.customerId === null
      || input.proposedAt === null || input.engagementKind === null) return;
    const startsAt = input.proposedAt.toISOString();
    const endsAt = input.scheduledEndsAt ?? canonicalScheduledEnd('SALES_MEETING', startsAt);
    if (endsAt === null) throw validation('scheduledAt');
    const duplicate = await tx.findCustomerVisitDuplicate({
      organizationId: actor.organizationId, customerId: input.customerId,
      assignedTo: input.assignedTo, engagementKind: input.engagementKind,
      startsAt, endsAt, excludeJobId: input.excludeJobId,
    });
    if (duplicate) throw new AppError(
      'CUSTOMER_VISIT_DUPLICATE', 409,
      'Aynı müşteri, personel ve ziyaret türü için bu saat aralığında zaten bir plan bulunuyor.',
      { conflicts: actor.role === 'STAFF' ? [] : [duplicate] },
    );
  }

  /** Duplicate authorization and frequency observation remain independent. */
  private async assessCustomerSchedule(
    tx: JobCardTransaction,
    actor: JobCardActor,
    input: {
      customerId: string | null; proposedAt: Date | null; jobType: JobCardType;
      scheduledEndsAt?: string | null; assignedTo: string;
      engagementKind: JobCardEngagementKind | null; excludeJobId?: string;
    },
  ): Promise<CustomerFrequencyAdvisory | null> {
    await this.assertCustomerVisitUnique(tx, actor, input);
    if (input.proposedAt === null) return null;
    const evaluation = await evaluateCustomerSchedule({
      reader: tx, organizationId: actor.organizationId, ...input, proposedAt: input.proposedAt, now: this.now(),
    });
    return evaluation.frequencyCount > FREQUENT_VISIT_ADVISORY_THRESHOLD
      ? { source: 'SYSTEM', windowDays: FREQUENT_VISIT_WINDOW_DAYS, countIncludingCandidate: evaluation.frequencyCount }
      : null;
  }

  private async resolveApproveFollowUp(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    input: ApproveFollowUpInput | undefined,
    requestTime: Date,
    lockedAssignees: ReadonlyMap<string, JobCardAssignee>,
  ): Promise<{
    proposal: ValidatedFollowUpProposal;
    priority: JobCardPriority;
    dueDate: string | null;
  } | null> {
    const meetingDetails = job.type === 'SALES_MEETING'
      ? await tx.getSubmissionMeetingDetails(actor.organizationId, job.id)
      : null;
    const followUpRequired = requiresMandatoryFollowUpProposal({
      ...job,
      ...meetingDetails,
    });
    const persisted = job.followUpProposedAt !== null
      && job.followUpProposedType !== null
      && job.followUpProposedAssignee !== null
      && job.followUpProposalInstructions !== null;
    if (!persisted && !input) {
      if (followUpRequired) {
        throw new AppError('FOLLOW_UP_PROPOSAL_REQUIRED', 400, 'Takip işi planı zorunludur.');
      }
      return null;
    }
    if (!followUpRequired && !persisted && input) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        400,
        'Bu iş türü için takip işi planı desteklenmiyor.',
      );
    }
    const managerProvidedSchedule = input?.scheduledAt !== undefined;
    if (followUpRequired
      && persisted
      && job.followUpProposalOrigin === 'SYSTEM'
      && !managerProvidedSchedule) {
      // D1: omitting scheduledAt keeps server-side automatic slot selection,
      // but manager-supplied semantic overrides (type/assignee/instructions)
      // remain authoritative — the same merge the persisted-proposal branch
      // below applies. Availability, authorization, and locking therefore run
      // against the final overridden values, never stale persisted ones.
      const proposal = await this.autoScheduleFollowUpProposal(
        tx,
        actor,
        job,
        requestTime,
        meetingDetails?.meetingAt ?? null,
        true,
        {
          type: input?.type ?? job.followUpProposedType!,
          assignedTo: input?.assignedTo ?? job.followUpProposedAssignee!,
          followUpInstructions: input?.followUpInstructions ?? job.followUpProposalInstructions!,
        },
        new Date(job.followUpProposedAt!),
        lockedAssignees,
      );
      return {
        proposal,
        priority: normalizePriority(input?.priority),
        dueDate: normalizeFollowUpDueDate(input?.dueDate, proposal.type),
      };
    }
    const proposalInput = managerProvidedSchedule
      ? input
      : (persisted ? {
        scheduledAt: job.followUpProposedAt!,
        type: input?.type ?? job.followUpProposedType!,
        assignedTo: input?.assignedTo ?? job.followUpProposedAssignee!,
        followUpInstructions: input?.followUpInstructions ?? job.followUpProposalInstructions!,
      } : undefined);
    const proposal = await this.validateFollowUpProposal(
      actor,
      job,
      proposalInput,
      requestTime,
      lockedAssignees,
      {
        followUpRequired,
        meetingAt: meetingDetails?.meetingAt ?? null,
        // Proposals persisted before the 15-minute policy are legacy data;
        // approving them must remain backward compatible. New/edited proposals
        // are validated at submission or when the Manager supplies an override.
        enforceMinimumLead: input !== undefined || !persisted,
      },
    );
    const priority = normalizePriority(input?.priority);
    const dueDate = normalizeFollowUpDueDate(input?.dueDate, proposal.type);
    if (job.customerId !== null) {
      const customer = await tx.getCustomerForUpdate(actor.organizationId, job.customerId);
      if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    }
    return { proposal, priority, dueDate };
  }

  private async autoScheduleFollowUpProposal(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    requestTime: Date,
    meetingAt: string | null,
    lockCustomer: boolean,
    input?: FollowUpProposalInput,
    preferredAt?: Date,
    lockedAssignees?: ReadonlyMap<string, JobCardAssignee>,
  ): Promise<ValidatedFollowUpProposal> {
    const type = input?.type ?? defaultFollowUpType(job.type);
    if (!(JOB_CARD_TYPES as readonly string[]).includes(type) || type !== 'SALES_MEETING') {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        400,
        'Müşteri ziyareti takip işi Sales Meeting olmalıdır.',
      );
    }
    if (actor.role === 'STAFF' && type !== defaultFollowUpType(job.type)) {
      throw new AppError('FORBIDDEN', 403, 'Personel takip işi türünü değiştiremez.');
    }
    if (job.customerId === null) {
      throw new AppError(
        'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED',
        409,
        'Bu takip işi türü için kaynak JobCard müşteriye bağlı olmalıdır.',
      );
    }
    const assignedTo = input?.assignedTo ?? job.assignedTo;
    const assignee = lockedAssignees?.get(assignedTo);
    if (!assignee) {
      throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    }
    assertCanCreateForAssignee(actor, assignee);
    if (lockCustomer && job.customerId !== null) {
      const customer = await tx.getCustomerForUpdate(actor.organizationId, job.customerId);
      if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    }

    const policyEarliestAt = earliestFollowUpAllowedAt({
      meetingAt: meetingAt === null ? null : new Date(meetingAt),
      requestAt: requestTime,
    });
    const timezone = await tx.getOrganizationTimezone(actor.organizationId);
    // Target-first automatic scheduling (TARGET_TOLERANCE=NONE): the desired
    // start is the persisted SYSTEM target when re-running at Manager
    // approval, otherwise the +7-day policy target. The effective start never
    // precedes the 15-minute floor, and the 30-day horizon stays anchored to
    // the floor so target-first search cannot shift the envelope forward.
    const desiredTargetAt = preferredAt
      ?? suggestedFollowUpInstant({
        evaluatedAt: requestTime,
        sourceScheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
        timezone,
        durationMs: canonicalScheduledDurationMs(type),
      });
    const effectiveTargetAt = desiredTargetAt.valueOf() > policyEarliestAt.valueOf()
      ? desiredTargetAt
      : policyEarliestAt;
    // Lazy candidate selection: only the actually inspected prefix of the
    // 30-day horizon is ever generated. Snapshot bounds come from a constant
    // search envelope instead of the last materialized candidate, so the
    // iterator is never exhausted merely to discover query bounds.
    const durationMs = canonicalScheduledDurationMs(type);
    if (durationMs === null) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        409,
        'Otomatik takip zamanı bulunamadı. Lütfen tarihi manuel seçin.',
      );
    }
    const horizonAt = resolveFollowUpSearchHorizonAt(policyEarliestAt, timezone);
    if (effectiveTargetAt.valueOf() >= horizonAt.valueOf()) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        409,
        'Otomatik takip zamanı bulunamadı. Lütfen tarihi manuel seçin.',
      );
    }
    const slotCandidates = iterateFollowUpSlotCandidates({
      earliestAllowedAt: effectiveTargetAt,
      horizonAnchorAt: policyEarliestAt,
      type,
      timezone,
    });
    const firstSlot = slotCandidates.next();
    if (firstSlot.done) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        409,
        'Otomatik takip zamanı bulunamadı. Lütfen tarihi manuel seçin.',
      );
    }
    const firstCandidate = firstSlot.value;

    const assigneeIntervals = await tx.listAssigneeCalendarIntervals(
      actor.organizationId,
      assignedTo,
      firstCandidate.startsAt,
      new Date(horizonAt.valueOf() + durationMs),
      job.id,
    );
    const blockers = assigneeIntervals.map((interval) => ({
      startsAt: new Date(interval.startsAt),
      endsAt: new Date(interval.endsAt),
    }));
    let current: IteratorResult<AvailableSlotCandidate, void> = { done: false, value: firstCandidate };
    while (!current.done) {
      const candidate = current.value;
      if (!isFollowUpSlotBlocked(candidate, blockers)) {
        return {
          scheduledAt: candidate.startsAt,
          type,
          assignedTo,
          followUpInstructions: input === undefined
            ? defaultFollowUpInstructions(job.title)
            : boundedTrimmedString(
              input.followUpInstructions,
              'followUpProposal.followUpInstructions',
              1,
              4_000,
            ),
          assignee,
        };
      }
      current = slotCandidates.next();
    }
    throw new AppError(
      'FOLLOW_UP_PROPOSAL_INVALID',
      409,
      '30 günlük aralıkta uygun takip zamanı bulunamadı. Lütfen tarihi manuel seçin.',
    );
  }

  private projectEvaluation(
    actor: JobCardActor,
    evaluation: CustomerScheduleEvaluation,
  ): RoleProjectedCustomerScheduleEvaluation {
    if (actor.role === 'STAFF') {
      return { level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null };
    }

    return {
      level: evaluation.level,
      safeMessage: evaluation.safeMessage,
      conflicts: evaluation.conflicts,
      recentVisit: evaluation.recentVisit === null
        ? null
        : {
            ...evaluation.recentVisit,
            resultSummary: evaluation.recentVisit.resultSummary === null
              ? null
              : Array.from(evaluation.recentVisit.resultSummary).slice(0, 200).join(''),
          },
      suggestedAlternativeAt: evaluation.suggestedAlternativeAt,
    };
  }

  async getFollowUpSuggestion(
    actor: JobCardActor,
    jobCardId: string,
    at?: string,
  ): Promise<FollowUpSuggestion> {
    const detail = await this.detail(actor, jobCardId);
    const completedPostHoc = detail.status === 'COMPLETED';
    if (completedPostHoc) {
      // Post-hoc suggestions use the same management authorization as the
      // mutating createFollowUp path. Staff may still use this endpoint for
      // non-terminal mandatory proposal flows below.
      assertCanCreateFollowUp(actor);
    } else if (isTerminalJobStatus(detail.status)) {
      throw new AppError('INVALID_TRANSITION', 409, 'Bu iş için takip önerisi oluşturulamaz.');
    }
    const meetingDetails = detail.type === 'SALES_MEETING'
      ? await this.repository.findMeetingDetails(actor.organizationId, detail.id)
      : null;
    if (at === undefined && !completedPostHoc && !requiresMandatoryFollowUpProposal({
      ...detail,
      ...meetingDetails,
    })) {
      throw new AppError(
        'FOLLOW_UP_PROPOSAL_INVALID',
        400,
        'Bu iş türü için takip işi önerisi bulunmuyor.',
      );
    }
    const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
    const defaultFields: FollowUpProposalFields = {
      scheduledAt: suggestedFollowUpInstant({
        evaluatedAt: this.now(),
        sourceScheduledAt: detail.scheduledAt ? new Date(detail.scheduledAt) : null,
        timezone,
        durationMs: canonicalScheduledDurationMs(defaultFollowUpType(detail.type)),
      }),
      type: defaultFollowUpType(detail.type),
      assignedTo: detail.assignedTo,
      followUpInstructions: defaultFollowUpInstructions(detail.title),
    };
    const job: JobCard = {
      ...detail,
      sourceJobCardId: null,
      followUpInstructions: null,
    } as unknown as JobCard;

    if (at !== undefined) {
      const evaluatedAt = new Date(isoInstant(at, 'at'));
      const evaluation = await this.repository.executeTransaction((tx) => (
        evaluateCustomerSchedule({
          reader: tx,
          organizationId: actor.organizationId,
          customerId: detail.customerId,
          proposedAt: evaluatedAt,
          jobType: defaultFields.type,
          excludeJobId: detail.id,
          now: this.now(),
        })
      ));
      return {
        scheduledAt: null,
        type: defaultFields.type,
        assignedTo: defaultFields.assignedTo,
        followUpInstructions: defaultFields.followUpInstructions,
        evaluation: this.projectEvaluation(actor, evaluation),
      };
    }
    const fields = defaultFields;
    const finalEvaluation = await this.repository.executeTransaction((tx) => (
      evaluateCustomerSchedule({
        reader: tx,
        organizationId: actor.organizationId,
        customerId: job.customerId,
        proposedAt: fields.scheduledAt,
        jobType: fields.type,
        excludeJobId: job.id,
        now: this.now(),
      })
    ));
    return {
      scheduledAt: fields.scheduledAt.toISOString(),
      type: fields.type,
      assignedTo: fields.assignedTo,
      followUpInstructions: fields.followUpInstructions,
      evaluation: this.projectEvaluation(actor, finalEvaluation),
    };
  }

  async previewCustomerSchedule(
    actor: JobCardActor,
    input: CustomerSchedulePreviewInput,
  ): Promise<RoleProjectedCustomerScheduleEvaluation> {
    const proposedAt = new Date(isoInstant(input.scheduledAt, 'scheduledAt'));
    return this.repository.executeTransaction((tx) => this.previewInTransaction(tx, actor, input, proposedAt));
  }

  async availableSlots(
    actor: JobCardActor,
    input: AvailableSlotsInput,
  ): Promise<AvailableSlotsResponse> {
    if (!this.calendar.enabled) {
      throw new AppError('NOT_FOUND', 404, 'Takvim özelliği etkin değil.');
    }
    assertCreateAssignmentRequest(actor, input.assignedTo);
    const startsAt = new Date(isoInstant(input.scheduledAt, 'scheduledAt'));
    const canonicalEnd = canonicalScheduledEnd(input.type, input.scheduledAt);
    if (canonicalEnd === null) throw validation('scheduledAt');
    const requestedEndsAt = input.scheduledEndsAt === undefined
      ? null
      : new Date(isoInstant(input.scheduledEndsAt, 'scheduledEndsAt'));
    if (input.jobCardId === null || input.jobCardId === undefined) {
      if (requestedEndsAt !== null && requestedEndsAt.toISOString() !== canonicalEnd) {
        throw validation('scheduledEndsAt');
      }
    }
    const endsAt = requestedEndsAt ?? new Date(canonicalEnd);
    if (!isOnSiteJobType(input.type)) {
      throw validation('scheduledEndsAt');
    }
    return this.repository.executeTransaction((tx) => (
      this.availableSlotsInTransaction(tx, actor, input, startsAt, endsAt)
    ));
  }

  private async availableSlotsInTransaction(
    tx: JobCardTransaction,
    actor: JobCardActor,
    input: AvailableSlotsInput,
    startsAt: Date,
    endsAt: Date,
  ): Promise<AvailableSlotsResponse> {
    let excludeJobId: string | undefined;
    let effectiveEndsAt = endsAt;
    if (input.jobCardId !== null && input.jobCardId !== undefined) {
      const job = await tx.getJob(actor.organizationId, input.jobCardId);
      if (!job
        || job.organizationId !== actor.organizationId
        || !isOnSiteJobType(job.type)
        || job.type !== input.type
        || job.customerId !== input.customerId) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      try {
        assertCanEdit(actor, job);
      } catch {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      excludeJobId = job.id;
      const persistedDurationMs = persistedScheduledDurationMs(
        job.scheduledAt,
        job.scheduledEndsAt,
      );
      if (persistedDurationMs !== null && persistedDurationMs > 0) {
        effectiveEndsAt = new Date(startsAt.valueOf() + persistedDurationMs);
      }
    }
    if (effectiveEndsAt.valueOf() <= startsAt.valueOf()) throw validation('scheduledEndsAt');
    const assignee = await tx.getAssignee(actor.organizationId, input.assignedTo);
    if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    assertCanCreateForAssignee(actor, assignee);
    if (!(await tx.customerExists(actor.organizationId, input.customerId))) {
      throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    }

    const timezone = await tx.getOrganizationTimezone(actor.organizationId);
    const candidates = generateAvailableSlotCandidates({
      startsAt,
      endsAt: effectiveEndsAt,
      timezone,
      horizonDays: FOLLOW_UP_SEARCH_HORIZON_DAYS,
    });
    if (candidates.length === 0) return { slots: [] };

    const lastCandidate = candidates[candidates.length - 1]!;
    const assigneeIntervals = await tx.listAssigneeCalendarIntervals(
      actor.organizationId, input.assignedTo,
      new Date(startsAt.valueOf() - MAX_TZ_OFFSET_MS),
      new Date(lastCandidate.endsAt.valueOf() + MAX_TZ_OFFSET_MS),
      excludeJobId ?? null,
    );
    const available = filterAvailableSlotCandidates(
      candidates,
      assigneeIntervals.map((interval) => ({
        startsAt: new Date(interval.startsAt),
        endsAt: new Date(interval.endsAt),
      })),
    );
    return {
      slots: available.map((slot) => ({
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      })),
    };
  }

  private async previewInTransaction(
    tx: JobCardTransaction,
    actor: JobCardActor,
    input: CustomerSchedulePreviewInput,
    proposedAt: Date,
  ): Promise<RoleProjectedCustomerScheduleEvaluation> {
    let excludeJobId: string | undefined;
    if (input.jobCardId !== null && input.jobCardId !== undefined) {
      // Never trust a client-supplied exclude id. Load the Job under the same
      // organization and confirm the actor may reach it; derive excludeJobId
      // server-side from the authorized Job.
      const job = await tx.getJob(actor.organizationId, input.jobCardId);
      if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
        throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      }
      excludeJobId = job.id;
    }
    if (input.customerId !== null) {
      const exists = await tx.customerExists(actor.organizationId, input.customerId);
      if (!exists) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
    }
    const evaluation = await evaluateCustomerSchedule({
      reader: tx,
      organizationId: actor.organizationId,
      customerId: input.customerId,
      proposedAt,
      jobType: input.type,
      engagementKind: input.engagementKind,
      excludeJobId,
      now: this.now(),
    });
    return this.projectEvaluation(actor, evaluation);
  }

  private async resolveStartLocation(input: {
    organizationId: string;
    actorUserId: string;
    capture: StartLocationCapture;
    correlationId: string;
  }): Promise<JobActionLocationCapture> {
    const { capture, correlationId, organizationId, actorUserId } = input;
    if (capture.outcome === 'UNAVAILABLE') return capture;
    const base = {
      ...capture,
      neighborhood: null as string | null,
      district: null as string | null,
      city: null as string | null,
      approximateLabel: null as string | null,
      geocodingProvider: null as 'GOOGLE' | null,
    };
    if (capture.accuracyMeters > 1_000) {
      return { ...base, geocodingStatus: 'NOT_REQUESTED' };
    }

    const quotaGuard = this.geolocation.quotaGuard;
    if (quotaGuard) {
      const decision = await quotaGuard.reserve({
        provider: 'GOOGLE',
        organizationId,
        actorUserId,
        now: this.now(),
      });
      if (!decision.allowed) {
        return { ...base, geocodingStatus: 'FAILED' };
      }
    }

    try {
      // Google adapter owns AbortController timeout. Optional safety race remains
      // only when reverseGeocoderTimeoutMs is explicitly provided (unit tests).
      const timeoutMs = this.geolocation.reverseGeocoderTimeoutMs;
      const reversePromise = this.geolocation.reverseGeocoder!.reverse({
        latitude: capture.latitude,
        longitude: capture.longitude,
        accuracyMeters: capture.accuracyMeters,
        correlationId,
      });
      let address;
      if (timeoutMs === undefined) {
        address = await reversePromise;
      } else {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          address = await Promise.race([
            reversePromise,
            new Promise<never>((_resolve, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error('Reverse geocoder timed out')),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      }
      return {
        ...base,
        ...address,
        geocodingStatus: 'RESOLVED',
        geocodingProvider: 'GOOGLE',
      };
    } catch {
      return {
        ...base,
        geocodingStatus: 'FAILED',
        geocodingProvider: 'GOOGLE',
      };
    }
  }

  private async presentDetail(
    reader: SubmissionReader & Pick<JobCardRepository, 'getFollowUpSource'>,
    actor: JobCardActor,
    persisted: PersistedJobCardDetail,
    evaluatedAt: Date,
    precomputed?: SubmissionEvaluation,
  ): Promise<JobCardDetail> {
    const { lifecycle, ...persistedJob } = persisted;
    const {
      sourceJobCardId,
      followUpInstructions,
      ...job
    } = persistedJob;
    const readinessStatuses: JobCardStatus[] = [
      'IN_PROGRESS', 'REVISION_REQUESTED', 'WAITING_APPROVAL',
    ];
    const evaluation = readinessStatuses.includes(job.status)
      ? precomputed ?? await evaluateSubmission(reader, actor, persistedJob, evaluatedAt)
      : null;
    const allowedCommands = getAllowedLifecycleCommands(actor, persistedJob, evaluatedAt);
    let followUpContext: JobCardDetail['followUpContext'] = null;
    if (sourceJobCardId != null) {
      if (followUpInstructions == null) followUpInvariantViolation();
      const source = await reader.getFollowUpSource(actor.organizationId, sourceJobCardId);
      if (!source || source.managerApprovedAt === null) followUpInvariantViolation();
      if (source.customerId !== null && source.customer === null) followUpInvariantViolation();
      if (source.contactId !== null && source.contact === null) followUpInvariantViolation();
      const sourceAccess = resolveSourceAccess(actor, source);
      const sourceSummary: FollowUpSourceSummary = {
        sourceType: source.type,
        sourcePlannedAt: source.scheduledAt,
        sourceOccurredAt: (source.type === 'SALES_MEETING'
          ? source.meetingAt
          : source.startedAt) ?? source.staffCompletedAt,
        sourceCompletedAt: source.managerApprovedAt,
        customer: source.customer,
        contact: source.contact,
        outcome: source.type === 'SALES_MEETING' ? source.outcome : null,
      };
      followUpContext = {
        sourceJobCardId,
        followUpInstructions,
        sourceAccess,
        sourceJobPath: sourceAccess === 'FULL' ? `/jobs/${sourceJobCardId}` : null,
        sourceSummary,
      };
    }
    let followUpProposal: FollowUpProposal | null = null;
    if (job.followUpProposedAt != null
      && job.followUpProposedType != null
      && job.followUpProposedAssignee != null
      && job.followUpProposalInstructions != null) {
      if (!persisted.proposer) followUpInvariantViolation();
      followUpProposal = {
        scheduledAt: job.followUpProposedAt,
        type: job.followUpProposedType,
        assignedTo: job.followUpProposedAssignee,
        followUpInstructions: job.followUpProposalInstructions,
        origin: job.followUpProposalOrigin ?? 'SYSTEM',
        proposedBy: persisted.proposer,
      };
    }
    return {
      ...job,
      workflowContext: {
        allowedCommands,
        allowedActions: getAllowedJobActions(actor, persistedJob),
        startLocationCaptureEnabled: this.geolocation.enabled
          && actor.role === 'STAFF'
          && allowedCommands.includes('START'),
        lifecycle,
        submissionReadiness: evaluation?.readiness ?? null,
      },
      followUpContext,
      followUpProposal,
    };
  }

  private presentFollowUpListItem(
    actor: JobCardActor,
    item: PersistedFollowUpListItem,
    evaluatedAt = this.now(),
  ) {
    const { sourceJobCardId, ...job } = item;
    return {
      ...this.presentListItem(actor, job, evaluatedAt),
      followUp: { sourceJobCardId },
    };
  }

  private presentListItem(
    actor: JobCardActor,
    item: PersistedJobCardListItem,
    evaluatedAt = this.now(),
  ): JobCardListItem {
    const subject: JobPermissionSubject = {
      organizationId: actor.organizationId,
      type: item.type,
      status: item.status,
      assignedTo: item.assignee.id,
      scheduledAt: item.scheduledAt,
    };
    return { ...item, allowedCommands: getAllowedLifecycleCommands(actor, subject, evaluatedAt) };
  }

}
