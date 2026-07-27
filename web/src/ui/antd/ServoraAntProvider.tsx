import { App as AntApp, ConfigProvider } from 'antd';
import trTR from 'antd/es/locale/tr_TR';
import { useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import { getServoraAntTheme } from './servora-ant-theme';

export const SERVORA_ANT_PREFIX = 'servora-ant';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    readReducedMotionPreference,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

export function getServoraPopupContainer() {
  return document.body;
}

function readPalette(): 'a' | 'b' | undefined {
  if (typeof document === 'undefined') return undefined;
  const ds = document.documentElement.dataset.palette;
  if (ds === 'a' || ds === 'b') return ds;
  const hash = window.location.hash;
  if (hash === '#palette-a') return 'a';
  if (hash === '#palette-b') return 'b';
  return undefined;
}

export function ServoraAntProvider({ children }: PropsWithChildren) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [palette] = useState<'a' | 'b' | undefined>(readPalette);
  const resolvedTheme = useMemo(
    () => getServoraAntTheme({ palette, reducedMotion: prefersReducedMotion }),
    [prefersReducedMotion, palette],
  );

  return (
    <ConfigProvider
      getPopupContainer={getServoraPopupContainer}
      locale={trTR}
      prefixCls={SERVORA_ANT_PREFIX}
      theme={resolvedTheme}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
