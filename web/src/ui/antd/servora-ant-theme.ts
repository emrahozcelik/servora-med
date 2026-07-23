import type { ThemeConfig } from 'antd';

import {
  servoraSemanticColorPairs,
  servoraVisualTokens,
} from '../servora-visual-tokens';

const { color, control, elevation, typography } = servoraVisualTokens;

/** Backward-compatible semantic soft backgrounds; values come from the token contract. */
export const servoraAntSemanticBackgrounds = {
  information: servoraSemanticColorPairs.information.soft.antValue,
  success: servoraSemanticColorPairs.success.soft.antValue,
  warning: servoraSemanticColorPairs.warning.soft.antValue,
  error: servoraSemanticColorPairs.error.soft.antValue,
} as const;

export const servoraAntTheme: ThemeConfig = {
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
    colorErrorBg: servoraAntSemanticBackgrounds.error,

    colorInfo: color.information.antValue,
    colorInfoBg: servoraAntSemanticBackgrounds.information,

    colorPrimary: color.accent.antValue,

    colorSuccess: color.success.antValue,
    colorSuccessBg: servoraAntSemanticBackgrounds.success,

    colorText: color.ink.antValue,
    colorTextLightSolid: color.paper.antValue,
    colorTextSecondary: color.muted.antValue,

    colorWarning: color.warning.antValue,
    colorWarningBg: servoraAntSemanticBackgrounds.warning,

    controlHeight: control.heightPx,
    controlOutline: color.focus.antValue,
    controlOutlineWidth: control.focusWidthPx,

    fontFamily: typography.fontFamily,
    fontSize: typography.bodySizePx,

    motion: true,
  },
};

export function getServoraAntTheme(reducedMotion: boolean): ThemeConfig {
  if (!reducedMotion) {
    return servoraAntTheme;
  }

  return {
    ...servoraAntTheme,
    token: {
      ...servoraAntTheme.token,
      motion: false,
    },
  };
}
