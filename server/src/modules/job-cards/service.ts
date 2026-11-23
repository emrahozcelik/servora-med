import { uuidString } from './validation.js';
import { AppError } from '../../errors/index.js';
import { isManagementRole } from '../auth/types.js';
import { randomUUID } from 'node:crypto';
import { presentActivity } from './activity-presenter.js';
import { JobCardSaleService } from './sale-service.js';
import { parseDeliveryQuantity } from './delivery-input.js';
import {
  assertCanCreateForAssignee,
  assertCanCreateFollowUp,
  assertCanListFollowUps,
  assertCanInvalidate,
  assertCanListOpenSubmissionLate,
  assertCanReadOverdueIncidentHistory,
  assertCanSendSubmissionReminder,
  assertCanGrantEarlyStartAuthorization,
  assertCanCreateChangeRequest,
  assertCanResolveChangeRequest,
  assertCanListOpenChangeRequests,
  assertCanReofferAssignment,
  assertCanListAssignmentOffersNeedingAction,
  assertCanListUnacceptedPastStart,
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
  JobDeliveryScope,
  JobLifecycleInstants,
  LifecycleIntentClaim,
  LifecycleIntentReservation,
  NotePageQuery,
  PageQuery,
  ProductReference,
  PersistedFollowUpListItem,
  SubmissionReader,
  AssignmentOfferRecord,
} from './repository.js';
import {
  deliveryItemCreateRequestHash,
  earlyStartAuthorizationRequestHash,
  changeRequestCreateRequestHash,
  changeRequestResolveRequestHash,
  followUpCreateRequestHash,
  jobCardCreateRequestHash,
  lifecycleRequestHash,
  meetingDetailsUpdateRequestHash,
  productDeliveryCreateRequestHash,
  reofferAssignmentRequestHash,
  type LifecycleLocationCapture,
} from './critical-action-request-hash.js';
import {
  assignmentOfferRequiredState,
  decideAssignmentOfferOpen,
  isAcceptanceOnTime,
  isAssignmentOfferEligible,
  isAssignmentOfferJobType,
} from './assignment-offer-policy.js';
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
  type MeetingOutcome,
  type PersistedJobCardDetail,
  type PersistedJobCardListItem,
  type PaginatedOverdueIncidentHistory,
  type SubmissionLatenessSnapshot,
  type OpenSubmissionLateItem,
  LIFECYCLE_INTENT_TTL_MS_DEFAULT,
  MEETING_DETAIL_FIELDS,
  type MeetingDetails,
  type MeetingDetailsCandidate,
  type MeetingDetailsContact,
  type MeetingDetailsLegacyResponse,
  type MeetingDetailsReaderResponse,
  type MeetingDetailsView,
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
  type EarlyStartAuthorizationInput,
  type EarlyStartAuthorizationReceipt,
  type CreateChangeRequestInput,
  type CreateChangeRequestReceipt,
  type ResolveChangeRequestInput,
  type ResolveChangeRequestReceipt,
  type OpenChangeRequestItem,
  type JobChangeRequestDecision,
  type JobChangeRequestReasonCode,
  type AssignmentOfferDecisionInput,
  type JobAssignmentOfferOpenedReason,
  type JobAssignmentOfferState,
  type JobAssignmentOfferSummary,
  type JobAssignmentOfferUrgentReason,
  type JobAssignmentOfferWithdrawReasonCode,
  type JobAssignmentOfferView,
  type NeedsActionAssignmentOfferItem,
  type UnacceptedPastStartItem,
  type PastStartAcknowledgementInput,
  type ReofferAssignmentInput,
  type ReofferAssignmentReceipt,
  JOB_CHANGE_REQUEST_DECISIONS,
  JOB_CHANGE_REQUEST_REASON_CODES,
  JOB_ASSIGNMENT_OFFER_DECLINE_REASON_CODES,
} from './types.js';
import {
  jobCardInvalidationRequestHash,
} from './invalidation-input.js';
import {
  isoInstant,
  optionalBoundedString,
  optionalLifecycleNote,
  requireActionId,
  requireLifecycleReason,
  requireSubmissionNote,
  validation,
  boundedTrimmedString,
  codePointLength,
} from './validation.js';
import {
  normalizeFollowUpDueDate,
  parsePastStartAcknowledgement,
  priority as normalizePriority,
} from './create-input.js';
import { localDateKey } from './local-calendar.js';
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
  weeklyReportDueDate,
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
import {
  parseWeeklyReportRemovalInput, weeklyReportRemovalRequestHash,
  type WeeklyReportRemovalInput,
} from '../weekly-reports/removal-input.js';
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
  followUpTargetInstant,
  assertFollowUpCancelContinuity,
  parseFollowUpCancelContinuity,
  requiresMandatoryFollowUpProposal,
  type FollowUpCancelContinuity,
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
  parseActionLocationCapture,
  parseStartLocationCapture,
  type ActionLocationCapture,
  type StartLocationCapture,
} from './start-location-input.js';
import type {
  JobActionLocationAction,
  JobActionLocationCapture,
  JobActionLocationComparison,
} from './location-types.js';
import {
  DEFAULT_SUBMIT_LOCATION_MAX_RELIABLE_ACCURACY_METERS,
  DEFAULT_SUBMIT_LOCATION_WARNING_DISTANCE_METERS,
  classifySubmitLocationComparison,
  haversineMeters,
  type SubmitLocationComparisonPolicy,
} from './submit-location-comparison.js';
import type { ReverseGeocodingQuotaGuard } from '../geocoding/reverse-geocoding-quota.js';
import type { NotificationDraft } from '../notifications/types.js';
import { normalizeExpiryDate } from './delivery-input.js';
import {
  CORRECTION_DEADLINE_DEFAULT_HOURS,
  CORRECTION_DEADLINE_MAX_DAYS,
  CORRECTION_DEADLINE_MIN_HOURS,
  effectiveSubmissionDeadlineAt,
  lateStartDeadlineAt,
  submissionBreachInstant,
  type OverdueIncidentDelayType,
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
  /** JOB-010 release 2b: required when a direct producer opens a passed-start offer. */
  pastStartAcknowledgement?: PastStartAcknowledgementInput | null;
  /** OVR-5b §4.5: the reason of an extension that ends open lateness. */
  deadlineExtensionReason?: string | null;
  /** OVR-5b §4.11: resolve the job's OPEN change request in this same patch. */
  changeRequestResolution?: ChangeRequestResolutionInput | null;
};

/** OVR-5b §4.11: the atomic JOB-010 resolution carried by a deadline patch. */
type ChangeRequestResolutionInput = {
  changeRequestId: string;
  resolution: 'RESCHEDULED';
  note?: string | null;
};

/** OVR-5b §4.11: the only resolution a deadline patch may record. */
const PATCH_CHANGE_REQUEST_RESOLUTIONS = ['RESCHEDULED'] as const;

/** OVR-5b §4.11: the complete nested shape; no other key is accepted. */
const CHANGE_REQUEST_RESOLUTION_FIELDS: readonly string[] = [
  'changeRequestId', 'resolution', 'note',
];
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
type SubmitInput = LifecycleInput & { followUpProposal?: FollowUpProposalInput; locationCapture?: unknown };
type ApproveInput = LifecycleInput & { followUp?: ApproveFollowUpInput };
type StartInput = LifecycleInput & { locationCapture?: unknown };
type RevisionInput = LifecycleInput & {
  revisionReason: string;
  /** OVR-5b §3: optional management correction deadline (ISO instant). */
  correctionDueAt?: string | null;
};
type CancelInput = LifecycleInput & { cancelReason: string; followUpContinuity?: unknown };

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
  'engagementKind', 'overrideReason', 'pastStartAcknowledgement',
  // OVR-5b: deadline extension reason and atomic change-request resolution.
  'deadlineExtensionReason', 'changeRequestResolution',
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
  cancelContinuity?: FollowUpCancelContinuity | null;
  /** JOB-010 release 2b: the Staff decline/release reason, part of the hash. */
  assignmentReason?: { code: string; text: string } | null;
  /**
   * OVR-5b §3.8: normalized REQUEST_REVISION correction deadline. Undefined
   * when the client did not send it, so the request hash stays identical.
   */
  correctionDueAt?: string;
};

type OverdueRecoveryTarget = Pick<
  OverdueIncidentIdentity,
  'organizationId' | 'jobCardId' | 'delayType' | 'episodeNo'
>;

/** OVR-5b §4: the only delay types an authorized extension can end. */
type OpenDeadlineDelayType = Extract<
  OverdueIncidentDelayType,
  'LATE_START' | 'LATE_SUBMISSION'
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

type DeliveryProductSnapshot = Pick<ProductReference, 'id' | 'name' | 'sku' | 'model' | 'unit'>;

/**
 * Delivery product eligibility protects demo-purge graph integrity: a BUSINESS
 * JobCard must never reference a DEMO product (the purge would otherwise be
 * blocked by DEMO_PRODUCT_TO_BUSINESS_JOB), while a DEMO JobCard may keep a
 * BUSINESS product or use a DEMO product from its own dataset. Ineligible
 * references share the existing inactive/cross-organization concealment.
 */
function assertDeliveryProductEligible(job: JobDeliveryScope, product: ProductReference) {
  const eligible = job.dataClass === 'BUSINESS'
    ? product.dataClass === 'BUSINESS'
    : product.dataClass === 'BUSINESS' || product.demoDatasetId === job.demoDatasetId;
  if (!eligible) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
}

/**
 * Maps a delivery item to its persistence record. Callers validate a supplied
 * quantity with `parseDeliveryQuantity`; the patch path deliberately passes a
 * legacy current quantity through unchanged when no new quantity was supplied.
 */
function deliveryRecord(organizationId: string, jobCardId: string, input: DeliveryInput, product: DeliveryProductSnapshot): Omit<DeliveryItemRecord, 'id'> {
  const deliveredAt = parseDeliveredAt(input.deliveredAt);
  if (!DELIVERY_PURPOSES.includes(input.deliveryPurpose) || !input.productId) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  return { organizationId, jobCardId, productId: product.id, deliveryPurpose: input.deliveryPurpose,
    deliveredAt, quantity: input.quantity, unit: product.unit, productNameSnapshot: product.name,
    productSkuSnapshot: product.sku, productModelSnapshot: product.model, lotNo: input.lotNo?.trim() || null,
    serialNo: input.serialNo?.trim() || null, expiryDate: normalizeExpiryDate(input.expiryDate),
    deliveryNote: input.deliveryNote?.trim() || null };
}

const MAX_INITIAL_DELIVERY_ITEMS = 25;

type InitialDeliveryItem = { productId: string; quantity: number };

function assertInitialProductDeliveryItems(input: { items?: ReadonlyArray<InitialDeliveryItem> }) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_INITIAL_DELIVERY_ITEMS) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünleri geçersiz.');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.productId !== 'string' || !item.productId.trim()
      || seen.has(item.productId)) {
      throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünleri geçersiz.');
    }
    parseDeliveryQuantity(item.quantity, 'items.quantity');
    seen.add(item.productId);
  }
}

/**
 * Normalized delivery intent carried by a PRODUCT_DELIVERY follow-up. The
 * child JobCard and its initial lines are created in one transaction, so the
 * batch contract is validated exactly like a normal delivery create.
 */
