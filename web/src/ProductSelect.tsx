import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { listProducts, type Paginated, type Product, type ProductFilters } from './services/products-api';
import { createRequestGate } from './services/request-gate';

const PAGE_SIZE = 8;

type ProductSelectState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<Product> }
  | { kind: 'error'; message: string };

type ProductSelectBaseProps = {
  load?: (filters: ProductFilters) => Promise<Paginated<Product>>;
  disabled?: boolean;
};

type MultiProductSelectProps = ProductSelectBaseProps & {
  selectedProducts: Product[];
  onAdd: (product: Product) => void;
  onRemove: (productId: string) => void;
  selected?: never;
  onChange?: never;
};

type SingleProductSelectProps = ProductSelectBaseProps & {
  selected: Product | null;
  onChange: (product: Product) => void;
  selectedProducts?: never;
  onAdd?: never;
  onRemove?: never;
};

export type ProductSelectProps = MultiProductSelectProps | SingleProductSelectProps;

function productMetadata(product: Product) {
  return [
    product.sku ? `SKU ${product.sku}` : null,
    product.brand ? `Marka ${product.brand}` : null,
    product.model ? `Model ${product.model}` : null,
    product.unit ? `Birim ${product.unit}` : null,
  ].filter((value): value is string => Boolean(value));
}

export function ProductSelect(props: ProductSelectProps) {
  const {
    load = listProducts,
    disabled = false,
  } = props;
  const isMulti = 'selectedProducts' in props;
  const selectedProducts: Product[] = isMulti
    ? (props as MultiProductSelectProps).selectedProducts
    : props.selected ? [props.selected] : [];
  const addProduct = isMulti
    ? (props as MultiProductSelectProps).onAdd
    : (props as SingleProductSelectProps).onChange;
  const removeProduct = isMulti ? (props as MultiProductSelectProps).onRemove : undefined;
  const [state, setState] = useState<ProductSelectState>({ kind: 'idle' });
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestGate = useRef(createRequestGate());

  useEffect(() => {
    if (!query || !searchOpen) {
      setState({ kind: 'idle' });
      return;
    }
    const generation = requestGate.current.next();
    setState({ kind: 'loading' });
    load({ status: 'active', q: query, limit: PAGE_SIZE, offset })
      .then((page) => {
        if (requestGate.current.isCurrent(generation)) setState({ kind: 'ready', page });
      })
      .catch((error) => {
        if (requestGate.current.isCurrent(generation)) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : 'Ürünler yüklenemedi.' });
        }
      });
    return () => { requestGate.current.next(); };
  }, [load, offset, query, reload, searchOpen]);

  const submitSearch = useCallback(() => {
    const nextQuery = draftQuery.trim();
    requestGate.current.next();
    setOffset(0);
    if (!nextQuery) {
      setQuery('');
      setSearchOpen(false);
      setState({ kind: 'idle' });
      return;
    }
    setSearchOpen(true);
    if (nextQuery === query && offset === 0) setReload((value) => value + 1);
    else setQuery(nextQuery);
  }, [draftQuery, offset, query]);

  function searchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitSearch();
  }

  function selectProduct(product: Product) {
    if (selectedProducts.some((selected) => selected.id === product.id)) return;
    addProduct(product);
    requestGate.current.next();
    setDraftQuery('');
    setQuery('');
    setOffset(0);
    setSearchOpen(false);
    setState({ kind: 'idle' });
    searchInputRef.current?.focus();
  }

  return <section className="product-select" aria-labelledby="delivery-product-label">
    {!isMulti && <input type="hidden" name="productId" value={selectedProducts[0]?.id ?? ''} />}
    <div className="product-select-search" role="search">
      <label id="delivery-product-label" htmlFor="delivery-product-search">Ürünler</label>
      <div className="product-select-search-controls">
        <input ref={searchInputRef} id="delivery-product-search" type="search" value={draftQuery} disabled={disabled}
          onChange={(event) => setDraftQuery(event.target.value)} onKeyDown={searchKeyDown}
          placeholder="Ad, SKU, marka veya model" />
        <button className="secondary-button" type="button" disabled={disabled} onClick={submitSearch}>Ürün ara</button>
      </div>
    </div>
    {selectedProducts.length > 0 && <div className="product-select-selected" aria-labelledby="selected-products-heading">
      <h2 id="selected-products-heading">Seçilen ürünler</h2>
      <ul className="product-select-selected-list">
        {selectedProducts.map((product) => {
          const metadata = productMetadata(product);
          return <li key={product.id} data-selected-product-id={product.id}>
            <div><strong>{product.name}</strong>{metadata.length > 0 && <small>{metadata.join(' · ')}</small>}</div>
            {removeProduct && <button className="secondary-button" type="button"
              aria-label={`Kaldır: ${product.name}`} disabled={disabled}
              onClick={() => removeProduct(product.id)}>Kaldır</button>}
          </li>;
        })}
      </ul>
    </div>}
    <div className="product-select-results" aria-live="polite" aria-busy={state.kind === 'loading'}>
      {state.kind === 'idle' && <p>Arama yaparak ürün seçin.</p>}
      {state.kind === 'loading' && <p role="status">Aktif ürünler yükleniyor…</p>}
      {state.kind === 'error' && <div className="field-error" role="alert"><p>{state.message}</p>
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => setReload((value) => value + 1)}>Tekrar dene</button></div>}
      {searchOpen && state.kind === 'ready' && state.page.items.length === 0 && <p>Aramanıza uygun aktif ürün bulunamadı.</p>}
      {searchOpen && state.kind === 'ready' && state.page.items.length > 0 && <ul className="product-select-list">
        {state.page.items.map((product) => {
          const metadata = productMetadata(product);
          const alreadySelected = selectedProducts.some((selected) => selected.id === product.id);
          return <li key={product.id}><button type="button" data-product-id={product.id}
            aria-pressed={alreadySelected} disabled={disabled || alreadySelected}
            onClick={() => selectProduct(product)}><strong>{product.name}</strong>
            {alreadySelected ? <span>Eklendi</span> : metadata.length > 0 && <span>{metadata.join(' · ')}</span>}
          </button></li>;
        })}
      </ul>}
      {searchOpen && state.kind === 'ready' && state.page.total > state.page.limit && <nav className="product-select-pagination" aria-label="Ürün sonuçları sayfaları">
        <button className="secondary-button" type="button" disabled={disabled || state.page.offset === 0}
          onClick={() => setOffset(Math.max(0, state.page.offset - state.page.limit))}>Önceki</button>
        <span>{state.page.offset + 1}–{Math.min(state.page.offset + state.page.limit, state.page.total)} / {state.page.total}</span>
        <button className="secondary-button" type="button" disabled={disabled || state.page.offset + state.page.limit >= state.page.total}
          onClick={() => setOffset(state.page.offset + state.page.limit)}>Sonraki</button>
      </nav>}
    </div>
  </section>;
}
