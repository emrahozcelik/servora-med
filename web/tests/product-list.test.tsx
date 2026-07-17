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
import { ApiError, type CurrentUser } from '../src/services/api';
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

  it('treats empty catalog without a query as the initial catalog state', () => {
    const filters = productFiltersFromParams(new URLSearchParams());
    const html = renderToStaticMarkup(<MemoryRouter><ProductListView state={{ kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } }}
      user={manager} filters={filters} hasFilters={false} onFilterChange={() => {}} onRetry={() => {}} /></MemoryRouter>);
    expect(html).toContain('Henüz ürün kaydı yok');
    expect(html).not.toContain('Filtrelere uygun ürün bulunamadı');
  });

  it('uses semantic structured rows with visible operational labels', () => {
    const html = render({ kind: 'ready', page: { items: [product], total: 1, limit: 25, offset: 0 } });
    expect(html).toContain('<ul'); expect(html).toContain('<article');
    expect(html).toContain('Dental İmplant Seti'); expect(html).toContain('İmplant');
    expect(html).toContain('SKU'); expect(html).toContain('IMP-01');
    expect(html).toContain('Birim'); expect(html).toContain('set');
    expect(html).toContain('/products/product-1');
    expect(html).toContain('product-list-card');
    expect(html).toContain('product-title-link');
    expect(html).not.toContain('Ürünü aç');
    expect(html).not.toContain('Aktif');
    expect(html).not.toContain('Pasif');
    expect(html).not.toContain('product-status');
  });

  it('keeps Staff read-only while Manager can create, edit, and delete', () => {
    const ready = { kind: 'ready', page: { items: [], total: 0, limit: 25, offset: 0 } } as const;
    expect(render(ready, staff)).not.toContain('Yeni ürün');
    expect(render(ready, manager)).toContain('Yeni ürün');
    const staffHtml = render({ kind: 'ready', page: { items: [product], total: 1, limit: 25, offset: 0 } }, staff);
    expect(staffHtml).not.toContain('ürününü düzenle');
    expect(staffHtml).not.toContain('ürününü sil');
    const managerHtml = render({ kind: 'ready', page: { items: [product], total: 1, limit: 25, offset: 0 } }, manager);
    expect(managerHtml).toContain('aria-label="Dental İmplant Seti ürününü düzenle"');
    expect(managerHtml).toContain('aria-label="Dental İmplant Seti ürününü sil"');
    expect(managerHtml).toContain('Düzenle');
    expect(managerHtml).toContain('Sil');
  });

  it('restores q/offset from the URL and resets offset when search changes', () => {
    expect(productFiltersFromParams(new URLSearchParams('q=implant&status=inactive&offset=50')))
      .toEqual({ q: 'implant', offset: 50 });
    expect(updateProductSearchParams(new URLSearchParams('q=implant&offset=50'), 'q', 'vida').toString())
      .toBe('q=vida');
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

  it('resets offset for search changes and writes pagination to the URL', async () => {
    const load = vi.fn().mockImplementation(async (filters: { offset?: number; status?: string }) => {
      expect(filters.status).toBe('active');
      return page([product], filters.offset ?? 0, 80);
    });
    const router = await mount('/products?q=implant&offset=25', load); await act(async () => { await Promise.resolve(); });
    const search = container.querySelector('#product-search') as HTMLInputElement;
    await act(async () => change(search, 'vida')); await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search).toBe('?q=vida');
    await act(async () => (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki') as HTMLButtonElement).click());
    expect(router.state.location.search).toBe('?q=vida&offset=25');
  });

  it('retries a routed request and classifies empty response as initial-empty', async () => {
    const request = deferred<ReturnType<typeof page>>(); const load = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValueOnce(page([]));
    await mount('/products', load);
    await act(async () => request.reject(new Error('Bağlantı kurulamadı.')));
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement;
    expect(retry).toBeTruthy(); await act(async () => retry.click()); await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('Henüz ürün kaydı yok');
    expect(container.textContent).not.toContain('Filtrelere uygun ürün bulunamadı');
  });

  it('confirms Product delete without optimistic removal', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn()
      .mockResolvedValueOnce(page([product]))
      .mockResolvedValueOnce(page([]));
    const router = createMemoryRouter([{
      path: '/products',
      element: <ProductListScreen user={manager} load={load} remove={remove} />,
    }], { initialEntries: ['/products'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await Promise.resolve(); });

    const deleteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Dental İmplant Seti ürününü sil') as HTMLButtonElement;
    await act(async () => deleteButton.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Dental İmplant Seti ürününü sil');
    expect(container.textContent).toContain('Dental İmplant Seti');
    expect(remove).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.className.includes('destructive')) as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => { await Promise.resolve(); });
    expect(remove).toHaveBeenCalledWith('product-1', 1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Dental İmplant Seti silindi.');
    expect(container.textContent).toContain('Henüz ürün kaydı yok');
  });

  it('keeps the Product row when delete is blocked by operation history', async () => {
    const remove = vi.fn().mockRejectedValue(new ApiError(
      409, 'PRODUCT_HAS_OPERATION_HISTORY',
      'Bu ürün geçmiş teslimat veya satış kayıtlarında kullanıldığı için silinemez.',
    ));
    const load = vi.fn().mockResolvedValue(page([product]));
    const router = createMemoryRouter([{
      path: '/products',
      element: <ProductListScreen user={manager} load={load} remove={remove} />,
    }], { initialEntries: ['/products'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await Promise.resolve(); });

    const deleteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Dental İmplant Seti ürününü sil') as HTMLButtonElement;
    await act(async () => deleteButton.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.className.includes('destructive')) as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Bu ürün geçmiş teslimat veya satış kayıtlarında kullanıldığı için silinemez.');
    expect(container.textContent).toContain('Dental İmplant Seti');
    expect(remove).toHaveBeenCalledWith('product-1', 1);
  });

  it('clamps empty trailing page offset after product delete', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn()
      .mockResolvedValueOnce(page([product], 25, 26))
      .mockResolvedValueOnce(page([], 25, 25))
      .mockResolvedValueOnce(page([product], 0, 25));
    const router = createMemoryRouter([{
      path: '/products',
      element: <ProductListScreen user={manager} load={load} remove={remove} />,
    }], { initialEntries: ['/products?offset=25'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Dental İmplant Seti');

    const deleteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Dental İmplant Seti ürününü sil') as HTMLButtonElement;
    await act(async () => deleteButton.click());
    const confirm = Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll('button'))
      .find((button) => button.className.includes('destructive')) as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.search === '' || router.state.location.search === '?offset=0').toBe(true);
    expect(remove).toHaveBeenCalledWith('product-1', 1);
  });
});
