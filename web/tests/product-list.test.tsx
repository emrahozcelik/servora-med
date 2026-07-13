/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProductListView,
  ProductListScreen,
  productFiltersFromParams,
  updateProductSearchParams,
  type ProductListState,
} from '../src/ProductList';
import type { CurrentUser } from '../src/services/api';
import type { Product } from '../src/services/products-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const staff: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe', role: 'STAFF' };
const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'Dental İmplant Seti', sku: 'IMP-01',
  brand: 'Servora', category: 'İmplant', model: 'M1', unit: 'set', referencePrice: 1250,
  isActive: true, version: 1, createdAt: '2026-07-13T08:00:00.000Z', updatedAt: '2026-07-13T08:00:00.000Z',
};

function render(state: ProductListState, user = manager, hasFilters = false) {
  return renderToStaticMarkup(<MemoryRouter><ProductListView state={state} user={user} hasFilters={hasFilters}
    filters={{}} onFilterChange={() => {}} onRetry={() => {}} /></MemoryRouter>);
}

describe('Product list', () => {
  it('renders explicit loading, empty, no-results, retry, and forbidden states', () => {
    expect(render({ kind: 'loading' })).toContain('aria-busy="true"');
    expect(render({ kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } })).toContain('Henüz ürün kaydı yok');
    expect(render({ kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } }, manager, true)).toContain('Filtrelere uygun ürün bulunamadı');
    const retry = render({ kind: 'error', code: 'NETWORK_ERROR', message: 'Bağlantı kurulamadı.', retryable: true });
    expect(retry).toContain('role="alert"'); expect(retry).toContain('Tekrar dene');
    const forbidden = render({ kind: 'error', code: 'FORBIDDEN', message: 'Yetkiniz yok.', retryable: false });
    expect(forbidden).toContain('Bu alana erişim yetkiniz yok'); expect(forbidden).not.toContain('Tekrar dene');
  });

  it('treats status all without a query as the initial catalog state', () => {
    const filters = productFiltersFromParams(new URLSearchParams('status=all'));
    const html = renderToStaticMarkup(<MemoryRouter><ProductListView state={{ kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } }}
      user={manager} filters={filters} hasFilters={false} onFilterChange={() => {}} onRetry={() => {}} /></MemoryRouter>);
    expect(html).toContain('Henüz ürün kaydı yok');
    expect(html).not.toContain('Filtrelere uygun ürün bulunamadı');
  });

  it('uses semantic structured rows with visible operational labels', () => {
    const html = render({ kind: 'ready', page: { items: [product], total: 1, limit: 25, offset: 0 } });
    expect(html).toContain('<ul'); expect(html).toContain('<article');
    expect(html).toContain('Dental İmplant Seti'); expect(html).toContain('Aktif');
    expect(html).toContain('SKU'); expect(html).toContain('IMP-01');
    expect(html).toContain('Birim'); expect(html).toContain('set');
    expect(html).toContain('/products/product-1');
  });

  it('keeps Staff read-only while Manager can create', () => {
    const ready = { kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } } as const;
    expect(render(ready, staff)).not.toContain('Yeni ürün');
    expect(render(ready, manager)).toContain('Yeni ürün');
  });

  it('restores q/status/offset from the URL and resets offset when a filter changes', () => {
    expect(productFiltersFromParams(new URLSearchParams('q=implant&status=inactive&offset=50')))
      .toEqual({ q: 'implant', status: 'inactive', offset: 50 });
    expect(updateProductSearchParams(new URLSearchParams('q=implant&status=inactive&offset=50'), 'q', 'vida').toString())
      .toBe('q=vida&status=inactive');
    expect(updateProductSearchParams(new URLSearchParams('q=implant&status=inactive&offset=50'), 'status', 'all').toString())
      .toBe('q=implant&status=all');
  });

  it('shows explicit previous and next controls from page metadata', () => {
    const html = render({ kind: 'ready', page: { items: [product], total: 80, limit: 25, offset: 25 } });
    expect(html).toContain('Önceki'); expect(html).toContain('Sonraki'); expect(html).toContain('26–50 / 80');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function page(items: Product[], offset = 0, total = items.length) {
  return { items, total, limit: 25, offset };
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('routed Product list screen', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  async function mount(initialEntry: string, load: Parameters<typeof ProductListScreen>[0]['load']) {
    const router = createMemoryRouter([{ path: '/products', element: <ProductListScreen user={manager} load={load} /> }], { initialEntries: [initialEntry] });
    await act(async () => root.render(<RouterProvider router={router} />));
    return router;
  }

  it('keeps focused search operable through multi-character pending refetches and ignores stale results', async () => {
    const older = deferred<ReturnType<typeof page>>(); const latest = deferred<ReturnType<typeof page>>();
    const load = vi.fn().mockResolvedValueOnce(page([])).mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const router = await mount('/products', load); await act(async () => { await Promise.resolve(); });
    const search = container.querySelector('#product-search') as HTMLInputElement; search.focus();

    await act(async () => change(search, 'i'));
    expect(router.state.location.search).toBe('?q=i'); expect(document.activeElement).toBe(search);
    expect(container.querySelector('#product-search')).toBe(search);
    expect(container.querySelector('.product-results')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => change(search, 'im'));
    expect(router.state.location.search).toBe('?q=im'); expect(document.activeElement).toBe(search);
    await act(async () => latest.resolve(page([{ ...product, id: 'latest', name: 'İmplant' }])));
    await act(async () => older.resolve(page([{ ...product, id: 'older', name: 'Eski sonuç' }])));
    expect(container.textContent).toContain('İmplant'); expect(container.textContent).not.toContain('Eski sonuç');
  });

  it('resets offset for q/status changes and writes pagination to the URL', async () => {
    const load = vi.fn().mockImplementation(async (filters: { offset?: number }) => page([product], filters.offset ?? 0, 80));
    const router = await mount('/products?q=implant&status=inactive&offset=25', load); await act(async () => { await Promise.resolve(); });
    const search = container.querySelector('#product-search') as HTMLInputElement;
    await act(async () => change(search, 'vida')); await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=vida&status=inactive');
    const status = container.querySelector('#product-status') as HTMLSelectElement;
    await act(async () => change(status, 'all')); await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=vida&status=all');
    await act(async () => (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki') as HTMLButtonElement).click());
    expect(router.state.location.search).toBe('?q=vida&status=all&offset=25');
  });

  it('retries a routed request and classifies status all empty response as initial-empty', async () => {
    const request = deferred<ReturnType<typeof page>>(); const load = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValueOnce(page([]));
    await mount('/products?status=all', load);
    await act(async () => request.reject(new Error('Bağlantı kurulamadı.')));
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement;
    expect(retry).toBeTruthy(); await act(async () => retry.click()); await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('Henüz ürün kaydı yok');
    expect(container.textContent).not.toContain('Filtrelere uygun ürün bulunamadı');
  });
});
