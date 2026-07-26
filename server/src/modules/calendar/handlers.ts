import type { FastifyReply, FastifyRequest } from 'fastify';

import type { CalendarService } from './service.js';
import { parseCalendarQuery } from './query.js';
import {
  parseManualEventCancel,
  parseManualEventCreate,
  parseManualEventPatch,
} from './validation.js';
import { uuidString } from '../job-cards/validation.js';

type Params = { eventId: string };

export function createCalendarHandlers(service: CalendarService) {
  return {
    list: (request: FastifyRequest) =>
      service.list(request.currentUser!, parseCalendarQuery(request.query)),
    assignees: (request: FastifyRequest) =>
      service.assignees(request.currentUser!),
    detail: (request: FastifyRequest<{ Params: Params }>) =>
      service.detail(
        request.currentUser!,
        uuidString(request.params.eventId, 'eventId'),
      ),
    create: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(
        await service.create(
          request.currentUser!,
          parseManualEventCreate(request.body),
        ),
      ),
    patch: (request: FastifyRequest<{ Params: Params }>) =>
      service.patch(
        request.currentUser!,
        uuidString(request.params.eventId, 'eventId'),
        parseManualEventPatch(request.body),
      ),
    cancel: (request: FastifyRequest<{ Params: Params }>) =>
      service.cancel(
        request.currentUser!,
        uuidString(request.params.eventId, 'eventId'),
        parseManualEventCancel(request.body),
      ),
  };
}
