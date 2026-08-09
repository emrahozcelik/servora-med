import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { JobCardStatus } from '../job-cards/types.js';
import type { RealtimeEventPublisher } from '../realtime/event-bus.js';
import type { RealtimeEventInput } from '../realtime/types.js';
import type {
  ConversationContextType,
  ConversationListCursor,
  ConversationListPage,
  ConversationListItem,
  ConversationRecord,
  CreateConversationInput,
  MessageCursor,
  MessagePage,
  MessageRecord,
  MessagingActivityRecord,
  RecipientListItem,
  MessagingNotificationInput,
  JobAssigneeSyncInput,
  JobAssigneeSyncResult,
} from './types.js';
import {
  canReadConversation,
  canSendMessage,
  isLegacyGeneralConversation,
  type JobAccessContext,
} from './policy.js';
import { isTerminalJobStatus } from '../job-cards/policy.js';
import {
  PostgresMessagingRepository,
  PostgresMessagingTransaction,
  type MessagingRepository,
} from './repository.js';

function forbidden(): never {
  throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
}

function notFound(): never {
  throw new AppError('NOT_FOUND', 404, 'Sayfa bulunamadı.');
}

function validateBody(body: unknown): string {
  if (typeof body !== 'string') {
    throw new AppError('VALIDATION_ERROR', 400, 'Mesaj metni geçersiz.');
  }
  const codePointCount = [...body].length;
  if (codePointCount < 1 || codePointCount > 4000) {
    throw new AppError('VALIDATION_ERROR', 400, 'Mesaj 1-4000 karakter arasında olmalıdır.');
  }
  return body;
}

function parseAssignee(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new AppError('STALE_REASSIGNMENT', 409, 'Atama geçişi kaydı geçersiz.');
  }
  const assignedTo = (value as { assignedTo?: unknown }).assignedTo;
  if (assignedTo === null || assignedTo === undefined) return null;
  if (typeof assignedTo !== 'string') {
    throw new AppError('STALE_REASSIGNMENT', 409, 'Atama geçişi kaydı geçersiz.');
  }
  return assignedTo;
}
function buildDirectKey(
  initiatorUserId: string,
  recipientUserId: string,
  contextType: ConversationContextType,
  jobId: string | null,
  customerId: string | null,
): string {
  if (contextType === 'JOB') {
    // JOB identity comes from org + job, not the participant pair.
    return `context:JOB:${jobId}`;
  }
  if (contextType === 'CUSTOMER') {
    // CUSTOMER is a topic: each create is a distinct thread for the customer.
    return `context:CUSTOMER:${customerId}:${randomUUID()}`;
  }
  // Legacy GENERAL direct conversations keep participant-pair identity.
  const participants = [initiatorUserId, recipientUserId].sort();
  return `${participants[0]}:${participants[1]}:${contextType}`;
}

function normalizeTitle(
  title: unknown,
  required: boolean,
  contextLabel: string,
): string | null {
  if (title === undefined || title === null) {
    if (required) {
      throw new AppError('VALIDATION_ERROR', 400, `${contextLabel} için konu başlığı zorunludur.`);
    }
    return null;
  }
  if (typeof title !== 'string') {
    throw new AppError('VALIDATION_ERROR', 400, 'Konu başlığı geçersiz.');
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'Konu başlığı boş olamaz.');
  }
  if ([...trimmed].length > 255) {
    throw new AppError('VALIDATION_ERROR', 400, 'Konu başlığı en fazla 255 karakter olabilir.');
  }
  return trimmed;
}

export class MessagingService {
  private readonly repository: MessagingRepository;

  constructor(
    private readonly pool: Pool,
    private readonly enabled: boolean,
    private readonly realtimePublisher?: RealtimeEventPublisher,
  ) {
    this.repository = new PostgresMessagingRepository(pool);
  }

  async getConversations(
    actor: SafeUser,
    cursor: ConversationListCursor | null,
    limit: number,
  ): Promise<ConversationListPage> {
    this.requireEnabled();
    return this.repository.listConversations(
      actor.organizationId, actor.id, actor.role, cursor, limit,
    );
  }

