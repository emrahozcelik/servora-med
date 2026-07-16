import type { FormEvent, ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { ReportDatePreset } from './report-range';

export type ReportNavSection = 'summary' | 'deliveries' | 'approvals';

const NAV: Array<{ id: ReportNavSection; to: string; label: string }> = [
  { id: 'summary', to: paths.reports, label: 'Özet' },
  { id: 'deliveries', to: paths.deliveryReports, label: 'Teslimler' },
  { id: 'approvals', to: paths.approvalReports, label: 'Onaylar' },
];

const PRESETS: Array<{ id: ReportDatePreset; label: string }> = [
  { id: 'today', label: 'Bugün' },
  { id: 'last7', label: 'Son 7 gün' },
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'thisMonth', label: 'Bu ay' },
];

export function ReportNavigation({ current }: { current: ReportNavSection }) {
  return (
    <nav className="report-nav" aria-label="Rapor bölümleri">
      {NAV.map((item) => (
        <Link
          key={item.id}
          to={item.to}
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
  return (
    <div className="report-empty">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
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
  return (
    <div className="workspace-message" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Tekrar dene
        </button>
      ) : null}
    </div>
  );
}

export function ReportLoadingState({ title }: { title: string }) {
  return (
    <section className="report-loading" aria-busy="true">
      <h1>{title}</h1>
    </section>
  );
}

export function ReportDateRangeForm({
  formKey,
  from,
  to,
  filterError,
  errorRef,
  onSubmit,
  onPreset,
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
              onClick={() => onPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
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
  children,
}: {
  title: string;
  current: ReportNavSection;
  refreshLabel?: string | null;
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
        <ReportNavigation current={current} />
      </header>
      {children}
    </main>
  );
}
