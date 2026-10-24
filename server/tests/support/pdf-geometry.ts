import { inflateSync } from 'node:zlib';

/**
 * Geometry-level PDF inspection helpers.
 *
 * `pdf-text.ts` answers "which characters are in the document". These helpers
 * answer a different question: "how wide is each character actually PAINTED".
 * That distinction is what makes the `.notdef` metrics defect visible — the
 * layout engine reserves the correct advance while the writer paints a
 * different one, so text-only assertions stay green while the page is visibly
 * broken.
 *
 * pdfmake emits one Identity-H Type0 font per text style (`/F1` normal, `/F2`
 * bold, …), each with its OWN `/W` array, so widths must be resolved per font
 * resource rather than from a single global table.
 */

type PdfObject = { dict: string; text: string | null };

function readObjects(buffer: Buffer): Map<string, PdfObject> {
  const raw = buffer.toString('latin1');
  const objects = new Map<string, PdfObject>();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    const body = match[2]!;
    const streamAt = body.indexOf('stream');
    let text: string | null = null;
    if (streamAt !== -1) {
      let start = streamAt + 'stream'.length;
      while (body[start] === '\r' || body[start] === '\n') start += 1;
      const end = body.lastIndexOf('endstream');
      try {
        text = inflateSync(Buffer.from(body.slice(start, end === -1 ? undefined : end), 'latin1'))
          .toString('latin1');
      } catch { text = null; }
    }
    objects.set(match[1]!, { dict: streamAt === -1 ? body : body.slice(0, streamAt), text });
  }
  return objects;
}

function parseWidthArray(dict: string): { widths: number[]; defaultWidth: number } | null {
  const defaultWidth = /\/DW\s+([\d.]+)/.exec(dict);
  const match = /\/W\s*\[\s*0\s*\[([^\]]*)\]/.exec(dict);
  if (!match) return null;
  const widths = match[1]!.trim().split(/\s+/).filter(Boolean).map(Number);
  return { widths, defaultWidth: defaultWidth ? Number(defaultWidth[1]) : 1000 };
}

export type PdfFont = { resourceName: string; widths: number[]; defaultWidth: number };

/** Font resource name (`F1`) -> its CID widths, resolved through `/DescendantFonts`. */
export function pdfFonts(buffer: Buffer): Map<string, PdfFont> {
  const objects = readObjects(buffer);
  const byObject = new Map<string, { widths: number[]; defaultWidth: number }>();

  for (const [id, object] of objects) {
    if (!/\/Subtype\s*\/Type0/.test(object.dict)) continue;
    const descendant = /\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(object.dict);
    if (!descendant) continue;
    const cid = objects.get(descendant[1]!);
    if (!cid) continue;
    const parsed = parseWidthArray(cid.dict);
    if (parsed) byObject.set(id, parsed);
  }

  const fonts = new Map<string, PdfFont>();
  for (const object of objects.values()) {
    for (const block of object.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const entry of block[1]!.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
        const parsed = byObject.get(entry[2]!);
        if (parsed) {
          fonts.set(entry[1]!, { resourceName: entry[1]!, ...parsed });
        }
      }
    }
  }
  if (fonts.size === 0) throw new Error('no Type0 font resources found in PDF');
  return fonts;
}

export type PaintedRun = {
  font: string;
  /** Text matrix x translation, in points from the page's left edge. */
  x: number;
  y: number;
  fontSize: number;
  glyphCount: number;
  /** Glyph id 0 is `.notdef`: the font has no glyph for the shown code point. */
  notdefGlyphs: number;
  /** Sum of the `/W` advances for this run, in points. */
  advancePt: number;
  rightPt: number;
};

const BT_BLOCK = /BT([\s\S]*?)ET/g;
const TEXT_MATRIX = /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+Tm/;
const FONT_SELECT = /\/(F\d+)\s+([\d.]+)\s+Tf/g;
const SHOWN_TEXT = /<([0-9A-Fa-f]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
const HEX_STRING = /<([0-9A-Fa-f]+)>/g;

function contentStreams(buffer: Buffer): string[] {
  const objects = readObjects(buffer);
  const streams: string[] = [];
  for (const object of objects.values()) {
    if (object.text !== null && /\bBT\b/.test(object.text)) streams.push(object.text);
  }
  return streams;
}

/** Every text run painted in the document, with its exact advance. */
export function pdfPaintedRuns(buffer: Buffer): PaintedRun[] {
  const fonts = pdfFonts(buffer);
  const runs: PaintedRun[] = [];
  for (const stream of contentStreams(buffer)) {
    for (const block of stream.matchAll(BT_BLOCK)) {
      const body = block[1]!;
      const matrix = TEXT_MATRIX.exec(body);
      const fontSelect = FONT_SELECT.exec(body);
      if (!matrix || !fontSelect) continue;
      TEXT_MATRIX.lastIndex = 0;
      FONT_SELECT.lastIndex = 0;
      const font = fonts.get(fontSelect[1]!);
      if (!font) throw new Error(`font resource ${fontSelect[1]} unresolved`);
      const x = Number(matrix[5]);
      const y = Number(matrix[6]);
      const fontSize = Number(fontSelect[2]);
      for (const shown of body.matchAll(SHOWN_TEXT)) {
        const payload = shown[1] ?? shown[2] ?? '';
        const glyphIds: number[] = [];
        for (const hex of payload.matchAll(HEX_STRING)) {
          const text = hex[1]!;
          for (let i = 0; i + 4 <= text.length; i += 4) {
            glyphIds.push(parseInt(text.slice(i, i + 4), 16));
          }
        }
        if (glyphIds.length === 0) continue;
        const advancePt = glyphIds.reduce(
          (total, id) => total + ((font.widths[id] ?? font.defaultWidth) / 1000) * fontSize,
          0,
        );
        runs.push({
          font: font.resourceName,
          x, y, fontSize,
          glyphCount: glyphIds.length,
          notdefGlyphs: glyphIds.filter((id) => id === 0).length,
          advancePt,
          rightPt: x + advancePt,
        });
      }
    }
  }
  return runs;
}

/** Runs that paint at least one `.notdef` glyph. */
export function pdfNotdefRuns(buffer: Buffer): PaintedRun[] {
  return pdfPaintedRuns(buffer).filter((run) => run.notdefGlyphs > 0);
}

/** The `.notdef` advance every font declares for id 0, in 1000-unit glyph space. */
export function pdfNotdefWidths(buffer: Buffer): number[] {
  return [...pdfFonts(buffer).values()].map((font) => font.widths[0]!);
}

/** Advance of one `.notdef` glyph at the given font size, in points. */
export function pdfNotdefAdvancePt(buffer: Buffer, fontSize: number): number {
  const widths = pdfNotdefWidths(buffer);
  return (widths[0]! / 1000) * fontSize;
}
