import type { FastifyRequest } from 'fastify';

import type { DataManagementService } from './service.js';

export function createDataManagementHandlers(service: DataManagementService) {
  return {
    getSummary: (request: FastifyRequest) => service.getSummary(request.currentUser!),
  };
}
