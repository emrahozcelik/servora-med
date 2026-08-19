import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { JOB_CARD_TYPES } from '../jobs/jobs-api';
import { jobTypeLabels } from '../jobs/job-labels';
import {
  activeWorkflowPresentation,
  activeWorkflowStatuses,
} from '../jobs/job-status-presentation';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  IndependentMeterBars,
  WorkflowTrend,
} from './report-charts';
import {
  approvalQueueHref,
  jobsStatusHref,
} from './report-action-links';
import {
  formatRefreshTime,
  resolveDatePreset,
  type ReportDatePreset,
} from './report-range';
import {
  dashboardSearch,
  readDashboardSearch,
  validateRequestedRange,
} from './report-search';
import type {
  DashboardReportResponse,
} from './report-types';
import { getDashboardReport } from './reports-api';
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

const EXECUTIVE_PRESET_OPTIONS = [
  { id: 'last7', label: 'Son 7 gün' },
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'last90', label: 'Son 90 gün' },
  { id: 'thisMonth', label: 'Bu ay' },
] as const;

function buildAttentionCards(dashboard: DashboardReportResponse): AttentionCard[] {
  const { counters } = dashboard;
  return [
    {
      key: 'overdue',
      title: `${counters.overdueJobCards} iş gecikmiş`,
      detail: counters.overdueJobCards > 0
        ? 'Termin tarihi geçmiş açık işler.'
        : 'Termin tarihi geçmiş açık iş bulunmuyor.',
      actionLabel: 'Geciken işleri aç',
      href: `${paths.jobs}?overdue=true`,
    },
    {
      key: 'waiting',
      title: `${counters.waitingApproval} iş onay bekliyor`,
      detail: counters.waitingApproval > 0
        ? 'Yönetici onayı olmadan tamamlanamaz.'
        : 'Yönetici onayı bekleyen iş bulunmuyor.',
      actionLabel: 'Onay kuyruğunu aç',
      href: approvalQueueHref(),
    },
    {
      key: 'revision',
      title: `${counters.revisionRequested} iş düzeltme bekliyor`,
      detail: counters.revisionRequested > 0
        ? 'Personelin revizyon tamamlaması gerekiyor.'
        : 'Düzeltme bekleyen iş bulunmuyor.',
      actionLabel: 'Düzeltme bekleyenleri aç',
      href: jobsStatusHref('REVISION_REQUESTED'),
    },
  ];
}

