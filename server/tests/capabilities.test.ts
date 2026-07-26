import { describe, expect, it } from 'vitest';

import { authenticatedUser } from '../src/modules/capabilities/service.js';

const staff = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe',
  email: 'ayse@example.test', role: 'STAFF' as const,
  mustChangePassword: false, isActive: true, version: 1,
};

describe('authenticated capability contract', () => {
  it('fails every capability closed and uses neutral support when config is absent', () => {
    expect(authenticatedUser(staff, undefined, undefined)).toMatchObject({
      capabilities: {
        overviewDashboard: false,
        calendar: false,
        messaging: false,
      },
      support: {
        displayLabel: 'Sistem yöneticiniz',
        email: null,
        helpUrl: null,
      },
    });
  });
});
