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
  });

  it('provides a visible focus indicator independent of color fill', () => {
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\); outline-offset: 3px; \}/);
  });

  it('has a structural mobile breakpoint and single-column detail/form reflow', () => {
    expect(css).toMatch(/body \{[^}]*min-width: 0;/);
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/\.app-header \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.account-area \{[^}]*flex-shrink: 0;/);
    expect(css).toMatch(/\.detail-heading \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.delivery-pair \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.delivery-lines > ul > li \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-filters \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-row \{ grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.customer-form-pair \{ grid-template-columns: 1fr;/);
  });

  it('honors reduced-motion preference', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms !important');
  });
});
