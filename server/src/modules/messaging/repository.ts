import type { Pool, PoolClient } from 'pg';

import type {
  ConversationContextType,
  ConversationListCursor,
  ConversationListItem,
  ConversationListPage,
  ConversationParticipantRecord,
  ConversationRecord,
  DirectKey,
  MessageCursor,
  MessagePage,
  MessageRecord,
  MessagingActivityAction,
  MessagingActivityRecord,
  RecipientListItem,
  MessagingNotificationInput,
} from './types.js';

type ConversationRow = {
  id: string;
  organization_id: string;
  direct_key: string;
  context_type: ConversationContextType;
  job_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type ParticipantRow = {
  conversation_id: string;
  user_id: string;
  organization_id: string;
  last_read_message_id: string | null;
  created_at: Date;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  organization_id: string;
  sender_user_id: string;
  client_action_id: string;
  body: string;
  created_at: Date;
};

type ConversationListItemRow = {
  id: string;
  direct_key: string;
  context_type: ConversationContextType;
  job_id: string | null;
  job_title: string | null;
  participant_name: string;
  participant_id: string;
  participant_is_active: boolean;
  unread_count: string;
  last_activity_at: Date;
  updated_at: Date;
};

type RecipientRow = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
};

type MessagingActivityRow = {
  id: string;
  organization_id: string;
  conversation_id: string;
  actor_user_id: string;
  action: MessagingActivityAction;
  client_action_id: string;
  created_at: Date;
};

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    directKey: row.direct_key,
    contextType: row.context_type,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    organizationId: row.organization_id,
    senderUserId: row.sender_user_id,
    clientActionId: row.client_action_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapActivity(row: MessagingActivityRow): MessagingActivityRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    clientActionId: row.client_action_id,
    createdAt: row.created_at,
  };
}

export interface MessagingRepository {
  findConversationByDirectKey(
    organizationId: string,
    directKey: string,
  ): Promise<ConversationRecord | null>;

