import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { toErrorResponse } from '../src/errors/index.js';
import { PostgresCustomerAssignmentCleanup } from '../src/modules/crm/people-adapter.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';
import { peopleRoutes } from '../src/modules/people/routes.js';
import { PeopleService } from '../src/modules/people/service.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('Demo and People integration PostgreSQL contract', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema: string;
  let app: FastifyInstance;
  let admin: SafeUser;
  let demo: DemoDatasetService;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
    schema = `dpr_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });

    const organizationId = (await pool.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`Demo People integration ${randomUUID()}`],
    )).rows[0]!.id;
    const adminId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Integration Admin', $2, 'synthetic-test-hash', 'ADMIN')
       RETURNING id`,
      [organizationId, `admin-${randomUUID()}@integration.test`],
    )).rows[0]!.id;
    admin = {
      id: adminId,
      organizationId,
      name: 'Integration Admin',
      email: 'integration-admin@test.invalid',
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    };

    demo = new DemoDatasetService(new PostgresDemoDatasetRepository(pool), () => true);
    const peopleRepository = new PostgresPeopleRepository(
      pool,
      { validatePassword: () => undefined, hashPassword: async () => 'synthetic-test-hash' },
      { revokeAllSessions: async () => undefined },
      new PostgresCustomerAssignmentCleanup(),
    );
    const people = new PeopleService(
      peopleRepository,
      { validatePassword: () => undefined, hashPassword: async () => 'synthetic-test-hash' },
      new PostgresReportsRepository(pool),
      () => new Date('2026-08-30T09:00:00.000Z'),
    );
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const result = toErrorResponse(error);
      reply.code(result.statusCode).send(result.body);
    });
    const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
      request.currentUser = admin;
    };
    await app.register(peopleRoutes, {
      prefix: '/api',
      service: people,
      authenticate,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('keeps the People endpoint available across Demo create, purge, and recreate', async () => {
    const beforeDemo = await app.inject({ method: 'GET', url: '/api/staff?status=active' });
    expect(beforeDemo.statusCode).toBe(200);
    expect(beforeDemo.json()).toEqual([]);

    const first = await demo.create(admin, { clientActionId: randomUUID() });
    expect(first.dataset.status).toBe('ACTIVE');
    expect(first.counts.users).toBe(3);

    const profileComposition = await pool.query<{ role: string; count: number }>(
      `SELECT u.role, COUNT(*)::int AS count
       FROM staff_profiles sp
       JOIN users u ON u.id = sp.user_id AND u.organization_id = sp.organization_id
       WHERE u.organization_id = $1 AND u.data_class = 'DEMO'
       GROUP BY u.role ORDER BY u.role`,
      [admin.organizationId],
    );
    expect(profileComposition.rows).toEqual([
      { role: 'MANAGER', count: 1 },
      { role: 'STAFF', count: 2 },
    ]);

    const afterCreate = await app.inject({ method: 'GET', url: '/api/staff?status=active' });
    expect(afterCreate.statusCode).toBe(200);
    expect(afterCreate.json()).toHaveLength(2);
    expect(afterCreate.json().every((profile: { user: { role: string } }) => profile.user.role === 'STAFF')).toBe(true);

    const demoManager = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM users
       WHERE organization_id = $1 AND data_class = 'DEMO' AND role = 'MANAGER'`,
      [admin.organizationId],
    );
    const managerProfile = await app.inject({
      method: 'GET',
      url: `/api/staff/${demoManager.rows[0]!.id}`,
    });
    expect(managerProfile.statusCode).toBe(404);

    const preview = await demo.preview(admin, first.dataset.id);
    expect(preview.safeToPurge).toBe(true);
    await expect(demo.purge(admin, first.dataset.id, {
      clientActionId: randomUUID(),
      planHash: preview.planHash,
    })).resolves.toMatchObject({ status: 'COMPLETED', datasetId: first.dataset.id });

    const afterPurge = await app.inject({ method: 'GET', url: '/api/staff?status=active' });
    expect(afterPurge.statusCode).toBe(200);
    expect(afterPurge.json()).toEqual([]);

    const second = await demo.create(admin, { clientActionId: randomUUID() });
    expect(second.dataset.id).not.toBe(first.dataset.id);
    const afterRecreate = await app.inject({ method: 'GET', url: '/api/staff?status=active' });
    expect(afterRecreate.statusCode).toBe(200);
    expect(afterRecreate.json()).toHaveLength(2);
  });
});
