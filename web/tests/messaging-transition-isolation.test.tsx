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
const realtimeCallbacks = new Map<string, () => void>();

const mockSendMessage = vi.fn();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: (...a: any[]) => mockMarkRead(...a),
  sendMessage: (...a: any[]) => mockSendMessage(...a),
  createOrGetConversation: vi.fn().mockResolvedValue({ id: 'new-conv', directKey: 'x', contextType: 'GENERAL', jobId: null, jobTitle: null, participantName: 'New', participantId: 'o', participantIsActive: true, unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
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

function m(id: string, body: string, senderId = 'other-user') {
  return { id, conversationId: 'c', organizationId: 'org-1', senderUserId: senderId, clientActionId: id, body, createdAt: new Date().toISOString() };
}
function conv(id: string, name?: string, overrides?: Partial<ReturnType<typeof conv>>) {
  const base = { id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null, participantName: name ?? ('U' + id.slice(0,4)), participantId: 'o', participantIsActive: true, unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { ...base, ...overrides };
}

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

  it('1: realtime conversation-specific callback discards stale load', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const staleLoad = deferred<any>();
    mockListMessages.mockImplementationOnce(() => staleLoad.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);
    const convCallback = realtimeCallbacks.get('conversation:ca');
    expect(convCallback).toBeDefined();
    const canonicalLoad = deferred<any>();
    mockListMessages.mockImplementationOnce(() => canonicalLoad.promise);
    convCallback!(); await tick(10);
    canonicalLoad.resolve({ items: [m('c1', 'canonical')], nextCursor: null }); await tick(20);
    staleLoad.resolve({ items: [m('s1', 'stale')], nextCursor: null }); await tick(20);
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('2: markRead isolation — pending A error does not leak to B', async () => {
    const cA = conv('ca', 'A', { unreadCount: 2 });
    const cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const loadA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadA.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);
    const mrPromise = deferred<any>();
    mockMarkRead.mockImplementationOnce(() => mrPromise.promise);
    loadA.resolve({ items: [m('a1', 'hello', 'other-user'), m('a2', 'world', 'other-user')], nextCursor: null });
    await tick(20);
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
    expect(mockMarkRead).toHaveBeenCalledWith('ca', 'a2');
    const loadB = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadB.promise);
    await clickConv(container, 1); await tick(10);
    loadB.resolve({ items: [m('b1', 'B msg')], nextCursor: null }); await tick(20);
    mrPromise.reject(new Error('A mark-read failed')); await tick(20);
    expect(container.textContent).not.toContain('Okundu');
    unmount();
  });

  it('3: retryMarkRead real button click with stale isolation', async () => {
    const cA = conv('ca', 'A', { unreadCount: 2 });
    const cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render(); await tick();

    // 1. Open A — first markRead rejects
    const mr1 = deferred<any>();
    mockMarkRead.mockImplementationOnce(() => mr1.promise);
    mockListMessages.mockResolvedValueOnce({ items: [m('a1', 'hello', 'other-user'), m('a2', 'world', 'other-user')], nextCursor: null });
    await clickConv(container, 0); await tick(30);
    expect(mockMarkRead).toHaveBeenCalledTimes(1);

    // 2. Reject first — should show retry button
    mr1.reject(new Error('First failed'));
    await tick(30);

    // 3. Find retry button — MUST exist (no conditional fallback)
    const retryBtn = Array.from(container.querySelectorAll('.inline-error .ghost-button'))
      .find(b => b.textContent === 'Tekrar dene') as HTMLElement;
    expect(retryBtn).toBeDefined();

    // 4. Click retry — second markRead starts
    const mr2 = deferred<any>();
    mockMarkRead.mockImplementationOnce(() => mr2.promise);
    await act(async () => { retryBtn.click(); await new Promise(r => setTimeout(r, 10)); });

    expect(mockMarkRead).toHaveBeenCalledTimes(2);
    expect(mockMarkRead).toHaveBeenNthCalledWith(1, 'ca', 'a2');
    expect(mockMarkRead).toHaveBeenNthCalledWith(2, 'ca', 'a2');

    // 5. Switch to B while retry is pending
    const loadB = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadB.promise);
    await clickConv(container, 1); await tick(10);
    loadB.resolve({ items: [m('b1', 'B msg')], nextCursor: null }); await tick(20);

    // 6. Reject A retry — error text and .inline-error must not leak to B
    mr2.reject(new Error('Retry failed'));
    await tick(20);
    expect(container.textContent).toContain('B msg');
    expect(container.textContent).not.toContain('Okundu');
    expect(container.textContent).not.toContain('Retry failed');
    expect(container.querySelector('.inline-error')).toBeNull();
    unmount();
  });

  it('4: scroll restoration exact formula with cursor verification', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({ items: [m('m1', 'first')], nextCursor: 'cursor-x' });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();

    (Element.prototype.scrollIntoView as any).mockClear();

    const log = container.querySelector('.thread-messages') as HTMLElement;

    // Deterministic scroll state — scrollHeight getter returns controllable value
    let measuredScrollHeight = 2000;
    Object.defineProperty(log, 'scrollHeight', { get: () => measuredScrollHeight, configurable: true });
    log.scrollTop = 500;

    // Deferred older-page response — handleLoadOlder reads prevHeight=2000, prevTop=500 synchronously,
    // then suspends at await listMessages(…)
    const olderPage = deferred<any>();
    mockListMessages.mockImplementationOnce(() => olderPage.promise);

    await act(async () => {
      (container.querySelector('.older-messages-control button') as HTMLElement)?.click();
    });

    // At this point handleLoadOlder has captured prevHeight=2000, prevTop=500
    // and is suspended. Set new height before response renders.
    measuredScrollHeight = 2600;

    // Resolve the deferred — flushes microtask continuation + React re-render + useLayoutEffect
    olderPage.resolve({ items: [m('old1', 'older')], nextCursor: null });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Formula: prevTop(500) + (newHeight(2600) - prevHeight(2000)) = 1100
    expect(log.scrollTop).toBe(1100);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(mockListMessages).toHaveBeenLastCalledWith('ca', 'cursor-x');
    unmount();
  });

  it('5: clears olderLoading when switching conversations', async () => {
    const cA = conv('ca', 'A'), cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({ items: [m('a1', 'A')], nextCursor: 'cursor-a' });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    const olderA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => olderA.promise);
    (container.querySelector('.older-messages-control button') as HTMLElement)?.click(); await tick(10);
    mockListMessages.mockResolvedValueOnce({ items: [m('b1', 'B')], nextCursor: 'cursor-b' });
    await clickConv(container, 1); await tick();
    const olderBtn = container.querySelector('.older-messages-control button') as HTMLElement;
    expect(olderBtn?.disabled).toBeFalsy();
    olderA.resolve({ items: [m('old', 'stale')], nextCursor: null }); await tick();
    expect(container.textContent).not.toContain('stale');
    unmount();
  });

  it('6: unmount invalidates pending requests', async () => {
    const cA = conv('ca', 'A');
    mockListConversations.mockResolvedValue({ items: [cA], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const loadA = deferred<any>();
    mockListMessages.mockImplementationOnce(() => loadA.promise);
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick(10);
    unmount();
    loadA.resolve({ items: [m('a1', 'post-unmount')], nextCursor: null }); await tick();
  });
});

