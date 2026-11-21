import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// OVR-5b rendered UI review (DECISIONS.md UI-003) shared-style contract.
const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`CSS rule not found: ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start + selector.length, end + 1);
}

describe('OVR-5b visual review shared-style contract', () => {
  it('keeps the standalone checkbox row at the 44px target with a whole-row label', () => {
    const row = ruleBody('.form-checkbox-row');
    expect(row).toContain('min-height: var(--control-height)');
    expect(row).toContain('align-items: center');

    const label = ruleBody('.form-checkbox-row label');
    expect(label).toContain('display: flex');
    expect(label).toContain('flex: 1 1 auto');
    expect(label).toContain('min-height: var(--control-height)');
    expect(label).toContain('cursor: pointer');
  });

  it('keeps compact buttons in a stacked mobile form footer at the control height', () => {
    const footer = ruleBody('.review-buttons .compact-button');
    expect(footer).toContain('min-height: var(--control-height)');
  });

  it('resets the prelude fieldset chrome inside the workflow and reason dialogs', () => {
    const fieldset = ruleBody('.reason-dialog fieldset, .workflow-dialog fieldset');
    expect(fieldset).toContain('min-width: 0');
    expect(fieldset).toContain('margin: 0');
    expect(fieldset).toContain('padding: 0');
    expect(fieldset).toContain('border: 0');
  });
});
