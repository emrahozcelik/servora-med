/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn();
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

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation() { return () => {}; },
}));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) as any;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); });

const user = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'a@t.t', role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: true, calendar: true, messaging: true }, support: { displayLabel: '', email: null, helpUrl: null } };

function m(id: string, body: string, senderUserId: string, senderName: string) {
  return {
    id, conversationId: 'conv-1', organizationId: 'org-1',
    senderUserId, senderName, clientActionId: id, body,
    createdAt: new Date().toISOString(),
  };
}

function conv() {
  return {
    id: 'conv-1', directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const,
    jobId: null, jobTitle: null, customerId: null, customerName: null, title: null,
    participantName: 'Uydu', participantId: 'o', participantIsActive: true,
    participants: [
      { userId: 'admin-1', name: 'Admin', isActive: true },
      { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true },
    ],
    unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function render() {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={['/messages']}><MessagingPage user={user} /></MemoryRouter>); });
  return { container: c, root: r, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

async function openConversation(container: HTMLElement) {
  const btn = container.querySelector('.conversation-item') as HTMLElement;
  await act(async () => { btn?.click(); await new Promise(r => setTimeout(r, 10)); });
}

describe('Message sender attribution rendering (multiparty repair)', () => {
  it('S1: two different incoming senders show correct distinct labels tied to the right message', async () => {
    mockListConversations.mockResolvedValue({ items: [conv()], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({
      items: [
        m('m1', 'Zeynep içeriği', 'staff-2', 'Zeynep Personel'),
        m('m2', 'Ali içeriği', 'staff-3', 'Ali Personel'),
      ],
      nextCursor: null,
    });
    const { container, unmount } = render();
    await tick();
    await openConversation(container); await tick();

    const bubbles = Array.from(container.querySelectorAll('.message-bubble'));
    const zeynepBubble = bubbles.find((b) => b.textContent?.includes('Zeynep içeriği'));
    const aliBubble = bubbles.find((b) => b.textContent?.includes('Ali içeriği'));
    expect(zeynepBubble).toBeDefined();
    expect(aliBubble).toBeDefined();
    expect(zeynepBubble!.className).toContain('other');
    expect(aliBubble!.className).toContain('other');

    const zeynepLabel = zeynepBubble!.querySelector('.message-sender');
    const aliLabel = aliBubble!.querySelector('.message-sender');
    expect(zeynepLabel?.textContent).toBe('Zeynep Personel');
    expect(aliLabel?.textContent).toBe('Ali Personel');
    expect(zeynepLabel?.textContent).not.toBe(aliLabel?.textContent);
    unmount();
  });

  it('S2: own message keeps own/right presentation without a sender label', async () => {
    mockListConversations.mockResolvedValue({ items: [conv()], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValueOnce({
      items: [
        m('m-own', 'Kendi mesajım', 'admin-1', 'Admin'),
        m('m-other', 'Gelen mesaj', 'staff-2', 'Zeynep Personel'),
      ],
      nextCursor: null,
    });
    const { container, unmount } = render();
    await tick();
    await openConversation(container); await tick();

    const ownBubble = Array.from(container.querySelectorAll('.message-bubble'))
      .find((b) => b.textContent?.includes('Kendi mesajım'));
    const otherBubble = Array.from(container.querySelectorAll('.message-bubble'))
      .find((b) => b.textContent?.includes('Gelen mesaj'));
    expect(ownBubble!.className).toContain('own');
    expect(ownBubble!.querySelector('.message-sender')).toBeNull();
    expect(otherBubble!.querySelector('.message-sender')?.textContent).toBe('Zeynep Personel');
    unmount();
  });

  it('S3: historical sender absent from current participants still renders senderName', async () => {
    mockListConversations.mockResolvedValue({ items: [conv()], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    // 'former-1' is not present in conv().participants — the projection must
    // not depend on current participant membership.
    mockListMessages.mockResolvedValueOnce({
      items: [m('m-hist', 'Geçmiş atama mesajı', 'former-1', 'Eski Personel')],
      nextCursor: null,
    });
    const { container, unmount } = render();
    await tick();
    await openConversation(container); await tick();

    const bubble = Array.from(container.querySelectorAll('.message-bubble'))
      .find((b) => b.textContent?.includes('Geçmiş atama mesajı'));
    expect(bubble).toBeDefined();
    expect(bubble!.querySelector('.message-sender')?.textContent).toBe('Eski Personel');
    unmount();
  });
});
