import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  archiveConversation,
  listConversations,
  unarchiveConversation,
} from '../src/services/messaging-api';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

describe('Messaging archive API', () => {
  it('requests the archived view from the server before pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    await listConversations('archived');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/messaging/conversations?limit=20&view=archived',
      { credentials: 'include' },
    );
  });

  it('uses explicit per-conversation archive and unarchive commands', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await archiveConversation('conv/1');
    await unarchiveConversation('conv/1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/messaging/conversations/conv%2F1/archive',
      { method: 'POST', credentials: 'include' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/messaging/conversations/conv%2F1/unarchive',
      { method: 'POST', credentials: 'include' },
    );
  });
});
