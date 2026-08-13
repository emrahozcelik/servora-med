import { afterEach, describe, expect, it, vi } from 'vitest';

import { listMessages, sendMessage } from '../src/services/messaging-api';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

const rawMessage = {
  id: 'm-1',
  conversationId: 'conv-1',
  organizationId: 'org-1',
  senderUserId: 'staff-1',
  senderName: 'Zeynep Personel',
  clientActionId: 'c-1',
  body: 'Mesaj içeriği',
  createdAt: '2026-08-13T12:00:00.000Z',
};

describe('Message API sender attribution parser (S6)', () => {
  it('listMessages parses the additive senderName field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [rawMessage],
      nextCursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await listMessages('conv-1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].senderName).toBe('Zeynep Personel');
    expect(page.items[0].senderUserId).toBe('staff-1');
  });

  it('sendMessage response parses the additive senderName field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rawMessage));
    vi.stubGlobal('fetch', fetchMock);

    const message = await sendMessage('conv-1', 'Mesaj içeriği', 'c-1');
    expect(message.senderName).toBe('Zeynep Personel');
    expect(message.body).toBe('Mesaj içeriği');
  });
});
