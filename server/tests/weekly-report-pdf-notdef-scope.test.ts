import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { correctNotdefWidths } from '../src/modules/weekly-reports/pdf/notdef-widths.js';
import { renderWeeklyReportPdf } from '../src/modules/weekly-reports/pdf/renderer.js';
import type { WeeklyReportSubmission } from '../src/modules/weekly-reports/types.js';

import { pdfNotdefWidths, pdfPaintedRuns } from './support/pdf-geometry.js';

function submission(overrides: Partial<WeeklyReportSubmission> = {}): WeeklyReportSubmission {
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
    sourceWork: [{
      jobCardId: 'job-1', type: 'GENERAL_TASK', title: 'Klinik ziyareti',
      customerName: 'Örnek Klinik', staffCompletedAt: '2026-10-22T09:00:00.000Z',
      statusAtSnapshot: 'COMPLETED',
    }],
    jobVersion: 7, sourceActivityId: 'act-1', createdAt: '2026-10-23T06:15:00.000Z',
    ...overrides,
  };
}

/**
 * Metrics isolation (WR-PDF-3).
 *
 * The `.notdef` correction must be surgical: entry 0 of each embedded font's
 * `/W` array, and nothing else. Advances for supported glyphs carry normal
 * typography (Turkish included) and must stay exactly as the font defines them.
 */

describe('correctNotdefWidths — surgical scope', () => {
  function fakeDocument() {
    return {
      fontCache: {
        Roboto: {
          normal: {
            font: {
              unitsPerEm: 2048,
              getGlyph: (id: number) => ({ advanceWidth: id === 0 ? 908 : 1111 }),
            },
            scale: 1000 / 2048,
            widths: [908, 500, 611.5, 999],
          },
        },
      },
    };
  }

  it('rewrites only the .notdef entry and leaves every other advance untouched', () => {
    const document = fakeDocument();
    const corrected = correctNotdefWidths(document);

    expect(corrected).toBe(1);
    expect(document.fontCache.Roboto.normal.widths[0]).toBeCloseTo(443.359, 3);
    // Supported glyph advances are byte-identical to before the correction.
    expect(document.fontCache.Roboto.normal.widths.slice(1)).toEqual([500, 611.5, 999]);
  });

  it('is idempotent: a second pass changes nothing', () => {
    const document = fakeDocument();
    correctNotdefWidths(document);
    const after = [...document.fontCache.Roboto.normal.widths];
    expect(correctNotdefWidths(document)).toBe(0);
    expect(document.fontCache.Roboto.normal.widths).toEqual(after);
  });

  it('fails loudly when the pdfkit font shape is not the one it was written for', () => {
    const document = { fontCache: { Roboto: { normal: { widths: [1] } } } };
    expect(() => correctNotdefWidths(document as never)).toThrow(/unsupported pdfkit font shape/);
    expect(() => correctNotdefWidths({ fontCache: {} })).toThrow(/no embedded fonts found/);
  });
});

describe('Weekly Report PDF — supported typography is unchanged', () => {
  it('renders a Turkish-only report without any .notdef glyph', async () => {
    const turkish = 'Çağrı ışığı ölçüm şüpheli İĞÜŞÖÇ';
    const buffer = await renderWeeklyReportPdf(buildWeeklyReportPdfDocumentModel({
      submission: submission({
        body: { ...submission().body, summary: turkish, nextWeekPlan: turkish },
        sourceWork: [{ ...submission().sourceWork[0]!, title: turkish, customerName: turkish }],
      }),
      staffName: 'Ayşe Çağlar',
    }));

    // The correction must not invent missing glyphs for text Roboto covers.
    const widths = pdfNotdefWidths(buffer);
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect(width).toBeCloseTo(443.359, 2);

    const runs = pdfPaintedRuns(buffer);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((run) => run.notdefGlyphs > 0)).toBe(false);
  });
});

afterEach(() => { vi.restoreAllMocks(); });
