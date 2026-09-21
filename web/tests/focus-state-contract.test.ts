import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
  // Comments may legitimately contain selector-like text; keep matching on rules only.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every rule whose selector list contains the exact selector. */
function rulesFor(selector: string): string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css))) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies;
}

describe('focus + disabled state contract (UX audit slice 2)', () => {
  it('gives keyboard-focused anchors the Servora focus token family (VIS-03)', () => {
    // Ant's runtime-injected link style (:where(...) a:focus-visible,
    // specificity 0-1-1) beats the global :focus-visible rule (0-1-0) with
    // colorPrimaryBorder + 1px offset. The html qualifier (0-1-2) wins by
    // specificity alone, independent of style-injection order.
    const rules = rulesFor('html a:focus-visible');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).toContain('outline: var(--focus-width) solid var(--focus)');
      expect(body).toContain('outline-offset: 3px');
      // No specificity hack: the fix must hold without !important.
      expect(body).not.toContain('!important');
    }
  });

  it('does not imply loading on ordinary disabled buttons (VIS-06)', () => {
    // Canonical product convention (report-preset-button, notification
    // dismiss): a disabled control is unavailable, cursor not-allowed.
    // Loading stays communicated through the existing aria-busy + label
    // mechanism (e.g. ConfirmationAction), never through the cursor.
    const rules = rulesFor('button:disabled');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).toContain('cursor: not-allowed');
      expect(body).not.toMatch(/cursor:\s*wait/);
    }
  });
});
