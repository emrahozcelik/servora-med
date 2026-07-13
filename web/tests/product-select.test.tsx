/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductSelect } from '../src/ProductSelect';
import type { Paginated, Product } from '../src/services/products-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'Dental İmplant', sku: 'IMP-01',
  brand: null, category: null, model: 'M1', unit: 'set', referencePrice: null,
  isActive: true, version: 1, createdAt: '2026-07-13T08:00:00.000Z', updatedAt: '2026-07-13T08:00:00.000Z',
};

function page(items: Product[], offset = 0, total = items.length): Paginated<Product> {
  return { items, total, limit: 25, offset };
}

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function input(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function searchButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürün ara') as HTMLButtonElement;
}

describe('ProductSelect', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  async function render(load: Parameters<typeof ProductSelect>[0]['load'], selected: Product | null = null) {
    const onChange = vi.fn();
    await act(async () => root.render(<ProductSelect selected={selected} onChange={onChange} load={load} />));
    return onChange;
  }

  it('loads only active Products with a bounded query and offset', async () => {
    const load = vi.fn().mockResolvedValue(page([product]));
    await render(load); await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledWith({ status: 'active', q: '', limit: 25, offset: 0 });
    expect(container.textContent).toContain('Dental İmplant');
  });

  it('submits accessible search and pages beyond the first 25 results', async () => {
    const load = vi.fn().mockResolvedValueOnce(page([product], 0, 60))
      .mockResolvedValueOnce(page([{ ...product, id: 'searched', name: 'Cerrahi Vida' }], 0, 1))
      .mockResolvedValueOnce(page([product], 0, 60))
      .mockResolvedValueOnce(page([{ ...product, id: 'page-2', name: 'İkinci sayfa' }], 25, 60));
    await render(load); await act(async () => { await Promise.resolve(); });

    const search = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => input(search, 'vida'));
    await act(async () => searchButton(container).click());
    expect(load).toHaveBeenLastCalledWith({ status: 'active', q: 'vida', limit: 25, offset: 0 });
    expect(container.textContent).toContain('Cerrahi Vida');

    await act(async () => input(search, ''));
    await act(async () => searchButton(container).click());
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki')!.click());
    expect(load).toHaveBeenLastCalledWith({ status: 'active', q: '', limit: 25, offset: 25 });
    expect(container.textContent).toContain('26–50 / 60');
  });

  it('reaches Products after the first 200 results without truncating the catalog', async () => {
    const load = vi.fn().mockImplementation(async ({ offset }: { offset: number }) => page([
      { ...product, id: `product-${offset}`, name: `Ürün ${offset + 1}` },
    ], offset, 225));
    await render(load); await act(async () => { await Promise.resolve(); });

    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const next = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki') as HTMLButtonElement;
      await act(async () => next.click());
    }

    expect(load).toHaveBeenLastCalledWith({ status: 'active', q: '', limit: 25, offset: 200 });
    expect(container.textContent).toContain('201–225 / 225');
    expect(container.textContent).toContain('Ürün 201');
  });

  it('keeps loading, empty, no-results, error, and retry states operable', async () => {
    const first = deferred<Paginated<Product>>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('Bağlantı kurulamadı.')).mockResolvedValueOnce(page([]));
    await render(load);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    await act(async () => first.reject(new Error('Bağlantı kurulamadı.')));
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement;
    expect(retry).toBeTruthy(); expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene')!.click());
    expect(container.textContent).toContain('Henüz aktif ürün kaydı yok');
  });

  it('distinguishes no search results and omits empty Product punctuation', async () => {
    const nullable = { ...product, id: 'nullable', name: 'Adsız Set', sku: null, model: null, unit: null };
    const load = vi.fn().mockResolvedValueOnce(page([nullable])).mockResolvedValueOnce(page([]));
    await render(load); await act(async () => { await Promise.resolve(); });
    const row = container.querySelector('[data-product-id="nullable"]') as HTMLElement;
    expect(row.textContent).toBe('Adsız Set');
    expect(row.textContent).not.toMatch(/[()·—]/);

    const search = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => input(search, 'bulunmaz'));
    await act(async () => searchButton(container).click());
    expect(container.textContent).toContain('Aramanıza uygun aktif ürün bulunamadı');
  });

  it('uses native keyboard-operable buttons and preserves the selected Product across searches', async () => {
    const load = vi.fn().mockResolvedValueOnce(page([product])).mockResolvedValueOnce(page([]));
    const onChange = await render(load); await act(async () => { await Promise.resolve(); });
    const option = container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement;
    expect(option.tagName).toBe('BUTTON'); expect(option.type).toBe('button');
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledWith(product);
    await act(async () => root.render(<ProductSelect selected={product} onChange={onChange} load={load} />));
    const search = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => input(search, 'başka'));
    await act(async () => searchButton(container).click());
    expect(container.querySelector('input[name="productId"]')?.getAttribute('value')).toBe('product-1');
    expect(container.textContent).toContain('Seçili ürün'); expect(container.textContent).toContain('Dental İmplant');
  });

  it('never lets a stale response replace newer results', async () => {
    const initial = deferred<Paginated<Product>>(); const latest = deferred<Paginated<Product>>();
    const load = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(latest.promise);
    await render(load);
    const search = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => input(search, 'yeni'));
    await act(async () => searchButton(container).click());
    await act(async () => latest.resolve(page([{ ...product, id: 'latest', name: 'Yeni sonuç' }])));
    await act(async () => initial.resolve(page([{ ...product, id: 'stale', name: 'Eski sonuç' }])));
    expect(container.textContent).toContain('Yeni sonuç'); expect(container.textContent).not.toContain('Eski sonuç');
  });
});
