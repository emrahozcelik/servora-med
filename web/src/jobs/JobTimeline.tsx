import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { ActivityTimeline, type ActivityTimelineItem } from '../ui/antd';
import { ResultState } from '../ui/antd/ResultState';
import { historicalJobStatusLabels, isKnownJobCardActivityEvent, jobActivityLabel } from './job-labels';
import { listActivity, type JobCardActivity, type JobCardActivityDetails, type Paginated } from './jobs-api';
import { formatLocationDistance } from './location-distance-format';

const PAGE_SIZE = 50;
const fieldLabels = {
  title: 'Başlık', description: 'Açıklama', customer: 'Müşteri', contact: 'Görüşülecek kişi',
  assignee: 'Sorumlu', priority: 'Öncelik', dueDate: 'Termin', scheduledAt: 'Planlanan zaman',
  scheduledEndsAt: 'Planlanan bitiş', engagementKind: 'Görüşme türü',
} as const;
const meetingFieldLabels = {
  meetingAt: 'Gerçekleşme zamanı', outcome: 'Sonuç', unsuccessfulReason: 'Başarısız görüşme nedeni',
  meetingSummary: 'Görüşme özeti',
  nextFollowUpAt: 'Takip zamanı',
  metContactId: 'Görüşülen kişi',
} as const;
const locationFailureLabels = {
  PERMISSION_DENIED: 'Konum izni reddedildi',
  POSITION_UNAVAILABLE: 'Cihaz konumu belirleyemedi',
  TIMEOUT: 'Konum isteği zaman aşımına uğradı',
  UNSUPPORTED: 'Tarayıcı konumu desteklemiyor',
  UNKNOWN: 'Bilinmeyen konum hatası',
} as const;

type TimelineState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<JobCardActivity> }
  | { kind: 'error'; message: string; retryable: boolean };

function actionLocationSuffix(
  location: NonNullable<Extract<JobCardActivityDetails, { kind: 'STATUS_TRANSITION' }>['startLocation']>,
  takenLabel: string,
  missingLabel: string,
) {
  if (location.outcome === 'UNAVAILABLE') {
    return ` · ${missingLabel}: ${locationFailureLabels[location.reason]}`;
  }
  const address = location.approximateLabel ?? 'Yaklaşık adres oluşturulamadı';
  const accuracy = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 })
    .format(location.accuracyMeters);
  const attribution = location.geocodingProvider === 'GOOGLE'
    && location.approximateLabel
    ? ' · Adres verisi: Google Maps'
    : '';
  return ` · ${takenLabel}: ${address} · Doğruluk: yaklaşık ${accuracy} metre · Yakalama zamanı: ${formatInstant(location.capturedAt)}${attribution}`;
}

/**
 * Slice 2 advisory comparison suffix. Only DIFFERENT is visually alarming;
 * UNRELIABLE is neutral; MATCH adds nothing (understated by design).
 */
function comparisonSuffixText(
  comparison: Extract<JobCardActivityDetails, { kind: 'STATUS_TRANSITION' }>['submitComparison'],
): string {
  if (!comparison) return '';
  if (comparison.outcome === 'DIFFERENT') {
    return ` · Başlangıç konumundan farklı: yaklaşık ${formatLocationDistance(comparison.distanceMeters)}`;
  }
  if (comparison.outcome === 'UNRELIABLE') {
    return ' · Konum doğruluğu güvenilir karşılaştırma için yetersiz.';
  }
  return '';
}

