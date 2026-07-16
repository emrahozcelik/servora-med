import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { jobTypeLabels } from '../jobs/job-labels';
import { SegmentedDistributionBar } from './report-charts';
import { formatWaitingDuration } from './report-range';
import { getApprovalReport } from './reports-api';
import { approvalSearch, readApprovalSearch } from './report-search';
import type { ApprovalReportResponse } from './report-types';
import {
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

const duration = formatWaitingDuration;

export function ApprovalReportView({ report }: { report: ApprovalReportResponse }) {
  const values = [
    ['Toplam bekleyen', report.summary.pendingCount],
    ['En uzun bekleme', report.summary.oldestWaitingMinutes === null ? 'Yok' : duration(report.summary.oldestWaitingMinutes)],
    ['Ortalama bekleme', report.summary.averageWaitingMinutes === null ? 'Yok' : duration(report.summary.averageWaitingMinutes)],
    ['2 saatten kısa', report.summary.under2Hours],
    ['2–8 saat', report.summary.between2And8Hours],
    ['8–24 saat', report.summary.between8And24Hours],
    ['24 saatten uzun', report.summary.over24Hours],
  ] as const;
  const slaSegments = [
    { key: 'under2', label: '2 saatten kısa', value: report.summary.under2Hours },
    { key: 'between2And8', label: '2–8 saat', value: report.summary.between2And8Hours },
    { key: 'between8And24', label: '8–24 saat', value: report.summary.between8And24Hours },
    { key: 'over24', label: '24 saatten uzun', value: report.summary.over24Hours },
  ];
  return (
    <>
      <dl className="approval-summary">
        {values.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <section className="report-section" aria-labelledby="approval-sla-title">
        <h2 id="approval-sla-title">Bekleme dağılımı</h2>
        <SegmentedDistributionBar segments={slaSegments} />
      </section>
      {report.items.length === 0
        ? <ReportEmptyState title="Onay bekleyen iş bulunmuyor." description="Onay kuyruğu şu an boş." />
        : (
          <ul className="approval-list">
            {report.items.map((item) => (
              <li key={item.id}>
                <div>
                  <span>{jobTypeLabels[item.type]}</span>
                  <h2>{item.title}</h2>
                  <p>{item.assignee.name}{item.customer ? ` · ${item.customer.name}` : ''}</p>
                </div>
                <strong>{duration(item.waitingMinutes)}</strong>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

export function ApprovalReport() {
  const [search, setSearch] = useSearchParams();
  const state = readApprovalSearch(search);
  const [report, setReport] = useState<ApprovalReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!state.canonical) setSearch(approvalSearch(state), { replace: true });
  }, [state, setSearch]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await getApprovalReport({ limit: 50, offset: state.offset }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Onay raporu yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [state.offset]);
  useEffect(() => { void load(); }, [load]);
  return (
    <ReportShell title="Onay kuyruğu" current="approvals">
      {loading && <ReportLoadingState title="Onay raporu yükleniyor" />}
      {!loading && error && (
        <ReportErrorState title="Onay raporu yüklenemedi" message={error} onRetry={() => void load()} />
      )}
      {!loading && !error && report && (
        <>
          <ApprovalReportView report={report} />
          <div className="report-pagination">
            <button
              type="button"
              disabled={state.offset === 0}
              onClick={() => setSearch(approvalSearch({
                offset: Math.max(0, state.offset - report.limit),
                canonical: true,
              }))}
            >
              Önceki
            </button>
            <span>{report.total} iş</span>
            <button
              type="button"
              disabled={state.offset + report.limit >= report.total}
              onClick={() => setSearch(approvalSearch({
                offset: state.offset + report.limit,
                canonical: true,
              }))}
            >
              Sonraki
            </button>
          </div>
        </>
      )}
    </ReportShell>
  );
}
