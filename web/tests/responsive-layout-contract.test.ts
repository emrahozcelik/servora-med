import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('responsive layout CSS contracts (PR B)', () => {
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

  it('uses one-column lanes with three-card desktop and four-card wide previews', () => {
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('container-name: job-board');
    expect(css).toMatch(/@container\s+job-board\s*\(\s*min-width:\s*68rem\s*\)/);
    expect(css).toMatch(/@media\s*\(\s*min-width:\s*90rem\s*\)/);
    expect(css).toMatch(/\.workflow-lane-cards\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/@media\s*\(\s*min-width:\s*64rem\s*\)[\s\S]*\.workflow-lane-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/@container\s+job-board\s*\(\s*min-width:\s*68rem\s*\)[\s\S]*\.workflow-lane-cards\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.workflow-lane-cards > li:nth-child\(n \+ 3\)\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media\s*\(\s*min-width:\s*64rem\s*\)[\s\S]*\.workflow-lane-cards > li:nth-child\(n \+ 4\)\s*\{[^}]*display:\s*none/);
    expect(css).not.toContain('.job-board-columns');
    expect(css).not.toContain('.job-board-column');
  });

  it('exposes shared form-control and field-hint styles', () => {
    expect(css).toContain('.form-control');
    expect(css).toContain('.field-hint');
    expect(css).toContain('.status-chip');
    expect(css).toContain('.priority-chip');
  });

  it('keeps owned workflow steps container reflowable without legacy lifecycle grid CSS', () => {
    expect(css).toMatch(/\.servora-workflow-steps\s*\{[^}]*min-width:\s*0/s);
    expect(css).toContain('.servora-workflow-steps .servora-ant-steps');
    expect(css).not.toMatch(/\.job-lifecycle-steps\s*\{/);
    expect(css).not.toMatch(/\.job-lifecycle-step(?:-|\s|\{)/);
  });

  it('places the work rail beside the main record area on desktop without a phantom column', () => {
    expect(css).toMatch(
      /@media\s*\(\s*min-width:\s*64rem\s*\)[\s\S]*\.job-detail-content--rail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(17rem,\s*1fr\)/s,
    );
    expect(css).toMatch(
      /\.job-detail-content--rail\s*>\s*\.job-detail-work-rail\s*\{[^}]*grid-column:\s*2/s,
    );
    expect(css).not.toMatch(/\.job-detail-content\s*\{[^}]*grid-auto-flow:\s*row dense/s);
  });

  it('supports 200% text and 400% reflow at 320 CSS px without page scroll dependence', () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*clip/s);
    expect(css).toMatch(/\.servora-record-descriptions\s+\.servora-ant-descriptions-item-content\s*\{[^}]*overflow-wrap:\s*break-word/s);
    expect(css).toMatch(/\.compact-workflow\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.compact-workflow\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.servora-workflow-steps/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.compact-workflow/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.structured-job-row/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.job-row-facts/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.job-row-commands/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*20rem\s*\)[\s\S]*\.workflow-lane-cards/);
    expect(css).not.toMatch(/\.job-row-summary\s*\{/);
    expect(css).not.toMatch(/\.job-expand\s*\{/);
  });

  it('keeps executive report metrics and workflow trend bounded across widths', () => {
    expect(css).toMatch(/\.report-executive-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*56rem\)[\s\S]*\.report-executive-metrics\s*\{[^}]*repeat\(3,/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.report-executive-metrics\s*\{[^}]*repeat\(2,/s);
    expect(css).toMatch(/\.report-workflow-plot\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.report-workflow-table\s*\{[^}]*width:\s*100%/);
  });

  it('disables workflow transition and scroll animations under reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*\.servora-workflow-steps/);
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*scroll-behavior:\s*auto/);
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*transition-duration:\s*0\.01ms/);
  });

  it('keeps the customer report list reflowable with a bounded structured row', () => {
    expect(css).toMatch(/\.report-customer-list\s*\{[^}]*list-style:\s*none/s);
    expect(css).toMatch(/\.report-customer-list\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.report-customer-card\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.report-customer-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.report-customer-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.report-customer-work-types\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('stacks customer report rows below the mid band and compresses at 390px', () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*720px\s*\)[\s\S]*\.report-customer-row\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*720px\s*\)[\s\S]*\.report-customer-metrics\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*390px\s*\)[\s\S]*\.report-customer-work-types\s*\{[^}]*width:\s*100%/);
  });

  it('wraps report pagination controls through the customer-specific modifier', () => {
    expect(css).toMatch(/\.report-pagination--wrap\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('stacks the customer filter form in two rows and collapses it under shared breakpoints', () => {
    expect(css).toMatch(/\.report-filters-wide--customer\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(8rem,\s*1fr\)\)/);
    expect(css).toMatch(/\.report-filters-wide--customer\s*>\s*label:nth-child\(n\s*\+\s*3\)\s*\{[^}]*grid-row:\s*2/);
    expect(css).toMatch(/@container\s+filter-region\s*\(\s*max-width:\s*52rem\s*\)[\s\S]*\.report-filters-wide--customer[\s\S]*grid-row:\s*auto/);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*56rem\s*\)[\s\S]*\.report-filters-wide--customer[\s\S]*grid-row:\s*auto/);
  });
});
