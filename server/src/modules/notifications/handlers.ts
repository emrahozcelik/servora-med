import type { FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { NotificationService } from './service.js';
import type { NotificationCursor } from './types.js';

const LIST_FIELDS = ['limit', 'cursor'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validation(message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message);
}

function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validation('Geçerli sorgu parametreleri gönderin.');
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>) {
  const unknown = Object.keys(value).find((key) => !LIST_FIELDS.includes(key as typeof LIST_FIELDS[number]));
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
}

function integer(value: unknown) {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) validation('limit geçersizdir.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) validation('limit geçersizdir.');
  return parsed;
}

function decodeCursor(value: unknown): NotificationCursor | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) validation('cursor geçersizdir.');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) validation('cursor geçersizdir.');
    const cursor = decoded as Record<string, unknown>;
    if (Object.keys(cursor).length !== 2 || typeof cursor.createdAt !== 'string'
      || typeof cursor.id !== 'string' || !UUID.test(cursor.id)) validation('cursor geçersizdir.');
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== cursor.createdAt) {
      validation('cursor geçersizdir.');
    }
    return { createdAt, id: cursor.id };
  } catch (error) {
    if (error instanceof AppError) throw error;
    validation('cursor geçersizdir.');
  }
}

function encodeCursor(cursor: NotificationCursor | null) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(), id: cursor.id,
  })).toString('base64url');
}

function listQuery(request: FastifyRequest) {
  const value = record(request.query);
  exact(value);
  return { limit: integer(value.limit), cursor: decodeCursor(value.cursor) };
}

function notificationId(request: FastifyRequest) {
  const value = (request.params as { notificationId?: unknown }).notificationId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AppError('NOTIFICATION_NOT_FOUND', 404, 'Bildirim bulunamadı.');
  }
  return value;
}

function viewer(request: FastifyRequest) {
  const user = request.currentUser!;
  return { organizationId: user.organizationId, userId: user.id };
}

export function createNotificationHandlers(service: NotificationService) {
  return {
    unreadCount: (request: FastifyRequest) => service.unreadCount(viewer(request)),
    list: async (request: FastifyRequest) => {
      const response = await service.list(viewer(request), listQuery(request));
      return { ...response, nextCursor: encodeCursor(response.nextCursor) };
    },
    markRead: (request: FastifyRequest) => service.markRead(viewer(request), notificationId(request)),
  };
}
