/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn();
const mockGetUnread = vi.fn();
const realtimeCallbacks = new Map<string, () => void>();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: vi.fn(),
  sendMessage: vi.fn(),
  createOrGetConversation: vi.fn(),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation(keys: string[], cb: () => void) {
    for (const key of keys) realtimeCallbacks.set(key, cb);
    return () => { for (const key of keys) realtimeCallbacks.delete(key); };
  },
}));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) as any;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); realtimeCallbacks.clear(); });

const user = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'a@t.t', role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: true, calendar: true, messaging: true }, support: { displayLabel: '', email: null, helpUrl: null } };

function conv(id: string, name?: string) {
  return { id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null, participantName: name ?? ('U' + id.slice(0, 4)), participantId: 'o', participantIsActive: true, unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function render() {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={['/messages']}><MessagingPage user={user} /></MemoryRouter>); });
  return { container: c, root: r, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

describe('MessagingPage conversation list states', () => {
  it('1: list fetch failure renders error + retry and never claims emptiness or no-selection', async () => {
    mockListConversations.mockRejectedValue(new Error('network down'));
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    expect(container.textContent).toContain('Konuşmalar yüklenemedi');
    const retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Tekrar dene');
    expect(retry).toBeDefined();
    expect(container.textContent).not.toContain('Konuşma bulunmuyor');
    expect(container.textContent).not.toContain('Konuşma seçin');
    expect(container.querySelectorAll('.conversation-item').length).toBe(0);
    unmount();
  });

  it('2: retry after failure recovers into a loaded conversation list', async () => {
    mockListConversations
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ items: [conv('ca', 'A')], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    expect(container.textContent).toContain('Konuşmalar yüklenemedi');
    const retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Tekrar dene') as HTMLElement;
    await act(async () => { retry.click(); await new Promise(r => setTimeout(r, 50)); });
    expect(container.querySelectorAll('.conversation-item').length).toBe(1);
    expect(container.textContent).not.toContain('Konuşmalar yüklenemedi');
    unmount();
  });

  it('3: successful empty list shows empty state without load-error and without no-selection', async () => {
    mockListConversations.mockResolvedValue({ items: [], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    expect(container.textContent).toContain('Konuşma bulunmuyor');
    expect(container.textContent).not.toContain('Konuşmalar yüklenemedi');
    expect(container.textContent).not.toContain('Konuşma seçin');
    unmount();
  });

  it('4: successful non-empty list with nothing selected shows the list and normal no-selection', async () => {
    mockListConversations.mockResolvedValue({ items: [conv('ca', 'A'), conv('cb', 'B')], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    expect(container.querySelectorAll('.conversation-item').length).toBe(2);
    expect(container.textContent).toContain('Konuşma seçin');
    expect(container.textContent).not.toContain('Konuşma bulunmuyor');
    unmount();
  });
});
