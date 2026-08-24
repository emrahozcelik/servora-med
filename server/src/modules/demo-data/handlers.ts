import type { FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { DemoDatasetService } from './service.js';
import type { DemoDatasetPurgeRequest } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validation(message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message);
}

function exactQuery(request: FastifyRequest) {
  const query = request.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) validation('Geçerli sorgu parametreleri gönderin.');
  const unknown = Object.keys(query as Record<string, unknown>)[0];
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
}

function datasetId(request: FastifyRequest) {
  const value = (request.params as { datasetId?: unknown }).datasetId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new AppError('DEMO_DATASET_NOT_FOUND', 404, 'Demo veri kümesi bulunamadı.');
  }
  return value;
}

function purgeBody(request: FastifyRequest): DemoDatasetPurgeRequest {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    validation('Geçerli bir purge isteği gövdesi gönderin.');
  }
  const body = request.body as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !['clientActionId', 'planHash'].includes(key));
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
  if (typeof body.clientActionId !== 'string' || !UUID.test(body.clientActionId)) {
    validation('clientActionId UUID olmalıdır.');
  }
  if (typeof body.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.planHash)) {
    validation('planHash geçerli bir SHA-256 değeri olmalıdır.');
  }
  return { clientActionId: body.clientActionId, planHash: body.planHash };
}

export function createDemoDatasetHandlers(service: DemoDatasetService) {
  return {
    list: (request: FastifyRequest) => {
      exactQuery(request);
      return service.list(request.currentUser!).then((items) => ({ items }));
    },
    inspect: (request: FastifyRequest) => {
      exactQuery(request);
      return service.inspect(request.currentUser!, datasetId(request));
    },
    preview: (request: FastifyRequest) => {
      exactQuery(request);
      return service.preview(request.currentUser!, datasetId(request));
    },
    purge: (request: FastifyRequest) => {
      exactQuery(request);
      return service.purge(request.currentUser!, datasetId(request), purgeBody(request));
    },
  };
}
