import type { PdfMakeCreatedDocument } from 'pdfmake';

/**
 * Corrects the `.notdef` width that PDFKit writes into the CIDFont `/W` array.
 *
 * ## The defect
 *
 * Every code point the embedded font cannot render is drawn as glyph id 0
 * (`.notdef`, the empty box). PDFKit builds the width array for an embedded
 * font like this (pdfkit 0.19.1 `EmbeddedFont`, unchanged in 0.20.2):
 *
 * ```js
 * this.widths = [this.font.getGlyph(0).advanceWidth];   // font units
 * this.widths[gid] = glyph.advanceWidth * this.scale;   // 1000-unit glyph space
 * ```
 *
 * The `/W` array is defined in 1000-unit glyph space, and `this.scale` is
 * `1000 / unitsPerEm`. So every entry except index 0 is scaled correctly, and
 * index 0 is emitted in raw font units. For Roboto (`unitsPerEm` 2048,
 * `.notdef` advance 908) the file therefore declares **908** where the true
 * advance is **443.359** — a 2.048x inflation.
 *
 * pdfmake measures text with fontkit, so it reserves 0.4434 em per missing
 * glyph, while the viewer advances 0.908 em. A table cell holding enough
 * missing glyphs paints past its right border and over the next column, which
 * is exactly the "text overlaps" report this fix answers.
 *
 * ## Why a runtime correction instead of a patched dependency
 *
 * No published pdfkit release contains the one-line fix, and the release
 * artifact is built with `npm ci --omit=dev`, so any `node_modules` patch
 * applied at install time would be discarded. Correcting the value on the font
 * instance for this render keeps `node_modules` pristine, works in every
 * install mode, and touches nothing outside the document being produced.
 *
 * The corrected value is the same expression PDFKit's own constructor uses for
 * every other glyph id, so this restores the writer's intended metric rather
 * than inventing a new one.
 *
 * ## Scope
 *
 * Only entry 0 is written, and only when it is currently unscaled. Advances for
 * supported glyphs are never touched, so Turkish text and normal typography
 * keep their existing metrics. This does **not** add glyph coverage: scripts
 * Roboto lacks still render as `.notdef` boxes — they are simply drawn at the
 * width that was reserved for them instead of nearly twice that width.
 */

/** Structural view of the PDFKit `EmbeddedFont` fields this correction needs. */
type EmbeddedFontMetrics = {
  font: { unitsPerEm: number; getGlyph(id: number): { advanceWidth: number } };
  scale: number;
  widths: number[];
};

/** Structural view of pdfmake's `PDFDocument.fontCache`. */
type FontCache = Record<string, Record<string, EmbeddedFontMetrics>>;

type PdfDocumentWithFonts = { fontCache?: FontCache };

function assertEmbeddedFont(
  family: string,
  style: string,
  font: unknown,
): EmbeddedFontMetrics {
  const candidate = font as Partial<EmbeddedFontMetrics> | null;
  if (
    !candidate
    || typeof candidate.scale !== 'number'
    || !Array.isArray(candidate.widths)
    || typeof candidate.font?.getGlyph !== 'function'
    || typeof candidate.font?.unitsPerEm !== 'number'
  ) {
    throw new Error(
      `Weekly report PDF: unsupported pdfkit font shape for ${family}/${style}; `
      + 'the .notdef width correction cannot be applied safely.',
    );
  }
  return candidate as EmbeddedFontMetrics;
}

/**
 * Rewrite `/W[0]` for every embedded font of an in-progress document.
 *
 * Must run after layout (fonts are created lazily while measuring) and before
 * the document is ended (that is when `/W` is serialised).
 */
export function correctNotdefWidths(document: PdfDocumentWithFonts): number {
  const families = Object.keys(document.fontCache ?? {});
  if (families.length === 0) {
    throw new Error(
      'Weekly report PDF: no embedded fonts found; the .notdef width correction '
      + 'cannot be applied safely.',
    );
  }
  let corrected = 0;
  for (const family of families) {
    for (const [style, rawFont] of Object.entries(document.fontCache![family] ?? {})) {
      const font = assertEmbeddedFont(family, style, rawFont);
      const scaled = font.font.getGlyph(0).advanceWidth * font.scale;
      if (font.widths[0] !== scaled) {
        font.widths[0] = scaled;
        corrected += 1;
      }
    }
  }
  return corrected;
}

/**
 * Produce the PDF bytes for a created pdfmake document, with `.notdef` metrics
 * corrected.
 *
 * `getStream()` resolves after layout and text encoding have run, so every font
 * is present and every glyph id is already registered; `getBuffer()` then ends
 * the document and serialises `/W` with the corrected entry.
 */
export async function getCorrectedBuffer(document: PdfMakeCreatedDocument): Promise<Buffer> {
  const pdfDocument = (await document.getStream()) as PdfDocumentWithFonts;
  correctNotdefWidths(pdfDocument);
  return document.getBuffer();
}
