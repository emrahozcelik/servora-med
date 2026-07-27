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

/** Candidate A: Warm Professional palette tokens (CSS + sRGB bridge). */
export const candidateATokens = {
  color: {
    ink: {
      cssVariable: '--ink',
      cssValue: 'oklch(27% 0.012 260deg)',
      antValue: '#202833',
    },
    muted: {
      cssVariable: '--muted',
      cssValue: 'oklch(48% 0.015 260deg)',
      antValue: '#5B646D',
    },
    paper: {
      cssVariable: '--paper',
      cssValue: 'oklch(99% 0.003 90deg)',
      antValue: '#FCFCFC',
    },
    canvas: {
      cssVariable: '--canvas',
      cssValue: 'oklch(96% 0.008 90deg)',
      antValue: '#F1F3F0',
    },
    rule: {
      cssVariable: '--rule',
      cssValue: 'oklch(87% 0.01 105deg)',
      antValue: '#D3D9D1',
    },
    accent: {
      cssVariable: '--accent',
      cssValue: 'oklch(44% 0.12 255deg)',
      antValue: '#005B94',
    },
    accentHover: {
      cssVariable: '--accent-hover',
      cssValue: 'oklch(37% 0.12 255deg)',
      antValue: '#004A7B',
    },
    accentSoft: {
      cssVariable: '--accent-soft',
      cssValue: 'oklch(93% 0.02 255deg)',
      antValue: '#DCEAF7',
    },
    focus: {
      cssVariable: '--focus',
      cssValue: 'oklch(55% 0.14 255deg)',
      antValue: '#0081C8',
    },
    information: {
      cssVariable: '--info',
      cssValue: 'oklch(41% 0.10 255deg)',
      antValue: '#004F80',
    },
    informationSoft: {
      cssVariable: '--info-soft',
      cssValue: 'oklch(93% 0.02 255deg)',
      antValue: '#DCEAF7',
    },
    success: {
      cssVariable: '--success',
      cssValue: 'oklch(38% 0.09 155deg)',
      antValue: '#1E4E2C',
    },
    successSoft: {
      cssVariable: '--success-soft',
      cssValue: 'oklch(95.5% 0.025 155deg)',
      antValue: '#E4F5E7',
    },
    warning: {
      cssVariable: '--warning',
      cssValue: 'oklch(39% 0.09 75deg)',
      antValue: '#613D08',
    },
    warningSoft: {
      cssVariable: '--warning-soft',
      cssValue: 'oklch(95.5% 0.025 85deg)',
      antValue: '#F8EDDD',
    },
    error: {
      cssVariable: '--error',
      cssValue: 'oklch(42% 0.15 25deg)',
      antValue: '#8B2520',
    },
    errorSoft: {
      cssVariable: '--error-soft',
      cssValue: 'oklch(95.5% 0.022 25deg)',
      antValue: '#F8E9E8',
    },
  },
} as const satisfies {
  color: Record<string, ServoraColorToken>;
};

/** Candidate B: Clinical Cool palette tokens (CSS + sRGB bridge). */
export const candidateBTokens = {
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
} as const satisfies {
  color: Record<string, ServoraColorToken>;
};

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
