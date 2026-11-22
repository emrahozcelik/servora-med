import { useEffect, useId, useState } from 'react';

import { formatDurationSeconds } from '../ui/duration';
import type {
  LatenessGroupCounts,
  OrganizationLatenessSummary,
  ResolvedReportRange,
} from './report-types';
import { getLatenessSummary } from './reports-api';
import { ReportErrorState } from './report-shell';

const TITLE = 'Gecikme kayıtları';
const EMPTY_PERIOD = 'Bu dönemde gecikme kaydı yok.';

const integer = new Intl.NumberFormat('tr-TR');

function formatInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

function formatCalendarDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function countsLabel(counts: LatenessGroupCounts) {
  return `${integer.format(counts.incidentCount)} kayıt · ${integer.format(counts.delayedJobCount)} iş`;
}

/** Organization card body. */
function LatenessSummaryView({
  summary,
  onRefresh,
}: {
  summary: OrganizationLatenessSummary;
  onRefresh?: () => void;
}) {
  const id = useId();
  const groups = [
    { key: 'staff', label: 'Personel sorumluluğunda', counts: summary.staffResponsibility },
    { key: 'operational', label: 'Değişiklik talebiyle ilişkili', counts: summary.operational },
    { key: 'unknown', label: 'Sorumlusu belirlenemeyen', counts: summary.unknownAccountability },
  ];
  const wait = summary.managementApprovalWait;
  const trackingNote = summary.range.from < summary.trackingStartedOn
    ? `Gecikme kayıtları ${formatCalendarDate(summary.trackingStartedOn)}'dan önce eksik olabilir.`
    : null;

  return (
    <section className="report-section report-lateness" aria-labelledby={`${id}-title`}>
      <div className="report-section-heading">
        <h2 id={`${id}-title`}>{TITLE}</h2>
        <button type="button" className="secondary-button" disabled={!onRefresh} onClick={onRefresh}>
          Yenile
        </button>
      </div>
      <p className="report-range">
        {formatCalendarDate(summary.range.from)} – {formatCalendarDate(summary.range.to)}
      </p>
      <p className="report-section-hint">
        Durumlar {formatInstant(summary.generatedAt, summary.range.timezone)} itibarıyladır.
      </p>
      {trackingNote && <p className="report-section-hint">{trackingNote}</p>}
      {summary.totalIncidentCount === 0
        ? <p className="report-empty-copy">{EMPTY_PERIOD}</p>
        : <>
          <dl className="report-metrics report-lateness-metrics">
            {groups.map((group) => <div key={group.key}>
              <dt>{group.label}</dt>
              <dd>{countsLabel(group.counts)}</dd>
            </div>)}
          </dl>
          <section className="report-lateness-wait" aria-labelledby={`${id}-wait`}>
            <h3 id={`${id}-wait`}>Yönetici onayı beklemesi</h3>
            <p className="report-lateness-wait-count">{countsLabel(wait)}</p>
            {(wait.recovered.count > 0 || wait.open.count > 0) && <dl className="report-lateness-wait-durations">
              {wait.recovered.count > 0 && <>
                <div>
                  <dt>Ortanca süre</dt>
                  <dd>{wait.recovered.medianSeconds === null
                    ? '—'
                    : formatDurationSeconds(wait.recovered.medianSeconds)}</dd>
                </div>
                <div>
                  <dt>En uzun süre</dt>
                  <dd>{wait.recovered.maxSeconds === null
                    ? '—'
                    : formatDurationSeconds(wait.recovered.maxSeconds)}</dd>
                </div>
              </>}
              {wait.open.count > 0 && <div>
                <dt>Devam eden en uzun süre</dt>
                <dd>{wait.open.maxElapsedSeconds === null
                  ? '—'
                  : formatDurationSeconds(wait.open.maxElapsedSeconds)}</dd>
              </div>}
            </dl>}
          </section>
        </>}
    </section>
  );
}

/**
 * OVR-7 organization lateness card on the Reports page. Fetched independently
 * like the business trend, so a failure here never hides the operational
 * summary.
 */
export function LatenessSummaryCard({ range }: { range: ResolvedReportRange }) {
  const [summary, setSummary] = useState<OrganizationLatenessSummary | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const from = range.from;
  const to = range.to;

  useEffect(() => {
    let current = true;
    setSummary(null);
    setError('');
    getLatenessSummary({ from, to }).then((next) => {
      if (current) setSummary(next);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Gecikme kayıtları yüklenemedi.');
    });
    return () => { current = false; };
  }, [from, to, attempt]);

  if (error) {
    return <ReportErrorState
      title="Gecikme kayıtları yüklenemedi"
      message={error}
      onRetry={() => setAttempt((current) => current + 1)}
    />;
  }
  if (!summary) {
    return <section className="report-section report-lateness report-lateness-loading" aria-busy="true">
      <h2>{TITLE}</h2>
      <p role="status">Gecikme kayıtları yükleniyor…</p>
    </section>;
  }
  return <LatenessSummaryView
    summary={summary}
    onRefresh={() => setAttempt((current) => current + 1)}
  />;
}
