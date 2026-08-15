/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesMeetingCreateScreen } from '../src/SalesMeetingCreate';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({ createJobCard: vi.fn() }));
const crm = vi.hoisted(() => ({ listCustomers: vi.fn() }));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const scheduling = vi.hoisted(() => ({
  defaultScheduledLocalValue: vi.fn(() => '2026-08-01T12:30'),
  isoInstantToLocalDateTime: vi.fn(() => '2026-08-10T09:30'),
  localDateTimeToIso: vi.fn((value: string) => value === '2026-08-01T12:30'
    ? '2026-08-01T09:30:00.000Z' : value === '2026-08-01T13:30'
      ? '2026-08-01T10:30:00.000Z' : '2026-08-01T09:30:00.000Z'),
  addOneHourLocal: vi.fn((value: string) => value === '2026-08-01T12:30'
    ? '2026-08-01T13:30' : '2026-08-01T13:30'),
}));
const preview = vi.hoisted(() => ({ useCustomerSchedulePreview: vi.fn() }));

vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobs,
}));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));
vi.mock('../src/jobs/scheduling', () => scheduling);
vi.mock('../src/jobs/useCustomerSchedulePreview', () => preview);
vi.mock('../src/jobs/CustomerScheduleNotice', () => ({
  CustomerScheduleNotice: () => null,
}));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const staffUser: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const customer = {
  id: 'customer-1', organizationId: 'org-1', name: 'ABC Klinik', customerType: 'clinic',
  status: 'active', version: 1,
};
const profile = {
  id: 'profile-2', user: { id: 'staff-2', organizationId: 'org-1', name: 'Bora Personel',
    email: 'b@test.local', role: 'STAFF', mustChangePassword: false, isActive: true,
    version: 1, lastLoginAt: null, createdAt: '', updatedAt: '' },
  title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
};

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Sales Meeting create page (AAP create-time parity)', () => {
  let root: Root;
  let host: HTMLDivElement;
  let onCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    let action = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true, value: vi.fn(() => `action-${++action}`),
    });
    jobs.createJobCard.mockResolvedValue({ id: 'job-1', version: 1 });
    crm.listCustomers.mockResolvedValue({ items: [customer], total: 1, limit: 200, offset: 0 });
    people.listStaff.mockResolvedValue([profile]);
    preview.useCustomerSchedulePreview.mockReturnValue({ evaluation: null, previewing: false });
    onCreated = vi.fn();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(user = manager) {
    await act(async () => root.render(<MemoryRouter>
      <SalesMeetingCreateScreen user={user} onCancel={() => {}} onCreated={onCreated} />
    </MemoryRouter>));
    await flush();
  }

  async function fillAndSubmit() {
    change(host.querySelector('#meeting-title') as HTMLInputElement, 'Kontrol görüşmesi');
    change(host.querySelector('#meeting-engagement-kind') as HTMLSelectElement, 'SALES_MEETING');
    change(host.querySelector('#meeting-customer') as HTMLSelectElement, 'customer-1');
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
  }

  it('AAP-19: submits scheduledAt and scheduledEndsAt exactly for the chosen interval', async () => {
    await render(staffUser);
    change(host.querySelector('#meeting-scheduled-at') as HTMLInputElement, '2026-08-01T12:30');
    change(host.querySelector('#meeting-scheduled-ends-at') as HTMLInputElement, '2026-08-01T13:30');
    await fillAndSubmit();
    expect(jobs.createJobCard).toHaveBeenCalledTimes(1);
    expect(jobs.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      clientActionId: 'action-1', type: 'SALES_MEETING', engagementKind: 'SALES_MEETING',
      title: 'Kontrol görüşmesi', customerId: 'customer-1', assignedTo: 'staff-1',
      scheduledAt: '2026-08-01T09:30:00.000Z',
      scheduledEndsAt: '2026-08-01T10:30:00.000Z',
    }));
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('AAP-21: rejects an end not strictly later than the start without calling the API', async () => {
    await render(staffUser);
    change(host.querySelector('#meeting-scheduled-at') as HTMLInputElement, '2026-08-01T12:30');
    change(host.querySelector('#meeting-scheduled-ends-at') as HTMLInputElement, '2026-08-01T12:30');
    await fillAndSubmit();
    expect(host.textContent).toContain('Planlanan bitiş zamanı başlangıç zamanından sonra olmalıdır.');
    expect(jobs.createJobCard).not.toHaveBeenCalled();
  });

  it('AAP-22: STAFF sees only the generic conflict message, never conflict details', async () => {
    jobs.createJobCard.mockRejectedValue(new ApiError(
      409, 'CALENDAR_CONFLICT', 'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.',
      false, {
        conflicts: [{
          source: 'JOB', id: 'job-x', title: 'Gizli plan', startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          assignedUser: { id: 'staff-1', name: 'Ayşe' }, relatedJobPath: '/jobs/job-x',
        }],
      },
    ));
    await render(staffUser);
    await fillAndSubmit();
    expect(host.textContent).toContain('Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.');
    expect(host.textContent).not.toContain('Gizli plan');
    expect(host.textContent).not.toContain('/jobs/job-x');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('AAP-23: MANAGER sees the canonical message plus rich same-org conflict details', async () => {
    jobs.createJobCard.mockRejectedValue(new ApiError(
      409, 'CALENDAR_CONFLICT', 'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.',
      false, {
        conflicts: [{
          source: 'JOB', id: 'job-x', title: 'Klinik teslimi', startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          assignedUser: { id: 'staff-2', name: 'Bora' }, relatedJobPath: '/jobs/job-x',
        }],
      },
    ));
    await render(manager);
    change(host.querySelector('#meeting-assignee') as HTMLSelectElement, 'staff-2');
    await fillAndSubmit();
    expect(host.textContent).toContain('Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.');
    expect(host.textContent).toContain('Klinik teslimi');
    expect(onCreated).not.toHaveBeenCalled();
  });
});