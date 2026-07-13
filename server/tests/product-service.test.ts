import { describe, expect, it } from 'vitest';

import { ProductService } from '../src/modules/products/service.js';
import type { Product } from '../src/modules/products/types.js';

const now = new Date('2026-07-13T10:00:00Z');
const manager = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };
const staff = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1', organizationId: 'org-1', name: 'İmplant', sku: 'SKU.a-1',
    brand: 'Servora', category: 'Cerrahi', model: 'M1', unit: 'adet',
    referencePrice: 1250, isActive: true, version: 1, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function fixture(options: {
  current?: Product | null;
  failUpdate?: boolean;
  failLifecycle?: boolean;
  failAudit?: boolean;
} = {}) {
  let current = options.current === undefined ? product() : options.current;
  const audits: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const tx = {
    lockProduct: async (organizationId: string) => {
      calls.push('lock');
      return current?.organizationId === organizationId ? current : null;
    },
    createProduct: async (input: Record<string, unknown>) => {
      calls.push('create');
      current = product({ ...input, id: 'product-created', isActive: true, version: 1 } as Partial<Product>);
      return current;
    },
    updateProduct: async (input: Record<string, unknown>) => {
      calls.push('update');
      if (options.failUpdate) return null;
      current = product({ ...current, ...input, version: current!.version + 1 } as Partial<Product>);
      return current;
    },
    setProductActive: async (input: { isActive: boolean }) => {
      calls.push('lifecycle');
      if (options.failLifecycle) return null;
      current = product({ ...current, isActive: input.isActive, version: current!.version + 1 });
      return current;
    },
    appendAudit: async (input: Record<string, unknown>) => {
      calls.push('audit');
      if (options.failAudit) throw new Error('audit failed');
      audits.push(input);
    },
  };
  const repository = {
    execute: async <T>(work: (value: typeof tx) => Promise<T>) => {
      const before = current;
      const auditCount = audits.length;
      try { return await work(tx); }
      catch (error) {
        current = before;
        audits.splice(auditCount);
        throw error;
      }
    },
    listProducts: async () => ({ items: current ? [current] : [], total: current ? 1 : 0, limit: 50, offset: 0 }),
    getProduct: async (organizationId: string) => current?.organizationId === organizationId ? current : null,
  };
  return {
    service: new ProductService(repository as never), audits, calls,
    current: () => current,
  };
}

