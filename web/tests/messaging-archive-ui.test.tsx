/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
const mockGetUnread = vi.fn().mockResolvedValue(0);
const mockArchive = vi.fn().mockResolvedValue(undefined);
const mockUnarchive = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/services/messaging-api', () => ({
  archiveConversation: (...args: unknown[]) => mockArchive(...args),
  unarchiveConversation: (...args: unknown[]) => mockUnarchive(...args),
  listConversations: (...args: unknown[]) => mockListConversations(...args),
  listMessages: (...args: unknown[]) => mockListMessages(...args),
  getUnreadCount: (...args: unknown[]) => mockGetUnread(...args),
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
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  })) as any;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.clearAllMocks());

const user = {
  id: 'admin-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.test',
  role: 'ADMIN' as const,
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: '', email: null, helpUrl: null },
};

function conversation(id: string, unreadCount = 0) {
  return {
    id,
    directKey: `topic:${id}`,
    contextType: 'GENERAL' as const,
    jobId: null,
    jobTitle: null,
    customerId: null,
    customerName: null,
    title: `Konu ${id}`,
    participantName: 'Ayşe',
    participantId: 'staff-1',
    participantIsActive: true,
    participants: [{ userId: 'staff-1', name: 'Ayşe', isActive: true }],
    unreadCount,
    lastActivityAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
  };
}

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
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

