import { App as AntApp, ConfigProvider } from 'antd';
import trTR from 'antd/es/locale/tr_TR';
import { useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import { getServoraAntTheme } from './servora-ant-theme';

export const SERVORA_ANT_PREFIX = 'servora-ant';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const syncPreference = () => setPrefersReducedMotion(mediaQuery.matches);

    syncPreference();
    mediaQuery.addEventListener('change', syncPreference);
    return () => mediaQuery.removeEventListener('change', syncPreference);
  }, []);

  return prefersReducedMotion;
}

export function getServoraPopupContainer() {
  return document.body;
}

export function ServoraAntProvider({ children }: PropsWithChildren) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const resolvedTheme = useMemo(
    () => getServoraAntTheme(prefersReducedMotion),
    [prefersReducedMotion],
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
