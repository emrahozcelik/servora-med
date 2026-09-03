import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Slice C dialog layering contract (static CSS guard).
 *
 * Root cause: .product-dialog-backdrop overrode the generic dialog backdrop
 * z-index (50) down to the mobile bottom-nav layer (20) while the nav renders
 * later in the AppShell DOM, so overflowing workflow dialogs slid their
 * primary CTA underneath the navigation bar. Real geometry is additionally
 * covered by web/scripts/follow-up-dialog-geometry.mjs (Chromium + WebKit).
 */
describe('follow-up dialog layering contract', () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
    'utf8',
  );

  function ruleBody(selector: string, exact = false): string {
    const start = exact ? css.indexOf(`${selector} {`) : css.indexOf(selector);
    expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  }

  it('keeps product dialog backdrops on the dialog layer above the bottom nav', () => {
    expect(ruleBody('.dialog-backdrop', true)).toMatch(/z-index:\s*50/);
    expect(ruleBody('.product-dialog-backdrop', true)).toMatch(/z-index:\s*50/);
    expect(ruleBody('.product-dialog-backdrop', true)).not.toMatch(/z-index:\s*20/);
    expect(ruleBody('.mobile-bottom-nav', true)).toMatch(/z-index:\s*20/);
  });

  it('reserves the mobile bottom-nav footprint in dialog max-height', () => {
    const mobileRule = '.authenticated-shell--mobile .reason-dialog';
    expect(css).toContain(mobileRule);
    const body = ruleBody(mobileRule);
    expect(body).toContain('max-height');
    expect(body).toContain('100dvh');
    // Mirrors .mobile-bottom-nav min-height plus the shared safe-area token.
    expect(body).toContain('3.75rem');
    expect(body).toContain('env(safe-area-inset-bottom');
  });

  it('preserves the working dialog scroll model', () => {
    expect(ruleBody('.reason-dialog, .workflow-dialog', true)).toMatch(/overflow:\s*auto/);
  });

  it('leaves neighboring overlay layers untouched', () => {
    expect(ruleBody('.shell-drawer-backdrop', true)).toMatch(/z-index:\s*30/);
    expect(ruleBody('.filter-sheet-root', true)).toMatch(/z-index:\s*55/);
    expect(ruleBody('.sticky-new-job', true)).toMatch(/z-index:\s*22/);
  });
});
