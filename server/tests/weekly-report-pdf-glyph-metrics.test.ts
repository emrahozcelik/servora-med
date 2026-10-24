import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { renderWeeklyReportPdf } from '../src/modules/weekly-reports/pdf/renderer.js';
import type { WeeklyReportSubmission } from '../src/modules/weekly-reports/types.js';

import { pdfNotdefRuns, pdfNotdefWidths } from './support/pdf-geometry.js';

const require = createRequire(import.meta.url);

/**
 * `.notdef` metrics regression (WR-PDF-3).
 *
 * pdfmake measures a run with fontkit, but PDFKit writes the CIDFont `/W`
 * array itself. Entry 0 — the `.notdef` glyph used for every code point the
 * embedded font cannot render — was emitted in font units instead of the
 * 1000-unit glyph space that `/W` is defined in, so each missing glyph was
 * painted `unitsPerEm / 1000` times too wide (2048/1000 = 2.048x for Roboto).
 *
 * A table cell holding enough unrenderable characters therefore painted across
 * its right border and over the next column. Existing tests could not see it:
 * they compare `pdfmake`'s own line boxes, which use the *measured* width, not
 * the *painted* one.
 *
 * These tests read the produced PDF bytes, so they fail if either the metrics
 * or the painted geometry regress, regardless of which layer breaks.
 */

const UNSUPPORTED = '\u2192'.repeat(20); // → : no Roboto glyph, becomes .notdef

function submission(overrides: Partial<WeeklyReportSubmission> = {}): WeeklyReportSubmission {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    weeklyReportId: '11111111-1111-4111-8111-111111111111',
    jobCardId: '22222222-2222-4222-8222-222222222222',
    seqNo: 1,
    submittedBy: '33333333-3333-4333-8333-333333333333',
    submittedAt: '2026-10-23T06:15:00.000Z',
    periodStart: '2026-10-19',
    periodEnd: '2026-10-25',
    body: {
      summary: 'Kısa özet.',
      blockers: null,
      nextWeekPlan: 'Kısa plan.',
      highlights: null,
      fieldObservations: null,
      supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Soru?' }],
    answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
    sourceWork: [{
      jobCardId: 'job-1',
      type: 'GENERAL_TASK',
      title: 'Klinik ziyareti',
      customerName: 'Örnek Klinik',
      staffCompletedAt: '2026-10-22T09:00:00.000Z',
      statusAtSnapshot: 'COMPLETED',
    }],
    jobVersion: 7,
    sourceActivityId: 'act-1',
    createdAt: '2026-10-23T06:15:00.000Z',
    ...overrides,
  };
}

async function render(frozen: WeeklyReportSubmission): Promise<Buffer> {
  return renderWeeklyReportPdf(
    buildWeeklyReportPdfDocumentModel({ submission: frozen, staffName: 'Ayşe Çağlar' }),
  );
}

/** The `.notdef` advance the embedded font actually declares, in 1000-unit space. */
function expectedNotdefWidth(): number {
  const fontkit = require('fontkit') as {
    openSync(path: string): {
      unitsPerEm: number;
      getGlyph(id: number): { advanceWidth: number };
    };
  };
  const pdfmakeRoot = dirname(require.resolve('pdfmake/package.json'));
  const font = fontkit.openSync(join(pdfmakeRoot, 'fonts', 'Roboto', 'Roboto-Regular.ttf'));
  return (font.getGlyph(0).advanceWidth / font.unitsPerEm) * 1000;
}

describe('Weekly Report PDF — .notdef glyph metrics', () => {
  it('writes the real .notdef advance into /W instead of the unscaled font-unit value', async () => {
    const buffer = await render(submission());
    const declared = pdfNotdefWidths(buffer);
    const expected = expectedNotdefWidth();

    // Roboto: 908 font units / 2048 unitsPerEm * 1000 = 443.359.
    expect(expected).toBeCloseTo(443.359, 3);
    // Every style font must carry the corrected entry, not just the first one.
    expect(declared.length).toBeGreaterThan(0);
    for (const width of declared) {
      expect(width).toBeCloseTo(expected, 2);
    }
  });

  it('paints each missing glyph at the advance it declared, at both table and body sizes', async () => {
    const buffer = await render(submission({
      body: { ...submission().body, summary: UNSUPPORTED },
      sourceWork: [{
        ...submission().sourceWork[0]!,
        title: UNSUPPORTED,
        customerName: UNSUPPORTED,
      }],
    }));

    const widths = pdfNotdefWidths(buffer);
    expect(widths[0]).toBeCloseTo(expectedNotdefWidth(), 2);
    const notdefRuns = pdfNotdefRuns(buffer);
    expect(notdefRuns.length).toBeGreaterThan(0);

    const sizes = new Set(notdefRuns.map((run) => run.fontSize));
    // The source-work table renders at 9pt, the report body at 10pt.
    expect(sizes.has(9)).toBe(true);
    expect(sizes.has(10)).toBe(true);

    for (const run of notdefRuns) {
      const perGlyph = run.advancePt / run.glyphCount;
      expect(perGlyph).toBeCloseTo((widths[0]! / 1000) * run.fontSize, 3);
    }
  });
});
