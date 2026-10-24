import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { renderWeeklyReportPdf } from '../src/modules/weekly-reports/pdf/renderer.js';
import type { WeeklyReportSubmission } from '../src/modules/weekly-reports/types.js';

import { pdfPaintedRuns } from './support/pdf-geometry.js';

const require = createRequire(import.meta.url);

/**
 * Source-work table width regression (WR-PDF-3, K2 protection).
 *
 * The deployed pre-WR-02 renderer sized the table with `auto` columns and let a
 * single long unbroken token push the table past the page edge (measured: any
 * title or customer name of 24+ uninterrupted characters, reaching +1443pt at
 * the 255-character column limit). WR-02 replaced that with fixed shares:
 *
 *     widths: [164.28, 65, 80, 65, 85]
 *
 * These tests pin the fixed-width behaviour so an `auto` column cannot come
 * back. They pass on current `main` by design — this is protection, not a new
 * behaviour — and the old renderer's failure is recorded in the WR-PDF-3
 * evidence bundle (`k2-production-vs-main.json`).
 */

const BODY_LEFT = 48;
const BODY_RIGHT = 595.28 - 48;

function submission(sourceWork: WeeklyReportSubmission['sourceWork']): WeeklyReportSubmission {
  return {
    id: 'sub-1', organizationId: 'org-1',
    weeklyReportId: '11111111-1111-4111-8111-111111111111',
    jobCardId: '22222222-2222-4222-8222-222222222222',
    seqNo: 1, submittedBy: '33333333-3333-4333-8333-333333333333',
    submittedAt: '2026-10-23T06:15:00.000Z',
    periodStart: '2026-10-19', periodEnd: '2026-10-25',
    body: {
      summary: 'Kısa özet.', blockers: null, nextWeekPlan: 'Kısa plan.',
      highlights: null, fieldObservations: null, supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Soru?' }],
    answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
    sourceWork,
    jobVersion: 7, sourceActivityId: 'act-1', createdAt: '2026-10-23T06:15:00.000Z',
  };
}

function rows(count: number, title: (index: number) => string): WeeklyReportSubmission['sourceWork'] {
  return Array.from({ length: count }, (_, index) => ({
    jobCardId: `job-${index + 1}`,
    type: (index % 2 === 0 ? 'GENERAL_TASK' : 'PRODUCT_DELIVERY') as
      'GENERAL_TASK' | 'PRODUCT_DELIVERY',
    title: title(index),
    customerName: index % 3 === 0 ? null : `Örnek Klinik ${index + 1}`,
    staffCompletedAt: new Date(Date.UTC(2026, 9, 20 + (index % 5), 9, 15)).toISOString(),
    statusAtSnapshot: (index % 3 === 0 ? 'WAITING_APPROVAL' : 'COMPLETED') as
      'COMPLETED' | 'WAITING_APPROVAL',
  }));
}

function pageCount(buffer: Buffer): number {
  const raw = buffer.toString('latin1');
  const match = /\/Count (\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

describe('Weekly Report PDF — source-work table width protection', () => {
  it.each([24, 30, 60, 120, 255])(
    'keeps a %i-character unbroken title inside the printable body',
    async (length) => {
      const token = 'S'.repeat(length);
      const buffer = await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
        submission: submission(rows(1, () => token)),
        staffName: 'Ayşe Çağlar',
      }));

      for (const run of pdfPaintedRuns(buffer)) {
        expect(run.x).toBeGreaterThanOrEqual(BODY_LEFT - 1);
        expect(run.rightPt, `token length ${length}`).toBeLessThanOrEqual(BODY_RIGHT + 1);
      }
    },
  );

  it('keeps a 255-character unbroken customer name inside the printable body', async () => {
    const buffer = await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
      submission: submission([{
        ...rows(1, () => 'Klinik ziyareti')[0]!,
        customerName: 'C'.repeat(255),
      }]),
      staffName: 'Ayşe Çağlar',
    }));

    for (const run of pdfPaintedRuns(buffer)) {
      expect(run.rightPt).toBeLessThanOrEqual(BODY_RIGHT + 1);
    }
  });

  it('repeats the table header and stays in bounds across 20 multipage rows', async () => {
    const buffer = await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
      submission: submission(rows(20, (index) => `${index + 1}. Klinik ziyareti ve ürün tanıtımı`)),
      staffName: 'Ayşe Çağlar',
    }));

    expect(pageCount(buffer)).toBeGreaterThan(1);

    const { default: LayoutBuilder } = require('pdfmake/js/LayoutBuilder.js');
    const spy = vi.spyOn(LayoutBuilder.prototype, 'layoutDocument');
    await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
      submission: submission(rows(20, (index) => `${index + 1}. Klinik ziyareti ve ürün tanıtımı`)),
      staffName: 'Ayşe Çağlar',
    }));
    const pages = spy.mock.results[0]!.value as Array<{
      items: Array<{ type: string; item: { inlines: { text: string }[] } }>;
    }>;

    // A repeated header on every table page is what keeps a split row readable.
    let headerPages = 0;
    for (const page of pages) {
      const texts = page.items
        .filter((entry) => entry.type === 'line')
        .map((entry) => entry.item.inlines.map((inline) => inline.text).join(''));
      if (texts.includes('Başlık')) headerPages += 1;
    }
    expect(headerPages).toBeGreaterThan(1);

    for (const run of pdfPaintedRuns(buffer)) {
      expect(run.rightPt).toBeLessThanOrEqual(BODY_RIGHT + 1);
    }
  });
});

