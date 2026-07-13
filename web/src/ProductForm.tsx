import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';

import { ApiError } from './services/api';
import { createProduct, type CreateProductInput, type Product } from './services/products-api';

type ProductField = 'name' | 'referencePrice';
type ProductFieldErrors = Partial<Record<ProductField, string>>;

const optionalText = (data: FormData, name: string) => {
  const value = String(data.get(name) ?? '').trim();
  return value || null;
};

export function productInputFromFormData(data: FormData): CreateProductInput {
  const referencePriceValue = String(data.get('referencePrice') ?? '').trim();
  const referencePrice = referencePriceValue === '' ? null : Number(referencePriceValue);
  if (referencePrice !== null && (!Number.isFinite(referencePrice) || referencePrice < 0)) {
    throw new Error('Referans fiyat sıfırdan küçük olamaz.');
  }
  return {
    name: String(data.get('name') ?? '').trim(),
    sku: optionalText(data, 'sku'), brand: optionalText(data, 'brand'),
    category: optionalText(data, 'category'), model: optionalText(data, 'model'),
    unit: optionalText(data, 'unit'), referencePrice,
  };
}

export function ProductForm({ pending, fieldErrors, error, errorRef, onCancel, onSubmit, initialProduct,
  title = 'Yeni ürün', intro = 'Katalog kaydını temel ürün bilgileriyle oluşturun. Yalnız ürün adı zorunludur.',
  submitLabel = 'Ürün oluştur', pendingLabel = 'Oluşturuluyor…' }: {
  pending: boolean;
  fieldErrors: ProductFieldErrors;
  error: string;
  errorRef?: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  initialProduct?: Product;
  title?: string;
  intro?: string;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const describedBy = (field: ProductField, help?: string) => [help, fieldErrors[field] ? `product-${field === 'referencePrice' ? 'reference-price' : field}-error` : ''].filter(Boolean).join(' ') || undefined;
  return <main className="product-create">
    <div className="detail-heading"><div><p className="eyebrow">Ürün kataloğu</p><h1>{title}</h1></div></div>
    <p className="form-intro">{intro}</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    <form className="product-form" noValidate onSubmit={onSubmit}>
      <p className="sr-only" role="status" aria-live="polite">{pending ? 'Ürün oluşturuluyor.' : ''}</p>
      <div className="field-group"><label htmlFor="product-name">Ürün adı (zorunlu)</label>
        <input id="product-name" name="name" required disabled={pending} defaultValue={initialProduct?.name} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={describedBy('name')} />
        {fieldErrors.name && <p className="field-error" id="product-name-error">{fieldErrors.name}</p>}</div>
      <div className="product-form-pair">
        <div className="field-group"><label htmlFor="product-sku">SKU (isteğe bağlı)</label><input id="product-sku" name="sku" disabled={pending} defaultValue={initialProduct?.sku ?? ''} /></div>
        <div className="field-group"><label htmlFor="product-brand">Marka (isteğe bağlı)</label><input id="product-brand" name="brand" disabled={pending} defaultValue={initialProduct?.brand ?? ''} /></div>
        <div className="field-group"><label htmlFor="product-category">Kategori (isteğe bağlı)</label><input id="product-category" name="category" disabled={pending} defaultValue={initialProduct?.category ?? ''} /></div>
        <div className="field-group"><label htmlFor="product-model">Model (isteğe bağlı)</label><input id="product-model" name="model" disabled={pending} defaultValue={initialProduct?.model ?? ''} /></div>
        <div className="field-group"><label htmlFor="product-unit">Birim (isteğe bağlı)</label><input id="product-unit" name="unit" disabled={pending} defaultValue={initialProduct?.unit ?? ''} /></div>
        <div className="field-group"><label htmlFor="product-reference-price">Referans fiyat (isteğe bağlı)</label>
          <input id="product-reference-price" name="referencePrice" type="number" min="0" step="0.01" inputMode="decimal" disabled={pending} defaultValue={initialProduct?.referencePrice ?? ''}
            aria-invalid={Boolean(fieldErrors.referencePrice)} aria-describedby={describedBy('referencePrice', 'product-reference-price-help')} />
          <p className="field-status" id="product-reference-price-help">Bu değer yalnızca bilgilendirme amaçlıdır; satış fiyatı, muhasebe kaydı veya stok değerlemesi değildir.</p>
          {fieldErrors.referencePrice && <p className="field-error" id="product-reference-price-error">{fieldErrors.referencePrice}</p>}</div>
      </div>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>İptal</button>
        <button className="primary-button compact-button" type="submit" disabled={pending}>{pending ? pendingLabel : submitLabel}</button></div>
    </form>
  </main>;
}

export function productServerFieldErrors(error: ApiError): ProductFieldErrors {
  const value = error.details?.fieldErrors;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  return {
    ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
    ...(typeof fields.referencePrice === 'string' ? { referencePrice: fields.referencePrice } : {}),
  };
}

export function ProductCreateScreen({ onCancel, onCreated, create = createProduct }: {
  onCancel: () => void;
  onCreated: (product: Product) => void;
  create?: typeof createProduct;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ProductFieldErrors>({});
  const [focusTarget, setFocusTarget] = useState<'summary' | ProductField | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusTarget === 'summary') errorRef.current?.focus();
    if (focusTarget === 'name') document.getElementById('product-name')?.focus();
    if (focusTarget === 'referencePrice') document.getElementById('product-reference-price')?.focus();
    if (focusTarget) setFocusTarget(null);
  }, [focusTarget, error, fieldErrors]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setFieldErrors({}); setFocusTarget(null);
    let input: CreateProductInput;
    try {
      input = productInputFromFormData(new FormData(event.currentTarget));
      if (!input.name) {
        setError('Ürün oluşturulamadı. Zorunlu alanı kontrol edin.'); setFieldErrors({ name: 'Ürün adı zorunludur.' }); setFocusTarget('name'); return;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Alanları kontrol edin.';
      setError('Ürün oluşturulamadı. Alanları kontrol edin.'); setFieldErrors({ referencePrice: message }); setFocusTarget('summary'); return;
    }
    setPending(true);
    try { onCreated(await create(input)); }
    catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'Ürün oluşturulamadı.', true);
      const nextFieldErrors = productServerFieldErrors(apiError); setError(apiError.message); setFieldErrors(nextFieldErrors);
      setFocusTarget(nextFieldErrors.name ? 'name' : nextFieldErrors.referencePrice ? 'referencePrice' : 'summary');
    } finally { setPending(false); }
  }

  return <ProductForm pending={pending} fieldErrors={fieldErrors} error={error} errorRef={errorRef}
    onCancel={onCancel} onSubmit={(event) => void submit(event)} />;
}
