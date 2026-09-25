import { inflateSync } from 'node:zlib';

/**
 * Shared PDF inspection helpers.
 *
 * pdfmake draws text with Identity-H Type0 fonts, so a content stream carries
 * CIDs (glyph ids), not code points. Two levels of recovery are exposed:
 *
 * - {@link pdfCMapText} / {@link pdfObjectText} are cheap structural probes used
 *   to assert what the document declares (font program, action dictionaries) and
 *   which code points any font can map.
 * - {@link pdfDecodedText} is the faithful decode: it resolves each font's own
 *   `/ToUnicode` CMap and walks the page content streams, so it recovers the
 *   strings actually drawn on the pages.
 */

/**
 * The font ToUnicode CMap streams, inflated and concatenated. This is the only
 * place the rendered Unicode code points are recoverable as text, and it is
 * derived exclusively from the glyphs actually used — so a code point that is
 * absent from the CMap was not rendered.
 */
export function pdfCMapText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let out = '';
  for (const part of raw.split('endstream')) {
    const objectIndex = part.lastIndexOf(' obj');
    if (objectIndex === -1) continue;
    const streamIndex = part.indexOf('stream', objectIndex);
    if (streamIndex === -1) continue;
    let start = streamIndex + 'stream'.length;
    while (part[start] === '\r' || part[start] === '\n') start += 1;
    try {
      const inflated = inflateSync(Buffer.from(part.slice(start), 'latin1')).toString('latin1');
      if (inflated.includes('beginbf')) out += inflated;
    } catch { /* not a flate stream */ }
  }
  return out;
}

/** The PDF object dictionaries with every stream body removed. */
export function pdfObjectText(buffer: Buffer): string {
  return buffer.toString('latin1')
    .split('endstream')
    .map((part) => {
      const streamIndex = part.indexOf('stream');
      return streamIndex === -1 ? part : part.slice(0, streamIndex);
    })
    .join('\n');
}

/** Normalized CMap key: hex with no leading zeros, even length, upper-case. */
function normCid(hex: string): string {
  const trimmed = hex.replace(/^0+/, '') || '0';
  return (trimmed.length % 2 ? `0${trimmed}` : trimmed).toUpperCase();
}

/** src-code -> Unicode table built from one CMap stream body. */
function cmapTableFrom(text: string): Map<string, string> {
  const table = new Map<string, string>();
  const hexToText = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      table.set(normCid(pair[1]!), hexToText(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    for (const item of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const low = parseInt(item[1]!, 16);
      let offset = 0;
      for (const value of item[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        table.set(normCid((low + offset).toString(16)), hexToText(value[1]!));
        offset += 1;
      }
    }
    const simple = body.replace(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[[\s\S]*?\]/g, '');
    for (const item of simple.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const low = parseInt(item[1]!, 16);
      const high = parseInt(item[2]!, 16);
      const base = parseInt(item[3]!, 16);
      if (high - low > 65535) continue;
      for (let i = 0; i <= high - low; i += 1) {
        table.set(normCid((low + i).toString(16)), String.fromCodePoint(base + i));
      }
    }
  }
  return table;
}

/**
 * Full object-graph text recovery: the text actually drawn on the pages.
 *
 * pdfmake emits one Identity-H Type0 font per text style (F1, F2, …) and each
 * carries its OWN `/ToUnicode` CMap, so CIDs must be resolved per font. The
 * document is walked object by object: page dict -> `/Resources` (usually an
 * indirect reference) -> `/Font` -> font `/ToUnicode`, then the page content
 * stream is scanned tracking the active `/Fn … Tf`.
 *
 * Runs are concatenated with no separator on purpose: pdfmake splits a run at
 * style/word-wrap boundaries and the space glyph is drawn inside a run, so
 * inserting a separator per text object would corrupt the recovered words.
 */
export function pdfDecodedText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const objects = new Map<string, { dict: string; text: string | null }>();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    const body = match[2]!;
    const streamAt = body.indexOf('stream');
    let text: string | null = null;
    if (streamAt !== -1) {
      let start = streamAt + 'stream'.length;
      while (body[start] === '\r' || body[start] === '\n') start += 1;
      const end = body.lastIndexOf('endstream');
      try {
        const data = body.slice(start, end === -1 ? undefined : end);
        text = inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
      } catch { text = null; }
    }
    objects.set(match[1]!, { dict: streamAt === -1 ? body : body.slice(0, streamAt), text });
  }

  const cidTable = (fontObjectNumber: string): Map<string, string> | null => {
    const font = objects.get(fontObjectNumber);
    if (!font) return null;
    const ref = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict);
    if (!ref) return null;
    const cmap = objects.get(ref[1]!);
    if (!cmap || cmap.text === null) return null;
    return cmapTableFrom(cmap.text);
  };

  let out = '';
  for (const [, object] of objects) {
    if (!/\/Type\s*\/Page[^s]/.test(object.dict)) continue;
    let resources = object.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(object.dict);
    if (resRef && objects.get(resRef[1]!)) resources = objects.get(resRef[1]!)!.dict;
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources);
    const byName = new Map<string, Map<string, string>>();
    if (fontDict) {
      for (const font of fontDict[1]!.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) {
        const table = cidTable(font[2]!);
        if (table) byName.set(font[1]!, table);
      }
    }
    const contentRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(object.dict);
    const content = contentRef ? objects.get(contentRef[1]!)?.text : null;
    if (!content) continue;
    let current: Map<string, string> | null = null;
    for (const token of content.matchAll(/\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>/g)) {
      if (token[1]) { current = byName.get(token[1]!) ?? null; continue; }
      const table = current ?? [...byName.values()][0];
      if (!table) continue;
      const digits = token[2]!;
      for (let i = 0; i + 4 <= digits.length; i += 4) {
        out += table.get(normCid(digits.slice(i, i + 4))) ?? '';
      }
    }
    out += '\n';
  }
  return out;
}
