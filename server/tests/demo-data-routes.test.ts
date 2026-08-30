import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { demoDatasetRoutes } from '../src/modules/demo-data/routes.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type {
  DemoDatasetCreateResponse,
  DemoDatasetPurgeResponse,
  DemoDatasetPreviewData,
  DemoDatasetRepository,
} from '../src/modules/demo-data/types.js';

const dataset: DemoDatasetPreviewData = {
  dataset: {
    id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', datasetKey: 'demo', seedVersion: 'r1',
    status: 'ACTIVE', createdAt: new Date('2026-08-24T10:00:00.000Z'), createdBy: 'admin-1',
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
  private createdKey: string | null = null;
  async listDatasets() { return [dataset.dataset]; }
  async findDataset(organizationId: string) {
    return organizationId === dataset.dataset.organizationId ? dataset.dataset : null;
  }
  async getPreviewData(organizationId: string) {
    return organizationId === dataset.dataset.organizationId ? dataset : null;
  }
  async purge(_organizationId: string, _datasetId: string, _actorUserId: string, _request: { clientActionId: string; planHash: string }): Promise<DemoDatasetPurgeResponse> {
    return {
      operationId: '22222222-2222-4222-8222-222222222222',
      status: 'COMPLETED',
      datasetId: dataset.dataset.id,
      datasetKey: dataset.dataset.datasetKey,
      seedVersion: dataset.dataset.seedVersion,
      planHash: _request.planHash,
      affectedCounts: dataset.affectedCounts,
      retained: { auditActorDetaches: 0 },
      completedAt: '2026-08-24T11:00:00.000Z',
    };
  }
  create(_organizationId: string, _actorUserId: string, request: { clientActionId: string }): Promise<DemoDatasetCreateResponse> {
    const replay = request.clientActionId === this.createdKey;
    this.createdKey = request.clientActionId;
    return Promise.resolve({
      dataset: {
        id: dataset.dataset.id,
        organizationId: dataset.dataset.organizationId,
        datasetKey: dataset.dataset.datasetKey,
        seedVersion: dataset.dataset.seedVersion,
        status: 'ACTIVE',
        createdAt: dataset.dataset.createdAt.toISOString(),
        createdBy: dataset.dataset.createdBy,
      },
      counts: { users: 3, customers: 5, products: 5, jobCards: 8 },
      replayed: replay,
    });
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

async function createApp(currentUser: SafeUser, creationEnabled = false) {
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
    service: new DemoDatasetService(new MemoryRepository(), () => creationEnabled),
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

  it('accepts the exact Admin purge contract and rejects malformed input', async () => {
    const app = await createApp(actor('ADMIN'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets/11111111-1111-4111-8111-111111111111/purge',
      payload: {
        clientActionId: '33333333-3333-4333-8333-333333333333',
        planHash: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'COMPLETED',
      datasetId: dataset.dataset.id,
      planHash: 'a'.repeat(64),
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets/11111111-1111-4111-8111-111111111111/purge',
      payload: { clientActionId: 'not-a-uuid', planHash: 'a'.repeat(64) },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('VALIDATION_ERROR');
  });

  it('creates a managed demo dataset as Admin when the creation flag is enabled', async () => {
    const app = await createApp(actor('ADMIN'), true);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: '11111111-1111-4111-8111-111111111111' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dataset: { status: 'ACTIVE', organizationId: 'org-1' },
      counts: { users: 3, customers: 5, products: 5, jobCards: 8 },
      replayed: false,
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
  });

  it('applies RBAC and the creation flag to the create route', async () => {
    const forStaff = await createApp(actor('STAFF'), true);
    const staffResponse = await forStaff.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(staffResponse.statusCode).toBe(403);
    expect(staffResponse.json().code).toBe('FORBIDDEN');

    const flagDisabled = await createApp(actor('ADMIN'), false);
    const disabled = await flagDisabled.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(disabled.statusCode).toBe(404);
  });

  it('rejects a malformed create body', async () => {
    const app = await createApp(actor('ADMIN'), true);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('VALIDATION_ERROR');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: 'not-a-uuid' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('VALIDATION_ERROR');

    const extra = await app.inject({
      method: 'POST',
      url: '/api/admin/demo-datasets',
      payload: { clientActionId: '11111111-1111-4111-8111-111111111111', extra: 1 },
    });
    expect(extra.statusCode).toBe(400);
  });
});
