import {
  useEffect, useRef, useState, type MouseEvent,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  deleteProduct, listProducts, type Paginated, type Product, type ProductFilters,
} from './services/products-api';
import { ConfirmationAction } from './ui/antd';
import { isInteractiveTarget } from './ui/clickable-card';

const PAGE_SIZE = 25;

export type ProductFilterValues = Pick<ProductFilters, 'q' | 'offset'>;
export type ProductListState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<Product> }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export function productFiltersFromParams(params: URLSearchParams): ProductFilterValues {
  const offsetValue = params.get('offset');
  const offset = offsetValue === null ? NaN : Number(offsetValue);
  return {
    ...(params.get('q') ? { q: params.get('q')! } : {}),
    ...(Number.isInteger(offset) && offset >= 0 ? { offset } : {}),
  };
}

export function updateProductSearchParams(
  current: URLSearchParams,
  name: 'q' | 'offset',
  value: string | number,
) {
  const next = new URLSearchParams(current);
  if (value === '') next.delete(name); else next.set(name, String(value));
  if (name === 'q') next.delete('offset');
  return next;
}

function ProductFiltersView({ filters, onChange }: {
  filters: ProductFilterValues;
  onChange: (name: 'q', value: string) => void;
}) {
  return <form className="product-filters" role="search" onSubmit={(event) => event.preventDefault()}>
    <div className="field-group"><label htmlFor="product-search">Ürün ara</label>
      <input id="product-search" type="search" value={filters.q ?? ''} onChange={(event) => onChange('q', event.target.value)} /></div>
  </form>;
}

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function ProductListView({ state, user, filters = {}, hasFilters, onFilterChange, onRetry, onOffsetChange, onOpenProduct, onRequestDelete, feedback = '', actionError = '' }: {
  state: ProductListState;
  user: CurrentUser;
  filters?: ProductFilterValues;
  hasFilters: boolean;
  onFilterChange: (name: 'q', value: string) => void;
  onRetry: () => void;
  onOffsetChange?: (offset: number) => void;
  onOpenProduct?: (productId: string) => void;
  onRequestDelete?: (product: Product, trigger: HTMLButtonElement) => void;
  feedback?: string;
  actionError?: string;
}) {
  const canManage = user.role !== 'STAFF';

  if (state.kind === 'error' && state.code === 'FORBIDDEN') return <main className="workspace product-workspace">
    <p className="eyebrow">Ürün kataloğu</p><div className="workspace-message" role="alert"><h1>Bu alana erişim yetkiniz yok</h1><p>{state.message}</p></div>
  </main>;

  return <main className="workspace product-workspace">
    <div className="workspace-heading"><div><p className="eyebrow">Ürün kataloğu</p><h1>Ürünler</h1></div>
      {canManage && <Link className="primary-button compact-button product-create-link" to={paths.newProduct}>Yeni ürün</Link>}</div>
    <ProductFiltersView filters={filters} onChange={onFilterChange} />
    <div className="sr-only" role="status" aria-live="polite">{feedback}</div>
    {actionError && <div className="workspace-message" role="alert"><p>{actionError}</p></div>}
    {state.kind === 'loading' ? <div className="product-results" aria-busy="true" aria-live="polite">
      <h2 className="sr-only">Ürünler yükleniyor</h2><div className="product-loading" aria-hidden="true"><span /><span /><span /></div>
    </div> : state.kind === 'error' ? <div className="product-results"><div className="workspace-message" role="alert">
      <h2>Ürünler yüklenemedi</h2><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}
    </div></div> : <ProductResults page={state.page} canManage={canManage} hasFilters={hasFilters}
      onOffsetChange={onOffsetChange} onOpenProduct={onOpenProduct} onRequestDelete={onRequestDelete} />}
  </main>;
}