export function ReportsDashboardView({
  report,
}: {
  report: DashboardReportResponse;
}) {
  const executiveMetrics = [
    { key: 'active', label: 'Aktif İşler', value: report.counters.activeJobCards, scope: 'Mevcut durum' },
    { key: 'completed', label: 'Dönemde Tamamlanan', value: report.counters.completedInPeriod, scope: 'Seçilen dönem' },
    { key: 'overdue', label: 'Geciken İşler', value: report.counters.overdueJobCards, scope: 'Mevcut durum' },
    { key: 'waiting', label: 'Onay Bekleyen', value: report.counters.waitingApproval, scope: 'Mevcut durum' },
    { key: 'revision', label: 'Düzeltme Bekleyen', value: report.counters.revisionRequested, scope: 'Mevcut durum' },
  ];

  const attention = buildAttentionCards(report);
  const activeStatusItems = activeWorkflowStatuses.map((status) => ({
    key: status,
    label: activeWorkflowPresentation[status].label,
    value: report.activeStatusDistribution.find((item) => item.status === status)?.count ?? 0,
    tone: status === 'WAITING_APPROVAL'
      ? 'warning' as const
      : status === 'REVISION_REQUESTED' ? 'danger' as const : 'primary' as const,
  }));
  const createdWorkTypeItems = JOB_CARD_TYPES.map((type) => ({
    key: type,
    label: jobTypeLabels[type],
    value: report.createdWorkTypeDistribution.find((item) => item.type === type)?.count ?? 0,
  }));

  return (
    <>
      <section className="report-section" aria-labelledby="overview-kpi-title">
        <h2 id="overview-kpi-title">Genel Durum</h2>
        <dl className="report-metrics report-executive-metrics">
          {executiveMetrics.map((item) => (
            <div key={item.key} data-report-kpi="true">
              <dt>
                {item.label}
                <span>{item.scope}</span>
              </dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        <p className="report-section-hint">Aktif işler, geciken işler ve kuyruk sayaçları mevcut durumu; tamamlanan işler seçilen dönemi gösterir.</p>
      </section>

      <section className="report-section" aria-labelledby="trend-title" data-report-trend-section="true">
        <h2 id="trend-title">İş Akışı Eğilimi</h2>
        <p className="report-section-hint">Seçilen dönemde oluşturulan ve tamamlanan işlerin günlük sayısı.</p>
        <WorkflowTrend created={report.dailyCreatedTrend} completed={report.completedTrend} />
      </section>

      <section className="report-section" aria-labelledby="active-workflow-title">
        <h2 id="active-workflow-title">Mevcut İş Akışı</h2>
        <p className="report-section-hint">Mevcut aktif işlerin iş akışı durumlarına göre dağılımı.</p>
        <IndependentMeterBars
          items={activeStatusItems}
          dataDistribution="active-status"
          ariaLabel="Mevcut iş akışı durumları"
        />
      </section>

      <section className="report-section" aria-labelledby="work-type-title">
        <h2 id="work-type-title">İş Türleri</h2>
        <p className="report-section-hint">Seçilen dönemde oluşturulan işlerin tür dağılımı.</p>
        <IndependentMeterBars
          items={createdWorkTypeItems}
          dataDistribution="created-work-type"
          ariaLabel="Oluşturulan iş türleri"
        />
      </section>

      <section className="report-section" aria-labelledby="attention-title">
        <h2 id="attention-title">Dikkat Gerektirenler</h2>
        <p className="report-section-hint">Şu anda işlem gerektiren iş kuyrukları.</p>
        <ul className="report-attention-list">
          {attention.map((card) => (
            <li key={card.key} className="report-attention-card" data-attention-key={card.key}>
              <div>
                <h3>{card.title}</h3>
                <p>{card.detail}</p>
              </div>
              <Link className="secondary-button" to={card.href}>{card.actionLabel}</Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function ReportsDashboard() {
  const [search, setSearch] = useSearchParams();
  const state = readDashboardSearch(search);
  const [report, setReport] = useState<DashboardReportResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filterError, setFilterError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ReportDatePreset | null>(null);
  const [customPresetActive, setCustomPresetActive] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const range = state.from && state.to ? { from: state.from, to: state.to } : null;
      const nextDashboard = await getDashboardReport(range);
      if (requestId !== requestSequence.current) return;
      setReport(nextDashboard);
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
    if (!resolvedTimezone || !state.from || !state.to) return;
    const matchingPreset = EXECUTIVE_PRESET_OPTIONS.find((preset) => {
      const range = resolveDatePreset(preset.id, resolvedTimezone);
      return range.from === state.from && range.to === state.to;
    });
    setSelectedPreset(matchingPreset?.id ?? null);
    setCustomPresetActive(matchingPreset === undefined);
  }, [resolvedTimezone, state.from, state.to]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtimeInvalidation(['reports', 'approval-queue'], () => { void load(); });

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
    setSelectedPreset(null);
    setCustomPresetActive(true);
    setSearch(dashboardSearch({ ...result.value, canonical: true }));
  }

  function applyPreset(preset: ReportDatePreset) {
    if (!resolvedTimezone) return;
    const range = resolveDatePreset(preset, resolvedTimezone);
    setFilterError('');
    setSelectedPreset(preset);
    setCustomPresetActive(false);
    setSearch(dashboardSearch({ ...range, canonical: true }));
  }

  function chooseCustomRange() {
    setSelectedPreset(null);
    setCustomPresetActive(true);
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('input[name="from"]')?.focus();
    });
  }

  const refreshLabel = refreshedAt && resolvedTimezone
    ? formatRefreshTime(refreshedAt, resolvedTimezone)
    : null;
  const rangeContext = { from: state.from, to: state.to };

  return (
    <ReportShell
      title="Raporlar"
      description="Operasyonunuzun genel durumunu ve seçilen dönemdeki hareketini izleyin."
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
        presetOptions={EXECUTIVE_PRESET_OPTIONS}
        onCustomPreset={chooseCustomRange}
        customPresetActive={customPresetActive}
        selectedPreset={selectedPreset}
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
        <ReportsDashboardView report={report} />
      )}
    </ReportShell>
  );
}
