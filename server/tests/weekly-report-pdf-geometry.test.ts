import { createRequire } from 'node:module';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { renderWeeklyReportPdf } from '../src/modules/weekly-reports/pdf/renderer.js';
import type { WeeklyReportSubmission } from '../src/modules/weekly-reports/types.js';

import { pdfNotdefRuns, pdfPaintedRuns } from './support/pdf-geometry.js';

const require = createRequire(import.meta.url);

/**
 * Measured-vs-painted geometry regression (WR-PDF-3).
 *
 * The existing "within the page" test compares pdfmake's own line boxes, which
 * carry the width the layout engine *reserved*. It cannot see a defect where
 * the writer paints wider than it reserved — which is exactly the `.notdef`
 * metrics bug. These tests therefore read the produced PDF and compare what is
 * actually painted against what was reserved for it.
 *
 * The declared side comes from pdfmake's layout (the same numbers the page is
 * laid out with); the painted side comes from the PDF content stream. Both are
 * required: either alone can look healthy while the document is broken.
 */

const MISSING = '\u2192';           // → : no Roboto glyph, drawn as .notdef
const BODY_RIGHT_EDGE = 595.28 - 48;

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

type LayoutLine = { x: number; y: number; width: number; height: number; text: string };

/** Layout lines pdfmake produced, with the width it reserved for each. */
async function renderWithLayout(frozen: WeeklyReportSubmission): Promise<{
  buffer: Buffer;
  lines: LayoutLine[];
}> {
  const { default: LayoutBuilder } = require('pdfmake/js/LayoutBuilder.js');
  const spy = vi.spyOn(LayoutBuilder.prototype, 'layoutDocument');
  const buffer = await renderWeeklyReportPdf(
    buildWeeklyReportPdfDocumentModel({ submission: frozen, staffName: 'Ayşe Çağlar' }),
  );
  const pages = spy.mock.results[0]!.value as Array<{
    items: Array<{ type: string; item: {
      x: number; y: number; getWidth(): number; getHeight(): number;
      inlines: { text: string }[];
    } }>;
  }>;
  spy.mockRestore();
  const lines: LayoutLine[] = [];
  for (const page of pages) {
    for (const entry of page.items) {
      if (entry.type !== 'line') continue;
      const text = entry.item.inlines.map((inline) => inline.text).join('');
      lines.push({
        x: entry.item.x, y: entry.item.y,
        width: entry.item.getWidth(), height: entry.item.getHeight(), text,
      });
    }
  }
  return { buffer, lines };
}

describe('Weekly Report PDF — measured vs painted geometry', () => {
  it('paints a missing-glyph cell no wider than the width reserved for it', async () => {
    // A full column of unrenderable characters: the case that painted over the
    // neighbouring "Durum" column before the .notdef metrics were corrected.
    const filler = MISSING.repeat(120);
    const { buffer, lines } = await renderWithLayout(submission({
      sourceWork: [{
        ...submission().sourceWork[0]!,
        title: filler,
        customerName: filler,
      }],
    }));

    // Declared: every layout line made only of missing glyphs.
    const declared = lines.filter(
      (line) => line.text.length > 0 && [...line.text].every((char) => char === MISSING),
    );
    expect(declared.length).toBeGreaterThan(4);

    // Painted: every run made only of .notdef glyphs, in document order.
    const painted = pdfNotdefRuns(buffer).filter((run) => run.notdefGlyphs === run.glyphCount);
    expect(painted.length).toBe(declared.length);

    for (let index = 0; index < declared.length; index += 1) {
      const reserved = declared[index]!;
      const drawn = painted[index]!;
      // Painted advance must match the reserved width; before the fix it was
      // 2.048x larger (e.g. 90pt painted for a 44pt reservation).
      expect(drawn.advancePt).toBeCloseTo(reserved.width, 0);
      expect(drawn.advancePt).toBeLessThanOrEqual(reserved.width + 1);
    }
  });

  it('keeps every painted run inside the printable body area', async () => {
    const filler = MISSING.repeat(200);
    const { buffer } = await renderWithLayout(submission({
      body: { ...submission().body, summary: filler },
      answers: [{ questionKey: 'q1', answer: filler }],
      sourceWork: [{
        ...submission().sourceWork[0]!,
        title: filler,
        customerName: filler,
      }],
    }));

    const runs = pdfPaintedRuns(buffer);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.rightPt, `run at y=${run.y.toFixed(1)}`).toBeLessThanOrEqual(BODY_RIGHT_EDGE + 1);
    }
  });

  it('does not inflate advances for supported Turkish glyphs', async () => {
    // Metrics for rendered glyphs must be untouched by the `.notdef` fix.
    // Conservation check: the total advance pdfmake reserved across every line
    // must equal the total advance actually painted. A correction that also
    // rescaled supported glyphs would break this by the same 2.048x factor.
    const turkish = 'Çağrı ışığı ölçüm şüpheli İĞÜŞÖÇ';
    const { buffer, lines } = await renderWithLayout(submission({
      body: { ...submission().body, summary: turkish, nextWeekPlan: turkish },
      sourceWork: [{ ...submission().sourceWork[0]!, title: turkish, customerName: turkish }],
    }));

    // The Turkish set is fully covered: no missing glyph may be painted here.
    expect(pdfNotdefRuns(buffer)).toHaveLength(0);

    const declaredTotal = lines.reduce((total, line) => total + line.width, 0);
    const paintedTotal = pdfPaintedRuns(buffer).reduce((total, run) => total + run.advancePt, 0);
    // Small divergence is expected and unrelated to metrics: a declared line
    // width trims its leading/trailing spaces while the painted advance still
    // includes them. The regression this guards against is a 2.048x glyph
    // inflation, which would exceed this bound by two orders of magnitude.
    const relativeError = Math.abs(paintedTotal - declaredTotal) / declaredTotal;
    expect(relativeError).toBeLessThan(0.01);
  });
});

afterEach(() => { vi.restoreAllMocks(); });
