import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the declaration block whose selector list STARTS with `selector`.
 */
function ruleFor(selector: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(selector)}\\s*[,{]`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`CSS rule not found: ${selector}`);
  const open = css.indexOf('{', match.index);
  const end = css.indexOf('}', open);
  return css.slice(match.index, end + 1);
}

describe('weekly report manager-question editor and WR-WEEK styles contract', () => {
  it('removes the unused preset checkbox rules (WR-WEEK D6)', () => {
    expect(css).not.toContain('.weekly-question-presets');
    expect(css).not.toContain('.weekly-question-preset');
  });

  it('leaves the global text-control rule untouched', () => {
    const generic = ruleFor('.field-group input, .field-group select, .field-group textarea');
    expect(generic).toContain('width: 100%');
    expect(generic).toContain('min-height: var(--control-height)');
    expect(css).not.toMatch(/\.field-group input:not\(/);
  });

  it('gives the add-custom action a left-aligned, content-width container', () => {
    const actions = ruleFor('.weekly-question-actions');
    expect(actions).toContain('display: flex');
    expect(actions).toContain('justify-content: flex-start');
    expect(actions).toContain('flex-wrap: wrap');
    expect(actions).not.toContain('width: 100%');
  });

  it('separates the staff bulk actions with a visible, wrapping gap', () => {
    const bulk = ruleFor('.weekly-staff-bulk-actions');
    expect(bulk).toContain('display: flex');
    expect(bulk).toContain('flex-wrap: wrap');
    expect(bulk).toMatch(/gap:\s*[\d.]+rem/);
    expect(bulk).not.toContain('justify-content: space-between');
    expect(ruleFor('.weekly-staff-bulk-actions .field-status')).toContain('margin-top: 0');
  });

  it('keeps week-choice radio targets at 44px without stretching the radio input', () => {
    const choice = ruleFor('.weekly-period-choice');
    expect(choice).toContain('min-height: var(--control-height)');
    const radio = ruleFor('.weekly-period-choice input[type="radio"]');
    expect(radio).toContain('width: 1.25rem');
    expect(radio).toContain('height: 1.25rem');
    expect(radio).not.toContain('!important');
  });

  it('keeps mobile sticky editor actions and readiness summary scoped below 768px with DESIGN tokens', () => {
    expect(css).toMatch(/@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?\.weekly-mobile-readiness\s*\{[^}]*display:\s*none/s);
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(mobileBlock).toContain('.weekly-editor-actions.form-actions');
    expect(mobileBlock).toContain('position: sticky');
    expect(mobileBlock).toContain('var(--paper)');
    expect(mobileBlock).toContain('var(--rule)');
    expect(mobileBlock).toContain('var(--shadow-raised)');
    expect(mobileBlock).toContain('var(--control-height)');
    expect(mobileBlock).not.toContain('backdrop-filter');
  });

  it('does not introduce a global .field-row rule', () => {
    expect(css).not.toMatch(/^\.field-row\s*\{/m);
  });
});
