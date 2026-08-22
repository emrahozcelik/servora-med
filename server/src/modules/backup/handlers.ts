import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { BackupService } from './service.js';
import type { BackupCursor } from './types.js';

const LIST_FIELDS = ['limit', 'cursor'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validation(message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message);
}

function bodyOf(request: FastifyRequest) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    validation('Geçerli bir istek gövdesi gönderin.');
  }
  return request.body as Record<string, unknown>;
}

function exactFields(body: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
}

function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validation('Geçerli sorgu parametreleri gönderin.');
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown) {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) validation('limit geçersizdir.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) validation('limit geçersizdir.');
  return parsed;
}

function decodeCursor(value: unknown): BackupCursor | null {
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

function encodeCursor(cursor: BackupCursor | null) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(), id: cursor.id,
  })).toString('base64url');
}

function listQuery(request: FastifyRequest) {
  const value = record(request.query);
  const unknown = Object.keys(value).find((key) => !LIST_FIELDS.includes(key as typeof LIST_FIELDS[number]));
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
  return { limit: integer(value.limit), cursor: decodeCursor(value.cursor) };
}

function backupId(request: FastifyRequest) {
  const value = (request.params as { backupId?: unknown }).backupId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AppError('BACKUP_NOT_FOUND', 404, 'Yedek kaydı bulunamadı.');
  }
  return value;
}

function booleanField(value: unknown, field: string) {
  if (typeof value !== 'boolean') validation(`${field} geçersizdir.`);
  return value;
}

function integerField(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) validation(`${field} geçersizdir.`);
  return value;
}

function stringField(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) validation(`${field} geçersizdir.`);
  return value.trim();
}

function scopeField(value: unknown) {
  if (value !== 'DATABASE' && value !== 'FULL_DATA') validation('defaultScope geçersizdir.');
  return value;
}

export function createBackupHandlers(service: BackupService) {
  return {
    list: async (request: FastifyRequest) => {
      const response = await service.listRuns(request.currentUser!, listQuery(request));
      return { ...response, nextCursor: encodeCursor(response.nextCursor) };
    },
    get: (request: FastifyRequest) => service.getRun(request.currentUser!, backupId(request)),
    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = bodyOf(request);
      exactFields(body, ['clientActionId', 'scope']);
      const created = await service.requestManualBackup(request.currentUser!, {
        clientActionId: body.clientActionId,
        scope: body.scope,
      });
      return reply.code(202).send(created);
    },
    getPolicy: (request: FastifyRequest) => service.getPolicy(request.currentUser!),
    updatePolicy: async (request: FastifyRequest) => {
      const body = bodyOf(request);
      exactFields(body, [
        'enabled', 'scheduleTimeLocal', 'timezone',
        'dailyRetention', 'weeklyRetention', 'monthlyRetention', 'defaultScope',
      ]);
      return service.updatePolicy(request.currentUser!, {
        enabled: booleanField(body.enabled, 'enabled'),
        scheduleTimeLocal: stringField(body.scheduleTimeLocal, 'scheduleTimeLocal'),
        timezone: stringField(body.timezone, 'timezone'),
        dailyRetention: integerField(body.dailyRetention, 'dailyRetention'),
        weeklyRetention: integerField(body.weeklyRetention, 'weeklyRetention'),
        monthlyRetention: integerField(body.monthlyRetention, 'monthlyRetention'),
        defaultScope: scopeField(body.defaultScope),
      });
    },
    getStorage: (request: FastifyRequest) => service.getStorageState(request.currentUser!),
  };
}
