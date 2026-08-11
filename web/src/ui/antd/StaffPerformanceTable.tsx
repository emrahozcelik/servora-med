import { Table, Tag, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type StaffPerformanceTableRecord = Readonly<{
  key: string;
  name: string;
  isActive: boolean;
  completedJobs: number;
  completionDays: number;
  jobsPerCompletionDay: number;
  correctionRequestEvents: number;
  authoredOperationalNotes: number;
  priorRangeLabel: string;
  priorPerformance: Readonly<{
    available: boolean;
    performance: Readonly<{
      completedJobs: number;
      completionDays: number;
      jobsPerCompletionDay: number;
      correctionRequestEvents: number;
      authoredOperationalNotes: number;
    }> | null;
  }>;
  staffExecution: Readonly<{
    approvedJobsWithStaffCompletionTimestamp: number;
    staffCompletionDays: number;
    jobsPerStaffCompletionDay: number;
    missingStaffCompletionTimestamp: number;
  }>;
  onTime: Readonly<{
    scheduledCompletedJobs: number;
    onTimeCompletedJobs: number;
    lateCompletedJobs: number;
    unscheduledCompletedJobs: number;
    onTimeRate: number | null;
  }>;
  workTypes: ReadonlyArray<{ label: string; count: number }>;
  currentWorkload: Readonly<{
    openJobCards: number;
    overdueJobCards: number;
    waitingApproval: number;
    revisionRequested: number;
  }>;
  reportHref: string;
}>;

type SortKey = 'name' | 'completedJobs' | 'completionDays' | 'jobsPerCompletionDay'
  | 'correctionRequestEvents' | 'authoredOperationalNotes';
type SortState = { key: SortKey; direction: 'ascend' | 'descend' };

const ratioFormatter = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat('tr-TR');
const percentFormatter = new Intl.NumberFormat('tr-TR', {
  style: 'percent',
  maximumFractionDigits: 0,
});

function signedDelta(value: number, formatter: Intl.NumberFormat) {
  const normalized = Math.abs(value) < 0.000_000_1 ? 0 : value;
  return `${normalized > 0 ? '+' : ''}${formatter.format(normalized)}`;
}

function ComparedMetric({
  current,
  prior,
  available,
  formatter,
}: {
  current: number;
  prior: number | null;
  available: boolean;
  formatter: Intl.NumberFormat;
}) {
  return (
    <span className="staff-performance-compared-metric">
      <strong>{formatter.format(current)}</strong>
      <small>
        {available && prior !== null
          ? `Önceki ${formatter.format(prior)} · değişim ${signedDelta(current - prior, formatter)}`
          : 'Önceki dönem verisi yok'}
      </small>
    </span>
  );
}

function SortTitle({
  label,
  definition,
  active,
  direction,
  onSort,
}: {
  label: string;
  definition?: string;
  active: boolean;
  direction: SortState['direction'];
  onSort: () => void;
}) {
  const button = (
    <button
      type="button"
      className="staff-performance-sort"
      onClick={onSort}
      aria-label={`${label} sütununu sırala${definition ? `. ${definition}` : ''}`}
    >
      <span>{label}</span>
      <span aria-hidden="true">{active ? (direction === 'ascend' ? '↑' : '↓') : '↕'}</span>
    </button>
  );
  if (!definition) return button;
  return (
    <Tooltip title={definition}>{button}</Tooltip>
  );
}

function StaffContext({ record }: { record: StaffPerformanceTableRecord }) {
  const current = record.currentWorkload;
  const prior = record.priorPerformance.performance;
  const execution = record.staffExecution;
  const timing = record.onTime;
  return (
    <div className="staff-performance-context">
      <section aria-label={`${record.name} önceki dönem karşılaştırması`}>
        <h3>Önceki dönem</h3>
        <p className="staff-performance-context-copy">{record.priorRangeLabel}</p>
        {!record.priorPerformance.available || !prior ? (
          <p className="staff-performance-context-empty">Önceki dönem verisi yok.</p>
        ) : (
          <dl className="staff-performance-secondary-metrics">
            <div>
              <dt>Düzeltme isteği</dt>
              <dd>Şimdi {record.correctionRequestEvents} · önceki {prior.correctionRequestEvents}</dd>
            </div>
            <div>
              <dt>Eklediği not</dt>
              <dd>Şimdi {record.authoredOperationalNotes} · önceki {prior.authoredOperationalNotes}</dd>
            </div>
          </dl>
        )}
      </section>
      <section aria-label={`${record.name} iş türleri`}>
        <h3>İş türleri</h3>
        <div className="staff-performance-tags">
          {record.workTypes.length === 0
            ? <span className="staff-performance-context-empty">Bu dönemde tamamlanan iş yok.</span>
            : record.workTypes.map((item) => (
                <Tag key={item.label}>{item.label} · {item.count}</Tag>
              ))}
        </div>
      </section>
      <section aria-label={`${record.name} personel bitirme zamanı`}>
        <h3>Personelin bitirme zamanı</h3>
        <p className="staff-performance-context-copy">
          <strong>{execution.staffCompletionDays}</strong> personelin bitirme günü ·{' '}
          <strong>{ratioFormatter.format(execution.jobsPerStaffCompletionDay)}</strong>{' '}
          iş / bitirme günü
        </p>
        <p className="staff-performance-context-note">
          {execution.approvedJobsWithStaffCompletionTimestamp} onaylı işte personel bitirme zamanı var;
          {' '}{execution.missingStaffCompletionTimestamp} onaylı işte bu zaman eksik.
        </p>
      </section>
      <section aria-label={`${record.name} mevcut plana göre zamanında tamamlama`}>
        <h3>Mevcut plana göre zamanında</h3>
        {timing.onTimeRate === null ? (
          <p className="staff-performance-context-empty">
            Zaman hedefli tamamlanan iş yok; oran hesaplanmadı.
          </p>
        ) : (
          <p className="staff-performance-context-copy">
            <strong>{percentFormatter.format(timing.onTimeRate)}</strong> ·{' '}
            {timing.onTimeCompletedJobs} / {timing.scheduledCompletedJobs} zaman hedefli iş
          </p>
        )}
        <p className="staff-performance-context-note">
          {timing.lateCompletedJobs} geç · {timing.unscheduledCompletedJobs} tamamlanan işte
          zaman hedefi yok.
        </p>
      </section>
      <section className="staff-performance-current" aria-label={`${record.name} şu an`}>
        <h3>Şu an</h3>
        <div className="staff-performance-tags">
          <Tag>{current.openJobCards} açık</Tag>
          <Tag>{current.overdueJobCards} gecikmiş</Tag>
          <Tag>{current.waitingApproval} onay bekliyor</Tag>
          <Tag>{current.revisionRequested} düzeltme bekliyor</Tag>
        </div>
      </section>
      <Link className="staff-performance-report-link" to={record.reportHref}>
        Raporu aç <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

const definitions: Partial<Record<SortKey, string>> = {
  completionDays:
    'Seçilen dönemde en az bir işin tamamlandığı organizasyon-yerel takvim günü.',
  jobsPerCompletionDay: 'En az bir iş tamamlanan günler üzerinden hesaplanır.',
  correctionRequestEvents:
    'Seçilen dönemde kaydedilen düzeltme isteği olaylarının sayısıdır; aynı iş tekrar sayılabilir.',
};

const labels: Record<SortKey, string> = {
  name: 'Personel',
  completedJobs: 'Tamamlanan',
  completionDays: 'Tamamlama günü',
  jobsPerCompletionDay: 'İş / gün',
  correctionRequestEvents: 'Düzeltme isteği',
  authoredOperationalNotes: 'Eklediği not',
};

function buildColumns(
  sort: SortState,
  onSort: (key: SortKey) => void,
): TableColumnsType<StaffPerformanceTableRecord> {
  return (Object.keys(labels) as SortKey[]).map((key) => ({
    title: <SortTitle
      label={labels[key]}
      definition={definitions[key]}
      active={sort.key === key}
      direction={sort.direction}
      onSort={() => onSort(key)}
    />,
    dataIndex: key,
    key,
    align: key === 'name' ? 'left' : 'right',
    onHeaderCell: () => ({
      'aria-sort': sort.key === key
        ? sort.direction === 'ascend' ? 'ascending' : 'descending'
        : 'none',
    }),
    ...(key === 'name' ? {
      render: (_value: unknown, record: StaffPerformanceTableRecord) => (
        <span className="staff-performance-person">
          <strong>{record.name}</strong>
          {!record.isActive && <Tag>Pasif</Tag>}
        </span>
      ),
    } : key === 'completedJobs' ? {
      render: (_value: unknown, record: StaffPerformanceTableRecord) => (
        <ComparedMetric
          current={record.completedJobs}
          prior={record.priorPerformance.performance?.completedJobs ?? null}
          available={record.priorPerformance.available}
          formatter={integerFormatter}
        />
      ),
    } : key === 'jobsPerCompletionDay' ? {
      render: (_value: unknown, record: StaffPerformanceTableRecord) => (
        <ComparedMetric
          current={record.jobsPerCompletionDay}
          prior={record.priorPerformance.performance?.jobsPerCompletionDay ?? null}
          available={record.priorPerformance.available}
          formatter={ratioFormatter}
        />
      ),
    } : {}),
  }));
}

function MobileRecord({ record }: { record: StaffPerformanceTableRecord }) {
  return (
    <li className="staff-performance-mobile-record">
      <div className="staff-performance-mobile-heading">
        <h2>{record.name}</h2>
        {!record.isActive && <Tag>Pasif</Tag>}
      </div>
      <dl className="staff-performance-mobile-metrics">
        <div><dt>Tamamlanan</dt><dd><ComparedMetric
          current={record.completedJobs}
          prior={record.priorPerformance.performance?.completedJobs ?? null}
          available={record.priorPerformance.available}
          formatter={integerFormatter}
        /></dd></div>
        <div><dt>Tamamlama günü</dt><dd>{record.completionDays}</dd></div>
        <div><dt>İş / gün</dt><dd><ComparedMetric
          current={record.jobsPerCompletionDay}
          prior={record.priorPerformance.performance?.jobsPerCompletionDay ?? null}
          available={record.priorPerformance.available}
          formatter={ratioFormatter}
        /></dd></div>
        <div><dt>Düzeltme isteği</dt><dd>{record.correctionRequestEvents}</dd></div>
        <div><dt>Eklediği not</dt><dd>{record.authoredOperationalNotes}</dd></div>
      </dl>
      <details>
        <summary>Ayrıntıları göster</summary>
        <StaffContext record={record} />
      </details>
    </li>
  );
}

export function StaffPerformanceTable({
  records,
}: {
  records: readonly StaffPerformanceTableRecord[];
}): ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'name', direction: 'ascend' });
  const sortedRecords = useMemo(() => [...records].sort((left, right) => {
    const leftValue = left[sort.key];
    const rightValue = right[sort.key];
    const result = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue, 'tr-TR')
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascend' ? result : -result;
  }), [records, sort]);
  const resolvedColumns = useMemo(() => buildColumns(sort, (key) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'ascend'
        ? 'descend'
        : 'ascend',
    }));
  }), [sort]);

  return (
    <div className="staff-performance-comparison">
      <div data-staff-performance-desktop="true" className="staff-performance-desktop">
        <Table<StaffPerformanceTableRecord>
          className="servora-staff-performance-table"
          columns={resolvedColumns}
          dataSource={sortedRecords}
          pagination={false}
          tableLayout="fixed"
          expandable={{
            columnTitle: <span className="visually-hidden">Ayrıntı</span>,
            expandedRowRender: (record) => <StaffContext record={record} />,
            expandIcon: ({ expanded, onExpand, record }) => (
              <button
                type="button"
                className="staff-performance-expand"
                aria-label={`${record.name} ayrıntılarını ${expanded ? 'gizle' : 'göster'}`}
                aria-expanded={expanded}
                onClick={(event: MouseEvent<HTMLButtonElement>) => onExpand(record, event)}
              >
                <span aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>
            ),
          }}
          locale={{ emptyText: 'Aramayla eşleşen personel bulunmuyor.' }}
          rowKey="key"
        />
      </div>
      <div data-staff-performance-mobile="true" className="staff-performance-mobile">
        <ul aria-label="Personel performansı kayıtları">
          {sortedRecords.map((record) => <MobileRecord key={record.key} record={record} />)}
        </ul>
      </div>
    </div>
  );
}
