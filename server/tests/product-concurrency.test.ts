import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { ProductService } from '../src/modules/products/service.js';

type CleanupClient = {
  query(statement: string): Promise<unknown>;
  release(error?: Error): void;
};

async function cleanupIsolatedSchema(
  client: CleanupClient,
  schema: string,
  preservePrimaryFailure: boolean,
) {
  const errors: unknown[] = [];
  for (const statement of [
    'ROLLBACK',
    'RESET search_path',
    `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
  ]) {
    try { await client.query(statement); }
    catch (error) { errors.push(error); }
  }

  const unsafeClientError = errors.length > 0
    ? new AggregateError(errors, 'Product concurrency test client cleanup failed')
    : undefined;
  try { client.release(unsafeClientError); }
  catch (error) { errors.push(error); }

  if (!preservePrimaryFailure && errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up Product concurrency test schema');
  }
}

describe('Product concurrency cleanup', () => {
  it('discards a client when isolated schema cleanup is unsafe', async () => {
    const releaseArguments: Array<Error | undefined> = [];
    const client = {
      async query(statement: string) {
        if (statement === 'RESET search_path') throw new Error('reset failed');
        return { rows: [] };
      },
      release(error?: Error) { releaseArguments.push(error); },
    };
    await expect(cleanupIsolatedSchema(client, 'product_race', false)).rejects.toThrow(
      'Failed to clean up Product concurrency test schema',
    );
    expect(releaseArguments).toHaveLength(1);
    expect(releaseArguments[0]).toBeInstanceOf(Error);
  });

  it('returns a clean client without a disposal error', async () => {
    const releaseArguments: Array<Error | undefined> = [];
    const client = {
      async query() { return { rows: [] }; },
      release(error?: Error) { releaseArguments.push(error); },
    };
    await cleanupIsolatedSchema(client, 'product_race', false);
    expect(releaseArguments).toEqual([undefined]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const setupPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => { await setupPool?.end(); });

describe.skipIf(!databaseUrl)('Product PostgreSQL optimistic concurrency', () => {
  it('permits exactly one of two patches using the same Product version', async () => {
    const schema = `product_race_${randomUUID().replaceAll('-', '')}`;
    const setupClient = await setupPool!.connect();
    let applicationPool: Pool | null = null;
    let primaryTestFailed = false;

    try {
      await setupClient.query(`CREATE SCHEMA ${schema}`);
      await setupClient.query(`SET search_path TO ${schema}, public`);
      for (const migration of [
        '001_auth_foundation.sql',
        '002_delivery_tracer.sql',
        '003_people.sql',
        '004_crm_contacts.sql',
        '005_product_catalog.sql',
      ]) {
        const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
        await setupClient.query(await readFile(path, 'utf8'));
      }
      await setupClient.query('RESET search_path');

      applicationPool = new Pool({
        connectionString: databaseUrl,
        max: 2,
        options: `-c search_path=${schema},public`,
      });
      const organizationId = randomUUID();
      const managerId = randomUUID();
      await applicationPool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, 'Product Race Test')`,
        [organizationId],
      );
      await applicationPool.query(
        `INSERT INTO users (id, organization_id, name, email, password_hash, role)
         VALUES ($1,$2,'Manager',$3,'test-hash','MANAGER')`,
        [managerId, organizationId, `${managerId}@test.local`],
      );

      const service = new ProductService(new PostgresProductRepository(applicationPool));
      const actor = { id: managerId, organizationId, role: 'MANAGER' as const };
      const created = await service.createProduct(actor, { name: 'Race Product' });

      const results = await Promise.allSettled([
        service.updateProduct(actor, created.id, { expectedVersion: 1, brand: 'First' }),
        service.updateProduct(actor, created.id, { expectedVersion: 1, brand: 'Second' }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: { code: 'VERSION_CONFLICT', details: { currentVersion: 2 } },
      });

      const persisted = await applicationPool.query<{ version: number; brand: string | null }>(
        'SELECT version, brand FROM products WHERE organization_id=$1 AND id=$2',
        [organizationId, created.id],
      );
      expect(persisted.rows[0]).toMatchObject({ version: 2 });
      expect(['First', 'Second']).toContain(persisted.rows[0]!.brand);
      const audit = await applicationPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_events
         WHERE organization_id=$1 AND subject_id=$2 AND event_type='PRODUCT_FIELDS_UPDATED'`,
        [organizationId, created.id],
      );
      expect(audit.rows[0]?.count).toBe('1');
    } catch (error) {
      primaryTestFailed = true;
      throw error;
    } finally {
      try { await applicationPool?.end(); }
      catch (error) {
        if (!primaryTestFailed) {
          primaryTestFailed = true;
          throw error;
        }
      } finally {
        await cleanupIsolatedSchema(setupClient, schema, primaryTestFailed);
      }
    }
  });
});
