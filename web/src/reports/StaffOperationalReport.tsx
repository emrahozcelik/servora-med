import { useCallback, useEffect, useState } from 'react';

import { getOwnStaffReport, getStaffReport } from './reports-api';
import type {
  DeliveryPurposeItem,
  RequestedReportRange,
  ResolvedReportRange,
  StaffReportResponse,
} from './report-types';
import type { DeliveryPurpose, MeetingOutcome } from '../jobs/jobs-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  OperationalTable,
  type OperationalTableColumn,
  type OperationalTableRow,
} from '../ui/OperationalTable';
import { EmptyState, LoadingSkeleton, MetricStatistic, ResultState } from '../ui/antd';
import { jobTypeLabels } from '../jobs/job-labels';
import { TrendBars } from './report-charts';

const purposeLabels: Record<DeliveryPurpose, string> = {
  SALE: 'Satış',
  SAMPLE: 'Numune',
  CONSIGNMENT: 'Konsinye',
  RETURN: 'İade',
  OTHER: 'Diğer',
};
const outcomeLabels: Record<MeetingOutcome, string> = {
  POSITIVE: 'Olumlu', FOLLOW_UP_REQUIRED: 'Takip gerekli',
  NO_DECISION: 'Karar verilmedi', NOT_INTERESTED: 'İlgilenmiyor',
};

const DELIVERY_PURPOSE_COLUMNS: readonly OperationalTableColumn[] = [
  { key: 'purpose', title: 'Amaç' },
  { key: 'unit', title: 'Birim' },
  { key: 'quantity', title: 'Miktar' },
];

const MEETING_OUTCOME_COLUMNS: readonly OperationalTableColumn[] = [
  { key: 'outcome', title: 'Sonuç' },
  { key: 'count', title: 'Görüşme sayısı' },
];

const COMPLETION_TREND_COLUMNS: readonly OperationalTableColumn[] = [
  { key: 'date', title: 'Tarih' },
  { key: 'count', title: 'Tamamlanan iş' },
];

function deliveryPurposeRows(items: readonly DeliveryPurposeItem[]): OperationalTableRow[] {
  return items.map((item) => ({
    key: JSON.stringify([item.purpose, item.unit]),
    cells: {
      purpose: purposeLabels[item.purpose],
      unit: item.unit ?? 'Birim belirtilmedi',
      quantity: item.quantity,
    },
  }));
}

