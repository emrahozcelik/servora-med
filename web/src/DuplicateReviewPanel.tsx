import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type CurrentUser } from './services/api';
import {
  attemptMatchesCurrent, clearDuplicateAttempt, readDuplicateAttempt,
  writeDuplicateAttempt, type DuplicateAttempt,
} from './duplicate-review-attempt';
import { ConfirmationAction } from './ui/antd/ConfirmationAction';
import {
  decideDuplicateReview, duplicateDecisionLabels, duplicateDecisionReasonLabels,
  duplicateEffectiveLabels, duplicateFreshnessLabels, duplicateFreshnessReasonLabels,
  duplicateReasonOptions, getDuplicateReviewHistory, reopenDuplicateReview,
  type DuplicateComparison, type DuplicateDecision, type DuplicateDecisionReason,
  type DuplicateHistoryPage,
} from './services/duplicate-customers-api';

const decisionOptions = Object.entries(duplicateDecisionLabels) as Array<[DuplicateDecision, string]>;
const terminalStatuses = new Set(['CONFIRMED_DUPLICATE', 'DISMISSED', 'REVIEW_REQUIRED']);
const conflictCodes = new Set([
  'VERSION_CONFLICT', 'EVIDENCE_CHANGED', 'MATCHING_RULE_CHANGED',
  'EVIDENCE_KEY_UNAVAILABLE', 'REVIEW_REOPEN_REQUIRED', 'REVIEW_ALREADY_PENDING',
]);
const retryCodes = new Set(['REVIEW_BUSY', 'ACTION_IN_PROGRESS', 'RATE_LIMIT_EXCEEDED']);

function formatDate(value: string) {
  return new Date(value).toLocaleString('tr-TR');
}

function decisionText(reasonCode: string) {
  return duplicateDecisionReasonLabels[reasonCode as DuplicateDecisionReason] ?? reasonCode;
}

