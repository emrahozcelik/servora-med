import './staff-performance.css';
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
      <svg width="14" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M12 4v16" />
        {(!active || direction === 'ascend') && <path d="m7 9 5-5 5 5" />}
        {(!active || direction === 'descend') && <path d="m7 15 5 5 5-5" />}
      </svg>
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
          Tamamlananlar, bu personelin gönderim kaydına bağlı ve seçilen dönemde yönetici tarafından onaylanmış
          işlerdir. Bu kayıt, işi fiilen gerçekleştiren kişinin ayrıca doğrulandığı anlamına gelmez. Onaya gönderme sayısı seçilen dönemdeki gönderim kayıtlarını gösterir.
          Tekrar gönderimlerin olay geçmişini saymaz.
        </p>
      </section>
      <section aria-label={`${record.name} tamamlanan işlerin türleri`}>
        <h3>Tamamlanan işlerin türleri</h3>
        <WorkTypeList items={record.completionWorkTypes} emptyCopy="Bu dönemde tamamlanan iş yok." />
      </section>
      <Link className="staff-performance-report-link" to={record.reportHref}>
        Raporu aç <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
      </Link>
    </div>
  );
}

const definitions: Partial<Record<SortKey, string>> = {
  openJobCards: 'Hazırlanan, atanan ve uygulanan mevcut işler; onay ve düzeltme kuyrukları ayrıdır.',
  completedJobs: 'Bu personelin gönderim kaydına bağlı, seçilen dönemde yönetici tarafından onaylanan işler.',
  recordedSubmissionCount:
    'Seçilen dönemde onaya gönderme atfı bu personele kayıtlı işleri gösterir; tekrar gönderimlerin olay geçmişini saymaz.',
};

const labels: Record<SortKey, string> = {
  name: 'Personel',
  openJobCards: 'Açık işler',
  waitingApproval: 'Onay bekliyor',
  revisionRequested: 'Düzeltme bekliyor',
  overdueJobCards: 'Geciken',
  completedJobs: 'Tamamlanan',
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
          <Tag>{record.isActive ? 'Aktif' : 'Pasif'}</Tag>
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
        <Tag>{record.isActive ? 'Aktif' : 'Pasif'}</Tag>
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
        <summary>Ayrıntıları göster <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary>
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
    { ...sortableColumn('name', sort, onSort), width: '26%' },
    { ...sortableColumn('completedJobs', sort, onSort), width: '24%' },
    sortableColumn('openJobCards', sort, onSort),
    { ...sortableColumn('waitingApproval', sort, onSort),
      render: (_value: unknown, record: StaffPerformanceTableRecord) => <span className="staff-performance-queue">
        <strong>{record.currentWorkload.waitingApproval}</strong>
        <small>{record.currentWorkload.revisionRequested} düzeltme bekliyor</small>
      </span>,
    },
    sortableColumn('overdueJobCards', sort, onSort),
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
            expandRowByClick: false,
            columnWidth: '6.25rem',
            expandIcon: ({ expanded, onExpand, record }) => (
              <button
                type="button"
                className="staff-performance-expand"
                aria-label={`${record.name} ayrıntılarını ${expanded ? 'gizle' : 'göster'}`}
                aria-expanded={expanded}
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation();
                  onExpand(record, event);
                }}
              >
                <span>Ayrıntı</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
              </button>
            ),
          }}
          locale={{ emptyText: 'Aramayla eşleşen personel bulunmuyor.' }}
          rowKey="key"
        />
      </div>
      <div data-staff-performance-mobile="true" className="staff-performance-mobile">
        <div className="staff-performance-mobile-sort">
          <label>Sırala
            <select value={sort.key} onChange={(event) => setSort({ key: event.target.value as SortKey, direction: 'ascend' })}>
              {(Object.keys(labels) as SortKey[]).map((key) => <option key={key} value={key}>{labels[key]}</option>)}
            </select>
          </label>
          <button type="button" className="secondary-button" onClick={() => setSort((current) => ({ ...current, direction: current.direction === 'ascend' ? 'descend' : 'ascend' }))}
            aria-label={`Sıralama yönü: ${sort.direction === 'ascend' ? 'artan' : 'azalan'}. Yönü değiştir.`}>
            {sort.direction === 'ascend' ? 'Artan' : 'Azalan'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={sort.direction === 'ascend' ? 'M12 20V4m-6 6 6-6 6 6' : 'M12 4v16m-6-6 6 6 6-6'} /></svg>
          </button>
        </div>
        <ul aria-label="Personel operasyon kayıtları">
          {sortedRecords.map((record) => <MobileRecord key={record.key} record={record} />)}
        </ul>
      </div>
    </div>
  );
}
