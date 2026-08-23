import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createBackupHandlers } from './handlers.js';
import type { BackupService, BackupStorageProbe } from './service.js';

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type BackupRoutesOptions = {
  service: BackupService;
  authenticate: Authenticate;
  storageProbe?: BackupStorageProbe;
};

// Backup administration is installation-sensitive infrastructure state and is
// intentionally ADMIN-only (BR0 platform contracts §2). Authorization is
// enforced in the service layer (requireAdmin), never by UI hiding alone.
export const backupRoutes: FastifyPluginAsync<BackupRoutesOptions> = async (app, options) => {
  const handlers = createBackupHandlers(options.service, options.storageProbe);
  const auth = { preHandler: options.authenticate };
  app.get('/backups', auth, handlers.list);
  app.get('/backups/:backupId', auth, handlers.get);
  app.get('/backup-overview', auth, handlers.getOverview);
  app.post('/backups', auth, handlers.create);
  app.get('/backup-policy', auth, handlers.getPolicy);
  app.put('/backup-policy', auth, handlers.updatePolicy);
  app.get('/backup-storage', auth, handlers.getStorage);
  // BR4: short synchronous connectivity/capability probe — never a backup
  // or reverify stream (those stay worker-owned).
  app.post('/backup-storage/test', auth, handlers.testStorage);
};
