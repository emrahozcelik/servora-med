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

const backupAdmin: CurrentUser = {
  ...user,
  role: 'ADMIN',
  capabilities: { ...user.capabilities, backup: true },
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

function statefulInstallController(initial: Partial<InstallOpportunitySnapshot>): InstallOpportunityController {
  const defaults: InstallOpportunitySnapshot = {
    canPrompt: false, installed: false, outcome: null,
    appleCandidate: false, guidanceDismissed: false, shouldOfferAppleGuidance: false,
  };
  let state: InstallOpportunitySnapshot = { ...defaults, ...initial };
  const listeners = new Set<() => void>();
  return {
    start: () => {}, stop: () => {},
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    prompt: async () => {},
    dismissGuidance: () => {},
    resetGuidance: () => {
      state = { ...state, guidanceDismissed: false, shouldOfferAppleGuidance: true };
      listeners.forEach((listener) => listener());
    },
  };
}

function countStepLists(html: string) {
  return (html.match(/apple-install-guidance-steps/g) ?? []).length;
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

  it('shows the admin-only Backup & Recovery entry only when the capability is enabled', async () => {
    const hidden = await render(<SettingsLandingPage user={user} />);
    expect(hidden).not.toContain('/settings/data-management/backup-recovery');
    const visible = await render(<SettingsLandingPage user={backupAdmin} />);
    expect(visible).toContain('/settings/data-management/backup-recovery');
    expect(visible).toContain('Yedekleme ve Kurtarma');
  });

  it('shows the Demo Data entry only to ADMIN users', async () => {
    const manager = { ...user, role: 'MANAGER' as const };
    const admin = { ...user, role: 'ADMIN' as const };

    const staffHtml = await render(<SettingsLandingPage user={user} />);
    const managerHtml = await render(<SettingsLandingPage user={manager} />);
    const adminHtml = await render(<SettingsLandingPage user={admin} />);

    expect(adminHtml).toContain('/settings/data-management/demo-data');
    expect(adminHtml).toContain('Demo verileri');
    expect(staffHtml).not.toContain('/settings/data-management/demo-data');
    expect(managerHtml).not.toContain('/settings/data-management/demo-data');
  });

  it('suppresses only the landing route duplicate while keeping nested headings visible', async () => {
    const landing = await render(<SettingsLandingPage />);
    expect(landing).toContain('<h1 class="route-identity-heading">Ayarlar</h1>');
    expect(landing).not.toContain('class="eyebrow"');

    const profile = await render(<ProfileSettingsPage user={user} />);
    expect(profile).toContain('<h1>Profil</h1>');
    expect(profile).not.toContain('route-identity-heading');
    expect(profile).not.toContain('class="eyebrow"');

    const application = await renderApplicationPage({});
    expect(application).toContain('<h1>Uygulama</h1>');
    expect(application).not.toContain('route-identity-heading');
    expect(application).not.toContain('class="eyebrow"');
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

  it('renders canonical user-facing role labels in profile page', async () => {
    const admin = { ...user, role: 'ADMIN' as const };
    const manager = { ...user, role: 'MANAGER' as const };
    const staff = { ...user, role: 'STAFF' as const };
    expect(await render(<ProfileSettingsPage user={admin} />)).toContain('Sistem yöneticisi');
    expect(await render(<ProfileSettingsPage user={manager} />)).toContain('Yönetici');
    expect(await render(<ProfileSettingsPage user={staff} />)).toContain('Personel');
    expect(await render(<ProfileSettingsPage user={manager} />)).not.toContain('Müdür');
    expect(await render(<ProfileSettingsPage user={admin} />)).not.toContain('>Yönetici<');
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
    expect(html).toContain('Bu tarayıcıda kurulum yönlendirmesi yok');
    expect(html).toContain('Dünya Dental');
    expect(html).toContain('İşler');
    expect(html).not.toContain('Uygulamayı yükle');
    expect(html).toContain('Bu tarayıcıda otomatik kurulum yönlendirmesi sunulmuyor.');
  });

  it('shows the bounded application about area with Servora-Med as the only technical reference', async () => {
    const html = await renderApplicationPage({});
    expect(html).toContain('<h1>Uygulama</h1>');
    expect(html).toContain('Uygulama hakkında');
    expect(html).toContain('Altyapı / Teknik ürün');
    expect(html).toContain('Servora-Med');
    expect(html).toContain('settings-panel');
  });

  it('offers the Chromium install action only when a prompt is available', async () => {
    const html = await renderApplicationPage({ canPrompt: true });
    expect(html).toContain('Tarayıcının kurulum düğmesi');
    expect(html).toContain('Kurulum yöntemi');
    expect(html).toContain('Uygulamayı yükle');
    expect(html).not.toContain('Kurulum yönergelerini tekrar göster');
  });

  it('keeps the Apple install steps out of the Chromium prompt state', async () => {
    const html = await renderApplicationPage({ canPrompt: true, appleCandidate: true });
    expect(html).toContain('Uygulamayı yükle');
    expect(html).not.toContain('Ana Ekrana Ekle');
    expect(countStepLists(html)).toBe(0);
  });

  it('shows the Apple install steps when guidance applies', async () => {
    const html = await renderApplicationPage({ appleCandidate: true, shouldOfferAppleGuidance: true });
    expect(html).toContain('Apple kurulum yönergesi');
    expect(html).toContain('Ana Ekrana Ekle');
    expect(html).toContain('Web Uygulaması Olarak Aç');
    expect(html).toContain('Ekle\'ye dokunun');
  });

  it('keeps a single copy of the Apple steps on the application settings route without the global card', async () => {
    const html = await renderApplicationPage({ appleCandidate: true, shouldOfferAppleGuidance: true });
    expect(countStepLists(html)).toBe(1);
    expect(html).not.toContain('data-install-guidance="true"');
  });

  it('offers to reopen dismissed Apple guidance', async () => {
    const html = await renderApplicationPage({ appleCandidate: true, guidanceDismissed: true });
    expect(html).toContain('Kurulum yönergelerini tekrar göster');
    expect(html).not.toContain('Ana Ekrana Ekle');
    expect(countStepLists(html)).toBe(0);
  });

  it('reopens the inline Apple guidance from the dismissed state in a single copy', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(
      <MemoryRouter>
        <InstallOpportunityProvider controller={statefulInstallController({ appleCandidate: true, guidanceDismissed: true })}>
          <ApplicationSettingsPage />
        </InstallOpportunityProvider>
      </MemoryRouter>,
    ));
    expect(container.textContent).toContain('Kurulum yönergelerini tekrar göster');
    expect(container.textContent).not.toContain('Ana Ekrana Ekle');
    const reopen = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Kurulum yönergelerini tekrar göster');
    expect(reopen).not.toBeUndefined();
    await act(async () => reopen!.click());
    expect(container.textContent).toContain('Ana Ekrana Ekle');
    expect(container.textContent).not.toContain('Kurulum yönergelerini tekrar göster');
    expect(container.querySelectorAll('.apple-install-guidance-steps')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('reports the installed standalone state', async () => {
    const html = await renderApplicationPage({ installed: true, appleCandidate: true });
    expect(html).toContain('Ana Ekran uygulaması olarak çalışıyor');
    expect(html).toContain('Ana Ekran uygulaması');
    expect(html).not.toContain('Uygulamayı yükle');
    expect(html).not.toContain('Ana Ekrana Ekle');
    expect(countStepLists(html)).toBe(0);
  });

  it('keeps the Uygulama tab in the settings tabs', async () => {
    const html = await renderApplicationPage({});
    expect(html).toContain('/settings/profile');
    expect(html).toContain('/settings/security');
    expect(html).toContain('/settings/notifications');
    expect(html).toContain('/settings/application');
  });
});