function followUpDeliveryIntent(input: FollowUpCreateInput): {
  deliveryPurpose: DeliveryPurpose;
  deliveryNote: string | null;
  items: InitialDeliveryItem[];
} | null {
  if (input.type !== 'PRODUCT_DELIVERY') return null;
  if (input.deliveryPurpose === null || input.deliveryPurpose === undefined
    || !DELIVERY_PURPOSES.includes(input.deliveryPurpose)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Ürün teslimi oluşturma bilgileri geçersiz.');
  }
  const items = input.items ?? [];
  assertInitialProductDeliveryItems({ items });
  return {
    deliveryPurpose: input.deliveryPurpose,
    deliveryNote: input.deliveryNote ?? null,
    items,
  };
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
  submitLocationComparison: JobActionLocationComparison | null;
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
  // Slice 2: advisory comparison carried on the receipt. Tolerantly decoded:
  // rows persisted before Slice 2 (or non-SUBMIT commands) simply yield null.
  // Server-computed at finalize time; never client-supplied.
  const rawComparison = record.submitLocationComparison;
  let submitLocationComparison: JobActionLocationComparison | null = null;
  if (rawComparison && typeof rawComparison === 'object' && !Array.isArray(rawComparison)) {
    const candidate = rawComparison as Record<string, unknown>;
    if ((candidate.outcome === 'MATCH' || candidate.outcome === 'DIFFERENT'
        || candidate.outcome === 'UNRELIABLE')
      && typeof candidate.referenceActivityId === 'string'
      && typeof candidate.distanceMeters === 'number'
      && Number.isFinite(candidate.distanceMeters)
      && candidate.distanceMeters >= 0) {
      submitLocationComparison = {
        referenceActivityId: candidate.referenceActivityId,
        distanceMeters: candidate.distanceMeters,
        outcome: candidate.outcome,
      };
    }
  }
  return { jobCardId, evaluatedAt, followUpJobCardId, submitLocationComparison };
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

function meetingDetailsResponse(
  jobCardId: string,
  jobCardVersion: number,
  details: MeetingDetailsView,
): MeetingDetails {
  return {
    jobCardId,
    ...details,
    unsuccessfulReason: details.unsuccessfulReason ?? null,
    metContactId: details.metContactId ?? null,
    metContact: details.metContact ?? null,
    jobCardVersion,
  };
}

/**
 * Slice 3 reader projection. The canonical response (persisted in the
 * idempotency receipt) always carries the met-contact fields; this boundary
 * maps it to the requested reader shape:
 * - legacy readers never receive `metContactId`/`metContact`;
 * - opted-in readers always receive both keys, including replays of pre-056
 *   receipts that predate the met-contact column (truthfully `null`).
 */
function projectMeetingDetailsResponse(
  response: MeetingDetails | MeetingDetailsLegacyResponse,
  includeMetContact: boolean,
): MeetingDetailsReaderResponse {
  const carriesMetFields = Object.hasOwn(response, 'metContactId');
  if (includeMetContact === carriesMetFields) return response;
  if (!includeMetContact) {
    const { metContactId: _metContactId, metContact: _metContact, ...legacy } = response as MeetingDetails;
    return legacy;
  }
  return { ...response, metContactId: null, metContact: null };
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

// OVR-5b §3 / §4: the two correction-deadline validation failures keep their
// accepted field error and Turkish text in one place.
const CORRECTION_DUE_AT_SYNTAX_MESSAGE = 'Geçerli bir düzeltme son tarihi seçin.';
const CORRECTION_DUE_AT_BOUNDS_MESSAGE =
  'Düzeltme son tarihi en az 1 saat, en fazla 14 gün sonrası olmalı.';

function correctionDueAtError(message: string) {
  return new AppError('VALIDATION_ERROR', 400, message, {
    fieldErrors: { correctionDueAt: message },
  });
}

/** OVR-5b §4.11: every field-level change-request resolution failure. */
function changeRequestResolutionError(message: string) {
  return new AppError('VALIDATION_ERROR', 400, message, {
    fieldErrors: { changeRequestResolution: message },
  });
}

/**
 * OVR-5b §3.1 syntax gate. Runs before the lifecycle intent claim and the
 * request hash, so an invalid value never creates a reservation. An absent key
 * and an explicit `undefined` both mean "not sent": the hash then stays
 * byte-identical to a pre-5b REQUEST_REVISION.
 */
function revisionCorrectionDueAt(input: { correctionDueAt?: unknown }): string | undefined {
  const value = input.correctionDueAt;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw correctionDueAtError(CORRECTION_DUE_AT_SYNTAX_MESSAGE);
  try {
    return isoInstant(value, 'correctionDueAt');
  } catch {
    throw correctionDueAtError(CORRECTION_DUE_AT_SYNTAX_MESSAGE);
  }
}

/**
 * OVR-5b §4.5: the optional deadline-extension reason. Missing, explicit
 * `undefined` and blank all mean "no reason"; a non-string or more than 500
 * trimmed code points is a validation failure whenever a value is supplied.
 */
function patchDeadlineExtensionReason(input: { deadlineExtensionReason?: unknown }): string | null {
  const value = input.deadlineExtensionReason;
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    const message = 'Tarih değişikliği gerekçesi geçersiz.';
    throw new AppError('VALIDATION_ERROR', 400, message, {
      fieldErrors: { deadlineExtensionReason: message },
    });
  }
  const trimmed = value.trim();
  if (codePointLength(trimmed) > 500) {
    const message = 'Tarih değişikliği gerekçesi en fazla 500 karakter olabilir.';
    throw new AppError('VALIDATION_ERROR', 400, message, {
      fieldErrors: { deadlineExtensionReason: message },
    });
  }
  return trimmed === '' ? null : trimmed;
}

/**
 * OVR-5b §4.11: the atomic change-request resolution carried by a deadline
 * patch. Shape errors are always the field-level validation failure; whether
 * the request exists, belongs to this job and is still open is decided under
 * the locks. Only the three accepted keys exist: an unknown nested key would
 * otherwise be silently dropped by a direct caller.
 */
function patchChangeRequestResolution(
  input: { changeRequestResolution?: unknown },
): ChangeRequestResolutionInput | null {
  if (!Object.hasOwn(input, 'changeRequestResolution')) return null;
  const message = 'Değişiklik talebi sonuçlandırma bilgisi geçersiz.';
  const fail = () => changeRequestResolutionError(message);
  const raw = input.changeRequestResolution;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CHANGE_REQUEST_RESOLUTION_FIELDS.includes(key))) {
    throw fail();
  }
  try {
    uuidString(record.changeRequestId, 'changeRequestResolution');
  } catch {
    throw fail();
  }
  if (typeof record.resolution !== 'string'
    || !(PATCH_CHANGE_REQUEST_RESOLUTIONS as readonly string[]).includes(record.resolution)) {
    throw fail();
  }
  const note = record.note;
  if (note !== undefined && note !== null && typeof note !== 'string') throw fail();
  const trimmedNote = typeof note === 'string' ? note.trim() : null;
  if (trimmedNote !== null && codePointLength(trimmedNote) > 2_000) throw fail();
  return {
    changeRequestId: record.changeRequestId as string,
    resolution: 'RESCHEDULED',
    note: trimmedNote === null || trimmedNote === '' ? null : trimmedNote,
  };
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
  private readonly saleService: JobCardSaleService;

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
      submitLocationWarningDistanceMeters?: number;
      submitLocationMaxReliableAccuracyMeters?: number;
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
    /**
     * JOB-010 release 2b: the assignment acceptance window. Off by default, so
     * a deployment that never sets JOB_ASSIGNMENT_WINDOW_ENABLED keeps the
     * release 2a behaviour exactly.
     */
    private readonly assignmentWindow: Readonly<{
      enabled: boolean;
    }> = { enabled: false },
  ) {
    this.notesService = new JobCardNotesService(repository);
    this.saleService = new JobCardSaleService(repository, now,
      (tx, job, activity, event, actorId) => this.appendRealtimeForActivity(tx, {
        activity, organizationId: job.organizationId, jobCardId: job.id, actorUserId: actorId,
        event, jobType: job.type, beforeAssigneeId: null, afterAssigneeId: job.assignedTo, customerId: job.customerId,
      }), (events) => this.publishRealtime(events));
  }

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

  /** JOB-010 release 2b: single read of the activation flag. */
  private assignmentWindowEnabled(): boolean {
    return this.assignmentWindow.enabled === true;
  }

  /**
   * Slice 2 advisory comparison policy. Configured via
   * SUBMIT_LOCATION_WARNING_DISTANCE_METERS /
   * SUBMIT_LOCATION_MAX_RELIABLE_ACCURACY_METERS, defaulting to the domain
   * constants. Server-owned SSOT: the web client never duplicates these.
   */
  private submitLocationComparisonPolicy(): SubmitLocationComparisonPolicy {
    return {
      warningDistanceMeters: this.geolocation.submitLocationWarningDistanceMeters
        ?? DEFAULT_SUBMIT_LOCATION_WARNING_DISTANCE_METERS,
      maxReliableAccuracyMeters: this.geolocation.submitLocationMaxReliableAccuracyMeters
        ?? DEFAULT_SUBMIT_LOCATION_MAX_RELIABLE_ACCURACY_METERS,
    };
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
      jobType?: JobCardType;
      actorUserId: string;
      event: JobCardActivityEvent;
      beforeAssigneeId: string | null;
      afterAssigneeId: string;
      calendarAffected?: boolean;
      notifyCalendarRescheduled?: boolean;
      sourceJobCardId?: string | null;
      customerId?: string | null;
      /**
       * JOB-010 release 2b: a management producer that supersedes its own
       * overdue offer handles the recovery itself, so the derived in-app
       * notification is suppressed while the activity and realtime event stay.
       */
      suppressNotifications?: boolean;
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

    const managementNotification = input.suppressNotifications !== true
      && (
        input.event === 'JOB_SUBMITTED_FOR_APPROVAL'
        || input.event === 'JOB_CHANGE_REQUESTED'
        // JOB-010 release 2b: a declined/released offer and an expired
        // acceptance must reach every active MANAGER/ADMIN.
        || input.event === 'JOB_ASSIGNMENT_DECLINED'
        || input.event === 'JOB_ASSIGNMENT_RELEASED'
        || input.event === 'JOB_ASSIGNMENT_OFFER_EXPIRED'
      );
    const managementRecipients = managementNotification
      ? await transaction.listActiveManagementRecipients(input.organizationId)
      : [];
    const drafts: NotificationDraft[] = input.suppressNotifications === true
      ? []
      : [...createJobCardNotificationDrafts({
        event: input.event,
        actorUserId: input.actorUserId,
        afterAssigneeId: input.afterAssigneeId,
        jobCardId: input.jobCardId,
        managementRecipients,
      })];
    if (
      input.suppressNotifications !== true
      && input.notifyCalendarRescheduled
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
    // Store one activity-backed event. Replay scopes relation keys and identity per current viewer.
    let audience = mapped.audience;
    if (input.jobType === 'SALES_MEETING') resourceKeys.add('sale-origin-context');
    if (input.jobType === 'SALE') {
      const snapshot = await transaction.getSubmissionSale(input.organizationId, input.jobCardId);
      const source = snapshot ? await transaction.getJob(input.organizationId, snapshot.sourceVisitId) : null;
      if (source) {
        resourceKeys.add('job-detail:' + source.id);
        audience = { roles: mapped.audience.roles, userIds: [...new Set([...mapped.audience.userIds, source.assignedTo])].sort() };
      }
    }
    const realtimeEvent = await transaction.appendRealtimeEvent({
      ...mapped, audience,
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

  /**
   * JOB-010 release 2a: the requester must learn the decision even when the
   * job was reassigned in the meantime, so the standard activity audience
   * (management + current assignee) is widened with the requester identity.
   * The in-app notification is only written while the requester is still
   * active; the realtime event is always written so the job views refresh.
   */
  private async appendChangeRequestResolutionEvents(
    transaction: JobCardTransaction,
    input: {
      activity: AppendedActivity;
      actor: JobCardActor;
      job: JobCard;
      requestedBy: string;
    },
  ): Promise<RealtimeEventRecord[]> {
    const mapped = mapJobCardActivityToRealtime({
      activityId: input.activity.id,
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      actorUserId: input.actor.id,
      event: 'JOB_CHANGE_REQUEST_RESOLVED',
      occurredAt: input.activity.createdAt,
      beforeAssigneeId: null,
      afterAssigneeId: input.job.assignedTo,
      customerId: input.job.customerId,
    });
    if (!mapped) return [];
    const requester = await transaction.getAssignee(
      input.actor.organizationId, input.requestedBy,
    );
    const notifyRequester = requester?.isActive === true;
    const realtimeEvent = await transaction.appendRealtimeEvent({
      ...mapped,
      audience: {
        roles: mapped.audience.roles,
        userIds: [...new Set([...mapped.audience.userIds, input.requestedBy])].sort(),
      },
      resourceKeys: notifyRequester
        ? [...new Set([...mapped.resourceKeys, 'notifications'])].sort()
        : [...mapped.resourceKeys].sort(),
    });
    if (!notifyRequester) return [realtimeEvent];
    const notifications = await transaction.appendNotifications({
      organizationId: input.actor.organizationId,
      sourceRealtimeEventId: realtimeEvent.id,
      createdAt: input.activity.createdAt,
      drafts: [{
        recipientUserId: input.requestedBy,
        kind: 'job.change_request_resolved',
        entityType: 'job-card',
        entityId: input.job.id,
      }],
    });
    if (this.webPush.enabled && notifications.length > 0) {
      await transaction.appendWebPushDeliveries({
        organizationId: input.actor.organizationId,
        notificationIds: notifications.map((notification) => notification.id),
        at: input.activity.createdAt,
      });
    }
    return [realtimeEvent];
  }

  /**
   * JOB-010 release 2a / OVR-5b §4.11: the single writer of a management
   * decision on one OPEN request. It is shared by the dedicated resolution
   * command and by a deadline patch that carries `changeRequestResolution`,
   * so state, resolution note, resolution activity, Staff notification and
   * realtime effects can never diverge. Callers already hold the users and
   * JobCard locks; this method takes the request row FOR UPDATE last.
   */
  private async resolveChangeRequestInTransaction(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    input: {
      changeRequestId: string;
      resolution: JobChangeRequestDecision;
      note: string | null;
      linkedJobCardId: string | null;
      requestTime: Date;
      clientActionId?: string;
    },
  ): Promise<{ changeRequestId: string; realtimeEvents: RealtimeEventRecord[] }> {
    const request = await tx.getChangeRequestForUpdate(
      actor.organizationId, job.id, input.changeRequestId,
    );
    if (!request) {
      throw new AppError('CHANGE_REQUEST_NOT_FOUND', 404, 'Öneri bulunamadı.');
    }
    if (request.state !== 'OPEN') {
      throw new AppError(
        'CHANGE_REQUEST_NOT_OPEN',
        409,
        'Bu öneri zaten sonuçlandırılmış.',
      );
    }
    if (input.linkedJobCardId !== null) {
      const linked = await tx.getJob(actor.organizationId, input.linkedJobCardId);
      if (!linked || linked.id === job.id) throw validation('linkedJobCardId');
    }
    const resolved = await tx.resolveOpenChangeRequest({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      changeRequestId: input.changeRequestId,
      resolution: input.resolution,
      resolvedBy: actor.id,
      resolvedAt: input.requestTime,
      resolutionNote: input.note,
      linkedJobCardId: input.linkedJobCardId,
    });
    if (!resolved) {
      throw new AppError(
        'CHANGE_REQUEST_NOT_OPEN',
        409,
        'Bu öneri zaten sonuçlandırılmış.',
      );
    }
    const activity = await tx.appendActivity({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      actorId: actor.id,
      event: 'JOB_CHANGE_REQUEST_RESOLVED',
      clientActionId: input.clientActionId,
      metadata: {
        requestId: input.changeRequestId,
        resolution: input.resolution,
        linkedJobCardId: input.linkedJobCardId,
      },
    });
    const realtimeEvents = await this.appendChangeRequestResolutionEvents(tx, {
      activity,
      actor,
      job,
      requestedBy: request.requestedBy,
    });
    return { changeRequestId: input.changeRequestId, realtimeEvents };
  }

  /**
   * JOB-010 release 2b: open an assignment offer inside the caller's
   * transaction. Returns null when the producer does not apply (flag off,
   * job outside the offer rules, self-assignment).
   *
   * Direct producers (a management request) reject a planned window that can
   * no longer fit an on-time answer and demand an explicit acknowledgement
   * once the planned start passed. Compound producers (JOB-008 approval,
   * JOB-009 replacement, offboarding transfer) cannot ask anyone, so they
   * record the offer and close it at once as `PLANNED_WINDOW_PASSED`.
   */
  private async openAssignmentOffer(
    tx: JobCardTransaction,
    input: {
      actor: JobCardActor;
      job: JobCard;
      openedReason: JobAssignmentOfferOpenedReason;
      requestTime: Date;
      direct: boolean;
      acknowledgement?: PastStartAcknowledgementInput | null;
    },
  ): Promise<{ offer: AssignmentOfferRecord; realtimeEvents: RealtimeEventRecord[] } | null> {
    if (!this.assignmentWindowEnabled()) return null;
    if (!isAssignmentOfferEligible(input.job, input.actor.id)) return null;
    const scheduledAt = input.job.scheduledAt;
    if (scheduledAt === null) return null;
    const scheduledEndsAt = input.job.scheduledEndsAt
      ?? canonicalScheduledEnd(input.job.type, scheduledAt);
    const decision = decideAssignmentOfferOpen({
      openedAt: input.requestTime,
      scheduledAt: new Date(scheduledAt),
      scheduledEndsAt: scheduledEndsAt === null ? null : new Date(scheduledEndsAt),
      direct: input.direct,
      acknowledgement: input.acknowledgement ?? null,
    });
    if (decision.kind === 'window-too-short') {
      throw new AppError(
        'ASSIGNMENT_WINDOW_TOO_SHORT',
        409,
        'Planlanan zaman kabul için çok kısa; lütfen daha ileri bir zaman seçin.',
      );
    }
    if (decision.kind === 'acknowledgement-required') {
      throw new AppError(
        'PAST_START_ACKNOWLEDGEMENT_REQUIRED',
        409,
        'Planlanan başlangıç geçti; müşteri onayı veya bekleme açıklaması zorunludur.',
      );
    }
    const acknowledgement = decision.kind === 'open'
      && decision.urgentReason === 'START_PASSED'
      ? decision.acknowledgement
      : null;
    const offer = await tx.insertAssignmentOffer({
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      assigneeUserId: input.job.assignedTo,
      openedAt: input.requestTime,
      openedReason: input.openedReason,
      openedBy: input.actor.id,
      assignmentHistoryId: null,
      acceptanceDueAt: decision.acceptanceDueAt,
      urgentReason: decision.urgentReason,
      ackCode: acknowledgement?.code ?? null,
      ackText: acknowledgement?.text ?? null,
      closeImmediately: decision.kind === 'planned-window-passed'
        ? {
          closedAt: input.requestTime,
          closedBy: input.actor.id,
          closeReason: 'PLANNED_WINDOW_PASSED',
        }
        : null,
    });
    const realtimeEvents: RealtimeEventRecord[] = [];
    const openedActivity = await tx.appendActivity({
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      actorId: input.actor.id,
      event: 'JOB_ASSIGNMENT_OFFER_OPENED',
      metadata: {
        offerId: offer.id,
        openedReason: input.openedReason,
        acceptanceDueAt: decision.acceptanceDueAt.toISOString(),
        urgentReason: decision.urgentReason,
      },
    });
    realtimeEvents.push(...await this.appendRealtimeForActivity(tx, {
      activity: openedActivity,
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      jobType: input.job.type,
      actorUserId: input.actor.id,
      event: 'JOB_ASSIGNMENT_OFFER_OPENED',
      beforeAssigneeId: null,
      afterAssigneeId: input.job.assignedTo,
      customerId: input.job.customerId,
    }));
    if (decision.kind === 'planned-window-passed') {
      const withdrawn = await tx.appendActivity({
        organizationId: input.actor.organizationId,
        jobCardId: input.job.id,
        actorId: input.actor.id,
        event: 'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
        metadata: { offerId: offer.id, closeReason: 'PLANNED_WINDOW_PASSED' },
      });
      realtimeEvents.push(...await this.appendRealtimeForActivity(tx, {
        activity: withdrawn,
        organizationId: input.actor.organizationId,
        jobCardId: input.job.id,
        jobType: input.job.type,
        actorUserId: input.actor.id,
        event: 'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
        beforeAssigneeId: null,
        afterAssigneeId: input.job.assignedTo,
        customerId: input.job.customerId,
      }));
    }
    return { offer, realtimeEvents };
  }

  /**
   * JOB-010 release 2b: close a live OPEN offer as WITHDRAWN when another
   * producer replaces it (reassign, reschedule, cancel, invalidation,
   * offboarding transfer). A no-op when the job is outside the window.
   */
  private async withdrawOpenAssignmentOffer(
    tx: JobCardTransaction,
    input: {
      actor: JobCardActor;
      job: JobCard;
      requestTime: Date;
      reason: Extract<
        JobAssignmentOfferWithdrawReasonCode,
        'REASSIGNED' | 'RESCHEDULED' | 'CANCELLED' | 'INVALIDATED'
      >;
    },
  ): Promise<RealtimeEventRecord[]> {
    if (!this.assignmentWindowEnabled()) return [];
    const offer = await tx.getLatestAssignmentOffer(input.actor.organizationId, input.job.id);
    if (offer === null || offer.state !== 'OPEN') return [];
    const closed = await tx.closeAssignmentOffer({
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      offerId: offer.id,
      expectedState: 'OPEN',
      state: 'WITHDRAWN',
      closedAt: input.requestTime,
      closedBy: input.actor.id,
      closeReason: input.reason,
      closeText: null,
    });
    if (!closed) return [];
    const activity = await tx.appendActivity({
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      actorId: input.actor.id,
      event: 'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
      metadata: { offerId: offer.id, closeReason: input.reason },
    });
    return this.appendRealtimeForActivity(tx, {
      activity,
      organizationId: input.actor.organizationId,
      jobCardId: input.job.id,
      jobType: input.job.type,
      actorUserId: input.actor.id,
      event: 'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
      beforeAssigneeId: null,
      afterAssigneeId: input.job.assignedTo,
      customerId: input.job.customerId,
    });
  }

  /**
   * JOB-010 release 2b: the offer state a lifecycle answer requires, checked
   * in the reservation preflight and again in the finalize transaction.
   * ACCEPT_ASSIGNMENT on a job outside the window is unchanged; DECLINE and
   * RELEASE never exist there.
   */
  private async assertAssignmentOfferCommand(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    command: LifecycleCommand,
    requestTime: Date,
  ): Promise<AssignmentOfferRecord | null> {
    if (!this.assignmentWindowEnabled()) return null;
    if (command !== 'ACCEPT_ASSIGNMENT' && command !== 'DECLINE_ASSIGNMENT'
      && command !== 'RELEASE_ASSIGNMENT') return null;
    // Role/assignment denials stay the policy's job (403), exactly as before:
    // the offer check only narrows a request the actor was otherwise allowed
    // to make.
    if (actor.role !== 'STAFF' || actor.id !== job.assignedTo) return null;
    const offer = await tx.getLatestAssignmentOffer(actor.organizationId, job.id);
    if (offer === null) {
      if (command === 'ACCEPT_ASSIGNMENT') return null;
      throw new AppError(
        'ASSIGNMENT_OFFER_NOT_OPEN',
        409,
        'Bu iş için açık bir atama teklifi bulunmuyor.',
      );
    }
    const requiredState = assignmentOfferRequiredState(command);
    if (offer.state !== requiredState || offer.assigneeUserId !== actor.id) {
      throw new AppError(
        'ASSIGNMENT_OFFER_NOT_OPEN',
        409,
        'Atama teklifi bu işlem için uygun durumda değil.',
      );
    }
    // JOB-010 §4: the canonical 049 reservation instant compared with the
    // deadline; a late answer writes nothing whether or not the worker ran.
    if (command !== 'RELEASE_ASSIGNMENT'
      && !isAcceptanceOnTime(requestTime, offer.acceptanceDueAt)) {
      throw new AppError(
        'ACCEPTANCE_WINDOW_CLOSED',
        409,
        'Kabul süresi doldu; yönetici yeni bir teklif göndermelidir.',
      );
    }
    return offer;
  }

  /** The offer summary `allowedCommands` reads, or null outside the window. */
  private assignmentOfferSummary(
    offer: {
      state: JobAssignmentOfferState;
      acceptanceDueAt: Date;
      assigneeUserId: string;
    } | null | undefined,
  ): JobAssignmentOfferSummary | null {
    if (offer === null || offer === undefined) return null;
    return {
      state: offer.state,
      acceptanceDueAt: offer.acceptanceDueAt.toISOString(),
      assigneeUserId: offer.assigneeUserId,
    };
  }

  /**
   * JOB-010 release 2b: job detail projection. An OPEN offer past its
   * deadline is presented as EXPIRED at read time, so the client never
   * computes a deadline with its own clock.
   */
  private presentAssignmentOffer(
    offer: {
      id: string;
      state: JobAssignmentOfferState;
      acceptanceDueAt: Date;
      openedAt: Date;
      urgentReason: JobAssignmentOfferUrgentReason | null;
      assigneeId: string;
      assigneeName: string | null;
    } | null | undefined,
    evaluatedAt: Date,
  ): JobAssignmentOfferView | null {
    if (offer === null || offer === undefined) return null;
    const expired = offer.state === 'OPEN'
      && evaluatedAt.valueOf() >= offer.acceptanceDueAt.valueOf();
    return {
      id: offer.id,
      state: expired ? 'EXPIRED' : offer.state,
      acceptanceDueAt: offer.acceptanceDueAt.toISOString(),
      openedAt: offer.openedAt.toISOString(),
      urgentReason: offer.urgentReason,
      assignee: { id: offer.assigneeId, name: offer.assigneeName },
    };
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
        // Staff-user lock contract (assignee-lock.ts): the invalidation note's
        // author snapshot is a users-row lock, so it is acquired BEFORE the
        // JobCard row instead of underneath it.
        if (note !== null) {
          await this.lockUsersInOrder(tx, actor.organizationId, [actor.id]);
        }
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
        // OVR-2 invalidation closure (owner decision 2026-11-20): INVALIDATE
        // ends every still-open overdue obligation of this card in the same
        // transaction, under the same lock, with the command's canonical
        // request time and actor. It is administrative closure, not recovery
        // (the recovery pair stays NULL) and it materializes nothing.
        // Recovered and already ended rows are never rewritten.
        const closedOverdueIncidents = await tx.invalidateOpenOverdueIncidents({
          organizationId: actor.organizationId,
          jobCardId,
          endedAt: requestTime,
          endedByUserId: actor.id,
        });

        // JOB-010 release 2a (D1): invalidation supersedes an OPEN
        // change/termination request in this same transaction; the decision
        // actor is recorded and the request text stays untouched history.
        const supersededRequest = await tx.closeOpenChangeRequest({
          organizationId: actor.organizationId,
          jobCardId,
          resolution: 'SUPERSEDED',
          resolvedBy: actor.id,
          resolvedAt: requestTime,
        });
        if (supersededRequest) {
          await tx.appendActivity({
            organizationId: actor.organizationId,
            jobCardId,
            actorId: actor.id,
            event: 'JOB_CHANGE_REQUEST_RESOLVED',
            metadata: {
              requestId: supersededRequest.id, resolution: 'SUPERSEDED', linkedJobCardId: null,
            },
          });
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
            closedOverdueIncidents,
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
          event: 'JOB_INVALIDATED', jobType: job.type,
          beforeAssigneeId: job.assignedTo,
          afterAssigneeId: updated.assignedTo,
          calendarAffected: true,
          customerId: updated.customerId,
        });
        // JOB-010 release 2b: invalidation withdraws a live OPEN offer; the
        // job can never be answered again.
        realtimeEvents.push(...await this.withdrawOpenAssignmentOffer(tx, {
          actor,
          job: updated,
          requestTime,
          reason: 'INVALIDATED',
        }));
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

  async createSaleFromVisit(actor: JobCardActor, visitId: string, input: unknown) {
    return this.saleService.createSaleFromVisit(actor, visitId, input);
  }

  async patchSaleItem(actor: JobCardActor, jobCardId: string, itemId: string, input: unknown) {
    return this.saleService.patchSaleItem(actor, jobCardId, itemId, input);
  }

  async removeSaleItem(actor: JobCardActor, jobCardId: string, itemId: string, input: unknown) {
    return this.saleService.removeSaleItem(actor, jobCardId, itemId, input);
  }

  async addSaleItem(actor: JobCardActor, jobCardId: string, input: unknown) {
    return this.saleService.addSaleItem(actor, jobCardId, input);
  }

  async patchSaleDetails(actor: JobCardActor, jobCardId: string, input: unknown) {
    return this.saleService.patchSaleDetails(actor, jobCardId, input);
  }

  async create(actor: JobCardActor, input: NormalizedJobCardCreateInput) {
    if (!['PRODUCT_DELIVERY', 'SALES_MEETING', 'GENERAL_TASK'].includes(input.type)) {
      throw new AppError('INVALID_JOB_TYPE', 400, 'Bu iş türü genel oluşturma işlemiyle kullanılamaz.');
    }
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
        // JOB-010 release 2b: a management create that lands in NEW is a
        // customer commitment; record its offer in this same transaction.
        const assignmentOffer = await this.openAssignmentOffer(transaction, {
          actor,
          job,
          openedReason: 'CREATE',
          requestTime,
          direct: true,
          acknowledgement: input.pastStartAcknowledgement ?? null,
        });
        if (assignmentOffer) realtimeEvents.push(...assignmentOffer.realtimeEvents);
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
    // Deadline authority is SERVER-ONLY (field-test product decision, WR-WEEK):
    // the submission deadline is the Monday after the Monday–Saturday period
    // (`periodEnd + 2`), or the organization-local creation date if requested
    // later so a late request is never born overdue. The public request shape
    // carries no dueDate field at all (the parser rejects one as an unknown
    // field), so no caller, staff or manager, can move their own or anyone's
    // accountability deadline.
    const requestTime = this.now();
    const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
    const dueDate = weeklyReportDueDate(input.periodEnd, localDateKey(requestTime, timezone));
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
    // Same server-only deadline authority as the single create: the Monday
    // after the Monday–Saturday period (`periodEnd + 2`), or the
    // organization-local creation date if later.
    const requestTime = this.now();
    const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
    const dueDate = weeklyReportDueDate(input.periodEnd, localDateKey(requestTime, timezone));
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

  async getWeeklyReport(actor: JobCardActor, jobCardId: string, includeSaleCapability = true): Promise<WeeklyReportDetail> {
    const { job, report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const submissionRows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    let liveSourceWork: WeeklyReportDetail['liveSourceWork'] = [];
    if (job.status === 'ACCEPTED' || job.status === 'IN_PROGRESS') {
      const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
      const { weekStart, weekEnd } = weekInstants(report.periodStart, report.periodEnd, timezone);
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
      canRemove: actor.role === 'ADMIN' && report.removal === null && report.staffUserId === job.assignedTo,
      jobStatus: job.status,
      jobVersion: job.version,
      dueDate: job.dueDate,
      assignedTo: job.assignedTo,
      instructions: job.description,
      liveSourceWork: includeSaleCapability ? liveSourceWork : liveSourceWork.filter((item) => item.type !== 'SALE'),
      submissionSummaries: submissionRows.map((row) => ({
        seqNo: row.seq_no,
        submittedAt: row.submitted_at.toISOString(),
        submittedBy: row.submitted_by,
      })),
    };
  }

  async weeklyReportRemovalPreview(actor: JobCardActor, jobCardId: string) {
    assertCanInvalidate(actor);
    const report = await this.getWeeklyReport(actor, jobCardId);
    const job = await this.repository.findJobCardDetail(actor.organizationId, jobCardId);
    if (!job) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
    // Advisory read only; POST repeats this guard under transaction/child locks.
    const activeFollowUps = report.canRemove
      ? await this.repository.hasActiveFollowUpChildren(actor.organizationId, jobCardId)
      : false;
    return {
      jobCardId, reportId: report.id, staffUserId: report.staffUserId, staffName: job.assignee.name,
      periodStart: report.periodStart, periodEnd: report.periodEnd,
      status: report.jobStatus, expectedVersion: report.jobVersion, expectedReportVersion: report.version,
      submissionCount: report.submissionSummaries.length,
      canRemove: report.canRemove && !activeFollowUps,
      removalBlocker: activeFollowUps ? 'ACTIVE_FOLLOW_UPS' as const : null,
      removal: report.removal,
    };
  }

  async removeWeeklyReport(actor: JobCardActor, jobCardId: string, rawInput: WeeklyReportRemovalInput) {
    assertCanInvalidate(actor);
    const input = parseWeeklyReportRemovalInput(rawInput);
    const result = await this.repository.executeCriticalAction<JobCardMutationReceipt>({
      organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId,
      operationKey: `WEEKLY_REPORT_REMOVE:${jobCardId}`,
      requestHash: weeklyReportRemovalRequestHash(jobCardId, input),
    }, async (tx) => {
      // Staff-user lock contract (assignee-lock.ts): the acting admin and the
      // report owner are locked FIRST, in ONE sorted de-duplicated call, before
      // the JobCard/WeeklyReport rows. The owner id comes from the unlocked
      // snapshot, so the authoritative checks are re-taken from the locked rows:
      // an actor demoted or deactivated meanwhile still gets 403 before anything
      // is written, and an owner that changed still fails the ownership check.
      const actorSnapshot = await tx.getAssignee(actor.organizationId, actor.id);
      if (!actorSnapshot?.isActive || actorSnapshot.role !== 'ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const snapshot = await tx.getJob(actor.organizationId, jobCardId);
      if (!snapshot || snapshot.type !== 'WEEKLY_REPORT') {
        throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      }
      const lockedUsers = await this.lockUsersInOrder(
        tx, actor.organizationId, [actor.id, snapshot.assignedTo],
      );
      const currentActor = lockedUsers.get(actor.id) ?? null;
      if (!currentActor?.isActive || currentActor.role !== 'ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const owner = lockedUsers.get(snapshot.assignedTo) ?? null;
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      const row = await tx.getWeeklyReportByJobForUpdate(actor.organizationId, jobCardId);
      if (!job || !row) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      if (!owner || owner.role !== 'STAFF' || job.type !== 'WEEKLY_REPORT'
        || row.staff_user_id !== job.assignedTo || job.assignedTo !== snapshot.assignedTo) {
        throw new AppError('WEEKLY_REPORT_OWNERSHIP_CONFLICT', 409, 'Rapor sahibi doğrulanamadığı için rapor kaldırılamaz.');
      }
      if (row.removed_at !== null) {
        throw new AppError('WEEKLY_REPORT_ALREADY_REMOVED', 409, 'Bu haftalık rapor zaten kaldırılmış.');
      }
      if (job.version !== input.expectedVersion || row.version !== input.expectedReportVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Rapor değişti. Güncel kaydı inceleyip yeniden deneyin.');
      }
      if ((await tx.listActiveFollowUpChildrenForUpdate(actor.organizationId, jobCardId)).length > 0) {
        throw new AppError('JOB_HAS_ACTIVE_FOLLOW_UPS', 409, 'Aktif takip işleri bulunan rapor kaldırılamaz.');
      }
      const at = this.now();
      const updated = job.status === 'INVALIDATED'
        ? await tx.bumpVersion(actor.organizationId, jobCardId, job.version)
        : await tx.invalidateWithVersion({ organizationId: actor.organizationId, jobCardId,
          expectedVersion: job.version, invalidatedAt: at, invalidatedBy: actor.id, reasonCode: 'CREATED_BY_MISTAKE' });
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
      // OVR-2 invalidation closure: a removal that invalidates the root uses
      // the same correction semantics as INVALIDATE, so every still-open
      // overdue obligation of the card ends here too, in this transaction and
      // with this command's request time/actor. A root that was ALREADY
      // INVALIDATED is historical data under the no-backfill rule: its open
      // rows stay untouched.
      const closedOverdueIncidents = job.status === 'INVALIDATED'
        ? 0
        : await tx.invalidateOpenOverdueIncidents({
          organizationId: actor.organizationId,
          jobCardId,
          endedAt: at,
          endedByUserId: actor.id,
        });
      const removed = await tx.removeWeeklyReportRow({ organizationId: actor.organizationId,
        reportId: row.id, expectedVersion: row.version, removedAt: at, removedBy: actor.id, reason: input.reason });
      if (!removed) throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
      const realtimeEvents: RealtimeEventRecord[] = [];
      if (job.status !== 'INVALIDATED') {
        const activity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId,
          actorId: actor.id, event: 'JOB_INVALIDATED', clientActionId: input.clientActionId,
          oldValue: { status: job.status, version: job.version },
          newValue: { status: updated.status, version: updated.version },
          metadata: { reasonCode: 'CREATED_BY_MISTAKE', reportId: row.id, closedOverdueIncidents } });
        await tx.appendAudit({ organizationId: actor.organizationId, actorUserId: actor.id, subjectId: jobCardId,
          oldValue: { status: job.status }, newValue: { status: updated.status },
          metadata: { reasonCode: 'CREATED_BY_MISTAKE', clientActionId: input.clientActionId } });
        realtimeEvents.push(...await this.appendRealtimeForActivity(tx, {
          activity, organizationId: actor.organizationId, jobCardId, actorUserId: actor.id,
          event: 'JOB_INVALIDATED', jobType: job.type, beforeAssigneeId: job.assignedTo,
          afterAssigneeId: job.assignedTo, calendarAffected: true, customerId: null,
        }));
      }
      const activity = await tx.appendActivity({ organizationId: actor.organizationId, jobCardId,
        actorId: actor.id, event: 'WEEKLY_REPORT_REMOVED', clientActionId: input.clientActionId,
        oldValue: { reportVersion: row.version }, newValue: { reportVersion: removed.version },
        metadata: { reportId: row.id, reason: input.reason, closedOverdueIncidents } });
      await tx.appendAudit({ organizationId: actor.organizationId, actorUserId: actor.id, subjectId: jobCardId,
        eventType: 'WEEKLY_REPORT_REMOVED', oldValue: { reportId: row.id, removedAt: null },
        newValue: { reportId: row.id, removedAt: at.toISOString() },
        metadata: { staffUserId: row.staff_user_id, periodStart: mapReport(row).periodStart,
          reason: input.reason, clientActionId: input.clientActionId } });
      await tx.synchronizeCalendarReminder({ organizationId: actor.organizationId, jobCardId,
        assignedUserId: job.assignedTo, startsAt: job.scheduledAt, endsAt: job.scheduledEndsAt,
        version: updated.version, active: false, now: at, reminderLeadMinutes: this.calendar.reminderLeadMinutes });
      realtimeEvents.push(...await this.appendRealtimeForActivity(tx, {
        activity, organizationId: actor.organizationId, jobCardId, actorUserId: actor.id,
        event: 'WEEKLY_REPORT_REMOVED', jobType: job.type, beforeAssigneeId: job.assignedTo,
        afterAssigneeId: job.assignedTo, calendarAffected: true, customerId: null,
      }));
      return { response: { jobCardId }, realtimeEvents };
    });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return this.getWeeklyReport(actor, decodeJobCardMutationReceipt(result.response).jobCardId);
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
    includeSaleCapability = true,
  ): Promise<WeeklyReportDetail> {
    if (actor.role !== 'STAFF') {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
    }
    await this.repository.executeTransaction(async (tx) => {
      // User -> JobCard -> WeeklyReport. Reuse the FOR SHARE user snapshot:
      // it fences role/deactivation changes while remaining compatible with
      // SUBMIT's note-author SHARE lock under the JobCard lock.
      const currentActor = await tx.getNoteAuthorSnapshot(actor.organizationId, actor.id);
      if (!currentActor?.isActive || currentActor.role !== 'STAFF') {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job || job.type !== 'WEEKLY_REPORT' || job.assignedTo !== actor.id) {
        throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      }
      const row = await tx.getWeeklyReportByJobForUpdate(actor.organizationId, jobCardId);
      if (!row) throw new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.');
      const report = mapReport(row);
      if (report.staffUserId !== actor.id) {
        throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
      }
      if (job.status !== 'ACCEPTED' && job.status !== 'IN_PROGRESS') {
        throw new AppError('WEEKLY_REPORT_DRAFT_LOCKED', 409, 'Rapor taslağı bu aşamada düzenlenemez.');
      }
      if (report.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
      }
      const draft = validateDraftBody(input.draft);
      const answers = validateDraftAnswers(report.questions, input.answers);
      const updated = await tx.updateWeeklyReportDraftRow({
        organizationId: actor.organizationId,
        reportId: report.id,
        expectedVersion: input.expectedVersion,
        draft,
        answers,
      });
      if (!updated) {
        throw new AppError('VERSION_CONFLICT', 409, 'Rapor başka bir işlem tarafından güncellendi.');
      }
    });
    return this.getWeeklyReport(actor, jobCardId, includeSaleCapability);
  }

  async listWeeklyReportSubmissions(
    actor: JobCardActor,
    jobCardId: string,
    includeSaleCapability = true,
  ): Promise<WeeklyReportSubmission[]> {
    const { report } = await this.loadWeeklyReportContext(actor, jobCardId);
    const rows = await this.repository.listWeeklyReportSubmissionRows(
      actor.organizationId, report.id,
    );
    return rows.map(mapSubmission).map((submission) => includeSaleCapability ? submission : {
      ...submission, sourceWork: submission.sourceWork.filter((item) => item.type !== 'SALE'),
    });
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
    const { weekStart, weekEnd } = weekInstants(report.periodStart, report.periodEnd, timezone);
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

  /**
   * Single insertion path for the initial delivery batch. Both the normal
   * Product Delivery create and a PRODUCT_DELIVERY follow-up child use it so
   * snapshots, version bumps and DELIVERY_ITEM_ADDED activities stay identical.
   * Runs inside the caller's transaction, after the JobCard's JOB_CREATED
   * activity, and returns the final JobCard version.
   */
  private async insertInitialDeliveryItems(
    transaction: JobCardTransaction,
    actor: JobCardActor,
    input: {
      jobCardId: string;
      jobVersion: number;
      clientActionId: string;
      deliveryPurpose: DeliveryPurpose;
      deliveryNote: string | null;
      items: ReadonlyArray<InitialDeliveryItem & { product: ProductReference }>;
    },
  ): Promise<number> {
    let version = input.jobVersion;
    for (const entry of input.items) {
      const item = await transaction.createDeliveryItem(deliveryRecord(
        actor.organizationId,
        input.jobCardId,
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
      const updated = await transaction.bumpVersion(actor.organizationId, input.jobCardId, version);
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      version = updated.version;
      await transaction.appendActivity({
        organizationId: actor.organizationId, jobCardId: input.jobCardId, actorId: actor.id,
        event: 'DELIVERY_ITEM_ADDED', clientActionId: input.clientActionId,
        newValue: {
          itemId: item.id, productId: item.productId,
          deliveryPurpose: item.deliveryPurpose, quantity: item.quantity,
          deliveredAt: null,
        },
      });
    }
    return version;
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

          // A human PRODUCT_DELIVERY create always creates a BUSINESS JobCard
          // today (no DEMO dataset is ever supplied here), so eligibility is
          // asserted against the BUSINESS scope without reading the new row.
          const businessScope: JobDeliveryScope = { dataClass: 'BUSINESS', demoDatasetId: null };
          // Products are resolved in deterministic ID order so concurrent
          // multi-line creates cannot acquire product row locks in opposing
          // orders; the persisted item order stays the request order.
          const references = new Map<string, ProductReference>();
          for (const productId of [...new Set(input.items.map((item) => item.productId))].sort()) {
            const product = await transaction.getProduct(actor.organizationId, productId);
            if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
            assertDeliveryProductEligible(businessScope, product);
            references.set(productId, product);
          }
          const products = input.items.map((item) => ({ ...item, product: references.get(item.productId)! }));

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

          const version = await this.insertInitialDeliveryItems(transaction, actor, {
            jobCardId: job.id,
            jobVersion: job.version,
            clientActionId: input.clientActionId,
            deliveryPurpose: input.deliveryPurpose,
            deliveryNote: input.deliveryNote,
            items: products,
          });
          // JOB-010 release 2b: the delivery create carries the same customer
          // commitment as the generic create; its offer commits here too.
          const assignmentOffer = await this.openAssignmentOffer(transaction, {
            actor,
            job,
            openedReason: 'CREATE',
            requestTime,
            direct: true,
            acknowledgement: input.pastStartAcknowledgement ?? null,
          });
          if (assignmentOffer) realtimeEvents.push(...assignmentOffer.realtimeEvents);
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
    if (!['PRODUCT_DELIVERY', 'SALES_MEETING', 'GENERAL_TASK'].includes(input.type)) {
      throw new AppError('INVALID_JOB_TYPE', 400, 'Bu iş türü takip işi olarak oluşturulamaz.');
    }
    if (input.type === 'PRODUCT_DELIVERY' && input.contactId !== null) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Ürün teslimi oluştururken ilgili kişi seçilemez.',
      );
    }
    // A delivery follow-up must be born with the initial lines it needs; no
    // accepted browser surface adds lines to an existing card yet.
    const delivery = followUpDeliveryIntent(input);
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
        if (sourceSnapshot.type === 'SALE') {
          throw new AppError('INVALID_JOB_TYPE', 400, 'Satış kaydı V1 takip işi kaynağı değildir.');
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
        // Same deterministic ID-ordered FOR SHARE resolution as the normal
        // delivery create: a BUSINESS child must never reference a DEMO product
        // (and a DEMO child only its own dataset). It runs before the child row
        // exists so an ineligible line cannot orphan a card; the persisted item
        // order stays the request order.
        const deliveryScope: JobDeliveryScope = {
          dataClass: childDataClass,
          demoDatasetId: childDemoDatasetId,
        };
        const deliveryProducts: Array<InitialDeliveryItem & { product: ProductReference }> = [];
        if (delivery !== null) {
          const references = new Map<string, ProductReference>();
          for (const productId of [...new Set(delivery.items.map((item) => item.productId))].sort()) {
            const product = await transaction.getProduct(actor.organizationId, productId);
            if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
            assertDeliveryProductEligible(deliveryScope, product);
            references.set(productId, product);
          }
          for (const item of delivery.items) {
            deliveryProducts.push({ ...item, product: references.get(item.productId)! });
          }
        }

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
          assignmentOffer: {
            openedReason: 'FOLLOW_UP_CREATE',
            direct: true,
            acknowledgement: input.pastStartAcknowledgement ?? null,
          },
        });
        if (delivery !== null) {
          await this.insertInitialDeliveryItems(transaction, actor, {
            jobCardId: job.id,
            jobVersion: job.version,
            clientActionId: input.clientActionId,
            deliveryPurpose: delivery.deliveryPurpose,
            deliveryNote: delivery.deliveryNote,
            items: deliveryProducts,
          });
        }
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
      /** JOB-009: null only for the replacement of an unlinked follow-up visit. */
      sourceJobCardId: string | null;
      customerId: string | null;
      type: JobCardType;
      title: string;
      followUpInstructions: string | null;
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
      /**
       * JOB-010 release 2b: the offer this child producer opens, or null for
       * producers whose child never starts in NEW (self-accepted follow-ups).
       */
      assignmentOffer?: {
        openedReason: JobAssignmentOfferOpenedReason;
        direct: boolean;
        acknowledgement?: PastStartAcknowledgementInput | null;
      } | null;
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
    if (input.assignmentOffer) {
      const assignmentOffer = await this.openAssignmentOffer(transaction, {
        actor,
        job,
        openedReason: input.assignmentOffer.openedReason,
        requestTime: input.requestTime,
        direct: input.assignmentOffer.direct,
        acknowledgement: input.assignmentOffer.acknowledgement ?? null,
      });
      if (assignmentOffer) realtimeEvents.push(...assignmentOffer.realtimeEvents);
    }
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

  async getSaleDetails(actor: JobCardActor, jobCardId: string) {
    if (!this.repository.saleReads) throw new Error('Sale readers unavailable');
    const detail = await this.repository.saleReads.details(actor, uuidString(jobCardId, 'jobCardId'));
    if (!detail) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    return detail;
  }

  async assertSaleCapability(actor: JobCardActor, jobCardId: string, enabled: boolean) {
    const job = await this.repository.findJobCard(actor.organizationId, uuidString(jobCardId, 'jobCardId'));
    if (!job || (job.type === 'SALE' && (!enabled || (actor.role === 'STAFF' && job.assignedTo !== actor.id)))) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
  }

  async getSaleCreateContext(actor: JobCardActor, visitId: string) {
    if (!this.repository.saleReads) throw new Error('Sale readers unavailable');
    const context = await this.repository.saleReads.context(actor, uuidString(visitId, 'visitId'));
    if (!context) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    return context;
  }

  async listRelatedSales(actor: JobCardActor, visitId: string, page: PageQuery) {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
      || !Number.isSafeInteger(page.offset) || page.offset < 0) throw new AppError('VALIDATION_ERROR', 400, 'Sayfalama geçersizdir.');
    if (!this.repository.saleReads) throw new Error('Sale readers unavailable');
    const result = await this.repository.saleReads.related(actor, uuidString(visitId, 'visitId'), page);
    if (!result) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    return result;
  }

  async detail(actor: JobCardActor, jobCardId: string, options?: { includeSubmitLocationCapability?: boolean }) {
    return this.detailAt(actor, jobCardId, this.now(), options);
  }

  private async detailAt(actor: JobCardActor, jobCardId: string, evaluatedAt: Date, options?: { includeSubmitLocationCapability?: boolean; submitLocationComparison?: JobActionLocationComparison | null }) {
    const job = await this.repository.findJobCardDetail(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    return this.presentDetail(this.repository, actor, job, evaluatedAt, undefined, options);
  }

  async getMeetingDetails(
    actor: JobCardActor,
    jobCardId: string,
    options?: { includeMetContactCapability?: boolean },
  ) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    assertSalesMeetingJob(job);
    assertCanViewMeetingResult(actor, job);
    const details = await this.repository.findMeetingDetails(actor.organizationId, jobCardId);
    if (!details) invariantViolation();
    return projectMeetingDetailsResponse(
      meetingDetailsResponse(jobCardId, job.version, details),
      options?.includeMetContactCapability === true,
    );
  }

  async patchMeetingDetails(
    actor: JobCardActor,
    jobCardId: string,
    input: PatchMeetingDetailsInput,
    options?: { includeMetContactCapability?: boolean },
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
        const metContactId = input.metContactId === undefined
          ? current.metContactId ?? null
          : input.metContactId;
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
          metContactId,
        };
        // Görüşülen kişi must belong to this job's customer, live in the same
        // organization and be active; the row lock keeps the check race-free.
        // A resubmitted unchanged reference is never re-validated: a contact
        // deactivated after the visit stays a valid historical reference, so
        // editing other meeting fields must not be blocked by it.
        const metContactChanged = metContactId !== (current.metContactId ?? null);
        let metContact: MeetingDetailsContact | null = null;
        if (metContactId !== null) {
          const contact = await transaction.getContactForUpdate(actor.organizationId, metContactId);
          if (!contact) {
            throw new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
          }
          if (metContactChanged) {
            if (job.customerId === null || contact.customerId !== job.customerId) {
              throw new AppError(
                'CONTACT_NOT_IN_CUSTOMER',
                409,
                'İlgili kişi seçilen müşteriye bağlı değil.',
              );
            }
            if (!contact.isActive) {
              throw new AppError(
                'CONTACT_INACTIVE',
                409,
                'Pasif ilgili kişi iş kartında kullanılamaz.',
              );
            }
          }
          metContact = { id: contact.id, name: contact.name, title: contact.title };
        }
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
          response: meetingDetailsResponse(jobCardId, updated.version, {
            ...candidate,
            metContact,
          }),
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
    // The receipt always stores the canonical shape; the reader gate maps it
    // to the caller's bundle (legacy readers never see the met fields, and an
    // opted-in replay of a pre-056 receipt reports them as not recorded).
    return projectMeetingDetailsResponse(
      result.response,
      options?.includeMetContactCapability === true,
    );
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
    // JOB-010 release 2b: the past-start acknowledgement is request intent for
    // a direct offer producer, never a JobCard column.
    const pastStartAcknowledgement = parsePastStartAcknowledgement(
      fields.pastStartAcknowledgement,
    );
    delete fields.pastStartAcknowledgement;
    // OVR-5b §4: both new keys are patch request intent, never JobCard
    // columns. Their type/length is validated whenever they are sent.
    const deadlineExtensionReason = patchDeadlineExtensionReason(input);
    const changeRequestResolution = patchChangeRequestResolution(input);
    delete fields.deadlineExtensionReason;
    delete fields.changeRequestResolution;
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
      if (snapshot.type === 'SALE' && ['customerId', 'contactId', 'scheduledAt', 'scheduledEndsAt',
        'dueDate', 'engagementKind', 'followUpInstructions'].some((field) => Object.hasOwn(fields, field))) {
        throw new AppError('VALIDATION_ERROR', 400, 'Satışın kaynak müşterisi ve zaman planı genel güncellemeyle değiştirilemez.');
      }
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
      // OVR-5 §4.0: the patch samples its business instant only now, after the
      // users (ARC-003) and the JobCard row are locked. A patch that waited
      // behind another transaction is judged at the moment it actually
      // applies, so a deadline that has already passed by then is never
      // treated as future.
      const requestTime = this.now();

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
        if (fields.assignedTo !== undefined && fields.assignedTo !== job.assignedTo) {
          throw new AppError(
            'WEEKLY_REPORT_ASSIGNMENT_IMMUTABLE',
            409,
            'Haftalık raporun sahibi ve sorumlu personeli değiştirilemez.',
          );
        }
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
        // every actor): the submission deadline is server-canonical at
        // creation AND stays tied to the immutable report afterwards — a
        // MANAGER/ADMIN can no longer reschedule it through the generic patch
        // either. Same-value patches fall through to the ordinary
        // change-scoped machinery (a no-op); a CHANGED dueDate is rejected for
        // every role (STAFF already hit the stricter ownership check above).
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
      if (job.type === 'SALES_MEETING' && nextCustomerId !== job.customerId) {
        const meeting = await transaction.getSubmissionMeetingDetails(actor.organizationId, jobCardId);
        if (meeting?.metContactId != null) {
          throw new AppError('CONTACT_NOT_IN_CUSTOMER', 409, 'İlgili kişi seçilen müşteriye bağlı değil.');
        }
      }
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
      const management = isManagementRole(actor.role);
      // OVR-5b §4.11: only management may resolve the Staff request, and only
      // a patch that really appends a schedule revision. Nothing is written.
      if (changeRequestResolution !== null) {
        if (!management) {
          throw changeRequestResolutionError(
            'Değişiklik talebini yalnızca yönetim sonuçlandırabilir.',
          );
        }
        if (!scheduleRevisionChanged) {
          throw changeRequestResolutionError(
            'Değişiklik talebi yalnızca zaman planı değişen bir güncellemeyle sonuçlandırılabilir.',
          );
        }
      }
      // JOB-010 §4 (Q9, P1-B): for a job in the window in NEW or ACCEPTED,
      // only management changes the customer time. Staff edits therefore
      // never move a deadline or open, withdraw or reopen an offer. This runs
      // before the interval-shape invariants so a Staff request for a
      // protected field is always the contract's 403, never a generic 400.
      if (this.assignmentWindowEnabled()
        && !management
        && ['NEW', 'ACCEPTED'].includes(job.status)
        && (await transaction.getLatestAssignmentOffer(actor.organizationId, jobCardId)) !== null
        && (scheduleChanged || dueDateChanged)) {
        throw new AppError(
          'CUSTOMER_TIME_MANAGEMENT_ONLY',
          403,
          'Müşteri zamanı yalnız yönetici tarafından değiştirilebilir.',
        );
      }
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
      // OVR-5b §5.1: Staff never move a deadline that is currently late. The
      // check runs after every existing guard and after the pre-mutation
      // materialization, so a breach the scanner has not ticked yet is locked
      // first and then rolled back with the whole transaction (§5.3 / S3).
      // The stricter guards above keep precedence.
      if (!management
        && (scheduleChanged || dueDateChanged)
        && await transaction.hasOpenDeadlineOverdueIncident({
          organizationId: actor.organizationId,
          jobCardId,
        })) {
        throw new AppError(
          'DEADLINE_CHANGE_REQUIRES_MANAGEMENT',
          409,
          'Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.',
        );
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
          event: 'JOB_ASSIGNED', jobType: job.type,
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
          event: 'JOB_FIELDS_UPDATED', jobType: job.type,
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
      // OVR-5b §4.1–§4.7: a management extension whose new first-late boundary
      // lies in the future ends the open obligation of that delay type and
      // episode in this same transaction. It runs after the appended revision
      // (the ending binds to it) and before the post-revision MUTATION
      // producers below, which therefore find nothing breached. A boundary that
      // would be removed is rejected (§4.3), and a missing reason rejects the
      // whole patch before anything is written (§4.5).
      if (management && scheduleRevisionChanged && appendedScheduleRevisionNo !== null) {
        const ending = await this.endOpenObligationsByExtension(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          job: updated,
          actorId: actor.id,
          requestTime,
          reason: deadlineExtensionReason,
          scheduleRevisionNo: appendedScheduleRevisionNo,
        });
        if (ending !== null) {
          const activity = await transaction.appendActivity({
            organizationId: actor.organizationId,
            jobCardId,
            actorId: actor.id,
            event: 'JOB_OVERDUE_ENDED_BY_EXTENSION',
            metadata: {
              delayTypes: ending.delayTypes,
              endings: ending.endings,
              reason: ending.reason,
              scheduleRevisionNo: appendedScheduleRevisionNo,
            },
          });
          realtimeEvents.push(...await this.appendRealtimeForActivity(transaction, {
            activity,
            organizationId: actor.organizationId,
            jobCardId,
            actorUserId: actor.id,
            event: 'JOB_OVERDUE_ENDED_BY_EXTENSION',
            jobType: job.type,
            beforeAssigneeId: job.assignedTo,
            afterAssigneeId: updated.assignedTo,
            customerId: updated.customerId,
          }));
        }
      }
      // OVR-5b §4.11: the patch may close the job's OPEN change request with
      // the very same effects as the dedicated resolution command, inside this
      // transaction, after the job lock and with the users -> job -> request
      // lock order. A patch never resolves a request it did not name.
      if (changeRequestResolution !== null) {
        const resolved = await this.resolveChangeRequestInTransaction(transaction, actor, updated, {
          changeRequestId: changeRequestResolution.changeRequestId,
          resolution: changeRequestResolution.resolution,
          note: changeRequestResolution.note ?? null,
          linkedJobCardId: null,
          requestTime,
        });
        realtimeEvents.push(...resolved.realtimeEvents);
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
      // JOB-010 §1a: a valid early-start authorization lives only while the
      // assignee and the planned interval it was granted for are unchanged.
      // Any effective change voids it one-way in this same transaction; a
      // dueDate-only revision does not (scheduleChanged excludes it).
      if (assigneeChanged || scheduleChanged) {
        await transaction.voidEarlyStartAuthorizations({
          organizationId: actor.organizationId, jobCardId, voidedAt: requestTime,
          voidReason: assigneeChanged ? 'REASSIGNED' : 'RESCHEDULED',
        });
      }
      // JOB-010 release 2b: a reassignment or planned-interval change closes a
      // live OPEN offer and opens a new one for the resulting assignment (the
      // JOB-006 ACCEPTED->NEW reset is a reschedule). A dueDate-only revision
      // moves no planned interval, so it never opens or withdraws an offer.
      if (this.assignmentWindowEnabled() && (assigneeChanged || scheduleChanged)) {
        realtimeEvents.push(...await this.withdrawOpenAssignmentOffer(transaction, {
          actor,
          job: updated,
          requestTime,
          reason: assigneeChanged ? 'REASSIGNED' : 'RESCHEDULED',
        }));
        const assignmentOffer = await this.openAssignmentOffer(transaction, {
          actor,
          job: updated,
          openedReason: assigneeChanged ? 'REASSIGN' : 'RESCHEDULE',
          requestTime,
          direct: true,
          acknowledgement: pastStartAcknowledgement,
        });
        if (assignmentOffer) realtimeEvents.push(...assignmentOffer.realtimeEvents);
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
        parseDeliveryQuantity(input.quantity);
        const plannedDeliveredAt = parseDeliveredAt(input.deliveredAt);
        if (plannedDeliveredAt !== null) {
          assertCanEditDeliveryActualTime(actor, job);
        }
        const product = await tx.getProduct(actor.organizationId, input.productId);
        if (!product?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
        const scope = await tx.getJobDeliveryScope(actor.organizationId, jobCardId);
        if (!scope) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        assertDeliveryProductEligible(scope, product);
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
      // Only a supplied replacement quantity is validated. A legacy fractional
      // row must stay editable for purpose/note/time changes without a
      // backfill or a new database constraint.
      if (input.quantity !== undefined && input.quantity !== null) parseDeliveryQuantity(input.quantity);
      if (input.deliveredAt !== undefined) {
        const nextDeliveredAt = parseDeliveredAt(input.deliveredAt);
        const previousIso = current.deliveredAt === null ? null : current.deliveredAt.toISOString();
        const nextIso = nextDeliveredAt === null ? null : nextDeliveredAt.toISOString();
        if (nextIso !== previousIso) {
          // Actual delivery time is execution-stage only (backend capability gate).
          assertCanEditDeliveryActualTime(actor, job);
        }
      }
      let product: DeliveryProductSnapshot;
      if (input.productId && input.productId !== current.productId) {
        const found = await tx.getProduct(actor.organizationId, input.productId);
        if (!found?.isActive) throw new AppError('PRODUCT_NOT_FOUND', 404, 'Aktif ürün bulunamadı.');
        const scope = await tx.getJobDeliveryScope(actor.organizationId, jobCardId);
        if (!scope) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        assertDeliveryProductEligible(scope, found);
        product = found;
      } else {
        product = {
          id: current.productId, name: current.productNameSnapshot,
          sku: current.productSkuSnapshot, model: current.productModelSnapshot, unit: current.unit };
      }
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

  async listActivity(
    actor: JobCardActor,
    jobCardId: string,
    page: PageQuery,
    options?: { includeSubmitLocationCapability?: boolean; includeMetContactCapability?: boolean; includeSaleCapability?: boolean },
  ) {
    await this.detail(actor, jobCardId);
    const result = await this.repository.listActivity(actor.organizationId, jobCardId, {
      ...page, ...(options?.includeSaleCapability === false ? { includeSaleCapability: false } : {}),
    });
    return {
      items: result.items.map((item) => presentActivity(item, options)),
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
    // OVR-4 metrics: one rollup read per job (not per row), joined in memory.
    // Manual timestamps are proven domain facts; legacy episodes without any
    // reminder keep nulls instead of guesses.
    const stats = await this.repository.listSubmissionReminderStats(
      actor.organizationId, jobCardId,
    );
    // NEW-1: the rollup is keyed by incident. Episode numbers repeat per delay
    // type and per schedule revision, so episode-only keys leak a previous
    // cycle's reminders into the obligation that replaced it.
    const statsByIncident = new Map(stats.map((entry) => [entry.incidentId, entry]));
    // One reminder read per ended incident, shared by its rows (Promise.all).
    const remindersByIncident = new Map<string, ReturnType<
      JobCardRepository['listSubmissionRemindersForIncident']
    >>();
    const items = await Promise.all(result.items.map(async (item) => {
      // Manual submission reminders belong to LATE_SUBMISSION incidents only
      // (migration 053). An APPROVAL_WAIT or LATE_START row never inherits the
      // submission episode's statistics.
      const isSubmissionDelay = item.delayType === 'LATE_SUBMISSION';
      // Only reminders sent at or before the closing instant measure the
      // nudge effect; a reminder sent afterwards belongs to a later cycle.
      // OVR-5 (§6): an ended row stops its statistics at `endedAt`, a
      // recovered row at `recoveredAt`. The rollup only carries the latest
      // overall instant, so an ended episode needs its reminder rows to count
      // the ones that predate the ending.
      const endedAtMs = item.endedAt === null ? null : item.endedAt.getTime();
      const recoveredAtMs = item.recoveredAt === null ? null : item.recoveredAt.getTime();
      let manualReminderCount = 0;
      let latestManualReminderAt: Date | null = null;
      if (isSubmissionDelay && endedAtMs !== null) {
        let pending = remindersByIncident.get(item.id);
        if (pending === undefined) {
          pending = this.repository.listSubmissionRemindersForIncident(
            actor.organizationId, jobCardId, item.id,
          );
          remindersByIncident.set(item.id, pending);
        }
        const reminders = await pending;
        const beforeEnding = reminders.filter(
          (reminder) => reminder.sentAt.getTime() <= endedAtMs,
        );
        manualReminderCount = beforeEnding.length;
        latestManualReminderAt = beforeEnding[0]?.sentAt ?? null;
      } else {
        const incidentStats = isSubmissionDelay
          ? statsByIncident.get(item.id) ?? null
          : null;
        const reminderBeforeRecovery = incidentStats !== null
          && (recoveredAtMs === null || incidentStats.latestSentAt.getTime() <= recoveredAtMs)
          ? incidentStats
          : null;
        manualReminderCount = incidentStats?.count ?? 0;
        latestManualReminderAt = reminderBeforeRecovery?.latestSentAt ?? null;
      }
      const manualReminderSentAt = latestManualReminderAt === null
        ? null
        : latestManualReminderAt.toISOString();
      // An ended obligation is neither recovered nor on time: the delay ends
      // at ending, so the recovery-based metrics stay null and the ended
      // duration (ended - breached, same rounding) is the measurement.
      const totalDelaySeconds = endedAtMs === null && recoveredAtMs !== null
        ? Math.max(0, Math.floor((recoveredAtMs - item.breachedAt.getTime()) / 1000))
        : null;
      const postReminderDelaySeconds = endedAtMs === null
        && latestManualReminderAt !== null && recoveredAtMs !== null
        ? Math.max(
          0,
          Math.floor(
            (recoveredAtMs - latestManualReminderAt.getTime()) / 1000,
          ),
        )
        : null;
      const endedDurationSeconds = endedAtMs === null
        ? null
        : Math.max(0, Math.floor((endedAtMs - item.breachedAt.getTime()) / 1000));
      return {
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
        endedAt: item.endedAt === null ? null : item.endedAt.toISOString(),
        endedBy: item.endedByUserId === null
          ? null
          : { id: item.endedByUserId, name: item.endedByUserName },
        endReason: item.endReason,
        endNote: item.endNote,
        endedByScheduleRevisionNo: item.endedByScheduleRevisionNo,
        endedDurationSeconds,
        totalDelaySeconds,
        manualReminderSentAt,
        manualReminderCount,
        postReminderDelaySeconds,
      };
    }));
    return {
      items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * OVR-4 server-owned open LATE_SUBMISSION snapshot for one job.
   *
   * Visibility follows the existing detail contract: STAFF reads its own
   * jobs, MANAGEMENT reads every job; cross-org stays 404. The elapsed
   * duration is computed from the injected request clock against the
   * canonical (earliest open) breach — clients render it verbatim and never
   * recompute domain time. The due-date `Geciken` contract is untouched.
   */
  async getSubmissionLateness(
    actor: JobCardActor,
    jobCardId: string,
  ): Promise<SubmissionLatenessSnapshot> {
    await this.detail(actor, jobCardId);
    const requestTime = this.now();
    const open = await this.repository.getOpenLateSubmissionIncidents(
      actor.organizationId, jobCardId,
    );
    if (open.length === 0) return { open: null };
    // Canonical operational signal: the earliest open breach of the current
    // episode. Revision-bound duplicates never move the visible clock.
    const byEpisode = new Map<number, Array<(typeof open)[number]>>();
    for (const incident of open) {
      const group = byEpisode.get(incident.episodeNo);
      if (group) group.push(incident);
      else byEpisode.set(incident.episodeNo, [incident]);
    }
    const current = [...byEpisode.values()]
      .map((rows) => rows[0]!)
      .sort((left, right) => left.breachedAt.getTime() - right.breachedAt.getTime())[0]!;
    const staffDelivery = await this.repository.getOverdueNotificationDelivery({
      organizationId: actor.organizationId,
      incidentId: current.id,
      kind: 'STAFF_REMINDER',
    });
    const escalationDelivery = await this.repository.getOverdueNotificationDelivery({
      organizationId: actor.organizationId,
      incidentId: current.id,
      kind: 'MANAGEMENT_ESCALATION',
    });
    const reminders = await this.repository.listSubmissionRemindersForIncident(
      actor.organizationId, jobCardId, current.id,
    );
    // JOB-010 release 2a (D1 §5): while a request is open, automatic OVR-4
    // Staff reminders stop and the wait is management time. The incident
    // itself is never closed or rewritten by the request.
    const openChangeRequest = await this.repository.getOpenChangeRequest(
      actor.organizationId, jobCardId,
    );
    return {
      open: {
        incidentId: current.id,
        delayType: 'LATE_SUBMISSION',
        episodeNo: current.episodeNo,
        scheduleRevisionNo: current.scheduleRevisionNo,
        deadlineAt: current.deadlineAt.toISOString(),
        breachedAt: current.breachedAt.toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((requestTime.getTime() - current.breachedAt.getTime()) / 1000),
        ),
        accountableUser: current.accountableUserId === null
          ? null
          : { id: current.accountableUserId, name: current.accountableUserName },
        accountableRole: current.accountableRole,
        staffReminderSentAt: staffDelivery?.sentAt.toISOString() ?? null,
        escalationSentAt: escalationDelivery?.sentAt.toISOString() ?? null,
        manualReminderSentAt: reminders[0]?.sentAt.toISOString() ?? null,
        manualReminderCount: reminders.length,
        changeRequestOpenSince: openChangeRequest?.requestedAt.toISOString() ?? null,
      },
    };
  }

  /**
   * OVR-4 manager operational list: currently open LATE_SUBMISSION episodes,
   * longest-waiting first, with the navigation context an escalation needs.
   * Management-only; STAFF keeps its per-job snapshot.
   */
  async listOpenSubmissionLate(
    actor: JobCardActor,
    page: PageQuery,
  ): Promise<{ items: OpenSubmissionLateItem[]; total: number; limit: number; offset: number }> {
    assertCanListOpenSubmissionLate(actor);
    const requestTime = this.now();
    const result = await this.repository.listOpenSubmissionLate({
      organizationId: actor.organizationId,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      items: result.items.map((item) => ({
        jobCardId: item.jobCardId,
        jobTitle: item.jobTitle,
        episodeNo: item.episodeNo,
        deadlineAt: item.deadlineAt.toISOString(),
        breachedAt: item.breachedAt.toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((requestTime.getTime() - item.breachedAt.getTime()) / 1000),
        ),
        staff: { id: item.staffId, name: item.staffName },
        customer: item.customerId === null
          ? null
          : { id: item.customerId, name: item.customerName ?? 'Belirtilmedi' },
        jobPath: `/jobs/${item.jobCardId}`,
      })),
      total: result.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  /**
   * OVR-4 manual manager reminder for an open LATE_SUBMISSION episode.
   *
   * Fail-closed: STAFF is rejected with 403 before any lookup; unknown or
   * cross-org jobs stay 404; stale versions, non-submittable statuses and
   * recovered (or never-late) episodes stay 409 without side effects.
   * Idempotency is two-layered: `processed_actions` replays the stored
   * response for the same clientActionId, and the UNIQUE manager-action
   * identity absorbs any residual duplicate before it can duplicate facts,
   * activities or notifications.
   */
  async sendSubmissionReminder(
    actor: JobCardActor,
    jobCardId: string,
    input: { clientActionId: string; expectedVersion: number },
  ): Promise<{ jobCardId: string; reminderId: string; sentAt: string }> {
    assertCanSendSubmissionReminder(actor);
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    const requestTime = this.now();
    const operationKey = `JOB_SUBMISSION_REMINDER:${jobCardId}`;
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
      },
      async (tx) => {
        // Staff-user lock contract (assignee-lock.ts): the reminder target
        // depends on the job, so the JobCard is read through a NON-locking
        // snapshot, both involved User rows are locked in one sorted call, and
        // only then is the JobCard locked — the same users -> JobCard order the
        // overdue/lateness workers and offboarding follow. A reassignment in
        // between must never silently redirect the reminder, so the assignment
        // is re-checked under the JobCard lock and a change is the same
        // VERSION_CONFLICT every concurrent edit reports.
        const snapshot = await tx.getJob(actor.organizationId, jobCardId);
        const lockedAssignees = await this.lockUsersInOrder(tx, actor.organizationId, [
          actor.id,
          snapshot?.assignedTo,
        ]);
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (!snapshot || snapshot.assignedTo !== job.assignedTo) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        if (job.version !== input.expectedVersion) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        if (job.status !== 'IN_PROGRESS' && job.status !== 'REVISION_REQUESTED') {
          throw new AppError(
            'SUBMISSION_REMINDER_NOT_APPLICABLE',
            409,
            'Bu iş şu anda onaya gönderme aşamasında değil.',
          );
        }
        const open = await tx.listOpenLateSubmissionIncidents(
          actor.organizationId, jobCardId,
        );
        if (open.length === 0) {
          throw new AppError(
            'SUBMISSION_NOT_LATE',
            409,
            'Bu işin açık bir onaya gönderme gecikmesi bulunmuyor.',
          );
        }
        const canonical = open[0]!;
        const target = lockedAssignees.get(job.assignedTo) ?? null;
        if (target === null || !target.isActive || target.role !== 'STAFF') {
          throw new AppError(
            'SUBMISSION_REMINDER_TARGET_UNPROVABLE',
            409,
            'Hatırlatma gönderilecek aktif personel bulunamadı.',
          );
        }
        const reminder = await tx.insertSubmissionReminder({
          organizationId: actor.organizationId,
          jobCardId,
          incidentId: canonical.id,
          episodeNo: canonical.episodeNo,
          scheduleRevisionNo: canonical.scheduleRevisionNo,
          managerUserId: actor.id,
          targetStaffUserId: target.id,
          sentAt: requestTime,
          clientActionId,
          operationKey,
        });
        const activity = await tx.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'JOB_SUBMISSION_REMINDER_SENT',
          clientActionId,
          metadata: {
            incidentId: canonical.id,
            delayType: 'LATE_SUBMISSION',
            episodeNo: canonical.episodeNo,
            scheduleRevisionNo: canonical.scheduleRevisionNo,
            breachedAt: canonical.breachedAt.toISOString(),
            deadlineAt: canonical.deadlineAt.toISOString(),
            sentAt: requestTime.toISOString(),
            targetStaffUserId: target.id,
          },
        });
        const mapped = mapJobCardActivityToRealtime({
          activityId: activity.id,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'JOB_SUBMISSION_REMINDER_SENT',
          occurredAt: requestTime,
          beforeAssigneeId: null,
          afterAssigneeId: job.assignedTo,
        });
        if (!mapped) {
          return {
            response: {
              jobCardId,
              reminderId: reminder.id,
              sentAt: requestTime.toISOString(),
            },
            realtimeEvents: [],
          };
        }
        const realtimeEvent = await tx.appendRealtimeEvent({
          ...mapped,
          resourceKeys: [...new Set([...mapped.resourceKeys, 'notifications'])].sort(),
        });
        const notifications = await tx.appendNotifications({
          organizationId: actor.organizationId,
          sourceRealtimeEventId: realtimeEvent.id,
          createdAt: requestTime,
          drafts: [{
            recipientUserId: target.id,
            kind: 'job.submission_reminder',
            entityType: 'job-card',
            entityId: jobCardId,
          }],
        });
        if (this.webPush.enabled && notifications.length > 0) {
          await tx.appendWebPushDeliveries({
            organizationId: actor.organizationId,
            notificationIds: notifications.map((notification) => notification.id),
            at: requestTime,
          });
        }
        return {
          response: {
            jobCardId,
            reminderId: reminder.id,
            sentAt: requestTime.toISOString(),
          },
          realtimeEvents: [realtimeEvent],
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  /**
   * JOB-010 §1a management early-start authorization.
   *
   * Fail-closed: STAFF is rejected with 403 before any lookup; unknown or
   * cross-org jobs stay 404; stale versions, terminal/other-type jobs and
   * already-authorized jobs stay 409 without side effects. The row records the
   * assignee and planned interval it was granted for, so a later reassignment
   * or reschedule invalidates it. Idempotency is `processed_actions` replay of
   * the stored response for the same clientActionId.
   */
  async grantEarlyStartAuthorization(
    actor: JobCardActor,
    jobCardId: string,
    input: EarlyStartAuthorizationInput,
  ): Promise<EarlyStartAuthorizationReceipt> {
    assertCanGrantEarlyStartAuthorization(actor);
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    const requestTime = this.now();
    const operationKey = `JOB_EARLY_START_AUTHORIZATION:${jobCardId}`;
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
        requestHash: earlyStartAuthorizationRequestHash(jobCardId, input.expectedVersion),
      },
      async (tx) => {
        // Staff-user lock contract (assignee-lock.ts): lock the assignee User
        // row BEFORE the JobCard row, like every other scheduling writer and
        // offboarding, so a concurrent offboarding transfer cannot deadlock
        // against the FK KEY SHARE taken by the authorization insert.
        const snapshot = await tx.getJob(actor.organizationId, jobCardId);
        if (!snapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        await this.lockUsersInOrder(tx, actor.organizationId, [snapshot.assignedTo]);
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion || job.assignedTo !== snapshot.assignedTo) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        if (
          (job.type !== 'PRODUCT_DELIVERY' && job.type !== 'SALES_MEETING')
          || (job.status !== 'NEW' && job.status !== 'ACCEPTED')
          || job.scheduledAt === null
        ) {
          throw new AppError(
            'EARLY_START_NOT_APPLICABLE',
            409,
            'Erken başlama izni yalnız planlanmış ürün teslimi veya satış görüşmesi '
              + 'işleri için, iş yeni ya da kabul edildi durumundayken verilebilir.',
          );
        }
        const scheduledAt = new Date(job.scheduledAt);
        const scheduledEndsAt = job.scheduledEndsAt === null ? null : new Date(job.scheduledEndsAt);
        const live = await tx.getLiveEarlyStartAuthorization(actor.organizationId, jobCardId);
        const stillValid = live !== null
          && live.assigneeUserId === job.assignedTo
          && live.scheduledAt.getTime() === scheduledAt.getTime()
          && (live.scheduledEndsAt?.getTime() ?? null)
            === (scheduledEndsAt?.getTime() ?? null);
        if (stillValid) {
          throw new AppError(
            'EARLY_START_ALREADY_AUTHORIZED',
            409,
            'Bu iş için geçerli bir erken başlama izni zaten var.',
          );
        }
        // A live row that no longer matches the job is a stale fact (the
        // invalidating edit happened outside the covered paths). Void it
        // truthfully before the partial-unique insert, so history stays
        // one-way and the new authorization is representable.
        if (live) {
          await tx.voidEarlyStartAuthorizations({
            organizationId: actor.organizationId,
            jobCardId,
            voidedAt: requestTime,
            voidReason: live.assigneeUserId !== job.assignedTo ? 'REASSIGNED' : 'RESCHEDULED',
          });
        }
        const scheduleRevisionNo = await tx.getCurrentScheduleRevisionNo(
          actor.organizationId, jobCardId,
        );
        if (scheduleRevisionNo === null) {
          throw new AppError(
            'EARLY_START_AUTHORIZATION_UNAVAILABLE',
            409,
            'İşin plan revizyonu bulunamadığı için erken başlama izni kaydedilemedi.',
          );
        }
        const authorization = await tx.insertEarlyStartAuthorization({
          organizationId: actor.organizationId,
          jobCardId,
          assigneeUserId: job.assignedTo,
          scheduleRevisionNo,
          scheduledAt,
          scheduledEndsAt,
          grantedBy: actor.id,
          grantedAt: requestTime,
          clientActionId,
        });
        const updated = await tx.bumpVersion(
          actor.organizationId, jobCardId, input.expectedVersion,
        );
        if (!updated) {
          throw new AppError(
            'VERSION_CONFLICT',
            409,
            'JobCard başka bir işlem tarafından güncellendi.',
          );
        }
        const activity = await tx.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'JOB_EARLY_START_AUTHORIZED',
          clientActionId,
          metadata: {
            authorizationId: authorization.id,
            assigneeUserId: job.assignedTo,
            scheduleRevisionNo,
            scheduledAt: scheduledAt.toISOString(),
            scheduledEndsAt: scheduledEndsAt?.toISOString() ?? null,
            grantedAt: authorization.grantedAt.toISOString(),
          },
        });
        const realtimeEvents = await this.appendRealtimeForActivity(tx, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: 'JOB_EARLY_START_AUTHORIZED',
          beforeAssigneeId: null,
          afterAssigneeId: job.assignedTo,
          customerId: job.customerId,
        });
        return {
          response: {
            jobCardId,
            authorizationId: authorization.id,
            grantedAt: authorization.grantedAt.toISOString(),
          } satisfies EarlyStartAuthorizationReceipt,
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  /**
   * JOB-010 release 2a (decision D1): Staff change/termination request.
   *
   * The request is the truthful alternative to cancelling a customer's job:
   * it never changes the JobCard row, status or version and deletes nothing.
   * Fail-closed: only the assigned STAFF may raise it (403 before any lookup
   * otherwise), unknown and cross-org jobs stay 404, a terminal job is 409
   * `JOB_NOT_ACTIVE` and a second request is 409 `CHANGE_REQUEST_ALREADY_OPEN`.
   * Idempotency is `processed_actions` replay of the stored response for the
   * same clientActionId. Activity, realtime event and the management
   * notifications commit in this same transaction.
   */
  async createChangeRequest(
    actor: JobCardActor,
    jobCardId: string,
    input: CreateChangeRequestInput,
  ): Promise<CreateChangeRequestReceipt> {
    assertCanCreateChangeRequest(actor);
    const clientActionId = requireActionId(input.clientActionId);
    if (!(JOB_CHANGE_REQUEST_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw validation('reasonCode');
    }
    const reasonCode = input.reasonCode as JobChangeRequestReasonCode;
    const reasonText = requireLifecycleReason(input.reasonText, 'reasonText');
    const requestTime = this.now();
    const operationKey = `JOB_CHANGE_REQUEST_CREATE:${jobCardId}`;
    const result = await this.repository.executeCriticalAction<CreateChangeRequestReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
        requestHash: changeRequestCreateRequestHash(jobCardId, { reasonCode, reasonText }),
      },
      async (tx) => {
        const snapshot = await tx.getJob(actor.organizationId, jobCardId);
        if (!snapshot || snapshot.assignedTo !== actor.id) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        // Assignee-before-JobCard lock order (assignee-lock.ts), like every
        // other writer that takes the FK KEY SHARE of the requested_by user.
        await this.lockUsersInOrder(tx, actor.organizationId, [snapshot.assignedTo]);
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job || job.assignedTo !== actor.id) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        if (isTerminalJobStatus(job.status)) {
          throw new AppError(
            'JOB_NOT_ACTIVE',
            409,
            'İş artık aktif olmadığı için öneri gönderilemez.',
          );
        }
        const existing = await tx.getOpenChangeRequest(actor.organizationId, jobCardId);
        if (existing !== null) {
          throw new AppError(
            'CHANGE_REQUEST_ALREADY_OPEN',
            409,
            'Bu iş için zaten açık bir öneri bulunuyor.',
          );
        }
        const changeRequest = await tx.insertChangeRequest({
          organizationId: actor.organizationId,
          jobCardId,
          requestedBy: actor.id,
          requestedAt: requestTime,
          jobStatusAtRequest: job.status,
          reasonCode,
          reasonText,
          clientActionId,
        });
        const activity = await tx.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'JOB_CHANGE_REQUESTED',
          clientActionId,
          metadata: {
            requestId: changeRequest.id,
            reasonCode,
            jobStatusAtRequest: job.status,
          },
        });
        const realtimeEvents = await this.appendRealtimeForActivity(tx, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          jobType: job.type,
          actorUserId: actor.id,
          event: 'JOB_CHANGE_REQUESTED',
          beforeAssigneeId: null,
          afterAssigneeId: job.assignedTo,
          customerId: job.customerId,
        });
        return {
          response: {
            jobCardId,
            changeRequestId: changeRequest.id,
            requestedAt: changeRequest.requestedAt.toISOString(),
          } satisfies CreateChangeRequestReceipt,
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  /**
   * JOB-010 release 2a (decision D1): management decision on an OPEN request.
   *
   * It records the decision only and never changes the JobCard; correcting,
   * rescheduling, creating a linked job or cancelling stay the existing
   * commands. Fail-closed: STAFF is rejected with 403 before any lookup,
   * unknown jobs and requests stay 404, an already closed request is 409
   * `CHANGE_REQUEST_NOT_OPEN`, a rejected request needs a note and a linked
   * job must be a different same-organization JobCard. Activity, realtime
   * event and the requester notification commit in this same transaction.
   */
  async resolveChangeRequest(
    actor: JobCardActor,
    jobCardId: string,
    changeRequestId: string,
    input: ResolveChangeRequestInput,
  ): Promise<ResolveChangeRequestReceipt> {
    assertCanResolveChangeRequest(actor);
    const clientActionId = requireActionId(input.clientActionId);
    if (!(JOB_CHANGE_REQUEST_DECISIONS as readonly string[]).includes(input.resolution)) {
      throw validation('resolution');
    }
    const resolution = input.resolution as JobChangeRequestDecision;
    const note = input.note === undefined || input.note === null
      ? null
      : optionalBoundedString(input.note, 'note', 2_000);
    if (resolution === 'REJECTED' && note === null) throw validation('note');
    const linkedJobCardId = input.linkedJobCardId === undefined
      || input.linkedJobCardId === null
      ? null
      : uuidString(input.linkedJobCardId, 'linkedJobCardId');
    if (resolution === 'LINKED_JOB_CREATED' && linkedJobCardId === null) {
      throw validation('linkedJobCardId');
    }
    if (resolution !== 'LINKED_JOB_CREATED' && linkedJobCardId !== null) {
      throw validation('linkedJobCardId');
    }
    const requestTime = this.now();
    const operationKey = `JOB_CHANGE_REQUEST_RESOLVE:${changeRequestId}`;
    const result = await this.repository.executeCriticalAction<ResolveChangeRequestReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
        requestHash: changeRequestResolveRequestHash(jobCardId, changeRequestId, {
          resolution,
          note,
          linkedJobCardId,
        }),
      },
      async (tx) => {
        const snapshot = await tx.getJob(actor.organizationId, jobCardId);
        if (!snapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        await this.lockUsersInOrder(tx, actor.organizationId, [snapshot.assignedTo]);
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        const resolved = await this.resolveChangeRequestInTransaction(tx, actor, job, {
          changeRequestId,
          resolution,
          note,
          linkedJobCardId,
          requestTime,
          clientActionId,
        });
        return {
          response: {
            jobCardId,
            changeRequestId,
            resolution,
            resolvedAt: requestTime.toISOString(),
          } satisfies ResolveChangeRequestReceipt,
          realtimeEvents: resolved.realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  /**
   * JOB-010 release 2a management decision list: OPEN requests, oldest first.
   * Management-only; STAFF is rejected with 403 before the read.
   */
  async listOpenChangeRequests(
    actor: JobCardActor,
    page: PageQuery,
  ): Promise<{ items: OpenChangeRequestItem[]; total: number; limit: number; offset: number }> {
    assertCanListOpenChangeRequests(actor);
    const result = await this.repository.listOpenChangeRequests({
      organizationId: actor.organizationId,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      items: result.items.map((item) => ({
        changeRequestId: item.changeRequestId,
        jobCardId: item.jobCardId,
        jobTitle: item.jobTitle,
        jobType: item.jobType,
        jobStatus: item.jobStatus,
        reasonCode: item.reasonCode,
        reasonText: item.reasonText,
        requestedAt: item.requestedAt.toISOString(),
        requestedBy: { id: item.requestedById, name: item.requestedByName },
        customer: item.customerId === null
          ? null
          : { id: item.customerId, name: item.customerName ?? 'Belirtilmedi' },
        jobPath: `/jobs/${item.jobCardId}`,
      })),
      total: result.total,
      limit: page.limit,
      offset: page.offset,
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

  /**
   * JOB-010 release 2b: management re-offers the same Staff member. A live
   * OPEN offer is a 409; an overdue one is closed EXPIRED in this same
   * transaction, so recovery never waits for the expiry worker.
   */
  async reofferAssignment(
    actor: JobCardActor,
    jobCardId: string,
    input: ReofferAssignmentInput,
  ): Promise<ReofferAssignmentReceipt> {
    assertCanReofferAssignment(actor);
    if (!this.assignmentWindowEnabled()) {
      throw new AppError(
        'ASSIGNMENT_WINDOW_DISABLED',
        409,
        'Atama kabul penceresi etkin değil.',
      );
    }
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    const acknowledgement = parsePastStartAcknowledgement(input.pastStartAcknowledgement);
    const requestTime = this.now();
    const operationKey = `JOB_ASSIGNMENT_REOFFER:${jobCardId}`;
    const result = await this.repository.executeCriticalAction<ReofferAssignmentReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey,
        requestHash: reofferAssignmentRequestHash(
          jobCardId, input.expectedVersion, acknowledgement,
        ),
      },
      async (tx) => {
        const snapshot = await tx.getJob(actor.organizationId, jobCardId);
        if (!snapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        // Assignee-before-JobCard lock order for every offer writer.
        await this.lockUsersInOrder(tx, actor.organizationId, [snapshot.assignedTo]);
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        if (job.status !== 'NEW'
          || !isAssignmentOfferJobType(job.type)
          || job.scheduledAt === null) {
          throw new AppError(
            'INVALID_TRANSITION',
            409,
            'Yalnız yeni durumdaki planlı ürün teslimi veya satış görüşmesi için teklif yenilenebilir.',
          );
        }
        const realtimeEvents: RealtimeEventRecord[] = [];
        const latest = await tx.getLatestAssignmentOffer(actor.organizationId, jobCardId);
        if (latest !== null && latest.state === 'OPEN') {
          if (isAcceptanceOnTime(requestTime, latest.acceptanceDueAt)) {
            throw new AppError(
              'ASSIGNMENT_OFFER_ALREADY_OPEN',
              409,
              'Bu iş için hâlâ yanıtlanmayı bekleyen bir atama teklifi var.',
            );
          }
          const expired = await tx.closeAssignmentOffer({
            organizationId: actor.organizationId,
            jobCardId,
            offerId: latest.id,
            expectedState: 'OPEN',
            state: 'EXPIRED',
            closedAt: requestTime,
            closedBy: null,
            closeReason: null,
            closeText: null,
          });
          if (!expired) {
            throw new AppError(
              'ASSIGNMENT_OFFER_ALREADY_OPEN',
              409,
              'Bu iş için hâlâ yanıtlanmayı bekleyen bir atama teklifi var.',
            );
          }
          const expiredActivity = await tx.appendActivity({
            organizationId: actor.organizationId,
            jobCardId,
            actorId: actor.id,
            event: 'JOB_ASSIGNMENT_OFFER_EXPIRED',
            metadata: {
              offerId: latest.id,
              acceptanceDueAt: latest.acceptanceDueAt.toISOString(),
              supersededByReoffer: true,
            },
          });
          realtimeEvents.push(...await this.appendRealtimeForActivity(tx, {
            activity: expiredActivity,
            organizationId: actor.organizationId,
            jobCardId,
            jobType: job.type,
            actorUserId: actor.id,
            event: 'JOB_ASSIGNMENT_OFFER_EXPIRED',
            beforeAssigneeId: null,
            afterAssigneeId: job.assignedTo,
            customerId: job.customerId,
            // The acting manager is already recovering this job with the new
            // offer: the overdue close is history, not a fresh alarm.
            suppressNotifications: true,
          }));
        }
        const opened = await this.openAssignmentOffer(tx, {
          actor,
          job,
          openedReason: 'REOFFER',
          requestTime,
          direct: true,
          acknowledgement,
        });
        if (opened === null) {
          throw new AppError(
            'INVALID_TRANSITION',
            409,
            'Bu iş için yeni bir atama teklifi oluşturulamadı.',
          );
        }
        const bumped = await tx.bumpVersion(
          actor.organizationId, jobCardId, input.expectedVersion,
        );
        if (!bumped) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        realtimeEvents.push(...opened.realtimeEvents);
        return {
          response: {
            jobCardId,
            offerId: opened.offer.id,
            acceptanceDueAt: opened.offer.acceptanceDueAt.toISOString(),
            urgentReason: opened.offer.urgentReason,
          } satisfies ReofferAssignmentReceipt,
          realtimeEvents,
        };
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  /**
   * JOB-010 release 2b §8: the management needs-action list. Management-only;
   * STAFF is rejected with 403 before the read. Deadlines are evaluated at
   * read time, so the list stays correct while the expiry worker is off.
   */
  async listAssignmentOffersNeedingAction(
    actor: JobCardActor,
    page: PageQuery,
  ): Promise<{
    items: NeedsActionAssignmentOfferItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    assertCanListAssignmentOffersNeedingAction(actor);
    const requestTime = this.now();
    const result = await this.repository.listAssignmentOffersNeedingAction({
      organizationId: actor.organizationId,
      requestTime,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      items: result.items.map((item) => ({
        jobCardId: item.jobCardId,
        jobTitle: item.jobTitle,
        jobType: item.jobType,
        offerId: item.offerId,
        state: item.state,
        closeReason: item.closeReason,
        closeText: item.closeText,
        acceptanceDueAt: item.acceptanceDueAt.toISOString(),
        urgentReason: item.urgentReason,
        scheduledAt: item.scheduledAt?.toISOString() ?? null,
        assignee: { id: item.assigneeId, name: item.assigneeName },
        customer: item.customerId === null
          ? null
          : { id: item.customerId, name: item.customerName ?? 'Belirtilmedi' },
        jobPath: `/jobs/${item.jobCardId}`,
      })),
      total: result.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  /**
   * OVR-6 §6.2: jobs JOB-010 does not own whose planned start passed without an
   * acceptance. Read-time clock, oldest planned start first, management only.
   * The list itself is never quiet-hours gated; only the automatic alert is.
   */
  async listUnacceptedPastStart(
    actor: JobCardActor,
    page: PageQuery,
  ): Promise<{
    items: UnacceptedPastStartItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    assertCanListUnacceptedPastStart(actor);
    const requestTime = this.now();
    const result = await this.repository.listUnacceptedPastStart({
      organizationId: actor.organizationId,
      requestTime,
      limit: page.limit,
      offset: page.offset,
    });
    return {
      items: result.items.map((item) => ({
        jobCardId: item.jobCardId,
        title: item.jobTitle,
        type: item.jobType,
        jobPath: `/jobs/${item.jobCardId}`,
        assignee: { id: item.assigneeId, name: item.assigneeName, active: item.assigneeActive },
        scheduledAt: item.scheduledAt.toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((requestTime.valueOf() - item.scheduledAt.valueOf()) / 1000),
        ),
        hasOpenChangeRequest: item.hasOpenChangeRequest,
      })),
      total: result.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async acceptAssignment(actor: JobCardActor, jobCardId: string, input: LifecycleInput) {
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'ACCEPT_ASSIGNMENT', operationKey: 'JOB_ACCEPT_ASSIGNMENT',
      target: 'ACCEPTED', event: 'JOB_ACCEPTED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    });
  }

  /**
   * JOB-010 release 2b (§5): the assigned Staff member hands the assignment
   * back before management acts. The job stays NEW and assigned; the offer is
   * closed DECLINED with the structured reason and its mandatory text.
   */
  async declineAssignment(
    actor: JobCardActor,
    jobCardId: string,
    input: AssignmentOfferDecisionInput,
  ) {
    const assignmentReason = this.assignmentDecisionReason(input);
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'DECLINE_ASSIGNMENT', operationKey: 'JOB_DECLINE_ASSIGNMENT',
      target: 'NEW', event: 'JOB_ASSIGNMENT_DECLINED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
      assignmentReason,
    });
  }

  /**
   * JOB-010 release 2b (§5): the assigned Staff member releases an accepted
   * assignment before START. The LATE_START obligation of the pre-release
   * acceptance is materialized first, then the job returns to NEW and the
   * offer moves ACCEPTED -> RELEASED.
   */
  async releaseAssignment(
    actor: JobCardActor,
    jobCardId: string,
    input: AssignmentOfferDecisionInput,
  ) {
    const assignmentReason = this.assignmentDecisionReason(input);
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'RELEASE_ASSIGNMENT', operationKey: 'JOB_RELEASE_ASSIGNMENT',
      target: 'NEW', event: 'JOB_ASSIGNMENT_RELEASED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
      assignmentReason,
    });
  }

  private assignmentDecisionReason(
    input: AssignmentOfferDecisionInput,
  ): { code: string; text: string } {
    if (!(JOB_ASSIGNMENT_OFFER_DECLINE_REASON_CODES as readonly string[])
      .includes(input.reasonCode)) {
      throw validation('reasonCode');
    }
    return {
      code: input.reasonCode,
      text: requireLifecycleReason(input.reasonText, 'reasonText'),
    };
  }

  async start(
    actor: JobCardActor,
    jobCardId: string,
    input: StartInput,
    presentation?: { includeSubmitLocationCapability?: boolean },
  ) {
    const lifecycleInput = this.lifecycleInput(input);
    const definition: LifecycleDefinition = {
      command: 'START', operationKey: 'JOB_START', target: 'IN_PROGRESS', event: 'JOB_STARTED',
      note: null, revisionReason: null, cancelReason: null,
      noteContext: null,
    };
    assertStaffStartActor(actor);
    if (!this.geolocation.enabled) {
      return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, undefined, undefined, presentation);
    }

    const capture = parseStartLocationCapture(input.locationCapture);
    const claim = this.intentClaim(actor, jobCardId, lifecycleInput.clientActionId, definition, lifecycleInput, capture);
    const completed = await this.repository.findCompletedLifecycleIntent<unknown>(claim);
    if (completed) {
      const receipt = decodeJobCardMutationReceipt(completed);
      return this.presentLifecycleReceipt(actor, receipt, presentation);
    }

    // #347 product decision: location is important but never workflow-blocking.
    // A valid UNAVAILABLE capture starts the job exactly like a captured one;
    // the unavailable envelope is persisted as JOB_STARTED evidence below.
    // 049: reserve BEFORE the provider call. The reservation commits and
    // releases the JobCard lock, so geocoder latency never holds it; the
    // claim hash covers only the pre-provider capture core, which the
    // normalizer keeps stable across provider resolution, so the same
    // claim finalizes below.
    const reserved = await this.repository.reserveLifecycleIntent<JobCardMutationReceipt>(
      claim,
      { jobCardId, ttlMs: this.intentTtlMs(),
        preflight: async (tx, job, reservedAt) => this.assertLifecycleReservation(tx, actor, job, definition, reservedAt),
      },
    );
    if (reserved.kind === 'replay') {
      const receipt = decodeJobCardMutationReceipt(reserved.response);
      return this.presentLifecycleReceipt(actor, receipt, presentation);
    }
    const resolvedCapture = await this.resolveActionLocation({
      organizationId: actor.organizationId,
      actorUserId: actor.id,
      capture,
      correlationId: lifecycleInput.clientActionId,
      // #347: location infrastructure must never prevent START. Quota-store
      // exceptions degrade to FAILED enrichment, exactly like advisory SUBMIT.
      softInfrastructureFailure: true,
    });
    return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, { action: 'JOB_STARTED', capture: resolvedCapture }, {
      claim,
      reservation: reserved.reservation,
    }, presentation);
  }

  async submitForApproval(
    actor: JobCardActor,
    jobCardId: string,
    input: SubmitInput,
    presentation?: { includeSubmitLocationCapability?: boolean },
  ) {
    const lifecycleInput = this.lifecycleInput(input);
    const definition: LifecycleDefinition = {
      command: 'SUBMIT_FOR_APPROVAL', operationKey: 'JOB_SUBMIT_FOR_APPROVAL',
      target: 'WAITING_APPROVAL', event: 'JOB_SUBMITTED_FOR_APPROVAL',
      note: requireSubmissionNote(input.note), revisionReason: null, cancelReason: null,
      noteContext: 'SUBMIT_FOR_APPROVAL',
      followUpProposal: input.followUpProposal,
    };
    // Slice 1: the SUBMIT location is advisory/soft. Unlike START, an omitted
    // or unavailable capture never blocks the transition; only a malformed
    // supplied envelope is a validation error. When action-scoped
    // geolocation is disabled (or the actor is not Staff) any supplied
    // capture is discarded before parsing, exactly like the START path.
    if (!this.geolocation.enabled || actor.role !== 'STAFF') {
      return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, undefined, undefined, presentation);
    }
    if (input.locationCapture === undefined) {
      return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, undefined, undefined, presentation);
    }
    const capture: ActionLocationCapture = parseActionLocationCapture(input.locationCapture);
    const claim = this.intentClaim(actor, jobCardId, lifecycleInput.clientActionId, definition, lifecycleInput, capture);
    const completed = await this.repository.findCompletedLifecycleIntent<unknown>(claim);
    if (completed) {
      const receipt = decodeJobCardMutationReceipt(completed);
      return this.presentLifecycleReceipt(actor, receipt, presentation);
    }
    // Reserve BEFORE the provider call so geocoder latency never holds the
    // JobCard lock; the claim hash covers only the pre-provider capture
    // core, which the normalizer keeps stable across provider resolution.
    const reserved = await this.repository.reserveLifecycleIntent<JobCardMutationReceipt>(
      claim,
      { jobCardId, ttlMs: this.intentTtlMs(),
        preflight: async (tx, job, reservedAt) => this.assertLifecycleReservation(tx, actor, job, definition, reservedAt),
      },
    );
    if (reserved.kind === 'replay') {
      const receipt = decodeJobCardMutationReceipt(reserved.response);
      return this.presentLifecycleReceipt(actor, receipt, presentation);
    }
    const resolvedCapture = await this.resolveActionLocation({
      organizationId: actor.organizationId,
      actorUserId: actor.id,
      capture,
      correlationId: lifecycleInput.clientActionId,
      softInfrastructureFailure: true,
    });
    return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, { action: 'JOB_SUBMITTED_FOR_APPROVAL', capture: resolvedCapture }, {
      claim,
      reservation: reserved.reservation,
    }, presentation);
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
    // OVR-5b §3.1: syntax first, before the intent claim and the hash.
    const correctionDueAt = revisionCorrectionDueAt(input);
    return this.runLifecycle(actor, jobCardId, this.lifecycleInput(input), {
      command: 'REQUEST_REVISION', operationKey: 'JOB_REQUEST_REVISION', target: 'REVISION_REQUESTED',
      event: 'JOB_REVISION_REQUESTED', note: null,
      revisionReason: lifecycleReason(input.revisionReason, 'revisionReason'), cancelReason: null,
      noteContext: 'REQUEST_REVISION',
      ...(correctionDueAt === undefined ? {} : { correctionDueAt }),
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
      cancelContinuity: parseFollowUpCancelContinuity(input.followUpContinuity),
    });
  }

  private lifecycleInput(input: LifecycleInput) {
    const clientActionId = requireActionId(input.clientActionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validation('expectedVersion');
    }
    return { clientActionId, expectedVersion: input.expectedVersion };
  }

  private async assertLifecycleReservation(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    definition: LifecycleDefinition,
    reservedAt: Date,
  ): Promise<void> {
    if (definition.command === 'START') assertStaffStartActor(actor);
    // JOB-010 release 2b: the offer state is read under the same JobCard lock
    // and passed to the policy so the answer commands exist only in the
    // window, then checked against the deadline (preflight).
    const offer = await this.assertAssignmentOfferCommand(
      tx, actor, job, definition.command, reservedAt,
    );
    assertCanTransition(
      actor,
      { ...job, assignmentOffer: this.assignmentOfferSummary(offer) },
      definition.command,
      definition.revisionReason ?? definition.cancelReason ?? undefined,
      reservedAt,
      { assignmentWindowEnabled: this.assignmentWindowEnabled() },
    );
    if (definition.command === 'START') assertPlannedIntervalForStart(job);
    if (definition.command === 'CANCEL') {
      assertFollowUpCancelContinuity(job, definition.cancelContinuity ?? null, reservedAt);
    }
    // OVR-5b §3.1: the correction-deadline bound is checked against the
    // reservation instant here and again in finalize against the same
    // reserved_at. Skipped when the job has no original submission deadline.
    if (definition.correctionDueAt !== undefined) {
      await this.assertCorrectionDeadlineBounds(tx, job, definition.correctionDueAt, reservedAt);
    }
  }

  private async runLifecycle(
    actor: JobCardActor,
    jobCardId: string,
    input: { clientActionId: string; expectedVersion: number },
    definition: LifecycleDefinition,
    actionLocation?: { action: JobActionLocationAction; capture: JobActionLocationCapture },
    preReserved?: { claim: LifecycleIntentClaim; reservation: LifecycleIntentReservation },
    presentation?: { includeSubmitLocationCapability?: boolean },
  ) {
    const claim = preReserved?.claim
      ?? this.intentClaim(actor, jobCardId, input.clientActionId, definition, input, actionLocation?.capture);
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
      return this.presentLifecycleReceipt(actor, receipt, presentation);
    }
    const reserved = preReserved
      ? { kind: 'reserved' as const, reservation: preReserved.reservation }
      : await this.repository.reserveLifecycleIntent<JobCardMutationReceipt>(
        claim,
        { jobCardId, ttlMs: this.intentTtlMs(),
        preflight: async (tx, job, reservedAt) => this.assertLifecycleReservation(tx, actor, job, definition, reservedAt),
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
    // The users locked in `lockUsers` are chosen from this UNLOCKED snapshot.
    // Kept so the finalize transaction can prove the governed assignment did
    // not change between choosing the locks and taking the JobCard lock.
    let lockedJobSnapshot: JobCard | null = null;
    // Slice 2: advisory SUBMIT comparison computed inside the finalize
    // transaction (null when inapplicable). Carried on the receipt response
    // so replays return the identical durable result without recomputing.
    let submitLocationComparison: JobActionLocationComparison | null = null;
    const result = await this.repository.finalizeLifecycleIntent<JobCardMutationReceipt>(
      claim,
      reserved.reservation,
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        // The locked users were resolved from the pre-lock snapshot. If the
        // assignment or the persisted follow-up proposal changed in that
        // window, those locks no longer cover the rows this command will
        // touch: fail closed with the same concurrency error as every other
        // stale-view command instead of 404-ing on a missing assignee row or
        // silently proceeding on locks taken for a previous owner.
        if (lockedJobSnapshot !== null
          && (job.assignedTo !== lockedJobSnapshot.assignedTo
            || job.followUpProposedAssignee !== lockedJobSnapshot.followUpProposedAssignee)) {
          throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        }
        if (definition.command === 'START' && actionLocation) assertStaffStartActor(actor);
        // JOB-010 release 2b: re-check the offer state and the deadline in the
        // finalize transaction. A stale view is a 409 and writes nothing.
        const lifecycleAssignmentOffer = await this.assertAssignmentOfferCommand(
          tx, actor, job, definition.command, requestTime,
        );
        assertCanTransition(
          actor,
          { ...job, assignmentOffer: this.assignmentOfferSummary(lifecycleAssignmentOffer) },
          definition.command,
          definition.revisionReason ?? definition.cancelReason ?? undefined,
          requestTime,
          { assignmentWindowEnabled: this.assignmentWindowEnabled() },
        );
        if (definition.command === 'START') {
          assertPlannedIntervalForStart(job);
        }
        if (definition.command === 'CANCEL') {
          assertFollowUpCancelContinuity(job, definition.cancelContinuity ?? null, requestTime);
        }
        // OVR-5b §3: the stored correction deadline of a revision episode is
        // decided once here, under the JobCard lock and against reserved_at:
        // the supplied value, else reserved_at + 24h, else NULL when the job
        // has no original deadline at all (§3.4). It never changes afterwards.
        const storedCorrectionDueAt = definition.command === 'REQUEST_REVISION'
          ? await this.resolveStoredCorrectionDueAt(tx, job, definition.correctionDueAt, requestTime)
          : null;
        // JOB-010 §5: releasing materializes the OVR-2 obligation of the
        // acceptance that is about to be cleared, so handing the job back can
        // never hide a breach. It runs BEFORE the transition, like the JOB-006
        // management reset and the offboarding transfer.
        if (definition.command === 'RELEASE_ASSIGNMENT') {
          await this.materializeLateStartIfBreached(tx, {
            organizationId: actor.organizationId,
            jobCardId,
            scheduledEndsAt: job.scheduledEndsAt,
            scheduleRevisionNo: null,
            revisionEffectiveAt: null,
            source: 'MUTATION',
            requestTime,
          });
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
                {
                  outcome: submissionMeetingDetails?.outcome ?? null,
                  nextFollowUpAt: submissionMeetingDetails?.nextFollowUpAt ?? null,
                },
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
          followUpCycleEndReason: definition.cancelContinuity?.decision === 'END_CYCLE'
            ? definition.cancelContinuity.endReason
            : null,
          followUpProposal: persistedProposal,
        });
        if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        // JOB-010 release 2b: the answer commands close their offer in this
        // same transaction. CANCEL takes a live OPEN offer back. The offer id
        // rides the command's own activity so every close has an activity row
        // that names it (the accepted one is JOB_ACCEPTED itself).
        let assignmentOfferMetadata: Record<string, unknown> | null = null;
        const lifecycleOfferEvents: RealtimeEventRecord[] = [];
        if (lifecycleAssignmentOffer !== null
          && (definition.command === 'ACCEPT_ASSIGNMENT'
            || definition.command === 'DECLINE_ASSIGNMENT'
            || definition.command === 'RELEASE_ASSIGNMENT')) {
          const reasonCode = definition.assignmentReason?.code ?? null;
          const reasonText = definition.assignmentReason?.text ?? null;
          const closeState = definition.command === 'ACCEPT_ASSIGNMENT'
            ? 'ACCEPTED' as const
            : definition.command === 'DECLINE_ASSIGNMENT'
              ? 'DECLINED' as const
              : 'RELEASED' as const;
          const closed = await tx.closeAssignmentOffer({
            organizationId: actor.organizationId,
            jobCardId,
            offerId: lifecycleAssignmentOffer.id,
            expectedState: definition.command === 'RELEASE_ASSIGNMENT' ? 'ACCEPTED' : 'OPEN',
            state: closeState,
            closedAt: requestTime,
            closedBy: actor.id,
            closeReason: closeState === 'ACCEPTED' ? null : reasonCode,
            closeText: closeState === 'ACCEPTED' ? null : reasonText,
          });
          if (!closed) {
            throw new AppError(
              'ASSIGNMENT_OFFER_NOT_OPEN',
              409,
              'Atama teklifi bu işlem için uygun durumda değil.',
            );
          }
          assignmentOfferMetadata = closeState === 'ACCEPTED'
            ? { offerId: lifecycleAssignmentOffer.id }
            : {
                offerId: lifecycleAssignmentOffer.id,
                reasonCode,
                reasonText,
              };
        }
        if (definition.command === 'CANCEL') {
          // JOB-010 release 2b: cancellation withdraws a live OPEN offer.
          lifecycleOfferEvents.push(...await this.withdrawOpenAssignmentOffer(tx, {
            actor,
            job: updated,
            requestTime,
            reason: 'CANCELLED',
          }));
        }
        // JOB-010 release 2a (D1): the command that ends the job's open
        // question also closes an OPEN change/termination request in this same
        // transaction — CANCEL truthfully as CANCELLED, APPROVE as SUPERSEDED.
        // The cancel reason stays the actor's own text; the request text is
        // never copied into it.
        if (definition.command === 'CANCEL' || definition.command === 'APPROVE') {
          const resolution = definition.command === 'CANCEL' ? 'CANCELLED' : 'SUPERSEDED';
          const closed = await tx.closeOpenChangeRequest({
            organizationId: actor.organizationId,
            jobCardId,
            resolution,
            resolvedBy: actor.id,
            resolvedAt: requestTime,
          });
          // Audit trail: the closure is its own fact in the job timeline. The
          // command's own activity/realtime already covers notifications.
          if (closed) {
            await tx.appendActivity({
              organizationId: actor.organizationId,
              jobCardId,
              actorId: actor.id,
              event: 'JOB_CHANGE_REQUEST_RESOLVED',
              metadata: { requestId: closed.id, resolution, linkedJobCardId: null },
            });
          }
        }
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
          // The author's users row was already locked users-first in the
          // finalize `lockUsers` hook; this snapshot only re-reads it.
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

        if (definition.cancelContinuity) {
          // JOB-009: the cancel records whether the follow-up cycle continues.
          metadata = {
            ...(metadata ?? {}),
            followUpContinuity: definition.cancelContinuity.decision === 'RESCHEDULE'
              ? { decision: 'RESCHEDULE', scheduledAt: definition.cancelContinuity.scheduledAt }
              : { decision: 'END_CYCLE', endReason: definition.cancelContinuity.endReason },
          };
        }
        if (assignmentOfferMetadata !== null) {
          metadata = { ...(metadata ?? {}), ...assignmentOfferMetadata };
        }
        // OVR-5b §3.7: the revision activity records the stored correction
        // deadline (null when the job has no original deadline). The in-app
        // notification text stays unchanged.
        if (definition.command === 'REQUEST_REVISION') {
          metadata = {
            ...(metadata ?? {}),
            correctionDueAt: storedCorrectionDueAt === null
              ? null
              : storedCorrectionDueAt.toISOString(),
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
        if (actionLocation) {
          // Slice 2: the SUBMIT comparison is computed from immutable
          // evidence inside the same transaction and persisted with the
          // SUBMIT row, so submit + activity + location + comparison commit
          // (or roll back) atomically. START rows never carry comparison.
          submitLocationComparison = actionLocation.action === 'JOB_SUBMITTED_FOR_APPROVAL'
            ? await this.resolveSubmitLocationComparison(
              tx, actor.organizationId, jobCardId, actionLocation.capture,
            )
            : null;
          await tx.appendJobActionLocation({
            organizationId: actor.organizationId,
            jobCardId,
            activityId: activity.id,
            actorUserId: actor.id,
            action: actionLocation.action,
            capture: actionLocation.capture,
            ...(submitLocationComparison ? { comparison: submitLocationComparison } : {}),
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
            storedCorrectionDueAt,
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
          // JOB-008: the approval-created child is never blocked by chain
          // length; the 10-level cap applies to manual createFollowUp only.
          // A DEMO parent's child stays in the same demo dataset (same rule as
          // createFollowUp and the JOB-009 replacement), so a complete demo
          // purge also removes it.
          const childIsDemo = source.dataClass === 'DEMO' && source.demoDatasetId !== null;
          const childTitle = Array.from(`Takip: ${updated.title.trim()}`).slice(0, 250).join('');
          const child = await this.createFollowUpChild(tx, actor, {
            dataClass: childIsDemo ? 'DEMO' : 'BUSINESS',
            demoDatasetId: childIsDemo ? source.demoDatasetId : null,
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
            // JOB-010 release 2b: the approval-created child that starts in
            // NEW is a compound producer — it can never ask for an
            // acknowledgement.
            assignmentOffer: {
              openedReason: 'APPROVE_FOLLOW_UP',
              direct: false,
            },
          });
          followUpJobCardId = child.job.id;
          childRealtimeEvents = child.realtimeEvents;
        }
        if (definition.cancelContinuity?.decision === 'RESCHEDULE') {
          // JOB-009: the replacement commits with the cancel. The cancelled
          // visit no longer occupies the calendar, so the same Staff may take
          // an overlapping replacement slot.
          // The replacement follows up the same completed visit as the
          // cancelled one (a follow-up source is always an approved JobCard);
          // which visit it replaces is recorded on its JOB_CREATED activity.
          // A replacement of a DEMO visit stays in the same demo dataset, so a
          // complete demo purge also removes it (same rule as createFollowUp).
          const cancelledVisit = await tx.getFollowUpSource(actor.organizationId, jobCardId);
          if (!cancelledVisit) followUpInvariantViolation();
          const replacementIsDemo = cancelledVisit.dataClass === 'DEMO' && cancelledVisit.demoDatasetId !== null;
          const replacement = await this.createFollowUpChild(tx, actor, {
            dataClass: replacementIsDemo ? 'DEMO' : 'BUSINESS',
            demoDatasetId: replacementIsDemo ? cancelledVisit.demoDatasetId : null,
            sourceJobCardId: updated.sourceJobCardId,
            customerId: updated.customerId,
            type: 'SALES_MEETING',
            title: updated.title,
            followUpInstructions: updated.followUpInstructions,
            scheduledAt: definition.cancelContinuity.scheduledAt,
            assignedTo: updated.assignedTo,
            priority: updated.priority,
            dueDate: null,
            contactId: updated.contactId,
            engagementKind: 'FOLLOW_UP',
            clientActionId: input.clientActionId,
            requestTime,
            assignee: lockedAssignees.get(updated.assignedTo) ?? null,
            ...(actor.id === updated.assignedTo
              ? { acceptance: { acceptedAt: requestTime, acceptedBy: actor.id } }
              : {}),
            activityMetadata: {
              replacesJobCardId: jobCardId,
            },
            // JOB-010 release 2b: the JOB-009 replacement that starts in NEW
            // is a compound producer.
            assignmentOffer: {
              openedReason: 'CANCEL_REPLACEMENT',
              direct: false,
            },
          });
          followUpJobCardId = replacement.job.id;
          childRealtimeEvents = replacement.realtimeEvents;
        }
        const realtimeEvents = await this.appendRealtimeForActivity(tx, {
          activity,
          organizationId: actor.organizationId,
          jobCardId,
          actorUserId: actor.id,
          event: definition.event, jobType: job.type,
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
            ...(submitLocationComparison ? { submitLocationComparison } : {}),
          },
          realtimeEvents: [...realtimeEvents, ...childRealtimeEvents, ...lifecycleOfferEvents],
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
          const mayReschedule = definition.cancelContinuity?.decision === 'RESCHEDULE';
          // The transition note's author snapshot is a users-row lock taken
          // further down, under the JobCard lock. Its id is known here, so it
          // joins the same sorted users-first lock set as the scheduling ids.
          const mayWriteTransitionNote = definition.noteContext !== null
            && (definition.note ?? definition.revisionReason ?? definition.cancelReason) !== null;
          const userIds: Array<string | null | undefined> = [
            ...(mayWriteTransitionNote ? [actor.id] : []),
          ];
          if (mayReschedule || mayScheduleFollowUp) {
            // One unlocked snapshot decides which users to lock; the finalize
            // transaction re-checks it under the JobCard lock.
            const jobSnapshot = await tx.getJob(actor.organizationId, jobCardId);
            if (!jobSnapshot) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
            lockedJobSnapshot = jobSnapshot;
            if (mayReschedule) {
              userIds.push(jobSnapshot.assignedTo);
            }
            if (mayScheduleFollowUp) {
              const needsSchedulingUserLocks = jobSnapshot.type === 'SALES_MEETING'
                || jobSnapshot.followUpProposedAssignee !== null
                || definition.followUpProposal?.assignedTo !== undefined
                || definition.approveFollowUp?.assignedTo !== undefined;
              if (needsSchedulingUserLocks) {
                userIds.push(
                  jobSnapshot.assignedTo,
                  jobSnapshot.followUpProposedAssignee,
                  definition.followUpProposal?.assignedTo,
                  definition.approveFollowUp?.assignedTo,
                );
              }
            }
          }
          lockedAssignees = await this.lockUsersInOrder(tx, actor.organizationId, userIds);
        },
      },
    );
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    const receipt = decodeJobCardMutationReceipt(result.response);
    return this.presentLifecycleReceipt(actor, receipt, presentation);
  }

  private async presentLifecycleReceipt(
    actor: JobCardActor,
    receipt: ReturnType<typeof decodeJobCardMutationReceipt>,
    presentation?: { includeSubmitLocationCapability?: boolean },
  ) {
    const detail = await this.detailAt(actor, receipt.jobCardId, receipt.evaluatedAt ?? this.now(), {
      ...presentation,
      submitLocationComparison: receipt.submitLocationComparison,
    });
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
    correctionDueAt: Date | null = null,
  ): Promise<number> {
    const episodeNo = await tx.getNextSubmittedSeqNo(organizationId, jobCardId);
    await tx.insertSubmissionEpisodeActivation({
      organizationId,
      jobCardId,
      episodeNo,
      activatedAt: requestTime,
      activatedByCommand: command,
      // OVR-5b §3: only a REQUEST_REVISION activation can carry one.
      correctionDueAt: command === 'REQUEST_REVISION' ? correctionDueAt : null,
    });
    return episodeNo;
  }

  /**
   * OVR-5b §3.4: the job's original effective submission deadline under the
   * current governing values, ignoring any correction. Null means the job has
   * no submission lateness today and keeps none.
   */
  private async originalSubmissionDeadline(
    tx: JobCardTransaction,
    job: JobCard,
  ): Promise<Date | null> {
    const phaseDeadline = job.scheduledEndsAt
      ?? (job.type === 'SALES_MEETING' ? null : job.scheduledAt);
    if (phaseDeadline === null && job.dueDate === null) return null;
    // The due-date fallback is the only timezone-dependent branch, exactly as
    // the shared producer resolves it.
    const timezone = phaseDeadline === null
      ? await tx.getOrganizationTimezone(job.organizationId)
      : 'UTC';
    return effectiveSubmissionDeadlineAt({
      scheduledEndsAt: job.scheduledEndsAt,
      scheduledAt: job.scheduledAt,
      type: job.type,
      dueDate: job.dueDate,
      timezone,
    });
  }

  /** OVR-5b §3.1 accepted bound: 1 hour to 14 days after the arming instant. */
  private assertCorrectionDeadlineBoundsValue(correction: Date, reservedAt: Date): void {
    const value = correction.getTime();
    const earliest = reservedAt.getTime() + CORRECTION_DEADLINE_MIN_HOURS * 3_600_000;
    const latest = reservedAt.getTime() + CORRECTION_DEADLINE_MAX_DAYS * 86_400_000;
    if (Number.isNaN(value) || value < earliest || value > latest) {
      throw correctionDueAtError(CORRECTION_DUE_AT_BOUNDS_MESSAGE);
    }
  }

  /**
   * OVR-5b §3.1 reservation preflight: validate the supplied correction
   * deadline against `reservedAt`. Skipped when §3.4 applies (no original
   * deadline), so a syntactically valid value is ignored there.
   */
  private async assertCorrectionDeadlineBounds(
    tx: JobCardTransaction,
    job: JobCard,
    correctionDueAt: string,
    reservedAt: Date,
  ): Promise<void> {
    if (await this.originalSubmissionDeadline(tx, job) === null) return;
    this.assertCorrectionDeadlineBoundsValue(new Date(correctionDueAt), reservedAt);
  }

  /**
   * OVR-5b §3: the value persisted on the REQUEST_REVISION activation row.
   * Re-validates the bound against the same reserved_at the finalize commits,
   * materializes the 24h default, and returns NULL when the job has no
   * original deadline.
   */
  private async resolveStoredCorrectionDueAt(
    tx: JobCardTransaction,
    job: JobCard,
    supplied: string | undefined,
    reservedAt: Date,
  ): Promise<Date | null> {
    if (await this.originalSubmissionDeadline(tx, job) === null) return null;
    const correction = supplied === undefined
      ? new Date(reservedAt.getTime() + CORRECTION_DEADLINE_DEFAULT_HOURS * 3_600_000)
      : new Date(supplied);
    this.assertCorrectionDeadlineBoundsValue(correction, reservedAt);
    return correction;
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

  /**
   * OVR-5b §4.1–§4.7: the authorized deadline extension of one management
   * patch. Under the NEW field values it evaluates, per open deadline
   * obligation, that delay type's first-late boundary:
   *
   * - `null` => the patch removes the governing boundary of a still-open
   *   obligation: rejected with `OPEN_LATENESS_DEADLINE_REQUIRED` (§4.3);
   * - after the patch instant => the obligation is no longer late: every open
   *   row of that (job, delay type, episode) is ended with the reason, the
   *   actor, the instant and the appended revision (§4.6);
   * - at or before the patch instant => still late, nothing is ended (§4.2).
   *
   * Only `LATE_START` episode 1 and the current `LATE_SUBMISSION` episode take
   * part. `APPROVAL_WAIT` is management delay with no schedule deadline and is
   * never ended (§4.4). A missing reason is rejected before any ending (§4.5).
   */
  private async endOpenObligationsByExtension(
    tx: JobCardTransaction,
    input: {
      organizationId: string;
      jobCardId: string;
      job: JobCard;
      actorId: string;
      requestTime: Date;
      reason: string | null;
      scheduleRevisionNo: number;
    },
  ): Promise<{
    delayTypes: OpenDeadlineDelayType[];
    endings: Array<{
      delayType: OpenDeadlineDelayType;
      episodeNo: number;
      previousFirstLateAt: string;
      newFirstLateAt: string;
    }>;
    reason: string;
  } | null> {
    const open = await tx.listOpenDeadlineIncidents({
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
    });
    if (open.length === 0) return null;

    const currentEpisodeNo = await tx.getNextSubmittedSeqNo(
      input.organizationId, input.jobCardId,
    );
    // The correction deadline of the evaluated submission episode belongs to
    // the §3 effective-deadline formula; the LATE_START boundary needs none.
    let submissionFirstLateAt: Date | null | undefined;
    const lateStartFirstLateAt = lateStartDeadlineAt(input.job.scheduledEndsAt);
    const groups = new Map<string, {
      delayType: OpenDeadlineDelayType;
      episodeNo: number;
      newFirstLateAt: Date;
    }>();

    for (const incident of open) {
      if (incident.delayType === 'LATE_START' && incident.episodeNo !== 1) continue;
      if (incident.delayType === 'LATE_SUBMISSION'
        && incident.episodeNo !== currentEpisodeNo) continue;
      let firstLateAt: Date | null;
      if (incident.delayType === 'LATE_START') {
        firstLateAt = lateStartFirstLateAt;
      } else {
        if (submissionFirstLateAt === undefined) {
          const activation = await tx.getSubmissionEpisodeActivation(
            input.organizationId, input.jobCardId, currentEpisodeNo,
          );
          const phaseDeadline = input.job.scheduledEndsAt
            ?? (input.job.type === 'SALES_MEETING' ? null : input.job.scheduledAt);
          const timezone = phaseDeadline === null && input.job.dueDate !== null
            ? await tx.getOrganizationTimezone(input.organizationId)
            : 'UTC';
          const effective = effectiveSubmissionDeadlineAt({
            scheduledEndsAt: input.job.scheduledEndsAt,
            scheduledAt: input.job.scheduledAt,
            type: input.job.type,
            dueDate: input.job.dueDate,
            timezone,
            correctionDueAt: activation?.correctionDueAt ?? null,
          });
          submissionFirstLateAt = effective === null
            ? null
            : submissionBreachInstant(effective);
        }
        firstLateAt = submissionFirstLateAt;
      }
      if (firstLateAt === null) {
        throw new AppError(
          'OPEN_LATENESS_DEADLINE_REQUIRED',
          409,
          'Gecikmesi açık işin son tarihi kaldırılamaz; ileri bir tarih seçin.',
        );
      }
      if (firstLateAt.getTime() <= input.requestTime.getTime()) continue;
      groups.set(`${incident.delayType}:${incident.episodeNo}`, {
        delayType: incident.delayType,
        episodeNo: incident.episodeNo,
        newFirstLateAt: firstLateAt,
      });
    }

    if (groups.size === 0) return null;
    if (input.reason === null) {
      const message = 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.';
      throw new AppError('DEADLINE_EXTENSION_REASON_REQUIRED', 400, message, {
        fieldErrors: { deadlineExtensionReason: message },
      });
    }

    const endings: Array<{
      delayType: OpenDeadlineDelayType;
      episodeNo: number;
      previousFirstLateAt: string;
      newFirstLateAt: string;
    }> = [];
    for (const group of groups.values()) {
      const ended = await tx.endOverdueIncidentEpisode({
        organizationId: input.organizationId,
        jobCardId: input.jobCardId,
        delayType: group.delayType,
        episodeNo: group.episodeNo,
        endedAt: input.requestTime,
        endedByUserId: input.actorId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: input.reason,
        endedByScheduleRevisionNo: input.scheduleRevisionNo,
      });
      // The canonical row of the episode is its earliest breach, exactly as
      // the reminder worker selects it; its own deadline_at is the first-late
      // boundary that governed before the extension.
      const canonical = [...ended].sort((left, right) => (
        left.breachedAt.getTime() - right.breachedAt.getTime()
        || left.id.localeCompare(right.id)
      ))[0];
      if (!canonical) continue;
      endings.push({
        delayType: group.delayType,
        episodeNo: group.episodeNo,
        previousFirstLateAt: canonical.deadlineAt.toISOString(),
        newFirstLateAt: group.newFirstLateAt.toISOString(),
      });
    }
    if (endings.length === 0) return null;
    return {
      delayTypes: [...new Set(endings.map((ending) => ending.delayType))],
      endings,
      reason: input.reason,
    };
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
    actionLocation?: LifecycleLocationCapture,
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
        locationCapture: actionLocation ?? null,
        ...(definition.cancelContinuity ? { cancelContinuity: definition.cancelContinuity } : {}),
        ...(definition.assignmentReason ? { assignmentReason: definition.assignmentReason } : {}),
        // OVR-5b §3.8: only when the client sent it.
        ...(definition.correctionDueAt === undefined
          ? {}
          : { correctionDueAt: definition.correctionDueAt }),
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
    if (input.type === 'WEEKLY_REPORT' || input.type === 'SALE'
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
    targetContext: {
      outcome: MeetingOutcome | null;
      nextFollowUpAt: string | null;
    } = { outcome: null, nextFollowUpAt: null },
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
    // approval, otherwise the JOB-008 target (Staff nextFollowUpAt, else +7 /
    // +14 calendar days by outcome). The effective start never precedes the
    // 15-minute floor; the search horizon is resolved below.
    const desiredTargetAt = preferredAt
      ?? followUpTargetInstant({
        evaluatedAt: requestTime,
        sourceScheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
        timezone,
        durationMs: canonicalScheduledDurationMs(type),
        outcome: targetContext.outcome,
        nextFollowUpAt: targetContext.nextFollowUpAt,
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
    // JOB-008: the 30-day envelope stays anchored at the lead floor; a
    // target beyond it (e.g. a distant Staff nextFollowUpAt) gets its own
    // envelope anchored at the target instead of failing outright.
    const floorHorizonAt = resolveFollowUpSearchHorizonAt(policyEarliestAt, timezone);
    const horizonAnchorAt = effectiveTargetAt.valueOf() >= floorHorizonAt.valueOf()
      ? effectiveTargetAt
      : policyEarliestAt;
    const horizonAt = resolveFollowUpSearchHorizonAt(horizonAnchorAt, timezone);
    const slotCandidates = iterateFollowUpSlotCandidates({
      earliestAllowedAt: effectiveTargetAt,
      horizonAnchorAt,
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
    if (detail.type === 'SALE') throw new AppError('INVALID_JOB_TYPE', 400, 'Satış kaydı V1 takip işi kaynağı değildir.');
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
      scheduledAt: followUpTargetInstant({
        evaluatedAt: this.now(),
        sourceScheduledAt: detail.scheduledAt ? new Date(detail.scheduledAt) : null,
        timezone,
        durationMs: canonicalScheduledDurationMs(defaultFollowUpType(detail.type)),
        outcome: meetingDetails?.outcome ?? null,
        nextFollowUpAt: meetingDetails?.nextFollowUpAt ?? null,
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

  /**
   * Slice 2 advisory comparison. Resolves the canonical START reference for
   * the job inside the SUBMIT transaction and classifies the current SUBMIT
   * snapshot against it. Returns null (no comparison) when the SUBMIT
   * evidence is unavailable, no valid START reference exists, or the START
   * reference itself carries no coordinates. Never throws for missing
   * evidence: the submission always succeeds.
   */
  private async resolveSubmitLocationComparison(
    tx: JobCardTransaction,
    organizationId: string,
    jobCardId: string,
    submit: JobActionLocationCapture,
  ): Promise<JobActionLocationComparison | null> {
    if (submit.outcome !== 'CAPTURED') return null;
    const reference = await tx.findStartActionLocationForComparison(organizationId, jobCardId);
    if (!reference) return null;
    const policy = this.submitLocationComparisonPolicy();
    const distanceMeters = haversineMeters(
      reference.latitude,
      reference.longitude,
      submit.latitude,
      submit.longitude,
    );
    const outcome = classifySubmitLocationComparison({
      distanceMeters,
      startAccuracyMeters: reference.accuracyMeters,
      submitAccuracyMeters: submit.accuracyMeters,
      policy,
    });
    return { referenceActivityId: reference.activityId, distanceMeters, outcome };
  }

  private async resolveActionLocation(input: {
    organizationId: string;
    actorUserId: string;
    capture: StartLocationCapture;
    correlationId: string;
    /**
     * Slice 1: SUBMIT location is advisory, so a quota infrastructure
     * failure degrades to FAILED enrichment instead of aborting the
     * lifecycle. START keeps the historical strict behavior (false).
     */
    softInfrastructureFailure: boolean;
  }): Promise<JobActionLocationCapture> {
    const { capture, correlationId, organizationId, actorUserId, softInfrastructureFailure } = input;
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
      let decision;
      try {
        decision = await quotaGuard.reserve({
          provider: 'GOOGLE',
          organizationId,
          actorUserId,
          now: this.now(),
        });
      } catch (quotaError) {
        // START keeps the historical behavior: the raw quota error
        // propagates unchanged. Only advisory SUBMIT degrades to FAILED.
        if (!softInfrastructureFailure) throw quotaError;
        return { ...base, geocodingStatus: 'FAILED' };
      }
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
    options?: { includeSubmitLocationCapability?: boolean; submitLocationComparison?: JobActionLocationComparison | null },
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
    const allowedCommands = getAllowedLifecycleCommands(
      actor,
      {
        ...persistedJob,
        // JOB-010 §1a: only a currently valid authorization widens START;
        // an absent fact defaults to false (never true).
        earlyStartAuthorized: (persistedJob.earlyStartAuthorization ?? null) !== null,
        // JOB-010 release 2b: the latest offer (absent = outside the window).
        assignmentOffer: this.assignmentOfferSummary(persisted.assignmentOffer),
      },
      evaluatedAt,
      { assignmentWindowEnabled: this.assignmentWindowEnabled() },
    );
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
        // JOB-010 release 2a: REQUEST_CHANGE / RESOLVE_CHANGE_REQUEST are
        // computed from the OPEN request read with the detail; an absent
        // request means neither action exists.
        allowedActions: getAllowedJobActions(actor, {
          ...persistedJob,
          // The offer fact only widens lifecycle commands.
          assignmentOffer: null,
          hasOpenChangeRequest: (persistedJob.changeRequest ?? null) !== null,
        }),
        startLocationCaptureEnabled: this.geolocation.enabled
          && actor.role === 'STAFF'
          && allowedCommands.includes('START'),
        // Reader-gated (see JobWorkflowContext): only opted-in readers
        // receive the new key, so previous bundles keep parsing this response.
        ...(options?.includeSubmitLocationCapability ? {
          submitLocationCaptureEnabled: this.geolocation.enabled
            && actor.role === 'STAFF'
            && allowedCommands.includes('SUBMIT_FOR_APPROVAL'),
        } : {}),
        lifecycle,
        submissionReadiness: evaluation?.readiness ?? null,
      },
      // Slice 2: the just-completed SUBMIT comparison, reader-gated like the
      // capability flag. Omitted (not null) without opt-in or comparison.
      ...(options?.includeSubmitLocationCapability && options?.submitLocationComparison
        ? {
            submitLocationComparison: {
              outcome: options.submitLocationComparison.outcome,
              distanceMeters: options.submitLocationComparison.distanceMeters,
            },
          }
        : {}),
      followUpContext,
      followUpProposal,
      // JOB-010 release 2b: latest offer, EXPIRED at read time once its
      // deadline passed.
      assignmentOffer: this.presentAssignmentOffer(persisted.assignmentOffer, evaluatedAt),
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
    rawItem: PersistedJobCardListItem,
    evaluatedAt = this.now(),
  ): JobCardListItem {
    // JOB-010 §1a / release 2b: the permission facts are server-internal;
    // never serialized.
    const { earlyStartAuthorized, assignmentOffer, ...item } = rawItem;
    const subject: JobPermissionSubject = {
      organizationId: actor.organizationId,
      type: item.type,
      status: item.status,
      assignedTo: item.assignee.id,
      scheduledAt: item.scheduledAt,
      earlyStartAuthorized,
      assignmentOffer: assignmentOffer ?? null,
    };
    return {
      ...item,
      allowedCommands: getAllowedLifecycleCommands(
        actor, subject, evaluatedAt,
        { assignmentWindowEnabled: this.assignmentWindowEnabled() },
      ),
    };
  }

}
