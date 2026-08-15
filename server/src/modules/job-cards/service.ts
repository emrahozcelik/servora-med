import { AppError } from '../../errors/index.js';
import { randomUUID } from 'node:crypto';
import { presentActivity } from './activity-presenter.js';
import {
  assertCanCreateForAssignee,
  assertCanCreateFollowUp,
  assertCanListFollowUps,
  assertCanEdit, assertCanEditDeliveryActualTime,
  assertCanEditMeetingResult,
  assertCanTransition,
  assertCanViewMeetingResult,
  assertCreateAssignmentRequest,
  assertProductDeliveryJob,
  assertFollowUpSourceEligible,
  assertSalesMeetingJob,
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
  NotePageQuery,
  PageQuery,
  ProductReference,
  PersistedFollowUpListItem,
  SubmissionReader,
} from './repository.js';
import {
  DELIVERY_PURPOSES,
  JOB_CARD_ENGAGEMENT_KINDS,
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
  type JobCardPriority,
  type PersistedJobCardDetail,
  type PersistedJobCardListItem,
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
} from './types.js';
import {
  isoInstant,
  optionalLifecycleNote,
  requireActionId,
  requireLifecycleReason,
  requireSubmissionNote,
  validation,
  boundedTrimmedString,
} from './validation.js';
import { JobCardNotesService, type CreateNoteInput } from './notes-service.js';
import {
  evaluateSubmission,
  validateSubmission,
  type SubmissionEvaluation,
} from './submission-policy.js';
import { validateMeetingDetailsCandidate } from './meeting-details-input.js';
import {
  evaluateCustomerSchedule,
  isOnSiteJobType,
  type CustomerScheduleEvaluation,
} from './customer-schedule.js';
import {
  defaultFollowUpInstructions,
  defaultFollowUpType,
  deriveProposalOrigin,
  suggestedFollowUpInstant,
  type FollowUpProposalFields,
} from './follow-up-policy.js';
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
import type { AppendWebPushDeliveriesInput } from '../web-push/repository.js';
import type { ReverseGeocoder } from './reverse-geocoder.js';
import {
  parseStartLocationCapture,
  type StartLocationCapture,
} from './start-location-input.js';
import type { JobActionLocationCapture } from './location-types.js';
import type { ReverseGeocodingQuotaGuard } from '../geocoding/reverse-geocoding-quota.js';
import type { NotificationDraft } from '../notifications/types.js';

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
    serialNo: input.serialNo?.trim() || null, expiryDate: input.expiryDate ?? null,
    deliveryNote: input.deliveryNote?.trim() || null };
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

