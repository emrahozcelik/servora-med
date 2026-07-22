import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { jobEngagementLabel, jobTypeLabels } from '../jobs/job-labels';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  OperationalTable,
  type OperationalTableColumn,
  type OperationalTableRow,
} from '../ui/OperationalTable';
import { SegmentedDistributionBar } from './report-charts';
import { formatRefreshTime, formatWaitingDuration } from './report-range';
import { getApprovalReport } from './reports-api';
import { approvalSearch, readApprovalSearch } from './report-search';
import type { ApprovalItem, ApprovalReportResponse } from './report-types';
import {
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

const duration = formatWaitingDuration;

const APPROVAL_QUEUE_CAPTION = 'Onay kuyruğundaki işler';

const APPROVAL_COLUMNS: readonly OperationalTableColumn[] = [
  { key: 'type', title: 'Tür' },
  { key: 'title', title: 'İş' },
  { key: 'assignee', title: 'Personel' },
  { key: 'customer', title: 'Müşteri' },
  { key: 'waiting', title: 'Bekleme süresi' },
];

function approvalQueueRows(items: readonly ApprovalItem[]): OperationalTableRow[] {
  return items.map((item) => ({
    key: item.id,
    cells: {
      type: item.type === 'SALES_MEETING'
        ? jobEngagementLabel(item.engagementKind)
        : jobTypeLabels[item.type],
      title: (
        <Link
          to={paths.job(item.id)}
          aria-label={`${item.title} işini aç`}
        >
          {item.title}
        </Link>
      ),
      assignee: item.assignee.name,
      customer: item.customer?.name ?? '—',
      waiting: duration(item.waitingMinutes),
    },
  }));
}

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
          <OperationalTable
            caption={APPROVAL_QUEUE_CAPTION}
            columns={APPROVAL_COLUMNS}
            rows={approvalQueueRows(report.items)}
            rowHeaderKey="title"
          />
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
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!state.canonical) setSearch(approvalSearch(state), { replace: true });
  }, [state, setSearch]);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await getApprovalReport({ limit: 50, offset: state.offset });
      if (requestId !== requestSequence.current) return;
      setReport(next);
      setRefreshedAt(new Date());
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Onay raporu yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [state.offset]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['approval-queue'], () => { void load(); });

  const refreshLabel = refreshedAt ? formatRefreshTime(refreshedAt) : null;

  return (
    <ReportShell title="Onay kuyruğu" current="approvals" refreshLabel={refreshLabel}>
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
