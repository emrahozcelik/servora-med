import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Owner spacing audit (2026-11-25, 390×844 rendered review).
 *
 * These are source contracts for the mobile spacing fixes: the rules must give
 * adjacent surfaces >= 8px and adjacent controls >= 8px, and the narrow
 * customer-report filter layout must not be able to clip its date inputs.
 */
const raw = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first rule whose selector is exactly `selector` at a line start. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`CSS rule not found: ${selector}`);
  return match[1] ?? '';
}

/** Full text (braces included) of the block opened at `start`. */
function bracedBlock(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`Unbalanced CSS block at index ${start}`);
}

/** Every at-rule block that opens with `marker`. */
function blocksWith(marker: string): string[] {
  const blocks: string[] = [];
  let index = css.indexOf(marker);
  while (index >= 0) {
    blocks.push(bracedBlock(css, index));
    index = css.indexOf(marker, index + marker.length);
  }
  return blocks;
}

function blockContaining(marker: string, needle: string): string {
  const block = blocksWith(marker).find((candidate) => candidate.includes(needle));
  if (!block) throw new Error(`No ${marker} block contains ${needle}`);
  return block;
}

/** Pixels for a `rem`/`px` spacing declaration; 0 when the property is absent. */
function spacingPx(body: string, property: string): number {
  const match = new RegExp(`${property}:\\s*([\\d.]+)(rem|px)`).exec(body);
  if (!match) return 0;
  const value = Number.parseFloat(match[1] ?? '0');
  return match[2] === 'px' ? value : value * 16;
}

describe('mobile spacing styles (owner audit 2026-11-25)', () => {
  it('keeps the narrow decision panel clear of the next surface', () => {
    const panel = ruleBody('.job-detail > [data-job-detail-section="actions"] > .detail-action.surface-flat');
    expect(spacingPx(panel, 'margin-bottom')).toBeGreaterThanOrEqual(8);
    // The base panel rule carries no bottom margin, so desktop's rail gap and
    // every other .detail-action surface stay untouched.
    const base = ruleBody('.detail-action.surface-flat');
    expect(spacingPx(base, 'margin-bottom')).toBe(0);
  });

  it('separates the job-note submit button from the note textarea', () => {
    const submit = ruleBody('.job-notes form > button[type="submit"]');
    expect(spacingPx(submit, 'margin-top')).toBeGreaterThanOrEqual(8);
    // The old selector matched a primary button that JobNotes no longer renders.
    expect(css).not.toContain('.job-notes form .primary-button');
  });

  it('lays out the meeting actual-time input and "Şimdi" as a gap-separated row', () => {
    const row = ruleBody('.meeting-actual-at-row');
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    expect(spacingPx(row, 'gap')).toBeGreaterThanOrEqual(8);
    const input = ruleBody('.meeting-actual-at-row input');
    expect(input).toMatch(/flex:\s*1 1 12rem/);
    expect(input).toMatch(/min-width:\s*0/);
    const button = ruleBody('.meeting-actual-at-row .secondary-button');
    expect(button).toMatch(/flex:\s*0 0 auto/);
  });

  it('keeps at least 8px between the schedule quick chips', () => {
    expect(spacingPx(ruleBody('.schedule-quick-chips'), 'gap')).toBeGreaterThanOrEqual(8);
  });

  it('keeps the customer report filters unclipped at 390px', () => {
    // Desktop keeps the four-column layout with the second-row placement.
    const base = ruleBody('.report-filters-wide--customer');
    expect(base).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(8rem, 1fr\)\)/);
    expect(ruleBody('.report-filters-wide--customer > label:nth-child(n + 3)'))
      .toMatch(/grid-row:\s*2/);

    // Narrow: two columns with Başlangıç/Bitiş side by side, full-width search
    // and apply, and the second-row placement reset at matching specificity.
    const narrow = blockContaining('@media (max-width: 720px)', '.report-filters-wide--customer');
    expect(narrow).toMatch(/\.report-filters-wide--customer\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(narrow).toMatch(/\.report-filters-wide--customer > label:nth-child\(n \+ 3\)\s*\{[^}]*grid-row:\s*auto/s);
    expect(narrow).toMatch(/\.report-filters-wide--customer > label:nth-child\(3\)\s*\{[^}]*grid-column:\s*1 \/ -1/s);
    expect(narrow).toMatch(/\.report-filters-wide--customer > button\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*width:\s*100%/s);

    // The two-column rule must be declared after the desktop four-column rule.
    expect(css.lastIndexOf('repeat(2, minmax(0, 1fr))'))
      .toBeGreaterThan(css.indexOf('repeat(4, minmax(8rem, 1fr))'));
  });

  it('resets the customer filter row placement wherever the layout collapses', () => {
    // Both collapse points must repeat the nth-child selector; a plain
    // `> label` reset loses to the base placement on specificity and leaves
    // implicit columns (the 390px clipped date input).
    const container = blockContaining('@container filter-region', '.report-filters-wide--customer');
    const tablet = blockContaining('@media (max-width: 56rem)', '.report-filters-wide--customer');
    for (const block of [container, tablet]) {
      expect(block).toMatch(/\.report-filters-wide--customer > label:nth-child\(n \+ 3\)[^{]*\{[^}]*grid-row:\s*auto/s);
    }
  });

  it('stacks the customer filter row when a native date input would clip', () => {
    const tiny = blocksWith('@media (max-width: 24rem)').find(
      (block) => block.includes('.report-filters-wide--customer'),
    );
    expect(tiny).toBeDefined();
    expect(tiny).toMatch(/\.report-filters-wide--customer\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });
});
