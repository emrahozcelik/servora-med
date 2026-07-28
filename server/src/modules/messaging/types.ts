export type ConversationContextType = 'GENERAL' | 'JOB';

export function isValidContextType(value: string): value is ConversationContextType {
  return value === 'GENERAL' || value === 'JOB';
}

export type ConversationRecord = Readonly<{
  id: string;
  organizationId: string;
  directKey: string;
  contextType: ConversationContextType;
  jobId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ConversationParticipantRecord = Readonly<{
  conversationId: string;
  userId: string;
  organizationId: string;
  lastReadMessageId: string | null;
  createdAt: Date;
}>;

export type MessageRecord = Readonly<{
  id: string;
  conversationId: string;
  organizationId: string;
  senderUserId: string;
  clientActionId: string;
  body: string;
  createdAt: Date;
}>;

export type MessageCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type MessagePage = Readonly<{
  items: readonly MessageRecord[];
  nextCursor: MessageCursor | null;
}>;

export type ConversationListCursor = Readonly<{
  updatedAt: Date;
  id: string;
}>;

export type ConversationListItem = Readonly<{
  id: string;
  directKey: string;
  contextType: ConversationContextType;
  jobId: string | null;
  jobTitle: string | null;
  participantName: string;
  participantId: string;
  participantIsActive: boolean;
  unreadCount: number;
  lastActivityAt: string;
  updatedAt: string;
}>;

export type ConversationListPage = Readonly<{
  items: readonly ConversationListItem[];
  nextCursor: ConversationListCursor | null;
}>;

export type RecipientListItem = Readonly<{
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}>;

export type DirectKey = string;

export type MessagingActivityAction = 'CONVERSATION_CREATED' | 'MESSAGE_SENT' | 'READ_CURSOR_UPDATED';

export type MessagingActivityRecord = Readonly<{
  id: string;
  organizationId: string;
  conversationId: string;
  actorUserId: string;
  action: MessagingActivityAction;
  clientActionId: string;
  createdAt: Date;
}>;

export type MessagingNotificationInput = Readonly<{
  organizationId: string;
  recipientUserId: string;
  kind: 'message.received';
  entityType: 'conversation';
  entityId: string;
}>;