  findConversationById(
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null>;

  createConversation(
    organizationId: string,
    directKey: DirectKey,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<ConversationRecord>;

  addParticipants(
    organizationId: string,
    conversationId: string,
    userIds: readonly string[],
  ): Promise<readonly ConversationParticipantRecord[]>;

  findParticipants(
    organizationId: string,
    conversationId: string,
  ): Promise<readonly ConversationParticipantRecord[]>;

  listConversations(
    organizationId: string,
    userId: string,
    cursor: ConversationListCursor | null,
    limit: number,
  ): Promise<ConversationListPage>;

  listMessages(
    organizationId: string,
    conversationId: string,
    cursor: MessageCursor | null,
    limit: number,
  ): Promise<MessagePage>;

  insertMessage(
    organizationId: string,
    conversationId: string,
    senderUserId: string,
    clientActionId: string,
    body: string,
  ): Promise<MessageRecord>;

  findMessageByClientAction(
    conversationId: string,
    senderUserId: string,
    clientActionId: string,
  ): Promise<MessageRecord | null>;

  getUnreadCount(
    organizationId: string,
    userId: string,
  ): Promise<number>;

  getUnreadCountByConversation(
    organizationId: string,
    userId: string,
    conversationId: string,
  ): Promise<number>;

  markRead(
    organizationId: string,
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void>;

  getAuthorizedRecipients(
    organizationId: string,
    userId: string,
    role: string,
  ): Promise<readonly RecipientListItem[]>;
}

export class PostgresMessagingRepository implements MessagingRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async findConversationByDirectKey(
    organizationId: string,
    directKey: string,
  ): Promise<ConversationRecord | null> {
    const result = await this.pool.query<ConversationRow>(
      `SELECT id, organization_id, direct_key, context_type, job_id, created_at, updated_at
         FROM conversations
        WHERE organization_id = $1 AND direct_key = $2`,
      [organizationId, directKey],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async findConversationById(
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const result = await this.pool.query<ConversationRow>(
      `SELECT id, organization_id, direct_key, context_type, job_id, created_at, updated_at
         FROM conversations
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, conversationId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async createConversation(
    organizationId: string,
    directKey: DirectKey,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<ConversationRecord> {
    const result = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (organization_id, direct_key, context_type, job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, direct_key) DO UPDATE SET updated_at = NOW()
       RETURNING id, organization_id, direct_key, context_type, job_id, created_at, updated_at`,
      [organizationId, directKey, contextType, jobId],
    );
    return mapConversation(result.rows[0]);
  }

  async addParticipants(
    organizationId: string,
    conversationId: string,
    userIds: readonly string[],
  ): Promise<readonly ConversationParticipantRecord[]> {
    if (userIds.length === 0) return [];
    const values: unknown[] = [];
    const rows = userIds.map((userId, index) => {
      const offset = index * 3;
      values.push(conversationId, userId, organizationId);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
    });
    const result = await this.pool.query<ParticipantRow>(
      `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
       VALUES ${rows.join(', ')}
       ON CONFLICT (conversation_id, user_id) DO NOTHING
       RETURNING conversation_id, user_id, organization_id, last_read_message_id, created_at`,
      values,
    );
    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      lastReadMessageId: row.last_read_message_id,
      createdAt: row.created_at,
    }));
  }

  async findParticipants(
    organizationId: string,
    conversationId: string,
  ): Promise<readonly ConversationParticipantRecord[]> {
    const result = await this.pool.query<ParticipantRow>(
      `SELECT conversation_id, user_id, organization_id, last_read_message_id, created_at
         FROM conversation_participants
        WHERE organization_id = $1 AND conversation_id = $2`,
      [organizationId, conversationId],
    );
    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      lastReadMessageId: row.last_read_message_id,
      createdAt: row.created_at,
    }));
  }

  async listConversations(
    organizationId: string,
    userId: string,
    cursor: ConversationListCursor | null,
    limit: number,
  ): Promise<ConversationListPage> {
    const cursorClause = cursor
      ? `AND (c.updated_at, c.id) < ($${cursor ? 3 : 0}, $${cursor ? 4 : 0})`
      : '';
    const limitParam = cursor ? '$5' : '$3';
    const values: unknown[] = [organizationId, userId];
    if (cursor) {
      values.push(cursor.updatedAt, cursor.id);
    }
    values.push(limit + 1);

    const result = await this.pool.query<ConversationListItemRow>(
      `SELECT c.id, c.direct_key, c.context_type, c.job_id,
              j.title AS job_title,
              other.name AS participant_name,
              other.id AS participant_id,
              other.is_active AS participant_is_active,
              COUNT(m.id) FILTER (
                WHERE m.sender_user_id <> $2
                  AND (cp.last_read_message_id IS NULL
                       OR (m.created_at, m.id) > (rm.created_at, rm.id))
              ) AS unread_count,
              COALESCE(
                (SELECT MAX(msgs.created_at) FROM messages msgs WHERE msgs.conversation_id = c.id),
                c.created_at
              ) AS last_activity_at,
              c.updated_at
         FROM conversations c
         JOIN conversation_participants cp
           ON cp.conversation_id = c.id AND cp.user_id = $2 AND cp.organization_id = c.organization_id
         JOIN conversation_participants cp2
           ON cp2.conversation_id = c.id AND cp2.user_id <> $2
         JOIN users other
           ON other.organization_id = c.organization_id AND other.id = cp2.user_id
         LEFT JOIN messages rm
           ON rm.conversation_id = c.id AND rm.id = cp.last_read_message_id
         LEFT JOIN job_cards j
           ON j.organization_id = c.organization_id AND j.id = c.job_id
         LEFT JOIN messages m
           ON m.conversation_id = c.id
        WHERE c.organization_id = $1
          ${cursorClause}
        GROUP BY c.id, c.direct_key, c.context_type, c.job_id, j.title,
                 other.name, other.id, other.is_active,
                 cp.last_read_message_id, c.updated_at, c.created_at
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ${limitParam}`,
      values,
    );

    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        directKey: row.direct_key,
        contextType: row.context_type,
        jobId: row.job_id,
        jobTitle: row.job_title,
        participantName: row.participant_name,
        participantId: row.participant_id,
        participantIsActive: row.participant_is_active,
        unreadCount: parseInt(row.unread_count, 10),
        lastActivityAt: row.last_activity_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: result.rows.length > limit && last
        ? { updatedAt: last.updated_at, id: last.id }
        : null,
    };
  }

  async listMessages(
    organizationId: string,
    conversationId: string,
    cursor: MessageCursor | null,
    limit: number,
  ): Promise<MessagePage> {
    const cursorClause = cursor
      ? `AND (m.created_at, m.id) < ($${cursor ? 4 : 0}, $${cursor ? 5 : 0})`
      : '';
    const limitParam = cursor ? '$6' : '$3';
    const values: unknown[] = [organizationId, conversationId];
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
    }
    values.push(limit + 1);

    // Query DESC (newest first) to get the bounded window; return ASC for display
    const result = await this.pool.query<MessageRow>(
      `SELECT m.id, m.conversation_id, m.organization_id, m.sender_user_id,
              m.client_action_id, m.body, m.created_at
         FROM messages m
        WHERE m.organization_id = $1
          AND m.conversation_id = $2
          ${cursorClause}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limitParam}`,
      values,
    );

    const rows = result.rows.map(mapMessage).reverse();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: result.rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    };
  }

  async insertMessage(
    organizationId: string,
    conversationId: string,
    senderUserId: string,
    clientActionId: string,
    body: string,
  ): Promise<MessageRecord> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (organization_id, conversation_id, sender_user_id, client_action_id, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id, sender_user_id, client_action_id) DO NOTHING
       RETURNING id, conversation_id, organization_id, sender_user_id, client_action_id, body, created_at`,
      [organizationId, conversationId, senderUserId, clientActionId, body],
    );
    const row = result.rows[0];
    if (!row) return null as unknown as MessageRecord;
    return mapMessage(row);
  }

  async findMessageByClientAction(
    conversationId: string,
    senderUserId: string,
    clientActionId: string,
  ): Promise<MessageRecord | null> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, conversation_id, organization_id, sender_user_id,
              client_action_id, body, created_at
         FROM messages
        WHERE conversation_id = $1
          AND sender_user_id = $2
          AND client_action_id = $3`,
      [conversationId, senderUserId, clientActionId],
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async getUnreadCount(
    organizationId: string,
    userId: string,
  ): Promise<number> {
    const result = await this.pool.query<{ unread_count: string }>(
      `SELECT COUNT(*) AS unread_count
         FROM messages m
         JOIN conversation_participants cp
           ON cp.conversation_id = m.conversation_id
          AND cp.user_id = $2
          AND cp.organization_id = m.organization_id
         LEFT JOIN messages rm
           ON rm.conversation_id = m.conversation_id AND rm.id = cp.last_read_message_id
        WHERE m.organization_id = $1
          AND m.sender_user_id <> $2
          AND (cp.last_read_message_id IS NULL
               OR (m.created_at, m.id) > (rm.created_at, rm.id))`,
      [organizationId, userId],
    );
    return parseInt(result.rows[0]?.unread_count ?? '0', 10);
  }

  async getUnreadCountByConversation(
    organizationId: string,
    userId: string,
    conversationId: string,
  ): Promise<number> {
    const result = await this.pool.query<{ unread_count: string }>(
      `SELECT COUNT(*) AS unread_count
         FROM messages m
         JOIN conversation_participants cp
           ON cp.conversation_id = m.conversation_id
          AND cp.user_id = $2
          AND cp.organization_id = m.organization_id
         LEFT JOIN messages rm
           ON rm.conversation_id = m.conversation_id AND rm.id = cp.last_read_message_id
        WHERE m.organization_id = $1
          AND m.conversation_id = $3
          AND m.sender_user_id <> $2
          AND (cp.last_read_message_id IS NULL
               OR (m.created_at, m.id) > (rm.created_at, rm.id))`,
      [organizationId, userId, conversationId],
    );
    return parseInt(result.rows[0]?.unread_count ?? '0', 10);
  }

  async markRead(
    organizationId: string,
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.pool.query(
      `WITH target_msg AS (
         SELECT created_at, id FROM messages
          WHERE organization_id = $1
            AND conversation_id = $3
            AND id = $4
       )
       UPDATE conversation_participants cp
          SET last_read_message_id = $4
         FROM target_msg tm
        WHERE cp.organization_id = $1
          AND cp.user_id = $2
          AND cp.conversation_id = $3
          AND (cp.last_read_message_id IS NULL
               OR (tm.created_at, tm.id) > (
                 SELECT rm.created_at, rm.id FROM messages rm
                  WHERE rm.conversation_id = cp.conversation_id
                    AND rm.id = cp.last_read_message_id
               ))`,
      [organizationId, userId, conversationId, messageId],
    );
  }

  async getAuthorizedRecipients(
    organizationId: string,
    userId: string,
    role: string,
  ): Promise<readonly RecipientListItem[]> {
    let query: string;
    const values: unknown[] = [organizationId, userId];

    if (role === 'ADMIN') {
      query = `SELECT u.id, u.name, u.role, u.is_active
                 FROM users u
                WHERE u.organization_id = $1
                  AND u.id <> $2
                  AND u.role = 'STAFF'
                  AND u.is_active = TRUE
                ORDER BY u.name ASC`;
    } else if (role === 'MANAGER') {
      query = `SELECT u.id, u.name, u.role, u.is_active
                 FROM users u
                 JOIN staff_profiles sp
                   ON sp.organization_id = u.organization_id AND sp.user_id = u.id
                WHERE u.organization_id = $1
                  AND u.id <> $2
                  AND u.role = 'STAFF'
                  AND sp.manager_user_id = $2
                ORDER BY u.name ASC`;
    } else {
      // STAFF cannot create new conversations — return empty
      return [];
    }

    const result = await this.pool.query<RecipientRow>(query, values);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
    }));
  }
}

