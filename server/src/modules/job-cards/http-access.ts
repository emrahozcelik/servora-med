import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { JobCardService } from './service.js';
import type { JobCardActor } from './types.js';

export function jobCardActor(request: FastifyRequest): JobCardActor {
  const user = request.currentUser!;
  return { id: user.id, organizationId: user.organizationId, role: user.role };
}

export function saleCapability(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as Record<string, unknown>).includeSaleCapability === 'true';
}

export function securedJobCardRoutes(
  authenticate: preHandlerHookHandler,
  service: Pick<JobCardService, 'assertSaleCapability'>,
) {
  const legacySaleGuard: preHandlerHookHandler = async (request) => {
    const id = (request.params as { id?: string }).id;
    if (!id) return;
    await service.assertSaleCapability(request.currentUser!, id, saleCapability(request.query));
  };
  return { preHandler: [authenticate, legacySaleGuard] };
}
