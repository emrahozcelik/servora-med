import { useRef } from 'react';

import { customerPhoneInputValue } from './phone';

export type PhoneInputProps = {
  id: string;
  name: string;
  defaultValue?: string | null;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange?: () => void;
};

/**
 * Customer create input: one automatic trunk `0` followed by ten user digits.
 * Non-digits and an eleventh user digit are rejected without changing the last
 * accepted value. The resulting 11-digit national value is submitted directly.
 */
export function PhoneInput({
  id, name, defaultValue = '', disabled, required, invalid, describedBy, onChange,
}: PhoneInputProps) {
  const initialValue = customerPhoneInputValue(defaultValue ?? '', '0');
  const lastAcceptedValue = useRef(initialValue);

  return <input id={id} name={name} type="tel" inputMode="numeric" autoComplete="tel-national"
    defaultValue={initialValue} maxLength={11} pattern="0[1-9][0-9]{9}"
    disabled={disabled} required={required}
    aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
    onChange={(event) => {
      const input = event.currentTarget;
      const value = customerPhoneInputValue(input.value, lastAcceptedValue.current);
      if (input.value !== value) {
        input.value = value;
        input.setSelectionRange(value.length, value.length);
      }
      lastAcceptedValue.current = value;
      onChange?.();
    }} />;
}
