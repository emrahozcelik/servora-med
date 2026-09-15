/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '../src/notifications/NotificationCenter';

const api = vi.hoisted(() => ({
  getUnreadNotificationCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  clearReadNotifications: vi.fn(),
}));
vi.mock('../src/services/notifications-api', () => api);
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: () => {},
}));
vi.mock('../src/install/InstallOpportunity', () => ({
  useInstallOpportunity: () => ({
    canPrompt: false,
    installed: false,
    prompt: vi.fn(),
  }),
}));
vi.mock('../src/web-push/WebPushProvider', () => ({
  useWebPush: () => ({
    enabled: false,
    pending: null,
    error: '',
    guidance: 'disabled',
    status: null,
    enable: vi.fn(),
    disable: vi.fn(),
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unread = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'job.assigned' as const,
  title: 'Yeni iş atandı',
  body: 'Size yeni bir iş atandı. Klinik ziyareti için notları ve teslim kalemlerini kontrol edin.',
  entity: { type: 'job-card' as const, id: '22222222-2222-4222-8222-222222222222' },
  createdAt: '2026-07-21T10:00:00.000Z',
  readAt: null,
};
const read = {
  ...unread,
  id: '33333333-3333-4333-8333-333333333333',
  title: 'İş tamamlandı',
  body: 'Yönetici onayı sonrası iş kapatıldı.',
  readAt: '2026-07-21T11:00:00.000Z',
};

const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function exactRuleBody(css: string, selector: string): string {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = cleaned.match(pattern);
  if (!match?.[1]) throw new Error(`Missing exact CSS rule for ${selector}`);
  return match[1];
}

describe('NotificationCenter visual contracts (T2C)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    api.getUnreadNotificationCount.mockResolvedValue(2);
    api.listNotifications.mockResolvedValue({ items: [unread, read], nextCursor: null });
    api.markNotificationRead.mockResolvedValue({ ...unread, readAt: '2026-07-21T11:00:00.000Z' });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(mobile = false, unreadCount: number | null = 2) {
    api.getUnreadNotificationCount.mockResolvedValue(unreadCount);
    await act(async () => root.render(
      <MemoryRouter>
        <NotificationCenter identityKey="org-1:staff-1" mobile={mobile} />
      </MemoryRouter>,
    ));
    await act(async () => {});
  }

  it('keeps trigger aria contract and absolute badge geometry', async () => {
    await render(false, 120);
    const trigger = container.querySelector<HTMLButtonElement>('.shell-notification-trigger')!;
    expect(trigger.getAttribute('aria-label')).toBe('Bildirimler');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const badge = trigger.querySelector('.notification-center-badge');
    expect(badge?.textContent).toBe('120');
    expect(trigger.querySelector('.shell-notification-icon')).not.toBeNull();
    expect(getComputedStyle(badge!).position || stylesCss).toBeTruthy();

    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
  });

  it('hides badge when unread count is zero or unavailable', async () => {
    await render(false, 0);
    expect(container.querySelector('.notification-center-badge')).toBeNull();
    await render(false, null);
    expect(container.querySelector('.notification-center-badge')).toBeNull();
  });

  it('renders stable read/unread row hooks without changing copy', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());
    const unreadRow = container.querySelector<HTMLElement>('[data-notification-id="11111111-1111-4111-8111-111111111111"]')!;
    const readRow = container.querySelector<HTMLElement>('[data-notification-id="33333333-3333-4333-8333-333333333333"]')!;
    expect(unreadRow.className).toContain('notification-center-item--unread');
    expect(unreadRow.getAttribute('data-read-state')).toBe('unread');
    expect(readRow.className).toContain('notification-center-item--read');
    expect(readRow.getAttribute('data-read-state')).toBe('read');
    expect(unreadRow.textContent).toContain('Okunmadı');
    expect(readRow.textContent).toContain('Okundu');
    expect(unreadRow.querySelector('.notification-center-item-body')?.textContent).toContain('Klinik ziyareti');
    expect(container.textContent).toContain('Kurulum ve cihaz bildirimleri');
  });

  it('adopts raised tokens and mobile safe-area on the panel', () => {
    const panel = exactRuleBody(stylesCss, '.notification-center-panel');
    expect(panel).toMatch(/border-radius:\s*var\(--radius-raised\)/);
    expect(panel).toMatch(/box-shadow:\s*var\(--shadow-raised\)/);
    expect(panel).not.toMatch(/0 1rem 2\.5rem/);
    expect(panel).not.toMatch(/border-radius:\s*0\.75rem/);

    const mobile = exactRuleBody(stylesCss, '.notification-center-panel--mobile');
    expect(mobile).toMatch(/safe-area-inset-top/);
    expect(mobile).toMatch(/safe-area-inset-right/);
    // Bottom safe-area is on the body so the last control can scroll fully into the content box.
    expect(exactRuleBody(stylesCss, '.notification-center-panel--mobile .notification-center-body'))
      .toMatch(/safe-area-inset-bottom/);

    const badge = exactRuleBody(stylesCss, '.notification-center-badge');
    expect(badge).toMatch(/border-radius:\s*var\(--radius-chip\)/);
    expect(badge).toMatch(/position:\s*absolute/);
    expect(badge).toMatch(/pointer-events:\s*none/);

    const trigger = exactRuleBody(stylesCss, '.shell-notification-trigger');
    expect(trigger).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(trigger).toMatch(/width:\s*2\.75rem/);

    const unreadItem = exactRuleBody(stylesCss, '.notification-center-item--unread');
    expect(unreadItem).toMatch(/border-inline-start-color:\s*var\(--accent\)/);
    const readItem = exactRuleBody(stylesCss, '.notification-center-item--read');
    expect(readItem).toMatch(/border-inline-start-color:\s*var\(--rule\)/);
    const item = exactRuleBody(stylesCss, '.notification-center-item');
    expect(item).toMatch(/border-inline-start-width:\s*0\.25rem/);

    const itemShell = exactRuleBody(stylesCss, '.notification-center-item-shell');
    expect(itemShell).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    const dismiss = exactRuleBody(stylesCss, '.notification-center-dismiss');
    expect(dismiss).toMatch(/min-width:\s*var\(--control-height\)/);
    expect(dismiss).toMatch(/min-height:\s*var\(--control-height\)/);
    const clearRead = exactRuleBody(stylesCss, '.notification-center-clear-read');
    expect(clearRead).toMatch(/min-height:\s*var\(--control-height\)/);

    expect(stylesCss).not.toMatch(/0 1rem 2\.5rem oklch\(26% 0\.016 246deg \/ 22%\)/);
  });

  it('groups the header as a title/close row plus a separate bulk-action row', async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());

    const heading = container.querySelector<HTMLElement>('.notification-center-heading')!;
    const main = heading.querySelector<HTMLElement>('.notification-center-heading-main')!;
    const bulk = heading.querySelector<HTMLElement>('.notification-center-bulk-actions')!;

    expect(main.querySelector('h2')?.textContent).toBe('Bildirimler');
    const close = main.querySelector<HTMLButtonElement>('.drawer-close')!;
    expect(close.getAttribute('aria-label')).toBe('Bildirimleri kapat');
    expect(close.querySelector('svg')).not.toBeNull();

    expect(bulk.querySelector('[data-clear-read]')?.textContent).toBe('Okunanları temizle');
    expect(Array.from(bulk.querySelectorAll('button')).map((button) => button.textContent))
      .toContain('Tümünü temizle');

    // Close is no longer grouped with the bulk actions, and the title row carries no bulk control.
    expect(bulk.querySelector('.drawer-close')).toBeNull();
    expect(main.querySelector('[data-clear-read]')).toBeNull();
    expect(main.textContent).not.toContain('Tümünü temizle');
    expect(main.textContent).not.toContain('Kapat');
  });

  it('keeps the same header grouping in the mobile panel', async () => {
    await render(true);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')!;
    await act(async () => trigger.click());

    const panel = container.querySelector<HTMLElement>('.notification-center-panel--mobile')!;
    const main = panel.querySelector<HTMLElement>('.notification-center-heading-main')!;
    const bulk = panel.querySelector<HTMLElement>('.notification-center-bulk-actions')!;

    expect(main.querySelector('h2')?.textContent).toBe('Bildirimler');
    expect(main.querySelector('.drawer-close')).not.toBeNull();
    expect(bulk.querySelector('[data-clear-read]')).not.toBeNull();
    expect(Array.from(bulk.querySelectorAll('button')).map((button) => button.textContent))
      .toContain('Tümünü temizle');
    expect(bulk.querySelector('.drawer-close')).toBeNull();
  });

  it('pins the two-level header geometry and forbids splitting the title', () => {
    const heading = exactRuleBody(stylesCss, '.notification-center-heading');
    expect(heading).toMatch(/display:\s*grid/);
    expect(heading).not.toMatch(/display:\s*flex/);
    expect(heading).toMatch(/border-bottom:\s*1px solid var\(--rule\)/);

    expect(exactRuleBody(stylesCss, '.notification-center-heading-main'))
      .toMatch(/justify-content:\s*space-between/);

    const title = exactRuleBody(stylesCss, '.notification-center-heading-main > h2');
    expect(title).toMatch(/overflow-wrap:\s*normal/);
    expect(title).not.toMatch(/anywhere/);

    expect(exactRuleBody(stylesCss, '.notification-center-bulk-actions'))
      .toMatch(/justify-content:\s*flex-end/);

    // The old single shared row is gone: close and bulk actions no longer share a container.
    expect(stylesCss).not.toMatch(/\.notification-center-heading-actions/);
    // The shared drawer/notification heading group stays the single source of heading type scale.
    expect((stylesCss.match(/\.notification-center-heading h2/g) ?? []).length).toBe(1);

    // Very narrow panels stack the bulk actions instead of wrapping arbitrarily.
    expect(stylesCss).toMatch(
      /@media \(max-width: 22rem\) \{\s*\.notification-center-bulk-actions \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });
});
