/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  CUSTOMER_SEARCH_PAGE_SIZE,
  CustomerSearchSelect,
} from '../src/jobs/CustomerSearchSelect';
import type { CustomerSummary } from '../src/services/crm-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const crm = vi.hoisted(() => ({ listCustomers: vi.fn(), getCustomer: vi.fn() }));

vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(),
  listCustomers: crm.listCustomers,
  getCustomer: crm.getCustomer,
}));

function makeSummary(index: number, overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return {
    id: `customer-${index}`,
    organizationId: 'org-1',
    name: `Müşteri ${index}`,
    customerType: 'clinic',
    taxNumber: null,
    phone: `053200000${String(index).padStart(2, '0')}`,
    email: null,
    city: 'İstanbul',
    district: null,
    address: null,
    assignedStaffUserId: null,
    status: 'active',
    version: 1,
    assignedStaffName: null,
    primaryContact: null,
    ...overrides,
  };
}

function page(items: CustomerSummary[], total: number, offset = 0) {
  return { items, total, limit: CUSTOMER_SEARCH_PAGE_SIZE, offset };
}

describe('CustomerSearchSelect shared remote selector', () => {
  let root: Root;
  let host: HTMLDivElement;
  let onChange: ReturnType<typeof vi.fn>;
  let onCustomerResolved: ReturnType<typeof vi.fn>;
  let onReadyChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    crm.listCustomers.mockResolvedValue(page([], 0));
    crm.getCustomer.mockRejectedValue(new Error('bulunamadı'));
    onChange = vi.fn();
    onCustomerResolved = vi.fn();
    onReadyChange = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  async function renderSelector(props: {
    value?: string; pinnedCustomer?: CustomerSummary | null; allowClear?: boolean;
    invalid?: boolean; describedBy?: string;
    clearValueWhenMissing?: boolean; isEligible?: (customer: CustomerSummary) => boolean;
  } = {}) {
    await act(async () => {
      root.render(
        <ConfigProvider>
          <label htmlFor="customer-search">Müşteri</label>
          <CustomerSearchSelect
            id="customer-search"
            value={props.value ?? ''}
            onChange={onChange}
            onCustomerResolved={onCustomerResolved}
            pinnedCustomer={props.pinnedCustomer}
            onReadyChange={onReadyChange}
            allowClear={props.allowClear}
            invalid={props.invalid}
            describedBy={props.describedBy}
            clearValueWhenMissing={props.clearValueWhenMissing}
            isEligible={props.isEligible}
          />
          {props.describedBy && <span id={props.describedBy} className="field-error">Hata</span>}
        </ConfigProvider>,
      );
    });
    await flush();
  }

  async function flush() {
    await act(async () => { await Promise.resolve(); });
  }

  async function settleDebounce() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CUSTOMER_SEARCH_DEBOUNCE_MS + 120));
    });
    await flush();
  }

  function openDropdown() {
    const selector = host.querySelector('.ant-select-content') as HTMLElement;
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    selector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  async function open() {
    await act(async () => { openDropdown(); });
    await flush();
  }

  function typeSearch(text: string) {
    const input = host.querySelector('input.ant-select-input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function search(text: string) {
    await act(async () => { typeSearch(text); });
    await settleDebounce();
  }

  function options() {
    return Array.from(document.querySelectorAll('.ant-select-item-option'));
  }

  function optionTitles() {
    return options().map((node) => node.textContent ?? '');
  }

  async function clickOption(index: number) {
    await act(async () => {
      options()[index]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      options()[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  }

  function scrollDropdownToBottom() {
    const dropdown = document.querySelector('.ant-select-dropdown') as HTMLElement;
    const scroller = (dropdown.querySelector('[class*="virtual-list-holder"]') as HTMLElement) ?? dropdown;
    // jsdom reports zero scroll metrics, so any positive scrollTop reads as "near bottom".
    scroller.scrollTop = 9999;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  it('loads only a bounded first page on open, without a full-catalog loop', async () => {
    crm.listCustomers.mockResolvedValue(page([makeSummary(1), makeSummary(2)], 2));
    await renderSelector();
    await open();
    await settleDebounce();
    expect(crm.listCustomers).toHaveBeenCalledTimes(1);
    expect(crm.listCustomers).toHaveBeenCalledWith({ limit: CUSTOMER_SEARCH_PAGE_SIZE, offset: 0 });
    expect(CUSTOMER_SEARCH_PAGE_SIZE).toBeLessThanOrEqual(50);
    expect(optionTitles().join(' ')).toContain('Müşteri 1');
    const offsets = crm.listCustomers.mock.calls.map((call) => (call[0] as { offset: number }).offset);
    expect(offsets).toEqual([0]);
  });

  it('sends the typed text as a server q query', async () => {
    crm.listCustomers.mockResolvedValue(page([], 0));
    await renderSelector();
    await open();
    await settleDebounce();
    crm.listCustomers.mockClear();
    crm.listCustomers.mockResolvedValue(page([makeSummary(7, { name: 'Denta Star' })], 1));
    await search('denta');
    expect(crm.listCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'denta', limit: CUSTOMER_SEARCH_PAGE_SIZE, offset: 0 }),
    );
    expect(optionTitles().join(' ')).toContain('Denta Star');
  });

  it('debounces rapid typing into a single request with the final text', async () => {
    crm.listCustomers.mockResolvedValue(page([], 0));
    await renderSelector();
    await open();
    await settleDebounce();
    crm.listCustomers.mockClear();
    await act(async () => {
      typeSearch('d');
      await new Promise((resolve) => setTimeout(resolve, 60));
      typeSearch('de');
      await new Promise((resolve) => setTimeout(resolve, 60));
      typeSearch('den');
    });
    await settleDebounce();
    const queries = crm.listCustomers.mock.calls.map((call) => (call[0] as { q?: string }).q);
    expect(queries).toEqual(['den']);
  });

  it('prevents a stale earlier response from overwriting a newer query', async () => {
    let resolveSlow!: (value: unknown) => void;
    const slow = new Promise((resolve) => { resolveSlow = resolve; });
    crm.listCustomers.mockImplementation((filters: { q?: string }) => {
      if ((filters.q ?? '') === 'den') return slow as Promise<never>;
      return Promise.resolve(page([makeSummary(9, { name: 'Denta Yeni' })], 1));
    });
    await renderSelector();
    await open();
    await settleDebounce();
    await act(async () => { typeSearch('den'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, CUSTOMER_SEARCH_DEBOUNCE_MS + 120)); });
    await act(async () => { typeSearch('denta'); });
    await settleDebounce();
    await act(async () => { resolveSlow(page([makeSummary(1, { name: 'Eski Sonuç' })], 1)); });
    await flush();
    expect(optionTitles().join(' ')).toContain('Denta Yeni');
    expect(optionTitles().join(' ')).not.toContain('Eski Sonuç');
  });

  it('selects a customer and reports its summary', async () => {
    const summary = makeSummary(3, { name: 'Seçilen Klinik', assignedStaffUserId: 'staff-9' });
    crm.listCustomers.mockResolvedValue(page([summary], 1));
    await renderSelector();
    await open();
    await settleDebounce();
    await clickOption(0);
    expect(onChange).toHaveBeenCalledWith('customer-3');
    expect(onCustomerResolved).toHaveBeenCalledWith(expect.objectContaining({
      id: 'customer-3', assignedStaffUserId: 'staff-9',
    }));
  });

  it('keeps the selected customer visible after the query changes', async () => {
    const summary = makeSummary(3, { name: 'Seçilen Klinik' });
    crm.listCustomers.mockResolvedValue(page([summary], 1));
    await renderSelector();
    await open();
    await settleDebounce();
    await clickOption(0);
    crm.listCustomers.mockResolvedValue(page([makeSummary(8, { name: 'Başka Klinik' })], 1));
    await search('başka');
    const titles = optionTitles().join(' ');
    expect(titles).toContain('Seçilen Klinik');
    expect(titles).toContain('Başka Klinik');
  });

  it('clears the selection when allowed', async () => {
    const summary = makeSummary(3, { name: 'Seçilen Klinik' });
    crm.listCustomers.mockResolvedValue(page([summary], 1));
    await renderSelector({ value: 'customer-3', pinnedCustomer: summary, allowClear: true });
    expect(onCustomerResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'customer-3' }));
    const clear = host.querySelector('.ant-select-clear') as HTMLElement;
    expect(clear).not.toBeNull();
    await act(async () => {
      clear.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(onChange).toHaveBeenCalledWith('');
    expect(onCustomerResolved).toHaveBeenCalledWith(null);
  });

  it('keeps a valid selection when a later search fails, with a retry path', async () => {
    const summary = makeSummary(3, { name: 'Seçilen Klinik' });
    crm.listCustomers.mockResolvedValue(page([summary], 1));
    await renderSelector();
    await open();
    await settleDebounce();
    await clickOption(0);
    crm.listCustomers.mockRejectedValue(new Error('ağ hatası'));
    await search('bozuk');
    expect(onChange).toHaveBeenCalledTimes(1);
    const titles = optionTitles().join(' ');
    expect(titles).toContain('Seçilen Klinik');
    expect(document.body.textContent ?? '').toContain('Tekrar dene');
    crm.listCustomers.mockResolvedValue(page([summary], 1));
    const retry = Array.from(document.querySelectorAll('.inline-action'))
      .find((node) => node.textContent === 'Tekrar dene') as HTMLElement;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(crm.listCustomers).toHaveBeenCalledWith(expect.objectContaining({ q: 'bozuk', offset: 0 }));
  });

  it('shows an explicit no-result state and never auto-creates', async () => {
    crm.listCustomers.mockResolvedValue(page([], 0));
    await renderSelector();
    await open();
    await settleDebounce();
    await search('zzz-eslesen-yok');
    expect(document.body.textContent ?? '').toContain('Sonuç bulunamadı');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCustomerResolved).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));
  });

  it('paginates with load-more and deduplicates by id', async () => {
    const first = Array.from({ length: 20 }, (_, index) => makeSummary(index + 1));
    const second = [
      { ...makeSummary(20), name: 'KOPYA-20' },
      { ...makeSummary(19), name: 'KOPYA-19' },
      ...Array.from({ length: 5 }, (_, index) => makeSummary(index + 21)),
    ];
    crm.listCustomers.mockImplementation((filters: { offset: number }) => Promise.resolve(
      filters.offset === 0 ? page(first, 25, 0) : page(second, 25, 20),
    ));
    await renderSelector();
    await open();
    await settleDebounce();
    expect(document.body.textContent ?? '').toContain('Müşteri 1');
    await act(async () => { scrollDropdownToBottom(); });
    await flush();
    expect(crm.listCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: CUSTOMER_SEARCH_PAGE_SIZE, offset: 20 }),
    );
    // Appended page is reachable …
    expect(document.body.textContent ?? '').toContain('Müşteri 21');
    // … while duplicate ids keep their first occurrence (no KOPYA rows rendered).
    const scroller = document.querySelector('.ant-select-dropdown [class*="virtual-list-holder"]')
      ?? document.querySelector('.ant-select-dropdown') as HTMLElement;
    (scroller as HTMLElement).scrollTop = 0;
    await act(async () => { (scroller as HTMLElement).dispatchEvent(new Event('scroll', { bubbles: true })); });
    await flush();
    expect(document.body.textContent ?? '').not.toContain('KOPYA');
  });

  it('resolves an initial customer through direct lookup without a catalog fetch', async () => {
    const summary = makeSummary(5, { name: 'Kayıtlı Müşteri' });
    crm.getCustomer.mockResolvedValue(summary);
    await renderSelector({ value: 'customer-5' });
    expect(crm.getCustomer).toHaveBeenCalledWith('customer-5');
    expect(crm.listCustomers).not.toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
    const loops = crm.listCustomers.mock.calls.filter(
      (call) => (call[0] as { offset: number }).offset > 0,
    );
    expect(loops).toEqual([]);
    expect(onCustomerResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'customer-5' }));
    expect(onReadyChange).toHaveBeenCalledWith(true);
  });

  it('pins a newly created customer even when the current query excludes it', async () => {
    const created = makeSummary(99, { name: 'Yeni Oluşan Klinik' });
    crm.listCustomers.mockResolvedValue(page([makeSummary(1)], 30));
    await renderSelector({ value: 'customer-99', pinnedCustomer: created });
    expect(crm.getCustomer).not.toHaveBeenCalled();
    await open();
    await settleDebounce();
    const titles = optionTitles().join(' ');
    expect(titles).toContain('Yeni Oluşan Klinik');
    expect(onCustomerResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'customer-99' }));
  });

  it('searches a large catalog with bounded requests and finds off-page items', async () => {
    const total = 500;
    crm.listCustomers.mockImplementation((filters: { q?: string; offset: number }) => {
      if (filters.q === 'derin-sonuc') {
        return Promise.resolve(page([makeSummary(499, { name: 'Derin Sonuç Klinik' })], 1));
      }
      const items = Array.from({ length: CUSTOMER_SEARCH_PAGE_SIZE }, (_, index) =>
        makeSummary(filters.offset + index + 1));
      return Promise.resolve(page(items, total, filters.offset));
    });
    await renderSelector();
    await open();
    await settleDebounce();
    const requestedRows = crm.listCustomers.mock.calls.reduce(
      (sum, call) => sum + ((call[0] as { limit: number }).limit ?? 0), 0,
    );
    expect(requestedRows).toBe(CUSTOMER_SEARCH_PAGE_SIZE);
    expect(options().length).toBeLessThanOrEqual(CUSTOMER_SEARCH_PAGE_SIZE);
    await search('derin-sonuc');
    expect(optionTitles().join(' ')).toContain('Derin Sonuç Klinik');
    // Even after loading several pages the rendered window stays bounded (virtualized).
    crm.listCustomers.mockImplementation((filters: { q?: string; offset: number }) => {
      const items = Array.from({ length: CUSTOMER_SEARCH_PAGE_SIZE }, (_, index) =>
        makeSummary(filters.offset + index + 1));
      return Promise.resolve(page(items, total, filters.offset));
    });
    await search('');
    await act(async () => { scrollDropdownToBottom(); });
    await flush();
    await act(async () => { scrollDropdownToBottom(); });
    await flush();
    expect(options().length).toBeLessThan(60);
  });

  it('clears a gone initial id instead of keeping a stale selection', async () => {
    const { ApiError } = await import('../src/services/api');
    crm.getCustomer.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Bulunamadı.'));
    await renderSelector({ value: 'customer-gone', clearValueWhenMissing: true });
    expect(crm.getCustomer).toHaveBeenCalledWith('customer-gone');
    expect(onChange).toHaveBeenCalledWith('');
    expect(onReadyChange).toHaveBeenCalledWith(true);
  });

  it('drops an ineligible initial customer the same way', async () => {
    const inactive = makeSummary(6, { name: 'Pasif Müşteri', status: 'inactive' });
    crm.getCustomer.mockResolvedValue(inactive);
    await renderSelector({
      value: 'customer-6',
      clearValueWhenMissing: true,
      isEligible: (customer) => customer.status !== 'inactive',
    });
    expect(onChange).toHaveBeenCalledWith('');
    expect(onCustomerResolved).toHaveBeenCalledWith(null);
  });

  it('wires combobox semantics and field-error association', async () => {    crm.listCustomers.mockResolvedValue(page([], 0));
    await renderSelector({ invalid: true, describedBy: 'customer-search-error' });
    const input = host.querySelector('input.ant-select-input') as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('customer-search-error');
    expect(host.querySelector('label[for="customer-search"]')).not.toBeNull();
    expect(document.activeElement === input || input.tabIndex >= -1).toBe(true);
  });
});
