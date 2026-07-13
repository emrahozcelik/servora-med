import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { productRoutes } from '../src/modules/products/routes.js';
import { ProductService } from '../src/modules/products/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const setupPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));

afterAll(async () => { await setupPool?.end(); });

async function applyMigrations(client: PoolClient) {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) await client.query(await readFile(`${migrationsDirectory}/${file}`, 'utf8'));
}

describe.skipIf(!databaseUrl)('Product PostgreSQL HTTP contract', () => {
  it('keeps UUID and field limits inside the HTTP contract instead of leaking database errors', async () => {
    const schema = `product_routes_${randomUUID().replaceAll('-', '')}`;
    const client = await setupPool!.connect();
    const app = Fastify({ logger: false });
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await applyMigrations(client);
      const organization = await client.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('Product Route Test') RETURNING id",
      );
      const organizationId = organization.rows[0]!.id;
      const manager = await client.query<{ id: string }>(`
        INSERT INTO users (organization_id, name, email, password_hash, role)
        VALUES ($1, 'Manager', $2, 'unused-test-hash', 'MANAGER')
        RETURNING id
      `, [organizationId, `manager-${randomUUID()}@example.com`]);
      const managerId = manager.rows[0]!.id;
      const repositoryPool = {
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release: () => undefined }),
      };
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        return reply.code(response.statusCode).send(response.body);
      });
      await app.register(productRoutes, {
        prefix: '/api', service: new ProductService(new PostgresProductRepository(repositoryPool as never)),
        authenticate: async (request) => {
          request.currentUser = {
            id: managerId, organizationId, name: 'Manager', email: 'manager@example.com',
            role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
          };
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/products/not-a-uuid' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });

      const boundary = await app.inject({ method: 'POST', url: '/api/products', payload: {
        name: 'n'.repeat(255), sku: 's'.repeat(100), brand: 'b'.repeat(100),
        category: 'c'.repeat(100), model: 'm'.repeat(100), unit: 'u'.repeat(30),
        referencePrice: 9_999_999_999.99,
      } });
      expect(boundary.statusCode).toBe(201);
      expect(boundary.json()).toMatchObject({ referencePrice: 9_999_999_999.99, version: 1 });

      const overLimit = await app.inject({ method: 'POST', url: '/api/products', payload: {
        name: 'Ürün', sku: 's'.repeat(101),
      } });
      expect(overLimit.statusCode).toBe(400);
      expect(overLimit.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { fieldErrors: { sku: 'SKU en fazla 100 karakter olabilir.' } },
      });
      const count = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
      expect(count.rows[0]?.count).toBe('1');
    } finally {
      await app.close();
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
