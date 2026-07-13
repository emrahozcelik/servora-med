import { describe, expect, it } from 'vitest';

import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { mapProduct, type ProductRow } from '../src/modules/products/types.js';

type QueryCall = { text: string; values: unknown[] };

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'product-1', organization_id: 'org-1', name: 'İmplant', sku: 'IMP-1',
    brand: 'Servora', category: 'Cerrahi', model: 'M1', unit: 'adet',
    default_price: '1250.50', is_active: true, version: 3,
    created_at: new Date('2026-07-13T08:00:00Z'),
    updated_at: new Date('2026-07-13T09:00:00Z'),
    ...overrides,
  };
}

function recordingPool(resolveRows: (text: string, values: unknown[]) => unknown[] = () => []) {
  const calls: QueryCall[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const rows = resolveRows(text, values);
    return { rows, rowCount: rows.length };
  };
  const client = { query, release: () => undefined };
  return { calls, pool: { query, connect: async () => client } as never };
}

describe('Product persistence', () => {
  it('maps PostgreSQL rows, numeric prices, and nullable catalog fields', () => {
    expect(mapProduct(productRow())).toEqual({
      id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'IMP-1',
      brand: 'Servora', category: 'Cerrahi', model: 'M1', unit: 'adet',
      referencePrice: 1250.5, isActive: true, version: 3,
      createdAt: new Date('2026-07-13T08:00:00Z'),
      updatedAt: new Date('2026-07-13T09:00:00Z'),
    });
    expect(mapProduct(productRow({ sku: null, unit: null, default_price: null }))).toMatchObject({
      sku: null, unit: null, referencePrice: null,
    });
  });

  it('escapes literal search metacharacters once and searches only approved columns', async () => {
    const recorded = recordingPool((text) => text.includes('COUNT(*)') ? [{ total: '0' }] : []);
    const repository = new PostgresProductRepository(recorded.pool);

    await repository.listProducts('org-1', {
      q: ' A%_\\B ', status: 'all', limit: 50, offset: 0,
    });

    const [count, page] = recorded.calls;
    expect(count!.values).toEqual(['org-1', '%A\\%\\_\\\\B%']);
    expect(page!.values).toEqual(['org-1', '%A\\%\\_\\\\B%', 50, 0]);
    for (const call of [count!, page!]) {
      expect(call.text.match(/ILIKE \$2 ESCAPE '\\'/g)).toHaveLength(5);
      const searchedColumns = [...call.text.matchAll(/(?:COALESCE\()?([a-z_]+)(?:,'')?\)? ILIKE/g)]
        .map((match) => match[1]);
      expect(searchedColumns).toEqual(['name', 'sku', 'brand', 'category', 'model']);
    }
  });

  it.each([
    ['active', /is_active=TRUE/],
    ['inactive', /is_active=FALSE/],
    ['all', null],
  ] as const)('applies the %s lifecycle filter', async (status, predicate) => {
    const recorded = recordingPool((text) => text.includes('COUNT(*)') ? [{ total: '0' }] : []);
    const repository = new PostgresProductRepository(recorded.pool);
    await repository.listProducts('org-1', { q: null, status, limit: 10, offset: 2 });
    const sql = recorded.calls.map((call) => call.text).join('\n');
    if (predicate) expect(sql).toMatch(predicate);
    else expect(sql).not.toMatch(/is_active=(?:TRUE|FALSE)/);
  });

  it('keeps total independent of pagination and returns deterministic organization-scoped pages', async () => {
    const recorded = recordingPool((text) => {
      if (text.includes('COUNT(*)')) return [{ total: '37' }];
      if (text.includes('FROM products')) return [productRow()];
      return [];
    });
    const repository = new PostgresProductRepository(recorded.pool);

    const result = await repository.listProducts('org-1', {
      q: null, status: 'active', limit: 999, offset: 7,
    });

    expect(result).toMatchObject({ total: 37, limit: 200, offset: 7 });
    expect(result.items).toHaveLength(1);
    const [count, page] = recorded.calls;
    expect(count!.text).toMatch(/WHERE organization_id=\$1/);
    expect(count!.values).toEqual(['org-1']);
    expect(count!.text).not.toMatch(/LIMIT|OFFSET/);
    expect(page!.text).toMatch(/WHERE organization_id=\$1/);
    expect(page!.text).toMatch(/ORDER BY name, id/);
    expect(page!.text).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(page!.values).toEqual(['org-1', 200, 7]);
  });

  it('scopes detail and locked reads to organization', async () => {
    const recorded = recordingPool((text) => text.includes('FROM products') ? [productRow()] : []);
    const repository = new PostgresProductRepository(recorded.pool);

    await expect(repository.getProduct('org-1', 'product-1')).resolves.toMatchObject({ id: 'product-1' });
    await repository.execute(async (tx) => tx.lockProduct('org-1', 'product-1'));

    const reads = recorded.calls.filter((call) => call.text.includes('FROM products'));
    expect(reads).toHaveLength(2);
    expect(reads.every((call) => /organization_id=\$1 AND id=\$2/.test(call.text))).toBe(true);
    expect(reads.every((call) => call.values.join(',') === 'org-1,product-1')).toBe(true);
    expect(reads[1]!.text).toMatch(/FOR UPDATE/);
  });

  it('uses organization and expected version for field and lifecycle updates', async () => {
    const recorded = recordingPool((text) => text.includes('RETURNING') ? [productRow()] : []);
    const repository = new PostgresProductRepository(recorded.pool);

    await repository.execute(async (tx) => {
      await tx.createProduct({
        organizationId: 'org-1', name: 'İmplant', sku: null, brand: null,
        category: null, model: null, unit: null, referencePrice: null,
      });
      await tx.updateProduct({
        organizationId: 'org-1', productId: 'product-1', expectedVersion: 3,
        name: 'İmplant 2', sku: 'IMP-2', brand: 'Servora', category: 'Cerrahi',
        model: 'M2', unit: 'adet', referencePrice: 1500,
      });
      await tx.setProductActive({
        organizationId: 'org-1', productId: 'product-1', expectedVersion: 4, isActive: false,
      });
      await tx.appendAudit({
        organizationId: 'org-1', actorUserId: 'manager-1', subjectId: 'product-1',
        eventType: 'PRODUCT_FIELDS_UPDATED', oldValue: null, newValue: null,
        metadata: { changedFields: ['name'] },
      });
    });

    const insert = recorded.calls.find((call) => call.text.includes('INSERT INTO products'))!;
    expect(insert.text).toMatch(/organization_id, name, sku, brand, category, model, unit, default_price/);
    expect(insert.values).toEqual(['org-1', 'İmplant', null, null, null, null, null, null]);
    const update = recorded.calls.find((call) => call.text.includes('UPDATE products') && call.text.includes('name=$4'))!;
    expect(update.text).toMatch(/version=version\+1/);
    expect(update.text).toMatch(/WHERE organization_id=\$1 AND id=\$2 AND version=\$3/);
    expect(update.values.slice(0, 3)).toEqual(['org-1', 'product-1', 3]);
    const lifecycle = recorded.calls.find((call) => call.text.includes('UPDATE products') && call.text.includes('is_active=$4'))!;
    expect(lifecycle.text).toMatch(/version=version\+1/);
    expect(lifecycle.text).toMatch(/WHERE organization_id=\$1 AND id=\$2 AND version=\$3/);
    expect(lifecycle.values).toEqual(['org-1', 'product-1', 4, false]);
    const audit = recorded.calls.find((call) => call.text.includes('INSERT INTO audit_events'))!;
    expect(audit.values).toEqual([
      'org-1', 'manager-1', 'PRODUCT', 'product-1', 'PRODUCT_FIELDS_UPDATED',
      null, null, { changedFields: ['name'] },
    ]);
  });

  it('commits successful work and rolls back failed work', async () => {
    const success = recordingPool();
    const repository = new PostgresProductRepository(success.pool);
    await expect(repository.execute(async () => 'done')).resolves.toBe('done');
    expect(success.calls.map((call) => call.text)).toEqual(['BEGIN', 'COMMIT']);

    const failure = recordingPool();
    const failingRepository = new PostgresProductRepository(failure.pool);
    await expect(failingRepository.execute(async () => {
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(failure.calls.map((call) => call.text)).toEqual(['BEGIN', 'ROLLBACK']);
  });
});
