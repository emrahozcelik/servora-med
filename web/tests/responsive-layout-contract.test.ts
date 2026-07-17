import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('responsive layout CSS contracts (PR A)', () => {
  it('collapses multi-column filters by container query on usable width', () => {
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('container-name: filter-region');
    expect(css).toMatch(/@container\s+filter-region\s*\(\s*max-width:\s*52rem\s*\)/);
    const block = css.slice(css.indexOf('@container filter-region (max-width: 52rem)'));
    expect(block).toContain('.customer-filters');
    expect(block).toContain('.job-filter-primary');
    expect(block).toContain('.report-filters');
    expect(block).toContain('.report-filters-wide');
  });

  it('gates five-column Kanban on container width with 90rem viewport fallback', () => {
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('container-name: job-board');
    expect(css).toMatch(/@container\s+job-board\s*\(\s*min-width:\s*68rem\s*\)/);
    expect(css).toMatch(/@media\s*\(\s*min-width:\s*90rem\s*\)/);
    expect(css).toMatch(/\.job-board-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });

  it('exposes shared form-control and field-hint styles', () => {
    expect(css).toContain('.form-control');
    expect(css).toContain('.field-hint');
    expect(css).toContain('.status-chip');
    expect(css).toContain('.priority-chip');
  });

  it('keeps lifecycle steps vertical on mobile and five-column-or-compact on desktop', () => {
    expect(css).toMatch(/\.job-lifecycle-steps\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.job-lifecycle-steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/@media\s*\(\s*min-width:\s*64rem\s*\)[\s\S]*\.job-lifecycle-steps\s*\{[^}]*grid-template-columns:\s*repeat\(\s*5\s*,\s*minmax\(0,\s*1fr\)\s*\)/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*63\.99rem\s*\)[\s\S]*\.job-lifecycle-steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });

  it('supports 200% text and 400% reflow at 320 CSS px without page scroll dependence', () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*clip/s);
    expect(css).toMatch(/\.job-lifecycle-step-label\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.compact-workflow\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.compact-workflow\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.job-lifecycle-steps/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.compact-workflow/);
  });

  it('disables workflow transition and scroll animations under reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*\.job-lifecycle-steps/);
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*scroll-behavior:\s*auto/);
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*transition-duration:\s*0\.01ms/);
  });
});
