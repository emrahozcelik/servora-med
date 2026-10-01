import { act } from 'react';

/**
 * Fills the Customer create phone field.
 *
 * `PhoneInput` re-masks on every change, so unlike the plain uncontrolled fields
 * elsewhere in these suites its `input` event has to be dispatched inside
 * `act()` and the resulting DOM value is the masked text.
 */
export async function setCustomerPhone(host: ParentNode, value: string) {
  const element = host.querySelector('#customer-phone');
  if (!(element instanceof HTMLInputElement)) throw new Error('#customer-phone bulunamadı.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Simulates an edit that leaves the caret somewhere inside the field: the value
 * is replaced and the selection placed at `caret` before the `input` event, so
 * the mask sees exactly what a real keystroke, paste or deletion would produce.
 *
 * Returns the resulting DOM value and caret.
 */
export async function editCustomerPhone(host: ParentNode, value: string, caret: number) {
  const element = host.querySelector('#customer-phone');
  if (!(element instanceof HTMLInputElement)) throw new Error('#customer-phone bulunamadı.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return { value: element.value, caret: element.selectionStart ?? -1 };
}
