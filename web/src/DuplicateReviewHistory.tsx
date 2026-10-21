import { useRef, useState } from 'react';
import { ApiError } from './services/api';
import {
  duplicateDecisionLabels, duplicateDecisionReasonLabels, getDuplicateReviewHistory,
  type DuplicateDecision, type DuplicateDecisionReason, type DuplicateHistoryPage,
} from './services/duplicate-customers-api';
import { useDuplicateRead } from './useDuplicateRead';

function formatDate(value: string) {
  return new Date(value).toLocaleString('tr-TR');
}

function decisionText(reasonCode: string) {
  return duplicateDecisionReasonLabels[reasonCode as DuplicateDecisionReason] ?? reasonCode;
}

export function DuplicateReviewHistory({ reviewId, pauseScope }: { reviewId: string; pauseScope: string }) {
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
