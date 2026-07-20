import { useCallback, useEffect, useState } from 'react';

import { getOwnStaffReport, getStaffReport } from './reports-api';
import type {
  DeliveryPurposeItem,
  ResolvedReportRange,
  StaffOperationalCounters,
  StaffReportResponse,
} from './report-types';
import type { DeliveryPurpose, MeetingOutcome } from '../jobs/jobs-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  OperationalTable,
  type OperationalTableColumn,
  type OperationalTableRow,
} from '../ui/OperationalTable';
import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';

const staffCounterLabels: Record<keyof StaffOperationalCounters, string> = {
  openJobCards: 'Açık işler',
  waitingApproval: 'Onay bekliyor',
  revisionRequested: 'Düzeltme istendi',
  overdueJobCards: 'Geciken',
  completedInPeriod: 'Dönemde tamamlandı',
};

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

function StaffCounterList({ counters }: { counters: StaffOperationalCounters }) {
  return <dl className="counter-grid report-counter-grid">
    {(Object.keys(staffCounterLabels) as Array<keyof StaffOperationalCounters>)
      .map((key) => <div key={key}>
        <dt>{staffCounterLabels[key]}</dt>
        <dd>{counters[key]}</dd>
      </div>)}
  </dl>;
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
  return <section className="staff-operational-report" aria-labelledby="staff-report-title">
    <div className="report-section-heading">
      <div>
        <p className="eyebrow">Operasyon raporu</p>
        <h2 id="staff-report-title">Aylık çalışma özeti</h2>
      </div>
      {!report.staff.isActive && <span className="status-label">Pasif personel</span>}
    </div>
    <p className="report-range">{formatReportRange(report.range)}</p>
    <StaffCounterList counters={report.counters} />
    <DeliveryPurposeTable items={report.deliveriesByPurpose} />
    <MeetingOutcomeTable items={report.meetingsByOutcome} />
  </section>;
}

export function StaffOperationalReportScreen({
  staffUserId,
  onBack,
  embedded = false,
}: {
  staffUserId?: string;
  onBack: () => void;
  embedded?: boolean;
}) {
  const [report, setReport] = useState<StaffReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = staffUserId
        ? await getStaffReport(staffUserId, null)
        : await getOwnStaffReport(null);
      setReport(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Operasyon raporu yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [staffUserId]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['reports'], () => { void load(); });

  const content = <>
    {!embedded && <button className="back-link" type="button" onClick={onBack}>Personel profiline dön</button>}
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
