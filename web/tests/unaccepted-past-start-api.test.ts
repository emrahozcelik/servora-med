import { afterEach, describe, expect, it, vi } from 'vitest';

import { listUnacceptedPastStart, type UnacceptedPastStartItem } from '../src/jobs/jobs-api';

afterEach(() => vi.unstubAllGlobals());

const listItem: UnacceptedPastStartItem = {
  jobCardId: 'job-1',
  title: 'Klinik sterilizasyon eğitimi',
  type: 'GENERAL_TASK',
  jobPath: '/jobs/job-1',
  assignee: { id: 'staff-1', name: 'Ayşe Personel', active: true },
  scheduledAt: '2026-11-21T11:00:00.000Z',
  elapsedSeconds: 5_400,
  hasOpenChangeRequest: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('unaccepted past-start list (OVR-6 §6)', () => {
  it('requests the management list with pagination and parses every item field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [listItem], total: 3, limit: 25, offset: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listUnacceptedPastStart({ limit: 25, offset: 0 })).resolves.toEqual({
      items: [listItem], total: 3, limit: 25, offset: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/pending-acceptance/past-start?limit=25&offset=0',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('accepts an inactive assignee, a zero elapsed time and an open change request', async () => {
    const flagged: UnacceptedPastStartItem = {
      ...listItem,
      assignee: { id: 'staff-2', name: 'Mert Personel', active: false },
      elapsedSeconds: 0,
      hasOpenChangeRequest: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [flagged], total: 1, limit: 25, offset: 0,
    })));

    await expect(listUnacceptedPastStart()).resolves.toEqual({
      items: [flagged], total: 1, limit: 25, offset: 0,
    });
  });

  it.each([
    ['unknown job type', { ...listItem, type: 'SURVEY' }],
    ['extra key', { ...listItem, jobType: 'GENERAL_TASK' }],
    ['missing title key', (() => {
      const { title: _omitted, ...rest } = listItem;
      return rest;
    })()],
    ['empty job path', { ...listItem, jobPath: '' }],
    ['non-canonical scheduled instant', { ...listItem, scheduledAt: '2026-11-21T11:00:00Z' }],
    ['negative elapsed seconds', { ...listItem, elapsedSeconds: -1 }],
    ['non-integer elapsed seconds', { ...listItem, elapsedSeconds: 1.5 }],
    ['string change-request flag', { ...listItem, hasOpenChangeRequest: 'false' }],
    ['extra assignee field', { ...listItem, assignee: { ...listItem.assignee, email: 'a@example.com' } }],
    ['missing assignee active flag', { ...listItem, assignee: { id: 'staff-1', name: 'Ayşe Personel' } }],
  ])('rejects a list item with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [candidate], total: 1, limit: 25, offset: 0,
    })));
    await expect(listUnacceptedPastStart()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
