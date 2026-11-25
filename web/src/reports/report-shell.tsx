import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../ui/PageHeader';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';
import { EmptyState, IconSegmented, LoadingSkeleton, ResultState } from '../ui/antd';
import { resolveDatePreset, type ReportDatePreset } from './report-range';
import { reportSectionHref, type ReportRangeContext } from './report-navigation';

export type ReportNavSection = 'summary' | 'staff' | 'customers' | 'deliveries' | 'approvals' | 'salesFollowUp';

const NAV: Array<{ id: ReportNavSection; label: string }> = [
  { id: 'summary', label: 'Özet' },
  { id: 'staff', label: 'Personel' },
  { id: 'customers', label: 'Müşteriler' },
  { id: 'deliveries', label: 'Teslimler' },
  { id: 'approvals', label: 'Onaylar' },
  { id: 'salesFollowUp', label: 'Satış ve takip' },
];

export type ReportPresetOption = { id: ReportDatePreset; label: string };

const PRESETS: readonly ReportPresetOption[] = [
  { id: 'today', label: 'Bugün' },
  { id: 'last7', label: 'Son 7 gün' },
  { id: 'last30', label: 'Son 30 gün' },
  { id: 'thisMonth', label: 'Bu ay' },
];

/**
 * The quick preset whose range equals the persisted URL range, or null for a
 * custom range. Derived from the URL so a reload, back/forward or the default
 * range still highlights the right preset.
 */
export function matchingReportPreset(
  from: string | null,
  to: string | null,
  timezone: string | null,
  options: readonly ReportPresetOption[] = PRESETS,
): ReportDatePreset | null {
  if (!timezone || !from || !to) return null;
  const match = options.find((preset) => {
    const range = resolveDatePreset(preset.id, timezone);
    return range.from === from && range.to === to;
  });
  return match?.id ?? null;
}

export function ReportNavigation({
  current,
  range,
}: {
  current: ReportNavSection;
  range?: ReportRangeContext | null;
}) {
  const navRef = useRef<HTMLElement>(null);
  // On narrow screens the section row scrolls horizontally; keep the current
  // section visible without moving the page vertically.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const start = active.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    const end = start + active.getBoundingClientRect().width;
    if (start < nav.scrollLeft || end > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = Math.max(0, start - 8);
    }
  }, [current]);
  return (
    <nav ref={navRef} className="report-nav" aria-label="Rapor bölümleri">
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
  return <span className="report-refresh-status">Son yenileme: {label}</span>;
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

/**
 * The submitted native inputs become controlled wheel fields. The hidden
 * native carrier keeps `from`/`to` in `FormData`, and the form's `key` remount
 * resets this state whenever the persisted range changes.
 */
function ReportRangeFields({
  from,
  to,
  filterError,
}: {
  from: string;
  to: string;
  filterError: string;
}) {
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);
  const describedBy = filterError ? 'report-filter-error' : undefined;
  return (
    <>
      <div className="report-range-field">
        <label htmlFor="report-range-from">Başlangıç</label>
        <WheelDateTimeField
          mode="date"
          id="report-range-from"
          name="from"
          value={fromValue}
          onChange={setFromValue}
          invalid={Boolean(filterError)}
          aria-describedby={describedBy}
          ariaLabel="Başlangıç"
        />
      </div>
      <div className="report-range-field">
        <label htmlFor="report-range-to">Bitiş</label>
        <WheelDateTimeField
          mode="date"
          id="report-range-to"
          name="to"
          value={toValue}
          onChange={setToValue}
          invalid={Boolean(filterError)}
          aria-describedby={describedBy}
          ariaLabel="Bitiş"
        />
      </div>
    </>
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
  presetsDisabled,
  presetControl = 'buttons',
  selectedPreset,
  presetOptions,
  onCustomPreset,
  customPresetActive = false,
  customPresetLabel = 'Özel aralık',
  wide,
  formClass,
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
  presetControl?: 'buttons' | 'segmented';
  selectedPreset?: ReportDatePreset | null;
  presetOptions?: readonly ReportPresetOption[];
  onCustomPreset?: () => void;
  customPresetActive?: boolean;
  customPresetLabel?: string;
  wide?: boolean;
  formClass?: string;
  children?: ReactNode;
}) {
  const availablePresets = presetOptions ?? PRESETS;

  const formClassNames = [
    'report-filters',
    wide ? 'report-filters-wide' : null,
    formClass ?? null,
  ].filter(Boolean).join(' ');

  return (
    <>
      {onPreset ? (
        <div className="report-presets" role="group" aria-label="Hızlı tarih aralığı">
          {presetControl === 'segmented' ? (
            <IconSegmented
              options={availablePresets.map((preset) => ({
                value: preset.id,
                label: preset.label,
              }))}
              value={selectedPreset ?? undefined}
              onChange={(value) => onPreset(value as ReportDatePreset)}
              ariaLabel="Hızlı tarih aralığı"
              disabled={presetsDisabled}
              responsiveVertical
            />
          ) : availablePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="report-preset-button"
                disabled={presetsDisabled}
                aria-pressed={selectedPreset === undefined ? undefined : selectedPreset === preset.id}
                onClick={() => onPreset(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          {onCustomPreset ? (
            <button
              type="button"
              className="report-preset-button report-preset-button--custom"
              disabled={presetsDisabled}
              aria-pressed={customPresetActive}
              onClick={onCustomPreset}
            >
              {customPresetLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="filter-region">
        <form
          key={formKey}
          className={formClassNames}
          onSubmit={onSubmit}
          noValidate
        >
          <ReportRangeFields from={from} to={to} filterError={filterError} />
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
  title: _title,
  description,
  current,
  refreshLabel,
  range,
  children,
}: {
  /** @deprecated H1 comes from resolved route identity; kept for call-site compat. */
  title: string;
  description?: ReactNode;
  current: ReportNavSection;
  refreshLabel?: string | null;
  range?: ReportRangeContext | null;
  children: ReactNode;
}) {
  void _title;
  return (
    <main className="workspace report-workspace">
      <PageHeader fallbackTitle={_title}
        description={<>{description ? <span className="report-intro">{description}</span> : null}
          {refreshLabel ? <ReportRefreshStatus label={refreshLabel} /> : null}</>}
        actions={<ReportNavigation current={current} range={range} />}
      />
      {children}
    </main>
  );
}
