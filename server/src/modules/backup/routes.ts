import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createBackupHandlers } from './handlers.js';
import type { BackupService } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type BackupRoutesOptions = {
  service: BackupService;
  authenticate: Authenticate;
};

// Backup administration is installation-sensitive infrastructure state and is
// intentionally ADMIN-only (BR0 platform contracts §2). Authorization is
// enforced in the service layer (requireAdmin), never by UI hiding alone.
export const backupRoutes: FastifyPluginAsync<BackupRoutesOptions> = async (app, options) => {
  const handlers = createBackupHandlers(options.service);
  const auth = { preHandler: options.authenticate };
  app.get('/backups', auth, handlers.list);
  app.get('/backups/:backupId', auth, handlers.get);
  app.post('/backups', auth, handlers.create);
  app.get('/backup-policy', auth, handlers.getPolicy);
  app.put('/backup-policy', auth, handlers.updatePolicy);
  app.get('/backup-storage', auth, handlers.getStorage);
};
