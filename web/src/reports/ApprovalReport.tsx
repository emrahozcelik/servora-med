import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../paths';
import { getApprovalReport } from './reports-api';
import { approvalSearch, readApprovalSearch } from './report-search';
import type { ApprovalReportResponse } from './report-types';

const typeLabels = { PRODUCT_DELIVERY: 'Ürün teslimi', GENERAL_TASK: 'Genel görev' } as const;
const duration = (minutes: number) => minutes < 60 ? `${minutes} dakika` : `${Math.floor(minutes / 60)} saat`;

export function ApprovalReportView({ report }: { report: ApprovalReportResponse }) {
  const values = [['Toplam bekleyen', report.summary.pendingCount], ['En uzun bekleme', report.summary.oldestWaitingMinutes === null ? 'Yok' : duration(report.summary.oldestWaitingMinutes)], ['Ortalama bekleme', report.summary.averageWaitingMinutes === null ? 'Yok' : duration(report.summary.averageWaitingMinutes)], ['2 saatten kısa', report.summary.under2Hours], ['2–8 saat', report.summary.between2And8Hours], ['8–24 saat', report.summary.between8And24Hours], ['24 saatten uzun', report.summary.over24Hours]] as const;
  return <><dl className="approval-summary">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {report.items.length === 0 ? <div className="report-empty"><p>Onay bekleyen iş bulunmuyor.</p></div>
      : <ul className="approval-list">{report.items.map((item) => <li key={item.id}><div><span>{typeLabels[item.type]}</span><h2>{item.title}</h2><p>{item.assignee.name}{item.customer ? ` · ${item.customer.name}` : ''}</p></div><strong>{duration(item.waitingMinutes)}</strong></li>)}</ul>}</>;
}

export function ApprovalReport() {
  const [search, setSearch] = useSearchParams(); const state = readApprovalSearch(search);
  const [report, setReport] = useState<ApprovalReportResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { if (!state.canonical) setSearch(approvalSearch(state), { replace: true }); }, [state, setSearch]);
  const load = useCallback(async () => { setLoading(true); setError(''); try { setReport(await getApprovalReport({ limit: 50, offset: state.offset })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Onay raporu yüklenemedi.'); } finally { setLoading(false); }
  }, [state.offset]); useEffect(() => { void load(); }, [load]);
  return <main className="workspace report-workspace"><header className="workspace-heading"><div><p className="eyebrow">Raporlar</p><h1>Onay kuyruğu</h1></div><nav className="report-nav"><Link to={paths.reports}>Özet</Link><Link to={paths.deliveryReports}>Teslimler</Link></nav></header>
    {loading && <section className="report-loading" aria-busy="true"><h1>Onay raporu yükleniyor</h1></section>}
    {!loading && error && <div className="workspace-message" role="alert"><h2>Onay raporu yüklenemedi</h2><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Tekrar dene</button></div>}
    {!loading && !error && report && <><ApprovalReportView report={report} /><div className="report-pagination"><button disabled={state.offset === 0} onClick={() => setSearch(approvalSearch({ offset: Math.max(0, state.offset - report.limit), canonical: true }))}>Önceki</button><span>{report.total} iş</span><button disabled={state.offset + report.limit >= report.total} onClick={() => setSearch(approvalSearch({ offset: state.offset + report.limit, canonical: true }))}>Sonraki</button></div></>}
  </main>;
}
