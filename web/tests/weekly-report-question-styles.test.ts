import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the declaration block whose selector list STARTS with `selector`.
 * The leading-selector anchor (and the required `{`/`,` terminator) keeps
 * `.weekly-question-preset` from matching the longer `.weekly-question-presets`
 * rule, and tolerates selector lists wrapped across lines such as
 * `.field-group input, ...\n.form-control {`.
 */
function ruleFor(selector: string): string {
  const pattern = new RegExp(`^${escapeRegExp(selector)}\\s*[,{]`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`CSS rule not found: ${selector}`);
  const open = css.indexOf('{', match.index);
  const end = css.indexOf('}', open);
  return css.slice(match.index, end + 1);
}

/**
 * Source contract for the Weekly Report manager-question editor layout fix.
 *
 * The regression was that the preset rows used a bare native
 * `<input type="checkbox">` inside a `.field-group`, so the generic
 * `.field-group input` text-control box (width: 100%, control height, padding,
 * border) restyled the checkbox into a large, misplaced hit area. The fix is
 * an owned AntD checkbox plus scoped layout rules — not a CSS override of the
 * native control, and not a change to the global text-input rule.
 */
describe('weekly report manager-question editor — styles source contract', () => {
  it('lays the presets out as evenly spaced rows', () => {
    const presets = ruleFor('.weekly-question-presets');
    expect(presets).toContain('display: grid');
    expect(presets).toMatch(/gap:\s*[\d.]+rem/);
    expect(presets).toContain('min-width: 0');
  });

  it('centers each checkbox with its prompt on one row', () => {
    const row = ruleFor('.weekly-question-preset');
    expect(row).toContain('display: flex');
    expect(row).toContain('align-items: center');
    expect(row).toContain('min-width: 0');
  });

  it('scopes the full-width text-control box off the AntD checkbox input', () => {
    // The owned AntD boundary renders with the Servora prefix (SERVORA_ANT_PREFIX
    // = 'servora-ant'), matching the existing .servora-ant-table/-descriptions
    // selectors in this stylesheet.
    const input = ruleFor(
      '.weekly-question-preset .servora-ant-checkbox-wrapper .servora-ant-checkbox-input',
    );
    // Each of these would otherwise come from `.field-group input`.
    expect(input).toContain('width: auto');
    expect(input).toContain('min-height: 0');
    expect(input).toContain('padding: 0');
    expect(input).toContain('border: 0');
  });

  it('beats the generic .field-group input rule on specificity, without !important', () => {
    const generic = '.field-group input';
    const override = '.weekly-question-preset .servora-ant-checkbox-wrapper .servora-ant-checkbox-input';
    const classCount = (selector: string) => selector.match(/\.[\w-]+/g)?.length ?? 0;
    // .field-group input is (0,1,1); the override carries strictly more class
    // selectors, so it wins the cascade on specificity alone.
    expect(classCount(override)).toBeGreaterThan(classCount(generic));
    expect(ruleFor(override)).not.toContain('!important');
    expect(ruleFor('.weekly-question-preset')).not.toContain('!important');
    expect(ruleFor('.weekly-question-presets')).not.toContain('!important');
    expect(ruleFor('.weekly-question-preset .servora-ant-checkbox-wrapper')).not.toContain('!important');
  });

  it('leaves the global text-control rule untouched', () => {
    const generic = ruleFor('.field-group input, .field-group select, .field-group textarea');
    expect(generic).toContain('width: 100%');
    expect(generic).toContain('min-height: var(--control-height)');
    // The shared rule still owns text inputs; the checkbox is excluded by
    // scoped specificity rather than by weakening the global rule.
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

  it('does not introduce a global .field-row rule', () => {
    expect(css).not.toMatch(/^\.field-row\s*\{/m);
  });
});
