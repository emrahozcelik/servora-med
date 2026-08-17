/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductSelect } from '../src/ProductSelect';
import type { Paginated, Product, ProductFilters } from '../src/services/products-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const product = (id: string, name: string): Product => ({
  id, organizationId: 'org-1', name, sku: `${id}-sku`, brand: 'Dünya Dental',
  category: null, model: 'M1', unit: 'set', referencePrice: null, isActive: true,
  version: 1, createdAt: '2026-07-13T08:00:00.000Z', updatedAt: '2026-07-13T08:00:00.000Z',
});

const productOne = product('product-1', 'Dental İmplant');
const productTwo = product('product-2', 'Cerrahi Vida');
const productThree = product('product-3', 'Greft Seti');

function page(items: Product[], offset = 0, total = items.length, limit = 8): Paginated<Product> {
  return { items, total, limit, offset };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function input(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function searchButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Ürün ara') as HTMLButtonElement;
}

describe('ProductSelect', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderPicker(
    load: (filters: ProductFilters) => Promise<Paginated<Product>>,
    selectedProducts: Product[] = [],
    onAdd = vi.fn(),
    onRemove = vi.fn(),
  ) {
    await act(async () => root.render(
      <ProductSelect selectedProducts={selectedProducts} onAdd={onAdd} onRemove={onRemove} load={load} />,
    ));
    return { onAdd, onRemove };
  }

  async function search(value: string) {
    const field = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => input(field, value));
    await act(async () => searchButton(container).click());
  }

  it('starts search-first without loading the catalogue', async () => {
    const load = vi.fn().mockResolvedValue(page([productOne]));
    await renderPicker(load);

    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Arama yaparak ürün seçin.');
    expect(container.textContent).toContain('Ürünler');
    expect(container.querySelector('[data-product-id]')).toBeNull();
    expect(container.querySelector('.product-select-pagination')).toBeNull();
  });

  it('searches with limit 8 and renders at most 8 results', async () => {
    const results = Array.from({ length: 8 }, (_, index) => product(`product-${index}`, `Ürün ${index}`));
    const load = vi.fn().mockResolvedValue(page(results, 0, 12));
    await renderPicker(load);
    await search('implant');

    expect(load).toHaveBeenCalledWith({ status: 'active', q: 'implant', limit: 8, offset: 0 });
    expect(container.querySelectorAll('[data-product-id]')).toHaveLength(8);
    expect(container.textContent).toContain('1–8 / 12');
  });

  it('pages server results at the bounded page size', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 8 }, (_, index) => product(`first-${index}`, `İlk ${index}`)), 0, 17))
      .mockResolvedValueOnce(page([product('page-2', 'İkinci sayfa')], 8, 17));
    await renderPicker(load);
    await search('vida');
    await act(async () => (Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Sonraki') as HTMLButtonElement).click());

    expect(load).toHaveBeenLastCalledWith({ status: 'active', q: 'vida', limit: 8, offset: 8 });
    expect(container.textContent).toContain('İkinci sayfa');
    expect(container.textContent).toContain('9–16 / 17');
  });

  it('commits selection, clears the query, and closes results', async () => {
    const load = vi.fn().mockResolvedValue(page([productOne]));
    const { onAdd } = await renderPicker(load);
    await search('implant');
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());

    expect(onAdd).toHaveBeenCalledWith(productOne);
    expect((container.querySelector('#delivery-product-search') as HTMLInputElement).value).toBe('');
    expect(container.querySelector('.product-select-list')).toBeNull();

    await act(async () => root.render(
      <ProductSelect selectedProducts={[productOne]} onAdd={onAdd} onRemove={vi.fn()} load={load} />,
    ));
    expect(container.textContent).toContain('Seçilen ürünler');
    expect(container.querySelector('[data-selected-product-id="product-1"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Kaldır: Dental İmplant"]')).toBeTruthy();
  });

  it('preserves the legacy single-selection consumer contract', async () => {
    const load = vi.fn().mockResolvedValue(page([productTwo]));
    const onChange = vi.fn();
    await act(async () => root.render(
      <ProductSelect selected={productOne} onChange={onChange} load={load} />,
    ));
    expect(container.querySelector('input[name="productId"]')?.getAttribute('value')).toBe('product-1');
    expect(container.querySelector('[data-selected-product-id="product-1"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Kaldır: Dental İmplant"]')).toBeNull();

    await search('vida');
    await act(async () => (container.querySelector('[data-product-id="product-2"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith(productTwo);
  });

  it('supports multiple distinct products and disables a duplicate', async () => {
    const load = vi.fn().mockImplementation(({ q }: ProductFilters) => {
      if (q === 'vida') return Promise.resolve(page([productTwo]));
      if (q === 'greft') return Promise.resolve(page([productThree]));
      return Promise.resolve(page([productOne]));
    });
    const { onAdd } = await renderPicker(load);

    await search('implant');
    await act(async () => (container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement).click());
    await act(async () => root.render(
      <ProductSelect selectedProducts={[productOne]} onAdd={onAdd} onRemove={vi.fn()} load={load} />,
    ));
    await search('vida');
    await act(async () => (container.querySelector('[data-product-id="product-2"]') as HTMLButtonElement).click());
    await act(async () => root.render(
      <ProductSelect selectedProducts={[productOne, productTwo]} onAdd={onAdd} onRemove={vi.fn()} load={load} />,
    ));
    await search('greft');
    await act(async () => (container.querySelector('[data-product-id="product-3"]') as HTMLButtonElement).click());
    expect(onAdd).toHaveBeenCalledTimes(3);

    await act(async () => root.render(
      <ProductSelect selectedProducts={[productOne, productTwo, productThree]} onAdd={onAdd} onRemove={vi.fn()} load={load} />,
    ));
    await search('implant');
    const duplicate = container.querySelector('[data-product-id="product-1"]') as HTMLButtonElement;
    expect(duplicate.disabled).toBe(true);
    expect(duplicate.textContent).toContain('Eklendi');
    await act(async () => duplicate.click());
    expect(onAdd).toHaveBeenCalledTimes(3);
  });

  it('removes only the requested selected product', async () => {
    const onRemove = vi.fn();
    await renderPicker(vi.fn().mockResolvedValue(page([])), [productOne, productTwo], vi.fn(), onRemove);

    await act(async () => (container.querySelector('[aria-label="Kaldır: Dental İmplant"]') as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledWith('product-1');
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('keeps selected products visible while a new search and page are active', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page([productThree], 0, 9))
      .mockResolvedValueOnce(page([productTwo], 8, 9));
    await renderPicker(load, [productOne]);
    await search('greft');
    expect(container.querySelector('[data-selected-product-id="product-1"]')).toBeTruthy();
    await act(async () => (Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Sonraki') as HTMLButtonElement).click());
    expect(container.querySelector('[data-selected-product-id="product-1"]')).toBeTruthy();
    expect(container.textContent).toContain('Cerrahi Vida');
  });

  it('does not let a stale response replace newer results or reopen after selection', async () => {
    const first = deferred<Paginated<Product>>();
    const second = deferred<Paginated<Product>>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { onAdd } = await renderPicker(load);

    await search('matrix');
    await search('cycles');
    await act(async () => second.resolve(page([productTwo])));
    await act(async () => first.resolve(page([productOne])));

    expect(container.textContent).toContain('Cerrahi Vida');
    expect(container.textContent).not.toContain('Dental İmplant');
    await act(async () => (container.querySelector('[data-product-id="product-2"]') as HTMLButtonElement).click());
    expect(onAdd).toHaveBeenCalledWith(productTwo);
    expect(container.querySelector('.product-select-list')).toBeNull();
    expect((container.querySelector('#delivery-product-search') as HTMLInputElement).value).toBe('');
  });

  it('keeps loading, error, retry, and no-results states operable', async () => {
    const pending = deferred<Paginated<Product>>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([]));
    await renderPicker(load);
    await search('bulunmaz');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    await act(async () => pending.reject(new Error('Bağlantı kurulamadı.')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Bağlantı kurulamadı.');
    await act(async () => (Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement).click());
    expect(container.textContent).toContain('Aramanıza uygun aktif ürün bulunamadı.');
  });

  it('submits the same search through the native Enter key', async () => {
    const load = vi.fn().mockResolvedValue(page([productOne]));
    await renderPicker(load);
    const field = container.querySelector('#delivery-product-search') as HTMLInputElement;
    await act(async () => {
      input(field, 'implant');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(load).toHaveBeenCalledWith({ status: 'active', q: 'implant', limit: 8, offset: 0 });
  });
});
