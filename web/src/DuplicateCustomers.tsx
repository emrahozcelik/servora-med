import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import { getDuplicateComparison, listDuplicateCandidates, duplicateReasonLabels, duplicateEffectiveLabels, duplicateFreshnessLabels, type DuplicatePage, type DuplicateComparison } from './services/duplicate-customers-api';
import { DuplicateReviewPanel } from './DuplicateReviewPanel';
import { PageHeader } from './ui/PageHeader';
import { EmptyState } from './ui/antd/EmptyState';
import { LoadingSkeleton } from './ui/antd/LoadingSkeleton';
import { ResultState } from './ui/antd/ResultState';
import { customerStatusLabels, customerTypeLabels, getCustomerOperationalSummary, type CustomerOperationalSummary } from './services/crm-api';
import { buildContextState } from './shell/context-return';
import { useOptionalRouteNavigation } from './shell/route-navigation-provider';
import { useDuplicateRead } from './useDuplicateRead';
import './duplicate-customers.css';

const readPauseScope = (kind: 'LIST' | 'DETAIL', user: CurrentUser) => `CRM_DUPLICATE_${kind}:v1:${user.organizationId}:${user.id}`;

export function DuplicateReadError({ error, onReload, retainedData = false, retryAt = null, retryAuto = true, busy = false, notFoundTitle = 'Aday taraması başlatılamadı', notFoundDescription = 'Seçili müşteri kapsamı kullanılamıyor veya erişim kapsamınızda değil. Aday listesine dönüp yeniden deneyin.' }: {
  error: Error; onReload: () => void; retainedData?: boolean; retryAt?: number | null; retryAuto?: boolean; busy?: boolean;
  notFoundTitle?: string; notFoundDescription?: string;
}) {
  const code = error instanceof ApiError ? error.code : '';
  const status = error instanceof ApiError ? error.status : 0;
  const waitingForRetry = retryAt !== null && status === 429;
  const waitSeconds = waitingForRetry ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  const notFound = status === 404;
  const title = notFound ? notFoundTitle : code === 'CANDIDATE_SCAN_LIMIT' ? 'Tarama kapsam sınırını aştı' : code === 'CURSOR_RESTART_REQUIRED' ? 'Liste değişti' : 'Karşılaştırma yüklenemedi';
  const description = notFound ? notFoundDescription : <>{error.message} Sonuç tamamlanamadı; aday bulunmadığı anlamına gelmez. {retainedData && <strong>Gösterilen sonuçlar son başarılı okumaya aittir; güncellikleri doğrulanamadı.</strong>}{waitingForRetry && <span className="duplicate-retry-wait"> Kota sınırı nedeniyle yaklaşık {waitSeconds} saniye bekleniyor. {retryAuto ? 'Süre dolunca görünür ekranda bir kez otomatik olarak yeniden denenecek.' : "Süre dolunca 'Tekrar dene' ile yeniden deneyebilirsiniz."}</span>}</>;
  return <ResultState status={notFound ? '404' : status === 403 ? '403' : 'error'} title={title} description={description}
    action={[401, 403, 404].includes(status) ? undefined : <button type="button" className="secondary-button" onClick={onReload} disabled={busy || waitingForRetry}>{code === 'CURSOR_RESTART_REQUIRED' ? 'İlk sayfadan başlat' : 'Tekrar dene'}</button>} />;
}
export function DuplicateReadNotice() {
  return <p className="duplicate-notice">Salt okunur aday listesi. Bu ekran müşteri kayıtlarını değiştirmez. Ortak iletişim bilgileri aynı müşteri olunduğunu kanıtlamaz; farklı şubeler ayrı kabul edilir.</p>;
}
export function DuplicateComparisonNotice() {
  return <p className="duplicate-notice">İnceleme kararı yalnız bu müşteri çifti için kaydedilir. Müşteriler birleştirilmez, pasifleştirilmez veya silinmez. Ortak iletişim bilgileri tek başına aynı müşteri olduğunu kanıtlamaz.</p>;
}
export function DuplicateCandidateView({ data, error, busy, retryAt = null, retryAuto = true, onReload, onFirst, onNext, laterPage = false }: {
  data: DuplicatePage | null; error: Error | null; busy: boolean; retryAt?: number | null; retryAuto?: boolean; onReload: () => void; onFirst: () => void; onNext: () => void; laterPage?: boolean;
}) {
  const location = useLocation();
  const contextState = buildContextState(location);
  return <main className="workspace duplicate-workspace" aria-busy={busy}>
    <PageHeader fallbackTitle="Olası mükerrerler" actions={<button className="secondary-button" type="button" onClick={laterPage ? onFirst : onReload} disabled={busy || (!laterPage && retryAt !== null)}>{laterPage ? 'İlk sayfayı yenile' : 'Yenile'}</button>} />
    <DuplicateReadNotice />
    <p>Yalnız aynı kuruluştaki gerçek iş kayıtları (BUSINESS); aday, aktif ve pasif müşteriler dahildir.</p>
    {busy && !data && <LoadingSkeleton title="Adaylar yükleniyor" rows={4} />}
    {error && <DuplicateReadError error={error} retainedData={data !== null} retryAt={retryAt} retryAuto={retryAuto} busy={busy} onReload={error instanceof ApiError && error.code === 'CURSOR_RESTART_REQUIRED' ? onFirst : onReload} />}
    {data && <>
      <p className="text-muted">Son okuma: <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString('tr-TR')}</time>. {laterPage ? 'Bu sayfa otomatik başa dönmez. Güncel kapsam için ilk sayfayı yenileyin.' : 'Görünürken 60 saniyede bir yenilenir.'}</p>
      {data.scope.anchorCustomerId && <Link to={paths.duplicateCustomers}>Müşteri filtresini kaldır</Link>}
      {Math.max(data.largestNameGroupSize, data.largestPhoneGroupSize) > 100 && <p role="status" className="duplicate-warning">Büyük ortak bilgi grubu var. Aynı isim grubunda en fazla {data.largestNameGroupSize}, aynı telefon grubunda en fazla {data.largestPhoneGroupSize} müşteri bulunuyor. Bir müşterinin adaylarını açarak kapsamı daraltabilirsiniz.</p>}
      {!error && data.items.length === 0 && (data.page.exhausted ? <EmptyState title="Bu kapsamda aday bulunamadı" description="Tarama başarıyla tamamlandı. Bu sonuç, kayıtların aynı müşteri olduğuna ilişkin bir karar değildir." /> : <p role="status">Bu ara sayfada gösterilecek aday yok. Taramayı sürdürün.</p>)}
      <ol className="duplicate-candidates">{data.items.map((item) => <li key={`${item.pair.customerAId}:${item.pair.customerBId}`}>
        <article className="duplicate-candidate">
          <div className="duplicate-identities">{([item.customerA, item.customerB] as const).map((customer, index) => <div key={customer.id}>
            <h2><span>Müşteri {index === 0 ? 'A' : 'B'}: </span>{customer.name}</h2>
            <p>{customerStatusLabels[customer.status]} · {[customer.city, customer.district].filter(Boolean).join(', ') || 'Konum belirtilmedi'}</p>
            <p className="duplicate-id">Kayıt: {customer.id}</p>
            <Link to={`${paths.duplicateCustomers}?anchorCustomerId=${encodeURIComponent(customer.id)}`}>Bu müşterinin adayları</Link>
          </div>)}</div>
          <ul className="duplicate-reasons" aria-label="Eşleşme gerekçeleri">{item.matchingCodes.map((code) => <li key={code}>{duplicateReasonLabels[code]}</li>)}</ul>
          {item.warnings.length > 0 && <p className="duplicate-warning">Çelişki: Vergi numaraları farklı.</p>}
          {item.review?.id && <p role="status" className="duplicate-review-summary">İnceleme: {duplicateEffectiveLabels[item.review.effectiveStatus]} · {duplicateFreshnessLabels[item.review.freshness]}</p>}
          {item.comparisonStatus !== 'READY' && <p role="status" className="duplicate-warning">Kanıt bütünü doğrulanamadığı için bu çiftte karşılaştırma açılamaz. Aday çift ve mevcut eşleşme gerekçeleri listede kalır.</p>}
          {item.comparisonStatus === 'READY' && <Link id={`duplicate-${item.pair.customerAId}-${item.pair.customerBId}`} className="secondary-button" to={paths.duplicateComparison(item.pair.customerAId, item.pair.customerBId)} state={{ ...(contextState ?? {}), duplicateFocus: `duplicate-${item.pair.customerAId}-${item.pair.customerBId}` }}>İki müşteriyi karşılaştır<span className="sr-only">: {item.customerA.name} / {item.customerB.name}</span></Link>}
        </article>
      </li>)}</ol>
      <nav className="duplicate-pagination" aria-label="Aday sayfaları">
        {laterPage && <button className="secondary-button" type="button" onClick={onFirst} disabled={busy}>İlk sayfa</button>}
        {!data.page.exhausted && <button className="primary-button" type="button" onClick={onNext} disabled={busy}>{data.items.length ? 'Sonraki sayfa' : 'Taramayı sürdür'}</button>}
        <span role="status">{busy ? 'Güncelleniyor…' : `Bu sayfada ${data.page.returnedItems} aday`}</span>
      </nav>
    </>}
  </main>;
}

