import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

let css = '';
beforeAll(async () => {
  css = await readFile(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
});

describe('shared accessibility CSS contract', () => {
  it('keeps primary controls at least 44 CSS px tall', () => {
    expect(css).toMatch(/--control-height:\s*2\.75rem;/);
    expect(css).toMatch(/button,\s*input\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
    expect(css).toMatch(
      /\.primary-button,\s*\.secondary-button,\s*\.destructive-button,\s*\.ghost-button\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*var\(--control-height\)/s,
    );
  });

  it('provides a visible focus indicator independent of color fill', () => {
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\)\s+solid\s+var\(--focus\);[^}]*outline-offset:\s*3px;/s,
    );
  });

  it('has a structural mobile breakpoint and single-column detail/form reflow', () => {
    expect(css).toMatch(/body\s*\{[^}]*min-width:\s*0;/s);
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
    expect(css).toMatch(/\.servora-activity-timeline article \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.servora-activity-timeline article p \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.servora-activity-timeline article footer \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
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
    expect(css).toMatch(/\.detail-summary \{[^}]*display: block;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-note-list li > div \{[^}]*flex-direction: column;/);
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

  it('styles owned Ant adapters through the configured prefix only', () => {
    expect(css).toContain('.servora-workflow-steps .servora-ant-steps');
    expect(css).toContain('.servora-ant-steps-item-title');
    expect(css).toContain('.servora-ant-descriptions-item-label');
    expect(css).toContain('.servora-ant-descriptions-item-content');
    expect(css).not.toMatch(/\.ant-(?:steps|descriptions|timeline)(?:\b|-)/);
    expect(css).not.toMatch(/\.job-timeline\s+(?:ol|li)(?:\b|\s|>)/);
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
    expect(css).toMatch(/\.report-filters button, \.report-filters input, \.report-filters select \{[^}]*min-height: var\(--control-height\);/);
    expect(css).toMatch(/\.report-workspace, \.report-section, \.report-table-wrap \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.responsive-report-table thead \{/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.responsive-report-table tr \{[^}]*display: block;/);
  });

  it('defines the 64rem shell structure, 44px targets, and no page overflow', () => {
    expect(css).toContain('@media (min-width: 64rem)');
    expect(css).toContain('@media (width < 64rem)');
    expect(css).toMatch(/\.shell-menu-button, \.shell-nav a, \.shell-signout, \.drawer-close \{[^}]*min-width: 2\.75rem;[^}]*min-height: var\(--control-height\);/);
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
    expect(css).toMatch(/\.job-quick-views a, \.job-filter-disclosure summary \{[^}]*min-height: var\(--control-height\);/);
    expect(css).not.toMatch(/\.job-expand\s*\{/);
    expect(css).not.toMatch(/\.job-detail-link\s*\{/);
    expect(css).toMatch(/\.structured-job-row \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.structured-job-row\.job-list-card \{[^}]*position:\s*relative;/);
    expect(css).toMatch(/\.job-row-title-link::after \{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    expect(css).toMatch(/\.job-row-commands \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.customer-row\.customer-list-card \{[^}]*position:\s*relative;/);
    expect(css).toMatch(/\.customer-title-link::after \{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    expect(css).toMatch(/\.customer-row-commands \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.product-row\.product-list-card \{[^}]*position:\s*relative;/);
    expect(css).toMatch(/\.product-title-link::after \{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);
    expect(css).toMatch(/\.product-row-commands \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.job-row-mobile-primary \{[^}]*position:\s*relative;[^}]*z-index:\s*[1-9]/);
    expect(css).toMatch(/\.job-row-facts dt \{[^}]*font-size: 0\.875rem;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/@media \(max-width: 80rem\)[\s\S]*\.job-row-facts \{[^}]*grid-column: 1 \/ -1;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.structured-job-row \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-facts \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.job-row-commands \{[^}]*flex-direction: column;/);
  });

  it('keeps horizontal workflow lanes reflowable without nested scroll columns', () => {
    expect(css).toMatch(/\.job-board \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-x: hidden;/);
    expect(css).toMatch(/\.workflow-lane \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.workflow-lane-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.workflow-lane-link \{[^}]*min-height: var\(--control-height\);/);
    expect(css).toMatch(/\.workflow-lane-cards \{[^}]*min-width: 0;[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).not.toMatch(/\.workflow-lane-cards[^}]*overflow-y|\.workflow-lane[^}]*overflow-y/);
    expect(css).not.toMatch(/\.job-board-card[^}]*box-shadow|\.workflow-lane[^}]*gradient/);
    expect(css).not.toMatch(/\.ant-layout|\.ant-menu|\.ant-card/);
  });

  it('keeps General Task creation and type cues accessible without color-only meaning', () => {
    expect(css).toMatch(/\.task-optional summary \{[^}]*min-height: var\(--control-height\);/);
    expect(css).toMatch(/\.inline-action \{[^}]*min-height: var\(--control-height\);/);
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

  it('keeps the compact view switch outside the filter sheet with reachable controls', () => {
    expect(css).toMatch(/\.job-view-switcher \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.job-view-switcher button \{[^}]*min-height: var\(--control-height\);/);
    expect(css).toMatch(/\.job-view-switcher button\[aria-pressed="true"\] \{[^}]*background: var\(--accent-soft\);/);
    expect(css).toMatch(/\.job-view-switcher button\[aria-pressed="true"\] \{[^}]*font-weight: 760;/);
  });

  it('marks Jobs quick views with multi-channel current state (not color alone)', () => {
    expect(css).toMatch(/\.job-quick-views a\[aria-current="page"\] \{[^}]*font-weight: 760;/);
    expect(css).toMatch(/\.job-quick-views a\[data-state="current"\] \{[^}]*font-weight: 760;/);
    expect(css).toMatch(/\.job-filters\.surface-flat \{[^}]*box-shadow: none;/);
  });

  it('keeps desktop job list rows flat without raised card shadow', () => {
    expect(css).toMatch(/\.structured-job-row \{[^}]*box-shadow: none;/);
    expect(css).toMatch(/\.job-row-primary h2 \{[^}]*font-weight: 720;/);
    expect(css).toMatch(/\.job-row-commands \.primary-button,\s*\.job-row-commands \.secondary-button \{[^}]*min-height: var\(--control-height\);/);
  });

  it('keeps manager approval review and workflow dialogs reflowable with reachable targets', () => {
    expect(css).toMatch(/\.approval-review \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.approval-review h2 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.workflow-dialog \{[^}]*width: min\(100%, 34rem\);[^}]*max-height: calc\(100dvh - 2rem\);[^}]*overflow: auto;/);
    expect(css).toMatch(/\.workflow-dialog \.review-buttons button, \.reason-dialog \.review-buttons button \{[^}]*min-height: var\(--control-height\);/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.approval-review-summary \{[^}]*grid-template-columns: 1fr;/);
  });
});
