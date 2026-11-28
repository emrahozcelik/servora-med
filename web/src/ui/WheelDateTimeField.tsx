import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

import { restoreFocus, trapTabKey } from './antd/overlay-focus';
import { lockBodyScroll } from './scroll-lock';
import { useNarrowShell } from './useResponsive';
import { WheelColumn } from './WheelColumn';
import {
  applyWheelColumnChange,
  buildWheelColumns,
  formatWheelDisplay,
  formatWheelValue,
  initialWheelSelection,
  resolveSelection,
  type WheelColumnKey,
  type WheelContext,
  type WheelMode,
  type WheelSelection,
} from './wheel-datetime';
import './wheel-picker.css';

export type WheelDateTimeFieldProps = {
  mode: WheelMode;
  id: string;
  /** Native form name; omitted exactly when the replaced input had no name. */
  name?: string;
  /** Native value contract: `YYYY-MM-DDTHH:mm`, `YYYY-MM-DD`, `HH:mm` or `''`. */
  value: string;
  onChange: (next: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  /** Server/page-owned error state, mirrored to `aria-invalid` on both branches. */
  invalid?: boolean;
  /** Minute granularity of the mobile minute wheel. Defaults to 5. */
  minuteStep?: number;
  label?: string;
  /** Accessible name for an external visible label (compact trigger). */
  ariaLabel?: string;
  /** Hint/error wiring, identical to the native attribute. */
  'aria-describedby'?: string;
  /** The rendered interactive control (native input or compact trigger). */
  controlRef?: RefObject<HTMLElement | null>;
};

const MODE_INPUT_TYPE: Record<WheelMode, 'datetime-local' | 'date' | 'time'> = {
  datetime: 'datetime-local',
  date: 'date',
  time: 'time',
};

const MODE_TITLE: Record<WheelMode, string> = {
  datetime: 'Tarih ve saat',
  date: 'Tarih',
  time: 'Saat',
};

const MODE_REQUIRED_MESSAGE: Record<WheelMode, string> = {
  datetime: 'Tarih ve saat seçin.',
  date: 'Tarih seçin.',
  time: 'Saat seçin.',
};

/**
 * `invalid` fires for every failing control during one submit. Only the first
 * one may move focus. The browser can run microtask checkpoints between those
 * listeners, so the claim is released with a macrotask after the submit.
 */
let invalidFocusClaimed = false;
let invalidFocusResetTimer: ReturnType<typeof setTimeout> | null = null;

function claimInvalidFocus(): boolean {
  if (invalidFocusClaimed) return false;
  invalidFocusClaimed = true;
  if (invalidFocusResetTimer !== null) clearTimeout(invalidFocusResetTimer);
  invalidFocusResetTimer = setTimeout(() => {
    invalidFocusClaimed = false;
    invalidFocusResetTimer = null;
  }, 0);
  return true;
}

const MODE_CLOSE_LABEL: Record<WheelMode, string> = {
  datetime: 'Tarih ve saat seçimini kapat',
  date: 'Tarih seçimini kapat',
  time: 'Saat seçimini kapat',
};

function WheelModeIcon({ mode }: { mode: WheelMode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {mode === 'time' ? (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 1.8" />
        </>
      ) : (
        <>
          <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
          <path d="M8 3.5v4M16 3.5v4M4 10h16" />
          {mode === 'datetime' && <path d="M12 13v3.2l2 1.2" />}
        </>
      )}
    </svg>
  );
}

type WheelSheetProps = {
  mode: WheelMode;
  title: string;
  value: string;
  min?: string;
  max?: string;
  required?: boolean;
  minuteStep?: number;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onClear: () => void;
  onCommit: (value: string) => void;
};

type WheelResolver = () => string | null;

function WheelSheet({
  mode,
  title,
  value,
  min,
  max,
  required,
  minuteStep,
  returnFocusRef,
  onCancel,
  onClear,
  onCommit,
}: WheelSheetProps): ReactNode {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const dayResolver = useRef<WheelResolver | null>(null);
  const monthResolver = useRef<WheelResolver | null>(null);
  const yearResolver = useRef<WheelResolver | null>(null);
  const hourResolver = useRef<WheelResolver | null>(null);
  const minuteResolver = useRef<WheelResolver | null>(null);
  const resolverFor: Record<WheelColumnKey, { current: WheelResolver | null }> = {
    day: dayResolver,
    month: monthResolver,
    year: yearResolver,
    hour: hourResolver,
    minute: minuteResolver,
  };
  const [context] = useState<WheelContext>(() => ({ now: new Date(), min, max, minuteStep }));
  const [draft, setDraft] = useState<WheelSelection>(() => (
    initialWheelSelection(mode, value, context)
  ));

  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (openerRef.current === null && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement;
    }
    const releaseScrollLock = lockBodyScroll();
    panel?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus();
    return () => {
      releaseScrollLock();
      // Strict Mode can replay setup while this sheet is still mounted.
      // Return to the trigger only when the sheet has actually closed.
      if (!panel?.isConnected) restoreFocus(returnFocusRef, openerRef.current);
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        // A picker can sit inside a form drawer; only this sheet dismisses.
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      trapTabKey(event, panel);
    }
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, []);

  const columns = buildWheelColumns(mode, draft, context);

  function commitDraft(): void {
    // Flush every wheel's current center synchronously, then let the shared
    // resolveSelection rule own the single min/max clamp. Applying each column
    // with its own bounds would let a stale minute wheel overwrite the
    // hour/minute a day or hour clamp had just produced.
    const rawContext: WheelContext = { ...context, min: undefined, max: undefined };
    let parts = draft;
    let changedColumn: WheelColumnKey = columns[columns.length - 1]!.key;
    for (const column of columns) {
      const resolve = resolverFor[column.key].current;
      const centered = resolve?.();
      if (centered !== null && centered !== undefined) {
        parts = applyWheelColumnChange(mode, parts, column.key, centered, rawContext);
        changedColumn = column.key;
      }
    }
    const resolved = resolveSelection(mode, parts, changedColumn, context);
    onCommit(formatWheelValue(mode, resolved));
  }

  return (
    <div className="wheel-sheet-root" data-servora-wheel-sheet="true">
      <button
        type="button"
        className="wheel-sheet-backdrop"
        aria-label={MODE_CLOSE_LABEL[mode]}
        onClick={onCancel}
      />
      <div
        ref={panelRef}
        className="wheel-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="wheel-sheet-header">
          <h2 id={titleId}>{title}</h2>
          {!required && value !== '' && (
            <button type="button" className="wheel-sheet-clear" onClick={onClear}>
              Temizle
            </button>
          )}
        </div>
        <div className="wheel-sheet-wheels" data-wheel-mode={mode}>
          {columns.map((column) => (
            <WheelColumn
              key={column.key}
              label={column.label}
              options={column.options}
              value={column.value}
              resolveRef={resolverFor[column.key]}
              onChange={(next) => {
                setDraft((current) => applyWheelColumnChange(
                  mode, current, column.key, next, context,
                ));
              }}
            />
          ))}
        </div>
        <div className="wheel-sheet-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Vazgeç</button>
          <button type="button" className="primary-button" onClick={commitDraft}>Tamam</button>
        </div>
      </div>
    </div>
  );
}

