import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addDeliveryItem, approveJobCard, createJobCard, getJobCard,
  listActivity, listJobCards, patchDeliveryItem, patchJobCard, removeDeliveryItem,
  requestJobCardRevision, startJobCard, submitJobCardForApproval,
} from '../src/jobs/jobs-api';
import { ApiError, listReferenceCustomers } from '../src/services/api';

afterEach(() => vi.unstubAllGlobals());

const job = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW',
  version: 1, title: 'Teslim', description: null, customerId: 'customer-1', assignedTo: 'staff-1',
  contactId: 'contact-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  customer: { id: 'customer-1', name: 'Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' } };
const jobListItem = {
  id: 'job-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 1, title: 'Teslim',
  priority: 'normal', dueDate: null, createdAt: '2026-07-11T10:00:00.000Z',
  updatedAt: '2026-07-11T10:00:00.000Z', staffCompletedAt: null,
  customer: { id: 'customer-1', name: 'Klinik' }, contact: { id: 'contact-1', name: 'Dr. Deniz' },
  assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 1,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('tracer API client', () => {
  it('loads typed customer references with credentials without a legacy Product request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [{ id: 'c1', name: 'Klinik', customerType: 'clinic', status: 'active' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listReferenceCustomers()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/reference/customers', expect.objectContaining({ credentials: 'include' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports JobCard create, list, detail, and patch contracts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(job, 201)).mockResolvedValueOnce(json({ items: [jobListItem], total: 1, limit: 25, offset: 0 }))
      .mockResolvedValueOnce(json(job)).mockResolvedValueOnce(json({ ...job, version: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const create = { clientActionId: 'a1', type: 'PRODUCT_DELIVERY' as const, title: 'Teslim', customerId: 'c1', contactId: 'contact-1', assignedTo: 's1' };
    await createJobCard(create); await expect(listJobCards()).resolves.toMatchObject({ items: [jobListItem] });
    await expect(getJobCard('job-1')).resolves.toMatchObject({ contactId: 'contact-1' });
    await patchJobCard('job-1', { expectedVersion: 1, title: 'Yeni' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/job-cards', expect.objectContaining({ method: 'POST', body: JSON.stringify(create) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/job-cards/job-1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('supports delivery mutations, lifecycle commands, and activity', async () => {
    const item = { id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
      deliveryPurpose: 'SALE', deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, unit: 'adet',
      productNameSnapshot: 'Set', productSkuSnapshot: 'S1', productModelSnapshot: null,
      lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ item, jobCardVersion: 2 }, 201))
      .mockResolvedValueOnce(json({ item: { ...item, quantity: 3 }, jobCardVersion: 3 }))
      .mockResolvedValueOnce(json({ id: 'i1', jobCardVersion: 4 }))
      .mockResolvedValueOnce(json({ ...job, status: 'IN_PROGRESS', version: 3 }))
      .mockResolvedValueOnce(json({ ...job, status: 'WAITING_APPROVAL', version: 4 }))
      .mockResolvedValueOnce(json({ ...job, status: 'COMPLETED', version: 5 }))
      .mockResolvedValueOnce(json({ ...job, status: 'REVISION_REQUESTED', version: 5 }))
      .mockResolvedValueOnce(json({ items: [{ id: 'e1', jobCardId: 'job-1', eventType: 'JOB_CREATED',
        actor: { id: 's1', name: 'Ayşe Personel' }, details: { kind: 'NONE' }, createdAt: '2026-07-11T10:00:00Z' }],
        total: 1, limit: 50, offset: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await addDeliveryItem('job-1', { clientActionId: 'd1', expectedVersion: 1, productId: 'p1', deliveryPurpose: 'SALE', deliveredAt: '2026-07-11T10:00:00Z', quantity: 2 });
    await patchDeliveryItem('job-1', 'i1', { expectedVersion: 2, quantity: 3 });
    await removeDeliveryItem('job-1', 'i1', 3);
    await startJobCard('job-1', { clientActionId: 's1', expectedVersion: 2 });
    await submitJobCardForApproval('job-1', { clientActionId: 's2', expectedVersion: 3 });
    await approveJobCard('job-1', { clientActionId: 's3', expectedVersion: 4 });
    await requestJobCardRevision('job-1', { clientActionId: 's4', expectedVersion: 4, revisionReason: 'Düzeltin' });
    await expect(listActivity('job-1')).resolves.toMatchObject({ items: [expect.objectContaining({ id: 'e1' })] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/job-cards/job-1/delivery-items', '/api/job-cards/job-1/delivery-items/i1',
      '/api/job-cards/job-1/delivery-items/i1', '/api/job-cards/job-1/start',
      '/api/job-cards/job-1/submit-for-approval', '/api/job-cards/job-1/approve',
      '/api/job-cards/job-1/request-revision', '/api/job-cards/job-1/activity',
    ]);
  });

  it('preserves backend status and code and identifies network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'Kart güncellendi.', code: 'VERSION_CONFLICT' }, 409))
      .mockRejectedValueOnce(new TypeError('network down')));
    await expect(getJobCard('job-1')).rejects.toMatchObject<ApiError>({ status: 409, code: 'VERSION_CONFLICT', retryable: false });
    await expect(listJobCards()).rejects.toMatchObject<ApiError>({ status: 0, code: 'NETWORK_ERROR', retryable: true });
  });

  it('rejects malformed successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'job-1' })));
    await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
