/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowUpCreateRoute } from '../src/AppRouter';
import { paths } from '../src/paths';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

describe('Follow-up route gate', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  async function render(entry: string, user = manager) {
    await act(async () => root.render(<MemoryRouter initialEntries={[entry]}>
      <FollowUpCreateRoute user={user} navigate={vi.fn()} />
    </MemoryRouter>));
  }

  it.each(['/jobs/new-follow-up', '/jobs/new-follow-up?source=not-a-uuid'])('rejects missing or invalid source query: %s', async (entry) => {
    await render(entry);
    expect(host.textContent).toContain('Geçersiz takip bağlantısı');
    expect(host.querySelector('[data-follow-up-create="true"]')).toBeNull();
  });

  it('shows the canonical forbidden surface to Staff before mounting the form', async () => {
    await render('/jobs/new-follow-up?source=11111111-1111-4111-8111-111111111111', {
      ...manager, id: 'staff-1', role: 'STAFF',
    });
    expect(host.textContent).toContain('Erişim yetkiniz yok');
    expect(host.querySelector('[data-follow-up-create="true"]')).toBeNull();
  });

  it('encodes the canonical source query through one path helper', () => {
    expect(paths.followUpCreate('source/id')).toBe('/jobs/new-follow-up?source=source%2Fid');
  });
});