export function DuplicateCustomersScreen({ user }: { user: CurrentUser }) {
  const [params, setParams] = useSearchParams(); const location = useLocation();
  const laterPage = params.has('cursor');
  const state = useDuplicateRead(params.toString(), (signal) => listDuplicateCandidates(params, signal), !laterPage, readPauseScope('LIST', user));
  const restored = useRef(false);
  useEffect(() => {
    const focus = (location.state as { duplicateFocus?: unknown } | null)?.duplicateFocus;
    if (!state.busy && state.data && !restored.current && typeof focus === 'string') { document.getElementById(focus)?.focus(); restored.current = true; }
  }, [state.busy, state.data, location.state]);
  const first = () => { if (!laterPage) state.reload(); else { const next = new URLSearchParams(params); next.delete('cursor'); setParams(next); } };
  return <DuplicateCandidateView {...state} onReload={state.reload} onFirst={first} laterPage={laterPage} onNext={() => { if (state.data?.page.nextCursor) { const next = new URLSearchParams(params); next.set('cursor', state.data.page.nextCursor); setParams(next); } }} />;
}

function OperationalSummary({ customerId }: { customerId: string }) {
  const [summary, setSummary] = useState<CustomerOperationalSummary | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [asOf, setAsOf] = useState('');
  return <section aria-label="İsteğe bağlı operasyonel özet">
    <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { setSummary(await getCustomerOperationalSummary(customerId)); setAsOf(new Date().toLocaleString('tr-TR')); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Özet yüklenemedi.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Özet yükleniyor…' : error ? 'Özeti tekrar yükle' : summary ? 'Operasyonel özeti yenile' : 'Operasyonel özeti göster'}</button>
    {error && <p role="alert">{error}</p>}
    {summary && <><p>Özet okuma zamanı: {asOf}. Kimlik eşleşme kanıtına dahil değildir.</p>
      <p>Onay bekleyen işler: {summary.pendingReview.waitingApprovalCount} · Revizyon bekleyen işler: {summary.pendingReview.revisionRequestedCount}</p>
      <p>Son etkileşim: {summary.latestInteraction ? <Link to={paths.job(summary.latestInteraction.jobCardId)}>{summary.latestInteraction.title}</Link> : 'Yok'}</p>
      <p>Sonraki planlı iş: {summary.nextPlannedWork ? <Link to={paths.job(summary.nextPlannedWork.jobCardId)}>{summary.nextPlannedWork.title}</Link> : 'Yok'}</p>
    </>}
  </section>;
}

export function DuplicateComparisonView({ data, reviewPanel }: { data: DuplicateComparison; reviewPanel?: ReactNode }) {
  const { customerA: a, customerB: b, evidence } = data;
  const codes = evidence.matchingCodes;
  const fields: { key: keyof Pick<typeof a, 'name' | 'taxNumber' | 'phone' | 'email' | 'city' | 'district' | 'address'>; label: string; match: boolean; conflict?: boolean }[] = [
    { key: 'name', label: 'İsim', match: codes.some((c) => c !== 'SAME_PHONE') },
    { key: 'phone', label: 'Telefon', match: codes.includes('SAME_NAME_AND_PHONE') || codes.includes('SAME_PHONE') },
    { key: 'email', label: 'E-posta', match: codes.includes('SAME_NAME_AND_EMAIL') },
    { key: 'taxNumber', label: 'Vergi numarası', match: false, conflict: evidence.warnings.length > 0 },
    ...(['city', 'district', 'address'] as const).map((key, i) => ({ key, label: ['Şehir', 'İlçe', 'Adres'][i]!, match: codes.includes('SAME_NAME_AND_ADDRESS') })),
  ];
  return <>
    <DuplicateComparisonNotice />
    <p>Son okuma: <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString('tr-TR')}</time>. Görünürken 60 saniyede bir yenilenir.</p>
    <ul aria-label="Eşleşme gerekçeleri">{codes.map((code) => <li key={code}>{duplicateReasonLabels[code]}</li>)}</ul>
    {evidence.warnings.length > 0 && <p className="duplicate-warning" role="status">Çelişki: İki dolu vergi numarası farklı. Ortak bilgiler kesin kimlik kanıtı değildir.</p>}
    <section className="duplicate-comparison" aria-label="İki müşteri karşılaştırması">
      <div className="duplicate-identities">{[a, b].map((customer, i) => <div key={customer.id}>
        <h2>Müşteri {i ? 'B' : 'A'}: {customer.name}</h2>
        <p className="duplicate-id">Kayıt: {customer.id}</p>
        <p>{customerStatusLabels[customer.status]} · {customerTypeLabels[customer.customerType]}</p>
        <Link className="secondary-button" to={paths.customer(customer.id)}>Müşteri {i ? 'B' : 'A'} detayını aç</Link>
      </div>)}</div>
      {fields.map((field) => <section className="duplicate-field" key={field.key} aria-label={`Alan: ${field.label}`}>
        <h3>{field.label}{field.match ? <span className="duplicate-field-signal">Eşleşen bilgi</span> : field.conflict ? <span className="duplicate-field-signal duplicate-warning">Çelişen bilgi</span> : null}</h3>
        <dl className="duplicate-field-values">{[a, b].map((customer, i) => <div key={customer.id}><dt>Müşteri {i ? 'B' : 'A'}</dt><dd>{customer[field.key] ?? 'Belirtilmedi'}</dd></div>)}</dl>
      </section>)}
      <section className="duplicate-field" aria-label="İlgili kişiler">
        <h3>İlgili kişiler</h3><p>Destekleyici karşılaştırma bilgileri; tek başına aday üretmez. Tekrarlanan iletişim değerleri ek bağımsız kanıt sayılmaz. Aktif ve pasif kişilerin tamamı gösterilir.</p>
        <div className="duplicate-identities">{[a, b].map((customer, i) => <section key={customer.id}>
          <h4>Müşteri {i ? 'B' : 'A'} — ilgili kişiler</h4>
          {customer.contacts.length === 0 ? <p>İlgili kişi yok.</p> : <ul className="duplicate-contacts">{customer.contacts.map((contact) => <li key={contact.id}>
            <h5>{contact.name}</h5><p>{contact.isActive ? 'Aktif' : 'Pasif'}{contact.isPrimary ? ' · Birincil kişi' : ''}</p>
            <dl><div><dt>Unvan</dt><dd>{contact.title ?? 'Belirtilmedi'}</dd></div><div><dt>Telefon</dt><dd>{contact.phone ?? 'Belirtilmedi'}</dd></div><div><dt>E-posta</dt><dd>{contact.email ?? 'Belirtilmedi'}</dd></div></dl>
          </li>)}</ul>}
          <OperationalSummary key={customer.id} customerId={customer.id} />
        </section>)}</div>
      </section>
    </section>
    {reviewPanel}
  </>;
}

