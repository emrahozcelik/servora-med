/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesMeetingCreateScreen } from '../src/SalesMeetingCreate';
import { DeliveryCreateView } from '../src/DeliveryCreate';
import { CustomerScheduleNotice } from '../src/jobs/CustomerScheduleNotice';
import { localDateTimeToIso } from '../src/jobs/scheduling';
import { ApiError, type CurrentUser } from '../src/services/api';
import {
  clearCustomerSelection,
  pickCustomerByName,
  pickCustomerByNameWithFakeTimers,
  stubMatchMedia,
} from './customer-search-select-harness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({
  createJobCard: vi.fn(),
  previewCustomerSchedule: vi.fn(),
}));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const crm = vi.hoisted(() => ({ listCustomers: vi.fn(), listContacts: vi.fn(), getCustomer: vi.fn() }));
const api = vi.hoisted(() => ({
  listReferenceCustomers: vi.fn(),
  createProductDelivery: vi.fn(),
}));
const products = vi.hoisted(() => ({ listProducts: vi.fn() }));
const scheduling = vi.hoisted(() => {
  return {
    defaultScheduledLocalValue: vi.fn(() => '2026-07-17T14:30'),
    isoInstantToLocalDateTime: (value: string) => {
      const date = new Date(value);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    },
    localDateTimeToIso: (value: string) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
      if (!match) throw new Error(value);
      return new Date(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4]), Number(match[5]), 0, 0,
      ).toISOString();
    },
  };
});
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobs,
}));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crm,
}));
vi.mock('../src/services/api', async (original) => ({
  ...await original<typeof import('../src/services/api')>(), ...api,
}));
vi.mock('../src/services/products-api', async (original) => ({
  ...await original<typeof import('../src/services/products-api')>(), ...products,
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
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function selectProduct(container: HTMLElement) {
  const search = container.querySelector('#delivery-product-search') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'implant');
  await act(async () => {
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => (Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Ürün ara') as HTMLButtonElement).click());
  await settle();
  await act(async () => (container.querySelector('[data-product-id="p1"]') as HTMLButtonElement).click());
}
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const conflictEvaluation = {
  level: 'CONFLICT',
  safeMessage: null,
  conflicts: [{
    jobCardId: 'j-other', title: 'A Klinik teslim', scheduledAt: '2026-07-01T09:00:00.000Z',
    type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
    assignee: { id: 'staff-2', name: 'Bora' }, jobPath: '/jobs/j-other',
  }],
  recentVisit: null,
  suggestedAlternativeAt: '2026-07-03T10:00:00.000Z',
};
const frequencyEvaluation = {
  level: 'FREQUENCY_EXCEEDED',
  safeMessage: null,
  conflicts: [],
  recentVisit: {
    occurredAt: '2026-07-10T00:00:00.000Z', jobType: 'SALES_MEETING',
    title: 'A Klinik görüşme', staffName: 'Ayşe Personel', resultSummary: 'Olumlu',
  },
  suggestedAlternativeAt: null,
};
// Real Staff-projected server shape: conflicts/recentVisit are stripped,
// only safeMessage and suggestedAlternativeAt survive projection.
const staffConflictEvaluation = {
  level: 'CONFLICT',
  safeMessage: 'Bu müşteri için yakın tarihte başka bir iş planlandı.',
  conflicts: [],
  recentVisit: null,
  suggestedAlternativeAt: '2026-07-03T10:00:00.000Z',
};
const staffWarningEvaluation = {
  level: 'WARNING',
  safeMessage: 'Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.',
  conflicts: [],
  recentVisit: null,
  suggestedAlternativeAt: null,
};

describe('Customer Scheduling preview in Sales Meeting planning', () => {
  let root: Root; let container: HTMLDivElement; let onCreated: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia();
    vi.useFakeTimers();
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => 'action-1') });
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    crm.listCustomers.mockResolvedValue({ items: [customer('c1', 'A Klinik')], total: 1, limit: 20, offset: 0 });
    crm.listContacts.mockResolvedValue({ items: [contact('c1', 'ct1', 'Dr. Ayşe')], total: 1, limit: 200, offset: 0 });
    jobs.createJobCard.mockResolvedValue({ id: 'meeting-1', version: 1 });
    jobs.previewCustomerSchedule.mockResolvedValue({ level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null });
    onCreated = vi.fn(); container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(user: CurrentUser) {
    await act(async () => root.render(<MemoryRouter><SalesMeetingCreateScreen user={user} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    await settle();
  }
  async function advancePreview() {
    await act(async () => { vi.advanceTimersByTime(300); });
    await settle();
  }

  it('requests an advisory preview for the selected customer and time', async () => {
    await render(manager);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await advancePreview();
    expect(jobs.previewCustomerSchedule).toHaveBeenCalledWith({
      type: 'SALES_MEETING', customerId: 'c1',
      scheduledAt: localDateTimeToIso('2026-07-01T10:00'), jobCardId: null,
    });
  });

  it('shows the conflict notice with alternative CTA and applies the alternative', async () => {
    jobs.previewCustomerSchedule.mockResolvedValue(conflictEvaluation);
    await render(manager);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await advancePreview();
    expect(container.textContent).toContain('Aynı müşteriye aynı gün başka bir saha işi planlanmış.');
    expect(container.textContent).toContain('A Klinik teslim');
    const alternativeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('önerilen alternatif zamanı kullan'));
    expect(alternativeButton).toBeTruthy();
    await act(async () => alternativeButton!.click());
    expect((container.querySelector('#meeting-scheduled-at') as HTMLInputElement).value)
      .toBe(scheduling.isoInstantToLocalDateTime('2026-07-03T10:00:00.000Z'));
    expect(container.querySelector('#meeting-scheduled-ends-at')).toBeNull();
  });

  it('keeps the conflict notice visible for Staff without conflict details', async () => {
    jobs.previewCustomerSchedule.mockResolvedValue(staffConflictEvaluation);
    await render(staff);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await advancePreview();
    expect(container.textContent).toContain('Bu müşteri için yakın tarihte başka bir iş planlandı.');
    expect(container.textContent).not.toContain('A Klinik teslim');
    const alternativeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('önerilen alternatif zamanı kullan'));
    expect(alternativeButton).toBeTruthy();
  });

  it('shows the safe warning message for Staff on a WARNING evaluation', async () => {
    jobs.previewCustomerSchedule.mockResolvedValue(staffWarningEvaluation);
    await render(staff);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await advancePreview();
    expect(container.textContent).toContain('Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.');
  });

  it('discards a stale preview response after the customer is cleared', async () => {
    let resolvePreview!: (value: unknown) => void;
    jobs.previewCustomerSchedule.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    await render(manager);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    await advancePreview();
    expect(jobs.previewCustomerSchedule).toHaveBeenCalledTimes(1);
    await clearCustomerSelection(container, 'meeting-customer');
    await act(async () => { resolvePreview(staffConflictEvaluation); });
    await settle();
    expect(container.textContent).not.toContain('Bu müşteri için yakın tarihte başka bir iş planlandı.');
    expect(container.textContent).not.toContain('Müşteri planı kontrol ediliyor');
  });

  it('shows the frequency review message for Staff without an override reason field', async () => {
    jobs.previewCustomerSchedule.mockResolvedValue(frequencyEvaluation);
    await render(staff);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-17T14:30');
    await advancePreview();
    expect(container.textContent).toContain('ziyaret sıklığı sınırı aşılıyor');
    expect(container.textContent).toContain('yönetici değerlendirmesi gerekiyor');
    expect(container.querySelector('#customer-visit-override-reason')).toBeNull();
  });

  it('shows the override reason field for Manager and submits it with the create', async () => {
    jobs.previewCustomerSchedule.mockResolvedValue(frequencyEvaluation);
    await render(manager);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-17T14:30');
    await advancePreview();
    const reason = container.querySelector('#customer-visit-override-reason') as HTMLTextAreaElement;
    expect(reason).toBeTruthy();
    change(reason, 'Yönetici onayı ile planlanıyor');
    change(container.querySelector('#meeting-assignee')!, 'staff-2');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createJobCard).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SALES_MEETING', customerId: 'c1',
      scheduledAt: localDateTimeToIso('2026-07-17T14:30'),
      overrideReason: 'Yönetici onayı ile planlanıyor',
    }));
    expect(onCreated).toHaveBeenCalledWith('meeting-1');
  });

  it('retains the form and shows the authoritative conflict error when the server rejects the create', async () => {
    jobs.createJobCard.mockRejectedValue(new ApiError(
      409, 'CUSTOMER_SCHEDULE_CONFLICT',
      'Aynı müşteriye aynı gün başka bir saha işi planlanmış. Farklı bir gün seçin.',
      false,
      {
        conflicts: [{
          jobCardId: 'j-other', title: 'A Klinik teslim', scheduledAt: '2026-07-01T09:00:00.000Z',
          type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
          assignee: { id: 'staff-2', name: 'Bora' }, jobPath: '/jobs/j-other',
        }],
        suggestedAlternativeAt: '2026-07-03T10:00:00.000Z',
      },
    ));
    await render(manager);
    change(container.querySelector('#meeting-title')!, 'Görüşme');
    change(container.querySelector('#meeting-engagement-kind')!, 'CUSTOMER_VISIT');
    await pickCustomerByNameWithFakeTimers(container, 'meeting-customer', 'A Klinik');
    change(container.querySelector('#meeting-scheduled-at')!, '2026-07-01T10:00');
    change(container.querySelector('#meeting-assignee')!, 'staff-2');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(container.textContent).toContain('Aynı müşteriye aynı gün başka bir saha işi planlanmış.');
    expect(container.textContent).toContain('A Klinik teslim');
    const alternativeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('önerilen alternatif zamanı kullan'));
    expect(alternativeButton).toBeTruthy();
    await act(async () => alternativeButton!.click());
    expect((container.querySelector('#meeting-scheduled-at') as HTMLInputElement).value)
      .toBe(scheduling.isoInstantToLocalDateTime('2026-07-03T10:00:00.000Z'));
    expect(container.querySelector('#meeting-scheduled-ends-at')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('CustomerScheduleNotice presentation', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  async function renderNotice(props: Parameters<typeof CustomerScheduleNotice>[0]) {
    await act(async () => root.render(<CustomerScheduleNotice {...props} />));
  }

  it('renders nothing for a CLEAR evaluation', async () => {
    await renderNotice({
      evaluation: { level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null },
      mode: 'manager', overrideReason: '', onOverrideReasonChange: () => {}, onUseSuggestedAlternative: () => {},
    });
    expect(container.textContent).toBe('');
  });

  it('renders the recent visit card for Manager', async () => {
    await renderNotice({
      evaluation: frequencyEvaluation, mode: 'manager', overrideReason: '',
      onOverrideReasonChange: () => {}, onUseSuggestedAlternative: () => {},
    });
    expect(container.textContent).toContain('Yakın tarihli müşteri ziyareti');
    expect(container.textContent).toContain('Ayşe Personel');
  });

  it('renders the conflict message and alternative CTA for Staff from the projected shape', async () => {
    await renderNotice({
      evaluation: staffConflictEvaluation, mode: 'staff', overrideReason: '',
      onOverrideReasonChange: () => {}, onUseSuggestedAlternative: () => {},
    });
    expect(container.textContent).toContain('Bu müşteri için yakın tarihte başka bir iş planlandı.');
    expect(container.textContent).not.toContain('A Klinik teslim');
    expect(container.textContent).toContain('önerilen alternatif zamanı kullan');
  });

  it('renders the safe warning message for Staff on a WARNING evaluation', async () => {
    await renderNotice({
      evaluation: staffWarningEvaluation, mode: 'staff', overrideReason: '',
      onOverrideReasonChange: () => {}, onUseSuggestedAlternative: () => {},
    });
    expect(container.textContent).toContain('Bu müşteriye yakın tarihte ziyaret gerçekleştirildi.');
  });
});

describe('Delivery authoritative conflict alternative', () => {
  let root: Root; let container: HTMLDivElement; let onCreated: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia();
    vi.useFakeTimers();
    scheduling.defaultScheduledLocalValue.mockReturnValue('2026-07-17T14:30');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => 'action-1') });
    people.listStaff.mockResolvedValue([profile('staff-1', 'Ayşe'), profile('staff-2', 'Bora')]);
    crm.listCustomers.mockResolvedValue({ items: [customer('c1', 'A Klinik')], total: 1, limit: 20, offset: 0 });
    crm.listContacts.mockResolvedValue({ items: [contact('c1', 'ct1', 'Dr. Ayşe')], total: 1, limit: 200, offset: 0 });
    crm.getCustomer.mockResolvedValue({ ...customer('c1', 'A Klinik'), contacts: [contact('c1', 'ct1', 'Dr. Ayşe')] });
    products.listProducts.mockResolvedValue({
      items: [{
        id: 'p1', organizationId: 'org-1', name: 'Kompozit', sku: 'K-1', brand: null,
        category: null, model: null, unit: 'adet', referencePrice: null, isActive: true,
        version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      total: 1, limit: 8, offset: 0,
    });
    jobs.previewCustomerSchedule.mockResolvedValue({ level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null });
    onCreated = vi.fn(); container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('applies the authoritative suggested alternative after a rejected delivery create', async () => {
    api.createProductDelivery.mockRejectedValue(new ApiError(
      409, 'CUSTOMER_SCHEDULE_CONFLICT',
      'Aynı müşteriye aynı gün başka bir saha işi planlanmış. Farklı bir gün seçin.',
      false,
      {
        conflicts: [{
          jobCardId: 'j-other', title: 'A Klinik teslim', scheduledAt: '2026-07-01T09:00:00.000Z',
          type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
          assignee: { id: 'staff-2', name: 'Bora' }, jobPath: '/jobs/j-other',
        }],
        suggestedAlternativeAt: '2026-07-03T10:00:00.000Z',
      },
    ));
    await act(async () => root.render(<MemoryRouter><DeliveryCreateView user={manager} onCancel={() => {}} onCreated={onCreated} /></MemoryRouter>));
    await settle();
    await pickCustomerByNameWithFakeTimers(container, 'delivery-customer', 'A Klinik');
    await selectProduct(container);
    change(container.querySelector('#delivery-scheduled-at')!, '2026-07-01T10:00');
    change(container.querySelector('#delivery-quantity-p1')!, '2');
    change(container.querySelector('#delivery-assignee')!, 'staff-2');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle();
    expect(container.textContent).toContain('Aynı müşteriye aynı gün başka bir saha işi planlanmış.');
    expect(container.textContent).toContain('A Klinik teslim');
    const alternativeButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('önerilen alternatif zamanı kullan'));
    expect(alternativeButton).toBeTruthy();
    await act(async () => alternativeButton!.click());
    expect((container.querySelector('#delivery-scheduled-at') as HTMLInputElement).value)
      .toBe(scheduling.isoInstantToLocalDateTime('2026-07-03T10:00:00.000Z'));
    expect(container.querySelector('#delivery-scheduled-ends-at')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
