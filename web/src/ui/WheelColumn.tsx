import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { WheelOption } from './wheel-datetime';

const ITEM_HEIGHT = 44;
const VISIBLE_ROWS = 5;
const SETTLE_TIMEOUT_MS = 140;

export type WheelColumnProps = {
  /** Accessible column name, e.g. `Saat`. */
  label: string;
  options: readonly WheelOption[];
  /** Selected option value; the item is scrolled to center. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}

function nearestEnabledIndex(options: readonly WheelOption[], index: number): number {
  if (options.length === 0) return 0;
  const start = clampIndex(index, options.length);
  if (!options[start]?.disabled) return start;
  for (let distance = 1; distance < options.length; distance += 1) {
    const below = start - distance;
    if (below >= 0 && !options[below]?.disabled) return below;
    const above = start + distance;
    if (above < options.length && !options[above]?.disabled) return above;
  }
  return start;
}

function stepEnabledIndex(
  options: readonly WheelOption[],
  from: number,
  delta: number,
): number {
  let index = from;
  let remaining = Math.abs(delta);
  const direction = delta > 0 ? 1 : -1;
  while (remaining > 0) {
    let candidate = index + direction;
    while (candidate >= 0 && candidate < options.length && options[candidate]?.disabled) {
      candidate += direction;
    }
    if (candidate < 0 || candidate >= options.length) break;
    index = candidate;
    remaining -= 1;
  }
  return index;
}

function firstEnabledIndex(options: readonly WheelOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex(options: readonly WheelOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return 0;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollColumnTo(element: HTMLElement, top: number, smooth: boolean): void {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    return;
  }
  element.scrollTop = top;
}

/**
 * One vertical scroll-snap wheel. The column itself is the focusable
 * `spinbutton`; the visible rows are pointer targets that stay out of the
 * accessibility tree so a screen reader hears one value, not 24 buttons.
 *
 * Spinbutton keys follow the ARIA contract: ArrowUp/PageUp/End increase the
 * value, ArrowDown/PageDown/Home decrease it, disabled boundary values are
 * skipped.
 */
export function WheelColumn({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: WheelColumnProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRef = useRef<() => void>(() => {});
  const animatingToRef = useRef<number | null>(null);
  const animationRetriesRef = useRef(0);
  const animateNextRef = useRef(false);

  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];
  const allDisabled = options.length === 0 || options.every((option) => option.disabled);

  function clearSettleTimer(): void {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function scheduleSettle(): void {
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      settleRef.current();
    }, SETTLE_TIMEOUT_MS);
  }

  function settle(): void {
    const scroller = scrollerRef.current;
    if (!scroller || disabled || allDisabled) return;
    const target = animatingToRef.current;
    if (target !== null) {
      if (Math.abs(scroller.scrollTop - target) > 2 && animationRetriesRef.current < 12) {
        animationRetriesRef.current += 1;
        scheduleSettle();
        return;
      }
      // Reached the programmatic target, or the user interrupted the animation.
      animatingToRef.current = null;
      animationRetriesRef.current = 0;
    }
    const rawIndex = clampIndex(Math.round(scroller.scrollTop / ITEM_HEIGHT), options.length);
    const index = nearestEnabledIndex(options, rawIndex);
    const option = options[index];
    if (!option) return;
    if (option.value !== value) {
      onChange(option.value);
      return;
    }
    const alignedTop = index * ITEM_HEIGHT;
    if (Math.abs(scroller.scrollTop - alignedTop) > 2) {
      scrollColumnTo(scroller, alignedTop, true);
    }
  }

  useEffect(() => {
    settleRef.current = settle;
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    function onScrollEnd() {
      clearSettleTimer();
      settleRef.current();
    }
    scroller.addEventListener('scrollend', onScrollEnd);
    return () => scroller.removeEventListener('scrollend', onScrollEnd);
  }, []);

  useEffect(() => () => clearSettleTimer(), []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = selectedIndex * ITEM_HEIGHT;
    if (Math.abs(scroller.scrollTop - target) <= 2) return;
    animatingToRef.current = target;
    animationRetriesRef.current = 0;
    scrollColumnTo(scroller, target, animateNextRef.current);
    animateNextRef.current = false;
  }, [selectedIndex]);

  function releaseAnimation(): void {
    animatingToRef.current = null;
    animationRetriesRef.current = 0;
    clearSettleTimer();
  }

  function selectIndex(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    animateNextRef.current = true;
    onChange(option.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled || allDisabled) return;
    let next = selectedIndex;
    switch (event.key) {
      case 'ArrowUp':
        next = stepEnabledIndex(options, selectedIndex, 1);
        break;
      case 'ArrowDown':
        next = stepEnabledIndex(options, selectedIndex, -1);
        break;
      case 'PageUp':
        next = stepEnabledIndex(options, selectedIndex, VISIBLE_ROWS);
        break;
      case 'PageDown':
        next = stepEnabledIndex(options, selectedIndex, -VISIBLE_ROWS);
        break;
      case 'Home':
        next = firstEnabledIndex(options);
        break;
      case 'End':
        next = lastEnabledIndex(options);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== selectedIndex) selectIndex(next);
  }

  return (
    <div
      ref={rootRef}
      className="wheel-column"
      data-wheel-column={label}
      role="spinbutton"
      tabIndex={disabled || allDisabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, options.length - 1)}
      aria-valuenow={selectedIndex}
      aria-valuetext={selectedOption?.label ?? ''}
      aria-disabled={disabled || allDisabled || undefined}
      onKeyDown={handleKeyDown}
    >
      <span className="wheel-column-highlight" aria-hidden="true" />
      <div
        ref={scrollerRef}
        className="wheel-column-scroller"
        tabIndex={-1}
        aria-hidden="true"
        onPointerDown={releaseAnimation}
        onTouchStart={releaseAnimation}
        onScroll={scheduleSettle}
      >
        {options.map((option, index) => (
          <span
            key={`${option.value}-${index}`}
            className="wheel-column-item"
            data-wheel-selected={option.value === value ? 'true' : undefined}
            data-wheel-disabled={option.disabled ? 'true' : undefined}
            onClick={() => {
              if (disabled || option.disabled) return;
              rootRef.current?.focus({ preventScroll: true });
              selectIndex(index);
            }}
          >
            {option.label}
          </span>
        ))}
      </div>
      <span className="wheel-column-fade wheel-column-fade--top" aria-hidden="true" />
      <span className="wheel-column-fade wheel-column-fade--bottom" aria-hidden="true" />
    </div>
  );
}
