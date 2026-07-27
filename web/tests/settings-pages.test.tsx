/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ProfileSettingsPage, SettingsLandingPage } from '../src/settings/SettingsPages';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Yılmaz',
  email: 'ayse@example.com', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

async function render(element: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('settings pages', () => {
  it('keeps settings navigation bounded to profile, security and this-device notifications', async () => {
    const html = await render(<SettingsLandingPage />);
    expect(html).toContain('/settings/profile');
    expect(html).toContain('/settings/security');
    expect(html).toContain('/settings/notifications');
    expect(html).not.toContain('Takvim');
    expect(html).not.toContain('Mesaj');
  });

  it('renders settings landing with OperationalCard inside the card grid', async () => {
    const html = await render(<SettingsLandingPage />);
    expect(html).toContain('servora-operational-card');
    expect(html).toContain('settings-card-link');
    expect(html).toContain('Profil');
    expect(html).toContain('Güvenlik');
    expect(html).toContain('Bildirimler');
  });

  it('shows profile data as read-only facts', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('Ayşe Yılmaz');
    expect(html).toContain('ayse@example.com');
    expect(html).not.toContain('<input');
  });

  it('renders UserAvatar in profile page', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('servora-user-avatar');
    expect(html).toContain('AY');
  });

  it('renders RecordDescriptions in profile page', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('servora-record-descriptions');
    expect(html).toContain('E-posta');
    expect(html).toContain('Rol');
  });

  it('renders SettingsTabs in profile page', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('servora-settings-tabs');
    expect(html).toContain('/settings/profile');
    expect(html).toContain('/settings/security');
    expect(html).toContain('/settings/notifications');
  });

  it('renders OperationalCard wrapper in profile page', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('servora-operational-card');
    expect(html).toContain('Profil bilgileri');
  });

  it('renders admin-managed profile hint', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('Profil bilgileriniz kuruluş yöneticiniz tarafından yönetilmektedir');
  });
});
