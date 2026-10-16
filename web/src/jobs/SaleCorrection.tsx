import { useEffect, useId, useRef, useState } from 'react';
import { ProductSelect, type ProductSelectionIdentity } from '../ProductSelect';
import type { Product } from '../services/products-api';
import { SaleContactSelect } from './SaleContactSelect';
import { correctSale, type SaleContact, type SaleCorrection, type SaleDetails } from './sale-api';
import { isDefinitiveMutationError } from './mutation-attempt-error';
import { isoInstantToLocalDateTime, localDateTimeToIso } from './scheduling';
import { loadSaleProducts, saleCount } from './sale-form';

/** One parent-versioned correction at a time, with an exact in-memory retry intent. */
export function SaleCorrectionSection({ details, customerId, disabled, onLockChange, onChanged }: {
  details: SaleDetails; customerId: string; disabled: boolean;
  onLockChange: (locked: boolean) => void; onChanged: () => Promise<unknown>;
}) {
  const id = useId();
  const [soldLocal, setSoldLocal] = useState(() => isoInstantToLocalDateTime(details.soldAt));
  const [contact, setContact] = useState<SaleContact | null>(details.saleContact);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [addition, setAddition] = useState<Product | null>(null);
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState('');
  const attempt = useRef<SaleCorrection | null>(null);
  const sending = useRef(false);
  const latest = useRef(details); latest.current = details;
  // Last server values reflected in the untouched form fields. A field that
  // still matches its base is not a user edit and may follow newer versions;
  // a diverged field is an unsent user edit and must never be silently lost.
  const base = useRef({ soldLocal: isoInstantToLocalDateTime(details.soldAt), contactId: details.saleContact?.id ?? null });
  function synchronize(source: SaleDetails) {
    const sourceSold = isoInstantToLocalDateTime(source.soldAt);
    const sourceContactId = source.saleContact?.id ?? null;
    if (soldLocal === base.current.soldLocal) setSoldLocal(sourceSold);
    if ((contact?.id ?? null) === base.current.contactId) setContact(source.saleContact);
    base.current = { soldLocal: sourceSold, contactId: sourceContactId };
  }
  const lifetime = useRef({ active: true });
  const lockCallback = useRef(onLockChange); lockCallback.current = onLockChange;
  const messageRef = useRef<HTMLDivElement>(null);
  const locked = disabled || pending || unresolved || needsRefresh;
  useEffect(() => { const owner = lifetime.current; owner.active = true;
    return () => { owner.active = false; lockCallback.current(false); }; }, []);
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);
  useEffect(() => {
    if (attempt.current || sending.current) return;
    synchronize(details);
    setQuantities({}); setAddition(null);
  // Parent version is authoritative; fresh DTO object identities are not edits.
  }, [details.jobCardVersion]);
  function release() {
    attempt.current = null; setUnresolved(false); setNeedsRefresh(false); lockCallback.current(false);
  }
  async function send(value: SaleCorrection) {
    if (sending.current) return;
    sending.current = true; setPending(true); setMessage(''); lockCallback.current(true);
    const owner = lifetime.current;
    try {
      await correctSale(details.jobCardId, value);
      if (!owner.active) return;
      await onChanged();
      if (!owner.active) return;
      release(); synchronize(latest.current); setQuantities({}); setAddition(null); setMessage('Satış kaydı güncellendi.');
    } catch (caught) {
      if (!owner.active) return;
      if (isDefinitiveMutationError(caught)) {
        attempt.current = null; setUnresolved(false); setNeedsRefresh(true);
      } else setUnresolved(true);
      setMessage(caught instanceof Error ? caught.message : 'Satış kaydı güncellenemedi.');
    } finally { if (owner.active) { sending.current = false; setPending(false); } }
  }
  function begin(value: SaleCorrection) {
    if (locked || attempt.current || sending.current) return;
    attempt.current = value; void send(value);
  }
  const version = () => ({ clientActionId: crypto.randomUUID(), expectedVersion: details.jobCardVersion });
  const lines = new Map(details.items.map((item) => [item.productId, item]));
  const identities: ProductSelectionIdentity[] = details.items.map((item) => ({ id: item.productId, name: item.name, sku: item.sku, brand: item.brand, model: item.model, unit: item.unit }));
  if (addition && !lines.has(addition.id)) identities.push(addition);
  function saveDetails() {
    const input: Extract<SaleCorrection, { kind: 'details' }>['input'] = version();
    if (contact?.id !== details.saleContact?.id) input.saleContactId = contact?.id ?? null;
    if (soldLocal !== isoInstantToLocalDateTime(details.soldAt)) {
      try { input.soldAt = localDateTimeToIso(soldLocal); }
      catch { setMessage('Geçerli satış tarihi ve saati girin.'); return; }
    }
    if (input.soldAt === undefined && input.saleContactId === undefined) { setMessage('Kaydedilecek değişiklik yok.'); return; }
    begin({ kind: 'details', input });
  }
  function saveQuantity(productId: string) {
    const line = lines.get(productId);
    const quantity = saleCount(quantities[productId] ?? line?.quantity ?? '1');
    if (quantity === null) { setMessage('Satış adedi 1–999999999 arasında tam sayı olmalıdır.'); return; }
    if (line) begin({ kind: 'quantity', itemId: line.id, input: { ...version(), quantity } });
    else if (addition) begin({ kind: 'add', input: { ...version(), productId: addition.id, quantity } });
  }
  return <section className="sale-correction task-form" aria-labelledby={id + '-title'}>
    <h2 id={id + '-title'}>Satış kaydını düzelt</h2>
    {message && <div ref={messageRef} className="detail-feedback" role="status" tabIndex={-1}>{message}</div>}
    <fieldset disabled={locked}>
      <div className="field-group"><label htmlFor={id + '-sold'}>Gerçekleşen satış zamanı</label>
        <input id={id + '-sold'} type="datetime-local" value={soldLocal} onChange={(e) => setSoldLocal(e.target.value)} />
        <p className="form-help">Cihazınızın yerel saat dilimi: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p></div>
      <SaleContactSelect customerId={customerId} selected={contact} onChange={setContact} disabled={locked} />
      <button type="button" className="secondary-button" onClick={saveDetails}>Satış bilgilerini kaydet</button>
      <ProductSelect selectedProducts={identities} load={loadSaleProducts} disabled={locked}
        onAdd={(product) => {
          if (details.items.length >= 25) { setMessage('En fazla 25 farklı ürün ekleyebilirsiniz.'); return; }
          if (addition) { setMessage('Önce seçili yeni ürünü kaydedin veya kaldırın.'); return; }
          setAddition(product); setQuantities((current) => ({ ...current, [product.id]: '1' }));
        }}
        onRemove={(productId) => {
          const line = lines.get(productId);
          if (line) begin({ kind: 'remove', itemId: line.id, input: version() });
          else { setAddition(null); setQuantities((current) => { const next = { ...current }; delete next[productId]; return next; }); }
        }}
        renderQuantity={(product) => <div><label className="field-group sale-quantity-field">Adet<input type="number" inputMode="numeric" min="1" max="999999999" step="1"
          aria-label={product.name + ' satış adedi'} value={quantities[product.id] ?? lines.get(product.id)?.quantity ?? '1'}
          onChange={(e) => setQuantities((current) => ({ ...current, [product.id]: e.target.value }))} /></label>
          <button type="button" className="secondary-button" aria-label={(lines.has(product.id) ? 'Adedi kaydet: ' : 'Ürünü ekle: ') + product.name}
            disabled={lines.has(product.id) && (quantities[product.id] ?? lines.get(product.id)?.quantity) === lines.get(product.id)?.quantity}
            onClick={() => saveQuantity(product.id)}>{lines.has(product.id) ? 'Adedi kaydet' : 'Ürünü ekle'}</button></div>} />
    </fieldset>
    {unresolved && <div role="status"><p>Sonuç doğrulanamadı. Özgün ürün, adet ve kayıt sürümü korunuyor.</p>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => { if (attempt.current) void send(attempt.current); }}>Özgün düzeltmeyi tekrar dene</button></div>}
    {needsRefresh && <button type="button" className="secondary-button" disabled={pending} onClick={async () => {
      if (sending.current) return;
      sending.current = true; setPending(true);
      try { await onChanged(); if (lifetime.current.active) { release(); synchronize(latest.current); setQuantities({}); setAddition(null); } }
      catch { if (lifetime.current.active) setMessage('Güncel kayıt yüklenemedi. Tekrar deneyin.'); }
      finally { if (lifetime.current.active) { sending.current = false; setPending(false); } }
    }}>Güncel kaydı yükle ve düzeltmeye devam et</button>}
  </section>;
}
