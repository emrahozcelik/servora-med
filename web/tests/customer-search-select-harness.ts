/** Shared driver for the antd-based CustomerSearchSelect in flow tests. */
import { act } from 'react';
import { vi } from 'vitest';

import { CUSTOMER_SEARCH_DEBOUNCE_MS } from '../src/jobs/CustomerSearchSelect';

export function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, media: '', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

export async function settle() {
  await act(async () => { await Promise.resolve(); });
}

export async function settleCustomerSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, CUSTOMER_SEARCH_DEBOUNCE_MS + 120));
  });
  await settle();
}

export function openCustomerSearch(host: ParentNode, selectId: string) {
  const select = host.querySelector(`#${selectId}`) as HTMLElement | null;
  const content = select?.closest('.ant-select')?.querySelector('.ant-select-content') as HTMLElement | null;
  (content ?? select)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  (content ?? select)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

export async function openCustomerSearchDropdown(host: ParentNode, selectId: string) {
  await act(async () => { openCustomerSearch(host, selectId); });
  await settle();
}

export function typeCustomerSearch(host: ParentNode, text: string) {
  const select = host.querySelector('.ant-select .ant-select-input') as HTMLInputElement | null
    ?? host.querySelector('input.ant-select-input') as HTMLInputElement | null;
  if (!select) throw new Error('customer search input not found');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(select, text);
  select.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function searchCustomer(host: ParentNode, text: string) {
  await act(async () => { typeCustomerSearch(host, text); });
  await settleCustomerSearch();
}

export function customerOptionTitles() {
  return Array.from(document.querySelectorAll('.ant-select-item-option'))
    .map((node) => node.textContent ?? '');
}

export async function selectCustomerOption(index: number) {
  const option = document.querySelectorAll('.ant-select-item-option')[index] as HTMLElement;
  if (!option) throw new Error(`customer option ${index} not found`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Opens the selector, waits for the bounded first page, and picks the first result. */
export async function pickFirstCustomer(host: ParentNode, selectId: string) {
  await openCustomerSearchDropdown(host, selectId);
  await settleCustomerSearch();
  await selectCustomerOption(0);
}

/** Opens the selector and picks the option whose label contains the given name. */
export async function pickCustomerByName(host: ParentNode, selectId: string, name: string) {
  await openCustomerSearchDropdown(host, selectId);
  await settleCustomerSearch();
  const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
    .find((node) => (node.textContent ?? '').includes(name)) as HTMLElement | undefined;
  if (!option) throw new Error(`customer option "${name}" not found`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Fake-timer variant of the search settle for suites under vi.useFakeTimers(). */
export async function settleCustomerSearchWithFakeTimers() {
  await act(async () => { vi.advanceTimersByTime(CUSTOMER_SEARCH_DEBOUNCE_MS + 120); });
  await settle();
}

export async function pickCustomerByNameWithFakeTimers(host: ParentNode, selectId: string, name: string) {
  await openCustomerSearchDropdown(host, selectId);
  await settleCustomerSearchWithFakeTimers();
  const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
    .find((node) => (node.textContent ?? '').includes(name)) as HTMLElement | undefined;
  if (!option) throw new Error(`customer option "${name}" not found`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Clears a selection through the antd clear control (allowClear selectors). */
export async function clearCustomerSelection(host: ParentNode, selectId: string) {
  const clear = host.querySelector(`#${selectId}`)?.closest('.ant-select')
    ?.querySelector('.ant-select-clear') as HTMLElement | null;
  if (!clear) throw new Error('customer clear control not found');
  await act(async () => {
    clear.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}
