import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/** Slices the `/* Phase 2 C2 *\/` block so later stylesheet edits cannot satisfy these contracts by accident. */
function phaseBlock(): string {
  const marker = '/* Phase 2 C2 */';
  const start = css.indexOf(marker);
  expect(start, 'Phase 2 C2 block present').toBeGreaterThan(-1);
  return css.slice(start);
}

describe('select inset contract (C2 follow-up)', () => {
  it('gives every shared-contract select inline padding and the control height', () => {
    const block = phaseBlock();
    const rule = /\.field-group select,[\s\S]*?\.backup-inline-form select \{([^}]*)\}/.exec(block);
    expect(rule, 'shared select rule present').not.toBeNull();
    const declarations = rule![1];
    expect(declarations).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(declarations).toMatch(/padding:\s*0 0\.85rem/);
  });
});
