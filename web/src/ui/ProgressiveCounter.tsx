import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { counterState } from './counter-policy';

/**
 * Shared progressive character counter.
 *
 * Hidden above 500 remaining; visible/muted at <= 500; attention styling at
 * <= 100. The visible span never uses a live region (no per-keypress chatter);
 * a separate visually-hidden live region announces the counter only when the
 * presentation state actually transitions.
 */
export function ProgressiveCounter({
  remaining,
  dataCounter,
  children,
}: {
  remaining: number;
  dataCounter: string;
  children: ReactNode;
}) {
  const state = counterState(remaining);
  const prevState = useRef(state);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (state !== prevState.current) {
      prevState.current = state;
      if (state !== 'hidden') setAnnounce(String(children));
    }
  }, [state, children]);
  if (state === 'hidden') return null;
  const counterProps = { [`data-${dataCounter}-counter`]: 'true' };
  return <>
    <span
      className={state === 'attention' ? 'field-guidance' : 'field-status'}
      data-counter-state={state}
      {...counterProps}
    >{children}</span>
    <span className="visually-hidden" aria-live="polite">{announce}</span>
  </>;
}
