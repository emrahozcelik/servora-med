import type { FormEvent, ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';

import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';
import type { ReportDatePreset } from './report-range';
import { reportSectionHref, type ReportRangeContext } from './report-navigation';

export type ReportNavSection = 'summary' | 'deliveries' | 'approvals';

const NAV: Array<{ id: ReportNavSection; label: string }> = [
  { id: 'summary', label: 'Özet' },
  { id: 'deliveries', label: 'Teslimler' },
  { id: 'approvals', label: 'Onaylar' },
];

const PRESETS: Array<{ id: ReportDatePreset; label: string }> = [
  { id: 'today', label: 'Bugün' },
  { id: 'last7', label: 'Son 7 gün' },
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'thisMonth', label: 'Bu ay' },
];

export function ReportNavigation({
  current,
  range,
}: {
  current: ReportNavSection;
  range?: ReportRangeContext | null;
}) {
  return (
    <nav className="report-nav" aria-label="Rapor bölümleri">
      {NAV.map((item) => (
        <Link
          key={item.id}
          to={reportSectionHref(item.id, range)}
          aria-current={item.id === current ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function ReportRefreshStatus({ label }: { label: string | null }) {
  if (!label) return null;
  return <p className="report-refresh-status">Son yenileme: {label}</p>;
}

export function ReportEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return <EmptyState
    title={title}
    description={description}
    action={action}
    headingLevel={3}
  />;
}

export function ReportErrorState({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return <ResultState
    status="error"
    title={title}
    description={message}
    headingLevel={2}
    action={onRetry ? (
      <button type="button" className="secondary-button" onClick={onRetry}>
        Tekrar dene
      </button>
    ) : undefined}
  />;
}

export function ReportLoadingState({ title }: { title: string }) {
  return <LoadingSkeleton title={title} headingLevel={1} rows={3} />;
}

export function ReportDateRangeForm({
  formKey,
  from,
  to,
  filterError,
  errorRef,
  onSubmit,
  onPreset,
  presetsDisabled,
  wide,
  children,
}: {
  formKey: string;
  from: string;
  to: string;
  filterError: string;
  errorRef: RefObject<HTMLDivElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onPreset?: (preset: ReportDatePreset) => void;
  /** Disable until organization timezone is known from a successful report response. */
  presetsDisabled?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {onPreset ? (
        <div className="report-presets" role="group" aria-label="Hızlı tarih aralığı">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="report-preset-button"
              disabled={presetsDisabled}
              onClick={() => onPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="filter-region">
        <form
          key={formKey}
          className={wide ? 'report-filters report-filters-wide' : 'report-filters'}
          onSubmit={onSubmit}
          noValidate
        >
          <label>
            Başlangıç
            <input
              name="from"
              type="date"
              defaultValue={from}
              aria-invalid={filterError ? true : undefined}
              aria-describedby={filterError ? 'report-filter-error' : undefined}
            />
          </label>
          <label>
            Bitiş
            <input
              name="to"
              type="date"
              defaultValue={to}
              aria-invalid={filterError ? true : undefined}
              aria-describedby={filterError ? 'report-filter-error' : undefined}
            />
          </label>
          {children}
          <button type="submit" className="secondary-button">Uygula</button>
        </form>
      </div>
      {filterError ? (
        <div
          id="report-filter-error"
          ref={errorRef}
          className="form-error"
          role="alert"
          tabIndex={-1}
        >
          <h2>Filtreleri kontrol edin</h2>
          <p>{filterError}</p>
        </div>
      ) : null}
    </>
  );
}

export function ReportShell({
  title,
  current,
  refreshLabel,
  range,
  children,
}: {
  title: string;
  current: ReportNavSection;
  refreshLabel?: string | null;
  range?: ReportRangeContext | null;
  children: ReactNode;
}) {
  return (
    <main className="workspace report-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Raporlar</p>
          <h1>{title}</h1>
          {refreshLabel ? <ReportRefreshStatus label={refreshLabel} /> : null}
        </div>
        <ReportNavigation current={current} range={range} />
      </header>
      {children}
    </main>
  );
}