export function DuplicateComparisonScreen({ user }: { user: CurrentUser }) {
  const { aId = '', bId = '' } = useParams(); const location = useLocation();
  const state = useDuplicateRead(`${aId}:${bId}`, (signal) => getDuplicateComparison(aId, bId, signal), true, readPauseScope('DETAIL', user));
  const navigation = useOptionalRouteNavigation();
  const entry = location.state as { duplicateFocus?: unknown } | null;
  const returnTarget = navigation?.returnTarget ?? { to: paths.duplicateCustomers, label: 'Olası mükerrerler' };
  const focusState = typeof entry?.duplicateFocus === 'string' ? { duplicateFocus: entry.duplicateFocus } : undefined;
  return <main className="workspace duplicate-workspace" aria-busy={state.busy}>
    <PageHeader fallbackTitle="Müşteri karşılaştırması"
      returnSlot={<Link className="route-return-link" to={returnTarget.to} state={focusState} aria-label={`${returnTarget.label}'e dön`}>‹ {returnTarget.label}</Link>}
      actions={<button type="button" className="secondary-button" onClick={state.reload} disabled={state.busy || state.retryAt !== null}>Yenile</button>} />
    {state.busy && !state.data && <LoadingSkeleton title="Karşılaştırma yükleniyor" rows={6} />}
    {state.error && <DuplicateReadError error={state.error} retainedData={state.data !== null} retryAt={state.retryAt} retryAuto={state.retryAuto} busy={state.busy} onReload={state.reload}
      notFoundTitle="Karşılaştırılabilir müşteri çifti bulunamadı"
      notFoundDescription="Bu çift kullanılamıyor veya erişim kapsamınızda değil. Olası mükerrerler listesine dönüp başka bir çift seçebilirsiniz." />}
    {state.data && <DuplicateComparisonView data={state.data} reviewPanel={<DuplicateReviewPanel user={user} aId={aId} bId={bId} data={state.data} onRefresh={state.reload} />} />}
    {state.busy && state.data && <p role="status">Karşılaştırma güncelleniyor…</p>}
  </main>;
}
