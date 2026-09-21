import { describe, expect, it } from 'vitest';

import { buildNavigationModel } from '../src/shell/navigation-model';
import { matchRouteIdentity } from '../src/shell/route-identity';
import type { CurrentUser } from '../src/services/api';

const baseUser: CurrentUser = {
  id: 'u1', organizationId: 'org-1', name: 'Test', email: 't@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const roles: CurrentUser['role'][] = ['ADMIN', 'MANAGER', 'STAFF'];

describe('navigation ↔ identity drift contract', () => {
  it('resolves every navigation destination target to a known identity', () => {
    for (const role of roles) {
      const model = buildNavigationModel({ ...baseUser, role });
      for (const destination of model.destinations) {
        const url = new URL(destination.to, 'http://localhost');
        expect(matchRouteIdentity(url.pathname), `${role}:${destination.to}`).not.toBeNull();
      }
    }
  });

  it('keeps shared nav/identity labels from diverging', () => {
    for (const role of roles) {
      const model = buildNavigationModel({ ...baseUser, role });
      for (const destination of model.destinations) {
        if (destination.kind !== 'link') continue;
        const url = new URL(destination.to, 'http://localhost');
        const match = matchRouteIdentity(url.pathname);
        if (!match) continue;
        // Role-specific navigation labels (STAFF's "Profilim") intentionally
        // differ from generic identity titles. Shared labels must not drift.
        if ((match.identity.id as string) === destination.id) {
          const roleSpecific = (role === 'STAFF' && (destination.id === 'staff' || destination.id === 'jobs'));
          if (!roleSpecific) {
            expect(destination.label, `${role}:${destination.id}`).toBe(match.identity.title);
          }
        }
      }
    }
  });
});
