import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { jobTypeLabels } from '../jobs/job-labels';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  StaffPerformanceTable,
  type StaffPerformanceTableRecord,
} from '../ui/antd';
import {
  formatRefreshTime,
  resolveDatePreset,
  type ReportDatePreset,
} from './report-range';
import {
  readStaffPerformanceSearch,
  staffPerformanceSearch,
  validateRequestedRange,
} from './report-search';
import type { StaffPerformanceResponse } from './report-types';
import { getStaffPerformance } from './reports-api';
import {
  ReportDateRangeForm,
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
  ReportShell,
} from './report-shell';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function performanceRangeLabel(report: StaffPerformanceResponse) {
  return `${formatDate(report.range.from)} – ${formatDate(report.range.to)}`;
}

function priorRangeLabel(report: StaffPerformanceResponse) {
  return `${formatDate(report.priorRange.from)} – ${formatDate(report.priorRange.to)}`;
}

function tableRecord(
  item: StaffPerformanceResponse['items'][number],
  report: StaffPerformanceResponse,
): StaffPerformanceTableRecord {
  return {
    key: item.staff.userId,
    name: item.staff.name,
    isActive: item.staff.isActive,
    completedJobs: item.performance.completedJobs,
    authoredOperationalNotes: item.performance.authoredOperationalNotes,
    staffSubmissionAttribution: item.staffSubmissionAttribution,
    priorRangeLabel: priorRangeLabel(report),
    priorPerformance: item.priorPerformance,
    completionWorkTypes: item.completionWorkTypes.map((workType) => ({
      label: jobTypeLabels[workType.type],
      count: workType.count,
    })),
    currentWorkloadByType: item.currentWorkloadByType.map((workType) => ({
      label: jobTypeLabels[workType.type],
      count: workType.count,
    })),
    currentWorkload: item.currentWorkload,
    reportHref: paths.staffReport(item.staff.userId, report.range),
  };
}

export function StaffPerformanceReport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = readStaffPerformanceSearch(searchParams);
  const [report, setReport] = useState<StaffPerformanceResponse | null>(null);
  const [staffSearch, setStaffSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterError, setFilterError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ReportDatePreset | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const requestedRange = state.from && state.to
        ? { from: state.from, to: state.to }
        : null;
      const next = await getStaffPerformance(requestedRange);
      if (requestId !== requestSequence.current) return;
      setReport(next);
      setResolvedTimezone(next.range.timezone);
      setRefreshedAt(new Date());
      if (!state.from || !state.to) {
        setSearchParams(staffPerformanceSearch({ ...next.range, canonical: true }), {
          replace: true,
        });
      }
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Personel operasyon analizi yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [state.from, state.to, setSearchParams]);

  useEffect(() => {
    if (!state.canonical) {
      setSearchParams(staffPerformanceSearch(state), { replace: true });
    }
  }, [state, setSearchParams]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeInvalidation(['reports'], () => { void load(); });

  const records = useMemo(() => {
    if (!report) return [];
    const normalized = staffSearch.trim().toLocaleLowerCase('tr-TR');
    return report.items
      .filter((item) => !normalized
        || item.staff.name.toLocaleLowerCase('tr-TR').includes(normalized))
      .map((item) => tableRecord(item, report));
  }, [report, staffSearch]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = validateRequestedRange(
      String(data.get('from') ?? ''),
      String(data.get('to') ?? ''),
    );
    if (!result.ok) {
      setFilterError(result.errors[0]?.message ?? 'Tarih aralığı geçersiz.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setFilterError('');
    setSelectedPreset(null);
    setSearchParams(staffPerformanceSearch({ ...result.value, canonical: true }));
  }

  function applyPreset(preset: ReportDatePreset) {
    if (!resolvedTimezone) return;
    const nextRange = resolveDatePreset(preset, resolvedTimezone);
    setFilterError('');
    setSelectedPreset(preset);
    setSearchParams(staffPerformanceSearch({ ...nextRange, canonical: true }));
  }

  const refreshLabel = refreshedAt && resolvedTimezone
    ? formatRefreshTime(refreshedAt, resolvedTimezone)
    : null;
  const rangeContext = { from: state.from, to: state.to };

  return (
    <ReportShell
      title="Personel Operasyon Analizi"
      current="staff"
      refreshLabel={refreshLabel}
      range={rangeContext}
    >
      <ReportDateRangeForm
        formKey={`${state.from}:${state.to}`}
        from={state.from ?? ''}
        to={state.to ?? ''}
        filterError={filterError}
        errorRef={errorRef}
        onSubmit={submit}
        onPreset={applyPreset}
        presetsDisabled={!resolvedTimezone}
        presetControl="segmented"
        selectedPreset={selectedPreset}
      />

      {!loading && !error && report && report.items.length > 0 && (
        <div className="staff-performance-search">
          <label htmlFor="staff-performance-search">Personel ara</label>
          <input
            id="staff-performance-search"
            name="staffSearch"
            type="search"
            value={staffSearch}
            onChange={(event) => setStaffSearch(event.currentTarget.value)}
            autoComplete="off"
          />
        </div>
      )}

      {loading && <ReportLoadingState title="Personel operasyon analizi yükleniyor" />}
      {!loading && error && (
        <ReportErrorState
          title="Personel operasyon analizi yüklenemedi"
          message={error}
          onRetry={() => void load()}
        />
      )}
      {!loading && !error && report && report.items.length === 0 && (
        <ReportEmptyState
          title="Gösterilecek personel bulunmuyor"
          description="Bu görünüm için uygun personel kaydı bulunmuyor."
        />
      )}
      {!loading && !error && report && report.items.length > 0 && (
        <section className="staff-performance-results" aria-labelledby="staff-performance-period">
          <div className="staff-performance-results-heading">
            <div>
              <h2 id="staff-performance-period">
                Personel operasyon analizi — {performanceRangeLabel(report)}
              </h2>
              <p>
                Şu an bölümü mevcut aksiyon kuyruklarını ve iş türü dağılımını; seçilen dönem
                bölümü ise yönetici onaylı tamamlanmaları ve kayıtlı operasyon kanıtlarını gösterir.
              </p>
              <p className="staff-performance-prior-range">
                Önceki dönem: {priorRangeLabel(report)}
              </p>
            </div>
            <span>{report.range.timezone}</span>
          </div>
          {records.length === 0 ? (
            <ReportEmptyState
              title="Aramayla eşleşen personel bulunmuyor"
              description="Farklı bir ad arayın veya arama alanını temizleyin."
            />
          ) : <StaffPerformanceTable records={records} />}
        </section>
      )}
    </ReportShell>
  );
}
