import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  CompletedTrendCalendar,
  IndependentMeterBars,
  SegmentedDistributionBar,
  TrendBars,
} from './report-charts';
import {
  approvalQueueHref,
  jobsOverdueHref,
  jobsStatusHref,
} from './report-action-links';
import {
  formatRefreshTime,
  formatWaitingDuration,
  resolveDatePreset,
  type ReportDatePreset,
} from './report-range';
import {
  dashboardSearch,
  readDashboardSearch,
  validateRequestedRange,
} from './report-search';
import type {
  ApprovalReportResponse,
  DashboardReportResponse,
} from './report-types';
import { getApprovalReport, getDashboardReport } from './reports-api';
import {
  ReportDateRangeForm,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

type AttentionCard = {
  key: string;
  title: string;
  detail: string;
  actionLabel: string;
  href: string;
};

function buildAttentionCards(
  dashboard: DashboardReportResponse,
  approval: ApprovalReportResponse | null,
): AttentionCard[] {
  const cards: AttentionCard[] = [];
  const { counters, range } = dashboard;

  if (counters.waitingApproval > 0) {
    const oldest = approval?.summary.oldestWaitingMinutes;
    cards.push({
      key: 'waiting',
      title: `${counters.waitingApproval} iş onay bekliyor`,
      detail: oldest != null
        ? `En eskisi ${formatWaitingDuration(oldest)} süredir bekliyor.`
        : 'Yönetici onayı olmadan tamamlanamaz.',
      actionLabel: 'Onay kuyruğunu aç',
      href: approvalQueueHref(),
    });
  }

  if (counters.overdueJobCards > 0) {
    cards.push({
      key: 'overdue',
      title: `${counters.overdueJobCards} iş gecikmiş`,
      detail: 'Termin tarihi geçmiş açık işler.',
      actionLabel: 'Geciken işleri aç',
      href: jobsOverdueHref(range.timezone),
    });
  }

  if (counters.revisionRequested > 0) {
    cards.push({
      key: 'revision',
      title: `${counters.revisionRequested} iş düzeltme bekliyor`,
      detail: 'Personelin revizyon tamamlaması gerekiyor.',
      actionLabel: 'Düzeltme bekleyenleri aç',
      href: jobsStatusHref('REVISION_REQUESTED'),
    });
  }

  // Max three action cards; queue signals take priority over pure SLA aging.
  return cards.slice(0, 3);
}

export function ReportsDashboardView({
  report,
  approval,
}: {
  report: DashboardReportResponse;
  approval: ApprovalReportResponse | null;
}) {
  const primary = [
    { key: 'waiting', label: 'Onay bekleyen', value: report.counters.waitingApproval, tone: 'warning' as const },
    { key: 'overdue', label: 'Geciken', value: report.counters.overdueJobCards, tone: 'danger' as const },
    { key: 'revision', label: 'Düzeltme bekleyen', value: report.counters.revisionRequested, tone: 'warning' as const },
  ];
  const secondary = [
    ['Aktif işler', report.counters.activeJobCards, 'Şu an'],
    ['Bu dönemde tamamlanan', report.counters.completedInPeriod, 'Seçilen dönem'],
    ['Bu dönemde iptal edilen', report.counters.cancelledInPeriod, 'Seçilen dönem'],
  ] as const;

  const attention = buildAttentionCards(report, approval);
  const slaSegments = approval
    ? [
      { key: 'under2', label: '2 saatten kısa', value: approval.summary.under2Hours },
      { key: 'between2And8', label: '2–8 saat', value: approval.summary.between2And8Hours },
      { key: 'between8And24', label: '8–24 saat', value: approval.summary.between8And24Hours },
      { key: 'over24', label: '24 saatten uzun', value: approval.summary.over24Hours },
    ]
    : null;

  const trendTotal = report.completedTrend.reduce((sum, point) => sum + point.count, 0);

  return (
    <>
      <section className="report-section" aria-labelledby="overview-kpi-title">
        <h2 id="overview-kpi-title">Genel durum</h2>
        <dl className="report-metrics report-metrics-secondary">
          {secondary.map(([label, value, scope]) => (
            <div key={label}>
              <dt>
                {label}
                <span>{scope}</span>
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="report-section" aria-labelledby="attention-kpi-title">
        <h2 id="attention-kpi-title">Öncelikli göstergeler</h2>
        <dl className="report-metrics report-metrics-primary">
          {primary.map((item) => (
            <div key={item.key} className={`report-metric-card report-metric-card--${item.tone}`}>
              <dt>
                {item.label}
                <span>Şu an</span>
              </dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        <IndependentMeterBars items={primary} />
      </section>

      {attention.length > 0 ? (
        <section className="report-section" aria-labelledby="attention-title">
          <h2 id="attention-title">Dikkat</h2>
          <ul className="report-attention-list">
            {attention.map((card) => (
              <li key={card.key} className="report-attention-card">
                <div>
                  <h3>{card.title}</h3>
                  <p>{card.detail}</p>
                </div>
                <Link className="secondary-button" to={card.href}>{card.actionLabel}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="report-section" aria-labelledby="trend-title" data-report-trend-section="true">
        <h2 id="trend-title">Tamamlanma eğilimi</h2>
        <p className="report-chart-summary" data-report-trend-summary="true">
          {report.completedTrend.length === 0
            ? 'Seçilen dönemde tamamlanma yok.'
            : `Seçilen dönemde günlük tamamlanan işler. Toplam ${trendTotal} tamamlanma.`}
        </p>
        {report.completedTrend.length > 0 ? (
          <TrendBars points={report.completedTrend} />
        ) : null}
        <details className="report-data-disclosure">
          <summary>Tamamlanan işler</summary>
          <CompletedTrendCalendar points={report.completedTrend} />
        </details>
      </section>

      <section className="report-section" aria-labelledby="sla-title">
        <h2 id="sla-title">Onay bekleme dağılımı</h2>
        {slaSegments ? (
          <>
            <SegmentedDistributionBar segments={slaSegments} />
            <dl className="approval-summary report-sla-summary">
              <div>
                <dt>Toplam bekleyen</dt>
                <dd>{approval!.summary.pendingCount}</dd>
              </div>
              <div>
                <dt>En uzun bekleme</dt>
                <dd>
                  {approval!.summary.oldestWaitingMinutes === null
                    ? 'Yok'
                    : formatWaitingDuration(approval!.summary.oldestWaitingMinutes)}
                </dd>
              </div>
              <div>
                <dt>Ortalama bekleme</dt>
                <dd>
                  {approval!.summary.averageWaitingMinutes === null
                    ? 'Yok'
                    : formatWaitingDuration(approval!.summary.averageWaitingMinutes)}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="report-section-hint">Onay bekleme özeti yüklenemedi; özet sayaçlar yine de geçerlidir.</p>
        )}
      </section>
    </>
  );
}

export function ReportsDashboard() {
  const [search, setSearch] = useSearchParams();
  const state = readDashboardSearch(search);
  const [report, setReport] = useState<DashboardReportResponse | null>(null);
  const [approval, setApproval] = useState<ApprovalReportResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filterError, setFilterError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const range = state.from && state.to ? { from: state.from, to: state.to } : null;
      const [nextDashboard, nextApproval] = await Promise.all([
        getDashboardReport(range),
        getApprovalReport({ limit: 1, offset: 0 }).catch(() => null),
      ]);
      if (requestId !== requestSequence.current) return;
      setReport(nextDashboard);
      setApproval(nextApproval);
      setResolvedTimezone(nextDashboard.range.timezone);
      setRefreshedAt(new Date());
      if (!state.from || !state.to) {
        setSearch(dashboardSearch({ ...nextDashboard.range, canonical: true }), { replace: true });
      }
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Rapor özeti yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [state.from, state.to, setSearch]);

  useEffect(() => {
    if (!state.canonical) setSearch(dashboardSearch(state), { replace: true });
  }, [state, setSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = validateRequestedRange(
      String(data.get('from') ?? ''),
      String(data.get('to') ?? ''),
    );
    if (!result.ok) {
      setFilterError(result.errors[0]?.message ?? 'Tarih aralığı geçersiz.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setFilterError('');
    setSearch(dashboardSearch({ ...result.value, canonical: true }));
  }

  function applyPreset(preset: ReportDatePreset) {
    if (!resolvedTimezone) return;
    const range = resolveDatePreset(preset, resolvedTimezone);
    setFilterError('');
    setSearch(dashboardSearch({ ...range, canonical: true }));
  }

  const refreshLabel = refreshedAt && resolvedTimezone
    ? formatRefreshTime(refreshedAt, resolvedTimezone)
    : null;
  const rangeContext = { from: state.from, to: state.to };

  return (
    <ReportShell
      title="Operasyon özeti"
      current="summary"
      refreshLabel={refreshLabel}
      range={rangeContext}
    >
      <ReportDateRangeForm
        formKey={`${state.from}:${state.to}`}
        from={state.from ?? ''}
        to={state.to ?? ''}
        filterError={filterError}
        errorRef={errorRef}
        onSubmit={submit}
        onPreset={applyPreset}
        presetsDisabled={!resolvedTimezone}
      />
      {loading && <ReportLoadingState title="Rapor özeti yükleniyor" />}
      {!loading && error && (
        <ReportErrorState
          title="Rapor özeti yüklenemedi"
          message={error}
          onRetry={() => void load()}
        />
      )}
      {!loading && !error && report && (
        <ReportsDashboardView report={report} approval={approval} />
      )}
    </ReportShell>
  );
}
