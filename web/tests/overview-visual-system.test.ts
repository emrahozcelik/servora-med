import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8')
  // Comments may legitimately contain selector-like text; keep matching on rules only.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every rule whose selector list contains the exact selector. */
function rulesFor(selector: string): string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css))) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies;
}

function rootBlock(): string {
  const start = css.indexOf(':root');
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

describe('overview visual system contract (UX audit slice 1)', () => {
  it('uses the canonical raised radius token on overview sections (VIS-04)', () => {
    const rules = rulesFor('.overview-section');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      if (body.includes('border-radius:')) {
        expect(body).toContain('border-radius: var(--radius-raised)');
      }
    }
    // Historical bug coverage is semantic: the scoped assertion above pins the
    // canonical token, and the "radius family hygiene" test below fails on any
    // referenced-but-undefined radius token (which is exactly what the old
    // undefined var(--radius-card) was). No global literal ban is kept, so a
    // future legitimately-defined --radius-card token would not false-fail.
  });

  it('defines every referenced radius token in :root (radius family hygiene)', () => {
    const defined = new Set(
      [...rootBlock().matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => `--${m[1]}`),
    );
    const used = [
      ...new Set([...css.matchAll(/var\((--radius-[a-zA-Z0-9-]+)/g)].map((m) => m[1])),
    ];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(defined.has(token)).toBe(true);
    }
  });

  it('keeps trend bar geometry on the structural base class, not the consumer class (VIS-01)', () => {
    // Container geometry: flex row with a fixed chart height.
    const base = rulesFor('.report-trend-bars');
    expect(base.some((body) => /display:\s*flex/.test(body) && /height:\s*6\.5rem/.test(body))).toBe(true);
    // Bar geometry scales with the --ratio custom property.
    const spans = rulesFor('.report-trend-bars span');
    expect(spans.some((body) => /height:/.test(body) && body.includes('--ratio'))).toBe(true);
    // The consumer class is a spacing hook only: re-declaring geometry here is
    // the symptom-patch anti-pattern that hid the broken chart.
    for (const body of rulesFor('.overview-trend')) {
      expect(body).not.toMatch(/(^|[^-])(height|background|display)\s*:/);
    }
  });

  it('gives semantic metric tones a full radius-following outline, not a left-only stripe (VIS-02)', () => {
    const base = rulesFor('.servora-metric-statistic');
    expect(base.some((body) => body.includes('border-radius: var(--radius-raised)'))).toBe(true);

    const expectations: Array<[string, string]> = [
      ['.servora-metric-statistic--attention', 'border: 1px solid var(--warning)'],
      ['.servora-metric-statistic--warning', 'border: 1px solid var(--warning)'],
      ['.servora-metric-statistic--success', 'border: 1px solid var(--success)'],
    ];
    for (const [selector, border] of expectations) {
      const rules = rulesFor(selector);
      expect(rules.length).toBeGreaterThan(0);
      for (const body of rules) {
        // A left-only border on a rounded, otherwise borderless card renders as
        // a detached curved fragment; the outline must follow the full radius.
        expect(body).not.toMatch(/border-left:/);
      }
      expect(rules.some((body) => body.includes(border))).toBe(true);
    }
  });
});
