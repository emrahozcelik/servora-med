/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  ApplicationSettingsPage,
  ProfileSettingsPage,
  SettingsLandingPage,
} from '../src/settings/SettingsPages';
import type { CurrentUser } from '../src/services/api';
import {
  InstallOpportunityProvider,
  type InstallOpportunityController,
  type InstallOpportunitySnapshot,
} from '../src/install/InstallOpportunity';

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

function fakeInstallController(snapshot: Partial<InstallOpportunitySnapshot>): InstallOpportunityController {
  const state: InstallOpportunitySnapshot = {
    canPrompt: false,
    installed: false,
    outcome: null,
    appleCandidate: false,
    guidanceDismissed: false,
    shouldOfferAppleGuidance: false,
    ...snapshot,
  };
  return {
    start: () => {},
    stop: () => {},
    subscribe: () => () => {},
    getSnapshot: () => state,
    prompt: async () => {},
    dismissGuidance: () => {},
    resetGuidance: () => {},
  };
}

async function renderApplicationPage(snapshot: Partial<InstallOpportunitySnapshot>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter>
      <InstallOpportunityProvider controller={fakeInstallController(snapshot)}>
        <ApplicationSettingsPage />
      </InstallOpportunityProvider>
    </MemoryRouter>,
  ));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('settings pages', () => {
  it('keeps settings navigation bounded to profile, security, notifications and application', async () => {
    const html = await render(<SettingsLandingPage />);
    expect(html).toContain('/settings/profile');
    expect(html).toContain('/settings/security');
    expect(html).toContain('/settings/notifications');
    expect(html).toContain('/settings/application');
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
    expect(html).toContain('Uygulama');
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

  it('shows the unsupported application state without install actions', async () => {
    const html = await renderApplicationPage({});
    expect(html).toContain('Tarayıcı');
    expect(html).toContain('Bu tarayıcıda yönlendirme yok');
    expect(html).toContain('Dünya Dental Servora');
    expect(html).toContain('İşler');
    expect(html).not.toContain('Uygulamayı yükle');
  });

  it('offers the Chromium install action only when a prompt is available', async () => {
    const html = await renderApplicationPage({ canPrompt: true });
    expect(html).toContain('Otomatik kurulum düğmesi');
    expect(html).toContain('Uygulamayı yükle');
    expect(html).not.toContain('Kurulum yönergelerini tekrar göster');
  });

  it('shows the Apple install steps when guidance applies', async () => {
    const html = await renderApplicationPage({ appleCandidate: true, shouldOfferAppleGuidance: true });
    expect(html).toContain('Apple kurulum yönergesi');
    expect(html).toContain('Ana Ekrana Ekle');
    expect(html).toContain('Web Uygulaması Olarak Aç');
    expect(html).toContain('Ekle\'ye dokunun');
  });

  it('offers to reopen dismissed Apple guidance', async () => {
    const html = await renderApplicationPage({ appleCandidate: true, guidanceDismissed: true });
    expect(html).toContain('Kurulum yönergelerini tekrar göster');
    expect(html).not.toContain('Ana Ekrana Ekle');
  });

  it('reports the installed standalone state', async () => {
    const html = await renderApplicationPage({ installed: true });
    expect(html).toContain('Ana Ekran uygulaması olarak çalışıyor');
    expect(html).toContain('Ana Ekran uygulaması');
    expect(html).not.toContain('Uygulamayı yükle');
  });

  it('keeps the Uygulama tab in the settings tabs', async () => {
    const html = await renderApplicationPage({});
    expect(html).toContain('/settings/profile');
    expect(html).toContain('/settings/security');
    expect(html).toContain('/settings/notifications');
    expect(html).toContain('/settings/application');
  });
});
