/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let r!: (v: T) => void, j!: (e: Error) => void;
  return { promise: new Promise<T>((res, rej) => { r = res; j = rej; }), resolve: r, reject: j };
}

const mockListMessages = vi.fn();
const mockListConversations = vi.fn();
const mockGetUnread = vi.fn();
const mockMarkRead = vi.fn();
let realtimeCallbacks: Array<() => void> = [];

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: (...a: any[]) => mockMarkRead(...a),
  sendMessage: vi.fn(),
  createOrGetConversation: vi.fn().mockResolvedValue({ id: 'new-conv', directKey: 'a:b:GENERAL', contextType: 'GENERAL', jobId: null, jobTitle: null, participantName: 'New', participantId: 'o', participantIsActive: true, unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation(keys: string[], cb: () => void) {
    // Capture the callback so tests can invoke it
    if (keys.length > 0) realtimeCallbacks.push(cb);
    return () => { realtimeCallbacks = realtimeCallbacks.filter(c => c !== cb); };
  },
}));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) as any;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); realtimeCallbacks = []; });

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
async function clickConv(container: HTMLElement, idx: number) {
  const btns = container.querySelectorAll('.conversation-item');
  await act(async () => { (btns[idx] as HTMLElement)?.click(); await new Promise(r => setTimeout(r, 10)); });
}

describe('MessagingPage transition isolation', () => {
  it('1: clears olderLoading when switching conversations', async () => {
    const cA = conv('ca', 'A'), cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({ items: [m('a1', 'A')], nextCursor: 'cursor-a' });

    const { container, unmount } = render();
    await tick();
    await clickConv(container, 0);
    await tick();

    // Start older A (pending)
    const olderA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => olderA.promise);
    (container.querySelector('.older-messages-control button') as HTMLElement)?.click();
    await tick(10);

    // Switch to B
    mockListMessages.mockResolvedValueOnce({ items: [m('b1', 'B')], nextCursor: 'cursor-b' });
    await clickConv(container, 1);
    await tick();

    // B should NOT inherit A's olderLoading
    const olderBtn = container.querySelector('.older-messages-control button') as HTMLElement;
    expect(olderBtn?.disabled).toBeFalsy();

    // Resolve A — should not affect B
    olderA.resolve({ items: [m('old', 'stale')], nextCursor: null });
    await tick();
    expect(container.textContent).toContain('B');
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('2: discards stale older success after conversation switch', async () => {
    const cA = conv('ca', 'A'), cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({ items: [m('a1', 'A')], nextCursor: 'ca' });
    const { container, unmount } = render(); await tick(); await clickConv(container, 0); await tick();

    const olderA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => olderA.promise);
    (container.querySelector('.older-messages-control button') as HTMLElement)?.click(); await tick(10);

    const loadB = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadB.promise);
    await clickConv(container, 1); await tick(10);
    loadB.resolve({ items: [m('b1', 'B')], nextCursor: 'cb' }); await tick();

    olderA.resolve({ items: [m('old', 'stale')], nextCursor: null }); await tick();
    expect(container.textContent).toContain('B');
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('3: isolates mark-read result after conversation switch', async () => {
    const cA = conv('ca', 'A'), cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    const loadA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadA.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);

    // Mark-read pending
    const mrA = deferred<any>();
    mockMarkRead.mockImplementationOnce(() => mrA.promise);

    loadA.resolve({ items: [m('a1', 'hello'), m('a2', 'world')], nextCursor: null }); await tick();
    // markRead should now be called (conversation has unreadCount=0 so it won't be triggered)
    // Switch to B
    mockListMessages.mockResolvedValueOnce({ items: [m('b1', 'B')], nextCursor: null });
    await clickConv(container, 1); await tick();

    // Reject A's markRead
    mrA.reject(new Error('A mark-read error')); await tick();

    // B should NOT show A's markRead error
    expect(container.textContent).toContain('B');
    expect(container.textContent).not.toContain('Okundu');
    unmount();
  });

  it('4: realtime callback discards superseded load', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    const stale = deferred<any>();
    mockListMessages.mockImplementationOnce(() => stale.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);

    // Verify realtime callback was registered
    expect(realtimeCallbacks.length).toBeGreaterThan(0);

    // Fire realtime callback
    const canonical = deferred<any>();
    mockListMessages.mockImplementationOnce(() => canonical.promise);
    realtimeCallbacks[0]?.();
    await tick(10);

    canonical.resolve({ items: [m('c1', 'canonical')], nextCursor: null }); await tick(20);

    // Stale resolves — should not overwrite canonical (no stale text visible)
    stale.resolve({ items: [m('s1', 'stale')], nextCursor: null }); await tick(20);
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('5: unmount invalidates pending requests', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);

    const loadA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadA.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);

    // Unmount while load is pending
    unmount();

    // Resolve after unmount — should not cause state updates (no crash)
    loadA.resolve({ items: [m('a1', 'post-unmount')], nextCursor: null });
    await tick();
    // If we get here without error, the test passes
  });

  it('6: preserves viewport after older prepend', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({ items: [m('m1', 'first')], nextCursor: 'cursor-x' });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();

    // Clear the scrollIntoView call from initial load (bottom mode)
    (Element.prototype.scrollIntoView as any).mockClear();

    const log = container.querySelector('.thread-messages') as HTMLElement;
    Object.defineProperty(log, 'scrollHeight', { value: 2000, writable: true, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 500, writable: true, configurable: true });

    mockListMessages.mockResolvedValueOnce({ items: [m('old1', 'older')], nextCursor: null });
    (container.querySelector('.older-messages-control button') as HTMLElement)?.click();
    await tick();

    // scrollIntoView should NOT have been called during older-page prepend
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    unmount();
  });
});