/**
 * Header geometry guard: five distinct columns that share the body width.
 *
 * The pre-WR-02 defect let `auto` columns expand with their content, which
 * squeezed the other columns and pushed the table past the page edge. Fixed
 * shares keep the five header labels at stable, distinct positions regardless
 * of how long the cell content is.
 */
describe('Weekly Report PDF — five stable columns', () => {
  const HEADERS = ['Başlık', 'Tür', 'Müşteri', 'Durum', 'Tamamlanma'];

  async function headerPositions(title: string): Promise<number[]> {
    const { default: LayoutBuilder } = require('pdfmake/js/LayoutBuilder.js');
    const spy = vi.spyOn(LayoutBuilder.prototype, 'layoutDocument');
    await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
      submission: submission(rows(2, () => title)),
      staffName: 'Ayşe Çağlar',
    }));
    const pages = spy.mock.results[0]!.value as Array<{
      items: Array<{ type: string; item: { x: number; inlines: { text: string }[] } }>;
    }>;
    const positions = new Map<string, number>();
    for (const page of pages) {
      for (const entry of page.items) {
        if (entry.type !== 'line') continue;
        const text = entry.item.inlines.map((inline) => inline.text).join('').trim();
        if (HEADERS.includes(text) && !positions.has(text)) positions.set(text, entry.item.x);
      }
    }
    spy.mockRestore();
    return HEADERS.map((header) => positions.get(header)!);
  }

  it('keeps the five column positions identical for short and 200-character content', async () => {
    const short = await headerPositions('Klinik');
    const long = await headerPositions('K'.repeat(200));

    expect(short.every((x) => typeof x === 'number')).toBe(true);
    // Fixed shares: a wide cell cannot move the other columns.
    expect(long).toEqual(short);
    // Strictly increasing, and inside the printable body.
    for (let index = 1; index < short.length; index += 1) {
      expect(short[index]!).toBeGreaterThan(short[index - 1]!);
    }
    expect(short[0]!).toBeGreaterThanOrEqual(BODY_LEFT - 1);
    expect(short[short.length - 1]!).toBeLessThanOrEqual(BODY_RIGHT);
  });
});

afterEach(() => { vi.restoreAllMocks(); });
