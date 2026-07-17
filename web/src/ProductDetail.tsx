import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ProductForm, productInputFromFormData, productServerFieldErrors } from './ProductForm';
import { ApiError, type CurrentUser } from './services/api';
import {
  getProduct, updateProduct, type CreateProductInput, type Product,
} from './services/products-api';

type ProductDetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; product: Product }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

type ProductDetailProps = {
  productId: string;
  user: CurrentUser;
  load?: typeof getProduct;
  update?: typeof updateProduct;
};

function apiError(caught: unknown, fallback: string) {
  return caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', fallback, true);
}

function safeCurrentVersion(error: ApiError) {
  const value = error.details?.currentVersion;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function ProductLoadError({ state, onRetry }: {
  state: Extract<ProductDetailState, { kind: 'error' }>;
  onRetry: () => void;
}) {
  if (state.code === 'PRODUCT_NOT_FOUND') return <main className="workspace product-workspace">
    <p className="eyebrow">Ürün kataloğu</p><div className="workspace-message" role="alert">
      <h1>Ürün bulunamadı</h1><p>Bu ürün kaldırılmış veya bağlantı değişmiş olabilir.</p>
    </div>
  </main>;
  if (state.code === 'FORBIDDEN') return <main className="workspace product-workspace">
    <p className="eyebrow">Ürün kataloğu</p><div className="workspace-message" role="alert">
      <h1>Bu ürünü görüntüleme yetkiniz yok</h1><p>{state.message}</p>
    </div>
  </main>;
  return <main className="workspace product-workspace">
    <p className="eyebrow">Ürün kataloğu</p><div className="workspace-message" role="alert">
      <h1>Ürün yüklenemedi</h1><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}
    </div>
  </main>;
}

function ProductFacts({ product }: { product: Product }) {
  const absent = (value: string | number | null) => value === null ? 'Belirtilmedi' : String(value);
  return <dl className="product-detail-facts">
    <div><dt>SKU</dt><dd>{absent(product.sku)}</dd></div>
    <div><dt>Marka</dt><dd>{absent(product.brand)}</dd></div>
    <div><dt>Kategori</dt><dd>{absent(product.category)}</dd></div>
    <div><dt>Model</dt><dd>{absent(product.model)}</dd></div>
    <div><dt>Birim</dt><dd>{absent(product.unit)}</dd></div>
    <div><dt>Referans fiyat</dt><dd>{absent(product.referencePrice)}</dd></div>
    <div><dt>Sürüm</dt><dd>{product.version}</dd></div>
    <div><dt>Son güncelleme</dt><dd>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' }).format(new Date(product.updatedAt))}</dd></div>
  </dl>;
}

