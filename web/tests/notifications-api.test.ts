import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getUnreadNotificationCount,
  listNotifications,
  markNotificationRead,
  parseNotificationPage,
} from '../src/services/notifications-api';

afterEach(() => vi.unstubAllGlobals());

describe('Notification API transport', () => {
  it('loads and strictly parses the unread count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ unreadCount: 3 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnreadNotificationCount()).resolves.toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/unread-count', expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('strictly parses public notification pages and sends one scalar cursor', async () => {
    const item = {
      id: '11111111-1111-4111-8111-111111111111', kind: 'job.assigned',
      title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.',
      entity: { type: 'job-card', id: '22222222-2222-4222-8222-222222222222' },
      createdAt: '2026-07-21T10:00:00.000Z', readAt: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [item], nextCursor: 'cursor-value',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listNotifications({ limit: 20, cursor: 'cursor-value' })).resolves.toEqual({
      items: [item], nextCursor: 'cursor-value',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications?limit=20&cursor=cursor-value', expect.objectContaining({ credentials: 'include' }),
    );

    expect(() => parseNotificationPage({
      items: [{ ...item, recipientUserId: 'staff-1' }], nextCursor: null,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('marks an item read through the API and preserves server errors', async () => {
    const item = {
      id: '11111111-1111-4111-8111-111111111111', kind: 'job.approved',
      title: 'İş onaylandı', body: 'İşiniz onaylandı.',
      entity: { type: 'job-card', id: '22222222-2222-4222-8222-222222222222' },
      createdAt: '2026-07-21T10:00:00.000Z', readAt: '2026-07-21T11:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(item), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(markNotificationRead(item.id)).resolves.toEqual(item);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/notifications/${item.id}/read`, expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
    );
  });

  it.each([
    { unreadCount: -1 }, { unreadCount: 1.5 }, { unreadCount: '1' },
  ])('rejects malformed unread counts: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(getUnreadNotificationCount()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
