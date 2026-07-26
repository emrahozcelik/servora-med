import type { FastifyRequest } from 'fastify';

import type { OverviewService } from './service.js';
import { parseOverviewQuery } from './query.js';

export function createOverviewHandlers(service: OverviewService) {
  return {
    get: (request: FastifyRequest) => service.getOverview(
      request.currentUser!,
      parseOverviewQuery(request.query),
    ),
  };
}
