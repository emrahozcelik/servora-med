import { describe, expect, it } from 'vitest';

import { authenticatedUser } from '../src/modules/capabilities/service.js';

const staff = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe',
  email: 'ayse@example.test', role: 'STAFF' as const,
  mustChangePassword: false, isActive: true, version: 1,
};

const manager = {
  id: 'manager-1', organizationId: 'org-1', name: 'Mehmet',
  email: 'mehmet@example.test', role: 'MANAGER' as const,
  mustChangePassword: false, isActive: true, version: 1,
};

const admin = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin',
  email: 'admin@example.test', role: 'ADMIN' as const,
  mustChangePassword: false, isActive: true, version: 1,
};

describe('authenticated capability contract', () => {
  it('fails every capability closed and uses neutral support when config is absent', () => {
    expect(authenticatedUser(staff, undefined, undefined)).toMatchObject({
      capabilities: {
        overviewDashboard: false,
        calendar: false,
        messaging: false,
        demoDatasetCreation: false,
      },
      support: {
        displayLabel: 'Sistem yöneticiniz',
        email: null,
        helpUrl: null,
      },
    });
  });

  it('exposes demoDatasetCreation only to ADMIN when flag is true', () => {
    const enabled = { overviewDashboard: false, calendar: false, messaging: false, backup: false, demoDatasetCreation: true };
    const disabled = { overviewDashboard: false, calendar: false, messaging: false, backup: false, demoDatasetCreation: false };

    // ADMIN + flag TRUE → true
    expect(authenticatedUser(admin, enabled, undefined).capabilities.demoDatasetCreation).toBe(true);
    // ADMIN + flag FALSE → false
    expect(authenticatedUser(admin, disabled, undefined).capabilities.demoDatasetCreation).toBe(false);

    // MANAGER + flag TRUE → false
    expect(authenticatedUser(manager, enabled, undefined).capabilities.demoDatasetCreation).toBe(false);
    // MANAGER + flag FALSE → false
    expect(authenticatedUser(manager, disabled, undefined).capabilities.demoDatasetCreation).toBe(false);

    // STAFF + flag TRUE → false
    expect(authenticatedUser(staff, enabled, undefined).capabilities.demoDatasetCreation).toBe(false);
    // STAFF + flag FALSE → false
    expect(authenticatedUser(staff, disabled, undefined).capabilities.demoDatasetCreation).toBe(false);
  });

  it('does not leak raw demo flag to non-admin via undefined config', () => {
    // When capabilities undefined, default is false for all roles
    expect(authenticatedUser(admin, undefined, undefined).capabilities.demoDatasetCreation).toBe(false);
    expect(authenticatedUser(manager, undefined, undefined).capabilities.demoDatasetCreation).toBe(false);
    expect(authenticatedUser(staff, undefined, undefined).capabilities.demoDatasetCreation).toBe(false);
  });
});
