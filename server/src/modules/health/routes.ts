import type { FastifyPluginAsync } from 'fastify';

import { createHealthHandlers } from './handlers.js';
import type { BackupHealthReadinessPort, HealthReadinessPort } from './service.js';

export type HealthRoutesOptions = {
  readiness: HealthReadinessPort;
  releaseSha: string;
  backupReadiness?: BackupHealthReadinessPort;
};

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const handlers = createHealthHandlers(options.readiness, options.releaseSha, options.backupReadiness);
  app.get('/', handlers.getHealth);
  app.get('/backup', handlers.getBackupHealth);
};
