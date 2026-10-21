import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type CurrentUser } from './services/api';
import {
  attemptMatchesCurrent, clearDuplicateAttempt, readDuplicateAttempt,
  readDuplicateCommandRetryAt, writeDuplicateCommandRetryAt, writeDuplicateAttempt, type DuplicateAttempt,
} from './duplicate-review-attempt';
import { ConfirmationAction } from './ui/antd/ConfirmationAction';
import { duplicateReadPauseScope, useDuplicateRead } from './useDuplicateRead';
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

function History({ reviewId, pauseScope }: { reviewId: string; pauseScope: string }) {
  const [windowRevision, setWindowRevision] = useState(0);
  const restartRequired = useRef(false);
  const cursor = useRef<string | null>(null);
  const loaded = useRef<DuplicateHistoryPage | null>(null);
  const read = useDuplicateRead(`${reviewId}:${windowRevision}`, async (signal) => {
    try {
      const previous = loaded.current;
      const next = await getDuplicateReviewHistory(reviewId, cursor.current, signal);
      if (signal.aborted) return next;
      const seen = new Set(previous?.items.map(item => item.eventId));
      const result = cursor.current && previous
        ? { ...next, items: [...previous.items, ...next.items.filter(item => !seen.has(item.eventId))] }
        : next;
      loaded.current = result;
      restartRequired.current = false;
      return result;
    } catch (failure) {
      if (!signal.aborted && failure instanceof ApiError && ([401, 403, 404].includes(failure.status) || failure.code === 'CURSOR_RESTART_REQUIRED')) {
        loaded.current = null; cursor.current = null;
        restartRequired.current = failure.code === 'CURSOR_RESTART_REQUIRED';
      }
      throw failure;
    }
  }, false, pauseScope);
  const { busy: loading, error, retryAt, retryAuto } = read;
  const cursorRestartRequired = restartRequired.current;
  const page = loaded.current === read.data ? read.data : null;
  const waiting = retryAt !== null;
  const accessLost = error instanceof ApiError && [401, 403, 404].includes(error.status);
  function more() {
    if (!page?.nextCursor || loading || waiting) return;
    cursor.current = page.nextCursor;
    void read.reload();
  }
  return <section className="duplicate-history" aria-label="Karar geçmişi">
    <h2>Karar geçmişi</h2>
    {loading && !page && <p role="status">Geçmiş yükleniyor…</p>}
    {error && <p role="alert">{error.message} {page && 'Gösterilen geçmiş son başarılı okumaya aittir; güncelliği doğrulanamadı.'}</p>}
    {waiting && <p role="status">Karar geçmişi ve karşılaştırma kotası nedeniyle yaklaşık {Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} saniye bekleyin. {retryAuto ? 'Süre dolunca görünür ekranda bir kez otomatik olarak yeniden denenecek.' : 'Süre dolunca geçmişi tekrar deneyin.'}</p>}
    {cursorRestartRequired && <p role="status">Önceki geçmiş sayfaları temizlendi. Tekrar denediğinizde güncel ilk sayfa yüklenecek.</p>}
    {error && !accessLost && <button type="button" className="secondary-button" onClick={() => { if (cursorRestartRequired) setWindowRevision(value => value + 1); else void read.reload(); }} disabled={loading || waiting}>Geçmişi tekrar dene</button>}
    {page && page.items.length === 0 && <p>Henüz karar geçmişi yok.</p>}
    {page && page.items.length > 0 && <ol className="duplicate-history-list">
      {page.items.map((item) => <li key={item.eventId}>
        <h3>{item.eventKind === 'DECISION_RECORDED' ? duplicateDecisionLabels[item.resultingStatus as DuplicateDecision] : 'Yeniden incelemeye açıldı'}</h3>
        <p>{decisionText(item.reasonCode)} · Sıra {item.seq}</p>
        <p><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time> · Aktör: {item.actorUserId}</p>
        {item.warnings.length > 0 && <p className="duplicate-warning">Vergi numaraları çelişiyor.</p>}
      </li>)}
    </ol>}
    {page?.nextCursor && <button type="button" className="secondary-button" onClick={more} disabled={loading || waiting}>{loading ? 'Yükleniyor…' : 'Daha eski kararlar'}</button>}
  </section>;
}

