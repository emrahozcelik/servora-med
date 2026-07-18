import type { ThemeConfig } from 'antd';

export const servoraAntSemanticBackgrounds = {
  information: '#D6E7F4',
  success: '#E3F4E6',
  warning: '#F7EDDC',
} as const;

export const servoraAntTheme: ThemeConfig = {
  token: {
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(30, 37, 43, 0.12)',
    boxShadowSecondary: '0 8px 24px rgba(30, 37, 43, 0.12)',
    colorBgBase: '#F8FBFC',
    colorBgContainer: '#F8FBFC',
    colorBgElevated: '#F8FBFC',
    colorBgLayout: '#EBF1F5',
    colorBorder: '#CAD2D8',
    colorBorderSecondary: '#CAD2D8',
    colorError: '#902822',
    colorInfo: '#00507C',
    colorInfoBg: servoraAntSemanticBackgrounds.information,
    colorPrimary: '#00628E',
    colorSuccess: '#1D4E2B',
    colorSuccessBg: servoraAntSemanticBackgrounds.success,
    colorText: '#1E252B',
    colorTextLightSolid: '#F8FBFC',
    colorTextSecondary: '#535C65',
    colorWarning: '#603C07',
    colorWarningBg: servoraAntSemanticBackgrounds.warning,
    controlHeight: 44,
    controlOutline: '#0084C3',
    controlOutlineWidth: 3,
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 16,
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
