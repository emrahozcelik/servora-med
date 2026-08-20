import { Table, Tag, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

type WorkTypeSummary = ReadonlyArray<{ label: string; count: number }>;

export type StaffPerformanceTableRecord = Readonly<{
  key: string;
  name: string;
  isActive: boolean;
  completedJobs: number;
  authoredOperationalNotes: number;
  staffSubmissionAttribution: Readonly<{
    recordedSubmissionCount: number;
    recordedSubmissionDays: number;
  }>;
  priorRangeLabel: string;
  priorPerformance: Readonly<{
    available: boolean;
    performance: Readonly<{
      completedJobs: number;
      authoredOperationalNotes: number;
    }> | null;
  }>;
  completionWorkTypes: WorkTypeSummary;
  currentWorkloadByType: WorkTypeSummary;
  currentWorkload: Readonly<{
    openJobCards: number;
    overdueJobCards: number;
    waitingApproval: number;
    revisionRequested: number;
  }>;
  reportHref: string;
}>;

type SortKey = 'name' | 'openJobCards' | 'waitingApproval' | 'revisionRequested'
  | 'overdueJobCards' | 'completedJobs' | 'recordedSubmissionCount';
type SortState = { key: SortKey; direction: 'ascend' | 'descend' };

const integerFormatter = new Intl.NumberFormat('tr-TR');

function signedDelta(value: number) {
  const normalized = Object.is(value, -0) ? 0 : value;
  return `${normalized > 0 ? '+' : ''}${integerFormatter.format(normalized)}`;
}

function ComparedMetric({
  current,
  prior,
  available,
}: {
  current: number;
  prior: number | null;
  available: boolean;
}) {
  return (
    <span className="staff-performance-compared-metric">
      <strong>{integerFormatter.format(current)}</strong>
      <small>
        {available && prior !== null
          ? `Önceki ${integerFormatter.format(prior)} · değişim ${signedDelta(current - prior)}`
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
  return <Tooltip title={definition}>{button}</Tooltip>;
}

function WorkTypeList({
  items,
  emptyCopy,
}: {
  items: WorkTypeSummary;
  emptyCopy?: string;
}) {
  if (items.length === 0) return <p className="staff-performance-context-empty">{emptyCopy}</p>;
  return (
    <ul className="staff-work-type-list staff-performance-work-type-list">
      {items.map((item) => (
        <li key={item.label}>
          <span>{item.label}</span>
          <strong>{integerFormatter.format(item.count)}</strong>
        </li>
      ))}
    </ul>
  );
}

function StaffContext({ record }: { record: StaffPerformanceTableRecord }) {
  const current = record.currentWorkload;
  const prior = record.priorPerformance.performance;
  return (
    <div className="staff-performance-context">
      <section className="staff-performance-context-snapshot" aria-label={`${record.name} şu an`}>
        <h3>Şu an</h3>
        <dl className="staff-performance-secondary-metrics">
          <div><dt>Aksiyon alınabilir</dt><dd>{current.openJobCards}</dd></div>
          <div><dt>Onay bekliyor</dt><dd>{current.waitingApproval}</dd></div>
          <div><dt>Düzeltme bekliyor</dt><dd>{current.revisionRequested}</dd></div>
          <div><dt>Gecikmiş</dt><dd>{current.overdueJobCards}</dd></div>
        </dl>
        <h4>Mevcut iş yükünün tür dağılımı</h4>
        <WorkTypeList items={record.currentWorkloadByType} emptyCopy="Mevcut iş yükü bulunmuyor." />
      </section>
      <section aria-label={`${record.name} seçilen dönem`}>
        <h3>Seçilen dönem</h3>
        <dl className="staff-performance-secondary-metrics">
          <div>
            <dt>Yönetici onaylı tamamlananlar</dt>
            <dd><ComparedMetric
              current={record.completedJobs}
              prior={prior?.completedJobs ?? null}
              available={record.priorPerformance.available}
            /></dd>
          </div>
          <div>
            <dt>Onaya gönderme kaydı</dt>
            <dd>{record.staffSubmissionAttribution.recordedSubmissionCount}</dd>
          </div>
          <div><dt>Eklenen operasyon notları</dt><dd>{record.authoredOperationalNotes}</dd></div>
        </dl>
        <p className="staff-performance-context-note">
          Tamamlananlar seçilen dönemde hâlen bu personele atanmış ve yönetici tarafından onaylanmış
          işleri gösterir. Onaya gönderme kaydı, mevcut atama üzerindeki zaman damgalı kaydı bildirir;
          olay geçmişi değildir.
        </p>
      </section>
      <section aria-label={`${record.name} tamamlanan işlerin türleri`}>
        <h3>Tamamlanan işlerin türleri</h3>
        <WorkTypeList items={record.completionWorkTypes} emptyCopy="Bu dönemde tamamlanan iş yok." />
      </section>
      <Link className="staff-performance-report-link" to={record.reportHref}>
        Raporu aç <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

const definitions: Partial<Record<SortKey, string>> = {
  openJobCards: 'NEW, ACCEPTED ve IN_PROGRESS aşamalarındaki mevcut işler.',
  completedJobs: 'Seçilen dönemde yönetici tarafından onaylanan ve hâlen bu personele atanmış işler.',
  recordedSubmissionCount: 'Mevcut atama üzerinde zaman damgalı onaya gönderme kaydı bulunan işler.',
};

const labels: Record<SortKey, string> = {
  name: 'Personel',
  openJobCards: 'Aksiyon alınabilir',
  waitingApproval: 'Onay bekliyor',
  revisionRequested: 'Düzeltme bekliyor',
  overdueJobCards: 'Gecikmiş',
  completedJobs: 'Yönetici onaylı tamamlananlar',
  recordedSubmissionCount: 'Onaya gönderme kaydı',
};

function sortValue(record: StaffPerformanceTableRecord, key: SortKey): string | number {
  if (key === 'name') return record.name;
  if (key === 'completedJobs') return record.completedJobs;
  if (key === 'recordedSubmissionCount') return record.staffSubmissionAttribution.recordedSubmissionCount;
  return record.currentWorkload[key];
}

function sortableColumn(
  key: SortKey,
  sort: SortState,
  onSort: (key: SortKey) => void,
): NonNullable<TableColumnsType<StaffPerformanceTableRecord>[number]> {
  return {
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
        />
      ),
    } : key === 'recordedSubmissionCount' ? {
      render: (_value: unknown, record: StaffPerformanceTableRecord) => (
        <span className="staff-performance-number">
          {integerFormatter.format(record.staffSubmissionAttribution.recordedSubmissionCount)}
        </span>
      ),
    } : {
      render: (_value: unknown, record: StaffPerformanceTableRecord) => (
        <span className="staff-performance-number">
          {integerFormatter.format(record.currentWorkload[key])}
        </span>
      ),
    }),
  };
}

function MobileRecord({ record }: { record: StaffPerformanceTableRecord }) {
  const current = record.currentWorkload;
  return (
    <li className="staff-performance-mobile-record">
      <div className="staff-performance-mobile-heading">
        <h2>{record.name}</h2>
        {!record.isActive && <Tag>Pasif</Tag>}
      </div>
      <section aria-label={`${record.name} şu an`}>
        <h3>Şu an</h3>
        <dl className="staff-performance-mobile-metrics">
          <div><dt>Aksiyon alınabilir</dt><dd>{current.openJobCards}</dd></div>
          <div><dt>Onay bekliyor</dt><dd>{current.waitingApproval}</dd></div>
          <div><dt>Düzeltme bekliyor</dt><dd>{current.revisionRequested}</dd></div>
          <div><dt>Gecikmiş</dt><dd>{current.overdueJobCards}</dd></div>
        </dl>
      </section>
      <section aria-label={`${record.name} seçilen dönem`}>
        <h3>Seçilen dönem</h3>
        <dl className="staff-performance-mobile-metrics">
          <div><dt>Yönetici onaylı tamamlananlar</dt><dd>{record.completedJobs}</dd></div>
          <div><dt>Onaya gönderme kaydı</dt><dd>{record.staffSubmissionAttribution.recordedSubmissionCount}</dd></div>
        </dl>
      </section>
      <details>
        <summary>Ayrıntıları göster</summary>
        <StaffContext record={record} />
      </details>
    </li>
  );
}

function buildColumns(
  sort: SortState,
  onSort: (key: SortKey) => void,
): TableColumnsType<StaffPerformanceTableRecord> {
  return [
    {
      title: 'PERSONEL',
      key: 'person',
      children: [sortableColumn('name', sort, onSort)],
    },
    {
      title: 'ŞU AN',
      key: 'current',
      children: [
        sortableColumn('openJobCards', sort, onSort),
        sortableColumn('waitingApproval', sort, onSort),
        sortableColumn('revisionRequested', sort, onSort),
        sortableColumn('overdueJobCards', sort, onSort),
      ],
    },
    {
      title: 'SEÇİLEN DÖNEM',
      key: 'period',
      children: [
        sortableColumn('completedJobs', sort, onSort),
        sortableColumn('recordedSubmissionCount', sort, onSort),
      ],
    },
  ];
}

export function StaffPerformanceTable({
  records,
}: {
  records: readonly StaffPerformanceTableRecord[];
}): ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'name', direction: 'ascend' });
  const sortedRecords = useMemo(() => [...records].sort((left, right) => {
    const leftValue = sortValue(left, sort.key);
    const rightValue = sortValue(right, sort.key);
    const result = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue, 'tr-TR')
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascend' ? result : -result;
  }), [records, sort]);
  const resolvedColumns = useMemo(() => buildColumns(sort, (key) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'ascend' ? 'descend' : 'ascend',
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
        <ul aria-label="Personel operasyon kayıtları">
          {sortedRecords.map((record) => <MobileRecord key={record.key} record={record} />)}
        </ul>
      </div>
    </div>
  );
}