function History({ reviewId, version, reloadKey }: { reviewId: string; version: number; reloadKey: number }) {
  const [page, setPage] = useState<DuplicateHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setPage(null);
    getDuplicateReviewHistory(reviewId).then((result) => { if (live) setPage(result); })
      .catch((failure) => { if (live) setError(failure instanceof Error ? failure.message : 'Karar geçmişi yüklenemedi.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reviewId, version, reloadKey]);
  async function more() {
    if (!page?.nextCursor) return;
    setLoading(true); setError('');
    try {
      const next = await getDuplicateReviewHistory(reviewId, page.nextCursor);
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Karar geçmişi yüklenemedi.');
    } finally { setLoading(false); }
  }
  return <section className="duplicate-history" aria-label="Karar geçmişi">
    <h2>Karar geçmişi</h2>
    {loading && !page && <p role="status">Geçmiş yükleniyor…</p>}
    {error && <p role="alert">{error}</p>}
    {page && page.items.length === 0 && <p>Henüz karar geçmişi yok.</p>}
    {page && page.items.length > 0 && <ol className="duplicate-history-list">
      {page.items.map((item) => <li key={item.eventId}>
        <h3>{item.eventKind === 'DECISION_RECORDED' ? duplicateDecisionLabels[item.resultingStatus as DuplicateDecision] : 'Yeniden incelemeye açıldı'}</h3>
        <p>{decisionText(item.reasonCode)} · Sıra {item.seq}</p>
        <p><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time> · Aktör: {item.actorUserId}</p>
        {item.warnings.length > 0 && <p className="duplicate-warning">Vergi numaraları çelişiyor.</p>}
      </li>)}
    </ol>}
    {page?.nextCursor && <button type="button" className="secondary-button" onClick={more} disabled={loading}>{loading ? 'Yükleniyor…' : 'Daha eski kararlar'}</button>}
  </section>;
}

export function DuplicateReviewPanel({ user, aId, bId, data, onRefresh }: {
  user: CurrentUser; aId: string; bId: string; data: DuplicateComparison; onRefresh: () => void;
}) {
  const [choice, setChoice] = useState<DuplicateDecision | ''>('');
  const [reason, setReason] = useState<DuplicateDecisionReason | ''>('');
  const [attempt, setAttempt] = useState<DuplicateAttempt | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [mustReinspect, setMustReinspect] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const restoredFor = useRef('');
  const identity = `${user.organizationId}:${user.id}:${aId < bId ? aId : bId}:${aId < bId ? bId : aId}`;

  useEffect(() => {
    if (restoredFor.current === identity) return;
    restoredFor.current = identity;
    setChoice(''); setReason(''); setAttempt(null); setError(''); setFeedback('');
    setMustReinspect(false); setRetryAt(null);
    const restored = readDuplicateAttempt(user.organizationId, user.id, aId, bId);
    if (restored) {
      setAttempt(restored);
      setChoice(restored.decision ?? '');
      setReason(restored.reasonCode ?? '');
    }
  }, [aId, bId, identity, user.id, user.organizationId]);

  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const review = data.review;
  const attemptStale = attempt ? !attemptMatchesCurrent(attempt, review, data.evidence.revision, data.evidence.matchingRuleVersion) : false;
  const blockedByChange = mustReinspect || attemptStale;
  const canDecide = data.allowedActions.includes('DECIDE') && !blockedByChange && !pending;
  const canReopen = data.allowedActions.includes('REOPEN') && !blockedByChange && !pending;
  const isTerminal = terminalStatuses.has(review.effectiveStatus);
  const waitingForRetry = retryAt !== null && Date.now() < retryAt;
  const reasonOptions = useMemo(() => (choice ? duplicateReasonOptions[choice] : []), [choice]);

  function beginDecision() {
    if (!choice || !reason) { setError('Önce bir karar ve gerekçe seçin.'); return; }
    if (blockedByChange) { setError('Güncel kanıtı incelemeden yeni istek oluşturulamaz.'); return; }
    const next: DuplicateAttempt = {
      version: 1, kind: 'DECIDE', clientActionId: crypto.randomUUID(),
      expectedReviewVersion: review.version, expectedEvidenceRevision: data.evidence.revision,
      matchingRuleVersion: data.evidence.matchingRuleVersion, decision: choice, reasonCode: reason,
      createdAt: Date.now(),
    };
    try { writeDuplicateAttempt(user.organizationId, user.id, aId, bId, next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Taslak saklanamadı.'); return; }
    setAttempt(next); setError(''); setConfirmOpen(true);
  }

  function beginReopen() {
    if (blockedByChange) { setError('Güncel kanıtı incelemeden yeni istek oluşturulamaz.'); return; }
    const next: DuplicateAttempt = {
      version: 1, kind: 'REOPEN', clientActionId: crypto.randomUUID(),
      expectedReviewVersion: review.version, expectedEvidenceRevision: data.evidence.revision,
      matchingRuleVersion: data.evidence.matchingRuleVersion, createdAt: Date.now(),
    };
    try { writeDuplicateAttempt(user.organizationId, user.id, aId, bId, next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Taslak saklanamadı.'); return; }
    setAttempt(next); setError(''); setConfirmOpen(true);
  }

  function cancelConfirmation() {
    if (pending) return;
    setConfirmOpen(false);
    setAttempt(null);
    clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
  }

  async function send(frozen: DuplicateAttempt) {
    setPending(true); setError(''); setFeedback('');
    try {
      if (frozen.kind === 'REOPEN') {
        await reopenDuplicateReview(aId, bId, {
          clientActionId: frozen.clientActionId, expectedReviewVersion: frozen.expectedReviewVersion,
          expectedEvidenceRevision: frozen.expectedEvidenceRevision, matchingRuleVersion: frozen.matchingRuleVersion,
        });
        setFeedback('İnceleme yeniden açıldı. Güncel durum yüklendi.');
      } else {
        await decideDuplicateReview(aId, bId, {
          clientActionId: frozen.clientActionId, expectedReviewVersion: frozen.expectedReviewVersion,
          expectedEvidenceRevision: frozen.expectedEvidenceRevision, matchingRuleVersion: frozen.matchingRuleVersion,
          decision: frozen.decision!, reasonCode: frozen.reasonCode!,
        });
        setFeedback('İnceleme kararı kaydedildi. Güncel durum yüklendi.');
      }
      clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
      setAttempt(null); setChoice(''); setReason(''); setConfirmOpen(false); setMustReinspect(false);
      setReloadKey((value) => value + 1);
      onRefresh();
    } catch (failure) {
      const api = failure instanceof ApiError ? failure : null;
      if (api && conflictCodes.has(api.code)) {
        clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
        setAttempt(null); setConfirmOpen(false); setMustReinspect(true);
        setError(`${api.message} Gerekçeniz korunuyor; güncel kanıtı inceledikten sonra yeni bir istek oluşturun.`);
        setReloadKey((value) => value + 1);
        onRefresh();
      } else if (api && (retryCodes.has(api.code) || api.status === 0 || api.status >= 500)) {
        setError(`${api.message} Aynı istek korunuyor; sonucu doğrulamak için tekrar deneyin.`);
        if (api.code === 'RATE_LIMIT_EXCEEDED') setRetryAt(Date.now() + (api.retryAfterSeconds ?? 60) * 1000);
      } else {
        setError(failure instanceof Error ? failure.message : 'İnceleme kaydedilemedi.');
      }
    } finally { setPending(false); }
  }

  const attemptLabel = attempt?.kind === 'REOPEN' ? 'Yeniden inceleme isteğini tekrar dene' : 'Özgün isteği tekrar dene';

  return <section className="duplicate-review" aria-labelledby="duplicate-review-heading" aria-busy={pending}>
    <h2 id="duplicate-review-heading">İnceleme</h2>
    <p className="duplicate-decision-effect">Bu işlem yalnız müşteri çifti için inceleme kararı kaydeder. Müşteriler birleştirilmez, pasifleştirilmez veya silinmez.</p>
    <p role="status" className="duplicate-review-status">
      <strong>{duplicateEffectiveLabels[review.effectiveStatus]}</strong>
      <span> · {duplicateFreshnessLabels[review.freshness]}</span>
      {review.freshnessReason && <span> · {duplicateFreshnessReasonLabels[review.freshnessReason]}</span>}
      {review.version > 0 && <span> · Sürüm {review.version}</span>}
    </p>
    {review.freshnessReason === 'SOURCE_CHANGED' || review.freshnessReason === 'RULE_CHANGED' || review.freshnessReason === 'KEY_UNAVAILABLE' || review.freshnessReason === 'OVER_BUDGET' || review.freshnessReason === 'SOURCE_UNAVAILABLE'
      ? <p className="duplicate-warning" role="status">Kanıt güncelliği doğrulanamıyor. Eski karar gizlenmez; güncel kanıtı inceleyin.</p>
      : null}
    {feedback && <p className="duplicate-success" role="status">{feedback}</p>}
    {error && <p className="duplicate-warning" role="alert">{error}</p>}
    {mustReinspect && !attempt && <button type="button" className="secondary-button" onClick={() => { setMustReinspect(false); setError(''); }}>Güncel kanıtı inceledim</button>}
    {attempt && attemptStale && <div role="status" className="duplicate-warning">
      <p>Kanıt veya inceleme sürümü değişti. Kayıtlı istek otomatik olarak yeni kanıta bağlanmaz.</p>
      <button type="button" className="secondary-button" onClick={() => {
        clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
        setAttempt(null); setMustReinspect(false); setError('');
      }}>Güncel kanıtı inceledim; yeni istek oluştur</button>
    </div>}
    {attempt && !attemptStale && !pending && !feedback && <div className="duplicate-unresolved" role="status">
      <p>Bekleyen bir inceleme isteği geri yüklendi. Sonuç belirsizse aynı isteği güvenle tekrar deneyebilirsiniz.</p>
      <button type="button" className="secondary-button" onClick={() => void send(attempt)} disabled={waitingForRetry || pending}>{attemptLabel}</button>
    </div>}
    {(isTerminal || canReopen) && <div className="duplicate-terminal">
      <p>Son karar: <strong>{review.currentDecision ? decisionText(review.currentDecision.reasonCode) : '—'}</strong>{review.currentDecision && <> · {formatDate(review.currentDecision.decidedAt)} · Aktör: {review.currentDecision.actorUserId}</>}</p>
      {canReopen && <button type="button" className="secondary-button" onClick={beginReopen}>Yeniden incele</button>}
    </div>}
    {!isTerminal && review.effectiveStatus !== 'BLOCKED' && review.effectiveStatus !== 'UNAVAILABLE' && data.allowedActions.includes('DECIDE') && <div className="duplicate-decision">
      <fieldset disabled={!canDecide || pending || waitingForRetry}>
        <legend>İnceleme kararı</legend>
        <p>Gerekçe zorunludur. Karar yalnız bu müşteri çifti için geçerlidir.</p>
        {decisionOptions.map(([value, label]) => <label key={value} className="duplicate-radio">
          <input type="radio" name="duplicate-decision" value={value} checked={choice === value} onChange={() => { setChoice(value); setReason(''); }} />
          <span>{label}</span>
        </label>)}
        <label className="duplicate-reason">Gerekçe
          <select value={reason} onChange={(event) => setReason(event.target.value as DuplicateDecisionReason | '')} disabled={!choice || !canDecide}>
            <option value="">Gerekçe seçin</option>
            {reasonOptions.map((value) => <option key={value} value={value}>{duplicateDecisionReasonLabels[value]}</option>)}
          </select>
        </label>
      </fieldset>
      {waitingForRetry && <p role="status">Kota nedeniyle yaklaşık {Math.max(1, Math.ceil(((retryAt ?? Date.now()) - Date.now()) / 1000))} saniye bekleyin.</p>}
      {blockedByChange && <p role="status">Güncel kanıtı inceledim düğmesine basmadan yeni istek gönderilemez.</p>}
      <button type="button" className="primary-button compact-button" onClick={beginDecision} disabled={!canDecide || !choice || !reason || waitingForRetry}>
        {choice === 'DISMISSED' ? 'Eşleşmeyi reddet' : 'Mükerrer olarak doğrula'}
      </button>
      <button type="button" className="secondary-button" onClick={() => { setChoice(''); setReason(''); setError(''); }} disabled={pending}>Daha sonra</button>
    </div>}
    {review.effectiveStatus === 'BLOCKED' || review.effectiveStatus === 'UNAVAILABLE' ? <p role="status" className="duplicate-warning">Bu çift için karar verilemiyor. Kaynak veya kanıt bütünü doğrulanamıyor; mevcut geçmiş korunuyor.</p> : null}
    {review.id && <History reviewId={review.id} version={review.version} reloadKey={reloadKey} />}
    <ConfirmationAction
      open={confirmOpen}
      title={attempt?.kind === 'REOPEN' ? 'Yeniden incelemeye aç' : attempt?.decision === 'DISMISSED' ? 'Eşleşmeyi reddet' : 'Mükerrer olarak doğrula'}
      description={attempt?.kind === 'REOPEN'
        ? 'Eski karar silinmez; aynı çift için yeni bir inceleme turu açılır.'
        : `Yalnız inceleme kararı kaydedilir. ${attempt?.reasonCode ? decisionText(attempt.reasonCode) : ''} Müşteri kayıtları birleştirilmez, pasifleştirilmez veya silinmez.`}
      details={attempt && attempt.kind === 'DECIDE' && attempt.decision ? [`Karar: ${duplicateDecisionLabels[attempt.decision]}`, `Gerekçe: ${attempt.reasonCode ? decisionText(attempt.reasonCode) : ''}`] : []}
      confirmLabel={attempt?.kind === 'REOPEN' ? 'Yeniden incelemeye aç' : 'Kararı kaydet'}
      pending={pending}
      onConfirm={() => { if (attempt) void send(attempt); }}
      onCancel={cancelConfirmation}
    />
  </section>;
}
