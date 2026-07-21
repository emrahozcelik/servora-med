import {
  ApiError,
  nullableString,
  number,
  object,
  request,
  string,
} from './api';

export const NOTIFICATION_KINDS = [
  'job.assigned',
  'job.reassigned',
  'job.awaiting_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type InAppNotification = Readonly<{
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity: Readonly<{ type: 'job-card'; id: string }>;
  createdAt: string;
  readAt: string | null;
}>;
export type NotificationPage = Readonly<{
  items: readonly InAppNotification[];
  nextCursor: string | null;
}>;

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key))) invalid('bildirim');
}

function instant(value: unknown, field: string) {
  const parsed = string(value, field);
  const date = new Date(parsed);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) invalid(field);
  return parsed;
}

function parseNotification(value: unknown): InAppNotification {
  const notification = object(value);
  exact(notification, ['id', 'kind', 'title', 'body', 'entity', 'createdAt', 'readAt']);
  const kind = string(notification.kind, 'kind');
  if (!NOTIFICATION_KINDS.includes(kind as NotificationKind)) invalid('kind');
  const entity = object(notification.entity);
  exact(entity, ['type', 'id']);
  if (entity.type !== 'job-card') invalid('entity.type');
  return {
    id: string(notification.id, 'id'),
    kind: kind as NotificationKind,
    title: string(notification.title, 'title'),
    body: string(notification.body, 'body'),
    entity: { type: 'job-card', id: string(entity.id, 'entity.id') },
    createdAt: instant(notification.createdAt, 'createdAt'),
    readAt: notification.readAt === null ? null : instant(notification.readAt, 'readAt'),
  };
}

export function parseNotificationPage(value: unknown): NotificationPage {
  const page = object(value);
  exact(page, ['items', 'nextCursor']);
  if (!Array.isArray(page.items)) invalid('items');
  const nextCursor = nullableString(page.nextCursor, 'nextCursor');
  return { items: page.items.map(parseNotification), nextCursor };
}

export async function getUnreadNotificationCount() {
  const response = object(await request('/api/notifications/unread-count'));
  exact(response, ['unreadCount']);
  const unreadCount = number(response.unreadCount, 'unreadCount');
  if (!Number.isInteger(unreadCount) || unreadCount < 0) invalid('unreadCount');
  return unreadCount;
}

export async function listNotifications(input: Readonly<{ limit?: number; cursor?: string | null }> = {}) {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor !== undefined && input.cursor !== null) query.set('cursor', input.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return parseNotificationPage(await request(`/api/notifications${suffix}`));
}

export async function markNotificationRead(notificationId: string) {
  return parseNotification(await request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'PATCH',
  }));
}
