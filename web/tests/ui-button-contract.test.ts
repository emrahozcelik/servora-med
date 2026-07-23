import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('button CSS contract', () => {
  it('makes full width opt-in via btn-full or form footer scopes', () => {
    expect(css).toMatch(/\.primary-button\s*\{[^}]*width:\s*auto/s);
    expect(css).toContain('.primary-button.btn-full');
    expect(css).toMatch(/\.login-form-wrap \.primary-button/);
    expect(css).toMatch(/\.people-form form > \.primary-button/);
    expect(css).toMatch(/\.task-form > \.primary-button/);
    expect(css).toMatch(/\.delivery-form > \.primary-button/);
  });

  it('maps compact-button to small size without forcing full width', () => {
    expect(css).toMatch(/\.btn-sm,\s*\.compact-button\s*\{[^}]*width:\s*auto/s);
  });

  it('defines surface hierarchy classes without side-stripe accents', () => {
    expect(css).toContain('.surface {');
    expect(css).toContain('.surface-raised');
    expect(css).toContain('.surface-flat');
    expect(css).not.toMatch(/\.surface[^{]*\{[^}]*border-left:\s*[2-9]px/s);
  });

  it('keeps list/board open-for-action controls at least 44 CSS px tall', () => {
    expect(css).toMatch(/\.job-row-mobile-primary\s+(?:\.primary-button|\.secondary-button)[^,{]*[,{][^}]*min-height:\s*var\(--control-height\)/s);
    expect(css).toMatch(/\.job-row-commands\s+(?:\.primary-button|\.secondary-button)[^,{]*[,{][^}]*min-height:\s*var\(--control-height\)/s);
    expect(css).toMatch(/\.job-row-mobile-primary\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*56rem\s*\)[\s\S]*\.job-row-mobile-primary\s*\{[^}]*display:\s*block/s);
  });
});
