import type { ThemeConfig } from 'antd';

import {
  servoraSemanticColorPairs,
  servoraVisualTokens,
} from '../servora-visual-tokens';

const { color, control, elevation, typography } = servoraVisualTokens;

/**
 * FormControl border shared with native inputs/selects/textarea
 * (`styles.css` `.field-group input, select, textarea, .form-control`).
 * The owned Select must not read as a lighter, disabled-looking control inside
 * a form that also has native controls (UI audit F-09).
 */
const controlBorder = color.controlBorder.cssValue;

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
    colorErrorBg: color.errorSoft.antValue,

    colorInfo: color.information.antValue,
    colorInfoBg: color.informationSoft.antValue,

    colorPrimary: color.accent.antValue,

    colorSuccess: color.success.antValue,
    colorSuccessBg: color.successSoft.antValue,

    colorText: color.ink.antValue,
    colorTextLightSolid: color.paper.antValue,
    colorTextSecondary: color.muted.antValue,

    colorWarning: color.warning.antValue,
    colorWarningBg: color.warningSoft.antValue,

    controlHeight: control.heightPx,
    controlOutline: color.focus.antValue,
    controlOutlineWidth: control.focusWidthPx,

    fontFamily: typography.fontFamily,
    fontSize: typography.bodySizePx,

    motion: true,
  },
  components: {
    // Select keyboard focus uses the Servora outline from the ServoraSelect
    // adapter class (styles.css, UI audit F-02). Ant's own focus ring is a
    // box-shadow that fades in over motionDurationSlow and is dropped in
    // forced-colors mode, so it is switched off here for every status to keep
    // the two indicators from stacking. Border colors still mark focus/status.
    Select: {
      activeOutlineColor: 'transparent',
      colorErrorOutline: 'transparent',
      colorWarningOutline: 'transparent',
      // Resting border joins the FormControl contract. Hover/focus/error and
      // warning borders keep their own tokens, so interaction feedback survives.
      colorBorder: controlBorder,
    },
    // ActivityTimeline renders its own tone marker as the item icon. The
    // marker fills this node, so the rail offset and marker stay aligned.
    Timeline: {
      dotSize: 24,
    },
  },
} satisfies ThemeConfig;

export const servoraAntSemanticBackgrounds = {
  information: servoraSemanticColorPairs.information.soft.antValue,
  success: servoraSemanticColorPairs.success.soft.antValue,
  warning: servoraSemanticColorPairs.warning.soft.antValue,
  error: servoraSemanticColorPairs.error.soft.antValue,
} as const;
