import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CompletedTrendCalendar,
  IndependentMeterBars,
  SegmentedDistributionBar,
  TrendBars,
  trendDensityClass,
} from '../src/reports/report-charts';

function dayPoints(count: number, value = 1) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    count: value,
  }));
}

describe('TrendBars contract', () => {
  it('is always aria-hidden and never the sole meaning carrier', () => {
    const html = renderToStaticMarkup(<TrendBars points={[{ date: '2026-07-01', count: 2 }]} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-report-trend-bars="true"');
  });

  it('handles empty, single, all-zero max, and 366-day density', () => {
    expect(renderToStaticMarkup(<TrendBars points={[]} />)).toContain('data-point-count="0"');
    const single = renderToStaticMarkup(<TrendBars points={[{ date: '2026-07-01', count: 4 }]} />);
    expect(single).toContain('data-point-count="1"');
    expect(single).toContain('data-density="density-normal"');

    const zeros = renderToStaticMarkup(
      <TrendBars points={[{ date: '2026-07-01', count: 0 }, { date: '2026-07-02', count: 0 }]} />,
    );
    expect(zeros).toContain('data-zero="true"');

    expect(trendDensityClass(366)).toBe('density-dense');
    const long = renderToStaticMarkup(<TrendBars points={dayPoints(366)} />);
    expect(long).toContain('data-density="density-dense"');
    expect(long).toContain('data-point-count="366"');
  });
});

describe('CompletedTrendCalendar contract', () => {
  it('shows empty message when no points are provided', () => {
    const html = renderToStaticMarkup(<CompletedTrendCalendar points={[]} />);
    expect(html).toContain('Takvimde gösterilecek gün yok.');
    expect(html).not.toContain('report-calendar-table');
  });

  it('uses captions, column scopes, and SR day text for in-range and out-of-range days', () => {
    const html = renderToStaticMarkup(
      <CompletedTrendCalendar points={[{ date: '2026-07-01', count: 2 }, { date: '2026-07-02', count: 0 }]} />,
    );
    expect(html).toContain('<caption>');
    expect(html).toContain('tamamlanan işler');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Pzt');
    expect(html).toContain('visually-hidden');
    expect(html).toContain('1 Tem 2026: 2 tamamlanan iş');
    expect(html).toContain('2 Tem 2026: 0 tamamlanan iş');
    // Out-of-range days still get explicit SR copy when present in the month grid.
    expect(html).toContain('seçilen aralık dışında');
    expect(html).toContain('is-in-range');
    expect(html).toContain('is-out-of-range');
  });
});

describe('SegmentedDistributionBar contract', () => {
  const segments = [
    { key: 'under2', label: '2 saatten kısa', value: 1 },
    { key: 'between2And8', label: '2–8 saat', value: 2 },
    { key: 'between8And24', label: '8–24 saat', value: 0 },
    { key: 'over24', label: '24 saatten uzun', value: 3 },
  ];

  it('keeps track decorative and exposes label+value legend and total summary', () => {
    const html = renderToStaticMarkup(<SegmentedDistributionBar segments={segments} />);
    expect(html).toContain('report-segmented-track');
    expect(html).toMatch(/report-segmented-track"[^>]*aria-hidden="true"/);
    expect(html).toContain('report-segmented-legend');
    expect(html).toContain('aria-hidden="true"'); // swatches
    expect(html).toContain('2 saatten kısa');
    expect(html).toContain('<strong>1</strong>');
    expect(html).toContain('Toplam 6 kayıt');
    expect(html).toContain('24 saatten uzun 3');
  });

  it('shows explicit empty message when every segment is zero', () => {
    const html = renderToStaticMarkup(
      <SegmentedDistributionBar
        segments={segments.map((segment) => ({ ...segment, value: 0 }))}
      />,
    );
    expect(html).toContain('Dağılımda kayıt yok.');
    expect(html).toContain('report-segmented-empty');
  });
});

describe('IndependentMeterBars contract', () => {
  it('shows visible label and value while keeping the track decorative', () => {
    const html = renderToStaticMarkup(
      <IndependentMeterBars
        items={[
          { key: 'waiting', label: 'Onay bekleyen', value: 3, tone: 'warning' },
          { key: 'overdue', label: 'Geciken', value: 1, tone: 'danger' },
        ]}
      />,
    );
    expect(html).toContain('Onay bekleyen');
    expect(html).toContain('<strong>3</strong>');
    expect(html).toContain('report-meter-track');
    expect(html).toMatch(/report-meter-track"[^>]*aria-hidden="true"/);
  });

  it('handles all-zero values without breaking and empty items with a message', () => {
    const zeros = renderToStaticMarkup(
      <IndependentMeterBars
        items={[
          { key: 'a', label: 'A', value: 0 },
          { key: 'b', label: 'B', value: 0 },
        ]}
      />,
    );
    expect(zeros).toContain('<strong>0</strong>');
    expect(zeros).toContain('width:0%');

    const empty = renderToStaticMarkup(<IndependentMeterBars items={[]} />);
    expect(empty).toContain('Gösterilecek gösterge yok.');
    expect(empty).toContain('data-report-meters-empty="true"');
    expect(empty).not.toContain('<ul');
  });
});
