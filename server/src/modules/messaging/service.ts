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
  if (typeof body !== 'string' || body.length < 1 || body.length > 4000) {
    throw new AppError('VALIDATION_ERROR', 400, 'Mesaj 1-4000 karakter arasında olmalıdır.');
  }
  if (/<[a-zA-Z/]/.test(body)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Mesaj yalnız düz metin olabilir.');
  }
  return body;
}

function buildDirectKey(
  organizationId: string,
  initiatorUserId: string,
  recipientUserId: string,
  contextType: ConversationContextType,
  jobId: string | null,
): string {
  const participants = [initiatorUserId, recipientUserId].sort();
  const base = `${participants[0]}:${participants[1]}:${contextType}`;
  return jobId ? `${base}:JOB:${jobId}` : base;
}

function buildRealtimeEvent(
  organizationId: string,
  conversationId: string,
  participantIds: readonly string[],
  activity: MessagingActivityRecord,
  occurredAt: Date,
  notificationDrafts: readonly MessagingNotificationInput[],
): RealtimeEventInput {
  const eventType = activity.action === 'CONVERSATION_CREATED'
    ? 'conversation.created' as const
    : 'message.sent' as const;

  const resourceKeys = [
    'conversations',
    `conversation:${conversationId}`,
    'message-unread',
    'overview',
  ];

  if (notificationDrafts.length > 0) {
    resourceKeys.push('notifications');
  }

  return {
    organizationId,
    sourceActivityId: activity.id,
    type: eventType,
    entityType: 'conversation',
    entityId: conversationId,
    actorUserId: activity.actorUserId,
    audience: {
      roles: [],
      userIds: [...participantIds],
    },
    resourceKeys,
    occurredAt,
  };
}

export class MessagingService {
  private readonly repository: MessagingRepository;

  constructor(
    pool: Pick<Pool, 'query'>,
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
  ): Promise<ConversationRecord & { participants: readonly { userId: string; isActive: boolean }[] }> {
    this.requireEnabled();
    if (recipientUserId === actor.id) {
      throw new AppError('VALIDATION_ERROR', 400, 'Kendinizle konuşma başlatamazsınız.');
    }

    if (contextType !== 'GENERAL' && contextType !== 'JOB') {
      throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz konuşma tipi.');
    }

    const directKey = buildDirectKey(
      actor.organizationId, actor.id, recipientUserId, contextType, jobId,
    );

    return this.poolTransaction(async (tx) => {
      const existing = await tx.findConversationByDirectKey(actor.organizationId, directKey);
      if (existing) {
        const participants = await tx.findAllParticipants(actor.organizationId, existing.id);
        return {
          ...existing,
          participants: participants.map((p) => ({ userId: p.userId, isActive: true })),
        };
      }

      await this.authorizeRecipient(actor, recipientUserId, contextType, jobId);

      const conversation = await tx.createConversation(
        actor.organizationId, directKey, contextType, jobId,
      );

      const participantRecords = await tx.addParticipants(
        actor.organizationId, conversation.id, [actor.id, recipientUserId],
      );

      const activity = await tx.insertActivity(
        actor.organizationId,
        conversation.id,
        actor.id,
        'CONVERSATION_CREATED',
        `conv-create-${actor.id}-${recipientUserId}-${Date.now()}`,
      );

      const realtimeEvent = buildRealtimeEvent(
        actor.organizationId,
        conversation.id,
        [actor.id, recipientUserId],
        activity,
        new Date(),
        [],
      );

      this.realtimePublisher?.publish({
        ...realtimeEvent,
        id: BigInt(0), // Will be replaced by actual insert
        sourceActivityId: realtimeEvent.sourceActivityId,
      } as any);

      return {
        ...conversation,
        participants: participantRecords.map((p) => ({
          userId: p.userId,
          isActive: true,
        })),
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

    return this.poolTransaction(async (tx) => {
      const conversation = await tx.findConversationById(actor.organizationId, conversationId);
      if (!conversation) throw notFound();

      const participants = await tx.findAllParticipants(actor.organizationId, conversation.id);
      const participantIds = participants.map((p) => p.userId);
      if (!participantIds.includes(actor.id)) {
        throw forbidden();
      }

      const otherParticipant = participants.find((p) => p.userId !== actor.id);
      if (otherParticipant) {
        const isActive = await this.repository.getAuthorizedRecipients(
          actor.organizationId, actor.id, actor.role,
        );
        // Don't let sending to disabled users
        const recipient = isActive.find((r) => r.id === otherParticipant.userId);
        if (recipient && !recipient.isActive) {
          throw new AppError('VALIDATION_ERROR', 400, 'Alıcı kullanıcı pasif durumda.');
        }
      }

      const message = await tx.insertMessage(
        actor.organizationId, conversation.id, actor.id, clientActionId, trimmedBody,
      );

      if (!message) {
        // Duplicate - fetch existing
        const existing = await this.repository.findMessageByClientAction(
          conversation.id, actor.id, clientActionId,
        );
        return { ...existing!, isDuplicate: true };
      }

      await tx.updateConversationTimestamp(conversation.id);

      const activity = await tx.insertActivity(
        actor.organizationId,
        conversation.id,
        actor.id,
        'MESSAGE_SENT',
        clientActionId,
      );

      const notificationInputs = participantIds
        .filter((uid) => uid !== actor.id)
        .map((uid): MessagingNotificationInput => ({
          organizationId: actor.organizationId,
          recipientUserId: uid,
          kind: 'message.received',
          entityType: 'conversation',
          entityId: conversation.id,
        }));

      const realtimeEvent = buildRealtimeEvent(
        actor.organizationId,
        conversation.id,
        participantIds,
        activity,
        new Date(),
        notificationInputs,
      );

      if (this.realtimePublisher && activity) {
        this.realtimePublisher.publish({
          ...realtimeEvent,
          id: BigInt(0),
          sourceActivityId: realtimeEvent.sourceActivityId,
        } as any);
      }

      return { ...message, isDuplicate: false };
    });
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
      actor.organizationId, conversationId, cursor, limit, true,
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

    await this.repository.markRead(actor.organizationId, actor.id, conversationId, messageId);
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
    const pool = (this.repository as PostgresMessagingRepository)['pool'] as Pool;
    const client = await pool.connect();
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
      throw new AppError('NOT_FOUND', 404, 'Alıcı bulunamadı.');
    }
    if (!recipient.isActive) {
      throw new AppError('VALIDATION_ERROR', 400, 'Pasif kullanıcı ile konuşma başlatılamaz.');
    }

    if (contextType === 'JOB' && jobId) {
      // Validate job visibility
      const pool = (this.repository as PostgresMessagingRepository)['pool'] as Pool;
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM job_cards
          WHERE organization_id = $1
            AND id = $2
            AND ($3 = 'ADMIN' OR $3 = 'MANAGER' OR assigned_to = $4)`,
        [actor.organizationId, jobId, actor.role, actor.id],
      );
      if (result.rows.length === 0) {
        throw new AppError('NOT_FOUND', 404, 'İş bulunamadı.');
      }
    }
  }
}
