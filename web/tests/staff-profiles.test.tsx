/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnStaffProfileView, StaffDirectoryView, StaffJobHistory, StaffProfileEditRoute, StaffProfileEditView } from '../src/StaffProfiles';
import type { CurrentUser } from '../src/services/api';
import type { StaffProfile } from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const profile: StaffProfile = { id: 'profile-1', user: { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 2, lastLoginAt: null, createdAt: '2026-07-12', updatedAt: '2026-07-12' },
  title: 'Uzman', phone: null, region: 'Marmara', managerUserId: 'manager-1', managerName: 'Murat', version: 1,
  counters: { open: 1, waitingApproval: 2, revisionRequested: 3, completedThisMonth: 4, overdue: 5 } };

describe('Staff profile views', () => {
  it('shows five backend counters on the own-profile view', () => {
    const html = renderToStaticMarkup(<OwnStaffProfileView profile={profile} onBack={() => {}} />);
    for (const label of ['Açık işler', 'Onay bekliyor', 'Düzeltme istendi', 'Bu ay tamamlandı', 'Geciken']) expect(html).toContain(label);
    expect(html).not.toContain('Profili düzenle');
  });
  it('renders a structured active Staff directory without internal notes or open/status controls', () => {
    const html = renderToStaticMarkup(<MemoryRouter><StaffDirectoryView profiles={[profile]} onOpen={() => {}} onBack={() => {}} /></MemoryRouter>);
    expect(html).toContain('Personel'); expect(html).toContain('Ayşe'); expect(html).toContain('Murat');
    expect(html).toContain('/staff/staff-1');
    expect(html).toContain('people-title-link');
    expect(html).toContain('people-list-card');
    expect(html).not.toContain('Profili aç');
    expect(html).not.toContain('Durum');
    expect(html).not.toContain('Pasif');
    expect(html).not.toContain('notes');
  });
  it('limits profile editing to approved fields', () => {
    const html = renderToStaticMarkup(<StaffProfileEditView profile={profile} managers={[]} onBack={() => {}} onChanged={() => {}} />);
    for (const label of ['Unvan', 'Telefon', 'Bölge', 'Yönetici']) expect(html).toContain(label);
    expect(html).not.toContain('Rol'); expect(html).not.toContain('Parola');
  });
  it('offers management a distinct operational report action', () => {
    const html = renderToStaticMarkup(<StaffProfileEditView profile={profile} managers={[]}
      onBack={() => {}} onChanged={() => {}} onOpenReport={() => {}} />);
    expect(html).toContain('Operasyon raporunu aç');
  });
  it('changes the edit form identity when route navigation selects another Staff user', () => {
    const first = StaffProfileEditRoute({ profile, managers: [], onBack: () => {}, onChanged: () => {} });
    const second = StaffProfileEditRoute({
      profile: { ...profile, id: 'profile-2', user: { ...profile.user, id: 'staff-2', name: 'Bora' } },
      managers: [], onBack: () => {}, onChanged: () => {},
    });
    expect(first.key).toBe('staff-1');
    expect(second.key).toBe('staff-2');
  });

  it('managed profile has one form-actions region with Listeye dön before Profili kaydet', () => {
    const html = renderToStaticMarkup(<StaffProfileEditView profile={profile} managers={[]}
      onBack={() => {}} onChanged={() => {}} onOpenReport={() => {}} />);
    const actions = html.match(/form-actions/g);
    expect(actions).toHaveLength(1);
    const listeyeDonIndex = html.indexOf('Listeye dön');
    const profiliKaydetIndex = html.indexOf('Profili kaydet');
    expect(listeyeDonIndex).toBeGreaterThan(-1);
    expect(profiliKaydetIndex).toBeGreaterThan(listeyeDonIndex);
    expect(html).toContain('Operasyon raporunu aç');
  });

  it('own profile has no edit command', () => {
    const html = renderToStaticMarkup(<OwnStaffProfileView profile={profile} onBack={() => {}} />);
    expect(html).not.toContain('Profili düzenle');
    expect(html).not.toContain('Profili kaydet');
  });
});

describe('Staff directory card interaction', () => {
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
  });

  it('opens the profile from empty card area and keeps a single keyboard target on the title link', async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(
      <MemoryRouter>
        <StaffDirectoryView profiles={[profile]} onOpen={onOpen} onBack={() => {}} />
      </MemoryRouter>,
    ));
    const card = container.querySelector('.people-list-card') as HTMLElement;
    const title = container.querySelector('.people-title-link') as HTMLAnchorElement;
    expect(title.getAttribute('href')).toBe('/staff/staff-1');
    expect(card.getAttribute('tabindex')).toBeNull();
    expect(card.getAttribute('role')).toBeNull();

    await act(async () => card.click());
    expect(onOpen).toHaveBeenCalledWith('staff-1');

    onOpen.mockClear();
    await act(async () => title.click());
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('Staff job history Weekly Report regression', () => {
  const manager = {
    id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'manager@example.test', role: 'MANAGER',
    mustChangePassword: false, isActive: true, version: 1,
  } as CurrentUser;

  const weeklyRow = {
    id: 'job-weekly-1', title: 'Haftalık Rapor 2026-09-28 – 2026-10-04', type: 'WEEKLY_REPORT',
    status: 'COMPLETED', priority: 'normal', scheduledAt: null, dueDate: null,
    createdAt: '2026-10-03T08:00:00Z', updatedAt: '2026-10-03T09:00:00Z',
    completedAt: '2026-10-03T09:00:00Z', assignee: { id: 'staff-1', name: 'Ayşe' },
    customer: null, contact: null, followUp: null, childCount: null,
  };

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

  it('renders a completed Weekly Report row through the real parser without the error state', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ items: [weeklyRow], total: 1, limit: 20, offset: 0 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<MemoryRouter><StaffJobHistory actor={manager} staffUserId="staff-1" /></MemoryRouter>);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('Haftalık Rapor');
    expect(container.textContent).toContain('Tamamlandı');
    expect(container.querySelector('.form-error')).toBeNull();

    const completedTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tamamlanan')!;
    await act(async () => completedTab.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/staff/staff-1/jobs?status=completed&limit=20&offset=0&includeSaleCapability=true', expect.anything());
    expect(container.textContent).toContain('Haftalık Rapor');
    expect(container.querySelector('.form-error')).toBeNull();
  });
});
