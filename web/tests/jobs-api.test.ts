import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addJobCardNote, approveJobCard, cancelJobCard, createJobCard, getJobCard,
  getJobCardBoard, listActivity, listDeliveryItems, listJobCardNotes, listJobCards, planJobCard,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
} from '../src/jobs/jobs-api';
import { jobActivityLabel } from '../src/jobs/job-labels';

afterEach(() => vi.unstubAllGlobals());

const related = (id: string, name: string) => ({ id, name });
const listItem = {
  id: 'job-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 7,
  title: 'Klinik teslimi', priority: 'urgent', dueDate: '2026-07-20',
  createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z',
  staffCompletedAt: '2026-07-12T10:00:00.000Z', customer: related('c1', 'ABC Klinik'),
  contact: related('ct1', 'Dr. Deniz'), assignee: related('s1', 'Ayşe Personel'), deliveryItemCount: 2,
};
const job = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 7,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: 'ct1',
  assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
};
const note = {
  id: 'note-1', jobCardId: 'job-1', note: 'Klinik arandı',
  author: related('s1', 'Ayşe Personel'), createdAt: '2026-07-13T10:00:00.000Z',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('JobCard workspace transport', () => {
  it('runtime-validates the paginated list including related names and technical version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [listItem], total: 9, limit: 25, offset: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listJobCards({ status: 'WAITING_APPROVAL', limit: 25, offset: 0 })).resolves.toEqual({
      items: [listItem], total: 9, limit: 25, offset: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards?status=WAITING_APPROVAL&limit=25&offset=0',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('runtime-validates all board columns and closed counts', async () => {
    const board = {
      columns: {
        NEW: { items: [listItem], count: 4 }, PLANNED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 2 }, WAITING_APPROVAL: { items: [], count: 1 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 8, CANCELLED: 3 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(board)));
    await expect(getJobCardBoard({ priority: 'urgent', limit: 10 })).resolves.toEqual(board);
  });

  it('runtime-validates paginated notes and always parses the fixed 201 note response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [note], total: 1, limit: 25, offset: 0 }))
      .mockResolvedValueOnce(json(note, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listJobCardNotes('job-1')).resolves.toEqual({ items: [note], total: 1, limit: 25, offset: 0 });
    const input = { clientActionId: 'note-action', note: 'Klinik arandı' };
    await expect(addJobCardNote('job-1', input)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/job-cards/job-1/notes', expect.objectContaining({
      method: 'POST', body: JSON.stringify(input), credentials: 'include',
    }));
  });

  it('accepts unknown activity event strings, validates known details, and exposes no raw JSONB', async () => {
    const activities = [
      { id: 'a2', jobCardId: 'job-1', eventType: 'FUTURE_EVENT', actor: null,
        details: { kind: 'NONE' }, createdAt: '2026-07-13T11:00:00.000Z' },
      { id: 'a1', jobCardId: 'job-1', eventType: 'JOB_STARTED', actor: related('s1', 'Ayşe Personel'),
        details: { kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED', toStatus: 'IN_PROGRESS' },
        createdAt: '2026-07-13T10:00:00.000Z' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: activities, total: 2, limit: 50, offset: 0 })));
    const page = await listActivity('job-1');
    expect(page.items).toEqual(activities);
    expect(page.items[0]!.eventType).toBe('FUTURE_EVENT');
    expect(page.items[0]).not.toHaveProperty('oldValue');
    expect(jobActivityLabel('FUTURE_EVENT')).toBe('İş kaydında bir işlem yapıldı');
    expect(jobActivityLabel('JOB_STARTED')).toBe('İş başlatıldı');
  });

  it('rejects raw activity JSONB fields rather than exposing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [{ id: 'a1', jobCardId: 'job-1', eventType: 'JOB_CREATED', actor: null,
        details: { kind: 'NONE' }, createdAt: '2026-07-13T10:00:00Z', oldValue: { secret: true } }],
      total: 1, limit: 50, offset: 0,
    })));
    await expect(listActivity('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([0, -1])('rejects delivery item quantity %s', async (quantity) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [{
      id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
      deliveryPurpose: 'SALE', deliveredAt: '2026-07-13T10:00:00Z', quantity, unit: 'adet',
      productNameSnapshot: 'Set', productSkuSnapshot: null, productModelSnapshot: null,
      lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
    }] })));
    await expect(listDeliveryItems('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([0, -1])('rejects DELIVERY_ITEM activity detail quantity %s', async (quantity) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [{
      id: 'a1', jobCardId: 'job-1', eventType: 'DELIVERY_ITEM_ADDED', actor: null,
      details: { kind: 'DELIVERY_ITEM', operation: 'ADDED', itemId: 'i1', purpose: 'SALE', quantity },
      createdAt: '2026-07-13T10:00:00Z',
    }], total: 1, limit: 50, offset: 0 })));
    await expect(listActivity('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('supports all seven lifecycle commands and validates every returned JobCard', async () => {
    const fetchMock = vi.fn();
    for (let index = 0; index < 7; index += 1) fetchMock.mockResolvedValueOnce(json({ ...job, version: 8 + index }));
    vi.stubGlobal('fetch', fetchMock);
    const versioned = { clientActionId: 'action', expectedVersion: 7 };
    await planJobCard('job-1', versioned); await startJobCard('job-1', versioned);
    await submitJobCardForApproval('job-1', { ...versioned, note: 'Bitti' });
    await approveJobCard('job-1', { ...versioned, note: 'Uygun' });
    await requestJobCardRevision('job-1', { ...versioned, revisionReason: 'Düzeltin' });
    await resumeJobCard('job-1', versioned);
    await cancelJobCard('job-1', { ...versioned, cancelReason: 'Müşteri iptal etti' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/job-cards/job-1/plan', '/api/job-cards/job-1/start',
      '/api/job-cards/job-1/submit-for-approval', '/api/job-cards/job-1/approve',
      '/api/job-cards/job-1/request-revision', '/api/job-cards/job-1/resume',
      '/api/job-cards/job-1/cancel',
    ]);
  });

  it.each([
    ['detail enum', { ...job, status: 'UNKNOWN' }, () => getJobCard('job-1')],
    ['detail zero version', { ...job, version: 0 }, () => getJobCard('job-1')],
    ['page zero limit', { items: [], total: 0, limit: 0, offset: 0 }, () => listJobCards()],
    ['list relationship', { items: [{ ...listItem, customer: { id: 'c1' } }], total: 1, limit: 25, offset: 0 }, () => listJobCards()],
    ['board count', { columns: { NEW: { items: [], count: -1 } }, closedCounts: { COMPLETED: 0, CANCELLED: 0 } }, () => getJobCardBoard()],
    ['note author', { items: [{ ...note, author: null }], total: 1, limit: 25, offset: 0 }, () => listJobCardNotes('job-1')],
    ['activity details', { items: [{ id: 'a1', jobCardId: 'job-1', eventType: 'JOB_STARTED', actor: null, details: { kind: 'STATUS_TRANSITION', fromStatus: 'BAD', toStatus: 'IN_PROGRESS' }, createdAt: 'x' }], total: 1, limit: 50, offset: 0 }, () => listActivity('job-1')],
  ])('rejects malformed successful %s responses', async (_name, body, call) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body)));
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('validates create and detail responses rather than casting them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(job, 201)).mockResolvedValueOnce(json(job)));
    await expect(createJobCard({ clientActionId: 'a1', type: 'PRODUCT_DELIVERY', title: 'Teslim', customerId: 'c1', assignedTo: 's1' }))
      .resolves.toEqual(job);
    await expect(getJobCard('job-1')).resolves.toEqual(job);
  });
});
