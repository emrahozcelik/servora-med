import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { listProducts, type Paginated, type Product, type ProductFilters } from './services/products-api';
import { createRequestGate } from './services/request-gate';

const PAGE_SIZE = 25;

type ProductSelectState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<Product> }
  | { kind: 'error'; message: string };

function productMetadata(product: Product) {
  return [
    product.sku ? `SKU ${product.sku}` : null,
    product.model ? `Model ${product.model}` : null,
    product.unit ? `Birim ${product.unit}` : null,
  ].filter((value): value is string => Boolean(value));
}

export function ProductSelect({ selected, onChange, load = listProducts, disabled = false }: {
  selected: Product | null;
  onChange: (product: Product) => void;
  load?: (filters: ProductFilters) => Promise<Paginated<Product>>;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ProductSelectState>({ kind: 'loading' });
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const requestGate = useRef(createRequestGate());

  useEffect(() => {
    const generation = requestGate.current.next();
    setState({ kind: 'loading' });
    load({ status: 'active', q: query, limit: PAGE_SIZE, offset })
      .then((page) => { if (requestGate.current.isCurrent(generation)) setState({ kind: 'ready', page }); })
      .catch((error) => {
        if (requestGate.current.isCurrent(generation)) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : 'Ürünler yüklenemedi.' });
        }
      });
    return () => { requestGate.current.next(); };
  }, [load, offset, query, reload]);

  const submitSearch = useCallback(() => {
    const nextQuery = draftQuery.trim();
    setOffset(0);
    if (nextQuery === query && offset === 0) setReload((value) => value + 1);
    else setQuery(nextQuery);
  }, [draftQuery, offset, query]);

  function searchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitSearch();
  }

  const hasQuery = query.length > 0;
  return <section className="product-select" aria-labelledby="delivery-product-label">
    <input type="hidden" name="productId" value={selected?.id ?? ''} />
    <div className="product-select-search" role="search">
      <label id="delivery-product-label" htmlFor="delivery-product-search">Ürün</label>
      <div className="product-select-search-controls">
        <input id="delivery-product-search" type="search" value={draftQuery} disabled={disabled}
          onChange={(event) => setDraftQuery(event.target.value)} onKeyDown={searchKeyDown}
          placeholder="Ad, SKU, marka veya model" />
        <button className="secondary-button" type="button" disabled={disabled} onClick={submitSearch}>Ürün ara</button>
      </div>
    </div>
    {selected && <div className="product-select-current" role="status"><span>Seçili ürün</span><strong>{selected.name}</strong>
      {productMetadata(selected).length > 0 && <small>{productMetadata(selected).join(' · ')}</small>}</div>}
    <div className="product-select-results" aria-live="polite" aria-busy={state.kind === 'loading'}>
      {state.kind === 'loading' && <p role="status">Aktif ürünler yükleniyor…</p>}
      {state.kind === 'error' && <div className="field-error" role="alert"><p>{state.message}</p>
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => setReload((value) => value + 1)}>Tekrar dene</button></div>}
      {state.kind === 'ready' && state.page.items.length === 0 && <p>{hasQuery ? 'Aramanıza uygun aktif ürün bulunamadı.' : 'Henüz aktif ürün kaydı yok.'}</p>}
      {state.kind === 'ready' && state.page.items.length > 0 && <ul className="product-select-list">
        {state.page.items.map((product) => {
          const metadata = productMetadata(product);
          return <li key={product.id}><button type="button" data-product-id={product.id} aria-pressed={selected?.id === product.id}
            disabled={disabled} onClick={() => onChange(product)}><strong>{product.name}</strong>
            {metadata.length > 0 && <span>{metadata.join(' · ')}</span>}</button></li>;
        })}
      </ul>}
      {state.kind === 'ready' && state.page.total > state.page.limit && <nav className="product-select-pagination" aria-label="Ürün sonuçları sayfaları">
        <button className="secondary-button" type="button" disabled={disabled || state.page.offset === 0}
          onClick={() => setOffset(Math.max(0, state.page.offset - state.page.limit))}>Önceki</button>
        <span>{state.page.offset + 1}–{Math.min(state.page.offset + state.page.limit, state.page.total)} / {state.page.total}</span>
        <button className="secondary-button" type="button" disabled={disabled || state.page.offset + state.page.limit >= state.page.total}
          onClick={() => setOffset(state.page.offset + state.page.limit)}>Sonraki</button>
      </nav>}
    </div>
  </section>;
}
