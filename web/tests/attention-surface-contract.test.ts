import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { servoraVisualTokens } from '../src/ui/servora-visual-tokens';

const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's').exec(stylesCss);
  if (!match) throw new Error(`Missing rule for ${selector}`);
  return match[1] ?? '';
}

function lightness(cssValue: string): number {
  const match = /oklch\(\s*([\d.]+)%/.exec(cssValue);
  if (!match) throw new Error(`Expected an oklch lightness in ${cssValue}`);
  return Number.parseFloat(match[1]!);
}

describe('C1 follow-up: large surfaces stay lighter than chips', () => {
  it('defines wash surfaces above their chip-strength soft token', () => {
    expect(lightness(servoraVisualTokens.color.warningWash.cssValue))
      .toBeGreaterThan(lightness(servoraVisualTokens.color.warningSoft.cssValue));
    expect(lightness(servoraVisualTokens.color.errorWash.cssValue))
      .toBeGreaterThan(lightness(servoraVisualTokens.color.errorSoft.cssValue));
  });

  it('uses the warning wash for the revision banner and the conflict banner', () => {
    expect(block('.revision-loop')).toMatch(/background:\s*var\(--warning-wash\)/);
    expect(block('.conflict-actions')).toMatch(/background:\s*var\(--warning-wash\)/);
  });

  it('keeps revision requested on Delay Amber, never the cancelled red', () => {
    const chip = block('.status-chip--waiting_approval, .status-chip--revision_requested, .priority-chip--high, .priority-chip--urgent');
    expect(chip).toMatch(/color:\s*var\(--warning\)/);
    expect(stylesCss).not.toMatch(/\.status-chip--revision_requested\s*\{/);
    expect(block('.job-status-revision_requested')).toMatch(/color:\s*var\(--warning\)/);
  });

  it('keeps the destructive decision button on the wash with a visible hover step', () => {
    expect(block('.review-buttons .destructive-button')).toMatch(/background:\s*var\(--error-wash\)/);
    expect(block('.review-buttons .destructive-button:hover:not(:disabled)'))
      .toMatch(/background:\s*var\(--error-soft\)/);
  });
});

describe('C1 follow-up: tonal callouts are not stacked bordered boxes', () => {
  const callouts = [
    '.workflow-responsibility-consequence',
    '.approval-review-instruction',
    '.detail-action .start-location-notice',
  ];

  it.each(callouts)('%s is borderless tonal text', (selector) => {
    const body = block(selector);
    expect(body).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(body).toMatch(/border:\s*0;/);
    expect(body).not.toMatch(/border-radius/);
    expect(body).not.toMatch(/border-left|border-inline-start/);
  });
});

describe('C1 follow-up: warning and pressed-state regressions', () => {
  it('renders the follow-up frequency warning with Delay Amber and a text label', () => {
    const warning = block('.follow-up-frequency-warning');
    expect(warning).toMatch(/background:\s*var\(--warning-wash\)/);
    expect(warning).toMatch(/border:\s*1px solid var\(--border-warning\)/);
    expect(warning).not.toMatch(/--error|--border-error/);
    expect(stylesCss).toMatch(/\.follow-up-frequency-warning-label\s*\{[^}]*color:\s*var\(--warning\)/s);
  });

  it('gives the pressed product row a full selection boundary, not an inset stripe', () => {
    const pressed = block('.product-select-list button[aria-pressed="true"]');
    expect(pressed).toMatch(/border:\s*1px solid var\(--accent\)/);
    expect(pressed).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(pressed).not.toMatch(/box-shadow/);
  });
});
