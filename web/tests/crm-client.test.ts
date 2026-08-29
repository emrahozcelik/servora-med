import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/services/api';
import {
  activateContact, activateCustomer, createContact, createCustomer, deactivateContact,
  deactivateCustomer, deleteCustomer, getContact, getCustomer, listContacts, listCustomerJobs, listCustomers,
  makePrimaryContact, updateContact, updateCustomer,
} from '../src/services/crm-api';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const contact = {
  id: 'contact/1', organizationId: 'org-1', customerId: 'customer/1', name: 'Dr. Ayşe',
  title: null, phone: null, email: null, isPrimary: true, isActive: true, version: 1,
};
const customer = {
  id: 'customer/1', organizationId: 'org-1', name: 'Demo Klinik', customerType: 'clinic',
  taxNumber: null, phone: null, email: null, city: 'İstanbul', district: null, address: null,
  assignedStaffUserId: null, status: 'active', version: 1,
};

describe('CRM API client', () => {
  it('fetches paginated Customer JobCard history with exact filters and parses the narrow row', async () => {
    const history = {
      id: 'job-1', title: 'Takip', type: 'GENERAL_TASK', status: 'COMPLETED', priority: 'normal',
      scheduledAt: null, dueDate: null, createdAt: '2026-07-12T08:00:00Z', updatedAt: '2026-07-12T08:00:00Z',
      completedAt: '2026-07-13T08:00:00Z', assignee: { id: 'staff-1', name: 'Ayşe' },
      customer: { id: 'customer/1', name: 'Klinik' }, contact: null,
      followUp: { sourceJobCardId: 'source-1' }, childCount: 2,
    };
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [history], total: 1, limit: 10, offset: 20 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listCustomerJobs('customer/1', { status: 'completed', type: 'GENERAL_TASK', limit: 10, offset: 20 }))
      .resolves.toMatchObject({ total: 1, items: [{ followUp: { sourceJobCardId: 'source-1' }, childCount: 2 }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/customers/customer%2F1/jobs?status=completed&type=GENERAL_TASK&limit=10&offset=20', expect.anything());
  });
  it('encodes every Customer filter, omits empty values, and includes credentials', async () => {
    const response = {
      items: [{ ...customer, assignedStaffName: null, primaryContact: { id: 'p1', name: 'Başhekim', title: null } }],
      total: 1, limit: 25, offset: 5,
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(response)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCustomers({ q: 'Ayşe & Ortak', status: 'active', customerType: 'clinic',
      assignedStaffUserId: 'staff/a+b', city: 'İstanbul / Avrupa', unassigned: false,
      limit: 25, offset: 5 })).resolves.toMatchObject({ total: 1, limit: 25, offset: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/customers?q=Ay%C5%9Fe+%26+Ortak&status=active&customerType=clinic&assignedStaffUserId=staff%2Fa%2Bb&city=%C4%B0stanbul+%2F+Avrupa&unassigned=false&limit=25&offset=5',
      expect.objectContaining({ credentials: 'include' }),
    );

    await listCustomers({ q: '', city: '' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/customers', expect.anything());
  });

  it('uses encoded nested Contact routes and filters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [contact], total: 1, limit: 10, offset: 2 }))
      .mockResolvedValueOnce(json(contact));
    vi.stubGlobal('fetch', fetchMock);

    await listContacts('customer/1', { q: 'Ayşe + Bey', status: 'all', limit: 10, offset: 2 });
    await getContact('customer/1', 'contact/1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/customers/customer%2F1/contacts?q=Ay%C5%9Fe+%2B+Bey&status=all&limit=10&offset=2',
      '/api/customers/customer%2F1/contacts/contact%2F1',
    ]);
  });

  it('encodes the top-level Customer detail route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ...customer, assignedStaffName: null,
      primaryContact: null, contacts: [], hasOperationHistory: false, openJobCount: 0, completedJobCount: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await getCustomer('customer/1 + özel');
    expect(fetchMock).toHaveBeenCalledWith('/api/customers/customer%2F1%20%2B%20%C3%B6zel',
      expect.objectContaining({ credentials: 'include' }));
  });

  it('parses the authoritative Customer operation-history signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...customer, assignedStaffName: null,
      primaryContact: null, contacts: [], openJobCount: 0, completedJobCount: 0,
      hasOperationHistory: true })));

    await expect(getCustomer('customer/1')).resolves.toMatchObject({ hasOperationHistory: true });
  });

  it('sends exact Customer mutation and command bodies', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(customer)));
    vi.stubGlobal('fetch', fetchMock);
    const create = { name: 'Demo Klinik', customerType: 'clinic' as const, status: 'prospect' as const,
      taxNumber: null, phone: null, email: null, city: 'İstanbul', district: null, address: null,
      assignedStaffUserId: null };
    const update = { expectedVersion: 1, name: 'Demo Klinik', customerType: 'clinic' as const,
      taxNumber: null, phone: null, email: null, city: 'Ankara', district: null, address: null,
      assignedStaffUserId: null };

    await createCustomer(create);
    await updateCustomer('customer/1', update);
    await activateCustomer('customer/1', 2);
    await deactivateCustomer('customer/1', 3);
    await deleteCustomer('customer/1', 3);
    expect(fetchMock.mock.calls.map(([, init]) => [init.method, init.body])).toEqual([
      ['POST', JSON.stringify(create)], ['PATCH', JSON.stringify(update)],
      ['POST', JSON.stringify({ expectedVersion: 2 })],
      ['POST', JSON.stringify({ expectedVersion: 3 })],
      ['DELETE', JSON.stringify({ expectedVersion: 3 })],
    ]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/customers/customer%2F1');
  });

  it('sends exact Contact mutation and command bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(contact, 201)).mockResolvedValueOnce(json(contact))
      .mockResolvedValueOnce(json(contact)).mockResolvedValueOnce(json(contact))
      .mockResolvedValueOnce(json({ contact, previousPrimaryContactId: 'old-contact' }));
    vi.stubGlobal('fetch', fetchMock);
    const create = { name: 'Dr. Ayşe', title: null, phone: null, email: null };
    const update = { expectedVersion: 1, ...create };

    await createContact('customer/1', create);
    await updateContact('customer/1', 'contact/1', update);
    await activateContact('customer/1', 'contact/1', 2);
    await deactivateContact('customer/1', 'contact/1', 3);
    await makePrimaryContact('customer/1', 'contact/1', 4);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ['/api/customers/customer%2F1/contacts', 'POST', JSON.stringify(create)],
      ['/api/customers/customer%2F1/contacts/contact%2F1', 'PATCH', JSON.stringify(update)],
      ['/api/customers/customer%2F1/contacts/contact%2F1/activate', 'POST', JSON.stringify({ expectedVersion: 2 })],
      ['/api/customers/customer%2F1/contacts/contact%2F1/deactivate', 'POST', JSON.stringify({ expectedVersion: 3 })],
      ['/api/customers/customer%2F1/contacts/contact%2F1/make-primary', 'POST', JSON.stringify({ expectedVersion: 4 })],
    ]);
  });

  it('rejects malformed list, detail, mutation, and command responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'broken' })));
    await expect(listCustomers()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(getCustomer('customer-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(createContact('customer-1', { name: 'Ayşe', title: null, phone: null, email: null }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(makePrimaryContact('customer-1', 'contact-1', 1))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects malformed Customer detail history counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...customer, assignedStaffName: null,
      primaryContact: null, contacts: [], hasOperationHistory: false, openJobCount: 'BOGUS', completedJobCount: 0 })));
    await expect(getCustomer('customer-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('propagates VERSION_CONFLICT without retrying the mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      error: 'Kayıt başka bir kullanıcı tarafından güncellendi.', code: 'VERSION_CONFLICT',
      details: { currentVersion: 4 },
    }, 409));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deactivateCustomer('customer-1', 1)).rejects.toMatchObject<ApiError>({
      status: 409, code: 'VERSION_CONFLICT', retryable: false, details: { currentVersion: 4 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores non-object error details while preserving the safe backend error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Sürüm çakıştı.', code: 'VERSION_CONFLICT', details: 'unsafe-shape',
    }, 409)));
    await expect(activateCustomer('customer-1', 1)).rejects.toMatchObject<ApiError>({
      status: 409, code: 'VERSION_CONFLICT', details: null,
    });
  });
});
