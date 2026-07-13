import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import {
  ProductListView,
  productFiltersFromParams,
  updateProductSearchParams,
  type ProductListState,
} from '../src/ProductList';
import type { CurrentUser } from '../src/services/api';
import type { Product } from '../src/services/products-api';

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
