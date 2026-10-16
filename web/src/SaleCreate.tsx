import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ProductSelect } from './ProductSelect';
import { type CurrentUser } from './services/api';
import { type Product } from './services/products-api';
import { createSaleFromVisit, getSaleCreateContext, type SaleCreateContext, type SaleCreateInput, type SaleContact } from './jobs/sale-api';
import { defaultDeliveredAtLocalValue, localDateTimeToIso } from './jobs/scheduling';
import { isDefinitiveMutationError } from './jobs/mutation-attempt-error';
import { SaleContactSelect } from './jobs/SaleContactSelect';
import { PageHeader } from './ui/PageHeader';
import { RecordDescriptions } from './ui/antd';
import { loadSaleProducts, saleCount } from './jobs/sale-form';
import { paths } from './paths';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';

function contactText(contact: SaleContact | null) {
  return contact ? [contact.name, contact.title].filter(Boolean).join(' · ') : 'Belirtilmedi';
}

export function SaleCreateScreen({ visitId, user, onCancel, onCreated }: {
  visitId: string; user: CurrentUser; onCancel: () => void; onCreated: (id: string) => void;
}) {
  const [context, setContext] = useState<SaleCreateContext | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [soldLocal, setSoldLocal] = useState(() => defaultDeliveredAtLocalValue());
  const [contact, setContact] = useState<SaleContact | null>(null);
  const [products, setProducts] = useState<Array<{ product: Product; quantity: string }>>([]);
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const attempt = useRef<SaleCreateInput | null>(null);
  const sending = useRef(false);
  const lifetime = useRef({ active: true, visitId, actorId: user.id, organizationId: user.organizationId });
  const errorRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const locked = pending || ambiguous;
  useEffect(() => { lifetime.current.active = true; return () => { lifetime.current.active = false; }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    let active = true;
    setContext(null);
    void getSaleCreateContext(visitId).then((value) => {
      if (!active) return;
      setContext(value);
      if (!initialized.current) { setTitle((value.customer?.name ?? '') + ' satış kaydı'); initialized.current = true; }
    }).catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Ziyaret doğrulanamadı.'); });
    return () => { active = false; };
  }, [visitId, reload]);
  useRealtimeInvalidation(['job-detail:' + visitId], () => {
    // A context refresh may revoke eligibility, never rewrite a frozen intent.
    setReload((v) => v + 1);
  });
  async function send(input: SaleCreateInput) {
    if (sending.current) return;
    sending.current = true; setPending(true); setError('');
    const owner = lifetime.current;
    try {
      const result = await createSaleFromVisit(visitId, input);
      if (!owner.active || lifetime.current !== owner) return;
      attempt.current = null; setAmbiguous(false); onCreated(result.jobCardId);
    } catch (caught) {
      if (!owner.active || lifetime.current !== owner) return;
      if (isDefinitiveMutationError(caught)) {
        attempt.current = null; setAmbiguous(false); setReload((v) => v + 1);
      } else setAmbiguous(true);
      setError(caught instanceof Error ? caught.message : 'Satış kaydı oluşturulamadı.');
    } finally { if (owner.active && lifetime.current === owner) { sending.current = false; setPending(false); } }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || ambiguous || !context?.eligible || !context.customer) return;
    if (!title.trim() || Array.from(title.trim()).length > 255 || Array.from(description.trim()).length > 4000
      || products.length < 1 || products.length > 25 || products.some((row) => saleCount(row.quantity) === null)) {
      setError('Başlık, en az bir ürün ve 1–999999999 arasında tam sayı adet girin.'); return;
    }
    let soldAt: string;
    try { soldAt = localDateTimeToIso(soldLocal); } catch { setError('Geçerli satış tarihi ve saati girin.'); return; }
    const input: SaleCreateInput = { clientActionId: crypto.randomUUID(), expectedSourceVersion: context.sourceVersion,
      title: title.trim(), description: description.trim() || null, soldAt, saleContactId: contact?.id ?? null,
      items: products.map((row) => ({ productId: row.product.id, quantity: saleCount(row.quantity)! })) };
    attempt.current = input; void send(input);
  }
  return <main className="workspace sale-create">
    <PageHeader fallbackTitle="Satış kaydı oluştur" description="Satış kaydı ziyaret ve teslimattan bağımsız olarak yönetici onayına gönderilir." />
    {error && <div ref={errorRef} role="alert" tabIndex={-1} className="form-error">{error}</div>}
    {!context && !error && <p role="status">Kaynak ziyaret doğrulanıyor…</p>}
    {!context && error && <button type="button" className="secondary-button" onClick={() => { setError(''); setReload((v) => v + 1); }}>Ziyareti tekrar yükle</button>}
    {context && !context.eligible && <section><h2>Bu ziyaretten satış oluşturulamıyor</h2>
      {context.activeSale?.access === 'FULL' ? locked ? <p>Mevcut satış kaydı: {context.activeSale.title}</p> : <a href={paths.job(context.activeSale.id)}>Mevcut satış kaydı: {context.activeSale.title}</a>
        : <p>{context.activeSale ? 'Bu ziyaretin erişemediğiniz bir aktif satış kaydı var.' : 'Ziyaret veya ilgili kayıtlar satış oluşturmaya uygun değil.'}</p>}
      <button type="button" className="secondary-button" disabled={locked} onClick={onCancel}>Ziyarete dön</button></section>}
    {context?.eligible && context.customer && <form className="task-form" onSubmit={submit} noValidate>
      <h2>Kaynak ziyaret</h2>
      {locked ? <p>Kaynak ziyaret kaydı</p> : <a href={paths.job(visitId)}>Kaynak ziyaret kaydı</a>}
      <RecordDescriptions ariaLabel="Doğrulanmış satış bağlamı" items={[
        { key: 'customer', label: 'Müşteri', content: context.customer.name },
        { key: 'staff', label: 'Sorumlu personel', content: context.assignee.name },
        { key: 'planned', label: 'Ziyarette planlanan kişi', content: contactText(context.plannedContact) },
        { key: 'met', label: 'Ziyarette görüşülen kişi', content: contactText(context.metContact) },
      ]} />
      <fieldset disabled={locked}>
        <div className="field-group"><label htmlFor="sale-title">Başlık</label><input id="sale-title" maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
        <SaleContactSelect customerId={context.customer.id} selected={contact} onChange={setContact} disabled={locked} />
        <div className="field-group"><label htmlFor="sale-sold-at">Gerçekleşen satış zamanı</label><input id="sale-sold-at" type="datetime-local" value={soldLocal} onChange={(e) => setSoldLocal(e.target.value)} required />
          <p className="form-help">Cihazınızın yerel saat dilimi: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p></div>
        <ProductSelect load={loadSaleProducts} disabled={locked} selectedProducts={products.map((row) => row.product)}
          onAdd={(product) => { if (products.length >= 25) { setError('En fazla 25 farklı ürün seçebilirsiniz.'); return; }
            setProducts((rows) => rows.some((row) => row.product.id === product.id) ? rows : [...rows, { product, quantity: '1' }]); }}
          onRemove={(id) => setProducts((rows) => rows.filter((row) => row.product.id !== id))}
          renderQuantity={(product) => <label className="field-group sale-quantity-field">Adet<input type="number" aria-label={product.name + ' satış adedi'} min="1" max="999999999" step="1" inputMode="numeric"
            value={products.find((row) => row.product.id === product.id)?.quantity ?? ''} onChange={(e) => setProducts((rows) => rows.map((row) => row.product.id === product.id ? { ...row, quantity: e.target.value } : row))} /></label>} />
        <div className="field-group"><label htmlFor="sale-description">Açıklama (isteğe bağlı)</label><textarea id="sale-description" rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </fieldset>
      <div className="form-actions"><button className="primary-button" type="submit" disabled={locked}>{pending ? 'Kaydediliyor…' : 'Satış kaydını oluştur'}</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={onCancel}>Vazgeç</button></div>
    </form>}
    {ambiguous && <div role="status" className="detail-feedback"><p>İşlem sonucu doğrulanamadı. Özgün istek korunuyor; değişiklik yapmadan aynı isteği tekrar deneyin.</p>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => { if (attempt.current) void send(attempt.current); }}>Özgün isteği tekrar dene</button></div>}
  </main>;
}
