import type { ThemeConfig } from 'antd';

import {
  candidateATokens,
  candidateBTokens,
  servoraSemanticColorPairs,
  servoraVisualTokens,
} from '../servora-visual-tokens';

function buildAntTheme(color: Record<string, { readonly antValue: string }>) {
  const control = servoraVisualTokens.control;
  const elevation = servoraVisualTokens.elevation;
  const typography = servoraVisualTokens.typography;

  const semanticBackgrounds = {
    information: color.informationSoft.antValue,
    success: color.successSoft.antValue,
    warning: color.warningSoft.antValue,
    error: color.errorSoft.antValue,
  };

  return {
    token: {
      borderRadius: control.radiusPx,
      boxShadow: elevation.raised,
      boxShadowSecondary: elevation.raised,

      colorBgBase: color.paper.antValue,
      colorBgContainer: color.paper.antValue,
      colorBgElevated: color.paper.antValue,
      colorBgLayout: color.canvas.antValue,

      colorBorder: color.rule.antValue,
      colorBorderSecondary: color.rule.antValue,

      colorError: color.error.antValue,
      colorErrorBg: semanticBackgrounds.error,

      colorInfo: color.information.antValue,
      colorInfoBg: semanticBackgrounds.information,

      colorPrimary: color.accent.antValue,

      colorSuccess: color.success.antValue,
      colorSuccessBg: semanticBackgrounds.success,

      colorText: color.ink.antValue,
      colorTextLightSolid: color.paper.antValue,
      colorTextSecondary: color.muted.antValue,

      colorWarning: color.warning.antValue,
      colorWarningBg: semanticBackgrounds.warning,

      controlHeight: control.heightPx,
      controlOutline: color.focus.antValue,
      controlOutlineWidth: control.focusWidthPx,

      fontFamily: typography.fontFamily,
      fontSize: typography.bodySizePx,

      motion: true,
    },
  } satisfies ThemeConfig;
}

export const servoraAntTheme: ThemeConfig = buildAntTheme(servoraVisualTokens.color);

/** Backward-compatible semantic soft backgrounds; values come from the token contract. */
export const servoraAntSemanticBackgrounds = {
  information: servoraSemanticColorPairs.information.soft.antValue,
  success: servoraSemanticColorPairs.success.soft.antValue,
  warning: servoraSemanticColorPairs.warning.soft.antValue,
  error: servoraSemanticColorPairs.error.soft.antValue,
} as const;

export function getServoraAntTheme(
  options?: { palette?: 'a' | 'b'; reducedMotion?: boolean },
): ThemeConfig {
  const palette = options?.palette;
  const reducedMotion = options?.reducedMotion ?? false;

  let base: ThemeConfig;
  if (palette === 'a') {
    base = buildAntTheme(candidateATokens.color);
  } else if (palette === 'b') {
    base = buildAntTheme(candidateBTokens.color);
  } else {
    base = servoraAntTheme;
  }

  if (!reducedMotion) {
    return base;
  }

  return {
    ...base,
    token: {
      ...base.token,
      motion: false,
    },
  };
}