function meetingDetailsResponse(
  jobCardId: string,
  jobCardVersion: number,
  details: MeetingDetailsCandidate,
): MeetingDetails {
  return { jobCardId, ...details, jobCardVersion };
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
  ) { this.notesService = new JobCardNotesService(repository); }

  private publishRealtime(events: readonly RealtimeEventRecord[]) {
    for (const event of events) {
      this.realtimePublisher.publish(event);
    }
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

  async create(actor: JobCardActor, input: NormalizedJobCardCreateInput) {
    const title = input.title.trim();
    const priority = input.priority;
    if (!input.clientActionId.trim() || !title ||
      (input.type === 'PRODUCT_DELIVERY' && !input.customerId) ||
      !input.assignedTo || !JOB_CARD_PRIORITIES.includes(priority)) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard oluşturma bilgileri geçersiz.');
    }
    if ((input.type === 'PRODUCT_DELIVERY' || input.type === 'SALES_MEETING')
      && (!input.scheduledAt || !input.scheduledEndsAt
        || Date.parse(input.scheduledEndsAt) <= Date.parse(input.scheduledAt))) {
      throw new AppError('VALIDATION_ERROR', 400, 'JobCard oluşturma bilgileri geçersiz.');
    }
    assertCreateAssignmentRequest(actor, input.assignedTo);
    const requestTime = this.now();
    let result: CriticalActionResult<JobCardMutationReceipt>;
    try {
      result = await this.repository.executeCriticalAction<JobCardMutationReceipt>(
        {
          organizationId: actor.organizationId, userId: actor.id,
          clientActionId: input.clientActionId, operationKey: 'JOB_CREATE',
        },
        async (transaction) => {
        const assignee = await transaction.getAssigneeForUpdate(actor.organizationId, input.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
        await this.validateJobReferences(transaction, actor.organizationId, input.customerId, input.contactId);
        const overrideReason = await this.enforceCustomerSchedule(transaction, actor, {
          customerId: input.customerId,
          proposedAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          jobType: input.type,
          overrideReason: (input as { overrideReason?: string | null }).overrideReason ?? null,
        });
        if (this.calendar.enabled
          && (input.type === 'SALES_MEETING' || input.type === 'PRODUCT_DELIVERY')
          && input.scheduledAt && input.scheduledEndsAt) {
          await transaction.assertCalendarAvailability({
            organizationId: actor.organizationId,
            jobCardId: null,
            assignedUserId: input.assignedTo,
            startsAt: input.scheduledAt,
            endsAt: input.scheduledEndsAt,
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
          scheduledEndsAt: input.scheduledEndsAt ?? null,
          engagementKind,
          acceptedAt: selfAccepted ? requestTime : null,
          acceptedBy: selfAccepted ? actor.id : null,
          sourceJobCardId: null,
          followUpInstructions: null,
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
          metadata: overrideReason !== null
            ? { customerVisitOverrideReason: overrideReason }
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

  async createFollowUp(
    actor: JobCardActor,
    sourceJobCardId: string,
    input: FollowUpCreateInput,
  ) {
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction<FollowUpCreateReceipt>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId: input.clientActionId,
        operationKey: `JOB_FOLLOW_UP_CREATE:${sourceJobCardId}`,
      },
      async (transaction) => {
        assertCanCreateFollowUp(actor);
        const source = await transaction.getFollowUpSource(
          actor.organizationId,
          sourceJobCardId,
        );
        if (!source) {
          throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        }
        assertFollowUpSourceEligible(source);
        await this.assertFollowUpDepth(transaction, source);

        let followUpOverrideReason: string | null = null;
        let lockedAssignee: JobCardAssignee | null | undefined;
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
          // Keep the shared writer order User -> Customer. Defer the
          // assignee authorization/error until after customer validation so a
          // customer/contact error keeps its existing precedence.
          lockedAssignee = await transaction.getAssigneeForUpdate(
            actor.organizationId,
            input.assignedTo,
          );
          await this.validateJobReferences(
            transaction,
            actor.organizationId,
            source.customerId,
            input.contactId,
          );
          // Customer scheduling for post-hoc follow-up: the source is already
          // COMPLETED, so it is never part of the active set; evaluate the
          // manually selected child date against the inherited Customer.
          followUpOverrideReason = await this.enforceCustomerSchedule(transaction, actor, {
            customerId: source.customerId,
            proposedAt: input.scheduledAt !== null ? new Date(input.scheduledAt) : null,
            jobType: input.type,
            overrideReason: input.overrideReason,
            errorMode: 'follow-up',
          });
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
          activityMetadata: {
            sourceJobCardId,
            ...(followUpOverrideReason !== null
              ? { customerVisitOverrideReason: followUpOverrideReason }
              : {}),
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
      assignee?: JobCardAssignee | null;
      engagementKind: JobCardEngagementKind | null;
      clientActionId: string;
      requestTime: Date;
      activityMetadata?: unknown;
    },
  ): Promise<{ job: JobCard; realtimeEvents: RealtimeEventRecord[] }> {
    const assignee = input.assignee === undefined
      ? await transaction.getAssigneeForUpdate(actor.organizationId, input.assignedTo)
      : input.assignee;
    if (!assignee) {
      throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
    }
    assertCanCreateForAssignee(actor, assignee);

    const job = await transaction.createJobCard({
      organizationId: actor.organizationId,
      type: input.type,
      status: 'NEW',
      title: input.title,
      description: null,
      customerId: input.customerId,
      contactId: input.contactId,
      assignedTo: input.assignedTo,
      createdBy: actor.id,
      priority: input.priority,
      dueDate: input.dueDate,
      scheduledAt: input.scheduledAt,
      scheduledEndsAt: null,
      engagementKind: input.engagementKind,
      acceptedAt: null,
      acceptedBy: null,
      sourceJobCardId: input.sourceJobCardId,
      followUpInstructions: input.followUpInstructions,
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
    if (job.scheduledAt !== null) createdValue.scheduledAt = job.scheduledAt;
    if (job.engagementKind !== null) createdValue.engagementKind = job.engagementKind;
    const activity = await transaction.appendActivity({
      organizationId: actor.organizationId,
      jobCardId: job.id,
      actorId: actor.id,
      event: 'JOB_CREATED',
      clientActionId: input.clientActionId,
      newValue: createdValue,
      metadata: input.activityMetadata === undefined
        ? { sourceJobCardId: input.sourceJobCardId }
        : input.activityMetadata,
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
    const result = await this.repository.listFollowUps(
      actor.organizationId,
      sourceJobCardId,
      page,
    );
    return {
      ...result,
      items: result.items.map((item) => this.presentFollowUpListItem(actor, item)),
    };
  }

  async list(actor: JobCardActor, query: JobCardListQuery) {
    if (actor.role === 'STAFF' && query.assignedTo !== null && query.assignedTo !== actor.id) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset };
    }
    const page = await this.repository.listJobCards(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
      this.now(),
    );
    return {
      ...page,
      items: page.items.map((item) => this.presentListItem(actor, item)),
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
    const board = await this.repository.listBoard(
      {
        organizationId: actor.organizationId,
        assignedTo: actor.role === 'STAFF' ? actor.id : null,
      },
      query,
    );
    const presentColumn = (column: { items: PersistedJobCardListItem[]; count: number }) => ({
      count: column.count,
      items: column.items.map((item) => this.presentListItem(actor, item)),
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
        const candidate: MeetingDetailsCandidate = {
          meetingAt: input.meetingAt === undefined ? current.meetingAt : input.meetingAt,
          outcome: input.outcome === undefined ? current.outcome : input.outcome,
          meetingSummary: input.meetingSummary === undefined
            ? current.meetingSummary
            : input.meetingSummary,
          nextFollowUpAt: input.nextFollowUpAt === undefined
            ? current.nextFollowUpAt
            : input.nextFollowUpAt,
        };
        validateMeetingDetailsCandidate(candidate);
        const changedFields = MEETING_DETAIL_FIELDS.filter(
          (field) => Object.hasOwn(input, field) && candidate[field] !== current[field],
        );
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
        await transaction.appendActivity({
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          event: 'MEETING_DETAILS_UPDATED',
          clientActionId,
          metadata: { changedFields },
        });
        return {
          response: meetingDetailsResponse(jobCardId, updated.version, candidate),
          realtimeEvents: [],
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
    const overrideReasonInput = fields.overrideReason ?? null;
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
      // Lock order correction: Job row FIRST, then assignee User, then target Customer,
      // to serialize calendar capacity without introducing a User↔Customer deadlock.
      const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
      if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
      if (job.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      }
      assertCanEdit(actor, job);

      const isCalendarIntervalJob = job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY';
      const scheduleChanged = fields.scheduledAt !== undefined
        && fields.scheduledAt !== job.scheduledAt
        || fields.scheduledEndsAt !== undefined
        && fields.scheduledEndsAt !== (job.scheduledEndsAt ?? null);
      const assigneeChanged = fields.assignedTo !== undefined
        && fields.assignedTo !== job.assignedTo;
      const needsCalendarAssigneeLock = this.calendar.enabled
        && isCalendarIntervalJob
        && (scheduleChanged || assigneeChanged);
      if (fields.assignedTo !== undefined && assigneeChanged) {
        const assignee = await transaction.getAssigneeForUpdate(actor.organizationId, fields.assignedTo);
        if (!assignee) throw new AppError('ASSIGNEE_NOT_FOUND', 404, 'Atanacak personel bulunamadı.');
        assertCanCreateForAssignee(actor, assignee);
      } else if (needsCalendarAssigneeLock) {
        await transaction.getAssigneeForUpdate(actor.organizationId, job.assignedTo);
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
      const overrideReason = (scheduleChanged || customerChanged)
        ? await this.enforceCustomerSchedule(transaction, actor, {
            customerId: nextCustomerId,
            proposedAt: nextScheduledAt !== null ? new Date(nextScheduledAt) : null,
            jobType: job.type,
            excludeJobId: job.id,
            overrideReason: overrideReasonInput,
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

      const updated = await transaction.updateFieldsWithVersion({
        organizationId: actor.organizationId, jobCardId, expectedVersion: input.expectedVersion, fields,
      });
      if (!updated) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      if (this.calendar.enabled && (scheduleChanged || assigneeChanged)) {
        await transaction.synchronizeCalendarReminder({
          organizationId: actor.organizationId,
          jobCardId,
          assignedUserId: updated.assignedTo,
          startsAt: updated.scheduledAt,
          endsAt: updated.scheduledEndsAt,
          version: updated.version,
          active: !['COMPLETED', 'CANCELLED'].includes(updated.status),
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
          metadata: overrideReason !== null
            ? { customerVisitOverrideReason: overrideReason }
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
      { organizationId: actor.organizationId, userId: actor.id, clientActionId: input.clientActionId, operationKey: 'DELIVERY_ITEM_CREATE' },
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

  async listReferenceCustomers(actor: JobCardActor) {
    return this.repository.listReferenceCustomers(actor.organizationId);
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
    if (!this.geolocation.enabled) {
      return this.runLifecycle(actor, jobCardId, lifecycleInput, definition);
    }

    const capture = parseStartLocationCapture(input.locationCapture);
    const claim = this.lifecycleClaim(actor, jobCardId, lifecycleInput.clientActionId, definition);
    const completed = await this.repository.findCompletedCriticalAction<unknown>(claim);
    if (completed) {
      const receipt = decodeJobCardMutationReceipt(completed);
      return this.detailAt(actor, receipt.jobCardId, receipt.evaluatedAt ?? this.now());
    }

    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    if (job.version !== lifecycleInput.expectedVersion) {
      throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
    }
    assertStaffStartActor(actor);
    assertCanTransition(actor, job, 'START');
    const resolvedCapture = await this.resolveStartLocation({
      organizationId: actor.organizationId,
      actorUserId: actor.id,
      capture,
      correlationId: lifecycleInput.clientActionId,
    });
    return this.runLifecycle(actor, jobCardId, lifecycleInput, definition, resolvedCapture);
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

  private async runLifecycle(
    actor: JobCardActor,
    jobCardId: string,
    input: { clientActionId: string; expectedVersion: number },
    definition: LifecycleDefinition,
    startLocation?: JobActionLocationCapture,
  ) {
    const requestTime = this.now();
    const result = await this.repository.executeCriticalAction<JobCardMutationReceipt>(
      this.lifecycleClaim(actor, jobCardId, input.clientActionId, definition),
      async (tx) => {
        const job = await tx.getJobForUpdate(actor.organizationId, jobCardId);
        if (!job) throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
        if (job.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
        if (startLocation) assertStaffStartActor(actor);
        assertCanTransition(
          actor, job, definition.command,
          definition.revisionReason ?? definition.cancelReason ?? undefined,
        );
        let persistedProposal: {
          scheduledAt: Date;
          type: JobCardType;
          assignedTo: string;
          instructions: string;
          origin: FollowUpProposalOrigin;
          proposedBy: string | null;
        } | null = null;
        let approval: {
          proposal: FollowUpProposalFields;
          overrideReason: string | null;
        } | null = null;
        if (definition.command === 'SUBMIT_FOR_APPROVAL') {
          await validateSubmission(tx, actor, job, requestTime);
          const proposal = await this.validateFollowUpProposal(
            tx, actor, job, definition.followUpProposal, requestTime,
          );
          await this.evaluateProposalAdvisory(tx, actor, job, proposal, requestTime);
          const suggestion = await this.computeFollowUpSuggestion(tx, actor, job, requestTime);
          const origin = suggestion.fields === null
            ? 'STAFF_ADJUSTED'
            : deriveProposalOrigin(proposal, suggestion.fields);
          persistedProposal = {
            scheduledAt: new Date(proposal.scheduledAt),
            type: proposal.type,
            assignedTo: proposal.assignedTo,
            instructions: proposal.followUpInstructions,
            origin,
            proposedBy: actor.id,
          };
        }
        if (definition.command === 'APPROVE') {
          approval = await this.resolveApproveFollowUp(
            tx, actor, job, definition.approveFollowUp, requestTime,
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
            ...(approval.overrideReason
              ? { customerVisitOverrideReason: approval.overrideReason }
              : {}),
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
            priority: 'normal',
            dueDate: null,
            contactId: null,
            engagementKind: approval.proposal.type === 'SALES_MEETING' ? 'FOLLOW_UP' : null,
            clientActionId: input.clientActionId,
            requestTime,
            activityMetadata: {
              sourceJobCardId: jobCardId,
              ...(approval.overrideReason
                ? { customerVisitOverrideReason: approval.overrideReason }
                : {}),
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
      });
    if (result.kind === 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    const receipt = decodeJobCardMutationReceipt(result.response);
    const detail = await this.detailAt(actor, receipt.jobCardId, receipt.evaluatedAt ?? this.now());
    if (definition.command === 'APPROVE' && receipt.followUpJobCardId) {
      return { ...detail, followUpJobCardId: receipt.followUpJobCardId };
    }
    return detail;
  }

  private lifecycleClaim(
    actor: JobCardActor,
    jobCardId: string,
    clientActionId: string,
    definition: LifecycleDefinition,
  ) {
    return {
      organizationId: actor.organizationId,
      userId: actor.id,
      clientActionId,
      operationKey: `${definition.operationKey}:${jobCardId}`,
    };
  }

  /**
   * Normalize + validate a follow-up proposal against the source Job and the
   * acting role. Shared by Staff submission and Manager approval so the
   * mandatory invariant has one server-side truth.
   */
  private async validateFollowUpProposal(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    input: FollowUpProposalInput | undefined,
    requestTime: Date,
  ): Promise<FollowUpProposalFields> {
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
    if (!(JOB_CARD_TYPES as readonly string[]).includes(input.type)) {
      throw new AppError('FOLLOW_UP_PROPOSAL_INVALID', 400, 'Takip işi türü geçersizdir.');
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
    const assignee = await tx.getAssigneeForUpdate(actor.organizationId, input.assignedTo);
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
    return { scheduledAt, type: input.type, assignedTo: input.assignedTo, followUpInstructions };
  }

  /** Advisory evaluation at Staff submission; never blocks, informs the suggestion only. */
  private evaluateProposalAdvisory(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    proposal: FollowUpProposalFields,
    requestTime: Date,
  ): Promise<CustomerScheduleEvaluation> {
    return evaluateCustomerSchedule({
      reader: tx,
      organizationId: actor.organizationId,
      customerId: job.customerId,
      proposedAt: new Date(proposal.scheduledAt),
      jobType: proposal.type,
      excludeJobId: job.id,
      now: requestTime,
    });
  }

  /**
   * Authoritative evaluation at Manager approval. Locks the Customer row
   * first so same-Customer scheduling decisions serialize; second transaction
   * wakes and sees the first one's committed child.
   */
  private async evaluateForApproval(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    proposal: FollowUpProposalFields,
    requestTime: Date,
  ): Promise<CustomerScheduleEvaluation> {
    if (job.customerId !== null) {
      const customer = await tx.getCustomerForUpdate(actor.organizationId, job.customerId);
      if (!customer) {
        throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
      }
    }
    return evaluateCustomerSchedule({
      reader: tx,
      organizationId: actor.organizationId,
      customerId: job.customerId,
      proposedAt: new Date(proposal.scheduledAt),
      jobType: proposal.type,
      excludeJobId: job.id,
      now: requestTime,
    });
  }

  /**
   * Authoritative Customer-schedule enforcement for normal ON_SITE writers
   * (create, patch/reschedule, post-hoc follow-up). Returns a normalized
   * override reason when a Manager/Admin overrides FREQUENCY_EXCEEDED, or
   * null when no override occurred. The caller is responsible for locking the
   * target Customer row before invoking this so same-Customer decisions
   * serialize. Error details are role-projected (Staff never sees other
   * Staff's conflicts or recent-visit detail).
   */
  private async enforceCustomerSchedule(
    tx: JobCardTransaction,
    actor: JobCardActor,
    input: {
      customerId: string | null;
      proposedAt: Date | null;
      jobType: JobCardType;
      excludeJobId?: string;
      overrideReason?: string | null;
      errorMode?: 'normal' | 'follow-up';
    },
  ): Promise<string | null> {
    if (input.customerId === null || !isOnSiteJobType(input.jobType) || input.proposedAt === null) {
      return null;
    }
    const evaluation = await evaluateCustomerSchedule({
      reader: tx,
      organizationId: actor.organizationId,
      customerId: input.customerId,
      proposedAt: input.proposedAt,
      jobType: input.jobType,
      excludeJobId: input.excludeJobId,
      now: this.now(),
    });
    const projected = this.projectEvaluation(actor, evaluation);
    if (evaluation.level === 'CONFLICT') {
      const followUp = input.errorMode === 'follow-up';
      throw new AppError(
        followUp ? 'FOLLOW_UP_CUSTOMER_CONFLICT' : 'CUSTOMER_SCHEDULE_CONFLICT',
        409,
        followUp
          ? 'Aynı müşteri için aynı tarihte başka bir plan bulunuyor.'
          : 'Aynı müşteriye aynı gün başka bir saha işi planlanmış.',
        {
          conflicts: projected.conflicts,
          suggestedAlternativeAt: projected.suggestedAlternativeAt,
        },
      );
    }
    if (evaluation.level === 'FREQUENCY_EXCEEDED') {
      if (actor.role === 'STAFF' && input.errorMode !== 'follow-up') {
        throw new AppError(
          'CUSTOMER_VISIT_FREQUENCY_REVIEW_REQUIRED',
          409,
          'Bu müşteri için ziyaret sıklığı sınırı aşılıyor. Planlama için yönetici değerlendirmesi gerekiyor.',
        );
      }
      if (typeof input.overrideReason !== 'string' || !input.overrideReason.trim()) {
        throw new AppError(
          input.errorMode === 'follow-up'
            ? 'FOLLOW_UP_OVERRIDE_REASON_REQUIRED'
            : 'CUSTOMER_VISIT_OVERRIDE_REASON_REQUIRED',
          400,
          'Sık ziyaret uyarısı için neden zorunludur.',
        );
      }
      return boundedTrimmedString(input.overrideReason, 'overrideReason', 1, 2_000);
    }
    return null;
  }

  private async resolveApproveFollowUp(
    tx: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    input: ApproveFollowUpInput | undefined,
    requestTime: Date,
  ): Promise<{ proposal: FollowUpProposalFields; overrideReason: string | null }> {
    const persisted = job.followUpProposedAt !== null
      && job.followUpProposedType !== null
      && job.followUpProposedAssignee !== null
      && job.followUpProposalInstructions !== null;
    if (!persisted && !input) {
      throw new AppError('FOLLOW_UP_PROPOSAL_REQUIRED', 400, 'Takip işi planı zorunludur.');
    }
    const proposal = await this.validateFollowUpProposal(
      tx,
      actor,
      job,
      input ?? (persisted ? {
        scheduledAt: job.followUpProposedAt!,
        type: job.followUpProposedType!,
        assignedTo: job.followUpProposedAssignee!,
        followUpInstructions: job.followUpProposalInstructions!,
      } : undefined),
      requestTime,
    );
    const evaluation = await this.evaluateForApproval(tx, actor, job, proposal, requestTime);
    let overrideReason: string | null = null;
    if (evaluation.level === 'FREQUENCY_EXCEEDED') {
      if (typeof input?.overrideReason !== 'string' || !input.overrideReason.trim()) {
        throw new AppError(
          'FOLLOW_UP_OVERRIDE_REASON_REQUIRED',
          400,
          'Sık ziyaret uyarısı için neden zorunludur.',
        );
      }
      overrideReason = boundedTrimmedString(input.overrideReason, 'followUp.overrideReason', 1, 2_000);
    }
    if (evaluation.level === 'CONFLICT') {
      throw new AppError(
        'FOLLOW_UP_CUSTOMER_CONFLICT',
        409,
        'Aynı müşteri için aynı tarihte başka bir plan bulunuyor.',
        {
          conflicts: evaluation.conflicts,
          suggestedAlternativeAt: evaluation.suggestedAlternativeAt,
        },
      );
    }
    return { proposal, overrideReason };
  }

  private async computeFollowUpSuggestion(
    reader: JobCardTransaction,
    actor: JobCardActor,
    job: JobCard,
    evaluatedAt: Date,
  ): Promise<{
    fields: FollowUpProposalFields | null;
    baseEvaluation: CustomerScheduleEvaluation;
    skippedConflict: boolean;
  }> {
    const timezone = await reader.getOrganizationTimezone(actor.organizationId);
    const baseAt = suggestedFollowUpInstant({
      evaluatedAt,
      sourceScheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
      timezone,
    });
    const baseFields: FollowUpProposalFields = {
      scheduledAt: baseAt,
      type: defaultFollowUpType(job.type),
      assignedTo: job.assignedTo,
      followUpInstructions: defaultFollowUpInstructions(job.title),
    };
    return evaluateCustomerSchedule({
      reader,
      organizationId: actor.organizationId,
      customerId: job.customerId,
      proposedAt: baseAt,
      jobType: baseFields.type,
      excludeJobId: job.id,
      now: evaluatedAt,
    }).then((baseEvaluation) => {
      if (baseEvaluation.level !== 'CONFLICT') {
        return { fields: baseFields, baseEvaluation, skippedConflict: false };
      }
      if (baseEvaluation.suggestedAlternativeAt === null) {
        return { fields: null, baseEvaluation, skippedConflict: false };
      }
      return {
        fields: {
          ...baseFields,
          scheduledAt: new Date(baseEvaluation.suggestedAlternativeAt),
        },
        baseEvaluation,
        skippedConflict: true,
      };
    });
  }

  private projectEvaluation(
    actor: JobCardActor,
    evaluation: CustomerScheduleEvaluation,
    overrides?: { safeMessage?: string | null; staffFrequencyMessage?: string | null },
  ): RoleProjectedCustomerScheduleEvaluation {
    const safeMessage = overrides?.safeMessage !== undefined
      ? overrides.safeMessage
      : evaluation.safeMessage;
    if (actor.role === 'STAFF') {
      return {
        level: evaluation.level,
        safeMessage: evaluation.level === 'FREQUENCY_EXCEEDED'
          ? (overrides?.staffFrequencyMessage
            ?? 'Bu müşteri için ziyaret sıklığı yüksek. Takip planı yönetici onayında ayrıca değerlendirilecek.')
          : safeMessage,
        conflicts: [],
        recentVisit: null,
        suggestedAlternativeAt: evaluation.suggestedAlternativeAt,
      };
    }
    return {
      level: evaluation.level,
      safeMessage,
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
    if (detail.status === 'COMPLETED' || detail.status === 'CANCELLED') {
      throw new AppError('INVALID_TRANSITION', 409, 'Bu iş için takip önerisi oluşturulamaz.');
    }
    const timezone = await this.repository.getOrganizationTimezone(actor.organizationId);
    const defaultFields: FollowUpProposalFields = {
      scheduledAt: suggestedFollowUpInstant({
        evaluatedAt: this.now(),
        sourceScheduledAt: detail.scheduledAt ? new Date(detail.scheduledAt) : null,
        timezone,
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
    const { fields, baseEvaluation, skippedConflict } = await this.repository
      .executeTransaction((tx) => this.computeFollowUpSuggestion(tx, actor, job, this.now()));
    if (fields === null) {
      return {
        scheduledAt: null,
        type: defaultFields.type,
        assignedTo: defaultFields.assignedTo,
        followUpInstructions: defaultFields.followUpInstructions,
        evaluation: this.projectEvaluation(actor, baseEvaluation),
      };
    }
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
      evaluation: this.projectEvaluation(actor, finalEvaluation, skippedConflict
        ? {
            safeMessage: 'Bu müşteri için yakın tarihte başka bir plan bulunduğundan sonraki uygun tarih önerildi.',
          }
        : undefined),
    };
  }

  async previewCustomerSchedule(
    actor: JobCardActor,
    input: CustomerSchedulePreviewInput,
  ): Promise<RoleProjectedCustomerScheduleEvaluation> {
    const proposedAt = new Date(isoInstant(input.scheduledAt, 'scheduledAt'));
    return this.repository.executeTransaction((tx) => this.previewInTransaction(tx, actor, input, proposedAt));
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
      excludeJobId,
      now: this.now(),
    });
    return this.projectEvaluation(actor, evaluation, {
      staffFrequencyMessage:
        'Bu müşteri için ziyaret sıklığı sınırı aşılıyor. Planlama için yönetici değerlendirmesi gerekiyor.',
    });
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
    const allowedCommands = getAllowedLifecycleCommands(actor, persistedJob);
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
    const followUpProposal: FollowUpProposal | null = job.followUpProposedAt !== null
      && job.followUpProposedType !== null
      && job.followUpProposedAssignee !== null
      && job.followUpProposalInstructions !== null
      ? {
          scheduledAt: job.followUpProposedAt,
          type: job.followUpProposedType,
          assignedTo: job.followUpProposedAssignee,
          followUpInstructions: job.followUpProposalInstructions,
          origin: job.followUpProposalOrigin ?? 'SYSTEM',
          proposedBy: persisted.proposer,
        }
      : null;
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
  ) {
    const { sourceJobCardId, ...job } = item;
    return {
      ...this.presentListItem(actor, job),
      followUp: { sourceJobCardId },
    };
  }

  private presentListItem(actor: JobCardActor, item: PersistedJobCardListItem): JobCardListItem {
    const subject: JobPermissionSubject = {
      organizationId: actor.organizationId,
      type: item.type,
      status: item.status,
      assignedTo: item.assignee.id,
    };
    return { ...item, allowedCommands: getAllowedLifecycleCommands(actor, subject) };
  }

}
