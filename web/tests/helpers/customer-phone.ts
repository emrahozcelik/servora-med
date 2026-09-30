import { act } from 'react';

/**
 * Fills the Customer create phone field.
 *
 * `PhoneInput` validates every change, so unlike the plain uncontrolled fields
 * elsewhere in these suites its `input` event is dispatched inside `act()`.
 */
export async function setCustomerPhone(host: ParentNode, value: string) {
  const element = host.querySelector('#customer-phone');
  if (!(element instanceof HTMLInputElement)) throw new Error('#customer-phone bulunamadı.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
