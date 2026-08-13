export type ConversationContextType = 'GENERAL' | 'JOB' | 'CUSTOMER';

export function isValidContextType(value: string): value is ConversationContextType {
  return value === 'GENERAL' || value === 'JOB' || value === 'CUSTOMER';
}

export type ConversationRecord = Readonly<{
  id: string;
  organizationId: string;
  directKey: string;
  contextType: ConversationContextType;
  jobId: string | null;
  customerId: string | null;
  title: string | null;
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

export type ConversationParticipantSummary = Readonly<{
  userId: string;
  name: string;
  isActive: boolean;
}>;

export type MessageRecord = Readonly<{
  id: string;
  conversationId: string;
  organizationId: string;
  senderUserId: string;
  senderName: string;
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
  customerId: string | null;
  customerName: string | null;
  title: string | null;
  participantName: string;
  participantId: string;
  participantIsActive: boolean;
  participants: readonly ConversationParticipantSummary[];
  unreadCount: number;
  lastActivityAt: string;
  updatedAt: string;
}>;

export type CreateConversationInput = Readonly<{
  /** Legacy single-recipient field. Use participantUserIds for the new contract. */
  recipientUserId?: string | null;
  /** New initial multi-participant field. Explicit participants; the creator is always added automatically. */
  participantUserIds?: readonly string[] | null;
  contextType: ConversationContextType;
  jobId?: string | null;
  customerId?: string | null;
  title?: string | null;
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

export type MessagingActivityAction = 'CONVERSATION_CREATED' | 'MESSAGE_SENT' | 'READ_CURSOR_UPDATED' | 'PARTICIPANTS_CHANGED';

export type JobAssigneeSyncInput = Readonly<{
  clientActionId: string;
  assignmentTransitionId: string;
}>;

export type JobAssigneeSyncResult = Readonly<{
  conversationId: string;
  synced: true;
  changed: boolean;
}>;

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

export interface MessagingReadPort {
  getUnreadCount(organizationId: string, userId: string, role: string): Promise<number>;
}
