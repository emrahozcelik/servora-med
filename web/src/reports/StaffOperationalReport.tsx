import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeliveryPurpose, JobCardType, MeetingOutcome } from '../jobs/jobs-api';
import { jobTypeLabels } from '../jobs/job-labels';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  OperationalTable,
  type OperationalTableColumn,
  type OperationalTableRow,
} from '../ui/OperationalTable';
import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';
import { SegmentedDistributionBar, TrendBars } from './report-charts';
import { getOwnStaffReport, getStaffReport } from './reports-api';
import type {
  DeliveryPurposeItem,
  RequestedReportRange,
  ResolvedReportRange,
  StaffReportResponse,
} from './report-types';

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

const REPORT_WORK_TYPE_ORDER = [
  'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING',
] as const satisfies readonly JobCardType[];

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
  { key: 'count', title: 'Yönetici onaylı tamamlanma' },
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

function stableWorkTypes(
  items: readonly { type: JobCardType; count: number }[],
) {
  return REPORT_WORK_TYPE_ORDER.map((type) => ({
    type,
    count: items.find((item) => item.type === type)?.count ?? 0,
  }));
}

function WorkTypeDistribution({
  headingId,
  title,
  description,
  items,
}: {
  headingId: string;
  title: string;
  description: string;
  items: readonly { type: JobCardType; count: number }[];
}) {
  const segments = stableWorkTypes(items).map((item) => ({
    key: item.type.toLocaleLowerCase('en-US'),
    label: jobTypeLabels[item.type],
    value: item.count,
  }));
  return (
    <section className="staff-work-type-distribution" aria-labelledby={headingId}>
      <h4 id={headingId}>{title}</h4>
      <p className="report-section-hint">{description}</p>
      <SegmentedDistributionBar
        segments={segments}
        className="report-segmented-bar staff-work-type-distribution-bar"
      />
    </section>
  );
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
    <h4 id="meeting-outcome-title">Görüşme sonuçları</h4>
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
  const trendTotal = report.completedTrend.reduce((sum, point) => sum + point.count, 0);
  const submission = report.staffSubmissionAttribution;
  return <section className="staff-operational-report" aria-labelledby="staff-report-title">
    <div className="report-section-heading">
      <div>
        <h2 id="staff-report-title">Personel Operasyon Analizi</h2>
      </div>
      <span className="status-label">{report.staff.isActive ? 'Aktif personel' : 'Pasif personel'}</span>
    </div>
    <p className="report-range">{formatReportRange(report.range)}</p>

    <section className="staff-analysis-group staff-analysis-snapshot" aria-labelledby="staff-current-title">
      <h3 id="staff-current-title">Şu an — mevcut operasyon yükü</h3>
      <p className="report-section-hint">
        Aksiyon alınabilir işler mevcut atamaya göre NEW, ACCEPTED ve IN_PROGRESS aşamalarını;
        diğer sayaçlar bekleyen operasyon kuyruklarını gösterir.
      </p>
      <dl className="staff-analysis-metrics staff-current-workload-grid">
        <div><dt>Aksiyon alınabilir</dt><dd>{report.currentWorkload.openJobCards}</dd></div>
        <div><dt>Gecikmiş</dt><dd>{report.currentWorkload.overdueJobCards}</dd></div>
        <div><dt>Onay bekliyor</dt><dd>{report.currentWorkload.waitingApproval}</dd></div>
        <div><dt>Düzeltme bekliyor</dt><dd>{report.currentWorkload.revisionRequested}</dd></div>
      </dl>
      <WorkTypeDistribution
        headingId="current-workload-types-title"
        title="Mevcut iş yükünün tür dağılımı"
        description="Bu dağılım tarih aralığından bağımsız mevcut atamayı gösterir."
        items={report.currentWorkloadByType}
      />
    </section>

    <section className="staff-analysis-group staff-analysis-period" aria-labelledby="staff-period-title">
      <h3 id="staff-period-title">Seçilen dönem — yönetici onaylı sonuçlar</h3>
      <p className="report-range">{formatReportRange(report.range)}</p>
      <dl className="staff-analysis-metrics staff-period-metrics">
        <div><dt>Yönetici onaylı tamamlananlar</dt><dd>{report.performance.completedJobs}</dd></div>
        <div><dt>Onaya gönderme kaydı</dt><dd>{submission.recordedSubmissionCount}</dd></div>
        <div><dt>Eklenen operasyon notları</dt><dd>{report.performance.authoredOperationalNotes}</dd></div>
      </dl>
      <p className="report-section-hint">
        Tamamlananlar seçilen dönemde hâlen bu personele atanmış ve yönetici tarafından onaylanmış
        işleri kapsar. Onaya gönderme kaydı, mevcut atama üzerindeki zaman damgalı kaydı bildirir;
        olay geçmişi değildir. Kaydı bulunan işler{' '}
        {submission.recordedSubmissionDays} organizasyon-yerel gün içindedir.
      </p>
      <WorkTypeDistribution
        headingId="completion-work-types-title"
        title="Tamamlanan işlerin türleri"
        description="Seçilen dönemdeki yönetici onaylı tamamlanmalar, mevcut atama ve iş türüne göre ayrılır."
        items={report.completionWorkTypes}
      />
      <section className="staff-detail-section staff-completion-trend" aria-labelledby="daily-completion-title">
        <h4 id="daily-completion-title">Dönem içindeki yönetici onaylı tamamlanmalar</h4>
        <p className="report-chart-summary">
          Seçilen dönemde toplam {trendTotal} yönetici onaylı tamamlanma. Sıfır tamamlamalı günler de seride yer alır.
        </p>
        <TrendBars points={report.completedTrend} />
        <details className="report-data-disclosure">
          <summary>Günlük veriyi tablo olarak göster</summary>
          <OperationalTable
            caption="Günlük yönetici onaylı tamamlanmalar"
            columns={COMPLETION_TREND_COLUMNS}
            rows={dailyCompletionRows(report)}
            rowHeaderKey="date"
          />
        </details>
      </section>
    </section>

    <section className="staff-analysis-group staff-analysis-context" aria-labelledby="staff-context-title">
      <h3 id="staff-context-title">Operasyon bağlamı</h3>
      <p className="report-section-hint">
        Teslim ve satış görüşmesi sonuçları seçilen dönemin operasyon kayıtlarıdır.
      </p>
      <section className="staff-detail-section" aria-labelledby="delivery-purpose-title">
        <h4 id="delivery-purpose-title">Onaylı teslimler</h4>
        <DeliveryPurposeTable items={report.deliveriesByPurpose} />
      </section>
      <MeetingOutcomeTable items={report.meetingsByOutcome} />
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
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = staffUserId
        ? await getStaffReport(staffUserId, requestedRange)
        : await getOwnStaffReport(requestedRange);
      if (requestId !== requestSequence.current) return;
      setReport(next);
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Personel operasyon raporu yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [staffUserId, requestedRange?.from, requestedRange?.to]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['reports'], () => { void load(); });

  const content = <>
    {!embedded && <button className="back-link" type="button" onClick={onBack}>{backLabel}</button>}
    {loading && <LoadingSkeleton
      title="Personel operasyon raporu yükleniyor"
      headingLevel={embedded ? 2 : 1}
      rows={2}
    />}
    {!loading && error && <ResultState
      status="error"
      title="Personel operasyon raporu yüklenemedi"
      description={error}
      headingLevel={embedded ? 2 : 1}
      action={<button className="secondary-button" type="button" onClick={() => void load()}>
        Tekrar dene
      </button>}
    />}
    {!loading && !error && report && <>
      {!embedded && <header className="staff-report-identity">
        <h1>{report.staff.name}</h1>
        <span className="status-label">{report.staff.isActive ? 'Aktif personel' : 'Pasif personel'}</span>
      </header>}
      <StaffOperationalReport report={report} />
    </>}
  </>;

  return embedded
    ? <div className="embedded-staff-report">{content}</div>
    : <main className="workspace staff-report-screen">{content}</main>;
}
