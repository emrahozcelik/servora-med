import { describe, expect, it } from 'vitest';

import { canAccessRoute } from '../src/shell/route-access';
import type { CurrentUser } from '../src/services/api';

const base: CurrentUser = {
  id: 's1', organizationId: 'o1', name: 'A', email: 'a@b.c', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manager: CurrentUser = { ...base, role: 'MANAGER', id: 'm1' };
const admin: CurrentUser = { ...base, role: 'ADMIN', id: 'a1' };

describe('canAccessRoute', () => {
  it('gates capability routes', () => {
    expect(canAccessRoute('overview', base)).toBe(false);
    expect(canAccessRoute('calendar', base)).toBe(false);
    expect(canAccessRoute('overview', { ...base, capabilities: { ...base.capabilities, overviewDashboard: true } })).toBe(true);
    expect(canAccessRoute('calendar', { ...manager, capabilities: { ...manager.capabilities, calendar: true } })).toBe(true);
  });

  it('denies staff on manager/admin routes', () => {
    expect(canAccessRoute('reports', base)).toBe(false);
    expect(canAccessRoute('reports', manager)).toBe(true);
    expect(canAccessRoute('users', manager)).toBe(false);
    expect(canAccessRoute('users', admin)).toBe(true);
    expect(canAccessRoute('staffReport', base)).toBe(false);
    expect(canAccessRoute('followUpCreate', base)).toBe(false);
    expect(canAccessRoute('productCreate', base)).toBe(false);
  });

  it('scopes staff profile to own id', () => {
    expect(canAccessRoute('staffProfile', base, { staffUserId: 's1' })).toBe(true);
    expect(canAccessRoute('staffProfile', base, { staffUserId: 'other' })).toBe(false);
    expect(canAccessRoute('staffProfile', manager, { staffUserId: 'other' })).toBe(true);
  });

  it('gates backup recovery on capability', () => {
    expect(canAccessRoute('settingsBackupRecovery', admin)).toBe(false);
    expect(canAccessRoute('settingsBackupRecovery', { ...admin, capabilities: { ...admin.capabilities, backup: true } })).toBe(true);
  });

  it('allows authenticated roots', () => {
    expect(canAccessRoute('jobs', base)).toBe(true);
    expect(canAccessRoute('jobDetail', base, { jobCardId: 'j1' })).toBe(true);
    expect(canAccessRoute('settings', base)).toBe(true);
  });
});
