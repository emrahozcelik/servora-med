import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { demoDatasetRoutes } from '../src/modules/demo-data/routes.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type {
  DemoDatasetPreviewData,
  DemoDatasetRepository,
} from '../src/modules/demo-data/types.js';

const dataset: DemoDatasetPreviewData = {
  dataset: {
    id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', datasetKey: 'demo', seedVersion: 'r1',
    status: 'ACTIVE', createdAt: new Date('2026-08-24T10:00:00.000Z'), createdBy: 'admin-1', purgedAt: null,
  },
  organizationName: 'Organization One',
  affectedCounts: {
    users: 0, staffProfiles: 0, customers: 0, contacts: 0, products: 0, jobCards: 0,
    deliveryItems: 0, notes: 0, confidentialNotes: 0, activities: 0, followUps: 0,
    calendarEvents: 0, conversations: 0, messages: 0, notifications: 0, reminders: 0, realtimeEvents: 0,
  },
  blockers: [],
  planKeys: [],
};

class MemoryRepository implements DemoDatasetRepository {
  async listDatasets() { return [dataset.dataset]; }
  async findDataset(organizationId: string) {
    return organizationId === dataset.dataset.organizationId ? dataset.dataset : null;
  }
  async getPreviewData(organizationId: string) {
    return organizationId === dataset.dataset.organizationId ? dataset : null;
  }
}

function actor(role: SafeUser['role']): SafeUser {
  return {
    id: `${role.toLowerCase()}-1`, organizationId: 'org-1', name: role,
    email: `${role.toLowerCase()}@example.com`, role,
    mustChangePassword: false, isActive: true, version: 1,
  };
}

const apps: FastifyInstance[] = [];

async function createApp(currentUser: SafeUser) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = currentUser;
  };
  await app.register(demoDatasetRoutes, {
    prefix: '/api/admin',
    service: new DemoDatasetService(new MemoryRepository()),
    authenticate,
  });
  apps.push(app);
  return app;
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Demo data HTTP routes', () => {
  it.each(['ADMIN', 'MANAGER', 'STAFF'] as const)('applies service RBAC for %s', async (role) => {
    const app = await createApp(actor(role));
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/demo-datasets/11111111-1111-4111-8111-111111111111/preview',
    });

    expect(response.statusCode).toBe(role === 'ADMIN' ? 200 : 403);
    if (role === 'ADMIN') {
      expect(response.json()).toMatchObject({
        dataset: { organizationId: 'org-1' },
        safeToPurge: true,
      });
      const clientOrganization = await app.inject({
        method: 'GET',
        url: '/api/admin/demo-datasets/11111111-1111-4111-8111-111111111111/preview?organizationId=other-org',
      });
      expect(clientOrganization.statusCode).toBe(400);
    }
  });
});
