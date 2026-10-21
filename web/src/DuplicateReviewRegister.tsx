import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  duplicateDecisionReasonLabels, duplicateEffectiveLabels, duplicateFreshnessLabels,
  duplicateFreshnessReasonLabels, duplicateReasonLabels, listDuplicateReviewRegister,
  type DuplicateRegisterItem, type DuplicateRegisterPage,
} from './services/duplicate-customers-api';
import { customerStatusLabels } from './services/crm-api';
import { DuplicateReadError } from './DuplicateCustomers';
import { DuplicateAttemptRecovery } from './DuplicateAttemptRecovery';
import { DuplicateReviewHistory } from './DuplicateReviewHistory';
import { PageHeader } from './ui/PageHeader';
import { EmptyState } from './ui/antd/EmptyState';
import { LoadingSkeleton } from './ui/antd/LoadingSkeleton';
import { buildContextState } from './shell/context-return';
import { useDuplicateRead, duplicateReadPauseScope } from './useDuplicateRead';
import './duplicate-customers.css';

function RegisterReviewRow({ item, contextState, user }: { item: DuplicateRegisterItem; contextState: Record<string, unknown> | null; user?: CurrentUser }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { review } = item;
  const decision = review.currentDecision ?? review.lastDecision;
  const identities = [
    { label: 'Müşteri A', customer: item.customerA },
    { label: 'Müşteri B', customer: item.customerB },
  ];
  const comparable = item.sourceAvailability === 'AVAILABLE' && item.comparisonStatus === 'READY';
  return <article className="duplicate-candidate" aria-labelledby={`register-${item.reviewId}`}>
    <h2 id={`register-${item.reviewId}`}>İnceleme kaydı</h2>
    <p className="duplicate-id">Kayıt: {item.reviewId} · Sürüm {review.version}</p>
    {item.sourceAvailability === 'UNAVAILABLE'
      ? <p className="duplicate-warning" role="status">Kaynak müşteriler artık kullanılamıyor. Geçmiş karar güvenli alanlarıyla korunur; karşılaştırma ve yeni karar açılamaz.</p>
      : <div className="duplicate-identities">{identities.map(({ label, customer }) => customer && <div key={customer.id}>
        <h3><span>{label}: </span>{customer.name}</h3>
        <p>{customerStatusLabels[customer.status]} · {[customer.city, customer.district].filter(Boolean).join(', ') || 'Konum belirtilmedi'}</p>
        <p className="duplicate-id">Kayıt: {customer.id}</p>
      </div>)}</div>}
    {!comparable && user && <DuplicateAttemptRecovery user={user} aId={item.pair.customerAId} bId={item.pair.customerBId} />}
    {!comparable && user && <div className="duplicate-history-access">
      <button type="button" className="secondary-button" aria-expanded={historyOpen} aria-controls={`register-history-${item.reviewId}`}
        onClick={() => setHistoryOpen((open) => !open)}>
        {historyOpen ? 'Karar geçmişini kapat' : 'Karar geçmişini aç'}
      </button>
      {historyOpen && <div id={`register-history-${item.reviewId}`}>
        <DuplicateReviewHistory reviewId={item.reviewId} pauseScope={duplicateReadPauseScope('DETAIL', user)} />
      </div>}
    </div>}
    <p role="status" className="duplicate-review-summary">
      <strong>{duplicateEffectiveLabels[review.effectiveStatus]}</strong>
      <span> · {duplicateFreshnessLabels[review.freshness]}</span>
      {review.freshnessReason && <span> · {duplicateFreshnessReasonLabels[review.freshnessReason]}</span>}
    </p>
    {item.matchingCodes.length > 0 && <ul className="duplicate-reasons" aria-label="Son kaydedilen eşleşme gerekçeleri">
      {item.matchingCodes.map((code) => <li key={code}>{duplicateReasonLabels[code]}</li>)}
    </ul>}
    {decision && <p>Son karar: <strong>{duplicateDecisionReasonLabels[decision.reasonCode]}</strong> · <time dateTime={decision.decidedAt}>{new Date(decision.decidedAt).toLocaleString('tr-TR')}</time> · Aktör: {decision.actorUserId}</p>}
    {item.comparisonStatus === 'OVER_BUDGET' && <p role="status" className="duplicate-warning">Kanıt bütçesi aşıldı. Bu çift için karşılaştırma açılamaz; kayıt listede kalır.</p>}
    {comparable && <Link id={`register-open-${item.reviewId}`} className="secondary-button"
      to={paths.duplicateComparison(item.pair.customerAId, item.pair.customerBId)}
      state={{ ...(contextState ?? {}), duplicateFocus: `register-open-${item.reviewId}` }}>
      İncelemeyi aç<span className="sr-only">: {item.customerA?.name} / {item.customerB?.name}</span>
    </Link>}
  </article>;
}

