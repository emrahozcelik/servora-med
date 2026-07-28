/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

// Deferred Promise helper
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Mock services
const mockListMessages = vi.fn();
const mockListConversations = vi.fn();
const mockGetUnread = vi.fn();
const mockMarkRead = vi.fn();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: (...a: any[]) => mockMarkRead(...a),
  sendMessage: vi.fn(),
  createOrGetConversation: vi.fn(),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({ useRealtimeInvalidation: vi.fn() }));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) as any;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); });

const user = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'a@t.t', role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: true, calendar: true, messaging: true }, support: { displayLabel: '', email: null, helpUrl: null } };

function m(id: string, body: string) { return { id, conversationId: 'c', organizationId: 'org-1', senderUserId: 'o', clientActionId: id, body, createdAt: new Date().toISOString() }; }
function conv(id: string, name?: string) { return { id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null, participantName: name ?? ('U' + id.slice(0,4)), participantId: 'o', participantIsActive: true, unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }

function render() {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={['/messages']}><MessagingPage user={user} /></MemoryRouter>); });
  return { container: c, root: r, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

async function openConversation(container: HTMLElement, index: number) {
  const btns = container.querySelectorAll('.conversation-item');
  await act(async () => { (btns[index] as HTMLElement)?.click(); await new Promise(r => setTimeout(r, 10)); });
}

describe('MessagingPage request isolation', () => {
  it('1: discards initial thread response after conversation switch', async () => {
    const loadA = deferred<any>();
    const convA = conv('conv-a', 'User A');
    const convB = conv('conv-b', 'User B');

    mockListConversations.mockResolvedValue({ items: [convA, convB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    // First loadMessages call will be for convA (pending)
    mockListMessages.mockImplementationOnce(() => loadA.promise);

    const { container, unmount } = render();
    await tick();

    // Click convA — triggers loadMessages which is pending
    await openConversation(container, 0);
    await tick(10);

    // Switch to convB
    const loadB = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadB.promise);
    await openConversation(container, 1);
    await tick(10);

    // Resolve convB first
    loadB.resolve({ items: [m('b1', 'conv B msg')], nextCursor: null });
    await tick();
    expect(container.textContent).toContain('conv B msg');

    // Now resolve stale convA response — should NOT affect state
    loadA.resolve({ items: [m('a1', 'conv A msg')], nextCursor: null });
    await tick();

    expect(container.textContent).toContain('conv B msg');
    expect(container.textContent).not.toContain('conv A msg');
    unmount();
  });

  it('2: discards superseded realtime thread load', async () => {
    const convA = conv('conv-a', 'User A');
    mockListConversations.mockResolvedValue({ items: [convA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    // First load (stale)
    const stale = deferred<any>();
    mockListMessages.mockImplementationOnce(() => stale.promise);

    const { container, unmount } = render();
    await tick();

    // Open conv — first load is pending
    await openConversation(container, 0);
    await tick(10);

    // Second load (canonical — simulates realtime refresh)
    const canonical = deferred<any>();
    mockListMessages.mockImplementationOnce(() => canonical.promise);
    // Trigger a second load (simulating realtime) by clicking again
    await openConversation(container, 0);
    await tick(10);

    // Resolve canonical first
    canonical.resolve({ items: [m('c1', 'canonical')], nextCursor: null });
    await tick();
    expect(container.textContent).toContain('canonical');

    // Stale resolves — should not overwrite canonical
    stale.resolve({ items: [m('s1', 'stale')], nextCursor: null });
    await tick();
    expect(container.textContent).toContain('canonical');
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('3: stale older error does not appear after conversation switch', async () => {
    const convA = conv('conv-a', 'User A');
    const convB = conv('conv-b', 'User B');
    mockListConversations.mockResolvedValue({ items: [convA, convB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    // Initial loads for both convs
    mockListMessages.mockResolvedValueOnce({ items: [m('a1', 'A msg')], nextCursor: 'cursor-a' });
    mockListMessages.mockResolvedValueOnce({ items: [m('b1', 'B msg')], nextCursor: 'cursor-b' });

    const { container, unmount } = render();
    await tick();

    // Open convA
    await openConversation(container, 0);
    await tick();

    // Start older request for convA (will fail)
    const olderA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => olderA.promise);
    const olderBtn = container.querySelector('.older-messages-control button') as HTMLElement;
    await act(async () => { olderBtn?.click(); await new Promise(r => setTimeout(r, 10)); });

    // Switch to convB
    await openConversation(container, 1);
    await tick();

    // Now reject convA's older request
    olderA.reject(new Error('Stale error'));
    await tick();

    // convB should NOT show convA's error
    expect(container.textContent).toContain('B msg');
    expect(container.textContent).not.toContain('Eski mesajlar yüklenemedi');
    unmount();
  });
});