function meetingOutcomeRows(
  items: StaffReportResponse['meetingsByOutcome'],
): OperationalTableRow[] {
  return items.map((item) => ({
    key: item.outcome,
    cells: {
      outcome: outcomeLabels[item.outcome],
      count: item.count,
    },
  }));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatReportRange(range: ResolvedReportRange) {
  return `${formatDate(range.from)} – ${formatDate(range.to)} · ${range.timezone}`;
}

function dailyCompletionRows(report: StaffReportResponse): OperationalTableRow[] {
  return report.completedTrend.map((point) => ({
    key: point.date,
    cells: { date: formatDate(point.date), count: point.count },
  }));
}

function DeliveryPurposeTable({ items }: { items: DeliveryPurposeItem[] }) {
  if (items.length === 0) {
    return <EmptyState
      title="Onaylı teslim bulunmuyor"
      description="Bu dönemde onaylı teslim bulunmuyor."
      headingLevel={3}
    />;
  }
  return (
    <OperationalTable
      caption="Onaylı teslimler"
      columns={DELIVERY_PURPOSE_COLUMNS}
      rows={deliveryPurposeRows(items)}
      rowHeaderKey="purpose"
    />
  );
}

function MeetingOutcomeTable({ items }: { items: StaffReportResponse['meetingsByOutcome'] }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return <section className="meeting-outcome-report" aria-labelledby="meeting-outcome-title">
    <h3 id="meeting-outcome-title">Görüşme sonuçları</h3>
    {total === 0 && <p className="report-empty-copy">Bu dönemde onaylı satış görüşmesi bulunmuyor.</p>}
    <OperationalTable
      caption="Görüşme sonuçları"
      columns={MEETING_OUTCOME_COLUMNS}
      rows={meetingOutcomeRows(items)}
      rowHeaderKey="outcome"
    />
  </section>;
}

export function StaffOperationalReport({ report }: { report: StaffReportResponse }) {
  const performance = report.performance;
  const trendTotal = report.completedTrend.reduce((sum, point) => sum + point.count, 0);
  const jobsPerDay = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 })
    .format(performance.jobsPerCompletionDay);
  return <section className="staff-operational-report" aria-labelledby="staff-report-title">
    <div className="report-section-heading">
      <div>
        <p className="eyebrow">Seçilen dönem</p>
        <h2 id="staff-report-title">Performans</h2>
      </div>
      {!report.staff.isActive && <span className="status-label">Pasif personel</span>}
    </div>
    <p className="report-range">{formatReportRange(report.range)}</p>

    <div className="staff-performance-statistics" aria-label="Seçilen dönem performans göstergeleri">
      <MetricStatistic title="Tamamlanan iş" value={performance.completedJobs} />
      <MetricStatistic title="Tamamlama günü" value={performance.completionDays} />
      <MetricStatistic title="İş / gün" value={jobsPerDay} />
      <MetricStatistic title="Düzeltme isteği" value={performance.correctionRequestEvents} />
      <MetricStatistic title="Eklediği not" value={performance.authoredOperationalNotes} />
    </div>
    <p className="report-section-hint">
      Tamamlama günü, en az bir iş tamamlanan organizasyon-yerel günü ifade eder. İş / gün
      yalnız bu günler üzerinden hesaplanır. Düzeltme isteği olay sayısıdır; aynı iş tekrar
      sayılabilir. Not sayısı yalnız insan tarafından eklenen operasyon notlarını içerir.
    </p>

    <section className="staff-detail-section" aria-labelledby="daily-completion-title">
      <h3 id="daily-completion-title">Günlük tamamlamalar</h3>
      <p className="report-chart-summary">
        Seçilen dönemde toplam {trendTotal} tamamlanan iş. Sıfır tamamlamalı günler de seride yer alır.
      </p>
      <TrendBars points={report.completedTrend} />
      <details className="report-data-disclosure">
        <summary>Günlük veriyi tablo olarak göster</summary>
        <OperationalTable
          caption="Günlük tamamlanan işler"
          columns={COMPLETION_TREND_COLUMNS}
          rows={dailyCompletionRows(report)}
          rowHeaderKey="date"
        />
      </details>
    </section>

    <section className="staff-detail-section" aria-labelledby="completion-types-title">
      <h3 id="completion-types-title">İş türleri</h3>
      {report.completionWorkTypes.length === 0 ? (
        <p className="report-empty-copy">Bu dönemde tamamlanan iş bulunmuyor.</p>
      ) : (
        <ul className="staff-work-type-list">
          {report.completionWorkTypes.map((item) => (
            <li key={item.type}>
              <span>{jobTypeLabels[item.type]}</span>
              <strong>{item.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>

    <section className="staff-detail-section" aria-labelledby="delivery-purpose-title">
      <h3 id="delivery-purpose-title">Teslimler</h3>
      <DeliveryPurposeTable items={report.deliveriesByPurpose} />
    </section>
    <section className="staff-detail-section">
      <MeetingOutcomeTable items={report.meetingsByOutcome} />
    </section>

    <section className="staff-detail-section staff-current-workload" aria-labelledby="current-workload-title">
      <p className="eyebrow">Anlık iş yükü</p>
      <h3 id="current-workload-title">Şu an</h3>
      <dl className="counter-grid staff-current-workload-grid">
        <div><dt>Açık işler</dt><dd>{report.currentWorkload.openJobCards}</dd></div>
        <div><dt>Gecikmiş</dt><dd>{report.currentWorkload.overdueJobCards}</dd></div>
        <div><dt>Onay bekliyor</dt><dd>{report.currentWorkload.waitingApproval}</dd></div>
        <div><dt>Düzeltme bekliyor</dt><dd>{report.currentWorkload.revisionRequested}</dd></div>
      </dl>
    </section>
  </section>;
}

export function StaffOperationalReportScreen({
  staffUserId,
  onBack,
  embedded = false,
  requestedRange = null,
  backLabel = 'Personel profiline dön',
}: {
  staffUserId?: string;
  onBack: () => void;
  embedded?: boolean;
  requestedRange?: RequestedReportRange;
  backLabel?: string;
}) {
  const [report, setReport] = useState<StaffReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = staffUserId
        ? await getStaffReport(staffUserId, requestedRange)
        : await getOwnStaffReport(requestedRange);
      setReport(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Operasyon raporu yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [staffUserId, requestedRange?.from, requestedRange?.to]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['reports'], () => { void load(); });

  const content = <>
    {!embedded && <button className="back-link" type="button" onClick={onBack}>{backLabel}</button>}
    {loading && <LoadingSkeleton
      title="Operasyon raporu yükleniyor"
      headingLevel={embedded ? 2 : 1}
      rows={2}
    />}
    {!loading && error && <ResultState
      status="error"
      title="Operasyon raporu yüklenemedi"
      description={error}
      headingLevel={embedded ? 2 : 1}
      action={<button className="secondary-button" type="button" onClick={() => void load()}>
        Tekrar dene
      </button>}
    />}
    {!loading && !error && report && <>
      {!embedded && <header className="staff-report-identity">
        <p className="eyebrow">Personel raporu</p>
        <h1>{report.staff.name}</h1>
      </header>}
      <StaffOperationalReport report={report} />
    </>}
  </>;

  return embedded
    ? <div className="embedded-staff-report">{content}</div>
    : <main className="workspace staff-report-screen">{content}</main>;
}
