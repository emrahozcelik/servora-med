import type { CSSProperties } from 'react';

export type TrendPoint = { date: string; count: number };

const WEEKDAY_LABELS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'] as const;

const monthTitle = (year: number, month: number) => new Intl.DateTimeFormat('tr-TR', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(Date.UTC(year, month - 1, 1)));

const dayLabel = (ymd: string) => new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${ymd}T00:00:00Z`));

type CalendarCell =
  | { kind: 'empty'; key: string }
  | { kind: 'day'; key: string; date: string; dayOfMonth: number; count: number; inRange: boolean };

function parseYmd(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

function ymdKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Monday-first index: Mon=0 … Sun=6 */
function mondayFirstIndex(year: number, month: number, day: number) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // Sun=0
  return (weekday + 6) % 7;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Accessible month calendar(s) for daily completion counts.
 * Only days present in `points` are "in range"; other month days render muted empty.
 */
export function CompletedTrendCalendar({
  points,
  className = 'report-trend-calendar',
}: {
  points: readonly TrendPoint[];
  className?: string;
}) {
  const byDate = new Map(points.map((point) => [point.date, point.count]));
  const max = points.reduce((peak, point) => Math.max(peak, point.count), 0);

  const months = new Map<string, { year: number; month: number }>();
  for (const point of points) {
    const { year, month } = parseYmd(point.date);
    months.set(`${year}-${month}`, { year, month });
  }
  const orderedMonths = [...months.values()].sort(
    (a, b) => a.year - b.year || a.month - b.month,
  );

  if (orderedMonths.length === 0) {
    return <p className="report-chart-summary">Takvimde gösterilecek gün yok.</p>;
  }

  return (
    <div className={className}>
      {orderedMonths.map(({ year, month }) => {
        const leading = mondayFirstIndex(year, month, 1);
        const length = daysInMonth(year, month);
        const cells: CalendarCell[] = [];
        for (let i = 0; i < leading; i += 1) {
          cells.push({ kind: 'empty', key: `pad-${year}-${month}-${i}` });
        }
        for (let day = 1; day <= length; day += 1) {
          const date = ymdKey(year, month, day);
          const inRange = byDate.has(date);
          cells.push({
            kind: 'day',
            key: date,
            date,
            dayOfMonth: day,
            count: byDate.get(date) ?? 0,
            inRange,
          });
        }
        while (cells.length % 7 !== 0) {
          cells.push({ kind: 'empty', key: `trail-${year}-${month}-${cells.length}` });
        }
        const weeks: CalendarCell[][] = [];
        for (let i = 0; i < cells.length; i += 7) {
          weeks.push(cells.slice(i, i + 7));
        }

        return (
          <table key={`${year}-${month}`} className="report-calendar-table">
            <caption>{monthTitle(year, month)} — tamamlanan işler</caption>
            <thead>
              <tr>
                {WEEKDAY_LABELS.map((label) => (
                  <th key={label} scope="col">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week, weekIndex) => (
                <tr key={`${year}-${month}-w${weekIndex}`}>
                  {week.map((cell) => {
                    if (cell.kind === 'empty') {
                      return <td key={cell.key} className="report-calendar-empty" aria-hidden="true" />;
                    }
                    const intensity = !cell.inRange || max === 0
                      ? 0
                      : cell.count / max;
                    return (
                      <td
                        key={cell.key}
                        className={[
                          'report-calendar-day',
                          cell.inRange ? 'is-in-range' : 'is-out-of-range',
                          cell.count > 0 ? 'has-count' : '',
                        ].filter(Boolean).join(' ')}
                        style={{ '--intensity': String(intensity) } as CSSProperties}
                      >
                        <span className="report-calendar-date" aria-hidden="true">
                          {cell.dayOfMonth}
                        </span>
                        <span className="visually-hidden">
                          {dayLabel(cell.date)}
                          {cell.inRange
                            ? `: ${cell.count} tamamlanan iş`
                            : ': seçilen aralık dışında'}
                        </span>
                        {cell.inRange ? (
                          <span className="report-calendar-count" aria-hidden="true">
                            {cell.count}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

export type DistributionSegment = {
  key: string;
  label: string;
  value: number;
};

const formatDate = (value: string) => new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

/** Density class so long ranges (up to 366 days) fit without horizontal overflow. */
export function trendDensityClass(pointCount: number): 'density-normal' | 'density-compact' | 'density-dense' {
  if (pointCount <= 60) return 'density-normal';
  if (pointCount <= 120) return 'density-compact';
  return 'density-dense';
}

/**
 * Decorative daily trend bars. Always pair with an accessible summary/table.
 * Zero / single / max edge cases: min height for zero, scale to max count.
 */
export function TrendBars({
  points,
  className = 'report-trend-bars',
}: {
  points: readonly TrendPoint[];
  className?: string;
}) {
  const max = points.reduce((peak, point) => Math.max(peak, point.count), 0);
  const density = trendDensityClass(points.length);
  return (
    <div
      className={`${className} ${className}--${density}`}
      data-density={density}
      data-point-count={points.length}
      aria-hidden="true"
    >
      {points.map((point) => {
        const ratio = max === 0 ? 0 : point.count / max;
        return (
          <span
            key={point.date}
            title={`${formatDate(point.date)}: ${point.count}`}
            style={{
              '--ratio': String(ratio),
              '--count': String(point.count),
            } as CSSProperties}
            data-zero={point.count === 0 ? 'true' : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * Mutually exclusive bucket distribution (e.g. approval SLA).
 * Segments must not represent overlapping counts.
 */
export function SegmentedDistributionBar({
  segments,
  className = 'report-segmented-bar',
}: {
  segments: readonly DistributionSegment[];
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className={className}>
      <div className="report-segmented-track" aria-hidden="true">
        {total === 0
          ? <span className="report-segmented-empty" />
          : segments.map((segment) => {
            if (segment.value <= 0) return null;
            const width = `${(segment.value / total) * 100}%`;
            return (
              <span
                key={segment.key}
                className={`report-segmented-fill report-segmented-fill--${segment.key}`}
                style={{ width }}
                title={`${segment.label}: ${segment.value}`}
              />
            );
          })}
      </div>
      <ul className="report-segmented-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className={`report-segmented-swatch report-segmented-fill--${segment.key}`} aria-hidden="true" />
            <span>{segment.label}</span>
            <strong>{segment.value}</strong>
          </li>
        ))}
      </ul>
      <p className="report-chart-summary">
        {total === 0
          ? 'Dağılımda kayıt yok.'
          : `Toplam ${total} kayıt: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}.`}
      </p>
    </div>
  );
}

/**
 * Independent horizontal meters — NOT a partition of 100%.
 * Each bar scales to the max among the provided values for visual comparison only.
 */
export function IndependentMeterBars({
  items,
  className = 'report-meter-list',
}: {
  items: readonly { key: string; label: string; value: number; tone?: 'primary' | 'warning' | 'danger' | 'muted' }[];
  className?: string;
}) {
  const max = items.reduce((peak, item) => Math.max(peak, item.value), 0);
  return (
    <ul className={className}>
      {items.map((item) => {
        const ratio = max === 0 ? 0 : item.value / max;
        return (
          <li key={item.key} className={`report-meter report-meter--${item.tone ?? 'primary'}`}>
            <div className="report-meter-label">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
            <div className="report-meter-track" aria-hidden="true">
              <span style={{ width: `${ratio * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
