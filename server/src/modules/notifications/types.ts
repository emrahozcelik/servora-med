export type NotificationViewer = Readonly<{
  organizationId: string;
  userId: string;
}>;

export const NOTIFICATION_KINDS = [
  'job.assigned',
  'job.reassigned',
  'job.awaiting_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationRecord = Readonly<{
  id: string;
  organizationId: string;
  recipientUserId: string;
  sourceRealtimeEventId: bigint;
  kind: NotificationKind;
  entityType: 'job-card';
  entityId: string;
  createdAt: Date;
  readAt: Date | null;
}>;

export type NotificationCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type NotificationPage = Readonly<{
  items: readonly NotificationRecord[];
  nextCursor: NotificationCursor | null;
}>;

export type NotificationDraft = Readonly<{
  recipientUserId: string;
  kind: NotificationKind;
  entityType: 'job-card';
  entityId: string;
}>;

export type NotificationAppendInput = Readonly<{
  organizationId: string;
  sourceRealtimeEventId: bigint;
  createdAt: Date;
  drafts: readonly NotificationDraft[];
}>;
