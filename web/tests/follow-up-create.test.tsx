/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowUpCreatePage } from '../src/jobs/FollowUpCreatePage';
import { CUSTOMERLESS_FOLLOW_UP_EXPLANATION } from '../src/jobs/follow-up-presentation';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { JobCard } from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({
  getJobCard: vi.fn(), getMeetingDetails: vi.fn(), createFollowUp: vi.fn(), findAvailableSlots: vi.fn(),
}));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const crm = vi.hoisted(() => ({ listContacts: vi.fn() }));
const scheduling = vi.hoisted(() => ({
  defaultScheduledLocalValue: vi.fn(() => '2026-08-01T12:30'),
  isoInstantToLocalDateTime: vi.fn((value: string) => value === '2026-08-17T10:00:00.000Z'
    ? '2026-08-17T13:00' : '2026-08-10T09:30'),
  localDateTimeToIso: vi.fn((value: string) => value === '2026-08-10T09:30'
    ? '2026-08-10T06:30:00.000Z' : '2026-08-01T09:30:00.000Z'),
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
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const staffUser: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const source: JobCard = {
  id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1',
  type: 'SALES_MEETING', status: 'COMPLETED', version: 7,
  title: 'Kaynak görüşme', description: 'SOURCE_OPERATIONAL_NOTE_MARKER',
  customerId: 'customer-1', contactId: 'contact-1', assignedTo: 'staff-1', createdBy: 'manager-1',
  priority: 'normal', dueDate: null, scheduledAt: '2026-08-01T09:00:00.000Z',
  engagementKind: 'CUSTOMER_VISIT', assignee: { id: 'staff-1', name: 'Source Staff Marker' },
  customer: { id: 'customer-1', name: 'Çok Uzun İsimli Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
  workflowContext: {
    ...workflowContext,
    allowedCommands: [],
    lifecycle: { ...workflowContext.lifecycle, approvedAt: '2026-08-01T10:00:00.000Z' },
  },
  followUpContext: null,
};
const profile = {
  id: 'profile-2', user: { id: 'staff-2', organizationId: 'org-1', name: 'Bora Personel',
    email: 'b@test.local', role: 'STAFF', mustChangePassword: false, isActive: true,
    version: 1, lastLoginAt: null, createdAt: '', updatedAt: '' },
  title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
};
const contact = {
  id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Deniz',
  title: null, phone: null, email: null, isPrimary: true, isActive: true, version: 1,
};

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitForAvailableSlotSearch() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); await Promise.resolve(); });
}

