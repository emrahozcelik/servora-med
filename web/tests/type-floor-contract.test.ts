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

describe('UI audit F-11 readable type floor', () => {
  it('finds the stylesheet inventory it claims to guard', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it('never declares absolute text below 0.75rem (12px)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = stripCssComments(readFileSync(file, 'utf8'));
      for (const match of css.matchAll(/font-size:\s*([\d.]+)(rem|px)\b/g)) {
        const value = Number.parseFloat(match[1]!);
        const pixels = match[2] === 'rem' ? value * 16 : value;
        if (pixels < 12 - 0.01) offenders.push(`${file.replace(srcRoot, 'src')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not declare relative (em/%) font sizes that bypass the floor', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = stripCssComments(readFileSync(file, 'utf8'));
      for (const match of css.matchAll(/font-size:\s*[\d.]+(?:em|%)\b/g)) {
        offenders.push(`${file.replace(srcRoot, 'src')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
