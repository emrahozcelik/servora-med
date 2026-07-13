import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/services/api';
import {
  activateProduct, createProduct, deactivateProduct, getProduct, listProducts, updateProduct,
} from '../src/services/products-api';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const product = {
  id: 'product/1', organizationId: 'org-1', name: 'Dental İmplant', sku: null,
  brand: null, category: null, model: null, unit: null, referencePrice: null,
  isActive: true, version: 1, createdAt: '2026-07-13T08:00:00.000Z',
  updatedAt: '2026-07-13T08:00:00.000Z',
};

describe('Product API client', () => {
  it('encodes every filter, omits empty values, and includes credentials', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({
      items: [product], total: 1, limit: 25, offset: 5,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProducts({ q: 'İmplant & Vida', status: 'inactive', limit: 25, offset: 5 }))
      .resolves.toEqual({ items: [product], total: 1, limit: 25, offset: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/products?q=%C4%B0mplant+%26+Vida&status=inactive&limit=25&offset=5',
      expect.objectContaining({ credentials: 'include' }),
    );

    await listProducts({ q: '' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/products', expect.anything());
  });

  it('accepts populated nullable fields and parses the canonical page metadata', async () => {
    const populated = { ...product, sku: 'SKU-1', brand: 'Servora', category: 'İmplant',
      model: 'M/1', unit: 'adet', referencePrice: 1250.5 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [populated], total: 7, limit: 10, offset: 2,
    })));

    await expect(listProducts()).resolves.toEqual({
      items: [populated], total: 7, limit: 10, offset: 2,
    });
  });

  it('encodes Product IDs for detail and mutations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(product)));
    vi.stubGlobal('fetch', fetchMock);

    await getProduct('product/1 + özel');
    await updateProduct('product/1 + özel', { expectedVersion: 1, name: 'Yeni Ad' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/products/product%2F1%20%2B%20%C3%B6zel',
      '/api/products/product%2F1%20%2B%20%C3%B6zel',
    ]);
  });

  it('sends create without expectedVersion and preserves omitted and null optional fields', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(product, 201)));
    vi.stubGlobal('fetch', fetchMock);
    const minimal = { name: 'Dental İmplant' };
    const nullable = { name: 'Dental İmplant', sku: null, brand: null, category: null,
      model: null, unit: null, referencePrice: null };

    await createProduct(minimal);
    await createProduct(nullable);
    expect(fetchMock.mock.calls.map(([, init]) => init.body)).toEqual([
      JSON.stringify(minimal), JSON.stringify(nullable),
    ]);
  });

  it('sends exact patch and lifecycle bodies', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(product)));
    vi.stubGlobal('fetch', fetchMock);
    const patch = { expectedVersion: 3, sku: null, referencePrice: 245.75 };

    await updateProduct('product/1', patch);
    await activateProduct('product/1', 4);
    await deactivateProduct('product/1', 5);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ['/api/products/product%2F1', 'PATCH', JSON.stringify(patch)],
      ['/api/products/product%2F1/activate', 'POST', JSON.stringify({ expectedVersion: 4 })],
      ['/api/products/product%2F1/deactivate', 'POST', JSON.stringify({ expectedVersion: 5 })],
    ]);
  });

  it('rejects every missing or malformed canonical response field', async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => listProducts(), () => getProduct('product-1'),
      () => createProduct({ name: 'İmplant' }), () => updateProduct('product-1', { expectedVersion: 1 }),
      () => activateProduct('product-1', 1), () => deactivateProduct('product-1', 1),
    ];
    for (const call of calls) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'broken' })));
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }

    const malformed = [
      { ...product, sku: undefined }, { ...product, referencePrice: '10' },
      { ...product, isActive: 'true' }, { ...product, version: '1' },
      { ...product, createdAt: '' }, { ...product, updatedAt: null },
    ];
    for (const response of malformed) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(response)));
      await expect(getProduct('product-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('propagates safe VERSION_CONFLICT details without retrying the mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      error: 'Kayıt başka bir kullanıcı tarafından güncellendi.', code: 'VERSION_CONFLICT',
      details: { currentVersion: 4 },
    }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deactivateProduct('product-1', 1)).rejects.toMatchObject<ApiError>({
      status: 409, code: 'VERSION_CONFLICT', retryable: false, details: { currentVersion: 4 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops non-object VERSION_CONFLICT details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Sürüm çakıştı.', code: 'VERSION_CONFLICT', details: 'unsafe-shape',
    }, 409)));
    await expect(activateProduct('product-1', 1)).rejects.toMatchObject<ApiError>({
      status: 409, code: 'VERSION_CONFLICT', details: null,
    });
  });
});
