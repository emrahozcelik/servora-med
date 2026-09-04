import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

afterAll(async () => { await adminPool?.end(); });

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>) {
  if (!adminPool) return;
  const schema = `customer_search_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
      logger: { info() {}, error() {} },
    });
    await run(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function createOrganization(pool: Pool, name: string) {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id', [name],
  );
  return result.rows[0]!.id;
}

async function createCustomer(
  pool: Pool,
  organizationId: string,
  input: { name: string; phone?: string | null; email?: string | null; status?: string },
) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, phone, email, status)
     VALUES ($1, $2, 'clinic', $3, $4, $5) RETURNING id`,
    [organizationId, input.name, input.phone ?? null, input.email ?? null, input.status ?? 'active'],
  );
  return result.rows[0]!.id;
}

async function createContact(
  pool: Pool,
  organizationId: string,
  customerId: string,
  input: { name: string; phone?: string | null },
) {
  await pool.query(
    `INSERT INTO contacts (organization_id, customer_id, name, phone, is_primary, is_active)
     VALUES ($1, $2, $3, $4, TRUE, TRUE)`,
    [organizationId, customerId, input.name, input.phone ?? null],
  );
}

const list = (
  repository: PostgresCrmRepository,
  organizationId: string,
  filters: Parameters<PostgresCrmRepository['listCustomers']>[1],
) => repository.listCustomers(organizationId, filters);

describe('customer remote search normalization', () => {
  it('matches Turkish İ/I/ı spellings symmetrically', async () => {
    if (!adminPool) return;
    await withIsolatedDatabase(async (pool) => {
      const repository = new PostgresCrmRepository(pool as never);
      const organizationId = await createOrganization(pool, 'Search TR test');
      await createCustomer(pool, organizationId, { name: 'İSTANBUL Dental' });
      await createCustomer(pool, organizationId, { name: 'Yılmaz Klinik' });

      for (const q of ['istanbul', 'İSTANBUL', 'Istanbul']) {
        const page = await list(repository, organizationId, { q, limit: 50, offset: 0 });
        expect(page.items.map((item) => item.name)).toContain('İSTANBUL Dental');
      }
      for (const q of ['yilmaz', 'YILMAZ', 'Yılmaz', 'yılmaz']) {
        const page = await list(repository, organizationId, { q, limit: 50, offset: 0 });
        expect(page.items.map((item) => item.name)).toContain('Yılmaz Klinik');
      }
    });
  });

  it('tolerates phone spacing, dashes and country prefixes without rewriting stored values', async () => {
    if (!adminPool) return;
    await withIsolatedDatabase(async (pool) => {
      const repository = new PostgresCrmRepository(pool as never);
      const organizationId = await createOrganization(pool, 'Search phone test');
      await createCustomer(pool, organizationId, { name: 'IŞIK Medikal', phone: '0532 123 45 67' });

      for (const q of ['05321234567', '0532 123 45 67', '0532-123-45-67', '+90 532 123 45 67', '5321234567']) {
        const page = await list(repository, organizationId, { q, limit: 50, offset: 0 });
        expect(page.items.map((item) => item.name)).toContain('IŞIK Medikal');
      }
      const stored = await pool.query<{ phone: string }>(
        'SELECT phone FROM customers WHERE organization_id=$1', [organizationId],
      );
      expect(stored.rows[0]!.phone).toBe('0532 123 45 67');
    });
  });

  it('matches linked contact fields and keeps inactive customers hidden by default', async () => {
    if (!adminPool) return;
    await withIsolatedDatabase(async (pool) => {
      const repository = new PostgresCrmRepository(pool as never);
      const organizationId = await createOrganization(pool, 'Search contact test');
      const customerId = await createCustomer(pool, organizationId, { name: 'Ege Diş' });
      await createContact(pool, organizationId, customerId, { name: 'Çağrı Demir', phone: '0544 999 88 77' });
      await createCustomer(pool, organizationId, { name: 'Pasif Depo', status: 'inactive' });

      for (const q of ['çağrı', 'ÇAĞRI', '05449998877', '0544 999 88 77']) {
        const page = await list(repository, organizationId, { q, limit: 50, offset: 0 });
        expect(page.items.map((item) => item.name)).toContain('Ege Diş');
      }
      const unfiltered = await list(repository, organizationId, { limit: 50, offset: 0 });
      expect(unfiltered.items.map((item) => item.name)).toContain('Ege Diş');
      expect(unfiltered.items.map((item) => item.name)).not.toContain('Pasif Depo');

      const empty = await list(repository, organizationId, { q: 'zzz-eslesen-yok', limit: 50, offset: 0 });
      expect(empty.items).toEqual([]);
      expect(empty.total).toBe(0);
    });
  });

  it('isolates organizations and honors limit/offset', async () => {
    if (!adminPool) return;
    await withIsolatedDatabase(async (pool) => {
      const repository = new PostgresCrmRepository(pool as never);
      const organizationA = await createOrganization(pool, 'Search org A');
      const organizationB = await createOrganization(pool, 'Search org B');
      await createCustomer(pool, organizationA, { name: 'Ortak İsim Klinik' });
      await createCustomer(pool, organizationB, { name: 'Ortak İsim Klinik' });

      const pageA = await list(repository, organizationA, { q: 'ortak isim', limit: 50, offset: 0 });
      expect(pageA.items).toHaveLength(1);

      await createCustomer(pool, organizationA, { name: 'Alfa Klinik' });
      await createCustomer(pool, organizationA, { name: 'Beta Klinik' });
      const first = await list(repository, organizationA, { limit: 1, offset: 0 });
      const second = await list(repository, organizationA, { limit: 1, offset: 1 });
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
      expect(first.total).toBe(3);
    });
  });
});
