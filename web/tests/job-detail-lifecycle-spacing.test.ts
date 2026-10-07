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

function marginRem(bodies: string[], property: 'margin-top' | 'margin-bottom'): number {
  const pattern = new RegExp(`${property}:\\s*([\\d.]+)rem`);
  for (const body of bodies) {
    const match = pattern.exec(body);
    if (match) return Number.parseFloat(match[1] ?? '0');
  }
  return 0;
}

describe('job detail lifecycle spacing (UI polish slice A)', () => {
  it('separates a completed follow-up create action from the terminal banner', () => {
    const bodies = rulesFor('.follow-up-create-action + [data-job-detail-section="terminal"]');
    expect(bodies.length).toBeGreaterThan(0);
    expect(marginRem(bodies, 'margin-top')).toBeGreaterThan(0);
  });

  it('separates a completed follow-up recommendation from the terminal banner', () => {
    const bodies = rulesFor('.follow-up-recommendation + [data-job-detail-section="terminal"]');
    expect(bodies.length).toBeGreaterThan(0);
    expect(marginRem(bodies, 'margin-top')).toBeGreaterThan(0);
  });

  it('separates a follow-up source panel from the terminal banner', () => {
    const bodies = rulesFor('.follow-up-source-context + [data-job-detail-section="terminal"]');
    expect(bodies.length).toBeGreaterThan(0);
    expect(marginRem(bodies, 'margin-top')).toBeGreaterThan(0);
  });

  it('keeps the shared terminal banner free of top margin (WeeklyReportDetail undisturbed)', () => {
    const bodies = rulesFor('.completed-job-banner');
    expect(bodies.length).toBeGreaterThan(0);
    expect(marginRem(bodies, 'margin-top')).toBe(0);
  });

  it('gives the JobDetail heading group bottom separation from the next surface', () => {
    const bodies = rulesFor('[data-job-detail="true"] > [data-job-detail-section="heading"]');
    expect(bodies.length).toBeGreaterThan(0);
    expect(marginRem(bodies, 'margin-bottom')).toBeGreaterThan(0);
  });

  it('leaves the global PageHeader spacing contract untouched', () => {
    const bodies = rulesFor('.page-header');
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((body) => body.includes('margin-bottom:'))).toBe(true);
  });
});