export function ProductDetailScreen({ productId, user, load = getProduct, update = updateProduct }: ProductDetailProps) {
  const [state, setState] = useState<ProductDetailState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof productServerFieldErrors>>({});
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [conflictVersion, setConflictVersion] = useState<number | null | undefined>(undefined);
  const editErrorRef = useRef<HTMLDivElement>(null);
  const [editFocusTarget, setEditFocusTarget] = useState<'summary' | 'name' | 'referencePrice' | null>(null);

  useEffect(() => {
    if (editFocusTarget === 'summary') editErrorRef.current?.focus();
    if (editFocusTarget === 'name') document.getElementById('product-name')?.focus();
    if (editFocusTarget === 'referencePrice') document.getElementById('product-reference-price')?.focus();
    if (editFocusTarget) setEditFocusTarget(null);
  }, [editFocusTarget, error, fieldErrors]);

  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    load(productId).then((product) => { if (active) setState({ kind: 'ready', product }); })
      .catch((caught) => {
        if (!active) return;
        const next = apiError(caught, 'Ürün yüklenemedi.');
        setState({ kind: 'error', code: next.code, message: next.message, retryable: next.retryable });
      });
    return () => { active = false; };
  }, [load, productId, reload]);

  if (state.kind === 'loading') return <main className="workspace product-workspace" aria-busy="true" aria-live="polite">
    <p className="eyebrow">Ürün kataloğu</p><h1>Ürün detayı yükleniyor</h1>
  </main>;
  if (state.kind === 'error') return <ProductLoadError state={state} onRetry={() => setReload((value) => value + 1)} />;

  const { product } = state;
  const canManage = user.role !== 'STAFF';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setFieldErrors({}); setFeedback(''); setConflictVersion(undefined);
    let input: CreateProductInput;
    try {
      input = productInputFromFormData(new FormData(event.currentTarget));
      if (!input.name) {
        setError('Ürün adı zorunludur.'); setFieldErrors({ name: 'Ürün adı zorunludur.' }); setEditFocusTarget('name'); return;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Alanları kontrol edin.';
      setError('Ürün güncellenemedi. Alanları kontrol edin.');
      setFieldErrors({ referencePrice: message }); setEditFocusTarget('summary'); return;
    }
    setPending(true);
    try {
      const updated = await update(productId, { ...input, expectedVersion: product.version });
      setState({ kind: 'ready', product: updated }); setEditing(false); setFeedback('Ürün bilgileri güncellendi.');
    } catch (caught) {
      const next = apiError(caught, 'Ürün güncellenemedi.');
      if (next.code === 'VERSION_CONFLICT') {
        setConflictVersion(safeCurrentVersion(next));
        setError('');
      } else {
        const nextFieldErrors = productServerFieldErrors(next);
        setError(next.message); setFieldErrors(nextFieldErrors);
        setEditFocusTarget(nextFieldErrors.name ? 'name' : nextFieldErrors.referencePrice ? 'referencePrice' : 'summary');
      }
    } finally { setPending(false); }
  }

  async function reloadCurrentValues() {
    setPending(true); setError('');
    try {
      const current = await load(productId);
      setState({ kind: 'ready', product: current }); setConflictVersion(undefined); setFormKey((value) => value + 1);
    } catch (caught) { setError(apiError(caught, 'Güncel ürün değerleri yüklenemedi.').message); }
    finally { setPending(false); }
  }

  if (editing) return <>
    {conflictVersion !== undefined && <div className="conflict-actions product-edit-conflict" role="alert">
      <p>Ürün başka bir kullanıcı tarafından güncellendi. Formdaki değişiklikleriniz korunuyor.
        {conflictVersion !== null && <> Güncel sürüm: {conflictVersion}.</>}{error && <> {error}</>}</p>
      <button className="secondary-button" type="button" onClick={() => void reloadCurrentValues()} disabled={pending}>Güncel değerleri yükle</button>
    </div>}
    <ProductForm key={formKey} pending={pending} fieldErrors={fieldErrors} error={conflictVersion === undefined ? error : ''} errorRef={editErrorRef}
      initialProduct={product} title="Ürünü düzenle" intro="Katalog bilgisini güncelleyin. Kaydetme sırasında mevcut sürüm doğrulanır."
      submitLabel="Değişiklikleri kaydet" pendingLabel="Kaydediliyor…" pendingAnnouncement="Ürün değişiklikleri kaydediliyor."
      onCancel={() => { setEditing(false); setError(''); setConflictVersion(undefined); }} onSubmit={(event) => void submit(event)} />
  </>;

  return <main className="product-detail">
    <div className="detail-heading"><div><p className="eyebrow">Ürün kataloğu</p><h1>{product.name}</h1></div>
      <span className="product-version">Sürüm {product.version}</span></div>
    {feedback && <div className="success-message" role="status" aria-live="polite">{feedback}</div>}
    {error && <div className="detail-feedback detail-feedback-error" role="alert">{error}</div>}
    <section className="record-section" aria-labelledby="product-info-title"><h2 id="product-info-title">Ürün bilgileri</h2><ProductFacts product={product} /></section>
    {canManage && <section className="record-section record-commands" aria-labelledby="product-actions-title">
      <h2 id="product-actions-title">Katalog işlemleri</h2>
      <p>Katalog bilgisini güncelleyin.</p>
      <div><button className="secondary-button" type="button" onClick={() => { setEditing(true); setFeedback(''); setError(''); }} disabled={pending}>Ürünü düzenle</button></div>
    </section>}
  </main>;
}
