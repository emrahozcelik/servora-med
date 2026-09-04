/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../src/AppShell';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches, media: '(min-width: 64rem)', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe('shell build identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(desktop: boolean) {
    setDesktop(desktop);
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/jobs']}>
        <AppShell user={staff} pendingSignOut={false} onSignOut={() => {}}>
          <main><h1>İçerik</h1></main>
        </AppShell>
      </MemoryRouter>,
    ));
  }

  it('renders build identity in the desktop sidebar footer with logout distinct', async () => {
    await render(true);

    const footer = container.querySelector('.shell-sidebar-footer');
    expect(footer).not.toBeNull();
    const identity = footer?.querySelector('.build-identity');
    expect(identity).not.toBeNull();
    expect(identity?.textContent).toContain('Servora Med 0.1.0');
    expect(identity?.getAttribute('data-build-sha')?.trim()).not.toBe('');

    const signout = footer?.querySelector('.shell-signout');
    expect(signout?.textContent).toContain('Oturumu kapat');
    expect(signout?.tagName).toBe('BUTTON');
    expect(identity?.tagName).not.toBe('BUTTON');

    expect(container.querySelectorAll('.build-identity')).toHaveLength(1);
  });

  it('renders build identity in the mobile drawer without touching the bottom nav', async () => {
    await render(false);

    const menuButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Menü');
    expect(menuButton).toBeDefined();
    await act(async () => { menuButton?.click(); });

    const drawer = container.querySelector('#app-navigation-drawer');
    expect(drawer).not.toBeNull();
    const identity = drawer?.querySelector('.build-identity');
    expect(identity).not.toBeNull();
    expect(identity?.textContent).toContain('Servora Med 0.1.0');
    expect(identity?.getAttribute('data-build-sha')?.trim()).not.toBe('');

    expect(container.querySelector('.mobile-bottom-nav .build-identity')).toBeNull();
    expect(container.querySelectorAll('.build-identity')).toHaveLength(1);
  });
});
