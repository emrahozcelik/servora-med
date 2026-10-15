import { useEffect, useRef, useState } from 'react';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { RecordDescriptions } from '../ui/antd';
import { jobCardStatusLabel } from './job-labels';
import { getSaleCreateContext, listRelatedSales, type SaleContact, type SaleDetails } from './sale-api';

function contactText(contact: SaleContact | null) {
  return contact ? [contact.name, contact.title].filter(Boolean).join(' · ') : 'Belirtilmedi';
}
export function SaleDetailsSection({ details, originPending = false }: { details: SaleDetails; originPending?: boolean }) {
  const source = details.sourceVisit;
  return <section className="sale-details" aria-labelledby="sale-details-title">
    <h2 id="sale-details-title">Satış anlaşması</h2>
    <RecordDescriptions ariaLabel="Satış bilgileri" items={[
      { key: 'soldAt', label: 'Gerçekleşen satış zamanı', content: <time dateTime={details.soldAt}>
        {new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(details.soldAt))}
      </time> },
      { key: 'saleContact', label: 'Satışta görüşülen kişi', content: contactText(details.saleContact) },
    ]} />
    <h3>Kaynak ziyaret</h3>
    {originPending ? <p role="status">Kaynak ziyaret erişimi doğrulanıyor…</p>
      : source.access === 'RESTRICTED' ? <p>Kaynak ziyarete erişiminiz yok.</p> : <>
      <a href={paths.job(source.id)}>{source.title}</a> · {jobCardStatusLabel(source.status)}
      <RecordDescriptions ariaLabel="Kaynak ziyaret snapshot bilgileri" items={[
        { key: 'title', label: 'Kayıt anındaki ziyaret', content: source.titleSnapshot },
        { key: 'customer', label: 'Kayıt anındaki müşteri', content: source.customerNameSnapshot },
        { key: 'planned', label: 'Ziyarette planlanan kişi', content: contactText(source.plannedContact) },
        { key: 'met', label: 'Ziyarette görüşülen kişi', content: contactText(source.metContact) },
      ]} />
    </>}
    <h3>Satılan ürünler</h3>
    {details.items.length === 0 ? <p>Satış ürünü bulunmuyor.</p> : <ul className="sale-product-lines">
      {details.items.map((item) => <li key={item.id} className="sale-product-line">
        <span className="sale-product-quantity" aria-label="Miktar">{item.quantity}{item.unit ? ' ' + item.unit : ''}</span>
        <div><strong>{item.name}</strong><p>{[
          item.sku ? 'SKU: ' + item.sku : null, item.brand, item.model, item.unit,
        ].filter(Boolean).join(' · ')}</p></div>
      </li>)}
    </ul>}
  </section>;
}
export function RelatedSalesSection({ visitId }: { visitId: string }) {
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | {
    kind: 'ready'; page: Awaited<ReturnType<typeof listRelatedSales>>; restrictedActive: boolean;
  }>({ kind: 'loading' });
  const requestRef = useRef(0);
  useRealtimeInvalidation(['job-detail:' + visitId], () => setRefresh((value) => value + 1));
  useEffect(() => {
    let current = true;
    const requestOffset = offset;
    requestRef.current += 1;
    const requestId = requestRef.current;
    setState({ kind: 'loading' });
    void Promise.all([listRelatedSales(visitId, requestOffset), getSaleCreateContext(visitId)]).then(([page, context]) => {
      // A newer request (offset clamp or refresh) already superseded this one.
      if (!current || requestRef.current !== requestId) return;
      const step = page.limit > 0 ? page.limit : 20;
      if (requestOffset > 0 && page.total <= requestOffset) {
        setOffset(Math.max(0, Math.floor((page.total - 1) / step) * step));
        return;
      }
      if (current) setState({ kind: 'ready', page, restrictedActive: context.activeSale?.access === 'RESTRICTED' });
    }).catch(() => { if (current && requestRef.current === requestId) setState({ kind: 'error' }); });
    return () => { current = false; };
  }, [visitId, offset, refresh]);
  const pageStep = state.kind === 'ready' && state.page.limit > 0 ? state.page.limit : 20;
  return <section aria-labelledby="related-sales-title" className="related-sales">
    <h2 id="related-sales-title">Bağlı satışlar</h2>
    {state.kind === 'loading' && <p role="status">Satış kayıtları yükleniyor…</p>}
    {state.kind === 'error' && <><p role="alert">Satış kayıtları yüklenemedi.</p>
      <button type="button" className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Tekrar dene</button></>}
    {state.kind === 'ready' && <>
      {state.restrictedActive && <p>Bu ziyaret için erişemediğiniz bir aktif satış kaydı var.</p>}
      {state.page.items.length === 0 ? <p>Erişilebilir satış kaydı bulunmuyor.</p> : <ul>
        {state.page.items.map((sale) => <li key={sale.id}><a href={paths.job(sale.id)}>{sale.title}</a> · {jobCardStatusLabel(sale.status)}</li>)}
      </ul>}
      {(state.page.total > state.page.limit || offset > 0) && <nav aria-label="Bağlı satış sayfaları">
        <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageStep))}>Önceki</button>
        <button type="button" className="secondary-button" disabled={offset + pageStep >= state.page.total} onClick={() => setOffset(offset + pageStep)}>Sonraki</button>
      </nav>}
    </>}
  </section>;
}
