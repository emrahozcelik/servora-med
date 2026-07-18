import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { CurrentUser } from '../services/api';
import { listStaff, type StaffProfile } from '../services/people-api';
import {
  formatRefreshTime,
  resolveDatePreset,
  type ReportDatePreset,
} from './report-range';
import { getDeliveryReport } from './reports-api';
import { deliverySearch, readDeliverySearch, validateRequestedRange } from './report-search';
import type { DeliveryReportResponse } from './report-types';
import {
  OperationalTable,
  type OperationalTableColumn,
  type OperationalTableRow,
} from '../ui/OperationalTable';
import {
  ReportDateRangeForm,
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

const purposeLabels = {
  SALE: 'Satış', SAMPLE: 'Numune', CONSIGNMENT: 'Konsinye', RETURN: 'İade', OTHER: 'Diğer',
} as const;
const formatDate = (value: string) => new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

const DELIVERY_TABLE_CAPTION = 'Teslim miktarları (birim kırılımları birleştirilmez)';

function deliveryTableModel(report: DeliveryReportResponse): {
  columns: OperationalTableColumn[];
  rows: OperationalTableRow[];
} {
  if (report.groupBy === 'day') {
    return {
      columns: [
        { key: 'date', title: 'Tarih' },
        { key: 'unit', title: 'Birim' },
        { key: 'quantity', title: 'Miktar' },
      ],
      rows: report.items.map((item, index) => ({
        key: `day-${index}-${item.date}-${item.unit ?? ''}-${item.quantity}`,
        cells: {
          date: formatDate(item.date),
          unit: item.unit ?? 'Birim belirtilmedi',
          quantity: item.quantity,
        },
      })),
    };
  }
  if (report.groupBy === 'purpose') {
    return {
      columns: [
        { key: 'purpose', title: 'Amaç' },
        { key: 'unit', title: 'Birim' },
        { key: 'quantity', title: 'Miktar' },
      ],
      rows: report.items.map((item, index) => ({
        key: `purpose-${index}-${item.purpose}-${item.unit ?? ''}-${item.quantity}`,
        cells: {
          purpose: purposeLabels[item.purpose],
          unit: item.unit ?? 'Birim belirtilmedi',
          quantity: item.quantity,
        },
      })),
    };
  }
  if (report.groupBy === 'product') {
    return {
      columns: [
        { key: 'product', title: 'Ürün' },
        { key: 'sku', title: 'SKU' },
        { key: 'model', title: 'Model' },
        { key: 'unit', title: 'Birim' },
        { key: 'quantity', title: 'Miktar' },
      ],
      rows: report.items.map((item, index) => ({
        key: `product-${index}-${item.productId}-${item.unit ?? ''}-${item.quantity}`,
        cells: {
          product: item.productNameSnapshot,
          sku: item.productSkuSnapshot ?? 'Belirtilmedi',
          model: item.productModelSnapshot ?? 'Belirtilmedi',
          unit: item.unit ?? 'Birim belirtilmedi',
          quantity: item.quantity,
        },
      })),
    };
  }
  return {
    columns: [
      { key: 'staff', title: 'Personel' },
      { key: 'unit', title: 'Birim' },
      { key: 'quantity', title: 'Miktar' },
    ],
    rows: report.items.map((item, index) => ({
      key: `staff-${index}-${item.staff.userId}-${item.unit ?? ''}-${item.quantity}`,
      cells: {
        staff: `${item.staff.name}${item.staff.isActive ? '' : ' (Pasif)'}`,
        unit: item.unit ?? 'Birim belirtilmedi',
        quantity: item.quantity,
      },
    })),
  };
}

export function DeliveryReportView({
  report,
  onResetFilters,
}: {
  report: DeliveryReportResponse;
  onResetFilters?: () => void;
}) {
  if (report.items.length === 0) {
    return (
      <ReportEmptyState
        title="Onaylı teslim yok"
        description="Seçilen dönemde onaylı teslim bulunmuyor. Tarih aralığını veya filtreleri değiştirin."
        action={onResetFilters ? (
          <button type="button" className="secondary-button" onClick={onResetFilters}>
            Filtreleri sıfırla
          </button>
        ) : undefined}
      />
    );
  }
  const table = deliveryTableModel(report);
  return (
    <OperationalTable
      caption={DELIVERY_TABLE_CAPTION}
      columns={table.columns}
      rows={table.rows}
    />
  );
}

type StaffOptions = { status: 'loading' | 'ready' | 'error'; items: StaffProfile[] };

export function DeliveryReport({ user }: { user: CurrentUser }) {
  const [search, setSearch] = useSearchParams();
  const state = readDeliverySearch(search);
  const [report, setReport] = useState<DeliveryReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [options, setOptions] = useState<StaffOptions>({ status: 'loading', items: [] });
  const [reload, setReload] = useState(0);
  const [formError, setFormError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!state.canonical) setSearch(deliverySearch(state), { replace: true });
  }, [state, setSearch]);

  useEffect(() => {
    let current = true;
    setOptions({ status: 'loading', items: [] });
    void listStaff(user.role === 'ADMIN' ? 'all' : 'active').then(
      (items) => current && setOptions({ status: 'ready', items }),
      () => current && setOptions({ status: 'error', items: [] }),
    );
    return () => { current = false; };
  }, [user.role, reload]);

  const { from, to, groupBy, staffUserId, offset } = state;
  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await getDeliveryReport({
        groupBy,
        staffUserId,
        requestedRange: from && to ? { from, to } : null,
        limit: 50,
        offset,
      });
      if (requestId !== requestSequence.current) return;
      setReport(next);
      setResolvedTimezone(next.range.timezone);
      setRefreshedAt(new Date());
      if (!from || !to) {
        setSearch(deliverySearch({
          from: next.range.from,
          to: next.range.to,
          groupBy,
          staffUserId,
          offset,
          canonical: true,
        }), { replace: true });
      }
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Teslim raporu yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [from, to, groupBy, staffUserId, offset, setSearch]);

  useEffect(() => { void load(); }, [load]);

  const allowed = useMemo(
    () => new Set([
      ...options.items.map((item) => item.user.id),
      ...(state.staffUserId ? [state.staffUserId] : []),
    ]),
    [options.items, state.staffUserId],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fromValue = String(data.get('from') ?? '');
    const toValue = String(data.get('to') ?? '');
    const range = validateRequestedRange(fromValue, toValue);
    const nextGroup = String(data.get('groupBy') ?? '');
    const selected = String(data.get('staffUserId') ?? '');
    if (
      !range.ok
      || !['day', 'purpose', 'product', 'staff'].includes(nextGroup)
      || (selected && !allowed.has(selected))
    ) {
      setFormError(
        !range.ok
          ? range.errors[0]?.message ?? 'Tarih aralığı geçersiz.'
          : 'Geçerli filtreler seçin.',
      );
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setFormError('');
    setSearch(deliverySearch({
      ...range.value,
      groupBy: nextGroup as DeliveryReportResponse['groupBy'],
      staffUserId: selected || null,
      offset: 0,
      canonical: true,
    }));
  }

  function applyPreset(preset: ReportDatePreset) {
    if (!resolvedTimezone) return;
    const range = resolveDatePreset(preset, resolvedTimezone);
    setFormError('');
    setSearch(deliverySearch({
      ...range,
      groupBy: state.groupBy,
      staffUserId: state.staffUserId,
      offset: 0,
      canonical: true,
    }));
  }

  function resetFilters() {
    setFormError('');
    setSearch(deliverySearch({
      from: state.from,
      to: state.to,
      groupBy: 'day',
      staffUserId: null,
      offset: 0,
      canonical: true,
    }));
  }

  const unavailable = state.staffUserId !== null
    && !options.items.some((item) => item.user.id === state.staffUserId);
  const refreshLabel = refreshedAt && resolvedTimezone
    ? formatRefreshTime(refreshedAt, resolvedTimezone)
    : null;
  const rangeContext = { from: state.from, to: state.to };

  return (
    <ReportShell
      title="Teslim raporu"
      current="deliveries"
      refreshLabel={refreshLabel}
      range={rangeContext}
    >
      <ReportDateRangeForm
        formKey={JSON.stringify([state.from, state.to, state.groupBy, state.staffUserId])}
        from={state.from ?? ''}
        to={state.to ?? ''}
        filterError={formError}
        errorRef={errorRef}
        onSubmit={submit}
        onPreset={applyPreset}
        presetsDisabled={!resolvedTimezone}
        wide
      >
        <label>
          Gruplama
          <select name="groupBy" defaultValue={state.groupBy}>
            <option value="day">Gün</option>
            <option value="purpose">Amaç</option>
            <option value="product">Ürün</option>
            <option value="staff">Personel</option>
          </select>
        </label>
        <label>
          Personel
          <select
            name="staffUserId"
            defaultValue={state.staffUserId ?? ''}
            disabled={options.status === 'loading'}
          >
            <option value="">Tüm personel</option>
            {unavailable && (
              <option value={state.staffUserId!}>Seçili personel (listede yok)</option>
            )}
            {options.items.map((item) => (
              <option key={item.user.id} value={item.user.id}>
                {item.user.name}{item.user.isActive ? '' : ' (Pasif)'}
              </option>
            ))}
          </select>
        </label>
      </ReportDateRangeForm>
      {options.status === 'error' && (
        <div className="inline-report-error" role="alert">
          Personel seçenekleri yüklenemedi.
          {' '}
          <button type="button" onClick={() => setReload((value) => value + 1)}>Tekrar dene</button>
        </div>
      )}
      {loading && <ReportLoadingState title="Teslim raporu yükleniyor" />}
      {!loading && error && (
        <ReportErrorState title="Teslim raporu yüklenemedi" message={error} onRetry={() => void load()} />
      )}
      {!loading && !error && report && (
        <>
          <DeliveryReportView report={report} onResetFilters={resetFilters} />
          <div className="report-pagination">
            <button
              type="button"
              disabled={state.offset === 0}
              onClick={() => setSearch(deliverySearch({ ...state, offset: Math.max(0, state.offset - 50) }))}
            >
              Önceki
            </button>
            <span>{report.total} grup</span>
            <button
              type="button"
              disabled={state.offset + report.limit >= report.total}
              onClick={() => setSearch(deliverySearch({ ...state, offset: state.offset + report.limit }))}
            >
              Sonraki
            </button>
          </div>
        </>
      )}
    </ReportShell>
  );
}
