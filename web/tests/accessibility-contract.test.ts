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
    expect(css).toMatch(/\.primary-button, \.secondary-button, \.destructive-button, \.ghost-button \{[^}]*display: inline-flex;[^}]*min-height: 2\.75rem;/s);
  });

  it('provides a visible focus indicator independent of color fill', () => {
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\); outline-offset: 3px; \}/);
  });

  it('has a structural mobile breakpoint and single-column detail/form reflow', () => {
    expect(css).toMatch(/body \{[^}]*min-width: 0;/);
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/\.compact-shell-header \{[^}]*display: flex;/);
    expect(css).toMatch(/\.detail-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.detail-heading > div \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.detail-heading h1 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.detail-section-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.detail-section-heading span \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.detail-section-heading > \* \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.job-notes, \.job-timeline \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.job-notes h2, \.job-timeline h2 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.job-timeline li > div \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.job-timeline strong, \.job-timeline span \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.meeting-details h2 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.delivery-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.task-form fieldset \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.meeting-result-form fieldset \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.field-group input,\s*\.field-group select,\s*\.field-group textarea,\s*\.form-control\s*\{[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.primary-button, \.secondary-button \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.delivery-heading > div, \.brand-lockup \{[^}]*min-width: 0;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.delivery-heading h1, \.brand-lockup span \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.form-intro \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.form-help \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.eyebrow \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.detail-summary time \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.delivery-pair \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.detail-summary \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-timeline li, \.job-note-list li > div, \.job-timeline li > div \{[^}]*flex-direction: column;/);
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
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.completed-trend span \{ transition: none; \}/);
  });

  it('keeps report controls reachable and report content reflowable', () => {
    expect(css).toMatch(/\.report-filters button, \.report-filters input, \.report-filters select \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.report-workspace, \.report-section, \.report-table-wrap \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.responsive-report-table thead \{/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.responsive-report-table tr \{[^}]*display: block;/);
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
    expect(css).toMatch(/\.job-quick-views a, \.job-filter-disclosure summary \{[^}]*min-height: 2\.75rem;/);
    expect(css).not.toMatch(/\.job-expand\s*\{/);
    expect(css).not.toMatch(/\.job-detail-link\s*\{/);
    expect(css).toMatch(/\.structured-job-row \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.structured-job-row\.job-list-card \{[^}]*position:\s*relative;/);
    expect(css).toMatch(/\.job-row-title-link::after \{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    expect(css).toMatch(/\.job-row-commands \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.job-row-mobile-primary \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.job-row-facts dt \{[^}]*font-size: 0\.875rem;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.job-row-facts \{[^}]*grid-column: 1 \/ -1;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-facts \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-commands \{[^}]*flex-direction: column;/);
  });

  it('keeps the desktop board inside the page with independently scrolling columns', () => {
    expect(css).toMatch(/\.job-board \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-x: hidden;/);
    expect(css).toMatch(/\.job-board-columns \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.job-board-column \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.job-board-items \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
    expect(css).not.toMatch(/\.job-board-card[^}]*box-shadow|\.job-board-column[^}]*gradient/);
  });

  it('keeps General Task creation and type cues accessible without color-only meaning', () => {
    expect(css).toMatch(/\.task-optional summary \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.inline-action \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.workspace-create-actions \{[^}]*display: flex;/);
    expect(css).toMatch(/\.job-board-type \{[^}]*font-size:/);
    expect(css).toMatch(/@media \(max-width: 40rem\)[\s\S]*\.workspace-create-actions > \* \{[^}]*flex: 1 1 auto;/);
    expect(css).toMatch(/\.new-job-menu-trigger/);
  });

  it('allows text-enlarged workspace controls to wrap without intrinsic-width overflow', () => {
    expect(css).toMatch(/\.compact-shell-header \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.workspace-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.job-filter-disclosure \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-filter-secondary \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('keeps manager approval review and workflow dialogs reflowable with reachable targets', () => {
    expect(css).toMatch(/\.approval-review \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.approval-review h2 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.workflow-dialog \{[^}]*width: min\(100%, 34rem\);[^}]*max-height: calc\(100dvh - 2rem\);[^}]*overflow: auto;/);
    expect(css).toMatch(/\.workflow-dialog \.review-buttons button, \.reason-dialog \.review-buttons button \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.approval-review-summary \{[^}]*grid-template-columns: 1fr;/);
  });
});
