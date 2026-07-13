import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';

import { ProductForm, productInputFromFormData, productServerFieldErrors } from './ProductForm';
import { ApiError, type CurrentUser } from './services/api';
import {
  activateProduct, deactivateProduct, getProduct, updateProduct, type CreateProductInput, type Product,
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
  activate?: typeof activateProduct;
  deactivate?: typeof deactivateProduct;
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
    <div><dt>Durum</dt><dd>{product.isActive ? 'Aktif' : 'Pasif'}</dd></div>
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

function DeactivateDialog({ product, pending, onCancel, onConfirm, trigger }: {
  product: Product;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => () => { trigger.current?.focus(); }, [trigger]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); onCancel(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (focusable.length === 0) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (focusable.length === 1) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  }

  return <div className="product-dialog-backdrop">
    <div className="product-dialog" role="dialog" aria-modal="true" aria-labelledby="deactivate-title" tabIndex={-1}
      aria-describedby="deactivate-description" ref={dialogRef} onKeyDown={handleKeyDown}>
      <h2 id="deactivate-title">{product.name} ürününü pasifleştir</h2>
      <p id="deactivate-description">Bu ürün yeni seçimlerde kullanılamaz; geçmiş kayıtlar değişmeden kalır.</p>
      <div className="product-dialog-actions">
        <button className="secondary-button" type="button" ref={cancelRef} onClick={() => { if (!pending) onCancel(); }} aria-disabled={pending}>Vazgeç</button>
        <button className="destructive-button" type="button" onClick={onConfirm} disabled={pending}>{pending ? 'Pasifleştiriliyor…' : 'Pasifleştir'}</button>
      </div>
    </div>
  </div>;
}

export function ProductDetailScreen({ productId, user, load = getProduct, update = updateProduct,
  activate = activateProduct, deactivate = deactivateProduct }: ProductDetailProps) {
  const [state, setState] = useState<ProductDetailState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof productServerFieldErrors>>({});
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [conflictVersion, setConflictVersion] = useState<number | null | undefined>(undefined);
  const [lifecycleConflictVersion, setLifecycleConflictVersion] = useState<number | null | undefined>(undefined);
  const [lifecycleReloadError, setLifecycleReloadError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const deactivateTriggerRef = useRef<HTMLButtonElement>(null);
  const editErrorRef = useRef<HTMLDivElement>(null);
  const [focusEditError, setFocusEditError] = useState(false);

  useEffect(() => {
    if (!focusEditError) return;
    editErrorRef.current?.focus(); setFocusEditError(false);
  }, [focusEditError, error, fieldErrors]);

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
      if (!input.name) { setError('Ürün adı zorunludur.'); setFieldErrors({ name: 'Ürün adı zorunludur.' }); return; }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Alanları kontrol edin.';
      setError('Ürün güncellenemedi. Alanları kontrol edin.');
      setFieldErrors({ referencePrice: message }); setFocusEditError(true); return;
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
      } else { setError(next.message); setFieldErrors(productServerFieldErrors(next)); }
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

  async function reloadLifecycleValues() {
    setPending(true); setLifecycleReloadError('');
    try {
      const current = await load(productId);
      setState({ kind: 'ready', product: current }); setLifecycleConflictVersion(undefined);
      setFeedback('Güncel ürün değerleri yüklendi.');
    } catch (caught) { setLifecycleReloadError(apiError(caught, 'Güncel ürün değerleri yüklenemedi.').message); }
    finally { setPending(false); }
  }

  async function changeLifecycle(kind: 'activate' | 'deactivate') {
    setPending(true); setError(''); setFeedback(''); setLifecycleConflictVersion(undefined); setLifecycleReloadError('');
    try {
      const updated = kind === 'activate'
        ? await activate(productId, product.version) : await deactivate(productId, product.version);
      setState({ kind: 'ready', product: updated });
      setFeedback(kind === 'activate' ? 'Ürün etkinleştirildi.' : 'Ürün pasifleştirildi.');
      setDialogOpen(false);
    } catch (caught) {
      const next = apiError(caught, 'Ürün durumu değiştirilemedi.');
      if (next.code === 'VERSION_CONFLICT') setLifecycleConflictVersion(safeCurrentVersion(next));
      else setError(next.message);
      setDialogOpen(false);
    } finally { setPending(false); }
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
    {lifecycleConflictVersion !== undefined && <div className="conflict-actions product-lifecycle-conflict" role="alert">
      <p>Ürün başka bir kullanıcı tarafından güncellendi. Görüntülenen bilgiler korunuyor.
        {lifecycleConflictVersion !== null && <> Güncel sürüm: {lifecycleConflictVersion}.</>}
        {lifecycleReloadError && <> {lifecycleReloadError}</>}</p>
      <button className="secondary-button" type="button" onClick={() => void reloadLifecycleValues()} disabled={pending}>Güncel değerleri yükle</button>
    </div>}
    <section className="record-section" aria-labelledby="product-info-title"><h2 id="product-info-title">Ürün bilgileri</h2><ProductFacts product={product} /></section>
    {canManage && <section className="record-section record-commands" aria-labelledby="product-actions-title">
      <h2 id="product-actions-title">Katalog işlemleri</h2>
      <p>Bilgileri güncelleyin veya ürünün yeni işlerde seçilebilirliğini yönetin.</p>
      <div><button className="secondary-button" type="button" onClick={() => { setEditing(true); setFeedback(''); setError(''); }} disabled={pending}>Ürünü düzenle</button>
        {product.isActive
          ? <button className="destructive-button" type="button" ref={deactivateTriggerRef} onClick={() => setDialogOpen(true)} disabled={pending}>Pasifleştir</button>
          : <button className="primary-button compact-button" type="button" onClick={() => void changeLifecycle('activate')} disabled={pending}>{pending ? 'Etkinleştiriliyor…' : 'Etkinleştir'}</button>}
      </div>
    </section>}
    {dialogOpen && <DeactivateDialog product={product} pending={pending} trigger={deactivateTriggerRef}
      onCancel={() => setDialogOpen(false)} onConfirm={() => void changeLifecycle('deactivate')} />}
  </main>;
}
