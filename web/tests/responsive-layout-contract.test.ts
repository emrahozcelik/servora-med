import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('responsive layout CSS contracts (PR A)', () => {
  it('collapses multi-column filters by 56rem, not only 720px', () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*56rem\s*\)/);
    const block = css.slice(css.indexOf('@media (max-width: 56rem)'));
    expect(block).toContain('.customer-filters');
    expect(block).toContain('.job-filter-primary');
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
});
