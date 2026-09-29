import { useLayoutEffect, useRef, useState } from 'react';

import { trPhoneCaret, trPhoneDigits, trPhoneInitial, trPhoneMask } from './phone';

export type PhoneInputProps = {
  id: string;
  name: string;
  /** Stored value; canonical `+90…` values are shown masked, anything else verbatim. */
  defaultValue?: string | null;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange?: () => void;
};

/**
 * Masked Turkish phone input. The text is re-masked on every keystroke and the
 * caret is restored after the same digit, so editing in the middle and deleting
 * inside the grouping behave normally. The masked text is submitted untouched —
 * the server is the only place that decides what a phone number means.
 */
export function PhoneInput({
  id, name, defaultValue = '', disabled, required, invalid, describedBy, onChange,
}: PhoneInputProps) {
  const [value, setValue] = useState(() => trPhoneInitial(defaultValue));
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null) return;
    caretRef.current = null;
    inputRef.current?.setSelectionRange(caret, caret);
  }, [value]);

  return <input id={id} name={name} type="tel" inputMode="tel" autoComplete="tel"
    ref={inputRef} value={value} disabled={disabled} required={required}
    aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
    onChange={(event) => {
      const raw = event.currentTarget.value;
      const caret = event.currentTarget.selectionStart ?? raw.length;
      const masked = trPhoneMask(raw);
      const rawDigits = raw.replace(/\D/g, '');
      const digits = trPhoneDigits(raw);
      // Only a leading trunk `0` insertion (or no digit change at all) keeps the
      // digit positions aligned; a pasted prefix would move every digit, so the
      // caret goes to the end there instead of pointing at the wrong place.
      const aligned = digits === rawDigits || digits === `0${rawDigits}`;
      caretRef.current = aligned
        ? trPhoneCaret(masked, raw.slice(0, caret).replace(/\D/g, '').length + (digits === rawDigits ? 0 : 1))
        : masked.length;
      setValue(masked);
      onChange?.();
    }} />;
}
