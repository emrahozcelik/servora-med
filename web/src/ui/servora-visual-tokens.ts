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
    /** Page frame behind the paper content column (html background). */
    frame: {
      cssVariable: '--frame',
      cssValue: 'oklch(97.5% 0.006 235deg)',
      antValue: '#F3F7FA',
    },
    /** Row/option hover tint between canvas and paper. */
    surfaceHover: {
      cssVariable: '--surface-hover',
      cssValue: 'oklch(97% 0.005 245deg)',
      antValue: '#F2F5F8',
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

    // Interactive-control boundaries. Passive grouping stays on --rule; a
    // control border is a distinct affordance and keeps its own value
    // (UI audit F-07).
    controlBorder: {
      cssVariable: '--border-control',
      cssValue: 'oklch(72% 0.018 240deg)',
      antValue: '#9BA6AF',
    },
    controlBorderHover: {
      cssVariable: '--border-control-hover',
      cssValue: 'oklch(60% 0.03 240deg)',
      antValue: '#718391',
    },

    // Semantic surface/chip borders. One level per state replaces the
    // accidental near-duplicate tints (UI audit F-07).
    accentBorder: {
      cssVariable: '--border-accent',
      cssValue: 'oklch(78% 0.04 238deg)',
      antValue: '#A0BCCE',
    },
    errorBorder: {
      cssVariable: '--border-error',
      cssValue: 'oklch(78% 0.07 28deg)',
      antValue: '#E1A79F',
    },
    warningBorder: {
      cssVariable: '--border-warning',
      cssValue: 'oklch(78% 0.06 70deg)',
      antValue: '#D1B18E',
    },
    successBorder: {
      cssVariable: '--border-success',
      cssValue: 'oklch(77% 0.065 150deg)',
      antValue: '#97C09F',
    },
    // Destructive controls need a stronger boundary than error surfaces.
    errorBorderStrong: {
      cssVariable: '--border-error-strong',
      cssValue: 'oklch(68% 0.1 28deg)',
      antValue: '#CF8075',
    },
    errorBorderEmphasis: {
      cssVariable: '--border-error-emphasis',
      cssValue: 'oklch(60% 0.14 28deg)',
      antValue: '#C65A4F',
    },

    // Overlay scrim: one tinted layer for dialogs, drawers, sheets and menus.
    scrim: {
      cssVariable: '--scrim',
      cssValue: 'oklch(26% 0.016 246deg / 48%)',
      antValue: 'rgba(30, 37, 43, 0.48)',
    },

    // Ordered severity ramp for report charts. The ageing buckets and the
    // warning meter read as one scale, so they share one token family
    // instead of five unrelated literals (UI audit F-07).
    chartGood: {
      cssVariable: '--chart-good',
      cssValue: 'oklch(62% 0.12 145deg)',
      antValue: '#549957',
    },
    chartCaution: {
      cssVariable: '--chart-caution',
      cssValue: 'oklch(70% 0.12 95deg)',
      antValue: '#B69D3A',
    },
    chartWarning: {
      cssVariable: '--chart-warning',
      cssValue: 'oklch(68% 0.14 70deg)',
      antValue: '#CE871B',
    },
    chartAlert: {
      cssVariable: '--chart-alert',
      cssValue: 'oklch(68% 0.14 55deg)',
      antValue: '#D97E38',
    },
    chartCritical: {
      cssVariable: '--chart-critical',
      cssValue: 'oklch(58% 0.16 25deg)',
      antValue: '#C74B47',
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
    /** Modal/dialog lift; one overlay shadow for every centered layer. */
    overlay: '0 1.5rem 4rem oklch(20% 0.02 240deg / 24%)',
    /** Directional lift for the edge-anchored mobile drawer. */
    drawer: '-0.75rem 0 2rem oklch(26% 0.016 246deg / 18%)',
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
  elevation: { raised: string; overlay: string; drawer: string };
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
  '--frame',
  '--surface-hover',
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
  '--border-control',
  '--border-control-hover',
  '--border-accent',
  '--border-error',
  '--border-warning',
  '--border-success',
  '--border-error-strong',
  '--border-error-emphasis',
  '--scrim',
  '--chart-good',
  '--chart-caution',
  '--chart-warning',
  '--chart-alert',
  '--chart-critical',
  '--control-height',
  '--radius-control',
  '--radius-button',
  '--radius-raised',
  '--radius-chip',
  '--shadow-raised',
  '--shadow-overlay',
  '--shadow-drawer',
] as const;
