import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(sourceRoot).map((path) => ({
  path,
  relative: path.slice(sourceRoot.length + 1),
  // Comments may explain a removed legacy pattern; only shipped code counts.
  text: readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''),
}));

describe('legacy interaction contract (UI audit F-13)', () => {
  it('never blocks the product with native confirm or prompt dialogs', () => {
    const offenders = files
      .filter((file) => /window\.(confirm|prompt)\s*\(/.test(file.text))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  it('does not render the legacy hierarchy-return label', () => {
    // DESIGN.md "Mobile ReturnLink": `Geri`, `İşlere dön`, `Listeye dön` and
    // similar hierarchy labels are not part of the design. The only sanctioned
    // hierarchy return is PageHeader's `‹ {label}` ReturnLink.
    const offenders = files
      .filter((file) => file.text.includes('Listeye dön'))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  it('keeps the optimistic-lock version out of detail screens', () => {
    const offenders = ['CustomerDetail.tsx', 'ProductDetail.tsx']
      .filter((name) => {
        const file = files.find((candidate) => candidate.relative === name);
        return file ? /Sürüm/.test(file.text) : true;
      });
    expect(offenders).toEqual([]);
  });
});
