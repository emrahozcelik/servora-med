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
  const onRequest=app.rateLimit({max:60,timeWindow:60_000,groupId:'public-health'});
  app.addHook('preClose',async()=>{await options.backupReadiness?.close?.();});
  app.get('/', {onRequest}, handlers.getHealth);
  app.get('/backup', {onRequest}, handlers.getBackupHealth);
};
