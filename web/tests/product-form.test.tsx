/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductCreateScreen, ProductForm, productInputFromFormData } from '../src/ProductForm';
import { ApiError } from '../src/services/api';
import type { Product } from '../src/services/products-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const created: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'Yeni Ürün', sku: null, brand: null,
  category: null, model: null, unit: null, referencePrice: null, isActive: true, version: 1,
  createdAt: '2026-07-13T08:00:00.000Z', updatedAt: '2026-07-13T08:00:00.000Z',
};

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('Product form', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  it('marks only name required and labels every optional field explicitly', async () => {
    await act(async () => root.render(<ProductForm pending={false} fieldErrors={{}} error="" onCancel={() => {}} onSubmit={() => {}} />));
    const required = container.querySelectorAll('[required]');
    expect(required).toHaveLength(1); expect((required[0] as HTMLInputElement).name).toBe('name');
    expect(container.textContent).toContain('Ürün adı (zorunlu)');
    for (const label of ['SKU (isteğe bağlı)', 'Marka (isteğe bağlı)', 'Kategori (isteğe bağlı)', 'Model (isteğe bağlı)', 'Birim (isteğe bağlı)', 'Referans fiyat (isteğe bağlı)']) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain('yalnızca bilgilendirme amaçlıdır');
    expect(container.textContent).toContain('satış fiyatı, muhasebe kaydı veya stok değerlemesi değildir');
  });

  it('maps omitted optional values to null and rejects a negative reference price', () => {
    const data = new FormData(); data.set('name', '  Dental İmplant  '); data.set('sku', ''); data.set('referencePrice', '');
    expect(productInputFromFormData(data)).toEqual({ name: 'Dental İmplant', sku: null, brand: null, category: null, model: null, unit: null, referencePrice: null });
    data.set('referencePrice', '-1');
    expect(() => productInputFromFormData(data)).toThrow('Referans fiyat sıfırdan küçük olamaz.');
  });

  it('associates a negative-price error and focuses the error summary', async () => {
    await act(async () => root.render(<ProductCreateScreen onCancel={() => {}} onCreated={() => {}} create={vi.fn()} />));
    const name = container.querySelector('#product-name') as HTMLInputElement;
    const price = container.querySelector('#product-reference-price') as HTMLInputElement;
    await act(async () => { name.value = 'Ürün'; price.value = '-1'; (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    expect(price.getAttribute('aria-describedby')).toContain('product-reference-price-error');
    expect(container.textContent).toContain('Referans fiyat sıfırdan küçük olamaz.');
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'));
  });

  it('disables controls while pending and announces success only after creation resolves', async () => {
    const request = deferred<Product>(); const create = vi.fn().mockReturnValue(request.promise); const onCreated = vi.fn();
    await act(async () => root.render(<ProductCreateScreen onCancel={() => {}} onCreated={onCreated} create={create} />));
    const name = container.querySelector('#product-name') as HTMLInputElement; name.value = 'Yeni Ürün';
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(container.querySelectorAll('input:disabled, button:disabled').length).toBeGreaterThan(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Ürün oluşturuluyor');
    expect(container.textContent).not.toContain('Ürün oluşturuldu'); expect(onCreated).not.toHaveBeenCalled();
    await act(async () => request.resolve(created));
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('focuses the first invalid field for server validation details', async () => {
    const create = vi.fn().mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Alanları kontrol edin.', false, { fieldErrors: { name: 'Bu ürün adı kullanılamaz.' } }));
    await act(async () => root.render(<ProductCreateScreen onCancel={() => {}} onCreated={() => {}} create={create} />));
    const name = container.querySelector('#product-name') as HTMLInputElement; name.value = 'Ürün';
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(container.textContent).toContain('Bu ürün adı kullanılamaz.'); expect(document.activeElement).toBe(name);
  });
});
