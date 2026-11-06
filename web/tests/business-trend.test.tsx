/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessTrend, BusinessTrendView } from '../src/reports/BusinessTrend';
import { getBusinessTrendReport, parseBusinessTrendReport } from '../src/reports/reports-api';
import type { BusinessTrendReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (original) => ({
  ...await original<typeof import('../src/reports/reports-api')>(), getBusinessTrendReport: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const report: BusinessTrendReportResponse = {
  range: { from: '2026-10-01', to: '2026-10-03', timezone: 'Europe/Istanbul' },
  asOf: '2026-10-03T09:00:00Z', observedThrough: '2026-10-03', partialDay: true,
  totals: { visits: 3, followUps: 1, sales: 1 },
  points: [{ date: '2026-10-01', visits: 2, followUps: 0, sales: 1 }, { date: '2026-10-02', visits: 1, followUps: 1, sales: 0 }, { date: '2026-10-03', visits: 0, followUps: 0, sales: 0 }],
  comparison: { range: { from: '2026-09-28', to: '2026-09-30', timezone: 'Europe/Istanbul' }, totals: { visits: 4, followUps: 0, sales: 1 } },
  relationships: { visitsWithFollowUp: 1, visitsWithSale: 1, followUpsWithSale: 0 },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (node: React.ReactNode) => { await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>)); };

describe('Business trend', () => {
  it('shows independent counts, explicit deltas, a daily table and partial-day/relationship scope', async () => {
    await render(<BusinessTrendView report={report} />);
    expect(container.querySelectorAll('.business-trend-line')).toHaveLength(3);
    expect(container.textContent).toContain('1 azalış');
    expect(container.textContent).toContain('1 artış');
    expect(container.textContent).toContain('Değişim yok');
    expect(container.textContent).toContain('Bugün henüz tamamlanmadı');
    expect(container.textContent).toContain('Takip ziyaretleri, toplam ziyaretlerin içindedir');
    expect(container.textContent).toContain('Dönem sonrasındaki bağlantılar');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelector('input[type="range"]')?.getAttribute('aria-valuetext')).toContain('3 Eki');
    expect(container.querySelector('.business-trend-report-link')?.getAttribute('href')).toContain('from=2026-10-01');
    expect(container.textContent).not.toMatch(/NaN|Infinity|%|puan|başarı oranı/);
  });

  it('keeps the chart when a synthetic click has no layout width', async () => {
    await render(<BusinessTrendView report={report} />);
    const plot = container.querySelector<SVGSVGElement>('.business-trend-plot')!;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 260, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await act(async () => { plot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120 })); });
    expect(container.querySelector('.business-trend-plot')).not.toBeNull();
    expect(container.textContent).not.toContain('henüz başlamadı');
    expect(container.querySelector('input[type="range"]')?.getAttribute('aria-valuetext')).toContain('3 Eki');
  });

  it('distinguishes zero approved records from a future range', async () => {
    await render(<BusinessTrendView report={{ ...report, totals: { visits: 0, followUps: 0, sales: 0 }, comparison: null }} />);
    expect(container.textContent).toContain('onaylı ziyaret veya satış kaydı bulunmuyor');
    await render(<BusinessTrendView report={{ ...report, points: [], observedThrough: null, comparison: null, partialDay: false }} />);
    expect(container.textContent).toContain('Seçilen dönem henüz başlamadı');
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it('keeps the selected range authoritative when an earlier request resolves last', async () => {
    let resolveOld!: (value: BusinessTrendReportResponse) => void;
    vi.mocked(getBusinessTrendReport).mockReturnValueOnce(new Promise((r) => { resolveOld = r; })).mockResolvedValueOnce(report);
    await render(<BusinessTrend range={{ from: '2026-09-01', to: '2026-09-30' }} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await render(<BusinessTrend range={report.range} />);
    await act(async () => resolveOld({ ...report, totals: { visits: 999, followUps: 0, sales: 0 } }));
    expect(container.textContent).not.toContain('999');
    expect(container.querySelector('.business-trend-totals dd strong')?.textContent).toBe('3');
  });

  it('recovers from a local error without replacing the rest of the report', async () => {
    vi.mocked(getBusinessTrendReport).mockRejectedValueOnce(new Error('Bağlantı kesildi')).mockResolvedValueOnce(report);
    await render(<BusinessTrend range={report.range} />);
    expect(container.textContent).toContain('Bağlantı kesildi');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('.business-trend-plot')).not.toBeNull();
  });

  it('rejects malformed counts and preserves the server response contract', () => {
    expect(parseBusinessTrendReport(report)).toEqual(report);
    expect(() => parseBusinessTrendReport({ ...report, totals: { visits: 1, followUps: 2, sales: 0 } })).toThrow();
    expect(() => parseBusinessTrendReport({ ...report, totals: { visits: -1, followUps: 0, sales: 0 } })).toThrow();
    expect(() => parseBusinessTrendReport({ ...report, healthScore: 100 })).toThrow();
  });
});