describe('Product service policy', () => {
  it('allows Staff reads and keeps every Product mutation writer-only', async () => {
    const { service } = fixture();
    await expect(service.listProducts(staff, { q: null, status: 'all', limit: 50, offset: 0 }))
      .resolves.toMatchObject({ total: 1 });
    await expect(service.getProduct(staff, 'product-1')).resolves.toMatchObject({ id: 'product-1' });

    const mutations = [
      () => service.createProduct(staff, { name: 'Ürün' }),
      () => service.updateProduct(staff, 'product-1', { expectedVersion: 1, name: 'Ürün' }),
      () => service.activateProduct(staff, 'product-1', 1),
      () => service.deactivateProduct(staff, 'product-1', 1),
    ];
    for (const mutate of mutations) {
      await expect(Promise.resolve().then(mutate)).rejects.toMatchObject({
        code: 'FORBIDDEN', statusCode: 403,
      });
    }
  });

  it('requires and trims the name', async () => {
    const { service } = fixture();
    await expect(service.createProduct(manager, { name: '   ' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    await expect(service.createProduct(manager, { name: '  İmplant  ' }))
      .resolves.toMatchObject({ name: 'İmplant' });
    await expect(service.updateProduct(manager, 'product-1', { expectedVersion: 1, name: '  ' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['name', 'x'.repeat(256), 'Ürün adı en fazla 255 karakter olabilir.'],
    ['sku', 'x'.repeat(101), 'SKU en fazla 100 karakter olabilir.'],
    ['brand', 'x'.repeat(101), 'Marka en fazla 100 karakter olabilir.'],
    ['category', 'x'.repeat(101), 'Kategori en fazla 100 karakter olabilir.'],
    ['model', 'x'.repeat(101), 'Model en fazla 100 karakter olabilir.'],
    ['unit', 'x'.repeat(31), 'Birim en fazla 30 karakter olabilir.'],
  ] as const)('rejects %s values beyond the persistence limit with a field error', async (
    field, value, message,
  ) => {
    const { service } = fixture();
    await expect(service.createProduct(manager, { name: 'Ürün', [field]: value }))
      .rejects.toMatchObject({
        code: 'VALIDATION_ERROR', statusCode: 400,
        details: { fieldErrors: { [field]: message } },
      });
  });

  it('normalizes omitted and empty optional text to null without changing SKU case or punctuation', async () => {
    const createdFixture = fixture();
    const created = await createdFixture.service.createProduct(manager, {
      name: ' Ürün ', sku: '  Ab.c-01  ', brand: ' ', category: '', model: null, unit: '  kutu ',
    });
    expect(created).toMatchObject({
      name: 'Ürün', sku: 'Ab.c-01', brand: null, category: null, model: null,
      unit: 'kutu', referencePrice: null,
    });

    const omitted = await fixture().service.createProduct(manager, { name: 'Sadece ad' });
    expect(omitted).toMatchObject({
      sku: null, brand: null, category: null, model: null, unit: null, referencePrice: null,
    });
  });

  it.each([null, 0, 12.5])('accepts referencePrice %s', async (referencePrice) => {
    await expect(fixture().service.createProduct(manager, { name: 'Ürün', referencePrice }))
      .resolves.toMatchObject({ referencePrice });
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid referencePrice %s', async (referencePrice) => {
      await expect(fixture().service.createProduct(manager, { name: 'Ürün', referencePrice }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    },
  );

  it('rejects a reference price beyond NUMERIC(12,2) with a field error', async () => {
    await expect(fixture().service.createProduct(manager, {
      name: 'Ürün', referencePrice: 10_000_000_000,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR', statusCode: 400,
      details: { fieldErrors: {
        referencePrice: 'Referans fiyat en fazla 9999999999.99 olabilir.',
      } },
    });
  });

  it('creates an active version-one Product and exactly one safe audit', async () => {
    const { service, audits } = fixture();
    const created = await service.createProduct(manager, {
      name: 'Ürün', sku: 'SECRET-SKU', referencePrice: 999,
    });
    expect(created).toMatchObject({ isActive: true, version: 1 });
    expect(audits).toEqual([{
      organizationId: 'org-1', actorUserId: 'manager-1', subjectId: 'product-created',
      eventType: 'PRODUCT_CREATED', oldValue: null,
      newValue: { isActive: true }, metadata: {},
    }]);
    expect(JSON.stringify(audits)).not.toMatch(/SECRET-SKU|999|referencePrice|name/);
  });

  it('requires at least one mutable patch field and preserves omitted fields', async () => {
    const empty = fixture();
    await expect(empty.service.updateProduct(manager, 'product-1', { expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    const partial = fixture();
    const updated = await partial.service.updateProduct(manager, 'product-1', {
      expectedVersion: 1, brand: '  Yeni Marka ', unit: ' ',
    });
    expect(updated).toMatchObject({
      name: 'İmplant', sku: 'SKU.a-1', brand: 'Yeni Marka', category: 'Cerrahi',
      model: 'M1', unit: null, referencePrice: 1250, version: 2,
    });
  });

  it('returns a no-op patch without updating, incrementing, or auditing', async () => {
    const { service, calls, audits } = fixture();
    const updated = await service.updateProduct(manager, 'product-1', {
      expectedVersion: 1, name: ' İmplant ', sku: ' SKU.a-1 ', referencePrice: 1250,
    });
    expect(updated).toMatchObject({ version: 1 });
    expect(calls).toEqual(['lock']);
    expect(audits).toEqual([]);
  });

  it('increments a changed patch once and audits only supplied changed field names', async () => {
    const { service, audits } = fixture();
    const updated = await service.updateProduct(manager, 'product-1', {
      expectedVersion: 1, name: 'İmplant', sku: 'new.Sku-2', referencePrice: 1500,
    });
    expect(updated).toMatchObject({ sku: 'new.Sku-2', referencePrice: 1500, version: 2 });
    expect(audits).toEqual([{
      organizationId: 'org-1', actorUserId: 'manager-1', subjectId: 'product-1',
      eventType: 'PRODUCT_FIELDS_UPDATED', oldValue: null, newValue: null,
      metadata: { changedFields: ['sku', 'referencePrice'] },
    }]);
    expect(JSON.stringify(audits)).not.toMatch(/new\.Sku-2|1500/);
  });

  it('conceals missing and cross-organization Products as PRODUCT_NOT_FOUND', async () => {
    for (const current of [null, product({ organizationId: 'org-2' })]) {
      const { service } = fixture({ current });
      await expect(service.getProduct(manager, 'product-1')).rejects.toMatchObject({
        code: 'PRODUCT_NOT_FOUND', statusCode: 404,
      });
      await expect(service.updateProduct(manager, 'product-1', { expectedVersion: 1, name: 'Yeni' }))
        .rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', statusCode: 404 });
    }
  });

  it('returns safe version conflicts for stale patch and lifecycle commands without writes or audits', async () => {
    for (const invoke of [
      (service: ProductService) => service.updateProduct(manager, 'product-1', { expectedVersion: 3, name: 'Yeni' }),
      (service: ProductService) => service.deactivateProduct(manager, 'product-1', 3),
    ]) {
      const { service, calls, audits } = fixture({ current: product({ version: 4 }) });
      await expect(invoke(service)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', statusCode: 409, details: { currentVersion: 4 },
      });
      expect(calls).toEqual(['lock']);
      expect(audits).toEqual([]);
    }
  });

  it('returns a safe conflict when a conditional write loses the version race', async () => {
    const patch = fixture({ failUpdate: true });
    await expect(patch.service.updateProduct(manager, 'product-1', { expectedVersion: 1, name: 'Yeni' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: null });
    expect(patch.audits).toEqual([]);

    const lifecycle = fixture({ failLifecycle: true });
    await expect(lifecycle.service.deactivateProduct(manager, 'product-1', 1))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: null });
    expect(lifecycle.audits).toEqual([]);
  });

  it('rejects repeated lifecycle commands and audits successful lifecycle changes safely', async () => {
    const repeated = fixture();
    await expect(repeated.service.activateProduct(manager, 'product-1', 1))
      .rejects.toMatchObject({ code: 'INVALID_PRODUCT_STATUS_TRANSITION', statusCode: 409 });

    const changed = fixture();
    const deactivated = await changed.service.deactivateProduct(manager, 'product-1', 1);
    expect(deactivated).toMatchObject({ isActive: false, version: 2 });
    expect(changed.audits).toEqual([{
      organizationId: 'org-1', actorUserId: 'manager-1', subjectId: 'product-1',
      eventType: 'PRODUCT_DEACTIVATED', oldValue: { isActive: true },
      newValue: { isActive: false }, metadata: {},
    }]);
  });

  it('rolls Product and audit state back together when the repository transaction fails', async () => {
    const createFailure = fixture({ current: null, failAudit: true });
    await expect(createFailure.service.createProduct(manager, { name: 'Ürün' }))
      .rejects.toThrow('audit failed');
    expect(createFailure.current()).toBeNull();
    expect(createFailure.audits).toEqual([]);

    const updateFailure = fixture({ failAudit: true });
    await expect(updateFailure.service.updateProduct(manager, 'product-1', {
      expectedVersion: 1, name: 'Yeni Ürün',
    })).rejects.toThrow('audit failed');
    expect(updateFailure.current()).toMatchObject({ name: 'İmplant', version: 1 });
    expect(updateFailure.audits).toEqual([]);
  });
});
