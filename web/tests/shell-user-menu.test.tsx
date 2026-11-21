/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '../src/services/api';
import { ShellUserMenu } from '../src/shell/ShellUserMenu';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staffUser: CurrentUser = {
  id: 'staff-1',
  organizationId: 'org-1',
  name: 'Ayşe Personel',
  email: 'ayse@dunyadental.example',
  role: 'STAFF',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: false, calendar: true, messaging: true },
};

const managerUser: CurrentUser = {
  ...staffUser,
  id: 'manager-1',
  name: 'Murat Yönetici',
  email: 'murat@dunyadental.example',
  role: 'MANAGER',
};

function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-route>{location.pathname}</span>
      <button type="button" data-go-customers onClick={() => navigate('/customers')}>
        Git
      </button>
    </div>
  );
}

describe('ShellUserMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubDesktopMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderMenu({
    user = managerUser,
    pendingSignOut = false,
    onSignOut = vi.fn(),
  }: {
    user?: CurrentUser;
    pendingSignOut?: boolean;
    onSignOut?: () => void;
  } = {}) {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <RouteProbe />
        <ShellUserMenu
          user={user}
          roleLabel={user.role === 'STAFF' ? 'Personel' : 'Yönetici'}
          pendingSignOut={pendingSignOut}
          onSignOut={onSignOut}
        />
      </MemoryRouter>,
    ));
  }

  it('opens an accessible menu popover, shows role-scoped links, and signs out', async () => {
    const onSignOut = vi.fn();
    await renderMenu({ user: staffUser, onSignOut });

    const trigger = container.querySelector<HTMLButtonElement>('.shell-user-menu-trigger')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const panel = container.querySelector<HTMLElement>('.shell-user-menu-panel')!;
    expect(panel.getAttribute('role')).toBe('menu');
    expect(panel.id).toBe(trigger.getAttribute('aria-controls'));
    expect(panel.textContent).toContain('Ayşe Personel');
    expect(panel.textContent).toContain('Personel');
    expect(panel.textContent).toContain('ayse@dunyadental.example');
    expect(panel.querySelector('a[href="/staff"]')?.textContent).toBe('Profilim');
    expect(panel.querySelector('a[href="/settings/profile"]')?.textContent).toBe('Profil ayarları');
    expect(panel.querySelector('a[href="/settings/security"]')?.textContent).toBe('Güvenlik');
    expect(panel.querySelector('a[href="/settings"]')?.textContent).toBe('Ayarlar');

    const signout = panel.querySelector<HTMLButtonElement>('.shell-signout')!;
    await act(async () => signout.click());
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('omits Profilim for Manager and shows pending sign-out state', async () => {
    await renderMenu({ user: managerUser, pendingSignOut: true });
    await act(async () => container.querySelector<HTMLButtonElement>('.shell-user-menu-trigger')!.click());

    const panel = container.querySelector('.shell-user-menu-panel')!;
    expect(panel.querySelector('a[href="/staff"]')).toBeNull();
    const signout = panel.querySelector<HTMLButtonElement>('.shell-signout')!;
    expect(signout.disabled).toBe(true);
    expect(signout.textContent).toContain('Kapatılıyor…');
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    await renderMenu();
    const trigger = container.querySelector<HTMLButtonElement>('.shell-user-menu-trigger')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(container.querySelector('.shell-user-menu-panel')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.shell-user-menu-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside pointerdown and route navigation', async () => {
    await renderMenu();
    const trigger = container.querySelector<HTMLButtonElement>('.shell-user-menu-trigger')!;
    await act(async () => trigger.click());
    expect(container.querySelector('.shell-user-menu-panel')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.shell-user-menu-panel')).toBeNull();

    await act(async () => trigger.click());
    expect(container.querySelector('.shell-user-menu-panel')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-go-customers]')!.click());
    expect(container.querySelector('[data-route]')?.textContent).toBe('/customers');
    expect(container.querySelector('.shell-user-menu-panel')).toBeNull();
  });
});