  /**
   * Exact authorized lookup of the canonical JOB conversation for a caller
   * (M5 Job Detail entry). Succeeds ONLY when the caller is a persisted
   * participant AND currently holds Job resource authorization (canReadConversation).
   * Every denied case — no canonical thread, non-participant, stale Staff,
   * wrong-org — returns the same opaque 404 with zero conversation metadata,
   * so the endpoint never doubles as an existence oracle for non-participants.
   */
  async getJobConversation(
    actor: SafeUser,
    jobId: string,
  ): Promise<ConversationListItem> {
    this.requireEnabled();
    const canonical = await this.repository.findCanonicalJobConversation(
      actor.organizationId, jobId,
    );
    if (!canonical) throw notFound();
    const participants = await this.repository.findParticipantsWithUsers(
      actor.organizationId, canonical.id,
    );
    if (!participants.some((p) => p.userId === actor.id)) {
      throw notFound();
    }
    const jobAccess = await this.fetchJobAccess(actor.organizationId, jobId);
    if (!canReadConversation({
      actor, conversation: canonical, job: jobAccess, isParticipant: true,
    })) {
      throw notFound();
    }
    const jobResult = await this.pool.query<{ title: string }>(
      `SELECT title FROM job_cards
        WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, jobId],
    );
    return {
      id: canonical.id,
      directKey: canonical.directKey,
      contextType: canonical.contextType,
      jobId: canonical.jobId,
      jobTitle: jobResult.rows[0]?.title ?? null,
      customerId: canonical.customerId,
      customerName: null,
      title: canonical.title,
      participantName: participants[0]?.name ?? '',
      participantId: participants[0]?.userId ?? '',
      participantIsActive: participants[0]?.isActive ?? false,
      participants,
      unreadCount: 0,
      lastActivityAt: canonical.updatedAt.toISOString(),
      updatedAt: canonical.updatedAt.toISOString(),
    };
  }

  async createOrGetConversation(
    actor: SafeUser,
    input: CreateConversationInput,
  ): Promise<ConversationListItem> {
    this.requireEnabled();
    const contextType = input.contextType;
    const jobId = input.jobId ?? null;
    const customerId = input.customerId ?? null;

    // Normalize to one canonical participant-id array.
    // The legacy single-recipient contract maps to a one-element array.
    const isNewContract = input.participantUserIds !== undefined && input.participantUserIds !== null;
    if (isNewContract && input.recipientUserId) {
      throw new AppError(
        'VALIDATION_ERROR', 400,
        'recipientUserId ve participantUserIds birlikte kullanılamaz.',
      );
    }

    let explicitParticipantIds: readonly string[];
    if (isNewContract) {
      explicitParticipantIds = Array.from(
        new Set(input.participantUserIds!.filter((id) => id !== actor.id)),
      );
      if (explicitParticipantIds.length === 0) {
        throw new AppError('VALIDATION_ERROR', 400, 'En az bir katılımcı seçin.');
      }
    } else {
      const recipientUserId = input.recipientUserId;
      if (!recipientUserId) {
        throw new AppError('VALIDATION_ERROR', 400, 'recipientUserId zorunludur.');
      }
      if (recipientUserId === actor.id) {
        throw new AppError('VALIDATION_ERROR', 400, 'Kendinizle konuşma başlatamazsınız.');
      }
      explicitParticipantIds = [recipientUserId];
    }

    // STAFF cannot create new conversations
    if (actor.role === 'STAFF') {
      throw forbidden();
    }

    if (contextType === 'JOB') {
      if (!jobId) {
        throw new AppError('VALIDATION_ERROR', 400, 'İş bağlamı için jobId zorunludur.');
      }
      if (customerId) {
        throw new AppError('VALIDATION_ERROR', 400, 'İş bağlamında customerId kullanılamaz.');
      }
    } else if (contextType === 'CUSTOMER') {
      if (!customerId) {
        throw new AppError('VALIDATION_ERROR', 400, 'Müşteri bağlamı için customerId zorunludur.');
      }
      if (jobId) {
        throw new AppError('VALIDATION_ERROR', 400, 'Müşteri bağlamında jobId kullanılamaz.');
      }
    } else {
      if (jobId) {
        throw new AppError('VALIDATION_ERROR', 400, 'Genel bağlamda jobId kullanılamaz.');
      }
      if (customerId) {
        throw new AppError('VALIDATION_ERROR', 400, 'Genel bağlamda customerId kullanılamaz.');
      }
    }

    // New-contract GENERAL threads must be titled: the UI no longer has a
    // titleless creation path, and titleless rows stay reserved for legacy.
    const title = normalizeTitle(
      input.title,
      contextType === 'CUSTOMER' || (isNewContract && contextType === 'GENERAL'),
      contextType === 'CUSTOMER' ? 'Müşteri konuşması' : 'Genel konu',
    );

    // New-contract GENERAL threads are titled topics with their own identity;
    // the legacy pair-based direct key belongs to legacy (titleless) threads
    // and must not capture a new topic created for the same staff pair.
    const directKey = isNewContract && contextType === 'GENERAL'
      ? `context:GENERAL:${randomUUID()}`
      : buildDirectKey(
          actor.id, explicitParticipantIds[0]!, contextType, jobId, customerId,
        );

    // JOB: canonical identity is org + job, never the participant set.
    // An existing canonical thread may only be returned to someone who is
    // ALREADY a persisted participant (M3: resource authorization alone is
    // never Messaging membership). Submitted participant lists never change
    // existing membership, and the caller is never added implicitly.
    if (contextType === 'JOB' && jobId) {
      const canonical = await this.repository.findCanonicalJobConversation(
        actor.organizationId, jobId,
      );
      if (canonical) {
        const canonicalParticipants = await this.repository.findParticipantsWithUsers(
          actor.organizationId, canonical.id,
        );
        if (!canonicalParticipants.some((p) => p.userId === actor.id)) {
          throw forbidden();
        }
        let canonicalJobTitle: string | null = null;
        const jobResult = await this.pool.query<{ title: string }>(
          `SELECT title FROM job_cards
            WHERE organization_id = $1 AND id = $2`,
          [actor.organizationId, jobId],
        );
        canonicalJobTitle = jobResult.rows[0]?.title ?? null;
        return {
          id: canonical.id,
          directKey: canonical.directKey,
          contextType: canonical.contextType,
          jobId: canonical.jobId,
          jobTitle: canonicalJobTitle,
          customerId: canonical.customerId,
          customerName: null,
          title: canonical.title,
          participantName: canonicalParticipants[0]?.name ?? '',
          participantId: canonicalParticipants[0]?.userId ?? '',
          participantIsActive: canonicalParticipants[0]?.isActive ?? false,
          participants: canonicalParticipants,
          unreadCount: 0,
          lastActivityAt: canonical.updatedAt.toISOString(),
          updatedAt: canonical.updatedAt.toISOString(),
        };
      }
    }

    // Resolve every explicit participant up front so a single invalid entry
    // fails the whole creation before any row is inserted.
    const participantInfos: Array<{ userId: string; name: string; isActive: boolean }> = [];
    for (const participantId of explicitParticipantIds) {
      const participantResult = await this.pool.query<{
        name: string; is_active: boolean;
      }>(
        `SELECT name, is_active FROM users
          WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, participantId],
      );
      if (participantResult.rows.length === 0) {
        throw notFound();
      }
      const info = participantResult.rows[0];
      participantInfos.push({
        userId: participantId,
        name: info.name,
        isActive: info.is_active,
      });

