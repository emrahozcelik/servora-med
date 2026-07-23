import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { theme } from 'antd';
import { describe, expect, it } from 'vitest';

import { servoraAntTheme } from '../src/ui/antd/servora-ant-theme';
import {
  SERVORA_REQUIRED_CSS_VARIABLES,
  SERVORA_SEMANTIC_STATES,
  servoraSemanticColorPairs,
  servoraVisualTokens,
} from '../src/ui/servora-visual-tokens';

const stylesPath = resolve(process.cwd(), 'src/styles.css');
const stylesCss = readFileSync(stylesPath, 'utf8');

/** Extract the first :root { … } block without a CSS parser dependency. */
function extractRootBlock(css: string): string {
  const match = css.match(/:root\s*\{/);
  if (!match || match.index === undefined) {
    throw new Error('Expected a :root rule in styles.css');
  }
  let depth = 0;
  let started = false;
  for (let i = match.index; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) {
        return css.slice(match.index, i + 1);
      }
    }
  }
  throw new Error('Unclosed :root rule in styles.css');
}

function declarationsForVariable(rootBlock: string, variable: string): string[] {
  const pattern = new RegExp(
    `${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`,
    'g',
  );
  const values: string[] = [];
  for (const match of rootBlock.matchAll(pattern)) {
    values.push(match[1]!.trim());
  }
  return values;
}

function channelToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16));
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hexadecimal color, received ${hex}`);
  }
  const [red, green, blue] = channels.map(channelToLinear);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Servora visual token contract', () => {
  const rootBlock = extractRootBlock(stylesCss);

  it('declares each required CSS custom property exactly once under :root', () => {
    for (const variable of SERVORA_REQUIRED_CSS_VARIABLES) {
      const values = declarationsForVariable(rootBlock, variable);
      expect(values, variable).toHaveLength(1);
      expect(values[0], variable).toBeTruthy();
    }
  });

  it('keeps CSS values aligned with the TypeScript token contract', () => {
    const { color, control, elevation } = servoraVisualTokens;
    const expected: Array<[string, string]> = [
      [color.ink.cssVariable, color.ink.cssValue],
      [color.muted.cssVariable, color.muted.cssValue],
      [color.paper.cssVariable, color.paper.cssValue],
      [color.canvas.cssVariable, color.canvas.cssValue],
      [color.rule.cssVariable, color.rule.cssValue],
      [color.accent.cssVariable, color.accent.cssValue],
      [color.accentHover.cssVariable, color.accentHover.cssValue],
      [color.accentSoft.cssVariable, color.accentSoft.cssValue],
      [color.focus.cssVariable, color.focus.cssValue],
      [color.information.cssVariable, color.information.cssValue],
      [color.informationSoft.cssVariable, color.informationSoft.cssValue],
      [color.success.cssVariable, color.success.cssValue],
      [color.successSoft.cssVariable, color.successSoft.cssValue],
      [color.warning.cssVariable, color.warning.cssValue],
      [color.warningSoft.cssVariable, color.warningSoft.cssValue],
      [color.error.cssVariable, color.error.cssValue],
      [color.errorSoft.cssVariable, color.errorSoft.cssValue],
      ['--control-height', control.heightCss],
      ['--radius-control', control.radiusControlCss],
      ['--radius-button', control.radiusButtonCss],
      ['--radius-raised', control.radiusRaisedCss],
      ['--radius-chip', control.radiusChipCss],
      ['--shadow-raised', elevation.raised],
    ];

    for (const [variable, value] of expected) {
      expect(declarationsForVariable(rootBlock, variable)[0]).toBe(value);
    }
  });

  it('wires foundation body and focus contracts to semantic tokens', () => {
    expect(stylesCss).toMatch(/body\s*\{[^}]*color:\s*var\(--ink\)/s);
    expect(stylesCss).toMatch(/body\s*\{[^}]*background:\s*var\(--paper\)/s);
    expect(stylesCss).toMatch(
      /button,\s*input\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    );
    expect(stylesCss).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*3px\s+solid\s+var\(--focus\)/s,
    );
    expect(stylesCss).toMatch(
      /:focus-visible\s*\{[^}]*outline-offset:\s*3px/s,
    );
  });

  it('bridges Ant theme tokens from the shared contract without hardcodes in theme source', () => {
    const themeSource = readFileSync(
      resolve(process.cwd(), 'src/ui/antd/servora-ant-theme.ts'),
      'utf8',
    );
    expect(themeSource).toContain("from '../servora-visual-tokens'");
    expect(themeSource).not.toMatch(/#[0-9A-Fa-f]{6}/);

    const { color, control, elevation, typography } = servoraVisualTokens;
    const token = servoraAntTheme.token!;

    expect(token.colorPrimary).toBe(color.accent.antValue);
    expect(token.colorText).toBe(color.ink.antValue);
    expect(token.colorTextSecondary).toBe(color.muted.antValue);
    expect(token.colorBgContainer).toBe(color.paper.antValue);
    expect(token.colorBgBase).toBe(color.paper.antValue);
    expect(token.colorBgLayout).toBe(color.canvas.antValue);
    expect(token.colorBorder).toBe(color.rule.antValue);
    expect(token.colorError).toBe(color.error.antValue);
    expect(token.colorWarning).toBe(color.warning.antValue);
    expect(token.colorSuccess).toBe(color.success.antValue);
    expect(token.colorInfo).toBe(color.information.antValue);
    expect(token.controlOutline).toBe(color.focus.antValue);
    expect(token.controlHeight).toBe(control.heightPx);
    expect(token.borderRadius).toBe(control.radiusPx);
    expect(token.controlOutlineWidth).toBe(control.focusWidthPx);
    expect(token.boxShadow).toBe(elevation.raised);
    expect(token.fontFamily).toBe(typography.fontFamily);
    expect(token.fontSize).toBe(typography.bodySizePx);
    expect(token.motion).toBe(true);

    const resolved = theme.getDesignToken(servoraAntTheme);
    expect(resolved.colorPrimary.toUpperCase()).toBe(color.accent.antValue);
    expect(resolved.controlHeight).toBe(44);
    expect(resolved.borderRadius).toBe(10);
  });

  it('keeps semantic state vocabulary closed', () => {
    expect([...SERVORA_SEMANTIC_STATES].sort()).toEqual(
      ['error', 'information', 'success', 'warning'].sort(),
    );
    for (const state of SERVORA_SEMANTIC_STATES) {
      expect(servoraSemanticColorPairs[state].foreground.antValue).toMatch(/^#[0-9A-F]{6}$/i);
      expect(servoraSemanticColorPairs[state].soft.antValue).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it.each([
    ['ink/paper', servoraVisualTokens.color.ink.antValue, servoraVisualTokens.color.paper.antValue, 4.5],
    ['muted/paper', servoraVisualTokens.color.muted.antValue, servoraVisualTokens.color.paper.antValue, 4.5],
    ['accent/paper', servoraVisualTokens.color.accent.antValue, servoraVisualTokens.color.paper.antValue, 4.5],
    ['error/paper', servoraVisualTokens.color.error.antValue, servoraVisualTokens.color.paper.antValue, 4.5],
    ['warning pair', servoraVisualTokens.color.warning.antValue, servoraVisualTokens.color.warningSoft.antValue, 4.5],
    ['success pair', servoraVisualTokens.color.success.antValue, servoraVisualTokens.color.successSoft.antValue, 4.5],
    ['information pair', servoraVisualTokens.color.information.antValue, servoraVisualTokens.color.informationSoft.antValue, 4.5],
    ['paper/accent', servoraVisualTokens.color.paper.antValue, servoraVisualTokens.color.accent.antValue, 4.5],
    ['focus/paper', servoraVisualTokens.color.focus.antValue, servoraVisualTokens.color.paper.antValue, 3.0],
    ['focus/canvas', servoraVisualTokens.color.focus.antValue, servoraVisualTokens.color.canvas.antValue, 3.0],
  ] as const)('contrast %s meets WCAG threshold', (_label, foreground, background, minimum) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });
});
