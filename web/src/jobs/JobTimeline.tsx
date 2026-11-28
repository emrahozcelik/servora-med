import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  ActivityTimeline,
  type ActivityTimelineItem,
  type ActivityTimelineTone,
} from '../ui/antd';
import { ResultState } from '../ui/antd/ResultState';
import type { SignalGlyphName } from '../ui/signal-icons';
import {
  assignmentOfferCloseReasonLabel,
  assignmentSuggestedSolutionLabel,
  changeRequestResolutionLabel,
  historicalJobStatusLabels,
  isKnownJobCardActivityEvent,
  jobActivityLabel,
  type KnownJobCardActivityEvent,
} from './job-labels';
import { listActivity, type JobCardActivity, type JobCardActivityDetails, type Paginated } from './jobs-api';
import { formatLocationDistance } from './location-distance-format';

type ActivityVisualMeta = Readonly<{
  tone: ActivityTimelineTone;
  icon: SignalGlyphName;
}>;

const ACTIVITY_META: Record<KnownJobCardActivityEvent, ActivityVisualMeta> = {
  JOB_APPROVED: { tone: 'success', icon: 'timeline-success' },
  JOB_ACCEPTED: { tone: 'success', icon: 'timeline-success' },
  JOB_OVERDUE_ENDED_BY_EXTENSION: { tone: 'success', icon: 'timeline-success' },
  JOB_CHANGE_REQUEST_RESOLVED: { tone: 'success', icon: 'timeline-success' },
  SALE_FROM_VISIT_CREATED: { tone: 'success', icon: 'timeline-success' },
  SALE_DELIVERY_CREATED: { tone: 'success', icon: 'timeline-success' },

  JOB_CREATED: { tone: 'info', icon: 'timeline-info' },
  JOB_ASSIGNED: { tone: 'info', icon: 'timeline-info' },
  JOB_PLANNED: { tone: 'info', icon: 'timeline-info' },
  JOB_STARTED: { tone: 'info', icon: 'timeline-info' },
  JOB_RESUMED: { tone: 'info', icon: 'timeline-info' },
  JOB_ASSIGNMENT_OFFER_OPENED: { tone: 'info', icon: 'timeline-info' },
  JOB_ASSIGNMENT_RELEASED: { tone: 'info', icon: 'timeline-info' },

  JOB_SUBMITTED_FOR_APPROVAL: { tone: 'warning', icon: 'timeline-warning' },
  JOB_REVISION_REQUESTED: { tone: 'warning', icon: 'timeline-warning' },
  JOB_APPROVAL_WITHDRAWN: { tone: 'warning', icon: 'timeline-warning' },
  JOB_SUBMISSION_REMINDER_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_SUBMISSION_AUTO_REMINDER_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_SUBMISSION_AUTO_ESCALATION_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_START_REMINDER_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_APPROVAL_WAIT_ALERT_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_PENDING_ACCEPTANCE_ALERT_SENT: { tone: 'warning', icon: 'timeline-warning' },
  JOB_EARLY_START_AUTHORIZED: { tone: 'warning', icon: 'timeline-warning' },
  JOB_CHANGE_REQUESTED: { tone: 'warning', icon: 'timeline-warning' },
  JOB_ASSIGNMENT_DECLINED: { tone: 'warning', icon: 'timeline-warning' },
  JOB_ASSIGNMENT_OFFER_EXPIRED: { tone: 'warning', icon: 'timeline-warning' },
  JOB_ASSIGNMENT_OFFER_WITHDRAWN: { tone: 'warning', icon: 'timeline-warning' },
  JOB_ASSIGNMENT_REMINDER_SENT: { tone: 'warning', icon: 'timeline-warning' },

  JOB_CANCELLED: { tone: 'danger', icon: 'timeline-danger' },
  JOB_INVALIDATED: { tone: 'danger', icon: 'timeline-danger' },
  WEEKLY_REPORT_REMOVED: { tone: 'danger', icon: 'timeline-danger' },

  JOB_FIELDS_UPDATED: { tone: 'neutral', icon: 'timeline-neutral' },
  DELIVERY_ITEM_ADDED: { tone: 'neutral', icon: 'timeline-neutral' },
  DELIVERY_ITEM_UPDATED: { tone: 'neutral', icon: 'timeline-neutral' },
  DELIVERY_ITEM_REMOVED: { tone: 'neutral', icon: 'timeline-neutral' },
  NOTE_ADDED: { tone: 'neutral', icon: 'timeline-neutral' },
  MEETING_DETAILS_UPDATED: { tone: 'neutral', icon: 'timeline-neutral' },
  SALE_DETAILS_UPDATED: { tone: 'neutral', icon: 'timeline-neutral' },
  SALE_ITEM_ADDED: { tone: 'neutral', icon: 'timeline-neutral' },
  SALE_ITEM_UPDATED: { tone: 'neutral', icon: 'timeline-neutral' },
  SALE_ITEM_REMOVED: { tone: 'neutral', icon: 'timeline-neutral' },
};

