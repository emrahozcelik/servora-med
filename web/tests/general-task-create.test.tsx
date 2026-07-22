/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralTaskCreateScreen } from '../src/GeneralTaskCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({ createJobCard: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const crm = vi.hoisted(() => ({ listCustomers: vi.fn(), listContacts: vi.fn() }));
const scheduling = vi.hoisted(() => ({
  defaultScheduledLocalValue: vi.fn(() => '2026-07-17T14:30'),
  localDateTimeToIso: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) throw new Error(value);
    return new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), 0, 0,
    ).toISOString();
  },
}));
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobs,
}));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/jobs/scheduling', () => scheduling);

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const staff: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF' };
const profile = (id: string, name: string, isActive = true) => ({
  id: `profile-${id}`, user: { id, organizationId: 'org-1', name, email: `${id}@test.local`,
    role: 'STAFF', mustChangePassword: false, isActive, version: 1,
    lastLoginAt: null, createdAt: '', updatedAt: '' },
  title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
});
const customer = (id: string, name: string) => ({
  id, organizationId: 'org-1', name, customerType: 'clinic', taxNumber: null, phone: null,
  email: null, city: null, district: null, address: null, assignedStaffUserId: null,
  assignedStaffName: null, status: 'active', version: 1, primaryContact: null,
});
const contact = (customerId: string, id: string, name: string) => ({
  id, organizationId: 'org-1', customerId, name, title: null, phone: null, email: null,
  isPrimary: false, isActive: true, version: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('General Task quick create', () => {
  let root: Root; let container: HTMLDivElement; let onCreated: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => 'action-1') });
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    crm.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    crm.listContacts.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    jobs.createJobCard.mockResolvedValue({ id: 'job-task-1', version: 1 });
    onCreated = vi.fn(); container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('keeps Staff ownership fixed and submits the prefilled planned time', async () => {
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    expect(people.listStaff).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Ayşe Personel');
    expect(container.querySelector('#task-assignee')).toBeNull();
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
    expect((container.querySelector('#task-scheduled-at') as HTMLInputElement).value).toBe('2026-07-17T14:30');
    change(container.querySelector('#task-title') as HTMLInputElement, '  Doktoru ara  ');
    change(container.querySelector('#task-description') as HTMLTextAreaElement, '  Randevu durumunu sor  ');

    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());

    expect(jobs.createJobCard).toHaveBeenCalledWith({
      clientActionId: 'action-1', type: 'GENERAL_TASK', title: 'Doktoru ara',
      assignedTo: 'staff-1', description: 'Randevu durumunu sor', priority: 'normal',
      dueDate: null, scheduledAt: localDateTimeToIso('2026-07-17T14:30'),
      customerId: null, contactId: null,
    });
    expect(onCreated).toHaveBeenCalledWith('job-task-1');
  });

  it('allows clearing the prefilled planned time and submits scheduledAt null', async () => {
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    change(container.querySelector('#task-title') as HTMLInputElement, 'Takip et');
    change(container.querySelector('#task-scheduled-at') as HTMLInputElement, '');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      scheduledAt: null, dueDate: null,
    }));
  });

  it('preserves a user-edited planned time across validation errors and staff retry', async () => {
    people.listStaff.mockRejectedValueOnce(new Error('Bağlantı yok'))
      .mockResolvedValueOnce([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    await settle();
    change(container.querySelector('#task-scheduled-at') as HTMLInputElement, '2026-08-10T08:30');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).not.toHaveBeenCalled();
    expect((container.querySelector('#task-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T08:30');
    await act(async () => (container.querySelector('[data-retry-staff]') as HTMLButtonElement).click());
    await settle();
    expect((container.querySelector('#task-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T08:30');
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
  });

  it('uses the existing design-system border token for optional fields', () => {
    const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

    expect(styles).toContain('.task-optional');
    expect(styles).not.toContain('var(--border)');
  });

  it('loads only active Staff and offers an inline retry after failure', async () => {
    people.listStaff.mockRejectedValueOnce(new Error('Bağlantı yok'))
      .mockResolvedValueOnce([profile('staff-1', 'Ayşe'), profile('inactive', 'Pasif', false)]);
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    await settle();
    expect(container.textContent).toContain('Personel listesi yüklenemedi');

    await act(async () => (container.querySelector('[data-retry-staff]') as HTMLButtonElement).click());
    await settle();

    expect(people.listStaff).toHaveBeenCalledTimes(2);
    const options = Array.from((container.querySelector('#task-assignee') as HTMLSelectElement).options)
      .map((option) => option.text);
    expect(options).toContain('Ayşe');
    expect(options).not.toContain('Pasif');
  });

  it('submits the exact manager body with optional operational context', async () => {
    crm.listCustomers.mockResolvedValue({
      items: [customer('c1', 'A Klinik')], total: 1, limit: 200, offset: 0,
    });
    crm.listContacts.mockResolvedValue({
      items: [contact('c1', 'contact-1', 'Dr. Ayşe')], total: 1, limit: 200, offset: 0,
    });
    await act(async () => root.render(
      <MemoryRouter><GeneralTaskCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>,
    ));
    await settle();
    const details = container.querySelector('details')!;
    details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();

    await act(async () => {
      change(container.querySelector('#task-title') as HTMLInputElement, 'Klinik dönüşünü takip et');
      change(container.querySelector('#task-description') as HTMLTextAreaElement, 'Teklif yanıtını öğren');
      change(container.querySelector('#task-assignee') as HTMLSelectElement, 'staff-2');
      change(container.querySelector('#task-priority') as HTMLSelectElement, 'high');
      change(container.querySelector('#task-scheduled-at') as HTMLInputElement, '2026-07-20T14:00');
    });
    await act(async () => change(container.querySelector('#task-customer') as HTMLSelectElement, 'c1'));
    await settle();
    await act(async () => change(container.querySelector('#task-contact') as HTMLSelectElement, 'contact-1'));
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());

    expect(jobs.createJobCard).toHaveBeenCalledWith({
      clientActionId: 'action-1', type: 'GENERAL_TASK', title: 'Klinik dönüşünü takip et',
      assignedTo: 'staff-2', description: 'Teklif yanıtını öğren', priority: 'high',
      dueDate: null, scheduledAt: localDateTimeToIso('2026-07-20T14:00'),
      customerId: 'c1', contactId: 'contact-1',
    });
    expect(onCreated).toHaveBeenCalledWith('job-task-1');
  });

  it('offers an explicit cancel action', async () => {
    const onCancel = vi.fn();
    await act(async () => root.render(
      <MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={onCancel} onCreated={onCreated} /></MemoryRouter>,
    ));
    await act(async () => (container.querySelector('[data-cancel-task]') as HTMLButtonElement).click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps disclosure labels and moves focus to an associated error summary', async () => {
    await act(async () => root.render(
      <MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>,
    ));
    const disclosure = container.querySelector('details.task-optional')!;
    expect(disclosure.querySelector('summary')?.textContent).toBe('Ek bilgiler');
    for (const label of ['Başlık', 'Açıklama (isteğe bağlı)', 'Öncelik', 'Planlanan zaman (isteğe bağlı)',
      'Müşteri (isteğe bağlı)', 'İlgili kişi (isteğe bağlı)']) {
      expect(container.textContent).toContain(label);
    }

    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    const summary = container.querySelector<HTMLElement>('.form-error')!;
    const title = container.querySelector<HTMLInputElement>('#task-title')!;
    expect(summary.getAttribute('role')).toBe('alert');
    expect(summary.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(summary);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe('task-title-error');
    expect(container.querySelector('#task-title-error')?.textContent)
      .toContain('Başlık 1 ile 255 karakter arasında olmalıdır');
  });

  it('loads all optional Customer and Contact pages and clears stale Contact state', async () => {
    crm.listCustomers.mockImplementation(({ offset }: { offset: number }) => Promise.resolve(offset === 0
      ? { items: [customer('c1', 'A Klinik'), customer('c2', 'B Klinik')], total: 3, limit: 200, offset: 0 }
      : { items: [customer('c3', 'C Klinik')], total: 3, limit: 200, offset: 2 }));
    const first = deferred<unknown>();
    crm.listContacts.mockImplementation((id: string, { offset }: { offset: number }) => {
      if (id === 'c1') return first.promise;
      return Promise.resolve(offset === 0
        ? { items: [contact('c2', 'b1', 'Dr. Bora')], total: 2, limit: 200, offset: 0 }
        : { items: [contact('c2', 'b2', 'Selin')], total: 2, limit: 200, offset: 1 });
    });
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    const details = container.querySelector('details')!; details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();
    expect(crm.listCustomers.mock.calls.map((call) => call[0].offset)).toEqual([0, 2]);

    const customerSelect = container.querySelector('#task-customer') as HTMLSelectElement;
    await act(async () => change(customerSelect, 'c1'));
    await act(async () => change(customerSelect, 'c2'));
    await settle();
    expect(crm.listContacts.mock.calls.filter((call) => call[0] === 'c2').map((call) => call[1].offset))
      .toEqual([0, 1]);
    await act(async () => first.resolve({ items: [contact('c1', 'old', 'Dr. Eski')], total: 1, limit: 200, offset: 0 }));
    const contactSelect = container.querySelector('#task-contact') as HTMLSelectElement;
    expect(contactSelect.textContent).toContain('Dr. Bora');
    expect(contactSelect.textContent).not.toContain('Dr. Eski');
    await act(async () => change(customerSelect, ''));
    expect(contactSelect.value).toBe('');
    expect(contactSelect.disabled).toBe(true);
  });

  it('allows context-free submit after optional CRM loading fails', async () => {
    crm.listCustomers.mockRejectedValue(new Error('CRM yok'));
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    const details = container.querySelector('details')!; details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();
    expect(container.textContent).toContain('Müşteriler yüklenemedi');
    change(container.querySelector('#task-title') as HTMLInputElement, 'Takip et');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).toHaveBeenCalledWith(expect.objectContaining({ customerId: null, contactId: null }));
  });

  it('auto-selects Customer and loads Contacts when initialCustomerId matches a loaded customer', async () => {
    crm.listCustomers.mockResolvedValue({
      items: [customer('c1', 'A Klinik'), customer('c2', 'B Klinik')], total: 2, limit: 200, offset: 0,
    });
    crm.listContacts.mockResolvedValue({
      items: [contact('c1', 'ct1', 'Dr. Ayşe')], total: 1, limit: 200, offset: 0,
    });
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} initialCustomerId="c1" /></MemoryRouter>));
    const details = container.querySelector('details')!; details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();
    expect((container.querySelector('#task-customer') as HTMLSelectElement).value).toBe('c1');
    expect(container.querySelector('#task-contact')?.textContent).toContain('Dr. Ayşe');
  });

  it('shows a create-customer link when the customer list is empty', async () => {
    crm.listCustomers.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    const details = container.querySelector('details')!; details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();
    expect(container.querySelector('[href="/customers/new?source=task"]')).not.toBeNull();
  });

  it('keeps the create-customer link available when customers already exist', async () => {
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    const details = container.querySelector('details')!; details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle', { bubbles: true })));
    await settle();
    expect(container.querySelector('[href="/customers/new?source=task"]')).not.toBeNull();
  });

  it('locks duplicate submit and retains action ID, values, and error focus for retry', async () => {
    const pending = deferred<never>(); jobs.createJobCard.mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(Object.assign(new Error('Bağlantı kesildi'), { retryable: true }))
      .mockResolvedValueOnce({ id: 'job-task-1', version: 1 });
    await act(async () => root.render(<MemoryRouter><GeneralTaskCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    change(container.querySelector('#task-title') as HTMLInputElement, 'Değeri koru');
    change(container.querySelector('#task-scheduled-at') as HTMLInputElement, '2026-07-22T13:00');
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());
    expect((container.querySelector('[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-cancel-task]') as HTMLButtonElement).disabled).toBe(true);
    form.requestSubmit(); expect(jobs.createJobCard).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(Object.assign(new Error('Bağlantı kesildi'), { retryable: true })));
    expect((container.querySelector('#task-title') as HTMLInputElement).value).toBe('Değeri koru');
    expect((container.querySelector('#task-scheduled-at') as HTMLInputElement).value).toBe('2026-07-22T13:00');
    expect(document.activeElement).toBe(container.querySelector('.form-error'));
    await act(async () => form.requestSubmit());
    expect(jobs.createJobCard.mock.calls[1]![0].clientActionId).toBe('action-1');
    expect(jobs.createJobCard.mock.calls[1]![0].scheduledAt).toBe(localDateTimeToIso('2026-07-22T13:00'));
  });
});