describe('Follow-up create page', () => {
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
    jobs.getJobCard.mockResolvedValue(source);
    jobs.getMeetingDetails.mockResolvedValue({
      jobCardId: source.id, meetingAt: '2026-08-01T09:15:00.000Z',
      outcome: 'FOLLOW_UP_REQUIRED', meetingSummary: 'MEETING_SUMMARY_MARKER',
      nextFollowUpAt: '2026-08-10T06:30:00.000Z', jobCardVersion: 7,
    });
    jobs.createFollowUp.mockResolvedValue({ ...source, id: 'created-1', followUpContext: {
      sourceJobCardId: source.id, followUpInstructions: 'Yeni talimat', sourceAccess: 'FULL',
      sourceJobPath: `/jobs/${source.id}`, sourceSummary: {
        sourceType: source.type, sourcePlannedAt: source.scheduledAt,
        sourceOccurredAt: '2026-08-01T09:15:00.000Z',
        sourceCompletedAt: '2026-08-01T10:00:00.000Z', customer: source.customer,
        contact: source.contact, outcome: 'FOLLOW_UP_REQUIRED',
      },
    } });
    jobs.findAvailableSlots.mockResolvedValue({
      slots: [{ startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' }],
    });
    people.listStaff.mockResolvedValue([profile]);
    crm.listContacts.mockResolvedValue({ items: [contact], total: 1, limit: 200, offset: 0 });
    onCreated = vi.fn();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(user = manager, card = source) {
    jobs.getJobCard.mockResolvedValue(card);
    await act(async () => root.render(<FollowUpCreatePage sourceId={card.id} user={user}
      onCancel={() => {}} onCreated={onCreated} />));
    await flush();
  }

  it('does not load or expose an operational form to Staff', async () => {
    await render(staffUser);
    expect(host.textContent).toContain('Takip işlerini yalnız yöneticiler oluşturabilir');
    expect(host.querySelector('form')).toBeNull();
    expect(jobs.getJobCard).not.toHaveBeenCalled();
  });

  it('rejects a source that is no longer completed', async () => {
    await render(manager, { ...source, status: 'IN_PROGRESS' });
    expect(host.textContent).toContain('Yalnız tamamlanmış bir işten');
    expect(host.querySelector('form')).toBeNull();
  });

  it('shows the canonical unavailable surface when the source cannot be reached', async () => {
    jobs.getJobCard.mockRejectedValue(new ApiError(404, 'JOB_CARD_NOT_FOUND', 'not found'));
    await act(async () => root.render(<FollowUpCreatePage sourceId={source.id} user={manager}
      onCancel={() => {}} onCreated={onCreated} />));
    await flush();
    expect(host.textContent).toContain('Kaynak iş bulunamadı');
    expect(host.textContent).not.toContain('SOURCE_OPERATIONAL_NOTE_MARKER');
    expect(host.querySelector('form')).toBeNull();
  });

  it('uses Sales Meeting proposal/engagement defaults without loading Contact or copying free text', async () => {
    await render();
    expect((host.querySelector('#follow-up-type') as HTMLSelectElement).value).toBe('SALES_MEETING');
    expect((host.querySelector('#follow-up-scheduled-at') as HTMLInputElement).value).toBe('2026-08-10T09:30');
    expect(host.querySelector('#follow-up-contact')).toBeNull();
    expect(crm.listContacts).not.toHaveBeenCalled();
    expect((host.querySelector('#follow-up-engagement-kind') as HTMLSelectElement).value).toBe('CUSTOMER_VISIT');
    expect((host.querySelector('#follow-up-instructions') as HTMLTextAreaElement).value).toBe('');
    expect((host.querySelector('#follow-up-title') as HTMLInputElement).value).toBe('Takip: Kaynak görüşme');
    expect(host.textContent).not.toContain('SOURCE_OPERATIONAL_NOTE_MARKER');
    expect(host.textContent).not.toContain('MEETING_SUMMARY_MARKER');
    expect(host.querySelector('form')?.textContent).not.toContain('Source Staff Marker');
  });

  it('renders the source context immediately visible without a disclosure', async () => {
    await render();
    expect(host.querySelector('details.follow-up-create-source-disclosure')).toBeNull();
    const sourceContext = host.querySelector('.follow-up-create-source-summary');
    expect(sourceContext).not.toBeNull();
    expect(sourceContext?.textContent).toContain('Kaynak iş');
    expect(sourceContext?.textContent).toContain('Kaynak görüşme');
    expect(host.querySelector('form')).not.toBeNull();
  });

  it('shows the source summary content without blocking the create form', async () => {
    await render();
    const sourceContext = host.querySelector('.follow-up-create-source-summary')!;
    expect(sourceContext.textContent).toContain('Çok Uzun İsimli Klinik');
    expect(sourceContext.textContent).toContain('Sorumlu personel');
    expect(sourceContext.textContent).toContain('Source Staff Marker');
    expect(sourceContext.textContent).not.toContain('İlgili kişi');
    expect(host.querySelector('form')).not.toBeNull();
  });

  it('uses a safe fallback when the source assignee is unavailable', async () => {
    await render(manager, { ...source, assignee: null as unknown as JobCard['assignee'] });
    const sourceContext = host.querySelector('.follow-up-create-source-summary')!;
    expect(sourceContext.textContent).toContain('Sorumlu personel');
    expect(sourceContext.textContent).toContain('Belirtilmedi');
  });

  it('renders the source context once without a second source request', async () => {
    await render();
    expect(jobs.getJobCard).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.follow-up-create-source-summary')).not.toBeNull();
  });

  it('clears form state and action identity when the source changes on the same route', async () => {
    await render();
    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Klinik A talimatı');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, 'Klinik A özel kapsamı');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');
    change(host.querySelector('#follow-up-priority') as HTMLSelectElement, 'urgent');

    const nextSource = {
      ...source, id: '22222222-2222-4222-8222-222222222222', type: 'GENERAL_TASK' as const,
      customerId: null, contactId: null, customer: null, contact: null, engagementKind: null,
    };
    jobs.getJobCard.mockResolvedValue(nextSource);
    await act(async () => root.render(<FollowUpCreatePage sourceId={nextSource.id} user={manager}
      onCancel={() => {}} onCreated={onCreated} />));
    await flush();

    expect((host.querySelector('#follow-up-title') as HTMLInputElement).value).toBe('Takip: Kaynak görüşme');
    expect((host.querySelector('#follow-up-instructions') as HTMLTextAreaElement).value).toBe('');
    expect((host.querySelector('#follow-up-assignee') as HTMLSelectElement).value).toBe('');
    expect((host.querySelector('#follow-up-priority') as HTMLSelectElement).value).toBe('normal');
    expect(host.querySelector('#follow-up-contact')).toBeNull();
    expect(host.textContent).toContain(CUSTOMERLESS_FOLLOW_UP_EXPLANATION);
  });

  it('forces customerless sources to GENERAL_TASK with the exact explanation', async () => {
    await render(manager, {
      ...source, type: 'GENERAL_TASK', customerId: null, contactId: null,
      customer: null, contact: null, engagementKind: null,
    });
    expect((host.querySelector('#follow-up-type') as HTMLSelectElement).value).toBe('GENERAL_TASK');
    const options = host.querySelectorAll('#follow-up-type option');
    expect((options[1] as HTMLOptionElement).disabled).toBe(true);
    expect((options[2] as HTMLOptionElement).disabled).toBe(true);
    expect(host.textContent).toContain(CUSTOMERLESS_FOLLOW_UP_EXPLANATION);
    expect(host.querySelector('#follow-up-contact')).toBeNull();
  });

  it('defaults a Product Delivery source to a Sales Meeting follow-up type', async () => {
    await render(manager, { ...source, type: 'PRODUCT_DELIVERY', engagementKind: null });
    expect((host.querySelector('#follow-up-type') as HTMLSelectElement).value).toBe('SALES_MEETING');
  });

  it('keeps a General Task source default type as General Task', async () => {
    await render(manager, { ...source, type: 'GENERAL_TASK', engagementKind: null });
    expect((host.querySelector('#follow-up-type') as HTMLSelectElement).value).toBe('GENERAL_TASK');
  });

  it('prefills the title with the Takip: prefix and keeps a user edit across a re-render', async () => {
    await render();
    const titleInput = host.querySelector('#follow-up-title') as HTMLInputElement;
    expect(titleInput.value).toBe('Takip: Kaynak görüşme');
    change(titleInput, 'Özel başlık');
    change(host.querySelector('#follow-up-type') as HTMLSelectElement, 'PRODUCT_DELIVERY');
    expect((host.querySelector('#follow-up-title') as HTMLInputElement).value).toBe('Özel başlık');
  });

  it('caps a very long generated title to the 255 code-point domain limit', async () => {
    await render(manager, { ...source, title: 'İ'.repeat(300) });
    const value = (host.querySelector('#follow-up-title') as HTMLInputElement).value;
    expect(value.startsWith('Takip: ')).toBe(true);
    expect(Array.from(value).length).toBe(255);
  });

  it('organizes the create form into purpose-layered sections with read-only customer context', async () => {
    await render();
    expect(Array.from(host.querySelectorAll('[data-follow-up-section] h2')).map((heading) => heading.textContent))
      .toEqual(['Takip işi', 'Atama', 'Planlama']);
    const customerContext = host.querySelector('[data-follow-up-customer-readonly]');
    expect(customerContext).not.toBeNull();
    expect(customerContext?.querySelector('input, select, textarea')).toBeNull();
    expect(customerContext?.textContent).toContain('Çok Uzun İsimli Klinik');
    expect(customerContext?.textContent).toContain('değiştirilemez');
  });

  it('uses shared available slots and applies a selected slot to the planned start', async () => {
    await render();
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');
    await waitForAvailableSlotSearch();
    expect(jobs.findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SALES_MEETING', customerId: 'customer-1', assignedTo: 'staff-2',
    }));
    expect(host.querySelector('.available-slots-notice')).not.toBeNull();
    const salesSlot = host.querySelector<HTMLButtonElement>('[data-available-slot]')!;
    await act(async () => { salesSlot.click(); });
    expect((host.querySelector('#follow-up-scheduled-at') as HTMLInputElement).value)
      .toBe('2026-08-17T13:00');

    jobs.findAvailableSlots.mockClear();
    change(host.querySelector('#follow-up-type') as HTMLSelectElement, 'PRODUCT_DELIVERY');
    await waitForAvailableSlotSearch();
    expect(jobs.findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PRODUCT_DELIVERY', customerId: 'customer-1', assignedTo: 'staff-2',
    }));
    expect(host.querySelector('.available-slots-notice')).not.toBeNull();
  });

  it('does not search for or render available slots for a General Task follow-up', async () => {
    await render(manager, {
      ...source, type: 'GENERAL_TASK', customerId: null, contactId: null,
      customer: null, contact: null, engagementKind: null,
    });
    await waitForAvailableSlotSearch();
    expect(jobs.findAvailableSlots).not.toHaveBeenCalled();
    expect(host.querySelector('.available-slots-notice')).toBeNull();
  });

  it('validates instructions and submits exactly once on a double submit', async () => {
    const pending = deferred<JobCard>();
    jobs.createFollowUp.mockReturnValue(pending.promise);
    await render();
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(host.textContent).toContain('Yeni takip işinin kapsamını yazın');
    expect(jobs.createFollowUp).not.toHaveBeenCalled();

    change(host.querySelector('#follow-up-title') as HTMLInputElement, '  Yeni görüşme  ');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, '  Yeni talimat  ');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).requestSubmit();
      (host.querySelector('form') as HTMLFormElement).requestSubmit();
      await Promise.resolve();
    });
    expect(jobs.createFollowUp).toHaveBeenCalledTimes(1);
    expect(jobs.createFollowUp).toHaveBeenCalledWith(source.id, {
      clientActionId: 'action-1', type: 'SALES_MEETING', title: 'Yeni görüşme',
      followUpInstructions: 'Yeni talimat', scheduledAt: '2026-08-10T06:30:00.000Z',
      assignedTo: 'staff-2', priority: 'normal', dueDate: null,
      contactId: null, engagementKind: 'CUSTOMER_VISIT',
    });
    expect(jobs.createFollowUp.mock.calls[0]?.[1]).not.toHaveProperty('customerId');
    expect(jobs.createFollowUp.mock.calls[0]?.[1]).not.toHaveProperty('scheduledEndsAt');
    expect(jobs.createFollowUp.mock.calls[0]?.[1]).not.toHaveProperty('sourceJobCardId');
    await act(async () => pending.resolve({ ...source, id: 'created-1' }));
    expect(onCreated).toHaveBeenCalledWith('created-1');
  });

  it('removes Contact from a Product Delivery follow-up and submits null', async () => {
    await render();
    change(host.querySelector('#follow-up-type') as HTMLSelectElement, 'PRODUCT_DELIVERY');
    expect(host.querySelector('#follow-up-contact')).toBeNull();
    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Yeni teslim');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, 'Ürünü teslim et.');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await flush();
    expect(jobs.createFollowUp).toHaveBeenCalledWith(source.id, expect.objectContaining({
      type: 'PRODUCT_DELIVERY',
      contactId: null,
    }));
  });

  it('counts Unicode code points and rejects instructions above 4000', async () => {
    await render();
    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Yeni görüşme');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, '😀'.repeat(4_001));
    expect(host.textContent).toContain('4001/4000 karakter');
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(host.textContent).toContain('en fazla 4000 karakter');
    expect(jobs.createFollowUp).not.toHaveBeenCalled();
  });

  it('keeps one action id for ACTION_IN_PROGRESS retry and replaces it after payload edit', async () => {
    jobs.createFollowUp
      .mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'busy', true))
      .mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'busy', true))
      .mockResolvedValueOnce({ ...source, id: 'created-2' });
    await render();
    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Yeni görüşme');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, 'Yeni talimat');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');

    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createFollowUp.mock.calls[0]?.[1].clientActionId).toBe('action-1');
    expect(jobs.createFollowUp.mock.calls[1]?.[1].clientActionId).toBe('action-1');
    expect(host.textContent).toContain('Kısa bir süre bekleyip');

    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Değişen görüşme');
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(jobs.createFollowUp.mock.calls[2]?.[1].clientActionId).toBe('action-2');
    expect(onCreated).toHaveBeenCalledWith('created-2');
  });

  it('keeps the same action id when a committed response is invalid', async () => {
    jobs.createFollowUp
      .mockRejectedValueOnce(new ApiError(0, 'INVALID_RESPONSE', 'invalid response'))
      .mockResolvedValueOnce({ ...source, id: 'created-3' });
    await render();
    change(host.querySelector('#follow-up-title') as HTMLInputElement, 'Yeni görüşme');
    change(host.querySelector('#follow-up-instructions') as HTMLTextAreaElement, 'Yeni talimat');
    change(host.querySelector('#follow-up-assignee') as HTMLSelectElement, 'staff-2');

    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit());

    expect(jobs.createFollowUp.mock.calls[0]?.[1].clientActionId).toBe('action-1');
    expect(jobs.createFollowUp.mock.calls[1]?.[1].clientActionId).toBe('action-1');
    expect(onCreated).toHaveBeenCalledWith('created-3');
  });

  it('hides the follow-up counter above 500 remaining and reveals it within the threshold', async () => {
    await render();
    const textarea = host.querySelector<HTMLTextAreaElement>('#follow-up-instructions')!;
    expect(host.textContent).not.toContain('karakter');
    const setDraft = async (value: string) => {
      change(textarea, value);
      await act(async () => { await Promise.resolve(); });
    };
    await setDraft('a'.repeat(3_500));
    expect(host.textContent).toContain('3500/4000 karakter');
    await setDraft('a'.repeat(3_900));
    expect(host.querySelector('[data-follow-up-instructions-counter]')!.getAttribute('data-counter-state'))
      .toBe('attention');
  });
});