function activityPresentationMeta(
  eventType: string,
  details?: JobCardActivityDetails,
): ActivityVisualMeta {
  if (
    eventType === 'JOB_CHANGE_REQUEST_RESOLVED'
    && details?.kind === 'CHANGE_REQUEST_RESOLVED'
    && (details.resolution === 'ACKNOWLEDGED_ONLY' || details.resolution === 'REJECTED')
  ) {
    return { tone: 'info', icon: 'timeline-info' };
  }
  return isKnownJobCardActivityEvent(eventType)
    ? ACTIVITY_META[eventType]
    : { tone: 'neutral', icon: 'timeline-neutral' };
}

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
 * Slice 2 advisory comparison suffix. DIFFERENT is rendered only as the
 * warning badge; UNRELIABLE is neutral text; MATCH adds nothing (understated).
 */
function comparisonSuffixText(
  comparison: Extract<JobCardActivityDetails, { kind: 'STATUS_TRANSITION' }>['submitComparison'],
): string {
  if (!comparison) return '';
  // DIFFERENT is carried once, by the warning badge (submitComparisonBadge).
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
  if (details.kind === 'SALE_ITEM') return details.productName + ' · ' + (details.previousQuantity && details.operation === 'UPDATED' ? details.previousQuantity + ' ürün → ' : '') + details.quantity + ' ürün';
  if (details.kind === 'SALE_DELIVERY') return `${details.itemCount} ürün satırıyla planlı teslim işi açıldı`;
  if (details.kind === 'NOTE') return 'Not geçmişe eklendi';
  if (details.kind === 'ASSIGNMENT_DECISION') {
    // The event label already says declined/released; the detail adds the
    // recorded reason, the Staff member's own words and the typed suggestion.
    // Recorded fact, third person ("İzinli / müsait değil"), not the Staff
    // form's first-person option text.
    const reasonLabel = assignmentOfferCloseReasonLabel(details.reasonCode);
    const reasonText = details.reasonText?.trim();
    // RESCUE-002: the suggestion is part of the answer, when one was recorded.
    const suggestion = details.suggestedSolution
      ? `Personelin önerisi: ${assignmentSuggestedSolutionLabel(details.suggestedSolution)}`
      : null;
    // JOB-012: the proposed time is part of the answer, when one was asked for.
    const proposed = details.proposedScheduledAt !== null
      ? `Önerilen: ${formatInstant(details.proposedScheduledAt)}`
      : null;
    return [
      reasonLabel,
      reasonText ? `“${reasonText}”` : null,
      suggestion,
      proposed,
    ].filter(Boolean).join(' · ');
  }
  if (details.kind === 'MEETING_DETAILS') return details.changedFields
    .map((field) => meetingFieldLabels[field]).join(', ');
  if (details.kind === 'CHANGE_REQUEST_RESOLVED') {
    return changeRequestResolutionLabel(details.resolution);
  }
  return '';
}

function transitionReason(details: JobCardActivityDetails): string | null {
  return details.kind === 'STATUS_TRANSITION' ? details.reason : null;
}

function formatInstant(value: string) {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

function submitComparisonBadge(details: JobCardActivityDetails): ActivityTimelineItem['badge'] {
  if (details.kind !== 'STATUS_TRANSITION') return null;
  if (details.submitComparison?.outcome !== 'DIFFERENT') return null;
  return {
    label: `Başlangıç konumundan farklı: yaklaşık ${formatLocationDistance(details.submitComparison.distanceMeters)}`,
    tone: 'warning',
    testId: 'DIFFERENT',
  };
}

function presentActivity(activity: JobCardActivity): ActivityTimelineItem {
  const meta = activityPresentationMeta(activity.eventType, activity.details);
  return {
    key: activity.id,
    action: jobActivityLabel(activity.eventType),
    detail: detailText(activity.details),
    reason: transitionReason(activity.details),
    actor: activity.actor?.name ?? 'Sistem',
    occurredAt: activity.createdAt,
    occurredAtLabel: formatInstant(activity.createdAt),
    tone: meta.tone,
    icon: meta.icon,
    badge: submitComparisonBadge(activity.details),
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
