/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function exactRuleBody(css: string, selector: string): string | null {
  const cleaned = stripComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = cleaned.match(pattern);
  return match?.[1] ?? null;
}

function ruleAbsent(selector: string): boolean {
  return exactRuleBody(stylesCss, selector) === null;
}

/**
 * Slice B: the owned OperationalCard adapter defines one canonical title
 * reflow contract. The selector must stay two-class specific so it wins
 * against Ant's head-title rule (`:where(…).ant-card .ant-card-head-title`,
 * specificity 0-2-0), and obsolete surface-scoped title-wrap overrides must
 * not return as duplicates.
 */
describe('OperationalCard title reflow contract (Slice B)', () => {
  it('defines the shared wrapping rule with winning specificity', () => {
    const body = exactRuleBody(
      stylesCss,
      '.servora-operational-card .servora-operational-card__title',
    );
    expect(body).not.toBeNull();
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it('does not rely on forbidden heavy-handed overrides', () => {
    const body = exactRuleBody(
      stylesCss,
      '.servora-operational-card .servora-operational-card__title',
    );
    expect(body).not.toBeNull();
    expect(body).not.toMatch(/!important/);
    expect(body).not.toMatch(/word-break/);
    expect(body).not.toMatch(/overflow:\s*visible/);
    expect(body).not.toMatch(/text-overflow/);
    expect(body).not.toMatch(/max-height/);
    expect(body).not.toMatch(/-webkit-line-clamp/);
  });

  it('removes the obsolete late-submission scoped title override', () => {
    expect(ruleAbsent('.submission-late-card .servora-operational-card__title')).toBe(true);
    expect(ruleAbsent('.submission-late-card .servora-operational-card__title a')).toBe(true);
  });

  it('removes the obsolete data-management scoped title override', () => {
    expect(ruleAbsent('.data-management-workspace .servora-operational-card__title')).toBe(true);
  });
});
