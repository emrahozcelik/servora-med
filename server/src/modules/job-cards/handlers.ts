import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { JobCardService } from './service.js';
import type { JobCardActor } from './types.js';
import { parseJobCardCreateInput } from './create-input.js';
import { parseMeetingDetailsPatch, parseMeetingJobCardId } from './meeting-details-input.js';
import { validation } from './validation.js';
import { parseJobCardBoardQuery, parseJobCardListQuery } from './workspace-query.js';

type Params = { id: string; itemId?: string };

function actor(request: FastifyRequest): JobCardActor {
  const user = request.currentUser!;
  return { id: user.id, organizationId: user.organizationId, role: user.role };
}

function body(request: FastifyRequest, allowed: readonly string[]) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçerli bir istek gövdesi zorunludur.');
  }
  const value = request.body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AppError('VALIDATION_ERROR', 400, 'İstek desteklenmeyen alan içeriyor.');
  }
  return value;
}

function page(raw: unknown, defaultLimit: number) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('query');
  const value = raw as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (!['limit', 'offset'].includes(key) || Array.isArray(entry)) throw validation(key);
  }
  const integer = (field: 'limit' | 'offset', fallback: number, minimum: number, maximum?: number) => {
    const entry = value[field];
    if (entry === undefined) return fallback;
    if (typeof entry !== 'string' || !/^\d+$/.test(entry)) throw validation(field);
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed < minimum
      || (maximum !== undefined && parsed > maximum)) throw validation(field);
    return parsed;
  };
  return { limit: integer('limit', defaultLimit, 1, 100), offset: integer('offset', 0, 0) };
}

const PATCH_FIELDS = [
  'expectedVersion', 'title', 'description', 'customerId', 'contactId',
  'assignedTo', 'priority', 'dueDate', 'scheduledAt',
];
const DELIVERY_FIELDS = ['clientActionId', 'expectedVersion', 'productId', 'deliveryPurpose', 'deliveredAt', 'quantity', 'lotNo', 'serialNo', 'expiryDate', 'deliveryNote'];
const LIFECYCLE_FIELDS = ['clientActionId', 'expectedVersion'] as const;
const LIFECYCLE_NOTE_FIELDS = [...LIFECYCLE_FIELDS, 'note'] as const;

export function createJobCardHandlers(service: JobCardService) {
  return {
    create: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.create(actor(request), parseJobCardCreateInput(request.body))),
    list: async (request: FastifyRequest) =>
      service.list(actor(request), parseJobCardListQuery(request.query)),
    board: async (request: FastifyRequest) =>
      service.board(actor(request), parseJobCardBoardQuery(request.query)),
    detail: async (request: FastifyRequest<{ Params: Params }>) => service.detail(actor(request), request.params.id),
    meetingDetails: async (request: FastifyRequest<{ Params: Params }>) =>
      service.getMeetingDetails(actor(request), parseMeetingJobCardId(request.params.id)),
    patchMeetingDetails: async (request: FastifyRequest<{ Params: Params }>) =>
      service.patchMeetingDetails(
        actor(request),
        parseMeetingJobCardId(request.params.id),
        parseMeetingDetailsPatch(request.body),
      ),
    patch: async (request: FastifyRequest<{ Params: Params }>) =>
      service.patch(actor(request), request.params.id, body(request, PATCH_FIELDS) as never),
    listDeliveryItems: async (request: FastifyRequest<{ Params: Params }>) =>
      ({ items: await service.listDeliveryItems(actor(request), request.params.id) }),
    addDeliveryItem: async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) =>
      reply.code(201).send(await service.addDeliveryItem(actor(request), request.params.id, body(request, DELIVERY_FIELDS) as never)),
    patchDeliveryItem: async (request: FastifyRequest<{ Params: Params }>) =>
      service.patchDeliveryItem(actor(request), request.params.id, request.params.itemId!, body(request, DELIVERY_FIELDS.filter((field) => field !== 'clientActionId')) as never),
    removeDeliveryItem: async (request: FastifyRequest<{ Params: Params }>) =>
      service.removeDeliveryItem(actor(request), request.params.id, request.params.itemId!, body(request, ['expectedVersion']) as never),
    accept: async (request: FastifyRequest<{ Params: Params }>) =>
      service.acceptAssignment(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    start: async (request: FastifyRequest<{ Params: Params }>) =>
      service.start(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    submit: async (request: FastifyRequest<{ Params: Params }>) =>
      service.submitForApproval(actor(request), request.params.id, body(request, LIFECYCLE_NOTE_FIELDS) as never),
    approve: async (request: FastifyRequest<{ Params: Params }>) =>
      service.approve(actor(request), request.params.id, body(request, LIFECYCLE_NOTE_FIELDS) as never),
    requestRevision: async (request: FastifyRequest<{ Params: Params }>) =>
      service.requestRevision(actor(request), request.params.id, body(request, ['clientActionId', 'expectedVersion', 'revisionReason']) as never),
    withdrawFromApproval: async (request: FastifyRequest<{ Params: Params }>) =>
      service.withdrawFromApproval(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    resume: async (request: FastifyRequest<{ Params: Params }>) =>
      service.resume(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    cancel: async (request: FastifyRequest<{ Params: Params }>) =>
      service.cancel(actor(request), request.params.id, body(request, ['clientActionId', 'expectedVersion', 'cancelReason']) as never),
    activity: async (request: FastifyRequest<{ Params: Params }>) =>
      service.listActivity(actor(request), request.params.id, page(request.query, 50)),
    listNotes: async (request: FastifyRequest<{ Params: Params }>) =>
      service.listNotes(actor(request), request.params.id, page(request.query, 25)),
    addNote: async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) =>
      reply.code(201).send(await service.addNote(
        actor(request), request.params.id, body(request, ['clientActionId', 'note']) as never,
      )),
  };
}
