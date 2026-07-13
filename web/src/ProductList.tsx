import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import { listProducts, type Paginated, type Product, type ProductFilters } from './services/products-api';

const PAGE_SIZE = 25;

export type ProductFilterValues = Pick<ProductFilters, 'q' | 'status' | 'offset'>;
export type ProductListState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<Product> }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export function productFiltersFromParams(params: URLSearchParams): ProductFilterValues {
  const status = params.get('status');
  const offsetValue = params.get('offset');
  const offset = offsetValue === null ? NaN : Number(offsetValue);
  return {
    ...(params.get('q') ? { q: params.get('q')! } : {}),
    ...(status === 'active' || status === 'inactive' || status === 'all' ? { status } : {}),
    ...(Number.isInteger(offset) && offset >= 0 ? { offset } : {}),
  };
}

export function updateProductSearchParams(
  current: URLSearchParams,
  name: 'q' | 'status' | 'offset',
  value: string | number,
) {
  const next = new URLSearchParams(current);
  if (value === '') next.delete(name); else next.set(name, String(value));
  if (name === 'q' || name === 'status') next.delete('offset');
  return next;
}

function ProductFiltersView({ filters, onChange }: {
  filters: ProductFilterValues;
  onChange: (name: 'q' | 'status', value: string) => void;
}) {
  return <form className="product-filters" role="search" onSubmit={(event) => event.preventDefault()}>
    <div className="field-group"><label htmlFor="product-search">Ürün ara</label>
      <input id="product-search" type="search" value={filters.q ?? ''} onChange={(event) => onChange('q', event.target.value)} /></div>
    <div className="field-group"><label htmlFor="product-status">Durum</label>
      <select id="product-status" value={filters.status ?? 'active'} onChange={(event) => onChange('status', event.target.value)}>
        <option value="active">Aktif</option><option value="inactive">Pasif</option><option value="all">Tümü</option>
      </select></div>
  </form>;
}

export function ProductListView({ state, user, filters = {}, hasFilters, onFilterChange, onRetry, onOffsetChange }: {
  state: ProductListState;
  user: CurrentUser;
  filters?: ProductFilterValues;
  hasFilters: boolean;
  onFilterChange: (name: 'q' | 'status', value: string) => void;
  onRetry: () => void;
  onOffsetChange?: (offset: number) => void;
}) {
  if (state.kind === 'error' && state.code === 'FORBIDDEN') return <main className="workspace product-workspace">
    <p className="eyebrow">Ürün kataloğu</p><div className="workspace-message" role="alert"><h1>Bu alana erişim yetkiniz yok</h1><p>{state.message}</p></div>
  </main>;

  return <main className="workspace product-workspace">
    <div className="workspace-heading"><div><p className="eyebrow">Ürün kataloğu</p><h1>Ürünler</h1></div>
      {user.role !== 'STAFF' && <Link className="primary-button compact-button product-create-link" to={paths.newProduct}>Yeni ürün</Link>}</div>
    <ProductFiltersView filters={filters} onChange={onFilterChange} />
    {state.kind === 'loading' ? <div className="product-results" aria-busy="true" aria-live="polite">
      <h2 className="sr-only">Ürünler yükleniyor</h2><div className="product-loading" aria-hidden="true"><span /><span /><span /></div>
    </div> : state.kind === 'error' ? <div className="product-results"><div className="workspace-message" role="alert">
      <h2>Ürünler yüklenemedi</h2><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}
    </div></div> : <ProductResults page={state.page} hasFilters={hasFilters} onOffsetChange={onOffsetChange} />}
  </main>;
}

function ProductResults({ page, hasFilters, onOffsetChange }: {
  page: Paginated<Product>;
  hasFilters: boolean;
  onOffsetChange?: (offset: number) => void;
}) {
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return <div className="product-results">
    {page.items.length === 0 ? <div className="workspace-message"><h2>{hasFilters ? 'Filtrelere uygun ürün bulunamadı' : 'Henüz ürün kaydı yok'}</h2>
      <p>{hasFilters ? 'Arama metnini veya durum filtresini değiştirin.' : 'Ürünler eklendiğinde katalog burada görünecek.'}</p></div>
      : <ul className="product-list">{page.items.map((product) => <li key={product.id}><article className="product-row">
        <div className="product-identity"><div className="product-signals"><span>{product.isActive ? 'Aktif' : 'Pasif'}</span><span>{product.category ?? 'Kategori belirtilmedi'}</span></div>
          <h2><Link to={paths.product(product.id)}>{product.name}</Link></h2><p>{product.brand ?? 'Marka belirtilmedi'}{product.model ? ` · ${product.model}` : ''}</p></div>
        <dl className="product-facts"><div><dt>SKU</dt><dd>{product.sku ?? 'Belirtilmedi'}</dd></div><div><dt>Birim</dt><dd>{product.unit ?? 'Belirtilmedi'}</dd></div></dl>
        <Link className="secondary-button product-open" to={paths.product(product.id)} aria-label={`${product.name} ürününü aç`}>Ürünü aç</Link>
      </article></li>)}</ul>}
    {page.total > page.limit && <nav className="product-pagination" aria-label="Ürün sayfaları">
      <button className="secondary-button" type="button" disabled={page.offset === 0} onClick={() => onOffsetChange?.(Math.max(0, page.offset - page.limit))}>Önceki</button>
      <span aria-live="polite">{first}–{last} / {page.total}</span>
      <button className="secondary-button" type="button" disabled={page.offset + page.limit >= page.total} onClick={() => onOffsetChange?.(page.offset + page.limit)}>Sonraki</button>
    </nav>}
  </div>;
}

export function ProductListScreen({ user, load = listProducts }: {
  user: CurrentUser;
  load?: typeof listProducts;
}) {
  const [params, setParams] = useSearchParams();
  const filters = productFiltersFromParams(params);
  const [state, setState] = useState<ProductListState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const queryKey = params.toString();

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    load({ ...filters, limit: PAGE_SIZE }).then((page) => { if (active) setState({ kind: 'ready', page }); })
      .catch((caught) => {
        if (!active) return;
        const error = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'Ürünler yüklenemedi.', true);
        setState({ kind: 'error', code: error.code, message: error.message, retryable: error.retryable });
      });
    return () => { active = false; };
  // queryKey represents the URL-owned filters; filters is intentionally reconstructed from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, queryKey, reload]);

  const hasFilters = Boolean(filters.q || filters.status === 'inactive');
  return <ProductListView state={state} user={user} filters={filters} hasFilters={hasFilters}
    onFilterChange={(name, value) => setParams(updateProductSearchParams(params, name, value))}
    onOffsetChange={(offset) => setParams(updateProductSearchParams(params, 'offset', offset))}
    onRetry={() => setReload((value) => value + 1)} />;
}
