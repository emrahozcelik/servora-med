/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesMeetingEditForm } from '../src/jobs/SalesMeetingEditForm';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));
const crm = vi.hoisted(() => ({ listCustomers: vi.fn(), listContacts: vi.fn() }));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));
vi.mock('../src/services/crm-api', async (original) => ({
  ...await original<typeof import('../src/services/crm-api')>(), ...crm,
}));

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Sezer Dener', email: 's@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Yönetici', role: 'MANAGER' };
const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 5,
  title: 'Dizayn ile görüşme', description: 'İmplant sunumu', customerId: 'customer-1',
  contactId: 'contact-1', assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'high',
  dueDate: '2026-07-17', assignee: { id: 'staff-1', name: 'Sezer Dener' },
  customer: { id: 'customer-1', name: 'A Klinik' }, contact: { id: 'contact-1', name: 'Dr. A' },
  workflowContext,
};
const customer = (id: string, name: string) => ({
  id, organizationId: 'org-1', name, customerType: 'clinic', taxNumber: null, phone: null,
  email: null, city: null, district: null, address: null, assignedStaffUserId: null,
  assignedStaffName: null, status: 'active', version: 1, primaryContact: null,
});
const contact = (customerId: string, id: string, name: string) => ({
  id, organizationId: 'org-1', customerId, name, title: null, phone: null, email: null,
  isPrimary: false, isActive: true, version: 1,
});
const profile = (id: string, name: string) => ({
  id: `profile-${id}`, user: { ...staff, id, name, email: `${id}@test.local` },
  title: null, phone: null, region: null, managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
});
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function settle() { await act(async () => { await Promise.resolve(); }); }

describe('SalesMeetingEditForm', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    crm.listCustomers.mockResolvedValue({
      items: [customer('customer-1', 'A Klinik'), customer('customer-2', 'B Klinik')],
      total: 2, limit: 200, offset: 0,
    });
    crm.listContacts.mockImplementation((customerId: string) => Promise.resolve({
      items: customerId === 'customer-1' ? [contact(customerId, 'contact-1', 'Dr. A')]
        : [contact(customerId, 'contact-2', 'Dr. B')], total: 1, limit: 200, offset: 0,
    }));
    people.listStaff.mockResolvedValue([profile('staff-1', 'Sezer Dener'), profile('staff-2', 'Bora')]);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('loads canonical fields and keeps Staff assignment fixed', async () => {
    await act(async () => root.render(<SalesMeetingEditForm job={job} user={staff} pending={false}
      onCancel={vi.fn()} onSave={vi.fn()} />));
    await settle();
    expect((container.querySelector('#meeting-edit-title') as HTMLInputElement).value).toBe(job.title);
    expect((container.querySelector('#meeting-edit-description') as HTMLTextAreaElement).value).toBe(job.description);
    expect(container.querySelector('#meeting-edit-due-date')).toBeNull();
    expect((container.querySelector('#meeting-edit-customer') as HTMLSelectElement).value).toBe(job.customerId);
    expect((container.querySelector('#meeting-edit-contact') as HTMLSelectElement).value).toBe(job.contactId);
    expect(container.querySelector('#meeting-edit-assignee')).toBeNull();
    expect(people.listStaff).not.toHaveBeenCalled();
  });

  it('loads management assignment and submits the full canonical patch', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<SalesMeetingEditForm job={job} user={manager} pending={false}
      onCancel={vi.fn()} onSave={onSave} />));
    await settle();
    expect(container.querySelector('#meeting-edit-assignee')).not.toBeNull();
    change(container.querySelector('#meeting-edit-title')!, '  Güncel başlık  ');
    change(container.querySelector('#meeting-edit-description')!, '  Güncel açıklama  ');
    await act(async () => change(container.querySelector('#meeting-edit-customer')!, 'customer-2'));
    await settle();
    expect((container.querySelector('#meeting-edit-contact') as HTMLSelectElement).value).toBe('');
    change(container.querySelector('#meeting-edit-contact')!, 'contact-2');
    change(container.querySelector('#meeting-edit-assignee')!, 'staff-2');
    change(container.querySelector('#meeting-edit-priority')!, 'urgent');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith({
      expectedVersion: 5, title: 'Güncel başlık', description: 'Güncel açıklama',
      customerId: 'customer-2', contactId: 'contact-2', assignedTo: 'staff-2',
      priority: 'urgent',
    });
  });

  it('requires title, customer, and manager assignee and supports cancel', async () => {
    const onSave = vi.fn(); const onCancel = vi.fn();
    await act(async () => root.render(<SalesMeetingEditForm job={{ ...job, assignedTo: '' }} user={manager}
      pending={false} onCancel={onCancel} onSave={onSave} />));
    await settle();
    change(container.querySelector('#meeting-edit-title')!, ' ');
    change(container.querySelector('#meeting-edit-customer')!, '');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    for (const id of ['meeting-edit-title', 'meeting-edit-customer', 'meeting-edit-assignee']) {
      expect(container.querySelector(`#${id}`)?.getAttribute('aria-invalid')).toBe('true');
    }
    expect(container.querySelector('#meeting-edit-due-date')).toBeNull();
    await act(async () => (container.querySelector('[data-cancel-meeting-edit]') as HTMLButtonElement).click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('Sales Meeting withdraw-to-edit confirmation copy', () => {
  it('exposes role-specific withdraw confirmation labels from the presentation SSOT', async () => {
    const { deriveJobWorkflowPresentation } = await import('../src/jobs/job-workflow-presentation');
    const waiting: JobCard = {
      ...job,
      status: 'WAITING_APPROVAL',
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES'],
        lifecycle: {
          ...workflowContext.lifecycle,
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
        },
        submissionReadiness: null,
      },
    };
    const staffModel = deriveJobWorkflowPresentation({
      job: waiting, user: staff, workflowContext: waiting.workflowContext,
      deliveryItems: [], meetingDetails: null,
    });
    const managerModel = deriveJobWorkflowPresentation({
      job: waiting, user: manager, workflowContext: waiting.workflowContext,
      deliveryItems: [], meetingDetails: null,
    });
    expect(staffModel.recordEditAction).toMatchObject({
      action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
      label: 'Kontrolden geri çek ve düzenle',
      confirmation: { confirmLabel: 'Geri çek ve düzenle' },
    });
    expect(managerModel.recordEditAction).toMatchObject({
      action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
      label: 'Kontrolden çıkar ve kayıtları düzenle',
      confirmation: { confirmLabel: 'Kontrolden çıkar ve düzenle' },
    });
    expect(staffModel.recordEditAction?.consequence).toMatch(/Uygulanıyor/);
    expect(managerModel.recordEditAction?.consequence).toMatch(/onaylamaz veya tamamlamaz/);
  });
});
