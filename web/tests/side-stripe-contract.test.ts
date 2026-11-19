import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcRoot = resolve(process.cwd(), 'src');

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const files = cssFiles(srcRoot);

describe('UI audit F-07 side stripes', () => {
  it('finds the stylesheet inventory it claims to guard', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it('never draws a 2–6px one-sided accent border in any stylesheet', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = stripCssComments(readFileSync(file, 'utf8'));
      for (const match of css.matchAll(/border-(?:left|right|inline-start|inline-end):\s*([2-6])px\s+solid[^;]*;/g)) {
        offenders.push(`${file.replace(srcRoot, 'src')}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never fakes a side stripe with a directional inset shadow', () => {
    // A full ring (`inset 0 0 0 2px`) is allowed; a one-axis offset is a stripe.
    const directionalInset = /inset\s+(?:-?[2-6]px\s+0(?:\s|,)|0\s+-?[2-6]px(?:\s|,))/;
    const offenders: string[] = [];
    for (const file of files) {
      const css = stripCssComments(readFileSync(file, 'utf8'));
      for (const match of css.matchAll(/box-shadow:[^;]+;/g)) {
        if (directionalInset.test(match[0])) {
          offenders.push(`${file.replace(srcRoot, 'src')}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects a directional inset-shadow stripe in a sample declaration', () => {
    const directionalInset = /inset\s+(?:-?[2-6]px\s+0(?:\s|,)|0\s+-?[2-6]px(?:\s|,))/;
    expect(directionalInset.test('box-shadow: inset 3px 0 0 var(--accent);')).toBe(true);
    expect(directionalInset.test('box-shadow: inset -4px 0 0 var(--error);')).toBe(true);
    expect(directionalInset.test('box-shadow: inset 0 2px 0 var(--rule);')).toBe(true);
    expect(directionalInset.test('box-shadow: inset 0 0 0 2px var(--accent);')).toBe(false);
    expect(directionalInset.test('box-shadow: 0 8px 24px rgba(30, 37, 43, 0.12);')).toBe(false);
  });
});

describe('UI audit F-07 raw color literals', () => {
  /** Removes the single `:root { … }` token block from styles.css. */
  function withoutRootBlock(css: string): string {
    const cleaned = stripCssComments(css);
    const start = cleaned.indexOf(':root {');
    if (start < 0) return cleaned;
    let depth = 0;
    for (let index = start; index < cleaned.length; index += 1) {
      if (cleaned[index] === '{') depth += 1;
      else if (cleaned[index] === '}') {
        depth -= 1;
        if (depth === 0) return cleaned.slice(0, start) + cleaned.slice(index + 1);
      }
    }
    throw new Error('Unclosed :root block');
  }

  it('keeps feature stylesheets free of one-off color literals', () => {
    const rawColor = /(?:oklch|rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:white|black|gray|grey|orange|yellow|red|green|blue)\b(?=\s*[;,])/g;
    const offenders: string[] = [];
    for (const file of files) {
      const css = withoutRootBlock(readFileSync(file, 'utf8'));
      for (const match of css.matchAll(rawColor)) {
        offenders.push(`${file.replace(srcRoot, 'src')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
