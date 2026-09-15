/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn();
const mockGetUnread = vi.fn();
const mockCursorMarkRead = vi.fn();
const mockReconcile = vi.fn();
const realtimeCallbacks = new Map<string, () => void>();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: (...a: any[]) => mockCursorMarkRead(...a),
  sendMessage: vi.fn(),
  createOrGetConversation: vi.fn(),
}));

vi.mock('../src/services/notifications-api', () => ({
  markNotificationsReadByEntity: (...a: any[]) => mockReconcile(...a),
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

function conv(id: string, unreadCount = 1) {
  return {
    id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null,
    customerId: null, customerName: null, title: null, participantName: 'U' + id,
    participantId: 'other-1', participantIsActive: true, participants: [],
    unreadCount, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function msg(id: string, conversationId: string) {
  return {
    id, conversationId, organizationId: 'org-1', senderUserId: 'other-1',
    senderName: 'Other', clientActionId: `action-${id}`, body: 'Merhaba',
    createdAt: new Date().toISOString(),
  };
}

function render(path = '/messages') {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={[path]}><MessagingPage user={user} /></MemoryRouter>); });
  return { container: c, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

function items(container: HTMLDivElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.conversation-item'));
}

describe('MessagingPage notification reconciliation', () => {
  it('reconciles notifications after the selected conversation displays', async () => {
    mockListConversations.mockResolvedValue({ items: [conv('ca')], nextCursor: null });
    mockGetUnread.mockResolvedValue(1);
    mockListMessages.mockResolvedValue({ items: [msg('m1', 'ca')], nextCursor: null });
    mockCursorMarkRead.mockResolvedValue(undefined);
    mockReconcile.mockResolvedValue(undefined);
    const { container, unmount } = render();
    await tick();
    await act(async () => { items(container)[0]!.click(); });
    await tick();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith('conversation', 'ca');
    expect(mockCursorMarkRead).toHaveBeenCalledWith('ca', 'm1');
    unmount();
  });

  it('does not reconcile when the message load fails', async () => {
    mockListConversations.mockResolvedValue({ items: [conv('ca')], nextCursor: null });
    mockGetUnread.mockResolvedValue(1);
    mockListMessages.mockRejectedValue(new Error('network down'));
    mockReconcile.mockResolvedValue(undefined);
    const { container, unmount } = render();
    await tick();
    await act(async () => { items(container)[0]!.click(); });
    await tick();
    expect(mockReconcile).not.toHaveBeenCalled();
    unmount();
  });

  it('stale selection A cannot reconcile after rapid switch to B', async () => {
    let resolveA!: (value: { items: ReturnType<typeof msg>[]; nextCursor: null }) => void;
    let resolveB!: (value: { items: ReturnType<typeof msg>[]; nextCursor: null }) => void;
    mockListConversations.mockResolvedValue({ items: [conv('ca'), conv('cb')], nextCursor: null });
    mockGetUnread.mockResolvedValue(1);
    mockListMessages.mockImplementation((id: string) => id === 'ca'
      ? new Promise((resolve) => { resolveA = resolve; })
      : new Promise((resolve) => { resolveB = resolve; }));
    mockCursorMarkRead.mockResolvedValue(undefined);
    mockReconcile.mockResolvedValue(undefined);
    const { container, unmount } = render();
    await tick();
    const [buttonA, buttonB] = items(container);
    await act(async () => { buttonA!.click(); });
    await act(async () => { buttonB!.click(); });
    await act(async () => { resolveB({ items: [msg('mb', 'cb')], nextCursor: null }); });
    await tick();
    await act(async () => { resolveA({ items: [msg('ma', 'ca')], nextCursor: null }); });
    await tick();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith('conversation', 'cb');
    unmount();
  });

  it('reconciliation failure keeps the conversation usable', async () => {
    mockListConversations.mockResolvedValue({ items: [conv('ca')], nextCursor: null });
    mockGetUnread.mockResolvedValue(1);
    mockListMessages.mockResolvedValue({ items: [msg('m1', 'ca')], nextCursor: null });
    mockCursorMarkRead.mockResolvedValue(undefined);
    mockReconcile.mockRejectedValue(new Error('notification service down'));
    const { container, unmount } = render();
    await tick();
    await act(async () => { items(container)[0]!.click(); });
    await tick();
    expect(container.textContent).toContain('Merhaba');
    expect(container.textContent).not.toContain('notification service down');
    unmount();
  });
});
