import type { FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { DemoDatasetService } from './service.js';

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
  };
}
