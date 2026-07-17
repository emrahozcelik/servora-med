/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesMeetingCreateScreen } from '../src/SalesMeetingCreate';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import { ApiError, type CurrentUser } from '../src/services/api';

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
  id: `profile-${id}`, user: { ...staff, id, name, isActive, email: `${id}@test.local` },
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
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('Sales Meeting planning flow', () => {
  let root: Root; let container: HTMLDivElement; let onCreated: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => 'action-1') });
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    crm.listCustomers.mockResolvedValue({ items: [customer('c1', 'A Klinik')], total: 1, limit: 200, offset: 0 });
    crm.listContacts.mockResolvedValue({ items: [contact('c1', 'ct1', 'Dr. Ayşe')], total: 1, limit: 200, offset: 0 });
    jobs.createJobCard.mockResolvedValue({ id: 'meeting-1', version: 1 });
    onCreated = vi.fn(); container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('keeps Staff ownership fixed and submits scheduledAt instead of date-only dueDate', async () => {
    await act(async () => root.render(<SalesMeetingCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    expect(people.listStaff).not.toHaveBeenCalled();
    expect(container.querySelector('#meeting-assignee')).toBeNull();
    expect(container.textContent).toContain('Planlanan görüşme zamanı');
    expect((container.querySelector('#meeting-scheduled-at') as HTMLInputElement).value).toBe('2026-07-17T14:30');
    change(container.querySelector('#meeting-title')!, '  İmplant değerlendirme görüşmesi  ');
    change(container.querySelector('#meeting-customer')!, 'c1'); await settle();
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).toHaveBeenCalledWith({
      clientActionId: 'action-1', type: 'SALES_MEETING',
      title: 'İmplant değerlendirme görüşmesi', customerId: 'c1', assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-07-01T10:00'),
      dueDate: '2026-07-01',
      description: null, contactId: null, priority: 'normal',
    });
    expect(onCreated).toHaveBeenCalledWith('meeting-1');
  });

  it('initializes planned time once and preserves edits across Customer reload and validation', async () => {
    await act(async () => root.render(<SalesMeetingCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
    const scheduled = container.querySelector('#meeting-scheduled-at') as HTMLInputElement;
    change(scheduled, '2026-08-05T15:00');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).not.toHaveBeenCalled();
    expect(scheduled.value).toBe('2026-08-05T15:00');
    await act(async () => (container.querySelector('[data-retry-customers]') as HTMLButtonElement | null)?.click());
    await settle();
    expect((container.querySelector('#meeting-scheduled-at') as HTMLInputElement).value).toBe('2026-08-05T15:00');
    expect(scheduling.defaultScheduledLocalValue).toHaveBeenCalledTimes(1);
  });

  it('blocks on required Customer loading, supports retry, and loads active Staff for managers', async () => {
    crm.listCustomers.mockRejectedValueOnce(new Error('CRM yok'));
    await act(async () => root.render(<SalesMeetingCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    expect(container.textContent).toContain('Müşteriler yüklenemedi');
    expect((container.querySelector('[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => (container.querySelector('[data-retry-customers]') as HTMLButtonElement).click());
    await settle();
    expect(crm.listCustomers).toHaveBeenCalledTimes(2);
    expect((container.querySelector('#meeting-assignee') as HTMLSelectElement).textContent).toContain('Bora');
  });

  it('requires title, Customer, scheduled time, and manager assignee with accessible errors', async () => {
    await act(async () => root.render(<SalesMeetingCreateScreen user={manager} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    change(container.querySelector('#meeting-scheduled-at')!, '');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).not.toHaveBeenCalled();
    expect(container.querySelector('.form-error')).toBe(document.activeElement);
    for (const id of ['meeting-title', 'meeting-customer', 'meeting-scheduled-at', 'meeting-assignee']) {
      const control = container.querySelector(`#${id}`);
      expect(control?.getAttribute('aria-invalid')).toBe('true');
      const errorId = control?.getAttribute('aria-describedby');
      expect(errorId).toBe(`${id}-error`);
      expect(container.querySelector(`#${errorId}`)?.textContent).not.toBe('');
    }
  });

  it('clears stale Contact selection and ignores an older Customer response', async () => {
    const old = deferred<unknown>();
    crm.listCustomers.mockResolvedValue({ items: [customer('c1', 'A'), customer('c2', 'B')], total: 2, limit: 200, offset: 0 });
    crm.listContacts.mockImplementation((id: string) => id === 'c1' ? old.promise : Promise.resolve({
      items: [contact('c2', 'ct2', 'Dr. Yeni')], total: 1, limit: 200, offset: 0,
    }));
    await act(async () => root.render(<SalesMeetingCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    const select = container.querySelector('#meeting-customer') as HTMLSelectElement;
    await act(async () => change(select, 'c1'));
    await act(async () => change(select, 'c2')); await settle();
    await act(async () => old.resolve({ items: [contact('c1', 'old', 'Dr. Eski')], total: 1, limit: 200, offset: 0 }));
    expect(container.querySelector('#meeting-contact')?.textContent).toContain('Dr. Yeni');
    expect(container.querySelector('#meeting-contact')?.textContent).not.toContain('Dr. Eski');
  });

  it('keeps Contact failure non-blocking and offers an adjacent retry', async () => {
    crm.listContacts.mockRejectedValueOnce(new Error('Kişiler yok'));
    await act(async () => root.render(<SalesMeetingCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} />));
    await settle();
    await act(async () => change(container.querySelector('#meeting-customer')!, 'c1')); await settle();
    expect(container.textContent).toContain('İlgili kişiler yüklenemedi');
    expect(container.querySelector('[data-retry-contacts]')).not.toBeNull();
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-scheduled-at')!, '2025-01-01T09:00');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      contactId: null,
      scheduledAt: localDateTimeToIso('2025-01-01T09:00'),
      dueDate: '2025-01-01',
    }));
  });

  it('locks double submit and reuses the action ID after a retryable error', async () => {
    const pending = deferred<never>(); jobs.createJobCard.mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi', true));
    await act(async () => root.render(<SalesMeetingCreateScreen user={staff} onCancel={() => {}} onCreated={onCreated} />));
    await settle(); change(container.querySelector('#meeting-title')!, 'Görüşme');
    await act(async () => change(container.querySelector('#meeting-customer')!, 'c1')); await settle();
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-15T11:00');
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit()); form.requestSubmit();
    expect(jobs.createJobCard).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi', true)));
    await act(async () => form.requestSubmit());
    expect(jobs.createJobCard.mock.calls[1]![0].clientActionId).toBe('action-1');
    expect((container.querySelector('#meeting-scheduled-at') as HTMLInputElement).value).toBe('2026-07-15T11:00');
  });
});