async function tick(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('MessagingPage per-user archive behavior', () => {
  it('keeps the heading, view selector, and new-conversation action in deliberate header regions', async () => {
    mockListConversations.mockResolvedValue({ items: [conversation('header')], nextCursor: null });

    const { container, unmount } = render();
    await tick();

    const header = container.querySelector('.messaging-sidebar-header');
    const headingRow = header?.querySelector('.messaging-sidebar-heading-row');
    const heading = headingRow?.querySelector('.messaging-sidebar-heading');
    const viewTabs = header?.querySelector('.conversation-view-tabs');
    const newConversation = headingRow?.querySelector('button[aria-label="Yeni konuşma"]');

    expect(heading?.textContent).toBe('Mesajlar');
    expect(headingRow).not.toBeNull();
    expect(viewTabs).not.toBeNull();
    expect(newConversation).not.toBeNull();
    expect(viewTabs?.parentElement).toBe(header);
    expect(newConversation?.parentElement).toBe(headingRow);
    unmount();
  });

  it('keeps a stable action-rail structure for varied and unread conversation rows', async () => {
    const long = {
      ...conversation('long'),
      title: 'Uzun müşteri görüşmesi ve ürün teslim planlaması için takip konuşması',
      participantName: 'Ayşe Demirhan ve diğer katılımcılar',
      lastActivityAt: '2026-08-09T10:00:00.000Z',
    };
    const unread = conversation('unread', 3);
    mockListConversations.mockResolvedValue({ items: [conversation('short'), long, unread], nextCursor: null });

    const { container, unmount } = render();
    await tick();

    const rows = Array.from(container.querySelectorAll('.conversation-row'));
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.querySelector('.conversation-meta')).not.toBeNull();
      expect(row.querySelector('.conversation-activity')).not.toBeNull();
      expect(row.querySelector('.conversation-action-rail')).not.toBeNull();
      expect(row.querySelector('.conversation-action-rail summary')).not.toBeNull();
    });

    const unreadAction = rows[2]?.querySelector('[role="menuitem"]') as HTMLButtonElement;
    expect(unreadAction).not.toBeNull();
    expect(unreadAction.disabled).toBe(true);
    unmount();
  });

  it('starts in Aktif and switches to a server-filtered Arşiv view', async () => {
    const active = conversation('active');
    const archived = conversation('archived');
    mockListConversations.mockImplementation((view: string) => Promise.resolve(
      view === 'archived'
        ? { items: [archived], nextCursor: null }
        : { items: [active], nextCursor: null },
    ));

    const { container, unmount } = render();
    await tick();

    const viewButtons = Array.from(container.querySelectorAll('.conversation-view-tab')) as HTMLButtonElement[];
    const activeTab = viewButtons.find((button) => button.textContent === 'Aktif');
    expect(activeTab?.getAttribute('aria-pressed')).toBe('true');
    expect(viewButtons).toHaveLength(2);
    expect(viewButtons.every((button) => button.tabIndex === 0)).toBe(true);
    expect(container.textContent).toContain('Konu active');

    const archiveTab = viewButtons.find((button) => button.textContent === 'Arşiv') as HTMLButtonElement;
    expect(archiveTab.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      archiveTab.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(mockListConversations).toHaveBeenCalledWith('archived');
    expect(container.querySelector('.conversation-view-tab[aria-pressed="true"]')?.textContent).toBe('Arşiv');
    expect(container.textContent).toContain('Konu archived');
    expect(container.textContent).not.toContain('Konu active');
    unmount();
  });

  it('uses plain list semantics when each conversation row contains multiple controls', async () => {
    mockListConversations.mockResolvedValue({ items: [conversation('semantic')], nextCursor: null });

    const { container, unmount } = render();
    await tick();

    const list = container.querySelector('.conversation-list');
    const row = container.querySelector('.conversation-row');
    const rowItem = row?.parentElement;
    const conversationButton = row?.querySelector('.conversation-item') as HTMLButtonElement;
    expect(list?.getAttribute('role')).toBeNull();
    expect(rowItem?.tagName).toBe('LI');
    expect(rowItem?.getAttribute('role')).toBeNull();

    await act(async () => {
      conversationButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(conversationButton.getAttribute('aria-current')).toBe('page');
    unmount();
  });

  it('disables archive for unread rows and archives a read row with focus restoration', async () => {
    const read = conversation('read');
    const unread = conversation('unread', 2);
    mockListConversations
      .mockResolvedValueOnce({ items: [read, unread], nextCursor: null })
      .mockResolvedValueOnce({ items: [unread], nextCursor: null });

    const { container, unmount } = render();
    await tick();

    const rows = Array.from(container.querySelectorAll('.conversation-row'));
    const readMenu = rows[0]?.querySelector('summary') as HTMLElement;
    const unreadMenu = rows[1]?.querySelector('summary') as HTMLElement;
    await act(async () => { unreadMenu.click(); });
    const unreadAction = rows[1]?.querySelector('[role="menuitem"]') as HTMLButtonElement;
    expect(unreadAction.disabled).toBe(true);
    expect(mockArchive).not.toHaveBeenCalled();

    await act(async () => {
      readMenu.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const readAction = rows[0]?.querySelector('[role="menuitem"]') as HTMLButtonElement;
    await act(async () => {
      readAction.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(mockArchive).toHaveBeenCalledWith('read');
    expect(container.querySelectorAll('.conversation-row')).toHaveLength(1);
    const activeTab = container.querySelector('.conversation-view-tab[aria-pressed="true"]');
    expect(activeTab?.textContent).toBe('Aktif');
    expect(document.activeElement).toBe(activeTab);
    unmount();
  });

  it('restores focus to the menu trigger after an archive failure', async () => {
    mockListConversations.mockResolvedValue({ items: [conversation('failure')], nextCursor: null });
    mockArchive.mockRejectedValueOnce(new Error('Arşivlenemedi.'));

    const { container, unmount } = render();
    await tick();
    const summary = container.querySelector('.conversation-row summary') as HTMLElement;
    await act(async () => { summary.click(); });
    const details = container.querySelector('.conversation-actions') as HTMLDetailsElement;
    const action = details.querySelector('[role="menuitem"]') as HTMLButtonElement;

    await act(async () => {
      action.focus();
      action.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Arşivlenemedi.');
    unmount();
  });

  it('removes an archived row after Arşivden çıkar and keeps the archive view selected', async () => {
    const archived = conversation('archived');
    mockListConversations
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [archived], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    const { container, unmount } = render();
    await tick();
    const archiveTab = Array.from(container.querySelectorAll('.conversation-view-tab'))
      .find((element) => element.textContent === 'Arşiv') as HTMLButtonElement;
    await act(async () => {
      archiveTab.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const summary = container.querySelector('.conversation-row summary') as HTMLElement;
    await act(async () => { summary.click(); });
    const action = container.querySelector('[role="menuitem"]') as HTMLButtonElement;
    await act(async () => {
      action.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(mockUnarchive).toHaveBeenCalledWith('archived');
    expect(container.querySelectorAll('.conversation-row')).toHaveLength(0);
    expect(container.querySelector('.conversation-view-tab[aria-pressed="true"]')?.textContent).toBe('Arşiv');
    unmount();
  });

  it('closes the row menu with Escape and restores focus to its trigger', async () => {
    mockListConversations.mockResolvedValue({ items: [conversation('escape')], nextCursor: null });

    const { container, unmount } = render();
    await tick();
    const summary = container.querySelector('.conversation-row summary') as HTMLElement;
    await act(async () => { summary.click(); });
    const details = container.querySelector('.conversation-actions') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    await act(async () => {
      details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    unmount();
  });
});
