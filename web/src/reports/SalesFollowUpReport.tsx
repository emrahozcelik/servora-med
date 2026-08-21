import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { jobTypeLabels } from '../jobs/job-labels';
import { activeWorkflowPresentation } from '../jobs/job-status-presentation';
import { JOB_CARD_TYPES } from '../jobs/jobs-api';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { formatRefreshTime, resolveDatePreset, type ReportDatePreset } from './report-range';
import { getSalesFollowUpReport } from './reports-api';
import {
  readSalesFollowUpSearch,
  salesFollowUpSearch,
  validateRequestedRange,
} from './report-search';
import type { SalesFollowUpReportResponse } from './report-types';
import { ServoraTable } from '../ui/antd/ServoraTable';
import type { ServoraTableColumnsType } from '../ui/antd/ServoraTable';

import { SegmentedDistributionBar, IndependentMeterBars } from './report-charts';
import {
  ReportDateRangeForm,
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

const OUTCOME_LABELS: Record<string, string> = {
  POSITIVE: 'Olumlu sonuç',
  FOLLOW_UP_REQUIRED: 'Takip gerekli',
  NO_DECISION: 'Karar verilmedi',
  NOT_INTERESTED: 'İlgilenmedi',
};

const OUTCOME_ORDER = ['POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED'] as const;

const OUTCOME_DISCLOSURE =
  'Seçilen dönem, görüşme gerçekleşme kaydına (meeting_at) göre belirlenir; dağılım görüşmelerin güncel kayıtlı sonucunu gösterir. Sonuç sonradan değiştirilebilir ve geçmişe dönük yorumlanmamalıdır.';

const OVERDUE_HINT =
  'Yalnız teslim tarihi bulunan aktif takip işleri sayılır; otomatik oluşturulan takiplerde tarih bulunmayabilir.';

const PERIOD_CREATED_LABEL = 'Oluşturulan satış görüşmesi işleri';
const PERIOD_APPROVED_LABEL = 'Yönetici onaylı tamamlanan görüşmeler';
const PERIOD_FOLLOW_UP_CREATED_LABEL = 'Oluşturulan takip işleri';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

export function formatScheduledAt(value: string | null, timeZone: string) {
  if (value === null) return 'Planlanmadı';
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(new Date(value));
}

export function formatProposedAt(value: string | null, timeZone: string) {
  if (value === null) return 'Önerilen tarih belirtilmedi';
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

export function SalesFollowUpReportView({
  report,
  offset,
  proposalOffset,
  onSalesMeetingPage,
  onProposalPage,
}: {
  report: SalesFollowUpReportResponse;
  offset: number;
  proposalOffset: number;
  onSalesMeetingPage: (nextOffset: number) => void;
  onProposalPage: (nextOffset: number) => void;
}) {
  const salesRecovery =
    report.current.salesMeetings.items.length === 0 &&
    report.current.salesMeetings.total > 0 &&
    offset > 0;
  const proposalRecovery =
    report.current.proposalQueue.items.length === 0 &&
    report.current.proposalQueue.total > 0 &&
    proposalOffset > 0;

  const salesGlobalEmpty = report.current.salesMeetings.total === 0;
  const proposalGlobalEmpty = report.current.proposalQueue.total === 0;

  const outcomeTotal = report.period.meetingOutcomeDistribution.reduce((sum, item) => sum + item.count, 0);
  const outcomeEmpty = outcomeTotal === 0;

  const statusItems = report.current.salesMeetings.statusDistribution.map((item) => ({
    key: item.status,
    label: activeWorkflowPresentation[item.status as keyof typeof activeWorkflowPresentation]?.label ?? item.status,
    value: item.count,
  }));
  const followUpStatusItems = report.current.followUpChildren.statusDistribution.map((item) => ({
    key: item.status,
    label: activeWorkflowPresentation[item.status as keyof typeof activeWorkflowPresentation]?.label ?? item.status,
    value: item.count,
  }));
  const followUpTypeItems = report.current.followUpChildren.typeDistribution.map((item) => ({
    key: item.type,
    label: jobTypeLabels[item.type as keyof typeof jobTypeLabels] ?? item.type,
    value: item.count,
  }));

  const outcomeSegments = OUTCOME_ORDER.map((outcome) => {
    const found = report.period.meetingOutcomeDistribution.find((item) => item.outcome === outcome);
    return {
      key: outcome.toLowerCase(),
      label: OUTCOME_LABELS[outcome] ?? outcome,
      value: found?.count ?? 0,
    };
  });

  return (
    <>
      <section className="report-section" aria-labelledby="period-title">
        <h2 id="period-title">Seçilen dönem</h2>
        <p className="report-section-hint">Seçilen tarih aralığındaki satış görüşmesi ve takip hareketleri.</p>
        <dl className="report-metrics report-sales-period-metrics">
          <div>
            <dt>{PERIOD_CREATED_LABEL}</dt>
            <dd>{report.period.salesMeetingsCreated}</dd>
          </div>
          <div>
            <dt>{PERIOD_APPROVED_LABEL}</dt>
            <dd>{report.period.salesMeetingsManagerApproved}</dd>
          </div>
          <div>
            <dt>{PERIOD_FOLLOW_UP_CREATED_LABEL}</dt>
            <dd>{report.period.followUpChildrenCreated}</dd>
          </div>
        </dl>
        {report.period.salesMeetingsCreated === 0 && (
          <p className="report-section-hint">Seçilen dönemde satış görüşmesi işi oluşturulmamış.</p>
        )}
        <div className="report-sales-outcome" aria-labelledby="outcome-title">
          <h3 id="outcome-title">Görüşme sonucu dağılımı</h3>
          {outcomeEmpty ? (
            <p>Bu dönemde sonuç dağılımına dahil edilen görüşme bulunmuyor.</p>
          ) : (
            <SegmentedDistributionBar segments={outcomeSegments} />
          )}
          <p className="report-section-hint" data-outcome-disclosure="true">
            {OUTCOME_DISCLOSURE}
          </p>
        </div>
        {report.period.followUpChildrenCreatedByType.length > 0 && (
          <div className="report-sales-created-types" aria-label="Oluşturulan takip türleri">
            {report.period.followUpChildrenCreatedByType.map((item) => (
              <span key={item.type} className="report-customer-chip">
                {jobTypeLabels[item.type as keyof typeof jobTypeLabels] ?? item.type} {item.count}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="report-section" aria-labelledby="current-title">
        <h2 id="current-title">Şu an</h2>
        <p className="report-section-hint">Mevcut operasyonel durum; seçilen tarih aralığından bağımsızdır.</p>
        <div className="report-sales-current-group" aria-labelledby="current-sales-title">
          <h3 id="current-sales-title">Satış görüşmesi iş yükü</h3>
          <p>
            Şu an aktif satış görüşmesi işleri: <strong>{report.current.salesMeetings.total}</strong>
          </p>
          <IndependentMeterBars items={statusItems} ariaLabel="Satış görüşmesi durum dağılımı" />
        </div>
        <div className="report-sales-current-group" aria-labelledby="current-followup-title">
          <h3 id="current-followup-title">Takip iş yükü</h3>
          <p>
            Şu an aktif takip işleri: <strong>{report.current.followUpChildren.total}</strong>
          </p>
          <p>
            Gecikmiş (teslim tarihi bulunan) takip işleri: <strong>{report.current.followUpChildren.overdueDueDatedFollowUpChildren}</strong>
          </p>
          <p className="report-section-hint">{OVERDUE_HINT}</p>
          {report.current.followUpChildren.overdueDueDatedFollowUpChildren === 0 ? (
            <p>Tarihli takip işleri arasında gecikmiş kayıt bulunmuyor.</p>
          ) : null}
          <div aria-label="Takip durum dağılımı">
            <IndependentMeterBars items={followUpStatusItems} ariaLabel="Takip durum dağılımı" />
          </div>
          <div aria-label="Takip tür dağılımı">
            <IndependentMeterBars items={followUpTypeItems} ariaLabel="Takip tür dağılımı" />
          </div>
        </div>
        <div className="report-sales-relationships" aria-label="İlişki kanıtı">
          <p>
            Doğrudan takip bağlantıları: <strong>{report.relationships.directFollowUpLinks}</strong>
          </p>
        </div>
      </section>

      <section className="report-section" aria-labelledby="sales-queue-title">
        <h2 id="sales-queue-title">Satış görüşmesi kuyruğu</h2>
        {salesGlobalEmpty ? (
          <ReportEmptyState title="Şu an aktif satış görüşmesi işi bulunmuyor." />
        ) : salesRecovery ? (
          <div role="status" data-recovery="sales-meeting">
            <p>Bu sayfada artık gösterilecek kayıt bulunmuyor.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onSalesMeetingPage(Math.max(0, offset - 10))}
            >
              Önceki sayfaya dön
            </button>
          </div>
        ) : (
          <ServoraTable
            data-pager="sales-meeting"
            rowKey="id"
            dataSource={report.current.salesMeetings.items}
            size="middle"
            pagination={{
              current: Math.floor(offset / 10) + 1,
              pageSize: 10,
              total: report.current.salesMeetings.total,
              showSizeChanger: false,
              onChange: (page) => onSalesMeetingPage((page - 1) * 10),
            }}
            columns={[
              {
                title: 'Müşteri',
                key: 'customer',
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) =>
                  record.customer ? (
                    <Link to={paths.customer(record.customer.id)} aria-label={`${record.customer.name} müşterisini aç`}>
                      {record.customer.name}
                    </Link>
                  ) : (
                    <span>Müşteri belirtilmedi</span>
                  ),
                
              },
              {
                title: 'Planlanan tarih',
                key: 'scheduledAt',
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) =>
                  formatScheduledAt(record.scheduledAt, report.range.timezone),
                
              },
              {
                title: 'Atanan personel',
                key: 'assignee',
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) => record.assignee.name,
                
              },
              {
                title: 'Durum',
                key: 'status',
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) =>
                  activeWorkflowPresentation[record.status as keyof typeof activeWorkflowPresentation]?.label ?? record.status,
                
              },
              {
                title: 'İşlem',
                key: 'action',
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) => (
                  <Link to={paths.job(record.id)} aria-label={`${record.id} işini aç`}>
                    İşi aç
                  </Link>
                ),
                
              },
              {
                title: 'Satış görüşmesi',
                key: 'mobile',
                
                render: (_: unknown, record: (typeof report.current.salesMeetings.items)[number]) => (
                  <div className="report-sales-mobile-cell">
                    <div>
                      {record.customer ? (
                        <Link to={paths.customer(record.customer.id)}>{record.customer.name}</Link>
                      ) : (
                        <span>Müşteri belirtilmedi</span>
                      )}
                    </div>
                    <div>{formatScheduledAt(record.scheduledAt, report.range.timezone)}</div>
                    <div>
                      {record.assignee.name} ·{' '}
                      {activeWorkflowPresentation[record.status as keyof typeof activeWorkflowPresentation]?.label ?? record.status}
                    </div>
                    <Link to={paths.job(record.id)}>İşi aç</Link>
                  </div>
                ),
              },
            ] as ServoraTableColumnsType<(typeof report.current.salesMeetings.items)[number]>}
          />
        )}
      </section>

      <section className="report-section" aria-labelledby="proposal-queue-title">
        <h2 id="proposal-queue-title">Onay / revizyon aşamasındaki takip önerileri</h2>
        {proposalGlobalEmpty ? (
          <ReportEmptyState title="Onay / revizyon aşamasında takip önerisi bulunmuyor." />
        ) : proposalRecovery ? (
          <div role="status" data-recovery="proposal">
            <p>Bu sayfada artık gösterilecek kayıt bulunmuyor.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onProposalPage(Math.max(0, proposalOffset - 10))}
            >
              Önceki sayfaya dön
            </button>
          </div>
        ) : (
          <ServoraTable
            data-pager="proposal"
            rowKey="id"
            dataSource={report.current.proposalQueue.items}
            size="middle"
            pagination={{
              current: Math.floor(proposalOffset / 10) + 1,
              pageSize: 10,
              total: report.current.proposalQueue.total,
              showSizeChanger: false,
              onChange: (page) => onProposalPage((page - 1) * 10),
            }}
            expandable={
              {
                columnTitle: <span className="visually-hidden">Talimat</span>,
                expandedRowRender: (record: (typeof report.current.proposalQueue.items)[number]) =>
                  record.followUpProposalInstructions ? (
                    <div className="report-proposal-expanded">
                      <h4>Takip talimatı</h4>
                      <p>{record.followUpProposalInstructions}</p>
                    </div>
                  ) : null,
                rowExpandable: (record: (typeof report.current.proposalQueue.items)[number]) =>
                  Boolean(record.followUpProposalInstructions),
              } as never
            }
            columns={[
              {
                title: 'Müşteri',
                key: 'customer',
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) =>
                  record.customer ? (
                    <Link to={paths.customer(record.customer.id)} aria-label={`${record.customer.name} müşterisini aç`}>
                      {record.customer.name}
                    </Link>
                  ) : (
                    <span>Müşteri belirtilmedi</span>
                  ),
                
              },
              {
                title: 'Durum',
                key: 'status',
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) =>
                  activeWorkflowPresentation[record.status as keyof typeof activeWorkflowPresentation]?.label ?? record.status,
                
              },
              {
                title: 'Önerilen takip tarihi',
                key: 'proposedAt',
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) =>
                  formatProposedAt(record.proposedFollowUpAt, report.range.timezone),
                
              },
              {
                title: 'Önerilen tür',
                key: 'type',
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) =>
                  record.followUpProposedType ? (jobTypeLabels[record.followUpProposedType as keyof typeof jobTypeLabels] ?? record.followUpProposedType) : 'Belirtilmedi',
                
              },
              {
                title: 'Önerilen sorumlu',
                key: 'assignee',
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) =>
                  record.followUpProposedAssignee ? record.followUpProposedAssignee.name : 'Belirtilmedi',
                
              },
              {
                title: 'Öneri',
                key: 'mobile',
                
                render: (_: unknown, record: (typeof report.current.proposalQueue.items)[number]) => (
                  <div className="report-proposal-mobile-cell">
                    <div>
                      {record.customer ? (
                        <Link to={paths.customer(record.customer.id)}>{record.customer.name}</Link>
                      ) : (
                        <span>Müşteri belirtilmedi</span>
                      )}{' '}
                      · {activeWorkflowPresentation[record.status as keyof typeof activeWorkflowPresentation]?.label ?? record.status}
                    </div>
                    <div>{formatProposedAt(record.proposedFollowUpAt, report.range.timezone)}</div>
                    <div>
                      {record.followUpProposedType ? (jobTypeLabels[record.followUpProposedType as keyof typeof jobTypeLabels] ?? record.followUpProposedType) : 'Belirtilmedi'}
                      {record.followUpProposedAssignee ? ` · ${record.followUpProposedAssignee.name}` : ''}
                    </div>
                  </div>
                ),
              },
            ] as ServoraTableColumnsType<(typeof report.current.proposalQueue.items)[number]>}
          />
        )}
      </section>
    </>
  );
}

