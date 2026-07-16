import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TrendBars, trendDensityClass } from '../src/reports/report-charts';

function points(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    count: index % 3,
  }));
}

describe('trend density', () => {
  it('classifies 1/7/30/61/121/366 point ranges', () => {
    expect(trendDensityClass(1)).toBe('density-normal');
    expect(trendDensityClass(7)).toBe('density-normal');
    expect(trendDensityClass(30)).toBe('density-normal');
    expect(trendDensityClass(60)).toBe('density-normal');
    expect(trendDensityClass(61)).toBe('density-compact');
    expect(trendDensityClass(120)).toBe('density-compact');
    expect(trendDensityClass(121)).toBe('density-dense');
    expect(trendDensityClass(366)).toBe('density-dense');
  });

  it('emits density attributes for reflow-safe long ranges', () => {
    const html = renderToStaticMarkup(<TrendBars points={points(366)} />);
    expect(html).toContain('data-density="density-dense"');
    expect(html).toContain('data-point-count="366"');
    expect(html).toContain('report-trend-bars--density-dense');
  });
});
