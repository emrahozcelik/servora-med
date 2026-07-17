/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnStaffProfileView, StaffDirectoryView, StaffProfileEditRoute, StaffProfileEditView } from '../src/StaffProfiles';
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