describe('MessagingPage stale-send isolation (B5)', () => {

  function threadBodies(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.thread-messages .message-bubble:not(.pending) .message-body'))
      .map((el) => el.textContent ?? '');
  }

  function composerValue(container: HTMLElement): string {
    return (container.querySelector('.composer-input') as HTMLTextAreaElement)?.value ?? '';
  }

  function pendingBubble(container: HTMLElement): HTMLElement | null {
    return container.querySelector('.message-bubble.own.pending');
  }

  async function typeComposer(container: HTMLElement, text: string) {
    const ta = container.querySelector('.composer-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(ta, text);
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }

  async function clickSend(container: HTMLElement) {
    await act(async () => {
      (container.querySelector('.send-button') as HTMLElement)?.click();
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  async function pressEnter(container: HTMLElement) {
    const ta = container.querySelector('.composer-input') as HTMLElement;
    await act(async () => {
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  function sendResponse(convId: string, id: string, body: string, extra?: Record<string, unknown>) {
    return {
      id, conversationId: convId, organizationId: 'org-1', senderUserId: 'admin-1',
      senderName: 'Admin', clientActionId: id, body, createdAt: new Date().toISOString(), ...extra,
    };
  }

  function twoConversations() {
    const cA = conv('ca', 'A'), cB = conv('cb', 'B');
    mockListConversations.mockResolvedValue({ items: [cA, cB], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
  }

  it('B5-1: stale A success does not touch B thread or composer', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith('ca', 'A one', expect.any(String));
    mockListMessages.mockResolvedValueOnce({ items: [m('b0', 'B old')], nextCursor: null });
    await clickConv(container, 1); await tick();
    await typeComposer(container, 'B draft');
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['B old']);
    expect(composerValue(container)).toBe('B draft');
    expect(container.textContent).not.toContain('A one');
    expect(pendingBubble(container)).toBeNull();
    unmount();
  });

  it('B5-2: stale A failure does not leak error or draft into B', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    mockListMessages.mockResolvedValueOnce({ items: [m('b0', 'B old')], nextCursor: null });
    await clickConv(container, 1); await tick();
    await typeComposer(container, 'B draft');
    sendA.reject(new Error('A send failed')); await tick(20);
    expect(threadBodies(container)).toEqual(['B old']);
    expect(composerValue(container)).toBe('B draft');
    expect(container.querySelector('.thread-composer .inline-error')).toBeNull();
    expect(container.textContent).not.toContain('A send failed');
    unmount();
  });

  it('B5-3: out-of-order — A settles after B send started, B state intact, then B completes', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    mockListMessages.mockResolvedValueOnce({ items: [m('b0', 'B old')], nextCursor: null });
    await clickConv(container, 1); await tick();
    await typeComposer(container, 'B one');
    const sendB = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendB.promise);
    await clickSend(container);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['B old']);
    expect(composerValue(container)).toBe('B one');
    expect(pendingBubble(container)).not.toBeNull();
    expect(pendingBubble(container)?.textContent).toContain('B one');
    expect(container.textContent).not.toContain('A one');
    sendB.resolve(sendResponse('cb', 'msg-b1', 'B one')); await tick(20);
    expect(threadBodies(container)).toEqual(['B old', 'B one']);
    expect(composerValue(container)).toBe('');
    expect(pendingBubble(container)).toBeNull();
    unmount();
  });

  it('B5-4: A -> B -> A supersession — obsolete A send never regains ownership', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    mockListMessages.mockResolvedValueOnce({ items: [m('b0', 'B old')], nextCursor: null });
    await clickConv(container, 1); await tick();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    await clickConv(container, 0); await tick();
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['A old']);
    // Established composer-switch contract: selectConversation preserves
    // composerText across switches (only draft/error are reset). The stale
    // send neither cleared nor overwrote it — full ownership inertness.
    expect(composerValue(container)).toBe('A one');
    unmount();
  });

  it('B5-5: same-conversation success preserved — append once, composer clears', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    expect(composerValue(container)).toBe('');
    expect(pendingBubble(container)).toBeNull();
    unmount();
  });

  it('B5-6: same-conversation failure keeps retry with the same clientActionId', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    sendA.reject(new Error('A send failed')); await tick(20);
    const errBox = container.querySelector('.thread-composer .inline-error') as HTMLElement;
    expect(errBox).not.toBeNull();
    expect(errBox.textContent).toContain('A send failed');
    const retryBtn = Array.from(errBox.querySelectorAll('.ghost-button'))
      .find((b) => b.textContent === 'Tekrar gönder') as HTMLElement;
    expect(retryBtn).toBeDefined();
    const sendRetry = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendRetry.promise);
    await act(async () => { retryBtn.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[1][2]).toBe(mockSendMessage.mock.calls[0][2]);
    sendRetry.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    expect(container.querySelector('.thread-composer .inline-error')).toBeNull();
    unmount();
  });

  it('B5-7: duplicate server response is never appended twice', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one', { isDuplicate: true })); await tick(20);
    expect(threadBodies(container)).toEqual(['A old']);
    expect(composerValue(container)).toBe('');
    unmount();
  });

  it('B5-8: realtime refresh during a pending same-conversation send does not orphan it', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    const convCallback = realtimeCallbacks.get('conversation:ca');
    expect(convCallback).toBeDefined();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    convCallback!(); await tick(20);
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    expect(composerValue(container)).toBe('');
    expect(pendingBubble(container)).toBeNull();
    expect(container.textContent).not.toContain('Gönderiliyor');
    unmount();
  });

  it('B5-9: rapid double-Enter starts a single send', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementation(() => sendA.promise);
    await pressEnter(container);
    await pressEnter(container);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    unmount();
  });

  it('B5-10: unmount while send pending leaves no stale local-state application', async () => {
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    unmount();
    sendA.resolve(sendResponse('ca', 'msg-a1', 'A one')); await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('B5-11: realtime refresh landing before send completion must not duplicate the message', async () => {
    // Review ordering gap: the server persists the sent message and publishes
    // the conversation realtime event before the HTTP send promise settles.
    // The canonical refresh may therefore already contain the new message
    // when the owned send success (isDuplicate: false) arrives.
    twoConversations();
    mockListMessages.mockResolvedValueOnce({ items: [m('a0', 'A old')], nextCursor: null });
    const { container, unmount } = render(); await tick();
    await clickConv(container, 0); await tick();
    await typeComposer(container, 'A one');
    const sendA = deferred<any>();
    mockSendMessage.mockImplementationOnce(() => sendA.promise);
    await clickSend(container);
    const convCallback = realtimeCallbacks.get('conversation:ca');
    expect(convCallback).toBeDefined();
    const sent = sendResponse('ca', 'msg-a1', 'A one');
    const realtimeRefresh = deferred<any>();
    mockListMessages.mockImplementationOnce(() => realtimeRefresh.promise);
    convCallback!(); await tick(10);
    realtimeRefresh.resolve({ items: [m('a0', 'A old'), sent], nextCursor: null }); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    sendA.resolve(sent); await tick(20);
    expect(threadBodies(container)).toEqual(['A old', 'A one']);
    expect(composerValue(container)).toBe('');
    expect(pendingBubble(container)).toBeNull();
    expect(container.textContent).not.toContain('Gönderiliyor');
    unmount();
  });
});
