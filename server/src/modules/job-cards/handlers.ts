import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { JobCardService } from './service.js';
import type { JobCardActor } from './types.js';
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

const CREATE_FIELDS = ['clientActionId', 'type', 'title', 'description', 'customerId', 'contactId', 'assignedTo', 'priority', 'dueDate'];
const PATCH_FIELDS = ['expectedVersion', 'title', 'description', 'customerId', 'contactId', 'assignedTo', 'priority', 'dueDate'];
const DELIVERY_FIELDS = ['clientActionId', 'expectedVersion', 'productId', 'deliveryPurpose', 'deliveredAt', 'quantity', 'lotNo', 'serialNo', 'expiryDate', 'deliveryNote'];
const LIFECYCLE_FIELDS = ['clientActionId', 'expectedVersion'] as const;
const LIFECYCLE_NOTE_FIELDS = [...LIFECYCLE_FIELDS, 'note'] as const;

export function createJobCardHandlers(service: JobCardService) {
  return {
    create: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.create(actor(request), body(request, CREATE_FIELDS) as never)),
    list: async (request: FastifyRequest) =>
      service.list(actor(request), parseJobCardListQuery(request.query)),
    board: async (request: FastifyRequest) =>
      service.board(actor(request), parseJobCardBoardQuery(request.query)),
    detail: async (request: FastifyRequest<{ Params: Params }>) => service.detail(actor(request), request.params.id),
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
    plan: async (request: FastifyRequest<{ Params: Params }>) =>
      service.plan(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    start: async (request: FastifyRequest<{ Params: Params }>) =>
      service.start(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    submit: async (request: FastifyRequest<{ Params: Params }>) =>
      service.submitForApproval(actor(request), request.params.id, body(request, LIFECYCLE_NOTE_FIELDS) as never),
    approve: async (request: FastifyRequest<{ Params: Params }>) =>
      service.approve(actor(request), request.params.id, body(request, LIFECYCLE_NOTE_FIELDS) as never),
    requestRevision: async (request: FastifyRequest<{ Params: Params }>) =>
      service.requestRevision(actor(request), request.params.id, body(request, ['clientActionId', 'expectedVersion', 'revisionReason']) as never),
    resume: async (request: FastifyRequest<{ Params: Params }>) =>
      service.resume(actor(request), request.params.id, body(request, LIFECYCLE_FIELDS) as never),
    cancel: async (request: FastifyRequest<{ Params: Params }>) =>
      service.cancel(actor(request), request.params.id, body(request, ['clientActionId', 'expectedVersion', 'cancelReason']) as never),
    activity: async (request: FastifyRequest<{ Params: Params }>) =>
      ({ items: await service.listActivity(actor(request), request.params.id) }),
  };
}
