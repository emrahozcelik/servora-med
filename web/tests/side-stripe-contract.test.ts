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
