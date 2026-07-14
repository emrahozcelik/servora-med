import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../paths';
import { getDashboardReport } from './reports-api';
import { dashboardSearch, readDashboardSearch, validateRequestedRange } from './report-search';
import type { DashboardReportResponse } from './report-types';

const formatDate = (value: string) => new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

export function ReportsDashboardView({ report }: { report: DashboardReportResponse }) {
  const current = [
    ['Aktif işler', report.counters.activeJobCards],
    ['Geciken işler', report.counters.overdueJobCards],
    ['Onay bekleyenler', report.counters.waitingApproval],
    ['Düzeltme bekleyenler', report.counters.revisionRequested],
  ] as const;
  return <>
    <dl className="report-metrics">{current.map(([label, value]) => <div key={label}>
      <dt>{label}<span>Şu an</span></dt><dd>{value}</dd>
    </div>)}<div><dt>Seçilen dönemde tamamlandı</dt><dd>{report.counters.completedInPeriod}</dd></div>
      <div><dt>Seçilen dönemde iptal edildi</dt><dd>{report.counters.cancelledInPeriod}</dd></div></dl>
    <section className="report-section" aria-labelledby="trend-title"><h2 id="trend-title">Tamamlanma eğilimi</h2>
      <div className="completed-trend" aria-hidden="true">{report.completedTrend.map((point) =>
        <span key={point.date} style={{ '--count': point.count } as CSSProperties} />)}</div>
      <table className="report-table"><caption>Tamamlanan işlerin günlük dağılımı</caption>
        <thead><tr><th scope="col">Tarih</th><th scope="col">Tamamlanan iş</th></tr></thead>
        <tbody>{report.completedTrend.map((point) => <tr key={point.date}>
          <th scope="row">{formatDate(point.date)}</th><td>{point.count}</td>
        </tr>)}</tbody></table></section>
  </>;
}

export function ReportsDashboard() {
  const [search, setSearch] = useSearchParams();
  const state = readDashboardSearch(search);
  const [report, setReport] = useState<DashboardReportResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filterError, setFilterError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const next = await getDashboardReport(state.from && state.to ? { from: state.from, to: state.to } : null);
      setReport(next);
      if (!state.from || !state.to) setSearch(dashboardSearch({ ...next.range, canonical: true }), { replace: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Rapor özeti yüklenemedi.'); }
    finally { setLoading(false); }
  }, [state.from, state.to, setSearch]);
  useEffect(() => { if (!state.canonical) setSearch(dashboardSearch(state), { replace: true }); }, [state, setSearch]);
  useEffect(() => { void load(); }, [load]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const result = validateRequestedRange(String(data.get('from') ?? ''), String(data.get('to') ?? ''));
    if (!result.ok) { setFilterError(result.errors[0]?.message ?? 'Tarih aralığı geçersiz.'); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setFilterError(''); setSearch(dashboardSearch({ ...result.value, canonical: true }));
  }
  return <main className="workspace report-workspace"><header className="workspace-heading"><div><p className="eyebrow">Raporlar</p><h1>Operasyon özeti</h1></div>
    <nav className="report-nav" aria-label="Rapor bölümleri"><Link to={paths.deliveryReports}>Teslimler</Link><Link to={paths.approvalReports}>Onaylar</Link></nav></header>
    <form key={`${state.from}:${state.to}`} className="report-filters" onSubmit={submit}><label>Başlangıç<input name="from" type="date" defaultValue={state.from ?? ''} /></label>
      <label>Bitiş<input name="to" type="date" defaultValue={state.to ?? ''} /></label><button className="secondary-button">Uygula</button></form>
    {filterError && <p ref={errorRef} className="field-error" role="alert" tabIndex={-1}>{filterError}</p>}
    {loading && <section className="report-loading" aria-busy="true"><h1>Rapor özeti yükleniyor</h1></section>}
    {!loading && error && <div className="workspace-message" role="alert"><h2>Rapor özeti yüklenemedi</h2><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Tekrar dene</button></div>}
    {!loading && !error && report && <ReportsDashboardView report={report} />}
  </main>;
}
