import { useCallback, useEffect, useState } from 'react';

import { getOwnStaffReport, getStaffReport } from './reports-api';
import type {
  DeliveryPurposeItem,
  ResolvedReportRange,
  StaffOperationalCounters,
  StaffReportResponse,
} from './report-types';
import type { DeliveryPurpose } from '../jobs/jobs-api';

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
    return <div className="report-empty">
      <h3>Onaylı teslim bulunmuyor</h3>
      <p>Bu dönemde onaylı teslim bulunmuyor.</p>
    </div>;
  }
  return <div className="report-table-wrap">
    <table className="report-table">
      <caption>Onaylı teslimler</caption>
      <thead><tr><th scope="col">Amaç</th><th scope="col">Birim</th>
        <th scope="col">Miktar</th></tr></thead>
      <tbody>{items.map((item) => <tr key={JSON.stringify([item.purpose, item.unit])}>
        <th scope="row">{purposeLabels[item.purpose]}</th>
        <td>{item.unit ?? 'Birim belirtilmedi'}</td>
        <td className="report-quantity">{item.quantity}</td>
      </tr>)}</tbody>
    </table>
  </div>;
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

  const content = <>
    {!embedded && <button className="back-link" type="button" onClick={onBack}>Personel profiline dön</button>}
    {loading && <section className="report-loading" aria-busy="true" aria-live="polite">
      {embedded ? <h2>Operasyon raporu yükleniyor</h2> : <h1>Operasyon raporu yükleniyor</h1>}
      <div className="loading-line" aria-hidden="true" />
      <div className="loading-line loading-line-short" aria-hidden="true" />
    </section>}
    {!loading && error && <div className="workspace-message" role="alert">
      {embedded ? <h2>Operasyon raporu yüklenemedi</h2> : <h1>Operasyon raporu yüklenemedi</h1>}
      <p>{error}</p>
      <button className="secondary-button" type="button" onClick={() => void load()}>Tekrar dene</button>
    </div>}
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