export function DuplicateRegisterView({ data, error, busy, retryAt = null, retryAuto = true, onReload, onFirst, onNext, laterPage = false, view = 'ATTENTION', onViewChange, user }: {
  data: DuplicateRegisterPage | null; error: Error | null; busy: boolean; retryAt?: number | null; retryAuto?: boolean;
  onReload: () => void; onFirst: () => void; onNext: () => void; laterPage?: boolean;
  view?: 'ATTENTION' | 'ALL'; onViewChange?: (view: 'ATTENTION' | 'ALL') => void; user?: CurrentUser;
}) {
  const location = useLocation();
  const contextState = buildContextState(location);
  return <main className="workspace duplicate-workspace" aria-busy={busy}>
    <PageHeader fallbackTitle="İnceleme kayıtları" actions={<button className="secondary-button" type="button" onClick={laterPage ? onFirst : onReload} disabled={busy || (!laterPage && retryAt !== null)}>{laterPage ? 'İlk sayfayı yenile' : 'Yenile'}</button>} />
    <p className="duplicate-notice">Kalıcı inceleme kayıtları. Güncel aday listesinde artık görünmeyen çiftler de burada kalır. Bu ekran hiçbir müşteri kaydını değiştirmez, birleştirmez veya silmez.</p>
    <p><Link className="secondary-button" to={paths.duplicateCustomers}>Olası mükerrerlere dön</Link></p>
    {onViewChange && <label className="duplicate-reason">Kayıt görünümü
      <select aria-label="Kayıt görünümü" value={view} onChange={(event) => onViewChange(event.target.value as 'ATTENTION' | 'ALL')} disabled={busy}>
        <option value="ATTENTION">İlgilenilmesi gerekenler</option><option value="ALL">Tüm inceleme kayıtları</option>
      </select>
    </label>}
    {busy && !data && <LoadingSkeleton title="İnceleme kayıtları yükleniyor" rows={4} />}
    {error && <DuplicateReadError error={error} retainedData={data !== null} retryAt={retryAt} retryAuto={retryAuto} busy={busy}
      onReload={error instanceof ApiError && error.code === 'CURSOR_RESTART_REQUIRED' ? onFirst : onReload} notFoundTitle="İnceleme kaydı bulunamadı"
      notFoundDescription="Bu kayıt kullanılamıyor veya erişim kapsamınızda değil." />}
    {data && <>
      <p className="text-muted">Son okuma: <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString('tr-TR')}</time>. {laterPage ? 'Bu sayfa otomatik başa dönmez. Güncel kapsam için ilk sayfayı yenileyin.' : 'Görünürken 60 saniyede bir yenilenir.'}</p>
      {!error && data.items.length === 0 && (data.page.exhausted
        ? <EmptyState title={view === 'ATTENTION' ? 'İlgilenilmesi gereken inceleme kaydı yok' : 'İnceleme kaydı yok'} description="Bu sonuç, kayıtların aynı müşteri olduğuna ilişkin bir karar değildir." />
        : <p role="status">Bu ara sayfada gösterilecek kayıt yok. Kayıtları sürdürün.</p>)}
      <ol className="duplicate-candidates">{data.items.map((item) => <li key={item.reviewId}>
        <RegisterReviewRow item={item} contextState={contextState} user={user} />
      </li>)}</ol>
      <nav className="duplicate-pagination" aria-label="İnceleme kaydı sayfaları">
        {laterPage && <button className="secondary-button" type="button" onClick={onFirst} disabled={busy}>İlk sayfa</button>}
        {!data.page.exhausted && <button className="primary-button" type="button" onClick={onNext} disabled={busy}>{data.items.length ? 'Sonraki sayfa' : 'Kayıtları sürdür'}</button>}
        <span role="status">{busy ? 'Güncelleniyor…' : `Bu sayfada ${data.page.returnedItems} kayıt`}</span>
      </nav>
    </>}
  </main>;
}

export function DuplicateReviewRegisterScreen({ user }: { user: CurrentUser }) {
  const [params, setParams] = useSearchParams();
  const laterPage = params.has('cursor');
  const state = useDuplicateRead(params.toString(), (signal) => listDuplicateReviewRegister(params, signal), !laterPage, duplicateReadPauseScope('LIST', user));
  const first = () => {
    if (!laterPage) { state.reload(); return; }
    const next = new URLSearchParams(params); next.delete('cursor'); setParams(next);
  };
  return <DuplicateRegisterView {...state} user={user} view={params.get('view') === 'ALL' ? 'ALL' : 'ATTENTION'}
    onViewChange={(view) => { const next = new URLSearchParams(params); next.set('view', view); next.delete('cursor'); setParams(next); }}
    onReload={state.reload} onFirst={first} laterPage={laterPage}
    onNext={() => { if (state.data?.page.nextCursor) { const next = new URLSearchParams(params); next.set('cursor', state.data.page.nextCursor); setParams(next); } }} />;
}
