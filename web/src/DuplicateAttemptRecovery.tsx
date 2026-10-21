import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type CurrentUser } from './services/api';
import {
  decideDuplicateReview, reopenDuplicateReview, type DuplicateCommandReceipt,
  duplicateDecisionReasonLabels,
} from './services/duplicate-customers-api';
import {
  clearDuplicateAttempt, clearDuplicateCommandRetryAt, readDuplicateAttempt, readDuplicateCommandRetryAt,
  subscribeDuplicateCommandCooldown, writeDuplicateCommandRetryAt, type DuplicateAttempt,
} from './duplicate-review-attempt';
import { classifyDuplicateRecoveryFailure, duplicateRecoveryRequest, duplicateRecoveryRetryable, duplicateRecoveryRetryDelay } from './duplicate-recovery';

type RecoveryState = 'idle' | 'sending' | 'receipt' | 'no-commit' | 'uncertain' | 'forbidden';

/**
 * Narrow recovery surface for an actor-bound frozen attempt whose response was
 * lost. It only replays the original clientActionId/payload; it never mints a
 * new intent and never renders a stored receipt as current review state.
 */
export function DuplicateAttemptRecovery({ user, aId, bId }: {
  user: Pick<CurrentUser, 'id' | 'organizationId'>; aId: string; bId: string;
}) {
  const [attempt, setAttempt] = useState<DuplicateAttempt | null>(() => readDuplicateAttempt(user.organizationId, user.id, aId, bId));
  const [state, setState] = useState<RecoveryState>('idle');
  const [receipt, setReceipt] = useState<DuplicateCommandReceipt | null>(null);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState<number | null>(() => readDuplicateCommandRetryAt(user.organizationId, user.id));
  const sending = useRef(false);

  useEffect(() => {
    setAttempt(readDuplicateAttempt(user.organizationId, user.id, aId, bId));
    setRetryAt(readDuplicateCommandRetryAt(user.organizationId, user.id));
    setState('idle'); setReceipt(null); setError('');
  }, [aId, bId, user.id, user.organizationId]);

  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => {
      clearDuplicateCommandRetryAt(user.organizationId, user.id);
      setRetryAt(null);
    }, Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt, user.id, user.organizationId]);

  // Sibling recovery rows share the same actor/org COMMAND cooldown.
  useEffect(() => subscribeDuplicateCommandCooldown(user.organizationId, user.id, (until) => {
    setRetryAt(until !== null && until > Date.now() ? until : null);
  }), [user.id, user.organizationId]);

  const waitingForRetry = retryAt !== null && Date.now() < retryAt;
  // A settled receipt or a definitive no-commit must stay visible after the frozen attempt is cleared.
  if (!attempt && state === 'idle') return null;

  async function replay(frozen: DuplicateAttempt) {
    if (sending.current || waitingForRetry) return;
    // Re-read the shared cooldown at send time; a sibling may have set it since render.
    const shared = readDuplicateCommandRetryAt(user.organizationId, user.id);
    if (shared !== null && Date.now() < shared) { setRetryAt(shared); return; }
    sending.current = true;
    setState('sending'); setError('');
    try {
      const request = duplicateRecoveryRequest(frozen, aId, bId);
      const settled = request.kind === 'REOPEN'
        ? await reopenDuplicateReview(request.aId, request.bId, request.body)
        : await decideDuplicateReview(request.aId, request.bId, request.body);
      clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
      setAttempt(null); setReceipt(settled); setState('receipt');
    } catch (failure) {
      const api = failure instanceof ApiError ? failure : null;
      const outcome = classifyDuplicateRecoveryFailure(failure);
      if (outcome === 'forbidden') {
        setState('forbidden');
        setError('Yetkiniz şu anda doğrulanamıyor. Kayıtlı istek korunuyor; yetkiniz doğrulandığında tekrar deneyin.');
        return;
      }
      if (outcome === 'definitive-no-commit') {
        clearDuplicateAttempt(user.organizationId, user.id, aId, bId);
        setAttempt(null); setState('no-commit');
        setError(`${api!.message} İstek uygulanmadı; kayıtlı taslak kapatıldı. Yeni bir karar için güncel kaydı inceleyin.`);
        return;
      }
      const delay = duplicateRecoveryRetryDelay(failure);
      if (delay !== null) {
        const until = Date.now() + delay;
        writeDuplicateCommandRetryAt(user.organizationId, user.id, until);
        setRetryAt(until);
      }
      setState('uncertain');
      setError(api
        ? `${api.message} ${duplicateRecoveryRetryable(failure) ? 'Sonuç hâlâ belirsiz' : 'Sonuç doğrulanamadı'}; kayıtlı istek korunuyor.`
        : 'İsteğin sonucu doğrulanamadı. Kayıtlı istek korunuyor.');
    } finally {
      sending.current = false;
    }
  }

  return <section className="duplicate-review" aria-labelledby="duplicate-recovery-heading" aria-busy={state === 'sending'}>
    <h2 id="duplicate-recovery-heading" tabIndex={-1}>Yanıtı alınamamış inceleme isteği</h2>
    <p>Bu çift için bu tarayıcıda saklanmış, sonucu doğrulanmamış bir istek var. Yalnız özgün istek kimliği ve yükü yeniden gönderilir; yeni bir karar oluşturulmaz.</p>
    {attempt && <p className="duplicate-id">İstek: {attempt.kind === 'REOPEN' ? 'Yeniden inceleme' : attempt.decision === 'CONFIRMED_DUPLICATE' ? 'Mükerrer doğrulama' : 'Eşleşmeyi reddetme'}
      {attempt.reasonCode && ` · ${duplicateDecisionReasonLabels[attempt.reasonCode]}`} · <time dateTime={new Date(attempt.createdAt).toISOString()}>{new Date(attempt.createdAt).toLocaleString('tr-TR')}</time></p>}
    {waitingForRetry && <p role="status">Kota sınırı nedeniyle yaklaşık {Math.max(1, Math.ceil((retryAt! - Date.now()) / 1000))} saniye bekleyin. Süre dolunca yalnız özgün istek yeniden gönderilebilir.</p>}
    {state === 'idle' && attempt && <button type="button" className="secondary-button" onClick={() => void replay(attempt)} disabled={waitingForRetry}>Özgün isteği tekrar dene</button>}
    {state === 'sending' && <p role="status">Özgün istek doğrulanıyor…</p>}
    {state === 'uncertain' && attempt && <button type="button" className="secondary-button" onClick={() => void replay(attempt)} disabled={waitingForRetry}>Özgün isteği tekrar dene</button>}
    {state === 'forbidden' && <p className="duplicate-warning" role="alert">{error}</p>}
    {state === 'no-commit' && <p className="duplicate-warning" role="status">{error}</p>}
    {error && state !== 'forbidden' && state !== 'no-commit' && <p className="duplicate-warning" role="alert">{error}</p>}
    {state === 'receipt' && receipt && <div role="status">
      <p className="duplicate-success">İstek daha önce kaydedilmiş: makbuz doğrulandı.</p>
      <p className="duplicate-warning">Bu makbuz güncel inceleme durumu değildir. Güncel karar ve kanıt için inceleme kaydını yeniden okuyun.</p>
      <dl>
        <div><dt>İnceleme</dt><dd>{receipt.reviewId} · sürüm {receipt.reviewVersion}</dd></div>
        <div><dt>Olay</dt><dd>{receipt.eventKind === 'REVIEW_REOPENED' ? 'Yeniden inceleme' : 'Karar'} · {receipt.eventId}</dd></div>
        <div><dt>Sonuç</dt><dd>{receipt.resultingStatus} · {receipt.reasonCode}</dd></div>
        <div><dt>Zaman</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString('tr-TR')}</time></dd></div>
      </dl>
      <p><Link className="secondary-button" to="/customers/duplicate-reviews">İnceleme kayıtlarına git</Link></p>
    </div>}
  </section>;
}
