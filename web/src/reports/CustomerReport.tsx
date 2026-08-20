import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { jobTypeLabels } from '../jobs/job-labels';
import { JOB_CARD_TYPES } from '../jobs/jobs-api';
import { paths } from '../paths';
import {
  customerStatusLabels,
  customerTypeLabels,
  CUSTOMER_STATUSES,
  CUSTOMER_TYPES,
} from '../services/crm-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { formatRefreshTime } from './report-range';
import { getCustomerReport } from './reports-api';
import { customerSearch, readCustomerSearch, validateRequestedRange } from './report-search';
import type { CustomerReportResponse, CustomerReportSnapshot } from './report-types';
import {
  ReportDateRangeForm,
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

const DISCLOSURE = 'Seçilen dönem metrikleri, iş kartlarının rapor anındaki mevcut müşteri bağlantısına göre gruplanır.';
const UNASSIGNED_HINT = 'Müşteri ilişkilendirilmemiş iş kartları, müşteri satırlarından ayrı tutulur ve müşteri filtrelerinden etkilenmez.';
const PERIOD_EMPTY_COPY = 'Seçilen dönemde iş kaydı yok.';

function snapshotZero(snapshot: CustomerReportSnapshot) {
  return Object.values(snapshot).every((value) => value === 0);
}

function periodZero(period: CustomerReportResponse['items'][number]['activity']['period']) {
  return period.created === 0 && period.managerApproved === 0 && period.followUpChildren === 0;
}

function CustomerRow({ item, index }: {
  item: CustomerReportResponse['items'][number];
  index: number;
}) {
  const { customer, activity } = item;
  const emptyPeriod = periodZero(activity.period);
  return (
    <li className="report-customer-card">
      <article className="report-customer-row">
        <div className="report-customer-identity">
          <h3>
            <Link
              to={paths.customer(customer.id)}
              aria-label={`${customer.name} müşterisini aç`}
            >
              {customer.name}
            </Link>
          </h3>
          <p className="report-customer-facts">
            {customerTypeLabels[customer.customerType]} · {customerStatusLabels[customer.status]}
          </p>
        </div>
        <section
          className="report-customer-current"
          aria-labelledby={`customer-current-${index}`}
        >
          <h4 id={`customer-current-${index}`}>Şu an</h4>
          <dl className="report-customer-metrics report-customer-metrics--current">
            <div><dt>Aktif işler</dt><dd>{activity.snapshot.active}</dd></div>
            <div><dt>Aksiyon alınabilir</dt><dd>{activity.snapshot.actionable}</dd></div>
            <div><dt>Onay bekliyor</dt><dd>{activity.snapshot.waitingApproval}</dd></div>
            <div><dt>Düzeltme bekliyor</dt><dd>{activity.snapshot.revisionRequested}</dd></div>
            <div><dt>Gecikmiş</dt><dd>{activity.snapshot.overdue}</dd></div>
          </dl>
        </section>
        <section
          className="report-customer-period"
          aria-labelledby={`customer-period-${index}`}
        >
          <h4 id={`customer-period-${index}`}>Seçilen dönem</h4>
          {emptyPeriod ? <p className="report-customer-zero">{PERIOD_EMPTY_COPY}</p> : (
            <>
              <dl className="report-customer-metrics report-customer-metrics--period">
                <div><dt>Oluşturulan işler</dt><dd>{activity.period.created}</dd></div>
                <div><dt>Yönetici onaylı tamamlananlar</dt><dd>{activity.period.managerApproved}</dd></div>
                <div><dt>Oluşturulan takip işleri</dt><dd>{activity.period.followUpChildren}</dd></div>
              </dl>
              <div
                className="report-customer-work-types"
                aria-label="Seçilen dönemde oluşturulan iş türleri"
              >
                {JOB_CARD_TYPES.map((type) => (
                  <span className="report-customer-chip" key={type}>
                    {jobTypeLabels[type]} {activity.period.createdWorkTypes[type]}
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      </article>
    </li>
  );
}

export function CustomerReportView({
  report,
  filtersActive = false,
  onResetFilters,
}: {
  report: CustomerReportResponse;
  filtersActive?: boolean;
  onResetFilters?: () => void;
}) {
  const unassigned = report.unassigned;
  const unassignedZero = snapshotZero(unassigned.snapshot)
    && periodZero(unassigned.period);
  return (
    <>
      <section className="report-customer-unassigned" aria-labelledby="customer-unassigned-title">
        <h2 id="customer-unassigned-title">Müşteri ilişkilendirilmemiş işler</h2>
        <p className="report-section-hint">{UNASSIGNED_HINT}</p>
        {unassignedZero ? (
          <p className="report-customer-zero">Şu an müşteri ilişkilendirilmemiş iş bulunmuyor.</p>
        ) : (
          <dl className="report-customer-unassigned-metrics">
            <div><dt>Aktif işler</dt><dd>{unassigned.snapshot.active}</dd></div>
            <div><dt>Gecikmiş</dt><dd>{unassigned.snapshot.overdue}</dd></div>
            <div><dt>Oluşturulan işler</dt><dd>{unassigned.period.created}</dd></div>
            <div><dt>Yönetici onaylı tamamlananlar</dt><dd>{unassigned.period.managerApproved}</dd></div>
          </dl>
        )}
      </section>
      <section className="report-customer-collection" aria-labelledby="customer-collection-title">
        <h2 id="customer-collection-title">Müşteriler</h2>
        <p className="report-section-hint">{DISCLOSURE}</p>
        {report.items.length === 0 ? (
          <ReportEmptyState
            title={filtersActive ? 'Filtrelere uygun müşteri bulunamadı.' : 'Henüz müşteri kaydı yok.'}
            description={filtersActive ? undefined : 'Henüz müşteri kaydı eklenmemiş.'}
            action={filtersActive ? (
              <button
                type="button"
                className="secondary-button"
                onClick={onResetFilters}
              >
                Filtreleri sıfırla
              </button>
            ) : undefined}
          />
        ) : (
          <ul className="report-customer-list" aria-labelledby="customer-collection-title">
            {report.items.map((item, index) => (
              <CustomerRow key={item.customer.id} item={item} index={index} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function CustomerReport() {
  const [search, setSearch] = useSearchParams();
  const state = readCustomerSearch(search);
  const [report, setReport] = useState<CustomerReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!state.canonical) setSearch(customerSearch(state), { replace: true });
  }, [state, setSearch]);

  const { from, to, offset } = state;
  const searchText = state.search;
  const status = state.status;
  const customerType = state.customerType;

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await getCustomerReport({
        search: searchText,
        status,
        customerType,
        requestedRange: from && to ? { from, to } : null,
        limit: 50,
        offset,
      });
      if (requestId !== requestSequence.current) return;
      setReport(next);
      setResolvedTimezone(next.range.timezone);
      setRefreshedAt(new Date());
      if (!from || !to) {
        setSearch(customerSearch({
          from: next.range.from,
          to: next.range.to,
          search: searchText,
          status,
          customerType,
          offset,
          canonical: true,
        }), { replace: true });
      }
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Müşteri operasyon aktivitesi raporu yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [from, to, searchText, status, customerType, offset, setSearch]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['reports'], () => { void load(); });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fromValue = String(data.get('from') ?? '');
    const toValue = String(data.get('to') ?? '');
    const range = validateRequestedRange(fromValue, toValue);
    if (!range.ok) {
      setFormError(range.errors[0]?.message ?? 'Tarih aralığı geçersiz.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setFormError('');
    const rawStatus = String(data.get('status') ?? '');
    const rawType = String(data.get('customerType') ?? '');
    setSearch(customerSearch({
      ...range.value,
      search: String(data.get('search') ?? '').trim(),
      status: rawStatus && (CUSTOMER_STATUSES as readonly string[]).includes(rawStatus)
        ? rawStatus : null,
      customerType: rawType && (CUSTOMER_TYPES as readonly string[]).includes(rawType)
        ? rawType : null,
      offset: 0,
      canonical: true,
    }));
  }

  function resetFilters() {
    setFormError('');
    setSearch(customerSearch({
      from: state.from,
      to: state.to,
      search: '',
      status: null,
      customerType: null,
      offset: 0,
      canonical: true,
    }));
  }

  const filtersActive = searchText !== '' || status !== null || customerType !== null;
  const refreshLabel = refreshedAt && resolvedTimezone
    ? formatRefreshTime(refreshedAt, resolvedTimezone)
    : null;
  const rangeContext = { from: state.from, to: state.to };
  const recovery = report !== null
    && report.items.length === 0
    && report.total > 0
    && report.offset > 0;

  return (
    <ReportShell
      title="Müşteri operasyon aktivitesi"
      current="customers"
      refreshLabel={refreshLabel}
      range={rangeContext}
    >
      <ReportDateRangeForm
        formKey={JSON.stringify([
          state.from, state.to, state.search, state.status, state.customerType,
        ])}
        from={state.from ?? ''}
        to={state.to ?? ''}
        filterError={formError}
        errorRef={errorRef}
        onSubmit={submit}
        wide
        formClass="report-filters-wide--customer"
      >
        <label>
          Ara
          <input name="search" type="search" defaultValue={state.search} />
        </label>
        <label>
          Durum
          <select name="status" defaultValue={state.status ?? ''}>
            <option value="">Tümü</option>
            {CUSTOMER_STATUSES.map((value) => (
              <option key={value} value={value}>{customerStatusLabels[value]}</option>
            ))}
          </select>
        </label>
        <label>
          Tür
          <select name="customerType" defaultValue={state.customerType ?? ''}>
            <option value="">Tümü</option>
            {CUSTOMER_TYPES.map((value) => (
              <option key={value} value={value}>{customerTypeLabels[value]}</option>
            ))}
          </select>
        </label>
      </ReportDateRangeForm>
      {filtersActive && (
        <div className="report-active-filters">
          <button type="button" className="secondary-button" onClick={resetFilters}>
            Filtreleri sıfırla
          </button>
        </div>
      )}
      {loading && <ReportLoadingState title="Müşteri operasyon aktivitesi yükleniyor" />}
      {!loading && error && (
        <ReportErrorState
          title="Müşteri operasyon aktivitesi yüklenemedi"
          message={error}
          onRetry={() => void load()}
        />
      )}
      {!loading && !error && report && (
        recovery ? (
          <section className="report-customer-recovery" role="status">
            <h2>Bu sayfada gösterilecek kayıt kalmadı.</h2>
            <p>Daha yeni kayıtlar olduğu için sayfa boş görünüyor.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSearch(customerSearch({
                ...state,
                offset: Math.max(0, report.offset - report.limit),
                canonical: true,
              }))}
            >
              Önceki sayfaya dön
            </button>
          </section>
        ) : (
          <>
            <CustomerReportView
              report={report}
              filtersActive={filtersActive}
              onResetFilters={resetFilters}
            />
            {report.items.length > 0 && (
              <div className="report-pagination report-pagination--wrap">
                <button
                  type="button"
                  disabled={state.offset === 0}
                  onClick={() => setSearch(customerSearch({
                    ...state,
                    offset: Math.max(0, state.offset - report.limit),
                    canonical: true,
                  }))}
                >
                  Önceki
                </button>
                <span>{report.total} müşteri</span>
                <button
                  type="button"
                  disabled={state.offset + report.limit >= report.total}
                  onClick={() => setSearch(customerSearch({
                    ...state,
                    offset: state.offset + report.limit,
                    canonical: true,
                  }))}
                >
                  Sonraki
                </button>
              </div>
            )}
          </>
        )
      )}
    </ReportShell>
  );
}