/**
 * One date/time field with a native desktop input and an Apple-style wheel
 * bottom sheet on compact viewports. Both branches use the same value contract,
 * so a form can swap its native input without changing state handling.
 */
export function WheelDateTimeField({
  mode,
  id,
  name,
  value,
  onChange,
  min,
  max,
  required,
  disabled,
  invalid,
  minuteStep,
  label,
  ariaLabel,
  'aria-describedby': describedBy,
  controlRef,
}: WheelDateTimeFieldProps) {
  const compact = useNarrowShell();
  const [open, setOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const errorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const proxyRef = useRef<HTMLInputElement>(null);
  const requiredMessage = MODE_REQUIRED_MESSAGE[mode];
  const setTriggerNode = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (controlRef) controlRef.current = node;
  }, [controlRef]);
  const setInputNode = useCallback((node: HTMLInputElement | null) => {
    if (controlRef) controlRef.current = node;
  }, [controlRef]);

  // Leaving compact mode swaps the trigger for the native input; a sheet left
  // open across that switch must not reappear on the way back.
  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  // The clipped carrier owns native validation, so its `invalid` event is the
  // only signal a compact form gets. Suppress the browser's off-screen bubble,
  // surface the reason on the visible trigger and move focus there once.
  useEffect(() => {
    const proxy = proxyRef.current;
    if (!proxy) return;
    function onInvalid(event: Event) {
      event.preventDefault();
      const input = event.currentTarget as HTMLInputElement;
      const minLabel = min ? formatWheelDisplay(mode, min) : '';
      const maxLabel = max ? formatWheelDisplay(mode, max) : '';
      let message = requiredMessage;
      if (!input.validity.valueMissing) {
        if (input.validity.rangeUnderflow && minLabel) {
          message = `En erken: ${minLabel}`;
        } else if (input.validity.rangeOverflow && maxLabel) {
          message = `En geç: ${maxLabel}`;
        }
      }
      setValidationError(message);
      if (claimInvalidFocus()) triggerRef.current?.focus();
    }
    proxy.addEventListener('invalid', onInvalid);
    return () => proxy.removeEventListener('invalid', onInvalid);
  }, [compact, max, min, mode, requiredMessage]);

  if (!compact) {
    return (
      <>
        {label && <label htmlFor={id} className="wheel-field-label">{label}</label>}
        <input
          id={id}
          name={name}
          type={MODE_INPUT_TYPE[mode]}
          value={value}
          min={min}
          max={max}
          required={required}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="form-control"
          ref={setInputNode}
          onChange={(event) => {
            setValidationError(null);
            onChange(event.target.value);
          }}
        />
      </>
    );
  }

  const display = formatWheelDisplay(mode, value) || (value ? value : '');
  const labelText = ariaLabel ?? label ?? MODE_TITLE[mode];
  const describedByIds = [describedBy, validationError ? errorId : undefined]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <>
      {label && <label htmlFor={id} className="wheel-field-label">{label}</label>}
      <button
        ref={setTriggerNode}
        type="button"
        id={id}
        className="wheel-field-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={validationError || invalid ? true : undefined}
        aria-describedby={describedByIds}
        aria-label={`${labelText}${required ? ' (zorunlu)' : ''}: ${display || 'Seçin'}`}
        onClick={() => { if (!disabled) setOpen(true); }}
      >
        <WheelModeIcon mode={mode} />
        <span className={display ? 'wheel-field-value' : 'wheel-field-value wheel-field-placeholder'}>
          {display || 'Seçin'}
        </span>
      </button>
      {/*
        Form carrier: the visible trigger is a button and cannot submit a value
        or take part in constraint validation. This clipped native control
        keeps `FormData` and `required`/`min`/`max` behavior of the input it
        replaces without exposing a second control to assistive technology.
      */}
      <input
        ref={proxyRef}
        type={MODE_INPUT_TYPE[mode]}
        name={name}
        value={value}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="wheel-field-proxy"
        onChange={() => {}}
      />
      {validationError && (
        <p id={errorId} className="field-error" role="alert">{validationError}</p>
      )}
      {open && (
        <WheelSheet
          mode={mode}
          title={labelText}
          value={value}
          min={min}
          max={max}
          required={required}
          minuteStep={minuteStep}
          returnFocusRef={triggerRef}
          onCancel={() => setOpen(false)}
          onClear={() => {
            setValidationError(null);
            onChange('');
            setOpen(false);
          }}
          onCommit={(next) => {
            setValidationError(null);
            onChange(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
