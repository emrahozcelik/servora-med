/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ProfileSettingsPage, SettingsLandingPage } from '../src/settings/SettingsPages';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

  it('shows profile data as read-only facts', async () => {
    const html = await render(<ProfileSettingsPage user={user} />);
    expect(html).toContain('Ayşe Yılmaz');
    expect(html).toContain('ayse@example.com');
    expect(html).not.toContain('<input');
  });
});
