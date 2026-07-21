/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '../src/notifications/NotificationCenter';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';

const api = vi.hoisted(() => ({
  getUnreadNotificationCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../src/services/notifications-api', () => api);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const notification = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'job.assigned' as const,
  title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.',
  entity: { type: 'job-card' as const, id: '22222222-2222-4222-8222-222222222222' },
  createdAt: '2026-07-21T10:00:00.000Z', readAt: null,
};

describe('NotificationCenter', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    api.getUnreadNotificationCount.mockResolvedValue(2);
    api.listNotifications.mockResolvedValue({ items: [notification], nextCursor: null });
    api.markNotificationRead.mockResolvedValue({ ...notification, readAt: '2026-07-21T11:00:00.000Z' });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.clearAllMocks();
  });

  async function render(identityKey = 'org-1:staff-1') {
    await act(async () => root.render(
      <MemoryRouter><NotificationCenter identityKey={identityKey} mobile={false} /></MemoryRouter>,
    ));
  }

  it('loads the badge and opens a labelled notification panel with semantic content', async () => {
    await render();
    await act(async () => {});
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    expect(trigger.textContent).toContain('2');
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Yeni iş atandı');
    expect(dialog.textContent).toContain('Size yeni bir iş atandı.');
    expect(dialog.textContent).toContain('Okunmadı');
    expect(document.activeElement).toBe(dialog.querySelector('button'));
  });

  it('shows an empty state and supports retry after a list failure', async () => {
    api.listNotifications.mockRejectedValueOnce(new Error('Bağlantı koptu')).mockResolvedValueOnce({ items: [], nextCursor: null });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    expect(container.textContent).toContain('Bağlantı koptu');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    expect(container.textContent).toContain('Henüz bildiriminiz yok.');
  });

  it('marks before navigating and locks only the pending notification action', async () => {
    let resolveMark: ((value: typeof notification & { readAt: string }) => void) | undefined;
    api.markNotificationRead.mockImplementationOnce(() => new Promise((resolve) => { resolveMark = resolve; }));
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const action = container.querySelector<HTMLButtonElement>('[data-notification-id]')!;
    await act(async () => action.click());
    expect(action.disabled).toBe(true);
    expect(api.markNotificationRead).toHaveBeenCalledWith(notification.id);
    await act(async () => resolveMark!({ ...notification, readAt: '2026-07-21T11:00:00.000Z' }));
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it('deduplicates later pages and keeps the panel open when mark-read fails', async () => {
    const later = {
      ...notification,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'İş onaylandı', kind: 'job.approved' as const, body: 'İşiniz onaylandı.',
    };
    api.listNotifications
      .mockResolvedValueOnce({ items: [notification], nextCursor: 'more' })
      .mockResolvedValueOnce({ items: [notification, later], nextCursor: null });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const more = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Daha fazla yükle')!;
    await act(async () => more.click());
    expect(container.querySelectorAll('[data-notification-id]')).toHaveLength(2);

    api.markNotificationRead.mockRejectedValueOnce(new Error('Okunamadı'));
    const action = container.querySelector<HTMLButtonElement>('[data-notification-id]')!;
    await act(async () => action.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Okunamadı');
  });

  it('closes with Escape and restores focus to the trigger', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('clears recipient-scoped panel state before loading a different identity', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    api.getUnreadNotificationCount.mockResolvedValue(0);
    await render('org-2:staff-2');
    await act(async () => {});
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-notification-id]')).toBeNull();
    expect(container.querySelector('[aria-label="Bildirimler"]')?.textContent).not.toContain('2');
  });

  it('reloads canonical data after a notifications realtime invalidation', async () => {
    const listeners = new Map<string, EventListener>();
    const eventSource: RealtimeEventSource = {
      addEventListener: (type, listener) => { listeners.set(type, listener); },
      removeEventListener: (type) => { listeners.delete(type); },
      close: () => {},
    };
    await act(async () => root.render(
      <MemoryRouter>
        <RealtimeProvider eventSourceFactory={() => eventSource}>
          <NotificationCenter identityKey="org-1:staff-1" mobile={false} />
        </RealtimeProvider>
      </MemoryRouter>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    await act(async () => listeners.get('servora.change')!(new MessageEvent('servora.change', {
      data: JSON.stringify({
        id: '1', type: 'job.approved', entity: { type: 'job-card', id: 'job-1' },
        resourceKeys: ['notifications'], occurredAt: '2026-07-21T12:00:00.000Z',
      }),
    })));
    expect(api.getUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(api.listNotifications).toHaveBeenCalledTimes(2);
  });
});
