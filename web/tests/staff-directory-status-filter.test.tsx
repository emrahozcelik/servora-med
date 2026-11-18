/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffProfilesScreen } from '../src/StaffProfiles';
import type { CurrentUser } from '../src/services/api';
import type { StaffProfile } from '../src/services/people-api';

import { stubDesktopMatchMedia } from './antd-match-media';

stubDesktopMatchMedia();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({ listStaff: vi.fn(), listUsers: vi.fn(), getStaffProfile: vi.fn(), getOwnStaffProfile: vi.fn() }));
vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  listStaff: (...args: unknown[]) => api.listStaff(...args),
  listUsers: (...args: unknown[]) => api.listUsers(...args),
  getStaffProfile: (...args: unknown[]) => api.getStaffProfile(...args),
  getOwnStaffProfile: (...args: unknown[]) => api.getOwnStaffProfile(...args),
}));

const make = (id: string, name: string, isActive: boolean): StaffProfile => ({
  id: `profile-${id}`, user: { id, organizationId: 'org-1', name, email: `${id}@example.com`, role: 'STAFF', mustChangePassword: false,
    isActive, version: 1, lastLoginAt: null, createdAt: '2026-07-12', updatedAt: '2026-07-12' },
  title: 'Uzman', phone: null, region: 'Marmara', managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
});
const activeStaff = make('staff-1', 'Ayşe Aktif', true);
const leftStaff = make('staff-2', 'Bora Ayrılan', false);
const viewer = (role: CurrentUser['role']) => ({ id: 'viewer-1', organizationId: 'org-1', name: 'Görüntüleyen', email: 'v@example.com', role,
  mustChangePassword: false, isActive: true, version: 1 }) as unknown as CurrentUser;

describe('Staff directory status filter', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    for (const mock of Object.values(api)) mock.mockReset();
    api.listUsers.mockResolvedValue([]);
    api.listStaff.mockImplementation(async (status: string) => status === 'inactive' ? [leftStaff] : status === 'all' ? [activeStaff, leftStaff] : [activeStaff]);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((el) => el.textContent === label)!;
  const names = () => Array.from(container.querySelectorAll('.people-title-link')).map((el) => el.textContent);
  const mount = (role: CurrentUser['role'], initialStaffUserId?: string) =>
    act(async () => root.render(<MemoryRouter><StaffProfilesScreen user={viewer(role)} initialStaffUserId={initialStaffUserId} /></MemoryRouter>));

  it('lets Admin choose Aktif, Pasif or Tümü and passes the status to listStaff', async () => {
    await mount('ADMIN');
    expect(api.listStaff).toHaveBeenLastCalledWith('active');
    expect(tab('Aktif').getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual(['Ayşe Aktif']);
    await act(async () => tab('Pasif').click());
    expect(api.listStaff).toHaveBeenLastCalledWith('inactive');
    expect(names()).toEqual(['Bora Ayrılan']);
    expect(container.textContent).toContain('· Pasif');
    expect(tab('Pasif').getAttribute('aria-selected')).toBe('true');
    await act(async () => tab('Tümü').click());
    expect(api.listStaff).toHaveBeenLastCalledWith('all');
    expect(names()).toEqual(['Ayşe Aktif', 'Bora Ayrılan']);
  });

  it('shows filter-specific empty copy', async () => {
    api.listStaff.mockResolvedValue([]);
    await mount('ADMIN');
    expect(container.textContent).toContain('Aktif personel profili yok.');
    await act(async () => tab('Pasif').click());
    expect(container.textContent).toContain('Pasif personel profili yok.');
  });

  it('shows no filter to Manager and keeps requesting active staff', async () => {
    await mount('MANAGER');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(api.listStaff).toHaveBeenCalledTimes(1);
    expect(api.listStaff).toHaveBeenCalledWith('active');
  });

  it('keeps the profile deep-link working for Admin', async () => {
    api.getStaffProfile.mockResolvedValue(leftStaff);
    await mount('ADMIN', 'staff-2');
    expect(api.getStaffProfile).toHaveBeenCalledWith('staff-2');
    expect(container.textContent).toContain('Bora Ayrılan');
    expect(container.querySelector('[role="tablist"][aria-label="Personel durumu"]')).toBeNull();
  });

  it('shows six staff per page and resets the page after a status switch', async () => {
    const many = Array.from({ length: 8 }, (_, index) => make(`s-${index}`, `Personel ${index}`, true));
    api.listStaff.mockImplementation(async (status: string) => status === 'inactive' ? [leftStaff] : many);
    await mount('ADMIN');
    expect(names()).toHaveLength(6);
    expect(container.textContent).toContain('Sayfa 1 / 2');
    // Ant 6.7 moved activation to the nested full-size button.
    await act(async () => container.querySelector<HTMLElement>('[class*="pagination-next"] button')!.click());
    expect(names()).toHaveLength(2);
    await act(async () => tab('Pasif').click());
    expect(names()).toEqual(['Bora Ayrılan']);
    expect(container.querySelector('.servora-list-pagination')).toBeNull();
    await act(async () => tab('Aktif').click());
    expect(names()[0]).toBe('Personel 0');
    expect(names()).toHaveLength(6);
  });

  it('keeps the tabs visible while hiding previous-filter rows until the new response arrives', async () => {
    let deliver!: (items: StaffProfile[]) => void;
    api.listStaff.mockImplementation((status: string) =>
      status === 'inactive' ? new Promise<StaffProfile[]>((resolve) => { deliver = resolve; }) : Promise.resolve([activeStaff]));
    await mount('ADMIN');
    const activeTab = tab('Aktif');
    activeTab.focus();
    await act(async () => tab('Pasif').click());
    expect(tab('Pasif').getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual([]);
    expect(container.textContent).toContain('Seçilen personel listesi yükleniyor');
    expect(container.querySelector('.servora-list-pagination')).toBeNull();
    await act(async () => deliver([leftStaff]));
    expect(names()).toEqual(['Bora Ayrılan']);
    expect(container.textContent).not.toContain('Seçilen personel listesi yükleniyor');
  });

});
