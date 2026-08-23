import type { FastifyReply, FastifyRequest } from 'fastify';

import type { BackupHealthReadinessPort, HealthReadinessPort } from './service.js';
import { getPublicHealthStatus } from './service.js';

export function createHealthHandlers(
  readiness: HealthReadinessPort,
  backupReadiness?: BackupHealthReadinessPort,
) {
  return {
    async getHealth(_request: FastifyRequest, reply: FastifyReply) {
      const result = await readiness.check();
      const statusCode = result === 'ok' ? 200 : 503;
      const body = getPublicHealthStatus(result);
      if (backupReadiness) {
        return reply.code(statusCode).send({
          ...body,
          backup: await backupReadiness.check(),
        });
      }
      return reply.code(statusCode).send(body);
    },
    async getBackupHealth(_request: FastifyRequest, reply: FastifyReply) {
      if (!backupReadiness) {
        return reply.code(404).send({ status: 'unavailable' });
      }
      const result = await backupReadiness.check();
      return reply.code(result.status === 'ok' ? 200 : 503).send(result);
    },
  };
}