export class PostgresMessagingTransaction {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async findConversationByDirectKey(
    organizationId: string,
    directKey: string,
  ): Promise<ConversationRecord | null> {
    const result = await this.client.query<ConversationRow>(
      `SELECT id, organization_id, direct_key, context_type, job_id, created_at, updated_at
         FROM conversations
        WHERE organization_id = $1 AND direct_key = $2`,
      [organizationId, directKey],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async findConversationById(
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const result = await this.client.query<ConversationRow>(
      `SELECT id, organization_id, direct_key, context_type, job_id, created_at, updated_at
         FROM conversations
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, conversationId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async createConversation(
    organizationId: string,
    directKey: DirectKey,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<ConversationRecord> {
    const result = await this.client.query<ConversationRow>(
      `INSERT INTO conversations (organization_id, direct_key, context_type, job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, direct_key) DO UPDATE SET updated_at = NOW()
       RETURNING id, organization_id, direct_key, context_type, job_id, created_at, updated_at`,
      [organizationId, directKey, contextType, jobId],
    );
    return mapConversation(result.rows[0]);
  }

  async createConversationIfNotExists(
    organizationId: string,
    directKey: DirectKey,
    contextType: ConversationContextType,
    jobId: string | null,
  ): Promise<ConversationRecord> {
    const result = await this.client.query<ConversationRow>(
      `INSERT INTO conversations (organization_id, direct_key, context_type, job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, direct_key) DO NOTHING
       RETURNING id, organization_id, direct_key, context_type, job_id, created_at, updated_at`,
      [organizationId, directKey, contextType, jobId],
    );
    // If no row returned (conflict), fetch existing
    if (result.rows.length === 0) {
      return this.findConversationByDirectKey(organizationId, directKey) as Promise<ConversationRecord>;
    }
    return mapConversation(result.rows[0]);
  }

  async addParticipants(
    organizationId: string,
    conversationId: string,
    userIds: readonly string[],
  ): Promise<readonly ConversationParticipantRecord[]> {
    if (userIds.length === 0) return [];
    const values: unknown[] = [];
    const rows = userIds.map((userId, index) => {
      const offset = index * 3;
      values.push(conversationId, userId, organizationId);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
    });
    const result = await this.client.query<ParticipantRow>(
      `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
       VALUES ${rows.join(', ')}
       ON CONFLICT (conversation_id, user_id) DO NOTHING
       RETURNING conversation_id, user_id, organization_id, last_read_message_id, created_at`,
      values,
    );
    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      lastReadMessageId: row.last_read_message_id,
      createdAt: row.created_at,
    }));
  }

  async findAllParticipants(
    organizationId: string,
    conversationId: string,
  ): Promise<readonly ConversationParticipantRecord[]> {
    const result = await this.client.query<ParticipantRow>(
      `SELECT conversation_id, user_id, organization_id, last_read_message_id, created_at
         FROM conversation_participants
        WHERE organization_id = $1 AND conversation_id = $2`,
      [organizationId, conversationId],
    );
    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      lastReadMessageId: row.last_read_message_id,
      createdAt: row.created_at,
    }));
  }

  async insertMessage(
    organizationId: string,
    conversationId: string,
    senderUserId: string,
    clientActionId: string,
    body: string,
  ): Promise<MessageRecord> {
    const result = await this.client.query<MessageRow>(
      `INSERT INTO messages (organization_id, conversation_id, sender_user_id, client_action_id, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id, sender_user_id, client_action_id) DO NOTHING
       RETURNING id, conversation_id, organization_id, sender_user_id, client_action_id, body, created_at`,
      [organizationId, conversationId, senderUserId, clientActionId, body],
    );
    const row = result.rows[0];
    if (!row) return null as unknown as MessageRecord;
    return mapMessage(row);
  }

  async insertActivity(
    organizationId: string,
    conversationId: string,
    actorUserId: string,
    action: MessagingActivityAction,
    clientActionId: string,
  ): Promise<MessagingActivityRecord> {
    const result = await this.client.query<MessagingActivityRow>(
      `INSERT INTO messaging_activity_logs
         (organization_id, conversation_id, actor_user_id, action, client_action_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, actor_user_id, client_action_id, action) DO NOTHING
       RETURNING id, organization_id, conversation_id, actor_user_id, action, client_action_id, created_at`,
      [organizationId, conversationId, actorUserId, action, clientActionId],
    );
    const row = result.rows[0];
    if (!row) return null as unknown as MessagingActivityRecord;
    return mapActivity(row);
  }

  async markRead(
    organizationId: string,
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.client.query(
      `WITH target_msg AS (
         SELECT created_at, id FROM messages
          WHERE organization_id = $1
            AND conversation_id = $3
            AND id = $4
       )
       UPDATE conversation_participants cp
          SET last_read_message_id = $4
         FROM target_msg tm
        WHERE cp.organization_id = $1
          AND cp.user_id = $2
          AND cp.conversation_id = $3
          AND (cp.last_read_message_id IS NULL
               OR (tm.created_at, tm.id) > (
                 SELECT rm.created_at, rm.id FROM messages rm
                  WHERE rm.conversation_id = cp.conversation_id
                    AND rm.id = cp.last_read_message_id
               ))`,
      [organizationId, userId, conversationId, messageId],
    );
  }

  async appendRealtimeEvent(input: {
    organizationId: string;
    messagingActivityId: string;
    type: string;
    entityType: string;
    entityId: string;
    actorUserId: string | null;
    audienceRoles: readonly string[];
    audienceUserIds: readonly string[];
    resourceKeys: readonly string[];
    occurredAt: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO realtime_events
        (organization_id, messaging_activity_id, event_type, entity_type,
         entity_id, actor_user_id, audience_roles, audience_user_ids,
         resource_keys, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.organizationId,
        input.messagingActivityId,
        input.type,
        input.entityType,
        input.entityId,
        input.actorUserId,
        input.audienceRoles,
        input.audienceUserIds,
        input.resourceKeys,
        input.occurredAt,
      ],
    );
  }

  async appendNotifications(input: {
    organizationId: string;
    sourceRealtimeEventId: bigint;
    createdAt: Date;
    drafts: readonly {
      recipientUserId: string;
      kind: string;
      entityType: string;
      entityId: string;
    }[];
  }): Promise<void> {
    if (input.drafts.length === 0) return;
    const values: unknown[] = [];
    const rows = input.drafts.map((draft, index) => {
      const offset = index * 7;
      values.push(
        input.organizationId,
        draft.recipientUserId,
        input.sourceRealtimeEventId.toString(),
        draft.kind,
        draft.entityType,
        draft.entityId,
        input.createdAt,
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
        $${offset + 5}, $${offset + 6}, $${offset + 7})`;
    });
    await this.client.query(
      `INSERT INTO in_app_notifications
        (organization_id, recipient_user_id, source_realtime_event_id, kind,
         entity_type, entity_id, created_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (recipient_user_id, source_realtime_event_id) DO NOTHING`,
      values,
    );
  }

  async updateConversationTimestamp(conversationId: string): Promise<void> {
    await this.client.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId],
    );
  }
}

export interface MessagingTransactionManager {
  run<T>(fn: (tx: PostgresMessagingTransaction) => Promise<T>): Promise<T>;
}
