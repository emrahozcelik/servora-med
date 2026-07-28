import type { Pool } from 'pg';
import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { RealtimeEventPublisher } from '../realtime/event-bus.js';
import type { RealtimeEventInput } from '../realtime/types.js';
import type {
  ConversationContextType,
  ConversationListCursor,
  ConversationListPage,
  ConversationListItem,
  ConversationRecord,
  MessageCursor,
  MessagePage,
  MessageRecord,
  MessagingActivityRecord,
  RecipientListItem,
  MessagingNotificationInput,
} from './types.js';
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

function buildDirectKey(
  initiatorUserId: string,
  recipientUserId: string,
  contextType: ConversationContextType,
  jobId: string | null,
): string {
  const participants = [initiatorUserId, recipientUserId].sort();
  const base = `${participants[0]}:${participants[1]}:${contextType}`;
  return jobId ? `${base}:JOB:${jobId}` : base;
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
    return this.repository.listConversations(actor.organizationId, actor.id, cursor, limit);
  }

  async createOrGetConversation(
    actor: SafeUser,
    recipientUserId: string,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<ConversationListItem> {
    this.requireEnabled();
    if (recipientUserId === actor.id) {
      throw new AppError('VALIDATION_ERROR', 400, 'Kendinizle konuşma başlatamazsınız.');
    }

    if (contextType !== 'GENERAL' && contextType !== 'JOB') {
      throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz konuşma tipi.');
    }

    // STAFF cannot create new conversations
    if (actor.role === 'STAFF') {
      throw forbidden();
    }

    // JOB must have jobId
    if (contextType === 'JOB' && !jobId) {
      throw new AppError('VALIDATION_ERROR', 400, 'İş bağlamı için jobId zorunludur.');
    }

    // GENERAL must not have jobId
    if (contextType === 'GENERAL' && jobId) {
      throw new AppError('VALIDATION_ERROR', 400, 'Genel bağlamda jobId kullanılamaz.');
    }

    const directKey = buildDirectKey(
      actor.id, recipientUserId, contextType, jobId,
    );

    // Query recipient info first (used for both create and existing cases)
    const recipientResult = await this.pool.query<{
      name: string; is_active: boolean; role: string;
    }>(
      `SELECT name, is_active, role FROM users
        WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, recipientUserId],
    );
    if (recipientResult.rows.length === 0) {
      throw notFound();
    }
    const recipientInfo = recipientResult.rows[0];

    // Authorize before creating
    await this.authorizeRecipient(actor, recipientUserId, contextType, jobId);

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

    const now = new Date();

    return this.poolTransactionWithPublish(async (tx) => {
      // Check if conversation already exists
      const existing = await tx.findConversationByDirectKey(actor.organizationId, directKey);
      if (existing) {
        return {
          result: {
            id: existing.id,
            directKey: existing.directKey,
            contextType: existing.contextType,
            jobId: existing.jobId,
            jobTitle,
            participantName: recipientInfo.name,
            participantId: recipientUserId,
            participantIsActive: recipientInfo.is_active,
            unreadCount: 0,
            lastActivityAt: existing.updatedAt.toISOString(),
            updatedAt: existing.updatedAt.toISOString(),
          },
          events: [],
        };
      }

      // Atomic insert-winner
      const conversation = await tx.createConversationIfNotExists(
        actor.organizationId, directKey, contextType, jobId,
      );

      // Add participants (idempotent)
      await tx.addParticipants(
        actor.organizationId, conversation.id, [actor.id, recipientUserId],
      );

      const clientActionId = `conv:${actor.id}:${recipientUserId}:${directKey}`;

      // Insert activity (idempotent)
      const activity = await tx.insertActivity(
        actor.organizationId,
        conversation.id,
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
          entityId: conversation.id,
          actorUserId: actor.id,
          audienceRoles: [],
          audienceUserIds: [actor.id, recipientUserId],
          resourceKeys: ['conversations', `conversation:${conversation.id}`, 'message-unread'],
          occurredAt: now,
        });

        events.push({
          id: rtId,
          event: {
            organizationId: actor.organizationId,
            messagingActivityId: activity.id,
            type: 'conversation.created',
            entityType: 'conversation',
            entityId: conversation.id,
            actorUserId: actor.id,
            audience: { roles: [], userIds: [actor.id, recipientUserId] },
            resourceKeys: ['conversations', `conversation:${conversation.id}`, 'message-unread'],
            occurredAt: now,
          },
        });
      }

      return {
        result: {
          id: conversation.id,
          directKey: conversation.directKey,
          contextType: conversation.contextType,
          jobId: conversation.jobId,
          jobTitle,
          participantName: recipientInfo.name,
          participantId: recipientUserId,
          participantIsActive: recipientInfo.is_active,
          unreadCount: 0,
          lastActivityAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
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
      if (!participantIds.includes(actor.id)) {
        throw forbidden();
      }

      // Reauthorize: verify exactly 2 participants and other is still valid
      if (participants.length !== 2) {
        throw forbidden();
      }
      const otherParticipant = participants.find((p) => p.userId !== actor.id)!;
      await this.reauthorizeSend(actor, otherParticipant.userId, conversation);

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

      // Persist realtime event
      let realtimeEventId: bigint | null = null;
      if (activity) {
        realtimeEventId = await tx.appendRealtimeEvent({
          organizationId: actor.organizationId,
          messagingActivityId: activity.id,
          type: 'message.sent',
          entityType: 'conversation',
          entityId: conversation.id,
          actorUserId: actor.id,
          audienceRoles: [],
          audienceUserIds: [...participantIds],
          resourceKeys: [
            'conversations',
            `conversation:${conversationId}`,
            'message-unread',
            'overview',
            'notifications',
          ],
          occurredAt: now,
        });

        // Persist in-app notifications for other participants
        const notificationRecipients = participantIds.filter((uid) => uid !== actor.id);
        if (notificationRecipients.length > 0 && realtimeEventId != null) {
          await tx.appendNotifications({
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
            audience: { roles: [], userIds: [...participantIds] },
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

    const participants = await this.repository.findParticipants(
      actor.organizationId, conversationId,
    );
    if (!participants.some((p) => p.userId === actor.id)) {
      throw forbidden();
    }

    return this.repository.listMessages(
      actor.organizationId, conversationId, cursor, limit,
    );
  }

  async markRead(
    actor: SafeUser,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    this.requireEnabled();

    const participants = await this.repository.findParticipants(
      actor.organizationId, conversationId,
    );
    if (!participants.some((p) => p.userId === actor.id)) {
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
    return this.repository.getUnreadCount(actor.organizationId, actor.id);
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