function ProductResults({ page, canManage, hasFilters, onOffsetChange, onOpenProduct, onRequestDelete }: {
  page: Paginated<Product>;
  canManage: boolean;
  hasFilters: boolean;
  onOffsetChange?: (offset: number) => void;
  onOpenProduct?: (productId: string) => void;
  onRequestDelete?: (product: Product, trigger: HTMLButtonElement) => void;
}) {
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return <div className="product-results">
    {page.items.length === 0 ? <div className="workspace-message"><h2>{hasFilters ? 'Filtrelere uygun ürün bulunamadı' : 'Henüz ürün kaydı yok'}</h2>
      <p>{hasFilters ? 'Arama metnini değiştirin.' : 'Ürünler eklendiğinde katalog burada görünecek.'}</p></div>
      : <ul className="product-list">{page.items.map((product) => <li key={product.id}>
        <article className="product-row product-list-card" data-product-id={product.id}
          onClick={(event) => openCardIfEmpty(event, onOpenProduct, product.id)}>
          <div className="product-identity"><div className="product-signals"><span>{product.category ?? 'Kategori belirtilmedi'}</span></div>
            <h2><Link className="product-title-link" to={paths.product(product.id)}>{product.name}</Link></h2>
            <p>{product.brand ?? 'Marka belirtilmedi'}{product.model ? ` · ${product.model}` : ''}</p></div>
          <dl className="product-facts"><div><dt>SKU</dt><dd>{product.sku ?? 'Belirtilmedi'}</dd></div><div><dt>Birim</dt><dd>{product.unit ?? 'Belirtilmedi'}</dd></div></dl>
          {canManage && <div className="product-row-commands">
            <Link className="secondary-button" to={paths.product(product.id)}
              aria-label={`${product.name} ürününü düzenle`}>Düzenle</Link>
            <button className="destructive-button" type="button"
              aria-label={`${product.name} ürününü sil`}
              onClick={(event) => onRequestDelete?.(product, event.currentTarget)}>Sil</button>
          </div>}
        </article></li>)}</ul>}
    {page.total > page.limit && <nav className="product-pagination" aria-label="Ürün sayfaları">
      <button className="secondary-button" type="button" disabled={page.offset === 0} onClick={() => onOffsetChange?.(Math.max(0, page.offset - page.limit))}>Önceki</button>
      <span aria-live="polite">{first}–{last} / {page.total}</span>
      <button className="secondary-button" type="button" disabled={page.offset + page.limit >= page.total} onClick={() => onOffsetChange?.(page.offset + page.limit)}>Sonraki</button>
    </nav>}
  </div>;
}

export function ProductListScreen({ user, load = listProducts, remove = deleteProduct }: {
  user: CurrentUser;
  load?: typeof listProducts;
  remove?: typeof deleteProduct;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = productFiltersFromParams(params);
  const [state, setState] = useState<ProductListState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const queryKey = params.toString();

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    load({ ...filters, status: 'active', limit: PAGE_SIZE }).then((page) => {
        if (!active) return;
        if (page.total > 0 && page.items.length === 0 && page.offset >= page.total) {
          const validOffset = Math.floor((page.total - 1) / page.limit) * page.limit;
          setParams(updateProductSearchParams(params, 'offset', validOffset));
          return;
        }
        setState({ kind: 'ready', page });
      })
      .catch((caught) => {
        if (!active) return;
        const error = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'Ürünler yüklenemedi.', true);
        setState({ kind: 'error', code: error.code, message: error.message, retryable: error.retryable });
      });
    return () => { active = false; };
  // queryKey represents the URL-owned filters; filters is intentionally reconstructed from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, queryKey, reload]);

  function requestDelete(product: Product, trigger: HTMLButtonElement) {
    if (deletePending) return;
    deleteTriggerRef.current = trigger;
    setActionError('');
    setDeleteTarget(product);
  }

  async function confirmDelete() {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    setActionError('');
    try {
      await remove(deleteTarget.id, deleteTarget.version);
      const name = deleteTarget.name;
      setDeleteTarget(null);
      setFeedback(`${name} silindi.`);
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Ürün silinemedi.');
      setDeleteTarget(null);
    } finally {
      setDeletePending(false);
    }
  }

  const hasFilters = Boolean(filters.q);
  return <>
    <ProductListView state={state} user={user} filters={filters} hasFilters={hasFilters}
      onFilterChange={(name, value) => setParams(updateProductSearchParams(params, name, value))}
      onOffsetChange={(offset) => setParams(updateProductSearchParams(params, 'offset', offset))}
      onRetry={() => setReload((value) => value + 1)}
      onOpenProduct={(productId) => navigate(paths.product(productId))}
      onRequestDelete={requestDelete} feedback={feedback} actionError={actionError} />
    <ConfirmationAction
      open={deleteTarget !== null}
      title={deleteTarget ? `${deleteTarget.name} ürününü sil` : 'Ürünü sil'}
      description="Bu işlem geri alınamaz. Ürün katalogdan kalıcı olarak silinir."
      confirmLabel="Sil"
      pending={deletePending}
      pendingLabel="Siliniyor…"
      destructive
      returnFocusRef={deleteTriggerRef}
      onCancel={() => { if (!deletePending) setDeleteTarget(null); }}
      onConfirm={() => { void confirmDelete(); }}
    />
  </>;
}
