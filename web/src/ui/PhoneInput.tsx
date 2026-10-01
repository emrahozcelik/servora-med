import { trPhoneEdit, trPhoneInitial } from './phone';

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
 * Masked Turkish phone input for NEW customer creation.
 *
 * The field is deliberately uncontrolled and re-masks itself imperatively on
 * every change. A React-controlled value would skip the re-render — and with it
 * any value-dependent effect — whenever deleting a single separator leaves the
 * masked text identical, so the raw text would stay on screen and the caret
 * would drift. Writing the masked text and the caret directly is deterministic:
 * React only rewrites the DOM when the rendered value differs, so the selection
 * survives.
 *
 * The masked text is submitted untouched — the server is the only place that
 * decides what a phone number means.
 */
export function PhoneInput({
  id, name, defaultValue = '', disabled, required, invalid, describedBy, onChange,
}: PhoneInputProps) {
  return <input id={id} name={name} type="tel" inputMode="tel" autoComplete="tel"
    defaultValue={trPhoneInitial(defaultValue)} disabled={disabled} required={required}
    aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
    onChange={(event) => {
      const input = event.currentTarget;
      const { value, caret } = trPhoneEdit(input.value, input.selectionStart ?? input.value.length);
      if (input.value !== value) input.value = value;
      input.setSelectionRange(caret, caret);
      onChange?.();
    }} />;
}
