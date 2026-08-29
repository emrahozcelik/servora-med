import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { dataManagementRoutes } from '../src/modules/data-management/routes.js';
import { DataManagementService } from '../src/modules/data-management/service.js';
import {
  PostgresDataManagementRepository,
  type DataManagementReadModel,
} from '../src/modules/data-management/repository.js';
import type { DataManagementSummary } from '../src/modules/data-management/types.js';

const summary: DataManagementSummary = {
  customers: { total: 2, prospect: 1, active: 1, inactive: 0 },
  contacts: { total: 1, active: 1, inactive: 0 },
  products: { total: 3, active: 2, inactive: 1 },
  staff: { total: 1, active: 1, inactive: 0 },
  demoDataset: { total: 1, active: 1, purged: 0 },
};

function actor(role: SafeUser['role'], organizationId = 'org-1'): SafeUser {
  return {
    id: `${role.toLowerCase()}-1`, organizationId, name: role,
    email: `${role.toLowerCase()}@example.com`, role,
    mustChangePassword: false, isActive: true, version: 1,
  };
}

class MemoryReadModel implements DataManagementReadModel {
  organizations: string[] = [];

  async getSummary(organizationId: string) {
    this.organizations.push(organizationId);
    return summary;
  }
}

const apps: Awaited<ReturnType<typeof Fastify>>[] = [];

async function createApp(currentUser: SafeUser, repository = new MemoryReadModel()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = currentUser;
  };
  await app.register(dataManagementRoutes, {
    prefix: '/api/admin',
    service: new DataManagementService(repository),
    authenticate,
  });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Data Management summary HTTP route', () => {
  it('returns the bounded summary to Admin without exposing mutation controls', async () => {
    const { app, repository } = await createApp(actor('ADMIN'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/data-management/summary',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(summary);
    expect(repository.organizations).toEqual(['org-1']);
  });

  it('uses one bounded organization-scoped aggregate query for the summary', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return {
          rows: [{
            customer_total: '2', customer_prospect: '1', customer_active: '1', customer_inactive: '0',
            contact_total: '1', contact_active: '1', contact_inactive: '0',
            product_total: '3', product_active: '2', product_inactive: '1',
            staff_total: '1', staff_active: '1', staff_inactive: '0',
            demo_dataset_total: '1', demo_dataset_active: '1', demo_dataset_purged: '0',
          }],
        };
      },
    };

    const result = await new PostgresDataManagementRepository(pool).getSummary('org-a');

    expect(result).toEqual(summary);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(['org-a']);
    expect(calls[0]?.text).toMatch(/WITH customer_counts AS/);
    expect(calls[0]?.text).toMatch(/data_class\s*=\s*'BUSINESS'/);
    expect(calls[0]?.text).toMatch(/contacts[\s\S]*JOIN customers/);
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it.each(['MANAGER', 'STAFF'] as const)('forbids %s from the summary route', async (role) => {
    const { app, repository } = await createApp(actor(role));

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/data-management/summary',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.organizations).toEqual([]);
  });
});
