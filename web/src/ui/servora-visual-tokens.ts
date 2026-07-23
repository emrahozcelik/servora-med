/**
 * Machine-readable Servora visual token contract.
 *
 * Maps DESIGN.md semantic names → CSS custom properties (OKLCH) → Ant sRGB bridge.
 * Not a second design system. Feature screens must not import this module;
 * native UI continues to consume CSS variables (var(--accent), …).
 * Allowed importers: web/src/ui/antd/** and web/tests/**.
 */

export const SERVORA_SEMANTIC_STATES = [
  'information',
  'success',
  'warning',
  'error',
] as const;

export type ServoraSemanticState = (typeof SERVORA_SEMANTIC_STATES)[number];

export type ServoraColorToken = Readonly<{
  cssVariable: `--${string}`;
  /** Canonical CSS value (OKLCH preferred). */
  cssValue: string;
  /** Ant Design / sRGB bridge value. */
  antValue: string;
}>;

export const servoraVisualTokens = {
  color: {
    ink: {
      cssVariable: '--ink',
      cssValue: 'oklch(26% 0.016 246deg)',
      antValue: '#1E252B',
    },
    muted: {
      cssVariable: '--muted',
      cssValue: 'oklch(47% 0.018 246deg)',
      antValue: '#535C65',
    },
    paper: {
      cssVariable: '--paper',
      cssValue: 'oklch(98.5% 0.004 235deg)',
      antValue: '#F8FBFC',
    },
    canvas: {
      cssVariable: '--canvas',
      cssValue: 'oklch(95.5% 0.009 235deg)',
      antValue: '#EBF1F5',
    },
    rule: {
      cssVariable: '--rule',
      cssValue: 'oklch(86% 0.012 238deg)',
      antValue: '#CAD2D8',
    },
    accent: {
      cssVariable: '--accent',
      cssValue: 'oklch(47% 0.105 238deg)',
      antValue: '#00628E',
    },
    accentHover: {
      cssVariable: '--accent-hover',
      cssValue: 'oklch(41% 0.105 238deg)',
      antValue: '#00507C',
    },
    accentSoft: {
      cssVariable: '--accent-soft',
      cssValue: 'oklch(92% 0.025 238deg)',
      antValue: '#D6E7F4',
    },
    focus: {
      cssVariable: '--focus',
      cssValue: 'oklch(58% 0.14 238deg)',
      antValue: '#0084C3',
    },
    information: {
      cssVariable: '--info',
      cssValue: 'oklch(41% 0.105 238deg)',
      antValue: '#00507C',
    },
    informationSoft: {
      cssVariable: '--info-soft',
      cssValue: 'oklch(92% 0.025 238deg)',
      antValue: '#D6E7F4',
    },
    success: {
      cssVariable: '--success',
      cssValue: 'oklch(38% 0.08 150deg)',
      antValue: '#1D4E2B',
    },
    successSoft: {
      cssVariable: '--success-soft',
      cssValue: 'oklch(95% 0.025 150deg)',
      antValue: '#E3F4E6',
    },
    warning: {
      cssVariable: '--warning',
      cssValue: 'oklch(39% 0.08 70deg)',
      antValue: '#603C07',
    },
    warningSoft: {
      cssVariable: '--warning-soft',
      cssValue: 'oklch(95% 0.025 80deg)',
      antValue: '#F7EDDC',
    },
    error: {
      cssVariable: '--error',
      cssValue: 'oklch(44% 0.14 28deg)',
      antValue: '#902822',
    },
    errorSoft: {
      cssVariable: '--error-soft',
      cssValue: 'oklch(95% 0.025 28deg)',
      antValue: '#F8E9E7',
    },
  },

  control: {
    heightPx: 44,
    heightCss: '2.75rem',
    radiusPx: 10,
    radiusControlCss: '0.6rem',
    radiusButtonCss: '0.6rem',
    radiusRaisedCss: '0.75rem',
    radiusChipCss: '999px',
    focusWidthPx: 3,
  },

  elevation: {
    /** Ant bridge + CSS --shadow-raised. Native .surface-raised may still use a local OKLCH shadow until T1B. */
    raised: '0 8px 24px rgba(30, 37, 43, 0.12)',
  },

  typography: {
    fontFamily:
      'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    bodySizePx: 16,
  },
} as const satisfies {
  color: Record<string, ServoraColorToken>;
  control: {
    heightPx: number;
    heightCss: string;
    radiusPx: number;
    radiusControlCss: string;
    radiusButtonCss: string;
    radiusRaisedCss: string;
    radiusChipCss: string;
    focusWidthPx: number;
  };
  elevation: { raised: string };
  typography: { fontFamily: string; bodySizePx: number };
};

/** Semantic foreground/background pairs for Ant bridge and contrast tests. */
export const servoraSemanticColorPairs = {
  information: {
    foreground: servoraVisualTokens.color.information,
    soft: servoraVisualTokens.color.informationSoft,
  },
  success: {
    foreground: servoraVisualTokens.color.success,
    soft: servoraVisualTokens.color.successSoft,
  },
  warning: {
    foreground: servoraVisualTokens.color.warning,
    soft: servoraVisualTokens.color.warningSoft,
  },
  error: {
    foreground: servoraVisualTokens.color.error,
    soft: servoraVisualTokens.color.errorSoft,
  },
} as const satisfies Record<
  ServoraSemanticState,
  { foreground: ServoraColorToken; soft: ServoraColorToken }
>;

/** CSS custom properties that must appear exactly once under :root. */
export const SERVORA_REQUIRED_CSS_VARIABLES = [
  '--ink',
  '--muted',
  '--paper',
  '--canvas',
  '--rule',
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--focus',
  '--info',
  '--info-soft',
  '--success',
  '--success-soft',
  '--warning',
  '--warning-soft',
  '--error',
  '--error-soft',
  '--control-height',
  '--radius-control',
  '--radius-button',
  '--radius-raised',
  '--radius-chip',
  '--shadow-raised',
] as const;
