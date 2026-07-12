import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OwnStaffProfileView, StaffDirectoryView, StaffProfileEditView } from '../src/StaffProfiles';
import type { StaffProfile } from '../src/services/people-api';

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
  it('renders a structured active Staff directory without internal notes', () => {
    const html = renderToStaticMarkup(<StaffDirectoryView profiles={[profile]} status="active" canFilterInactive={false} onStatusChange={() => {}} onOpen={() => {}} onBack={() => {}} />);
    expect(html).toContain('Personel'); expect(html).toContain('Ayşe'); expect(html).toContain('Murat'); expect(html).not.toContain('notes');
  });
  it('limits profile editing to approved fields', () => {
    const html = renderToStaticMarkup(<StaffProfileEditView profile={profile} managers={[]} onBack={() => {}} onChanged={() => {}} />);
    for (const label of ['Unvan', 'Telefon', 'Bölge', 'Yönetici']) expect(html).toContain(label);
    expect(html).not.toContain('Rol'); expect(html).not.toContain('Parola');
  });
});
