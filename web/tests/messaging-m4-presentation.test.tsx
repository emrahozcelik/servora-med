/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn();
const mockGetUnread = vi.fn();

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

function conv(overrides: Partial<ReturnType<typeof base>> & { id: string }) {
  return { ...base(overrides.id), ...overrides };
}
function base(id: string) {
  return {
    id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null,
    customerId: null, customerName: null, title: null,
    participantName: 'U' + id.slice(0, 4), participantId: 'o', participantIsActive: true,
    participants: [], unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function render() {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={['/messages']}><MessagingPage user={user} /></MemoryRouter>); });
  return { container: c, root: r, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

const jobConv = conv({
  id: 'c-job', contextType: 'JOB', jobId: 'job-1', jobTitle: 'Diş ünitesi teslimi',
  participants: [
    { userId: 'admin-1', name: 'Admin', isActive: true },
    { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true },
  ],
});
const customerConv = conv({
  id: 'c-cust', contextType: 'CUSTOMER', customerId: 'cust-1', customerName: 'Klinik A',
  title: 'Yeni cihaz demo',
  participants: [
    { userId: 'admin-1', name: 'Admin', isActive: true },
    { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true },
    { userId: 'staff-3', name: 'Mehmet Kaya', isActive: true },
  ],
});
const generalConv = conv({
  id: 'c-gen', contextType: 'GENERAL', title: 'Ay sonu toplantı',
  participants: [
    { userId: 'admin-1', name: 'Admin', isActive: true },
    { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true },
    { userId: 'staff-3', name: 'Mehmet Kaya', isActive: true },
    { userId: 'staff-4', name: 'Zeynep Şahin', isActive: true },
  ],
});
const legacyConv = conv({
  id: 'c-legacy', contextType: 'GENERAL', title: null,
  participantName: 'Ayşe Yılmaz', participantId: 'staff-2',
  participants: [
    { userId: 'admin-1', name: 'Admin', isActive: true },
    { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true },
  ],
});

describe('Messaging M4 context-first list/header presentation', () => {
  it('1: JOB conversation lists the Job title as primary with an İş label', async () => {
    mockListConversations.mockResolvedValue({ items: [jobConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    expect(item.textContent).toContain('Diş ünitesi teslimi');
    expect(item.textContent).toContain('İş');
    unmount();
  });

  it('2: CUSTOMER conversation lists title primary, customer secondary, Müşteri label', async () => {
    mockListConversations.mockResolvedValue({ items: [customerConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    expect(item.textContent).toContain('Yeni cihaz demo');
    expect(item.textContent).toContain('Klinik A');
    expect(item.textContent).toContain('Müşteri');
    unmount();
  });

  it('3: titled GENERAL conversation lists title primary with Genel label', async () => {
    mockListConversations.mockResolvedValue({ items: [generalConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    expect(item.textContent).toContain('Ay sonu toplantı');
    expect(item.textContent).toContain('Genel');
    unmount();
  });

  it('4: legacy titleless GENERAL keeps a person-based label and stays listed', async () => {
    mockListConversations.mockResolvedValue({ items: [legacyConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    expect(item.textContent).toContain('Ayşe Yılmaz');
    expect(container.querySelectorAll('.conversation-item').length).toBe(1);
    unmount();
  });

  it('5: 3+ participant conversation summarizes as "name + N kişi"', async () => {
    mockListConversations.mockResolvedValue({ items: [generalConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    expect(item.textContent).toContain('Ayşe Yılmaz + 2 kişi');
    unmount();
  });

  it('6: thread header shows context title first and customer identity as context', async () => {
    mockListConversations.mockResolvedValue({ items: [customerConv], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListMessages.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const item = container.querySelector('.conversation-item') as HTMLElement;
    await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 10)); });
    const header = container.querySelector('.thread-header') as HTMLElement;
    expect(header.textContent).toContain('Yeni cihaz demo');
    expect(header.textContent).toContain('Klinik A');
    expect(header.textContent).toContain('Müşteri');
    unmount();
  });

  it('7: ADMIN empty state still says "Konuşma bulunmuyor"', async () => {
    mockListConversations.mockResolvedValue({ items: [], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    expect(container.textContent).toContain('Konuşma bulunmuyor');
    expect(container.textContent).not.toContain('Konuşmalar yüklenemedi');
    unmount();
  });
});