export function SalesFollowUpReport() {
  const [search, setSearch] = useSearchParams();
  const state = readSalesFollowUpSearch(search);
  const [report, setReport] = useState<SalesFollowUpReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ReportDatePreset | null>(null);
  const [customPresetActive, setCustomPresetActive] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  const { from, to, offset, proposalOffset } = state;

  useEffect(() => {
    if (!state.canonical) setSearch(salesFollowUpSearch(state), { replace: true });
  }, [state, setSearch]);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await getSalesFollowUpReport({
        requestedRange: from && to ? { from, to } : null,
        limit: 10,
        offset,
        proposalLimit: 10,
        proposalOffset,
      });
      if (requestId !== requestSequence.current) return;
      setReport(next);
      setResolvedTimezone(next.range.timezone);
      setRefreshedAt(new Date());
      if (!from || !to) {
        setSearch(
          salesFollowUpSearch({
            from: next.range.from,
            to: next.range.to,
            offset,
            proposalOffset,
            canonical: true,
          }),
          { replace: true },
        );
      }
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Satış ve takip raporu yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [from, to, offset, proposalOffset, setSearch]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtimeInvalidation(['reports'], () => {
    void load();
  });

  useEffect(() => {
    if (!resolvedTimezone || !from || !to) return;
    const presets: ReportDatePreset[] = ['today', 'last7', 'last30', 'thisMonth'];
    const matching = presets.find((preset) => {
      const range = resolveDatePreset(preset, resolvedTimezone);
      return range.from === from && range.to === to;
    });
    setSelectedPreset(matching ?? null);
    setCustomPresetActive(matching === undefined);
  }, [resolvedTimezone, from, to]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rawFrom = String(data.get('from') ?? '');
    const rawTo = String(data.get('to') ?? '');
    const result = validateRequestedRange(rawFrom, rawTo);
    if (!result.ok) {
      setFormError(result.errors[0]?.message ?? 'Tarih aralığı geçersiz.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setFormError('');
    setSelectedPreset(null);
    setCustomPresetActive(true);
    setSearch(
      salesFollowUpSearch({
        ...result.value,
        offset: 0,
        proposalOffset: 0,
        canonical: true,
      }),
    );
  }

  function applyPreset(preset: ReportDatePreset) {
    if (!resolvedTimezone) return;
    const range = resolveDatePreset(preset, resolvedTimezone);
    setFormError('');
    setSelectedPreset(preset);
    setCustomPresetActive(false);
    setSearch(
      salesFollowUpSearch({
        ...range,
        offset: 0,
        proposalOffset: 0,
        canonical: true,
      }),
    );
  }

  function chooseCustomRange() {
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('input[name="from"]')?.focus();
    });
  }

  const refreshLabel = refreshedAt && resolvedTimezone ? formatRefreshTime(refreshedAt, resolvedTimezone) : null;
  const rangeContext = { from, to };

  return (
    <ReportShell
      title="Satış ve Takip Operasyon Analizi"
      description="Seçilen dönemdeki satış görüşmesi hareketlerini ve şu anki operasyonel iş yükünü izleyin."
      current="salesFollowUp"
      refreshLabel={refreshLabel}
      range={rangeContext}
    >
      <ReportDateRangeForm
        formKey={`${from}:${to}:${offset}:${proposalOffset}`}
        from={from ?? ''}
        to={to ?? ''}
        filterError={formError}
        errorRef={errorRef}
        onSubmit={submit}
        onPreset={applyPreset}
        presetsDisabled={!resolvedTimezone}
        onCustomPreset={chooseCustomRange}
        customPresetActive={customPresetActive}
        selectedPreset={selectedPreset}
      />
      {loading && <ReportLoadingState title="Satış ve takip raporu yükleniyor" />}
      {!loading && error && (
        <ReportErrorState title="Satış ve takip raporu yüklenemedi" message={error} onRetry={() => void load()} />
      )}
      {!loading && !error && report && (
        <SalesFollowUpReportView
          report={report}
          offset={offset}
          proposalOffset={proposalOffset}
          onSalesMeetingPage={(nextOffset) =>
            setSearch(salesFollowUpSearch({ from, to, offset: nextOffset, proposalOffset, canonical: true }))
          }
          onProposalPage={(nextProposalOffset) =>
            setSearch(salesFollowUpSearch({ from, to, offset, proposalOffset: nextProposalOffset, canonical: true }))
          }
        />
      )}
    </ReportShell>
  );
}
