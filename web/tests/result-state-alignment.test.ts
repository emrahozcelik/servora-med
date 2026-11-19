import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/** Slices the trailing Phase 2 C2 block so later stylesheet edits cannot satisfy these contracts by accident. */
function phaseBlock(): string {
  const marker = '/* Phase 2 C2 */';
  const start = css.indexOf(marker);
  expect(start, 'Phase 2 C2 block present').toBeGreaterThan(-1);
  return css.slice(start);
}

describe('result state alignment contract (C2 follow-up)', () => {
  it('left-aligns the copy and the status artwork on one edge', () => {
    const block = phaseBlock();
    const grouped = /html \.servora-result-state \.servora-ant-result-title,[\s\S]*?\{([^}]*)\}/.exec(block);
    expect(grouped, 'grouped left-alignment rule present').not.toBeNull();
    const selectors = grouped![0].slice(0, grouped![0].indexOf('{'));
    for (const part of ['title', 'subtitle', 'extra', 'icon']) {
      expect(selectors, `${part} selector aligned with the copy`).toContain(`.servora-ant-result-${part}`);
    }
    expect(grouped![1]).toMatch(/text-align:\s*left/);
  });

  it('keeps the calm block padding instead of Ant’s centred result padding', () => {
    expect(phaseBlock()).toMatch(
      /html \.servora-result-state \.servora-ant-result \{[^}]*padding:\s*2rem 0;/,
    );
  });
});