export function DuplicateReviewPanel({ user, aId, bId, data, onRefresh }: {
  user: CurrentUser; aId: string; bId: string; data: DuplicateComparison; onRefresh: () => void | Promise<boolean>;
}) {
  const [choice, setChoice] = useState<DuplicateDecision | ''>('');
  const [reason, setReason] = useState<DuplicateDecisionReason | ''>('');
  const [draftContext, setDraftContext] = useState<Pick<DuplicateAttempt, 'expectedReviewVersion' | 'expectedEvidenceRevision' | 'matchingRuleVersion'> | null>(null);
  const [attempt, setAttempt] = useState<DuplicateAttempt | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const sending = useRef(false);
  const commandOpener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reconciliation, setReconciliation] = useState<'PENDING' | 'FAILED' | 'CURRENT' | null>(null);
  const [mustReinspect, setMustReinspect] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const restoredFor = useRef('');
  const identity = `${user.organizationId}:${user.id}:${aId < bId ? aId : bId}:${aId < bId ? bId : aId}`;

  useEffect(() => {
    if (restoredFor.current === identity) return;
    restoredFor.current = identity;
    setChoice(''); setReason(''); setDraftContext(null); setAttempt(null); setError(''); setFeedback(''); setSubmitted(false); setConfirmOpen(false);
    setMustReinspect(false); setRetryAt(readDuplicateCommandRetryAt(user.organizationId, user.id));
    setReconciliation(null);
    const restored = readDuplicateAttempt(user.organizationId, user.id, aId, bId);
    if (restored) {
      setAttempt(restored);
      setSubmitted(true);
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
  const reviewedNow = { expectedReviewVersion: review.version, expectedEvidenceRevision: data.evidence.revision, matchingRuleVersion: data.evidence.matchingRuleVersion };
  const attemptStale = attempt ? !attemptMatchesCurrent(attempt, review, data.evidence.revision, data.evidence.matchingRuleVersion) : false;
  const draftStale = draftContext ? !attemptMatchesCurrent(draftContext, review, data.evidence.revision, data.evidence.matchingRuleVersion) : false;
  const blockedByChange = mustReinspect || attemptStale || draftStale;
  const needsReconciliation = reconciliation === 'PENDING' || reconciliation === 'FAILED';
  const canDecide = data.allowedActions.includes('DECIDE') && !blockedByChange && !pending && attempt === null && !needsReconciliation;
  const canReopen = data.allowedActions.includes('REOPEN') && !blockedByChange && !pending && attempt === null && !needsReconciliation;
  const isTerminal = terminalStatuses.has(review.effectiveStatus);
  const waitingForRetry = retryAt !== null && Date.now() < retryAt;
  const reasonOptions = useMemo(() => (choice ? duplicateReasonOptions[choice] : []), [choice]);

  function beginDecision() {
    if (!canDecide) return;
    if (!choice || !reason) { setError('Önce bir karar ve gerekçe seçin.'); return; }
    if (blockedByChange) { setError('Güncel kanıtı incelemeden yeni istek oluşturulamaz.'); return; }
    commandOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : heading.current;
    const next: DuplicateAttempt = {
      version: 1, kind: 'DECIDE', clientActionId: crypto.randomUUID(),
      ...(draftContext ?? reviewedNow), decision: choice, reasonCode: reason,
      createdAt: Date.now(),
    };
    setAttempt(next); setError(''); setConfirmOpen(true);
  }

  function beginReopen() {
    if (!canReopen) return;
    if (blockedByChange) { setError('Güncel kanıtı incelemeden yeni istek oluşturulamaz.'); return; }
    commandOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : heading.current;
    const next: DuplicateAttempt = {
      version: 1, kind: 'REOPEN', clientActionId: crypto.randomUUID(),
      expectedReviewVersion: review.version, expectedEvidenceRevision: data.evidence.revision,
      matchingRuleVersion: data.evidence.matchingRuleVersion, createdAt: Date.now(),
    };
    setAttempt(next); setError(''); setConfirmOpen(true);
  }

  function cancelConfirmation() {
    if (pending) return;
    setConfirmOpen(false);
    if (submitted) return;
    setAttempt(null);
    clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
  }

  async function reconcile() {
    setReconciliation('PENDING');
    try { setReconciliation(await onRefresh() === true ? 'CURRENT' : 'FAILED'); }
    catch { setReconciliation('FAILED'); }
  }

  async function send(frozen: DuplicateAttempt) {
    if (sending.current || waitingForRetry || readDuplicateCommandRetryAt(user.organizationId, user.id) !== null || (!submitted && blockedByChange)) return;
    try { writeDuplicateAttempt(user.organizationId, user.id, aId, bId, frozen); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Taslak saklanamadı. İşlem gönderilmedi.'); return; }
    sending.current = true; setSubmitted(true);
    setPending(true); setError(''); setFeedback('');
    try {
      if (frozen.kind === 'REOPEN') {
        await reopenDuplicateReview(aId, bId, {
          clientActionId: frozen.clientActionId, expectedReviewVersion: frozen.expectedReviewVersion,
          expectedEvidenceRevision: frozen.expectedEvidenceRevision, matchingRuleVersion: frozen.matchingRuleVersion,
        });
        setFeedback('İnceleme yeniden açıldı.');
      } else {
        await decideDuplicateReview(aId, bId, {
          clientActionId: frozen.clientActionId, expectedReviewVersion: frozen.expectedReviewVersion,
          expectedEvidenceRevision: frozen.expectedEvidenceRevision, matchingRuleVersion: frozen.matchingRuleVersion,
          decision: frozen.decision!, reasonCode: frozen.reasonCode!,
        });
        setFeedback('İnceleme kararı kaydedildi.');
      }
      clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
      commandOpener.current = heading.current;
      setAttempt(null); setSubmitted(false); setChoice(''); setReason(''); setDraftContext(null); setConfirmOpen(false); setMustReinspect(false);
      setReloadKey((value) => value + 1);
      await reconcile();
    } catch (failure) {
      commandOpener.current = heading.current;
      setConfirmOpen(false);
      const api = failure instanceof ApiError ? failure : null;
      const definitiveNoCommit = (api?.status === 404 && api.code === 'DUPLICATE_PAIR_NOT_FOUND')
        || (api?.status === 422 && api.code === 'EVIDENCE_LIMIT_EXCEEDED');
      if (api && (conflictCodes.has(api.code) || definitiveNoCommit)) {
        clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
        setAttempt(null); setSubmitted(false); setConfirmOpen(false); setMustReinspect(true);
        setError(definitiveNoCommit
          ? `${api.message} İstek uygulanmadı. Yeni bir istekten önce müşteri kapsamı ve güncel kanıt yeniden doğrulanmalı.`
          : `${api.message} Gerekçeniz korunuyor; güncel kanıtı inceledikten sonra yeni bir istek oluşturun.`);
        setReloadKey((value) => value + 1);
        await reconcile();
      } else if (api && (retryCodes.has(api.code) || api.status === 0 || api.status >= 500)) {
        setError(`${api.message} Aynı istek korunuyor; sonucu doğrulamak için tekrar deneyin.`);
        if (api.code === 'RATE_LIMIT_EXCEEDED') {
          const until = Date.now() + (api.retryAfterSeconds ?? 60) * 1000;
          writeDuplicateCommandRetryAt(user.organizationId, user.id, until); setRetryAt(until);
        }
      } else {
        setError(failure instanceof Error ? failure.message : 'İnceleme kaydedilemedi.');
      }
    } finally { sending.current = false; setPending(false); }
  }

  const attemptLabel = attempt?.kind === 'REOPEN' ? 'Yeniden inceleme isteğini tekrar dene' : 'Özgün isteği tekrar dene';

  return <section className="duplicate-review" aria-labelledby="duplicate-review-heading" aria-busy={pending}>
    <h2 id="duplicate-review-heading" ref={heading} tabIndex={-1}>İnceleme</h2>
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
    {reconciliation === 'PENDING' && <p role="status">Güncel durum doğrulanıyor… Gösterilen karşılaştırma son başarılı okumaya aittir.</p>}
    {reconciliation === 'FAILED' && <div role="status" className="duplicate-warning"><p>Güncel durum doğrulanamadı. {feedback && 'İşlem makbuzu kaydedildi. '}Gösterilen karşılaştırma son başarılı okumaya aittir.</p><button type="button" className="secondary-button" onClick={() => void reconcile()}>Güncel durumu doğrula</button></div>}
    {reconciliation === 'CURRENT' && <p role="status">Güncel durum yüklendi.</p>}
    {error && <p className="duplicate-warning" role="alert">{error}</p>}
    {(mustReinspect || draftStale) && !attempt && <button type="button" className="secondary-button" onClick={() => { if (needsReconciliation) return; setDraftContext(reviewedNow); setMustReinspect(false); setError(''); }} disabled={needsReconciliation}>Güncel kanıtı inceledim</button>}
    {attempt && attemptStale && <div role="status" className="duplicate-warning">
      <p>Kanıt veya inceleme sürümü değişti. Kayıtlı istek otomatik olarak yeni kanıta bağlanmaz.</p>
      {!submitted && <button type="button" className="secondary-button" onClick={() => {
        setAttempt(null); setConfirmOpen(false); setDraftContext(reviewedNow); setMustReinspect(false); setError('');
      }}>Güncel kanıtı inceledim; yeni istek oluştur</button>}
    </div>}
    {attempt && submitted && !pending && !feedback && <div className="duplicate-unresolved" role="status">
      <p>Bekleyen bir inceleme isteği geri yüklendi. Sonuç belirsizse aynı isteği güvenle tekrar deneyebilirsiniz.</p>
      <button type="button" className="secondary-button" onClick={() => void send(attempt)} disabled={waitingForRetry || pending}>{attemptLabel}</button>
    </div>}
    {(isTerminal || canReopen) && <div className="duplicate-terminal">
      <p>Son karar: <strong>{review.currentDecision ? decisionText(review.currentDecision.reasonCode) : '—'}</strong>{review.currentDecision && <> · {formatDate(review.currentDecision.decidedAt)} · Aktör: {review.currentDecision.actorUserId}</>}</p>
      {data.allowedActions.includes('REOPEN') && <button type="button" className="secondary-button" onClick={beginReopen} disabled={!canReopen || waitingForRetry}>Yeniden incele</button>}
    </div>}
    {!isTerminal && review.effectiveStatus !== 'BLOCKED' && review.effectiveStatus !== 'UNAVAILABLE' && data.allowedActions.includes('DECIDE') && <div className="duplicate-decision">
      <fieldset disabled={!canDecide || pending || waitingForRetry}>
        <legend>İnceleme kararı</legend>
        <p>Gerekçe zorunludur. Karar yalnız bu müşteri çifti için geçerlidir.</p>
        {decisionOptions.map(([value, label]) => <label key={value} className="duplicate-radio">
          <input type="radio" name="duplicate-decision" value={value} checked={choice === value} onChange={() => { setDraftContext((old) => old ?? reviewedNow); setChoice(value); setReason(''); }} />
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
      <button type="button" className="secondary-button" onClick={() => { setChoice(''); setReason(''); setDraftContext(null); setError(''); }} disabled={pending || attempt !== null}>Daha sonra</button>
    </div>}
    {review.effectiveStatus === 'BLOCKED' || review.effectiveStatus === 'UNAVAILABLE' ? <p role="status" className="duplicate-warning">Bu çift için karar verilemiyor. Kaynak veya kanıt bütünü doğrulanamıyor; mevcut geçmiş korunuyor.</p> : null}
    {review.id && <History key={`${identity}:${review.id}:${review.version}:${reloadKey}`} reviewId={review.id} pauseScope={duplicateReadPauseScope('DETAIL', user)} />}
    <ConfirmationAction
      open={confirmOpen}
      title={attempt?.kind === 'REOPEN' ? 'Yeniden incelemeye aç' : attempt?.decision === 'DISMISSED' ? 'Eşleşmeyi reddet' : 'Mükerrer olarak doğrula'}
      description={attempt?.kind === 'REOPEN'
        ? 'Eski karar silinmez; aynı çift için yeni bir inceleme turu açılır.'
        : `Yalnız inceleme kararı kaydedilir. ${attempt?.reasonCode ? decisionText(attempt.reasonCode) : ''} Müşteri kayıtları birleştirilmez, pasifleştirilmez veya silinmez.`}
      details={attempt && attempt.kind === 'DECIDE' && attempt.decision ? [`Karar: ${duplicateDecisionLabels[attempt.decision]}`, `Gerekçe: ${attempt.reasonCode ? decisionText(attempt.reasonCode) : ''}`] : []}
      confirmLabel={attempt?.kind === 'REOPEN' ? 'Yeniden incelemeye aç' : 'Kararı kaydet'}
      pending={pending}
      confirmDisabled={waitingForRetry || (!submitted && blockedByChange)}
      returnFocusRef={commandOpener}
      fallbackFocusRef={heading}
      onConfirm={() => { if (attempt) void send(attempt); }}
      onCancel={cancelConfirmation}
    />
  </section>;
}
