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
      cssValue: 'oklch(23% 0.018 250deg)',
      antValue: '#162028',
    },
    muted: {
      cssVariable: '--muted',
      cssValue: 'oklch(44% 0.02 250deg)',
      antValue: '#4F5A64',
    },
    paper: {
      cssVariable: '--paper',
      cssValue: 'oklch(99% 0.002 245deg)',
      antValue: '#FCFCFD',
    },
    canvas: {
      cssVariable: '--canvas',
      cssValue: 'oklch(94% 0.01 245deg)',
      antValue: '#E7ECF0',
    },
    rule: {
      cssVariable: '--rule',
      cssValue: 'oklch(83% 0.014 238deg)',
      antValue: '#C4CCD3',
    },
    accent: {
      cssVariable: '--accent',
      cssValue: 'oklch(41% 0.13 242deg)',
      antValue: '#005D8F',
    },
    accentHover: {
      cssVariable: '--accent-hover',
      cssValue: 'oklch(34% 0.13 242deg)',
      antValue: '#004B76',
    },
    accentSoft: {
      cssVariable: '--accent-soft',
      cssValue: 'oklch(91% 0.03 242deg)',
      antValue: '#D3E3F5',
    },
    focus: {
      cssVariable: '--focus',
      cssValue: 'oklch(53% 0.15 242deg)',
      antValue: '#007EC9',
    },
    information: {
      cssVariable: '--info',
      cssValue: 'oklch(37% 0.12 242deg)',
      antValue: '#004F7F',
    },
    informationSoft: {
      cssVariable: '--info-soft',
      cssValue: 'oklch(91% 0.03 242deg)',
      antValue: '#D3E3F5',
    },
    success: {
      cssVariable: '--success',
      cssValue: 'oklch(35% 0.09 150deg)',
      antValue: '#174A26',
    },
    successSoft: {
      cssVariable: '--success-soft',
      cssValue: 'oklch(94% 0.028 150deg)',
      antValue: '#D9EFDF',
    },
    warning: {
      cssVariable: '--warning',
      cssValue: 'oklch(38% 0.09 70deg)',
      antValue: '#5C3A07',
    },
    warningSoft: {
      cssVariable: '--warning-soft',
      cssValue: 'oklch(94% 0.028 78deg)',
      antValue: '#F4E9D5',
    },
    error: {
      cssVariable: '--error',
      cssValue: 'oklch(36% 0.16 28deg)',
      antValue: '#751E19',
    },
    errorSoft: {
      cssVariable: '--error-soft',
      cssValue: 'oklch(94% 0.028 28deg)',
      antValue: '#F5E4E2',
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
    focusWidthCss: '3px',
  },

  elevation: {
    /** Shared raised elevation for Ant theme and native `.surface-raised`. */
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
    focusWidthCss: string;
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
  '--focus-width',
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