function detailText(details: JobCardActivityDetails) {
  if (details.kind === 'STATUS_TRANSITION') {
    const transition = `${historicalJobStatusLabels[details.fromStatus]} → ${historicalJobStatusLabels[details.toStatus]}`;
    const startSuffix = details.startLocation
      ? actionLocationSuffix(details.startLocation, 'Konum', 'Konum alınamadı')
      : '';
    // Slice 1: basic SUBMIT snapshot only; no comparison or anomaly badges.
    const submitSuffix = details.submitLocation
      ? actionLocationSuffix(details.submitLocation, 'Onaya gönderme konumu', 'Onaya gönderme konumu alınamadı')
      : '';
    // Slice 2: advisory comparison. DIFFERENT warns without implying
    // misconduct; UNRELIABLE stays neutral; MATCH stays understated.
    const comparisonSuffix = comparisonSuffixText(details.submitComparison);
    return `${transition}${startSuffix}${submitSuffix}${comparisonSuffix}`;
  }
  if (details.kind === 'FIELDS_UPDATED') return details.changedFields.map((field) => fieldLabels[field]).join(', ');
  if (details.kind === 'DELIVERY_ITEM') {
    const operation = { ADDED: 'Eklendi', UPDATED: 'Güncellendi', REMOVED: 'Kaldırıldı' }[details.operation];
    return details.quantity === null ? operation : `${operation}, miktar ${details.quantity}`;
  }
  if (details.kind === 'SALE_RELATION') return 'Bağlı satışlar erişim yetkinize göre gösterilir';
  if (details.kind === 'SALE_DETAILS') return details.changedFields.map((field) => field === 'soldAt' ? 'Satış zamanı' : 'Satışta görüşülen kişi').join(', ');
  if (details.kind === 'SALE_ITEM') return details.productName + ' · ' + (details.previousQuantity && details.operation === 'UPDATED' ? details.previousQuantity + ' → ' : '') + details.quantity;
  if (details.kind === 'NOTE') return 'Not geçmişe eklendi';
  if (details.kind === 'MEETING_DETAILS') return details.changedFields
    .map((field) => meetingFieldLabels[field]).join(', ');
  return '';
}

function transitionReason(details: JobCardActivityDetails): string | null {
  return details.kind === 'STATUS_TRANSITION' ? details.reason : null;
}

function formatInstant(value: string) {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

function presentActivity(activity: JobCardActivity): ActivityTimelineItem {
  return {
    key: activity.id,
    action: jobActivityLabel(activity.eventType),
    detail: detailText(activity.details),
    reason: transitionReason(activity.details),
    actor: activity.actor?.name ?? 'Sistem',
    occurredAt: activity.createdAt,
    occurredAtLabel: formatInstant(activity.createdAt),
  };
}

export function JobTimeline({ jobId, refreshKey = 0, load = listActivity }: {
  jobId: string;
  refreshKey?: number;
  load?: typeof listActivity;
}) {
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<TimelineState>({ kind: 'loading' });
  const previousRefreshKey = useRef(refreshKey);

  useEffect(() => {
    if (previousRefreshKey.current !== refreshKey) {
      previousRefreshKey.current = refreshKey;
      if (offset !== 0) { setOffset(0); return; }
    }
    let active = true;
    setState({ kind: 'loading' });
    load(jobId, { limit: PAGE_SIZE, offset })
      .then((page) => { if (active) setState({ kind: 'ready', page }); })
      .catch((caught) => {
        if (!active) return;
        const error = caught instanceof ApiError
          ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'İşlem geçmişi yüklenemedi.', true);
        setState({ kind: 'error', message: error.message, retryable: error.retryable });
      });
    return () => { active = false; };
  }, [jobId, load, offset, refreshKey, reloadKey]);

  useEffect(() => {
    if (state.kind !== 'ready' || !import.meta.env.DEV) return;
    for (const activity of state.page.items) {
      if (!isKnownJobCardActivityEvent(activity.eventType)) {
        console.warn('Unknown JobCard activity event', { eventType: activity.eventType });
      }
    }
  }, [state]);

  return <section className="job-timeline" aria-labelledby="job-timeline-title">
    <h2 id="job-timeline-title">İşlem geçmişi</h2>
    <p className="timeline-order-note">En yeni işlem üstte</p>
    {state.kind === 'loading' && <div aria-busy="true"><p>İşlem geçmişi yükleniyor</p></div>}
    {state.kind === 'error' && <ResultState status="error" title="İşlem geçmişi yüklenemedi" description={state.message} headingLevel={3}
      action={state.retryable ? <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button> : undefined}
    />}
    {state.kind === 'ready' && (state.page.items.length === 0
      ? <p className="detail-empty">Henüz işlem geçmişi yok.</p>
      : <ActivityTimeline items={state.page.items.map(presentActivity)} />)}
    {state.kind === 'ready' && state.page.total > state.page.limit && <nav className="job-pagination" aria-label="İşlem geçmişi sayfaları">
      <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Önceki</button>
      <span>{offset + 1}–{Math.min(offset + state.page.items.length, state.page.total)} / {state.page.total}</span>
      <button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= state.page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Sonraki</button>
    </nav>}
  </section>;
}
