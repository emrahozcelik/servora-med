import { ApiError, items, json, nullableString, number, object, request, string } from './api';

export type Conversation = {
  id: string;
  directKey: string;
  contextType: 'GENERAL' | 'JOB' | 'CUSTOMER';
  jobId: string | null;
  jobTitle: string | null;
  customerId: string | null;
  title: string | null;
  participantName: string;
  participantId: string;
  participantIsActive: boolean;
  participants: readonly ConversationParticipantSummary[];
  unreadCount: number;
  lastActivityAt: string;
  updatedAt: string;
};

export type ConversationParticipantSummary = {
  userId: string;
  name: string;
  isActive: boolean;
};

export type Recipient = {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
};

export type Message = {
  id: string;
  conversationId: string;
  organizationId: string;
  senderUserId: string;
  clientActionId: string;
  body: string;
  createdAt: string;
  isDuplicate?: boolean;
};

export type MessagePage = {
  items: Message[];
  nextCursor: string | null;
};

export type ConversationListPage = {
  items: Conversation[];
  nextCursor: string | null;
};

function parseConversation(value: unknown): Conversation {
  const v = object(value);
  return {
    id: string(v.id, 'id'),
    directKey: string(v.directKey, 'directKey'),
    contextType: string(v.contextType, 'contextType') as 'GENERAL' | 'JOB' | 'CUSTOMER',
    jobId: nullableString(v.jobId, 'jobId'),
    jobTitle: nullableString(v.jobTitle, 'jobTitle'),
    customerId: nullableString(v.customerId, 'customerId'),
    title: nullableString(v.title, 'title'),
    participantName: string(v.participantName, 'participantName'),
    participantId: string(v.participantId, 'participantId'),
    participantIsActive: v.participantIsActive === true,
    participants: Array.isArray(v.participants)
      ? v.participants.map((entry: unknown) => {
          const p = object(entry);
          return {
            userId: string(p.userId, 'userId'),
            name: string(p.name, 'name'),
            isActive: p.isActive === true,
          };
        })
      : [],
    unreadCount: number(v.unreadCount, 'unreadCount'),
    lastActivityAt: string(v.lastActivityAt, 'lastActivityAt'),
    updatedAt: string(v.updatedAt, 'updatedAt'),
  };
}

function parseRecipient(value: unknown): Recipient {
  const v = object(value);
  return {
    id: string(v.id, 'id'),
    name: string(v.name, 'name'),
    role: string(v.role, 'role'),
    isActive: v.isActive === true,
  };
}

function parseMessage(value: unknown): Message {
  const v = object(value);
  return {
    id: string(v.id, 'id'),
    conversationId: string(v.conversationId, 'conversationId'),
    organizationId: string(v.organizationId, 'organizationId'),
    senderUserId: string(v.senderUserId, 'senderUserId'),
    clientActionId: string(v.clientActionId, 'clientActionId'),
    body: string(v.body, 'body'),
    createdAt: string(v.createdAt, 'createdAt'),
    isDuplicate: v.isDuplicate === true || undefined,
  };
}

export async function listConversations(cursor?: string | null): Promise<ConversationListPage> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const data = object(await request(`/api/messaging/conversations?${params}`));
  const list = data.items;
  if (!Array.isArray(list)) throw new ApiError(0, 'INVALID_RESPONSE', 'Geçersiz liste yanıtı.');
  return {
    items: list.map(parseConversation),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

export async function listRecipients(): Promise<Recipient[]> {
  const data = object(await request('/api/messaging/recipients'));
  const list = data.items;
  if (!Array.isArray(list)) throw new ApiError(0, 'INVALID_RESPONSE', 'Geçersiz liste yanıtı.');
  return list.map(parseRecipient);
}

export async function createOrGetConversation(
  recipientUserId: string,
  contextType: 'GENERAL' | 'JOB' = 'GENERAL',
  jobId?: string | null,
): Promise<Conversation> {
  const body: Record<string, unknown> = { recipientUserId, contextType };
  if (jobId) body.jobId = jobId;
  const data = await request('/api/messaging/conversations', json('POST', body));
  return parseConversation(data);
}

export async function listMessages(
  conversationId: string,
  cursor?: string | null,
): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  const data = object(await request(`/api/messaging/conversations/${conversationId}/messages?${params}`));
  const list = data.items;
  if (!Array.isArray(list)) throw new ApiError(0, 'INVALID_RESPONSE', 'Geçersiz liste yanıtı.');
  return {
    items: list.map(parseMessage),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

export async function sendMessage(
  conversationId: string,
  body: string,
  clientActionId: string,
): Promise<Message> {
  const data = await request(
    `/api/messaging/conversations/${conversationId}/messages`,
    json('POST', { body, clientActionId }),
  );
  return parseMessage(data);
}

export async function markRead(conversationId: string, messageId: string): Promise<void> {
  await request(
    `/api/messaging/conversations/${conversationId}/read`,
    json('PATCH', { messageId }),
  );
}

export async function getUnreadCount(): Promise<number> {
  const data = object(await request('/api/messaging/unread-count'));
  return number(data.unreadCount, 'unreadCount');
}