      // Authorize before creating
      await this.authorizeRecipient(actor, participantId, contextType, jobId);
    }

    // Verify the customer belongs to the same organization when CUSTOMER context
    let customerName: string | null = null;
    if (contextType === 'CUSTOMER' && customerId) {
      const customerResult = await this.pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM customers
          WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, customerId],
      );
      if (customerResult.rows.length === 0) {
        throw notFound();
      }
      customerName = customerResult.rows[0].name;
    }

    // Fetch job title if JOB context
    let jobTitle: string | null = null;
    if (contextType === 'JOB' && jobId) {
      const jobResult = await this.pool.query<{ title: string }>(
        `SELECT title FROM job_cards
          WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, jobId],
      );
      jobTitle = jobResult.rows[0]?.title ?? null;
    }

    const allParticipantIds = [actor.id, ...explicitParticipantIds];
    const legacyParticipant = participantInfos[0]!;

    const now = new Date();

    return this.poolTransactionWithPublish(async (tx) => {
      // JOB: canonical identity is org + job, never the participant set.
      // An existing canonical thread is returned as-is; its membership must
      // not be silently changed by a repeated create with a different list.
      let conversation: ConversationRecord | null = null;
      if (contextType === 'JOB' && jobId) {
        conversation = await tx.findCanonicalJobConversation(actor.organizationId, jobId);
      }
      if (!conversation) {
        conversation = await tx.findConversationByDirectKey(actor.organizationId, directKey);
      }
      if (conversation) {
        const participants = await tx.findParticipantsWithUsers(
          actor.organizationId, conversation.id,
        );
        if (!participants.some((p) => p.userId === actor.id)) {
          throw forbidden();
        }
        return {
          result: {
            id: conversation.id,
            directKey: conversation.directKey,
            contextType: conversation.contextType,
            jobId: conversation.jobId,
            jobTitle,
            customerId: conversation.customerId,
            customerName,
            title: conversation.title,
            participantName: legacyParticipant.name,
            participantId: legacyParticipant.userId,
            participantIsActive: legacyParticipant.isActive,
            participants,
            unreadCount: 0,
            lastActivityAt: conversation.updatedAt.toISOString(),
            updatedAt: conversation.updatedAt.toISOString(),
          },
          events: [],
        };
      }

      // Atomic insert-winner. `inserted` is true only when THIS request
      // actually created the row. A losing concurrent create returns the
      // winner's conversation with inserted=false and MUST NOT persist
      // participants or emit creation side effects: membership of an existing
      // canonical JOB conversation is immutable, and the loser is only allowed
      // the canonical-return semantics below.
      const createdResult = await tx.createConversationIfNotExists(
        actor.organizationId, directKey, contextType, jobId, customerId, title,
      );
      const created = createdResult.conversation;

      if (!createdResult.inserted) {
        const recoveredParticipants = await tx.findParticipantsWithUsers(
          actor.organizationId, created.id,
        );
        if (!recoveredParticipants.some((p) => p.userId === actor.id)) {
          throw forbidden();
        }
        return {
          result: {
            id: created.id,
            directKey: created.directKey,
            contextType: created.contextType,
            jobId: created.jobId,
            jobTitle,
            customerId: created.customerId,
            customerName,
            title: created.title,
            participantName: recoveredParticipants[0]?.name ?? '',
            participantId: recoveredParticipants[0]?.userId ?? '',
            participantIsActive: recoveredParticipants[0]?.isActive ?? false,
            participants: recoveredParticipants,
            unreadCount: 0,
            lastActivityAt: created.updatedAt.toISOString(),
            updatedAt: created.updatedAt.toISOString(),
          },
          events: [],
        };
      }

      // Add all initial participants (idempotent)
      await tx.addParticipants(
        actor.organizationId, created.id, allParticipantIds,
      );

      const clientActionId = `conv:${actor.id}:${allParticipantIds.slice(1).join(',')}:${directKey}`;

      // Insert activity (idempotent)
      const activity = await tx.insertActivity(
        actor.organizationId,
        created.id,
        actor.id,
        'CONVERSATION_CREATED',
        clientActionId,
      );

      const events: Array<{ id: bigint; event: RealtimeEventInput }> = [];

      // Persist realtime event (no notifications for conversation created)
      if (activity) {
        const rtId = await tx.appendRealtimeEvent({
          organizationId: actor.organizationId,
          messagingActivityId: activity.id,
          type: 'conversation.created',
          entityType: 'conversation',
          entityId: created.id,
          actorUserId: actor.id,
          audienceRoles: [],
          audienceUserIds: allParticipantIds,
          resourceKeys: ['conversations', `conversation:${created.id}`, 'message-unread'],
          occurredAt: now,
        });

        events.push({
          id: rtId,
          event: {
            organizationId: actor.organizationId,
            messagingActivityId: activity.id,
            type: 'conversation.created',
            entityType: 'conversation',
            entityId: created.id,
            actorUserId: actor.id,
            audience: { roles: [], userIds: allParticipantIds },
            resourceKeys: ['conversations', `conversation:${created.id}`, 'message-unread'],
            occurredAt: now,
          },
        });
      }

      const participants = await tx.findParticipantsWithUsers(
        actor.organizationId, created.id,
      );

      return {
        result: {
          id: created.id,
          directKey: created.directKey,
          contextType: created.contextType,
          jobId: created.jobId,
          jobTitle,
          customerId: created.customerId,
          customerName,
          title: created.title,
          participantName: legacyParticipant.name,
          participantId: legacyParticipant.userId,
          participantIsActive: legacyParticipant.isActive,
          participants,
          unreadCount: 0,
          lastActivityAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        },
        events,
      };
    });
  }

  async sendMessage(
    actor: SafeUser,
    conversationId: string,
    body: unknown,
    clientActionId: string,
  ): Promise<MessageRecord & { isDuplicate: boolean }> {
    this.requireEnabled();
    const trimmedBody = validateBody(body);

    if (!clientActionId || typeof clientActionId !== 'string') {
      throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
    }

    const result = await this.poolTransactionWithPublish<MessageRecord & { isDuplicate: boolean }>(async (tx) => {
      const conversation = await tx.findConversationById(actor.organizationId, conversationId);
      if (!conversation) throw notFound();

      const participants = await tx.findAllParticipants(actor.organizationId, conversation.id);
      const participantIds = participants.map((p) => p.userId);
      const isParticipant = participantIds.includes(actor.id);
      if (!isParticipant) {
        throw forbidden();
      }

      // Legacy titleless GENERAL direct conversations keep the pre-M3
      // pairwise reauthorization policy (N=2 only; N>2 stays fail-closed).
      // All contextual conversations (JOB, CUSTOMER, titled GENERAL) use the
      // resource-based policy: membership + current JobCard authorization.
      let jobAccess: JobAccessContext | null = null;
      if (conversation.contextType === 'JOB' && conversation.jobId) {
        jobAccess = await this.fetchJobAccess(actor.organizationId, conversation.jobId);
      }
      if (isLegacyGeneralConversation(conversation)) {
        if (participants.length === 2) {
          const otherParticipant = participants.find((p) => p.userId !== actor.id)!;
          await this.reauthorizeSend(actor, otherParticipant.userId, conversation);
        } else {
          throw forbidden();
        }
      } else if (!canSendMessage({ actor, conversation, job: jobAccess, isParticipant })) {
        throw forbidden();
      }

      const message = await tx.insertMessage(
        actor.organizationId, conversation.id, actor.id, clientActionId, trimmedBody,
      );

      if (!message) {
        // Duplicate — fetch existing (idempotent)
        const existing = await this.repository.findMessageByClientAction(
          conversation.id, actor.id, clientActionId,
        );
        return { result: { ...existing!, isDuplicate: true }, events: [] as Array<{ id: bigint; event: RealtimeEventInput }> };
      }

      await tx.updateConversationTimestamp(conversation.id);

      const activity = await tx.insertActivity(
        actor.organizationId,
        conversation.id,
        actor.id,
        'MESSAGE_SENT',
        clientActionId,
      );

      const now = new Date();

      // Persist realtime event. The audience is derived from conversation
      // participants, restricted for JOB conversations to users who currently
      // have access to the underlying JobCard (stale/unassigned Staff are
      // excluded and must not receive activity for threads they can no longer
      // read).
      let realtimeEventId: bigint | null = null;
      let audienceUserIds: readonly string[] = [...participantIds];
      if (activity) {
        if (conversation.contextType === 'JOB') {
          const authorized = await tx.findJobAuthorizedAudience(
            actor.organizationId, conversation.id, jobAccess?.assignedTo ?? '',
          );
          audienceUserIds = authorized;
        }
        realtimeEventId = await tx.appendRealtimeEvent({
          organizationId: actor.organizationId,
          messagingActivityId: activity.id,
          type: 'message.sent',
          entityType: 'conversation',
          entityId: conversation.id,
          actorUserId: actor.id,
          audienceRoles: [],
          audienceUserIds: [...audienceUserIds],
          resourceKeys: [
            'conversations',
            `conversation:${conversationId}`,
            'message-unread',
            'overview',
            'notifications',
          ],
          occurredAt: now,
        });

        // Persist in-app notifications for authorized other participants
        const notificationRecipients = audienceUserIds.filter((uid) => uid !== actor.id);
        if (notificationRecipients.length > 0 && realtimeEventId != null) {
          const notificationIds = await tx.appendNotifications({
            organizationId: actor.organizationId,
            sourceRealtimeEventId: realtimeEventId,
            createdAt: now,
            drafts: notificationRecipients.map((uid) => ({
              recipientUserId: uid,
              kind: 'message.received',
              entityType: 'conversation',
              entityId: conversation.id,
            })),
          });

          // Persist Web Push deliveries for active subscriptions
          if (notificationIds.length > 0) {
            await tx.appendWebPushDeliveries({
              organizationId: actor.organizationId,
              notificationIds,
              at: now,
            });
          }
        }
      }

      const events: Array<{ id: bigint; event: RealtimeEventInput }> = [];
      if (activity && realtimeEventId != null) {
        events.push({
          id: realtimeEventId,
          event: {
            organizationId: actor.organizationId,
            messagingActivityId: activity.id,
            type: 'message.sent',
            entityType: 'conversation',
            entityId: conversation.id,
            actorUserId: actor.id,
            audience: { roles: [], userIds: [...audienceUserIds] },
            resourceKeys: ['conversations', `conversation:${conversationId}`, 'message-unread', 'overview', 'notifications'],
            occurredAt: now,
          },
        });
      }

      return { result: { ...message, isDuplicate: false }, events };
    });
    return result;
  }

  async getMessages(
    actor: SafeUser,
    conversationId: string,
    cursor: MessageCursor | null,
    limit: number,
  ): Promise<MessagePage> {
    this.requireEnabled();

    const conversation = await this.repository.findConversationById(
      actor.organizationId, conversationId,
    );
    if (!conversation) throw notFound();

    const participants = await this.repository.findParticipants(
      actor.organizationId, conversationId,
    );
    const isParticipant = participants.some((p) => p.userId === actor.id);
    const jobAccess = conversation.contextType === 'JOB' && conversation.jobId
      ? await this.fetchJobAccess(actor.organizationId, conversation.jobId)
      : null;
    if (!canReadConversation({ actor, conversation, job: jobAccess, isParticipant })) {
      throw forbidden();
    }

    return this.repository.listMessages(
      actor.organizationId, conversationId, cursor, limit,
    );
  }

  /**
   * M9: explicit JOB assignee conversation sync.
   *
   * Purpose-specific operation: only the verified Staff assignment transition
   * identified by its immutable JOB_ASSIGNED activity ID may alter membership.
   * The client never supplies participant IDs. Authorization (participant +
   * ADMIN/MANAGER + current Job resource auth) is re-evaluated on every request,
   * including idempotent replay. Admin/Manager membership is immutable here.
   */
  async syncJobAssignee(
    actor: SafeUser,
    conversationId: string,
    input: JobAssigneeSyncInput,
  ): Promise<JobAssigneeSyncResult> {
    this.requireEnabled();
    if (!input.clientActionId || typeof input.clientActionId !== 'string') {
      throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
    }
    return this.poolTransactionWithPublish<JobAssigneeSyncResult>(async (tx) => {
      const conversation = await tx.findConversationByIdForUpdate(
        actor.organizationId, conversationId,
      );
      if (!conversation) throw notFound();
      if (conversation.contextType !== 'JOB' || !conversation.jobId) {
        throw new AppError('VALIDATION_ERROR', 409, 'Bu işlem yalnızca JOB konuşmaları içindir.');
      }
      const job = await tx.findJobAssigneeForUpdate(actor.organizationId, conversation.jobId);
      if (!job) throw notFound();

      const participants = await tx.findParticipantsWithUsers(
        actor.organizationId, conversation.id,
      );
      const isParticipant = participants.some((p) => p.userId === actor.id);
      if (actor.role === 'STAFF') throw forbidden();
      if (!isParticipant) throw notFound();

      if (isTerminalJobStatus(job.status as JobCardStatus)) {
        throw new AppError('JOB_NOT_EDITABLE', 409, 'Tamamlanan işlerde katılımcı değiştirilemez.');
      }

      // Idempotency receipt lookup AFTER current authorization, BEFORE mutation.
      const receipt = await tx.findActivityReceipt(
        actor.organizationId, actor.id, input.clientActionId, 'PARTICIPANTS_CHANGED',
      );
      if (receipt) {
        if (
          receipt.conversationId !== conversation.id
          || receipt.details?.assignmentTransitionId !== input.assignmentTransitionId
        ) {
          throw new AppError(
            'CLIENT_ACTION_REUSED', 409,
            'Bu işlem kodu başka bir işlem için kullanıldı.',
          );
        }
        return {
          result: { conversationId: conversation.id, synced: true, changed: false },
          events: [],
        };
      }

      // Immutable transition identity: exact JOB_ASSIGNED activity, still latest,
      // and consistent with the locked current Job assignment.
      const activity = await tx.findAssignmentActivityById(
        actor.organizationId, conversation.jobId, input.assignmentTransitionId,
      );
      if (!activity || activity.eventType !== 'JOB_ASSIGNED') {
        throw new AppError('STALE_REASSIGNMENT', 409, 'Atama geçişi bulunamadı.');
      }
      const latestActivityId = await tx.findLatestAssignmentActivityId(
        actor.organizationId, conversation.jobId,
      );
      if (latestActivityId !== activity.id) {
        throw new AppError('STALE_REASSIGNMENT', 409, 'Atama geçişi güncel değil.');
      }
      const previous = parseAssignee(activity.oldValue);
      const current = parseAssignee(activity.newValue);
      if (current !== job.assignedTo) {
        throw new AppError('STALE_REASSIGNMENT', 409, 'Atama durumu değişti.');
      }

      // M9 mutates only Staff membership.
      const candidateIds = Array.from(new Set(
        [previous, current].filter((value): value is string => value !== null),
      ));
      for (const userId of candidateIds) {
        const role = await tx.findUserRole(actor.organizationId, userId);
        if (role !== 'STAFF') {
          throw new AppError('FORBIDDEN', 403, 'Yalnızca personel atamaları senkronize edilebilir.');
        }
      }

      const participantIds = new Set(participants.map((p) => p.userId));
      const removedUserIds: string[] = [];
      const addedUserIds: string[] = [];
      if (previous !== null && previous !== current && participantIds.has(previous)) {
        await tx.deleteParticipant(actor.organizationId, conversation.id, previous);
        removedUserIds.push(previous);
      }
      if (current !== null && !participantIds.has(current)) {
        const latestMessageId = await tx.findLatestMessageId(
          actor.organizationId, conversation.id,
        );
        await tx.insertParticipantWithReadMarker(
          actor.organizationId, conversation.id, current, latestMessageId,
        );
        addedUserIds.push(current);
      }

      if (removedUserIds.length === 0 && addedUserIds.length === 0) {
        // Effective delta empty: transition verified, nothing to mutate.
        return {
          result: { conversationId: conversation.id, synced: true, changed: false },
          events: [],
        };
      }

      // Realtime audience: post-mutation participants ∩ current JOB source
      // authorization, plus the exact removed previous assignee as a targeted
      // revocation exception. Unrelated stale Staff rows stay out.
      const postParticipants = await tx.findParticipantRoles(
        actor.organizationId, conversation.id,
      );
      const audienceUserIds = postParticipants
        .filter((p) => p.role !== 'STAFF' || p.userId === job.assignedTo)
        .map((p) => p.userId);
      if (removedUserIds.length > 0) {
        audienceUserIds.push(...removedUserIds);
      }

      const activityRow = await tx.insertActivity(
        actor.organizationId,
        conversation.id,
        actor.id,
        'PARTICIPANTS_CHANGED',
        input.clientActionId,
        {
          assignmentTransitionId: input.assignmentTransitionId,
          jobId: conversation.jobId,
          contextType: 'JOB',
          addedUserIds,
          removedUserIds,
          actorUserId: actor.id,
        },
      );
      if (!activityRow) {
        // Duplicate receipt race: an identical request committed first.
        return {
          result: { conversationId: conversation.id, synced: true, changed: false },
          events: [],
        };
      }
      const resourceKeys = [
        `conversation:${conversation.id}`,
        'message-unread',
        'overview',
        'notifications',
      ];
      const realtimeEventId = await tx.appendRealtimeEvent({
        organizationId: actor.organizationId,
        messagingActivityId: activityRow.id,
        type: 'conversation.participants_changed',
        entityType: 'conversation',
        entityId: conversation.id,
        actorUserId: actor.id,
        audienceRoles: [],
        audienceUserIds,
        resourceKeys,
        occurredAt: activityRow.createdAt,
      });

      return {
        result: { conversationId: conversation.id, synced: true, changed: true },
        events: [{
          id: realtimeEventId,
          event: {
            organizationId: actor.organizationId,
            messagingActivityId: activityRow.id,
            type: 'conversation.participants_changed',
            entityType: 'conversation',
            entityId: conversation.id,
            actorUserId: actor.id,
            audience: { roles: [], userIds: audienceUserIds },
            resourceKeys,
            occurredAt: activityRow.createdAt,
          },
        }],
      };
    });
  }

  async markRead(
    actor: SafeUser,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    this.requireEnabled();

    const conversation = await this.repository.findConversationById(
      actor.organizationId, conversationId,
    );
    if (!conversation) throw notFound();

    const participants = await this.repository.findParticipants(
      actor.organizationId, conversationId,
    );
    const isParticipant = participants.some((p) => p.userId === actor.id);
    const jobAccess = conversation.contextType === 'JOB' && conversation.jobId
      ? await this.fetchJobAccess(actor.organizationId, conversation.jobId)
      : null;
    if (!canReadConversation({ actor, conversation, job: jobAccess, isParticipant })) {
      throw forbidden();
    }

    // Verify message belongs to this conversation and org
    const msgResult = await this.pool.query<{ id: string }>(
      `SELECT id FROM messages
        WHERE organization_id = $1
          AND conversation_id = $2
          AND id = $3`,
      [actor.organizationId, conversationId, messageId],
    );
    if (msgResult.rows.length === 0) {
      throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz mesaj.');
    }

    // Check if cursor actually advances
    const currentCursor = participants.find((p) => p.userId === actor.id);
    const currentReadId = currentCursor?.lastReadMessageId ?? null;

    if (currentReadId === messageId) {
      return; // Already at this cursor
    }

    // Determine if this is a forward move
    const cursorAdvances = currentReadId === null || await this.isForwardMove(
      actor.organizationId, conversationId, currentReadId, messageId,
    );

    if (!cursorAdvances) {
      return; // No-op: cursor not moving forward
    }

    const now = new Date();

    return this.poolTransactionWithPublish(async (tx) => {
      // Mark read with forward-only check; returns true if cursor actually advanced
      const advanced = await tx.markReadWithResult(
        actor.organizationId, actor.id, conversationId, messageId,
      );

      if (!advanced) {
        return { result: undefined, events: [] };
      }

      const clientActionId = `read:${actor.id}:${conversationId}:${messageId}`;

      const activity = await tx.insertActivity(
        actor.organizationId,
        conversationId,
        actor.id,
        'READ_CURSOR_UPDATED',
        clientActionId,
      );

      const events: Array<{ id: bigint; event: RealtimeEventInput }> = [];

      if (activity) {
        // Persist realtime invalidation for other tabs of the same user
        const rtId = await tx.appendRealtimeEvent({
          organizationId: actor.organizationId,
          messagingActivityId: activity.id,
          type: 'message.sent',
          entityType: 'conversation',
          entityId: conversationId,
          actorUserId: actor.id,
          audienceRoles: [],
          audienceUserIds: [actor.id],
          resourceKeys: ['conversations', `conversation:${conversationId}`, 'message-unread'],
          occurredAt: now,
        });

        events.push({
          id: rtId,
          event: {
            organizationId: actor.organizationId,
            messagingActivityId: activity.id,
            type: 'message.sent',
            entityType: 'conversation',
            entityId: conversationId,
            actorUserId: actor.id,
            audience: { roles: [], userIds: [actor.id] },
            resourceKeys: ['conversations', `conversation:${conversationId}`, 'message-unread'],
            occurredAt: now,
          },
        });
      }

      return { result: undefined, events };
    });
  }

  async getUnreadCount(actor: SafeUser): Promise<number> {
    this.requireEnabled();
    return this.repository.getUnreadCount(actor.organizationId, actor.id, actor.role);
  }

  async getRecipients(actor: SafeUser): Promise<readonly RecipientListItem[]> {
    this.requireEnabled();
    return this.repository.getAuthorizedRecipients(
      actor.organizationId, actor.id, actor.role,
    );
  }

  private requireEnabled(): void {
    if (!this.enabled) throw notFound();
  }

  private async poolTransaction<T>(
    fn: (tx: PostgresMessagingTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresMessagingTransaction(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async poolTransactionWithPublish<T>(
    fn: (tx: PostgresMessagingTransaction) => Promise<{ result: T; events: Array<{ id: bigint; event: RealtimeEventInput }> }>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresMessagingTransaction(client);
      const { result, events } = await fn(tx);
      await client.query('COMMIT');

      // Post-commit publish: events are already persisted, now notify in-memory bus
      if (this.realtimePublisher && events.length > 0) {
        for (const { id, event } of events) {
          this.realtimePublisher.publish({
            id,
            organizationId: event.organizationId,
            sourceActivityId: event.sourceActivityId ?? null,
            messagingActivityId: event.messagingActivityId ?? null,
            type: event.type,
            entityType: event.entityType,
            entityId: event.entityId,
            actorUserId: event.actorUserId,
            audience: event.audience,
            resourceKeys: event.resourceKeys,
            occurredAt: event.occurredAt,
          });
        }
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async fetchJobAccess(
    organizationId: string,
    jobId: string,
  ): Promise<JobAccessContext | null> {
    const result = await this.pool.query<{
      status: JobCardStatus;
      assigned_to: string;
    }>(
      `SELECT status, assigned_to FROM job_cards
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      organizationId,
      status: row.status,
      assignedTo: row.assigned_to,
    };
  }

  private async authorizeRecipient(
    actor: SafeUser,
    recipientUserId: string,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<void> {
    const recipients = await this.repository.getAuthorizedRecipients(
      actor.organizationId, actor.id, actor.role,
    );

    const recipient = recipients.find((r) => r.id === recipientUserId);
    if (!recipient) {
      throw forbidden();
    }
    if (!recipient.isActive) {
      throw new AppError('VALIDATION_ERROR', 400, 'Pasif kullanıcı ile konuşma başlatılamaz.');
    }

    if (contextType === 'JOB' && jobId) {
      await this.validateJobContext(actor, jobId, recipientUserId);
    }
  }

  private async reauthorizeSend(
    actor: SafeUser,
    otherUserId: string,
    conversation: ConversationRecord,
  ): Promise<void> {
    // Check if other user is still active
    const userResult = await this.pool.query<{ is_active: boolean; role: string }>(
      `SELECT is_active, role FROM users
        WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, otherUserId],
    );
    const otherUser = userResult.rows[0];
    if (!otherUser) throw forbidden();
    if (!otherUser.is_active) {
      throw new AppError('VALIDATION_ERROR', 400, 'Alıcı kullanıcı pasif durumda.');
    }

    // MANAGER: verify other participant is still in their team (must be STAFF)
    if (actor.role === 'MANAGER') {
      if (otherUser.role !== 'STAFF') throw forbidden();
      const teamCheck = await this.pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM staff_profiles
            WHERE organization_id = $1
              AND user_id = $2
              AND manager_user_id = $3
         ) AS exists`,
        [actor.organizationId, otherUserId, actor.id],
      );
      if (!teamCheck.rows[0]?.exists) throw forbidden();
    }

    // ADMIN: verify other participant is still active STAFF in same org
    if (actor.role === 'ADMIN') {
      if (otherUser.role !== 'STAFF') throw forbidden();
    }

    // STAFF: verify other participant is ADMIN or MANAGER and active
    if (actor.role === 'STAFF') {
      if (otherUser.role !== 'ADMIN' && otherUser.role !== 'MANAGER') {
        throw forbidden();
      }
    }

    // JOB context: verify job still belongs to same org and other participant is the assigned staff
    if (conversation.contextType === 'JOB' && conversation.jobId) {
      const jobResult = await this.pool.query<{ id: string; assigned_to: string }>(
        `SELECT id, assigned_to FROM job_cards
          WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, conversation.jobId],
      );
      if (jobResult.rows.length === 0) throw forbidden();

      const job = jobResult.rows[0];

      // The other participant must be the currently assigned staff
      if (job.assigned_to !== otherUserId) throw forbidden();

      // MANAGER: verify assigned staff is still in their team
      if (actor.role === 'MANAGER') {
        const jobStaffCheck = await this.pool.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM staff_profiles sp
              WHERE sp.organization_id = $1
               AND sp.user_id = $2
               AND sp.manager_user_id = $3
           ) AS exists`,
          [actor.organizationId, job.assigned_to, actor.id],
        );
        if (!jobStaffCheck.rows[0]?.exists) throw forbidden();
      }

      // STAFF: verify the job is still assigned to the actor
      if (actor.role === 'STAFF') {
        if (job.assigned_to !== actor.id) throw forbidden();
      }
    }
  }

  private async validateJobContext(
    actor: SafeUser,
    jobId: string,
    recipientUserId: string,
  ): Promise<void> {
    const result = await this.pool.query<{ assigned_to: string }>(
      `SELECT assigned_to FROM job_cards
        WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, jobId],
    );
    if (result.rows.length === 0) {
      throw new AppError('NOT_FOUND', 404, 'İş bulunamadı.');
    }

    const job = result.rows[0];
    if (job.assigned_to !== recipientUserId) {
      throw new AppError('VALIDATION_ERROR', 400, 'İş bağlamında alıcı, işin atandığı personel olmalıdır.');
    }

    // MANAGER: verify assigned staff is in their team
    if (actor.role === 'MANAGER') {
      const teamCheck = await this.pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM staff_profiles
            WHERE organization_id = $1
              AND user_id = $2
              AND manager_user_id = $3
         ) AS exists`,
        [actor.organizationId, job.assigned_to, actor.id],
      );
      if (!teamCheck.rows[0]?.exists) throw forbidden();
    }
  }

  private async isForwardMove(
    organizationId: string,
    conversationId: string,
    currentMessageId: string,
    targetMessageId: string,
  ): Promise<boolean> {
    const result = await this.pool.query<{ is_forward: boolean }>(
      `SELECT (target.created_at, target.id) > (current.created_at, current.id) AS is_forward
         FROM messages target, messages current
        WHERE target.organization_id = $1
          AND target.conversation_id = $2
          AND target.id = $3
          AND current.organization_id = $1
          AND current.conversation_id = $2
          AND current.id = $4`,
      [organizationId, conversationId, targetMessageId, currentMessageId],
    );
    return result.rows[0]?.is_forward ?? false;
  }
}
