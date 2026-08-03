import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { StaffConfidentialNotesService } from './service.js';
import { boundedTrimmedString } from './service.js';

function bodyOf(request: FastifyRequest) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçerli bir istek gövdesi gönderin.');
  }
  return request.body as Record<string, unknown>;
}

function exactFields(body: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError('VALIDATION_ERROR', 400, `Bilinmeyen alan: ${unknown}.`);
}

function staffUserId(request: FastifyRequest) {
  return String((request.params as { userId?: unknown }).userId ?? '');
}

function pageQuery(request: FastifyRequest) {
  const value = request.query;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçerli sorgu parametreleri gönderin.');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !['limit', 'offset'].includes(key));
  if (unknown) throw new AppError('VALIDATION_ERROR', 400, `Bilinmeyen alan: ${unknown}.`);
  const integer = (raw: unknown, field: 'limit' | 'offset', fallback: number, minimum: number, maximum?: number) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw new AppError('VALIDATION_ERROR', 400, `${field} geçersizdir.`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
      throw new AppError('VALIDATION_ERROR', 400, `${field} geçersizdir.`);
    }
    return parsed;
  };
  const limit = integer(record.limit, 'limit', 20, 1, 100);
  return { limit, offset: integer(record.offset, 'offset', 0, 0) };
}

export function createStaffConfidentialNotesHandlers(service: StaffConfidentialNotesService) {
  return {
    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = bodyOf(request);
      exactFields(body, ['clientActionId', 'body']);
      return reply.code(201).send(await service.createNote(
        request.currentUser!,
        staffUserId(request),
        {
          clientActionId: boundedTrimmedString(body.clientActionId, 'clientActionId', 1, 255),
          body: boundedTrimmedString(body.body, 'body', 1, 4_000),
        },
      ));
    },
    list: async (request: FastifyRequest) =>
      service.listNotes(request.currentUser!, staffUserId(request), pageQuery(request)),
  };
}
