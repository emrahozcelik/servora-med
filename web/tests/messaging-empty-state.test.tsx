/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mockListConversations = vi.fn();
const mockGetUnread = vi.fn();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...args: unknown[]) => mockListConversations(...args),
  listMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  getUnreadCount: (...args: unknown[]) => mockGetUnread(...args),
  listRecipients: vi.fn().mockResolvedValue([]),
  markRead: vi.fn(),
  sendMessage: vi.fn(),
  createOrGetConversation: vi.fn(),
  archiveConversation: vi.fn(),
  unarchiveConversation: vi.fn(),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation() { return () => {}; },
}));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  })) as unknown as typeof window.matchMedia;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); });

const user = {
  id: 'admin-1',
  organizationId: 'org-1',
  name: 'Deniz Yönetici',
  email: 'deniz@example.test',
  role: 'ADMIN' as const,
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: '', email: null, helpUrl: null },
};

const conversation = {
  id: 'conv-1',
  directKey: 'conv-1',
  contextType: 'GENERAL' as const,
  jobId: null,
  jobTitle: null,
  customerId: null,
  customerName: null,
  title: 'Bölge ziyaret programı',
  participantName: 'Ayşe Yılmaz',
  participantId: 'staff-1',
  participantIsActive: true,
  participants: [],
  unreadCount: 0,
  lastActivityAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/messages']}>
        <MessagingPage user={user} />
      </MemoryRouter>,
    );
  });
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

describe('Messaging empty-state composition (UI audit F-08)', () => {
  it('renders exactly one empty state when no conversation exists', async () => {
    mockListConversations.mockResolvedValue({ items: [], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await settle();

    const emptyStates = container.querySelectorAll('[data-servora-empty-state="true"]');
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.textContent).toContain('Konuşma bulunmuyor');
    expect(container.textContent).not.toContain('Henüz konuşma yok');
    // The detail pane stays inert instead of repeating the list empty state.
    expect(container.querySelector('.thread-empty')).toBeNull();
    expect(container.querySelector('.messaging-thread')?.classList.contains('active')).toBe(false);
    unmount();
  });

  it('keeps one neutral prompt in the detail pane when conversations exist', async () => {
    mockListConversations.mockResolvedValue({ items: [conversation], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await settle();

    const emptyStates = container.querySelectorAll('[data-servora-empty-state="true"]');
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.textContent).toContain('Konuşma seçin');
    expect(emptyStates[0]?.closest('.thread-empty')).not.toBeNull();
    expect(container.textContent).not.toContain('Henüz konuşma yok');
    unmount();
  });
});
