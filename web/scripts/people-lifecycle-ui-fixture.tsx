import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { StaffDirectoryView } from '../src/StaffProfiles';
import { UserDetailView, UserListView } from '../src/UserManagement';
import type { ManagedUser, StaffProfile } from '../src/services/people-api';
import type { PeopleStatusFilter } from '../src/ui/PeopleStatusFilterTabs';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import '../src/styles.css';

declare global {
  interface Window {
    __peopleRequests: string[];
    __releasePeopleAction: () => void;
  }
}

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'users';
const admin = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' } as const;

function makeUser(index: number, active: boolean, role: ManagedUser['role'] = 'STAFF'): ManagedUser {
  return {
    id: 'person-' + index, organizationId: 'org-1',
    name: 'Sentetik Personel ' + index, email: 'person' + index + '@example.test',
    role, mustChangePassword: false, isActive: active, version: 1,
    lastLoginAt: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
  };
}

const activeUsers = Array.from({ length: 8 }, (_, index) => makeUser(index + 1, true));
const inactiveStaff = makeUser(90, false);
const inactiveManager = makeUser(91, false, 'MANAGER');
const users = [...activeUsers, inactiveStaff, inactiveManager];
const profiles: StaffProfile[] = users.filter((user) => user.role === 'STAFF').map((user) => ({
  id: 'profile-' + user.id, user, title: 'Saha uzmanı', phone: null, region: 'Ankara',
  managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
}));

window.__peopleRequests = [];
let releaseAction: (() => void) | undefined;
window.__releasePeopleAction = () => {
  const release = releaseAction;
  releaseAction = undefined;
  release?.();
};

Object.defineProperty(window, 'fetch', {
  configurable: true,
  value: async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), window.location.origin);
    if (url.pathname === '/api/users/' + inactiveManager.id + '/activate') {
      window.__peopleRequests.push(url.pathname);
      await new Promise<void>((resolve) => { releaseAction = resolve; });
      return new Response(JSON.stringify({ ...inactiveManager, isActive: true, version: 2 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('Unmocked people fixture request: ' + url.pathname);
  },
});

function Fixture() {
  const [staffFilter, setStaffFilter] = useState<PeopleStatusFilter>('active');
  const [isFiltering, setIsFiltering] = useState(false);
  const filteredProfiles = profiles.filter((profile) =>
    staffFilter === 'all' || profile.user.isActive === (staffFilter === 'active'));

  function switchStaffFilter(next: PeopleStatusFilter) {
    setIsFiltering(true);
    setStaffFilter(next);
    window.setTimeout(() => setIsFiltering(false), 350);
  }

  if (view === 'users' || view === 'users-empty') {
    return <UserListView users={view === 'users-empty' ? [inactiveStaff] : users}
      onCreate={() => {}} onOpen={() => {}} />;
  }
  if (view === 'staff' || view === 'staff-manager' || view === 'staff-loading') {
    return <StaffDirectoryView profiles={view === 'staff-loading' ? profiles : filteredProfiles}
      statusFilter={staffFilter}
      isFiltering={isFiltering || view === 'staff-loading'}
      onStatusFilterChange={view === 'staff-manager' ? undefined : switchStaffFilter}
      onOpen={() => {}} />;
  }
  if (view === 'detail-staff') {
    return <UserDetailView user={inactiveStaff} viewer={admin} onChanged={() => {}} />;
  }
  if (view === 'detail-manager') {
    return <UserDetailView user={inactiveManager} viewer={admin} onChanged={() => {}} />;
  }
  throw new Error('Unknown people fixture view: ' + view);
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ServoraAntProvider>
      <MemoryRouter><Fixture /></MemoryRouter>
    </ServoraAntProvider>
  </React.StrictMode>,
);
