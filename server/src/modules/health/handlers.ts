import type { FastifyReply, FastifyRequest } from 'fastify';

import type { BackupHealthReadinessPort, HealthReadinessPort } from './service.js';
import { getPublicHealthStatus } from './service.js';

export function createHealthHandlers(
  readiness: HealthReadinessPort,
  releaseSha: string,
  backupReadiness?: BackupHealthReadinessPort,
) {
  return {
    async getHealth(_request: FastifyRequest, reply: FastifyReply) {
      // Health admission is live state; intermediaries must not cache old verdicts.
      reply.header('Cache-Control', 'no-store');
      const result = await readiness.check();
      const statusCode = result === 'ok' ? 200 : 503;
      const body = getPublicHealthStatus(result, releaseSha);
      if (backupReadiness) {
        return reply.code(statusCode).send({
          ...body,
          backup: await backupReadiness.check(),
        });
      }
      return reply.code(statusCode).send(body);
    },
    async getBackupHealth(_request: FastifyRequest, reply: FastifyReply) {
      reply.header('Cache-Control', 'no-store');
      if (!backupReadiness) {
        return reply.code(404).send({ status: 'unavailable' });
      }
      const result = await backupReadiness.check();
      return reply.code(result.status === 'ok' ? 200 : 503).send(result);
    },
  };
}
