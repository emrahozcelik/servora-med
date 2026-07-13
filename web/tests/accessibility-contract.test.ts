import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

let css = '';
beforeAll(async () => {
  css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
});

describe('shared accessibility CSS contract', () => {
  it('keeps primary controls at least 44 CSS px tall', () => {
    expect(css).toMatch(/button, input \{ min-height: 2\.75rem; \}/);
    expect(css).toMatch(/\.primary-button, \.secondary-button \{[^}]*display: inline-flex;[^}]*min-height: 2\.75rem;/);
  });

  it('provides a visible focus indicator independent of color fill', () => {
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\); outline-offset: 3px; \}/);
  });

  it('has a structural mobile breakpoint and single-column detail/form reflow', () => {
    expect(css).toMatch(/body \{[^}]*min-width: 0;/);
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/\.compact-shell-header \{[^}]*display: flex;/);
    expect(css).toMatch(/\.detail-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.delivery-pair \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.delivery-lines > ul > li \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-filters \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-row \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-form-pair \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.record-facts, \.job-summary-grid \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.contact-list > li \{[^}]*flex-direction: column;/);
    expect(css).toMatch(/\.product-filters \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.product-row \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.product-form-pair \{ grid-template-columns: 1fr;/);
  });

  it('prevents Product content from forcing page-level horizontal scrolling', () => {
    expect(css).toMatch(/\.product-workspace, \.product-create \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.product-row \{[^}]*min-width: 0;/);
  });

  it('honors reduced-motion preference', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms !important');
  });

  it('defines the 64rem shell structure, 44px targets, and no page overflow', () => {
    expect(css).toContain('@media (min-width: 64rem)');
    expect(css).toMatch(/\.shell-menu-button, \.shell-nav a, \.shell-signout, \.drawer-close \{[^}]*min-width: 2\.75rem;[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.authenticated-shell \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.shell-content \{[^}]*min-width: 0;/);
    expect(css).toMatch(/body \{[^}]*overflow-x: clip;/);
  });

  it('keeps the shell flat and restrained while elevating only the modal drawer', () => {
    expect(css).not.toMatch(/\.shell-sidebar[^}]*box-shadow/);
    expect(css).not.toMatch(/\.authenticated-shell[^}]*gradient|\.shell-sidebar[^}]*gradient/);
    expect(css).not.toMatch(/\.shell-sidebar[^}]*backdrop-filter|\.shell-drawer[^}]*backdrop-filter/);
    expect(css).toMatch(/\.shell-drawer \{[^}]*box-shadow:/);
  });

  it('keeps compact and desktop shell controls reachable in short or zoomed viewports', () => {
    expect(css).toMatch(/\.shell-drawer \{[^}]*block-size: 100dvh;[^}]*max-block-size: 100vh;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.shell-sidebar \{[^}]*max-block-size: 100vh;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
  });

  it('reflows the structured JobCard list without small targets or horizontal page overflow', () => {
    expect(css).toMatch(/\.job-quick-views a, \.job-filter-disclosure summary, \.job-expand, \.job-detail-link \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.structured-job-row \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.job-row-facts dt, \.job-row-summary dt \{[^}]*font-size: 0\.875rem;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.job-row-facts \{[^}]*grid-column: 1 \/ -1;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-facts \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-commands \{[^}]*flex-direction: column;/);
  });
});
