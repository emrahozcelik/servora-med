import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SERVORA_REQUIRED_CSS_VARIABLES,
  servoraVisualTokens,
} from '../src/ui/servora-visual-tokens';

const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractRootBlock(css: string): { root: string; outsideRoot: string } {
  const cleaned = stripCssComments(css);
  const match = cleaned.match(/:root\s*\{/);
  if (!match || match.index === undefined) {
    throw new Error('Expected :root rule');
  }
  let depth = 0;
  let started = false;
  for (let i = match.index; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) {
        return {
          root: cleaned.slice(match.index, i + 1),
          // Entire stylesheet outside :root (before + after), not only post-root.
          outsideRoot: cleaned.slice(0, match.index) + cleaned.slice(i + 1),
        };
      }
    }
  }
  throw new Error('Unclosed :root');
}

/** Property-specific raw min-height: 2.75rem (not --control-height: 2.75rem). */
function rawControlHeightDeclarations(css: string): string[] {
  const cleaned = stripCssComments(css);
  const matches = cleaned.match(/(?:^|[^-])min-height:\s*2\.75rem\s*;/gm) ?? [];
  return matches;
}

function countStandaloneSelectorBlocks(css: string, selector: string): number {
  const cleaned = stripCssComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Standalone rule: selector { … } at block start (not a compound group).
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`, 'g');
  return [...cleaned.matchAll(pattern)].length;
}

function selectorBlockContains(css: string, selector: string, snippet: RegExp): boolean {
  const cleaned = stripCssComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs');
  for (const match of cleaned.matchAll(pattern)) {
    if (snippet.test(match[1] ?? '')) return true;
  }
  return false;
}

describe('shared visual language adoption (T1B)', () => {
  const { root, outsideRoot } = extractRootBlock(stylesCss);

  it('bridges focus ring width through --focus-width', () => {
    expect(SERVORA_REQUIRED_CSS_VARIABLES).toContain('--focus-width');
    expect(servoraVisualTokens.control.focusWidthCss).toBe('3px');
    expect(root).toMatch(/--focus-width:\s*3px\s*;/);
    expect(stylesCss).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\)\s+solid\s+var\(--focus\)/s,
    );
    expect(stylesCss).not.toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*3px\s+solid\s+var\(--focus\)/s,
    );
  });

  it('forbids raw min-height: 2.75rem control declarations outside the token definition', () => {
    expect(rawControlHeightDeclarations(stylesCss)).toEqual([]);
    expect(root).toMatch(/--control-height:\s*2\.75rem\s*;/);
    // width/flex uses of 2.75rem remain allowed
    expect(stylesCss).toMatch(/min-width:\s*2\.75rem|width:\s*2\.75rem|flex:\s*0\s+0\s+2\.75rem/);
  });

  it('adopts control radius and height on shared field controls', () => {
    expect(stylesCss).toMatch(
      /\.field-group input,\s*\.field-group select,\s*\.field-group textarea,\s*\.form-control\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    );
    expect(stylesCss).toMatch(
      /\.field-group input,\s*\.field-group select,\s*\.field-group textarea,\s*\.form-control\s*\{[^}]*border-radius:\s*var\(--radius-control\)/s,
    );
    expect(stylesCss).toMatch(
      /\.field-group input,\s*\.field-group select,\s*\.field-group textarea,\s*\.form-control\s*\{[^}]*padding:\s*0\.72rem 0\.85rem/s,
    );
  });

  it('adopts button geometry tokens on the shared button group', () => {
    expect(stylesCss).toMatch(
      /\.primary-button,\s*\.secondary-button,\s*\.destructive-button,\s*\.ghost-button\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    );
    expect(stylesCss).toMatch(
      /\.primary-button,\s*\.secondary-button,\s*\.destructive-button,\s*\.ghost-button\s*\{[^}]*border-radius:\s*var\(--radius-button\)/s,
    );
    expect(stylesCss).toMatch(
      /\.primary-button,\s*\.secondary-button,\s*\.destructive-button,\s*\.ghost-button\s*\{[^}]*min-width:\s*7rem/s,
    );
  });

  it('keeps a single canonical destructive-button base and hover', () => {
    expect(countStandaloneSelectorBlocks(stylesCss, '.destructive-button')).toBe(1);
    expect(countStandaloneSelectorBlocks(stylesCss, '.destructive-button:hover:not(:disabled)')).toBe(1);

    expect(selectorBlockContains(
      stylesCss,
      '.destructive-button',
      /border:\s*1px solid oklch\(68% 0\.1 28deg\)/,
    )).toBe(true);
    expect(selectorBlockContains(
      stylesCss,
      '.destructive-button',
      /color:\s*var\(--error\)/,
    )).toBe(true);
    expect(selectorBlockContains(
      stylesCss,
      '.destructive-button',
      /background:\s*var\(--paper\)/,
    )).toBe(true);
    // Must not reintroduce filled-red base
    expect(selectorBlockContains(
      stylesCss,
      '.destructive-button',
      /background:\s*var\(--error\)/,
    )).toBe(false);
  });

  it('adopts raised surface radius and canonical shadow', () => {
    expect(stylesCss).toMatch(
      /\.surface-raised\s*\{[^}]*border-radius:\s*var\(--radius-raised\)/s,
    );
    expect(stylesCss).toMatch(
      /\.surface-raised\s*\{[^}]*box-shadow:\s*var\(--shadow-raised\)/s,
    );
    expect(stylesCss).not.toMatch(
      /\.surface-raised\s*\{[^}]*box-shadow:\s*0 12px 32px/s,
    );
  });

  it('uses chip radius token on chip/pill/counter surfaces', () => {
    expect(stylesCss).toMatch(/\.status-label[^{]*\{[^}]*border-radius:\s*var\(--radius-chip\)/s);
    expect(stylesCss).toMatch(
      /\.status-chip,\s*\.priority-chip\s*\{[^}]*border-radius:\s*var\(--radius-chip\)/s,
    );
    expect(stylesCss).toMatch(
      /\.record-status span\s*\{[^}]*border-radius:\s*var\(--radius-chip\)/s,
    );
    expect(stylesCss).toMatch(
      /\.notification-center-badge\s*\{[^}]*border-radius:\s*var\(--radius-chip\)/s,
    );
    expect(stylesCss).toMatch(
      /\.workflow-lane-heading h2 > strong\s*\{[^}]*border-radius:\s*var\(--radius-chip\)/s,
    );
    // Meter/segmented tracks must not be forced onto chip token via this sweep
    expect(stylesCss).toMatch(
      /\.report-meter-track\s*\{[^}]*border-radius:\s*999px/s,
    );
  });

  it('forbids exact canonical semantic OKLCH literals outside :root', () => {
    const canonicalValues = Object.values(servoraVisualTokens.color).map((token) => token.cssValue);
    const offenders: string[] = [];
    for (const value of canonicalValues) {
      if (outsideRoot.includes(value)) {
        offenders.push(value);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects canonical semantic OKLCH literals both before and after :root', () => {
    const sampleValue = servoraVisualTokens.color.warning.cssValue;

    const onlyInRoot = extractRootBlock(`:root { --warning: ${sampleValue}; }`);
    expect(onlyInRoot.outsideRoot.includes(sampleValue)).toBe(false);

    const beforeRoot = extractRootBlock(
      `.before { color: ${sampleValue}; }\n:root { --x: 1; }`,
    );
    expect(beforeRoot.outsideRoot.includes(sampleValue)).toBe(true);

    const afterRoot = extractRootBlock(
      `:root { --x: 1; }\n.after { color: ${sampleValue}; }`,
    );
    expect(afterRoot.outsideRoot.includes(sampleValue)).toBe(true);

    const bothSides = extractRootBlock(
      `.before { color: ${sampleValue}; }\n:root { --warning: ${sampleValue}; }\n.after { color: ${sampleValue}; }`,
    );
    expect(bothSides.root.includes(sampleValue)).toBe(true);
    expect(bothSides.outsideRoot.split(sampleValue).length - 1).toBe(2);
  });

  it('preserves unique feature palette and non-canonical border tints', () => {
    expect(outsideRoot).toMatch(/oklch\(72% 0\.018 240deg\)/);
    expect(outsideRoot).toMatch(/oklch\(78% 0\.07 28deg\)/);
    expect(outsideRoot).toMatch(/oklch\(68% 0\.1 28deg\)/);
    expect(outsideRoot).toMatch(/oklch\(96% 0\.02 70deg\)/); // revision chip soft (not warning-soft)
  });

  it('groups shared page-heading geometry without inventing type scale', () => {
    expect(stylesCss).toMatch(
      /\.login-form-wrap h1,\s*\.workspace-empty h1\s*\{[^}]*font-size:\s*1\.75rem/s,
    );
    expect(stylesCss).toMatch(
      /\.workspace > h1,\s*\.workspace-heading h1\s*\{[^}]*font-size:\s*1\.75rem/s,
    );
    expect(stylesCss).toMatch(
      /\.detail-heading h1\s*\{[^}]*font-size:\s*1\.75rem[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(stylesCss).toMatch(
      /\.report-section-heading h2\s*\{[^}]*font-size:\s*1\.375rem/s,
    );
  });

  it('groups shared section-heading contract for drawer and notification headings', () => {
    expect(stylesCss).toMatch(
      /\.drawer-heading h2,\s*\.notification-center-heading h2\s*\{[^}]*margin:\s*0;[^}]*font-size:\s*1\.125rem/s,
    );
    // Each heading appears once — as members of the shared group, not as separate base blocks.
    expect((stylesCss.match(/\.drawer-heading h2/g) ?? []).length).toBe(1);
    expect((stylesCss.match(/\.notification-center-heading h2/g) ?? []).length).toBe(1);
  });

  it('groups shared helper text contract while preserving diverging layout', () => {
    expect(stylesCss).toMatch(
      /\.field-hint,\s*\.form-help\s*\{[^}]*color:\s*var\(--muted\);[^}]*font-size:\s*0\.8125rem/s,
    );
    expect(stylesCss).toMatch(
      /\.field-hint\s*\{[^}]*margin:\s*0;[^}]*line-height:\s*1\.45/s,
    );
    expect(stylesCss).toMatch(
      /\.form-help\s*\{[^}]*margin:\s*1rem 0 0;[^}]*line-height:\s*1\.55;[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  it('keeps helper/label/error semantic roles', () => {
    expect(stylesCss).toMatch(/\.field-group label\s*\{[^}]*font-size:\s*0\.9rem/s);
    // Shared form-level error surface is .form-error (not a missing field-error contract).
    expect(stylesCss).toMatch(/\.form-error[^{]*\{[^}]*color:\s*var\(--error\)/s);
    expect(stylesCss).toMatch(/\.form-error[^{]*\{[^}]*background:\s*var\(--error-soft\)/s);
    expect(stylesCss).toMatch(/\.success-message[^{]*\{[^}]*color:\s*var\(--success\)/s);
    expect(stylesCss).toMatch(/\.success-message[^{]*\{[^}]*background:\s*var\(--success-soft\)/s);
  });
});
