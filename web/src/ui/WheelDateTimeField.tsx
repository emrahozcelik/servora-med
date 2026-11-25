import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

import { restoreFocus, trapTabKey } from './antd/overlay-focus';
import { useCompact } from './useResponsive';
import { WheelColumn } from './WheelColumn';
import {
  applyWheelColumnChange,
  buildWheelColumns,
  formatWheelDisplay,
  formatWheelValue,
  initialWheelSelection,
  type WheelContext,
  type WheelMode,
  type WheelSelection,
} from './wheel-datetime';
import './wheel-picker.css';

export type WheelDateTimeFieldProps = {
  mode: WheelMode;
  id: string;
  name: string;
  /** Native value contract: `YYYY-MM-DDTHH:mm`, `YYYY-MM-DD`, `HH:mm` or `''`. */
  value: string;
  onChange: (next: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  /** Minute granularity of the mobile minute wheel. Defaults to 5. */
  minuteStep?: number;
  label?: string;
  /** Hint/error wiring, identical to the native attribute. */
  'aria-describedby'?: string;
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
  minuteStep?: number;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onCommit: (selection: WheelSelection) => void;
};

function WheelSheet({
  mode,
  title,
  value,
  min,
  max,
  minuteStep,
  returnFocusRef,
  onCancel,
  onCommit,
}: WheelSheetProps): ReactNode {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const [context] = useState<WheelContext>(() => ({ now: new Date(), min, max, minuteStep }));
  const [draft, setDraft] = useState<WheelSelection>(() => (
    initialWheelSelection(mode, value, context)
  ));

  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const panel = panelRef.current;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocus(returnFocusRef, openerRef.current);
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      trapTabKey(event, panel);
    }
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, []);

  const columns = buildWheelColumns(mode, draft, context);

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
        </div>
        <div className="wheel-sheet-wheels" data-wheel-mode={mode}>
          {columns.map((column) => (
            <WheelColumn
              key={column.key}
              label={column.label}
              options={column.options}
              value={column.value}
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
          <button type="button" className="primary-button" onClick={() => onCommit(draft)}>Tamam</button>
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
  minuteStep,
  label,
  'aria-describedby': describedBy,
}: WheelDateTimeFieldProps) {
  const compact = useCompact();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Leaving compact mode swaps the trigger for the native input; a sheet left
  // open across that switch must not reappear on the way back.
  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

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
          aria-describedby={describedBy}
          className="form-control"
          onChange={(event) => onChange(event.target.value)}
        />
      </>
    );
  }

  const display = formatWheelDisplay(mode, value) || (value ? value : '');
  const labelText = label ?? MODE_TITLE[mode];

  return (
    <>
      {label && <label htmlFor={id} className="wheel-field-label">{label}</label>}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        name={name}
        className="wheel-field-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={describedBy}
        aria-label={`${labelText}${required ? ' (zorunlu)' : ''}: ${display || 'Seçin'}`}
        onClick={() => { if (!disabled) setOpen(true); }}
      >
        <WheelModeIcon mode={mode} />
        <span className={display ? 'wheel-field-value' : 'wheel-field-value wheel-field-placeholder'}>
          {display || 'Seçin'}
        </span>
      </button>
      {open && (
        <WheelSheet
          mode={mode}
          title={labelText}
          value={value}
          min={min}
          max={max}
          minuteStep={minuteStep}
          returnFocusRef={triggerRef}
          onCancel={() => setOpen(false)}
          onCommit={(selection) => {
            onChange(formatWheelValue(mode, selection));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
