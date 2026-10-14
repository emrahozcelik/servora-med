import { useEffect, useState } from 'react';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { RecordDescriptions } from '../ui/antd';
import { jobCardStatusLabel } from './job-labels';
import { getSaleCreateContext, listRelatedSales, type SaleContact, type SaleDetails } from './sale-api';

function contactText(contact: SaleContact | null) {
  return contact ? [contact.name, contact.title].filter(Boolean).join(' · ') : 'Belirtilmedi';
}
export function SaleDetailsSection({ details }: { details: SaleDetails }) {
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
    {source.access === 'RESTRICTED' ? <p>Kaynak ziyarete erişiminiz yok.</p> : <>
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
  useRealtimeInvalidation(['job-detail:' + visitId], () => setRefresh((value) => value + 1));
  useEffect(() => {
    let current = true; setState({ kind: 'loading' });
    void Promise.all([listRelatedSales(visitId, offset), getSaleCreateContext(visitId)]).then(([page, context]) => {
      if (current) setState({ kind: 'ready', page, restrictedActive: context.activeSale?.access === 'RESTRICTED' });
    }).catch(() => { if (current) setState({ kind: 'error' }); });
    return () => { current = false; };
  }, [visitId, offset, refresh]);
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
      {state.page.total > state.page.limit && <nav aria-label="Bağlı satış sayfaları">
        <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Önceki</button>
        <button type="button" className="secondary-button" disabled={offset + 20 >= state.page.total} onClick={() => setOffset(offset + 20)}>Sonraki</button>
      </nav>}
    </>}
  </section>;
}
